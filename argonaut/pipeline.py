"""Session pipeline: clip or live camera -> virtual sensors -> identification -> twin -> optimisation.

Emits events from docs/CONTRACT.md through an async `emit` callback and records them to
data/runs/<session>/events.jsonl for replay.
"""

import asyncio
import json
import time
from pathlib import Path

import cv2
import numpy as np

from .dsp import audio as A
from .dsp import dealias as DA
from .dsp import identify, modal, severity, spectral
from .dsp.motion import Region, measure_regions, read_video
from .models import client as mc
from .optimize import Twin, optimise

RUNS = Path(__file__).resolve().parent.parent / "data" / "runs"
WATERFALL_FMAX = 120.0


def _f(x):
    return float(x) if x is not None and np.isfinite(x) else None


class Session:
    def __init__(self, session_id: str, asset_name: str = "Asset", emit=None):
        self.id, self.asset_name = session_id, asset_name
        self._listeners: list = [emit] if emit else []
        self.dir = RUNS / session_id
        self.dir.mkdir(parents=True, exist_ok=True)
        self._log = open(self.dir / "events.jsonl", "a", encoding="utf-8")
        self.t0 = time.perf_counter()
        self.latest: dict[str, dict] = {}
        self.ident: dict = {}
        self.twin: Twin | None = None
        self.proposal: dict | None = None
        self.nameplate: dict = {}
        self.pump_curve: dict | None = None
        self.sensor_prompts: list[str] | None = None
        self.plant = None  # optional VFD client (simulator)

    # ---------------------------------------------------------------- events
    def subscribe(self, fn):
        self._listeners.append(fn)

    def unsubscribe(self, fn):
        if fn in self._listeners:
            self._listeners.remove(fn)

    async def emit(self, ev: dict):
        ev.setdefault("t", round(time.perf_counter() - self.t0, 3))
        key = ev["type"] if ev["type"] not in ("spectrum", "waterfall") else f'{ev["type"]}:{ev.get("channel")}'
        if ev["type"] not in ("agent", "transcript", "pipeline"):
            self.latest[key] = ev
        self._log.write(json.dumps(ev, default=_f) + "\n")
        self._log.flush()
        for fn in list(self._listeners):
            try:
                await fn(ev)
            except Exception:
                self.unsubscribe(fn)

    # ---------------------------------------------------------------- clip analysis
    async def analyse_clip(self, path: str, realtime: float = 1.0, regions: list[Region] | None = None,
                           mm_per_px: float | None = None, run_agent: bool = True):
        """Full identification of a recorded clip, streamed progressively at `realtime` x speed."""
        frames, fps, scale = await asyncio.to_thread(read_video, path)
        h, w = frames.shape[1:]
        first_bgr = _first_color_frame(path, scale)
        await self.emit({"type": "pipeline", "stage": "dsp", "state": "running", "model": "argonaut-dsp",
                         "detail": f"{len(frames)} frames @ {fps:.0f} fps, {w}x{h}"})

        scene = None
        file_id = None
        if mc.available():
            from .models import sam, spark
            upload = asyncio.create_task(spark.upload(path, self.emit))
            try:
                scene = await spark.understand_scene(first_bgr, self.emit)
                await self.emit({"type": "coach", **scene["capture"], "text": scene["capture"]["advice"]})
                self.nameplate = scene.get("nameplate") or {}
            except Exception as e:
                await self.emit({"type": "error", "message": f"scene understanding failed: {e}"})
            if regions is None:
                prompts = self.sensor_prompts or (scene or {}).get("sensor_prompts") or ["machine"]
                ref = (scene or {}).get("reference_prompt") or "wall"
                regions = await sam.place_sensors(first_bgr, prompts[:5], ref, self.emit)
            if scene and not mm_per_px:
                sr = scene.get("scale_reference") or {}
                if sr.get("pixel_size") and sr.get("real_size_mm"):
                    mm_per_px = sr["real_size_mm"] / sr["pixel_size"]
            try:
                file_id = await upload
            except Exception:
                file_id = None
        if not regions:
            regions = _fallback_regions(w, h)
        mm_per_px = mm_per_px or 0.5
        from .models.sam import sensors_event
        try:
            rel = Path(path).resolve().relative_to(RUNS.parent.parent).as_posix()
            await self.emit({"type": "media", "url": f"/api/media/{rel}", "width": w, "height": h, "fps": fps})
        except ValueError:
            pass  # clip outside the project: no playback URL
        await self.emit(sensors_event(regions, w, h))
        await self.emit(self._asset_event())

        # --- motion of every virtual sensor
        t_dsp = time.perf_counter()
        motion = await asyncio.to_thread(measure_regions, frames, regions)
        chans = [r for r in regions if not r.is_reference]
        rejected = [r for r in chans if not motion[r.id]["quality"].get("rigid", True)]
        if rejected and len(rejected) < len(chans):
            chans = [r for r in chans if r not in rejected]
            await self.emit({"type": "coach", "level": "warn",
                             "text": "Ignoring " + ", ".join(f"'{r.label}'" for r in rejected)
                                     + ": features inside it move independently (rotating parts or occlusion)."})
        self._rejected = [r.label for r in rejected]
        disp_mm = {r.id: motion[r.id]["axis_disp_px"] * mm_per_px for r in chans}
        await self.emit({"type": "pipeline", "stage": "dsp", "state": "ok", "model": "argonaut-dsp",
                         "latency_ms": int((time.perf_counter() - t_dsp) * 1000),
                         "detail": f"sub-pixel tracking of {len(chans)} rigid sensors"
                                   + (f", rejected {len(rejected)}" if rejected else "")})

        # --- audio
        audio = await asyncio.to_thread(A.load_audio, path)
        fa = aa = None
        cav = None
        if audio is not None and len(audio) > 24000:
            fa, aa = A.spectrum(audio, 24000, fmax=min(2000, fps * 4))
            cav = A.cavitation_index(audio, 24000)

        # --- short-time spectra on the strongest channel (reference for speed tracking)
        main = max(chans, key=lambda r: np.std(disp_mm[r.id])) if chans else None
        if main is None:
            return
        x = disp_mm[main.id]
        tt, f, S = spectral.stft_amp(x, fps, win_s=min(1.0, len(x) / fps / 4), hop_s=0.25)
        fmax = min(fps / 2 * 0.9, 80.0)
        hint = (self.nameplate.get("rpm") or 0) / 60 or None
        sp, conf = identify.track_speed(tt, f, S, f_range=(1.0, fmax / 1.5), start_hint=hint)
        speed_source = "video"
        wf_sel = f <= min(WATERFALL_FMAX, fps / 2)
        wf_rows = spectral.to_uint8_db(S[:, wf_sel])
        mic_wf = None
        if audio is not None and len(audio) > 24000 * 2:
            tone, aconf, mic_wf, tone_k = await asyncio.to_thread(A.acoustic_track, audio, 24000, tt,
                                                                  hint_hz=hint)
            # Microphone is the tachometer when the camera is too slow (aliasing), the video ridge is
            # stuck at the search floor (stationary sensors carry weak orders), or audio is more confident.
            video_stuck = np.median(sp) < 1.5
            if fps < 100 or video_stuck:
                # If no subharmonic structure was found (k == 1) but Muse Spark counted blades, the
                # tracked tone is blade pass: divide by the blade count it read from the image.
                blades = (self.nameplate.get("blades_or_vanes") or 0) or 1
                div = 1
                if blades > 1 and not hint:
                    # Muse Spark counted the blades: anchor the tracked ridge to the blade-pass rule
                    # (shaft = blade-pass fundamental / blades) on the steadiest part of the clip.
                    seg = audio[-min(len(audio), 6 * 24000):] if sp[-1] >= sp[0] else audio[:6 * 24000]
                    fa_, aa_ = A.spectrum(seg, 24000, fmax=1500.0, seconds=2.0)
                    sh, _bpf, prom = identify.shaft_from_blade_pass(fa_, aa_, int(blades))
                    ref = float(np.median(tone[-8:] if sp[-1] >= sp[0] else tone[:8]))
                    if sh and prom > 8:
                        div = max(ref / sh, 1e-6)
                sp, conf = tone / div, aconf
                speed_source = ("audio (blade pass)" if div > 1 or tone_k > 1 else "audio (tonal order)")
                steady = np.ptp(sp) / max(np.median(sp), 1e-6) < 0.1
                if not hint and steady and fps < 100:
                    # Cross-modal check: which sub-multiple of the acoustic speed explains the camera's
                    # aliased peaks as shaft orders? (the mic alone cannot tell 1x from 2x)
                    fm, am = spectral.amp_spectrum(x, fps)
                    s0, d, _n = DA.resolve_speed(spectral.find_peaks(fm, am, n=6, fmin=0.5), fps,
                                                 float(np.median(sp)), bin_hz=fm[1] - fm[0])
                    if d > 1:
                        sp = sp / d
        self._speed_source = speed_source

        # Progressive emission (feels live; also the replay timeline).
        cls = severity.machine_class(self.nameplate.get("kw") or None)
        win = max(16, int(fps * 1.0))
        for i, tc in enumerate(tt):
            n1 = min(len(x), int(tc * fps + win / 2))
            n0 = max(0, n1 - 2 * win)
            ch = []
            for r in chans:
                seg = disp_mm[r.id][n0:n1]
                v = spectral.band_rms_velocity(seg, fps, band=(2.0, fps / 2))
                ch.append({"id": r.id, "disp_mm_rms": float(np.std(seg)), "vel_mm_s_rms": v,
                           "iso_zone": severity.zone(v, cls)})
            overall = max(c["vel_mm_s_rms"] for c in ch)
            seg_v = spectral.segment_rms_velocity(disp_mm[main.id][n0:n1], fps, (2.0, fps / 2), n_seg=4)
            await self.emit({"type": "telemetry", "clip_t": float(tc), "speed_hz": float(sp[i]), "speed_rpm": float(sp[i] * 60),
                             "speed_source": speed_source, "channels": ch, "overall_vel_mm_s_rms": overall,
                             "overall_vel_ci": list(spectral.mean_ci(seg_v)) if len(seg_v) > 1 else None,
                             "band": DA.usable_band(fps, float(sp[i]) if speed_source.startswith("audio") else None),
                             "iso_zone": severity.zone(overall, cls)})
            await self.emit({"type": "waterfall", "clip_t": float(tc), "channel": main.id,
                             "f_max_hz": float(f[wf_sel][-1]), "row": wf_rows[i].tolist()})
            if mic_wf is not None:
                j = int(np.argmin(np.abs(mic_wf[0] - tc)))
                await self.emit({"type": "waterfall", "clip_t": float(tc), "channel": "mic",
                                 "f_max_hz": float(mic_wf[1][-1]), "row": mic_wf[2][j][::4].tolist()})
            if i % 2 == 0:
                await self._emit_spectrum(main.id, x[n0:n1], fps, float(sp[i]), fa, aa, float(tc))
            await asyncio.sleep(0.25 / max(realtime, 1e-3))

        if getattr(self, "_last_dealias", None):
            await self.emit(self._last_dealias)
        # --- identification
        await self._identify(tt, f, S, sp, conf, fps, disp_mm, chans, fa, aa, cav, x, cls)
        if file_id and mc.available():
            from .models import spark
            try:
                heard = await spark.listen(file_id, self.emit)
                self.ident["muse_spark_listen"] = heard
            except Exception as e:
                await self.emit({"type": "error", "message": f"audio check failed: {e}"})
        if run_agent:
            await self.run_agent()

    async def _emit_spectrum(self, cid, seg, fps, speed_hz, fa, aa, t):
        """Spectrum with CI whiskers; de-aliased against the acoustic speed when orders exceed Nyquist."""
        f1, m, lo, hi = spectral.welch_amp_ci(seg, fps, n_seg=6)
        v = spectral.disp_to_vel_spectrum(f1, m)
        sel = f1 <= min(WATERFALL_FMAX, fps / 2)
        disp_peaks = spectral.find_peaks(f1[sel], m[sel], n=6, fmin=1.0)
        audio_speed = getattr(self, "_speed_source", "video").startswith("audio")
        dealias_on = audio_speed and speed_hz > 0 and 2 * speed_hz > fps / 2 * 0.9
        assigned = (DA.dealias_peaks(disp_peaks, fps, speed_hz, speed_sd_hz=0.05, bin_hz=f1[1] - f1[0])
                    if dealias_on else [None] * len(disp_peaks))
        corr = A.corroborate([p["f_hz"] for p in disp_peaks], fa, aa) if fa is not None else [False] * len(disp_peaks)
        peaks = []
        for p, c, a in zip(disp_peaks, corr, assigned):
            ft = a["f_true_hz"] if a and a["order"] else p["f_hz"]
            order = ft / speed_hz if speed_hz > 0 else 0
            w = 2 * np.pi * ft
            peaks.append({"f_hz": ft, "amp": w * p["amp"], "order": round(order, 2),
                          "amp_ci": [w * float(np.interp(p["f_hz"], f1, lo)), w * float(np.interp(p["f_hz"], f1, hi))],
                          "corroborated_audio": bool(c) or bool(a and a["order"]),
                          "label": f"{round(order)}×" if abs(order - round(order)) < 0.06 and round(order) >= 1 else "",
                          **({"aliased": True, "f_alias_hz": p["f_hz"]} if a and a["order"] and a["fold"] else {})})
        if dealias_on:
            self._last_dealias = {"type": "dealias", "channel": cid, "fs_video": fps, "speed_hz_audio": speed_hz,
                                  "speed_source": "audio",
                                  "peaks": [{k: a[k] for k in ("f_alias_hz", "f_true_hz", "order", "fold", "residual_hz",
                                                               "confidence")} for a in assigned if a and a["order"]]}
        await self.emit({"type": "spectrum", "channel": cid, "f_hz": f1[sel].tolist(),
                         "amp": v[sel].tolist(), "unit": "mm/s", "peaks": peaks, "clip_t": t})

    async def _identify(self, tt, f, S, sp, conf, fps, disp_mm, chans, fa, aa, cav, x, cls):
        t_id = time.perf_counter()
        sweep = float(np.ptp(sp) / max(np.max(sp), 1e-6))
        # Operating point = speed before a coast-down, or after a run-up.
        op = slice(0, 4) if sp[0] > sp[-1] else slice(-4, None)
        orders = {}
        for k in (1, 2, 3):
            amp = identify.order_amplitude(f, S, sp, k)
            orders[k] = {"amp_mm": amp.tolist(), "vel_mm_s_now": float(amp[op].mean() * 2 * np.pi * k * sp[op].mean())}
        modes = []
        if sweep > 0.25:  # run-up / coast-down: order-tracked resonance test with SDOF curve fit
            for k in (1, 2):
                res = identify.resonance_from_order(sp[sp > 1.0], np.array(orders[k]["amp_mm"])[sp > 1.0], k)
                if not res:
                    continue
                t_o, f_o, a_o = identify.order_track(x, fps, tt, sp, order=k)
                band = (f_o > res["f_hz"] * 0.6) & (f_o < res["f_hz"] * 1.4)
                step = max(1, int(band.sum() / 400))
                fit = identify.fit_sdof(f_o[band][::step], a_o[band][::step], f_guess=res["f_hz"])
                if fit and fit["zeta_err"] < fit["zeta"]:
                    modes.append({**fit, "source": f"{k}× order-tracked sweep, SDOF fit",
                                  "label": f"Structural mode {fit['f_hz']:.1f} Hz"})
                elif res["zeta"] is not None:
                    df = f[1] - f[0]
                    modes.append({"f_hz": res["f_hz"], "f_err_hz": float(df / 2), "zeta": res["zeta"],
                                  "zeta_err": float(max(0.003, df / (2 * res["f_hz"]))),
                                  "source": f"{k}× order sweep, half-power", "label": f"Structural mode {res['f_hz']:.1f} Hz"})
                break  # one clean resonance curve is enough; 2× is a fallback
        sm, _ = identify.structural_modes(tt, f, S, sp)
        for p in sm:
            if all(abs(p["f_hz"] - m["f_hz"]) > 1.0 for m in modes) and p["f_hz"] < fps / 2 * 0.8:
                modes.append({"f_hz": p["f_hz"], "f_err_hz": float((f[1] - f[0]) / 2), "zeta": None, "zeta_err": None,
                              "source": "residual spectrum", "label": f"Structural peak {p['f_hz']:.1f} Hz"})
        modes = sorted(modes, key=lambda m: m["f_hz"])[:4]

        # Operational modal analysis across all sensors simultaneously
        X = np.vstack([disp_mm[r.id] for r in chans])
        fdd_modes, fdd_payload = [], None
        if len(chans) >= 2:
            ff, s, fm = modal.fdd(X, fps, fmin=2.0, fmax=min(fps / 2 * 0.9, 120))
            if sweep <= 0.25:  # steady speed: a peak on k×speed is a forced response (ODS), not a mode
                for mm in fm:
                    k = round(mm["f_hz"] / max(sp[op].mean(), 1e-6))
                    if k >= 1 and abs(mm["f_hz"] - k * sp[op].mean()) <= max(0.03 * mm["f_hz"], 2 * (ff[1] - ff[0])):
                        mm["forced_order"] = int(k)
            fdd_modes = fm
            sel = ff <= min(fps / 2 * 0.9, 120)
            fdd_payload = {"type": "modal", "method": "FDD", "f_hz": ff[sel].tolist(),
                           "sv1": s[sel, 0].tolist(), "sv2": (s[sel, 1] if s.shape[1] > 1 else s[sel, 0] * 0).tolist(),
                           "modes": [{"f_hz": m["f_hz"], "zeta": m["zeta"], "forced_order": m.get("forced_order"),
                                      "shape": [{"id": r.id, "amp": a, "phase_deg": p}
                                                for r, a, p in zip(chans, m["shape_amp"], m["shape_phase_deg"])]}
                                     for m in fm]}
            await self.emit(fdd_payload)

        speeds_rpm = (sp * 60).tolist()
        crit = identify.campbell(np.array(speeds_rpm), modes, orders=(1, 2, 5)) if modes else []
        await self.emit({"type": "campbell", "speeds_rpm": speeds_rpm, "times_s": tt.tolist(),
                         "order_amp_mm": {str(k): v["amp_mm"] for k, v in orders.items()},
                         "modes": modes, "orders": [1, 2, 5], "criticals": crit})

        overall = [spectral.band_rms_velocity(disp_mm[r.id], fps, (2.0, fps / 2)) for r in chans]
        nyq_risk = bool(sp[-1] * 2 > fps / 2 * 0.8)
        self.ident = {
            "fps": fps, "nyquist_hz": fps / 2, "near_nyquist_warning": nyq_risk,
            "speed_hz_now": float(sp[op].mean()), "speed_rpm_now": float(sp[op].mean() * 60), "speed_sweep_frac": sweep,
            "speed_track_confidence_median": float(np.median(conf)), "speed_source": getattr(self, "_speed_source", "video"),
            "orders_vel_mm_s_now": {k: v["vel_mm_s_now"] for k, v in orders.items()},
            "modes": modes, "campbell_criticals": crit,
            "fdd_modes": [{"f_hz": m["f_hz"], "zeta": m["zeta"], "shape_phase_deg": m["shape_phase_deg"],
                           "kind": f"forced response at {m['forced_order']}x (ODS)" if m.get("forced_order") else "structural mode",
                           "sv_ratio": m["sv_ratio"], "channels": [r.label for r in chans]} for m in fdd_modes],
            "channels": [{"id": r.id, "label": r.label, "vel_mm_s_rms": v, "iso_zone": severity.zone(v, cls)}
                         for r, v in zip(chans, overall)],
            "iso_class": cls, "iso_zone": severity.zone(max(overall), cls),
            "cavitation": cav, "audio_available": fa is not None,
            "nameplate": self.nameplate,
        }
        await self.emit({"type": "pipeline", "stage": "dsp", "state": "ok", "model": "argonaut-dsp",
                         "latency_ms": int((time.perf_counter() - t_id) * 1000),
                         "detail": f"identified {len(modes)} modes, {len(crit)} critical speeds"})
        self._build_twin()

    def _build_twin(self):
        i = self.ident
        rated = self.nameplate.get("rpm") or max(i["speed_rpm_now"], 1.0)
        self.twin = Twin(
            speed_rpm=max(i["speed_rpm_now"], 0.3 * rated),
            modes=[{"f_hz": m["f_hz"], "zeta": m["zeta"] or 0.03,
                    "f_sd": m.get("f_err_hz") or 0.02 * m["f_hz"],
                    "zeta_sd": m.get("zeta_err") or 0.3 * (m["zeta"] or 0.03)}
                   for m in i["modes"] if m.get("zeta") or len(i["modes"]) == 1],
            order_vel_mm_s={float(k): max(v, 1e-4) for k, v in i["orders_vel_mm_s_now"].items() if k in (1, 2)},
            rated_rpm=rated, rated_kw=self.nameplate.get("kw") or 0.1, machine_class=i["iso_class"],
            pump_curve=self.pump_curve, system=self.pump_curve.get("system") if self.pump_curve else None,
            npsh_available_m=self.pump_curve.get("npsha") if self.pump_curve else None,
        )

    def _asset_event(self) -> dict:
        pc = self.pump_curve
        return {"type": "asset", "name": self.asset_name,
                "nameplate": {"rpm": self.nameplate.get("rpm") or None, "kw": self.nameplate.get("kw") or None,
                              "poles": self.nameplate.get("poles") or None},
                "pump_curve": ({k: pc[k] for k in ("q", "h", "eta", "npshr")} if pc else None),
                "bep": ({"q": pc.get("bep_q"), "h": pc.get("bep_h")} if pc else None)}

    # ---------------------------------------------------------------- agent + optimisation
    async def run_agent(self, private: bool = False):
        if not self.ident:
            return
        if not mc.available():
            await self._rule_based()
            return
        from .models import agent
        from .models.provenance import Ledger, check

        ledger = Ledger()

        async def get_identification(_):
            return {k: v for k, v in self.ident.items()}

        async def run_optimiser(args):
            r = optimise(self.twin, duty_min_frac=args.get("duty_min_frac", 0.8),
                         margin=args.get("resonance_margin", 0.1))
            self._last_opt = r
            return {k: v for k, v in r.items() if k != "curve"}

        async def report_diagnosis(args):
            claims, prov = check(args["summary"], ledger)
            await self.emit({"type": "diagnosis", "claims": claims, "provenance": prov, "id": agent.new_id("d"), "severity": args["severity"],
                             "title": args["title"], "summary": args["summary"],
                             "evidence": [_evidence(e) for e in args.get("evidence", [])],
                             "confidence": args.get("confidence", 0.5),
                             "model": mc.OPEN_WEIGHTS if private else mc.WONDER})
            return {"ok": True}

        async def propose_setpoint(args):
            r = getattr(self, "_last_opt", None) or optimise(self.twin)
            return await self._emit_proposal(r, args.get("rationale", ""), mc.OPEN_WEIGHTS if private else mc.WONDER)

        try:
            await agent.run({"get_identification": get_identification, "run_optimiser": run_optimiser,
                             "report_diagnosis": report_diagnosis, "propose_setpoint": propose_setpoint},
                            self.emit, private=private, ledger=ledger)
        except Exception as e:
            await self.emit({"type": "error", "message": f"agent failed: {e}"})
            await self._rule_based()

    async def _emit_proposal(self, r: dict, rationale: str, model: str) -> dict:
        if not r.get("feasible"):
            await self.emit({"type": "diagnosis", "id": "d-opt", "severity": "warn", "title": "No feasible setpoint",
                             "summary": r.get("reason", ""), "evidence": [], "confidence": 0.7, "model": model})
            return {"ok": False}
        self.proposal = {"type": "proposal", "id": f"p{int(time.time()) % 100000}", "objective": r["objective"],
                         "current": r["current"], "proposed": r["proposed"], "constraints": r["constraints"],
                         "feasible_band_rpm": r["feasible_band_rpm"], "exclusion_bands_rpm": r["exclusion_bands_rpm"],
                         "expected": r["expected"], "rationale": rationale, "model": model,
                         "curve": r.get("curve"), "risk": r.get("risk")}
        await self.emit(self.proposal)
        return {"ok": True, "proposal_id": self.proposal["id"]}

    async def _rule_based(self):
        """Deterministic fallback when no API key: same evidence, transparent rules."""
        i = self.ident
        for m in i["modes"]:
            for c in i["campbell_criticals"]:
                if abs(c["mode_f_hz"] - m["f_hz"]) < 0.01 and abs(c["rpm"] - i["speed_rpm_now"]) / max(c["rpm"], 1) < 0.1:
                    await self.emit({"type": "diagnosis", "id": f"d-res-{c['order']}", "severity": "alarm",
                                     "title": "Operating on a critical speed",
                                     "summary": f"{c['order']}× at {i['speed_rpm_now']:.0f} rpm excites the "
                                                f"{m['f_hz']:.1f} Hz mode (ζ={m['zeta'] or 0:.3f}).",
                                     "evidence": [{"kind": "metric", "name": "mode_f_hz", "value": m["f_hz"],
                                                   "err": m["f_err_hz"]}], "confidence": 0.8, "model": "rules"})
        o = i["orders_vel_mm_s_now"]
        if o.get(2, 0) > 0.6 * o.get(1, 1):
            await self.emit({"type": "diagnosis", "id": "d-2x", "severity": "warn", "title": "Strong 2× component",
                             "summary": "2× is above 60% of 1×: check coupling alignment.",
                             "evidence": [], "confidence": 0.6, "model": "rules"})
        if i.get("cavitation") and i["cavitation"]["index"] > 0.5:
            await self.emit({"type": "diagnosis", "id": "d-cav", "severity": "alarm", "title": "Cavitation signature",
                             "summary": f"Cavitation index {i['cavitation']['index']:.2f}.", "evidence": [],
                             "confidence": 0.6, "model": "rules"})
        await self._emit_proposal(optimise(self.twin), "Deterministic optimiser (no LLM).", "rules")

    # ---------------------------------------------------------------- approval + closed-loop verification
    async def approve(self, proposal_id: str, approved: bool):
        if not self.proposal or self.proposal["id"] != proposal_id:
            return {"ok": False, "error": "unknown proposal"}
        if not approved:
            await self.emit({"type": "agent", "role": "assistant", "text": "Proposal rejected by operator.", "final": True})
            return {"ok": True}
        target = self.proposal["proposed"]["speed_rpm"]
        if self.plant is not None:
            await asyncio.to_thread(self.plant.write_setpoint, target)
            await self.emit({"type": "agent", "role": "assistant", "final": False,
                             "text": f"Setpoint {target:.0f} rpm written to VFD. Waiting for ramp, then re-measuring."})
            await asyncio.sleep(4)
            st = await asyncio.to_thread(self.plant.read_state)
            await self.verify_measured(st.get("vel_mm_s_rms"))
        else:
            await self.emit({"type": "coach", "level": "ok",
                             "text": f"Set the drive to {target:.0f} rpm, then record a 10 s verification clip."})
        return {"ok": True}

    async def verify_measured(self, measured_vel: float | None):
        if measured_vel is None or not self.proposal:
            return
        pred = self.proposal["proposed"]["vel_mm_s"]
        err = abs(measured_vel - pred) / max(pred, 1e-6)
        before = self.proposal["current"]["vel_mm_s"]
        await self.emit({"type": "verification", "proposal_id": self.proposal["id"], "predicted_vel_mm_s": pred,
                         "measured_vel_mm_s": measured_vel, "passed": err < 0.35,
                         "summary": f"Vibration {before:.2f} → {measured_vel:.2f} mm/s "
                                    f"({100 * (measured_vel / before - 1):+.0f}%); prediction error {100 * err:.0f}%."})

    async def verify_clip(self, path: str):
        frames, fps, _ = await asyncio.to_thread(read_video, path)
        h, w = frames.shape[1:]
        regs = _fallback_regions(w, h)
        mot = await asyncio.to_thread(measure_regions, frames, regs)
        v = max(spectral.band_rms_velocity(mot[r.id]["axis_disp_px"] * 0.5, fps, (2.0, fps / 2))
                for r in regs if not r.is_reference)
        await self.verify_measured(v)


def _evidence(ref: str) -> dict:
    """Agent evidence ids ('peak:s1:24.6', 'mode:14.2', 'zone') -> contract evidence objects."""
    parts = str(ref).split(":")
    try:
        if parts[0] == "peak" and len(parts) >= 3:
            return {"kind": "spectrum_peak", "channel": parts[1], "f_hz": float(parts[2])}
        if parts[0] in ("mode", "fdd") and len(parts) >= 2:
            return {"kind": "metric", "name": f"{parts[0]} f_hz", "value": float(parts[1]), "err": None}
    except ValueError:
        pass
    return {"kind": "metric", "name": str(ref), "value": "", "err": None}


def _first_color_frame(path: str, scale: float) -> np.ndarray:
    cap = cv2.VideoCapture(path)
    ok, fr = cap.read()
    cap.release()
    if not ok:
        raise ValueError("cannot read first frame")
    if scale != 1.0:
        fr = cv2.resize(fr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return fr


def _fallback_regions(w: int, h: int) -> list[Region]:
    """Without SAM: centre region as the machine, top-left corner strip as static reference."""
    return [Region("s1", "machine (left)", (int(w * 0.3), int(h * 0.3), int(w * 0.5), int(h * 0.75)),
                   meta={"color": "#38BDF8"}),
            Region("s2", "machine (right)", (int(w * 0.5), int(h * 0.3), int(w * 0.7), int(h * 0.75)),
                   meta={"color": "#A78BFA"}),
            Region("s0", "reference (corner)", (2, 2, int(w * 0.12), int(h * 0.25)), is_reference=True,
                   meta={"color": "#94A3B8"})]

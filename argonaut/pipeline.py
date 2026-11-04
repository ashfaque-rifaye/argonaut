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
from .dsp import kinematics as KIN
from .dsp.motion import Region, measure_regions, read_video
from .models import client as mc
from .actions import Actions
from .optimize import Twin, optimise

RUNS = Path(__file__).resolve().parent.parent / "data" / "runs"
WATERFALL_FMAX = 120.0
PLAUSIBLE_MAX_MM_S = 45.0  # above ISO 20816 zone-D levels of any normal machine: treat as scale error
ORDER_RATIOS = (1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 2, 2, 3, 4, 6)


def _stationary_span(tt, sp, at_end: bool, tol: float = 0.03, max_s: float = 8.0) -> float:
    """Longest window (<= max_s) at the steady end of the speed track whose speed varies < tol:
    a spectrum over a speed sweep smears every line and would mislead the kinematic sieve."""
    if len(sp) < 3:
        return 0.0
    order = range(len(sp) - 1, -1, -1) if at_end else range(len(sp))
    ref, span = None, 0.0
    idx = list(order)
    ref = float(sp[idx[0]])
    for j in idx[1:]:
        if abs(sp[j] - ref) > tol * max(ref, 1e-6):
            break
        span = abs(float(tt[j]) - float(tt[idx[0]]))
    return min(span, max_s)


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
        self.scene: dict | None = None
        self.kin = KIN.Kinematics()
        self.kin_override: dict = {}   # what-if assumptions set by the agent or the operator
        self.speed_post: dict | None = None
        self.plant = None  # optional VFD client (simulator)
        self.actions = Actions(self)

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
                           clip_id: str | None = None,
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
                scene = await spark.understand_scene(first_bgr, self.emit, effort="minimal")
                await self.emit({"type": "coach", **scene["capture"], "text": scene["capture"]["advice"]})
                self.nameplate = scene.get("nameplate") or {}
                self.scene = scene
            except Exception as e:
                await self.emit({"type": "error", "message": f"scene understanding failed: {e}"})
            if regions is None:
                prompts = self.sensor_prompts or (scene or {}).get("sensor_prompts") or ["machine"]
                ref = (scene or {}).get("reference_prompt") or "wall"
                regions = await sam.place_sensors(first_bgr, prompts[:5], ref, self.emit, effort="minimal",
                                                  boxes=None if self.sensor_prompts else (scene or {}).get("boxes"))
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
        # Scale is "calibrated" only if it came from the caller or from a credible reference object.
        self.scale_calibrated = bool(mm_per_px) and 0.02 <= mm_per_px <= 5.0
        mm_per_px = mm_per_px or 0.5
        from .models.sam import sensors_event
        try:
            rel = Path(path).resolve().relative_to(RUNS.parent.parent).as_posix()
            await self.emit({"type": "media", "url": f"/api/media/{rel}", "width": w, "height": h, "fps": fps,
                             "clip_id": clip_id, "mode": "analyse"})
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

        # --- kinematic model (Muse Spark's reading of the machine, plus any what-if override)
        self.kin = KIN.Kinematics.from_scene(self.scene, self.nameplate)
        for k, v in self.kin_override.items():
            setattr(self.kin, k, v)
        self._audio = None

        # --- audio
        audio = await asyncio.to_thread(A.load_audio, path)
        self._audio = audio
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
                elif not hint:
                    # No nameplate, no blade count: induction-motor synchronous-speed prior on the steady part.
                    raw = float(np.median(tone[-8:] if sp[-1] >= sp[0] else tone[:8])) * tone_k
                    snap = identify.synchronous_divisor(raw)
                    if snap:
                        div = snap[0] / tone_k  # shaft = raw tone / k_sync
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
        # Bayesian kinematic speed posterior on the steady part of the recording: settles which order
        # the microphone hears when the machine's kinematics make one answer far more probable.
        self.speed_post = None
        # A clip whose tracked speed never sweeps far is steady: use its last 8 s (the tachometer track
        # itself may be what is wrong). A run-up / coast-down uses only its steady end.
        sweep_all = float(np.ptp(sp) / max(np.max(sp), 1e-6)) if len(sp) else 1.0
        # steadiness is judged on the raw acoustic tone when there is one: the tachometer's order
        # choice may be the very thing that is wrong
        steady_ref = tone if (audio is not None and "tone" in locals() and len(tone) == len(tt)) else sp
        # the steadier end of the recording: the end of a run-up, the start of a coast-down
        span_end, span_start = _stationary_span(tt, steady_ref, True), _stationary_span(tt, steady_ref, False)
        at_end = span_end >= span_start
        seg_s = (min(8.0, len(audio) / 24000 - 0.5) if audio is not None and sweep_all < 0.3
                 else max(span_end, span_start))
        self._kin_window_s = seg_s
        if audio is not None and len(audio) > 24000 * 3 and seg_s >= 2.0:
            n = int(seg_s * 24000)
            seg = audio[-n:] if at_end else audio[:n]
            fk, ak = A.spectrum(seg, 24000, fmax=1500.0, seconds=min(4.0, seg_s / 2))
            self._kin_spec = (fk, ak)
            self.line = KIN.detect_line_hz(fk, ak)
            post = await asyncio.to_thread(KIN.speed_posterior, fk, ak, self.kin, line=self.line)
            self.speed_post = post
            if post and not hint and post["p_map"] >= 0.8 and speed_source.startswith("audio"):
                ref = float(np.median(sp[-8:] if sp[-1] >= sp[0] else sp[:8]))
                r = post["map_hz"] / max(ref, 1e-6)
                q = min(ORDER_RATIOS, key=lambda q: abs(r / q - 1))
                # Same order (r ~ 1), another order (r ~ rational) or, when near-certain, an unrelated line
                # the tachometer locked onto: rescale the track to the posterior MAP, whose line fit is finer.
                if abs(r - 1) < 0.03 or abs(r / q - 1) < 0.03 or post["p_map"] >= 0.95:
                    sp = sp * r
                    speed_source += (" · refined by kinematic posterior" if abs(r - 1) < 0.03
                                     else f" · kinematic posterior (×{r:.3g})")
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
            calibrated = self.scale_calibrated and overall < PLAUSIBLE_MAX_MM_S
            seg_v = spectral.segment_rms_velocity(disp_mm[main.id][n0:n1], fps, (2.0, fps / 2), n_seg=4)
            await self.emit({"type": "telemetry", "clip_t": float(tc), "speed_hz": float(sp[i]), "speed_rpm": float(sp[i] * 60),
                             "speed_source": speed_source, "channels": ch, "overall_vel_mm_s_rms": overall,
                             "overall_vel_ci": list(spectral.mean_ci(seg_v)) if len(seg_v) > 1 else None,
                             "band": DA.usable_band(fps, float(sp[i]) if speed_source.startswith("audio") else None),
                             "iso_zone": severity.zone(overall, cls) if calibrated else None,
                             "calibrated": calibrated})
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
        await self.emit({"type": "coach", "level": "ok", "clip_end": True,
                         "text": "End of clip: identification and diagnosis follow."})
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
            "iso_class": cls,
            # Absolute severity only with a credible scale and physically plausible levels; otherwise relative.
            "scale_calibrated": bool(self.scale_calibrated and max(overall) < PLAUSIBLE_MAX_MM_S),
            "scale_note": (None if self.scale_calibrated and max(overall) < PLAUSIBLE_MAX_MM_S else
                           "Absolute mm/s is NOT calibrated (no credible scale reference, or levels physically "
                           "implausible for this machine, e.g. camera motion). Treat amplitudes as relative; "
                           "frequencies, orders, phases and ratios remain valid."),
            "iso_zone": severity.zone(max(overall), cls) if self.scale_calibrated and max(overall) < PLAUSIBLE_MAX_MM_S else None,
            "cavitation": cav, "audio_available": fa is not None,
            "nameplate": self.nameplate,
        }
        await self.emit({"type": "pipeline", "stage": "dsp", "state": "ok", "model": "argonaut-dsp",
                         "latency_ms": int((time.perf_counter() - t_id) * 1000),
                         "detail": f"identified {len(modes)} modes, {len(crit)} critical speeds"})
        self._build_twin()
        await self.kinematic_inference(fdd_modes=fdd_modes, chans=chans)

    async def kinematic_inference(self, fdd_modes=None, chans=None, override: dict | None = None) -> dict | None:
        """Speed posterior + fault posterior for the current kinematic model; emits a `kinematics` event.
        `override` (agent what-if) re-runs the whole inference with changed assumptions."""
        if override:
            self.kin_override.update({k: v for k, v in override.items() if hasattr(self.kin, k)})
            for k, v in self.kin_override.items():
                setattr(self.kin, k, v)
            if getattr(self, "_kin_spec", None):
                self.speed_post = await asyncio.to_thread(KIN.speed_posterior, *self._kin_spec, self.kin,
                                                          line=getattr(self, "line", None))
        if fdd_modes is not None:
            self._fdd_for_kin = fdd_modes
        fdd_modes = getattr(self, "_fdd_for_kin", None) or []
        i = self.ident
        audio = getattr(self, "_audio", None)
        fa = fh = None
        if getattr(self, "_kin_spec", None):
            fa, aa = self._kin_spec
        if audio is not None and len(audio) >= 12 * 24000:
            fh, ah = A.spectrum(audio[-16 * 24000:], 24000, fmax=250.0, seconds=min(16.0, len(audio) / 24000))
        ph2 = None
        for m in fdd_modes:
            if m.get("forced_order") == 2 and len(m.get("shape_phase_deg") or []) >= 2:
                # compare only channels that actually carry 2x: a near-silent channel's phase is noise
                amp = np.asarray(m.get("shape_amp") or [1.0] * len(m["shape_phase_deg"]), float)
                p = [ph for ph, a_ in zip(m["shape_phase_deg"], amp) if a_ >= 0.3 * amp.max()]
                if len(p) >= 2:
                    ph2 = max(abs(((a - b + 180) % 360) - 180) for a in p for b in p)
        sp_modes = (self.speed_post or {}).get("modes") or [{"f_hz": i["speed_hz_now"], "p": 1.0}]
        if not self.speed_post or (i.get("speed_source") or "").startswith("video"):
            sp_modes = [{"f_hz": i["speed_hz_now"], "p": 1.0}]  # camera measured the speed directly
        ctx = {"kin": self.kin, "audio_f": fa, "audio_a": aa if fa is not None else None,
               "audio_hi": (fh, ah) if fh is not None else None, "line_hz": (getattr(self, "line", None) or {}).get("line_hz"),
               # camera orders only where the camera can see them (below 80 % of Nyquist); else aliased
               "video_orders": ({int(k): v for k, v in i.get("orders_vel_mm_s_now", {}).items()}
                                if 2 * i["speed_hz_now"] < 0.8 * i["nyquist_hz"] else {}),
               "phase_2x_deg": ph2, "modes": i.get("modes"), "criticals": i.get("campbell_criticals"),
               "fdd_modes": i.get("fdd_modes"), "sweep_frac": i.get("speed_sweep_frac"),
               "scale_calibrated": i.get("scale_calibrated"), "cavitation": i.get("cavitation")}
        faults = await asyncio.to_thread(KIN.fault_posterior, ctx, sp_modes)
        f_now = i["speed_hz_now"]
        forcing = [{"label": l["label"], "family": l["family"], "f_hz": l["order"] * f_now}
                   for l in KIN.order_lines(self.kin, max_order=12) if l["order"] * f_now <= 1500]
        ev = {"type": "kinematics", "kin": self.kin.to_dict(), "line": getattr(self, "line", None),
              "speed_posterior": self.speed_post, "speed_rpm_used": f_now * 60, "speed_source": i.get("speed_source"),
              "forcing": forcing[:40], "faults": faults,
              "override": {k: v for k, v in self.kin_override.items() if k != "source"} or None}
        await self.emit(ev)
        sp_ = self.speed_post or {}
        i["kinematics"] = {
            "model": {k: v for k, v in self.kin.to_dict().items() if v not in (None, [], False)},
            "line_frequency_hz": (getattr(self, "line", None) or {}).get("line_hz"),
            "speed_posterior": ({"map_rpm": sp_.get("map_rpm"), "ci68_rpm": sp_.get("ci68_rpm"), "p_map": sp_.get("p_map"),
                                 "modes": [{"rpm": m["rpm"], "p": m["p"], "relation": m.get("relation")} for m in sp_.get("modes", [])],
                                 "prior": sp_.get("prior"), "explained_peaks": f'{sp_.get("n_explained")}/{sp_.get("n_peaks")}',
                                 "display_rpm": sp_.get("display_rpm"), "display_error_pct": sp_.get("display_error_pct")}
                                if sp_ else None),
            "fault_posterior": [{"id": h["id"], "title": h["title"], "p": h["p"], "p_range": h["p_range"],
                                 "prior": h["prior"], "evaluable": h["evaluable"],
                                 "evidence": [{"feature": e["feature"], "value": e["value"], "db": round(e["db"], 1)}
                                              for e in h["evidence"]]} for h in faults],
        }
        return i["kinematics"]

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

        async def test_kinematic_hypothesis(args):
            if args.get("revert"):
                self.kin_override = {}
                self.kin = KIN.Kinematics.from_scene(self.scene, self.nameplate)
                out = await self.kinematic_inference(override={"source": self.kin.source})
                self.kin_override = {}
                return out
            names = {"machine_class": "machine"}
            ov = {names.get(k, k): v for k, v in args.items() if k != "revert" and v not in (None, "")}
            ov["source"] = "what-if (Muse Wonder)"
            return await self.kinematic_inference(override=ov)

        async def propose_action(args):
            kind = args.get("kind")
            i = self.ident
            params = {}
            if kind == "skip_bands":
                bands = (self.proposal or {}).get("exclusion_bands_rpm") or getattr(self, "_last_opt", {}).get("exclusion_bands_rpm")
                if not bands:
                    r = optimise(self.twin)
                    bands = r.get("exclusion_bands_rpm")
                if not bands:
                    return {"error": "no resonance bands identified: nothing to program"}
                params = {"bands_rpm": bands[:3]}
            elif kind == "balance":
                params = {"grade": 6.3, "rotor_kg": 25.0, "radius_mm": 120.0}
            elif kind == "work_order":
                params = {"fault_id": args.get("fault_id"), "summary": args.get("summary")}
            elif kind not in ("impact", "followup"):
                return {"error": f"unknown action kind {kind}"}
            a = await self.actions.propose(kind, args.get("title") or kind, args.get("rationale", ""), params,
                                           proposer=mc.OPEN_WEIGHTS if private else mc.WONDER)
            return {"action_id": a["id"], "status": a["status"],
                    "note": ("waiting for operator approval" if a["status"] == "proposed" else
                             "no drive connected: include the procedure in a work order instead" if a["status"] == "needs_drive"
                             else a["status"]),
                    "result": a.get("result")}

        async def propose_setpoint(args):
            r = getattr(self, "_last_opt", None) or optimise(self.twin)
            return await self._emit_proposal(r, args.get("rationale", ""), mc.OPEN_WEIGHTS if private else mc.WONDER)

        try:
            await agent.run({"get_identification": get_identification, "run_optimiser": run_optimiser,
                             "report_diagnosis": report_diagnosis, "propose_setpoint": propose_setpoint,
                             "test_kinematic_hypothesis": test_kinematic_hypothesis,
                             "propose_action": propose_action},
                            self.emit, private=private, ledger=ledger)
        except Exception as e:
            await self.emit({"type": "error", "message": f"agent failed: {e}"})
            await self._rule_based()
        if self.kin_override:
            # what-ifs are transient: the agent's comparisons stay in the timeline, the final state is
            # what Muse Spark read from the machine
            self.kin_override = {}
            self.kin = KIN.Kinematics.from_scene(self.scene, self.nameplate)
            await self.kinematic_inference(override={"source": self.kin.source})
            self.kin_override = {}

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
        for h in (i.get("kinematics") or {}).get("fault_posterior", []):
            if h["evaluable"] and h["p"] >= 0.5:
                ev = "; ".join(f"{e['feature']} {e['value']} ({e['db']:+.1f} dB)" for e in h["evidence"])
                await self.emit({"type": "diagnosis", "id": f"d-kin-{h['id']}", "severity": "warn" if h["p"] < 0.8 else "alarm",
                                 "title": f"{h['title']}: P = {h['p']:.2f}",
                                 "summary": f"Fault posterior {h['p']:.2f} (prior {h['prior']:.2f}). Evidence: {ev}.",
                                 "evidence": [], "confidence": h["p"], "model": "rules"})
        await self._emit_proposal(optimise(self.twin), "Deterministic optimiser (no LLM).", "rules")
        await self.plan_actions_rules()

    async def plan_actions_rules(self):
        """Deterministic action plan (no LLM): what a reliability engineer would queue for this evidence."""
        i = self.ident
        faults = [h for h in (i.get("kinematics") or {}).get("fault_posterior", []) if h["evaluable"]]
        top = faults[0] if faults else None
        if top and top["p"] >= 0.4:
            await self.actions.propose("work_order", f"Work order: {top['title']}", "Highest fault posterior.",
                                       {"fault_id": top["id"]})
            if top["id"] == "imbalance":
                await self.actions.propose("balance", "Field-balance the rotor", "1x-dominant vibration.",
                                           {"grade": 6.3, "rotor_kg": 25.0, "radius_mm": 120.0})
        bands = (self.proposal or {}).get("exclusion_bands_rpm")
        if bands:
            await self.actions.propose("skip_bands", "Lock the drive out of resonance bands",
                                       "Campbell / optimiser exclusion bands.", {"bands_rpm": bands[:3]})
        if self.proposal:
            await self.actions.propose("impact", "Annual energy and cost impact", "Proposed setpoint.", {})
        await self.actions.propose("followup", "Schedule the re-measurement", "Severity and fault posterior.", {})

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

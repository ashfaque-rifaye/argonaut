"""Honest accuracy benchmark of the Argonaut DSP pipeline against the synthetic ground truth.

Fully offline (no model API: regions come from the ground-truth part boxes, not SAM). For every
synthetic preset in data/synth/ it runs ``Session.analyse_clip`` exactly as the app does and compares
``Session.ident`` plus the raw ``measure_regions`` output with the exact truth in ``<clip>.json``
(schema argonaut.synth.v1). Each preset is also re-run with every region box perturbed (shifted by
+-10 % of its size, shrunk / grown by 10 %) to show how robust the numbers are to imperfect masks.

    uv run python scripts/benchmark.py                 # full run (~3-6 min on 8+ cores)
    uv run python scripts/benchmark.py --quick         # nominal boxes only
    uv run python scripts/benchmark.py --from-json     # rebuild docs/BENCHMARK.md from the saved JSON

Writes data/benchmark_results.json (raw numbers) and docs/BENCHMARK.md (tables + method + limits).
Nothing under argonaut/ is modified; session event logs go to a temporary directory that is deleted.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import shutil
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SYNTH = ROOT / "data" / "synth"
OUT_JSON = ROOT / "data" / "benchmark_results.json"
OUT_MD = ROOT / "docs" / "BENCHMARK.md"

PRESETS = ["fan_coastdown", "pump_steady_misalignment", "pump_cavitation", "imbalance_before", "imbalance_after",
           "shake_test"]
# Region perturbations: (name, dx, dy, size factor), dx/dy as a fraction of the box width/height.
VARIANTS = [("nominal", 0.0, 0.0, 1.0), ("shift+10%", 0.10, 0.10, 1.0), ("shift-10%", -0.10, -0.10, 1.0),
            ("shrink10%", 0.0, 0.0, 0.90), ("grow10%", 0.0, 0.0, 1.10)]
PIPELINE_ORDERS = (1, 2, 5)  # orders the pipeline draws on its Campbell diagram
MODE_TOL = 0.15  # an estimate matches a true mode if within +-15 % in frequency


# ============================================================================================
# Ground truth helpers
# ============================================================================================

def load_truth(preset: str) -> dict:
    with open(SYNTH / f"{preset}.json", encoding="utf-8") as f:
        t = json.load(f)
    assert t["schema"] == "argonaut.synth.v1", t["schema"]
    return t


def _bbox_overlap_frac(a, b) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    return inter / max(1e-9, (a[2] - a[0]) * (a[3] - a[1]))


def select_parts(truth: dict, include_contaminated: bool = False) -> tuple[list[str], list[str], str | None]:
    """Rigid, non-rotating parts to track; parts whose box overlaps a rotating sprite are 'contaminated'.

    Rotating sprites are those that `follow` another part (fan blades, the coupling with its tape)."""
    parts = truth["parts"]
    ref = next((p for p, v in parts.items() if v["is_reference"]), None)
    rotating = [p for p, v in parts.items() if v.get("follows")]
    clean, contaminated = [], []
    for p, v in parts.items():
        if v["is_reference"] or p in rotating:
            continue
        hit = any(_bbox_overlap_frac(v["bbox_rest"], parts[r]["bbox_rest"]) > 0.2 for r in rotating)
        (contaminated if hit else clean).append(p)
    return clean, (contaminated if include_contaminated else []), ref


def perturb_bbox(b, dx, dy, size, w, h):
    x1, y1, x2, y2 = b
    bw, bh = x2 - x1, y2 - y1
    cx, cy = (x1 + x2) / 2 + dx * bw, (y1 + y2) / 2 + dy * bh
    bw, bh = bw * size, bh * size
    nb = (cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2)
    return (int(np.clip(round(nb[0]), 0, w - 1)), int(np.clip(round(nb[1]), 0, h - 1)),
            int(np.clip(round(nb[2]), 0, w - 1)), int(np.clip(round(nb[3]), 0, h - 1)))


# ============================================================================================
# Signal helpers
# ============================================================================================

def dft_at(x: np.ndarray, f: float, fs: float) -> complex:
    """Complex peak amplitude of the component at exactly f (Hann window, amplitude-correct)."""
    x = np.asarray(x, float) - np.mean(x)
    w = np.hanning(len(x))
    n = np.arange(len(x))
    return complex(2 * np.sum(x * w * np.exp(-2j * np.pi * f * n / fs)) / w.sum())


def highpass(x, fs, fc=2.0):
    from scipy import signal
    sos = signal.butter(4, fc, "highpass", fs=fs, output="sos")
    return signal.sosfiltfilt(sos, np.asarray(x, float) - np.mean(x), axis=0)


def dominant_freq(d: np.ndarray, fs: float, fmin: float = 2.0) -> float:
    """Frequency of the largest 2-D displacement component above fmin (zero-padded Hann FFT)."""
    d = d - d.mean(axis=0)
    n = len(d)
    nfft = int(2 ** np.ceil(np.log2(n)) * 4)
    w = np.hanning(n)[:, None]
    X = np.fft.rfft(d * w, nfft, axis=0)
    f = np.fft.rfftfreq(nfft, 1 / fs)
    a = np.sqrt((np.abs(X) ** 2).sum(axis=1))
    a[(f < fmin) | (f > fs / 2 * 0.95)] = 0
    return float(f[int(np.argmax(a))])


def exposure_gain(f: float, exposure_s: float) -> float:
    """Amplitude a box-car exposure (motion blur) leaves of a sinusoid at f: |sinc(f * T)|."""
    return float(abs(np.sinc(f * exposure_s)))


def part_metrics(meas: np.ndarray, true: np.ndarray, fs: float) -> dict:
    """Gain / phase at the dominant true component and broadband agreement for one tracked part."""
    meas = meas - meas.mean(axis=0)
    true = true - true.mean(axis=0)
    f0 = dominant_freq(true, fs)
    T = np.array([dft_at(true[:, k], f0, fs) for k in range(2)])
    M = np.array([dft_at(meas[:, k], f0, fs) for k in range(2)])
    ax = int(np.argmax(np.abs(T)))
    th, mh = highpass(true, fs), highpass(meas, fs)
    ax_c = int(np.argmax(th.std(axis=0)))
    corr = float(np.corrcoef(th[:, ax_c], mh[:, ax_c])[0, 1]) if th[:, ax_c].std() > 0 and mh[:, ax_c].std() > 0 else None
    rms_true = float(np.sqrt(np.mean((th ** 2).sum(axis=1))))
    rms_err = float(np.sqrt(np.mean(((mh - th) ** 2).sum(axis=1))))
    return {
        "f_dom_hz": f0, "true_amp_px": float(np.linalg.norm(np.abs(T))), "meas_amp_px": float(np.linalg.norm(np.abs(M))),
        "gain": float(np.linalg.norm(np.abs(M)) / max(np.linalg.norm(np.abs(T)), 1e-12)),
        "phase_err_deg": float(np.degrees(np.angle(M[ax] / T[ax]))) if abs(T[ax]) > 0 and abs(M[ax]) > 0 else None,
        "dom_axis": "xy"[ax], "corr_hp2hz": corr, "corr_axis": "xy"[ax_c],
        "rms_true_hp_px": rms_true, "rms_err_hp_px": rms_err, "rms_err_ratio": rms_err / max(rms_true, 1e-12),
    }


def nearest(cands: list[dict], f_true: float, tol: float = MODE_TOL) -> dict | None:
    c = [m for m in cands if abs(m["f_hz"] - f_true) <= tol * f_true]
    return min(c, key=lambda m: abs(m["f_hz"] - f_true)) if c else None


# ============================================================================================
# One pipeline run (worker process)
# ============================================================================================

def read_video_lowmem(path: str, max_frames: int | None = None, max_width: int = 960):
    """Same decoding as argonaut.dsp.motion.read_video (INTER_AREA resize to <= max_width, BGR->gray), but
    written into one preallocated array so a 4800-frame clip needs 2.5 GB instead of 5 GB at peak."""
    import cv2
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise FileNotFoundError(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n_hint = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) + 8
    if max_frames:
        n_hint = min(n_hint, max_frames)
    buf, n, scale = None, 0, 1.0
    while True:
        if max_frames and n >= max_frames:
            break
        ok, frame = cap.read()
        if not ok:
            break
        h, w = frame.shape[:2]
        if w > max_width:
            scale = max_width / w
            frame = cv2.resize(frame, (max_width, round(h * scale)), interpolation=cv2.INTER_AREA)
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if buf is None:
            buf = np.empty((n_hint,) + g.shape, np.uint8)
        if n >= len(buf):  # frame count hint was short: grow (rare)
            buf = np.concatenate([buf, np.empty_like(buf[: max(64, len(buf) // 4)])])
        buf[n] = g
        n += 1
    cap.release()
    if not n:
        raise ValueError(f"no frames decoded from {path}")
    return buf[:n], float(fps), scale


_FRAME_CACHE: dict = {}


def run_group(jobs: list[dict]) -> list[dict]:
    """All region variants of one clip in one process: decode the video once, reuse it for every run."""
    import argonaut.pipeline as pl
    path = str(SYNTH / load_truth(jobs[0]["preset"])["video"])
    _FRAME_CACHE[path] = read_video_lowmem(path)
    orig_read = pl.read_video
    pl.read_video = lambda p, max_frames=None, max_width=960: _FRAME_CACHE[p] if p in _FRAME_CACHE else orig_read(p, max_frames, max_width)
    out = []
    try:
        for j in jobs:
            try:
                out.append(run_job(j))
            except Exception as e:  # keep going; report the failure
                out.append({"preset": j["preset"], "variant": j["variant"], "diagnostic": j.get("diagnostic"),
                            "m": {"pipeline_failed": 1.0}, "error": repr(e), "tracked": [], "rejected": []})
    finally:
        pl.read_video = orig_read
        _FRAME_CACHE.clear()
    return out


def run_job(job: dict) -> dict:
    """Run Session.analyse_clip offline on one clip with one region variant; return scalar metrics."""
    import cv2
    cv2.setNumThreads(1)
    from argonaut.models import client as mc
    mc.api_key = lambda: ""  # force fully offline (no Spark / SAM / agent)
    import argonaut.pipeline as pl
    from argonaut.dsp.motion import Region
    saved = (pl.RUNS, pl.measure_regions, pl.identify.track_speed, pl.A.acoustic_track)
    try:
        return _run_job(job, pl, Region)
    finally:  # undo the instrumentation so the next run in this process starts clean
        pl.RUNS, pl.measure_regions, pl.identify.track_speed, pl.A.acoustic_track = saved


def _run_job(job, pl, Region) -> dict:
    import cv2

    t_start = time.perf_counter()
    preset, vname, dx, dy, size = job["preset"], job["variant"], job["dx"], job["dy"], job["size"]
    truth = load_truth(preset)
    path = str(SYNTH / truth["video"])
    cap = cv2.VideoCapture(path)
    src_w, src_h = cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    cap.release()
    dec_w = min(int(src_w), 960)  # read_video downsizes to max_width=960
    dec_h = int(round(src_h * dec_w / src_w))
    s_tr = dec_w / truth["width"]  # truth px -> decoded px
    mm_per_px = truth["mm_per_px"] / s_tr

    clean, contam, ref = select_parts(truth, include_contaminated=job.get("contaminated", False))
    tracked = clean + contam
    regions = []
    for p in tracked + ([ref] if ref else []):
        b = [c * s_tr for c in truth["parts"][p]["bbox_rest"]]
        regions.append(Region(p, p, perturb_bbox(b, dx, dy, size, dec_w, dec_h), is_reference=(p == ref)))

    tmp = Path(tempfile.mkdtemp(prefix="argonaut_bench_"))
    pl.RUNS = tmp  # keep the session event log out of data/runs
    captured: dict = {}
    orig_measure = pl.measure_regions

    def measure_and_capture(frames, regs):
        out = orig_measure(frames, regs)
        captured["motion"], captured["n_frames"] = out, len(frames)
        return out

    pl.measure_regions = measure_and_capture
    # Capture the speed trackers' internals: the first track_speed call is the video ridge, then audio.
    speed_calls: list = []
    orig_track = pl.identify.track_speed

    def track_and_capture(*a, **k):
        out = orig_track(*a, **k)
        speed_calls.append(out)
        return out

    pl.identify.track_speed = track_and_capture
    orig_acoustic = pl.A.acoustic_track

    def acoustic_and_capture(*a, **k):
        tone, aconf, wf, tone_k = orig_acoustic(*a, **k)
        captured["audio_tone_hz"], captured["audio_conf"], captured["audio_tone_order"] = tone, aconf, tone_k
        if job.get("video_tach"):  # diagnostic: make the audio tachometer never win the confidence vote
            aconf = np.zeros_like(aconf)
        return tone, aconf, wf, tone_k

    pl.A.acoustic_track = acoustic_and_capture
    events: list[dict] = []

    async def sink(ev):
        if ev["type"] in ("telemetry", "campbell", "modal", "coach", "error"):
            events.append(ev)
        elif ev["type"] == "waterfall" and "main_channel" not in captured and ev.get("channel") != "mic":
            captured["main_channel"] = ev["channel"]

    s = pl.Session(f"bench_{preset}_{vname}", preset, emit=sink)
    try:
        asyncio.run(s.analyse_clip(path, realtime=1e6, regions=regions, mm_per_px=mm_per_px, run_agent=False))
    finally:
        s._log.close()
        shutil.rmtree(tmp, ignore_errors=True)
    ident = s.ident
    res: dict = {"preset": preset, "variant": vname, "diagnostic": job.get("diagnostic"),
                 "regions": {r.id: list(r.bbox) for r in regions}, "tracked": tracked, "reference": ref,
                 "rejected": list(getattr(s, "_rejected", [])), "main_channel": captured.get("main_channel"),
                 "errors": [e.get("message") for e in events if e["type"] == "error"], "m": {}}
    m = res["m"]
    fps = truth["fps"]
    t_true = np.asarray(truth["frames"]["t"])
    rpm_true = np.asarray(truth["frames"]["speed_rpm"])

    # ---------------- raw tracker vs true displacement
    mot = captured.get("motion", {})
    n = min(captured.get("n_frames", 0), truth["n_frames"])
    fp = truth["frames"]["parts"]
    true_d = {p: np.stack([fp[p]["x"], fp[p]["y"]], 1)[:n] * s_tr for p in fp}
    meas_d = {p: mot[p]["disp_px"][:n] for p in tracked if p in mot}
    for p, d in meas_d.items():
        if np.abs(true_d[p] - true_d[p].mean(axis=0)).max() < 1e-4:  # part does not move: tracker noise floor
            m[f"part.{p}.static_noise_rms_px"] = float(np.sqrt(np.mean((highpass(d, fps) ** 2).sum(axis=1))))
            m[f"part.{p}.method"] = mot[p]["quality"].get("method")
            m[f"part.{p}.features"] = mot[p]["quality"].get("features")
            continue
        pm = part_metrics(d, true_d[p], fps)
        pm.update(method=mot[p]["quality"].get("method"), features=mot[p]["quality"].get("features"),
                  rigid=mot[p]["quality"].get("rigid"), feature_spread_px=mot[p]["quality"].get("feature_spread_px"),
                  expected_blur_gain=exposure_gain(pm["f_dom_hz"], truth["exposure_s"]))
        for k, v in pm.items():
            m[f"part.{p}.{k}"] = v

    const_speed = truth["speed_profile"]["kind"] == "constant"
    f_run = float(np.mean(rpm_true[:n])) / 60.0
    # Per-order gain of every tracked part/axis (steady clips): evidence for sub-pixel attenuation.
    order_pts = []
    if const_speed:
        for o in truth["orders"]:
            f = o["order"] * f_run
            if f >= fps / 2 * 0.95:
                continue
            for p, d in meas_d.items():
                for k, axn in enumerate("xy"):
                    T = dft_at(true_d[p][:, k], f, fps)
                    if abs(T) < 0.005:
                        continue
                    M = dft_at(d[:, k], f, fps)
                    order_pts.append({"part": p, "axis": axn, "order": o["order"], "f_hz": f, "true_px": abs(T),
                                      "meas_px": abs(M), "gain": abs(M) / abs(T),
                                      "phase_err_deg": float(np.degrees(np.angle(M / T))),
                                      "blur_gain": exposure_gain(f, truth["exposure_s"]),
                                      "method": mot[p]["quality"].get("method")})
    res["order_points"] = order_pts

    # 2x phase motor vs pump (axial x), raw tracker and truth
    mt = None
    if const_speed and "motor" in meas_d and "pump" in meas_d:
        f2 = 2 * f_run
        mt, pt = dft_at(true_d["motor"][:, 0], f2, fps), dft_at(true_d["pump"][:, 0], f2, fps)
        mm_, pm_ = dft_at(meas_d["motor"][:, 0], f2, fps), dft_at(meas_d["pump"][:, 0], f2, fps)
        if min(abs(mt), abs(pt)) < 0.01:  # no meaningful 2x in this clip
            mt = None
    if const_speed and "motor" in meas_d and "pump" in meas_d and mt is not None:
        m["phase2x.truth_deg"] = float(abs(np.degrees(np.angle(pt / mt))))
        m["phase2x.track_deg"] = float(abs(np.degrees(np.angle(pm_ / mm_))))
        m["amp2x.motor_x.true_px"], m["amp2x.motor_x.meas_px"] = abs(mt), abs(mm_)
        m["amp2x.pump_x.true_px"], m["amp2x.pump_x.meas_px"] = abs(pt), abs(pm_)
    if const_speed:
        # 1x vector amplitude of each part (used for the imbalance before/after reduction)
        for p in meas_d:
            T = np.array([dft_at(true_d[p][:, k], f_run, fps) for k in range(2)])
            M = np.array([dft_at(meas_d[p][:, k], f_run, fps) for k in range(2)])
            m[f"amp1x.{p}.true_px"] = float(np.linalg.norm(np.abs(T)))
            m[f"amp1x.{p}.meas_px"] = float(np.linalg.norm(np.abs(M)))

    # Camera-shake rejection: residual (tracked - true part motion) vs the true shake
    shake = np.stack([truth["frames"]["shake"]["x"], truth["frames"]["shake"]["y"]], 1)[:n] * s_tr
    shake = shake - shake.mean(axis=0)
    shake_rms = float(np.sqrt(np.mean((shake ** 2).sum(axis=1))))
    if shake_rms > 1e-6 and ref in mot:
        wall = mot[ref]["disp_px"][:n]
        m["shake.true_rms_px"] = shake_rms
        m["shake.wall_track_err_rms_px"] = float(np.sqrt(np.mean(((wall - shake) ** 2).sum(axis=1))))
        m["shake.wall_track_gain"] = float(np.sqrt(np.mean((wall ** 2).sum(axis=1))) / shake_rms)
        for p, d in meas_d.items():
            tp = true_d[p] - true_d[p].mean(axis=0)
            res_c = d - tp
            res_u = (d + wall) - tp  # what the part track would be without the wall reference
            m[f"shake.{p}.residual_rms_px"] = float(np.sqrt(np.mean((res_c ** 2).sum(axis=1))))
            m[f"shake.{p}.ratio_compensated"] = m[f"shake.{p}.residual_rms_px"] / shake_rms
            m[f"shake.{p}.ratio_uncompensated"] = float(np.sqrt(np.mean((res_u ** 2).sum(axis=1)))) / shake_rms
            m[f"shake.{p}.true_part_rms_px"] = float(np.sqrt(np.mean((tp ** 2).sum(axis=1))))

    if not ident:
        res["m"]["pipeline_failed"] = 1.0
        res["runtime_s"] = time.perf_counter() - t_start
        return res

    # ---------------- running speed
    tel = [e for e in events if e["type"] == "telemetry"]
    ct = np.array([e["clip_t"] for e in tel])
    sp_est = np.array([e["speed_hz"] for e in tel])
    sp_true = np.interp(ct, t_true, rpm_true) / 60.0
    op = slice(0, 4) if sp_est[0] > sp_est[-1] else slice(-4, None)
    m["speed.now_est_rpm"] = ident["speed_rpm_now"]
    m["speed.now_true_rpm"] = float(sp_true[op].mean() * 60)
    m["speed.now_err_pct"] = 100 * (ident["speed_rpm_now"] / m["speed.now_true_rpm"] - 1)
    ok = sp_true > 2.0  # ignore the final near-standstill seconds of a coast-down
    rel = np.abs(sp_est[ok] / sp_true[ok] - 1)
    m["speed.track_median_abs_err_pct"] = float(100 * np.median(rel))
    m["speed.track_p90_abs_err_pct"] = float(100 * np.percentile(rel, 90))
    m["speed.track_frac_within_2pct"] = float(np.mean(rel < 0.02))
    m["speed.sweep_frac_est"] = ident["speed_sweep_frac"]
    res["speed_source"] = ident["speed_source"]
    if speed_calls:
        m["diag.video_ridge_speed_rpm_median"] = float(np.median(speed_calls[0][0]) * 60)
        m["diag.video_ridge_conf_median"] = float(np.median(speed_calls[0][1]))
    if "audio_tone_hz" in captured:
        m["diag.audio_tone_hz_median"] = float(np.median(captured["audio_tone_hz"]))
        m["diag.audio_tone_order"] = float(np.median(captured["audio_tone_hz"]) / f_run) if f_run > 0 else None
        m["diag.audio_conf_median"] = float(np.median(captured["audio_conf"]))
    res["speed_track"] = {"t": ct.tolist(), "est_hz": sp_est.tolist(), "true_hz": sp_true.tolist()}

    # ---------------- modes (SDOF fit / half-power / residual-spectrum peak / FDD)
    est_modes = ident["modes"]
    fdd = ident["fdd_modes"]
    groups = {"sdof": [x for x in est_modes if "SDOF" in x["source"]],
              "halfpower": [x for x in est_modes if "half-power" in x["source"]],
              "residual": [x for x in est_modes if "residual" in x["source"]],
              "fdd": fdd}
    for tm in truth["modes"]:
        key = tm["name"].replace(" ", "_")
        for g, cands in groups.items():
            e = nearest(cands, tm["fn_hz"])
            if e is None:
                continue
            m[f"mode.{key}.{g}.f_hz"] = e["f_hz"]
            m[f"mode.{key}.{g}.f_err_hz"] = e["f_hz"] - tm["fn_hz"]
            m[f"mode.{key}.{g}.f_err_pct"] = 100 * (e["f_hz"] / tm["fn_hz"] - 1)
            if e.get("f_err_hz") is not None:
                m[f"mode.{key}.{g}.f_sigma_hz"] = e["f_err_hz"]
            if e.get("zeta") is not None:
                m[f"mode.{key}.{g}.zeta"] = e["zeta"]
                m[f"mode.{key}.{g}.zeta_err_abs"] = e["zeta"] - tm["zeta"]
                m[f"mode.{key}.{g}.zeta_err_rel_pct"] = 100 * (e["zeta"] / tm["zeta"] - 1)
                if e.get("zeta_err") is not None:
                    m[f"mode.{key}.{g}.zeta_sigma"] = e["zeta_err"]
    # Spurious "modes": estimates not near any true mode (and whether they sit on an order line)
    spur = []
    speed_now = ident["speed_hz_now"]
    for g, cands in groups.items():
        for e in cands:
            if all(abs(e["f_hz"] - tm["fn_hz"]) > MODE_TOL * tm["fn_hz"] for tm in truth["modes"]):
                k = e["f_hz"] / f_run if const_speed else None
                spur.append({"method": g, "f_hz": e["f_hz"],
                             "on_order": (round(k) if k and abs(k - round(k)) < 0.03 and round(k) >= 1 else None)})
    res["spurious_modes"] = spur
    res["est_modes"] = {g: [{"f_hz": x["f_hz"], "zeta": x.get("zeta")} for x in c] for g, c in groups.items()}

    # ---------------- Campbell critical speeds (pipeline orders 1, 2, 5)
    lo, hi = float(rpm_true.min()), float(rpm_true.max())
    crit_est = ident["campbell_criticals"]
    for tc in truth["criticals"]:
        if tc["order"] not in PIPELINE_ORDERS or not (lo <= tc["rpm"] <= hi):
            continue
        key = f"crit.{int(tc['order'])}x.{tc['mode'].replace(' ', '_')}"
        m[f"{key}.true_rpm"] = tc["rpm"]
        c = [x for x in crit_est if x["order"] == tc["order"]
             and abs(x["mode_f_hz"] - tc["mode_f_hz"]) <= MODE_TOL * tc["mode_f_hz"]]
        if c:
            best = min(c, key=lambda x: abs(x["rpm"] - tc["rpm"]))
            m[f"{key}.est_rpm"] = best["rpm"]
            m[f"{key}.err_rpm"] = best["rpm"] - tc["rpm"]
    res["est_criticals"] = crit_est

    # ---------------- FDD 2x operating shape phase motor vs pump
    if const_speed:
        f2 = 2 * f_run
        near = [x for x in fdd if abs(x["f_hz"] - f2) < 0.05 * f2]
        if near:
            x = min(near, key=lambda q: abs(q["f_hz"] - f2))
            ch = x["channels"]
            if "motor" in ch and "pump" in ch:
                d = x["shape_phase_deg"][ch.index("pump")] - x["shape_phase_deg"][ch.index("motor")]
                m["phase2x.fdd_deg"] = float(abs((d + 180) % 360 - 180))

    # ---------------- order velocities, cavitation, ISO
    for k, v in ident["orders_vel_mm_s_now"].items():
        m[f"order{k}.vel_mm_s_now"] = v
    if ident.get("cavitation"):
        m["cav.index"] = ident["cavitation"]["index"]
        m["cav.hf_energy_fraction"] = ident["cavitation"]["hf_energy_fraction"]
        m["cav.hf_kurtosis"] = ident["cavitation"]["hf_kurtosis"]
    res["iso_zone"] = ident["iso_zone"]
    res["runtime_s"] = time.perf_counter() - t_start
    return res


# ============================================================================================
# Aggregation
# ============================================================================================

def stats(vals):
    v = np.array([x for x in vals if isinstance(x, (int, float)) and not isinstance(x, bool) and np.isfinite(x)], float)
    if not len(v):
        return None
    return {"mean": float(v.mean()), "std": float(v.std(ddof=1)) if len(v) > 1 else 0.0, "min": float(v.min()),
            "max": float(v.max()), "n": int(len(v))}


def aggregate(runs: dict) -> dict:
    """runs[preset][variant] -> result. Adds per-metric stats over all region variants, plus cross-clip metrics."""
    agg: dict = {}
    for preset, vs in runs.items():
        keys = sorted({k for r in vs.values() if not r.get("diagnostic") for k in r["m"]})
        agg[preset] = {}
        for k in keys:
            vals = [r["m"].get(k) for v, r in vs.items() if not r.get("diagnostic")]
            nominal = vs.get("nominal", {}).get("m", {}).get(k)
            agg[preset][k] = {"nominal": nominal, "variants": stats(vals),
                              "missing_in": [v for v, r in vs.items() if not r.get("diagnostic") and r["m"].get(k) is None]}
    # Cross-clip: imbalance reduction and cavitation separation, per region variant
    cross: dict = {"imbalance_reduction": {}, "cavitation": {}}
    variants = [v for v in runs.get("imbalance_before", {}) if v in runs.get("imbalance_after", {})]  # incl. video_tach
    for v in variants:
        b, a = runs["imbalance_before"][v]["m"], runs["imbalance_after"][v]["m"]
        row = {}
        if b.get("order1.vel_mm_s_now") and a.get("order1.vel_mm_s_now") is not None:
            row["pipeline_1x_vel_pct"] = 100 * (1 - a["order1.vel_mm_s_now"] / b["order1.vel_mm_s_now"])
        for p in ("motor", "pump", "pipe", "baseplate"):
            if b.get(f"amp1x.{p}.meas_px") and a.get(f"amp1x.{p}.meas_px") is not None:
                row[f"track_{p}_pct"] = 100 * (1 - a[f"amp1x.{p}.meas_px"] / b[f"amp1x.{p}.meas_px"])
                row[f"truth_{p}_pct"] = 100 * (1 - a[f"amp1x.{p}.true_px"] / b[f"amp1x.{p}.true_px"])
        row["main_channel_before"] = runs["imbalance_before"][v].get("main_channel")
        row["main_channel_after"] = runs["imbalance_after"][v].get("main_channel")
        cross["imbalance_reduction"][v] = row
    pumps = ["pump_steady_misalignment", "imbalance_before", "imbalance_after"]
    for v in runs.get("pump_cavitation", {}):
        cav = runs["pump_cavitation"][v]["m"].get("cav.index")
        others = [runs[p][v]["m"].get("cav.index") for p in pumps if p in runs and v in runs[p]]
        others = [o for o in others if o is not None]
        if cav is not None and others:
            cross["cavitation"][v] = {"cavitation_index": cav, "max_non_cavitation_index": max(others),
                                      "separation": cav - max(others), "ratio": cav / max(max(others), 1e-9),
                                      "flagged_at_0.5": cav > 0.5, "false_alarms_at_0.5": sum(o > 0.5 for o in others)}
    return {"per_preset": agg, "cross": cross}


# ============================================================================================
# Report
# ============================================================================================

def _fmt(x, nd=2, pct=False, sign=False):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return "n/a"
    s = f"{x:+.{nd}f}" if sign else f"{x:.{nd}f}"
    return s + ("%" if pct else "")


def _spread(a: dict, key: str, nd=2, pct=False):
    s = (a.get(key) or {}).get("variants")
    if not s:
        return "n/a"
    miss = len((a.get(key) or {}).get("missing_in") or [])
    return f"{s['mean']:.{nd}f} ± {s['std']:.{nd}f}{'%' if pct else ''}" + (f" (n={s['n']}, {miss} miss)" if miss else "")


def write_report(data: dict) -> str:
    runs, agg, cross = data["runs"], data["aggregate"]["per_preset"], data["aggregate"]["cross"]
    truth = {p: data["truth_summary"][p] for p in data["truth_summary"]}
    L = []
    w = L.append
    w("# Argonaut accuracy benchmark (synthetic ground truth)\n")
    w(f"Generated by `scripts/benchmark.py` on {data['generated']} in {data['runtime_s']:.0f} s, fully offline "
      "(no model API: no SAM, no Muse Spark, no agent). Raw numbers: `data/benchmark_results.json`.\n")
    w("Every number below compares the unmodified pipeline (`Session.analyse_clip`, `measure_regions`) with the "
      "exact answer the clip was rendered from. *Nominal* = regions are the true part boxes. *Perturbed* = "
      f"mean ± sample std over {len(VARIANTS)} region variants (nominal, boxes shifted +10 % and -10 % of their size "
      "in x and y, shrunk 10 %, grown 10 %), so it shows how much a sloppy mask moves the answer. "
      "`n/a` means the pipeline produced no estimate for that quantity.\n")

    # ---------------- headline
    w("## Headline\n")
    w("| Quantity | Estimate (nominal) | Truth | Error | Perturbed (mean ± std) |")
    w("|---|---|---|---|---|")
    hl = data["headline"]
    for row in hl:
        w(f"| {row['name']} | {row['est']} | {row['truth']} | {row['err']} | {row['spread']} |")
    w("")

    # ---------------- speed
    w("## 1. Running speed\n")
    w("`speed_rpm_now` is the operating speed the pipeline reports (mean of the first 4 STFT slices for a "
      "coast-down, last 4 otherwise). Track error is the median / 90th-percentile |error| of the full speed "
      "track over every telemetry slice with true speed > 120 rpm.\n")
    w("| Preset | fps | Source | Estimate rpm | Truth rpm | Error | Track median / p90 abs err | Perturbed error |")
    w("|---|---|---|---|---|---|---|---|")
    for p in PRESETS:
        r = runs.get(p, {}).get("nominal")
        if not r or "speed.now_est_rpm" not in r["m"]:
            continue
        mm, a = r["m"], agg[p]
        w(f"| {p} | {truth[p]['fps']:.0f} | {r.get('speed_source')} | {mm['speed.now_est_rpm']:.1f} | "
          f"{mm['speed.now_true_rpm']:.1f} | {_fmt(mm['speed.now_err_pct'], 2, True, True)} | "
          f"{_fmt(mm['speed.track_median_abs_err_pct'], 2, True)} / {_fmt(mm['speed.track_p90_abs_err_pct'], 1, True)} | "
          f"{_spread(a, 'speed.now_err_pct', 2, True)} |")
    w("")

    # ---------------- modes
    w("## 2. Structural modes (natural frequency and damping)\n")
    w("Methods: **SDOF fit** = order-tracked resonance curve from the coast-down with a least-squares SDOF fit "
      "(only runs when the speed sweeps > 25 %); **half-power** = its fallback; **residual** = constant-frequency "
      "peaks left after masking order lines (no damping); **FDD** = frequency domain decomposition across all "
      f"sensors (half-power damping on the first singular value). An estimate counts as found if it is within "
      f"±{int(MODE_TOL * 100)} % of the true natural frequency.\n")
    w("| Preset | True mode | Method | f est (Hz) | f true | f err (Hz / %) | ζ est | ζ true | ζ err abs / rel | Perturbed f err % | Perturbed ζ err rel % |")
    w("|---|---|---|---|---|---|---|---|---|---|---|")
    for p in PRESETS:
        r = runs.get(p, {}).get("nominal")
        if not r:
            continue
        for tm in truth[p]["modes"]:
            key = tm["name"].replace(" ", "_")
            for g in ("sdof", "halfpower", "residual", "fdd"):
                base = f"mode.{key}.{g}"
                a = agg[p]
                if f"{base}.f_hz" not in a:
                    continue
                mm = r["m"]
                w(f"| {p} | {tm['name']} | {g} | {_fmt(mm.get(base + '.f_hz'), 2)} | {tm['fn_hz']:.2f} | "
                  f"{_fmt(mm.get(base + '.f_err_hz'), 2, sign=True)} / {_fmt(mm.get(base + '.f_err_pct'), 1, True, True)} | "
                  f"{_fmt(mm.get(base + '.zeta'), 4)} | {tm['zeta']:.3f} | "
                  f"{_fmt(mm.get(base + '.zeta_err_abs'), 4, sign=True)} / {_fmt(mm.get(base + '.zeta_err_rel_pct'), 0, True, True)} | "
                  f"{_spread(a, base + '.f_err_pct', 1, True)} | {_spread(a, base + '.zeta_err_rel_pct', 0, True)} |")
            found = any(f"mode.{key}.{g}.f_hz" in agg[p] for g in ("sdof", "halfpower", "residual", "fdd"))
            if not found:
                w(f"| {p} | {tm['name']} | (none) | not found | {tm['fn_hz']:.2f} | | | {tm['zeta']:.3f} | | | |")
    w("")
    w("Estimates that match **no** true mode (nominal regions); `on order` = sits on k × running speed, i.e. a forced "
      "response reported as if it were a structural mode:\n")
    w("| Preset | Method | f (Hz) | On order |")
    w("|---|---|---|---|")
    for p in PRESETS:
        r = runs.get(p, {}).get("nominal")
        for s_ in (r or {}).get("spurious_modes", []):
            w(f"| {p} | {s_['method']} | {s_['f_hz']:.2f} | {('%d×' % s_['on_order']) if s_['on_order'] else '-'} |")
    w("")

    # ---------------- criticals
    w("## 3. Critical speeds (Campbell)\n")
    w("True critical speeds inside the clip's speed range for the orders the pipeline draws (1×, 2×, 5×).\n")
    w("| Preset | Critical | Truth rpm | Estimate rpm (nominal) | Error rpm | Perturbed error rpm |")
    w("|---|---|---|---|---|---|")
    for p in PRESETS:
        a = agg.get(p, {})
        for k in sorted(x for x in a if x.startswith("crit.") and x.endswith(".true_rpm")):
            base = k[: -len(".true_rpm")]
            _, o, mode = base.split(".")
            w(f"| {p} | {o} × {mode.replace('_', ' ')} | {a[k]['nominal']:.0f} | "
              f"{_fmt((a.get(base + '.est_rpm') or {}).get('nominal'), 0)} | "
              f"{_fmt((a.get(base + '.err_rpm') or {}).get('nominal'), 0, sign=True)} | {_spread(a, base + '.err_rpm', 0)} |")
    w("")

    # ---------------- phase
    w("## 4. Misalignment: 2× phase, motor vs pump (axial x)\n")
    w("| Source | Estimate (deg) | Truth (deg) | Error (deg) | Perturbed estimate |")
    w("|---|---|---|---|---|")
    p = "pump_steady_misalignment"
    if p in agg:
        a = agg[p]
        tr = (a.get("phase2x.truth_deg") or {}).get("nominal")
        for key, name in (("phase2x.track_deg", "Raw tracker (`measure_regions`, x axis)"),
                          ("phase2x.fdd_deg", "Pipeline FDD shape at 2× (`ident.fdd_modes`)")):
            est = (a.get(key) or {}).get("nominal")
            w(f"| {name} | {_fmt(est, 1)} | 180 (rendered {_fmt(tr, 1)}) | "
              f"{_fmt(None if est is None else est - 180, 1, sign=True)} | {_spread(a, key, 1)} |")
        for part in ("motor", "pump"):
            ta, ma = (a.get(f"amp2x.{part}_x.true_px") or {}).get("nominal"), (a.get(f"amp2x.{part}_x.meas_px") or {}).get("nominal")
            if ta:
                w(f"| 2× amplitude {part} x (px) | {_fmt(ma, 3)} | {_fmt(ta, 3)} | gain {_fmt(ma / ta if ma else None, 2)} | {_spread(a, f'amp2x.{part}_x.meas_px', 3)} |")
    w("")

    # ---------------- imbalance
    w("## 5. Balancing: 1× reduction before → after (truth 85 %)\n")
    w("| Region variant | Pipeline 1× velocity | Tracker motor 1× | Tracker pump 1× | Truth motor 1× (rendered) | Main channel before / after |")
    w("|---|---|---|---|---|---|")
    for v, row in cross["imbalance_reduction"].items():
        w(f"| {v} | {_fmt(row.get('pipeline_1x_vel_pct'), 1, True)} | {_fmt(row.get('track_motor_pct'), 1, True)} | "
          f"{_fmt(row.get('track_pump_pct'), 1, True)} | {_fmt(row.get('truth_motor_pct'), 1, True)} | "
          f"{row.get('main_channel_before')} / {row.get('main_channel_after')} |")
    vals = [row.get("pipeline_1x_vel_pct") for row in cross["imbalance_reduction"].values()]
    s = stats(vals)
    if s:
        w(f"| **mean ± std** | **{s['mean']:.1f} ± {s['std']:.1f} %** | "
          f"{_fmt((stats([r.get('track_motor_pct') for r in cross['imbalance_reduction'].values()]) or {}).get('mean'), 1, True)} | "
          f"{_fmt((stats([r.get('track_pump_pct') for r in cross['imbalance_reduction'].values()]) or {}).get('mean'), 1, True)} | | |")
    w("")

    # ---------------- displacement
    w("## 6. Displacement tracking per part (raw `measure_regions` vs true displacement)\n")
    w("Gain = measured / true amplitude of the dominant true component (2-D vector, exact-frequency Hann DFT); "
      "the motion-blur limit is what a perfect tracker would read through the camera's box-car exposure. "
      "Correlation and RMS-error ratio are on the dominant axis / both axes after a 2 Hz high-pass.\n")
    w("| Preset | Part | Tracker (features) | f dom (Hz) | True amp (px) | Gain | Blur limit | Phase err (deg) | Corr | RMS err / RMS true | Perturbed gain | Perturbed corr |")
    w("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for p in PRESETS:
        r = runs.get(p, {}).get("nominal")
        if not r:
            continue
        for part in r["tracked"]:
            b = f"part.{part}."
            mm, a = r["m"], agg[p]
            if b + "gain" not in mm:
                continue
            meth = "LK" if mm.get(b + "method") == "lucas_kanade" else "phaseCorr"
            rej = " **rejected**" if part in r["rejected"] else ""
            w(f"| {p} | {part}{rej} | {meth} ({mm.get(b + 'features')}) | {mm[b + 'f_dom_hz']:.2f} | {mm[b + 'true_amp_px']:.3f} | "
              f"{mm[b + 'gain']:.2f} | {mm[b + 'expected_blur_gain']:.2f} | {_fmt(mm.get(b + 'phase_err_deg'), 1, sign=True)} | "
              f"{_fmt(mm.get(b + 'corr_hp2hz'), 2)} | {mm[b + 'rms_err_ratio']:.2f} | {_spread(a, b + 'gain', 2)} | "
              f"{_spread(a, b + 'corr_hp2hz', 2)} |")
    w("")
    # amplitude-binned gain
    pts = [q for p in PRESETS for q in (runs.get(p, {}).get("nominal") or {}).get("order_points", [])]
    if pts:
        w("**Gain vs true amplitude** (every order component of every tracked part and axis in the steady clips, "
          "nominal regions; LK tracker only; gain normalised by the motion-blur limit):\n")
        w("| True amplitude (px) | Components | Median gain | 10th–90th pct gain | Median |phase err| (deg) |")
        w("|---|---|---|---|---|")
        bins = [(0.005, 0.03), (0.03, 0.06), (0.06, 0.15), (0.15, 0.4), (0.4, 5.0)]
        for lo, hi in bins:
            q = [x for x in pts if lo <= x["true_px"] < hi and x["method"] == "lucas_kanade"]
            if not q:
                continue
            g = np.array([x["gain"] / x["blur_gain"] for x in q])
            ph = np.array([abs(x["phase_err_deg"]) for x in q])
            w(f"| {lo:.3f}–{hi:.2f} | {len(q)} | {np.median(g):.2f} | {np.percentile(g, 10):.2f}–{np.percentile(g, 90):.2f} | {np.median(ph):.0f} |")
        w("")

    # ---------------- shake
    w("## 7. Camera-shake rejection (shake_test: 1.5 px RMS hand shake + 0.15 px tremor, 60 fps)\n")
    w("Ratio = RMS(tracked part motion − true part motion) / RMS(true shake), both axes, full band. "
      "*Without reference* adds the wall track back, i.e. what the part would read with no static reference.\n")
    p = "shake_test"
    if p in runs:
        a, r = agg[p], runs[p]["nominal"]
        w("| Part | True part RMS (px) | Residual RMS (px) | Ratio with wall reference | Ratio without reference | Perturbed ratio |")
        w("|---|---|---|---|---|---|")
        for part in r["tracked"]:
            b = f"shake.{part}."
            if b + "ratio_compensated" in r["m"]:
                w(f"| {part} | {r['m'][b + 'true_part_rms_px']:.3f} | {r['m'][b + 'residual_rms_px']:.3f} | "
                  f"{r['m'][b + 'ratio_compensated']:.3f} | {r['m'][b + 'ratio_uncompensated']:.2f} | "
                  f"{_spread(a, b + 'ratio_compensated', 3)} |")
        w(f"\nWall track vs true shake: gain {_fmt(r['m'].get('shake.wall_track_gain'), 3)}, "
          f"RMS error {_fmt(r['m'].get('shake.wall_track_err_rms_px'), 3)} px of {_fmt(r['m'].get('shake.true_rms_px'), 2)} px.\n")

    # ---------------- cavitation
    w("## 8. Cavitation index (audio)\n")
    w("| Clip | Index (nominal) | HF energy fraction | HF kurtosis |")
    w("|---|---|---|---|")
    for p in ("pump_cavitation", "pump_steady_misalignment", "imbalance_before", "imbalance_after", "shake_test", "fan_coastdown"):
        r = runs.get(p, {}).get("nominal")
        if r and "cav.index" in r["m"]:
            w(f"| {p} | {r['m']['cav.index']:.3f} | {r['m']['cav.hf_energy_fraction']:.4f} | {r['m']['cav.hf_kurtosis']:.2f} |")
    c = cross["cavitation"].get("nominal")
    if c:
        w(f"\nSeparation (cavitation − highest non-cavitation pump clip): **{c['separation']:+.3f}** "
          f"(ratio {c['ratio']:.2f}×); flagged by the 0.5 rule: {c['flagged_at_0.5']}; false alarms among "
          f"non-cavitation pump clips: {c['false_alarms_at_0.5']}. Audio does not depend on regions, so the "
          "perturbed runs are identical.\n")

    # ---------------- contaminated
    cont = runs.get("fan_coastdown", {}).get("blade_contaminated")
    if cont:
        w("## 9. Blade-contaminated regions (fan guard and motor, whose boxes contain the spinning blades)\n")
        w("| Part | Tracker (features) | Rigid check | Gain | Corr | RMS err / RMS true | Rejected by pipeline |")
        w("|---|---|---|---|---|---|---|")
        for part in cont["tracked"]:
            b = f"part.{part}."
            mm = cont["m"]
            if b + "gain" in mm:
                w(f"| {part} | {mm.get(b + 'method')} ({mm.get(b + 'features')}) | rigid={mm.get(b + 'rigid')}, "
                  f"spread {_fmt(mm.get(b + 'feature_spread_px'), 3)} px | {mm[b + 'gain']:.2f} | {_fmt(mm.get(b + 'corr_hp2hz'), 2)} | "
                  f"{mm[b + 'rms_err_ratio']:.2f} | {part in cont['rejected']} |")
        cm = cont["m"]
        w(f"\nWith these regions included the pipeline reports speed {_fmt(cm.get('speed.now_est_rpm'), 0)} rpm "
          f"(truth {_fmt(cm.get('speed.now_true_rpm'), 0)}), stand-rocking SDOF "
          f"{_fmt(cm.get('mode.stand_rocking.sdof.f_hz'), 2)} Hz / ζ {_fmt(cm.get('mode.stand_rocking.sdof.zeta'), 4)}, "
          f"main channel `{cont.get('main_channel')}`.\n")

    w(data.get("narrative", ""))
    return "\n".join(L)


def build_headline(runs, agg, cross) -> list[dict]:
    rows = []

    def g(p, k):
        return (agg.get(p, {}).get(k) or {}).get("nominal")

    for p in ("pump_steady_misalignment", "fan_coastdown", "shake_test"):
        if g(p, "speed.now_est_rpm") is not None:
            rows.append({"name": f"Running speed, {p}", "est": f"{g(p, 'speed.now_est_rpm'):.1f} rpm",
                         "truth": f"{g(p, 'speed.now_true_rpm'):.1f} rpm", "err": _fmt(g(p, 'speed.now_err_pct'), 2, True, True),
                         "spread": _spread(agg[p], "speed.now_err_pct", 2, True)})
    p = "fan_coastdown"
    for g_, nm in (("sdof", "SDOF fit"), ("fdd", "FDD")):
        b = f"mode.stand_rocking.{g_}"
        if g(p, b + ".f_hz") is not None:
            rows.append({"name": f"Fan stand-rocking fn ({nm})", "est": f"{g(p, b + '.f_hz'):.2f} Hz", "truth": "14.20 Hz",
                         "err": _fmt(g(p, b + '.f_err_pct'), 1, True, True), "spread": _spread(agg[p], b + ".f_err_pct", 1, True)})
        if g(p, b + ".zeta") is not None:
            rows.append({"name": f"Fan stand-rocking ζ ({nm})", "est": f"{g(p, b + '.zeta'):.4f}", "truth": "0.0200",
                         "err": _fmt(g(p, b + '.zeta_err_rel_pct'), 0, True, True),
                         "spread": _spread(agg[p], b + ".zeta_err_rel_pct", 0, True)})
    b = "crit.1x.stand_rocking"
    if g(p, b + ".est_rpm") is not None:
        rows.append({"name": "Fan 1× critical speed", "est": f"{g(p, b + '.est_rpm'):.0f} rpm", "truth": f"{g(p, b + '.true_rpm'):.0f} rpm",
                     "err": _fmt(g(p, b + '.err_rpm'), 0, sign=True) + " rpm", "spread": _spread(agg[p], b + ".err_rpm", 0)})
    p = "pump_steady_misalignment"
    for k, nm in (("phase2x.track_deg", "tracker"), ("phase2x.fdd_deg", "FDD")):
        if g(p, k) is not None:
            rows.append({"name": f"2× phase motor vs pump ({nm})", "est": f"{g(p, k):.1f}°", "truth": "180°",
                         "err": _fmt(g(p, k) - 180, 1, sign=True) + "°", "spread": _spread(agg[p], k, 1)})
    ir = cross["imbalance_reduction"]
    if "nominal" in ir and ir["nominal"].get("pipeline_1x_vel_pct") is not None:
        rows.append({"name": "1× imbalance reduction (pipeline)", "est": _fmt(ir["nominal"]["pipeline_1x_vel_pct"], 1, True),
                     "truth": "85%", "err": _fmt(ir["nominal"]["pipeline_1x_vel_pct"] - 85, 1, sign=True) + " pts",
                     "spread": (lambda s: f"{s['mean']:.1f} ± {s['std']:.1f}%" if s else "n/a")(
                         stats([r.get("pipeline_1x_vel_pct") for r in ir.values()]))})
    p = "shake_test"
    if g(p, "shake.motor.ratio_compensated") is not None:
        rows.append({"name": "Shake residual / true shake (motor)", "est": f"{g(p, 'shake.motor.ratio_compensated'):.3f}",
                     "truth": "0", "err": f"without reference {g(p, 'shake.motor.ratio_uncompensated'):.2f}",
                     "spread": _spread(agg[p], "shake.motor.ratio_compensated", 3)})
    c = cross["cavitation"].get("nominal")
    if c:
        rows.append({"name": "Cavitation index separation", "est": f"{c['cavitation_index']:.3f} vs {c['max_non_cavitation_index']:.3f}",
                     "truth": "cav > non-cav", "err": f"{c['separation']:+.3f}", "spread": "audio only (no region effect)"})
    return rows


# ============================================================================================
# Main
# ============================================================================================

def truth_summary(preset):
    t = load_truth(preset)
    return {"fps": t["fps"], "n_frames": t["n_frames"], "width": t["width"], "exposure_s": t["exposure_s"],
            "speed_profile": t["speed_profile"], "modes": [{k: m[k] for k in ("name", "fn_hz", "zeta")} for m in t["modes"]],
            "criticals": t["criticals"], "camera": t["camera"], "description": t["description"]}


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--quick", action="store_true", help="nominal regions only (no perturbations)")
    ap.add_argument("--from-json", action="store_true", help="only rebuild docs/BENCHMARK.md from the saved JSON")
    ap.add_argument("--workers", type=int, default=max(2, min(6, (os.cpu_count() or 4) // 2)),
                    help="parallel processes (one clip each; ~1 GB per pump clip, 2.5 GB per fan process)")
    ap.add_argument("--fan-workers", type=int, default=1, help="processes the fan_coastdown variants are split over")
    ap.add_argument("--presets", nargs="*", default=PRESETS)
    args = ap.parse_args(argv)

    if args.from_json:
        data = json.loads(OUT_JSON.read_text(encoding="utf-8"))
        data["narrative"] = NARRATIVE(data)
        OUT_MD.write_text(write_report(data), encoding="utf-8")
        print(f"rebuilt {OUT_MD}")
        return

    t0 = time.perf_counter()
    variants = VARIANTS[:1] if args.quick else VARIANTS
    jobs = [{"preset": p, "variant": v, "dx": dx, "dy": dy, "size": s} for p in args.presets for (v, dx, dy, s) in variants]
    if "fan_coastdown" in args.presets:
        jobs.append({"preset": "fan_coastdown", "variant": "blade_contaminated", "dx": 0, "dy": 0, "size": 1.0,
                     "contaminated": True, "diagnostic": "blade_contaminated"})
    # Diagnostic: same nominal regions, but the audio tachometer is not allowed to override the video ridge.
    for p in args.presets:
        if p != "fan_coastdown":
            jobs.append({"preset": p, "variant": "video_tach", "dx": 0, "dy": 0, "size": 1.0, "video_tach": True,
                         "diagnostic": "video_tach"})
    runs: dict = {}
    # One process per clip (frames decoded once, ~1 GB per pump clip, 2.5 GB for the fan); the fan clip is the
    # longest, so its variants are split over --fan-workers processes.
    groups = []
    for p in args.presets:
        js = [j for j in jobs if j["preset"] == p]
        k = args.fan_workers if p == "fan_coastdown" else 1
        groups += [js[i::k] for i in range(k) if js[i::k]]
    groups.sort(key=lambda g: g[0]["preset"] != "fan_coastdown")  # longest first
    print(f"{len(jobs)} pipeline runs in {len(groups)} clip groups on {args.workers} processes", flush=True)
    with ProcessPoolExecutor(args.workers) as po:
        futs = {po.submit(run_group, g): g for g in groups}
        for fu in as_completed(futs):
            g = futs[fu]
            try:
                rs = fu.result()
            except Exception as e:  # a whole worker died (e.g. out of memory)
                rs = [{"preset": j["preset"], "variant": j["variant"], "diagnostic": j.get("diagnostic"),
                       "m": {"pipeline_failed": 1.0}, "error": repr(e), "tracked": [], "rejected": []} for j in g]
            for r in rs:
                runs.setdefault(r["preset"], {})[r["variant"]] = r
                print(f"  {r['preset']:<26} {r['variant']:<18} {r.get('runtime_s', 0):6.1f} s"
                      + (f"  ERROR {r['error']}" if r.get("error") else ""), flush=True)

    agg = aggregate(runs)
    data = {"schema": "argonaut.benchmark.v1", "generated": time.strftime("%Y-%m-%d %H:%M"),
            "runtime_s": time.perf_counter() - t0, "variants": [v[0] for v in variants],
            "truth_summary": {p: truth_summary(p) for p in args.presets},
            "runs": runs, "aggregate": agg}
    data["headline"] = build_headline(runs, agg["per_preset"], agg["cross"])
    OUT_JSON.write_text(json.dumps(data, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)),
                        encoding="utf-8")
    data = json.loads(OUT_JSON.read_text(encoding="utf-8"))  # identical types to --from-json
    data["narrative"] = NARRATIVE(data)
    OUT_MD.write_text(write_report(data), encoding="utf-8")

    print(f"\nHeadline ({time.perf_counter() - t0:.0f} s total):")
    for row in data["headline"]:
        print(f"  {row['name']:<42} est {row['est']:<22} truth {row['truth']:<14} err {row['err']:<22} pert {row['spread']}")
    print(f"\nwrote {OUT_JSON.relative_to(ROOT)} and {OUT_MD.relative_to(ROOT)}")


def NARRATIVE(data: dict) -> str:  # filled in below (method, limits, findings)
    return ""


if __name__ == "__main__":
    main()

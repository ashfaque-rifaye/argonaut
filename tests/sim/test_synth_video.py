import json
import math
import shutil
import subprocess
from dataclasses import replace
from pathlib import Path

import cv2
import numpy as np
import pytest

from argonaut.sim.synth_video import (
    PRESETS,
    SCHEMA,
    ClipSpec,
    ModeSpec,
    OrderSpec,
    SpeedProfile,
    preset_specs,
    render_clip,
    simulate_motion,
)

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not on PATH")


@pytest.fixture(scope="module")
def small_clip(tmp_path_factory):
    """Low-res 60 fps pump clip with a clearly measurable 1x on the motor."""
    spec = ClipSpec(
        name="test_small", scene="pump", width=480, height=270, fps=60, duration_s=1.5,
        speed=SpeedProfile("constant", 1480.0), ref_rpm=1480.0,
        orders=[OrderSpec(1, "1x", {"motor": (0.6, 0.3, 0, 90), "pump": (0.4, 0.2, 30, 120)})],
        modes=[ModeSpec("skid rocking", 14.2, 0.02, {"motor": (0.8, 0.2, 0), "pump": (1.0, 0.2, 0)},
                        coupling={1: (0.01, 0)}, ambient_rms_px=0.05)],
        shake_rms_px=0.4, sensor_noise=1.0, seed=3,
    )
    out = tmp_path_factory.mktemp("synth") / "small.mp4"
    truth = render_clip(spec, out, progress=False)
    return out, truth, spec


def _check_truth_schema(tr: dict):
    n = tr["n_frames"]
    assert tr["schema"] == SCHEMA
    for k in ("fps", "width", "height", "duration_s", "exposure_s", "mm_per_px", "reference_object", "machine",
              "speed_profile", "orders", "modes", "criticals", "parts", "frames", "camera"):
        assert k in tr, k
    fr = tr["frames"]
    assert len(fr["t"]) == len(fr["speed_rpm"]) == len(fr["shaft_angle_rad"]) == n
    assert len(fr["shake"]["x"]) == len(fr["shake"]["y"]) == n
    assert set(fr["parts"]) == set(tr["parts"])
    assert any(p["is_reference"] for p in tr["parts"].values())
    for name, p in fr["parts"].items():
        assert len(p["x"]) == len(p["y"]) == n
        assert np.asarray(p["bbox"]).shape == (n, 4)
        rest = tr["parts"][name]
        assert len(rest["bbox_rest"]) == 4 and len(rest["polygon_rest"]) >= 3
    wall = fr["parts"]["wall"]
    assert max(abs(v) for v in wall["x"] + wall["y"]) == 0.0
    for m in tr["modes"]:
        assert m["fn_hz"] > 0 and 0 < m["zeta"] < 1 and m["shape"]
        for s in m["shape"].values():
            assert {"x", "y", "phase_deg"} <= set(s)
    for o in tr["orders"]:
        assert o["order"] > 0 and o["parts"]
    ro = tr["reference_object"]
    assert ro["width_mm"] / ro["width_px"] == pytest.approx(tr["mm_per_px"], rel=1e-3)
    assert np.allclose(np.diff(fr["t"]), 1.0 / tr["fps"])


def test_ground_truth_schema(small_clip):
    out, truth, spec = small_clip
    on_disk = json.loads(out.with_suffix(".json").read_text())
    assert on_disk["n_frames"] == round(spec.duration_s * spec.fps)
    _check_truth_schema(on_disk)
    assert on_disk["frames"]["speed_rpm"][0] == pytest.approx(1480.0)
    assert on_disk["audio"]["rate"] == 24000


def test_video_frame_count_fps_and_audio(small_clip):
    out, truth, spec = small_clip
    cap = cv2.VideoCapture(str(out))
    assert cap.isOpened()
    assert int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) == truth["n_frames"]
    assert cap.get(cv2.CAP_PROP_FPS) == pytest.approx(spec.fps, rel=1e-3)
    n = 0
    while cap.read()[0]:
        n += 1
    assert n == truth["n_frames"]
    assert (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))) == (480, 270)
    if shutil.which("ffprobe"):
        info = json.loads(subprocess.run(
            ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(out)],
            capture_output=True, text=True, check=True).stdout)
        kinds = {s["codec_type"]: s for s in info["streams"]}
        assert kinds["video"]["codec_name"] == "h264"
        assert kinds["audio"]["codec_name"] == "aac" and int(kinds["audio"]["sample_rate"]) == 24000


def _lk(ref, img):
    gx = cv2.Sobel(ref, cv2.CV_32F, 1, 0, ksize=3) / 8
    gy = cv2.Sobel(ref, cv2.CV_32F, 0, 1, ksize=3) / 8
    it = img - ref
    A = np.array([[np.sum(gx * gx), np.sum(gx * gy)], [np.sum(gx * gy), np.sum(gy * gy)]])
    return np.linalg.solve(A, -np.array([np.sum(gx * it), np.sum(gy * it)]))


def _lk_iter(ref, img, iters=4):
    """Iterative (Gauss-Newton) global translation estimate of img relative to ref."""
    d = np.zeros(2)
    h, w = img.shape
    for _ in range(iters):
        M = np.float32([[1, 0, d[0]], [0, 1, d[1]]])  # sample img at x + d
        warped = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP,
                                borderMode=cv2.BORDER_REFLECT)
        d += _lk(ref, warped)
    return d


def test_pixels_match_ground_truth(small_clip):
    """A simple gradient (Lucas-Kanade) estimator on the decoded video recovers the true motion."""
    out, truth, _ = small_clip
    cap = cv2.VideoCapture(str(out))
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(cv2.GaussianBlur(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 1.0))
    ref_all = np.mean(frames, axis=0)
    for part in ("motor", "wall"):
        x1, y1, x2, y2 = truth["parts"][part]["bbox_rest"]
        dx, dy = 0.1 * (x2 - x1), 0.1 * (y2 - y1)
        sl = (slice(int(y1 + dy), int(y2 - dy)), slice(int(x1 + dx), int(x2 - dx)))
        meas = np.array([_lk_iter(ref_all[sl], f[sl]) for f in frames])
        for ax, k in ((0, "x"), (1, "y")):
            t = np.array(truth["frames"]["parts"][part][k]) + np.array(truth["frames"]["shake"][k])
            m, t = meas[:, ax] - meas[:, ax].mean(), t - t.mean()
            assert np.corrcoef(m, t)[0, 1] > 0.95, (part, k)
            gain = np.dot(m, t) / np.dot(t, t)
            assert 0.8 < gain < 1.25, (part, k, gain)


def test_sdof_steady_state_amplification():
    """1x exactly at fn: steady-state modal amplitude = static coupling / (2 zeta)."""
    fn, zeta, static = 14.2, 0.02, 0.01
    spec = ClipSpec(name="sdof", duration_s=4.0, speed=SpeedProfile("constant", fn * 60), ref_rpm=fn * 60,
                    modes=[ModeSpec("m", fn, zeta, {"motor": (1.0, 0.0, 0)}, coupling={1: (static, 0)})])
    mot = simulate_motion(spec, ["motor"], np.random.default_rng(0))
    eta = mot["modal"]["m"]
    amp = np.abs(eta[len(eta) // 2:]).max()
    assert amp == pytest.approx(static / (2 * zeta), rel=0.03)
    # 90 deg phase lag at resonance: response peaks when cos(theta) crosses zero
    th = mot["theta"]
    corr_cos = np.dot(eta, np.cos(th)) / len(eta)
    corr_sin = np.dot(eta, np.sin(th)) / len(eta)
    assert abs(corr_sin) > 10 * abs(corr_cos)


def test_coastdown_passes_through_resonance():
    spec = preset_specs("fan_coastdown")[0]
    mot = simulate_motion(spec, ["wall", "base", "stand", "motor", "rotor", "guard"], np.random.default_rng(1))
    rpm = mot["rpm"]
    assert rpm[0] == pytest.approx(1476.0) and rpm[-1] == pytest.approx(0.0, abs=1e-6)
    assert np.all(np.diff(rpm) <= 1e-9)
    eta = mot["modal"]["stand rocking"]
    fs = mot["fs"]
    win = int(0.25 * fs)
    env = np.array([np.abs(eta[i:i + win]).max() for i in range(0, len(eta) - win, win)])
    rpm_w = rpm[: len(env) * win: win]
    peak_rpm = rpm_w[np.argmax(env)]
    assert 650 < peak_rpm < 900  # just below the 852 rpm critical (sweep delay of a lightly damped mode)
    assert env.max() > 3 * np.median(env)


def test_speed_profiles():
    t = np.linspace(0, 10, 101)
    lin = SpeedProfile("linear", 300, 1500).rpm(t, 10)
    assert lin[0] == 300 and lin[-1] == 1500
    ex = SpeedProfile("exp_coastdown", 1476, 0, 5).rpm(t, 10)
    assert ex[0] == pytest.approx(1476) and ex[-1] == pytest.approx(0, abs=1e-9)
    assert SpeedProfile("constant", 900).rpm(t, 10).std() == 0


def test_all_presets_build():
    names = []
    for p in PRESETS:
        for s in preset_specs(p):
            assert s.duration_s * s.fps > 0
            names.append(s.name)
    assert "imbalance_before" in names and "imbalance_after" in names
    before, after = preset_specs("imbalance_before_after")
    a0 = before.orders[0].parts["motor"][0]
    a1 = after.orders[0].parts["motor"][0]
    assert a1 / a0 == pytest.approx(0.15)


@pytest.mark.parametrize("name", ["fan_coastdown", "pump_steady_misalignment", "pump_cavitation",
                                  "imbalance_before", "imbalance_after", "shake_test"])
def test_generated_dataset(name):
    """Checks the committed clips in data/synth (skipped if they have not been generated)."""
    mp4 = ROOT / "data" / "synth" / f"{name}.mp4"
    if not mp4.exists():
        pytest.skip("run: uv run python -m argonaut.sim.synth_video --all")
    tr = json.loads(mp4.with_suffix(".json").read_text())
    _check_truth_schema(tr)
    cap = cv2.VideoCapture(str(mp4))
    assert int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) == tr["n_frames"]
    assert cap.get(cv2.CAP_PROP_FPS) == pytest.approx(tr["fps"], rel=1e-3)
    assert mp4.stat().st_size < 15e6
    if name == "pump_cavitation":
        assert len(tr["audio"]["cavitation_burst_times_s"]) > 100
    if name == "fan_coastdown":
        crit = [c["rpm"] for c in tr["criticals"] if c["order"] == 1 and math.isclose(c["mode_f_hz"], 14.2)]
        assert crit and crit[0] == pytest.approx(852.0)

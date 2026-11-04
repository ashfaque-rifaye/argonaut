"""Moving-camera measurement against a known answer, and the limits on a public deployment."""
import cv2
import numpy as np
import pytest
from fastapi import HTTPException

from argonaut import guard, track
from argonaut.dsp import spectral

FPS, W, H = 30.0, 640, 360


def _texture(h, w, seed):
    rng = np.random.default_rng(seed)
    t = cv2.resize(rng.integers(0, 255, (h // 6, w // 6), dtype=np.uint8), (w, h), interpolation=cv2.INTER_CUBIC)
    return cv2.GaussianBlur(t, (3, 3), 0)


def _scene(pan_px_per_s=30.0, f_hz=5.0, amp_px=1.0, seconds=8.0):
    """A textured wall panning past the camera, and a textured block on it vibrating vertically at f_hz."""
    bg = _texture(H * 2, W * 4, 0)
    block = _texture(120, 160, 1)
    n = int(seconds * FPS)
    frames = np.zeros((n, H, W), np.uint8)
    polys = []
    for i in range(n):
        t = i / FPS
        M = np.float32([[1, 0, -pan_px_per_s * t], [0, 1, -20]])
        f = cv2.warpAffine(bg, M, (W, H), flags=cv2.INTER_CUBIC)
        # the block rides on the wall (same pan) and vibrates on top of it
        x, y = 200 - pan_px_per_s * t + 160, 120 + amp_px * np.sin(2 * np.pi * f_hz * t)
        Mb = np.float32([[1, 0, x], [0, 1, y]])
        b = cv2.warpAffine(block, Mb, (W, H), flags=cv2.INTER_CUBIC)
        a = cv2.warpAffine(np.full(block.shape, 255, np.uint8), Mb, (W, H))
        f[a > 128] = b[a > 128]
        frames[i] = f
        polys.append([[int(x), int(y)], [int(x) + 160, int(y)], [int(x) + 160, int(y) + 120], [int(x), int(y) + 120]])
    return frames, polys


def test_measures_vibration_on_a_panning_camera():
    frames, polys = _scene()
    tr = {"fps": FPS, "n": len(polys), "items": [{"id": "s1", "label": "block", "polys": polys}]}
    m = track.measure_tracked(frames, FPS, tr)["s1"]
    x = m["disp_px"][:, 1]  # vertical
    f, a = spectral.amp_spectrum(x - x.mean(), FPS)
    peak = f[1:][np.argmax(a[1:])]
    assert abs(peak - 5.0) < 0.3
    # a 1 px sine has 0.707 px RMS; the pan (240 px over the clip) must not leak in
    assert 0.5 < np.std(x) < 0.95


def test_camera_motion_alone_reads_nothing():
    frames, polys = _scene(amp_px=0.0)
    tr = {"fps": FPS, "n": len(polys), "items": [{"id": "s1", "label": "block", "polys": polys}]}
    x = track.measure_tracked(frames, FPS, tr)["s1"]["disp_px"][:, 1]
    assert np.std(x) < 0.15


def test_shots_and_travel():
    frames, _ = _scene(pan_px_per_s=60.0, seconds=8.0)
    small = np.stack([cv2.resize(f, (512, 288)) for f in frames[:: int(FPS / track.TRACK_FPS)]])
    shots, travel = track.find_shots(small)
    assert travel >= track.MOVING
    assert len(shots) >= 2 and shots[0][0] == 0 and shots[-1][1] == len(small)
    still = np.stack([small[0]] * len(small))
    assert track.find_shots(still) == ([(0, len(small))], 0.0)


def test_outlines_correspond_between_frames():
    a = track._resample([[10, 10], [110, 10], [110, 60], [10, 60]])
    b = track._resample([[110, 10], [110, 60], [10, 60], [10, 10]])  # same outline, listed from another corner
    assert a.shape == (track.VERTICES, 2)
    assert np.abs(a - b).max() < 1.0


def test_public_limits(monkeypatch):
    monkeypatch.setattr(guard, "PUBLIC", True)
    with pytest.raises(HTTPException):
        guard.check_clip(guard.MAX_CLIP_S + 1, 1000)
    with pytest.raises(HTTPException):
        guard.check_clip(5, (guard.MAX_UPLOAD_MB + 1) * 1024 * 1024)
    guard.check_clip(5, 1000)
    for bad in ("0", "file:///etc/passwd", "http://127.0.0.1/x", "http://localhost/x", "rtsp://192.168.1.10/cam", "http://169.254.169.254/latest"):
        with pytest.raises(HTTPException):
            guard.check_feed_url(bad)
    guard._by_ip.clear()
    guard._all.clear()
    for _ in range(guard.PER_IP_HOUR):
        guard._spend("1.2.3.4")
    with pytest.raises(HTTPException):
        guard._spend("1.2.3.4")
    guard._spend("5.6.7.8")  # someone else is unaffected

import cv2
import numpy as np

from argonaut.dsp import identify, modal, spectral
from argonaut.dsp.motion import Region, measure_regions


def _texture(h, w, seed=0):
    rng = np.random.default_rng(seed)
    img = rng.random((h // 4, w // 4)).astype(np.float32)
    return cv2.resize(cv2.GaussianBlur(img, (0, 0), 1.0), (w, h), interpolation=cv2.INTER_CUBIC)


def test_subpixel_tracking_with_camera_shake():
    fs, n, h, w = 240.0, 480, 240, 320
    t = np.arange(n) / fs
    body_true = 0.30 * np.sin(2 * np.pi * 24.6 * t)  # 0.3 px vibration at 24.6 Hz
    shake = 1.5 * np.sin(2 * np.pi * 2.0 * t)  # large slow camera shake
    bg, obj = _texture(h, w, 1), _texture(h, w, 2)
    frames = []
    for i in range(n):
        M_bg = np.float32([[1, 0, shake[i]], [0, 1, 0]])
        M_obj = np.float32([[1, 0, shake[i] + body_true[i]], [0, 1, 0]])
        a = cv2.warpAffine(bg, M_bg, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
        b = cv2.warpAffine(obj, M_obj, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
        img = a.copy()
        img[60:180, 120:280] = b[60:180, 120:280]
        frames.append(np.clip(img * 255, 0, 255).astype(np.uint8))
    frames = np.stack(frames)
    regions = [Region("s1", "body", (125, 65, 275, 175)), Region("ref", "wall", (5, 5, 100, 230), is_reference=True)]
    out = measure_regions(frames, regions)
    x = out["s1"]["disp_px"][:, 0]
    f, a = spectral.amp_spectrum(x, fs)
    pk = max(spectral.find_peaks(f, a), key=lambda p: p["amp"])
    assert abs(pk["f_hz"] - 24.6) < 0.3
    assert abs(pk["amp"] - 0.30) < 0.06  # sub-pixel amplitude recovered despite 1.5 px shake


def _coastdown(fs=240.0, T=20.0, rpm0=1476.0, fn=14.2, zeta=0.02, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(int(T * fs)) / fs
    sp = rpm0 / 60 * np.exp(-t / 8.0)
    phase = 2 * np.pi * np.cumsum(sp) / fs
    r = sp / fn
    gain = 1 / np.sqrt((1 - r**2) ** 2 + (2 * zeta * r) ** 2)
    x = 0.05 * gain * np.sin(phase) + 0.02 * np.sin(2 * phase) + 0.01 * rng.standard_normal(len(t))
    return t, sp, x


def test_speed_tracking_and_resonance_from_coastdown():
    fs = 240.0
    t, sp_true, x = _coastdown(fs)
    tt, f, S = spectral.stft_amp(x, fs, win_s=1.0, hop_s=0.25)
    sp, conf = identify.track_speed(tt, f, S, f_range=(2.0, 30.0), start_hint=24.6)
    truth = np.interp(tt, t, sp_true)
    good = truth > 4
    assert np.median(np.abs(sp[good] - truth[good]) / truth[good]) < 0.03
    amp1 = identify.order_amplitude(f, S, sp, 1)
    res = identify.resonance_from_order(sp[good], amp1[good], 1)
    assert res is not None and abs(res["f_hz"] - 14.2) < 0.8
    assert res["zeta"] is not None and 0.005 < res["zeta"] < 0.08
    crit = identify.campbell(sp * 60, [{"f_hz": res["f_hz"]}], orders=(1, 2))
    assert any(abs(c["rpm"] - 852) < 50 and c["order"] == 1 for c in crit)


def test_fdd_recovers_modes_and_shapes():
    from scipy import signal
    fs, T = 1000.0, 60.0  # high rate so discretising the test modes doesn't shift their frequency
    rng = np.random.default_rng(3)
    n = int(fs * T)
    def mode(fn, z):
        w = 2 * np.pi * fn
        sysd = signal.cont2discrete(([w**2], [1, 2 * z * w, w**2]), 1 / fs)
        return signal.lfilter(sysd[0].ravel(), sysd[1], rng.standard_normal(n))
    q1, q2 = mode(14.2, 0.02), mode(31.0, 0.03)
    X = np.vstack([1.0 * q1 + 0.3 * q2, -0.5 * q1 + 1.0 * q2, 0.8 * q1 - 0.6 * q2])
    X += 0.02 * rng.standard_normal(X.shape)
    f, s, modes = modal.fdd(X, fs, nperseg=8192, fmin=5, fmax=100, n_modes=2)
    fs_found = sorted(m["f_hz"] for m in modes)
    assert abs(fs_found[0] - 14.2) < 0.3 and abs(fs_found[1] - 31.0) < 0.5
    m1 = min(modes, key=lambda m: abs(m["f_hz"] - 14.2))
    # channel 2 moves in anti-phase with channel 1 in mode 1
    assert abs(abs(m1["shape_phase_deg"][1]) - 180) < 25

import numpy as np

from argonaut.dsp import dealias, spectral


def test_alias_formula():
    assert abs(dealias.alias_of(24.6, 30.0) - 5.4) < 1e-9
    assert abs(dealias.alias_of(49.2, 30.0) - 10.8) < 1e-9
    assert abs(dealias.alias_of(10.0, 30.0) - 10.0) < 1e-9


def test_webcam_recovers_orders_above_nyquist():
    """A 30 fps camera watching 1x=24.6 Hz and 2x=49.2 Hz; the mic says speed=24.6 Hz."""
    fs, T, sp = 30.0, 20.0, 24.6
    t = np.arange(int(fs * T)) / fs
    rng = np.random.default_rng(0)
    x = 0.30 * np.sin(2 * np.pi * sp * t) + 0.12 * np.sin(2 * np.pi * 2 * sp * t + 1) + 0.01 * rng.standard_normal(len(t))
    f, a = spectral.amp_spectrum(x, fs)
    peaks = spectral.find_peaks(f, a, n=4, fmin=0.5)
    res = dealias.dealias_peaks(peaks, fs, speed_hz=sp, speed_sd_hz=0.03, bin_hz=f[1] - f[0])
    by_order = {r["order"]: r for r in res if r["order"]}
    assert abs(by_order[1]["f_true_hz"] - 24.6) < 1e-6 and abs(by_order[1]["f_alias_hz"] - 5.4) < 0.1
    assert abs(by_order[2]["f_true_hz"] - 49.2) < 1e-6 and abs(by_order[2]["f_alias_hz"] - 10.8) < 0.1
    assert abs(by_order[1]["amp_true"] - 0.30) < 0.05


def test_ambiguous_fold_is_not_guessed():
    # speed 15 Hz at fs 30: 1x and 3x both alias to 15 Hz -> must be flagged ambiguous, not assigned
    res = dealias.dealias_peaks([{"f_hz": 15.0, "amp": 1.0}], 30.0, speed_hz=15.0, orders=range(1, 4))
    assert res[0]["order"] is None and set(res[0]["ambiguous_with"]) >= {1, 3}


def test_welch_ci_contains_truth():
    fs = 240.0
    t = np.arange(int(fs * 10)) / fs
    rng = np.random.default_rng(1)
    x = 0.2 * np.sin(2 * np.pi * 24.6 * t) + 0.05 * rng.standard_normal(len(t))
    f, m, lo, hi = spectral.welch_amp_ci(x, fs)
    i = int(np.argmax(m))
    assert abs(f[i] - 24.6) < 0.5 and lo[i] <= m[i] <= hi[i] and abs(m[i] - 0.2) < 0.04


def test_camera_aliases_resolve_which_order_the_mic_heard():
    """Mic hears 2x (49.2 Hz) loudest; the 30 fps camera's 1x alias at 5.4 Hz proves the shaft is 24.6 Hz."""
    fs, sp = 30.0, 24.6
    t = np.arange(int(fs * 20)) / fs
    x = 0.3 * np.sin(2 * np.pi * sp * t) + 0.15 * np.sin(2 * np.pi * 2 * sp * t)
    f, a = spectral.amp_spectrum(x, fs)
    speed, div, n = dealias.resolve_speed(spectral.find_peaks(f, a, n=4, fmin=0.5), fs, acoustic_hz=2 * sp,
                                          speed_sd_hz=0.03, bin_hz=f[1] - f[0])
    assert div == 2 and abs(speed - sp) < 1e-9 and n == 2

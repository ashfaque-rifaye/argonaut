"""System identification: running speed, order tracking, structural modes, Campbell diagram, damping."""

import numpy as np
from scipy import ndimage, signal

from .spectral import find_peaks


def _interp_amp(f, amp, fq):
    return np.interp(fq, f, amp, left=0.0, right=0.0)


def harmonic_score(f, amp, f0_grid, n_harm=4, weights=(1.0, 0.8, 0.5, 0.4)):
    """Harmonic-sum score for each candidate fundamental (rewards 1x supported by 2x, 3x...)."""
    a = np.sqrt(amp)  # compress so one huge resonance does not dominate
    score = np.zeros_like(f0_grid)
    for k in range(1, n_harm + 1):
        score += weights[k - 1] * _interp_amp(f, a, k * f0_grid)
    return score


def estimate_speed(f, amp, f_range=(5.0, 60.0), hint_hz: float | None = None):
    """Running speed (Hz) from a spectrum; `hint_hz` (e.g. nameplate rpm/60) narrows the search."""
    lo, hi = f_range
    if hint_hz:
        lo, hi = max(lo, 0.6 * hint_hz), min(hi, 1.1 * hint_hz)
    grid = np.linspace(lo, hi, 2000)
    s = harmonic_score(f, amp, grid)
    i = int(np.argmax(s))
    contrast = float(s[i] / (np.median(s) + 1e-12))
    return float(grid[i]), contrast


def refine_fundamental(f, amp, f0: float, min_hz: float = 4.0, max_div: int = 12, rel_tol: float = 0.015):
    """Blade/vane-pass tones are often louder than the shaft line. Find the shaft speed as the
    LARGEST fundamental f0/k that explains the strong spectral lines as integer multiples (an
    approximate GCD of the line frequencies), so the loud tone becomes order k. A smaller k is always
    preferred on ties, because every sub-multiple of the true fundamental also "explains" the lines.
    Returns (f_shaft, k)."""
    noise = np.median(amp) + 1e-12
    idx, _ = signal.find_peaks(amp, prominence=4 * noise)
    lines = [float(f[i]) for i in idx if amp[i] > 8 * noise and f[i] >= min_hz]
    lines = sorted(lines, key=lambda x: -_local_max(f, amp, x))[:12]
    if len(lines) < 2:
        return f0, 1

    def explained(base):
        n = 0
        for x in lines:
            h = round(x / base)
            if h >= 1 and abs(x - h * base) <= rel_tol * x + (f[1] - f[0]):
                n += 1
        return n / len(lines)

    best_k, best_score = 1, explained(f0)
    for k in range(2, max_div + 1):
        sub = f0 / k
        if sub < min_hz:
            break
        sc = explained(sub)
        if sc > best_score + 0.15:  # a sub-multiple must explain clearly MORE lines to be preferred
            best_k, best_score = k, sc
    return f0 / best_k, best_k


def shaft_from_blade_pass(f, amp, blades: int, f_range=(20.0, 1500.0)):
    """Shaft speed when the blade/vane count is known (Muse Spark counts it from the image).

    In fans and pumps the aerodynamic/hydraulic blade-pass tone (BPF = blades x shaft) is normally the
    strongest tonal line, with its harmonics above it. Take the strongest line in the band as BPF and
    divide by the blade count. Returns (shaft_hz, bpf_hz, prominence over the noise floor)."""
    sel = (f >= f_range[0]) & (f <= f_range[1])
    fs, a = f[sel], amp[sel]
    noise = np.median(a) + 1e-12
    idx, _ = signal.find_peaks(a, prominence=4 * noise)
    if not len(idx):
        return None, None, 0.0
    i = int(idx[np.argmax(a[idx])])
    top = float(fs[i])
    # The loudest line may be a BPF harmonic. Walk down to the lowest fundamental whose whole series
    # (base, 2*base, ..., top) is present; a lone sub-multiple line (e.g. a 2x shaft line) does not qualify.
    bpf = top
    for j in (5, 4, 3, 2):
        base = top / j
        if base < f_range[0] / 2:
            continue
        if all(_local_max(fs, a, base * m, rel_bw=0.006) > 6 * noise and not _mains(base * m) for m in range(1, j)):
            bpf = base
            break
    return float(bpf / blades), float(bpf), float(_local_max(fs, a, bpf) / noise)


def _mains(fx: float, tol: float = 0.01) -> bool:
    """Electrical lines (multiples of 50/60 Hz, e.g. 2x line-frequency hum) are not aerodynamic harmonics."""
    return any(abs(fx - k * m) <= tol * fx for m in (50.0, 60.0) for k in range(1, 9))


def _local_max(f, amp, fc, rel_bw=0.015):
    sel = (f >= fc * (1 - rel_bw)) & (f <= fc * (1 + rel_bw))
    return float(amp[sel].max()) if sel.any() else 0.0


def track_speed(t, f, S, f_range=(1.0, 60.0), max_rel_step=0.15, start_hint: float | None = None):
    """Follow the running-speed ridge through short-time spectra (Viterbi-style continuity).

    Returns speed_hz per time slice and a per-slice confidence (harmonic contrast).
    """
    grid = np.linspace(f_range[0], f_range[1], 1200)
    scores = np.stack([harmonic_score(f, S[i], grid) for i in range(len(t))])
    scores = scores / (scores.max(axis=1, keepdims=True) + 1e-12)
    n, m = scores.shape
    # Dynamic programming: maximise score minus penalty for relative jumps between slices.
    cost = np.full((n, m), -np.inf)
    back = np.zeros((n, m), int)
    cost[0] = scores[0]
    if start_hint:
        cost[0] -= 2.0 * np.abs(grid - start_hint) / start_hint
    rel = np.abs(grid[:, None] - grid[None, :]) / grid[None, :]
    trans = np.where(rel <= max_rel_step, -3.0 * rel, -np.inf)
    for i in range(1, n):
        tot = cost[i - 1][None, :] + trans
        back[i] = np.argmax(tot, axis=1)
        cost[i] = scores[i] + tot[np.arange(m), back[i]]
    path = np.zeros(n, int)
    path[-1] = int(np.argmax(cost[-1]))
    for i in range(n - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    speed = grid[path]
    conf = scores[np.arange(n), path] / (np.median(scores, axis=1) + 1e-12)
    return speed, conf


def order_amplitude(f, S, speed_hz, order: float, rel_bw: float = 0.03):
    """Amplitude of order k through time: max of S within ±rel_bw around k*speed."""
    out = np.zeros(len(speed_hz))
    for i, sp in enumerate(speed_hz):
        fc = order * sp
        sel = (f >= fc * (1 - rel_bw)) & (f <= fc * (1 + rel_bw))
        out[i] = S[i, sel].max() if sel.any() else 0.0
    return out


def half_power_damping(fx, ax, i_peak):
    """Damping ratio from the half-power (-3 dB) bandwidth around a peak; returns (fn, zeta)."""
    peak = ax[i_peak]
    target = peak / np.sqrt(2)
    l = i_peak
    while l > 0 and ax[l] > target:
        l -= 1
    r = i_peak
    while r < len(ax) - 1 and ax[r] > target:
        r += 1
    if l == 0 or r == len(ax) - 1:
        return float(fx[i_peak]), None

    def cross(i0, i1):
        a0, a1 = ax[i0], ax[i1]
        return fx[i0] + (target - a0) * (fx[i1] - fx[i0]) / (a1 - a0) if a1 != a0 else fx[i0]

    f1, f2 = cross(l, l + 1), cross(r - 1, r)
    fn = float(fx[i_peak])
    return fn, float((f2 - f1) / (2 * fn)) if fn > 0 else None


def structural_modes(t, f, S, speed_hz, orders=(1, 2, 3, 4, 5), fmin=2.0, rel_bw=0.04, n=4):
    """Constant-frequency peaks that do NOT follow any order line = structural natural frequencies.

    Order bands are masked slice by slice; what remains is averaged and peak-picked.
    """
    M = S.copy()
    df = f[1] - f[0]
    for i, sp in enumerate(speed_hz):
        for k in orders:
            fc = k * sp
            half = max(rel_bw * fc, 2.5 * df)  # never narrower than the window's main lobe
            M[i, (f >= fc - half) & (f <= fc + half)] = np.nan
    avg = np.nanmedian(M, axis=0)
    avg = np.nan_to_num(avg, nan=0.0)
    avg = ndimage.uniform_filter1d(avg, 3)
    return [p for p in find_peaks(f, avg, n=n, fmin=fmin, rel_prom=0.35) if p["amp"] > 3 * np.median(avg[f >= fmin])], avg


def resonance_from_order(speed_hz, order_amp, order: float):
    """Treat order amplitude vs excitation frequency (k*speed) as an FRF: peak -> fn, zeta.

    A run-up/coast-down sweeps the excitation through the mode, which is the classic
    order-based resonance test (no impact hammer needed).
    """
    fx = order * np.asarray(speed_hz)
    srt = np.argsort(fx)
    fx, ax = fx[srt], ndimage.uniform_filter1d(np.asarray(order_amp)[srt], 5)
    if len(fx) < 8 or ax.max() <= 0:
        return None
    idx, props = signal.find_peaks(ax, prominence=0.3 * ax.max())
    if not len(idx):
        return None
    i = int(idx[np.argmax(props["prominences"])])
    fn, zeta = half_power_damping(fx, ax, i)
    return {"f_hz": fn, "zeta": zeta, "peak_amp": float(ax[i]), "order": order}


def order_track(x: np.ndarray, fs: float, tt: np.ndarray, speed_hz: np.ndarray, order: float = 1.0,
                iters: int = 3, bw_hz: float = 0.6):
    """Synchronous (phase-locked) order tracking, a Vold-Kalman-style refinement.

    Demodulate the signal at k·phase(t), low-pass, and use the residual phase drift to correct
    the instantaneous speed (a software PLL). The result is the order amplitude at fine time
    resolution, independent of the STFT window, which is what resonance curve fitting needs.
    Returns (t, inst_freq_hz of the order, amplitude).
    """
    n = len(x)
    t = np.arange(n) / fs
    f_inst = order * np.interp(t, tt, speed_hz)
    x = np.asarray(x, float) - np.mean(x)
    sos = signal.butter(2, bw_hz, fs=fs, output="sos")
    for _ in range(iters):
        phi = 2 * np.pi * np.cumsum(f_inst) / fs
        z = x * np.exp(-1j * phi)
        z = signal.sosfiltfilt(sos, z.real) + 1j * signal.sosfiltfilt(sos, z.imag)
        drift = np.unwrap(np.angle(z))
        corr = np.gradient(drift, 1 / fs) / (2 * np.pi)
        corr = signal.sosfiltfilt(signal.butter(2, bw_hz / 2, fs=fs, output="sos"), corr)
        f_inst = np.clip(f_inst + corr, 0.05, fs / 2)
    return t, f_inst, 2 * np.abs(z)


def fit_sdof(f: np.ndarray, amp: np.ndarray, f_guess: float | None = None):
    """Least-squares fit of an SDOF resonance A(f) = c·f^p / |1 - r² + 2jζr|.

    The forcing exponent p is fitted too (p≈2 for pure unbalance, ≈0 for constant-amplitude forcing),
    so the natural frequency is not biased by assuming the wrong excitation law.

    Returns {"f_hz", "zeta", "f_err_hz", "zeta_err"} with 1-sigma errors from the fit covariance,
    or None if the fit fails. Far better conditioned than half-power on noisy order data.
    """
    from scipy.optimize import curve_fit

    f, amp = np.asarray(f, float), np.asarray(amp, float)
    ok = (f > 0) & np.isfinite(amp) & (amp > 0)
    f, amp = f[ok], amp[ok]
    if len(f) < 12:
        return None
    i = int(np.argmax(amp))
    fn0 = f_guess or f[i]

    def model(fq, fn, zeta, logc, pw):
        r = fq / fn
        return logc + pw * np.log(fq / fn) - 0.5 * np.log((1 - r**2) ** 2 + (2 * zeta * r) ** 2)

    try:
        p, cov = curve_fit(model, f, np.log(amp), p0=[fn0, 0.03, np.log(amp[i] * 0.06), 1.0],
                           bounds=([fn0 * 0.7, 0.002, -50, 0.0], [fn0 * 1.3, 0.3, 50, 3.0]), maxfev=20000)
        err = np.sqrt(np.diag(cov))
    except Exception:
        return None
    return {"f_hz": float(p[0]), "zeta": float(p[1]), "f_err_hz": float(err[0]), "zeta_err": float(err[1]),
            "forcing_power": float(p[3])}


def campbell(speeds_rpm: np.ndarray, modes: list[dict], orders=(1, 2, 5)):
    """Critical speeds: where order line k*rpm/60 crosses a natural frequency."""
    criticals = []
    lo, hi = float(np.min(speeds_rpm)), float(np.max(speeds_rpm))
    for m in modes:
        for k in orders:
            rpm = 60.0 * m["f_hz"] / k
            if lo * 0.9 <= rpm <= hi * 1.1:
                criticals.append({"rpm": rpm, "order": k, "mode_f_hz": m["f_hz"]})
    return criticals

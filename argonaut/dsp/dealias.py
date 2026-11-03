"""Audio-guided de-aliasing: recover true vibration frequencies above the camera's Nyquist limit.

A camera sampling at fs folds every true frequency f onto  alias(f) = |((f + fs/2) mod fs) − fs/2|.
On its own a folded peak is ambiguous (infinitely many f map to it). But the microphone samples at
24 kHz and gives the shaft speed directly. Rotating machinery vibrates mainly at shaft orders k·speed,
so each folded peak is explained by the order whose alias matches it. We accept the assignment only
when exactly one order matches within tolerance, so ambiguous folds are reported rather than guessed.

Severity depends on this: velocity = 2π·f·x, so computing it at the aliased frequency would
under-state a 24.6 Hz vibration seen at 5.4 Hz by a factor of ~4.6.
"""

import numpy as np


def alias_of(f: np.ndarray | float, fs: float):
    """Frequency at which a true frequency f appears when sampled at fs (0..fs/2)."""
    return np.abs(np.mod(np.asarray(f, float) + fs / 2, fs) - fs / 2)


def fold_index(f: float, fs: float) -> int:
    """n such that f lies in the n-th Nyquist zone fold (0 = no aliasing)."""
    return int(np.floor((f + fs / 2) / fs))


def exposure_gain(f: float, exposure_s: float | None) -> float:
    """Amplitude attenuation of a sinusoid integrated over the exposure time (motion blur): |sinc(f·T)|."""
    if not exposure_s:
        return 1.0
    return float(abs(np.sinc(f * exposure_s))) or 1e-6


def dealias_peaks(peaks: list[dict], fs: float, speed_hz: float, speed_sd_hz: float = 0.05,
                  orders=range(1, 13), bin_hz: float | None = None, exposure_s: float | None = None) -> list[dict]:
    """Assign each observed (possibly folded) peak to a unique shaft order.

    peaks: [{"f_hz": observed frequency, "amp": amplitude in displacement units}]
    Returns one dict per peak: f_alias_hz, f_true_hz, order, fold, residual_hz, confidence, amp_true
    (amplitude corrected for exposure blur at the true frequency), or order=None if unexplained/ambiguous.
    """
    bin_hz = bin_hz or 0.0
    out = []
    for p in peaks:
        fa = float(p["f_hz"])
        cands = []
        for k in orders:
            ft = k * speed_hz
            tol = 3 * k * speed_sd_hz + bin_hz  # speed error grows with order; plus spectral resolution
            res = abs(float(alias_of(ft, fs)) - fa)
            if res <= tol:
                cands.append((res, k, ft, tol))
        if len(cands) == 1 or (cands and _dominant(cands)):
            res, k, ft, tol = min(cands)
            conf = float(np.clip(1 - res / (tol + 1e-9), 0, 1)) * (1.0 if len(cands) == 1 else 0.6)
            g = exposure_gain(ft, exposure_s) / exposure_gain(fa, exposure_s)
            out.append({"f_alias_hz": fa, "f_true_hz": ft, "order": k, "fold": fold_index(ft, fs),
                        "residual_hz": res, "confidence": conf, "amp_true": float(p.get("amp", 0)) / max(g, 1e-6),
                        "ambiguous_with": [c[1] for c in cands if c[1] != k]})
        else:
            out.append({"f_alias_hz": fa, "f_true_hz": None, "order": None, "fold": None, "residual_hz": None,
                        "confidence": 0.0, "amp_true": p.get("amp"),
                        "ambiguous_with": [c[1] for c in cands]})
    return out


def _dominant(cands) -> bool:
    """With several candidate orders, accept the best only if it is clearly closer than the next."""
    s = sorted(cands)
    return len(s) >= 2 and s[0][0] < 0.25 * s[1][0]


def resolve_speed(video_peaks: list[dict], fs: float, acoustic_hz: float, max_div: int = 6,
                  min_hz: float = 3.0, speed_sd_hz: float = 0.05, bin_hz: float = 0.0) -> tuple[float, int, int]:
    """Cross-modal consistency: the microphone gives a tone, but not which shaft order it is.
    Try speed = tone/d for d = 1..max_div and keep the d under which the camera's (aliased) peaks
    are best explained by unique shaft orders. Ties go to the smallest d. Returns (speed_hz, d, n_explained)."""
    best = (acoustic_hz, 1, -1)
    for d in range(1, max_div + 1):
        sp = acoustic_hz / d
        if sp < min_hz:
            break
        n = sum(1 for a in dealias_peaks(video_peaks, fs, sp, speed_sd_hz, bin_hz=bin_hz) if a["order"])
        if n > best[2]:
            best = (sp, d, n)
    return best


def usable_band(fs: float, speed_hz: float | None, max_order: int = 12) -> dict:
    """Measurable band: direct (camera Nyquist) and with audio de-aliasing (orders up to max_order)."""
    direct = fs / 2
    return {"direct_hz": direct, "dealiased_hz": (max_order * speed_hz) if speed_hz else direct}

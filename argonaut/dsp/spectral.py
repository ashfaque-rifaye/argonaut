"""Spectra, peaks, band RMS and short-time spectra for vibration channels."""

import numpy as np
from scipy import signal


def amp_spectrum(x: np.ndarray, fs: float, nfft: int | None = None):
    """Single-sided peak-amplitude spectrum with a Hann window (amplitude-correct for tones)."""
    x = np.asarray(x, float) - np.mean(x)
    n = len(x)
    nfft = nfft or int(2 ** np.ceil(np.log2(n)))
    w = np.hanning(n)
    X = np.fft.rfft(x * w, nfft)
    amp = 2 * np.abs(X) / w.sum()
    f = np.fft.rfftfreq(nfft, 1 / fs)
    return f, amp


def welch_amp_ci(x: np.ndarray, fs: float, n_seg: int = 8, conf: float = 0.90):
    """Segment-averaged amplitude spectrum with a confidence band from segment-to-segment scatter.

    The clip is split into n_seg half-overlapping Hann segments; each gives an amplitude spectrum.
    Returns f, mean, lo, hi (Student-t interval of the mean across segments).
    """
    from scipy import stats

    x = np.asarray(x, float) - np.mean(x)
    n = len(x)
    seg = max(32, int(2 * n / (n_seg + 1)))
    hop = seg // 2
    starts = range(0, max(1, n - seg + 1), hop)
    A = []
    for s in starts:
        f, a = amp_spectrum(x[s:s + seg], fs, nfft=int(2 ** np.ceil(np.log2(seg))) * 2)
        A.append(a)
    A = np.array(A)
    m = A.mean(axis=0)
    if len(A) < 2:
        return f, m, m, m
    t = stats.t.ppf(0.5 + conf / 2, len(A) - 1)
    half = t * A.std(axis=0, ddof=1) / np.sqrt(len(A))
    return f, m, np.maximum(m - half, 0), m + half


def segment_rms_velocity(disp: np.ndarray, fs: float, band=(2.0, 1000.0), n_seg: int = 8) -> np.ndarray:
    """Band RMS velocity of n_seg consecutive segments (for confidence intervals and significance tests)."""
    x = np.asarray(disp, float)
    L = len(x) // n_seg
    return np.array([band_rms_velocity(x[i * L:(i + 1) * L], fs, band) for i in range(n_seg) if L > 16])


def mean_ci(samples: np.ndarray, conf: float = 0.90) -> tuple[float, float]:
    from scipy import stats

    s = np.asarray(samples, float)
    if len(s) < 2:
        v = float(s.mean()) if len(s) else 0.0
        return v, v
    h = stats.t.ppf(0.5 + conf / 2, len(s) - 1) * s.std(ddof=1) / np.sqrt(len(s))
    return float(s.mean() - h), float(s.mean() + h)


def disp_to_vel_spectrum(f: np.ndarray, disp_amp: np.ndarray) -> np.ndarray:
    """Displacement amplitude -> velocity amplitude (same length unit per second)."""
    return disp_amp * 2 * np.pi * f


def band_rms_velocity(disp: np.ndarray, fs: float, band=(2.0, 1000.0)) -> float:
    """RMS velocity in `band` from a displacement signal (differentiate in frequency domain)."""
    x = np.asarray(disp, float) - np.mean(disp)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / fs)
    sel = (f >= band[0]) & (f <= min(band[1], fs / 2 * 0.95))
    V = X * (2j * np.pi * f)
    V[~sel] = 0
    v = np.fft.irfft(V, len(x))
    return float(np.sqrt(np.mean(v**2)))


def find_peaks(f: np.ndarray, amp: np.ndarray, n: int = 8, fmin: float = 1.0, rel_prom: float = 0.08):
    """Top-n spectral peaks with parabolic (log-amplitude) interpolation of frequency and amplitude."""
    sel = f >= fmin
    a = np.where(sel, amp, 0)
    if a.max() <= 0:
        return []
    idx, props = signal.find_peaks(a, prominence=a.max() * rel_prom)
    order = np.argsort(props["prominences"])[::-1][:n]
    df = f[1] - f[0]
    peaks = []
    for i in idx[order]:
        if 0 < i < len(a) - 1 and a[i - 1] > 0 and a[i + 1] > 0:
            l, c, r = np.log(a[i - 1:i + 2])
            denom = l - 2 * c + r
            p = 0.5 * (l - r) / denom if denom != 0 else 0.0
            fi, ai = f[i] + p * df, float(np.exp(c - 0.25 * (l - r) * p))
        else:
            fi, ai = f[i], a[i]
        peaks.append({"f_hz": float(fi), "amp": float(ai), "bin": int(i)})
    return sorted(peaks, key=lambda p: p["f_hz"])


def stft_amp(x: np.ndarray, fs: float, win_s: float = 1.0, hop_s: float = 0.25):
    """Short-time amplitude spectra: returns t (centres, s), f, S [len(t), len(f)]."""
    nper = max(16, int(win_s * fs))
    hop = max(1, int(hop_s * fs))
    f, t, Z = signal.stft(np.asarray(x, float) - np.mean(x), fs, window="hann", nperseg=nper,
                          noverlap=nper - hop, boundary=None, padded=False,
                          nfft=int(2 ** np.ceil(np.log2(nper)) * 2))
    # scipy scales by 1/sum(w); peak amplitude of a tone = 2*|Z|
    return t, f, (2 * np.abs(Z)).T


def to_uint8_db(S: np.ndarray, floor_db: float = -60.0) -> np.ndarray:
    """Map amplitude rows to 0-255 on a dB scale relative to the global max (for waterfall rows)."""
    ref = S.max() or 1.0
    db = 20 * np.log10(np.maximum(S, 1e-12) / ref)
    return np.clip((db - floor_db) / -floor_db * 255, 0, 255).astype(np.uint8)

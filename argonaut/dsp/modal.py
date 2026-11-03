"""Output-only (operational) modal analysis by Frequency Domain Decomposition (FDD).

All virtual sensors are recorded simultaneously, so the cross-spectral density matrix
G(f) across channels is available. Its singular values peak at natural frequencies and
the first singular vector at a peak is the (operating) mode shape.
"""

import numpy as np
from scipy import signal

from .identify import half_power_damping


def csd_matrix(X: np.ndarray, fs: float, nperseg: int):
    """X: (channels, samples). Returns f, G (F, C, C) complex."""
    c = X.shape[0]
    f, _ = signal.csd(X[0], X[0], fs, nperseg=nperseg)
    G = np.zeros((len(f), c, c), complex)
    for i in range(c):
        for j in range(i, c):
            _, g = signal.csd(X[i], X[j], fs, nperseg=nperseg)
            G[:, i, j] = g
            G[:, j, i] = np.conj(g)
    return f, G


def fdd(X: np.ndarray, fs: float, nperseg: int | None = None, fmin=1.0, fmax=None, n_modes=4,
        exclude_hz: list[tuple[float, float]] | None = None):
    """Return f, singular values (F, C), and a list of modes with frequency, damping, shape."""
    X = np.asarray(X, float)
    X = X - X.mean(axis=1, keepdims=True)
    nperseg = nperseg or min(X.shape[1], int(2 ** np.floor(np.log2(X.shape[1] / 4))))
    f, G = csd_matrix(X, fs, nperseg)
    U, s, _ = np.linalg.svd(G)
    sv1 = s[:, 0]
    sel = (f >= fmin) & (f <= (fmax or f[-1]))
    if exclude_hz:
        for lo, hi in exclude_hz:
            sel &= ~((f >= lo) & (f <= hi))
    a = np.where(sel, sv1, 0)
    idx, props = signal.find_peaks(a, prominence=a.max() * 0.05 if a.max() > 0 else 0)
    idx = idx[np.argsort(props["prominences"])[::-1][:n_modes]]
    modes = []
    for i in sorted(idx):
        fn, zeta = half_power_damping(f, sv1, int(i))
        u = U[i, :, 0]
        ref = u[np.argmax(np.abs(u))]
        u = u * np.conj(ref) / (np.abs(ref) + 1e-12)  # phase relative to the strongest channel
        amp = np.abs(u) / (np.abs(u).max() + 1e-12)
        modes.append({
            "f_hz": float(fn), "zeta": zeta, "df_hz": float(f[1] - f[0]),
            "shape_amp": amp.tolist(), "shape_phase_deg": np.degrees(np.angle(u)).tolist(),
            # Modal assurance-style purity: how dominant the first singular value is at the peak.
            "sv_ratio": float(s[i, 0] / (s[i, 1] + 1e-12)) if s.shape[1] > 1 else None,
        })
    return f, s, modes

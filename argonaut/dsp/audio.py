"""Acoustic channel: speed from sound, envelope (demodulation) spectrum, cavitation index,
and cross-modal corroboration of peaks found in video."""

import subprocess

import numpy as np
from scipy import signal, stats

from .spectral import amp_spectrum


def load_audio(path: str, rate: int = 24000) -> np.ndarray | None:
    """Decode the audio track of any media file to mono float32 at `rate` (None if no audio)."""
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"]
    try:
        raw = subprocess.run(cmd, capture_output=True, check=True, timeout=120).stdout
    except subprocess.CalledProcessError:
        return None
    if not raw:
        return None
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0


def spectrum(x: np.ndarray, fs: int, fmax: float = 2000.0, seconds: float = 8.0):
    """Averaged (Welch) amplitude-like spectrum up to fmax, good resolution for low orders."""
    nper = int(min(len(x), seconds * fs))
    f, p = signal.welch(x, fs, nperseg=nper, noverlap=nper // 2)
    sel = f <= fmax
    return f[sel], np.sqrt(p[sel])


def envelope_spectrum(x: np.ndarray, fs: int, band=(2000.0, 8000.0), fmax=500.0):
    """Band-pass, Hilbert envelope, then spectrum: reveals repetitive impacts (bearings, cavitation)."""
    hi = min(band[1], fs / 2 * 0.95)
    sos = signal.butter(4, [band[0], hi], btype="band", fs=fs, output="sos")
    env = np.abs(signal.hilbert(signal.sosfiltfilt(sos, x)))
    f, a = amp_spectrum(env - env.mean(), fs)
    sel = f <= fmax
    return f[sel], a[sel]


def cavitation_index(x: np.ndarray, fs: int, frame_s: float = 0.05) -> dict:
    """Cavitation is broadband, impulsive, high-frequency noise.

    Index combines the high-band energy fraction and the kurtosis of the high-band signal
    (impulsiveness). Returns components so the agent can explain the number.
    """
    hi = min(10000.0, fs / 2 * 0.95)
    sos = signal.butter(4, [4000.0, hi], btype="band", fs=fs, output="sos")
    xh = signal.sosfiltfilt(sos, x)
    frac = float(np.sum(xh**2) / (np.sum(x**2) + 1e-12))
    n = int(frame_s * fs)
    frames = xh[: len(xh) // n * n].reshape(-1, n) if len(xh) >= n else xh[None, :]
    kurt = float(np.median(stats.kurtosis(frames, axis=1, fisher=True)))
    index = float(np.clip(frac * 4 + max(kurt, 0) / 6, 0, 1))
    return {"index": index, "hf_energy_fraction": frac, "hf_kurtosis": kurt}


def acoustic_track(x: np.ndarray, fs: int, at_times: np.ndarray, f_range=(20.0, 1000.0), fmax: float = 1500.0,
                   win_s: float = 0.5, hop_s: float = 0.25, hint_hz: float | None = None):
    """The microphone as a tachometer: follow the dominant tonal ridge (blade/vane pass or a shaft
    harmonic) through a run-up or coast-down. Works when the camera frame rate is far below the
    rotation rate. Returns (shaft_hz at `at_times`, confidence, (t, f, rows_uint8) for an audio waterfall,
    k) where k is the order of the tracked tone (k > 1: the ridge was a blade/vane-pass tone).
    """
    from .identify import track_speed
    from .spectral import stft_amp, to_uint8_db

    t, f, S = stft_amp(x, fs, win_s=win_s, hop_s=hop_s)
    sel = f <= fmax
    f, S = f[sel], S[:, sel]
    tone, conf = track_speed(t, f, S, f_range=f_range, max_rel_step=0.08)
    # The loudest ridge is often blade/vane pass. Per slice, walk down to the shaft fundamental;
    # the most common divisor k across slices is applied to the whole track (robust to noisy slices).
    from .identify import refine_fundamental
    ks = [refine_fundamental(f, S[i], tone[i], min_hz=f_range[0] / 8)[1] for i in range(0, len(t), max(1, len(t) // 40))]
    k = int(np.bincount(ks).argmax()) if ks else 1
    if hint_hz:  # nameplate speed (read by Muse Spark) resolves which order the tracked tone is
        ref = float(np.median(tone))
        cands = [kk for kk in range(1, 25) if abs(ref / kk - hint_hz) <= 0.4 * hint_hz]
        if cands:
            k = min(cands, key=lambda kk: abs(ref / kk - hint_hz))
    return (np.interp(at_times, t, tone / k), np.interp(at_times, t, conf),
            (t, f, to_uint8_db(S, floor_db=-50)), k)


def corroborate(peaks_hz: list[float], f_audio: np.ndarray, a_audio: np.ndarray,
                rel_tol: float = 0.02, harmonics=(1, 2, 3)) -> list[bool]:
    """A video peak is corroborated if the audio spectrum has a local peak at f (or a harmonic)."""
    if f_audio is None or len(f_audio) == 0:
        return [False] * len(peaks_hz)
    noise = np.median(a_audio)
    out = []
    for fp in peaks_hz:
        ok = False
        for k in harmonics:
            fc = k * fp
            sel = (f_audio >= fc * (1 - rel_tol)) & (f_audio <= fc * (1 + rel_tol))
            if sel.any() and a_audio[sel].max() > 4 * noise:
                ok = True
                break
        out.append(ok)
    return out

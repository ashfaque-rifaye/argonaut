"""Original soundtrack for the intro / outro, synthesised from scratch (no samples, nothing to license).

    uv run python film/music.py intro film/out/intro.wav
    uv run python film/music.py outro film/out/outro.wav

A 124 bpm electronic cue: four-on-the-floor kick, claps, hats, a side-chained saw bass and pad, a
plucked arpeggio, noise risers into every scene cut and an impact on it. Cut times come from the film
timelines (intro.html / outro.html), so hits land exactly on the picture.
"""
import sys
import wave

import numpy as np
from scipy import signal

SR = 44100
BPM = 124.0
BEAT = 60.0 / BPM
rng = np.random.default_rng(7)

# A-minor progression (Am  F  C  G), one chord per bar
CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
BASS = [45, 41, 36, 43]
ARP = [[69, 72, 76, 72], [65, 69, 72, 69], [64, 67, 72, 67], [67, 71, 74, 71]]

CUES = {
    "intro": {"dur": 16.5, "cuts": [2.2, 3.8, 5.7, 7.5, 9.2, 11.5, 13.6], "groove": (2.2, 11.4), "break": (11.4, 13.6), "logo": 13.6},
    "outro": {"dur": 8.5, "cuts": [0.05, 3.5], "groove": (0.05, 3.45), "break": (3.45, 3.5), "logo": 3.5},
}


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def env(n, a, d, sustain=0.0):
    t = np.arange(n) / SR
    e = np.minimum(1.0, t / max(a, 1e-4)) * (sustain + (1 - sustain) * np.exp(-t / max(d, 1e-4)))
    return e


def lp(x, fc, order=2):
    b, a = signal.butter(order, min(fc, SR / 2 * 0.95) / (SR / 2), "low")
    return signal.lfilter(b, a, x)


def hp(x, fc, order=2):
    b, a = signal.butter(order, fc / (SR / 2), "high")
    return signal.lfilter(b, a, x)


def bp(x, lo, hi):
    b, a = signal.butter(2, [lo / (SR / 2), min(hi, SR / 2 * 0.95) / (SR / 2)], "band")
    return signal.lfilter(b, a, x)


def saw(f, n, detune=0.0):
    t = np.arange(n) / SR
    ph = (f * (1 + detune)) * t
    return 2 * (ph - np.floor(ph + 0.5))


def add(buf, x, t0, gain=1.0):
    i = int(t0 * SR)
    if i >= len(buf) or i + len(x) <= 0:
        return
    j0 = max(0, -i)
    x = x[j0:]
    i = max(0, i)
    n = min(len(x), len(buf) - i)
    buf[i:i + n] += gain * x[:n]


def kick():
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t / 0.03)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t / 0.22) + 0.3 * np.exp(-t / 0.004) * rng.standard_normal(n)


def clap():
    n = int(0.3 * SR)
    x = bp(rng.standard_normal(n), 900, 4000)
    e = np.zeros(n)
    for k, d in enumerate((0.0, 0.012, 0.024)):
        i = int(d * SR)
        e[i:] += np.exp(-np.arange(n - i) / SR / (0.009 if k < 2 else 0.11))
    return x * e * 0.8


def hat(open_=False):
    n = int((0.22 if open_ else 0.06) * SR)
    return hp(rng.standard_normal(n), 7000) * env(n, 0.001, 0.08 if open_ else 0.014)


def riser(length):
    n = int(length * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    for k in range(8):  # sweep the band upward in 8 slices
        s, e_ = k * n // 8, (k + 1) * n // 8
        lo = 300 * 2 ** (k * 0.6)
        out[s:e_] = bp(noise, lo, lo * 3)[s:e_]
    pitch = saw(0, n) * 0
    f = 200 * 2 ** (3 * t / length)
    pitch = np.sin(2 * np.pi * np.cumsum(f) / SR)
    return (0.6 * out + 0.25 * pitch) * (t / length) ** 2


def impact():
    n = int(2.2 * SR)
    t = np.arange(n) / SR
    boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t / 0.08)) / SR) * np.exp(-t / 0.9)
    crash = hp(rng.standard_normal(n), 3000) * np.exp(-t / 0.6) * 0.35
    return boom + crash


def pad_chord(notes, length):
    n = int(length * SR)
    x = sum(saw(hz(m), n, d) for m in notes for d in (-0.006, 0.0, 0.007))
    x = lp(x / 9, 1800)
    return x * env(n, 0.25, length, sustain=0.9) * np.minimum(1, (n - np.arange(n)) / (0.2 * SR))


def pluck(m, length=0.22):
    n = int(length * SR)
    x = saw(hz(m), n) + 0.5 * saw(hz(m + 12), n, 0.003)
    return lp(x, 3800) * env(n, 0.002, 0.09)


def bass_note(m, length):
    n = int(length * SR)
    x = saw(hz(m), n) + 0.6 * np.sin(2 * np.pi * hz(m - 12) * np.arange(n) / SR)
    return lp(x, 420) * env(n, 0.004, length * 0.6, sustain=0.5)


def reverb(x, secs=1.6, mix=0.18):
    n = int(secs * SR)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / SR / (secs / 5))
    ir = lp(ir, 5000)
    wet = signal.fftconvolve(x, ir)[: len(x)]
    wet /= np.max(np.abs(wet)) + 1e-9
    return x + mix * wet * np.max(np.abs(x))


def compose(name):
    c = CUES[name]
    dur = c["dur"]
    N = int((dur + 0.5) * SR)
    drums, bass, pads, arp, fx = (np.zeros(N) for _ in range(5))
    duck = np.ones(N)
    g0, g1 = c["groove"]
    br0, br1 = c["break"]
    K = kick()
    # groove: beats aligned so a downbeat lands on the first cut
    t = g0
    beat = 0
    while t < g1:
        in_break = br0 <= t < br1
        if not in_break:
            add(drums, K, t, 0.95)
            i = int(t * SR)
            d = 1 - 0.65 * np.exp(-np.arange(int(0.28 * SR)) / SR / 0.09)  # side-chain
            duck[i:i + len(d)] = np.minimum(duck[i:i + len(d)], d[: max(0, min(len(d), N - i))])
            if beat % 2 == 1:
                add(drums, clap(), t, 0.55)
            add(drums, hat(True), t + BEAT / 2, 0.22)
            add(drums, hat(), t + BEAT / 4, 0.12)
            add(drums, hat(), t + 3 * BEAT / 4, 0.12)
        bar = (beat // 4) % 4
        if beat % 4 == 0:
            add(pads, pad_chord(CHORDS[bar], 4 * BEAT), t, 0.5)
        if not in_break:
            add(bass, bass_note(BASS[bar], BEAT * 0.45), t + BEAT / 2, 0.55)
            add(bass, bass_note(BASS[bar], BEAT * 0.3), t + 3 * BEAT / 4, 0.4)
            for k in range(4):
                add(arp, pluck(ARP[bar][k]), t + k * BEAT / 4, 0.16)
        t += BEAT
        beat += 1
    # opening: a pad and a ticking build before the drop
    add(pads, pad_chord(CHORDS[0], g0 + 0.3), 0.0, 0.45)
    for k in range(int(g0 / (BEAT / 2))):
        add(drums, hat(), k * BEAT / 2, 0.05 + 0.1 * k / max(1, g0 / (BEAT / 2)))
    # risers into cuts, impacts on cuts
    for i, ct in enumerate(c["cuts"]):
        big = ct in (g0, c["logo"])
        L = 1.2 if big else 0.55
        add(fx, riser(L), ct - L, 0.5 if big else 0.25)
        add(fx, impact(), ct, 0.9 if big else 0.4)
    # logo: final chord, sub swell, fade
    add(pads, pad_chord([57, 60, 64, 69], dur - c["logo"] + 0.4), c["logo"], 0.7)
    mix = drums + duck * (bass + pads * 0.9) + arp + fx
    mix = reverb(mix)
    fade = np.ones(N)
    f0 = int((dur - 1.6) * SR)
    fade[f0:] = np.linspace(1, 0, N - f0) ** 1.5
    mix *= fade
    mix = np.tanh(1.4 * mix / (np.max(np.abs(mix)) + 1e-9)) * 0.95
    mix = mix[: int(dur * SR)]
    # gentle stereo: a few ms of delay on the right channel for width
    r = np.concatenate([np.zeros(int(0.007 * SR)), mix])[: len(mix)]
    return np.stack([mix, 0.92 * r + 0.08 * mix], axis=1)


def write(path, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    write(sys.argv[2], compose(sys.argv[1]))
    print("wrote", sys.argv[2])

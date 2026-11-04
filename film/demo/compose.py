"""Assemble the demo: intro film + recorded console segments with voice-over and a music bed + outro film.

    uv run python film/demo/compose.py      # -> film/out/argonaut-demo.mp4 (and reports the length)
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
FILM = ROOT.parent / "out"
sys.path.insert(0, str(ROOT.parent))
import music  # noqa: E402

TEMPO = 1.02  # voice-over plays 2 % faster, as record.mjs assumes
PAD = 0.25
SEGS = ["welcome", "sense", "infer", "samples", "agents", "loop", "voiceopen", "roster"]
SAMPLES = ["belt", "conveyor", "pump", "motor"]
HOLD = json.loads((ROOT / "holds.json").read_text())
LIB = ROOT.parent.parent / "data" / "library"
# the machine's own sound under each segment (source file, from clip time)
SOUND = {"sense": "pump-skid-analyser", "infer": "fan-exhaust-84in-runup", "samples_belt": "belt-drive-running", "samples_conveyor": "conveyor-drive-velenje",
         "samples_pump": "pump-self-priming-bench", "samples_motor": "motor-load-test-bench"}
VOPTS = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", "-s", "1920x1080", "-video_track_timescale", "15360"]  # one timescale, or -c copy concat drops frames


def run(*a):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *map(str, a)], check=True)


def probe(f):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)]))


def cut(name, dest):
    m = json.loads((OUT / f"seg_{name}.json").read_text())
    run("-ss", m["start"], "-i", OUT / f"seg_{name}.webm", "-t", m["seconds"], "-an", *VOPTS, dest)
    return probe(dest)


def bed(seconds, path):
    """A quiet pad + pluck bed for under the voice, from the same synth as the films (same key and tempo)."""
    N = int((seconds + 1) * music.SR)
    pads, arp = np.zeros(N), np.zeros(N)
    t, beat = 0.0, 0
    while t < seconds:
        bar = (beat // 4) % 4
        if beat % 4 == 0:
            music.add(pads, music.pad_chord(music.CHORDS[bar], 4 * music.BEAT), t, 0.5)
        if beat % 2 == 0:
            for k in range(4):
                music.add(arp, music.pluck(music.ARP[bar][k]), t + k * music.BEAT / 4, 0.1)
        t += music.BEAT
        beat += 1
    x = music.reverb(pads + arp, mix=0.25)
    x = x / (np.max(np.abs(x)) + 1e-9) * 0.9
    x = x[: int(seconds * music.SR)]
    n = int(1.0 * music.SR)
    x[:n] *= np.linspace(0, 1, n)
    x[-n:] *= np.linspace(1, 0, n)
    music.write(str(path), np.stack([x, x], axis=1))


def footage_track(name, t0, seconds, hold, full=1.0, under=0.22):
    """The clip's own sound, loudness-normalised: full during the hold, then down under the voice."""
    m = json.loads((OUT / f"seg_{name}.json").read_text())
    dest = OUT / f"sound_{name}.wav"
    env = f"volume='{under}+({full}-{under})*clip(({hold}-t)/0.6,0,1)':eval=frame"
    run("-ss", m.get("clipT0", 0), "-i", LIB / f"{SOUND[name]}.mp4", "-t", seconds, "-vn", "-af",
        f"loudnorm=I=-18:TP=-2:LRA=11,aresample=44100,{env}", "-ac", "2", dest)
    return dest, t0


def main():
    parts = []
    for name in SEGS:
        if name == "samples":
            sub = []
            for s in SAMPLES:
                d = OUT / f"cut_samples_{s}.mp4"
                cut(f"samples_{s}", d)
                sub.append(d)
            lst = OUT / "samples.txt"
            lst.write_text("".join(f"file '{p.name}'\n" for p in sub))
            run("-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", OUT / "cut_samples.mp4")
            parts.append(OUT / "cut_samples.mp4")
        elif name == "roster":
            d = OUT / "cut_roster.mp4"
            run("-i", FILM / "argonaut-roster.mp4", "-an", *VOPTS, d)
            parts.append(d)
        else:
            d = OUT / f"cut_{name}.mp4"
            cut(name, d)
            parts.append(d)
    lst = OUT / "mid.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in parts))
    run("-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", OUT / "mid_v.mp4")
    mid = probe(OUT / "mid_v.mp4")

    # voice: each segment's narration starts after its hold, while the machine is heard alone
    cmd = probe(OUT / "vo_command.mp3") + 0.6
    holds = {**HOLD, "voiceopen": cmd}
    inputs, filt, t = [], [], 0.0
    starts, quiet = {}, []
    for i, (name, p) in enumerate(zip(SEGS, parts)):
        starts[name] = t
        h = holds.get(name, 0)
        if h:
            quiet.append((t, t + h))
        inputs += ["-i", OUT / f"vo_{name}.mp3"]
        filt.append(f"[{i}:a]atempo={TEMPO},aresample=44100,adelay={int((t + h) * 1000 + 80)}:all=1,volume=1.0[v{i}]")
        t += probe(p)
    k = len(SEGS)
    # footage sound and the spoken command, as extra inputs on the voice bus
    extra = []
    for name in ("sense", "infer"):
        extra.append(footage_track(name, starts[name], probe(OUT / f"cut_{name}.mp4"), holds[name]))
    ts = starts["samples"]
    for j, sname in enumerate(SAMPLES):
        n = f"samples_{sname}"
        sec = probe(OUT / f"cut_{n}.mp4")
        extra.append(footage_track(n, ts, sec, holds["samples"] if j == 0 else 0.0, under=0.3))
        ts += sec
    extra.append((OUT / "vo_command.mp3", starts["voiceopen"]))
    fx = []
    for j, (f, t0) in enumerate(extra):
        inputs += ["-i", f]
        fx.append(f"[{k + j}:a]aresample=44100,aformat=channel_layouts=stereo,adelay={int(t0 * 1000)}:all=1[s{j}]")
    bed(mid, OUT / "bed.wav")
    nb = k + len(extra)
    inputs += ["-i", OUT / "bed.wav"]
    vo_mix = "".join(f"[v{i}]" for i in range(k))
    s_mix = "".join(f"[s{j}]" for j in range(len(extra)))
    # the music nearly drops out while the machine is heard alone, and ducks under the voice
    q = "+".join(f"between(t,{a:.2f},{b:.2f})" for a, b in quiet)
    fc = ";".join(filt + fx + [
        f"{vo_mix}amix=inputs={k}:duration=longest:normalize=0,asplit=2[vo1][vo2]",
        f"{s_mix}amix=inputs={len(extra)}:duration=longest:normalize=0[sn]",
        f"[{nb}:a]aresample=44100,volume='if({q},0.02,0.20)':eval=frame[b]",
        "[b][vo1]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=300[bd]",
        "[bd][vo2][sn]amix=inputs=3:duration=first:normalize=0,volume=1.4,alimiter=limit=0.95[out]",
    ])
    run(*inputs, "-filter_complex", fc, "-map", "[out]", "-t", mid, "-ac", "2", "-ar", "44100", OUT / "mid_a.wav")
    run("-i", OUT / "mid_v.mp4", "-i", OUT / "mid_a.wav", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", OUT / "mid.mp4")

    # intro + middle + outro: normalise each part to one format, then join without re-timing anything
    final = FILM / "argonaut-demo.mp4"
    joined = []
    for name, src in (("intro", FILM / "argonaut-intro.mp4"), ("midn", OUT / "mid.mp4"), ("outro", FILM / "argonaut-outro.mp4")):
        d = OUT / f"join_{name}.mp4"
        run("-i", src, *VOPTS, "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2", d)
        joined.append(d)
    lst = OUT / "final.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in joined))
    run("-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", final)
    d = probe(final)
    print(f"{final}: {d:.1f} s = {int(d // 60)}:{d % 60:04.1f}, {final.stat().st_size / 1e6:.0f} MB  (middle {mid:.1f} s)")
    if d > 180:
        raise SystemExit("over 3 minutes")


main()

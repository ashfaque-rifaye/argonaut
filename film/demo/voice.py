"""Voice-over for the demo, with word timings so highlights land on the word being spoken.

    uv run --with edge-tts python film/demo/voice.py
    -> film/demo/out/vo_<id>.mp3, vo_<id>.json ([{t, w}]), durations.txt, roster_cues.js, vo_command.mp3
"""
import asyncio
import json
import subprocess
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
VOICE, RATE = "en-US-AndrewNeural", "+12%"
TEMPO = 1.02
COMMAND = ("hi-IN-SwaraNeural", "Argonaut, is pump ko analyse karo, aur best speed batao.")


async def speak(text, voice, rate, mp3):
    for i in range(6):
        try:
            words = []
            with open(mp3, "wb") as f:
                async for c in edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary").stream():
                    if c["type"] == "audio":
                        f.write(c["data"])
                    elif c["type"] == "WordBoundary":
                        words.append({"t": c["offset"] / 1e7, "w": c["text"]})
            return words
        except Exception:
            await asyncio.sleep(3 + 3 * i)
    raise SystemExit(f"tts failed: {text[:40]}")


def probe(f):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)]))


def at(words, needle, after=0.0):
    for w in words:
        if w["t"] >= after and needle.lower() in w["w"].lower():
            return w["t"] / TEMPO
    raise SystemExit(f"no word {needle}")


async def main():
    OUT.mkdir(exist_ok=True)
    lines = []
    all_words = {}
    for n in json.loads((ROOT / "narration.json").read_text(encoding="utf-8")):
        mp3 = OUT / f"vo_{n['id']}.mp3"
        words = await speak(n["text"], VOICE, RATE, mp3)
        (OUT / f"vo_{n['id']}.json").write_text(json.dumps(words), encoding="utf-8")
        d = probe(mp3)
        lines.append(f"{n['id']} {d:.3f}")
        all_words[n["id"]] = words
        print(n["id"], round(d, 1), len(words))
    await speak(COMMAND[1], COMMAND[0], "+0%", OUT / "vo_command.mp3")
    lines.append(f"command {probe(OUT / 'vo_command.mp3'):.3f}")
    (OUT / "durations.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    r = all_words["roster"]
    t_end = float(lines[[l.split()[0] for l in lines].index("roster")].split()[1]) / TEMPO
    # the second "Muse Spark" is the Open one
    spark = [w["t"] for w in r if w["w"] == "Spark"]
    cues = {"dur": round(t_end + 0.6, 2),
            "models": [round(at(r, "SAM"), 2), round(at(r, "Spark"), 2), round(at(r, "Wonder"), 2), round(at(r, "Voice"), 2), round(spark[1] / TEMPO, 2)],
            "acts": [round(at(r, "field"), 2), round(at(r, "skip"), 2), round(at(r, "work"), 2), round(at(r, "cost"), 2), round(at(r, "follow"), 2)]}
    (ROOT.parent / "out" / "roster_cues.js").write_text(f"window.ROSTER_CUES = {json.dumps(cues)}\n", encoding="utf-8")
    print(cues)


asyncio.run(main())

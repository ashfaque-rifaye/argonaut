"""Record the hands-free, private run: a spoken Hindi-English command goes through Muse Voice Transcribe, it starts the
analysis of a real clip, and the agent then reasons on Muse Spark Open (open weights) instead of Muse Wonder.

The operator's voice is synthesised speech, and everything downstream of it is a real call.

    uv run --with edge-tts python scripts/record_voice_open.py    # -> data/runs/demo_voice_open/events.jsonl
"""
import asyncio
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from argonaut.models.voice import VoiceSession  # noqa: E402
from argonaut.pipeline import RUNS, Session  # noqa: E402

CLIP = Path(__file__).resolve().parent.parent / "data" / "library" / "pump-self-priming-bench.mp4"
OUT = "demo_voice_open"
VOICE = "hi-IN-SwaraNeural"
COMMAND = "Argonaut, is pump ko analyse karo, aur best speed batao."


async def speak(text: str) -> bytes:
    import edge_tts
    with tempfile.TemporaryDirectory() as d:
        mp3 = Path(d) / "x.mp3"
        for i in range(6):
            try:
                await edge_tts.Communicate(text, VOICE).save(str(mp3))
                break
            except Exception:
                await asyncio.sleep(3 + 3 * i)
        return subprocess.run(["ffmpeg", "-v", "error", "-i", str(mp3), "-ar", "24000", "-ac", "1", "-f", "s16le", "-"],
                              capture_output=True, check=True).stdout


async def main():
    tmp = f"_rec_{OUT}"
    shutil.rmtree(RUNS / tmp, ignore_errors=True)
    s = Session(tmp, "Pump · hands-free, private mode")
    pcm = await speak(COMMAND)
    # The realtime model sometimes stutters ("Argonautonaut"); record a take whose transcript is clean, unedited.
    for attempt in range(5):
        heard = asyncio.Event()
        fired: list[str] = []
        said: list[dict] = []

        async def collect(ev, said=said):
            said.append(ev)

        async def on_command(name, fired=fired, heard=heard):
            fired.append(name)
            heard.set()

        voice = VoiceSession(collect, on_command)
        await voice.start()
        await asyncio.sleep(0.5)
        chunk = 4800  # 100 ms at 24 kHz, 16-bit
        for i in range(0, len(pcm), chunk):
            await voice.push(pcm[i:i + chunk])
            await asyncio.sleep(0.1)
        for _ in range(30):  # trailing silence so the model closes the utterance
            await voice.push(b"\0" * chunk)
            await asyncio.sleep(0.1)
        await asyncio.wait_for(heard.wait(), 30)
        await voice.stop()
        final = next((e["text"] for e in said if e["type"] == "transcript" and e["final"] and e["text"].strip()), "")
        words = final.split()
        print(f"take {attempt + 1}: {fired}", final.encode("ascii", "replace").decode())
        if words and words[0].strip(",").lower() == "argonaut" and all(x.strip(",") != y.strip(",") for x, y in zip(words, words[1:])):
            break
    for ev in said:
        await s.emit(ev)

    await s.analyse_clip(str(CLIP), realtime=1e6, clip_id="pump-self-priming-bench", run_agent=False)
    await s.run_agent(private=True)
    s._log.close()
    shutil.rmtree(RUNS / OUT, ignore_errors=True)
    (RUNS / tmp).rename(RUNS / OUT)
    print("recorded", OUT)


if __name__ == "__main__":
    asyncio.run(main())

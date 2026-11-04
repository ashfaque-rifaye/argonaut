"""End-to-end checks of the two Meta paths that had never run:

1. Muse Voice Transcribe realtime: speak a code-switched command (synthesised speech) into VoiceSession.
2. Muse Spark Open: the agent's chat path against an OpenAI-compatible open-weights endpoint.

    uv run --with edge-tts python scripts/test_voice_open.py voice
    uv run python scripts/test_voice_open.py open
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

UTTERANCES = [
    ("en-IN-NeerjaNeural", "Argonaut, start a coast-down and check the bearing housing."),
    ("hi-IN-SwaraNeural", "Argonaut, pump ka coast-down shuru karo, aur phir optimize karo."),
]


async def speak(voice: str, text: str) -> bytes:
    import edge_tts
    with tempfile.TemporaryDirectory() as d:
        mp3 = Path(d) / "x.mp3"
        for i in range(6):
            try:
                await edge_tts.Communicate(text, voice).save(str(mp3))
                break
            except Exception:
                await asyncio.sleep(3 + 3 * i)
        return subprocess.run(["ffmpeg", "-v", "error", "-i", str(mp3), "-ar", "24000", "-ac", "1", "-f", "s16le", "-"],
                              capture_output=True, check=True).stdout


async def test_voice():
    from argonaut.models.voice import VoiceSession
    events, commands = [], []

    async def emit(ev):
        events.append(ev)
        if ev["type"] == "transcript" and ev.get("final"):
            print("  transcript:", ev["text"])
        if ev["type"] == "pipeline" and ev.get("state") == "error":
            print("  pipeline error:", ev.get("detail"))

    async def on_command(name):
        commands.append(name)
        print("  COMMAND ->", name)

    for voice, text in UTTERANCES:
        print(f"speaking ({voice}): {text}")
        pcm = await speak(voice, text)
        s = VoiceSession(emit, on_command)
        await s.start()
        await asyncio.sleep(0.5)
        chunk = 4800  # 100 ms at 24 kHz, 16-bit
        for i in range(0, len(pcm), chunk):
            await s.push(pcm[i:i + chunk])
            await asyncio.sleep(0.1)  # real time
        for _ in range(30):  # trailing silence so the model closes the utterance
            await s.push(b"\0" * chunk)
            await asyncio.sleep(0.1)
        await asyncio.sleep(1.5)
        await s.stop()
    print("commands:", commands)
    print("transcripts:", sum(1 for e in events if e["type"] == "transcript"))


async def test_open():
    from openai import AsyncOpenAI
    token = os.environ.get("HF_TOKEN") or (Path.home() / ".cache/huggingface/token").read_text().strip()
    model = os.environ.get("OPEN_MODEL", "meta-models/Muse-Spark-Open-816B-A42B")
    c = AsyncOpenAI(base_url="https://router.huggingface.co/v1", api_key=token, timeout=120)
    tools = [{"type": "function", "function": {"name": "get_identification", "description": "Measured machine data.",
                                               "parameters": {"type": "object", "properties": {}, "required": []}}}]
    msgs = [{"role": "system", "content": "You are a machinery engineer. Use the tool, then answer in one sentence with the numbers."},
            {"role": "user", "content": "Assess this pump."}]
    r = await c.chat.completions.create(model=model, messages=msgs, tools=tools, max_tokens=400)
    m = r.choices[0].message
    print("model:", r.model, "| tool calls:", [t.function.name for t in (m.tool_calls or [])], "| usage:", r.usage and r.usage.total_tokens)
    if m.tool_calls:
        msgs.append(m.model_dump(exclude_none=True))
        for t in m.tool_calls:
            msgs.append({"role": "tool", "tool_call_id": t.id, "content": json.dumps(
                {"speed_rpm": 1482, "order_1x_share": 0.88, "fault_posterior": {"imbalance": 0.56}})})
        r = await c.chat.completions.create(model=model, messages=msgs, tools=tools, max_tokens=300)
    print("answer:", r.choices[0].message.content)


asyncio.run(test_voice() if sys.argv[1:] == ["voice"] else test_open())

"""Smoke-test every Meta model we plan to use, so API problems surface before we build.

Usage:
    uv run python scripts/smoke_test.py            # text + SAM image + transcribe
    uv run python scripts/smoke_test.py --video path/to/clip.mp4   # also Muse Spark video + SAM video
"""

import argparse
import io
import math
import os
import struct
import sys
import time
import wave

import httpx
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

API_KEY = os.environ.get("MODEL_API_KEY", "")
BASE_URL = os.environ.get("MODEL_BASE_URL", "https://api.meta.ai/v1")
SAMPLE_IMAGE = "https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg"

results: list[tuple[str, bool, str]] = []


def check(name):
    def wrap(fn):
        def run(*args):
            t0 = time.perf_counter()
            try:
                detail = fn(*args)
                results.append((name, True, f"{time.perf_counter() - t0:.1f}s  {detail}"))
            except Exception as e:  # noqa: BLE001 - report every failure, keep going
                results.append((name, False, f"{type(e).__name__}: {e}"[:300]))
        return run
    return wrap


client = OpenAI(base_url=BASE_URL, api_key=API_KEY or "missing")


@check("list models")
def list_models():
    ids = sorted(m.id for m in client.models.list().data)
    return ", ".join(ids)


@check("muse-spark-1.3 text")
def spark_text():
    r = client.responses.create(model="muse-spark-1.3", input="Reply with exactly: pong")
    return r.output_text.strip()[:60]


@check("muse-wonder-1.0 text")
def wonder_text():
    r = client.responses.create(model="muse-wonder-1.0", input="Reply with exactly: pong")
    return r.output_text.strip()[:60]


@check("sam-3.1 image")
def sam_image():
    text = ""
    with client.responses.stream(
        model="sam-3.1",
        input=[{"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": "cat"},
            {"type": "input_image", "image_url": SAMPLE_IMAGE},
        ]}],
    ) as stream:
        for event in stream:
            if event.type == "response.output_text.delta":
                text += event.delta
    return f"{text.count('<|box')} box(es); head: {text[:90]}"


def _tone_wav(seconds=1.0, rate=16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(
            struct.pack("<h", int(3000 * math.sin(2 * math.pi * 440 * i / rate)))
            for i in range(int(seconds * rate))
        ))
    return buf.getvalue()


@check("muse-voice-transcribe-1.0 file")
def transcribe():
    # A pure tone has no speech; we only check auth, format and the response shape.
    r = httpx.post(
        f"{BASE_URL}/asr/transcribe",
        headers={"Authorization": f"Bearer {API_KEY}"},
        files={
            "request": (None, '{"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV"}', "application/json"),
            "audio": ("tone.wav", _tone_wav(), "audio/wav"),
        },
        timeout=60,
    )
    r.raise_for_status()
    return f"keys: {list(r.json().keys())}"


def _upload(path: str) -> str:
    with open(path, "rb") as f:
        return client.files.create(file=f, purpose="user_data").id


@check("muse-spark-1.3 video")
def spark_video(file_id: str):
    r = client.responses.create(
        model="muse-spark-1.3",
        max_output_tokens=4000,
        input=[{"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": "In one sentence: what is in this video and what can you hear?"},
            {"type": "input_video", "file_id": file_id},
        ]}],
    )
    return r.output_text.strip()[:160]


@check("sam-3.1 video")
def sam_video(file_id: str, prompt: str):
    text = ""
    with client.responses.stream(
        model="sam-3.1",
        input=[{"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": prompt},
            {"type": "input_video", "file_id": file_id},
        ]}],
        metadata={"mask_encoding": "one_bit", "include_confidence": "true"},
    ) as stream:
        for event in stream:
            if event.type == "response.output_text.done":  # video output arrives whole, not as deltas
                text = event.text
    frames = len({line.split("f>")[0] for line in text.splitlines() if line.startswith("<")})
    return f"{frames} frame(s) with '{prompt}'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", help="local .mp4 to test video understanding and SAM tracking")
    ap.add_argument("--prompt", default="fan", help="SAM noun phrase for the video test")
    args = ap.parse_args()

    if not API_KEY:
        sys.exit("MODEL_API_KEY is not set. Copy .env.example to .env and add your key.")

    list_models()
    spark_text()
    wonder_text()
    sam_image()
    transcribe()
    if args.video:
        file_id = _upload(args.video)
        spark_video(file_id)
        sam_video(file_id, args.prompt)

    width = max(len(n) for n, _, _ in results)
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name:<{width}}  {detail}")
    sys.exit(0 if all(ok for _, ok, _ in results) else 1)


if __name__ == "__main__":
    main()

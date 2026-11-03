"""Muse Voice Transcribe realtime session: browser mic PCM in, diarised transcripts + commands out."""

import asyncio
import json
import re

import websockets

from .client import VOICE, Emit, api_key

URI = "wss://api.meta.ai/v1/asr/realtime"
KEYWORDS = ["Argonaut", "coast-down", "run-up", "Campbell", "resonance", "setpoint", "RPM", "NPSH",
            "cavitation", "bearing", "misalignment", "VFD", "approve", "reject"]
COMMANDS = [
    (re.compile(r"coast[\s-]?down|ruk(o|ne)|band karo", re.I), "start_coastdown"),
    (re.compile(r"\b(identify|analy[sz]e|check)\b", re.I), "identify"),
    (re.compile(r"\b(optimi[sz]e|best speed)\b", re.I), "optimize"),
    (re.compile(r"\b(verify|re-?measure)\b", re.I), "verify"),
    (re.compile(r"\bstop\b", re.I), "stop"),
]


class VoiceSession:
    def __init__(self, emit: Emit, on_command, languages=("English", "Hindi", "Tamil")):
        self.emit, self.on_command, self.languages = emit, on_command, list(languages)
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=200)
        self.task: asyncio.Task | None = None

    async def start(self):
        self.task = asyncio.create_task(self._run())

    async def push(self, pcm24k: bytes):
        if self.task and not self.task.done():
            try:
                self.queue.put_nowait(pcm24k)
            except asyncio.QueueFull:
                pass  # drop rather than run >5 s ahead of real time

    async def stop(self):
        await self.queue.put(None)
        if self.task:
            await asyncio.wait([self.task], timeout=5)

    async def _run(self):
        await self.emit({"type": "pipeline", "stage": "voice", "state": "running", "model": VOICE,
                         "detail": "realtime diarisation"})
        try:
            async with websockets.connect(URI, max_size=2**22) as ws:
                await ws.send(json.dumps({
                    "authorization": {"accessToken": f"Bearer {api_key()}"},
                    "audioEncoding": "PCM_24KHZ", "model": VOICE, "mode": "DIARIZATION",
                    "partialMode": "CUMULATIVE", "languageBias": self.languages, "keywords": KEYWORDS,
                }))
                await ws.recv()  # handshake ack {"sessionId": ...}
                sender = asyncio.create_task(self._send(ws))
                speaker = "A"
                async for msg in ws:
                    if not isinstance(msg, str):
                        continue
                    ev = json.loads(msg)
                    kind = ev.get("type")
                    if kind == "speaker":
                        speaker = ev.get("label", speaker)
                    elif kind == "transcript":
                        await self.emit({"type": "transcript", "speaker": speaker, "text": ev.get("transcript", ""),
                                         "final": bool(ev.get("final"))})
                    elif kind == "speechComplete":
                        text = ev.get("transcript", "")
                        await self.emit({"type": "transcript", "speaker": speaker, "text": text, "final": True})
                        for rx, name in COMMANDS:
                            if rx.search(text):
                                await self.on_command(name)
                                break
                    elif kind == "error":
                        await self.emit({"type": "pipeline", "stage": "voice", "state": "error", "model": VOICE,
                                         "detail": str(ev)[:200]})
                sender.cancel()
        except Exception as e:
            await self.emit({"type": "pipeline", "stage": "voice", "state": "error", "model": VOICE, "detail": str(e)[:200]})
            return
        await self.emit({"type": "pipeline", "stage": "voice", "state": "idle", "model": VOICE, "detail": "session closed"})

    async def _send(self, ws):
        while True:
            chunk = await self.queue.get()
            if chunk is None:
                await ws.send(json.dumps({"type": "endStream"}))
                return
            await ws.send(chunk)

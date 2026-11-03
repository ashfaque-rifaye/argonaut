"""FastAPI realtime server (see docs/CONTRACT.md).

Run:  uv run uvicorn argonaut.server:app --port 8000
"""

import asyncio
import base64
import json
import uuid
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .live import LiveEngine
from .models import client as mc
from .pipeline import RUNS, Session

app = FastAPI(title="Argonaut")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

SESSIONS: dict[str, Session] = {}
LIVE: dict[str, LiveEngine] = {}
TASKS: dict[str, asyncio.Task] = {}
LOOPS: dict[str, tuple] = {}


class NewSession(BaseModel):
    asset_name: str = "Asset"
    mode: str = "clip"


class Approval(BaseModel):
    proposal_id: str
    approved: bool
    note: str | None = None


def _plant_client():
    """The simulated VFD (Modbus TCP), if its server is running: `python -m argonaut.sim.plant --modbus-port 5020`."""
    try:
        from .sim import vfd_client
        vfd_client.read_state(timeout=0.3)
        return vfd_client
    except Exception:
        return None


@app.get("/api/health")
async def health():
    return {"ok": True, "meta_api": mc.available(), "baseten": mc.baseten() is not None}


@app.post("/api/sessions")
async def new_session(body: NewSession):
    sid = uuid.uuid4().hex[:8]
    s = Session(sid, body.asset_name)
    s.plant = await asyncio.to_thread(_plant_client)
    SESSIONS[sid] = s
    return {"session_id": sid}


@app.post("/api/sessions/{sid}/clip")
async def upload_clip(sid: str, file: UploadFile = File(...), realtime: float = 1.0, verify: bool = False):
    s = SESSIONS[sid]
    dest = s.dir / f"clip_{uuid.uuid4().hex[:6]}{Path(file.filename or 'x.mp4').suffix or '.mp4'}"
    dest.write_bytes(await file.read())
    import cv2
    cap = cv2.VideoCapture(str(dest))
    meta = {"fps": cap.get(cv2.CAP_PROP_FPS), "frames": cap.get(cv2.CAP_PROP_FRAME_COUNT),
            "width": cap.get(cv2.CAP_PROP_FRAME_WIDTH), "height": cap.get(cv2.CAP_PROP_FRAME_HEIGHT)}
    cap.release()
    coro = s.verify_clip(str(dest)) if verify else s.analyse_clip(str(dest), realtime=realtime)
    TASKS[sid] = asyncio.create_task(_guard(s, coro))
    return {"clip_id": dest.stem, "fps": meta["fps"], "duration_s": meta["frames"] / max(meta["fps"], 1),
            "width": meta["width"], "height": meta["height"]}


@app.post("/api/sessions/{sid}/datasheet")
async def upload_datasheet(sid: str, file: UploadFile = File(...)):
    s = SESSIONS[sid]
    data = await file.read()

    async def run():
        from .models import spark
        curve = await spark.read_pump_curve(data, file.content_type or "image/png", s.emit)
        s.pump_curve = {**curve, "system": {"static_head_m": 0.3 * curve["bep_h"], "k": 0.7 * curve["bep_h"] / max(curve["bep_q"], 1e-3) ** 2},
                        "npsha": 1.6 * max(curve["npshr"] or [1.0])}
        s.nameplate.setdefault("rpm", curve["rated_rpm"])
        await s.emit(s._asset_event())
        if s.ident:
            s._build_twin()

    TASKS[sid + ":ds"] = asyncio.create_task(_guard(s, run()))
    return {"ok": True}


@app.post("/api/sessions/{sid}/approve")
async def approve(sid: str, body: Approval):
    return await SESSIONS[sid].approve(body.proposal_id, body.approved)


class Envelope(BaseModel):
    lo_rpm: float
    hi_rpm: float
    max_step_rpm: float = 150.0
    approved: bool = True
    duty_min_frac: float = 0.8


@app.post("/api/sessions/{sid}/envelope")
async def approve_envelope(sid: str, body: Envelope):
    """Operator approves a speed envelope; Argonaut then optimises in closed loop inside it."""
    from .rto import ClosedLoop
    s = SESSIONS[sid]
    if not body.approved:
        return {"ok": True}
    if s.plant is None:
        s.plant = await asyncio.to_thread(_plant_client)
    if s.plant is None:
        return {"ok": False, "error": "no drive connected (start: uv run python -m argonaut.sim.plant --modbus-port 5020)"}
    if sid in LOOPS and not LOOPS[sid][1].done():
        return {"ok": False, "error": "closed loop already running"}
    loop = ClosedLoop(s, s.plant, (body.lo_rpm, body.hi_rpm), body.max_step_rpm, body.duty_min_frac)
    LOOPS[sid] = (loop, asyncio.create_task(_guard(s, loop.run())))
    return {"ok": True}


@app.post("/api/sessions/{sid}/rto/stop")
async def stop_rto(sid: str):
    if sid in LOOPS:
        LOOPS[sid][0].stopped = True
    return {"ok": True}


@app.get("/api/sessions/{sid}/report")
async def report(sid: str):
    s = SESSIONS[sid]
    return {"session_id": sid, "asset": s.asset_name, "identification": s.ident, "latest": s.latest}


DATA = (Path(__file__).resolve().parent.parent / "data").resolve()


@app.get("/api/media/{rel:path}")
async def media(rel: str):
    """Serve an analysed clip for playback under the sensor overlays (only files inside data/)."""
    from fastapi import HTTPException
    from fastapi.responses import FileResponse
    p = (DATA.parent / rel).resolve()
    if DATA not in p.parents or not p.is_file():
        raise HTTPException(404)
    return FileResponse(p, media_type="video/mp4")


@app.get("/api/runs")
async def runs():
    return sorted(p.name for p in RUNS.iterdir() if (p / "events.jsonl").exists()) if RUNS.exists() else []


async def _guard(s: Session, coro):
    try:
        await coro
    except Exception as e:
        await s.emit({"type": "error", "message": f"{type(e).__name__}: {e}"})


@app.websocket("/ws/{sid}")
async def ws_session(ws: WebSocket, sid: str):
    await ws.accept()
    s = SESSIONS.get(sid)
    if s is None:
        s = SESSIONS[sid] = Session(sid, "Live asset")
    send_lock = asyncio.Lock()

    async def push(ev):
        async with send_lock:
            await ws.send_text(json.dumps(ev, default=float))

    for ev in list(s.latest.values()):  # late joiners get the current picture
        await push(ev)
    s.subscribe(push)
    voice = None
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            kind = msg.get("type")
            if kind == "frame":
                eng = LIVE.setdefault(sid, LiveEngine(s))
                await eng.push_frame(float(msg.get("t", 0)), msg["jpeg_b64"])
            elif kind == "audio":
                pcm = base64.b64decode(msg["pcm16_b64"])
                await LIVE.setdefault(sid, LiveEngine(s)).push_audio(pcm)  # acoustic tachometer + de-aliasing
                if voice is None and mc.available():
                    from .models.voice import VoiceSession
                    voice = VoiceSession(s.emit, lambda name: _command(s, name))
                    await voice.start()
                if voice:
                    await voice.push(pcm)
            elif kind == "media":  # a streaming client announces the clip it plays, so viewers can show it
                rel = str(msg.get("path", "")).replace("\\", "/").lstrip("/")
                if (DATA.parent / rel).resolve().is_file() and DATA in (DATA.parent / rel).resolve().parents:
                    await s.emit({"type": "media", "url": f"/api/media/{rel}", "width": msg.get("width", 640),
                                  "height": msg.get("height", 360), "fps": msg.get("fps", 30)})
            elif kind == "sensors.set":
                s.sensor_prompts = msg.get("prompts") or None
                if sid in LIVE:
                    LIVE[sid].set_prompts(s.sensor_prompts)
            elif kind == "command":
                await _command(s, msg.get("name", ""))
            elif kind == "chat":
                await s.emit({"type": "agent", "role": "user", "text": msg.get("text", ""), "final": True})
                asyncio.create_task(_guard(s, s.run_agent()))
    except WebSocketDisconnect:
        pass
    finally:
        s.unsubscribe(push)
        if voice:
            await voice.stop()


async def _command(s: Session, name: str):
    if name in ("identify", "optimize"):
        asyncio.create_task(_guard(s, s.run_agent()))
    elif name == "start_coastdown":
        await s.emit({"type": "coach", "level": "ok",
                      "text": "Coast-down: switch the drive off now and keep the camera still for 20 s."})
    elif name == "verify" and s.proposal:
        await s.emit({"type": "coach", "level": "ok", "text": "Record a 10 s clip at the new setpoint to verify."})


@app.websocket("/ws/replay/{run_id}")
async def ws_replay(ws: WebSocket, run_id: str, speed: float = 1.0):
    """Replay a recorded run at its original pace (demo + UI development without camera or API)."""
    await ws.accept()
    path = RUNS / run_id / "events.jsonl"
    if not path.exists():
        await ws.send_text(json.dumps({"type": "error", "message": f"no run {run_id}"}))
        await ws.close()
        return
    last_t = None
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            ev = json.loads(line)
            t = ev.get("t")
            if last_t is not None and t is not None and t > last_t:
                await asyncio.sleep(min(2.0, (t - last_t) / max(speed, 1e-3)))
            last_t = t if t is not None else last_t
            await ws.send_text(line)
    except WebSocketDisconnect:
        pass

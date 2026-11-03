"""Stream a real clip into the running server exactly like the browser does: JPEG frames + 24 kHz mic PCM
over the session WebSocket, paced in real time. Prints what the live engine reports.

    uv run uvicorn argonaut.server:app --port 8000
    uv run python scripts/stream_clip.py data/raw/clips/rotor-kit-overview-unesp.mp4 --fps 30
Watch it live in the console: http://localhost:5173/console?session=<printed id>
"""

import argparse
import asyncio
import base64
import json
import sys
import time
from pathlib import Path

import cv2
import httpx
import numpy as np
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from argonaut.dsp.audio import load_audio  # noqa: E402

BASE = "http://127.0.0.1:8000"


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip")
    ap.add_argument("--fps", type=float, default=30.0, help="camera frame rate to emulate")
    ap.add_argument("--seconds", type=float, default=None)
    ap.add_argument("--asset", default=None)
    ap.add_argument("--wait-before", type=float, default=0.0, help="pause after printing the session id")
    a = ap.parse_args()

    clip = Path(a.clip)
    async with httpx.AsyncClient(timeout=60) as c:
        sid = (await c.post(BASE + "/api/sessions", json={"asset_name": a.asset or clip.stem, "mode": "live"})).json()["session_id"]
    print(f"session {sid}  ->  http://localhost:5173/console?session={sid}", flush=True)
    await asyncio.sleep(a.wait_before)

    cap = cv2.VideoCapture(str(clip))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    audio = load_audio(str(clip))
    step = max(1, round(src_fps / a.fps))
    stats = {"telemetry": [], "dealias": [], "sensors": None, "coach": [], "pipeline": [], "error": []}

    async with websockets.connect(f"ws://127.0.0.1:8000/ws/{sid}", max_size=2 ** 25) as ws:
        rel = clip.resolve().relative_to(Path(__file__).resolve().parent.parent).as_posix()
        await ws.send(json.dumps({"type": "media", "path": rel, "width": W, "height": H, "fps": src_fps}))

        async def reader():
            async for raw in ws:
                ev = json.loads(raw)
                t = ev["type"]
                if t in ("telemetry", "dealias", "coach", "error"):
                    stats[t].append(ev)
                elif t == "sensors":
                    stats["sensors"] = ev
                elif t == "pipeline" and ev.get("state") in ("ok", "error"):
                    stats["pipeline"].append(ev)

        rtask = asyncio.create_task(reader())
        t0, i, ai = time.perf_counter(), 0, 0
        while True:
            ok, fr = cap.read()
            if not ok or (a.seconds and i / src_fps > a.seconds):
                break
            if i % step == 0:
                t = i / src_fps
                if fr.shape[1] > 960:
                    fr = cv2.resize(fr, (960, round(fr.shape[0] * 960 / fr.shape[1])), interpolation=cv2.INTER_AREA)
                _, buf = cv2.imencode(".jpg", fr, [cv2.IMWRITE_JPEG_QUALITY, 85])
                await ws.send(json.dumps({"type": "frame", "t": round(t, 4), "jpeg_b64": base64.b64encode(buf.tobytes()).decode()}))
                a1 = int(t * 24000)
                if audio is not None and a1 > ai:
                    pcm = (np.clip(audio[ai:a1], -1, 1) * 32767).astype(np.int16).tobytes()
                    await ws.send(json.dumps({"type": "audio", "t": round(t, 4), "pcm16_b64": base64.b64encode(pcm).decode(), "rate": 24000}))
                    ai = a1
                await asyncio.sleep(max(0.0, t - (time.perf_counter() - t0)))
            i += 1
        await asyncio.sleep(1.0)
        rtask.cancel()

    tel = stats["telemetry"]
    print(f"\nstreamed {i / src_fps:.1f} s of {clip.name} at {a.fps:.0f} fps")
    if stats["sensors"]:
        print("virtual sensors:", [(s["label"], round(s["confidence"] or 0, 2)) for s in stats["sensors"]["items"]])
    for p in stats["pipeline"]:
        if p["stage"] in ("sam", "spark"):
            print(f"  {p['model']:<16} {p['state']:<5} {p.get('latency_ms', 0):>6} ms  {p.get('detail', '')}")
    for cch in stats["coach"]:
        print("coach:", cch["text"])
    if tel:
        lat = [e["latency"]["frame_to_telemetry_ms"] for e in tel if e.get("latency")]
        last = tel[-1]
        print(f"telemetry {len(tel)} updates; latency median {np.median(lat):.0f} ms, p95 {np.percentile(lat, 95):.0f} ms; fps_in {last['latency']['fps_in']:.1f}")
        sp = [e["speed_rpm"] for e in tel if e.get("speed_source", "").startswith("audio")]
        if sp:
            print(f"mic tachometer: median {np.median(sp):.0f} rpm (IQR {np.percentile(sp, 25):.0f}–{np.percentile(sp, 75):.0f})")
        print("last:", {k: last.get(k) for k in ("speed_rpm", "speed_source", "overall_vel_mm_s_rms", "iso_zone", "band")})
    if stats["dealias"]:
        d = stats["dealias"][-1]
        print("de-aliasing (camera alias -> true, order):",
              [(round(p["f_alias_hz"], 2), round(p["f_true_hz"], 2), p["order"]) for p in d["peaks"]])
    for e in stats["error"][:3]:
        print("ERROR", e["message"])


asyncio.run(main())

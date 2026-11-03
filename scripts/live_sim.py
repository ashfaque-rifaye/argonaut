"""Replay a clip as a live 30 fps webcam + 24 kHz mic stream through the streaming engine (no API).

    uv run python scripts/live_sim.py data/synth/pump_steady_misalignment.mp4
"""
import asyncio, base64, json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cv2, numpy as np  # noqa: E402
from argonaut.dsp import audio as A  # noqa: E402
from argonaut.dsp.motion import Region  # noqa: E402
from argonaut.live import LiveEngine  # noqa: E402
from argonaut.models import client as mc  # noqa: E402
from argonaut.pipeline import Session  # noqa: E402


async def main(path, cam_fps=30.0):
    mc.api_key = lambda: ""
    gt = json.load(open(Path(path).with_suffix(".json")))
    ev = {"telemetry": [], "dealias": [], "spectrum": []}

    async def sink(e):
        if e["type"] in ev:
            ev[e["type"]].append(e)

    s = Session("_live_sim", "Pump P-201 (live)", emit=sink)
    eng = LiveEngine(s)
    cap = cv2.VideoCapture(path)
    src_fps = cap.get(cv2.CAP_PROP_FPS)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    sc = 640 / W
    eng.regions = [Region(n, n, tuple(int(v * sc) for v in p["bbox_rest"]), is_reference=p["is_reference"])
                   for n, p in gt["parts"].items() if n in ("wall", "motor", "pump", "baseplate", "stand", "base")]
    eng.mm_per_px = gt["mm_per_px"] / sc
    audio = A.load_audio(path)
    step = int(round(src_fps / cam_fps))
    i, t0, ai = 0, time.perf_counter(), 0
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        if i % step == 0:
            t = i / src_fps
            ok2, buf = cv2.imencode(".jpg", fr, [cv2.IMWRITE_JPEG_QUALITY, 85])
            await eng.push_frame(t, base64.b64encode(buf.tobytes()).decode())
            a1 = int(t * 24000)
            if audio is not None and a1 > ai:
                await eng.push_audio((np.clip(audio[ai:a1], -1, 1) * 32767).astype(np.int16).tobytes())
                ai = a1
            await asyncio.sleep(max(0, t - (time.perf_counter() - t0)))  # real-time pacing
        i += 1
    await asyncio.sleep(0.3)
    tel = ev["telemetry"]
    lat = [e["latency"]["frame_to_telemetry_ms"] for e in tel]
    print(f"telemetry events {len(tel)} over {i / src_fps:.1f}s; latency median {np.median(lat):.1f} ms, p95 {np.percentile(lat, 95):.1f} ms; fps_in {tel[-1]['latency']['fps_in']:.1f}")
    print("last:", {k: tel[-1][k] for k in ("speed_rpm", "speed_source", "overall_vel_mm_s_rms", "overall_vel_ci", "iso_zone", "band")})
    if ev["dealias"]:
        print("dealias:", [(round(p["f_alias_hz"], 2), round(p["f_true_hz"], 2), p["order"], p["fold"]) for p in ev["dealias"][-1]["peaks"]])
    print("truth speed rpm:", gt["machine"]["rated_rpm"], "orders:", [(o["label"], o["order"]) for o in gt["orders"]])
    sys.exit(0)

asyncio.run(main(sys.argv[1]))

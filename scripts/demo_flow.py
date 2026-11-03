"""Drive the full product flow through the running server (http://localhost:8000):
clip upload -> live identification (Meta models) -> proposal -> envelope approval -> closed loop -> verification.

    uv run python -m argonaut.sim.plant --kind fan --modbus-port 5020 --noise 0.03 --speed 890 --ramp 400
    uv run python scripts/demo_flow.py data/synth/fan_coastdown.mp4
"""
import asyncio, json, sys
import httpx, websockets

BASE = "http://127.0.0.1:8000"


async def main(clip):
    async with httpx.AsyncClient(timeout=120) as c:
        sid = (await c.post(BASE + "/api/sessions", json={"asset_name": "Fan F-101"})).json()["session_id"]
        print("session", sid)
        async with websockets.connect(f"ws://127.0.0.1:8000/ws/{sid}", max_size=2 ** 25) as ws:
            with open(clip, "rb") as f:
                await c.post(BASE + f"/api/sessions/{sid}/clip?realtime=4", files={"file": ("clip.mp4", f, "video/mp4")})
            proposal = None
            env_sent = False
            while True:
                ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=400))
                t = ev["type"]
                if t == "agent":
                    print("AGENT", ev.get("provenance"), ev["text"][:140].replace("\n", " "))
                elif t in ("diagnosis", "dealias", "error"):
                    print(t.upper(), ev.get("title", ""), (ev.get("summary") or ev.get("message") or "")[:120], ev.get("provenance", ""))
                elif t == "proposal":
                    proposal = ev
                    print("PROPOSAL", round(ev["current"]["speed_rpm"]), "->", round(ev["proposed"]["speed_rpm"]), ev.get("risk"))
                elif t == "rto" and ev["status"] in ("stepping", "converged", "aborted"):
                    print("RTO", ev["iteration"], ev["status"], ev.get("setpoint_rpm"), (ev.get("measured") or {}).get("vel_mm_s"), ev.get("reason", "")[:90])
                elif t == "verification":
                    print("VERIFY", ev["summary"], ev.get("p_value"), ev.get("significant"))
                    if ev.get("proposal_id") == "rto":
                        break
                if t == "pipeline" and ev["stage"] == "wonder" and ev["state"] == "ok" and proposal and not env_sent:
                    pass
                if (t == "agent" and ev.get("final") and proposal is not None and not env_sent) or \
                   (t == "diagnosis" and ev.get("title") == "No feasible setpoint" and not env_sent):
                    env_sent = True
                    r = await c.post(BASE + f"/api/sessions/{sid}/envelope",
                                     json={"lo_rpm": 600, "hi_rpm": 1476, "max_step_rpm": 150, "approved": True,
                                           "duty_min_frac": 0.6})
                    print("ENVELOPE approved ->", r.json())

asyncio.run(main(sys.argv[1]))

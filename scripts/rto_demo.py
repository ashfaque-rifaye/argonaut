"""Closed-loop RTO demo against the simulated fan plant (offline, no API needed).

    uv run python scripts/rto_demo.py
Starts the Modbus plant in-process, seeds the twin with what Argonaut identified from the
fan coast-down clip (mode 14.76 ± 0.06 Hz, ζ 1.66 ± 0.41 %), then optimises in closed loop.
"""
import asyncio, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("ARGONAUT_VFD_PORT", "5031")
from argonaut.optimize import Twin  # noqa: E402
from argonaut.pipeline import Session  # noqa: E402
from argonaut.rto import ClosedLoop  # noqa: E402
from argonaut.sim import vfd_client  # noqa: E402
from argonaut.sim.plant import ModbusPlantServer, Plant, PlantConfig  # noqa: E402


async def main():
    plant = Plant(PlantConfig.fan(), speed_rpm=float(sys.argv[1]) if len(sys.argv) > 1 else 890.0, noise=0.03, seed=1)
    srv = ModbusPlantServer(plant, port=int(os.environ["ARGONAUT_VFD_PORT"])).start_in_thread()
    vfd_client.write_ramp(400)
    events = []

    async def sink(ev):
        events.append(ev)
        if ev["type"] == "rto" and ev["status"] in ("stepping", "converged", "aborted"):
            m = (ev.get("model") or {}).get("modes") or [{}]
            print(f"it{ev['iteration']} {ev['status']:<9} speed {ev.get('speed_rpm') or 0:7.0f} -> set {ev.get('setpoint_rpm') or 0:7.0f}"
                  f"  meas {(ev.get('measured') or {}).get('vel_mm_s', 0):5.2f}  pred {(ev.get('predicted') or {}).get('vel_mm_s', 0):5.2f}"
                  f"  fn {m[0].get('f_hz', 0):.2f}±{m[0].get('f_sd') or 0:.2f}  ζ {m[0].get('zeta') or 0:.4f}  | {ev.get('reason', '')}")
        if ev["type"] == "verification":
            print("VERIFY", ev["summary"], ev["significant"])

    s = Session("rto_demo", "Fan F-101 (simulated drive)", emit=sink)
    s.twin = Twin(speed_rpm=1294, modes=[{"f_hz": 14.76, "zeta": 0.0166, "f_sd": 0.06, "zeta_sd": 0.0041}],
                  order_vel_mm_s={1.0: 0.76, 2.0: 0.98}, rated_rpm=1476, rated_kw=0.075, min_rpm_frac=0.3)
    loop = ClosedLoop(s, vfd_client, (600, 1476), max_step=150, duty_min_frac=0.6)
    await loop.run()
    print("truth: plant critical 1x at", round(60 * 14.2), "rpm")
    srv.stop()

asyncio.run(main())

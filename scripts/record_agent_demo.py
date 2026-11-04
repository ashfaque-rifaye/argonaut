"""Record the agentic demo run: pump P-101 (rotor imbalance) analysed with the Meta models while the simulated drive is
connected, the agents propose actions, and an operator approves each one after a short pause.

    uv run python -m argonaut.sim.plant --kind pump --modbus-port 5020 --noise 0.02 --speed 1480 --ramp 300
    uv run python scripts/record_agent_demo.py            # -> data/runs/demo_agent_actions/events.jsonl
"""
import asyncio
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from argonaut.pipeline import RUNS, Session  # noqa: E402
from argonaut.sim import vfd_client  # noqa: E402

CLIP = Path(__file__).resolve().parent.parent / "data" / "synth" / "imbalance_before.mp4"
OUT = "demo_agent_actions"
APPROVE_AFTER_S = 3.0


async def main():
    vfd_client.read_state(timeout=1.0)  # fail fast if the drive is not running
    tmp = f"_rec_{OUT}"
    shutil.rmtree(RUNS / tmp, ignore_errors=True)
    s = Session(tmp, "Pump P-101 · simulated drive")
    s.plant = vfd_client
    approved: set[str] = set()

    async def operator(ev):
        if ev["type"] == "action" and ev["status"] == "proposed" and ev["id"] not in approved:
            approved.add(ev["id"])

            async def later(aid=ev["id"]):
                await asyncio.sleep(APPROVE_AFTER_S)
                await s.actions.approve(aid, True, "approved by operator")
            asyncio.create_task(later())

    s.subscribe(operator)
    await s.analyse_clip(str(CLIP), realtime=1.0)
    for _ in range(240):  # let approved actions finish
        busy = [a for a in s.actions.items.values() if a["status"] in ("proposed", "running")]
        if not busy:
            break
        await asyncio.sleep(0.5)
    s._log.close()
    print({a["kind"]: a["status"] for a in s.actions.items.values()})
    for a in s.actions.items.values():
        if a.get("result") and a["kind"] in ("balance", "skip_bands", "impact"):
            print(a["kind"], {k: v for k, v in a["result"].items() if k != "markdown"})
    shutil.rmtree(RUNS / OUT, ignore_errors=True)
    (RUNS / tmp).rename(RUNS / OUT)


if __name__ == "__main__":
    asyncio.run(main())

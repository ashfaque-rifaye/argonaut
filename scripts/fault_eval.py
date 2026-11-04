"""Fault-inference evaluation on the synthetic ground-truth clips (offline, no model API).

For each preset the scene JSON Muse Spark would return is built from the clip's ground-truth machine
description (class, poles, blades/vanes; nameplate rpm withheld), then the unmodified pipeline runs and
the fault posterior is compared with the fault the clip was rendered with.

    uv run python scripts/fault_eval.py            # writes data/fault_eval.json
"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from argonaut.models import client as mc  # noqa: E402
from argonaut.dsp.motion import Region  # noqa: E402
from argonaut.pipeline import Session  # noqa: E402
from benchmark import load_truth, select_parts  # noqa: E402  (same true part boxes as the benchmark)

SYNTH = Path(__file__).resolve().parent.parent / "data" / "synth"
TRUTH = {  # preset -> fault the clip was rendered with (None = healthy / low-level)
    "pump_steady_misalignment": "misalignment",
    "pump_cavitation": "cavitation",
    "imbalance_before": "imbalance",
    "imbalance_after": None,
    "fan_coastdown": "resonance",
    "shake_test": None,
}


async def run(preset: str) -> dict:
    meta = json.loads((SYNTH / f"{preset}.json").read_text())
    m = meta["machine"]
    s = Session(f"_fault_{preset}", preset, emit=None)
    s.scene = {"kinematics": {"machine_class": "fan" if meta["scene"] == "fan" else "centrifugal_pump",
                              "poles": m.get("poles", 0), "line_hz": 50}}
    s.nameplate = {"blades_or_vanes": m.get("blades") or m.get("vanes") or 0}
    truth = load_truth(preset)
    s_tr = min(truth["width"], 960) / truth["width"]
    clean, _contam, ref = select_parts(truth)
    regions = [Region(p, p, [c * s_tr for c in truth["parts"][p]["bbox_rest"]], is_reference=(p == ref))
               for p in clean + ([ref] if ref else [])]
    await s.analyse_clip(str(SYNTH / f"{preset}.mp4"), realtime=1e6, regions=regions,
                         mm_per_px=truth["mm_per_px"] / s_tr, run_agent=False)
    k = s.ident["kinematics"]
    return {"preset": preset, "truth": TRUTH[preset], "speed_rpm": s.ident["speed_rpm_now"],
            "faults": [(h["id"], round(h["p"], 3), h["evaluable"]) for h in k["fault_posterior"]]}


async def main():
    mc.api_key = lambda: ""
    rows = []
    for p in TRUTH:
        r = await run(p)
        top = next(h for h in r["faults"] if h[2])
        hit = (top[0] == r["truth"] and top[1] >= 0.5) if r["truth"] else all(h[1] < 0.5 for h in r["faults"])
        r["top"], r["correct"] = top, hit
        rows.append(r)
        print(f"{p:26s} truth={str(r['truth']):13s} top={top[0]:12s} p={top[1]:.2f}  {'OK' if hit else 'MISS'}  "
              + " ".join(f"{i}:{q:.2f}" for i, q, e in r["faults"] if e))
    (SYNTH.parent / "fault_eval.json").write_text(json.dumps(rows, indent=1))
    print(f"correct {sum(r['correct'] for r in rows)}/{len(rows)}")


asyncio.run(main())

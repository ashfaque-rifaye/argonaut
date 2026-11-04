"""Analyse a clip offline (no API): uv run python scripts/analyse_clip.py <clip.mp4> [asset name]"""
import asyncio, collections, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from argonaut.models import client as mc  # noqa: E402
from argonaut.pipeline import Session  # noqa: E402


async def main(path, name):
    counts, last = collections.Counter(), {}

    async def sink(ev):
        counts[ev["type"]] += 1
        last[ev["type"]] = ev
        if ev["type"] in ("diagnosis", "error"):
            print(ev["type"].upper(), ev.get("title", ""), ev.get("summary", ev.get("message", "")))

    if "--api" not in sys.argv:
        mc.api_key = lambda: ""
    s = Session(Path(path).stem, name, emit=sink)
    await s.analyse_clip(path, realtime=1e6)
    i = s.ident
    print(dict(counts))
    print(f"fps {i['fps']:.1f}  speed now {i['speed_rpm_now']:.0f} rpm  sweep {i['speed_sweep_frac']:.2f}  conf {i['speed_track_confidence_median']:.2f}  zone {i['iso_zone']}")
    print("modes:", [(round(m['f_hz'], 2), m['zeta'] and round(m['zeta'], 4), m['source']) for m in i['modes']])
    print("fdd:", [(round(m['f_hz'], 2), m['zeta'] and round(m['zeta'], 4)) for m in i['fdd_modes']])
    print("cavitation:", i['cavitation'])
    k = i.get("kinematics") or {}
    if k:
        sp = k.get("speed_posterior") or {}
        print("kinematics:", k.get("model"), "line", k.get("line_frequency_hz"))
        if sp:
            print(f"speed posterior: MAP {sp['map_rpm']:.1f} rpm P={sp['p_map']:.2f} modes",
                  [(round(m['rpm']), round(m['p'], 2), m.get('relation')) for m in sp['modes']],
                  "display", sp.get("display_rpm"), sp.get("display_error_pct"))
        print("faults:", [(h["id"], round(h["p"], 2)) for h in k["fault_posterior"] if h["evaluable"]])
    p = last.get("proposal")
    if p:
        print("proposal:", round(p["current"]["speed_rpm"]), "->", round(p["proposed"]["speed_rpm"]), p["expected"])


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else "Asset"))

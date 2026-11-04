"""Build the static showcase deployment into deploy/ (no backend: recorded runs replay in the browser).

    uv run python scripts/export_static.py          # builds web with VITE_SHOWCASE=1, copies runs + footage
    npx vercel deploy deploy --prod                 # or any static host

Contents: the web app, /static/runs/<id>.jsonl for every committed demo run whose footage is in the
repo, /static/runs.json, /static/library.json (only clips that have a recorded run) and /static/media/...
"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "deploy"
RUNS = ROOT / "data" / "runs"
SYNTH_RUNS = {"synth-imbalance_before": "demo_agent_actions", "synth-fan_coastdown": "demo_fan_closed_loop",
              "synth-pump_steady_misalignment": "demo_pump_misalignment"}


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    env = {**os.environ, "VITE_SHOWCASE": "1"}
    npx = "npx.cmd" if sys.platform == "win32" else "npx"
    subprocess.run([npx, "vite", "build", "--outDir", str(OUT), "--emptyOutDir"], cwd=ROOT / "web", env=env, check=True)
    st = OUT / "static"
    (st / "runs").mkdir(parents=True)
    media: set[str] = set()
    runs = []
    for d in sorted(RUNS.glob("demo_*")):
        ev = d / "events.jsonl"
        if not ev.exists():
            continue
        urls = set(re.findall(r'"url": "/api/media/([^"]+)"', ev.read_text(encoding="utf-8")))
        if any(u.startswith("data/raw/") or not (ROOT / u).exists() for u in urls):  # footage not in the repo
            print("skip", d.name, "(footage not committed)")
            continue
        shutil.copy(ev, st / "runs" / f"{d.name}.jsonl")
        media |= urls
        runs.append(d.name)
    (st / "runs.json").write_text(json.dumps(runs), encoding="utf-8")

    lib = json.loads((ROOT / "data" / "library" / "library.json").read_text(encoding="utf-8"))["clips"]
    clips = []
    for c in lib:
        if f"demo_real_{c['id']}" in runs:
            media |= {c["path"], c["poster"]}
            clips.append({**c, "url": f"/static/media/{c['path']}", "poster_url": f"/static/media/{c['poster']}"})
    for sid, run in SYNTH_RUNS.items():
        stem = sid.split("-", 1)[1]
        mp4 = f"data/synth/{stem}.mp4"
        if run in runs and (ROOT / mp4).exists():
            g = json.loads((ROOT / "data" / "synth" / f"{stem}.json").read_text(encoding="utf-8"))
            media.add(mp4)
            clips.append({"id": sid, "title": f"Synthetic · {stem.replace('_', ' ')}", "kind": g.get("scene", "synthetic"),
                          "featured": False, "real": False, "note": g.get("description", ""), "what": g.get("description", ""),
                          "credit": "Argonaut test bench", "license": "MIT (this repo)", "source_url": None,
                          "url": f"/static/media/{mp4}", "poster_url": None, "width": g.get("width"), "height": g.get("height"),
                          "fps": g.get("fps"), "duration_s": g.get("duration_s"), "has_audio": True, "run": run})
    (st / "library.json").write_text(json.dumps({"clips": clips}, ensure_ascii=False), encoding="utf-8")
    for rel in sorted(media):
        dst = st / "media" / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / rel, dst)

    (OUT / "vercel.json").write_text(json.dumps({
        "rewrites": [{"source": "/((?!static/|assets/|media/|mock/|favicon).*)", "destination": "/index.html"}],
        "headers": [
            {"source": "/static/media/(.*)", "headers": [{"key": "Cache-Control", "value": "public, max-age=604800, immutable"}]},
            {"source": "/assets/(.*)", "headers": [{"key": "Cache-Control", "value": "public, max-age=31536000, immutable"}]},
            {"source": "/static/runs/(.*)", "headers": [{"key": "Content-Type", "value": "application/x-ndjson; charset=utf-8"}]},
        ],
    }, indent=2), encoding="utf-8")
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"deploy/: {len(runs)} runs, {len(clips)} clips, {len(media)} media files, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()

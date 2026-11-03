"""Offline end-to-end check: synthetic coast-down video -> Session pipeline -> events (no API needed).

    uv run python scripts/e2e_offline.py
"""

import asyncio
import collections
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from argonaut.dsp.motion import Region  # noqa: E402
from argonaut.models import client as mc  # noqa: E402
from argonaut.pipeline import Session  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "data" / "runs" / "_e2e_clip.mp4"


def make_clip(path: Path, fs=240, T=12.0, w=480, h=270, fn=14.2, zeta=0.02, rpm0=1476):
    rng = np.random.default_rng(0)
    tex = cv2.resize(cv2.GaussianBlur(rng.random((h // 4, w // 4)).astype(np.float32), (0, 0), 1), (w, h))
    body = cv2.resize(cv2.GaussianBlur(rng.random((h // 4, w // 4)).astype(np.float32), (0, 0), 1), (w, h))
    t = np.arange(int(T * fs)) / fs
    sp = rpm0 / 60 * np.exp(-t / 6.0)
    ph = 2 * np.pi * np.cumsum(sp) / fs
    r = sp / fn
    gain = 1 / np.sqrt((1 - r**2) ** 2 + (2 * zeta * r) ** 2)
    dx = 0.04 * gain * np.sin(ph) + 0.03 * np.sin(2 * ph)
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fs, (w, h))
    for i in range(len(t)):
        M = np.float32([[1, 0, dx[i]], [0, 1, 0.5 * dx[i]]])
        b = cv2.warpAffine(body, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
        img = tex.copy()
        img[80:220, 150:400] = b[80:220, 150:400]
        g = np.clip(img * 255, 0, 255).astype(np.uint8)
        vw.write(cv2.cvtColor(g, cv2.COLOR_GRAY2BGR))
    vw.release()


async def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    make_clip(OUT)
    counts = collections.Counter()
    last = {}

    async def sink(ev):
        counts[ev["type"]] += 1
        last[ev["type"]] = ev

    mc.api_key = lambda: ""  # force the offline path
    s = Session("_e2e", "Synthetic fan", emit=sink)
    regions = [Region("s1", "fan housing", (160, 90, 390, 210), meta={"color": "#38BDF8"}),
               Region("s2", "fan housing (upper)", (160, 85, 390, 150), meta={"color": "#A78BFA"}),
               Region("s0", "wall", (5, 5, 120, 70), is_reference=True)]
    await s.analyse_clip(str(OUT), realtime=1e6, regions=regions, mm_per_px=1.0, run_agent=True)
    print(dict(counts))
    c = last["campbell"]
    print("modes:", [(round(m["f_hz"], 2), m["zeta"] and round(m["zeta"], 4), m["source"]) for m in c["modes"]])
    print("criticals:", [(round(x["rpm"]), x["order"]) for x in c["criticals"]])
    print("speed now rpm:", round(s.ident["speed_rpm_now"]), " sweep:", round(s.ident["speed_sweep_frac"], 2))
    p = last.get("proposal")
    if p:
        print("proposal:", round(p["current"]["speed_rpm"]), "->", round(p["proposed"]["speed_rpm"]), p["expected"])
    for d in [e for e in [last.get("diagnosis")] if e]:
        print("diagnosis:", d["title"], "|", d["summary"])
    ok = any(abs(m["f_hz"] - 14.2) < 1.0 for m in c["modes"])
    print("PASS" if ok else "FAIL: 14.2 Hz mode not identified")
    sys.exit(0 if ok else 1)


asyncio.run(main())

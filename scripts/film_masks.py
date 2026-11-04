"""Run the real Muse Spark + SAM 3.1 sensor placement on a still for the film's "give it eyes" scene.

    uv run python scripts/film_masks.py film/assets/blower.jpg film/assets/blower_masks.js
"""
import asyncio
import json
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from argonaut.models import sam, spark  # noqa: E402


async def main(img: str, out: str):
    frame = cv2.imread(img)
    h, w = frame.shape[:2]
    scene = await spark.understand_scene(frame, None, effort="low")
    print("Muse Spark:", scene.get("machine_type"), "|", scene.get("sensor_prompts"), "| ref:", scene.get("reference_prompt"))
    print("kinematics:", scene.get("kinematics"))
    regions = await sam.place_sensors(frame, scene["sensor_prompts"][:5], scene.get("reference_prompt") or "wall",
                                      None, effort="low", boxes=scene.get("boxes"))
    ev = sam.sensors_event(regions, w, h)
    items = [{"label": it["label"], "color": it["color"], "ref": it["is_reference"], "conf": it["confidence"],
              "pts": it["polygon"]} for it in ev["items"]]
    for it in items:
        print(f"  {it['label']:28s} conf {it['conf']}  {len(it['pts'])} pts")
    Path(out).write_text("window.MASKS=" + json.dumps(items) + ";\nwindow.SCENE=" + json.dumps(
        {"machine": scene.get("machine_type"), "kinematics": scene.get("kinematics")}) + ";", encoding="utf-8")


asyncio.run(main(sys.argv[1], sys.argv[2]))

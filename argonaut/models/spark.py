"""Muse Spark: scene + nameplate understanding, capture coaching, datasheet (pump curve) reading,
and audio-visual corroboration — all as schema-constrained JSON."""

import asyncio
import base64
import json

import cv2
import numpy as np
import openai

from .client import SPARK, SPARK_AUDIO, Emit, meta, stage

SCENE_SCHEMA = {
    "type": "object",
    "properties": {
        "machine_type": {"type": "string", "description": "e.g. centrifugal pump, axial fan, induction motor"},
        "drive": {"type": "string", "description": "direct, belt, gearbox, unknown"},
        "sensor_prompts": {"type": "array", "items": {"type": "string"},
                           "description": "2-5 short noun phrases naming rigid machine parts to measure, "
                                          "e.g. 'motor housing', 'pump casing', 'baseplate', 'fan guard'"},
        "reference_prompt": {"type": "string", "description": "a static background surface, e.g. 'wall', 'floor'"},
        "sensor_boxes": {"type": "array", "description": "tight pixel box for each sensor_prompt, same order",
                         "items": {"type": "object", "properties": {
                             "name": {"type": "string"},
                             "what": {"type": "string", "description": "2-5 words on what this part does or is, read from "
                                                                       "the image, e.g. 'drives the pump', 'cast iron volute'"},
                             "x1": {"type": "number"}, "y1": {"type": "number"},
                             "x2": {"type": "number"}, "y2": {"type": "number"}},
                             "required": ["name", "what", "x1", "y1", "x2", "y2"]}},
        "scale_reference": {"type": "object", "properties": {
            "object": {"type": "string"}, "real_size_mm": {"type": "number"},
            "pixel_size": {"type": "number"}}, "required": ["object", "real_size_mm", "pixel_size"]},
        "nameplate": {"type": "object", "properties": {
            "rpm": {"type": "number"}, "kw": {"type": "number"}, "poles": {"type": "number"},
            "blades_or_vanes": {"type": "number"}, "text": {"type": "string"}},
            "required": ["rpm", "kw", "poles", "blades_or_vanes", "text"]},
        "capture": {"type": "object", "properties": {
            "level": {"type": "string", "enum": ["ok", "warn", "block"]},
            "advice": {"type": "string"}}, "required": ["level", "advice"]},
        "kinematics": {"type": "object", "description": "what the machine can physically produce, for the "
                                                         "forcing-frequency model; 0 / '' / false when unknown",
                       "properties": {
                           "machine_class": {"type": "string", "enum": [
                               "induction_motor", "fan", "centrifugal_pump", "gear_pump", "genset", "engine",
                               "washer", "gearbox", "wind_turbine", "structure", "generic"]},
                           "stroke": {"type": "number", "description": "engines: 4 or 2"},
                           "cylinders": {"type": "number"},
                           "poles": {"type": "number"},
                           "synchronous": {"type": "boolean", "description": "synchronous generator / PM machine"},
                           "line_hz": {"type": "number", "description": "50 or 60 only if signage, region or a display shows it"},
                           "gear_teeth": {"type": "array", "items": {"type": "number"}},
                           "display_rpm": {"type": "number", "description": "rpm shown on a controller / tachometer "
                                                                           "display in the frame, else 0"},
                           "display_hz": {"type": "number"},
                           "rating_text": {"type": "string", "description": "ratings seen (e.g. '1500 kVA'); NEVER "
                                                                           "copy a kVA/kW figure into an rpm field"},
                           "evidence": {"type": "string", "description": "what in the image supports these values"}},
                       "required": ["machine_class", "stroke", "cylinders", "poles", "synchronous", "line_hz",
                                    "gear_teeth", "display_rpm", "display_hz", "rating_text", "evidence"]},
    },
    "required": ["machine_type", "drive", "sensor_prompts", "reference_prompt", "sensor_boxes", "scale_reference",
                 "nameplate", "capture", "kinematics"],
}

SCENE_PROMPT = """You are the field eyes of a vibration and machinery-dynamics engineer.
Look at this frame of an industrial machine.
- Identify the machine and drive.
- Propose 2-5 rigid, STATIONARY (non-rotating) parts to place virtual vibration sensors on: short
  noun phrases a segmentation model can find, e.g. motor housing, bearing housing, pump casing,
  baseplate/skid, stand pole, pipe flange. NEVER choose rotating parts or anything that encloses them
  (blades, impeller, rotor, shaft, coupling, fan guard/grille with blades behind it): their own motion
  corrupts the vibration measurement.
- Name one static background surface for camera-shake reference.
- Find ONE object of known real size for scale (nameplate plate ~ 100 mm wide, A4 sheet 297 mm,
  coin, bolt head, standard brick 230 mm) and estimate its size in pixels in this image.
- Read the nameplate if visible (rpm, kW, poles); use 0 for unknown numbers and '' for unknown text.
  For fans/pumps estimate blade or vane count if visible (0 if unknown).
- Kinematics (drives the forcing-frequency model, so be literal): the machine class (genset when a diesel
  engine, a generating-set enclosure or a generator controller is visible: exhaust stack, radiator, engine
  block, a controller showing Hz / kVA / rpm such as PowerCommand or DeepSea; an electric motor driving a
  dynamometer, load, pump or fan is induction_motor or that driven machine); for engines and
  gensets the stroke (diesel gensets are 4-stroke) and cylinder count if countable; motor/generator poles
  only from a nameplate; line frequency only if a display or nameplate shows it; gear tooth counts only
  if countable. If a controller or tachometer display is visible, copy its rpm and Hz exactly.
  A rating such as "1500 kVA" or "15 kW" is NOT a speed. Use 0 / '' / false for anything not visible.
- Judge the capture for measurement: 'block' if the machine is out of frame, blurry or moving camera;
  'warn' if usable but improvable; give one concrete instruction."""


def _img_part(frame: np.ndarray) -> dict:
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return {"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()}


async def _json(model: str, content: list[dict], schema: dict, name: str, max_tokens: int = 4000,
                effort: str | None = None) -> dict:
    last = None
    extra = {"reasoning": {"effort": effort}} if effort else {}
    for budget in (max_tokens, max_tokens * 2):  # reasoning shares the output budget; retry once with more room
        for attempt in range(3):  # transient network failures: back off and retry
            try:
                r = await meta().responses.create(
                    model=model,
                    input=[{"type": "message", "role": "user", "content": content}],
                    text={"format": {"type": "json_schema", "name": name, "schema": schema}},
                    max_output_tokens=budget,
                    **extra,
                )
                break
            except (openai.APIConnectionError, openai.APITimeoutError):
                if attempt == 2:
                    raise
                await asyncio.sleep(2 * (attempt + 1))
        try:
            return json.loads(r.output_text)
        except json.JSONDecodeError as e:
            last = e
    raise ValueError(f"{name}: model returned no valid JSON ({last})")


async def understand_scene(frame: np.ndarray, emit: Emit | None = None, effort: str = "low",
                           known: list[str] | None = None) -> dict:
    """effort='minimal' for live mode (~4 s), 'low' for clip analysis.

    `known`: names of parts already seen in this video, so the same part keeps its name when the camera moves.
    """
    h, w = frame.shape[:2]
    prompt = SCENE_PROMPT + (f"\n- The image is {w}x{h} px (x right, y down). For every proposed part also give a "
                             "tight pixel box in sensor_boxes.")
    if known:
        prompt += ("\n- This frame is from a moving camera, so make each box tight around the whole visible part, including its "
                   "shadowed side. Parts named earlier in this video: " + ", ".join(known)
                   + ". If one of them is visible use exactly that name; only add a new name for a part not listed. "
                     "Box only what is actually visible in this frame.")
    async with stage(emit, "spark", SPARK, f"scene, parts + boxes, nameplate, scale ({effort})"):
        out = await _json(SPARK, [{"type": "input_text", "text": prompt}, _img_part(frame)],
                          SCENE_SCHEMA, "scene", effort=effort)
    boxes = {}
    for b in out.get("sensor_boxes") or []:
        x1, y1, x2, y2 = (int(round(b[k])) for k in ("x1", "y1", "x2", "y2"))
        x1, x2 = sorted((max(0, min(w - 1, x1)), max(0, min(w, x2))))
        y1, y2 = sorted((max(0, min(h - 1, y1)), max(0, min(h, y2))))
        if x2 - x1 > 8 and y2 - y1 > 8:
            boxes[b["name"]] = [x1, y1, x2, y2]
    out["boxes"] = boxes
    return out


VERIFY_SCHEMA = {
    "type": "object",
    "properties": {"outlines": {"type": "array", "items": {"type": "object", "properties": {
        "number": {"type": "integer"}, "correct": {"type": "boolean"}, "actually_on": {"type": "string"}},
        "required": ["number", "correct", "actually_on"]}}},
    "required": ["outlines"],
}


async def verify_outlines(frame: np.ndarray, labels: list[str], emit: Emit | None = None) -> list[bool]:
    """Spark checks SAM's work: `frame` has numbered outlines drawn on it; is each one on the part it is named for?"""
    listing = "\n".join(f"{i + 1}: {name}" for i, name in enumerate(labels))
    prompt = ("Numbered outlines are drawn on this frame of a machine, each meant to surround the named part:\n" + listing
              + "\nFor each number say whether the outline is mostly on that part. It is NOT correct if it mostly covers "
                "background, floor, sky, bright glare, or a different part of the machine. Clipped by the frame edge or partly "
                "hidden is fine. Be strict about wrong objects.")
    async with stage(emit, "spark", SPARK, "check the tracked outlines"):
        out = await _json(SPARK, [{"type": "input_text", "text": prompt}, _img_part(frame)], VERIFY_SCHEMA, "verify", effort="low")
    bad = {o["number"] for o in out.get("outlines") or [] if not o["correct"]}
    return [i + 1 not in bad for i in range(len(labels))]


LOCATE_SCHEMA = {
    "type": "object",
    "properties": {"parts": {"type": "array", "items": {"type": "object", "properties": {
        "name": {"type": "string"}, "visible": {"type": "boolean"},
        "x1": {"type": "number"}, "y1": {"type": "number"}, "x2": {"type": "number"}, "y2": {"type": "number"}},
        "required": ["name", "visible", "x1", "y1", "x2", "y2"]}}},
    "required": ["parts"],
}


async def locate_parts(frame: np.ndarray, names: list[str], emit: Emit | None = None,
                       effort: str = "low") -> dict[str, list[int]]:
    """Muse Spark localises named machine parts as pixel boxes; SAM 3.1 then refines each box to a mask."""
    h, w = frame.shape[:2]
    prompt = (f"The image is {w}x{h} pixels (x right, y down, origin top-left). For each part, give a tight "
              f"bounding box around only that rigid part, in pixels. Parts: {', '.join(names)}. "
              "Set visible=false if a part is not in the image.")
    async with stage(emit, "spark", SPARK, f"localise {len(names)} parts"):
        out = await _json(SPARK, [{"type": "input_text", "text": prompt}, _img_part(frame)], LOCATE_SCHEMA, "parts",
                          effort=effort)
    boxes = {}
    for p in out["parts"]:
        x1, y1, x2, y2 = (int(round(v)) for v in (p["x1"], p["y1"], p["x2"], p["y2"]))
        x1, x2 = sorted((max(0, min(w - 1, x1)), max(0, min(w, x2))))
        y1, y2 = sorted((max(0, min(h - 1, y1)), max(0, min(h, y2))))
        if p["visible"] and x2 - x1 > 8 and y2 - y1 > 8:
            boxes[p["name"]] = [x1, y1, x2, y2]
    return boxes


CURVE_SCHEMA = {
    "type": "object",
    "properties": {
        "rated_rpm": {"type": "number"},
        "q": {"type": "array", "items": {"type": "number"}, "description": "flow points, m3/h"},
        "h": {"type": "array", "items": {"type": "number"}, "description": "head at each flow, m"},
        "eta": {"type": "array", "items": {"type": "number"}, "description": "efficiency 0-1 at each flow"},
        "npshr": {"type": "array", "items": {"type": "number"}, "description": "NPSH required, m"},
        "bep_q": {"type": "number"}, "bep_h": {"type": "number"},
    },
    "required": ["rated_rpm", "q", "h", "eta", "npshr", "bep_q", "bep_h"],
}


async def read_pump_curve(file_bytes: bytes, mime: str, emit: Emit | None = None) -> dict:
    """Digitise a pump performance curve from a datasheet image or PDF."""
    b64 = base64.b64encode(file_bytes).decode()
    part = ({"type": "input_file", "filename": "datasheet.pdf", "file_data": f"data:{mime};base64,{b64}"}
            if mime == "application/pdf" else {"type": "input_image", "image_url": f"data:{mime};base64,{b64}"})
    prompt = ("Digitise the pump performance curve at rated speed: 8-12 points of flow (m3/h) with head (m), "
              "efficiency (0-1) and NPSHr (m) at the same flows; give the BEP. Use 0 where a value is absent.")
    async with stage(emit, "spark", SPARK, "digitise pump curve"):
        return await _json(SPARK, [{"type": "input_text", "text": prompt}, part], CURVE_SCHEMA, "pump_curve")


AUDIO_SCHEMA = {
    "type": "object",
    "properties": {
        "sounds": {"type": "array", "items": {"type": "string"}},
        "cavitation_like": {"type": "boolean"},
        "rubbing_or_impacts": {"type": "boolean"},
        "speed_changing": {"type": "string", "enum": ["steady", "speeding_up", "slowing_down", "unknown"]},
        "speech": {"type": "string"},
    },
    "required": ["sounds", "cavitation_like", "rubbing_or_impacts", "speed_changing", "speech"],
}


async def listen(file_id: str, emit: Emit | None = None) -> dict:
    """Muse Spark watches AND listens to the clip in one call: an independent qualitative check
    of what our DSP measured (cavitation crackle, rubbing, run-up/coast-down)."""
    prompt = ("Listen to this machinery clip as a reliability engineer. List distinct machine sounds; "
              "is there gravel-like crackle typical of pump cavitation; rubbing or impacts; is the speed steady, "
              "rising or falling; transcribe any human speech.")
    async with stage(emit, "spark", SPARK_AUDIO, "audio-visual check"):
        return await _json(SPARK_AUDIO, [{"type": "input_text", "text": prompt},
                                         {"type": "input_video", "file_id": file_id}], AUDIO_SCHEMA, "audio_check")


async def upload(path: str, emit: Emit | None = None) -> str:
    async with stage(emit, "spark", "files", "upload clip"):
        with open(path, "rb") as f:
            return (await meta().files.create(file=f, purpose="user_data")).id

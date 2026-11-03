"""SAM 3.1 as the virtual-sensor placer: noun phrase -> pixel-accurate mask -> tracked region."""

import asyncio
import base64

import cv2
import numpy as np
from meta_sam_parser import (
    CompletedOutcome,
    FramePrompt,
    PromptBox,
    PromptObject,
    build_object_prompt,
    SegmentationMaskRecord,
    decode_mask_to_raster,
    image_segmentation_format,
    video_segmentation_format,
)

from ..dsp.motion import Region
from .client import SAM, Emit, meta, stage

PALETTE = ["#38BDF8", "#A78BFA", "#F472B6", "#34D399", "#FBBF24", "#60A5FA", "#F87171", "#2DD4BF"]


def _jpeg_data_url(gray_or_bgr: np.ndarray) -> str:
    ok, buf = cv2.imencode(".jpg", gray_or_bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()


async def _stream_text(content: list[dict], metadata: dict | None = None) -> str:
    text, done = [], None
    async with meta().responses.stream(
        model=SAM,
        input=[{"type": "message", "role": "user", "content": content}],
        metadata=metadata or {},
    ) as stream:
        async for event in stream:
            if event.type == "response.output_text.delta":
                text.append(event.delta)
            elif event.type == "response.output_text.done":
                done = event.text  # video results can arrive only here, without deltas
    return done if done and len(done) >= len("".join(text)) else "".join(text)


def _records(raw: str, media: str):
    fmt = image_segmentation_format() if media == "image" else video_segmentation_format()
    parser = fmt.create_parser()
    parser.push(raw, emit=False)
    return parser.finish(CompletedOutcome()).result.records


def _mask_to_full(rec: SegmentationMaskRecord, shape) -> np.ndarray:
    h, w = shape
    if rec.mask.encoding == "one_bit":  # skip the canonical re-encode check (~40% of decode time)
        from meta_sam_parser._mask_codec import _decode_raster
        raster = _decode_raster(rec.mask.payload, rec.mask.width, rec.mask.height)
    else:
        raster = decode_mask_to_raster(rec.mask)
    local = np.frombuffer(raster, np.uint8).reshape(rec.mask.height, rec.mask.width)
    full = np.zeros((h, w), bool)
    x0, y0 = int(round(rec.bounds.left)), int(round(rec.bounds.top))
    x1, y1 = min(w, x0 + local.shape[1]), min(h, y0 + local.shape[0])
    full[y0:y1, x0:x1] = local[: y1 - y0, : x1 - x0].astype(bool)
    return full


def _polygon(mask: np.ndarray, max_pts: int = 48) -> list[list[int]]:
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return []
    c = max(cnts, key=cv2.contourArea)
    eps = 0.002 * cv2.arcLength(c, True)
    while True:
        poly = cv2.approxPolyDP(c, eps, True)
        if len(poly) <= max_pts:
            return poly.reshape(-1, 2).astype(int).tolist()
        eps *= 1.5


async def segment_frame(frame: np.ndarray, prompt: str, emit: Emit | None = None) -> list[dict]:
    """All instances of `prompt` in one frame: [{mask, bbox, confidence}] (best first)."""
    async with stage(emit, "sam", SAM, f"segment '{prompt}'"):
        raw = await _stream_text(
            [{"type": "input_text", "text": prompt}, {"type": "input_image", "image_url": _jpeg_data_url(frame)}],
            {"include_confidence": "true", "mask_encoding": "one_bit"},
        )
    out = await asyncio.to_thread(_parse_instances, raw, frame.shape[:2])
    return sorted(out, key=lambda d: -(d["confidence"] or 0) or -d["mask"].sum())


def _parse_instances(raw: str, shape) -> list[dict]:
    """CPU-heavy (pure-Python mask codec): always called in a worker thread."""
    out = []
    for rec in _records(raw, "image"):
        if isinstance(rec, SegmentationMaskRecord):
            m = _mask_to_full(rec, shape)
            ys, xs = np.nonzero(m)
            if len(xs) < 50:
                continue
            out.append({"mask": m, "bbox": (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())),
                        "confidence": rec.confidence, "object_id": rec.object_id})
    return out


async def segment_boxes(frame: np.ndarray, boxes: dict[str, list[int]], emit: Emit | None = None) -> dict[str, dict]:
    """Box-prompted SAM 3.1: one request, up to 16 objects, each box refined to a pixel-accurate mask."""
    h, w = frame.shape[:2]
    names = list(boxes)[:16]
    objs = [PromptObject(id=i + 1, prompts=[FramePrompt(frame=0, box=PromptBox(*boxes[n]))]) for i, n in enumerate(names)]
    async with stage(emit, "sam", SAM, f"refine {len(names)} boxes to masks"):
        raw = await _stream_text([{"type": "input_text", "text": build_object_prompt(size=(w, h), objects=objs)},
                                  {"type": "input_image", "image_url": _jpeg_data_url(frame)}],
                                 {"include_confidence": "true", "mask_encoding": "one_bit"})
    out = {}
    for inst in await asyncio.to_thread(_parse_instances, raw, frame.shape[:2]):
        try:
            name = names[int(inst["object_id"]) - 1]
        except (ValueError, IndexError):
            continue
        out.setdefault(name, inst)
    return out


async def place_sensors(frame: np.ndarray, prompts: list[str], reference_prompt: str | None = "wall",
                        emit: Emit | None = None, effort: str = "low",
                        boxes: dict[str, list[int]] | None = None) -> list[Region]:
    """One virtual sensor per named part, plus a static reference region for shake cancellation.

    1) SAM 3.1 concept prompts (noun phrase) in parallel.
    2) Parts SAM cannot name are localised by Muse Spark as boxes, then SAM 3.1 refines each box
       to a mask (two Meta models cooperating: language grounding + pixel-accurate segmentation).
    """
    names = list(dict.fromkeys(list(prompts) + ([reference_prompt] if reference_prompt else [])))
    if boxes:  # boxes already localised by Muse Spark: run both SAM paths concurrently
        concept, refined = await asyncio.gather(
            asyncio.gather(*(segment_frame(frame, p, emit) for p in names), return_exceptions=True),
            segment_boxes(frame, {k: v for k, v in boxes.items() if k in names}, emit), return_exceptions=True)
        hits = {} if isinstance(refined, Exception) else dict(refined)
        if not isinstance(concept, Exception):
            hits.update({n: r[0] for n, r in zip(names, concept) if not isinstance(r, Exception) and r})
        missing = []
    else:
        found = await asyncio.gather(*(segment_frame(frame, p, emit) for p in names), return_exceptions=True)
        hits = {n: r[0] for n, r in zip(names, found) if not isinstance(r, Exception) and r}
        missing = [n for n in names if n not in hits]
    if missing:
        from . import spark
        try:
            boxes = await spark.locate_parts(frame, missing, emit, effort=effort)
            if boxes:
                hits.update(await segment_boxes(frame, boxes, emit))
        except Exception as e:
            if emit:
                await emit({"type": "pipeline", "stage": "sam", "state": "error", "model": SAM,
                            "detail": f"box refinement failed: {str(e)[:120]}"})
    regions = []
    for i, name in enumerate(names):
        if name not in hits:
            continue
        best = hits[name]
        regions.append(Region(id=f"s{i + 1}", label=name, bbox=best["bbox"], mask=best["mask"],
                              is_reference=(name == reference_prompt), confidence=best["confidence"],
                              meta={"color": "#94A3B8" if name == reference_prompt else PALETTE[i % len(PALETTE)]}))
    return regions


def sensors_event(regions: list[Region], width: int, height: int, t: float = 0.0) -> dict:
    return {"type": "sensors", "t": t, "width": width, "height": height, "items": [
        {"id": r.id, "label": r.label, "color": r.meta.get("color", "#38BDF8"),
         "polygon": _polygon(r.mask) if r.mask is not None else
         [[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[1]], [r.bbox[2], r.bbox[3]], [r.bbox[0], r.bbox[3]]],
         "bbox": list(r.bbox), "confidence": r.confidence, "is_reference": r.is_reference}
        for r in regions]}


async def track_in_video(file_id: str, prompt: str, emit: Emit | None = None) -> dict[int, list[int]]:
    """SAM 3.1 video tracking of one concept: {frame_index: bbox} for the first object.

    Used to re-anchor virtual sensors when the camera is hand-held and drifts.
    """
    async with stage(emit, "sam", SAM, f"track '{prompt}' in video"):
        raw = await _stream_text(
            [{"type": "input_text", "text": prompt}, {"type": "input_video", "file_id": file_id}],
            {"mask_encoding": "one_bit", "include_confidence": "true"},
        )
    boxes: dict[int, list[int]] = {}
    for rec in _records(raw, "video"):
        if getattr(rec, "kind", "") == "box" and rec.frame is not None and rec.object_id in ("0", "1"):
            boxes.setdefault(rec.frame.frame_index, [int(rec.left), int(rec.top), int(rec.right), int(rec.bottom)])
    return boxes

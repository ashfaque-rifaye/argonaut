"""Entities that follow the machine: Muse Spark names what is in each shot, SAM 3.1 tracks it through the video.

A fixed mask from the first frame is wrong the moment the camera moves. Instead:

1. Split the clip into shots (the camera has moved far from the shot's key frame, or the picture changed).
2. At each shot's sharpest early frame Muse Spark names the measurable parts, reusing names for parts it has
   already seen, so a part keeps one identity across shots and new parts appear when they come into view.
3. SAM 3.1 video segmentation tracks those parts through the shot: a real mask per frame, and no mask when
   the part has left the picture.

`measure_tracked` then measures vibration inside the moving masks: frame-to-frame Lucas-Kanade inside each
mask, minus the camera motion fitted on the background, integrated and high-passed.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from meta_sam_parser import FramePrompt, PromptBox, PromptObject, SegmentationMaskRecord, build_object_prompt

from .dsp.motion import Region
from .models import sam, spark
from .models.client import SAM, Emit, meta, stage

TRACK_FPS = float(os.environ.get("TRACK_FPS", "10"))
PROXY_W = int(os.environ.get("TRACK_PROXY_W", "512"))  # mask decoding cost grows with area
MAX_SECONDS = 90.0
MAX_SHOTS = 5
MIN_SHOT_S = 3.0
ACCUM_MOVE = 0.15   # new shot when the camera has moved this fraction of the width from the key frame
MOVING = 0.03       # below this travel the camera counts as fixed: fixed masks and the reference-frame tracker apply
VERTICES = 32
RELOOK_S = 7.0
MIN_AREA = 0.012     # of the frame
MAX_CAM_PX = 12.0    # camera motion per frame, at 960 px wide
MAX_RESID_PX = 2.0


def _proxy(path: str, out: Path) -> tuple[np.ndarray, list[np.ndarray]]:
    """Constant-rate low-res copy for SAM; returns gray frames and BGR frames of that copy."""
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-t", str(MAX_SECONDS), "-vf",
                    f"scale={PROXY_W}:-2,fps={TRACK_FPS}", "-an", "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p", str(out)],
                   check=True)
    cap = cv2.VideoCapture(str(out))
    bgr = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        bgr.append(f)
    cap.release()
    gray = np.stack([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in bgr]) if bgr else np.zeros((0, 1, 1), np.uint8)
    return gray, bgr


def find_shots(gray: np.ndarray) -> tuple[list[tuple[int, int]], float]:
    """[(start, end)] frame ranges, and the camera's largest travel as a fraction of the frame width.

    A new shot starts on a cut or once the view has moved far from the shot's start.
    """
    n = len(gray)
    if n < 2:
        return [(0, n)], 0.0
    w = gray.shape[2]
    min_len = int(MIN_SHOT_S * TRACK_FPS)
    cuts, start = [], 0
    acc = np.zeros(2)
    travel = 0.0
    for i in range(1, n):
        prev, cur = gray[i - 1], gray[i]
        pts = cv2.goodFeaturesToTrack(prev, 200, 0.01, 8)
        moved = None
        if pts is not None and len(pts) >= 8:
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, pts, None, winSize=(21, 21), maxLevel=3)
            good = st.ravel() == 1
            if good.sum() >= 8:
                moved = np.median((nxt - pts)[good].reshape(-1, 2), axis=0)
        cut = moved is None or abs(float(np.mean(cur)) - float(np.mean(prev))) > 25
        if moved is not None:
            acc += moved
        travel = max(travel, float(np.hypot(*acc)) / w)
        if cut:
            travel = max(travel, ACCUM_MOVE)
        # fast whips blur past the flow estimate, so a camera in motion also gets a fresh look every few seconds
        stale = i - start >= RELOOK_S * TRACK_FPS and np.hypot(*acc) > MOVING * w
        if i - start >= min_len and (cut or stale or np.hypot(*acc) > ACCUM_MOVE * w) and len(cuts) < MAX_SHOTS - 1:
            cuts.append(i)
            start, acc = i, np.zeros(2)
    if cuts and n - cuts[-1] < min_len:  # too short a tail to be worth a look of its own
        cuts.pop()
    edges = [0, *cuts, n]
    return [(edges[k], edges[k + 1]) for k in range(len(edges) - 1)], travel


def camera_travel(path: str) -> float:
    """How far the camera moves in a clip (fraction of the frame width). Cheap: no model calls."""
    with tempfile.TemporaryDirectory() as d:
        gray, _ = _proxy(path, Path(d) / "proxy.mp4")
    return find_shots(gray)[1] if len(gray) else 0.0


def _sharpest(gray: np.ndarray, a: int, b: int) -> int:
    """Index of the sharpest frame in [a, b): SAM and Spark get a clean look, not a motion-blurred one."""
    best, bi = -1.0, a
    for i in range(a, b):
        v = float(cv2.Laplacian(gray[i], cv2.CV_32F).var())
        if v > best:
            best, bi = v, i
    return bi


def _resample(poly: list[list[int]], n: int = VERTICES) -> np.ndarray:
    """Fixed vertex count, equal arc length, clockwise, starting above the centroid: so vertices correspond
    from frame to frame, and the outline can be smoothed in time and interpolated by the viewer."""
    p = np.asarray(poly, float)
    if 0.5 * np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]) < 0:
        p = p[::-1]
    closed = np.vstack([p, p[:1]])
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(closed, axis=0).T))]
    # start where the outline crosses the vertical through its centroid, above it: stable from frame to frame,
    # where "the topmost vertex" can jump between corners of a nearly flat edge
    dense = np.column_stack([np.interp(np.linspace(0, d[-1], 720, endpoint=False), d, closed[:, k]) for k in (0, 1)])
    c = dense.mean(axis=0)
    above = np.flatnonzero(dense[:, 1] < c[1])
    start = above[int(np.argmin(np.abs(dense[above, 0] - c[0])))] if len(above) else 0
    idx = (start + np.round(np.arange(n) * 720 / n).astype(int)) % 720
    return dense[idx]


def _smooth_track(frames: dict[int, list], n: int, breaks: list[int]) -> list[np.ndarray | None]:
    """Per-frame outlines over the whole clip: 1-2 frame dropouts held, jitter averaged, never across a shot cut."""
    out: list[np.ndarray | None] = [None] * n
    for f, p in frames.items():
        if 0 <= f < n and len(p) >= 3:
            out[f] = _resample(p)
    for i in range(1, n - 2):  # brief dropouts are SAM flicker, not the part leaving the picture
        if out[i] is None and out[i - 1] is not None and (out[i + 1] is not None or out[i + 2] is not None):
            out[i] = out[i - 1]
    res = list(out)
    cuts = set(breaks)
    for i in range(n):
        if out[i] is None:
            continue
        win = [out[i]]
        if i > 0 and out[i - 1] is not None and i not in cuts:
            win.append(out[i - 1])
        if i + 1 < n and out[i + 1] is not None and i + 1 not in cuts:
            win.append(out[i + 1])
        res[i] = np.mean(win, axis=0)
    return res


def _outline(job: tuple) -> list[list[int]]:
    """Mask payload to outline. A pure-Python range decoder runs per pixel, so these go to worker processes."""
    from meta_sam_parser._mask_codec import _decode_raster
    payload, mw, mh, x0, y0, w, h = job
    local = np.frombuffer(_decode_raster(payload, mw, mh), np.uint8).reshape(mh, mw)
    if local.sum() < 40 or local.sum() > 0.6 * w * h:  # a speck, or the mask has run away over the whole picture
        return []
    full = np.zeros((h, w), bool)
    x1, y1 = min(w, x0 + mw), min(h, y0 + mh)
    full[y0:y1, x0:x1] = local[: y1 - y0, : x1 - x0].astype(bool)
    return sam._polygon(full, 32)


async def _track_shot(proxy: Path, tmp: Path, bgr: list[np.ndarray], gray: np.ndarray, a: int, b: int, known: list[str],
                      emit: Emit | None) -> tuple[dict, dict[str, dict[int, list]]]:
    key = _sharpest(gray, a, min(b, a + max(2, int(0.6 * TRACK_FPS))))
    scene = await spark.understand_scene(bgr[key], emit, effort="medium", known=known)
    boxes = scene.get("boxes") or {}
    names = list(boxes)[:6]
    if not names:
        return scene, {}
    sub = tmp / f"shot_{a}.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{key / TRACK_FPS:.3f}", "-i", str(proxy), "-t", f"{(b - key) / TRACK_FPS:.3f}",
                    "-an", "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p", str(sub)], check=True)
    h, w = bgr[0].shape[:2]
    objs = [PromptObject(id=i + 1, prompts=[FramePrompt(frame=0, box=PromptBox(*boxes[n]))]) for i, n in enumerate(names)]
    with open(sub, "rb") as f:
        fid = (await meta().files.create(file=f, purpose="user_data")).id
    async with stage(emit, "sam", SAM, f"track {len(names)} parts through {(b - key) / TRACK_FPS:.0f} s of video"):
        raw = await sam._stream_text([{"type": "input_text", "text": build_object_prompt(size=(w, h), objects=objs)},
                                      {"type": "input_video", "file_id": fid}],
                                     {"mask_encoding": "one_bit", "include_confidence": "true"})

    recs = await asyncio.to_thread(lambda: [r for r in sam._records(raw, "video") if isinstance(r, SegmentationMaskRecord)])
    jobs, meta_ = [], []
    conf_: dict[str, list[float]] = {}
    for rec in recs:
        try:
            name = names[int(rec.object_id) - 1]
        except (ValueError, IndexError):
            continue
        jobs.append((rec.mask.payload, rec.mask.width, rec.mask.height, int(round(rec.bounds.left)), int(round(rec.bounds.top)), w, h))
        meta_.append((name, key + rec.frame.frame_index))
        if rec.confidence is not None:
            conf_.setdefault(name, []).append(rec.confidence)
    with ProcessPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as pool:
        loop = asyncio.get_running_loop()
        outlines = await asyncio.gather(*[loop.run_in_executor(pool, _outline, j) for j in jobs])
    tracks: dict[str, dict[int, list]] = {}
    for (name, f), poly in zip(meta_, outlines):
        if poly:
            tracks.setdefault(name, {})[f] = poly
    # a sliver is rarely the part it was named for, and too small to measure anyway
    for name, fr in list(tracks.items()):
        if np.median([cv2.contourArea(np.array(q, np.int32)) for q in fr.values()]) < MIN_AREA * w * h:
            del tracks[name]
    conf = {k: float(np.mean(v)) for k, v in conf_.items()}
    # Spark checks SAM's work on a frame from the middle of the shot: an outline on the wrong thing is worse than none
    mid = (key + b) // 2
    shown = [n for n in tracks if tracks[n].get(mid)]
    if shown:
        board = bgr[mid].copy()
        for i, n in enumerate(shown):
            q = np.array(tracks[n][mid], np.int32)
            cv2.polylines(board, [q], True, (0, 255, 255), 2)
            cx, cy = q.mean(axis=0).astype(int)
            cv2.putText(board, str(i + 1), (int(cx), int(cy)), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 5)
            cv2.putText(board, str(i + 1), (int(cx), int(cy)), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 255), 2)
        try:
            for n, ok in zip(shown, await spark.verify_outlines(board, shown, emit)):
                if not ok:
                    del tracks[n]
        except Exception:
            pass  # keep the outlines if the check itself fails
    scene["_conf"] = conf
    # frames between the shot start and its key frame take the key frame's mask
    for name, fr in tracks.items():
        if key in fr:
            for i in range(a, key):
                fr.setdefault(i, fr[key])
    return scene, tracks


async def build_tracks(path: str, out_w: int, out_h: int, known: list[str] | None = None, emit: Emit | None = None) -> dict | None:
    """Track a clip's parts through the camera's movement. {fps, width, height, n, shots, travel, items} or None."""
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        proxy = tmp / "proxy.mp4"
        gray, bgr = await asyncio.to_thread(_proxy, path, proxy)
        if len(bgr) < int(TRACK_FPS):
            return None
        shots, travel = await asyncio.to_thread(find_shots, gray)
        # the first shot sets the names; later shots reuse them and add what has come into view
        scene, first = await _track_shot(proxy, tmp, bgr, gray, *shots[0], list(known or []), emit)
        scenes, parts = [scene], [first]
        if len(shots) > 1:
            names = list(dict.fromkeys([*(known or []), *first]))
            more = await asyncio.gather(*[_track_shot(proxy, tmp, bgr, gray, a, b, names, emit) for a, b in shots[1:]],
                                        return_exceptions=True)
            for r in more:
                if not isinstance(r, BaseException):
                    scenes.append(r[0])
                    parts.append(r[1])
    h, w = bgr[0].shape[:2]
    n = len(gray)
    sx, sy = out_w / w, out_h / h
    entities: dict[str, dict] = {}
    for sc, tr in zip(scenes, parts):
        conf = sc.get("_conf", {})
        what = {str(b.get("name", "")).strip().lower(): b.get("what") or "" for b in sc.get("sensor_boxes") or []}
        for name, frames in tr.items():
            k = name.strip().lower()
            e = entities.setdefault(k, {"label": name.strip(), "what": what.get(k, ""), "frames": {}, "conf": []})
            e["frames"].update(frames)
            if name in conf:
                e["conf"].append(conf[name])
    if not entities:
        return None
    breaks = [a for a, _ in shots[1:]]
    items = []
    for i, e in enumerate(sorted(entities.values(), key=lambda e: min(e["frames"]))):
        sm = await asyncio.to_thread(_smooth_track, e["frames"], n, breaks)
        polys = [None if p is None else [[round(float(x) * sx), round(float(y) * sy)] for x, y in p] for p in sm]
        items.append({"id": f"s{i + 1}", "label": e["label"], "what": e["what"], "color": sam.PALETTE[i % len(sam.PALETTE)],
                      "confidence": float(np.mean(e["conf"])) if e["conf"] else 0.9, "polys": polys})
    return {"fps": TRACK_FPS, "width": out_w, "height": out_h, "n": n, "shots": [a / TRACK_FPS for a, _ in shots],
            "travel": travel, "items": items}


def tracks_event(tr: dict) -> dict:
    return {"type": "tracks", "fps": tr["fps"], "width": tr["width"], "height": tr["height"], "n": tr["n"], "shots": tr["shots"],
            "items": [{k: it[k] for k in ("id", "label", "what", "color", "confidence", "polys")} for it in tr["items"]]}


def regions_from_tracks(tr: dict, shape: tuple[int, int]) -> list[Region]:
    """One sensor per tracked entity, its mask taken from the frame where it first appears."""
    h, w = shape
    out = []
    for it in tr["items"]:
        p = next(x for x in it["polys"] if x)
        m = np.zeros((h, w), np.uint8)
        cv2.fillPoly(m, [np.array(p, np.int32)], 1)
        ys, xs = np.nonzero(m)
        out.append(Region(it["id"], it["label"], (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())), mask=m.astype(bool),
                          confidence=it["confidence"], meta={"color": it["color"]}))
    return out


def measure_tracked(frames: np.ndarray, fps: float, tr: dict) -> dict[str, dict]:
    """Vibration inside moving masks with the camera's own motion removed. Same shape as measure_regions."""
    N, H, W = frames.shape
    items = tr["items"]
    rel = np.full((N, len(items), 2), np.nan)
    tf = tr["fps"]
    for i in range(N - 1):
        idx = min(tr["n"] - 1, int(round(i / fps * tf)))
        labels = np.zeros((H, W), np.int16)
        for k, it in enumerate(items):
            p = it["polys"][idx]
            if p:
                cv2.fillPoly(labels, [np.array(p, np.int32)], k + 1)
        pts = cv2.goodFeaturesToTrack(frames[i], 1200, 0.01, 6)
        if pts is None or len(pts) < 12:
            continue
        nxt, st, _ = cv2.calcOpticalFlowPyrLK(frames[i], frames[i + 1], pts, None, winSize=(21, 21), maxLevel=3,
                                              criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
        good = st.ravel() == 1
        a, b = pts[good].reshape(-1, 2), nxt[good].reshape(-1, 2)
        if len(a) < 12:
            continue
        lab = labels[np.clip(a[:, 1].astype(int), 0, H - 1), np.clip(a[:, 0].astype(int), 0, W - 1)]
        bg = lab == 0
        src, dst = (a[bg], b[bg]) if bg.sum() >= 12 else (a, b)
        M, _ = cv2.estimateAffinePartial2D(src.reshape(-1, 1, 2), dst.reshape(-1, 1, 2), method=cv2.RANSAC, ransacReprojThreshold=1.0)
        if M is None:
            continue
        # during a whip the flow is unreliable and motion blur hides any vibration: no measurement for this frame
        if float(np.hypot(*M[:, 2])) > MAX_CAM_PX * W / 960:
            continue
        pred = a @ M[:, :2].T + M[:, 2]
        resid = b - pred
        for k in range(len(items)):
            inside = lab == k + 1
            if inside.sum() >= 5:
                r = np.median(resid[inside], axis=0)
                if np.hypot(*r) < MAX_RESID_PX:  # more than this between frames is tracking error, not vibration
                    rel[i, k] = r
    win = max(3, int(round(fps * 0.5)))
    out = {}
    for k, it in enumerate(items):
        r = np.nan_to_num(rel[:, k], nan=0.0)
        d = np.cumsum(r, axis=0)
        # high-pass: remove the slow drift of integrating frame-to-frame motion
        ker = np.ones(win) / win
        hp = np.stack([d[:, c] - np.convolve(np.pad(d[:, c], win, mode="edge"), ker, "same")[win:-win] for c in (0, 1)], axis=1)
        hp -= hp.mean(axis=0)
        w, v = np.linalg.eigh(np.cov(hp.T)) if len(hp) > 2 else (np.ones(2), np.eye(2))
        axis = v[:, int(np.argmax(w))]
        axis = axis if axis[int(np.argmax(np.abs(axis)))] > 0 else -axis
        present = float(np.mean(~np.isnan(rel[:, k, 0])))
        out[it["id"]] = {"disp_px": hp, "axis_disp_px": hp @ axis, "axis": axis,
                         "quality": {"tracker": "lucas_kanade (moving mask)", "rigid": True, "present": present}}
    return out

"""Sub-pixel motion of named regions ("virtual sensors") from video.

Each region is tracked against a fixed reference frame, so vibration does not
accumulate drift. Primary estimator: pyramidal Lucas-Kanade on features inside
the region mask, reduced with a median plus MAD outlier rejection. Fallback: windowed
phase correlation on the region's interior rectangle.
"""

from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Region:
    id: str
    label: str
    bbox: tuple[int, int, int, int]  # x1, y1, x2, y2 in frame pixels (inclusive)
    mask: np.ndarray | None = None  # bool HxW for the full frame, optional
    is_reference: bool = False
    confidence: float | None = None
    meta: dict = field(default_factory=dict)


def read_video(path: str, max_frames: int | None = None, max_width: int = 960):
    """Return (gray frames uint8 [N,H,W], fps, scale) where scale = output px / source px."""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise FileNotFoundError(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames, scale = [], 1.0
    while True:
        ok, frame = cap.read()
        if not ok or (max_frames and len(frames) >= max_frames):
            break
        h, w = frame.shape[:2]
        if w > max_width:
            scale = max_width / w
            frame = cv2.resize(frame, (max_width, round(h * scale)), interpolation=cv2.INTER_AREA)
        frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
    cap.release()
    if not frames:
        raise ValueError(f"no frames decoded from {path}")
    return np.stack(frames), float(fps), scale


def _interior(bbox, shape, shrink=0.12):
    x1, y1, x2, y2 = bbox
    dx, dy = (x2 - x1) * shrink, (y2 - y1) * shrink
    h, w = shape
    return (max(0, int(x1 + dx)), max(0, int(y1 + dy)), min(w - 1, int(x2 - dx)), min(h - 1, int(y2 - dy)))


def _region_mask(region: Region, shape) -> np.ndarray:
    if region.mask is not None:
        m = region.mask.astype(np.uint8)
        # Erode so features sit on the object, not on its silhouette edge against the background.
        k = max(3, int(0.04 * min(region.bbox[2] - region.bbox[0], region.bbox[3] - region.bbox[1])) | 1)
        return cv2.erode(m, np.ones((k, k), np.uint8)) * 255
    m = np.zeros(shape, np.uint8)
    x1, y1, x2, y2 = _interior(region.bbox, shape)
    m[y1:y2 + 1, x1:x2 + 1] = 255
    return m


def _phase_corr_track(frames: np.ndarray, region: Region) -> np.ndarray:
    x1, y1, x2, y2 = _interior(region.bbox, frames.shape[1:])
    ref = frames[0, y1:y2 + 1, x1:x2 + 1].astype(np.float32)
    win = cv2.createHanningWindow(ref.shape[::-1], cv2.CV_32F)
    out = np.zeros((len(frames), 2))
    for i in range(1, len(frames)):
        cur = frames[i, y1:y2 + 1, x1:x2 + 1].astype(np.float32)
        (dx, dy), _ = cv2.phaseCorrelate(ref, cur, win)
        out[i] = (dx, dy)
    return out


def track_region(frames: np.ndarray, region: Region, max_features: int = 150) -> tuple[np.ndarray, dict]:
    """Displacement (N,2) in pixels of `region` relative to frame 0, plus quality info."""
    mask = _region_mask(region, frames.shape[1:])
    pts = cv2.goodFeaturesToTrack(frames[0], maxCorners=max_features, qualityLevel=0.01,
                                  minDistance=4, mask=mask, blockSize=7)
    if pts is None or len(pts) < 8:  # thin or low-texture parts (poles, pipes): accept weaker corners
        pts = cv2.goodFeaturesToTrack(frames[0], maxCorners=max_features, qualityLevel=0.0005,
                                      minDistance=2, mask=mask, blockSize=5)
    if pts is None or len(pts) < 8:
        # phaseCorrelate's centroid sub-pixel step under-reads motions well below 1 px; last resort only
        return _phase_corr_track(frames, region), {"method": "phase_correlation", "features": 0}

    pts = cv2.cornerSubPix(frames[0], pts.astype(np.float32), (5, 5), (-1, -1),
                           (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_COUNT, 30, 0.001))
    lk = dict(winSize=(21, 21), maxLevel=2,
              criteria=(cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_COUNT, 30, 0.003))
    out = np.zeros((len(frames), 2))
    spread = []
    prev_pts = pts.copy()
    for i in range(1, len(frames)):
        # Seed from the previous estimate (handles larger motion); measure against frame 0 (no drift).
        nxt, st, _ = cv2.calcOpticalFlowPyrLK(frames[0], frames[i], pts, prev_pts.copy(),
                                              flags=cv2.OPTFLOW_USE_INITIAL_FLOW, **lk)
        good = st.ravel() == 1
        if good.sum() < 4:
            out[i] = out[i - 1]
            continue
        d = (nxt[good] - pts[good]).reshape(-1, 2)
        med = np.median(d, axis=0)
        mad = np.median(np.abs(d - med), axis=0) + 1e-6
        keep = np.all(np.abs(d - med) < 4 * 1.4826 * mad + 0.05, axis=1)
        out[i] = d[keep].mean(axis=0) if keep.any() else med
        spread.append(float(np.std(d[keep], axis=0).mean()) if keep.sum() > 1 else 0.0)
        prev_pts = nxt
    return out, {"method": "lucas_kanade", "features": int(len(pts)),
                 "feature_spread_px": float(np.median(spread)) if spread else 0.0}


def measure_regions(frames: np.ndarray, regions: list[Region]) -> dict[str, dict]:
    """Track every region; subtract the reference region (camera shake) from the others.

    Returns {id: {"disp_px": (N,2), "axis_disp_px": (N,), "axis": (2,), "quality": {...}}}.
    """
    raw = {r.id: track_region(frames, r) for r in regions}
    refs = [r.id for r in regions if r.is_reference]
    shake = np.mean([raw[i][0] for i in refs], axis=0) if refs else np.zeros((len(frames), 2))
    out = {}
    for r in regions:
        d, q = raw[r.id]
        d = d if r.is_reference else d - shake
        d = d - d.mean(axis=0)
        # Principal axis of motion -> single signed channel (best SNR for spectra / modal analysis).
        cov = np.cov(d.T) if len(d) > 2 else np.eye(2)
        w, v = np.linalg.eigh(cov)
        axis = v[:, np.argmax(w)]
        axis = axis if axis[np.argmax(np.abs(axis))] > 0 else -axis
        # Rigid-body check: features on one rigid part move together. A large spread between features
        # relative to the common motion means rotating parts (blades) or occlusion inside the mask.
        spread = q.get("feature_spread_px", 0.0)
        common = float(np.std(d @ axis))
        q["rigid"] = bool(r.is_reference or spread < max(0.25, 1.5 * common))
        out[r.id] = {"disp_px": d, "axis_disp_px": d @ axis, "axis": axis, "quality": q}
    return out

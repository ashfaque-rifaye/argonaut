"""Streaming real-time engine: browser camera + microphone -> telemetry at 10 Hz with a measured latency budget.

Per frame (O(1)): pyramidal Lucas-Kanade from the fixed reference frame, seeded with the previous
estimate, for every virtual sensor; camera shake removed with the static reference region. Samples go
into ring buffers with their arrival timestamps.

Per tick (10 Hz): resample the last window onto a uniform grid, segment-averaged spectra with
confidence intervals, overall velocity with a CI, ISO zone. The microphone ring buffer gives the shaft
speed (a 24 kHz acoustic tachometer). When shaft orders lie above the camera's Nyquist limit, peaks are
de-aliased against it, and velocity is computed at the TRUE frequencies.
"""

import asyncio
import base64
import time
from collections import deque

import cv2
import numpy as np

from .dsp import dealias as DA
from .dsp import identify, severity, spectral
from .dsp.motion import Region, _region_mask
from .models import client as mc

AUDIO_RATE = 24000


class _Track:
    """Incremental tracker for one region: reference features + previous estimate."""

    def __init__(self, ref: np.ndarray, region: Region):
        self.region = region
        mask = _region_mask(region, ref.shape)
        pts = cv2.goodFeaturesToTrack(ref, maxCorners=120, qualityLevel=0.01, minDistance=4, mask=mask, blockSize=7)
        if pts is None or len(pts) < 8:
            pts = cv2.goodFeaturesToTrack(ref, maxCorners=120, qualityLevel=0.0005, minDistance=2, mask=mask, blockSize=5)
        self.pts = pts.astype(np.float32) if pts is not None else None
        self.prev = self.pts.copy() if self.pts is not None else None
        self.spread = 0.0

    def step(self, ref: np.ndarray, cur: np.ndarray) -> tuple[float, float]:
        if self.pts is None or len(self.pts) < 4:
            return 0.0, 0.0
        nxt, st, _ = cv2.calcOpticalFlowPyrLK(ref, cur, self.pts, self.prev.copy(), winSize=(21, 21), maxLevel=2,
                                              flags=cv2.OPTFLOW_USE_INITIAL_FLOW,
                                              criteria=(cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_COUNT, 20, 0.01))
        good = st.ravel() == 1
        if good.sum() < 4:
            return 0.0, 0.0
        d = (nxt[good] - self.pts[good]).reshape(-1, 2)
        med = np.median(d, axis=0)
        mad = np.median(np.abs(d - med), axis=0) + 1e-6
        keep = np.all(np.abs(d - med) < 4 * 1.4826 * mad + 0.05, axis=1)
        self.prev = nxt
        self.spread = 0.9 * self.spread + 0.1 * float(np.std(d[keep], axis=0).mean()) if keep.sum() > 1 else self.spread
        m = d[keep].mean(axis=0) if keep.any() else med
        return float(m[0]), float(m[1])


class LiveEngine:
    def __init__(self, session, window_s: float = 6.0, max_width: int = 640):
        self.s, self.window_s, self.max_width = session, window_s, max_width
        self.ref: np.ndarray | None = None
        self.tracks: dict[str, _Track] = {}
        self.regions: list[Region] | None = None
        self.prompts: list[str] | None = None
        self.t: deque[float] = deque()
        self.arrival: deque[float] = deque()
        self.disp: dict[str, deque] = {}
        self.audio: deque[np.ndarray] = deque()
        self.audio_n = 0
        self.speed: tuple[float, float] | None = None  # (Hz, confidence) from the microphone
        self.lat: deque[float] = deque(maxlen=60)
        self.dropped = 0
        self._placing = False
        self._task: asyncio.Task | None = None
        self._tick = 0
        self.mm_per_px = 0.5

    # ---------------------------------------------------------------- inputs
    def set_prompts(self, prompts: list[str]):
        self.prompts, self.regions, self.ref, self.tracks = prompts, None, None, {}

    async def push_audio(self, pcm16: bytes):
        x = np.frombuffer(pcm16, np.int16).astype(np.float32) / 32768.0
        self.audio.append(x)
        self.audio_n += len(x)
        while self.audio_n > 4 * AUDIO_RATE and self.audio:
            self.audio_n -= len(self.audio.popleft())

    async def push_frame(self, t: float, jpeg_b64: str):
        arrived = time.perf_counter()
        b64 = jpeg_b64.split(",", 1)[1] if jpeg_b64.startswith("data:") else jpeg_b64
        img = cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            self.dropped += 1
            return
        if img.shape[1] > self.max_width:
            sc = self.max_width / img.shape[1]
            img = cv2.resize(img, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        if self.regions is None:
            if not self._placing:
                self._placing = True
                asyncio.create_task(self._place(img, gray))
            return
        if self.ref is None or gray.shape != self.ref.shape:
            self._anchor(gray)
        for rid, tr in self.tracks.items():
            self.disp[rid].append(tr.step(self.ref, gray))
        self.t.append(t)
        self.arrival.append(arrived)
        while self.t and self.t[-1] - self.t[0] > self.window_s:
            self.t.popleft()
            self.arrival.popleft()
            for q in self.disp.values():
                q.popleft()
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    def _anchor(self, gray: np.ndarray):
        self.ref = gray
        self.tracks = {r.id: _Track(gray, r) for r in self.regions}
        self.disp = {r.id: deque() for r in self.regions}
        self.t.clear()
        self.arrival.clear()

    async def _place(self, img: np.ndarray, gray: np.ndarray):
        h, w = img.shape[:2]
        try:
            regs = []
            if mc.available():
                from .models import sam, spark
                prompts, ref = self.prompts, "wall"
                if not prompts:
                    scene = await spark.understand_scene(img, self.s.emit)
                    prompts, ref = scene["sensor_prompts"][:4], scene.get("reference_prompt") or "wall"
                    self.s.nameplate = scene.get("nameplate") or {}
                    sr = scene.get("scale_reference") or {}
                    if sr.get("pixel_size") and sr.get("real_size_mm"):
                        self.mm_per_px = sr["real_size_mm"] / sr["pixel_size"]
                    await self.s.emit({"type": "coach", "level": scene["capture"]["level"], "text": scene["capture"]["advice"]})
                regs = await sam.place_sensors(img, prompts, ref, self.s.emit)
            if not regs:
                from .pipeline import _fallback_regions
                regs = _fallback_regions(w, h)
            if not any(r.is_reference for r in regs):
                from .pipeline import _fallback_regions
                regs.append(_fallback_regions(w, h)[-1])
            self.regions = regs
            self._anchor(gray)
            from .models.sam import sensors_event
            await self.s.emit(sensors_event(regs, w, h))
        finally:
            self._placing = False

    # ---------------------------------------------------------------- analysis
    def _acoustic_speed(self):
        if self.audio_n < AUDIO_RATE:
            return None
        x = np.concatenate(list(self.audio))[-2 * AUDIO_RATE:]
        from .dsp import audio as A
        f, a = A.spectrum(x, AUDIO_RATE, fmax=1500.0, seconds=1.0)
        hint = (self.s.nameplate.get("rpm") or 0) / 60 or None
        sp, contrast = identify.estimate_speed(f, a, f_range=(5.0, 400.0), hint_hz=hint)
        if not hint:
            sp, _k = identify.refine_fundamental(f, a, sp)  # vane/blade pass -> shaft speed
        return (sp, contrast) if contrast > 3.0 else None

    async def _loop(self):
        while True:
            t0 = time.perf_counter()
            try:
                await self._analyse()
            except Exception as e:
                await self.s.emit({"type": "error", "message": f"live analysis: {e}"})
            await asyncio.sleep(max(0.0, 0.1 - (time.perf_counter() - t0)))

    async def _analyse(self):
        if len(self.t) < 40 or not self.regions:
            return
        self._tick += 1
        ts = np.array(self.t)
        fps = (len(ts) - 1) / max(ts[-1] - ts[0], 1e-3)
        grid = np.arange(ts[0], ts[-1], 1 / fps)
        refs = [r.id for r in self.regions if r.is_reference]
        shake = np.mean([np.array(self.disp[i]) for i in refs], axis=0) if refs else 0
        chans = [r for r in self.regions if not r.is_reference]
        if self._tick % 5 == 1:
            self.speed = self._acoustic_speed()
        sp_hz = self.speed[0] if self.speed else None
        cls = severity.machine_class(self.s.nameplate.get("kw") or None)
        if sp_hz is not None and not self.s.nameplate.get("rpm") and 2 * sp_hz / 6 > fps / 2 * 0.9:
            # Which order is the acoustic tone? Let the camera's aliased peaks decide (cross-modal check).
            main = max(chans, key=lambda r: float(np.std(np.array(self.disp[r.id])[:, 0])) if self.disp[r.id] else 0)
            d = np.array(self.disp[main.id]) - shake
            xm = np.interp(grid, ts, (d - d.mean(axis=0))[:, 0] + (d - d.mean(axis=0))[:, 1])
            fm, am = spectral.amp_spectrum(xm, fps)
            sp_hz, _div, _n = DA.resolve_speed(spectral.find_peaks(fm, am, n=6, fmin=0.5), fps, sp_hz,
                                               bin_hz=fm[1] - fm[0])
        need_dealias = sp_hz is not None and 2 * sp_hz > fps / 2 * 0.9
        out, best = [], None
        for r in chans:
            d = np.array(self.disp[r.id]) - shake
            if not len(d):
                continue
            d -= d.mean(axis=0)
            w, v = np.linalg.eigh(np.cov(d.T) + 1e-12 * np.eye(2))
            x = np.interp(grid, ts, d @ v[:, np.argmax(w)]) * self.mm_per_px
            f, m, lo, hi = spectral.welch_amp_ci(x, fps, n_seg=6)
            peaks = spectral.find_peaks(f, m, n=6, fmin=0.5)
            if need_dealias:
                assigned = DA.dealias_peaks(peaks, fps, sp_hz, speed_sd_hz=0.05, bin_hz=f[1] - f[0])
                comps = [(a["f_true_hz"], a["amp_true"]) for a in assigned if a["order"]]
                vel = float(np.sqrt(sum((2 * np.pi * ft * amp) ** 2 / 2 for ft, amp in comps))) if comps else \
                    spectral.band_rms_velocity(x, fps, (0.5, fps / 2))
            else:
                assigned = None
                vel = spectral.band_rms_velocity(x, fps, (0.5, fps / 2))
            seg = spectral.segment_rms_velocity(x, fps, (0.5, fps / 2), n_seg=6)
            scale = vel / max(float(np.mean(seg)), 1e-9) if len(seg) else 1.0
            ci = [c * scale for c in spectral.mean_ci(seg)] if len(seg) > 1 else [vel, vel]
            out.append({"id": r.id, "disp_mm_rms": float(np.std(x)), "vel_mm_s_rms": vel, "vel_ci": ci,
                        "iso_zone": severity.zone(vel, cls), "rigid": tracks_rigid(self.tracks[r.id], x)})
            if best is None or vel > best[1]:
                best = (r.id, vel, f, m, lo, hi, peaks, assigned, ci)
        if not out:
            return
        latency_ms = (time.perf_counter() - self.arrival[-1]) * 1000
        self.lat.append(latency_ms)
        rid, overall, f, m, lo, hi, peaks, assigned, ci = best
        speed_hz = sp_hz if sp_hz else (max(peaks, key=lambda p: p["amp"])["f_hz"] if peaks else 0.0)
        await self.s.emit({"type": "telemetry", "speed_hz": speed_hz, "speed_rpm": speed_hz * 60,
                           "speed_source": "audio (tonal order)" if sp_hz else "video",
                           "channels": out, "overall_vel_mm_s_rms": overall, "overall_vel_ci": ci,
                           "iso_zone": severity.zone(overall, cls),
                           "latency": {"frame_to_telemetry_ms": latency_ms, "p95_ms": float(np.percentile(self.lat, 95)),
                                       "fps_in": fps, "frames_dropped": self.dropped},
                           "band": DA.usable_band(fps, sp_hz if need_dealias else None)})
        if self._tick % 3 == 0:
            vel_amp = spectral.disp_to_vel_spectrum(f, m)
            pk = []
            for i, p in enumerate(peaks):
                a = assigned[i] if assigned else None
                ft = a["f_true_hz"] if a and a["order"] else p["f_hz"]
                order = (ft / speed_hz) if speed_hz else 0
                pk.append({"f_hz": ft, "amp": 2 * np.pi * ft * (a["amp_true"] if a and a["order"] else p["amp"]),
                           "amp_ci": [2 * np.pi * ft * float(np.interp(p["f_hz"], f, lo)),
                                      2 * np.pi * ft * float(np.interp(p["f_hz"], f, hi))],
                           "order": round(order, 2), "corroborated_audio": bool(a and a["order"]),
                           "label": f"{round(order)}×" if speed_hz and abs(order - round(order)) < 0.06 and round(order) >= 1 else "",
                           **({"aliased": True, "f_alias_hz": p["f_hz"]} if a and a["order"] and a["fold"] else {})})
            await self.s.emit({"type": "spectrum", "channel": rid, "f_hz": f.tolist(), "amp": vel_amp.tolist(),
                               "unit": "mm/s", "peaks": pk})
            await self.s.emit({"type": "waterfall", "channel": rid, "f_max_hz": float(f[-1]),
                               "row": spectral.to_uint8_db(vel_amp[None, :])[0].tolist()})
        if assigned and self._tick % 10 == 0:
            await self.s.emit({"type": "dealias", "channel": rid, "fs_video": fps, "speed_hz_audio": sp_hz,
                               "speed_source": "audio",
                               "peaks": [{k: a[k] for k in ("f_alias_hz", "f_true_hz", "order", "fold", "residual_hz", "confidence")}
                                         for a in assigned if a["order"]]})


def tracks_rigid(tr: _Track, x: np.ndarray) -> bool:
    return tr.spread < max(0.25, 1.5 * float(np.std(x)))

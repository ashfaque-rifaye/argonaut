"""Synthetic vibration video generator with exact ground truth.

Renders a machine scene (pump skid or pedestal fan) where every part moves by a known, sub-pixel
displacement, adds the matching audio, and writes ``<clip>.mp4`` (H.264 + AAC, faststart) plus
``<clip>.json`` (ground truth) next to it.

Motion model (per part p, x and y separately, in output pixels):

    d_p(t) = sum_orders  A_pk * (N/N_ref)^e_k * cos(k*theta(t) + phi_pk)          (direct forced response)
           + sum_modes   Phi_pm * eta_m(t)                                         (structural modes)
           + optional band-limited part noise

    eta_m'' + 2 zeta_m w_m eta_m' + w_m^2 eta_m = w_m^2 F_m(t)        (simulated in time at 24 kHz)
    F_m(t)  = sum_k c_mk * (N/N_ref)^2 * cos(k*theta + psi_mk) + ambient broadband noise

so an order passing near fn is amplified by the SDOF frequency response
1/sqrt((1-r^2)^2 + (2 zeta r)^2) in steady state (and correctly delayed/limited during fast
coast-downs), with the 180 deg phase flip through resonance. theta(t) is the shaft angle.

Rendering: every part is a supersampled (4x) RGBA sprite. Each frame the sprite is shifted by its
exact sub-pixel displacement with the Fourier shift theorem (no 1/32 px quantisation like
cv2.warpAffine), motion-blurred over the exposure by the matching sinc in the Fourier domain,
composited over a static wall, then optional camera shake (whole frame, so the wall moves too),
sensor noise and lighting flicker are applied.

CLI::

    uv run python -m argonaut.sim.synth_video --preset fan_coastdown --out data/synth/fan_coastdown.mp4
    uv run python -m argonaut.sim.synth_video --all
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path

import cv2
import numpy as np
import scipy.fft as sfft
from scipy import signal
from scipy.io import wavfile

AUDIO_RATE = 24000  # Hz; the motion model is simulated at this rate too
SUPERSAMPLE = 4
SHIFT_BITS = 4  # cv2 fractional coordinate bits used when drawing (1/16 px at 4x)
BASE_W, BASE_H = 960.0, 540.0  # design coordinates; scaled to the requested resolution
SCHEMA = "argonaut.synth.v1"
# x264 tuning that preserves sub-pixel motion (dct-decimate and dead-zones zero out tiny residuals)
X264_EXTRA = os.environ.get("ARGONAUT_X264_EXTRA", "-tune grain -x264-params no-dct-decimate=1").split()

# --------------------------------------------------------------------------------------------
# Specs
# --------------------------------------------------------------------------------------------


@dataclass
class OrderSpec:
    """Direct forced response at k x shaft speed. parts: name -> (ax_px, ay_px, phase_x_deg, phase_y_deg)."""

    order: float
    label: str
    parts: dict
    speed_exponent: float = 2.0


@dataclass
class ModeSpec:
    """Structural mode. shape: part -> (ax, ay, phase_deg); coupling: order -> (static_px, phase_deg)."""

    name: str
    fn_hz: float
    zeta: float
    shape: dict
    coupling: dict = field(default_factory=dict)
    ambient_rms_px: float = 0.0  # RMS of the broadband-excited modal response (shape amplitude 1)
    ambient_floor: float = 0.3  # share of ambient excitation present at zero speed


@dataclass
class SpeedProfile:
    kind: str = "constant"  # constant | linear | exp_coastdown
    rpm0: float = 1480.0
    rpm1: float = 0.0
    tau_s: float = 6.0

    def rpm(self, t: np.ndarray, duration: float) -> np.ndarray:
        tc = np.clip(t, 0.0, duration)
        if self.kind == "constant":
            return np.full_like(t, self.rpm0, dtype=float)
        if self.kind == "linear":
            return self.rpm0 + (self.rpm1 - self.rpm0) * tc / duration
        if self.kind == "exp_coastdown":
            # shifted exponential that reaches rpm1 exactly at t = duration
            e_end = math.exp(-duration / self.tau_s)
            frac = (np.exp(-tc / self.tau_s) - e_end) / (1.0 - e_end)
            return self.rpm1 + (self.rpm0 - self.rpm1) * frac
        raise ValueError(self.kind)


@dataclass
class AudioSpec:
    order_tones: dict = field(default_factory=lambda: {1: 0.02, 2: 0.015})  # order -> amplitude
    blade_pass: float = 0.08
    magnetic: float = 0.03  # 2 x electrical frequency hum
    pwm_whine: float = 0.006  # VFD carrier 4 kHz with +-2 f_elec sidebands
    broadband: float = 0.05  # flow / aero noise (pink), scales with speed
    structure: float = 0.04  # structure-borne: motor/guard velocity, couples resonances into audio
    cavitation: float = 0.0  # 0..1 intensity of cavitation crackle (impulsive HF bursts)
    room: float = 0.002


@dataclass
class ClipSpec:
    name: str
    scene: str = "pump"  # pump | fan
    width: int = 960
    height: int = 540
    fps: float = 240.0
    duration_s: float = 8.0
    speed: SpeedProfile = field(default_factory=SpeedProfile)
    ref_rpm: float = 1480.0  # order amplitudes are specified at this speed
    orders: list = field(default_factory=list)
    modes: list = field(default_factory=list)
    part_noise: dict = field(default_factory=dict)  # part -> (rms_px, f_lo, f_hi)
    shake_rms_px: float = 0.0
    shake_band_hz: tuple = (0.3, 6.0)
    shake_tremor_px: float = 0.0  # extra 8-12 Hz hand tremor component (RMS)
    sensor_noise: float = 1.0  # Gaussian sigma in 8-bit levels
    shutter: float = 0.5  # exposure as a fraction of the frame period (0.5 = 180 deg)
    motion_blur: bool = True
    flicker: float = 0.0  # relative 100 Hz lighting flicker amplitude
    optics_sigma_px: float = 0.6  # lens PSF (Gaussian) applied to all layers
    amp_scale: float = 1.0
    audio: AudioSpec = field(default_factory=AudioSpec)
    seed: int = 0
    crf: int = 16
    description: str = ""


# --------------------------------------------------------------------------------------------
# Drawing helpers
# --------------------------------------------------------------------------------------------


class Layer:
    """Supersampled premultiplied-RGB + alpha drawing surface over a box in design units."""

    def __init__(self, box, sx, sy, margin_px, pad_px=8, ss=SUPERSAMPLE):
        x1, y1, x2, y2 = box
        self.sx, self.sy, self.M, self.ss = sx, sy, margin_px, ss
        self.X0 = int(math.floor(x1 * sx + margin_px)) - pad_px
        self.Y0 = int(math.floor(y1 * sy + margin_px)) - pad_px
        X1 = int(math.ceil(x2 * sx + margin_px)) + pad_px
        Y1 = int(math.ceil(y2 * sy + margin_px)) + pad_px
        # FFT-friendly sprite sizes (sprites are Fourier-shifted every frame)
        self.w = sfft.next_fast_len(X1 - self.X0, real=True) if pad_px else X1 - self.X0
        self.h = sfft.next_fast_len(Y1 - self.Y0, real=True) if pad_px else Y1 - self.Y0
        self.img = np.zeros((self.h * ss, self.w * ss, 3), np.uint8)
        self.a = np.zeros((self.h * ss, self.w * ss), np.uint8)

    def fork(self, img=None, a=None) -> "Layer":
        """Shallow copy with its own pixel buffers (lets dynamic sprites render from several threads)."""
        new = object.__new__(Layer)
        new.__dict__.update(self.__dict__)
        new.img = (self.img if img is None else img).copy()
        new.a = (self.a if a is None else a).copy()
        return new

    # coordinates
    def _f(self, x, y):
        return ((x * self.sx + self.M - self.X0) * self.ss, (y * self.sy + self.M - self.Y0) * self.ss)

    def P(self, x, y):
        fx, fy = self._f(x, y)
        k = 1 << SHIFT_BITS
        return (int(round(fx * k)), int(round(fy * k)))

    def L(self, d):
        return max(1, int(round(d * self.sx * self.ss)))

    # primitives (opaque unless a < 255)
    def Pv(self, xs, ys):
        """Vectorised P for arrays of design coordinates -> (n, 1, 2) int32 fixed-point points."""
        k = (1 << SHIFT_BITS) * self.ss
        X = np.round((np.asarray(xs) * self.sx + self.M - self.X0) * k)
        Y = np.round((np.asarray(ys) * self.sy + self.M - self.Y0) * k)
        return np.stack([X, Y], -1).astype(np.int32).reshape(-1, 1, 2)

    def poly(self, pts, color, a=255):
        pts = np.asarray(pts, dtype=float)
        p = self.Pv(pts[:, 0], pts[:, 1])
        cv2.fillPoly(self.img, [p], color, cv2.LINE_AA, SHIFT_BITS)
        if a:
            cv2.fillPoly(self.a, [p], a, cv2.LINE_AA, SHIFT_BITS)

    def rect(self, x1, y1, x2, y2, color, a=255):
        self.poly([(x1, y1), (x2, y1), (x2, y2), (x1, y2)], color, a)

    def rrect(self, x1, y1, x2, y2, r, color, a=255):
        pts = []
        for cx, cy, a0 in ((x2 - r, y1 + r, -90), (x2 - r, y2 - r, 0), (x1 + r, y2 - r, 90), (x1 + r, y1 + r, 180)):
            for ang in np.linspace(a0, a0 + 90, 7):
                pts.append((cx + r * math.cos(math.radians(ang)), cy + r * math.sin(math.radians(ang))))
        self.poly(pts, color, a)

    def circle(self, cx, cy, r, color, thick=-1, a=255):
        c = self.P(cx, cy)
        rr = int(round(r * self.sx * self.ss * (1 << SHIFT_BITS)))
        t = -1 if thick < 0 else self.L(thick)
        cv2.circle(self.img, c, rr, color, t, cv2.LINE_AA, SHIFT_BITS)
        if a:
            cv2.circle(self.a, c, rr, a, t, cv2.LINE_AA, SHIFT_BITS)

    def ellipse(self, cx, cy, rx, ry, color, a=255, angle=0.0):
        k = 1 << SHIFT_BITS
        c = self.P(cx, cy)
        ax = (int(round(rx * self.sx * self.ss * k)), int(round(ry * self.sy * self.ss * k)))
        cv2.ellipse(self.img, c, ax, angle, 0, 360, color, -1, cv2.LINE_AA, SHIFT_BITS)
        if a:
            cv2.ellipse(self.a, c, ax, angle, 0, 360, a, -1, cv2.LINE_AA, SHIFT_BITS)

    def line(self, x1, y1, x2, y2, color, thick=1.0, a=255):
        t = self.L(thick)
        cv2.line(self.img, self.P(x1, y1), self.P(x2, y2), color, t, cv2.LINE_AA, SHIFT_BITS)
        if a:
            cv2.line(self.a, self.P(x1, y1), self.P(x2, y2), a, t, cv2.LINE_AA, SHIFT_BITS)

    def text(self, s, x, y, scale, color, thick=1.0, font=cv2.FONT_HERSHEY_SIMPLEX):
        fx, fy = self._f(x, y)
        cv2.putText(self.img, s, (int(fx), int(fy)), font, scale * self.sx * self.ss, color,
                    max(1, int(round(thick * self.sx * self.ss))), cv2.LINE_AA)

    def bolt(self, cx, cy, r=4.0, color=(120, 125, 130)):
        """Hex bolt head with a highlight."""
        pts = [(cx + r * math.cos(math.radians(30 + 60 * i)), cy + r * math.sin(math.radians(30 + 60 * i)))
               for i in range(6)]
        self.poly(pts, tuple(int(c * 0.6) for c in color))
        pts2 = [(cx + 0.78 * r * math.cos(math.radians(30 + 60 * i)), cy + 0.78 * r * math.sin(math.radians(30 + 60 * i)))
                for i in range(6)]
        self.poly(pts2, color)
        self.circle(cx - r * 0.25, cy - r * 0.25, r * 0.28, tuple(min(255, int(c * 1.5)) for c in color))

    def shade_rows(self, y1, y2, lo=0.62, hi=1.12, peak=0.3):
        """Cylindrical shading over design rows y1..y2 (applied to what is already drawn)."""
        _, fy1 = self._f(0, y1)
        _, fy2 = self._f(0, y2)
        r0, r1 = max(int(fy1), 0), min(int(fy2), self.img.shape[0])
        if r1 <= r0:
            return
        u = (np.arange(r0, r1) - fy1) / max(fy2 - fy1, 1)
        prof = lo + (hi - lo) * np.clip(np.cos((u - peak) * math.pi * 0.9), 0, 1) ** 0.7
        blk = self.img[r0:r1].astype(np.float32) * prof[:, None, None]
        self.img[r0:r1] = np.clip(blk, 0, 255).astype(np.uint8)

    def finish(self, rng, texture=0.05, sigma=0.6):
        """Downscale (INTER_AREA), apply lens blur and surface texture -> (premult rgb float32, alpha)."""
        col = cv2.resize(self.img, (self.w, self.h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
        al = cv2.resize(self.a, (self.w, self.h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
        if texture > 0:
            col *= (1.0 + texture * _texture(rng, self.h, self.w))[..., None]
        if sigma > 0:
            col = cv2.GaussianBlur(col, (0, 0), sigma)
            al = cv2.GaussianBlur(al, (0, 0), sigma)
        col = np.minimum(np.clip(col, 0, 1), al[..., None])
        return col, np.clip(al, 0, 1)


def _texture(rng, h, w):
    """Multi-scale surface texture in roughly [-1, 1] (gives phase correlation something to lock on)."""
    t = np.zeros((h, w), np.float32)
    for sigma, wgt in ((0.7, 0.5), (2.0, 0.7), (6.0, 0.9), (18.0, 0.6)):
        n = rng.standard_normal((h, w)).astype(np.float32)
        n = cv2.GaussianBlur(n, (0, 0), sigma)
        t += wgt * n / (n.std() + 1e-9)
    return t / 2.5


# --------------------------------------------------------------------------------------------
# Scenes
# --------------------------------------------------------------------------------------------


@dataclass
class Sprite:
    part: str  # part name (ground truth key) whose displacement the sprite follows
    X0: int
    Y0: int
    color: np.ndarray | None  # static premultiplied colour (h, w, 3)
    alpha: np.ndarray | None
    h: int = 0
    w: int = 0
    dynamic: object = None  # callable(theta_subsamples) -> (color, alpha) for rotating details
    F: np.ndarray | None = None  # cached rfft2 of the static stack


@dataclass
class PartInfo:
    name: str
    label: str
    polygon: list  # rest polygon in output pixels
    is_reference: bool = False
    follows: str | None = None


@dataclass
class Scene:
    background: np.ndarray  # padded canvas float32 (H+2M, W+2M, 3)
    sprites: list
    parts: dict
    margin: int
    mm_per_px: float
    reference_object: dict
    machine: dict


def _poly_px(pts, sx, sy):
    return [[round(x * sx, 2), round(y * sy, 2)] for x, y in pts]


def _wall_and_floor(Lb: Layer, rng, floor_y, wall_color=(168, 172, 170), floor_color=(105, 110, 112)):
    """Concrete-block wall + concrete floor drawn on a full-canvas layer (design units)."""
    m = 40
    Lb.rect(-m, -m, BASE_W + m, floor_y, wall_color)
    bw, bh = 120.0, 60.0
    for row, y in enumerate(np.arange(-m, floor_y, bh)):
        off = (row % 2) * bw / 2
        for x in np.arange(-m - off, BASE_W + m, bw):
            j = rng.uniform(-14, 14)
            c = tuple(int(np.clip(v + j, 0, 255)) for v in wall_color)
            Lb.rect(x + 1.5, y + 1.5, x + bw - 1.5, min(y + bh - 1.5, floor_y), c)
    Lb.rect(-m, floor_y, BASE_W + m, BASE_H + m, floor_color)
    Lb.rect(-m, floor_y - 6, BASE_W + m, floor_y, (90, 92, 95))  # skirting
    for _ in range(14):  # floor stains
        Lb.ellipse(rng.uniform(0, BASE_W), rng.uniform(floor_y + 10, BASE_H), rng.uniform(10, 50),
                   rng.uniform(3, 9), tuple(int(v * rng.uniform(0.8, 0.95)) for v in floor_color))


def _sign(Lb: Layer, x, y, w, h, title, lines, bg=(40, 170, 240), fg=(20, 20, 20)):
    Lb.rect(x, y, x + w, y + h, (235, 238, 240))
    Lb.rect(x + 3, y + 3, x + w - 3, y + 0.38 * h, bg)
    Lb.text(title, x + 8, y + 0.30 * h, 0.42, fg, 1.2)
    for i, s in enumerate(lines):
        Lb.text(s, x + 8, y + 0.55 * h + i * 0.2 * h, 0.32, (40, 40, 40), 1.0)


def build_pump_scene(W, H, margin, rng, sigma) -> Scene:
    sx, sy = W / BASE_W, H / BASE_H
    floor_y = 430.0
    sprites, parts = [], {}
    # ---------------- background (static): wall, floor, suction pipe, conduit, sign ----------------
    Lb = Layer((-margin / sx, -margin / sy, BASE_W + margin / sx, BASE_H + margin / sy), sx, sy, margin, pad_px=0, ss=2)
    _wall_and_floor(Lb, rng, floor_y)
    _sign(Lb, 60, 60, 190, 110, "CAUTION", ["Rotating equipment", "Hearing protection", "required in this area"])
    Lb.rect(-40, 22, BASE_W + 40, 30, (120, 120, 118))  # conduit
    for x in range(40, 960, 160):
        Lb.rect(x, 18, x + 10, 34, (95, 95, 95))
    Lb.rect(100, floor_y - 2, 860, floor_y + 18, (150, 150, 146))  # grout pad
    for x in np.arange(100, 860, 40):  # hazard tape
        Lb.poly([(x, 492), (x + 20, 492), (x + 32, 502), (x + 12, 502)], (20, 200, 240))
    # suction pipe (static, enters from the right)
    Lb.rect(752, 297, BASE_W + 40, 343, (95, 120, 85))
    Lb.shade_rows(297, 343)
    Lb.rect(880, 290, 890, 350, (80, 100, 70))
    Lb.rect(890, 343, 896, floor_y, (60, 60, 60))  # pipe support
    bg_col = cv2.resize(Lb.img, (Lb.w, Lb.h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    bg_col *= (1.0 + 0.06 * _texture(rng, Lb.h, Lb.w))[..., None]
    bg = cv2.GaussianBlur(np.clip(bg_col, 0, 1), (0, 0), sigma) if sigma > 0 else np.clip(bg_col, 0, 1)
    parts["wall"] = PartInfo("wall", "concrete block wall (static reference)",
                             _poly_px([(300, 50), (560, 50), (560, 200), (300, 200)], sx, sy), True)

    def add(part, label, box, draw, texture=0.05, outline=None, follows=None):
        L = Layer(box, sx, sy, margin)
        draw(L)
        col, al = L.finish(rng, texture, sigma)
        sprites.append(Sprite(part, L.X0, L.Y0, col, al, L.h, L.w))
        if part not in parts:
            poly = outline or [(box[0], box[1]), (box[2], box[1]), (box[2], box[3]), (box[0], box[3])]
            parts[part] = PartInfo(part, label, _poly_px(poly, sx, sy), False, follows)
        return L

    # ---------------- baseplate ----------------
    def d_base(L):
        L.rect(120, 400, 840, 432, (110, 95, 70))
        L.rect(120, 400, 840, 406, (150, 135, 105))
        L.rect(120, 426, 840, 432, (70, 60, 45))
        for x in (135, 825, 330, 620):
            L.bolt(x, 416, 5.0)
    add("baseplate", "steel baseplate", (115, 398, 845, 434), d_base, 0.07)

    # ---------------- motor ----------------
    blue = (150, 95, 40)

    def d_motor(L):
        for x in (200, 410):  # feet
            L.rect(x, 380, x + 45, 402, (120, 75, 30))
            L.bolt(x + 10, 396, 3.5)
            L.bolt(x + 35, 396, 3.5)
        L.rrect(185, 262, 470, 390, 14, blue)
        for y in np.arange(272, 386, 9):  # cooling fins
            L.line(195, y, 462, y, (110, 68, 28), 2.0)
        L.rrect(150, 272, 190, 380, 10, (130, 85, 40))  # fan cowl
        for y in np.arange(282, 372, 7):
            L.line(156, y, 184, y, (60, 40, 20), 2.0)
        L.rect(460, 300, 474, 360, (140, 90, 40))  # end shield
        L.shade_rows(262, 390)
        L.rrect(280, 228, 352, 264, 4, (145, 92, 40))  # terminal box
        L.rect(284, 232, 348, 238, (175, 120, 60))
        for x in (288, 344):
            L.bolt(x, 250, 2.6)
        L.circle(230, 258, 7, (90, 90, 95), 3)  # lifting eye
        # nameplate (reference object 70 x 40 mm)
        L.rect(320, 300, 390, 340, (200, 205, 205))
        L.rect(322, 302, 388, 309, (60, 60, 60))
        L.text("ARGONAUT", 324, 308.2, 0.19, (230, 230, 230), 0.7)
        for i, s in enumerate(["3~ MOT 15 kW", "1480 r/min 50Hz", "400V  IP55  4P"]):
            L.text(s, 324, 318 + i * 8, 0.17, (30, 30, 30), 0.6)
        for x, y in ((323.5, 337), (386.5, 337)):
            L.circle(x, y, 1.3, (80, 80, 80))

    add("motor", "electric motor housing", (148, 226, 476, 404), d_motor, 0.05,
        outline=[(150, 262), (470, 262), (470, 390), (150, 390)])

    # ---------------- pump ----------------
    red = (40, 45, 170)

    def d_pump(L):
        L.rect(560, 380, 700, 402, (35, 40, 140))  # pedestal
        for x in (575, 685):
            L.bolt(x, 395, 3.5)
        L.rect(525, 300, 600, 362, red)  # bearing frame
        L.shade_rows(300, 362)
        L.circle(650, 322, 72, red)  # volute
        L.circle(650, 322, 58, (35, 40, 155), 3)
        for k in range(10):
            a = math.radians(36 * k + 10)
            L.bolt(650 + 66 * math.cos(a), 322 + 66 * math.sin(a), 3.2)
        L.rect(625, 228, 675, 262, red)  # discharge nozzle
        L.rect(615, 222, 685, 232, (35, 40, 150))  # discharge flange
        for x in (622, 650, 678):
            L.bolt(x, 227, 2.8)
        L.rect(712, 300, 752, 344, red)  # suction nozzle
        L.rect(744, 290, 754, 352, (35, 40, 150))
        for y in (296, 321, 346):
            L.bolt(749, y, 2.8)
        L.rect(600, 312, 610, 332, (140, 140, 140))
        L.circle(650, 322, 18, (45, 50, 180))
        L.text("P-101", 628, 360, 0.35, (230, 230, 230), 1.0)

    add("pump", "centrifugal pump casing", (520, 220, 756, 404), d_pump, 0.06,
        outline=[(525, 250), (722, 250), (722, 394), (525, 394)])

    # ---------------- discharge pipe ----------------
    gpipe = (95, 120, 85)

    def d_pipe(L):
        L.rect(626, 120, 674, 222, gpipe)
        L.rect(615, 212, 685, 222, (80, 100, 70))
        L.rect(615, 150, 685, 158, (80, 100, 70))
        L.circle(674, 120, 48, gpipe)  # elbow
        L.rect(674, 72, BASE_W + 40, 120, gpipe)
        L.rect(626, 72, 674, 120, gpipe)
        L.shade_rows(72, 120)
        L.rect(800, 64, 808, 128, (80, 100, 70))
        for x in (622, 650, 678):
            L.bolt(x, 217, 2.8)
            L.bolt(x, 154, 2.8)
        L.rect(686, 136, 700, 160, (90, 90, 90))  # gauge stem + gauge
        L.circle(712, 170, 16, (40, 40, 40))
        L.circle(712, 170, 13, (235, 235, 235))
        L.line(712, 170, 720, 162, (20, 20, 200), 1.2)

    add("pipe", "discharge pipe", (612, 60, BASE_W + 30, 226), d_pipe, 0.06,
        outline=[(626, 72), (960, 72), (960, 120), (674, 120), (674, 222), (626, 222)])

    # ---------------- coupling (dynamic: rotating reflective tape) ----------------
    cbox = (466, 292, 532, 368)

    def d_coupling_static(L):
        L.rect(468, 323, 530, 337, (150, 150, 150))  # shaft
        L.rect(480, 300, 514, 360, (95, 95, 100))  # coupling hubs
        L.rect(495, 300, 499, 360, (55, 55, 60))
        L.shade_rows(300, 360, 0.55, 1.2)

    Lc = Layer(cbox, sx, sy, margin)
    d_coupling_static(Lc)
    base_img, base_a = Lc.img.copy(), Lc.a.copy()
    R, yc = 30.0, 330.0

    def coupling_dynamic(thetas, Lc0=Lc, base_img=base_img, base_a=base_a):
        Lc = Lc0.fork()
        acc = np.zeros_like(base_img, dtype=np.float32)
        for th in thetas:
            Lc.img[:] = base_img
            for x1, x2 in ((483, 493),):
                lo, hi = th - 0.2, th + 0.2
                if math.cos(th) > -0.2:  # tape on the visible side
                    ya, yb = yc - R * math.sin(min(hi, th + math.pi / 2)), yc - R * math.sin(max(lo, th - math.pi / 2))
                    y1, y2 = sorted((ya, yb))
                    if y2 - y1 > 0.05:
                        b = float(np.clip(0.35 + 0.65 * math.cos(th), 0, 1))
                        Lc.rect(x1, y1, x2, y2, (int(255 * b), int(255 * b), int(240 * b)), a=0)
            acc += Lc.img
        Lc.img[:] = np.clip(acc / len(thetas), 0, 255).astype(np.uint8)
        Lc.a[:] = base_a
        return Lc.finish(None, 0.0, sigma)

    sprites.insert(2, Sprite("coupling", Lc.X0, Lc.Y0, None, None, Lc.h, Lc.w, dynamic=coupling_dynamic))
    parts["coupling"] = PartInfo("coupling", "shaft coupling with reflective tape",
                                 _poly_px([(480, 300), (514, 300), (514, 360), (480, 360)], sx, sy), False, "motor")
    # z-order: baseplate, motor, coupling, pump, pipe
    order = ["baseplate", "motor", "coupling", "pump", "pipe"]
    sprites.sort(key=lambda s: order.index(s.part))
    mm_per_px = 1.0 / sx  # design scale: 1 design unit = 1 mm
    ref = {"name": "motor nameplate", "width_mm": 70.0, "height_mm": 40.0,
           "polygon": _poly_px([(320, 300), (390, 300), (390, 340), (320, 340)], sx, sy),
           "width_px": round(70 * sx, 3)}
    machine = {"type": "end-suction centrifugal pump, 4-pole motor", "rated_rpm": 1480, "kw": 15.0, "poles": 4,
               "vanes": 6, "tag": "P-101"}
    return Scene(bg, sprites, parts, margin, mm_per_px, ref, machine)


def build_fan_scene(W, H, margin, rng, sigma) -> Scene:
    sx, sy = W / BASE_W, H / BASE_H
    floor_y = 455.0
    sprites, parts = [], {}
    Lb = Layer((-margin / sx, -margin / sy, BASE_W + margin / sx, BASE_H + margin / sy), sx, sy, margin, pad_px=0, ss=2)
    _wall_and_floor(Lb, rng, floor_y, wall_color=(176, 184, 186), floor_color=(80, 100, 120))
    _sign(Lb, 640, 70, 220, 120, "TEST BAY 3", ["Fan F-101 coast-down", "Keep 1 m clearance", "Ear protection"],
          bg=(60, 160, 60))
    Lb.rect(600, 250, 900, 258, (130, 130, 128))  # wall rail
    bg_col = cv2.resize(Lb.img, (Lb.w, Lb.h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    bg_col *= (1.0 + 0.06 * _texture(rng, Lb.h, Lb.w))[..., None]
    bg = cv2.GaussianBlur(np.clip(bg_col, 0, 1), (0, 0), sigma) if sigma > 0 else np.clip(bg_col, 0, 1)
    parts["wall"] = PartInfo("wall", "painted block wall (static reference)",
                             _poly_px([(600, 280), (900, 280), (900, 430), (600, 430)], sx, sy), True)
    cx, cy, R = 350.0, 200.0, 150.0

    def add(part, label, box, draw, texture=0.05, outline=None):
        L = Layer(box, sx, sy, margin)
        draw(L)
        col, al = L.finish(rng, texture, sigma)
        sprites.append(Sprite(part, L.X0, L.Y0, col, al, L.h, L.w))
        poly = outline or [(box[0], box[1]), (box[2], box[1]), (box[2], box[3]), (box[0], box[3])]
        parts[part] = PartInfo(part, label, _poly_px(poly, sx, sy), False)

    def d_base(L):
        L.poly([(230, 470), (470, 470), (490, 505), (210, 505)], (55, 55, 60))
        L.rect(210, 503, 490, 510, (35, 35, 38))
        L.rect(316, 478, 384, 498, (210, 212, 212))  # rating label (reference object 68 x 20 mm)
        L.text("ARGONAUT AIR", 319, 486, 0.17, (20, 20, 20), 0.6)
        L.text("230V~ 75W 1476rpm", 319, 494.5, 0.15, (40, 40, 40), 0.5)
        L.circle(260, 490, 6, (30, 30, 200))  # speed knob
        L.circle(440, 490, 6, (120, 120, 120))

    add("base", "fan base", (205, 466, 495, 512), d_base, 0.05)

    def d_stand(L):
        L.rect(341, 250, 359, 472, (185, 185, 190))
        L.rect(345, 250, 349, 472, (235, 235, 240))
        L.rrect(334, 380, 366, 400, 4, (60, 60, 65))  # height collar
        L.circle(370, 390, 5, (40, 40, 45))

    add("stand", "fan stand pole", (330, 248, 376, 474), d_stand, 0.03, outline=[(341, 352), (359, 352), (359, 470), (341, 470)])

    def d_motor(L):
        L.ellipse(cx, cy, 70, 66, (70, 72, 78))
        L.ellipse(cx, cy, 52, 50, (95, 97, 104))
        for k in range(12):
            a = math.radians(30 * k)
            L.line(cx + 30 * math.cos(a), cy + 30 * math.sin(a), cx + 48 * math.cos(a), cy + 48 * math.sin(a), (50, 50, 55), 2)
        L.rrect(cx - 18, cy + 50, cx + 18, cy + 80, 5, (70, 72, 78))  # neck to stand

    add("motor", "fan motor housing", (cx - 72, cy - 68, cx + 72, cy + 82), d_motor, 0.04,
        outline=[(cx - 70, cy - 66), (cx + 70, cy - 66), (cx + 70, cy + 66), (cx - 70, cy + 66)])

    # rotor (dynamic): 5 blades + hub, one blade carries a red balancing clip (1x marker)
    rbox = (cx - R + 4, cy - R + 4, cx + R - 4, cy + R - 4)
    Lr = Layer(rbox, sx, sy, margin, ss=2)
    blade = []
    for u in np.linspace(0, 1, 18):
        rad = 30 + 108 * u
        blade.append((rad, -0.30 - 0.18 * u + 0.12 * math.sin(math.pi * u)))
    for u in np.linspace(1, 0, 18):
        rad = 30 + 108 * u
        blade.append((rad, 0.30 + 0.05 * math.sin(math.pi * u)))
    n_bl = 5

    blade_r = np.array([b[0] for b in blade])
    blade_a = np.array([b[1] for b in blade])

    def rotor_dynamic(thetas, Lr0=Lr):
        Lr = Lr0.fork()
        acc_c = np.zeros_like(Lr.img, dtype=np.float32)
        acc_a = np.zeros_like(Lr.a, dtype=np.float32)
        for th in thetas:
            Lr.img[:] = 0
            Lr.a[:] = 0
            for b in range(n_bl):
                phi = th + 2 * math.pi * b / n_bl
                Lr.poly(np.stack([cx + blade_r * np.cos(phi + blade_a), cy + blade_r * np.sin(phi + blade_a)], -1),
                        (205, 170, 120), a=225)
                if b == 0:
                    Lr.circle(cx + 118 * math.cos(phi), cy + 118 * math.sin(phi), 7, (30, 30, 220), a=255)
            Lr.circle(cx, cy, 30, (190, 155, 105), a=255)
            Lr.circle(cx + 14 * math.cos(th), cy + 14 * math.sin(th), 4, (250, 250, 250), a=255)
            acc_c += Lr.img
            acc_a += Lr.a
        Lr.img[:] = np.clip(acc_c / len(thetas), 0, 255).astype(np.uint8)
        Lr.a[:] = np.clip(acc_a / len(thetas), 0, 255).astype(np.uint8)
        return Lr.finish(None, 0.0, sigma)

    sprites.append(Sprite("rotor", Lr.X0, Lr.Y0, None, None, Lr.h, Lr.w, dynamic=rotor_dynamic))
    parts["rotor"] = PartInfo("rotor", "fan blades (rotating)",
                              _poly_px([(cx - 138, cy - 138), (cx + 138, cy - 138), (cx + 138, cy + 138), (cx - 138, cy + 138)], sx, sy),
                              False, "guard")

    def d_guard(L):
        chrome = (200, 200, 205)
        L.circle(cx, cy, R, chrome, 5)
        for r in (34, 60, 86, 112, 136):
            L.circle(cx, cy, r, chrome, 1.4)
        for k in range(28):
            a = math.radians(360 / 28 * k)
            L.line(cx + 34 * math.cos(a), cy + 34 * math.sin(a), cx + R * math.cos(a), cy + R * math.sin(a), chrome, 1.2)
        L.circle(cx, cy, 26, (230, 230, 232))  # badge
        L.circle(cx, cy, 26, (150, 150, 155), 1.5)
        L.text("ARGO", cx - 17, cy + 4, 0.30, (60, 60, 160), 1.0)
        L.rect(cx - 8, cy + R - 3, cx + 8, cy + R + 8, (150, 150, 155))  # clamp

    add("guard", "fan guard (front grille)", (cx - R - 4, cy - R - 4, cx + R + 4, cy + R + 10), d_guard, 0.02,
        outline=[(cx - R, cy - R), (cx + R, cy - R), (cx + R, cy + R), (cx - R, cy + R)])
    order = ["base", "stand", "motor", "rotor", "guard"]
    sprites.sort(key=lambda s: order.index(s.part))
    ref = {"name": "fan rating label", "width_mm": 68.0, "height_mm": 20.0,
           "polygon": _poly_px([(316, 478), (384, 478), (384, 498), (316, 498)], sx, sy), "width_px": round(68 * sx, 3)}
    machine = {"type": "pedestal fan, 4-pole motor", "rated_rpm": 1476, "kw": 0.075, "poles": 4, "blades": 5,
               "tag": "F-101"}
    return Scene(bg, sprites, parts, margin, 1.0 / sx, ref, machine)


# --------------------------------------------------------------------------------------------
# Motion model
# --------------------------------------------------------------------------------------------


def sdof_sos(fn_hz: float, zeta: float, fs: float):
    """Discrete SDOF filter with unit static gain: w^2 / (s^2 + 2 zeta w s + w^2) (bilinear; warp is negligible at 24 kHz)."""
    w = 2 * math.pi * fn_hz
    wd = w * math.sqrt(1 - zeta**2)
    z, p, k = signal.bilinear_zpk([], [complex(-zeta * w, wd), complex(-zeta * w, -wd)], w * w, fs)
    return signal.zpk2sos(z, p, k)


def _bandnoise(rng, n, fs, f_lo, f_hi, rms, norm_from=0):
    """Band-limited Gaussian noise whose RMS over samples [norm_from:] equals rms."""
    if rms <= 0:
        return np.zeros(n)
    sos = signal.butter(2, [f_lo, f_hi], btype="band", fs=fs, output="sos")
    x = signal.sosfiltfilt(sos, rng.standard_normal(n))
    return x * (rms / (x[norm_from:].std() + 1e-12))


def simulate_motion(spec: ClipSpec, part_names, rng) -> dict:
    fs = AUDIO_RATE
    zmin = min([m.zeta * m.fn_hz for m in spec.modes], default=1.0)
    pre = float(min(12.0, 6.0 / (2 * math.pi * zmin))) if spec.modes else 0.5  # pre-roll to steady state
    n_pre = int(round(pre * fs))
    n = int(round(spec.duration_s * fs)) + 1
    t = (np.arange(n_pre + n) - n_pre) / fs
    rpm = spec.speed.rpm(t, spec.duration_s)
    theta = 2 * math.pi * np.cumsum(rpm / 60.0) / fs
    theta -= theta[n_pre]  # shaft angle 0 at t = 0
    s_ref = rpm / spec.ref_rpm
    a_sc = spec.amp_scale
    disp = {p: np.zeros((2, n_pre + n)) for p in part_names}

    for o in spec.orders:
        sk = s_ref**o.speed_exponent
        for p, (ax, ay, phx, phy) in o.parts.items():
            disp[p][0] += a_sc * ax * sk * np.cos(o.order * theta + math.radians(phx))
            disp[p][1] += a_sc * ay * sk * np.cos(o.order * theta + math.radians(phy))

    modal = {}
    for m in spec.modes:
        sos = sdof_sos(m.fn_hz, m.zeta, fs)
        F = np.zeros(n_pre + n)
        for k, (px, ph) in m.coupling.items():
            F += px * s_ref**2 * np.cos(float(k) * theta + math.radians(ph))
        eta = signal.sosfilt(sos, F)
        if m.ambient_rms_px > 0:
            w = rng.standard_normal(n_pre + n) * (m.ambient_floor + (1 - m.ambient_floor) * s_ref**2)
            ea = signal.sosfilt(sos, w)
            ea *= m.ambient_rms_px / (ea[n_pre:].std() + 1e-12)
            eta = eta + ea
        eta *= a_sc
        modal[m.name] = eta
        need_h = any(ph % 180 != 0 for (_, _, ph) in m.shape.values())
        an = signal.hilbert(eta) if need_h else None
        for p, (ax, ay, ph) in m.shape.items():
            if an is None:
                sig = eta * (1.0 if ph % 360 == 0 else -1.0)
            else:
                sig = np.real(an * np.exp(1j * math.radians(ph)))
            disp[p][0] += ax * sig
            disp[p][1] += ay * sig

    for p, (rms, f_lo, f_hi) in spec.part_noise.items():
        disp[p][0] += a_sc * _bandnoise(rng, n_pre + n, fs, f_lo, f_hi, rms, n_pre)
        disp[p][1] += a_sc * 0.6 * _bandnoise(rng, n_pre + n, fs, f_lo, f_hi, rms, n_pre)

    shake = np.zeros((2, n_pre + n))
    if spec.shake_rms_px > 0 or spec.shake_tremor_px > 0:
        for ax in range(2):
            shake[ax] = _bandnoise(rng, n_pre + n, fs, *spec.shake_band_hz, spec.shake_rms_px, n_pre)
            shake[ax] += _bandnoise(rng, n_pre + n, fs, 8.0, 12.0, spec.shake_tremor_px, n_pre)

    sl = slice(n_pre, None)
    return {
        "fs": fs, "t": t[sl], "rpm": rpm[sl], "theta": theta[sl],
        "disp": {p: d[:, sl] for p, d in disp.items()},
        "modal": {k: v[sl] for k, v in modal.items()},
        "shake": shake[:, sl],
    }


# --------------------------------------------------------------------------------------------
# Audio
# --------------------------------------------------------------------------------------------


def _pink(rng, n):
    X = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / AUDIO_RATE)
    f[0] = f[1]
    x = np.fft.irfft(X / np.sqrt(f), n)
    return x / (x.std() + 1e-12)


def synth_audio(spec: ClipSpec, mot: dict, scene: Scene, rng) -> tuple[np.ndarray, dict]:
    fs = AUDIO_RATE
    a = spec.audio
    t, rpm, th = mot["t"], mot["rpm"], mot["theta"]
    n = len(t)
    s = np.clip(rpm / spec.ref_rpm, 0, None)
    run = np.clip(rpm / 60.0, 0, 1)  # fades out below 60 rpm
    y = np.zeros(n)
    comps = []
    for k, amp in a.order_tones.items():
        y += amp * s**2 * np.sin(float(k) * th + rng.uniform(0, 2 * math.pi))
        comps.append({"name": f"{k}x shaft order", "order": float(k), "amp": amp, "scaling": "(N/Nref)^2"})
    nb = int(scene.machine.get("blades") or scene.machine.get("vanes") or 5)
    if a.blade_pass:
        y += a.blade_pass * s**2 * (np.sin(nb * th) + 0.45 * np.sin(2 * nb * th + 1.1) + 0.2 * np.sin(3 * nb * th + 2.3))
        comps.append({"name": "blade/vane pass", "order": float(nb), "harmonics": [1, 2, 3], "amp": a.blade_pass})
    poles = int(scene.machine.get("poles", 4))
    fe = rpm * poles / 120.0
    ph_e = 2 * math.pi * np.cumsum(fe) / fs
    if a.magnetic:
        y += a.magnetic * run * (np.sin(2 * ph_e) + 0.4 * np.sin(4 * ph_e + 0.7))
        comps.append({"name": "motor magnetic hum", "order": poles, "freq": "2 x f_elec = N*poles/60", "amp": a.magnetic})
    if a.pwm_whine:
        fc = 4000.0
        car = 2 * math.pi * fc * t
        y += a.pwm_whine * run * (0.5 * np.sin(car) + 0.35 * np.sin(car + 2 * ph_e) + 0.35 * np.sin(car - 2 * ph_e))
        comps.append({"name": "VFD PWM carrier", "freq_hz": fc, "sidebands": "fc +- 2 f_elec", "amp": a.pwm_whine})
    if a.broadband:
        lp = signal.butter(2, 9000, fs=fs, output="sos")
        y += a.broadband * s**1.5 * signal.sosfilt(lp, _pink(rng, n))
        comps.append({"name": "flow/aero broadband (pink)", "amp": a.broadband, "scaling": "(N/Nref)^1.5"})
    if a.structure:
        main = "guard" if "guard" in mot["disp"] else "pump"
        v = np.gradient(mot["disp"][main][0]) * fs
        hp = signal.butter(2, 5.0, btype="high", fs=fs, output="sos")
        v = signal.sosfilt(hp, v)
        y += a.structure * v / (np.percentile(np.abs(v), 99.5) + 1e-9)
        comps.append({"name": f"structure-borne ({main} velocity)", "amp": a.structure})
    bursts = []
    if a.cavitation > 0:
        hpf = signal.butter(4, 2500, btype="high", fs=fs, output="sos")
        cav = np.zeros(n)
        rate = 70.0 * a.cavitation
        tt = 0.0
        while True:
            tt += rng.exponential(1.0 / rate)
            if tt >= spec.duration_s:
                break
            if rpm[min(int(tt * fs), n - 1)] < 300:
                continue
            for j in range(1 if rng.random() > 0.35 else int(rng.integers(2, 6))):
                t0 = tt + (0 if j == 0 else rng.uniform(0.001, 0.02))
                i0 = int(t0 * fs)
                dur = rng.uniform(0.0015, 0.006)
                m = int(dur * fs)
                if i0 + m >= n:
                    continue
                amp = 0.12 * a.cavitation * rng.lognormal(0, 0.5)
                env = np.exp(-np.arange(m) / (m / 3.0))
                cav[i0:i0 + m] += amp * env * rng.standard_normal(m)
                bursts.append(round(t0, 5))
        cav += 0.04 * a.cavitation * rng.standard_normal(n)  # continuous HF hiss
        y += signal.sosfilt(hpf, cav)
        comps.append({"name": "cavitation crackle", "intensity": a.cavitation, "band_hz": [2500, 12000],
                      "n_bursts": len(bursts)})
    y += a.room * rng.standard_normal(n)
    # Fixed calibration gain (levels are comparable across clips) + soft limiter like a phone mic AGC.
    gain = 1.6
    y = 0.95 * np.tanh(y * gain / 0.95)
    return y.astype(np.float32), {"rate": fs, "components": comps, "gain": gain, "limiter": "0.95*tanh(gain*x/0.95)",
                                  "cavitation_burst_times_s": sorted(bursts)}


# --------------------------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------------------------


def _freqs(h, w):
    return sfft.fftfreq(h)[:, None].astype(np.float32), sfft.rfftfreq(w)[None, :].astype(np.float32)


def _shift_stack(F, ky, kx, dx, dy, vx, vy, h, w, blur=True):
    """Fourier shift (and motion blur) of a stack (C, h, w) given its rfft2 F."""
    ph = np.exp(-2j * np.pi * ky * dy).astype(np.complex64) * np.exp(-2j * np.pi * kx * dx).astype(np.complex64)
    if blur and (abs(vx) > 0.02 or abs(vy) > 0.02):
        ph = ph * np.sinc(kx * vx + ky * vy).astype(np.float32)
    return sfft.irfft2(F * ph[None], s=(h, w))


def _stack(col, al):
    return np.concatenate([np.moveaxis(col, -1, 0), al[None]], axis=0).astype(np.float32)


def render_clip(spec: ClipSpec, out_path: str | Path, progress: bool = True, audio: bool = True) -> dict:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    W, H = int(spec.width) // 2 * 2, int(spec.height) // 2 * 2
    fps = float(spec.fps)
    n_frames = int(round(spec.duration_s * fps))

    # motion first (needed to size margins)
    part_names = ["wall", "baseplate", "motor", "coupling", "pump", "pipe"] if spec.scene == "pump" else \
        ["wall", "base", "stand", "motor", "rotor", "guard"]
    follows = {"coupling": "motor"} if spec.scene == "pump" else {"rotor": "guard"}
    mot = simulate_motion(spec, part_names, np.random.default_rng(spec.seed + 1))
    for child, parent in follows.items():
        mot["disp"][child] = mot["disp"][parent].copy()
    mot["disp"]["wall"][:] = 0.0
    fs = mot["fs"]
    max_d = max(float(np.abs(d).max()) for d in mot["disp"].values())
    max_s = float(np.abs(mot["shake"]).max())
    margin = int(math.ceil(max_s * 1.5)) + 16

    build = build_pump_scene if spec.scene == "pump" else build_fan_scene
    scene = build(W, H, margin, np.random.default_rng(spec.seed + 2), spec.optics_sigma_px)
    if max_d > 6.0:  # sprites carry 8 px of transparent padding for the Fourier shift
        raise ValueError(f"part displacement {max_d:.1f}px exceeds sprite padding")
    bg = scene.background
    Hp, Wp = bg.shape[:2]

    # frame sample indices (frame time t_i = i/fps is the exposure centre)
    idx = np.clip(np.round(np.arange(n_frames) / fps * fs).astype(int), 0, len(mot["t"]) - 1)
    half = max(1, int(round(spec.shutter / fps * fs / 2)))
    i_lo, i_hi = np.clip(idx - half, 0, len(mot["t"]) - 1), np.clip(idx + half, 0, len(mot["t"]) - 1)

    # caches
    for sp in scene.sprites:
        sp.ky, sp.kx = _freqs(sp.h, sp.w)
        # overlap of the sprite with the padded canvas (sprites may extend past the frame edge)
        y0, x0 = max(sp.Y0, 0), max(sp.X0, 0)
        y1, x1 = min(sp.Y0 + sp.h, Hp), min(sp.X0 + sp.w, Wp)
        sp.dst = (slice(y0, y1), slice(x0, x1))
        sp.src = (slice(y0 - sp.Y0, y1 - sp.Y0), slice(x0 - sp.X0, x1 - sp.X0))
        if sp.dynamic is None:
            sp.F = sfft.rfft2(_stack(sp.color, sp.alpha), workers=-1)
    gky, gkx = _freqs(Hp, Wp)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    vign = (1.0 - 0.22 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / 2).astype(np.float32)
    nrng = np.random.default_rng(spec.seed + 3)
    noise_bank = [nrng.standard_normal((H + 64, W + 64, 3)).astype(np.float32) for _ in range(4)] \
        if spec.sensor_noise > 0 else None
    n_sub = 5 if spec.motion_blur else 1

    # audio
    wav_path = None
    audio_info = None
    if audio:
        y, audio_info = synth_audio(spec, mot, scene, np.random.default_rng(spec.seed + 4))
        y = y[: int(round(spec.duration_s * fs))]
        wav_path = out_path.with_suffix(".tmp.wav")
        wavfile.write(wav_path, fs, (y * 32767).astype(np.int16))

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{W}x{H}", "-framerate", f"{fps:g}", "-i", "-"]
    if wav_path:
        cmd += ["-i", str(wav_path), "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "96k", "-ac", "1"]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", str(spec.crf), "-pix_fmt", "yuv420p",
            *X264_EXTRA,
            "-g", str(int(round(fps))), "-movflags", "+faststart",
            "-metadata", f"comment=argonaut synthetic clip {spec.name} ({SCHEMA})", str(out_path)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    bboxes = {p: np.zeros((n_frames, 4), np.float32) for p in scene.parts}
    rest_bbox = {}
    for p, info in scene.parts.items():
        arr = np.array(info.polygon, float)
        rest_bbox[p] = np.array([arr[:, 0].min(), arr[:, 1].min(), arr[:, 0].max(), arr[:, 1].max()], np.float32)

    shake_on = bool(np.any(mot["shake"] != 0))
    vign3 = np.repeat((vign * 255.0)[..., None], 3, axis=2)
    if noise_bank is not None:
        noise_bank = [nb * np.float32(spec.sensor_noise) for nb in noise_bank]
    noise_off = nrng.integers(0, 64, (n_frames, 2))
    disp, theta, shake = mot["disp"], mot["theta"], mot["shake"]

    def render_frame(i: int) -> bytes:
        j, jl, jh = idx[i], i_lo[i], i_hi[i]
        canvas = bg.copy()
        for sp in scene.sprites:
            d = disp[sp.part]
            dx, dy = float(d[0, j]), float(d[1, j])
            vx, vy = float(d[0, jh] - d[0, jl]), float(d[1, jh] - d[1, jl])
            if sp.dynamic is not None:
                th = theta[np.linspace(jl, jh, n_sub).round().astype(int)]
                col, al = sp.dynamic(list(th))
                F = sfft.rfft2(_stack(col, al))
            else:
                F = sp.F
            out = _shift_stack(F, sp.ky, sp.kx, dx, dy, vx, vy, sp.h, sp.w, spec.motion_blur)
            a = np.clip(out[3][sp.src], 0.0, 1.0)
            c = np.clip(np.moveaxis(out[:3], 0, -1)[sp.src], 0.0, 1.0)
            roi = canvas[sp.dst]
            roi *= (1.0 - a)[..., None]
            roi += c
        if shake_on:
            sxp, syp = float(shake[0, j]), float(shake[1, j])
            svx, svy = float(shake[0, jh] - shake[0, jl]), float(shake[1, jh] - shake[1, jl])
            Fc = sfft.rfft2(np.moveaxis(canvas, -1, 0))
            canvas = np.ascontiguousarray(
                np.moveaxis(_shift_stack(Fc, gky, gkx, sxp, syp, svx, svy, Hp, Wp, spec.motion_blur), 0, -1))
        frame = cv2.multiply(np.ascontiguousarray(canvas[margin:margin + H, margin:margin + W]), vign3)
        if spec.flicker:
            frame *= np.float32(1.0 + spec.flicker * math.cos(2 * math.pi * 100.0 * i / fps))
        if noise_bank is not None:
            ox, oy = noise_off[i]
            cv2.add(frame, noise_bank[i % 4][oy:oy + H, ox:ox + W], dst=frame)
        return cv2.convertScaleAbs(cv2.max(frame, 0.0)).tobytes()

    for p in scene.parts:  # observed bounding boxes = rest bbox + part displacement + camera shake
        off = disp[p][:, idx] + shake[:, idx]
        bboxes[p][:] = rest_bbox[p][None, :] + np.stack([off[0], off[1], off[0], off[1]], -1)

    t0 = time.time()
    n_workers = max(1, min(8, (os.cpu_count() or 2) - 1))
    try:
        with ThreadPoolExecutor(n_workers) as ex:
            pending = deque()
            nxt = 0
            for i in range(n_frames):
                while nxt < n_frames and len(pending) < 3 * n_workers:
                    pending.append(ex.submit(render_frame, nxt))
                    nxt += 1
                proc.stdin.write(pending.popleft().result())
                if progress and (i % max(1, n_frames // 20) == 0 or i == n_frames - 1):
                    el = time.time() - t0
                    sys.stderr.write(f"\r[{spec.name}] frame {i + 1}/{n_frames}  {el:5.1f}s  "
                                     f"(eta {el / (i + 1) * (n_frames - i - 1):5.1f}s)")
                    sys.stderr.flush()
    finally:
        proc.stdin.close()
        rc = proc.wait()
        if wav_path and wav_path.exists():
            wav_path.unlink()
    if progress:
        sys.stderr.write("\n")
    if rc != 0:
        raise RuntimeError(f"ffmpeg failed with code {rc}")

    truth = build_truth(spec, scene, mot, idx, bboxes, rest_bbox, audio_info, out_path, W, H, n_frames, follows)
    with open(out_path.with_suffix(".json"), "w", encoding="utf-8") as f:
        json.dump(truth, f, separators=(",", ":"))
    return truth


def _r(a, nd=5):
    return np.round(np.asarray(a, dtype=float), nd).tolist()


def critical_speeds(spec: ClipSpec, extra_orders=()) -> list[dict]:
    orders = sorted({o.order for o in spec.orders} | {float(k) for m in spec.modes for k in m.coupling} | set(extra_orders))
    out = []
    for m in spec.modes:
        for k in orders:
            out.append({"order": k, "mode": m.name, "mode_f_hz": m.fn_hz, "rpm": round(60 * m.fn_hz / k, 3)})
    return sorted(out, key=lambda d: d["rpm"])


def build_truth(spec, scene, mot, idx, bboxes, rest_bbox, audio_info, out_path, W, H, n_frames, follows) -> dict:
    fps = float(spec.fps)
    parts = {}
    for p, info in scene.parts.items():
        d = mot["disp"][p][:, idx]
        parts[p] = {
            "label": info.label,
            "is_reference": info.is_reference,
            "follows": follows.get(p),
            "polygon_rest": info.polygon,
            "bbox_rest": _r(rest_bbox[p], 2),
        }
    frames_parts = {p: {"x": _r(mot["disp"][p][0, idx]), "y": _r(mot["disp"][p][1, idx]),
                        "bbox": np.round(bboxes[p], 2).tolist()} for p in scene.parts}
    sc = spec.amp_scale
    truth = {
        "schema": SCHEMA,
        "preset": spec.name,
        "description": spec.description,
        "video": out_path.name,
        "seed": spec.seed,
        "width": W,
        "height": H,
        "fps": fps,
        "n_frames": n_frames,
        "duration_s": n_frames / fps,
        "exposure_s": spec.shutter / fps,
        "frame_time": "t_i = i / fps is the centre of the exposure of frame i",
        "units": {"displacement": "px (output resolution)", "speed": "rpm", "angle": "rad"},
        "conventions": {
            "x": "+right", "y": "+down (image rows)",
            "part_displacement": "true motion of the part relative to the static wall/world",
            "observed_image_motion": "part displacement + camera shake (shake moves the wall too)",
            "phase": "component = amp * cos(order * shaft_angle + phase); shaft_angle = 0 at t = 0",
        },
        "mm_per_px": scene.mm_per_px,
        "reference_object": scene.reference_object,
        "machine": scene.machine,
        "scene": spec.scene,
        "speed_profile": asdict(spec.speed) | {"ref_rpm": spec.ref_rpm},
        "orders": [{"order": o.order, "label": o.label, "speed_exponent": o.speed_exponent, "ref_rpm": spec.ref_rpm,
                    "parts": {p: {"x": sc * v[0], "y": sc * v[1], "phase_x_deg": v[2], "phase_y_deg": v[3]}
                              for p, v in o.parts.items()}} for o in spec.orders],
        "modes": [{"name": m.name, "fn_hz": m.fn_hz, "zeta": m.zeta,
                   "shape": {p: {"x": v[0], "y": v[1], "phase_deg": v[2]} for p, v in m.shape.items()},
                   "coupling_px_static_at_ref": {str(k): {"px": sc * v[0], "phase_deg": v[1]} for k, v in m.coupling.items()},
                   "ambient_rms_px": sc * m.ambient_rms_px} for m in spec.modes],
        "criticals": critical_speeds(spec),
        "part_noise": {p: {"rms_px": sc * v[0], "band_hz": [v[1], v[2]]} for p, v in spec.part_noise.items()},
        "camera": {"shake_rms_px": spec.shake_rms_px, "shake_band_hz": list(spec.shake_band_hz),
                   "tremor_rms_px": spec.shake_tremor_px, "sensor_noise_sigma_8bit": spec.sensor_noise,
                   "shutter_fraction": spec.shutter, "motion_blur": spec.motion_blur, "flicker_100hz": spec.flicker,
                   "optics_sigma_px": spec.optics_sigma_px, "codec": f"libx264 crf {spec.crf}, yuv420p"},
        "parts": parts,
        "frames": {
            "t": _r(np.arange(n_frames) / fps, 9),
            "speed_rpm": _r(mot["rpm"][idx], 3),
            "shaft_angle_rad": _r(mot["theta"][idx], 4),
            "shake": {"x": _r(mot["shake"][0, idx]), "y": _r(mot["shake"][1, idx])},
            "modal_coordinates": {k: _r(v[idx]) for k, v in mot["modal"].items()},
            "parts": frames_parts,
        },
        "audio": audio_info,
    }
    return truth


# --------------------------------------------------------------------------------------------
# Presets
# --------------------------------------------------------------------------------------------


def _pump_modes(ambient=0.03):
    return [
        ModeSpec("skid rocking", 14.2, 0.02,
                 shape={"motor": (0.8, 0.2, 0), "pump": (1.0, 0.2, 0), "pipe": (1.3, 0.1, 0), "baseplate": (0.3, 0.05, 0)},
                 coupling={1: (0.012, 0)}, ambient_rms_px=ambient),
        ModeSpec("pipe bending", 31.0, 0.03,
                 shape={"pipe": (1.0, 0.5, 0), "pump": (0.3, 0.1, 180), "motor": (0.1, 0.0, 180)},
                 coupling={1: (0.008, 0), 2: (0.012, 0)}, ambient_rms_px=ambient),
    ]


# Amplitudes are in output pixels at 960x540 (1 px = 1 mm in these scenes). They are deliberately
# >= ~0.05 px: H.264 (even at CRF 10-16) attenuates motions below ~0.03-0.05 px by 30-70 %.
_PUMP_1X = {"motor": (0.08, 0.10, 0, 90), "pump": (0.10, 0.12, 20, 110),
            "pipe": (0.06, 0.06, 40, 130), "baseplate": (0.02, 0.02, 0, 90)}


def preset_specs(name: str) -> list[ClipSpec]:
    if name == "fan_coastdown":
        return [ClipSpec(
            name="fan_coastdown", scene="fan", fps=240, duration_s=20.0, crf=20, amp_scale=2.0,
            speed=SpeedProfile("exp_coastdown", 1476.0, 0.0, 7.0), ref_rpm=1476.0,
            orders=[
                OrderSpec(1, "1x", {"guard": (0.06, 0.02, 0, 90), "motor": (0.055, 0.02, 0, 90),
                                    "stand": (0.025, 0.008, 0, 90), "base": (0.004, 0.002, 0, 90)}),
                OrderSpec(2, "2x", {"guard": (0.04, 0.015, 30, 120), "motor": (0.035, 0.015, 30, 120)}),
                OrderSpec(5, "blade pass 5x", {"guard": (0.04, 0.04, 0, 0), "motor": (0.025, 0.02, 0, 0)}),
            ],
            modes=[
                ModeSpec("stand rocking", 14.2, 0.02,
                         shape={"guard": (1.0, 0.15, 0), "motor": (0.95, 0.12, 0), "stand": (0.45, 0.05, 0),
                                "base": (0.03, 0.0, 0)},
                         coupling={1: (0.08, 0), 2: (0.01, 0), 5: (0.004, 0)}, ambient_rms_px=0.03),
                ModeSpec("head yaw", 31.0, 0.03,
                         shape={"guard": (1.0, 0.3, 0), "motor": (0.6, 0.2, 180), "stand": (0.08, 0.0, 0)},
                         coupling={1: (0.01, 0), 2: (0.02, 0), 5: (0.005, 0)}, ambient_rms_px=0.02),
            ],
            audio=AudioSpec(order_tones={1: 0.02, 2: 0.01}, blade_pass=0.10, broadband=0.08),
            description="Pedestal fan 1476 -> 0 rpm exponential coast-down over 20 s; 5 blades; stand rocking "
                        "mode 14.2 Hz (zeta 0.02), head yaw 31 Hz (zeta 0.03). 1x crosses 14.2 Hz at 852 rpm.",
        )]
    pump_common = dict(scene="pump", fps=240, duration_s=8.0, speed=SpeedProfile("constant", 1480.0), ref_rpm=1480.0)
    if name == "pump_steady_misalignment":
        return [ClipSpec(
            name="pump_steady_misalignment", **pump_common,
            orders=[
                OrderSpec(1, "1x", dict(_PUMP_1X)),
                OrderSpec(2, "2x (misalignment, axial = x)", {"motor": (0.30, 0.08, 0, 0), "pump": (0.30, 0.08, 180, 180),
                                                             "pipe": (0.08, 0.05, 180, 180), "baseplate": (0.03, 0.0, 0, 0)}),
                OrderSpec(6, "vane pass 6x", {"pump": (0.04, 0.04, 0, 0), "pipe": (0.05, 0.04, 0, 0)}),
            ],
            modes=_pump_modes(), audio=AudioSpec(order_tones={1: 0.015, 2: 0.04}, blade_pass=0.06),
            description="Pump skid at 1480 rpm with strong 2x (misalignment) in the axial (x) direction, 180 deg "
                        "out of phase between motor and pump housings across the coupling.",
        )]
    if name == "pump_cavitation":
        return [ClipSpec(
            name="pump_cavitation", **pump_common,
            orders=[
                OrderSpec(1, "1x", dict(_PUMP_1X)),
                OrderSpec(2, "2x", {"motor": (0.04, 0.02, 0, 0), "pump": (0.04, 0.02, 0, 0)}),
                OrderSpec(6, "vane pass 6x", {"pump": (0.06, 0.06, 0, 0), "pipe": (0.08, 0.05, 0, 0)}),
            ],
            modes=_pump_modes(0.04),
            part_noise={"pipe": (0.06, 40.0, 110.0), "pump": (0.03, 40.0, 110.0)},
            audio=AudioSpec(order_tones={1: 0.015, 2: 0.01}, blade_pass=0.06, broadband=0.07, cavitation=1.0),
            description="Pump at 1480 rpm with suction-side cavitation: impulsive HF crackle in audio, raised "
                        "broadband pipe/pump vibration (40-110 Hz) and vane-pass.",
        )]
    if name == "imbalance_before_after":
        def clip(tag, f, seed):
            return ClipSpec(
                name=f"imbalance_{tag}", **pump_common, seed=seed,
                orders=[
                    OrderSpec(1, "1x (unbalance)", {"motor": (0.60 * f, 0.50 * f, 0, 90), "pump": (0.36 * f, 0.30 * f, 10, 100),
                                                    "pipe": (0.12 * f, 0.10 * f, 20, 110), "baseplate": (0.06 * f, 0.04 * f, 0, 90)}),
                    OrderSpec(2, "2x", {"motor": (0.04, 0.02, 0, 0), "pump": (0.04, 0.02, 0, 0)}),
                    OrderSpec(6, "vane pass 6x", {"pump": (0.03, 0.03, 0, 0)}),
                ],
                modes=_pump_modes(0.02), audio=AudioSpec(order_tones={1: 0.05 * f + 0.005, 2: 0.01}),
                description=f"Imbalance {tag}: 1x amplitude factor {f:.2f} (after = 85% reduction of 1x).",
            )
        return [clip("before", 1.0, 10), clip("after", 0.15, 11)]
    if name == "shake_test":
        return [ClipSpec(
            name="shake_test", scene="pump", fps=60, duration_s=10.0, speed=SpeedProfile("constant", 1480.0),
            ref_rpm=1480.0,
            orders=[OrderSpec(1, "1x", {"motor": (0.12, 0.12, 0, 90), "pump": (0.12, 0.12, 20, 110)})],
            modes=[], shake_rms_px=1.5, shake_band_hz=(0.3, 6.0), shake_tremor_px=0.15,
            audio=AudioSpec(),
            description="Hand-held camera shake (1.5 px RMS, 0.3-6 Hz, + 0.15 px tremor 8-12 Hz) over a pump with "
                        "only a small 1x (0.12 px) at 24.67 Hz; 60 fps. Tests shake cancellation using the wall.",
        )]
    raise KeyError(f"unknown preset {name!r}; choose from {PRESETS}")


PRESETS = ["fan_coastdown", "pump_steady_misalignment", "pump_cavitation", "imbalance_before_after", "shake_test"]


def _output_paths(specs: list[ClipSpec], out: str | None, default_dir: Path) -> list[Path]:
    if out is None:
        return [default_dir / f"{s.name}.mp4" for s in specs]
    p = Path(out)
    if len(specs) == 1:
        return [p]
    return [p.with_name(f"{p.stem}_{s.name.split('_')[-1]}{p.suffix or '.mp4'}") for s in specs]


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Render synthetic ground-truth vibration clips")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--preset", choices=PRESETS)
    g.add_argument("--all", action="store_true")
    ap.add_argument("--out", default=None, help="output mp4 (multi-clip presets get _before/_after suffixes)")
    ap.add_argument("--out-dir", default="data/synth")
    ap.add_argument("--fps", type=float)
    ap.add_argument("--duration", type=float)
    ap.add_argument("--width", type=int)
    ap.add_argument("--height", type=int)
    ap.add_argument("--seed", type=int)
    ap.add_argument("--crf", type=int)
    ap.add_argument("--amp-scale", type=float)
    ap.add_argument("--no-audio", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg not found on PATH")
    names = PRESETS if args.all else [args.preset]
    for name in names:
        specs = preset_specs(name)
        over = {k: v for k, v in dict(fps=args.fps, duration_s=args.duration, width=args.width, height=args.height,
                                      crf=args.crf, amp_scale=args.amp_scale).items() if v is not None}
        if args.seed is not None:
            over["seed"] = args.seed
        specs = [replace(s, **over) for s in specs]
        paths = _output_paths(specs, None if args.all else args.out, Path(args.out_dir))
        for s, p in zip(specs, paths):
            t0 = time.time()
            render_clip(s, p, progress=not args.quiet, audio=not args.no_audio)
            mb = os.path.getsize(p) / 1e6
            print(f"wrote {p} ({mb:.1f} MB) + {p.with_suffix('.json').name} in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()

"""Simulated plant: a VFD-driven centrifugal pump (or fan) with a Modbus TCP interface.

Physics (all steady-state; the only dynamics is the VFD speed ramp):

* Pump curve at rated speed N0:  H0(Q) = h0 + h1*Q - h2*Q**2            (Q in m3/h, H in m)
  Efficiency at rated speed:      eta0(Q) = eta_bep * x * (2 - x),  x = Q / Q_bep
  NPSH required at rated speed:   NPSHr0(Q) = npshr0 + npshr2 * x**2
* Affinity laws at speed ratio r = N/N0:  Q -> r*Q, H -> r**2*H, P -> r**3*P, NPSHr -> r**2*NPSHr,
  efficiency is constant along affinity parabolas, so eta(Q, r) = eta0(Q/r).
* System curve:  H_sys(Q) = H_static + (k_sys + k_throttle) * Q**2. The operating point is the
  intersection of pump curve at speed N and system curve.
* Shaft power = rho*g*Q*H/eta (finite at shut-off), motor + VFD losses -> electrical kW,
  specific energy kWh/m3 = kW / Q.
* NPSH available = (p_atm - p_vap)/(rho g) + z_suction - (k_suction + k_throttle) * Q**2.
  npsh_margin = NPSHa / NPSHr (ratio; the optimizer constraint is >= 1.3), cavitating when < 1.0.
* Vibration: every excitation order k (1x unbalance, 2x misalignment, vane/blade pass) is a
  static deflection d_k*(N/N0)**2 multiplied by the skid frequency response
  rigid + sum_m p_m / sqrt((1-r_m**2)**2 + (2*zeta_m*r_m)**2),  r_m = k*f_rot/fn_m,
  converted to velocity 2*pi*f*x and combined as RMS with hydraulic (recirculation, cavitation)
  broadband terms. Resonance bands are therefore real: speeds where k*N/60 ~ fn are bad.

Run as a Modbus TCP server:  ``uv run python -m argonaut.sim.plant --modbus-port 5020``
Print the ground-truth speed sweep: ``uv run python -m argonaut.sim.plant --sweep``
"""

from __future__ import annotations

import argparse
import asyncio
import math
import random
import threading
import time
from dataclasses import asdict, dataclass, field, replace

import numpy as np

RHO = 1000.0  # kg/m3, water
G = 9.81

# Broadband velocity RMS zone boundaries (A/B, B/C, C/D) in mm/s, ISO 10816-1 / 20816-1 style.
# Kept identical to argonaut.dsp.severity so ground truth and the DSP agree.
ISO_ZONES_MM_S = {
    "I": (0.71, 1.8, 4.5),
    "II": (1.12, 2.8, 7.1),
    "III": (1.8, 4.5, 11.2),
    "IV": (2.8, 7.1, 18.0),
}


def iso_zone(vel_mm_s_rms: float, cls: str = "I") -> str:
    ab, bc, cd = ISO_ZONES_MM_S[cls]
    if vel_mm_s_rms < ab:
        return "A"
    if vel_mm_s_rms < bc:
        return "B"
    if vel_mm_s_rms < cd:
        return "C"
    return "D"


def sdof_gain(r, zeta):
    """Magnitude of the SDOF dynamic amplification 1/sqrt((1-r^2)^2 + (2 zeta r)^2)."""
    r = np.asarray(r, dtype=float)
    return 1.0 / np.sqrt((1.0 - r**2) ** 2 + (2.0 * zeta * r) ** 2)


# --------------------------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------------------------


@dataclass
class Mode:
    name: str
    fn_hz: float
    zeta: float
    participation: float  # how strongly the measured point responds in this mode (dimensionless)


@dataclass
class PlantConfig:
    kind: str = "pump"  # "pump" | "fan"
    name: str = "Pump P-101"
    # Drive / nameplate
    rated_rpm: float = 1480.0
    min_rpm: float = 0.0
    max_rpm: float = 1800.0  # 60 Hz on a 4-pole, 50 Hz motor
    poles: int = 4
    motor_kw: float = 15.0
    motor_eta_rated: float = 0.93
    motor_fixed_loss_frac: float = 0.35  # share of rated motor losses that is speed-, not load-dependent
    vfd_eta: float = 0.975
    standby_kw: float = 0.03  # VFD electronics
    n_vanes: int = 6  # impeller vanes (pump) or blades (fan)
    machine_class: str = "I"  # ISO 10816 class used for zones
    # Machine curve at rated speed. Units: q in m3/h; h in m (pump) or Pa (fan).
    q_unit: str = "m3/h"
    h_unit: str = "m"
    h0: float = 40.0
    h1: float = 0.0
    h2: float = 0.0008
    q_bep: float = 100.0
    eta_bep: float = 0.78
    pressure_per_h: float = RHO * G  # Pa per unit of h (rho*g for a pump in metres, 1 for a fan in Pa)
    # NPSH (pump only)
    npshr0: float = 2.0
    npshr2: float = 3.0
    p_atm_head: float = 10.33  # m
    p_vap_head: float = 0.24  # m, water at 20 C
    z_suction: float = 1.5  # m, flooded suction (tank level above impeller eye)
    k_suction: float = 0.0002  # suction line friction, m/(m3/h)^2
    # System
    static_head: float = 6.0
    k_sys: float = 0.00201
    k_throttle_max: float = 0.0006  # suction-valve loss coefficient at throttle = 0.5
    # Vibration model
    modes: list[Mode] = field(
        default_factory=lambda: [
            Mode("skid rocking", 14.2, 0.02, 1.5),
            Mode("skid / pipe bending", 31.0, 0.03, 0.3),
        ]
    )
    rigid_response: float = 0.2  # non-resonant (stiffness-controlled) share of the response
    exc_um: dict = field(default_factory=lambda: {"1": 6.5, "2": 7.0, "vp": 1.9})  # static defl. at rated, um
    vel_floor_mm_s: float = 0.2
    recirc_mm_s: float = 1.5  # added broadband at very low flow (recirculation)
    cavitation_mm_s: float = 2.5  # added broadband at full cavitation
    # Rotor unbalance (drives the 1x term): residual unbalance vector in g.mm at an angle on the
    # balancing plane, the plane radius where weights are fitted, and the rotor mass (ISO 21940-11).
    unbalance_gmm: float = 2400.0  # out of tolerance: ISO 21940-11 G6.3 allows ~1000 g.mm at 1480 rpm
    unbalance_deg: float = 40.0
    balance_radius_mm: float = 120.0
    rotor_mass_kg: float = 25.0
    # VFD
    ramp_rpm_s: float = 150.0

    @property
    def has_npsh(self) -> bool:
        return self.kind == "pump"

    @classmethod
    def pump(cls, **kw) -> "PlantConfig":
        return cls(**kw)

    @classmethod
    def fan(cls, **kw) -> "PlantConfig":
        base = dict(
            kind="fan",
            name="Fan F-101",
            rated_rpm=1476.0,
            max_rpm=1500.0,
            poles=4,
            motor_kw=0.075,
            motor_eta_rated=0.60,
            vfd_eta=0.95,
            standby_kw=0.002,
            n_vanes=5,
            h_unit="Pa",
            h0=60.0,
            h1=0.0,
            h2=1.0417e-5,
            q_bep=1200.0,
            eta_bep=0.35,
            pressure_per_h=1.0,
            static_head=0.0,
            k_sys=2.509e-5,
            k_throttle_max=0.0,
            modes=[Mode("stand rocking", 14.2, 0.02, 1.5), Mode("guard / head yaw", 31.0, 0.03, 0.3)],
            exc_um={"1": 6.5, "2": 7.0, "vp": 1.9},
            recirc_mm_s=0.0,
            cavitation_mm_s=0.0,
            ramp_rpm_s=120.0,
        )
        base.update(kw)
        return cls(**base)


# --------------------------------------------------------------------------------------------
# Steady-state physics
# --------------------------------------------------------------------------------------------


def _k_throttle(cfg: PlantConfig, throttle: float) -> float:
    """Suction valve loss coefficient for throttle in [0, 1) (0 = fully open)."""
    th = min(max(throttle, 0.0), 0.98)
    return cfg.k_throttle_max * (th / (1.0 - th)) ** 2


def operating_point(cfg: PlantConfig, speed_rpm: float, throttle: float = 0.0) -> tuple[float, float]:
    """Return (Q, H) where the pump curve at speed N meets the system curve."""
    r = max(speed_rpm, 0.0) / cfg.rated_rpm
    k_tot = cfg.k_sys + (_k_throttle(cfg, throttle) if cfg.has_npsh else 0.0)
    # h0 r^2 + h1 r Q - h2 Q^2 = Hs + k Q^2  ->  (h2 + k) Q^2 - h1 r Q + (Hs - h0 r^2) = 0
    a = cfg.h2 + k_tot
    b = -cfg.h1 * r
    c = cfg.static_head - cfg.h0 * r**2
    if r <= 0 or c >= 0 and b >= 0:
        return 0.0, cfg.h0 * r**2  # cannot overcome static head: dead-headed, Q = 0
    disc = b * b - 4 * a * c
    q = max((-b + math.sqrt(max(disc, 0.0))) / (2 * a), 0.0)
    if q <= 0:
        return 0.0, cfg.h0 * r**2
    return q, cfg.static_head + k_tot * q**2


def pump_head(cfg: PlantConfig, q, speed_rpm: float):
    r = speed_rpm / cfg.rated_rpm
    q = np.asarray(q, dtype=float)
    return cfg.h0 * r**2 + cfg.h1 * r * q - cfg.h2 * q**2


def efficiency(cfg: PlantConfig, q: float, speed_rpm: float) -> float:
    r = speed_rpm / cfg.rated_rpm
    if r <= 0:
        return 0.0
    x = q / (cfg.q_bep * r)
    return max(cfg.eta_bep * x * (2.0 - x), 0.0)


def shaft_power_kw(cfg: PlantConfig, q: float, h: float, speed_rpm: float) -> float:
    """rho g Q H / eta, written as rho g H (r Q_bep) / (eta_bep (2 - x)) so it stays finite at Q = 0."""
    r = max(speed_rpm, 0.0) / cfg.rated_rpm
    if r <= 0:
        return 0.0
    x = min(q / (cfg.q_bep * r), 1.9)
    return cfg.pressure_per_h * h * (r * cfg.q_bep / 3600.0) / (cfg.eta_bep * (2.0 - x)) / 1000.0


def electrical_kw(cfg: PlantConfig, p_shaft_kw: float, speed_rpm: float) -> tuple[float, float]:
    """Return (electrical kW, combined motor*VFD efficiency)."""
    r = max(speed_rpm, 0.0) / cfg.rated_rpm
    if r <= 0:
        return cfg.standby_kw, 0.0
    load = p_shaft_kw / cfg.motor_kw
    rated_loss = cfg.motor_kw * (1.0 / cfg.motor_eta_rated - 1.0)
    a = cfg.motor_fixed_loss_frac
    motor_loss = rated_loss * (a * min(r, 1.2) ** 1.5 + (1 - a) * load**2)
    p_in = (p_shaft_kw + motor_loss) / cfg.vfd_eta + cfg.standby_kw
    return p_in, (p_shaft_kw / p_in if p_in > 0 else 0.0)


def npsh(cfg: PlantConfig, q: float, speed_rpm: float, throttle: float) -> tuple[float, float]:
    """Return (NPSH available, NPSH required) in metres."""
    r = max(speed_rpm, 1e-9) / cfg.rated_rpm
    npsha = cfg.p_atm_head - cfg.p_vap_head + cfg.z_suction - (cfg.k_suction + _k_throttle(cfg, throttle)) * q**2
    x = q / (cfg.q_bep * r)
    npshr = r**2 * (cfg.npshr0 + cfg.npshr2 * x**2)
    return npsha, npshr


def _order_value(cfg: PlantConfig, key: str) -> int:
    return cfg.n_vanes if key == "vp" else int(key)


def structural_frf(cfg: PlantConfig, f_hz):
    """Rigid + modal amplification at excitation frequency f (magnitudes of SDOF responses)."""
    f = np.asarray(f_hz, dtype=float)
    amp = np.full_like(f, cfg.rigid_response)
    for m in cfg.modes:
        amp = amp + m.participation * sdof_gain(f / m.fn_hz, m.zeta)
    return amp


def structural_frf_complex(cfg: PlantConfig, f_hz: float) -> complex:
    """Complex receptance-like FRF (rigid + modal SDOF terms): its phase is the lag a keyphasor sees."""
    h = complex(cfg.rigid_response, 0.0)
    for m in cfg.modes:
        r = f_hz / m.fn_hz
        h += m.participation / complex(1.0 - r * r, 2.0 * m.zeta * r)
    return h


def unbalance_vector(cfg: PlantConfig, added: list[tuple[float, float]] = ()) -> complex:
    """Total unbalance (g.mm, complex) = residual + sum of fitted masses (grams at the plane radius)."""
    u = cfg.unbalance_gmm * complex(math.cos(math.radians(cfg.unbalance_deg)), math.sin(math.radians(cfg.unbalance_deg)))
    for g, deg in added:
        u += g * cfg.balance_radius_mm * complex(math.cos(math.radians(deg)), math.sin(math.radians(deg)))
    return u


def one_x_vector(cfg: PlantConfig, speed_rpm: float, unbalance: complex) -> tuple[float, float]:
    """1x velocity (mm/s RMS) and phase (deg, keyphasor-referenced) for a given unbalance vector."""
    if speed_rpm <= 1.0:
        return 0.0, 0.0
    f1 = speed_rpm / 60.0
    s = (speed_rpm / cfg.rated_rpm) ** 2
    d_um = cfg.exc_um["1"] * abs(unbalance) / max(cfg.unbalance_gmm, 1e-9)
    x_um = d_um * s * float(structural_frf(cfg, f1))
    vel = 2 * math.pi * f1 * x_um / 1000.0 / math.sqrt(2)
    phase = math.degrees(math.atan2(unbalance.imag, unbalance.real)) - math.degrees(math.atan2(
        structural_frf_complex(cfg, f1).imag, structural_frf_complex(cfg, f1).real)) + 90.0  # velocity leads displacement
    return vel, phase % 360.0


def vibration(cfg: PlantConfig, speed_rpm: float, q: float, cavitation_index: float,
              unbalance_scale: float = 1.0) -> dict:
    """Predicted velocity RMS (mm/s), overall and per component."""
    if speed_rpm <= 1.0:
        return {"overall": 0.0, "components": {}}
    f1 = speed_rpm / 60.0
    s = (speed_rpm / cfg.rated_rpm) ** 2
    q_rel = q / (cfg.q_bep * speed_rpm / cfg.rated_rpm)
    comps = {}
    for key, d_um in cfg.exc_um.items():
        k = _order_value(cfg, key)
        f = k * f1
        hyd = 1.0 + 1.5 * (q_rel - 1.0) ** 2 if key == "vp" else 1.0
        if key == "1":
            d_um *= unbalance_scale  # balancing changes the 1x forcing
        x_um = d_um * s * float(structural_frf(cfg, f)) * hyd
        comps[f"{k}x"] = 2 * math.pi * f * x_um / 1000.0 / math.sqrt(2)
    run = min(speed_rpm / cfg.rated_rpm, 1.0)
    comps["floor"] = cfg.vel_floor_mm_s * run
    if cfg.recirc_mm_s and q_rel < 0.6:
        comps["recirculation"] = cfg.recirc_mm_s * (0.6 - q_rel) / 0.6 * run
    if cfg.cavitation_mm_s and cavitation_index > 0:
        comps["cavitation"] = cfg.cavitation_mm_s * cavitation_index
    overall = math.sqrt(sum(v * v for v in comps.values()))
    return {"overall": overall, "components": comps}


def evaluate(cfg: PlantConfig, speed_rpm: float, throttle: float = 0.0, unbalance_scale: float = 1.0) -> dict:
    """Full steady-state plant state at a given shaft speed (pure function)."""
    n = max(float(speed_rpm), 0.0)
    q, h = operating_point(cfg, n, throttle)
    eta = efficiency(cfg, q, n)
    p_shaft = shaft_power_kw(cfg, q, h, n)
    kw, drive_eta = electrical_kw(cfg, p_shaft, n)
    if cfg.has_npsh and n > 0:
        npsha, npshr = npsh(cfg, q, n, throttle)
        margin = npsha / max(npshr, 1e-6)
        cav_index = float(np.clip((1.3 - margin) / 0.5, 0.0, 1.0)) if q > 0 else 0.0
        cavitating = bool(margin < 1.0 and q > 0)
    else:
        npsha = npshr = margin = None
        cav_index, cavitating = 0.0, False
    vib = vibration(cfg, n, q, cav_index, unbalance_scale)
    spec = kw / q if q > 1e-6 else None
    return {
        "kind": cfg.kind,
        "speed_rpm": n,
        "q": q,
        "h": h,
        "eta": eta,
        "kw": kw,
        "shaft_kw": p_shaft,
        "drive_eta": drive_eta,
        "specific_energy": spec,  # kWh per m3 (q is m3/h, kw is kW)
        "vel_mm_s_rms": vib["overall"],
        "vel_components": vib["components"],
        "iso_zone": iso_zone(vib["overall"], cfg.machine_class),
        "npsh_margin": margin,
        "npsha_m": npsha,
        "npshr_m": npshr,
        "cavitation_index": cav_index,
        "cavitating": cavitating,
        "throttle": throttle,
        "q_unit": cfg.q_unit,
        "h_unit": cfg.h_unit,
    }


def critical_speeds(cfg: PlantConfig, orders=("1", "2", "vp"), rpm_max: float | None = None) -> list[dict]:
    """Speeds where an excitation order crosses a natural frequency (Campbell diagram criticals)."""
    rpm_max = rpm_max or cfg.max_rpm * 1.1
    out = []
    for m in cfg.modes:
        for key in orders:
            k = _order_value(cfg, key)
            rpm = 60.0 * m.fn_hz / k
            if 0 < rpm <= rpm_max:
                half_bw = m.zeta * rpm  # half-power bandwidth of the resonance in rpm
                out.append({"order": k, "mode": m.name, "mode_f_hz": m.fn_hz, "zeta": m.zeta, "rpm": rpm,
                            "half_power_band_rpm": [rpm - half_bw, rpm + half_bw]})
    return sorted(out, key=lambda d: d["rpm"])


def sweep(speeds, cfg: PlantConfig | None = None, throttle: float = 0.0) -> dict:
    """Ground-truth curves vs speed: q, h, eta, kW, specific energy, vibration, NPSH margin.

    Returns a dict of numpy arrays (None values become NaN) plus ``criticals``.
    """
    cfg = cfg or PlantConfig.pump()
    speeds = np.atleast_1d(np.asarray(speeds, dtype=float))
    rows = [evaluate(cfg, s, throttle) for s in speeds]
    keys = ["q", "h", "eta", "kw", "shaft_kw", "specific_energy", "vel_mm_s_rms", "npsh_margin",
            "cavitation_index"]
    out = {"speed_rpm": speeds}
    for k in keys:
        out[k] = np.array([np.nan if r[k] is None else r[k] for r in rows], dtype=float)
    out["cavitating"] = np.array([r["cavitating"] for r in rows], dtype=bool)
    out["iso_zone"] = [r["iso_zone"] for r in rows]
    comp_names = sorted({c for r in rows for c in r["vel_components"]})
    out["vel_components"] = {c: np.array([r["vel_components"].get(c, 0.0) for r in rows]) for c in comp_names}
    out["criticals"] = critical_speeds(cfg)
    return out


# --------------------------------------------------------------------------------------------
# Dynamic plant (VFD ramp) - thread safe
# --------------------------------------------------------------------------------------------


class Plant:
    """A VFD-driven machine. Speed follows the setpoint at a limited ramp rate (accel/decel)."""

    def __init__(self, cfg: PlantConfig | None = None, speed_rpm: float | None = None, throttle: float = 0.0,
                 noise: float = 0.0, seed: int | None = None):
        self.cfg = cfg or PlantConfig.pump()
        s = self.cfg.rated_rpm if speed_rpm is None else float(speed_rpm)
        self.speed_rpm = s
        self.setpoint_rpm = s
        self.throttle = throttle
        self.ramp_rpm_s = self.cfg.ramp_rpm_s
        self.noise = noise
        self._rng = random.Random(seed)
        self.added_masses: list[tuple[float, float]] = []   # (grams, deg) fitted on the balancing plane
        self.skip_bands: list[tuple[float, float]] = []     # VFD skip frequencies: (centre rpm, half-width rpm)
        self._lock = threading.RLock()
        self._t_last = time.monotonic()
        self.t = 0.0

    # --- control -------------------------------------------------------------------------
    def set_setpoint(self, rpm: float) -> float:
        with self._lock:
            self.update()
            rpm = float(min(max(rpm, self.cfg.min_rpm), self.cfg.max_rpm))
            for c, hw in self.skip_bands:  # a VFD never dwells inside a skip band: snap to the nearer edge
                if hw > 0 and c - hw < rpm < c + hw:
                    rpm = c - hw if rpm < c else c + hw
            self.setpoint_rpm = rpm
            return self.setpoint_rpm

    # --- balancing plane and drive parameters ---------------------------------------------
    @property
    def unbalance(self) -> complex:
        return unbalance_vector(self.cfg, self.added_masses)

    @property
    def unbalance_scale(self) -> float:
        return abs(self.unbalance) / max(self.cfg.unbalance_gmm, 1e-9)

    def fit_mass(self, grams: float, deg: float) -> None:
        with self._lock:
            self.added_masses.append((float(grams), float(deg) % 360.0))

    def remove_last_mass(self) -> None:
        with self._lock:
            if self.added_masses:
                self.added_masses.pop()

    def set_skip_bands(self, bands: list[tuple[float, float]]) -> None:
        with self._lock:
            self.skip_bands = [(float(c), float(hw)) for c, hw in bands if hw > 0][:3]
            self.set_setpoint(self.setpoint_rpm)

    def one_x(self, noisy: bool = False) -> tuple[float, float]:
        with self._lock:
            vel, ph = one_x_vector(self.cfg, self.speed_rpm, self.unbalance)
        if noisy:
            vel *= 1.0 + self._rng.gauss(0.0, 0.02)
            ph += self._rng.gauss(0.0, 2.0)
        return vel, ph % 360.0

    def set_ramp(self, rpm_per_s: float) -> None:
        with self._lock:
            self.update()
            self.ramp_rpm_s = max(float(rpm_per_s), 1.0)

    def set_throttle(self, throttle: float) -> None:
        with self._lock:
            self.throttle = float(min(max(throttle, 0.0), 0.95))

    # --- time ----------------------------------------------------------------------------
    def step(self, dt: float) -> None:
        """Advance the VFD ramp by dt seconds (simulation time)."""
        with self._lock:
            dv = self.setpoint_rpm - self.speed_rpm
            lim = self.ramp_rpm_s * dt
            self.speed_rpm += max(-lim, min(lim, dv))
            self.t += dt

    def update(self) -> None:
        """Advance to wall-clock now (used by the Modbus server)."""
        with self._lock:
            now = time.monotonic()
            dt, self._t_last = now - self._t_last, now
            if dt > 0:
                self.step(dt)

    # --- outputs -------------------------------------------------------------------------
    def state(self, noisy: bool = False) -> dict:
        with self._lock:
            st = evaluate(self.cfg, self.speed_rpm, self.throttle, self.unbalance_scale)
            st["one_x_mm_s"], st["one_x_phase_deg"] = one_x_vector(self.cfg, self.speed_rpm, self.unbalance)
            st["setpoint_rpm"] = self.setpoint_rpm
            st["ramp_rpm_s"] = self.ramp_rpm_s
            st["ramping"] = abs(self.setpoint_rpm - self.speed_rpm) > 0.5
            st["t"] = self.t
        if noisy and self.noise > 0:
            for k in ("speed_rpm", "q", "h", "kw", "vel_mm_s_rms", "one_x_mm_s"):
                st[k] = max(st[k] * (1.0 + self._rng.gauss(0.0, self.noise)), 0.0)
            st["one_x_phase_deg"] = (st["one_x_phase_deg"] + self._rng.gauss(0.0, 100 * self.noise)) % 360.0
        return st

    def sweep(self, speeds, throttle: float | None = None) -> dict:
        return sweep(speeds, self.cfg, self.throttle if throttle is None else throttle)

    def asset_card(self) -> dict:
        """Datasheet-style description (pump curve at rated speed, system curve, BEP, modes).

        The keys match ``argonaut.optimize.Twin`` (pump_curve, system) and the contract ``asset`` event.
        """
        c = self.cfg
        q = np.linspace(0.0, 1.8 * c.q_bep, 19)
        h = pump_head(c, q, c.rated_rpm)
        eta = np.array([efficiency(c, qi, c.rated_rpm) for qi in q])
        card = {
            "name": c.name,
            "kind": c.kind,
            "nameplate": {"rpm": c.rated_rpm, "kw": c.motor_kw, "poles": c.poles, "vanes_or_blades": c.n_vanes},
            "pump_curve": {"q": q.round(3).tolist(), "h": np.round(h, 4).tolist(), "eta": eta.round(4).tolist(),
                           "rated_rpm": c.rated_rpm, "q_unit": c.q_unit, "h_unit": c.h_unit},
            "bep": {"q": c.q_bep, "h": float(pump_head(c, c.q_bep, c.rated_rpm)), "eta": c.eta_bep},
            "system": {"static_head_m": c.static_head, "k": c.k_sys + (_k_throttle(c, self.throttle) if c.has_npsh else 0.0)},
            "modes": [asdict(m) for m in c.modes],
            "speed_range_rpm": [c.min_rpm, c.max_rpm],
            "machine_class": c.machine_class,
        }
        if c.has_npsh:
            card["pump_curve"]["npshr"] = [round(c.npshr0 + c.npshr2 * (qi / c.q_bep) ** 2, 4) for qi in q]
            card["npsh_available_m_at_bep"] = npsh(c, c.q_bep, c.rated_rpm, self.throttle)[0]
        return card


# --------------------------------------------------------------------------------------------
# Modbus TCP server
# --------------------------------------------------------------------------------------------

# Holding registers (FC3 read / FC6, FC16 write), 0-based addresses
HR_SPEED_SETPOINT_RPM = 0  # rpm
HR_RAMP_RPM_S = 1  # rpm/s accel/decel limit
HR_THROTTLE_PERMILLE = 2  # suction valve closure 0..950 (0 = open)
HR_BAL_MASS_CG = 3  # balancing: mass to fit, centigrams
HR_BAL_ANGLE_DEG = 4  # balancing: angle on the plane, degrees from the keyphasor mark
HR_BAL_CMD = 5  # write 1 = fit the mass, 2 = remove the last fitted mass
HR_SKIP_BASE = 6  # 3 skip bands: (centre rpm, half-width rpm) at 6/7, 8/9, 10/11
N_HR = 12

# Input registers (FC4 read), 0-based addresses
IR_SPEED_RPM = 0  # rpm
IR_FLOW_X10 = 1  # m3/h x10
IR_HEAD_X10 = 2  # m x10 (Pa x10 for a fan)
IR_KW_X100 = 3  # electrical kW x100
IR_VIB_X100 = 4  # mm/s RMS x100
IR_NPSH_MARGIN_X100 = 5  # NPSHa/NPSHr x100 (65535 = not applicable)
IR_EFF_X1000 = 6  # pump/fan efficiency x1000
IR_SPEC_ENERGY_X1000 = 7  # kWh/m3 x1000 (65535 = no flow)
IR_NPSHA_X100 = 8  # m x100
IR_NPSHR_X100 = 9  # m x100
IR_STATUS = 10  # bit0 running, bit1 ramping, bit2 cavitating, bit3 at setpoint
IR_SETPOINT_RPM = 11  # setpoint echo, rpm
IR_SHAFT_KW_X100 = 12  # shaft kW x100
IR_1X_VEL_X100 = 13  # 1x velocity mm/s RMS x100 (keyphasor-synchronous)
IR_1X_PHASE_X10 = 14  # 1x phase deg x10 from the keyphasor mark
IR_N_MASSES = 15  # balancing masses currently fitted
N_IR = 16
NA = 0xFFFF

REGISTER_MAP = {
    "holding": {
        HR_SPEED_SETPOINT_RPM: ("speed_setpoint_rpm", 1),
        HR_RAMP_RPM_S: ("ramp_rpm_s", 1),
        HR_THROTTLE_PERMILLE: ("throttle", 1000),
    },
    "input": {
        IR_SPEED_RPM: ("speed_rpm", 1),
        IR_FLOW_X10: ("q", 10),
        IR_HEAD_X10: ("h", 10),
        IR_KW_X100: ("kw", 100),
        IR_VIB_X100: ("vel_mm_s_rms", 100),
        IR_NPSH_MARGIN_X100: ("npsh_margin", 100),
        IR_EFF_X1000: ("eta", 1000),
        IR_SPEC_ENERGY_X1000: ("specific_energy", 1000),
        IR_NPSHA_X100: ("npsha_m", 100),
        IR_NPSHR_X100: ("npshr_m", 100),
        IR_STATUS: ("status", 1),
        IR_SETPOINT_RPM: ("setpoint_rpm", 1),
        IR_SHAFT_KW_X100: ("shaft_kw", 100),
        IR_1X_VEL_X100: ("one_x_mm_s", 100),
        IR_1X_PHASE_X10: ("one_x_phase_deg", 10),
        IR_N_MASSES: ("n_masses", 1),
    },
}


def _u16(value, scale: float) -> int:
    if value is None or (isinstance(value, float) and not math.isfinite(value)):
        return NA
    return int(min(max(round(value * scale), 0), NA - 1))


def encode_input_registers(st: dict) -> list[int]:
    regs = [0] * N_IR
    for addr, (key, scale) in REGISTER_MAP["input"].items():
        if key == "status":
            continue
        regs[addr] = _u16(st.get(key), scale)
    status = 0
    status |= 1 if st["speed_rpm"] > 1.0 else 0
    status |= 2 if st.get("ramping") else 0
    status |= 4 if st.get("cavitating") else 0
    status |= 8 if abs(st.get("setpoint_rpm", st["speed_rpm"]) - st["speed_rpm"]) <= 1.0 else 0
    regs[IR_STATUS] = status
    return regs


class ModbusPlantServer:
    """Serve a :class:`Plant` over Modbus TCP (pymodbus SimDevice API).

    ``await srv.serve()`` runs inside an existing event loop; ``srv.start_in_thread()`` runs it in a
    daemon thread with its own loop (handy for tests and for embedding in the FastAPI process).
    """

    def __init__(self, plant: Plant, host: str = "127.0.0.1", port: int = 5020, tick_s: float = 0.05):
        self.plant, self.host, self.port, self.tick_s = plant, host, port, tick_s
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None
        self._error: BaseException | None = None

    def _device(self):
        from pymodbus.constants import ExcCodes
        from pymodbus.simulator import DataType, SimData, SimDevice

        plant = self.plant
        hr_init = [int(plant.setpoint_rpm), int(plant.ramp_rpm_s), int(round(plant.throttle * 1000))] + [0] * (N_HR - 3)
        pending = {"cg": 0, "deg": 0}
        skip_regs = [0] * 6  # shadow of the skip-band registers: a band takes effect once its width is non-zero
        ir_init = encode_input_registers(plant.state())

        async def action(fc, start, address, count, regs, set_values):  # noqa: ARG001
            plant.update()
            if fc == 4:  # read input registers: refresh from the plant
                st = plant.state(noisy=True)
                st["n_masses"] = len(plant.added_masses)
                vals = encode_input_registers(st)
                for i, v in enumerate(vals):
                    regs[i - start] = v
                return None
            if fc == 3:  # read holding registers: reflect current setpoints
                regs[HR_SPEED_SETPOINT_RPM - start] = int(round(plant.setpoint_rpm))
                regs[HR_RAMP_RPM_S - start] = int(round(plant.ramp_rpm_s))
                regs[HR_THROTTLE_PERMILLE - start] = int(round(plant.throttle * 1000))
                extra = [pending["cg"], pending["deg"], 0] + list(skip_regs)
                for i, v in enumerate(extra):
                    reg = HR_BAL_MASS_CG + i
                    if start <= reg < start + count:
                        regs[reg - start] = v
                return None
            if set_values is not None:  # writes (FC6 / FC16)
                for i, v in enumerate(list(set_values)):
                    reg = address + i
                    if reg == HR_SPEED_SETPOINT_RPM:
                        set_values[i] = int(round(plant.set_setpoint(float(v))))
                    elif reg == HR_RAMP_RPM_S:
                        plant.set_ramp(float(v))
                        set_values[i] = int(round(plant.ramp_rpm_s))
                    elif reg == HR_THROTTLE_PERMILLE:
                        plant.set_throttle(float(v) / 1000.0)
                        set_values[i] = int(round(plant.throttle * 1000))
                    elif reg == HR_BAL_MASS_CG:
                        pending["cg"] = int(v)
                    elif reg == HR_BAL_ANGLE_DEG:
                        pending["deg"] = int(v) % 360
                    elif reg == HR_BAL_CMD:
                        if int(v) == 1:
                            plant.fit_mass(pending["cg"] / 100.0, pending["deg"])
                        elif int(v) == 2:
                            plant.remove_last_mass()
                        set_values[i] = 0
                    elif HR_SKIP_BASE <= reg < HR_SKIP_BASE + 6:
                        skip_regs[reg - HR_SKIP_BASE] = int(v)
                        plant.set_skip_bands([(skip_regs[2 * b], skip_regs[2 * b + 1]) for b in range(3)])
                    else:
                        return ExcCodes.ILLEGAL_ADDRESS
            return None

        bits = [SimData(0, values=[False] * 16, datatype=DataType.BITS)]
        return SimDevice(
            id=0,  # answer any unit id
            simdata=(
                bits,
                [SimData(0, values=[False] * 16, datatype=DataType.BITS)],
                [SimData(0, values=hr_init, datatype=DataType.UINT16)],
                [SimData(0, values=ir_init, datatype=DataType.UINT16)],
            ),
            action=action,
        )

    async def serve(self) -> None:
        from pymodbus.server import ModbusTcpServer

        server = ModbusTcpServer(self._device(), address=(self.host, self.port))
        try:
            await server.serve_forever(background=True)
            self._ready.set()
            while not self._stop.is_set():
                self.plant.update()
                await asyncio.sleep(self.tick_s)
        finally:
            await server.shutdown()

    def _run(self) -> None:
        try:
            asyncio.run(self.serve())
        except BaseException as exc:  # surfaced by start_in_thread
            self._error = exc
            self._ready.set()

    def start_in_thread(self, timeout: float = 5.0) -> "ModbusPlantServer":
        self._thread = threading.Thread(target=self._run, name="argonaut-vfd-modbus", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout):
            raise TimeoutError("Modbus server did not start")
        if self._error:
            raise RuntimeError(f"Modbus server failed: {self._error!r}")
        return self

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)


# --------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------


def _fmt(v, nd=2):
    return "  -  " if v is None or (isinstance(v, float) and math.isnan(v)) else f"{v:.{nd}f}"


def _print_sweep(cfg: PlantConfig, throttle: float) -> None:
    speeds = np.arange(300, cfg.max_rpm + 1, 50.0)
    sw = sweep(speeds, cfg, throttle)
    print(f"{cfg.name} ({cfg.kind}) throttle={throttle}")
    print(f"{'rpm':>6} {'Q':>8} {'H':>8} {'eta':>6} {'kW':>8} {'kWh/m3':>8} {'mm/s':>6} zone {'NPSHm':>6} cav")
    for i, s in enumerate(speeds):
        print(f"{s:6.0f} {_fmt(sw['q'][i], 1):>8} {_fmt(sw['h'][i], 1):>8} {_fmt(sw['eta'][i]):>6} "
              f"{_fmt(sw['kw'][i], 3):>8} {_fmt(sw['specific_energy'][i], 4):>8} {sw['vel_mm_s_rms'][i]:6.2f} "
              f"{sw['iso_zone'][i]:>4} {_fmt(sw['npsh_margin'][i]):>6} {'Y' if sw['cavitating'][i] else ''}")
    print("criticals:", ", ".join(f"{c['order']}x/{c['mode_f_hz']}Hz @ {c['rpm']:.0f} rpm" for c in sw["criticals"]))


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Simulated VFD-driven pump/fan with Modbus TCP")
    ap.add_argument("--kind", choices=["pump", "fan"], default="pump")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--modbus-port", type=int, default=5020)
    ap.add_argument("--speed", type=float, default=None, help="initial speed rpm (default rated)")
    ap.add_argument("--throttle", type=float, default=0.0, help="suction throttle 0..0.95")
    ap.add_argument("--ramp", type=float, default=None, help="VFD ramp rpm/s")
    ap.add_argument("--noise", type=float, default=0.0, help="relative measurement noise on input registers")
    ap.add_argument("--sweep", action="store_true", help="print the ground-truth speed sweep and exit")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    cfg = PlantConfig.fan() if args.kind == "fan" else PlantConfig.pump()
    if args.ramp:
        cfg = replace(cfg, ramp_rpm_s=args.ramp)
    if args.sweep:
        _print_sweep(cfg, args.throttle)
        return
    plant = Plant(cfg, speed_rpm=args.speed, throttle=args.throttle, noise=args.noise)
    srv = ModbusPlantServer(plant, args.host, args.modbus_port)

    async def run():
        task = asyncio.create_task(srv.serve())
        print(f"[plant] {cfg.name} Modbus TCP on {args.host}:{args.modbus_port}  (Ctrl+C to stop)", flush=True)
        try:
            while not task.done():
                await asyncio.sleep(1.0)
                if not args.quiet:
                    st = plant.state()
                    print(f"[plant] N={st['speed_rpm']:7.1f}/{st['setpoint_rpm']:.0f} rpm  Q={st['q']:6.1f}  "
                          f"H={st['h']:5.1f}  P={st['kw']:6.3f} kW  v={st['vel_mm_s_rms']:5.2f} mm/s ({st['iso_zone']})"
                          f"  NPSHm={_fmt(st['npsh_margin'])}{'  CAVITATING' if st['cavitating'] else ''}", flush=True)
        finally:
            srv._stop.set()
            await task

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

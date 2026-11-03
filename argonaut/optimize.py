"""Digital twin + constrained real-time optimisation of a variable-speed rotating asset.

The twin is built only from what Argonaut identified (modes with damping, order amplitudes at
the current speed, nameplate, optional pump curve). The optimiser searches the speed setpoint:

    minimise   electrical power (specific energy at fixed duty)
    subject to duty (flow) >= required fraction
               every strong excitation order outside each natural frequency band (fn ± margin)
               predicted broadband velocity in ISO zone A/B
               NPSH margin >= 1.3 (pumps, when a curve is known)
"""

from dataclasses import dataclass, field

import numpy as np

from .dsp.severity import ZONES_MM_S


@dataclass
class Twin:
    speed_rpm: float  # current operating speed
    modes: list[dict]  # [{"f_hz", "zeta"}]
    order_vel_mm_s: dict[float, float]  # measured velocity amplitude per order at current speed
    rated_rpm: float
    rated_kw: float
    machine_class: str = "I"
    min_rpm_frac: float = 0.4
    max_rpm_frac: float = 1.0
    pump_curve: dict | None = None  # {"q","h","eta","npshr","rated_rpm"}
    system: dict | None = None  # {"static_head_m", "k"} H = static + k Q^2
    npsh_available_m: float | None = None
    extra: dict = field(default_factory=dict)

    def frf(self, f_hz: np.ndarray) -> np.ndarray:
        """Dynamic amplification of the structure at excitation frequency f (sum of SDOF modes, rigid baseline 1)."""
        f = np.atleast_1d(f_hz).astype(float)
        h = np.ones_like(f, dtype=complex)
        for m in self.modes:
            r = f / m["f_hz"]
            z = m.get("zeta") or 0.03
            h += (1.0 / (1 - r**2 + 2j * z * r)) - 1.0
        return np.abs(h)

    def predict_vel(self, rpm: np.ndarray) -> np.ndarray:
        """Broadband velocity RMS (mm/s) vs speed. Imbalance-type forcing scales with speed^2;
        velocity response = forcing x amplification x (2 pi f); calibrated at the current speed."""
        rpm = np.atleast_1d(rpm).astype(float)
        total = np.zeros_like(rpm)
        for k, v_now in self.order_vel_mm_s.items():
            f_now = k * self.speed_rpm / 60
            c = v_now / ((self.speed_rpm**2) * self.frf(f_now)[0] * f_now)
            f = k * rpm / 60
            total += (c * rpm**2 * self.frf(f) * f) ** 2
        return np.sqrt(total) / np.sqrt(2)  # amplitude -> RMS

    def hydraulics(self, rpm: np.ndarray):
        """Flow fraction, electrical kW and NPSH margin vs speed (affinity laws on pump & system curves)."""
        rpm = np.atleast_1d(rpm).astype(float)
        n = rpm / self.rated_rpm
        if not self.pump_curve or not self.system:
            q_frac = rpm / self.speed_rpm  # fan/pump on a friction-only system: Q ∝ N
            kw = self.rated_kw * n**3
            return q_frac, kw, np.full_like(rpm, np.nan)
        pts = [self._pump_point(ni) for ni in n]
        q_now = self._pump_point(self.speed_rpm / self.rated_rpm)[0]
        qs, kws, npsh = (np.array(v) for v in zip(*pts))
        return qs / max(q_now, 1e-6), kws, npsh

    def _pump_point(self, ni: float):
        """Operating point at speed ratio ni: pump H = a q² + b·ni·q + c·ni² meets system H = hs + k q²."""
        pc = self.pump_curve
        q0, h0, eta0 = (np.asarray(pc[k], float) for k in ("q", "h", "eta"))
        a, b, c = np.polyfit(q0, h0, 2)
        hs, k = self.system["static_head_m"], self.system["k"]
        roots = np.roots([a - k, b * ni, c * ni**2 - hs])
        roots = roots[np.isreal(roots)].real
        q = float(roots[roots > 0].max()) if (roots > 0).any() else 0.0
        h = hs + k * q**2
        eta = float(np.interp(q / max(ni, 1e-6), q0, eta0)) if q > 0 else 0.3
        kw = 1000 * 9.81 * (q / 3600) * h / 1000 / max(eta, 0.2) / 0.9  # hydraulic kW / (eta x motor+VFD 0.9)
        npsh = np.nan
        if pc.get("npshr") and self.npsh_available_m:
            npshr = float(np.interp(q / max(ni, 1e-6), q0, np.asarray(pc["npshr"], float))) * ni**2
            npsh = self.npsh_available_m / max(npshr, 1e-3)
        return q, kw, npsh


def exclusion_bands(twin: Twin, orders=(1, 2), margin: float = 0.10, strong_frac: float = 0.15):
    """Speed bands (rpm) where a significant order excites a natural frequency within ±margin."""
    vmax = max(twin.order_vel_mm_s.values()) if twin.order_vel_mm_s else 1.0
    strong = [k for k in orders if twin.order_vel_mm_s.get(k, 0) >= strong_frac * vmax] or [1]
    bands = []
    for m in twin.modes:
        for k in strong:
            c = 60 * m["f_hz"] / k
            bands.append((c * (1 - margin), c * (1 + margin), k, m["f_hz"]))
    return sorted(bands)


def resonance_probability(twin: Twin, rpm: np.ndarray, orders=(1, 2), strong_frac: float = 0.15) -> np.ndarray:
    """P(at least one significant order k·rpm/60 falls inside a mode's half-power band), given the
    identified uncertainty of each natural frequency (fn ~ N(f_hz, f_sd)). Order f_k is inside the band
    [fn(1-ζ), fn(1+ζ)]  ⇔  fn ∈ [f_k/(1+ζ), f_k/(1-ζ)]."""
    from scipy.stats import norm

    rpm = np.atleast_1d(rpm).astype(float)
    vmax = max(twin.order_vel_mm_s.values()) if twin.order_vel_mm_s else 1.0
    strong = [k for k in orders if twin.order_vel_mm_s.get(k, 0) >= strong_frac * vmax] or [1]
    p_none = np.ones_like(rpm)
    for m in twin.modes:
        z = max(m.get("zeta") or 0.03, 0.005)
        sd = max(m.get("f_sd") or 0.02 * m["f_hz"], 1e-3)
        for k in strong:
            fk = k * rpm / 60
            p = norm.cdf((fk / (1 - z) - m["f_hz"]) / sd) - norm.cdf((fk / (1 + z) - m["f_hz"]) / sd)
            p_none *= 1 - np.clip(p, 0, 1)
    return 1 - p_none


def predict_vel_band(twin: Twin, rpm: np.ndarray, n: int = 200, seed: int = 0, q=(5, 95)):
    """Monte Carlo prediction band: sample mode frequencies and damping within their uncertainty."""
    rng = np.random.default_rng(seed)
    sims = []
    base = [dict(m) for m in twin.modes]
    for _ in range(n):
        twin.modes = [{**m, "f_hz": rng.normal(m["f_hz"], m.get("f_sd") or 0.02 * m["f_hz"]),
                       "zeta": float(np.clip(rng.lognormal(np.log(m.get("zeta") or 0.03),
                                                           (m.get("zeta_sd") or 0.3 * (m.get("zeta") or 0.03))
                                                           / (m.get("zeta") or 0.03)), 0.003, 0.5))}
                      for m in base]
        sims.append(twin.predict_vel(rpm))
    twin.modes = base
    sims = np.array(sims)
    return np.percentile(sims, q[0], axis=0), np.percentile(sims, q[1], axis=0)


def optimise(twin: Twin, duty_min_frac: float = 0.8, margin: float = 0.10, n_grid: int = 600,
             vib_weight: float = 1.0, p_res_max: float = 0.05, rpm_range: tuple[float, float] | None = None) -> dict:
    lo, hi = rpm_range or (twin.min_rpm_frac * twin.rated_rpm, twin.max_rpm_frac * twin.rated_rpm)
    rpm = np.linspace(lo, hi, n_grid)
    vel = twin.predict_vel(rpm)
    vel_lo, vel_hi = predict_vel_band(twin, rpm)
    p_res = resonance_probability(twin, rpm)
    q_frac, kw, npsh = twin.hydraulics(rpm)
    bands = exclusion_bands(twin, margin=margin)
    in_band = np.zeros_like(rpm, bool)
    for b0, b1, *_ in bands:
        in_band |= (rpm >= b0) & (rpm <= b1)
    zone_b = ZONES_MM_S[twin.machine_class][1]
    # Robust: the upper prediction bound must stay below B/C and the resonance risk below p_res_max.
    ok = (q_frac >= duty_min_frac) & ~in_band & (vel_hi < zone_b) & (p_res <= p_res_max)
    ok &= np.where(np.isnan(npsh), True, npsh >= 1.3)

    cur_i = int(np.argmin(np.abs(rpm - twin.speed_rpm)))
    curve = {"rpm": rpm.tolist(), "vel": vel.tolist(), "vel_lo": vel_lo.tolist(), "vel_hi": vel_hi.tolist(),
             "kw": kw.tolist(), "p_res": p_res.tolist()}
    current = {"speed_rpm": float(twin.speed_rpm), "vel_mm_s": float(vel[cur_i]), "kw": float(kw[cur_i])}
    feasible = _runs(rpm, ok)
    if not ok.any():
        return {"feasible": False, "current": current, "exclusion_bands_rpm": [[b[0], b[1]] for b in bands],
                "feasible_band_rpm": [], "reason": "no speed satisfies duty, resonance and severity constraints",
                "curve": curve, "risk": {"p_res_current": float(p_res[cur_i]), "threshold": p_res_max}}
    # Energy-first objective with a severity penalty: J = kW/kW_now · (1 + w · v/v_B/C).
    J = np.where(ok, kw / max(current["kw"], 1e-9) * (1 + vib_weight * vel / zone_b), np.inf)
    j = int(np.argmin(J))
    proposed = {"speed_rpm": float(rpm[j]), "vel_mm_s": float(vel[j]), "kw": float(kw[j]),
                "vel_lo": float(vel_lo[j]), "vel_hi": float(vel_hi[j])}
    constraints = [
        {"name": "resonance margin", "value": f"≥{int(margin * 100)}% from "
         + ", ".join(f"{(b[0] + b[1]) / 2:.0f} rpm ({b[2]}× on {b[3]:.1f} Hz)" for b in bands) if bands else "no modes",
         "ok": True},
        {"name": "duty (flow)", "value": f"{q_frac[j] * 100:.0f}% of current (min {duty_min_frac * 100:.0f}%)", "ok": True},
        {"name": f"ISO zone (class {twin.machine_class}), 95% bound", "value": f"{vel_hi[j]:.2f} mm/s < {zone_b} (B/C)", "ok": True},
        {"name": "P(resonance)", "value": f"{100 * p_res[j]:.1f}% ≤ {100 * p_res_max:.0f}%", "ok": True},
    ]
    if not np.isnan(npsh[j]):
        constraints.append({"name": "NPSH margin", "value": f"{npsh[j]:.2f} (min 1.3)", "ok": True})
    return {
        "feasible": True, "objective": "min electrical power at required duty",
        "current": current, "proposed": proposed, "constraints": constraints,
        "feasible_band_rpm": feasible, "exclusion_bands_rpm": [[b[0], b[1]] for b in bands],
        "expected": {"vibration_change_pct": round(float(100 * (vel[j] / current["vel_mm_s"] - 1)), 1),
                     "energy_change_pct": round(float(100 * (kw[j] / current["kw"] - 1)), 1)},
        "curve": curve,
        "risk": {"p_res_current": float(p_res[cur_i]), "p_res_proposed": float(p_res[j]), "threshold": p_res_max},
    }


def _runs(x: np.ndarray, mask: np.ndarray) -> list[list[float]]:
    runs, start = [], None
    for i, m in enumerate(mask):
        if m and start is None:
            start = i
        if (not m or i == len(mask) - 1) and start is not None:
            end = i if m else i - 1
            runs.append([float(x[start]), float(x[end])])
            start = None
    return runs

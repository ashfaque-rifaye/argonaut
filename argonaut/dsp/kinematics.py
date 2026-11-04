"""Machine kinematics -> forcing-frequency model, Bayesian running-speed inference and fault inference.

A spectrum on its own is ambiguous: a comb of lines every 12.5 Hz is a 750 rpm machine's integer orders
*or* a 1500 rpm four-stroke engine's half orders. The kinematic model (what the machine is, read by
Muse Spark: engine stroke and cylinders, poles, blade/vane count, gear teeth, bearing geometry) says
which lines a machine *can* produce. Everything below is deterministic and auditable:

* ``order_lines``      forcing lines as multiples of shaft speed (shaft orders, half orders, blade pass,
                       gear mesh, bearing defect orders).
* ``detect_line_hz``   electrical frequency from the 2 x f_line magnetostriction / electromagnetic comb.
* ``speed_posterior``  p(f_shaft | peaks, kinematics): a Bayesian harmonic sieve. Each spectral peak is
                       either explained by one of the M lines the hypothesis predicts (Gaussian
                       tolerance from bin width and speed wander) or is background (uniform). The 1/M
                       factor is an Occam penalty, so a lower fundamental that "explains everything"
                       with twice as many lines loses unless the data need it. Priors come from physics
                       (synchronous speed and slip, generator poles), never from the display we
                       validate against.
* ``fault_posterior``  per-hypothesis log-odds evidence accumulation (naive Bayes with likelihood
                       ratios). Every feature, value and weight of evidence (decibans) is reported, and
                       hypotheses without the evidence they need are marked not evaluable instead of
                       guessed. Speed uncertainty is propagated by mixing over the speed-posterior modes.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np
from scipy.special import expit

from . import spectral

MACHINES = ("induction_motor", "fan", "centrifugal_pump", "gear_pump", "genset", "engine", "washer",
            "gearbox", "wind_turbine", "structure", "generic")
INDUCTION_DRIVEN = {"induction_motor", "fan", "centrifugal_pump", "gear_pump", "gearbox"}
POLE_PRIOR = {2: 0.30, 4: 0.40, 6: 0.15, 8: 0.10, 10: 0.03, 12: 0.02}          # installed induction motors
GEN_POLE_PRIOR = {2: 0.12, 4: 0.68, 6: 0.12, 8: 0.08}                          # diesel gensets (1500/1800 rpm dominate)
LN10 = np.log(10.0)


@dataclass
class Kinematics:
    machine: str = "generic"
    line_hz: float | None = None          # mains / generator electrical frequency, if known
    poles: int | None = None
    synchronous: bool = False             # synchronous machine: shaft = 2 f_line / poles exactly
    blades: int | None = None             # fan blades / impeller vanes / gear-pump teeth
    cylinders: int | None = None
    stroke: int | None = None             # 2 or 4 (engines)
    gear_teeth: list[int] = field(default_factory=list)  # [driver, driven]
    bearing: dict | None = None           # {"n": balls, "d": ball dia, "D": pitch dia, "phi_deg": contact angle}
    rated_rpm: float | None = None        # nameplate
    display_rpm: float | None = None      # read off a controller / tachometer display: validation only
    source: str = "default"

    @property
    def four_stroke(self) -> bool:
        return self.machine in ("engine", "genset") and (self.stroke or 4) == 4

    @classmethod
    def from_scene(cls, scene: dict | None, nameplate: dict | None = None) -> "Kinematics":
        """Build from Muse Spark's scene JSON (`kinematics` block) plus the nameplate it read."""
        k = (scene or {}).get("kinematics") or {}
        n = nameplate or {}
        pos = lambda v: v if isinstance(v, (int, float)) and v > 0 else None  # noqa: E731
        machine = k.get("machine_class") if k.get("machine_class") in MACHINES else "generic"
        teeth = [int(t) for t in (k.get("gear_teeth") or []) if isinstance(t, (int, float)) and t > 0][:2]
        return cls(machine=machine, line_hz=pos(k.get("line_hz")), poles=int(pos(k.get("poles") or n.get("poles")) or 0) or None,
                   synchronous=bool(k.get("synchronous")) or machine == "genset",
                   blades=int(pos(n.get("blades_or_vanes")) or 0) or None,
                   cylinders=int(pos(k.get("cylinders")) or 0) or None, stroke=int(pos(k.get("stroke")) or 0) or None,
                   gear_teeth=teeth, rated_rpm=pos(n.get("rpm")), display_rpm=pos(k.get("display_rpm")),
                   source="muse-spark" if k else "nameplate" if n else "default")

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------------- forcing model
def bearing_orders(n: int, d: float, D: float, phi_deg: float = 0.0) -> dict:
    """Rolling-element defect frequencies as multiples of shaft speed (inner race rotating).

    BPFO = n/2 (1 - d/D cos phi), BPFI = n/2 (1 + d/D cos phi), FTF = 1/2 (1 - d/D cos phi),
    BSF = D/(2d) (1 - (d/D cos phi)^2)."""
    c = d / D * np.cos(np.radians(phi_deg))
    return {"BPFO": n / 2 * (1 - c), "BPFI": n / 2 * (1 + c), "FTF": 0.5 * (1 - c), "BSF": D / (2 * d) * (1 - c * c)}


FAMILY_WEIGHT = {"shaft": 1.0, "half_order": 0.7, "firing": 0.5, "blade_pass": 1.5, "gear_mesh": 1.0,
                 "shaft_out": 0.3, "bearing": 0.3}


def order_lines(kin: Kinematics, max_order: float = 40.0) -> list[dict]:
    """Every line the machine can produce, as a multiple (order) of shaft speed, by family. Families
    can share an order (a 4-stroke engine's firing order is also a shaft harmonic): the speed sieve
    treats each family as its own comb with its own Occam factor."""
    lines: dict[tuple, dict] = {}

    def add(order: float, family: str, label: str):
        o = round(float(order), 4)
        if 0 < o <= max_order and (family, o) not in lines:
            lines[(family, o)] = {"order": o, "family": family, "label": label}

    for k in range(1, int(max_order) + 1):
        add(k, "shaft", f"{k}×")
    if kin.four_stroke:
        for k in np.arange(0.5, max_order, 1.0):
            add(k, "half_order", f"{k:g}×")
    if kin.machine in ("engine", "genset") and kin.cylinders:
        fo = kin.cylinders / 2 if kin.four_stroke else kin.cylinders
        for h in range(1, int(max_order / fo) + 1):
            add(h * fo, "firing", f"{h * fo:g}× (firing{'' if h == 1 else f' ×{h}'})")
    if kin.blades:
        for h in range(1, int(max_order / kin.blades) + 1):
            add(h * kin.blades, "blade_pass", f"{h}×BPF ({h * kin.blades}×)")
    if len(kin.gear_teeth) == 2:
        z1, z2 = kin.gear_teeth
        for h in range(1, int(max_order / z1) + 1):
            add(h * z1, "gear_mesh", f"{h}×GMF")
        add(z1 / z2, "shaft_out", "output shaft 1×")
    if kin.bearing:
        b = kin.bearing
        for name, o in bearing_orders(b["n"], b["d"], b["D"], b.get("phi_deg", 0.0)).items():
            for h in (1, 2):
                add(h * o, "bearing", f"{h if h > 1 else ''}{name}")
    return sorted(lines.values(), key=lambda l: (l["order"], -FAMILY_WEIGHT[l["family"]]))


def detect_line_hz(f: np.ndarray, a: np.ndarray, tol: float = 0.03) -> dict | None:
    """Electrical frequency from the even-harmonic comb 2f, 4f, 6f... (magnetostriction and
    electromagnetic forces act at twice line frequency). Searches 50 and 60 Hz +/- 3 % (an off-grid
    generator drifts), returns the refined frequency and the comb's prominence in dB."""
    best = None
    df = f[1] - f[0]
    for nominal in (50.0, 60.0):
        cands = np.arange(nominal * (1 - tol), nominal * (1 + tol), df / 4)
        scores = []
        for fl in cands:
            s = 0.0
            for h in (2, 4, 6, 8):
                fc = h * fl
                if fc > f[-1]:
                    break
                w = (f > fc * 0.9) & (f < fc * 1.1)
                if w.sum() < 8:
                    continue
                pk = np.interp(fc, f, a)
                s += 20 * np.log10(pk / (np.median(a[w]) + 1e-12) + 1e-12)
            scores.append(s / 4)
        i = int(np.argmax(scores))
        if best is None or scores[i] > best["prominence_db"]:
            best = {"line_hz": float(cands[i]), "nominal_hz": nominal, "prominence_db": float(scores[i])}
    return best if best and best["prominence_db"] >= 6.0 else None


# ---------------------------------------------------------------------------------- speed inference
def _log_prior(grid: np.ndarray, kin: Kinematics, line: dict | None) -> tuple[np.ndarray, str]:
    lg = np.log(grid)
    flat = np.zeros_like(grid)
    fl = (line or {}).get("line_hz") or kin.line_hz
    if kin.rated_rpm:
        mu = np.log(kin.rated_rpm / 60)
        return np.logaddexp(np.log(0.9) - 0.5 * ((lg - mu) / 0.04) ** 2, np.log(0.1) + flat), "nameplate rpm (±4 %)"
    if fl and (kin.synchronous or kin.machine == "genset"):
        poles = {kin.poles: 1.0} if kin.poles else GEN_POLE_PRIOR
        # a measured line (the audio's 2f comb) pins the speed to 0.4 %; a nominal 50/60 Hz read off a
        # frame does not: an off-grid generator drifts by a few per cent with load and governor droop
        rel = 0.004 if (line or {}).get("line_hz") else 0.03
        sd = rel * 2 * fl / np.array(list(poles))
        comp = [np.log(w) - 0.5 * ((grid - 2 * fl / p) / sdp) ** 2 - np.log(np.sqrt(2 * np.pi) * sdp)
                for (p, w), sdp in zip(poles.items(), sd)]
        flat_pdf = -np.log(np.log(grid[-1] / grid[0])) - lg
        return np.logaddexp(np.log(0.9) + np.logaddexp.reduce(comp, axis=0), np.log(0.1) + flat_pdf), \
            f"synchronous machine at {fl:.2f} Hz{' (measured)' if rel < 0.01 else ' ±3 % (nominal)'}, poles {'%d' % kin.poles if kin.poles else '2-8 (genset prior)'}"
    if fl and kin.machine in INDUCTION_DRIVEN:
        poles = {kin.poles: 1.0} if kin.poles else POLE_PRIOR
        comp = []
        for p, w in poles.items():
            fs = 2 * fl / p
            slip = (fs - grid) / fs  # soft-edged uniform on 0-6 % slip
            inside = expit((slip + 0.002) / 0.002) * expit(-(slip - 0.06) / 0.004)
            comp.append(np.log(w / (0.06 * fs) + 1e-300) + np.log(inside + 1e-300))
        # a bare motor is almost always on-line; fans, pumps and gearboxes are often VFD- or belt-driven
        p_flat = 0.05 if kin.machine == "induction_motor" else 0.5
        flat_pdf = -np.log(np.log(grid[-1] / grid[0])) - lg      # normalised flat-in-log density per Hz
        return np.logaddexp(np.log(1 - p_flat) + np.logaddexp.reduce(comp, axis=0), np.log(p_flat) + flat_pdf), \
            f"induction slip 0-6 % at {fl:.0f} Hz, poles {'%d' % kin.poles if kin.poles else '2-12 (installed-base prior)'}"
    return flat, "scale-invariant (flat in log f)"


def speed_posterior(f: np.ndarray, a: np.ndarray, kin: Kinematics, f_range=(3.0, 120.0), band=(10.0, 1500.0),
                    n_peaks: int = 18, rel_sigma: float = 0.004, pi: float = 0.8, line: dict | None = None) -> dict | None:
    """p(f_shaft | spectrum, kinematics) on a log grid. Returns the posterior, its modes with
    probability mass, the MAP with a 68 % credible interval and which peaks the MAP explains."""
    band = (band[0], min(band[1], float(f[-1])))
    pk = [p for p in spectral.find_peaks(f, a, n=n_peaks * 2, fmin=band[0], rel_prom=0.04) if p["f_hz"] <= band[1]]
    fl = (line or {}).get("line_hz") or kin.line_hz
    masked = []
    if fl and not (kin.synchronous or kin.machine == "genset"):
        # induction machines: line-frequency multiples (1x, 2x hum, 3x...) are electrical, not shaft orders
        keep = [p for p in pk if min(abs(p["f_hz"] - h * fl) for h in range(1, 31)) > max(0.6, 0.004 * p["f_hz"])]
        masked = [round(p["f_hz"], 2) for p in pk if p not in keep]
        pk = keep
    pk = sorted(pk, key=lambda p: -p["amp"])[:n_peaks]
    if len(pk) < 3:
        return None
    fi = np.array([p["f_hz"] for p in pk])
    ai = np.array([p["amp"] for p in pk])
    w = np.sqrt(ai / ai.max())
    df = float(f[1] - f[0])
    # every hypothesis must predict lines across the whole band, or a low fundamental whose comb stops
    # early would concentrate its density where the peaks are and win for the wrong reason
    lines = order_lines(kin, max_order=band[1] / f_range[0] + 1)
    fams = sorted({l["family"] for l in lines})
    wf = np.array([FAMILY_WEIGHT[fm] for fm in fams])
    wf = wf / wf.sum()
    fam_orders = [np.array([l["order"] for l in lines if l["family"] == fm]) for fm in fams]
    grid = np.geomspace(f_range[0], f_range[1], 2400)
    B = band[1] - band[0]
    loglik = np.empty_like(grid)
    for s in range(0, len(grid), 200):  # chunked: (chunk, lines, peaks) stays a few MB
        dens = np.zeros((len(grid[s:s + 200]), len(fi)))
        for wk, orders in zip(wf, fam_orders):
            L = orders[None, :] * grid[s:s + 200, None]                      # this family's line frequencies
            in_band = (L >= band[0]) & (L <= band[1])
            M = in_band.sum(1)
            sig = np.sqrt((df / 2) ** 2 + (rel_sigma * L) ** 2)
            # Gaussian mass of each peak on each in-band line, averaged over the family's M lines:
            # the Occam factor that stops a dense comb from "explaining everything" for free
            g = np.exp(-0.5 * ((fi[None, None, :] - L[:, :, None]) / sig[:, :, None]) ** 2) / (np.sqrt(2 * np.pi) * sig[:, :, None])
            dens += wk * (g * in_band[:, :, None]).sum(1) / np.maximum(M, 1)[:, None] * (M > 0)[:, None]
        loglik[s:s + 200] = (w[None, :] * np.log(pi * dens + (1 - pi) / B)).sum(1)
    logpri, prior_desc = _log_prior(grid, kin, line)
    lp = loglik + logpri
    post = np.exp(lp - lp.max())
    post /= post.sum()

    # modes: mass within +/-2.5 % of each local maximum
    lg = np.log(grid)
    modes = []
    for i in np.argsort(post)[::-1]:
        if any(abs(lg[i] - np.log(m["f_hz"])) < 0.05 for m in modes):
            continue
        mass = float(post[np.abs(lg - lg[i]) < 0.025].sum())
        if mass < 0.01:
            break
        modes.append({"f_hz": float(grid[i]), "rpm": float(grid[i] * 60), "p": mass})
        if len(modes) >= 4:
            break
    total = sum(m["p"] for m in modes) or 1.0
    for m in modes:
        m["p"] = m["p"] / total
    top = modes[0]
    for m in modes[1:]:
        r = m["f_hz"] / top["f_hz"]
        for q, name in ((2, "2×"), (0.5, "½×"), (3, "3×"), (1 / 3, "⅓×"), (1.5, "3/2×"), (2 / 3, "2/3×")):
            if abs(r / q - 1) < 0.03:
                m["relation"] = name
    near = np.abs(lg - np.log(top["f_hz"])) < 0.025
    cdf = np.cumsum(post[near]) / post[near].sum()
    g = grid[near]
    ci = (float(g[np.searchsorted(cdf, 0.16)] * 60), float(g[min(np.searchsorted(cdf, 0.84), len(g) - 1)] * 60))

    # which peaks the MAP explains
    fmap = top["f_hz"]
    explained = []
    for p in sorted(pk, key=lambda p: p["f_hz"]):
        ln = min(lines, key=lambda l: abs(l["order"] * fmap - p["f_hz"]))
        s = np.sqrt((df / 2) ** 2 + (rel_sigma * ln["order"] * fmap) ** 2)
        explained.append({"f_hz": p["f_hz"], "amp": p["amp"] / ai.max(),
                          "line": ln["label"] if abs(ln["order"] * fmap - p["f_hz"]) < 2.5 * s else None,
                          "family": ln["family"] if abs(ln["order"] * fmap - p["f_hz"]) < 2.5 * s else None})
    sel = np.linspace(0, len(grid) - 1, 360).astype(int)
    out = {"grid_rpm": (grid[sel] * 60).tolist(), "post": (post[sel] / post[sel].max()).tolist(),
           "modes": modes, "map_hz": fmap, "map_rpm": fmap * 60, "ci68_rpm": ci, "p_map": top["p"],
           "ambiguous": top["p"] < 0.8, "prior": prior_desc, "peaks": explained, "masked_electrical_hz": masked,
           "n_explained": sum(1 for e in explained if e["line"]), "n_peaks": len(explained)}
    if kin.display_rpm:
        out["display_rpm"] = kin.display_rpm
        out["display_error_pct"] = 100 * (fmap * 60 - kin.display_rpm) / kin.display_rpm
    return out


# ---------------------------------------------------------------------------------- fault inference
def order_amps(f: np.ndarray, a: np.ndarray, shaft_hz: float, orders) -> dict:
    """Amplitude and SNR (dB over the local median) at k x shaft for each order."""
    df = f[1] - f[0]
    out = {}
    for k in orders:
        fc = k * shaft_hz
        if fc <= f[0] or fc >= f[-1]:
            continue
        hw = max(1.5 * df, 0.006 * fc)
        sel = (f >= fc - hw) & (f <= fc + hw)
        loc = (f >= fc * 0.85) & (f <= fc * 1.15)
        amp = float(a[sel].max()) if sel.any() else 0.0
        noise = float(np.median(a[loc])) + 1e-12
        out[float(k)] = {"amp": amp, "snr_db": float(20 * np.log10(amp / noise + 1e-12))}
    return out


def _clip(v, lo, hi):
    return float(min(hi, max(lo, v)))


def _ev(feature: str, value, llr: float, note: str) -> dict:
    return {"feature": feature, "value": value, "llr": llr, "db": 10 * llr / LN10, "note": note}


def _hypotheses(ctx: dict, shaft_hz: float) -> list[dict]:
    kin: Kinematics = ctx["kin"]
    fa, aa = ctx.get("audio_f"), ctx.get("audio_a")
    vo = ctx.get("video_orders") or {}
    aud = order_amps(fa, aa, shaft_hz, [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10]) if fa is not None else {}
    H = []

    # 1x / 2x / 3x amplitudes: video (structural displacement) preferred, audio as fallback
    if vo.get(1):
        a1, a2, a3, src = vo.get(1, 0), vo.get(2, 0), vo.get(3, 0), "video"
    else:
        # Microphone order ratios are not structural vibration (an engine's or fan's 1x is acoustically
        # quiet whatever its imbalance), so imbalance / misalignment need the camera to resolve 1x-2x.
        a1 = a2 = a3 = 0.0
        src = None
    tot = a1 + a2 + a3 + 1e-12

    # imbalance
    ev = []
    if src:
        s1 = a1 / tot
        ev.append(_ev("1× share of 1-3×", round(s1, 3), _clip(6 * (s1 - 0.55), -2.5, 2.5),
                      f"{src}: imbalance concentrates vibration at 1× (radial, once per revolution)"))
    if src == "video" and ctx.get("scale_calibrated"):
        ev.append(_ev("1× velocity (mm/s rms)", round(a1, 2), _clip(1.5 * np.log(max(a1, 1e-3) / 1.8), -2.0, 2.0),
                      "absolute 1× level against the ISO 20816 zone A/B boundary (calibrated scale only)"))
    H.append({"id": "imbalance", "title": "Mass imbalance", "prior": 0.15, "evidence": ev})

    # misalignment
    ev = []
    r21 = a2 / a1 if a1 > 0 else 0.0
    ph = ctx.get("phase_2x_deg")
    if src and a1 > 0:
        cap = 1.5 if ph is not None else 1.0  # without phase, a high 2x is as much looseness or noise
        ev.append(_ev("2×/1× amplitude ratio", round(r21, 3), _clip(2.0 * np.log(max(r21, 1e-3) / 0.45), -2.0, cap),
                      f"{src}: misalignment raises 2× (often > 50 % of 1×); on its own also looseness or noise, so capped"))
    if ph is not None:
        d = abs(((ph + 180) % 360) - 180)
        ev.append(_ev("2× phase across coupling", round(d, 1), _clip(2.5 * (d - 90) / 90, -2.5, 2.5),
                      "≈180° across the coupling at 2× is the misalignment signature"))
    H.append({"id": "misalignment", "title": "Shaft misalignment", "prior": 0.10, "evidence": ev})

    # looseness / rub
    ev = []
    if aud:
        n_h = sum(1 for k in range(1, 11) if aud.get(float(k), {}).get("snr_db", 0) > 10)
        ev.append(_ev("shaft harmonics 1-10× above 10 dB", n_h, _clip(0.55 * (n_h - 5), -2.0, 2.5),
                      "mechanical looseness produces a long series of shaft harmonics"))
        if not kin.four_stroke:
            hs = max(aud.get(0.5, {}).get("snr_db", 0), aud.get(1.5, {}).get("snr_db", 0), aud.get(2.5, {}).get("snr_db", 0))
            ev.append(_ev("half-order lines (dB)", round(hs, 1), _clip((hs - 8) / 4, -1.0, 2.0),
                          "½× series on a non-engine machine suggests looseness or rub"))
    H.append({"id": "looseness", "title": "Mechanical looseness", "prior": 0.08, "evidence": ev})

    # resonance: only modes identified independently of the forcing count (a damped fit from a speed
    # sweep, or an FDD structural mode). In steady state a peak at k x speed cannot be told apart from
    # forced response, so it is not evidence either way: the remedy is a coast-down.
    ev = []
    sweep = ctx.get("sweep_frac") or 0.0
    forcing = [shaft_hz, 2 * shaft_hz] + ([kin.blades * shaft_hz] if kin.blades else [])
    modes = [m for m in (ctx.get("modes") or []) if m.get("f_hz") and m.get("zeta")]
    modes += [m for m in (ctx.get("fdd_modes") or []) if str(m.get("kind", "")).startswith("structural")]
    if sweep > 0.25:
        crit = [c for c in (ctx.get("criticals") or []) if c.get("rpm")]
        if crit:
            z = min((m.get("zeta") or 0.05) for m in modes) if modes else 0.05
            q = 1 / (2 * max(z, 1e-3))
            ev.append(_ev("critical speed inside the swept range (Q)", round(q, 1), _clip(0.12 * q, 0.5, 3.0),
                          f"the run-up/coast-down crosses {', '.join(f'{c['rpm']:.0f}' for c in crit[:3])} rpm; "
                          "amplification Q = 1/(2ζ)"))
        else:
            ev.append(_ev("critical speed inside the swept range", 0, -1.5, "no order line crossed an identified mode"))
    elif modes:
        m = min(abs(fo - md["f_hz"]) / md["f_hz"] for fo in forcing for md in modes)
        ev.append(_ev("forcing-to-mode separation", round(m, 3), _clip(3.0 - 18.0 * m, -1.5, 3.0),
                      "a 1×/2×/blade-pass line within ±5-10 % of an independently identified natural frequency"))
    H.append({"id": "resonance", "title": "Resonance (natural frequency in the operating range)", "prior": 0.12, "evidence": ev})

    # cavitation (pumps)
    ev = []
    cav = ctx.get("cavitation")
    if cav is not None and kin.machine in ("centrifugal_pump", "gear_pump", "generic"):
        c = cav.get("index", cav) if isinstance(cav, dict) else cav
        ev.append(_ev("cavitation index (HF crackle)", round(float(c), 3), _clip(8 * (float(c) - 0.35), -3.0, 4.0),
                      "vapour-bubble collapse: impulsive broadband HF energy (kurtosis + HF fraction)"))
    H.append({"id": "cavitation", "title": "Pump cavitation", "prior": 0.08, "evidence": ev})

    # blade / vane pass
    ev = []
    if kin.blades and fa is not None:
        bp = order_amps(fa, aa, shaft_hz, [kin.blades]).get(float(kin.blades), {})
        a1a = aud.get(1.0, {}).get("amp", 0) or 1e-9
        if bp:
            r = bp["amp"] / a1a
            ev.append(_ev("BPF / 1× (audio)", round(r, 2), _clip(1.5 * np.log(max(r, 1e-3) / 4), -1.5, 2.0),
                          "strong blade/vane pass: off-design flow, recirculation or tip-gap problems"))
    H.append({"id": "flow", "title": "Blade/vane-pass excitation (off-design flow)", "prior": 0.10, "evidence": ev})

    # electrical: pole-pass sidebands (induction motors)
    ev = []
    fl = ctx.get("line_hz")
    if fl and kin.machine in INDUCTION_DRIVEN and ctx.get("audio_hi") is not None:
        fh, ah = ctx["audio_hi"]
        p = kin.poles or min(POLE_PRIOR, key=lambda pp: abs(2 * fl / pp - shaft_hz) if 2 * fl / pp >= shaft_hz else 1e9)
        fs = 2 * fl / p
        if fs > shaft_hz and (fs - shaft_hz) / fs < 0.08 and (fh[1] - fh[0]) < (fs - shaft_hz) * p / 3:
            fpp = (fs - shaft_hz) * p
            car = order_amps(fh, ah, shaft_hz, [1]).get(1.0, {}).get("amp", 0)
            sb = max(order_amps(fh, ah, shaft_hz + s * fpp, [1]).get(1.0, {}).get("amp", 0) for s in (-1, 1))
            if car > 0:
                L = 20 * np.log10(sb / car + 1e-12)
                ev.append(_ev("pole-pass sidebands at 1×±f_pp (dB)", round(L, 1), _clip((L + 48) / 5, -2.0, 3.0),
                              f"f_pp = poles × slip freq = {fpp:.2f} Hz; sidebands within ~35-45 dB of 1× indicate rotor-bar defects"))
    H.append({"id": "rotor_bar", "title": "Rotor-bar / electrical asymmetry", "prior": 0.05, "evidence": ev})

    # combustion (engines): half orders relative to firing order
    ev = []
    if kin.four_stroke and aud:
        firing = (kin.cylinders or 0) / 2
        ref = aud.get(float(firing), {}).get("amp") if firing else max((v["amp"] for k, v in aud.items() if k == int(k)), default=0)
        half = max(aud.get(0.5, {}).get("amp", 0), aud.get(1.5, {}).get("amp", 0))
        if ref:
            r = half / ref
            ev.append(_ev("½-order / firing-order ratio", round(r, 3), _clip(2 * np.log(max(r, 1e-3) / 0.35), -2.0, 3.0),
                          "one weak cylinder repeats once per cycle (2 revolutions): energy at ½× and 1½×"))
    H.append({"id": "combustion", "title": "Cylinder-to-cylinder combustion imbalance", "prior": 0.10, "evidence": ev})

    # bearing defect: only with geometry
    ev = []
    if kin.bearing and ctx.get("envelope") is not None:
        fe, ae = ctx["envelope"]
        bo = bearing_orders(kin.bearing["n"], kin.bearing["d"], kin.bearing["D"], kin.bearing.get("phi_deg", 0.0))
        best = max(order_amps(fe, ae, shaft_hz, [bo[k]]).get(float(bo[k]), {}).get("snr_db", 0) for k in ("BPFO", "BPFI"))
        ev.append(_ev("envelope line at BPFO/BPFI (dB)", round(best, 1), _clip((best - 8) / 3, -2.0, 3.0),
                      "rolling-element defects modulate HF resonance at the defect frequency"))
    H.append({"id": "bearing", "title": "Rolling-element bearing defect", "prior": 0.08, "evidence": ev})
    return H


def fault_posterior(ctx: dict, speed_modes: list[dict]) -> list[dict]:
    """Posterior probability per fault hypothesis, mixed over the speed-posterior modes:
    P(H | e) = sum_m p(m) * sigmoid(logit(prior_H) + sum_j LLR_j(m)). Returns the hypotheses sorted by
    posterior, each with its evidence (value, LLR, decibans), the prior, the range across speed modes and
    whether it could be evaluated at all."""
    modes = [m for m in speed_modes if m["p"] > 0.02] or speed_modes[:1]
    tot = sum(m["p"] for m in modes)
    runs = [(m["p"] / tot, _hypotheses(ctx, m["f_hz"])) for m in modes]
    out = []
    for j, h in enumerate(runs[0][1]):
        ps = []
        for w, hs in runs:
            hh = hs[j]
            lo = np.log(hh["prior"] / (1 - hh["prior"])) + sum(e["llr"] for e in hh["evidence"])
            ps.append((w, 1 / (1 + np.exp(-lo))))
        p = sum(w * v for w, v in ps)
        out.append({"id": h["id"], "title": h["title"], "prior": h["prior"], "p": float(p),
                    "p_range": [float(min(v for _, v in ps)), float(max(v for _, v in ps))],
                    "evaluable": bool(h["evidence"]), "evidence": h["evidence"],
                    "evidence_db": float(sum(e["db"] for e in h["evidence"]))})
    return sorted(out, key=lambda h: (not h["evaluable"], -h["p"]))

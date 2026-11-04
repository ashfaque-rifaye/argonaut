"""Agent actions: from a diagnosis to a fixed machine.

Muse Wonder decides *which* actions a diagnosis calls for and explains why; this module turns each
into an auditable action card (proposed -> approved -> running -> done | failed) whose physics is
deterministic and whose effect is re-measured:

* ``balance``     single-plane field balancing by the influence-coefficient method: measure the 1x
                  vector, fit a trial mass, measure again, alpha = (V1 - V0) / T, correction
                  C = -V0 / alpha, fit it, verify, and check the residual against ISO 21940-11
                  (U_per = 9549 * G * M / n g.mm).
* ``skip_bands``  program the drive's skip frequencies over the resonance bands (Campbell /
                  optimiser exclusion bands), read them back, and prove the drive now refuses them.
* ``work_order``  a CMMS-ready work order: ISO 14224 failure mode, risk-matrix priority, task
                  procedure with tolerances, safety, parts, verification criteria and the evidence.
* ``impact``      annual energy, cost and CO2 of the proposed setpoint (stated assumptions).
* ``followup``    the re-measurement interval implied by severity and fault probability.

Physical actions need a connected drive (the Modbus VFD); without one they are drafted into the work
order for a technician instead of being executed.
"""

from __future__ import annotations

import asyncio
import cmath
import math
import time
import uuid

# Task library: what a reliability engineer does about each fault hypothesis.
TASKS = {
    "imbalance": {
        "mode": ("VIB", "Vibration"), "cause": "Mass unbalance of the rotor",
        "steps": ["Lock out / tag out the drive; confirm zero speed and zero energy.",
                  "Clean the balancing plane; mark the keyphasor reference.",
                  "Run the influence-coefficient field balance (trial mass, correction mass) with Argonaut.",
                  "Fit the correction mass at the computed angle; torque and secure it.",
                  "Re-measure: residual unbalance within ISO 21940-11 G6.3."],
        "parts": ["Balancing weights (clip-on / weld-on) 0.5-20 g", "Thread locker"], "hours": 2.0, "action": "balance"},
    "misalignment": {
        "mode": ("VIB", "Vibration"), "cause": "Shaft misalignment across the coupling",
        "steps": ["Lock out / tag out; remove the coupling guard.",
                  "Check soft foot (< 0.05 mm under each foot) before aligning.",
                  "Laser-align motor to pump. Tolerance at 1500 rpm: offset <= 0.05 mm, "
                  "angularity <= 0.05 mm per 100 mm (3000 rpm: 0.03 mm / 0.03 mm per 100 mm).",
                  "Re-torque hold-down bolts in sequence; refit the guard.",
                  "Re-measure: 2x below 50 % of 1x and no 180 deg phase shift across the coupling."],
        "parts": ["Stainless shim set", "Coupling insert (if worn)"], "hours": 3.0, "action": None},
    "resonance": {
        "mode": ("VIB", "Vibration"), "cause": "Forcing frequency coincident with a structural natural frequency",
        "steps": ["Program VFD skip frequencies over the resonance bands (Argonaut can do this).",
                  "If the duty needs that speed: detune the structure. To move fn above the forcing by 15 %, "
                  "stiffness must rise by the factor computed below (mass unchanged).",
                  "Re-run a coast-down; confirm the Campbell crossing has moved out of the operating range."],
        "parts": ["Bracing / stiffener per detuning calculation"], "hours": 1.0, "action": "skip_bands"},
    "cavitation": {
        "mode": ("NOI", "Noise"), "cause": "NPSH available below NPSH required",
        "steps": ["Check suction strainer and suction valve fully open.",
                  "Raise suction level or reduce speed / flow to restore NPSH margin >= 1.3.",
                  "Re-measure: cavitation index < 0.35 and no HF impulsive crackle."],
        "parts": ["Suction strainer element"], "hours": 1.5, "action": None},
    "looseness": {
        "mode": ("VIB", "Vibration"), "cause": "Mechanical looseness (foundation, hold-down, bearing fit)",
        "steps": ["Inspect hold-down bolts and grout; check for cracked baseplate welds.",
                  "Torque bolts to specification in sequence.",
                  "Re-measure: shaft harmonic series 1-10x reduced; no half-order lines."],
        "parts": [], "hours": 1.5, "action": None},
    "flow": {
        "mode": ("PDE", "Parameter deviation"), "cause": "Operation away from best-efficiency flow",
        "steps": ["Compare duty point with the pump curve (upload the datasheet to Argonaut).",
                  "Move the setpoint toward BEP with the optimiser, within duty limits."],
        "parts": [], "hours": 0.5, "action": None},
    "rotor_bar": {
        "mode": ("VIB", "Vibration"), "cause": "Rotor-bar or electrical asymmetry",
        "steps": ["Motor current signature analysis at full load; compare pole-pass sidebands.",
                  "Plan rotor inspection at the next outage if sidebands exceed -45 dB."],
        "parts": [], "hours": 1.0, "action": None},
    "combustion": {
        "mode": ("PDE", "Parameter deviation"), "cause": "Cylinder-to-cylinder combustion imbalance",
        "steps": ["Read injector balance / exhaust temperatures per cylinder.",
                  "Compression test the suspect cylinder; service the injector."],
        "parts": ["Injector seals"], "hours": 2.5, "action": None},
    "bearing": {
        "mode": ("VIB", "Vibration"), "cause": "Rolling-element bearing defect",
        "steps": ["Trend the envelope spectrum at BPFO/BPFI weekly.",
                  "Lubricate per OEM; plan replacement if the defect line grows 6 dB."],
        "parts": ["Bearing set", "Grease"], "hours": 4.0, "action": None},
}


def priority(p_fault: float, zone: str | None, resonance: bool) -> tuple[str, str]:
    """Risk matrix: likelihood (fault posterior) x consequence (ISO zone, resonance)."""
    cons = {"D": 3, "C": 2, "B": 1, "A": 0}.get(zone or "", 1) + (1 if resonance else 0)
    like = 2 if p_fault >= 0.7 else 1 if p_fault >= 0.4 else 0
    score = like + cons
    return ("P1", "within 24 h") if score >= 4 else ("P2", "within 7 days") if score >= 3 else \
        ("P3", "within 30 days") if score >= 2 else ("P4", "next planned outage")


def followup_days(p_top: float, zone: str | None) -> int:
    if zone == "D" or p_top >= 0.7:
        return 7
    if zone == "C" or p_top >= 0.4:
        return 30
    return 90


def iso21940_uper(G: float, rotor_kg: float, rpm: float) -> float:
    """Permissible residual unbalance, g.mm (ISO 21940-11): U_per = 9549 * G * m / n."""
    return 9549.0 * G * rotor_kg / max(rpm, 1.0)


def trial_mass_g(rotor_kg: float, radius_mm: float, rpm: float, force_frac: float = 0.05) -> float:
    """Trial mass whose centrifugal force is a fraction of the rotor weight (field-balancing rule)."""
    w = 2 * math.pi * rpm / 60.0
    return max(0.5, round(force_frac * rotor_kg * 9.81 / (radius_mm / 1000.0 * w * w) * 1000.0, 1))


class Actions:
    def __init__(self, session):
        self.s = session
        self.items: dict[str, dict] = {}

    async def _emit(self, a: dict):
        await self.s.emit({"type": "action", **{k: v for k, v in a.items() if not k.startswith("_")}})

    async def propose(self, kind: str, title: str, rationale: str, params: dict | None = None,
                      proposer: str = "rules", requires_approval: bool = True) -> dict:
        drive = self.s.plant is not None
        physical = kind in ("balance", "skip_bands", "setpoint")
        a = {"id": f"a{uuid.uuid4().hex[:5]}", "kind": kind, "title": title, "rationale": rationale,
             "params": params or {}, "proposer": proposer, "created": time.time(),
             "status": "proposed" if (drive or not physical) else "needs_drive",
             "requires_approval": requires_approval and physical, "steps": [], "result": None}
        if a["status"] == "proposed" and not a["requires_approval"]:
            a["status"] = "running"
        self.items[a["id"]] = a
        await self._emit(a)
        if a["status"] == "running":
            await self._run(a)
        return a

    async def approve(self, aid: str, approved: bool, note: str | None = None) -> dict:
        a = self.items.get(aid)
        if not a:
            return {"ok": False, "error": "unknown action"}
        if a["status"] not in ("proposed",):
            return {"ok": False, "error": f"action is {a['status']}"}
        if not approved:
            a["status"] = "rejected"
            a["note"] = note
            await self._emit(a)
            return {"ok": True}
        a["status"], a["approved_at"], a["note"] = "running", time.time(), note
        await self._emit(a)
        asyncio.create_task(self._run(a))
        return {"ok": True}

    async def _step(self, a: dict, text: str, status: str = "done", data: dict | None = None):
        a["steps"].append({"t": round(time.time() - a["created"], 1), "text": text, "status": status, "data": data or {}})
        await self._emit(a)

    async def _run(self, a: dict):
        try:
            fn = {"balance": self._balance, "skip_bands": self._skip_bands, "work_order": self._work_order,
                  "impact": self._impact, "followup": self._followup}[a["kind"]]
            a["result"] = await fn(a)
            a["status"] = "done"
        except Exception as e:  # the card shows the failure; nothing is left half-applied silently
            a["status"], a["error"] = "failed", str(e)
        a["finished"] = time.time()
        await self._emit(a)

    # ------------------------------------------------------------------ balancing
    async def _read_1x(self, n: int = 6) -> tuple[complex, dict]:
        vs, st = [], {}
        for _ in range(n):
            st = await asyncio.to_thread(self.s.plant.read_state)
            vs.append(cmath.rect(st["one_x_mm_s"], math.radians(st["one_x_phase_deg"])))
            await asyncio.sleep(0.15)
        v = sum(vs) / len(vs)
        return v, st

    async def _balance(self, a: dict) -> dict:
        p = self.s.plant
        cfg = a["params"]
        G, M, r = cfg.get("grade", 6.3), cfg.get("rotor_kg", 25.0), cfg.get("radius_mm", 120.0)
        v0, st0 = await self._read_1x()
        rpm = st0["speed_rpm"]
        await self._step(a, f"Baseline 1x vector V0 = {abs(v0):.2f} mm/s ∠ {math.degrees(cmath.phase(v0)) % 360:.0f}° "
                            f"at {rpm:.0f} rpm (overall {st0['vel_mm_s_rms']:.2f} mm/s)",
                         data={"v0": [abs(v0), math.degrees(cmath.phase(v0)) % 360], "overall": st0["vel_mm_s_rms"]})
        t_g = trial_mass_g(M, r, rpm)
        await asyncio.to_thread(p.fit_mass, t_g, 0.0)
        await self._step(a, f"Trial mass {t_g:.1f} g fitted at 0° (centrifugal force 5 % of rotor weight at r = {r:.0f} mm)",
                         data={"trial_g": t_g})
        await asyncio.sleep(0.6)
        v1, _ = await self._read_1x()
        T = complex(t_g, 0.0)
        alpha = (v1 - v0) / T
        c = -v0 / alpha
        u0 = abs(v0 / alpha) * r
        u_lim = iso21940_uper(G, M, rpm)
        c_g, c_deg = round(abs(c), 1), round(math.degrees(cmath.phase(c)) % 360)
        await self._step(a, f"V1 = {abs(v1):.2f} mm/s ∠ {math.degrees(cmath.phase(v1)) % 360:.0f}°  ->  influence "
                            f"coefficient α = (V1 − V0)/T = {abs(alpha):.3f} mm/s/g ∠ {math.degrees(cmath.phase(alpha)) % 360:.0f}°; "
                            f"correction C = −V0/α = {c_g:.1f} g ∠ {c_deg}°",
                         data={"v1": [abs(v1), math.degrees(cmath.phase(v1)) % 360],
                               "alpha": [abs(alpha), math.degrees(cmath.phase(alpha)) % 360], "correction": [c_g, c_deg]})
        await self._step(a, f"Initial unbalance {u0:,.0f} g·mm vs ISO 21940-11 G{G} limit {u_lim:,.0f} g·mm "
                            f"({M:.0f} kg rotor at {rpm:.0f} rpm): {'out of tolerance' if u0 > u_lim else 'within tolerance'}",
                         status="warn" if u0 > u_lim else "done", data={"u0_gmm": u0, "u_per_gmm": u_lim})
        await asyncio.to_thread(p.remove_last_mass)
        await asyncio.to_thread(p.fit_mass, c_g, c_deg)
        await self._step(a, f"Trial mass removed; correction mass {c_g:.1f} g fitted at {c_deg}°")
        await asyncio.sleep(0.6)
        v2, st2 = await self._read_1x()
        u_res = abs(v2 / alpha) * r       # g.mm on the plane
        u_per = iso21940_uper(G, M, rpm)
        red = 100 * (1 - abs(v2) / max(abs(v0), 1e-9))
        ok = u_res <= u_per
        await self._step(a, f"Verified: 1x {abs(v0):.2f} → {abs(v2):.2f} mm/s ({red:.0f} % lower); overall "
                            f"{st0['vel_mm_s_rms']:.2f} → {st2['vel_mm_s_rms']:.2f} mm/s. Residual unbalance "
                            f"{u_res:.0f} g·mm vs ISO 21940-11 G{G} limit {u_per:.0f} g·mm: {'PASS' if ok else 'FAIL'}",
                         status="done" if ok else "warn",
                         data={"v2": [abs(v2), math.degrees(cmath.phase(v2)) % 360], "u_res_gmm": u_res, "u_per_gmm": u_per})
        return {"one_x_before": abs(v0), "one_x_after": abs(v2), "reduction_pct": red, "u0_gmm": u0,
                "overall_before": st0["vel_mm_s_rms"], "overall_after": st2["vel_mm_s_rms"],
                "correction_g": c_g, "correction_deg": c_deg, "u_res_gmm": u_res, "u_per_gmm": u_per,
                "grade": f"G{G}", "pass": ok, "zone_after": st2.get("iso_zone")}

    # ------------------------------------------------------------------ skip bands
    async def _skip_bands(self, a: dict) -> dict:
        p = self.s.plant
        bands = [(0.5 * (lo + hi), 0.5 * (hi - lo)) for lo, hi in a["params"]["bands_rpm"]][:3]
        back = await asyncio.to_thread(p.write_skip_bands, bands)
        await self._step(a, "Drive skip frequencies programmed and read back: "
                         + ", ".join(f"{c - hw:.0f}-{c + hw:.0f} rpm" for c, hw in back), data={"bands": back})
        # prove it: ask the drive for the middle of the first band; it must refuse to dwell there
        c, hw = back[0]
        st = await asyncio.to_thread(p.read_state)
        prev = st["setpoint_rpm"]
        accepted = await asyncio.to_thread(p.write_setpoint, c)
        await asyncio.to_thread(p.write_setpoint, prev)
        ok = abs(accepted - c) >= hw - 1
        await self._step(a, f"Test: requested {c:.0f} rpm (inside the band) → drive accepted {accepted:.0f} rpm "
                            f"({'refused, as intended' if ok else 'NOT refused'}); setpoint restored to {prev:.0f} rpm",
                         status="done" if ok else "warn")
        return {"bands": back, "test_requested": c, "test_accepted": accepted, "pass": ok}

    # ------------------------------------------------------------------ work order
    async def _work_order(self, a: dict) -> dict:
        s, i = self.s, self.s.ident
        k = i.get("kinematics") or {}
        faults = [h for h in k.get("fault_posterior", []) if h["evaluable"]]
        fid = a["params"].get("fault_id") or (faults[0]["id"] if faults else "imbalance")
        h = next((x for x in faults if x["id"] == fid), {"p": a["params"].get("p", 0.5), "title": fid, "evidence": []})
        lib = TASKS.get(fid, TASKS["imbalance"])
        zone = i.get("iso_zone")
        res = any(x["id"] == "resonance" and x["p"] >= 0.4 for x in faults)
        pr, due = priority(h["p"], zone, res)
        steps = list(lib["steps"])
        detune = None
        if fid == "resonance":
            modes = [m["f_hz"] for m in i.get("modes", []) if m.get("f_hz")]
            f1 = i.get("speed_hz_now") or 0
            if modes and f1:
                fn = min(modes, key=lambda m: abs(m - f1))
                detune = (1.15 * f1 / fn) ** 2 if fn < 1.15 * f1 else None
                if detune:
                    steps[1] += f" Here: fn = {fn:.2f} Hz, 1x = {f1:.2f} Hz -> stiffness x{detune:.2f} (fn ∝ √k)."
        wo = {
            "number": f"WO-{time.strftime('%y%m%d')}-{a['id'][1:].upper()}",
            "asset": s.asset_name, "created": time.strftime("%Y-%m-%d %H:%M"),
            "priority": pr, "due": due,
            "failure_mode": {"code": lib["mode"][0], "text": lib["mode"][1], "standard": "ISO 14224"},
            "suspected_cause": lib["cause"], "probability": round(h["p"], 2),
            "description": a["params"].get("summary") or f"{h['title']}: posterior {h['p']:.2f}.",
            "evidence": [f"{e['feature']} = {e['value']} ({e['db']:+.1f} dB)" for e in h.get("evidence", [])]
                        + ([f"ISO 20816 zone {zone}"] if zone else ["Amplitudes uncalibrated: severity from frequencies and ratios"])
                        + [f"Running speed {i.get('speed_rpm_now', 0):.0f} rpm ({i.get('speed_source')})"],
            "safety": ["Lock out / tag out (LOTO) the drive and isolate process energy",
                       "Guards back on before restart; no loose clothing near rotating parts"],
            "tasks": steps, "parts": lib["parts"], "est_hours": lib["hours"],
            "verification": "Re-measure with Argonaut after the work; acceptance: fault posterior < 0.2 and ISO zone A/B "
                            "(or unchanged frequencies/ratios if uncalibrated).",
            "detune_stiffness_factor": detune, "raised_by": a["proposer"],
        }
        await self._step(a, f"Work order {wo['number']} drafted: {pr} ({due}), {wo['failure_mode']['code']} – {lib['cause']}")
        return {"work_order": wo, "markdown": work_order_md(wo)}

    # ------------------------------------------------------------------ impact
    async def _impact(self, a: dict) -> dict:
        pr = self.s.proposal
        prm = a["params"]
        hours, tariff, co2 = prm.get("hours_per_year", 6000), prm.get("usd_per_kwh", 0.12), prm.get("kg_co2_per_kwh", 0.45)
        if not pr:
            raise ValueError("no setpoint proposal to evaluate yet")
        dkw = pr["current"]["kw"] - pr["proposed"]["kw"]
        kwh = dkw * hours
        out = {"kw_saved": dkw, "kwh_per_year": kwh, "usd_per_year": kwh * tariff, "t_co2_per_year": kwh * co2 / 1000,
               "vibration_change_pct": pr["expected"].get("vibration_change_pct"),
               "assumptions": {"hours_per_year": hours, "usd_per_kwh": tariff, "kg_co2_per_kwh": co2}}
        await self._step(a, f"{dkw:.2f} kW saved × {hours} h/yr = {kwh:,.0f} kWh/yr ≈ ${kwh * tariff:,.0f}/yr, "
                            f"{kwh * co2 / 1000:.1f} t CO₂/yr (tariff ${tariff}/kWh, grid {co2} kg/kWh)")
        return out

    # ------------------------------------------------------------------ follow-up
    async def _followup(self, a: dict) -> dict:
        i = self.s.ident
        faults = [h for h in (i.get("kinematics") or {}).get("fault_posterior", []) if h["evaluable"]]
        p_top = faults[0]["p"] if faults else 0.0
        days = followup_days(p_top, i.get("iso_zone"))
        due = time.strftime("%Y-%m-%d", time.localtime(time.time() + days * 86400))
        await self._step(a, f"Re-measure in {days} days ({due}): same camera position, same speed, "
                            f"so the posterior and spectra are comparable.")
        return {"days": days, "due": due}


def work_order_md(wo: dict) -> str:
    L = [f"# {wo['number']} · {wo['asset']}", "",
         f"**Priority:** {wo['priority']} ({wo['due']})  ",
         f"**Failure mode:** {wo['failure_mode']['code']} – {wo['failure_mode']['text']} ({wo['failure_mode']['standard']})  ",
         f"**Suspected cause:** {wo['suspected_cause']} (posterior {wo['probability']})  ",
         f"**Raised by:** {wo['raised_by']} · {wo['created']}", "", wo["description"], "", "## Evidence"]
    L += [f"- {e}" for e in wo["evidence"]]
    L += ["", "## Safety"] + [f"- {x}" for x in wo["safety"]]
    L += ["", "## Tasks"] + [f"{n}. {t}" for n, t in enumerate(wo["tasks"], 1)]
    if wo["parts"]:
        L += ["", "## Parts"] + [f"- {x}" for x in wo["parts"]]
    L += ["", f"**Estimated time:** {wo['est_hours']} h", "", "## Verification", wo["verification"], ""]
    return "\n".join(L)

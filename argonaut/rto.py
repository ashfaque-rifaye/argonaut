"""Closed-loop real-time optimisation (RTO) of a variable-speed asset inside an operator-approved envelope.

Each iteration:
  1. MEASURE   n readings at the current operating point (mean, sd).
  2. UPDATE    Bayesian update of the digital twin from all measurements so far: grid posterior over the
               dominant mode's natural frequency fn and damping ζ, with the forcing gain g solved in closed
               form per grid point. Likelihood on log-velocity residuals (scale-free); priors from identification.
  3. OPTIMISE  robust optimiser on the updated twin, restricted to the envelope.
  4. STEP      move the setpoint toward the optimum by at most max_step (trust region); wait for the
               drive ramp to settle. Converge when the step is small and the twin predicts the plant.
This is the "two-step" RTO scheme (parameter estimation, then economic optimisation), with a trust
region and human-approved bounds as the safety layer.
"""

import asyncio
import copy
import time

import numpy as np
from scipy import stats
from scipy.optimize import nnls

from .optimize import Twin, optimise, predict_vel_band


class ClosedLoop:
    def __init__(self, session, plant, envelope: tuple[float, float], max_step: float = 150.0,
                 duty_min_frac: float = 0.8, max_iter: int = 8, n_meas: int = 6):
        self.s, self.plant = session, plant
        self.env = (float(min(envelope)), float(max(envelope)))
        self.max_step, self.duty, self.max_iter, self.n_meas = max_step, duty_min_frac, max_iter, n_meas
        self.history: list[dict] = []
        self.meas: list[tuple[float, float, float]] = []  # (rpm, vel_mean, vel_sd)
        self.first_samples: list[float] = []
        self.stopped = False

    # ------------------------------------------------------------------ plant I/O
    async def _read(self) -> dict:
        return await asyncio.to_thread(self.plant.read_state)

    async def _measure(self) -> tuple[dict, np.ndarray, np.ndarray]:
        vels, kws, last = [], [], {}
        for _ in range(self.n_meas):
            last = await self._read()
            vels.append(last["vel_mm_s_rms"])
            kws.append(last["kw"])
            await asyncio.sleep(0.25)
        return last, np.array(vels), np.array(kws)

    async def _settle(self, timeout: float = 15.0):
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < timeout and not self.stopped:
            st = await self._read()
            if st.get("at_setpoint") and not st.get("ramping"):
                break
            await asyncio.sleep(0.3)
        await asyncio.sleep(0.6)  # structural transient

    # ------------------------------------------------------------------ model update
    def _update(self, twin: Twin) -> dict:
        """Grid posterior over (fn, ζ) of the dominant mode and the forcing gain g."""
        rpm = np.array([m[0] for m in self.meas])
        y = np.log(np.maximum([m[1] for m in self.meas], 1e-4))
        sig = np.sqrt(0.18 ** 2 +  # model-form error (twin simpler than plant) + measurement scatter
                       np.array([(m[2] / max(m[1], 1e-6)) ** 2 for m in self.meas]))
        if not twin.modes:
            g = float(np.exp(np.mean(y - np.log(np.maximum(twin.predict_vel(rpm), 1e-6)))))
            twin.order_vel_mm_s = {k: v * g for k, v in twin.order_vel_mm_s.items()}
            return {"modes": [], "gain_1x": g, "gain_sd": None}
        base_orders = dict(self.base_orders)
        best_lp = -np.inf
        i0 = int(np.argmax([1 / max(m.get("zeta") or 0.03, 1e-3) for m in twin.modes]))  # sharpest mode dominates
        m0 = dict(twin.modes[i0])
        mu, sd = m0["f_hz"], max(m0.get("f_sd") or 0.03 * m0["f_hz"], 0.02)
        z0 = m0.get("zeta") or 0.03
        fgrid = np.linspace(mu - 3 * sd, mu + 3 * sd, 41)
        zgrid = np.geomspace(max(0.004, z0 / 4), min(0.3, z0 * 4), 17)
        logpost = np.full((len(fgrid), len(zgrid)), -np.inf)
        gains = np.zeros_like(logpost)
        orders = sorted(base_orders)
        per_order = len(rpm) >= 3 and len(orders) > 1
        best_g = {k: 1.0 for k in orders}
        for a, fn in enumerate(fgrid):
            for b, z in enumerate(zgrid):
                twin.modes[i0] = {**m0, "f_hz": fn, "zeta": z}
                w = 1 / sig ** 2
                if per_order:
                    # v² = Σ_k g_k² · v_k² is linear in g_k² ≥ 0: non-negative least squares per grid point.
                    cols = []
                    for k in orders:
                        twin.order_vel_mm_s = {kk: (base_orders[kk] if kk == k else 0.0) for kk in orders}
                        cols.append(np.maximum(twin.predict_vel(rpm), 1e-9) ** 2)
                    A = np.array(cols).T
                    g2, _ = nnls(A * w[:, None], np.exp(2 * y) * w)
                    pv = np.sqrt(np.maximum(A @ g2, 1e-12))
                    lg = 0.0
                    r = y - np.log(pv)
                    gk = {k: float(np.sqrt(v)) for k, v in zip(orders, g2)}
                else:
                    twin.order_vel_mm_s = dict(base_orders)
                    p = np.log(np.maximum(twin.predict_vel(rpm), 1e-6))
                    lg = np.sum(w * (y - p)) / np.sum(w)  # closed-form log-gain (weighted LS)
                    r = y - p - lg
                    gk = {k: float(np.exp(lg)) for k in orders}
                prior = stats.norm.logpdf(fn, mu, sd) + stats.norm.logpdf(np.log(z), np.log(z0), 0.6)
                logpost[a, b] = prior - 0.5 * np.sum(w * r ** 2) + stats.norm.logpdf(lg, 0, 1.0)
                gains[a, b] = lg
                if logpost[a, b] > best_lp:
                    best_lp, best_g = logpost[a, b], gk
        P = np.exp(logpost - logpost.max())
        P /= P.sum()
        F, Z = np.meshgrid(fgrid, zgrid, indexing="ij")
        f_mean, z_mean = float((P * F).sum()), float(np.exp((P * np.log(Z)).sum()))
        f_sd = float(np.sqrt((P * (F - f_mean) ** 2).sum()))
        z_sd = float(np.sqrt((P * (Z - z_mean) ** 2).sum()))
        lg_mean = float((P * gains).sum())
        g_sd = float(np.sqrt((P * (gains - lg_mean) ** 2).sum()))
        twin.modes[i0] = {**m0, "f_hz": f_mean, "f_sd": max(f_sd, 0.01), "zeta": z_mean, "zeta_sd": max(z_sd, 1e-4)}
        twin.order_vel_mm_s = {k: base_orders[k] * best_g[k] for k in base_orders}
        g = float(best_g[orders[0]])
        return {"order_gains": {str(k): v for k, v in best_g.items()}, "modes": [{"f_hz": mm["f_hz"], "f_sd": mm.get("f_sd"), "zeta": mm.get("zeta"),
                           "zeta_sd": mm.get("zeta_sd")} for mm in twin.modes],
                "gain_1x": g, "gain_sd": g * g_sd}

    # ------------------------------------------------------------------ loop
    async def _emit(self, **kw):
        await self.s.emit({"type": "rto", "envelope_rpm": list(self.env), "max_step_rpm": self.max_step,
                           "history": self.history, "source": "plant simulator (Modbus)", **kw})

    async def run(self):
        base = copy.deepcopy(self.s.twin)
        if base is None:
            await self._emit(iteration=0, status="aborted", reason="no identified twin; analyse a clip first")
            return
        twin = copy.deepcopy(base)
        st0 = await self._read()
        await asyncio.to_thread(self.plant.write_setpoint, float(st0["speed_rpm"]))  # hold: no surprise ramp
        await self._settle()
        pred_err = None
        for it in range(1, self.max_iter + 1):
            if self.stopped:
                break
            await self._emit(iteration=it, status="measuring", setpoint_rpm=None, speed_rpm=None,
                             predicted=None, measured=None, model=None, objective=None, reason="")
            st, vels, kws = await self._measure()
            rpm_now = float(st["speed_rpm"])
            if it == 1:
                self.first_samples = list(vels)
                # Re-anchor the twin's operating point and calibration to the live plant.
                twin.speed_rpm = rpm_now
                self.base_orders = dict(twin.order_vel_mm_s)
            vel_m, vel_sd, kw_m = float(vels.mean()), float(vels.std(ddof=1)), float(kws.mean())
            if self.history:
                pv = self.history[-1]["pred_vel"]
                pred_err = abs(vel_m - pv) / max(pv, 1e-6)
                self.history[-1].update(meas_vel=vel_m, meas_sd=vel_sd, kw=kw_m)
            self.meas.append((rpm_now, vel_m, vel_sd))

            await self._emit(iteration=it, status="updating", speed_rpm=rpm_now,
                             measured={"vel_mm_s": vel_m, "kw": kw_m}, predicted=None, model=None,
                             objective=None, setpoint_rpm=None, reason="")
            model = await asyncio.to_thread(self._update, twin)
            r = await asyncio.to_thread(optimise, twin, self.duty, 0.10, 400, 1.0, 0.05, self.env)
            if r.get("feasible"):
                target = r["proposed"]["speed_rpm"]
            else:  # explore: head for the lowest predicted upper bound in the envelope (learn, then decide)
                cv = r["curve"]
                target = float(cv["rpm"][int(np.argmin(np.array(cv["vel_hi"]) + 1e3 * (np.array(cv["p_res"]) > 0.05)))])
            step = float(np.clip(target - rpm_now, -self.max_step, self.max_step))
            sp = float(np.clip(rpm_now + step, *self.env))
            lo, hi = predict_vel_band(twin, np.array([sp]), n=120)
            pred = float(twin.predict_vel(np.array([sp]))[0])
            pred_kw = float(twin.hydraulics(np.array([sp]))[1][0])
            converged = it > 1 and r.get("feasible") and abs(step) < 10 and pred_err is not None and pred_err < 0.15
            self.history.append({"iteration": it, "setpoint_rpm": sp, "speed_rpm": rpm_now, "pred_vel": pred,
                                 "pred_lo": float(lo[0]), "pred_hi": float(hi[0]), "meas_vel": None, "kw": kw_m,
                                 "p_res": float(r.get("risk", {}).get("p_res_proposed", np.nan)) if r.get("feasible") else None})
            status = "converged" if converged else "stepping"
            reason = (f"converged: |Δsetpoint| {abs(step):.0f} rpm < 10 and prediction error {100 * pred_err:.0f}% < 15%"
                      if converged else (f"step {step:+.0f} rpm toward optimum {target:.0f} rpm (trust region ±{self.max_step:.0f})"
                                         if r.get("feasible") else f"exploring: no feasible point yet, step {step:+.0f} rpm toward lowest predicted vibration"))
            await self._emit(iteration=it, status=status, setpoint_rpm=sp, speed_rpm=rpm_now,
                             predicted={"vel_mm_s": pred, "vel_lo": float(lo[0]), "vel_hi": float(hi[0]), "kw": pred_kw},
                             measured={"vel_mm_s": vel_m, "kw": kw_m}, model=model,
                             objective={"kw": pred_kw, "j": None}, reason=reason)
            if converged:
                await self._verify(vels)
                return
            await asyncio.to_thread(self.plant.write_setpoint, sp)
            await self._emit(iteration=it, status="settling", setpoint_rpm=sp, speed_rpm=rpm_now,
                             predicted={"vel_mm_s": pred, "vel_lo": float(lo[0]), "vel_hi": float(hi[0]), "kw": pred_kw},
                             measured=None, model=model, objective={"kw": pred_kw, "j": None}, reason="drive ramping")
            await self._settle()
        st, vels, _ = await self._measure()
        await self._emit(iteration=len(self.history), status="aborted" if self.stopped else "converged",
                         setpoint_rpm=self.history[-1]["setpoint_rpm"] if self.history else None,
                         speed_rpm=float(st["speed_rpm"]), predicted=None,
                         measured={"vel_mm_s": float(vels.mean()), "kw": float(st["kw"])}, model=None, objective=None,
                         reason="stopped by operator" if self.stopped else "iteration limit reached")
        if not self.stopped:
            await self._verify(vels)

    async def _verify(self, final_samples: np.ndarray):
        """Welch t-test on vibration before vs after the loop: is the reduction beyond measurement noise?"""
        b, a = np.array(self.first_samples), np.array(final_samples)
        t, p = stats.ttest_ind(a, b, equal_var=False)
        ci = lambda x: [float(x.mean() - 1.833 * x.std(ddof=1) / np.sqrt(len(x))),  # noqa: E731 (90%, n≈6)
                        float(x.mean() + 1.833 * x.std(ddof=1) / np.sqrt(len(x)))]
        pred = self.history[-1]["pred_vel"] if self.history else float(a.mean())
        err = abs(a.mean() - pred) / max(pred, 1e-6)
        await self.s.emit({"type": "verification", "proposal_id": "rto", "predicted_vel_mm_s": pred,
                           "measured_vel_mm_s": float(a.mean()), "passed": bool(err < 0.2 and a.mean() < b.mean()),
                           "before_ci": ci(b), "after_ci": ci(a), "p_value": float(p), "significant": bool(p < 0.01),
                           "summary": f"Closed loop: vibration {b.mean():.2f} → {a.mean():.2f} mm/s "
                                      f"({100 * (a.mean() / b.mean() - 1):+.0f}%), p = {p:.1e}; "
                                      f"twin prediction error {100 * err:.0f}%."})

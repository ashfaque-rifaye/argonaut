# Argonaut v3: camera-native system identification and real-time optimization for rotating plant

> **From a phone camera to a live digital twin of the machine, and the setpoint that runs it best.**
> Argonaut identifies a machine's dynamics from video and sound. It works out natural frequencies, damping, mode shapes, critical speeds and its cavitation margin. It then runs a constrained real-time optimizer that moves the operating point *out* of resonance and *toward* best efficiency. Before anything is applied, it checks the move with physics and a person signs off.

The v2 analysis (prior art, IP, naming, rules) still applies and is kept in git history. v3 changes the *depth* of the idea, not its novelty claim.

---

## 0. The problem, stated precisely (hardened, Nov 3)

**Variable-speed rotating machines run at setpoints nobody has checked against their own dynamics.**

- **Scale.** Electric motor systems used **53% of global electricity in 2023** ([IEA 4E policy brief, 2025](https://www.iea-4e.org/wp-content/uploads/2025/12/4E-Policy-Brief-EMSA-9-20251218.pdf)). Pumps, fans and compressors account for about 70% of motor-system electricity ([IEA 4E, 2018](https://www.pole-medee.com/wp-content/uploads/2018/03/12-TPA-2018.pdf)).
- **The mechanism.** Variable-frequency drives let an asset run at any speed. Every shaft order (1×, 2×, blade/vane pass) sweeps across the structure's natural frequencies as speed changes. Somewhere in the speed range there are resonance bands, and for pumps a cavitation boundary too. Running inside them wastes energy and destroys bearings, seals and welds.
- **Why it isn't solved.** Mapping those bands is a specialist test: an impact-hammer modal survey, or a run-up/coast-down with a tachometer, multi-channel accelerometers and a data recorder, then an analyst. That is why most installed drives are commissioned on nameplate defaults and never re-tuned.
- **What we replace.** The tachometer becomes the phone's microphone. The accelerometer array becomes SAM 3.1 virtual sensors on video. The analyst's test design and diagnosis become a Muse Wonder agent bound to measured evidence. The commissioning engineer's speed tuning becomes a closed-loop, uncertainty-aware optimiser inside a human-approved envelope.

**What the AI does that signal processing cannot, and what it is never allowed to do.**

| Needs semantics (Meta models) | Needs physics (our DSP, deterministic) |
|---|---|
| *Where* to measure: name parts, refuse rotating ones (SAM 3.1 + Muse Spark) | Sub-pixel motion, shake cancellation, spectra with CIs |
| Physical context: nameplate rpm, blade/vane count, scale reference, pump-curve datasheet (Muse Spark) | Order tracking, de-aliasing, resonance fits, FDD |
| *What the machine can produce*: a kinematic model (class, engine stroke, cylinders, poles, gear teeth, a controller display's rpm) (Muse Spark) | Forcing-frequency families, Bayesian speed posterior (harmonic sieve with Occam factor), log-odds fault posterior (`docs/KINEMATICS.md`) |
| Experiment design and diagnosis by practitioner rules, explained (Muse Wonder) | Digital twin, robust optimisation, Bayesian update, significance tests |
| Hands-free field operation in code-switched speech (Voice Transcribe) | |

The agent never produces a number. Every number it writes is checked against tool outputs (numeric provenance), and unverified figures are flagged in the UI.

**Measured so far** (synthetic ground truth and simulated plant; see `docs/BENCHMARK.md`):
- **Misalignment:** phase 0° / −180° across the coupling, matching the truth (0° / 180°). Speed 1477 rpm against a true 1480.
- **Coast-down:** mode 14.06 Hz by FDD (truth 14.2), ζ 2.2% (truth 2.0%). 1× critical 886 rpm (truth 852).
- **30 fps webcam + microphone:** recovered 1× at 24.68 Hz, 2× at 49.35 Hz and 6× vane pass at 148.06 Hz from aliases at 5.34, 10.67 and 2.01 Hz. Streaming latency 22 ms median, 38 ms p95.
- **Closed-loop optimisation on the simulated drive:** converged in 8 iterations; vibration 2.59 → 0.30 mm/s (−89%), p = 3.8×10⁻⁸; twin prediction error 1%.
- **Running speed** (`docs/BENCHMARK.md`): pump 1476.8 rpm against a true 1480 (−0.22%); fan coast-down 1294.4 against 1293.1 (+0.10%); 60 fps shake test 1483.2 against 1480 (+0.22%).
- **Other benchmark results:** 1× critical 889 rpm against a true 852 rpm. Imbalance correction measured at 89.8% against 85%. Camera-shake residual is 2.8% of the true shake (100% without the wall reference).
- **Honest limits:**
  - The twin's posterior natural frequency settles at 14.6 Hz against a plant truth of 14.2 Hz. Its single-mode, unbalance-forcing model is simpler than the plant. Decisions stay safe because the optimiser uses the uncertainty band, not the point estimate.
  - Without a nameplate speed, the microphone can't tell which shaft order it hears. The camera's aliases decide it, and that decision is sensitive to sensor placement under heavy hand shake: −37 ± 34% across perturbed regions on the 60 fps shake test. Muse Spark reading the nameplate removes the ambiguity.
  - Motions below about 0.03 px are attenuated by H.264 and by the tracker (median gain 0.8–0.9).
- **Fault posterior on synthetic ground truth** (`scripts/fault_eval.py`): the top hypothesis matches the rendered fault on 6 of 6 clips (misalignment 0.86, cavitation 0.83, imbalance 0.56, coast-down resonance 0.73; nothing ≥ 0.5 on the balanced and the healthy clip).
- **Real footage** (15 published clips in `data/library`: fans, diesel gensets, washing machines, pumps, motors, a rotor rig, a wind turbine, a bridge). Tachometer ground truth exists only where a display shows it:
  - **Genset with a controller display (51.3 Hz / 1,542 rpm):** the microphone's kinematic posterior gives **1,542.4 rpm** without seeing the display (+0.03%). Without the four-stroke model it would read 771 rpm.
  - **1500 kVA genset:** every audio line is a multiple of 12.49 Hz; the measured 49.94 Hz generator line and the four-stroke half-order model give **1,498 rpm (P 0.98)** instead of 750.
  - **2.13 m exhaust fan:** with the 6 blades Muse Spark counted, **413 rpm (P 0.97)**; without the count, 2,477 rpm (the blade pass read as 1×).
  - **Correction:** an earlier version reported 2,978 rpm for the induction-motor bench. That was the 49.74 Hz mains line read as 1×. Its audio is dominated by electrical lines, and the posterior now says the speed is not identifiable from it (P(MAP) 0.39).
  - Absolute mm/s is only claimed with a credible scale reference and plausible levels. Handheld, unscaled footage is reported as **relative** ("uncalibrated"), and the agent is instructed not to issue ISO zones then. In our first real runs, Muse Wonder had already flagged 400–1500 mm/s readings as implausible instead of alarming.
  - Without a nameplate, blade count or engine model, which order the microphone hears can stay ambiguous. The speed posterior now reports that ambiguity as probabilities (modes with their relation, ½×, 2×…) instead of hiding it, and Muse Wonder can test alternative kinematics before concluding.

---

## 1. Why "vibration analysis" was too shallow

Basic vibration analysis answers "is it shaking?" Plant engineers need answers to harder questions:

- **Where are the resonances, and does my operating speed sit on one?** Variable-frequency drives (VFDs) let pumps and fans run at any speed. Many speeds excite a structural mode, and nobody has mapped them.
- **How close am I to cavitation or recirculation?** Pumps run away from their best-efficiency point (BEP) waste energy and wear out early.
- **What setpoint minimizes energy per unit of work while staying dynamically safe?**

Answering these normally needs four things: an impact-hammer modal test, a run-up/coast-down test with a tachometer and multi-channel data acquisition, a rotordynamics model, and a process engineer. That's days of specialist work, so >95% of motor-driven assets never get it.

**The stakes:** electric-motor systems draw about half of the world's electricity, and pumps and fans are the largest share of that. Running off-BEP and in resonance is the default state of the installed base.

## 2. What Argonaut does: a closed loop

```
            ┌───────────────────────── SENSE ─────────────────────────┐
 phone /    │ SAM 3.1: language-placed virtual sensors ("bearing      │
 webcam ───►│ housing", "pump casing", "baseplate", "discharge pipe", │
 + mic      │ static "wall" reference); up to 16 tracked regions       │
            │ Sub-pixel motion per region: phase correlation + camera │
            │ shake cancellation → displacement in mm (scale from a   │
            │ known reference object)                                 │
            └──────────────────────────┬──────────────────────────────┘
                                       ▼
            ┌──────────────────────── IDENTIFY ───────────────────────┐
            │ • Order tracking: speed from video and audio → 1×, 2×,  │
            │   blade/vane-pass frequency                             │
            │ • Run-up / coast-down → Campbell diagram → critical      │
            │   speeds (where an order line crosses a natural freq.)   │
            │ • Operational modal analysis (output-only): frequency    │
            │   domain decomposition (FDD) → natural frequencies,      │
            │   mode shapes across regions, damping from the half-     │
            │   power bandwidth                                        │
            │ • Envelope (demodulated) audio spectrum → bearing defect │
            │   frequencies; broadband hiss → cavitation index         │
            │ • Muse Spark: reads nameplate and pump-curve datasheet   │
            │   → rated RPM, flow, head, BEP, NPSH curve               │
            └──────────────────────────┬──────────────────────────────┘
                                       ▼
            ┌─────────────────────── DIGITAL TWIN ────────────────────┐
            │ Per-asset model: modal table + resonance bands + pump    │
            │ affinity laws (Q∝N, H∝N², P∝N³) + vibration severity     │
            │ zones (ISO 20816) + uncertainty for every parameter.     │
            │ Updated live as new evidence arrives (recursive          │
            │ estimation).                                             │
            └──────────────────────────┬──────────────────────────────┘
                                       ▼
            ┌─────────────────── REAL-TIME OPTIMIZATION ──────────────┐
            │ Muse Wonder runs a constrained optimizer over speed:     │
            │   minimize  specific energy (kWh per m³, or per unit     │
            │             of duty)                                     │
            │   subject to  duty met (flow / head)                     │
            │               speed outside every resonance band ± margin│
            │               NPSH margin > 1.3                          │
            │               predicted vibration in zone A/B            │
            │ Output: a recommended setpoint, the expected gain, and   │
            │ the evidence. A person approves, the setpoint is written │
            │ (simulated VFD over Modbus/OPC-UA), then Argonaut        │
            │ RE-MEASURES and confirms the predicted change happened   │
            │ (closed loop).                                           │
            └─────────────────────────────────────────────────────────┘
```

**Self-verification, carried over from v2:**
- A frequency counts only when the video *and* the audio both show it.
- Clips near the frame-rate limit get a second frame rate to rule out false (aliased) peaks.
- Every parameter has an error bar, and the system refuses to act on wide ones.

## 3. Engineering vocabulary the demo will *show*, not just say

| Term | What it means on screen |
|---|---|
| Campbell diagram | Natural frequencies plotted against speed, with order lines (1×, 2×, vane-pass). A circle marks each critical speed where they cross |
| Operating deflection shape (ODS) | An amplified animation of how the tracked regions move together at a chosen frequency |
| Operational modal analysis (FDD) | Singular-value spectrum across all virtual sensors; peaks are modes, and mode shapes come from the singular vectors |
| Order tracking / waterfall | Spectrum against time during a run-up or coast-down; order lines appear as rays from the origin |
| Damping ratio ζ | From the half-power bandwidth of each mode, shown with its error bar |
| Envelope spectrum | Demodulated high-frequency audio showing bearing-defect frequencies |
| Affinity laws, BEP, NPSH margin | The pump-curve panel: operating point against BEP, with the cavitation boundary |
| Constrained real-time optimization | The optimizer panel: feasible speed band, resonance exclusion zones, chosen setpoint, predicted kWh saved |

## 4. Meta models: each has a visible, non-trivial job

| Model | Job |
|---|---|
| **SAM 3.1** | Places virtual sensors by name and tracks them, turning segmentation into a multi-channel measuring instrument |
| **Muse Spark** (1.2 for audio) | Understands the scene and sound together, reads the nameplate and pump-curve PDF, coaches the capture, cross-checks against the audio |
| **Muse Wonder** | Plans the identification experiment ("do a coast-down"), runs the optimizer through tools, explains the decision with evidence, and re-plans when verification fails |
| **Muse Voice Transcribe** | Realtime, code-switched, hands-free control on the plant floor ("Argonaut, start a coast-down") |
| **Muse Spark Open** (Baseten) | Private mode: the reasoning runs on open weights, so plant data stays in the plant (open-weight prize) |
| **Muse Image** (optional) | An asset "health and efficiency card" for the shareable report |

## 5. Demo (cheap rig, real physics)
- **Rig:** a variable-speed desk or pedestal fan (or a drill on a stand), plus a small water pump in a bucket for the pump-curve and cavitation panel.
- **Coast-down capture:** switch the fan off and film 20 s. The live waterfall shows order lines sweeping down; Argonaut finds the stand's resonance and draws the Campbell diagram.
- **Optimizer:** "Speed 3 sits on the 14.2 Hz stand mode. Recommend speed 2.6 — vibration −68%, same airflow band." Approve, re-measure, verified.
- **Pump:** throttle the bucket pump's inlet. The cavitation index rises, the NPSH-margin constraint fires, and the optimizer backs off.
- Industrial footage (public, licensed clips) shows it working on real plant equipment.

## 6. Real-time architecture
- The browser (phone or desktop) streams camera frames and microphone audio over WebSocket to a FastAPI backend.
- **Every frame:** local signal processing (phase correlation inside SAM masks), with live spectrum, waterfall and Campbell updates.
- **SAM 3.1** re-segments a short clip every few seconds to refresh the masks. Between refreshes the regions are tracked locally.
- **Voice Transcribe:** a realtime WebSocket session runs alongside.
- **Muse Spark:** a multimodal check on a short clip every N seconds, plus on demand.
- **Muse Wonder:** an event-driven agent loop with tools (identify, optimize, apply-setpoint, verify).

# Kinematic inference: what the machine *can* produce decides what the spectrum *means*

`argonaut/dsp/kinematics.py` · tests in `tests/dsp/test_kinematics.py` · evaluation in `scripts/fault_eval.py`

## Why this layer exists

A spectrum alone is ambiguous:
- **Engine:** a comb of lines every 12.49 Hz is a 750 rpm machine's integer orders, or a 1,500 rpm four-stroke engine's half orders.
- **Fan:** a 41.25 Hz tone is a 2,475 rpm shaft, or the blade pass of a 6-blade fan at 412 rpm.

Signal processing cannot settle this. Knowing what the machine is can, and that is the part **Muse Spark** supplies. From the first frame it returns a `kinematics` block:
- machine class
- engine stroke and cylinder count
- poles
- line frequency, only if signage or a display shows it
- gear teeth
- any rpm shown on a controller display

The nameplate supplies blade/vane count and rated speed. Everything downstream is deterministic and auditable.

## 1. Forcing-frequency model

Each line family is a set of multiples (orders) of shaft frequency `f`:

| Family | Orders | When |
|---|---|---|
| shaft | 1, 2, 3, … | always |
| half order | 0.5, 1.5, 2.5, … | four-stroke engines (one combustion cycle = 2 revolutions) |
| firing | `n_cyl/2 · h` (4-stroke), `n_cyl · h` (2-stroke) | engines with a known cylinder count |
| blade pass | `B · h` | fans, pumps (vanes), gear pumps (teeth) |
| gear mesh | `z₁ · h`, output shaft `z₁/z₂` | gearboxes with tooth counts |
| bearing | BPFO = n/2 (1 − d/D cos φ), BPFI = n/2 (1 + d/D cos φ), FTF = ½ (1 − d/D cos φ), BSF = D/2d (1 − (d/D cos φ)²) | only with bearing geometry |

**Electrical lines** at `k · f_line` are masked for induction machines: magnetostriction and electromagnetic forces act at 2 f_line, and the line frequency itself appears too. They are not shaft orders.

`f_line` is estimated from the even-harmonic comb (2f, 4f, 6f, 8f) within ±3% of 50 Hz and of 60 Hz, so an off-grid generator's drift (49.94 Hz) is measured, not assumed.

## 2. Bayesian speed posterior: a harmonic sieve with an Occam factor

Take the N strongest spectral peaks `fᵢ` with amplitudes `aᵢ`, from the steady part of the recording only. For each candidate shaft frequency `f` on a log grid (3–120 Hz):

```
p(fᵢ | f) = π · Σ_fam w_fam · (1/M_fam(f)) · Σ_{l ∈ fam} N(fᵢ; l·f, σᵢ²)  +  (1 − π) / B
σᵢ² = (Δf/2)² + (ρ · l·f)²          # bin width + 0.4 % speed wander
log L(f) = Σᵢ √(aᵢ/a_max) · log p(fᵢ | f)
p(f | peaks) ∝ L(f) · p(f)
```

**Each peak** is either explained by a line the hypothesis predicts, or treated as background (uniform over the band `B`).

**The 1/M term is the Occam factor.** A lower fundamental with twice as many lines can explain everything, but only by spreading its probability twice as thin. So it loses unless the data need the extra lines.

**Family weights** encode which lines a machine radiates most (blade pass 1.5, shaft 1.0, half order 0.7, firing 0.5). Every family's comb spans the whole band, so a hypothesis whose comb stops early cannot concentrate its density where the peaks happen to be.

**Priors come from physics:**
- **Induction machine:** shaft speed sits at 0–6% slip below `2 f_line / p`. The pole count uses an installed-base prior. Fans, pumps and gearboxes keep 50% flat mass, because they are often on a VFD or a belt.
- **Synchronous generator:** `f = 2 f_line / p` (genset pole prior 4: 0.68, 2: 0.12, 6: 0.12, 8: 0.08), ±0.4% when the line frequency is measured from the audio's 2f comb, ±3% when it is only a nominal 50/60 Hz read from the frame (off-grid generators drift with load).
- **Nameplate rpm:** ±4%.
- **Otherwise:** flat in log f.

A speed read off a **controller display is never used as a prior**. It is kept only to validate the posterior.

**Outputs:** the posterior, its modes with probability mass and their relation to the MAP (½×, 2×, ⅔× …), a 68% credible interval, which peaks the MAP explains and as which line, and an `ambiguous` flag when P(MAP mode) < 0.8.

**Arbitration.** The clip pipeline then decides between the acoustic tachometer and the posterior:
- The posterior is computed only on a window where the tracked speed varies by less than 3%. A spectrum over a run-up smears every line.
- It replaces the tachometer's order only if its MAP mode has P ≥ 0.8 and sits at a rational ratio of the tachometer's speed.

## 3. Fault posterior: log-odds evidence accumulation

**The model.** Each hypothesis H has a base-rate prior and a set of features. Each feature contributes a log-likelihood ratio, reported in decibans (dB = 10·log₁₀ LR):

```
logit P(H | e) = logit P(H) + Σⱼ LLRⱼ(eⱼ)
```

**Speed uncertainty** is propagated by mixing over the speed-posterior modes: `P(H) = Σ_m p(m) · P(H | e, f_m)`. The UI shows the range across modes.

| Hypothesis | Prior | Evidence (feature → LLR) |
|---|---|---|
| Imbalance | 0.15 | 1× share of 1–3× (6·(s₁ − 0.55), ±2.5); 1× velocity vs the ISO A/B boundary (calibrated scale only) |
| Misalignment | 0.10 | 2×/1× ratio (capped at +1.5: on its own also looseness or noise); 2× phase across the coupling (≈180° → +2.5), using only channels that carry ≥ 30% of the 2× amplitude |
| Looseness | 0.08 | number of shaft harmonics 1–10× above 10 dB; ½-order series on non-engines |
| Resonance | 0.12 | swept runs: a Campbell critical inside the range, weighted by amplification Q = 1/(2ζ); steady runs: forcing-to-mode separation, counting only modes identified independently of the forcing (damped fit or FDD structural mode) |
| Cavitation | 0.08 | cavitation index (HF kurtosis + HF energy fraction) |
| Off-design flow | 0.10 | blade-pass / 1× in audio |
| Rotor bar | 0.05 | pole-pass sidebands at 1× ± p·(f_sync − f) relative to 1×, from a 16 s high-resolution spectrum |
| Combustion imbalance | 0.10 | ½-order / firing-order ratio (four-stroke engines) |
| Bearing | 0.08 | envelope-spectrum line at BPFO/BPFI, *only with bearing geometry* |

**Structural evidence only from the camera.** Imbalance and misalignment use camera order amplitudes, and only when 2× lies below 80% of the camera's Nyquist frequency. Microphone order ratios are not structural vibration: an engine's or a fan's 1× is acoustically quiet whatever its imbalance. So on a 30 fps clip of a 1,500 rpm machine, these two hypotheses are not evaluable rather than guessed.

**Missing evidence.** A hypothesis whose evidence is missing is marked **not evaluable**. It is never guessed, and the agent is told to say which capture would provide that evidence.

**Steady state can't show resonance.** In steady state, a peak at k× speed cannot be told apart from forced response. So steady-state data is not counted as resonance evidence; the remedy is a coast-down, which is exactly what Muse Wonder recommends.

The likelihood ratios are expert-elicited from standard vibration-analysis practice (ISO 18436-2 category training material, ISO 20816). They are not fitted to the evaluation clips.

## 4. Muse Wonder: what-if testing

The agent's `get_identification` includes the whole kinematics block. A new tool, `test_kinematic_hypothesis`, re-runs both posteriors under changed assumptions (machine class, blades, stroke, cylinders, poles, line frequency), so the agent can compare hypotheses before concluding. For example:

> "is this a 6-blade fan at 412 rpm, or the 2,475 rpm shaft?"

The system prompt tells it to report probabilities, not certainty.

## 5. Results

**Synthetic ground truth** (`scripts/fault_eval.py`, true sensor boxes, nameplate rpm withheld): 6 of 6 clips, with the top evaluable hypothesis matching the rendered fault.

| Clip | Rendered fault | Top hypothesis |
|---|---|---|
| pump_steady_misalignment | 2× at 180° across the coupling | misalignment 0.86 |
| pump_cavitation | HF crackle | cavitation 0.83 |
| imbalance_before | 1× imbalance | imbalance 0.56 |
| imbalance_after | 85% less 1× | nothing ≥ 0.5 (imbalance 0.38) |
| fan_coastdown | 1× crosses the 14.2 Hz stand mode | resonance 0.73 |
| shake_test | small 1×, handheld | nothing ≥ 0.5 |

**Real footage, audio only.** There is no tachometer ground truth except where a display shows one.

| Clip | Kinematic model (Muse Spark) | Posterior MAP | Without the kinematic model |
|---|---|---|---|
| Genset, controller display 1,542 rpm / 51.3 Hz | 4-stroke genset | **1,542.4 rpm**, display error **+0.03%** | 771 rpm (½×) |
| Genset 1500 kVA, step load | 4-stroke genset, line 49.94 Hz measured | **1,498 rpm, P 0.98** (4-pole at 49.94 Hz) | 750 rpm |
| 84" exhaust fan | 6 blades | **413 rpm, P 0.97** | 2,477 rpm (blade pass read as 1×) |
| Washer, 1,400 rpm spin | washer | 1,383 rpm, P 1.00 (title says 1,400) | same |
| Induction motor bench | induction motor, 49.75 Hz measured | **ambiguous**: the top modes share the probability | — |

**About the motor bench.** It is dominated by electrical lines: 199 Hz = 4 × 49.75 Hz is the strongest. An earlier version of Argonaut reported 2,978 rpm for it, by reading the 49.74 Hz mains line as 1×. The kinematic layer masks electrical lines and reports the speed as not identifiable from this audio, which is the honest answer.

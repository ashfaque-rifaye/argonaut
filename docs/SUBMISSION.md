# Submission form answers (draft)

Paste-ready text for the hackathon form. Every number here comes from `docs/BENCHMARK.md`, `CONCEPT.md` §0 or a recorded run in `data/runs/`.

| Field | Answer |
|---|---|
| Team name | Argonaut |
| Track | Indie Dev |
| Theme | Push the Frontier |
| GitHub | https://github.com/ashfaque-rifaye/argonaut |
| Demo video | *(YouTube link once uploaded)* |
| X post | *(link once posted; see `docs/DEMO_SCRIPT.md` for the post text)* |

---

## Project description

**Short (one paragraph):**

Argonaut turns a camera and a microphone into a vibration test lab for pumps, fans and motors. SAM 3.1 places virtual sensors on the machine by name, and Muse Spark refuses to place them on rotating parts. The microphone works as a tachometer. Deterministic signal processing then identifies the machine's dynamics: running speed, natural frequencies, damping, mode shapes and critical speeds. Muse Spark also reads what the machine physically is (a four-stroke diesel, a 6-blade fan, an induction motor), and a Bayesian kinematic layer turns that into probabilities: which shaft speed the audio lines imply, and how likely each fault is, with the evidence for each in decibans. A Muse Wonder agent tests alternative hypotheses, diagnoses the faults and runs an uncertainty-aware optimiser that moves the drive speed out of resonance. A person approves the new setpoint, it is written to the drive over Modbus, and Argonaut re-measures to prove the change is statistically significant. The agent never invents a number: every figure it writes is checked against tool outputs.

**Long (if the field allows it):**

Electric motor systems used 53% of the world's electricity in 2023 (IEA 4E, 2025), and about 70% of that runs pumps, fans and compressors. Most of them sit on variable-frequency drives that were commissioned on nameplate defaults. Nobody has checked those setpoints against the machine's own resonances, because doing so takes an impact-hammer modal survey or a run-up test with a tachometer, accelerometers, a data recorder and an analyst.

Argonaut replaces that kit with what is already on site:

- **Sense.** SAM 3.1 segments "bearing housing", "pump casing", "baseplate" and a static reference by name; Muse Spark reads the nameplate and the scale reference and rejects rotating parts. Sub-pixel Lucas–Kanade tracking with camera-shake cancellation turns each mask into a sensor channel.
- **Identify.** Order tracking from audio and video, audio-guided de-aliasing of a 30 fps camera, Campbell critical speeds, an SDOF resonance fit and operational modal analysis (FDD), with confidence intervals throughout.
- **Infer.** Muse Spark's kinematic model (engine stroke, blades, poles, gear teeth) defines which lines the machine can produce. A Bayesian harmonic sieve with an Occam factor gives the posterior over running speed, and a log-odds model gives the posterior per fault hypothesis. Hypotheses without the evidence they need are marked not evaluable instead of guessed (`docs/KINEMATICS.md`).
- **Optimise.** A digital twin (modal FRF, affinity laws, pump curve, NPSH) and a robust optimiser that computes the probability of resonance from the uncertainty in the natural frequency.
- **Close the loop.** A Bayesian update of the twin, a trust-region step, human approval of the envelope, a Modbus write, and a Welch t-test on the re-measurement.

**Results:**

- **Synthetic ground truth:**
  - Running speed within 0.22%.
  - Mode 14.06 Hz against a true 14.2 Hz.
  - Misalignment phase 179.8° against 180°.
  - Camera shake rejected to 2.8% of its true size.
- **Simulated drive:** vibration 2.59 → 0.30 mm/s (−89%, p = 3.8×10⁻⁸).
- **Fault posterior on synthetic ground truth:** the top hypothesis matches the rendered fault on 6 of 6 clips.
- **Real footage, speed from the microphone alone:**
  - A diesel genset whose controller display reads 1,542 rpm: the posterior gives 1,542.4 rpm without seeing the display (+0.03%); without the four-stroke model it would say 771.
  - A 1500 kVA genset: 1,498 rpm (P 0.98) instead of the 750 rpm a plain harmonic fit gives.
  - An exhaust fan: 413 rpm with the 6 blades Muse Spark counted, instead of 2,477.
- **Agent output:** 66 of 66 numbers in its final assessment matched a tool output.
- **Real footage:** the console runs 15 published CC-licensed clips (fans, diesel gensets, washing machines, pumps, motors), and anyone can upload their own video. On handheld footage with no scale reference, amplitudes are labelled "uncalibrated · relative" and no ISO zone is reported.

---

## How did you use Meta products?

Five Meta models each do a separate job that the signal processing cannot do alone:

- **SAM 3.1** (`sam-3.1`) is the sensor array.
  - It uses text prompts ("pump casing", "bearing housing", "wall") and box prompts refined from Muse Spark's detections.
  - It returns one-bit masks for the image and tracks them in video.
  - Each mask becomes a measurement channel for sub-pixel motion tracking.
  - A static-reference mask drives the camera-shake cancellation.
- **Muse Spark** (`muse-spark-1.3`, and `1.2` for audio) handles the physical context. Every call uses JSON-schema structured output. It:
  - understands the scene and returns bounding boxes for measurable parts
  - refuses to place sensors on blades, belts or shafts
  - reads the nameplate speed, the blade count and the scale reference
  - returns a kinematic model of the machine (class, engine stroke, cylinders, poles, gear teeth) and copies any rpm shown on a controller display, which is used only to validate the measurement, never as its prior
  - parses a pump-curve datasheet
  - cross-checks the audio
- **Muse Wonder** (`muse-wonder-1.0`) is the reliability engineer, running a tool-calling agent loop through the Responses API with `previous_response_id`. Its tools are `get_identification`, `test_kinematic_hypothesis`, `run_optimiser`, `report_diagnosis` and `propose_setpoint`.
  - When the speed posterior is ambiguous, it re-runs the Bayesian inference under alternative kinematics (for example a two-stroke instead of a four-stroke engine) and compares the probabilities before concluding.
  - It applies practitioner rules: 1× means imbalance, 2× at 180° across the coupling means misalignment, and an order crossing a mode means resonance.
  - It cites evidence IDs for every finding and proposes a setpoint for a person to approve.
  - A numeric provenance checker matches every number in its text against the tool outputs, and the UI flags any number that doesn't match.
- **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) provides a realtime WebSocket session with diarization for hands-free operation on the plant floor, in English, Hindi, Tamil and other languages, including code-switched speech.
- **Muse Spark Open** (open weights via Baseten) provides a private mode: the same agent loop runs over Chat Completions, so plant data can stay on infrastructure the plant controls.

---

## Why do Meta's models matter for this?

The hard part of machine diagnostics was never the FFT. It is knowing *where* to measure, *what* you are looking at and *what the numbers mean*. Until now that needed a specialist on site. Each of those gaps maps to a Meta capability:

- **Where to measure.** SAM 3.1's open-vocabulary segmentation means the operator says "bearing housing" instead of gluing accelerometers onto it. Video tracking keeps those sensors on the part.
- **What you are looking at.** Muse Spark's multimodal structured output provides the physical context: nameplate speed, blade count, engine type and scale. Without it the frequencies are genuinely ambiguous: the same comb of lines is a 750 rpm machine or a 1,500 rpm four-stroke diesel. With it, a Bayesian model can say which, and how sure it is.
- **What the numbers mean.** Muse Wonder can hold the whole identification in context, call tools, and explain a decision the way a vibration analyst would. It stays bound to measured evidence.
- **Field use.** Voice Transcribe's code-switching fits how technicians actually talk on Indian shop floors. Open weights let a plant keep its data in-house, which is often a hard requirement in industry.

The split is deliberate: the models decide *where* and *why*, and deterministic physics produces *every number*. That keeps the system trustworthy enough to touch a drive setpoint.

---

## Partner / API feedback

Concrete issues from building on the Meta Model API this week:

1. **SAM 3.1 video streaming** sent no incremental deltas. The full result arrived only in the final `output_text.done` event, so we had to buffer it. Progressive per-frame events would allow live overlays.
2. **SAM concept prompts** missed generic industrial nouns (for example "motor" on a pump skid). Prompting with Muse Spark boxes fixed it. A documented box-plus-text combined mode would help.
3. **Mask payloads.** Decoding the default mask format in pure Python blocked our event loop on multi-region frames. The `one_bit` format solved it, so we'd suggest making it the documented default for performance-sensitive apps.
4. **Voice Transcribe file endpoint** returned an HTTP 400 until `audioEncoding: "WAV"` was set explicitly. The error message didn't name the missing field.
5. **Responses API state.** Long agent runs occasionally hit "previous response not found or expired". We fall back to resending the full history. A documented TTL would let us plan for it.
6. **Audio on Muse Spark** needs `1.2` while the rest of the stack uses `1.3`. A single model ID that handles audio would simplify things.
7. **Positives:** the API is OpenAI-compatible, so it worked with the stock SDK. Structured output was reliable at `reasoning.effort: "minimal"` (about 4–8 s per scene call), and Muse Wonder's tool calling stayed on task across multi-turn tool loops.

---

## Honest limits (for judges who ask)

- **Closed-loop results** come from a simulated VFD plant. The synthetic accuracy numbers come from rendered clips with known answers. The real clips have no tachometer ground truth.
- **Order ambiguity.** Without a nameplate or blade count, the microphone can't always tell which shaft order it hears. Example: the factory exhaust fan reads 825 rpm in clip mode, but ≈412 rpm from the blade-pass analysis.
- **A correction we made.** An earlier version reported 2,978 rpm for the induction-motor bench clip. That was the 49.74 Hz mains line read as 1×. The kinematic layer now masks electrical lines and reports that speed as not identifiable from that audio.
- **Open weights.** The private mode code path exists, but this build was not run against a Baseten endpoint, because no key was configured.

# Demo video script (3:00) and X post

The voice-over is about 410 words, which fits 3:00 at a calm pace (~140 wpm). Record the screen at 1920×1080 in the dark theme. Use **recorded runs** for every console shot, so nothing waits on API latency. Cut the Analyse-mode wait (45–75 s) if you show a live run.

## Before recording

- Start the servers:
  - API: `uv run uvicorn argonaut.server:app --port 8000`
  - Web: `pnpm dev` in `web/`
  - Plant: `uv run python -m argonaut.sim.plant --modbus-port 5020`
- Open these tabs in order:
  1. `http://localhost:5173/` (landing)
  2. `/console` (the featured clip auto-plays)
  3. `/console?replay=demo_fan_closed_loop`
  4. `docs/BENCHMARK.md` on GitHub
- Recorder: OBS, or Windows Game Bar (`Win+Alt+R`). Record the voice-over separately, then lay it over the screen recording.
- Hide the bookmarks bar, set the browser zoom to 100%, and close the notifications.

## Shot list

| Time | Screen | Voice-over |
|---|---|---|
| **0:00–0:12** | Landing hero video. The hero spectrogram animates. | "Half the world's electricity goes into electric motors. Most of them drive pumps and fans, at speeds nobody has ever checked against the machine's own resonances." |
| **0:12–0:30** | Landing → the Sense / Measure / Identify stages. Overlay the line *IEA 4E, 2025: motors = 53% of global electricity.* | "Finding those resonances takes a specialist test: accelerometers, a tachometer, a data recorder and an analyst. So most variable-speed drives run on factory defaults for life. Argonaut does that test with a camera and a microphone." |
| **0:30–0:55** | `/console`, real footage: the factory exhaust fan. Point the cursor at the credit chip, then at the sensor masks as they draw in. | "This is real public footage of a factory exhaust fan. SAM 3.1 places virtual sensors by name: the housing, the frame, and a static wall reference to cancel camera shake. Muse Spark understands the scene and refuses to put a sensor on the spinning blades." |
| **0:55–1:20** | Sample strip → **Diesel genset · controller reads 1542 rpm** (recorded run). Open the **Faults** tab: point at the speed posterior, then the green "display" marker. | "Which shaft order is the microphone hearing? Muse Spark reads what the machine is: a four-stroke diesel genset. A Bayesian model then weighs every line in the sound against what a four-stroke engine can produce. It says 1,542 rpm. The controller display, which the model never saw, reads 1,542. Without knowing it's a four-stroke, the same audio reads 771." |
| **1:20–1:40** | Sample strip → **1500 kVA genset**, then **exhaust fan**. Point at the posterior peak and its probability, then at the fault list with its evidence in decibans. | "The same physics on a 1500 kilowatt-amp generator: 1,498 rpm at 98 percent. On the fan, the six blades Muse Spark counted turn a 2,477 rpm misreading into 413. Each fault gets a probability with its evidence. Faults the footage can't support are marked not evaluable, not guessed." |
| **1:40–2:00** | Sample strip → **AC condenser fan · coast-down** (recorded run). In the Muse Wonder panel, show the `test_kinematic_hypothesis` calls, then hover a provenance badge. | "Muse Wonder is the reliability engineer. Here the speed is ambiguous, so it tests the alternative itself: what if this fan had four blades, not three? It compares the probabilities, cites evidence for every finding, and is never allowed to produce a number itself." |
| **2:00–2:35** | `/console?replay=demo_fan_closed_loop`: proposal, envelope, **Approve**, the setpoint written over Modbus, the re-measurement, the verification result. Overlay the line *Simulated VFD plant.* | "Now close the loop on a simulated drive. The digital twin is updated from measurements. The optimiser moves the speed out of resonance using the probability of resonance, not a point estimate. A person approves the envelope, the setpoint goes to the drive over Modbus, and Argonaut re-measures. Vibration falls from 2.59 to 0.30 millimetres per second, minus 89 percent, and a t-test confirms it's real." |
| **2:35–2:50** | `docs/BENCHMARK.md` headline table, scrolling slowly. | "We benchmarked it against ground truth: running speed within a quarter of a percent, the mode within one percent, misalignment phase within a fifth of a degree, and camera shake rejected to under three percent of its size." |
| **2:50–3:00** | Architecture strip: SAM 3.1 · Muse Spark · Muse Wonder · Voice Transcribe · Muse Spark Open, then the GitHub URL. | "Meta's models decide where to look and what it means. Physics produces every number. Argonaut: a vibration test lab in a camera." |

## Shot notes

- **Show it was built this week.** Flash the GitHub commit list (all commits dated Nov 3, 2026) for one second under the last shot.
- **Say "simulated" out loud** on the closed-loop shot. Judges will ask, and saying it first makes the result more credible, not less.
- **Use the genset with the controller display** as the real-footage proof. It is the one clip with an independent speed reference.
- **Don't quote a speed for the induction-motor bench.** Its audio is mostly mains lines, and the posterior correctly calls its speed ambiguous.
- **Show the upload tile once.** Drop a phone video on the live view to show that any machine can be analysed.
- **Voice and open weights.** Show Voice Transcribe or Muse Spark Open on screen only if you record them working. The script mentions them only in the architecture strip.

## X post (Most Viral prize)

Attach a 30–45 s cut of shots 0:30–1:15 and 2:00–2:35 as native video. A link alone gets far less reach.

**Option A (about 250 of 280 characters, counting the link as 23):**

> Built Argonaut for the @AIatMeta hackathon: a vibration test lab in a camera.
>
> SAM 3.1 places virtual sensors, the mic is a tachometer, Muse Wonder finds the resonance and retunes the drive.
>
> Vibration −89% on a sim plant.
>
> [video] github.com/ashfaque-rifaye/argonaut

**Option B (hook first):**

> Half the world's electricity runs motors. Most run at speeds nobody checked against their own resonances.
>
> I built an agent that finds them from video and sound, and moves the drive out of resonance, with a person approving.
>
> Built on @AIatMeta Muse + SAM 3.1 🧵

Follow-up reply for the thread: "Every number the agent writes is checked against measured tool outputs. 66/66 verified. Code: github.com/ashfaque-rifaye/argonaut"

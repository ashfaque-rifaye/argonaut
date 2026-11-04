# Demo video script (3:00) and X post

The voice-over is about 300 words (intro and outro films carry the rest), which fits 3:00 at a calm pace (~140 wpm). Record the screen at 1920×1080 in the dark theme. Use **recorded runs** for every console shot, so nothing waits on API latency. Cut the Analyse-mode wait (45–75 s) if you show a live run.

## Script as recorded

No zooming: rings and part highlights follow the voice-over. Build with `film/demo/voice.py`, `record.mjs` and `compose.py`.

| 0:00 | Intro film |
|---|---|
| Welcome sheet | Motors use half the world's electricity, and most of them run at speeds nobody ever checked against their own resonances. Argonaut turns any camera into a vibration analyst. Pick a machine, upload your footage, or connect a live feed. |
| Motor-pump skid, hand-held. Machine sound first, then the highlight follows the part being named | A hand-held walk around a real motor and pump. Muse Spark names each part and what it does. SAM 3.1 tracks it, so the outline stays on the motor housing, then the baseplate, as the camera moves. Every reading is measured inside that moving mask, with the camera's own motion subtracted. |
| Exhaust fan. Machine sound first, then the kinematic panel | Now a factory fan, starting up. Muse Spark counts six blades. A Bayesian model then weighs every line in this sound against what a six-blade fan can produce, and answers 413 rpm, with 97 percent probability. Without the blade count, the same sound reads 2477. |
| Belt, mine conveyor, pump, motor bench | The same engine runs on belts, mine conveyors, pumps and a motor test bench. Where the evidence is ambiguous, it says so instead of guessing. And anyone can upload their own video. |
| Agent actions on the simulated pump | Then the agents act. Muse Wonder calls tools and decides the fix. Here it field-balances a pump: it measures the vibration vector, fits a trial weight, and computes the correction, 18.9 grams at 211 degrees. One-times vibration falls 84 percent, inside the ISO limit. It writes the work order and books the re-check. A person approves every step. This one ran on our simulated drive. |
| Closed loop and provenance | It also runs the machine better: out of resonance, then re-measured. Vibration fell 89 percent on the simulated plant, and every number the agent writes is checked against the measurements. |
| The spoken command is heard, then the recorded run | That spoken command, in Hindi and English together, went through Muse Voice Transcribe and started this analysis. The agent then reasoned on the open-weight Muse Spark Open, which a plant can host itself. |
| Roster card: every model and agent action | Five Meta models, each with one job. SAM 3.1 is the sensors. Muse Spark is the eyes: it names parts, counts blades and reads nameplates. Muse Wonder is the engineer. Voice Transcribe is the ears. Muse Spark Open keeps data private. Then five agent actions: field balance, drive skip bands, the work order, the cost impact, and the follow-up that proves it worked. |
| End | Outro film: four results, the name, credits |

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

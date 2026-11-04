# Demo video script (3:00) and X post

The voice-over is about 300 words (intro and outro films carry the rest), which fits 3:00 at a calm pace (~140 wpm). Record the screen at 1920×1080 in the dark theme. Use **recorded runs** for every console shot, so nothing waits on API latency. Cut the Analyse-mode wait (45–75 s) if you show a live run.

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
| **0:00–0:16** | **`film/out/argonaut-intro.mp4`** (put music under it). | No voice-over: the film carries it ("53% of the world's electricity turns a motor… Give it eyes. And a mind."). |
| **0:16–0:32** | `/console`: the welcome sheet. Hover the three ways in (sample, upload, live feed), then click **Instant recorded run** on the recommended genset. | "This is Argonaut. Pick a recorded machine, upload any video, or connect a live camera. SAM 3.1 places virtual sensors by name, and Muse Spark reads what the machine is." |
| **0:32–0:58** | Genset 1500 kVA replay (`&speed=2`). Enlarge the footage (⤢) as the masks draw, then open **Faults**. | "Every line in this generator's sound is a multiple of 12.49 hertz. That's a 750 rpm machine, or a 1,500 rpm four-stroke's half orders. Muse Spark says four-stroke diesel; a Bayesian model weighs every line and says 1,498 rpm, 98 percent. Without that knowledge, the same audio reads 750." |
| **0:58–1:15** | Machines strip → **Genset · controller reads 1542 rpm**. Point at the green "display" marker on the posterior. | "Here the controller shows 1,542 rpm. The model never saw it. From sound alone it says 1,542.4." |
| **1:15–2:00** | `/console?replay=demo_agent_actions&speed=4`. Follow the **Agent actions** panel: the diagnosis, the balance card with its steps, the PASS chip, then download the work order (.md). Overlay *Simulated drive (Modbus)*. | "Detection is half the job. Muse Wonder decides what fixes the machine: here, a field balance. It measures the 1× vector, fits a trial mass, computes the influence coefficient and the correction: 18.9 grams at 211 degrees. One-times vibration drops 84 percent, and the residual passes ISO 21940 grade 6.3. Then it writes the work order and books the re-measurement." |
| **2:00–2:25** | `/console?replay=demo_fan_closed_loop&speed=2`: proposal, envelope, Approve, the re-measurement. | "It also runs the machine better: the optimiser moves the drive out of resonance, a person approves, and Argonaut re-measures. Vibration falls 89 percent, and a t-test confirms it." |
| **2:25–2:45** | `docs/KINEMATICS.md` results table, then `docs/BENCHMARK.md` headline. | "Every claim is checked: six of six faults on ground truth, speed within a quarter of a percent, and 98 percent of the numbers the agent writes traced back to measurements." |
| **2:45–3:00** | **`film/out/argonaut-outro.mp4`**. | No voice-over. |

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

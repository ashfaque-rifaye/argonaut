# Argonaut

**Camera-native system identification and real-time optimisation for rotating plant, built on Meta's models.**

Argonaut turns a video of a pump, fan, motor, diesel genset or washing machine into a live digital twin of the machine. From that twin it works out the speed setpoint that runs the machine best, and before anything is applied it checks the move with physics and a person signs off.

- **SAM 3.1** places *virtual sensors by name* ("motor housing", "pump casing", "baseplate"). When a name isn't found directly, **Muse Spark** draws a box around the part and SAM refines that box to a pixel-accurate mask. Each mask becomes a contact-free accelerometer.
- Our signal processing measures **sub-pixel motion** in each region, cancelling camera shake against a static reference. From that it tracks speed and orders; when the frame rate is too low, the microphone acts as the tachometer.
- From a run-up or coast-down it identifies **natural frequencies and damping (with error bars)** and the **Campbell critical speeds**. It also runs **operational modal analysis (FDD)** to get mode shapes and phase across sensors.
- **Muse Spark** reads the scene, nameplate and pump-curve datasheet, coaches the capture, and *listens* to the clip as an independent check.
- **Kinematic inference** ([docs/KINEMATICS.md](docs/KINEMATICS.md)). Muse Spark also says what the machine physically is: engine stroke, blade count, poles, gear teeth, any rpm on a controller display. A Bayesian harmonic sieve with an Occam factor then turns the sound into a **posterior over running speed**, settling ambiguities a spectrum alone cannot (a 1,500 rpm four-stroke's half orders against a 750 rpm machine). A log-odds model gives a **posterior per fault hypothesis**, with each piece of evidence in decibans, and marks hypotheses the footage cannot support as not evaluable. On a genset whose controller reads 1,542 rpm, the microphone posterior gives 1,542.4 rpm without seeing the display.
- **Muse Wonder** is a tool-using engineer agent. It never invents numbers. It diagnoses from the measured evidence (imbalance, misalignment, resonance, cavitation, ISO 20816 severity) and runs a **constrained real-time optimiser** over the drive speed: minimise energy at the required duty, stay clear of resonance bands, keep NPSH margin, and stay in zone A/B.
- **Agents act, not just detect.** After the diagnosis Muse Wonder queues corrective actions in the console's *Agent actions* panel; the operator approves, Argonaut executes on the drive and re-measures:
  - **Field balancing** by the influence-coefficient method (baseline 1× vector, trial mass, α = (V1 − V0)/T, correction C = −V0/α), checked against ISO 21940-11 G6.3. In the recorded run the agent cut 1× vibration by 84 % on the simulated drive.
  - **Drive lock-out of resonance bands**: programs the VFD's skip frequencies over Modbus, reads them back and proves the drive refuses a setpoint inside a band.
  - **Work orders** for the CMMS (ISO 14224 failure mode, risk-matrix priority, tasks with tolerances, safety, parts, verification), downloadable as Markdown; **impact** (kWh, $, CO₂ per year); **follow-up** date.
  - Without a connected drive (real footage) the physical steps go into the work order for a technician instead.
- A person **approves**. The setpoint is written to the drive (a simulated VFD over Modbus TCP), and Argonaut **re-measures to verify** the predicted change.
- **Muse Voice Transcribe** provides realtime, code-switched voice control (English, Hindi, Tamil, …). **Muse Spark Open** (open weights, via Baseten) provides a private mode.

## Run
```bash
uv sync
cp .env.example .env                                   # add MODEL_API_KEY (and optionally BASETEN_API_KEY)
uv run python scripts/smoke_test.py                    # checks every Meta model we use
uv run uvicorn argonaut.server:app --port 8000         # realtime backend
cd web && pnpm install && pnpm dev                     # control room UI at http://localhost:5173
```
- **Replay a recorded run:** `http://localhost:5173/?replay=pump_steady_misalignment`
- **Self-playing simulator:** `?mock=1&autoplay=1`
- **Simulated plant with VFD:** `uv run python -m argonaut.sim.plant --modbus-port 5020`. The server attaches it automatically.
- **Analyse a clip from the command line:** `uv run python scripts/analyse_clip.py data/synth/fan_coastdown.mp4 "Fan F-101" --api`
- **Tests:** `uv run pytest -q`, covering the DSP engine, kinematic inference and the simulator plus ground-truth videos.
- **Fault-inference evaluation on ground truth:** `uv run python scripts/fault_eval.py` (6/6 synthetic clips).
- **Your own video:** drop an mp4/mov on the live view or use the *Upload video* tile under it. The console runs it through the same engine.
- **A live camera:** *New source → Connect a live feed* takes an RTSP / HTTP / HLS URL (or a camera index); the server decodes it into the live engine and relays an MJPEG preview to the browser.
- **Agentic demo with the drive:** start the plant (`uv run python -m argonaut.sim.plant --kind pump --modbus-port 5020 --noise 0.02 --speed 1480 --ramp 300`), then `uv run python scripts/record_agent_demo.py`, or open the recorded run `?replay=demo_agent_actions&speed=4`.
- **Intro / outro films:** `npm i --prefix film playwright-core@1.48.2` then `node film/render.mjs intro` (or `outro`): frame-accurate HTML motion graphics rendered through Microsoft Edge to `film/out/*.mp4`.

## Layout
| Path | What |
|---|---|
| `argonaut/dsp/` | Motion tracking, spectra, order and speed tracking, resonance fit, Campbell, FDD, audio, ISO zones, kinematic speed and fault inference |
| `argonaut/models/` | Meta model layer: SAM 3.1, Muse Spark, Muse Wonder agent, Voice Transcribe, Muse Spark Open |
| `argonaut/optimize.py` | Digital twin and constrained speed optimiser |
| `argonaut/pipeline.py`, `server.py`, `live.py` | Session pipeline, FastAPI REST/WebSocket, live-camera engine, replay |
| `argonaut/sim/` | VFD pump/fan plant (Modbus TCP) and synthetic videos with known answers |
| `web/` | Control-room UI (React, TypeScript, uPlot, canvas) |
| `docs/` | Realtime contract and design system |

## Credits
The console's 15 real clips are in `data/library/`, with author, licence and source for each in [data/library/CREDITS.md](data/library/CREDITS.md). Raw downloads in `data/raw/` are not committed. It is reused under the licences listed in [data/VIDEO_SOURCES.md](data/VIDEO_SOURCES.md), with author and source for each clip (CC BY / CC0 / public domain). See [CONTRIBUTIONS.md](CONTRIBUTIONS.md) for what was built during the hackathon.

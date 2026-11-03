# Argonaut

**Camera-native system identification and real-time optimisation for rotating plant, built on Meta's models.**

Argonaut turns a phone video of a pump, fan or motor into a live digital twin of the machine. From that twin it works out the speed setpoint that runs the machine best, and before anything is applied it checks the move with physics and a person signs off.

- **SAM 3.1** places *virtual sensors by name* ("motor housing", "pump casing", "baseplate"). When a name isn't found directly, **Muse Spark** draws a box around the part and SAM refines that box to a pixel-accurate mask. Each mask becomes a contact-free accelerometer.
- Our signal processing measures **sub-pixel motion** in each region, cancelling camera shake against a static reference. From that it tracks speed and orders; when the frame rate is too low, the microphone acts as the tachometer.
- From a run-up or coast-down it identifies **natural frequencies and damping (with error bars)** and the **Campbell critical speeds**. It also runs **operational modal analysis (FDD)** to get mode shapes and phase across sensors.
- **Muse Spark** reads the scene, nameplate and pump-curve datasheet, coaches the capture, and *listens* to the clip as an independent check.
- **Muse Wonder** is a tool-using engineer agent. It never invents numbers. It diagnoses from the measured evidence (imbalance, misalignment, resonance, cavitation, ISO 20816 severity) and runs a **constrained real-time optimiser** over the drive speed: minimise energy at the required duty, stay clear of resonance bands, keep NPSH margin, and stay in zone A/B.
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
- **Tests:** `uv run pytest -q`, covering the DSP engine and the simulator plus ground-truth videos.

## Layout
| Path | What |
|---|---|
| `argonaut/dsp/` | Motion tracking, spectra, order and speed tracking, resonance fit, Campbell, FDD, audio, ISO zones |
| `argonaut/models/` | Meta model layer: SAM 3.1, Muse Spark, Muse Wonder agent, Voice Transcribe, Muse Spark Open |
| `argonaut/optimize.py` | Digital twin and constrained speed optimiser |
| `argonaut/pipeline.py`, `server.py`, `live.py` | Session pipeline, FastAPI REST/WebSocket, live-camera engine, replay |
| `argonaut/sim/` | VFD pump/fan plant (Modbus TCP) and synthetic videos with known answers |
| `web/` | Control-room UI (React, TypeScript, uPlot, canvas) |
| `docs/` | Realtime contract and design system |

## Credits
The test footage in `data/raw/clips/` is not committed. It is reused under the licences listed in [data/VIDEO_SOURCES.md](data/VIDEO_SOURCES.md), with author and source for each clip (CC BY / CC0 / public domain). See [CONTRIBUTIONS.md](CONTRIBUTIONS.md) for what was built during the hackathon.

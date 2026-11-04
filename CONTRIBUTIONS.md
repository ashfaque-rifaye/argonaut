# Contributions and provenance

The hackathon rules require that judges can clearly identify what was built during the event (Oct 26 – Nov 4, 2026).

## Built during the hackathon
All code in this repository was written from scratch starting **2026-11-01**. The first commit marks the start. Every feature shown in the demo is listed here as it lands.

| Date | Feature |
|---|---|
| 2026-11-01 | Project scaffold and a smoke test for every Meta model we use |
| 2026-11-01 | DSP engine: sub-pixel virtual-sensor tracking with camera-shake cancellation; spectra; speed and order tracking (Viterbi ridge plus phase-locked order tracking); order-sweep resonance with SDOF curve fit (fn, ζ with error bars); Campbell critical speeds; FDD operational modal analysis; audio corroboration, envelope spectrum and cavitation index; ISO 20816 zones |
| 2026-11-01 | Digital twin plus constrained real-time speed optimizer (resonance exclusion, duty, severity, NPSH, affinity laws) |
| 2026-11-01 | Meta model layer: SAM 3.1 virtual sensors (image plus video tracking), Muse Spark scene/nameplate/datasheet/audio checks, Muse Wonder tool-using agent, Muse Spark Open private mode, Muse Voice Transcribe realtime |
| 2026-11-01 | FastAPI realtime server (REST plus WebSocket, live camera engine, replay) and an offline end-to-end test |
| 2026-11-02 | Control-room UI (web/), plant simulator with Modbus VFD and synthetic ground-truth videos (argonaut/sim/), licensed real-footage library |
| 2026-11-03 | Live Meta API integration: Muse Spark box localisation refined by SAM 3.1 box prompts, rigid-body sensor rejection, microphone tachometer with subharmonic refinement |
| 2026-11-03 | Hardening: streaming engine (per-frame incremental tracking, 10 Hz telemetry, latency budget); audio-guided de-aliasing; confidence intervals and robust resonance probability; closed-loop RTO with Bayesian twin update and trust region; significance-tested verification; numeric provenance checker for agent output |
| 2026-11-03 | Kinematic inference (docs/KINEMATICS.md): Muse Spark kinematic model, forcing-frequency families, mains-frequency detection, Bayesian harmonic-sieve speed posterior with Occam factor and physics priors, log-odds fault posterior with speed-uncertainty mixing, Muse Wonder what-if tool; synthetic fault evaluation; 5 more real machine clips (two diesel gensets, two washing machines, a centrifugal pump); console sample strip and drag-and-drop upload |
| 2026-11-04 | Agents that act (argonaut/actions.py): influence-coefficient field balancing with ISO 21940-11 check, VFD skip-frequency lock-out with read-back test, ISO 14224 work orders, impact and follow-up; simulated drive gains an unbalance vector, balancing masses, keyphasor 1x phase and skip bands over Modbus; operator approvals API; live camera feeds (RTSP/HTTP) with MJPEG relay; console redesign (glass, large footage, welcome sheet with sample / upload / live feed, guided tour, panel explanations); intro and outro films (film/) |
| 2026-11-04 | Shot-aware video tracking (`argonaut/track.py`), measurement inside moving masks, live entity labels, footage sound, real Voice Transcribe and Muse Spark Open runs, hosted backend with public limits (`argonaut/guard.py`), demo re-cut. |

## Pre-existing tools and libraries (not our work)
- Meta Model API and models: Muse Spark, Muse Wonder, SAM 3.1, Muse Voice Transcribe, and Muse Spark Open (open weights, via the Hugging Face router)
- Open-source libraries listed in `pyproject.toml` (OpenAI Python SDK, OpenCV, NumPy, SciPy, httpx, websockets, meta-sam-parser, pymodbus); Playwright (film rendering only)

## Not reused
No code from earlier personal projects or from any employer is included.

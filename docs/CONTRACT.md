# Realtime contract: frontend ↔ backend

The backend is FastAPI at `http://localhost:8000`. The frontend is Vite + React + TypeScript in `web/`, served on `http://localhost:5173`, and proxies `/api` and `/ws` to the backend.
All messages are JSON with a `type` field. Units are SI unless the field name says otherwise (`_hz`, `_mm`, `_rpm`, `_kw`). Timestamps `t` are seconds from session start.

## REST
| Method | Path | Body / result |
|---|---|---|
| POST | `/api/sessions` | `{asset_name, mode: "live"\|"clip"}` → `{session_id}` |
| POST | `/api/sessions/{id}/clip` | multipart `file` (mp4/mov) → `{clip_id, fps, duration_s, width, height}` |
| POST | `/api/sessions/{id}/datasheet` | multipart `file` (pdf/png) → `{ok}`; parsed asynchronously, result arrives as an `asset` event |
| POST | `/api/sessions/{id}/approve` | `{proposal_id, approved: bool, note?}` → `{ok}` |
| GET | `/api/sessions/{id}/report` | full JSON snapshot of the session (all of the latest events) |

## WebSocket `/ws/{session_id}`

### Client → server
```jsonc
{"type":"frame", "t":1.23, "jpeg_b64":"..."}            // live mode, ≤30 fps, ≤960 px wide
{"type":"audio", "t":1.23, "pcm16_b64":"...", "rate":24000} // mono PCM chunks, ~80 ms each
{"type":"sensors.set", "prompts":["bearing housing","baseplate","wall"]} // virtual sensors by name
{"type":"command", "name":"start_coastdown"|"stop"|"identify"|"optimize"|"verify"}
{"type":"chat", "text":"why did you pick 2.6?"}
```

### Server → client
```jsonc
// Status of each model or pipeline stage, for the "model rail" UI
{"type":"pipeline", "stage":"sam"|"spark"|"wonder"|"voice"|"dsp"|"open_weights",
 "state":"idle"|"running"|"ok"|"error", "model":"sam-3.1", "latency_ms":420, "detail":"tracking 4 regions"}

// Virtual sensors: SAM masks reduced to polygons, in source pixel coordinates
{"type":"sensors", "t":2.0, "width":960, "height":540,
 "items":[{"id":"s1","label":"bearing housing","color":"#38BDF8","polygon":[[x,y],...],
           "bbox":[x1,y1,x2,y2],"confidence":0.93,"is_reference":false}]}

// Live measurement, ~10 Hz
{"type":"telemetry", "t":2.1,
 "speed_hz":24.6, "speed_rpm":1476, "speed_source":"video+audio",
 "channels":[{"id":"s1","disp_mm_rms":0.082,"vel_mm_s_rms":3.1,"iso_zone":"B"}],
 "overall_vel_mm_s_rms":3.4, "iso_zone":"B"}

// Spectrum per channel (latest window), ~4 Hz
{"type":"spectrum", "t":2.1, "channel":"s1", "f_hz":[...], "amp":[...], "unit":"mm/s",
 "peaks":[{"f_hz":24.6,"amp":2.9,"order":1.0,"label":"1×","corroborated_audio":true}]}

// Waterfall row (append), ~4 Hz
{"type":"waterfall", "t":2.1, "channel":"s1", "f_max_hz":120, "row":[...uint8 0-255...]}

// Campbell diagram (after a run-up / coast-down)
{"type":"campbell", "speeds_rpm":[...],
 "modes":[{"f_hz":14.2,"f_err_hz":0.3,"zeta":0.021,"zeta_err":0.006,"label":"Stand rocking mode"}],
 "orders":[1,2,5], "criticals":[{"rpm":852,"order":1,"mode_f_hz":14.2}]}

// Operational modal analysis
{"type":"modal", "method":"FDD", "f_hz":[...], "sv1":[...], "sv2":[...],
 "modes":[{"f_hz":14.2,"zeta":0.021,"shape":[{"id":"s1","amp":1.0,"phase_deg":0},{"id":"s2","amp":0.4,"phase_deg":178}]}]}

// Asset model / digital twin
{"type":"asset", "name":"Fan F-101", "nameplate":{"rpm":1450,"kw":0.075,"poles":4},
 "pump_curve":{"q":[...],"h":[...],"eta":[...],"npshr":[...]} | null,
 "bep":{"q":12.0,"h":18.0} | null}

// Diagnosis with evidence
{"type":"diagnosis", "id":"d1", "severity":"info"|"warn"|"alarm",
 "title":"Operating on structural resonance", "summary":"...",
 "evidence":[{"kind":"spectrum_peak","channel":"s1","f_hz":14.2},{"kind":"frame","t":3.4,"jpeg_b64":"..."},
             {"kind":"metric","name":"zeta","value":0.021,"err":0.006}],
 "confidence":0.88, "model":"muse-wonder-1.0"}

// Optimizer proposal (needs human approval)
{"type":"proposal", "id":"p1", "objective":"min specific energy",
 "current":{"speed_rpm":1450,"vel_mm_s":7.9,"kw":0.075},
 "proposed":{"speed_rpm":1220,"vel_mm_s":2.5,"kw":0.045},
 "constraints":[{"name":"resonance margin","value":"≥12% from 852/1704 rpm","ok":true},
                {"name":"NPSH margin","value":"1.6","ok":true}],
 "feasible_band_rpm":[[900,1600]], "exclusion_bands_rpm":[[780,930],[1610,1790]],
 "expected":{"vibration_change_pct":-68,"energy_change_pct":-40},
 "rationale":"...", "model":"muse-wonder-1.0"}

// Verification after a setpoint change
{"type":"verification", "proposal_id":"p1", "predicted_vel_mm_s":2.5, "measured_vel_mm_s":2.7,
 "passed":true, "summary":"Predicted change confirmed within 8%"}

// Agent narration / chat (streamed)
{"type":"agent", "role":"assistant", "text":"...", "final":false}

// Voice transcript (Muse Voice Transcribe)
{"type":"transcript", "speaker":"A", "text":"start coast-down", "final":true}

// Capture coaching (Muse Spark)
{"type":"coach", "level":"ok"|"warn"|"block", "text":"Move 30 cm closer; nameplate unreadable"}

{"type":"error", "message":"..."}
```

## Replay mode
The backend can replay a recorded session (`data/runs/<id>/events.jsonl`) over the same WebSocket at real speed. The demo and UI development therefore run without a camera or API key: `GET /ws/replay/{run_id}`.

---

## v2 additions (hardening): realtime, de-aliasing, uncertainty, closed-loop RTO, provenance

All fields below are additive. Existing fields keep their meaning.

### telemetry (extended)
```jsonc
{"type":"telemetry", ...,
 "latency": {"frame_to_telemetry_ms": 38.2, "p95_ms": 61.0, "fps_in": 29.8, "frames_dropped": 0},
 "band": {"direct_hz": 14.9, "dealiased_hz": 120.0},   // measurable band now: camera Nyquist vs with audio de-aliasing
 "overall_vel_ci": [3.1, 3.7]}                          // 90% CI of overall_vel_mm_s_rms
```

### spectrum.peaks[] (extended)
```jsonc
{"f_hz":24.6, "amp":2.9, "amp_ci":[2.6,3.2], "order":1.0, "label":"1×", "corroborated_audio":true,
 "aliased": true, "f_alias_hz": 5.4}   // present when the peak was recovered by de-aliasing
```

### dealias (new, ~1 Hz while live, once per clip)
```jsonc
{"type":"dealias", "channel":"s1", "fs_video": 30.0, "speed_hz_audio": 24.61, "speed_source":"audio",
 "peaks":[{"f_alias_hz":5.39, "f_true_hz":24.61, "order":1, "fold":1, "residual_hz":0.04, "confidence":0.93},
          {"f_alias_hz":10.78,"f_true_hz":49.22,"order":2, "fold":2, "residual_hz":0.06, "confidence":0.88}]}
```
`fold` = n in f_true = |f_alias − n·fs|, or n·fs + f_alias. A peak is assigned only if exactly one order k·speed explains it within `residual_hz`.

### proposal (extended)
```jsonc
{"type":"proposal", ...,
 "curve": {"rpm":[...], "vel":[...], "vel_lo":[...], "vel_hi":[...], "kw":[...], "p_res":[...]},  // p_res = P(an order lands inside a mode's half-power band), 0..1
 "risk": {"p_res_current":0.62, "p_res_proposed":0.01, "threshold":0.05},
 "constraints":[..., {"name":"P(resonance)", "value":"1% ≤ 5%", "ok":true}]}
```

### verification (extended)
```jsonc
{"type":"verification", ..., "before_ci":[7.4,8.3], "after_ci":[2.5,2.9], "p_value":0.0003, "significant":true}
```

### Envelope approval + closed-loop RTO (new)
REST `POST /api/sessions/{id}/envelope` `{"lo_rpm":900, "hi_rpm":1500, "max_step_rpm":150, "approved":true}` → `{ok}`
Starts the closed loop against the plant (simulated VFD over Modbus) inside the approved envelope.
REST `POST /api/sessions/{id}/rto/stop` → `{ok}`.

```jsonc
{"type":"rto", "iteration":3, "status":"stepping"|"settling"|"measuring"|"updating"|"converged"|"aborted",
 "envelope_rpm":[900,1500], "max_step_rpm":150,
 "setpoint_rpm":1220, "speed_rpm":1231,
 "predicted":{"vel_mm_s":3.1, "vel_lo":2.7, "vel_hi":3.6, "kw":45.0},
 "measured":{"vel_mm_s":3.4, "kw":46.1} | null,
 "model":{"modes":[{"f_hz":14.21,"f_sd":0.08,"zeta":0.021,"zeta_sd":0.003}], "gain_1x":0.97, "gain_sd":0.05},
 "objective":{"kw":45.0, "j":0.61},
 "history":[{"iteration":1,"setpoint_rpm":1476,"pred_vel":7.9,"meas_vel":7.8,"kw":79.0}, ...],
 "reason":"converged: |Δsetpoint| < 10 rpm and prediction error 6% < 15%",
 "source":"plant simulator (Modbus)"}
```

### agent (extended): numeric provenance
```jsonc
{"type":"agent", "role":"assistant", "text":"... 14.76 Hz ...", "final":true,
 "claims":[{"start":42, "end":47, "value":14.76, "verified":true, "source":"modes[0].f_hz"},
           {"start":80, "end":83, "value":12.0, "verified":false, "source":null}],
 "provenance":{"verified":11, "unverified":1}}
```
`start`/`end` are character offsets into `text`. The UI marks verified numbers (subtle tick) and unverified ones (red underline).

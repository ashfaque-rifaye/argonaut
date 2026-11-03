# Argonaut UI: design system ("Argon")

The Argonaut control room is a single-screen instrument. It has to read like a shipped industrial product: calm when the machine is healthy, and unmistakable when it is not. Everything below serves that.

---

## 1. Principles

1. **Gray is normal, color is news.** (ISA-101 high-performance HMI.) The whole UI sits on a graphite grayscale. Saturated color appears only for abnormal states (warn/alarm), for a verified pass, and for the single signature accent. If a screenshot of a healthy machine looks colorful, it is wrong.
2. **One accent, one meaning.** *Argon violet* (`#9D8CFF`, the glow of an argon discharge tube) means "AI / model at work, or the thing it proposes". Running pipeline stages, the proposed setpoint, the Approve button, selections. Never used for state.
3. **Numbers are the product.** Every measured value is set in a tabular monospace with its unit and, where we have one, its uncertainty (`14.20 ± 0.30 Hz`). Values never tween: what's on screen is what was measured.
4. **Analog context beats digits.** Severity is shown as a value pointer on a banded analog bar (ISO 20816 zones A–D), not a colored number. The operator sees *where* in the range the value sits.
5. **Evidence is one click away.** Every diagnosis and proposal carries evidence chips (spectrum peak, frame, metric ± error). They open a drawer that shows the raw proof.
6. **Show the models working.** The model rail is a first-class instrument: each Meta model's state, latency and current task are live, so judges can see SAM 3.1, Muse Spark, Muse Wonder and Muse Voice doing real work.
7. **A human closes the loop.** Approve/Reject is the largest control on screen, and the verification state that follows is as prominent as the proposal.
8. **Density with seams, not boxes.** Panels butt against each other separated by 1 px hairlines (a console bezel), no drop shadows, no rounded "cards floating on gray". Corner radius 6 px on controls, 0 between panels.

## 2. Situation-awareness levels (ISA-101 L1–L4) mapped to the screen

| Level | Purpose | Where in Argonaut |
|---|---|---|
| L1 overview | "Is anything wrong, and how bad?" | Header status + telemetry strip (speed, overall severity bar, active diagnosis) |
| L2 unit control | "What is this machine doing, and what should I do?" | Live view, optimizer proposal, digital-twin pump curve, model rail |
| L3 detail | "Why?" | Spectrum, waterfall, Campbell diagram, FDD modal panel |
| L4 diagnostics | "Show me the proof." | Evidence drawer (peak, frame, metric with error bar), agent console |

## 3. Color tokens

All tokens live in `web/src/index.css` as CSS variables and are exposed to Tailwind v4 via `@theme`.

| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#07080A` | App canvas, the seams between panels |
| `--bg-1` | `#0D0F12` | Panel surface |
| `--bg-2` | `#121519` | Panel header strip, inset wells |
| `--bg-3` | `#191D22` | Controls, hover |
| `--bg-4` | `#21262C` | Pressed / selected control |
| `--line-1` | `#1C2127` | Hairline (1 px) |
| `--line-2` | `#283038` | Strong hairline, control borders |
| `--fg-1` | `#E7EAEE` | Primary text, primary numerics |
| `--fg-2` | `#A2ABB5` | Secondary text |
| `--fg-3` | `#6C7580` | Labels, units, axis text |
| `--fg-4` | `#454D56` | Disabled, gridline labels |
| `--accent` | `#9D8CFF` | Argon violet: AI activity, proposal, primary CTA |
| `--accent-dim` | `rgba(157,140,255,.14)` | Accent wash |
| `--warn` | `#F0A63A` | Abnormal, needs attention (ISO zone C, coach warn) |
| `--alarm` | `#F2484B` | Alarm (ISO zone D, failed constraint, pipeline error) |
| `--ok` | `#3CBF8A` | **Only** for "verified" / "constraint passed". Never for "normal" |
| `--trace-1` | `#D8DEE6` | Primary data trace |
| `--trace-2` | `#7B8693` | Secondary trace (SV2, previous run) |
| `--grid` | `#171B20` | Chart gridlines |

ISO 20816 bar bands: A `#20262D`, B `#2A3139`, C `#3A2F1C` (amber-tinted), D `#3D1D1F` (red-tinted). The pointer takes the zone's semantic color only in C/D.

Sensor identity colors (mask polygons, channel legends) are muted and cool, so they never compete with warn/alarm: `#56B6E0`, `#8B9EF5`, `#4FC1A6`, `#CBB98A`, `#AEB6BF`; the static reference region is gray `#6C7580` and dashed. Backend-supplied colors are honored as-is.

Spectrogram/waterfall uses **inferno**, which is perceptually uniform, prints well in grayscale and starts from near-black so it sits on the graphite base.

## 4. Typography

- **UI:** Inter Variable (`@fontsource-variable/inter`), 12.5 px base, `cv11`, `ss01`, `tnum` features on.
- **Numerics / IDs / model names:** JetBrains Mono Variable (`@fontsource-variable/jetbrains-mono`), `tnum`, `zero`.
- Fonts are bundled, not loaded from Google Fonts, so the demo works offline.

| Role | Spec |
|---|---|
| Panel title | Inter 10.5 px / 600 / uppercase / tracking 0.08em / `--fg-3` |
| Body | Inter 12.5 px / 450 / `--fg-2` |
| Data label | Inter 11 px / 500 / `--fg-3` |
| Readout | Mono 13 px / 500 / `--fg-1` |
| Hero readout | Mono 30 px / 400 / tracking −0.02em |
| Unit | Mono 11 px / `--fg-3`, 3 px left of value |

## 5. Grid and layout

- 4 px base unit; panel padding 12 px; header strips 32 px; app header 48 px.
- Desktop (≥1280 px): header / telemetry strip / three columns: left `clamp(360px, 25vw, 460px)` (live view, model rail, agent console), center flexible (spectrum, waterfall, Campbell + modal), right `clamp(360px, 24vw, 440px)` (optimizer, digital twin). The screen fits 1440×900 to 1920×1080 without page scroll.
- Below 1280 px the right column wraps under the center; below 768 px it becomes the **phone capture view**: live view first (full width), compact telemetry, proposal, console. Charts stack.
- Panels are separated by `gap: 1px` over `--bg-0`, giving continuous hairline seams.

## 6. Motion

- UI transitions 120–180 ms `cubic-bezier(.2,.8,.2,1)`; drawer 220 ms.
- Data is never eased. Charts redraw on arrival (canvas/uPlot), 60 fps budget, no React re-render per sample for high-rate data (waterfall rows are blitted onto a canvas).
- "Running" uses a 1.6 s opacity pulse on a 6 px dot plus a moving 1 px scan line under the stage. Nothing else loops.
- ODS animation is the only large motion, and it is opt-in.
- `prefers-reduced-motion` disables pulses and the ODS auto-play.

## 7. Component inventory

| Component | File | Notes |
|---|---|---|
| AppHeader | `components/Header.tsx` | Asset, session id, mode pill (LIVE / REPLAY / SIM), connection dot + RTT, REC timer, command buttons |
| TelemetryStrip | `components/TelemetryStrip.tsx` | Speed hero + source chips, ISO 20816 analog bar, per-channel mini readouts with sparklines, active diagnosis |
| IsoBar | `components/IsoBar.tsx` | Banded analog indicator with pointer and zone letters |
| LiveView | `components/LiveView.tsx` | Webcam / clip / simulated feed, mask polygons, label chips, reference badge, ODS toggle + frequency picker, sensor prompt editor |
| ModelRail | `components/ModelRail.tsx` | Six pipeline stages, state, latency sparkline, detail |
| SpectrumPanel | `components/SpectrumPanel.tsx` | uPlot line, order cursors, peak labels (1×, 2×, BPF), audio-corroborated tick, channel tabs |
| WaterfallPanel | `components/WaterfallPanel.tsx` | Canvas spectrogram, inferno, scrolling, order-ray overlay |
| CampbellPanel | `components/CampbellPanel.tsx` | SVG; mode lines ± error band, order rays, critical circles, speed coverage rug, live + proposed speed |
| ModalPanel | `components/ModalPanel.tsx` | FDD SV1/SV2 (log), mode table f / ζ ± err, mode-shape bars, "animate ODS" |
| TwinPanel | `components/TwinPanel.tsx` | H–Q, η, NPSHr, BEP, affinity-scaled curve at current speed, live operating point, resonance exclusion bands mapped to Q |
| ProposalCard | `components/ProposalCard.tsx` | Current vs proposed, speed axis with feasible/exclusion bands, constraints, expected gains, rationale, Approve/Reject, Verification state |
| AgentConsole | `components/AgentConsole.tsx` | Streamed narration, voice transcript (speaker tags), coach, diagnoses with evidence chips, chat input |
| EvidenceDrawer | `components/EvidenceDrawer.tsx` | Spectrum peak mini-chart, frame thumbnail, metric with error bar |
| Panel, Chip, Btn, Kbd, Stat | `components/ui.tsx` | Primitives |

## 8. References (patterns, not copies)

1. **ISA-101 "Going Gray"**, Control.com: <https://control.com/technical-articles/going-gray/>. Grayscale base with color reserved for abnormal: the core of our palette.
2. **High-performance HMIs**, Control Engineering: <https://www.controleng.com/high-performance-hmis-designs-to-improve-operator-effectiveness/>. Analog indicators with normal bands, and the L1–L4 display hierarchy that maps onto our layout.
3. **"The High Performance HMI"**, ISA Interchange: <https://blog.isa.org/the-high-performance-hmi>. HP-HMI is not "remove all color"; color must earn attention. This is why we keep one accent for AI activity.
4. **Siemens Industrial Experience (iX)**: <https://ix.siemens.io>. An industrial design system whose default theme is dark. Dense control sizing and status pairing (icon + text, never color alone).
5. **Linear, "How we redesigned the Linear UI"**: <https://linear.app/now/how-we-redesigned-the-linear-ui>. A small set of base tokens generating elevation steps, and restraint with chrome. Source of our bg-0…bg-4 elevation ladder and hairline polish.
6. **Palantir Blueprint**: <https://blueprintjs.com/docs/>. Data-dense dark UI for analysts. Informs table density, mono IDs and status text paired with color.
7. **Crew Dragon display notes** (SpaceX AMA, recreated in uxdesign.cc): <https://uxdesign.cc/how-i-recreated-crew-dragons-ui-15877eddf3ed>. Text over video must stay legible on pure white or black backgrounds (our label chips use an opaque graphite backing plus a 1 px border). Large minimum targets for gloved use on the Approve control.
8. **Waterfall / forcing-frequency conventions**: Shoplogix spectral docs <https://support.ims.shoplogix.com/machine-health-monitoring/spectral-analysis> and Augury <https://www.augury.com/blog/machine-health/five-reasons-why-vibration-analysts-love-augury/>. Forcing-frequency markers on spectra, cascade orientation and amplitude scaling. We render 2D (time × frequency) rather than 3D for legibility.
9. **Perceptual colormaps (viridis/inferno)**, BIDS: <https://bids.github.io/colormap/>. Why the spectrogram uses inferno.

Dribbble and Behance searches (industrial IoT dark dashboard, SCADA HMI, telemetry mission control) returned no usable shot-level pages through the research tools. The genre's common patterns (glowing gauges, neon gradients, 3D isometric plants) were deliberately rejected as conflicting with ISA-101.

## 9. Contract assumptions (for the backend)

These are places where `docs/CONTRACT.md` is ambiguous; the UI follows the contract literally and assumes:

1. **`agent` streaming:** `text` is a **delta**. Consecutive `final:false` chunks are appended to the same bubble; `final:true` closes it (its `text` is appended too, and may be empty).
2. **`transcript` interim results:** a `final:false` transcript is the **current hypothesis** for that speaker and replaces the previous interim line; `final:true` commits it.
3. **`campbell.speeds_rpm`:** treated as the set of speeds at which data was captured. It is drawn as a coverage rug along the speed axis and sets the x-range. Order rays and mode lines are drawn analytically from `orders` and `modes`.
4. **ISO 20816 zone boundaries** are not in the contract. The bar uses class III (large rigid) boundaries, A/B 1.8, B/C 4.5, C/D 11.2 mm/s RMS. The zone **letter** always comes from the server's `iso_zone`.
5. **Waterfall rows:** `row` is linearly spaced from 0 to `f_max_hz`; row length may vary and is resampled. Newest row is drawn at the top.
6. **`diagnosis.evidence[].jpeg_b64`** may be raw base64 or a `data:` URL; both are accepted.
7. **`modal.modes[].shape[].id`** refers to `sensors.items[].id`; ζ error bars in the mode table come from the matching `campbell.modes` entry (nearest `f_hz` within 0.5 Hz), because `modal.modes` has no `zeta_err`.
8. **`asset.pump_curve`** arrays are at nameplate speed (`nameplate.rpm`). The twin scales them to live speed with the affinity laws. The live operating point assumes a pure-friction system curve through the nameplate duty point (taken as 115% BEP flow when nothing else is known). NPSHa is not in the contract, so the panel shows NPSHr only, unless the proposal carries an "NPSH margin" constraint.
9. **Session bootstrap:** the UI calls `POST /api/sessions` on load. If that fails (backend down), or `?mock=1` is set, it runs the built-in simulator. `?replay=<run_id>` connects to `/ws/replay/<run_id>`; `?session=<id>` joins an existing session.
10. **Approve flow:** the UI POSTs `/api/sessions/{id}/approve` and then waits for `verification`. It does not send a `verify` command itself unless the operator presses Verify.
11. **`pipeline.stage` set** is closed (`sam|spark|wonder|voice|dsp|open_weights`); unknown stages are ignored.

### Contract additions supported (from `argonaut/pipeline.py`, not yet in CONTRACT.md)

12. **Acoustic waterfall:** `waterfall` rows with `channel: "mic"` (f_max ≈ 1500 Hz, a few hundred bins) feed a second waterfall, reached through a **Vibration | Acoustic** switch in the waterfall panel. Acoustic markers are BPF, 2·BPF and 3·BPF; structural mode lines are hidden there. A `mic` spectrum never becomes the default selected channel.
13. **`clip_t`** (optional on `telemetry`, `spectrum`, `waterfall`) is the time axis of the waterfall when present (labels show clip seconds instead of "−Ns"). The live-view HUD shows `clip N.N s`, and a locally loaded clip is seeked to stay within 0.4 s of `clip_t`.
14. **`telemetry.speed_source`** gets a badge under the RPM readout: `audio (blade pass)` / `audio (tonal order)` → accent "mic tachometer · blade pass / tonal order"; `video` → "optical tach"; `video+audio` → "fused". The video/audio source chips light up by substring.
15. **`campbell.times_s` + `campbell.order_amp_mm`** (`{"1":[…],"2":[…],"3":[…]}`, aligned with `speeds_rpm`): the Campbell panel gains a **Campbell | Resonance** switch. Resonance plots order amplitude vs rpm (1× solid, 2× dashed, 3× dotted), shades each fitted mode's critical-speed band `60·(f ± f_err)/k`, and labels it `f ± err Hz · ζ ± err · source`. Mode objects may carry `source` and `forcing_power`. **`zeta` / `zeta_err` may be `null`** (residual-spectrum peaks) and render as "—".
16. **`proposal.curve`** (`{rpm, vel, kw}`) is drawn in the optimizer card as the objective landscape: predicted vibration (solid, left axis, ISO 20816 zone bands behind it) and power (dashed, right axis, W) against speed, with resonance exclusion bands hatched, the feasible band as a strip on the axis, critical-speed ticks, a NOW marker, the proposed diamond and a move arrow. If `curve` is absent it falls back to the plain speed-axis band chart.
17. **Floats:** rpm values (`speed_rpm`, `criticals[].rpm`, proposal speeds) arrive as floats and are rounded for display only. Constraint names are capitalized for display.
18. **Unattended demo:** `?mock=1&autoplay=1` makes the simulator approve its own proposal 9 s after it appears, so the full sense → identify → optimize → approve → verify loop plays without a person (kiosk mode). In live or replay mode approval is always manual.

---

## v2: hardening surfaces, closed loop, provenance, landing page

Everything below is driven by the "v2 additions" in `docs/CONTRACT.md`. All new fields are optional; with a v1 backend every v2 surface simply does not render.

### Routes

| Path | What |
|---|---|
| `/` | Landing page (`src/landing/`). Static: no socket, no simulator. The console bundle is lazy-loaded. |
| `/console` | The control room. All query params work here (`?mock=1&autoplay=1`, `?replay=<id>`, `?session=<id>`). |
| `/?mock=…`, `/?replay=…`, `/?session=…` | Redirected (history.replaceState) to `/console` with the same query, so old links keep working. |

The router is about 40 lines (`src/lib/router.ts`, `useSyncExternalStore` over `popstate`) with no dependency.

### New / extended components

| Component | File | Notes |
|---|---|---|
| AcqStats + BandBar | `components/Header.tsx` | Header micro-readouts (≥1024 px): frame→telemetry latency (last + p95; colour only past 150/300 ms), input fps + dropped frames, and the measurable band. Its bar is solid for 0–Nyquist (camera-direct) and violet-hatched for the band recovered by audio de-aliasing. Tooltips give exact values. Command buttons collapse to icons below 1536 px to make room. |
| IsoBar `ci` | `components/IsoBar.tsx` | 90% CI drawn as a bracket span on the ISO 20816 bar; the strip also prints `90% CI lo–hi`. |
| Spectrum v2 | `components/SpectrumPanel.tsx` | 90% CI whiskers on every peak. De-aliased peaks get a hollow violet diamond, a dashed label border and a faint arc back to the baseline tick where the camera actually sees them (`f_alias_hz`). The Nyquist line is dashed and labelled `fs/2`. A 3 px strip along the axis shows the direct band (gray) and the de-aliased band (violet). Content above the measurable band is dimmed. |
| DealiasView | `components/DealiasView.tsx` | **SPECTRUM / DE-ALIAS** switch in the spectrum header. It draws the *folding diagram*: x = true frequency, y = what the camera sees (0…fs/2). Sampling maps every true frequency onto the triangle wave, so a camera peak at f_alias is ambiguous (hollow candidates n·fs ± f_alias). The mic tachometer's order lines (k × speed, violet dashed) pick exactly one (filled diamond), annotated `k× · fold n · ±residual · confidence`. A one-line headline states the primary case in words: "Camera sees 5.39 Hz → true 24.61 Hz (1×) from mic tachometer". |
| ObjectiveChart v2 | `components/ProposalCard.tsx` | The predicted-vibration 90% band (`vel_lo/vel_hi`) replaces the gradient fill. A **P(res) lane** sits under the speed axis on a log scale (0.1 %…100 %) with the gate as a dashed line: area above the gate is alarm-red, below it gray, and the NOW dot and proposed diamond sit on it. A `P(res) current → proposed · gate` row joins the transition table. |
| Verification v2 | `components/ProposalCard.tsx` | Before/after 90% CIs as whiskers on an ISO-zoned scale, with the prediction as a violet hollow diamond, and a `p = … · significant` chip (green only when significant). |
| Optimizer tabs | `components/ProposalCard.tsx` | A `Proposal | Closed loop` tab strip under the panel header. The tab auto-switches to Closed loop when an `rto` run starts. While that tab is open the optimizer column takes more height from the twin panel. |
| ClosedLoop | `components/ClosedLoop.tsx` | **Status:** a chip (`it n · phase` in violet while running, green *Converged*, red *Aborted*) and a 4-step phase rail (stepping → settling → measuring → updating). **Source:** a chip (`source plant simulator (Modbus)`) that is never truncated. **Envelope editor:** a dual-thumb slider over the speed axis showing the feasible band, resonance hatch, P(res) heat strip, criticals, NOW and the proposal (keyboard ±10 rpm), plus a max-step segmented control and plain-language consequences, e.g. "first step moves from 1476 rpm into the envelope" and resonance-overlap warnings. **Iteration trace:** 3 lanes. rpm: envelope lines, setpoint steps in violet, measured speed. mm/s: predicted 90% band, dashed prediction, measured dots, ISO B/C line. W: power. **Model-update table:** mode f ± σ, ζ ± σ and 1× gain ± σ, with a bar showing σ relative to iteration 1. **Footer:** *Approve envelope* (accent, large), then *Stop closed loop* (danger, large), then a converged/aborted summary with the server's `reason` and *New envelope*. |
| Agent provenance | `components/AgentConsole.tsx` | Verified numbers look like plain text with a faint dotted underline. On hover they tint green and show a tiny check plus a tooltip with the `source` path. Unverified numbers have a red dotted underline and the tooltip "unverified · not found in any tool output". Each closed message gets a footer "n/m numbers traced to tool output · k unverified". The panel header shows a session counter, e.g. `Provenance 39/40 verified`, with a red dot while anything is unverified. |
| Tip | `components/ui.tsx` | Portal tooltip at fixed coordinates, clamped to the viewport, so scrolling panels never clip it. |

### Colour rules applied to v2

- **Violet** marks model/inference output only: de-aliased peaks and recovered frequencies, mic-tachometer order lines, the proposal, the RTO setpoint and its prediction band, the approved envelope.
- **Green** is used only for *verified*: provenance checks, a significant verification, a converged loop whose prediction error is inside tolerance.
- **Red** marks unverified numbers, P(res) above the gate, aborted runs and the Stop control.
- Uncertainty is always drawn in the data's own colour, either at low opacity (bands) or as whiskers, never as a new hue.

### Landing page (`/`)

The landing page uses the console's tokens, type and seams, with no stock imagery. The hero background is a live procedural spectrogram (`landing/HeroSpectrogram.tsx`). It shows a 5-blade fan cycling hold → coast-down → standstill → run-up, with orders 1×/2×/3×/BPF lighting up as they cross three structural modes, an inferno colormap and order tags at the leading edge. It pauses when the tab is hidden and stays static under `prefers-reduced-motion`.

Sections in order: hero, problem (IEA 4E figures with source), how it works (five SVG step diagrams), Meta models with their visible jobs, measured results (exact benchmark numbers, footnoted to `docs/BENCHMARK.md`), "What the AI never does" with a live specimen of the provenance marks, closing CTA, footer. It is responsive down to 390 px with no horizontal scroll.

### v2 contract assumptions

1. **`agent.claims` offsets** index the *assembled* message (all deltas concatenated), not the chunk that carries them. The UI checks that each slice actually contains `value`. If not, it tries chunk-relative offsets, then searches the text for the value. Claims that cannot be anchored still count in the provenance totals.
2. **`agent.provenance`** is per message; the header counter is the session sum. If it is absent, it is derived from `claims`.
3. **`rto` events carry no `t`.** The trace is stamped with client session time on arrival. A new run is detected when `iteration` decreases or a non-terminal status follows a terminal one. If samples are missing (joined late), the trace falls back to `history` on an iteration axis.
4. **`rto.measured.kw` / `predicted.kw`** are in kW; values < 1 kW are displayed in W.
5. **`rto.model.modes`** are matched to the first run's model by index to compute σ shrinkage.
6. **`telemetry.band.dealiased_hz == direct_hz`** is read as "no tachometer lock": de-aliased readouts are hidden and the spectrum dims everything above Nyquist.
7. **`dealias`** is shown for the selected channel, or else the first channel that has one.
8. **`verification.p_value`** below 0.0001 is shown as `< 0.0001`.
9. **Envelope pre-fill** is the feasible band that contains the proposed speed (or else the first band), with a max step of 150 rpm.
10. **`?mock=1&autoplay=1`** now also opens the Closed loop tab 6 s after verification and approves the pre-filled envelope 7 s later. The whole loop, including about 6 RTO iterations to convergence, therefore plays unattended.


---

## v3: themes, media-backed story, motion, console polish

### Copy

The product no longer says "your camera" or "phone". It reads machine physics from **any feed that can see and hear the machine**: CCTV, inspection or handheld cameras, drones, with no sensors bolted on. Hero: **"Machines, measured by sight and sound."** Sub-line: "Argonaut identifies a rotating machine's dynamics from ordinary video and sound, then finds the speed that runs it best, verified in closed loop." "Camera frame rate" stays where it is technically needed (de-aliasing, Nyquist). The sweep covered the landing page, page title/meta, console tooltips (Live view source: "Device camera (webcam, USB or capture card)") and the simulator's coach line.

### Themes (dark + light)

- **Tokens.** `web/src/index.css` defines every colour once as `--color-*` in `@theme static` (dark values) and overrides them under `:root[data-theme="light"]`. Tailwind utilities, opacity modifiers (`border-accent/35`) and inline SVG (`fill="var(--color-fg-3)"`, `color-mix(in srgb, var(--color-alarm) 40%, transparent)`) all follow the theme. New tokens: `line-3`, `on-accent`, `warn-2`/`warn-bg`, `alarm-2`/`alarm-bg`, `iso-a…d`, `shadow`, `page` (landing background), `well` (video).
- **Canvas / uPlot.** `lib/theme.ts` mirrors the tokens as hex (`PALETTES`, `pal()`, `alpha()`), because canvas cannot read CSS variables. The spectrum (uPlot axes, series, every draw-hook mark), the waterfall and the hero spectrogram rebuild on theme change.
- **Colormaps.** Dark keeps **inferno**. Light uses **paper-violet**: near-white → argon violet → ink, monotonic in lightness (L* ≈ 98 → 12), so the noise floor melts into the panel and peaks read as ink (`lib/colormap.ts`, `colormapFor(theme)`; the waterfall legend and its tooltip follow).
- **Light is an ISA-101 light-grey HMI, not an inversion.** Bezel/seams `#DDE1E6`, panels `#F7F8FA`, ink text `#11161C`. Every semantic hue is darkened until text passes WCAG AA on the panel: accent `#6550E0` (5.2:1), accent-2 `#4E3BC4`, warn `#A35C00` (4.8:1), alarm `#CF2A2F` (4.9:1), ok `#0F7F53` (4.7:1); fg-3 `#525B66` (6.3:1), fg-4 `#6D7580` (≈4.3:1, reserved for tertiary labels). Dark fg-4 was lifted from `#454D56` to `#4F5862` for legibility.
- **Video stays graphite.** The live-view well carries `.scope-dark` (dark tokens re-declared locally), so HUD badges, mask labels and the coach toast keep the "opaque graphite chip over footage" rule in both themes.
- **Toggle.** Sun/moon `ThemeToggle` in both headers; `T` in the console. Default follows `prefers-color-scheme` (and keeps following it until the user chooses); the choice persists in `localStorage['argonaut-theme']` (wrapped in try/catch). An inline script in `index.html` sets `data-theme` before first paint (no flash), and transitions are suppressed for one frame during a switch (`.theme-switching`) so it is a clean cut.

### Landing page

- **Nav:** sticky, section-aware (active link gets a pill), a 1 px accent scroll-progress line (rAF-throttled `scaleX`), theme toggle.
- **Hero:** staggered blur-up entrance. Background = `<Media name="hero">` (16:9 muted loop). When the footage is ready the live spectrogram crossfades (1.6 s) into a 40% blended overlay masked to the right half (`screen` in dark, `multiply` in light). Without footage the procedural spectrogram is the hero, as before. Feed chips: CCTV · Inspection cameras · Handheld · Drones.
- **How it works:** five media cards (2-up, 16:9). Each = `<Media>` layer (image or loop, `object-fit: cover`, lazy, fades in, slow hover zoom) + floor scrim + the console's own overlays, animated when 35% visible: SAM masks stroke-draw with a one-shot segmentation sweep and staggered chips (Sense); camera samples pop along the true waveform, then the dashed alias and the unfolded 24.68 Hz (Measure); Campbell rays draw, crossings pop and pulse (Identify); the objective curve traces, the NOW→proposal arrow draws, the diamond pops (Optimise); before/after whiskers, the twin's prediction diamond, the arrow and the significance chip (Prove). Geometry lives in a 1600×900 viewBox (the card is locked to 16:9); labels are HTML in % so they stay legible at 390 px; secondary chips hide below `sm`. Sense masks are calibrated per theme (`SENSE` in `landing/Stages.tsx`; the dark still is mirrored).
- **Motion system** (`landing/motion.tsx` + `index.css`): `Reveal` (IntersectionObserver, opacity/transform only, staggered with `--d`), `CountUp` (ease-out-quart; the final value is rendered invisibly underneath to reserve its width, so there is no reflow), overlay classes `ov-draw / ov-fill / ov-fade / ov-pop / ov-ring / ov-sweep`. Everything is compositor-only; `prefers-reduced-motion` shows final states and stills.
- **Results:** count-ups on every headline figure; before/after bars grow from the left.

### `<Media>` and the asset contract

`landing/Media.tsx` reads `web/public/media/manifest.json` (`{ dark: { sense: ["sense.mp4","sense.webp"], … }, light: {…} }`). Candidates are HEAD-probed once and accepted only with an `image/*` or `video/*` content type, so an SPA fallback page never counts as media. The first hit wins: a video plays muted, looped and inline, only while on screen; an image fades in. If the theme has no asset the other theme's is used; if neither exists, the gradient + hairline-grid fallback stays and the overlay still animates. Reduced motion: stills only (`<name>.webp` or `<name>-poster`).

| File (per theme: `web/public/media/{dark,light}/`) | Format | Size / ratio | Composition |
|---|---|---|---|
| `hero.mp4` (+ `hero-poster.webp`) | H.264 MP4, muted, 6–12 s seamless loop, ≤ 4 MB | 1920×1080, 16:9 | Subject in the right 55%; left 40% calm (dark in dark, bright in light) for the headline |
| `sense.webp` / `.mp4` | WebP q≈80 (≤ 200 KB) or short loop | 1376×768 (≈16:9) | Motor-pump skid on a baseplate; a plain static wall or column on the far left |
| `measure.webp` | same | same | Close-up of a bearing housing / fan guard near the centre; lower 30% calm for the waveform band |
| `identify.webp` | same | same | Fan or skid on a steel stand in the right half; left half calm for the chart panel |
| `optimise.webp` | same | same | VFD / MCC cabinets in the right half; left half calm |
| `prove.webp` | same | same | Machine running steady or an operator with a tablet in the right half; left half calm |

Avoid watermarks and baked-in text in the lower-right corner; chips and panels sit at the top corners and bottom-left.

### Console

- **Header:** the logo links back to the overview; ThemeToggle and a keyboard-shortcut button; the session id moved into the connection tooltip; command labels appear at ≥ 1760 px (icons with tooltips below), so nothing wraps at 1440–1920.
- **Keyboard:** `T` theme, `1–5` focus Live view / Spectrum / Campbell / Optimizer proposal / Closed loop (the five landing stages; the panel scrolls into view and gets a 1.4 s accent bezel), `?` help overlay, `Esc` closes it. Keys are ignored while typing.
- **Live pulse:** a 5 px violet dot beside Shaft speed and Overall velocity flashes on every telemetry message (`LiveTick`). Values themselves still never tween.
- **Loading states:** `Empty` draws a faint skeleton of the chart to come (line, heat or table) under a frosted card, with the **model-rail chip of the stage that will fill it** (`StageWait`: icon, model, live task, running scan line). Spectrum and waterfall fade in on first data; a new proposal fades in.
- **Live view:** a new SAM result (different regions, or regions that moved more than ~24 px) replays the masks' stroke-draw (staggered 110 ms), the fill fade and the label chips. The video stays `object-contain`, unfiltered.
- **Shipped media (Google Flow):** `hero.mp4` (1280×720, 24 fps, 8 s, H.264) + `hero-poster.webp`, and the five 1376×768 stage stills, per theme; `manifest.json` points at exactly these files. The hero clip does not loop by itself, so `<Media loopFade={0.9}>` runs two decoders and crossfades the last 0.9 s into a restart underneath (`CrossfadeLoop`), with no dip to the background. It is scaled 1.12× from the left so the generator's corner watermark falls outside the frame. The hero never borrows the other theme's clip (`crossTheme={false}`); the procedural spectrogram is its fallback.

---

## v4: Source library (real footage by default)

- **Real by default.** `/console` in LIVE mode (backend reachable, no `?mock` / `?replay` / `?session`) creates the session, waits for the socket, then `POST /play` with the featured real clip in `analyse` mode. `?clip=<id>&mode=stream|analyse` overrides. The simulated rig (`/mock/rig.svg`) renders only in mock mode. A joined session (`?session=`) never auto-plays.
- **Live view header:** `SOURCE · <title> · real footage · <licence>` (synthetic: `synthetic · ground truth`; replays add `· recorded run`). The HUD leads with the mode: `ANALYSE`, `STREAM`, `REPLAY`, `CAM`, `SIM`, or `ENDED`. The old sim/webcam/clip segmented control became one icon button (layers + chevron, `S` key) that opens the drawer.
- **Source drawer** (`components/SourceDrawer.tsx`, right sheet, max 500 px, full width at 390): kind filter pills, then **Real footage** (featured first) and **Synthetic · ground truth**, then **Other inputs** (device camera, clip from disk, and the simulated rig in mock mode only). Each card has a poster (object-cover, duration badge, `PLAYING` dot), title, `REAL FOOTAGE` badge (solid ink with a red recording dot) or a dashed `synthetic · ground truth` badge, kind chip, duration · fps, an audio icon, a two-line note, the credit line `© credit · licence · source ↗` (new tab), and the actions **Analyse** / **Live stream**, plus **Recorded run · instant** when `/api/runs` holds `demo_real_<clip id>` (opens `?replay=`; no API key needed). The current card gets a `· ON` mark. It is a modal dialog: focus moves in, Tab is trapped, Esc closes and focus returns. In mock or replay, picking a clip reopens the console live with `?clip=`.
- **Colour:** source state stays neutral. The red dot means footage, as on the recording HUD. Violet still marks only AI, so the waiting card reuses the model-rail chip (`StageWait`) of the stage the footage is waiting on.
- **Video:** `object-contain`, muted, no filter, poster = the clip's poster. In `analyse` it holds the first frame until telemetry carries `clip_t`, then follows it. Drift up to 1.2 s is corrected with playbackRate (0.7–1.3×), larger drift with a seek. The video pauses when `clip_t` stops for 1.5 s (a model call or the end of the walk), so the footage never runs ahead of the analysis. `stream` simply plays once. A local file plays from a blob URL and loops, as before.
- **Attribution chip** (CC BY): bottom-right on the video, `Footage: <credit> · <licence> ↗`, linking to the source. It moves above the ODS bar when ODS is on. Synthetic clips show `synthetic · ground truth` instead.
- **End of clip:** `stream` ends on the coach "End of clip…". `analyse` has no end event, so the clip counts as ended when the last `clip_t` is within 1.2 s of `duration_s` and telemetry has been silent for 2.5 s. Results stay on screen, and a graphite pill shows `End of clip · results kept`, **Play again**, and **Choose source**. A failed `/play` shows a red pill with Retry.
- **Uncalibrated scale** (`telemetry.calibrated === false`): velocity numbers are dimmed and labelled `rel. mm/s`. The zone badge is replaced by a dashed `uncalibrated · relative` badge whose tooltip reads "No credible scale reference in this footage: amplitudes are relative; frequencies, orders, phase and ratios remain valid". The ISO 20816 bar is greyed (35 %, grayscale), and its pointer, CI and proposal marker are hidden. Per-channel zone letters are hidden. A missing `calibrated` field means calibrated (older backends, replays).
- **Protocol:** `MediaEvent` gains optional `clip_id` / `mode`, and its width/height/fps are optional. New types: `LibraryClip`, `PlayMode`, `PlayRequest/Response`, and `TelemetryEvent.calibrated?`. `iso_zone` is nullable. A media event is matched to a library clip by `clip_id`, then by URL, so `analyse` (which emits no `clip_id`) and old replays still get credits.

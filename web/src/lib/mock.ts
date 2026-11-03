// Realistic simulator for the Argonaut realtime contract.
// Scenario: 4-pole pedestal fan F-101 (5 blades) running at 1476 rpm, sitting on a 24.1 Hz
// motor-mount mode, plus a 14.2 Hz stand-rocking mode. Boot → steady → voice-commanded
// coast-down to 0 rpm → run-up → identification (FDD + Campbell) → optimizer proposal →
// human approval → ramp to new setpoint → re-measure → verification.
// v2: the camera is a 30 fps webcam (Nyquist 15 Hz), so every order above 14.9 Hz is folded and
// recovered by de-aliasing against the mic tachometer; telemetry carries latency/band/CI; the
// proposal carries a vibration CI band and P(resonance); after verification an operator-approved
// envelope starts a ~6-iteration closed loop against the plant simulator; agent text carries
// numeric provenance (with one deliberately unverified number).

import type {
  AgentClaim,
  ApproveRequest,
  AssetEvent,
  CampbellEvent,
  ClientMessage,
  DealiasPeak,
  EnvelopeRequest,
  Evidence,
  IsoZone,
  ModalEvent,
  PipelineStage,
  PipelineState,
  ProposalEvent,
  SensorItem,
  ServerMessage,
  RtoEvent,
  RtoHistoryEntry,
  RtoStatus,
  SpectrumPeak,
  TelemetryChannel,
} from './protocol'

type Emit = (m: ServerMessage) => void

/* ───────────────────────── physics ───────────────────────── */

const N0 = 1476 // rpm, measured run speed
const NAMEPLATE_RPM = 1450
const BLADES = 5
const F_MAX = 125
const DF = 0.25
const F_GRID = Array.from({ length: Math.round(F_MAX / DF) + 1 }, (_, i) => +(i * DF).toFixed(2))

interface ModeDef {
  f: number
  zeta: number
  label: string
}
const MODES: ModeDef[] = [
  { f: 14.2, zeta: 0.021, label: 'Stand rocking mode' },
  { f: 24.1, zeta: 0.034, label: 'Motor-mount bending' },
  { f: 61.5, zeta: 0.045, label: 'Guard panel mode' },
]

interface ChanDef {
  id: string
  label: string
  color: string
  ref: boolean
  base: number // non-resonant forced response weight
  w: [number, number, number] // modal participation (amp)
  ph: [number, number, number] // modal phase, deg
  bpf: number
}
const CHANNELS: ChanDef[] = [
  { id: 's1', label: 'motor housing', color: '#56B6E0', ref: false, base: 0.55, w: [0.62, 1.0, 0.1], ph: [0, 0, 8], bpf: 0.25 },
  { id: 's2', label: 'bearing housing', color: '#8B9EF5', ref: false, base: 0.7, w: [0.71, 0.84, 0.15], ph: [2, 4, -6], bpf: 0.4 },
  { id: 's3', label: 'fan guard', color: '#4FC1A6', ref: false, base: 0.3, w: [0.55, 0.42, 1.0], ph: [-3, 172, 0], bpf: 1.0 },
  { id: 's4', label: 'stand', color: '#CBB98A', ref: false, base: 0.25, w: [1.0, 0.3, 0.05], ph: [0, 0, 0], bpf: 0.1 },
  { id: 's5', label: 'baseplate', color: '#AEB6BF', ref: false, base: 0.12, w: [0.18, 0.08, 0.02], ph: [176, -170, 0], bpf: 0.05 },
  { id: 's6', label: 'wall', color: '#6C7580', ref: true, base: 0, w: [0, 0, 0], ph: [0, 0, 0], bpf: 0 },
]

const H = (f: number, m: ModeDef) => {
  const r = f / m.f
  return 1 / Math.sqrt((1 - r * r) ** 2 + (2 * m.zeta * r) ** 2)
}

let K1 = 1 // calibrated below

/** RMS velocity (mm/s) of each order component for a channel at shaft frequency f1. */
function orderAmps(ch: ChanDef, f1: number, modes: ModeDef[] = MODES) {
  if (ch.ref || f1 < 0.3) return { a1: 0, a2: 0, a5: 0 }
  const force = (f1 / (N0 / 60)) ** 2
  const resp = (f: number) => ch.base + ch.w[0] * H(f, modes[0]) * 0.11 + ch.w[1] * H(f, modes[1]) * 0.11 + ch.w[2] * H(f, modes[2]) * 0.11
  const a1 = K1 * force * resp(f1)
  const a2 = 0.2 * K1 * force * resp(2 * f1)
  const a5 = 0.09 * K1 * force * (ch.bpf * 0.6 + 0.3 * resp(BLADES * f1))
  return { a1, a2, a5 }
}

const AMBIENT = 0.05
function chanRms(ch: ChanDef, f1: number, modes: ModeDef[] = MODES) {
  const { a1, a2, a5 } = orderAmps(ch, f1, modes)
  const amb = ch.ref ? 0.004 : AMBIENT * (ch.w[0] + ch.w[1] + ch.w[2] * 0.5)
  return Math.sqrt(a1 * a1 + a2 * a2 + a5 * a5 + amb * amb + 0.0004)
}
function overallAt(rpm: number, modes: ModeDef[] = MODES) {
  const f1 = rpm / 60
  return Math.max(...CHANNELS.filter((c) => !c.ref).map((c) => chanRms(c, f1, modes)))
}
/** Predicted-vibration band from the identified mode-frequency uncertainty (±f_err) and an 8% model term. */
function overallBand(rpm: number, errs: number[]) {
  const vals = [-1, 0, 1].map((s) => overallAt(rpm, MODES.map((m, k) => ({ ...m, f: m.f + s * (errs[k] ?? 0) }))))
  return { lo: Math.min(...vals) * 0.92, hi: Math.max(...vals) * 1.08 }
}

/* ── v2: camera sampling, de-aliasing, resonance probability ── */
const FS_VIDEO = 30
const DIRECT_HZ = 14.9
const DEALIASED_HZ = 120
const foldOf = (f: number) => {
  const n = Math.round(f / FS_VIDEO)
  return { n, alias: Math.abs(f - n * FS_VIDEO) }
}
/** standard normal CDF (Abramowitz–Stegun 7.1.26) */
function phi(z: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2)
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}
/** P(any of orders 1, 2, BPF lands inside a mode's half-power band f(1 ± ζ)), mode f ~ N(f, f_err²). */
function pRes(rpm: number, modes: { f_hz: number; f_err_hz: number; zeta: number | null }[]) {
  let q = 1
  for (const m of modes) {
    const z = m.zeta ?? 0.03
    const sd = Math.max(0.05, m.f_err_hz)
    for (const k of [1, 2, BLADES]) {
      const fk = (k * rpm) / 60
      const p = phi((fk - m.f_hz * (1 - z)) / sd) - phi((fk - m.f_hz * (1 + z)) / sd)
      q *= 1 - Math.max(0, p)
    }
  }
  return 1 - q
}
// calibrate: 7.9 mm/s RMS overall at the run speed
K1 = 1
K1 = 7.9 / overallAt(N0)

const isoZone = (v: number): IsoZone => (v < 1.8 ? 'A' : v < 4.5 ? 'B' : v < 11.2 ? 'C' : 'D')

const gauss = (f: number, f0: number, s: number) => Math.exp(-0.5 * ((f - f0) / s) ** 2)
const lorentz = (f: number, f0: number, hw: number) => 1 / (1 + ((f - f0) / hw) ** 2)

let seed = 7
const rnd = () => {
  seed = (seed * 16807) % 2147483647
  return (seed - 1) / 2147483646
}
const jitter = (k: number) => 1 + (rnd() - 0.5) * 2 * k

function spectrumFor(ch: ChanDef, f1: number) {
  const { a1, a2, a5 } = orderAmps(ch, f1)
  const amp = new Array<number>(F_GRID.length)
  const ambW = ch.ref ? [0.002, 0.002, 0.001] : ch.w.map((w) => w * AMBIENT)
  for (let i = 0; i < F_GRID.length; i++) {
    const f = F_GRID[i]
    let v = 0
    if (a1 > 0) {
      v += a1 * gauss(f, f1, 0.32)
      v += a2 * gauss(f, 2 * f1, 0.36)
      v += 0.25 * a2 * gauss(f, 3 * f1, 0.4)
      v += a5 * gauss(f, BLADES * f1, 0.45)
    }
    for (let k = 0; k < MODES.length; k++) {
      const m = MODES[k]
      v += ambW[k] * lorentz(f, m.f, Math.max(0.3, m.zeta * m.f * 1.4)) * jitter(0.25)
    }
    const floor = 0.006 + 0.03 / (1 + f * 0.6)
    v += floor * (0.6 + rnd() * 0.8)
    amp[i] = +v.toFixed(5)
  }
  const peaks: SpectrumPeak[] = []
  // v2: 90% CI on amplitude (wider for small peaks), aliasing flags for everything above the camera Nyquist
  const pk = (f: number, a: number, order: number, label: string, corroborated_audio: boolean): SpectrumPeak => {
    const rel = 0.07 + 0.012 / Math.max(a, 0.02)
    const aliased = f > DIRECT_HZ
    return {
      f_hz: +f.toFixed(2),
      amp: +a.toFixed(3),
      amp_ci: [+(a * (1 - rel)).toFixed(3), +(a * (1 + rel * 1.1)).toFixed(3)],
      order,
      label,
      corroborated_audio,
      ...(aliased ? { aliased: true, f_alias_hz: +foldOf(f).alias.toFixed(2) } : {}),
    }
  }
  if (a1 > 0.05) {
    peaks.push(pk(f1, a1, 1, '1×', f1 > 4))
    if (a2 > 0.05) peaks.push(pk(2 * f1, a2, 2, '2×', f1 > 8))
    if (a5 > 0.03 && BLADES * f1 < DEALIASED_HZ) peaks.push(pk(BLADES * f1, a5, BLADES, 'BPF', f1 > 6))
  }
  return { amp, peaks }
}

function waterfallRow(amp: number[]) {
  return amp.map((a) => {
    const db = 20 * Math.log10(Math.max(a, 1e-4) / 0.004)
    return Math.max(0, Math.min(255, Math.round((db / 68) * 255)))
  })
}

/** Microphone spectrum row (0–1500 Hz): blade-pass tone + harmonics, rotor-slot tone, 100 Hz hum, aero noise. */
const MIC_FMAX = 1500
const MIC_BINS = 300
function micRow(f1: number) {
  const row = new Array<number>(MIC_BINS)
  const s = f1 / (N0 / 60)
  for (let i = 0; i < MIC_BINS; i++) {
    const f = (i / (MIC_BINS - 1)) * MIC_FMAX
    let p = 2e-4 + 0.02 * s ** 2.5 * Math.exp(-f / 600) * (0.6 + rnd() * 0.8)
    p += 0.6 * gauss(f, 100, 4) + 0.12 * gauss(f, 200, 4)
    if (f1 > 0.5) {
      const bpf = BLADES * f1
      p += 6 * s ** 2 * gauss(f, bpf, 5) + 2.2 * s ** 2 * gauss(f, 2 * bpf, 5) + 0.8 * s ** 2 * gauss(f, 3 * bpf, 6)
      p += 0.5 * s ** 3 * gauss(f, 28 * f1, 6)
    }
    const db = 20 * Math.log10(Math.max(p, 1e-5) / 2e-4)
    row[i] = Math.max(0, Math.min(255, Math.round((db / 92) * 255)))
  }
  return row
}

function fddCurves() {
  const f: number[] = []
  const sv1: number[] = []
  const sv2: number[] = []
  for (let x = 0; x <= 80; x += 0.25) {
    f.push(+x.toFixed(2))
    let a = 0.0009 + 0.004 / (1 + x * 0.4)
    let b = 0.0006 + 0.0025 / (1 + x * 0.4)
    MODES.forEach((m, k) => {
      const peak = [0.32, 0.55, 0.12][k]
      a += peak * lorentz(x, m.f, m.zeta * m.f * 1.2)
      b += peak * 0.07 * lorentz(x, m.f + 0.4, m.zeta * m.f * 2.2)
    })
    // forced harmonics show up as narrow spikes (flagged, not modes)
    a += 0.18 * gauss(x, N0 / 60, 0.22) + 0.04 * gauss(x, (2 * N0) / 60, 0.25)
    sv1.push(+(a * jitter(0.05)).toFixed(6))
    sv2.push(+(b * jitter(0.08)).toFixed(6))
  }
  return { f, sv1, sv2 }
}

/* ───────────────────────── scene geometry (960×540) ───────────────────────── */

const W = 960
const HGT = 540
const rectPoly = (x1: number, y1: number, x2: number, y2: number, r = 8): [number, number][] => {
  const pts: [number, number][] = []
  const corners: [number, number, number][] = [
    [x2 - r, y1 + r, -90],
    [x2 - r, y2 - r, 0],
    [x1 + r, y2 - r, 90],
    [x1 + r, y1 + r, 180],
  ]
  for (const [cx, cy, a0] of corners) for (let k = 0; k <= 3; k++) {
    const a = ((a0 + k * 30) * Math.PI) / 180
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return pts
}
const ellipsePoly = (cx: number, cy: number, rx: number, ry: number, n = 28): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]
  })

const GEOM: Record<string, [number, number][]> = {
  s1: rectPoly(388, 214, 622, 312, 22),
  s2: rectPoly(620, 230, 664, 298, 6),
  s3: ellipsePoly(742, 262, 60, 156),
  s4: [[512, 314], [552, 314], [554, 420], [592, 424], [592, 438], [470, 438], [470, 424], [508, 420]],
  s5: [[300, 444], [752, 444], [792, 484], [262, 484]],
  s6: rectPoly(96, 118, 206, 232, 3),
}
const CONF: Record<string, number> = { s1: 0.96, s2: 0.93, s3: 0.91, s4: 0.94, s5: 0.88, s6: 0.97 }

function bboxOf(p: [number, number][]): [number, number, number, number] {
  const xs = p.map((q) => q[0])
  const ys = p.map((q) => q[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v)) as [number, number, number, number]
}

/* ───────────────────────── engine ───────────────────────── */

type Phase = 'boot' | 'steady' | 'coast' | 'runup' | 'identified' | 'awaiting' | 'ramping' | 'settled' | 'rto'

/** [number as written in the text, tool-output path that holds it | null = not found anywhere] */
type ClaimSpec = [string, string | null]

/** Locate each claimed number in order of appearance (digit-bounded), giving character offsets. */
function locateClaims(text: string, specs: ClaimSpec[]): AgentClaim[] {
  const out: AgentClaim[] = []
  let from = 0
  for (const [str, source] of specs) {
    const esc = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp('(?<![\\d.])' + esc + '(?![\\d])', 'g')
    re.lastIndex = from
    const m = re.exec(text)
    if (!m) continue
    out.push({ start: m.index, end: m.index + str.length, value: parseFloat(str.replace(/\s/g, '')), verified: source != null, source })
    from = m.index + str.length
  }
  return out
}

/** Closed-loop RTO state (mock plant: the same physics, with a 1× gain 7% below the twin's). */
interface RtoRun {
  lo: number
  hi: number
  maxStep: number
  plan: number[]
  iter: number // 1-based
  sub: RtoStatus
  subT: number
  setpoint: number
  rampFrom: number
  history: RtoHistoryEntry[]
  measured: { vel_mm_s: number; kw: number } | null
  done: boolean
}
const G_TRUE = 0.86
const RTO_OPT = 1275
const twinGain = (k: number) => G_TRUE + (1 - G_TRUE) * 0.55 ** k
const twinGainSd = (k: number) => Math.max(0.03, 0.15 * 0.68 ** k)
const twinModes = (k: number) => [
  { f_hz: +(14.2 + 0.04 * (1 - 0.6 ** k)).toFixed(3), f_sd: +Math.max(0.09, 0.3 * 0.78 ** k).toFixed(3), zeta: 0.021, zeta_sd: +Math.max(0.003, 0.006 * 0.85 ** k).toFixed(4) },
  { f_hz: +(24.1 + 0.09 * (1 - 0.55 ** k)).toFixed(3), f_sd: +Math.max(0.07, 0.4 * 0.7 ** k).toFixed(3), zeta: +(0.034 - 0.001 * (1 - 0.6 ** k)).toFixed(4), zeta_sd: +Math.max(0.004, 0.008 * 0.84 ** k).toFixed(4) },
]
const kwAt = (n: number) => 0.075 * (n / NAMEPLATE_RPM) ** 3
/** specific-energy objective (normalized): bowl around the plant's true optimum */
const objJ = (n: number) => +(0.61 + 0.85 * ((n - RTO_OPT) / 420) ** 2).toFixed(3)

export class MockEngine {
  private emit: Emit
  private t = 0
  private tick = 0
  private timer: number | null = null
  private phase: Phase = 'boot'
  private phaseT = 0
  private rpm = N0
  private targetRpm = N0
  private rampFrom = N0
  private queue: { at: number; fn: () => void }[] = []
  private coastSpeeds: number[] = []
  private coastTimes: number[] = []
  private orderAmp: Record<string, number[]> = { '1': [], '2': [], '3': [] }
  private campbellModes: CampbellEvent['modes'] = []
  private proposal: ProposalEvent | null = null
  private prompts = CHANNELS.map((c) => c.label)
  private frameCache: string | null = null
  private wonderBusy = false
  private dropped = 0
  private rtoRun: RtoRun | null = null

  constructor(emit: Emit) {
    this.emit = emit
  }

  start() {
    this.scheduleScript()
    this.timer = window.setInterval(() => this.step(), 100)
    void this.prepareFrame()
  }
  stop() {
    if (this.timer) window.clearInterval(this.timer)
    this.timer = null
  }

  /* ── client → server ── */
  handle(m: ClientMessage) {
    if (m.type === 'command') {
      if (m.name === 'start_coastdown' && (this.phase === 'steady' || this.phase === 'settled' || this.phase === 'awaiting')) this.beginCoast()
      else if (m.name === 'identify') this.identify()
      else if (m.name === 'optimize') this.optimize()
      else if (m.name === 'verify') this.verify()
      else if (m.name === 'stop') this.say('Stopping capture. Buffers are kept, so you can still identify from what was recorded.')
    } else if (m.type === 'chat') {
      this.answer(m.text)
    } else if (m.type === 'sensors.set') {
      this.prompts = m.prompts
      this.pipe('sam', 'running', 0, `segmenting ${m.prompts.map((p) => `“${p}”`).join(', ')}`)
      this.after(0.9, () => {
        this.pipe('sam', 'ok', 438, `${Math.min(m.prompts.length, CHANNELS.length)} regions · prompts updated`)
        this.emitSensors()
      })
    }
  }

  approve(req: ApproveRequest) {
    if (!this.proposal || req.proposal_id !== this.proposal.id) return
    if (!req.approved) {
      this.phase = 'steady'
      this.say(`Understood. Holding at ${N0} rpm and logging the rejection${req.note ? ` (“${req.note}”)` : ''}. Ask me for an alternative with a different constraint.`)
      return
    }
    this.say(`Approved. Writing ${this.proposal.proposed.speed_rpm} rpm to the drive (simulated Modbus, holding register 40001) and ramping at 60 rpm/s. I'll re-measure once it settles.`)
    this.pipe('wonder', 'running', 0, 'apply_setpoint → VFD (simulated)')
    this.after(0.6, () => this.pipe('wonder', 'ok', 212, `setpoint ${this.proposal!.proposed.speed_rpm} rpm written`))
    this.rampFrom = this.rpm
    this.targetRpm = this.proposal.proposed.speed_rpm
    this.setPhase('ramping')
  }

  /** v2 · operator approved an envelope: run the closed loop inside it. */
  approveEnvelope(req: EnvelopeRequest) {
    if (!req.approved) return
    const lo = Math.min(req.lo_rpm, req.hi_rpm)
    const hi = Math.max(req.lo_rpm, req.hi_rpm)
    const start = Math.round(this.rpm)
    const target = Math.min(hi, Math.max(lo, RTO_OPT))
    let d = target - start
    if (Math.abs(d) < 20) d = 40
    // damped approach with an overshoot, limited by max step and the envelope
    const plan = [start]
    for (const f of [0.64, -0.3, 0.2, -0.12, 0.05, 0]) {
      const want = Math.round(target + (f === 0 ? 0 : f * d))
      const prev = plan[plan.length - 1]
      const stepd = Math.max(-req.max_step_rpm, Math.min(req.max_step_rpm, want - prev))
      plan.push(Math.min(hi, Math.max(lo, prev + stepd)))
    }
    this.rtoRun = { lo, hi, maxStep: req.max_step_rpm, plan, iter: 1, sub: 'measuring', subT: 0, setpoint: start, rampFrom: start, history: [], measured: null, done: false }
    this.setPhase('rto')
    this.pipe('wonder', 'running', 0, `closed loop · envelope ${lo}–${hi} rpm · step ≤ ${req.max_step_rpm}`)
    const text = `Envelope approved: ${lo}–${hi} rpm, steps of at most ${req.max_step_rpm} rpm. I'll measure, update the twin and step the setpoint until it stops moving. The drive is the plant simulator over Modbus.`
    this.say(text, 0.3, [[String(lo), 'envelope.lo_rpm'], [String(hi), 'envelope.hi_rpm'], [String(req.max_step_rpm), 'envelope.max_step_rpm']])
  }
  stopRto() {
    const r = this.rtoRun
    if (!r || r.done) return
    r.done = true
    this.emitRto('aborted', 'stopped by operator · holding last setpoint')
    this.pipe('wonder', 'ok', 120, 'closed loop aborted by operator')
    this.say(`Stopped. Holding ${Math.round(r.setpoint)} rpm; the twin keeps what it learned in ${r.history.length} iterations.`, 0.2, [[String(Math.round(r.setpoint)), 'rto.setpoint_rpm']])
    this.setPhase('settled')
  }

  /* ── helpers ── */
  private after(dt: number, fn: () => void) {
    this.queue.push({ at: this.t + dt, fn })
  }
  private setPhase(p: Phase) {
    this.phase = p
    this.phaseT = 0
  }
  private pipe(stage: PipelineStage, state: PipelineState, latency_ms: number, detail: string, model?: string) {
    const models: Record<PipelineStage, string> = {
      sam: 'sam-3.1',
      spark: 'muse-spark-1.2',
      wonder: 'muse-wonder-1.0',
      voice: 'muse-voice-transcribe',
      dsp: 'argonaut-dsp',
      open_weights: 'muse-spark-open · baseten',
    }
    this.emit({ type: 'pipeline', stage, state, model: model ?? models[stage], latency_ms: Math.round(latency_ms), detail })
  }
  /** Stream agent narration in small deltas. */
  private sayFreeAt = 0
  private say(text: string, delay = 0, claimSpecs?: ClaimSpec[]) {
    const claims = claimSpecs ? locateClaims(text, claimSpecs) : undefined
    const words = text.split(/(?<= )/)
    const start = Math.max(this.t + delay, this.sayFreeAt)
    this.sayFreeAt = start + (words.length / 3) * 0.11 + 0.4
    delay = start - this.t
    let i = 0
    const chunk = () => {
      const n = 2 + Math.floor(rnd() * 3)
      const part = words.slice(i, i + n).join('')
      i += n
      const final = i >= words.length
      if (final && claims)
        this.emit({
          type: 'agent',
          role: 'assistant',
          text: part,
          final,
          claims,
          provenance: { verified: claims.filter((c) => c.verified).length, unverified: claims.filter((c) => !c.verified).length },
        })
      else this.emit({ type: 'agent', role: 'assistant', text: part, final })
      if (!final) this.after(0.06 + rnd() * 0.05, chunk)
    }
    this.after(delay, chunk)
  }
  private voice(speaker: string, text: string, at: number) {
    const words = text.split(' ')
    for (let k = 1; k <= words.length; k++) {
      const partial = words.slice(0, k).join(' ')
      this.after(at + k * 0.22, () => {
        this.emit({ type: 'transcript', speaker, text: k === words.length ? text : partial, final: k === words.length })
        this.pipe('voice', k === words.length ? 'ok' : 'running', 140 + rnd() * 90, k === words.length ? `“${text}”` : 'streaming partials')
      })
    }
    this.after(at + words.length * 0.22 + 1.2, () => this.pipe('voice', 'running', 0, 'listening · realtime session'))
  }
  private coach(level: 'ok' | 'warn' | 'block', text: string, at: number) {
    this.after(at, () => this.emit({ type: 'coach', level, text }))
  }

  private emitSensors() {
    const items: SensorItem[] = CHANNELS.map((c) => {
      const base = GEOM[c.id]
      const dx = (rnd() - 0.5) * 0.8
      const dy = (rnd() - 0.5) * 0.8
      const polygon = base.map(([x, y]) => [+(x + dx).toFixed(1), +(y + dy).toFixed(1)] as [number, number])
      return {
        id: c.id,
        label: this.prompts[CHANNELS.indexOf(c)] ?? c.label,
        color: c.color,
        polygon,
        bbox: bboxOf(polygon),
        confidence: +Math.min(0.995, CONF[c.id] + (rnd() - 0.5) * 0.02).toFixed(3),
        is_reference: c.ref,
      }
    })
    this.emit({ type: 'sensors', t: +this.t.toFixed(2), width: W, height: HGT, items })
  }

  private asset(): AssetEvent {
    const q: number[] = []
    const h: number[] = []
    const eta: number[] = []
    const npshr: number[] = []
    for (let x = 0; x <= 20.0001; x += 0.5) {
      q.push(+x.toFixed(2))
      h.push(+(22 - 0.02778 * x * x).toFixed(3))
      eta.push(+Math.max(0, 0.68 * (1 - ((x - 12) / 12.5) ** 2)).toFixed(4))
      npshr.push(+(1.2 + 0.012 * x * x).toFixed(3))
    }
    return { type: 'asset', name: 'Fan F-101', nameplate: { rpm: NAMEPLATE_RPM, kw: 0.075, poles: 4 }, pump_curve: { q, h, eta, npshr }, bep: { q: 12.0, h: 18.0 } }
  }

  private async prepareFrame() {
    try {
      const img = new Image()
      img.src = '/mock/rig.svg'
      await img.decode()
      const c = document.createElement('canvas')
      c.width = 384
      c.height = 216
      const g = c.getContext('2d')!
      g.drawImage(img, 0, 0, c.width, c.height)
      const sx = c.width / W
      g.lineWidth = 1.5
      for (const ch of CHANNELS) {
        g.strokeStyle = ch.color
        g.fillStyle = ch.color + '22'
        g.beginPath()
        GEOM[ch.id].forEach(([x, y], i) => (i ? g.lineTo(x * sx, y * sx) : g.moveTo(x * sx, y * sx)))
        g.closePath()
        g.fill()
        g.stroke()
      }
      this.frameCache = c.toDataURL('image/jpeg', 0.82).split(',')[1]
    } catch {
      this.frameCache = null
    }
  }
  private frameEvidence(t: number): Evidence[] {
    return this.frameCache ? [{ kind: 'frame', t: +t.toFixed(2), jpeg_b64: this.frameCache }] : []
  }

  private criticals(modes: { f_hz: number }[]) {
    const out: CampbellEvent['criticals'] = []
    for (const m of modes) for (const o of [1, 2, BLADES]) {
      const rpm = (60 * m.f_hz) / o
      if (rpm > 120 && rpm < 1800) out.push({ rpm: Math.round(rpm), order: o, mode_f_hz: m.f_hz })
    }
    return out
  }
  private emitCampbell() {
    const speeds = this.coastSpeeds.length ? this.coastSpeeds.slice() : [Math.round(this.rpm)]
    const tracked = this.coastTimes.length >= 4 && this.coastTimes.length === speeds.length
    this.emit({
      type: 'campbell',
      speeds_rpm: speeds,
      ...(tracked ? { times_s: this.coastTimes.slice(), order_amp_mm: { '1': this.orderAmp['1'].slice(), '2': this.orderAmp['2'].slice(), '3': this.orderAmp['3'].slice() } } : {}),
      modes: this.campbellModes,
      orders: [1, 2, BLADES],
      criticals: this.criticals(this.campbellModes),
    })
  }
  private emitModal(prelim: boolean) {
    const { f, sv1, sv2 } = fddCurves()
    const modes = (prelim ? MODES.slice(1, 2) : MODES).map((m) => {
      const k = MODES.indexOf(m)
      return {
        f_hz: m.f,
        zeta: m.zeta,
        shape: CHANNELS.filter((c) => !c.ref).map((c) => ({ id: c.id, amp: +(c.w[k] / Math.max(...CHANNELS.map((x) => x.w[k]))).toFixed(3), phase_deg: c.ph[k] })),
      }
    })
    const ev: ModalEvent = { type: 'modal', method: 'FDD', f_hz: f, sv1, sv2, modes }
    this.emit(ev)
  }

  /* ── scripted scenario ── */
  private scheduleScript() {
    // boot
    this.after(0.1, () => {
      this.pipe('voice', 'running', 0, 'listening · realtime session')
      this.pipe('dsp', 'idle', 0, 'waiting for masks')
      this.pipe('wonder', 'idle', 0, 'waiting for evidence')
      this.pipe('open_weights', 'idle', 0, 'private mode standby')
      this.pipe('sam', 'running', 0, `segmenting ${CHANNELS.map((c) => `“${c.label}”`).join(', ')}`)
      this.pipe('spark', 'running', 0, 'reading scene + nameplate')
    })
    this.coach('warn', 'Camera shake 0.6 px. Brace the camera or mount it on something solid.', 0.8)
    this.after(1.2, () => {
      this.pipe('sam', 'ok', 412, '6 regions · mean conf 0.93')
      this.emitSensors()
      this.pipe('dsp', 'ok', 7, 'phase correlation · 5 ch + ref @ 30 fps')
      this.setPhase('steady')
    })
    this.after(2.5, () => {
      this.pipe('spark', 'ok', 1830, 'nameplate: 1450 rpm · 75 W · 4-pole')
      this.emit(this.asset())
    })
    this.say('Six virtual sensors placed. The wall is static, so I use it to cancel camera shake. Scale comes from the nameplate (80 × 50 mm → 0.41 mm/px).', 2.7)
    this.coach('ok', 'Shake cancelled against the wall reference · residual 0.04 px', 3.4)
    this.after(4.2, () => this.emitModal(true))
    this.after(5.0, () => {
      this.emit({
        type: 'diagnosis',
        id: 'd1',
        severity: 'warn',
        title: 'High 1× vibration at running speed',
        summary: 'Overall 7.9 mm/s RMS (ISO 20816 zone C), dominated by 1× at 24.6 Hz on the bearing and motor housings. Their in-phase motion suggests resonance near running speed rather than unbalance alone.',
        evidence: [
          { kind: 'spectrum_peak', channel: 's2', f_hz: +(N0 / 60).toFixed(2) },
          { kind: 'metric', name: 'overall velocity (mm/s RMS)', value: 7.9, err: 0.3 },
          ...this.frameEvidence(this.t),
        ],
        confidence: 0.81,
        model: 'muse-wonder-1.0',
      })
    })
    this.say(
      'Running at 1476 rpm (24.6 Hz; video and audio agree). Overall 7.9 mm/s RMS, zone C, mostly at 1×. The webcam samples at 30 fps, so 1× is folded to 5.4 Hz; the mic tachometer unfolds it. The bearing and motor housings move in phase, which points to a resonance near running speed, not unbalance alone. A coast-down will tell them apart.',
      5.4,
      [
        ['1476', 'telemetry.speed_rpm'],
        ['24.6', 'telemetry.speed_hz'],
        ['7.9', 'telemetry.overall_vel_mm_s_rms'],
        ['30', 'dealias.fs_video'],
        ['5.4', 'dealias.peaks[0].f_alias_hz'],
      ],
    )
    this.voice('A', 'Argonaut, start a coast-down.', 9.5)
    this.after(11.4, () => this.beginCoast())
    this.after(10.0, () => this.sparkCheck())
  }

  private sparkCheck() {
    this.pipe('spark', 'running', 0, 'audio cross-check · 5 s clip')
    this.after(1.3 + rnd() * 0.4, () => {
      const f1 = this.rpm / 60
      this.pipe('spark', 'ok', 1250 + rnd() * 400, f1 > 2 ? `1× ${f1.toFixed(1)} Hz corroborated in audio` : 'no rotating tone · ambient only')
    })
    this.after(11, () => this.sparkCheck())
  }

  private beginCoast() {
    if (this.phase === 'coast') return
    this.pipe('wonder', 'running', 0, 'planning identification · coast-down')
    this.after(0.9, () => this.pipe('wonder', 'ok', 880, 'plan: coast-down → FDD → Campbell'))
    this.say("Starting coast-down. Switch the fan off now; I'll track 1×, 2× and blade-pass down to standstill.", 0.2)
    this.after(1.2, () => this.emit({ type: 'transcript', speaker: 'B', text: 'Okay, fan is off.', final: true }))
    this.coastSpeeds = []
    this.coastTimes = []
    this.orderAmp = { '1': [], '2': [], '3': [] }
    this.campbellModes = [{ f_hz: 24.1, f_err_hz: 0.9, zeta: 0.03, zeta_err: 0.015, label: 'Motor-mount bending', source: 'FDD at run speed' }]
    this.rampFrom = this.rpm
    this.setPhase('coast')
  }

  private identify() {
    if (this.wonderBusy) return
    this.wonderBusy = true
    this.pipe('wonder', 'running', 0, 'identify · FDD + Campbell fit')
    this.pipe('dsp', 'running', 0, 'FDD · 5 ch cross-spectral matrix')
    this.after(1.6, () => {
      this.pipe('dsp', 'ok', 64, 'FDD done · 3 modes above MAC 0.9')
      this.campbellModes = [
        { f_hz: 14.2, f_err_hz: 0.3, zeta: 0.021, zeta_err: 0.006, label: 'Stand rocking mode', source: '1× order-tracked sweep, SDOF fit', forcing_power: 1.94 },
        { f_hz: 24.1, f_err_hz: 0.4, zeta: 0.034, zeta_err: 0.008, label: 'Motor-mount bending', source: '1× order-tracked sweep, SDOF fit', forcing_power: 2.02 },
        { f_hz: 61.5, f_err_hz: 1.1, zeta: 0.045, zeta_err: 0.014, label: 'Guard panel mode', source: 'FDD, 5 channels' },
      ]
      if (this.coastSpeeds.length < 4) this.coastSpeeds = Array.from({ length: 60 }, (_, i) => Math.round(N0 * (1 - i / 59)))
      this.emitCampbell()
      this.emitModal(false)
    })
    this.after(2.6, () => {
      this.pipe('wonder', 'ok', 2410, 'diagnosis d2 · 3 evidence items')
      this.emit({
        type: 'diagnosis',
        id: 'd2',
        severity: 'alarm',
        title: 'Operating on structural resonance',
        summary: '1× (24.6 Hz) sits 2% above the 24.1 Hz motor-mount bending mode (ζ 0.034). Dynamic amplification is about 12×. A second critical speed at 852 rpm comes from the 14.2 Hz stand rocking mode.',
        evidence: [
          { kind: 'spectrum_peak', channel: 's1', f_hz: +(N0 / 60).toFixed(2) },
          { kind: 'metric', name: 'f_n mode 2 (Hz)', value: 24.1, err: 0.4 },
          { kind: 'metric', name: 'zeta mode 2', value: 0.034, err: 0.008 },
          ...this.frameEvidence(this.t),
        ],
        confidence: 0.9,
        model: 'muse-wonder-1.0',
      })
      this.wonderBusy = false
      this.setPhase('identified')
    })
    this.say(
      'Identification done: three modes. Motor-mount bending at 24.1 ± 0.4 Hz (ζ 0.034 ± 0.008) sits 2% below running speed and amplifies 1× about 12×. Stand rocking at 14.2 Hz gives a critical speed at 852 rpm.',
      2.9,
      [
        ['24.1', 'campbell.modes[1].f_hz'],
        ['0.4', 'campbell.modes[1].f_err_hz'],
        ['0.034', 'campbell.modes[1].zeta'],
        ['0.008', 'campbell.modes[1].zeta_err'],
        ['12', null],
        ['14.2', 'campbell.modes[0].f_hz'],
        ['852', 'campbell.criticals[0].rpm'],
      ],
    )
  }

  private optimize() {
    if (this.wonderBusy) return
    this.wonderBusy = true
    this.pipe('wonder', 'running', 0, 'optimize · min specific energy s.t. 5 constraints')
    this.after(0.4, () => this.pipe('open_weights', 'running', 0, 'mirroring rationale on open weights (audit)'))
    const pr = 1220
    const vCur = overallAt(N0)
    const vNew = overallAt(pr)
    const kw = (n: number) => +(0.075 * (n / NAMEPLATE_RPM) ** 3).toFixed(4)
    const resModes = () => (this.campbellModes.length ? this.campbellModes : MODES.map((m) => ({ f_hz: m.f, f_err_hz: 0.5, zeta: m.zeta })))
    const pResAt = (r: number) => pRes(r, resModes())
    const pctTxt = (v: number) => (v < 0.001 ? '<0.1%' : `${(v * 100).toFixed(1)}%`)
    this.after(2.9, () => {
      this.pipe('wonder', 'ok', 2870, 'proposal p1 · 1220 rpm')
      this.proposal = {
        type: 'proposal',
        id: 'p1',
        objective: 'min specific energy',
        current: { speed_rpm: N0, vel_mm_s: +vCur.toFixed(2), kw: kw(N0) },
        proposed: { speed_rpm: pr, vel_mm_s: +vNew.toFixed(2), kw: kw(pr) },
        constraints: [
          { name: 'Duty met (flow)', value: `12.2 m³/h ≥ 12.2 m³/h`, ok: true },
          { name: 'Resonance margin', value: `15.6% from 1446 rpm · 43% from 852 rpm (≥ 8%)`, ok: true },
          { name: 'NPSH margin', value: '1.98 (≥ 1.30)', ok: true },
          { name: 'Predicted vibration', value: `${vNew.toFixed(1)} mm/s · zone ${isoZone(vNew)}`, ok: vNew < 4.5 },
          { name: 'Evidence error bars', value: 'σf 0.4 Hz < 0.8 Hz gate', ok: true },
          { name: 'P(resonance)', value: `${pctTxt(pResAt(pr))} ≤ 5%`, ok: pResAt(pr) <= 0.05 },
        ],
        feasible_band_rpm: [[1220, 1330]],
        exclusion_bands_rpm: [[665, 920], [1330, 1562]],
        expected: { vibration_change_pct: Math.round((vNew / vCur - 1) * 100), energy_change_pct: Math.round(((pr / N0) ** 3 - 1) * 100) },
        rationale:
          'At 1476 rpm, 1× sits 2% above the 24.1 Hz motor-mount mode, so the structure amplifies it about 12×. 1220 rpm is the lowest-energy speed that still meets the 12.2 m³/h duty. It clears the 1446 rpm critical by 15.6% and the 852 rpm stand critical by 43%, and keeps the NPSH margin at 1.98. Higher speeds in the feasible band cost energy as N³ for no vibration benefit.',
        model: 'muse-wonder-1.0',
        curve: (() => {
          const rpm: number[] = []
          for (let r = 300; r <= 1700; r += 10) rpm.push(r)
          const errs = MODES.map((m) => this.campbellModes.find((c) => Math.abs(c.f_hz - m.f) < 0.6)?.f_err_hz ?? 0.5)
          const band = rpm.map((r) => overallBand(r, errs))
          return {
            rpm,
            vel: rpm.map((r) => +overallAt(r).toFixed(3)),
            vel_lo: band.map((b) => +b.lo.toFixed(3)),
            vel_hi: band.map((b) => +b.hi.toFixed(3)),
            kw: rpm.map((r) => kw(r)),
            p_res: rpm.map((r) => +pResAt(r).toFixed(4)),
          }
        })(),
        risk: { p_res_current: +pResAt(N0).toFixed(3), p_res_proposed: +pResAt(pr).toFixed(4), threshold: 0.05 },
      }
      this.emit(this.proposal)
      this.wonderBusy = false
      this.setPhase('awaiting')
    })
    this.after(2.6, () => this.pipe('open_weights', 'ok', 2140, 'agreement 0.97 with Wonder · data stayed on-prem'))
    const dv = Math.round((vNew / vCur - 1) * 100)
    const de = Math.round(((pr / N0) ** 3 - 1) * 100)
    this.say(
      `Proposal p1: drop to 1220 rpm. It's the lowest-energy speed that still meets the 12.2 m³/h duty, clears the 1446 rpm critical by 15.6%, and keeps NPSH margin at 1.98. P(resonance) falls from ${(pResAt(N0) * 100).toFixed(0)}% to ${pctTxt(pResAt(pr))}. Expected ${dv}% vibration and ${de}% energy. Waiting for your approval.`,
      3.1,
      [
        ['1220', 'proposal.proposed.speed_rpm'],
        ['12.2', 'proposal.constraints[0].value'],
        ['1446', 'campbell.criticals[2].rpm'],
        ['15.6', 'proposal.constraints[1].value'],
        ['1.98', 'proposal.constraints[2].value'],
        [(pResAt(N0) * 100).toFixed(0), 'proposal.risk.p_res_current'],
        [pctTxt(pResAt(pr)).replace(/[<%]/g, ''), 'proposal.risk.p_res_proposed'],
        [String(dv), 'proposal.expected.vibration_change_pct'],
        [String(de), 'proposal.expected.energy_change_pct'],
      ],
    )
  }

  private verify() {
    if (!this.proposal) return
    const p = this.proposal
    this.pipe('wonder', 'running', 0, `verify · re-measuring at ${Math.round(this.rpm)} rpm`)
    this.pipe('dsp', 'running', 0, 'verification window · 8 s average')
    this.after(2.2, () => {
      const measured = +(overallAt(this.rpm) * 1.07).toFixed(2)
      const dev = (measured / p.proposed.vel_mm_s - 1) * 100
      const passed = Math.abs(dev) < 15
      this.pipe('dsp', 'ok', 8, 'phase correlation · 5 ch + ref @ 30 fps')
      this.pipe('wonder', 'ok', 2240, passed ? 'verified · closed loop' : 'verification failed · re-planning')
      this.emit({
        type: 'verification',
        proposal_id: p.id,
        predicted_vel_mm_s: p.proposed.vel_mm_s,
        measured_vel_mm_s: measured,
        passed,
        summary: `Predicted change confirmed within ${Math.abs(dev).toFixed(0)}% · ${p.current.vel_mm_s.toFixed(1)} → ${measured.toFixed(1)} mm/s`,
        before_ci: [+(p.current.vel_mm_s * 0.943).toFixed(2), +(p.current.vel_mm_s * 1.052).toFixed(2)],
        after_ci: [+(measured * 0.926).toFixed(2), +(measured * 1.074).toFixed(2)],
        // permutation test on 8 s windows (3999 resamples): smallest resolvable p is 1/4000
        p_value: 0.0003,
        significant: true,
      })
      this.emit({
        type: 'diagnosis',
        id: 'd3',
        severity: 'info',
        title: 'Resonance cleared at 1220 rpm',
        summary: `Measured ${measured.toFixed(1)} mm/s RMS (zone ${isoZone(measured)}) against ${p.proposed.vel_mm_s.toFixed(1)} predicted. 1× now sits 16% below the motor-mount mode.`,
        evidence: [
          { kind: 'metric', name: 'overall velocity (mm/s RMS)', value: measured, err: 0.2 },
          { kind: 'spectrum_peak', channel: 's1', f_hz: +(this.rpm / 60).toFixed(2) },
          ...this.frameEvidence(this.t),
        ],
        confidence: 0.93,
        model: 'muse-wonder-1.0',
      })
      this.say(
        `Re-measured at ${Math.round(this.rpm)} rpm: ${measured.toFixed(1)} mm/s against ${p.proposed.vel_mm_s.toFixed(1)} predicted (${dev >= 0 ? '+' : ''}${dev.toFixed(0)}%). The drop is significant (p = 0.0003). Verified, zone ${isoZone(measured)}. The twin's mode estimate is still ±0.4 Hz wide; approve an envelope and I can refine the setpoint in closed loop.`,
        0.2,
        [
          [String(Math.round(this.rpm)), 'telemetry.speed_rpm'],
          [measured.toFixed(1), 'verification.measured_vel_mm_s'],
          [p.proposed.vel_mm_s.toFixed(1), 'verification.predicted_vel_mm_s'],
          [`${dev >= 0 ? '+' : ''}${dev.toFixed(0)}`.replace('+', ''), 'verification (measured / predicted − 1)'],
          ['0.0003', 'verification.p_value'],
          ['0.4', 'campbell.modes[1].f_err_hz'],
        ],
      )
    })
  }

  private answer(q: string) {
    const lq = q.toLowerCase()
    this.pipe('wonder', 'running', 0, 'answering operator question')
    this.after(0.7, () => this.pipe('wonder', 'ok', 690 + rnd() * 300, 'answered · cited 2 evidence items'))
    let a: string
    if (/why|pick|1220|2\.6/.test(lq) && this.proposal)
      a = `Because ${N0} rpm puts 1× on the 24.1 Hz motor-mount mode. Below about 1330 rpm the amplification drops from roughly 12× to 3×. Energy falls as N³, so I took the lowest speed in the feasible band that still meets the 12.2 m³/h duty: 1220 rpm. Going lower would break the duty constraint.`
    else if (/damp|zeta|ζ/.test(lq)) a = 'Damping comes from the half-power bandwidth of each FDD peak: ζ = Δf / 2f_n. Mode 2 shows 1.64 Hz at 24.1 Hz, so ζ ≈ 0.034, and the ±0.008 comes from the bandwidth uncertainty across the five channels.'
    else if (/npsh|cavitat/.test(lq)) a = 'NPSH margin is NPSHa / NPSHr. NPSHr scales with N², so slowing to 1220 rpm raises the margin from 1.40 to 1.98, well above the 1.3 limit. The audio cavitation index is flat at 0.08.'
    else if (/coast|run.?up/.test(lq)) a = 'Say "Argonaut, start a coast-down" or press Coast-down. Switch the machine off and keep the camera still for about 20 s. I track the orders down to standstill and build the Campbell diagram from them.'
    else a = `Right now: ${Math.round(this.rpm)} rpm, overall ${overallAt(this.rpm).toFixed(1)} mm/s RMS (zone ${isoZone(overallAt(this.rpm))}). Ask me about the proposal, damping, NPSH, or how to run a coast-down.`
    this.say(a, 0.8)
  }

  /* ── main loop (10 Hz) ── */
  private step() {
    this.t += 0.1
    this.phaseT += 0.1
    this.tick++
    const due = this.queue.filter((q) => q.at <= this.t)
    if (due.length) {
      this.queue = this.queue.filter((q) => q.at > this.t)
      due.forEach((q) => q.fn())
    }
    if (this.phase === 'boot') return

    // speed profile
    const T_COAST = 18
    const T_RUN = 6
    if (this.phase === 'coast') {
      const u = Math.min(this.phaseT, T_COAST)
      const tau = 6.5
      const e = Math.exp(-T_COAST / tau)
      this.rpm = Math.max(0, this.rampFrom * ((Math.exp(-u / tau) - e) / (1 - e)))
      if (this.tick % 5 === 0) {
        this.coastSpeeds.push(Math.round(this.rpm))
        this.coastTimes.push(+this.t.toFixed(2))
        {
          const f = this.rpm / 60
          const { a1, a2 } = orderAmps(CHANNELS[1], f)
          const mm = (v: number, k: number) => (f > 0.5 ? +(v / (2 * Math.PI * k * f)).toFixed(5) : 0)
          this.orderAmp['1'].push(mm(a1, 1))
          this.orderAmp['2'].push(mm(a2, 2))
          this.orderAmp['3'].push(mm(0.25 * a2, 3))
        }
        // estimates sharpen as the sweep passes each mode
        const m2 = this.campbellModes.find((m) => m.label.startsWith('Motor'))
        if (m2) {
          m2.f_err_hz = Math.max(0.4, m2.f_err_hz * 0.93)
          m2.zeta_err = Math.max(0.008, (m2.zeta_err ?? 0.02) * 0.93)
          m2.zeta = +(0.034 + ((m2.zeta ?? 0.03) - 0.034) * 0.9).toFixed(4)
        }
        if (this.rpm < 930 && !this.campbellModes.some((m) => m.label.startsWith('Stand')))
          this.campbellModes.push({ f_hz: 14.2, f_err_hz: 0.9, zeta: 0.028, zeta_err: 0.014, label: 'Stand rocking mode', source: '1× order sweep, half-power' })
        const m1 = this.campbellModes.find((m) => m.label.startsWith('Stand'))
        if (m1 && this.rpm < 800) {
          m1.f_err_hz = Math.max(0.3, m1.f_err_hz * 0.9)
          m1.zeta_err = Math.max(0.006, (m1.zeta_err ?? 0.02) * 0.9)
          m1.zeta = +(0.021 + ((m1.zeta ?? 0.03) - 0.021) * 0.85).toFixed(4)
        }
        this.emitCampbell()
      }
      if (this.rpm < 880 && this.rpm > 820 && !(this as { _saidStand?: boolean })._saidStand) {
        ;(this as { _saidStand?: boolean })._saidStand = true
        this.say('1× just crossed 14.2 Hz at about 850 rpm, and the stand channel rang up 4×. That is the stand rocking mode.')
      }
      if (this.phaseT >= T_COAST) {
        this.rpm = 0
        this.say('Coast-down complete: 1476 → 0 rpm, 5 channels above 0.9 confidence. Restarting to run speed for the baseline.')
        this.coach('ok', 'Good capture. Coast-down covered the full speed range with no dropped frames.', 0.5)
        this.setPhase('runup')
      }
    } else if (this.phase === 'runup') {
      this.rpm = N0 * (1 - Math.exp(-this.phaseT / 1.4))
      if (this.phaseT >= T_RUN) {
        this.rpm = N0
        this.setPhase('steady')
        this.after(0.8, () => this.identify())
        this.after(5.2, () => this.optimize())
      }
    } else if (this.phase === 'ramping') {
      const rate = 60 // rpm/s
      const dir = Math.sign(this.targetRpm - this.rampFrom)
      this.rpm = this.rampFrom + dir * rate * this.phaseT
      if ((dir < 0 && this.rpm <= this.targetRpm) || (dir > 0 && this.rpm >= this.targetRpm)) {
        this.rpm = this.targetRpm
        this.setPhase('settled')
        this.coach('ok', 'Speed settled at 1220 rpm. Hold still for the 8 s verification window.', 0.2)
        this.after(2.5, () => this.verify())
      }
    } else if (this.phase === 'rto') {
      this.stepRto()
    }

    const rpmMeas = this.rpm > 1 ? this.rpm * jitter(0.0015) : 0
    const f1 = rpmMeas / 60
    const audioTach = f1 > 3

    // telemetry @ 10 Hz
    const channels: TelemetryChannel[] = CHANNELS.filter((c) => !c.ref).map((c) => {
      const v = chanRms(c, f1) * jitter(0.025)
      const fd = Math.max(f1, 8)
      return { id: c.id, disp_mm_rms: +(v / (2 * Math.PI * fd)).toFixed(4), vel_mm_s_rms: +v.toFixed(2), iso_zone: isoZone(v) }
    })
    const overall = Math.max(...channels.map((c) => c.vel_mm_s_rms))
    // v2: latency of the frame → telemetry path (webcam 30 fps), a two-frame hiccup before the coast-down
    if (Math.abs(this.t - 7.3) < 0.05) this.dropped += 2
    const lat = 33 + rnd() * 9 + (this.tick % 60 === 30 ? 14 : 0)
    // transients widen the CI (fewer stationary averages)
    const transient = this.phase === 'coast' || this.phase === 'runup' || this.phase === 'ramping' || (this.phase === 'rto' && this.rtoRun?.sub === 'stepping')
    const ciRel = transient ? 0.11 : 0.055
    this.emit({
      type: 'telemetry',
      t: +this.t.toFixed(2),
      speed_hz: +f1.toFixed(3),
      speed_rpm: Math.round(rpmMeas),
      speed_source: this.phase === 'runup' && f1 > 0.5 ? 'audio (blade pass)' : f1 > 3 ? 'video+audio' : f1 > 0.5 ? 'video' : 'none',
      channels,
      overall_vel_mm_s_rms: +overall.toFixed(2),
      iso_zone: isoZone(overall),
      latency: { frame_to_telemetry_ms: +lat.toFixed(1), p95_ms: +(57 + rnd() * 6).toFixed(1), fps_in: +(29.7 + rnd() * 0.25).toFixed(1), frames_dropped: this.dropped },
      band: { direct_hz: DIRECT_HZ, dealiased_hz: audioTach ? DEALIASED_HZ : DIRECT_HZ },
      overall_vel_ci: [+(overall * (1 - ciRel)).toFixed(2), +(overall * (1 + ciRel * 1.15)).toFixed(2)],
    })
    // de-aliasing @ 1 Hz while the mic tachometer has a lock
    if (this.tick % 10 === 5 && audioTach) this.emitDealias(f1)
    // closed loop @ 2 Hz
    if (this.phase === 'rto' && this.rtoRun && !this.rtoRun.done && this.tick % 5 === 2) this.emitRto()

    // spectrum + waterfall @ 4 Hz (every 2.5 ticks → alternate 2/3)
    if (this.tick % 5 === 0 || this.tick % 5 === 3) {
      for (const c of CHANNELS) {
        const { amp, peaks } = spectrumFor(c, f1)
        this.emit({ type: 'spectrum', t: +this.t.toFixed(2), channel: c.id, f_hz: F_GRID, amp, unit: 'mm/s', peaks })
        this.emit({ type: 'waterfall', t: +this.t.toFixed(2), channel: c.id, f_max_hz: F_MAX, row: waterfallRow(amp) })
      }
      this.emit({ type: 'waterfall', t: +this.t.toFixed(2), channel: 'mic', f_max_hz: MIC_FMAX, row: micRow(f1) })
    }
    // tracked masks @ 2 Hz, SAM refresh every 6 s
    if (this.tick % 5 === 1) this.emitSensors()
    if (this.tick % 60 === 30) {
      this.pipe('sam', 'running', 0, 're-segmenting 2 s clip')
      this.after(0.45, () => this.pipe('sam', 'ok', 370 + rnd() * 110, `tracking ${CHANNELS.length} regions · mean conf ${(0.92 + rnd() * 0.03).toFixed(2)}`))
    }
    if (this.tick % 10 === 0) {
      this.pipe('dsp', 'ok', 6 + rnd() * 3, `phase correlation · ${CHANNELS.length - 1} ch + ref @ 30 fps · ${f1 > 0.5 ? `1× ${f1.toFixed(2)} Hz` : 'no rotation'}${audioTach ? ' · de-aliased' : ''}`)
    }
  }

  /* ── v2: de-aliasing ── */
  private emitDealias(f1: number) {
    const fa = f1 * (1 + (rnd() - 0.5) * 0.0008) // mic tachometer estimate
    const conf: Record<number, number> = { 1: 0.93, 2: 0.88, 3: 0.79, [BLADES]: 0.84 }
    for (const c of CHANNELS.filter((x) => !x.ref)) {
      const peaks: DealiasPeak[] = []
      for (const k of [1, 2, 3, BLADES]) {
        const ft = k * fa
        if (ft <= DIRECT_HZ || ft > DEALIASED_HZ) continue
        const { n, alias } = foldOf(ft)
        if (alias < 0.4) continue // folded onto DC: not observable
        const res = 0.02 + rnd() * 0.05 * Math.sqrt(k)
        peaks.push({ f_alias_hz: +alias.toFixed(2), f_true_hz: +ft.toFixed(2), order: k, fold: n, residual_hz: +res.toFixed(2), confidence: +(conf[k] * (c.id === 's1' || c.id === 's2' ? 1 : 0.96)).toFixed(2) })
      }
      this.emit({ type: 'dealias', channel: c.id, fs_video: FS_VIDEO, speed_hz_audio: +fa.toFixed(2), speed_source: 'audio', peaks })
    }
  }

  /* ── v2: closed-loop RTO against the plant simulator ── */
  private static readonly SUB_T: Record<RtoStatus, number> = { stepping: 0, settling: 1.6, measuring: 2.6, updating: 1.1, converged: 0, aborted: 0 }
  private stepRto() {
    const r = this.rtoRun
    if (!r || r.done) return
    r.subT += 0.1
    if (r.sub === 'stepping') {
      const dir = Math.sign(r.setpoint - r.rampFrom)
      this.rpm = r.rampFrom + dir * 60 * r.subT
      if ((dir <= 0 && this.rpm <= r.setpoint) || (dir >= 0 && this.rpm >= r.setpoint)) {
        this.rpm = r.setpoint
        r.sub = 'settling'
        r.subT = 0
      }
      return
    }
    this.rpm = r.setpoint
    if (r.subT < MockEngine.SUB_T[r.sub]) return
    r.subT = 0
    if (r.sub === 'settling') r.sub = 'measuring'
    else if (r.sub === 'measuring') {
      const meas = overallAt(r.setpoint) * jitter(0.02)
      r.measured = { vel_mm_s: +meas.toFixed(2), kw: +(kwAt(r.setpoint) * 1.03).toFixed(4) }
      const pred = overallAt(r.setpoint) * (twinGain(r.iter - 1) / G_TRUE)
      r.history.push({ iteration: r.iter, setpoint_rpm: r.setpoint, pred_vel: +pred.toFixed(2), meas_vel: r.measured.vel_mm_s, kw: r.measured.kw })
      r.sub = 'updating'
      this.pipe('wonder', 'running', 0, `closed loop · it ${r.iter} · updating twin (gain, modes)`)
    } else if (r.sub === 'updating') {
      const last = r.history[r.history.length - 1]
      const err = Math.abs(last.pred_vel / (last.meas_vel ?? last.pred_vel) - 1)
      const next = r.plan[r.iter]
      const dS = next != null ? next - r.setpoint : 0
      this.pipe('wonder', 'ok', 180 + rnd() * 120, `closed loop · it ${r.iter} · pred err ${(err * 100).toFixed(0)}%`)
      if (r.iter >= 2 && (next == null || Math.abs(dS) < 10) && err < 0.15) {
        r.done = true
        this.emitRto('converged', `converged: |Δsetpoint| ${Math.abs(dS).toFixed(0)} rpm < 10 rpm and prediction error ${(err * 100).toFixed(0)}% < 15%`)
        this.setPhase('settled')
        const m = twinModes(r.iter)
        this.say(
          `Closed loop converged after ${r.iter} iterations at ${r.setpoint} rpm. The plant's 1× gain is ${twinGain(r.iter).toFixed(2)} ± ${twinGainSd(r.iter).toFixed(2)} of the twin's, and the motor-mount mode tightened to ${m[1].f_hz.toFixed(2)} ± ${m[1].f_sd.toFixed(2)} Hz. Measured ${last.meas_vel?.toFixed(2)} mm/s against ${last.pred_vel.toFixed(2)} predicted.`,
          0.3,
          [
            [String(r.iter), 'rto.iteration'],
            [String(r.setpoint), 'rto.setpoint_rpm'],
            [twinGain(r.iter).toFixed(2), 'rto.model.gain_1x'],
            [twinGainSd(r.iter).toFixed(2), 'rto.model.gain_sd'],
            [m[1].f_hz.toFixed(2), 'rto.model.modes[1].f_hz'],
            [m[1].f_sd.toFixed(2), 'rto.model.modes[1].f_sd'],
            [last.meas_vel?.toFixed(2) ?? '', 'rto.measured.vel_mm_s'],
            [last.pred_vel.toFixed(2), 'rto.predicted.vel_mm_s'],
          ],
        )
        return
      }
      if (r.iter === 3) {
        const g = twinGain(3)
        this.say(`Iteration 3: the twin over-predicted by ${(err * 100).toFixed(0)}%, so I lowered its 1× gain to ${g.toFixed(2)}. Mode uncertainty is shrinking as each setpoint adds evidence.`, 0.2, [
          [(err * 100).toFixed(0), 'rto.history[2] (pred / meas − 1)'],
          [g.toFixed(2), 'rto.model.gain_1x'],
        ])
      }
      r.iter += 1
      r.rampFrom = r.setpoint
      r.setpoint = next ?? r.setpoint
      r.measured = null
      r.sub = 'stepping'
    }
  }
  private emitRto(status?: RtoStatus, reason?: string) {
    const r = this.rtoRun
    if (!r) return
    const st = status ?? r.sub
    const k = st === 'converged' || st === 'aborted' || r.sub === 'updating' ? r.iter : r.iter - 1
    const kp = r.iter - 1 // model the prediction for this setpoint was made with
    const pred = overallAt(r.setpoint) * (twinGain(kp) / G_TRUE)
    const rel = 1.645 * twinGainSd(kp) / twinGain(kp) + 0.03
    const ev: RtoEvent = {
      type: 'rto',
      iteration: r.iter,
      status: st,
      envelope_rpm: [r.lo, r.hi],
      max_step_rpm: r.maxStep,
      setpoint_rpm: r.setpoint,
      speed_rpm: Math.round(this.rpm),
      predicted: { vel_mm_s: +pred.toFixed(2), vel_lo: +(pred * (1 - rel)).toFixed(2), vel_hi: +(pred * (1 + rel)).toFixed(2), kw: +kwAt(r.setpoint).toFixed(4) },
      measured: r.measured,
      model: { modes: twinModes(k), gain_1x: +twinGain(k).toFixed(3), gain_sd: +twinGainSd(k).toFixed(3) },
      objective: { kw: +kwAt(r.setpoint).toFixed(4), j: objJ(r.setpoint) },
      history: r.history.slice(),
      reason: reason ?? null,
      source: 'plant simulator (Modbus)',
    }
    this.emit(ev)
  }
}

export const MOCK_CONSTANTS = { N0, NAMEPLATE_RPM, BLADES, MODES, CHANNELS }

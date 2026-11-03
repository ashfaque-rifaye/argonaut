// Exact TypeScript mirror of docs/CONTRACT.md. Field names are the wire names.
// Units: SI unless the field name says otherwise (_hz, _mm, _rpm, _kw). `t` = seconds from session start.

/* ───────────────────────────── REST ───────────────────────────── */

export type SessionMode = 'live' | 'clip'

export interface CreateSessionRequest {
  asset_name: string
  mode: SessionMode
}
export interface CreateSessionResponse {
  session_id: string
}
export interface ClipUploadResponse {
  clip_id: string
  fps: number
  duration_s: number
  width: number
  height: number
}
export interface DatasheetUploadResponse {
  ok: boolean
}
export interface ApproveRequest {
  proposal_id: string
  approved: boolean
  note?: string
}
export interface ApproveResponse {
  ok: boolean
}
/** v2 · POST /api/sessions/{id}/envelope: operator-approved operating envelope for the closed loop. */
export interface EnvelopeRequest {
  lo_rpm: number
  hi_rpm: number
  max_step_rpm: number
  approved: boolean
}
export interface OkResponse {
  ok: boolean
}
/** GET /api/sessions/{id}/report: full snapshot (latest of every event). Shape is backend-defined.
 *  v4 · carries `scale_calibrated: false` when amplitudes are relative only. */
export type SessionReport = Record<string, unknown> & { scale_calibrated?: boolean }

/* ─────────────────────── WebSocket: client → server ─────────────────────── */

export interface FrameMsg {
  type: 'frame'
  t: number
  jpeg_b64: string
}
export interface AudioMsg {
  type: 'audio'
  t: number
  pcm16_b64: string
  rate: number
}
export interface SensorsSetMsg {
  type: 'sensors.set'
  prompts: string[]
}
export type CommandName = 'start_coastdown' | 'stop' | 'identify' | 'optimize' | 'verify'
export interface CommandMsg {
  type: 'command'
  name: CommandName
}
export interface ChatMsg {
  type: 'chat'
  text: string
}
export type ClientMessage = FrameMsg | AudioMsg | SensorsSetMsg | CommandMsg | ChatMsg

/* ─────────────────────── WebSocket: server → client ─────────────────────── */

export type PipelineStage = 'sam' | 'spark' | 'wonder' | 'voice' | 'dsp' | 'open_weights'
export type PipelineState = 'idle' | 'running' | 'ok' | 'error'
export interface PipelineEvent {
  type: 'pipeline'
  stage: PipelineStage
  state: PipelineState
  model: string
  latency_ms: number
  detail: string
}

export type Point = [number, number]
export interface SensorItem {
  id: string
  label: string
  color: string
  polygon: Point[]
  bbox: [number, number, number, number]
  confidence: number
  is_reference: boolean
}
export interface SensorsEvent {
  type: 'sensors'
  t: number
  width: number
  height: number
  items: SensorItem[]
}

export type IsoZone = 'A' | 'B' | 'C' | 'D'
export interface TelemetryChannel {
  id: string
  disp_mm_rms: number
  vel_mm_s_rms: number
  /** null when the scale is uncalibrated (see TelemetryEvent.calibrated) */
  iso_zone: IsoZone | null
}
/** Known values: "video", "audio", "video+audio", "audio (blade pass)", "audio (tonal order)", "none". */
export type SpeedSource = string
export interface TelemetryEvent {
  type: 'telemetry'
  t: number
  /** seconds into the analysed clip (clip / replay mode) */
  clip_t?: number
  speed_hz: number
  speed_rpm: number
  speed_source: SpeedSource
  channels: TelemetryChannel[]
  overall_vel_mm_s_rms: number
  /** v4 · may be null even when values exist (uncalibrated scale) */
  iso_zone: IsoZone | null
  /**
   * v4 · false = the absolute mm/s scale is not trustworthy (no credible scale reference in real
   * footage, or physically implausible levels from camera motion). Amplitudes are relative;
   * frequencies, orders, phase and ratios stay valid. Absent = calibrated (older backends, replays).
   */
  calibrated?: boolean
  /** v2 · realtime health of the frame → telemetry path */
  latency?: TelemetryLatency | null
  /** v2 · measurable vibration band right now: camera Nyquist vs with audio de-aliasing */
  band?: TelemetryBand | null
  /** v2 · 90% CI of overall_vel_mm_s_rms */
  overall_vel_ci?: [number, number] | null
}
export interface TelemetryLatency {
  frame_to_telemetry_ms: number
  p95_ms: number
  fps_in: number
  frames_dropped: number
}
export interface TelemetryBand {
  direct_hz: number
  dealiased_hz: number
}

export interface SpectrumPeak {
  f_hz: number
  amp: number
  order: number
  label: string
  corroborated_audio: boolean
  /** v2 · 90% CI of amp */
  amp_ci?: [number, number] | null
  /** v2 · true when the peak lies above the camera Nyquist and was recovered by de-aliasing */
  aliased?: boolean
  /** v2 · where the camera actually sees it (folded into 0..fs/2) */
  f_alias_hz?: number | null
}

/** v2 · de-aliasing result (~1 Hz live, once per clip). f_true = |f_alias − fold·fs| or fold·fs + f_alias. */
export interface DealiasPeak {
  f_alias_hz: number
  f_true_hz: number
  order: number
  fold: number
  residual_hz: number
  confidence: number
}
export interface DealiasEvent {
  type: 'dealias'
  channel: string
  fs_video: number
  speed_hz_audio: number
  speed_source: string
  peaks: DealiasPeak[]
}
export interface SpectrumEvent {
  type: 'spectrum'
  t: number
  clip_t?: number
  channel: string
  f_hz: number[]
  amp: number[]
  unit: string
  peaks: SpectrumPeak[]
}

export interface WaterfallEvent {
  type: 'waterfall'
  t: number
  clip_t?: number
  /** a sensor id, or "mic" for the acoustic waterfall (f_max_hz ≈ 1500) */
  channel: string
  f_max_hz: number
  /** uint8 0–255, linearly spaced 0..f_max_hz */
  row: number[]
}

export interface CampbellMode {
  f_hz: number
  f_err_hz: number
  /** null when the peak was found without a damping fit (e.g. residual spectrum) */
  zeta: number | null
  zeta_err: number | null
  label: string
  forcing_power?: number
  /** how the mode was identified, e.g. "1× order-tracked sweep, SDOF fit" */
  source?: string
}
export interface CampbellCritical {
  rpm: number
  order: number
  mode_f_hz: number
}
export interface CampbellEvent {
  type: 'campbell'
  speeds_rpm: number[]
  /** sample times aligned with speeds_rpm */
  times_s?: number[]
  /** order amplitude (mm) vs time, keyed by order ("1","2","3"), aligned with speeds_rpm */
  order_amp_mm?: Record<string, number[]>
  modes: CampbellMode[]
  orders: number[]
  criticals: CampbellCritical[]
}

export interface ModeShapeEntry {
  id: string
  amp: number
  phase_deg: number
}
export interface ModalMode {
  f_hz: number
  zeta: number | null
  shape: ModeShapeEntry[]
}
export interface ModalEvent {
  type: 'modal'
  method: string
  f_hz: number[]
  sv1: number[]
  sv2: number[]
  modes: ModalMode[]
}

export interface PumpCurve {
  q: number[]
  h: number[]
  eta: number[]
  npshr: number[]
}
export interface AssetEvent {
  type: 'asset'
  name: string
  nameplate: { rpm: number; kw: number; poles: number }
  pump_curve: PumpCurve | null
  bep: { q: number; h: number } | null
}

export type Severity = 'info' | 'warn' | 'alarm'
export interface EvidenceSpectrumPeak {
  kind: 'spectrum_peak'
  channel: string
  f_hz: number
}
export interface EvidenceFrame {
  kind: 'frame'
  t: number
  jpeg_b64: string
}
export interface EvidenceMetric {
  kind: 'metric'
  name: string
  value: number
  err: number
}
export type Evidence = EvidenceSpectrumPeak | EvidenceFrame | EvidenceMetric
export interface DiagnosisEvent {
  type: 'diagnosis'
  id: string
  severity: Severity
  title: string
  summary: string
  evidence: Evidence[]
  confidence: number
  model: string
}

export interface OperatingState {
  speed_rpm: number
  vel_mm_s: number
  kw: number
}
export interface ProposalConstraint {
  name: string
  value: string
  ok: boolean
}
export interface ProposalEvent {
  type: 'proposal'
  id: string
  objective: string
  current: OperatingState
  proposed: OperatingState
  constraints: ProposalConstraint[]
  feasible_band_rpm: [number, number][]
  exclusion_bands_rpm: [number, number][]
  expected: { vibration_change_pct: number; energy_change_pct: number }
  rationale: string
  model: string
  /** predicted vibration (mm/s) and power (kW) vs speed: the optimizer's objective landscape */
  curve?: ProposalCurve | null
  /** v2 · probability of resonance now vs at the proposal, against the gate */
  risk?: ProposalRisk | null
}
export interface ProposalCurve {
  rpm: number[]
  vel: number[]
  kw: number[]
  /** v2 · 90% band of the predicted vibration */
  vel_lo?: number[]
  vel_hi?: number[]
  /** v2 · P(an order lands inside a mode's half-power band), 0..1 */
  p_res?: number[]
}
export interface ProposalRisk {
  p_res_current: number
  p_res_proposed: number
  threshold: number
}

export interface VerificationEvent {
  type: 'verification'
  proposal_id: string
  predicted_vel_mm_s: number
  measured_vel_mm_s: number
  passed: boolean
  summary: string
  /** v2 · 90% CIs of overall velocity before / after the change, and the test result */
  before_ci?: [number, number] | null
  after_ci?: [number, number] | null
  p_value?: number | null
  significant?: boolean | null
}

/* v2 · closed-loop RTO */
export type RtoStatus = 'stepping' | 'settling' | 'measuring' | 'updating' | 'converged' | 'aborted'
export interface RtoModelMode {
  f_hz: number
  f_sd: number
  zeta: number | null
  zeta_sd: number | null
}
export interface RtoHistoryEntry {
  iteration: number
  setpoint_rpm: number
  pred_vel: number
  meas_vel: number | null
  kw: number
}
export interface RtoEvent {
  type: 'rto'
  iteration: number
  status: RtoStatus
  envelope_rpm: [number, number]
  max_step_rpm: number
  setpoint_rpm: number
  speed_rpm: number
  predicted: { vel_mm_s: number; vel_lo?: number; vel_hi?: number; kw: number }
  measured: { vel_mm_s: number; kw: number } | null
  model?: { modes: RtoModelMode[]; gain_1x?: number; gain_sd?: number } | null
  objective?: { kw: number; j: number } | null
  history?: RtoHistoryEntry[]
  reason?: string | null
  /** what the loop is actually driving, e.g. "plant simulator (Modbus)" */
  source?: string
}

export interface AgentEvent {
  type: 'agent'
  role: string
  text: string
  final: boolean
  /** v2 · numeric provenance; start/end are character offsets into the assembled message text */
  claims?: AgentClaim[]
  provenance?: { verified: number; unverified: number } | null
}
export interface AgentClaim {
  start: number
  end: number
  value: number
  verified: boolean
  source: string | null
}

export interface TranscriptEvent {
  type: 'transcript'
  speaker: string
  text: string
  final: boolean
}

export type CoachLevel = 'ok' | 'warn' | 'block'
export interface CoachEvent {
  type: 'coach'
  level: CoachLevel
  text: string
}

export interface ErrorEvent {
  type: 'error'
  message: string
}

export type ServerMessage =
  | PipelineEvent
  | SensorsEvent
  | TelemetryEvent
  | SpectrumEvent
  | WaterfallEvent
  | CampbellEvent
  | ModalEvent
  | AssetEvent
  | DiagnosisEvent
  | ProposalEvent
  | VerificationEvent
  | AgentEvent
  | TranscriptEvent
  | CoachEvent
  | MediaEvent
  | DealiasEvent
  | RtoEvent
  | ErrorEvent

/** The analysed clip, served by the backend so the live view plays the real footage (synced to clip_t). */
export interface MediaEvent {
  type: 'media'
  t?: number
  url: string
  width?: number | null
  height?: number | null
  fps?: number | null
  /** v3 · set when the media comes from POST /play (library clip); absent for uploads and older replays */
  clip_id?: string
  mode?: PlayMode
}

/* ───────────── v3 · real-footage library (GET /api/library, POST /api/sessions/{id}/play) ───────────── */

export type PlayMode = 'analyse' | 'stream'
export type ClipKind = 'fan' | 'pump' | 'motor' | 'rotor' | 'structure' | 'turbine' | (string & {})

export interface LibraryClip {
  id: string
  title: string
  kind: ClipKind
  featured?: boolean
  /** true = published real footage (credit + licence must be shown); false = synthetic with exact ground truth */
  real: boolean
  note?: string
  what?: string
  credit?: string
  license?: string
  source_url?: string | null
  url: string
  poster_url?: string | null
  width?: number | null
  height?: number | null
  fps?: number | null
  duration_s?: number | null
  has_audio?: boolean
}
export interface LibraryResponse {
  clips: LibraryClip[]
}
export interface PlayRequest {
  clip_id: string
  mode: PlayMode
}
export interface PlayResponse {
  ok: boolean
  clip?: LibraryClip
  mode?: PlayMode
  error?: string
}

export type ServerMessageType = ServerMessage['type']

export const PIPELINE_STAGES: PipelineStage[] = ['sam', 'spark', 'wonder', 'voice', 'dsp', 'open_weights']

export const STAGE_META: Record<PipelineStage, { name: string; role: string; defaultModel: string }> = {
  sam: { name: 'SAM 3.1', role: 'Virtual sensors · segmentation + tracking', defaultModel: 'sam-3.1' },
  spark: { name: 'Muse Spark', role: 'Scene + audio understanding · datasheet', defaultModel: 'muse-spark-1.2' },
  wonder: { name: 'Muse Wonder', role: 'Agent · experiment plan + optimizer', defaultModel: 'muse-wonder-1.0' },
  voice: { name: 'Muse Voice Transcribe', role: 'Hands-free voice control', defaultModel: 'muse-voice-transcribe' },
  dsp: { name: 'DSP', role: 'Sub-pixel motion · FFT · order tracking', defaultModel: 'argonaut-dsp' },
  open_weights: { name: 'Muse Spark Open', role: 'Private mode · open weights on Baseten', defaultModel: 'muse-spark-open' },
}

export function isServerMessage(x: unknown): x is ServerMessage {
  return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string'
}

import { create } from 'zustand'
import type {
  AgentClaim,
  AssetEvent,
  DealiasEvent,
  RtoEvent,
  RtoStatus,
  CampbellEvent,
  CoachEvent,
  DiagnosisEvent,
  Evidence,
  LibraryClip,
  PlayMode,
  ModalEvent,
  PipelineEvent,
  PipelineStage,
  ProposalEvent,
  SensorsEvent,
  ServerMessage,
  SpectrumEvent,
  TelemetryEvent,
  VerificationEvent,
  WaterfallEvent,
} from './protocol'
import { PIPELINE_STAGES, STAGE_META } from './protocol'

export type AppMode = 'live' | 'replay' | 'mock'
export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'closed'
export type ProposalStatus = 'none' | 'pending' | 'submitting' | 'applying' | 'verified' | 'failed' | 'rejected'

export interface ConsoleItem {
  id: string
  kind: 'agent' | 'user' | 'transcript' | 'coach' | 'diagnosis' | 'error' | 'system'
  text: string
  open?: boolean // streaming / interim
  speaker?: string
  level?: string
  refId?: string // diagnosis / proposal id
  at: number // wall-clock ms
  /** v2 · numeric provenance, offsets into `text` */
  claims?: AgentClaim[]
}

/** One rto event as it arrived, stamped with session seconds (rto events carry no `t`). */
export interface RtoSample {
  t: number
  iteration: number
  status: RtoStatus
  setpoint_rpm: number
  speed_rpm: number
  pred: number
  lo: number | null
  hi: number | null
  meas: number | null
  kw: number | null
}
/** v4 · what the Live view is playing from the real-footage library */
export type PlayStatus = 'starting' | 'playing' | 'ended' | 'error'
export interface NowPlaying {
  clip: LibraryClip
  mode: PlayMode
  status: PlayStatus
  error?: string
  /** changes on every (re)start so the <video> element restarts from 0 */
  nonce: number
}
export type LibraryState = 'idle' | 'loading' | 'ready' | 'error'

export type EnvelopeStatus = 'none' | 'submitting' | 'approved' | 'stopping' | 'error'
export type OptimizerTab = 'proposal' | 'loop'

export interface StageState extends PipelineEvent {
  history: number[]
  updatedAt: number
}

const HIST = 150

export interface TelemetryHistory {
  speed: number[]
  overall: number[]
  channels: Record<string, number[]>
  /** v2 · p95 frame → telemetry latency (ms) */
  latency: number[]
}

export interface EvidenceTarget {
  title: string
  evidence: Evidence[]
  focus: number
  source?: string
}

interface State {
  mode: AppMode
  conn: ConnState
  sessionId: string | null
  assetName: string
  startedAt: number
  msgCount: number
  msgRate: number

  pipeline: Record<PipelineStage, StageState>
  sensors: SensorsEvent | null
  telemetry: TelemetryEvent | null
  hist: TelemetryHistory
  spectra: Record<string, SpectrumEvent>
  selectedChannel: string | null
  campbell: CampbellEvent | null
  modal: ModalEvent | null
  asset: AssetEvent | null
  diagnoses: DiagnosisEvent[]
  proposal: ProposalEvent | null
  proposalStatus: ProposalStatus
  verification: VerificationEvent | null
  coach: CoachEvent | null
  console: ConsoleItem[]
  drawer: EvidenceTarget | null
  ods: { on: boolean; f_hz: number | null }
  videoSource: 'sim' | 'webcam' | 'clip'
  mediaUrl: string | null

  /* v4 · source library */
  library: LibraryClip[] | null
  libraryState: LibraryState
  /** recorded run ids (GET /api/runs): `demo_real_<clip id>` = an instant replay of that clip with Meta model output */
  runs: string[]
  nowPlaying: NowPlaying | null
  /** a clip the operator picked from disk (blob URL, played locally) */
  localClip: { url: string; name: string } | null
  sourceOpen: boolean

  /* v2 */
  dealias: Record<string, DealiasEvent>
  rto: RtoEvent | null
  rtoTrace: RtoSample[]
  /** rto runs seen this session, and the session time of the current run's first sample */
  rtoRun: { n: number; t0: number; model0: RtoEvent['model'] | null }
  envelopeStatus: EnvelopeStatus
  optimizerTab: OptimizerTab
  provenance: { verified: number; unverified: number; messages: number }

  ingest: (m: ServerMessage) => void
  set: (p: Partial<State>) => void
  pushConsole: (item: Omit<ConsoleItem, 'id' | 'at'>) => void
  openEvidence: (t: EvidenceTarget) => void
  closeEvidence: () => void
  reset: () => void
  /** clear analysis results (new source) but keep the console, provenance and connection */
  resetAnalysis: () => void
}

let seq = 0
const nid = () => `c${++seq}`

function initialPipeline(): Record<PipelineStage, StageState> {
  const o = {} as Record<PipelineStage, StageState>
  for (const s of PIPELINE_STAGES) {
    o[s] = {
      type: 'pipeline',
      stage: s,
      state: 'idle',
      model: STAGE_META[s].defaultModel,
      latency_ms: 0,
      detail: 'standby',
      history: [],
      updatedAt: 0,
    }
  }
  return o
}

const push = (arr: number[], v: number, n = HIST) => {
  const a = arr.length >= n ? arr.slice(arr.length - n + 1) : arr.slice()
  a.push(v)
  return a
}

/* ───────── Waterfall: high-rate data kept out of React state ───────── */
export interface WaterfallBuf {
  rows: Uint8Array[]
  ts: number[]
  fMax: number
  version: number
  /** time axis is clip seconds (clip_t) rather than session seconds */
  clip?: boolean
}
const WF_ROWS = 260
export const waterfall = {
  bufs: new Map<string, WaterfallBuf>(),
  listeners: new Set<(ch: string) => void>(),
  add(e: WaterfallEvent) {
    let b = this.bufs.get(e.channel)
    if (!b) {
      b = { rows: [], ts: [], fMax: e.f_max_hz, version: 0 }
      this.bufs.set(e.channel, b)
    }
    b.fMax = e.f_max_hz
    b.rows.push(Uint8Array.from(e.row))
    b.ts.push(e.clip_t ?? e.t)
    b.clip = e.clip_t != null
    if (b.rows.length > WF_ROWS) {
      b.rows.shift()
      b.ts.shift()
    }
    b.version++
    this.listeners.forEach((l) => l(e.channel))
  },
  clear() {
    this.bufs.clear()
  },
}

const initial = () => ({
  conn: 'connecting' as ConnState,
  startedAt: Date.now(),
  msgCount: 0,
  msgRate: 0,
  pipeline: initialPipeline(),
  sensors: null,
  telemetry: null,
  hist: { speed: [], overall: [], channels: {}, latency: [] } as TelemetryHistory,
  spectra: {} as Record<string, SpectrumEvent>,
  selectedChannel: null as string | null,
  campbell: null,
  modal: null,
  asset: null,
  diagnoses: [] as DiagnosisEvent[],
  proposal: null,
  proposalStatus: 'none' as ProposalStatus,
  verification: null,
  coach: null,
  console: [] as ConsoleItem[],
  drawer: null,
  ods: { on: false, f_hz: null as number | null },
  dealias: {} as Record<string, DealiasEvent>,
  rto: null as RtoEvent | null,
  rtoTrace: [] as RtoSample[],
  rtoRun: { n: 0, t0: 0, model0: null } as { n: number; t0: number; model0: RtoEvent['model'] | null },
  envelopeStatus: 'none' as EnvelopeStatus,
  optimizerTab: 'proposal' as OptimizerTab,
  provenance: { verified: 0, unverified: 0, messages: 0 },
})

const TERMINAL: RtoStatus[] = ['converged', 'aborted']
const MAX_TRACE = 900

/** Parse the number written in a slice of text (handles −, thin spaces, thousands spaces). */
function numIn(s: string) {
  const m = /[-−]?\d[\d\s\u2009\u202f]*(?:[.,]\d+)?/.exec(s)
  if (!m) return NaN
  return parseFloat(m[0].replace(/[\s\u2009\u202f]/g, '').replace('−', '-').replace(',', '.'))
}
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 0.005)

/**
 * Claims are character offsets into the assembled message. We trust them when the slice holds
 * the claimed value; otherwise try chunk-relative offsets, then a text search, then drop the mark
 * (an unanchored claim still counts in the provenance total).
 */
function anchorClaims(full: string, chunkStart: number, claims: AgentClaim[]): AgentClaim[] {
  const out: AgentClaim[] = []
  for (const c of claims) {
    const cands: [number, number][] = [
      [c.start, c.end],
      [c.start + chunkStart, c.end + chunkStart],
    ]
    let hit = cands.find(([a, b]) => a >= 0 && b <= full.length && b > a && near(numIn(full.slice(a, b)), c.value))
    if (!hit) {
      for (const f of [String(c.value), c.value.toFixed(1), c.value.toFixed(2), c.value.toFixed(0)]) {
        const i = full.indexOf(f)
        if (i >= 0) {
          hit = [i, i + f.length]
          break
        }
      }
    }
    if (hit) out.push({ ...c, start: hit[0], end: hit[1] })
  }
  return out.sort((a, b) => a.start - b.start)
}

const MAX_CONSOLE = 220
const cap = (c: ConsoleItem[]) => (c.length > MAX_CONSOLE ? c.slice(c.length - MAX_CONSOLE) : c)

export const useStore = create<State>((set, get) => ({
  mode: 'mock',
  sessionId: null,
  assetName: 'Fan F-101',
  videoSource: 'sim',
  mediaUrl: null,
  library: null,
  libraryState: 'idle',
  runs: [],
  nowPlaying: null,
  localClip: null,
  sourceOpen: false,
  ...initial(),

  set: (p) => set(p),
  reset: () => {
    waterfall.clear()
    set({ ...initial() })
  },
  resetAnalysis: () => {
    waterfall.clear()
    const { conn: _c, startedAt: _s, console: _k, provenance: _p, msgCount: _m, msgRate: _r, pipeline: _pl, ...rest } = initial()
    set(rest)
  },
  openEvidence: (t) => set({ drawer: t }),
  closeEvidence: () => set({ drawer: null }),
  pushConsole: (item) => set((s) => ({ console: cap([...s.console, { ...item, id: nid(), at: Date.now() }]) })),

  ingest: (m) => {
    const s = get()
    const msgCount = s.msgCount + 1
    switch (m.type) {
      case 'pipeline': {
        if (!(m.stage in s.pipeline)) return
        const prev = s.pipeline[m.stage]
        const history = m.latency_ms > 0 && m.state !== 'running' ? push(prev.history, m.latency_ms, 24) : prev.history
        set({ msgCount, pipeline: { ...s.pipeline, [m.stage]: { ...m, history, updatedAt: Date.now() } } })
        return
      }
      case 'sensors':
        set({ msgCount, sensors: m })
        return
      case 'media': {
        // match the media to a library clip (clip_id from /play, else by URL: analyse mode and older replays)
        const lib = s.library ?? []
        const np = s.nowPlaying
        const clip =
          (m.clip_id ? lib.find((c) => c.id === m.clip_id) : undefined) ??
          lib.find((c) => c.url === m.url) ??
          (np && (np.clip.id === m.clip_id || np.clip.url === m.url) ? np.clip : undefined)
        let nowPlaying: NowPlaying | null = null
        if (clip) {
          const same = np?.clip.id === clip.id
          nowPlaying = same
            ? { ...np!, mode: m.mode ?? np!.mode, status: np!.status === 'starting' || np!.status === 'error' ? 'playing' : np!.status }
            : { clip, mode: m.mode ?? 'analyse', status: 'playing', nonce: Date.now() }
        }
        set({
          msgCount,
          mediaUrl: m.url,
          nowPlaying,
          // a library clip replaces a local file; an unknown URL (the server's copy of an upload) keeps it
          localClip: clip ? null : s.localClip,
          videoSource: s.videoSource === 'webcam' && !clip ? 'webcam' : 'clip',
        })
        return
      }
      case 'telemetry': {
        const channels: Record<string, number[]> = { ...s.hist.channels }
        for (const c of m.channels) channels[c.id] = push(channels[c.id] ?? [], c.vel_mm_s_rms)
        set({
          msgCount,
          telemetry: m,
          hist: {
            speed: push(s.hist.speed, m.speed_rpm),
            overall: push(s.hist.overall, m.overall_vel_mm_s_rms),
            channels,
            latency: m.latency ? push(s.hist.latency, m.latency.p95_ms, 90) : s.hist.latency,
          },
        })
        return
      }
      case 'spectrum': {
        const selectedChannel = s.selectedChannel ?? (m.channel === 'mic' ? null : m.channel)
        set({ msgCount, spectra: { ...s.spectra, [m.channel]: m }, selectedChannel })
        return
      }
      case 'waterfall':
        waterfall.add(m)
        set({ msgCount })
        return
      case 'campbell':
        set({ msgCount, campbell: m })
        return
      case 'modal':
        set({ msgCount, modal: m })
        return
      case 'asset':
        set({ msgCount, asset: m, assetName: m.name })
        return
      case 'diagnosis': {
        const exists = s.diagnoses.some((d) => d.id === m.id)
        const diagnoses = exists ? s.diagnoses.map((d) => (d.id === m.id ? m : d)) : [...s.diagnoses, m]
        const consoleItems = exists
          ? s.console
          : cap([...s.console, { id: nid(), at: Date.now(), kind: 'diagnosis' as const, text: m.title, refId: m.id, level: m.severity }])
        set({ msgCount, diagnoses, console: consoleItems })
        return
      }
      case 'proposal':
        set({
          msgCount,
          proposal: m,
          proposalStatus: 'pending',
          verification: null,
          console: cap([...s.console, { id: nid(), at: Date.now(), kind: 'system', text: `Proposal ${m.id} ready for approval · ${Math.round(m.current.speed_rpm)} → ${Math.round(m.proposed.speed_rpm)} rpm`, refId: m.id, level: 'proposal' }]),
        })
        return
      case 'verification':
        set({
          msgCount,
          verification: m,
          proposalStatus: m.passed ? 'verified' : 'failed',
          console: cap([...s.console, { id: nid(), at: Date.now(), kind: 'system', text: m.summary, refId: m.proposal_id, level: m.passed ? 'verified' : 'failed' }]),
        })
        return
      case 'agent': {
        const c = s.console.slice()
        let idx = -1
        for (let i = c.length - 1; i >= Math.max(0, c.length - 12); i--) {
          if (c[i].kind === 'agent' && c[i].open) {
            idx = i
            break
          }
        }
        const prevText = idx >= 0 ? c[idx].text : ''
        const text = prevText + m.text
        const newClaims = m.claims?.length ? anchorClaims(text, prevText.length, m.claims) : []
        const merged = (idx >= 0 ? c[idx].claims ?? [] : []).concat(newClaims)
        const claims = merged.length ? merged : undefined
        if (idx >= 0) c[idx] = { ...c[idx], text, open: !m.final, claims }
        else c.push({ id: nid(), at: Date.now(), kind: 'agent', text, open: !m.final, speaker: m.role, claims })
        let provenance = s.provenance
        if (m.provenance || m.claims?.length) {
          const v = m.provenance?.verified ?? m.claims!.filter((x) => x.verified).length
          const u = m.provenance?.unverified ?? m.claims!.filter((x) => !x.verified).length
          provenance = { verified: s.provenance.verified + v, unverified: s.provenance.unverified + u, messages: s.provenance.messages + 1 }
        }
        set({ msgCount, console: cap(c), provenance })
        return
      }
      case 'dealias':
        set({ msgCount, dealias: { ...s.dealias, [m.channel]: m } })
        return
      case 'rto': {
        const t = (Date.now() - s.startedAt) / 1000
        const prev = s.rto
        const newRun = !prev || m.iteration < prev.iteration || (TERMINAL.includes(prev.status) && !TERMINAL.includes(m.status))
        const sample: RtoSample = {
          t,
          iteration: m.iteration,
          status: m.status,
          setpoint_rpm: m.setpoint_rpm,
          speed_rpm: m.speed_rpm,
          pred: m.predicted.vel_mm_s,
          lo: m.predicted.vel_lo ?? null,
          hi: m.predicted.vel_hi ?? null,
          meas: m.measured?.vel_mm_s ?? null,
          kw: m.measured?.kw ?? m.predicted.kw ?? null,
        }
        const base = newRun ? [] : s.rtoTrace
        const rtoTrace = base.length >= MAX_TRACE ? [...base.slice(base.length - MAX_TRACE + 1), sample] : [...base, sample]
        const terminal = TERMINAL.includes(m.status)
        const consoleItems =
          terminal && prev?.status !== m.status
            ? cap([
                ...s.console,
                {
                  id: nid(),
                  at: Date.now(),
                  kind: 'system' as const,
                  text: `Closed loop ${m.status} · iteration ${m.iteration} · ${Math.round(m.setpoint_rpm)} rpm`,
                  level: m.status === 'converged' ? 'verified' : 'failed',
                },
              ])
            : s.console
        set({
          msgCount,
          rto: m,
          rtoTrace,
          rtoRun: newRun ? { n: s.rtoRun.n + 1, t0: t, model0: m.model ?? null } : s.rtoRun.model0 || !m.model ? s.rtoRun : { ...s.rtoRun, model0: m.model },
          optimizerTab: newRun ? 'loop' : s.optimizerTab,
          envelopeStatus: terminal ? 'none' : s.envelopeStatus === 'stopping' ? 'stopping' : 'approved',
          console: consoleItems,
        })
        return
      }
      case 'transcript': {
        const c = s.console.slice()
        let idx = -1
        for (let i = c.length - 1; i >= Math.max(0, c.length - 12); i--) {
          if (c[i].kind === 'transcript' && c[i].open && c[i].speaker === m.speaker) {
            idx = i
            break
          }
        }
        if (idx >= 0) c[idx] = { ...c[idx], text: m.text, open: !m.final }
        else c.push({ id: nid(), at: Date.now(), kind: 'transcript', text: m.text, open: !m.final, speaker: m.speaker })
        set({ msgCount, console: cap(c) })
        return
      }
      case 'coach': {
        const last = [...s.console].reverse().find((x) => x.kind === 'coach')
        const consoleItems =
          last && last.text === m.text ? s.console : cap([...s.console, { id: nid(), at: Date.now(), kind: 'coach' as const, text: m.text, level: m.level }])
        const ended = /^end of clip/i.test(m.text) && s.nowPlaying && s.nowPlaying.status !== 'ended'
        set({ msgCount, coach: m, console: consoleItems, ...(ended ? { nowPlaying: { ...s.nowPlaying!, status: 'ended' as const } } : {}) })
        return
      }
      case 'error':
        set({ msgCount, console: cap([...s.console, { id: nid(), at: Date.now(), kind: 'error', text: m.message }]) })
        return
    }
  },
}))

// message-rate meter
setInterval(() => {
  const s = useStore.getState()
  const prev = (useStore as unknown as { _last?: number })._last ?? s.msgCount
  ;(useStore as unknown as { _last?: number })._last = s.msgCount
  const rate = s.msgCount - prev
  if (rate !== s.msgRate) useStore.setState({ msgRate: rate })
}, 1000)

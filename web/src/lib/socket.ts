// Transport layer: WebSocket to /ws/{session_id} with reconnect, REST helpers, and the
// mock fallback. A single `link` object is what the UI talks to.

import type {
  ApproveRequest,
  ApproveResponse,
  ClientMessage,
  ClipUploadResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  DatasheetUploadResponse,
  EnvelopeRequest,
  OkResponse,
  SessionReport,
} from './protocol'
import { defaultEnvelope } from './envelope'
import { isServerMessage } from './protocol'
import { MockEngine } from './mock'
import { useStore } from './store'
import { autoStart, loadLibrary } from './library'
import { API_ORIGIN, SHOWCASE, StaticReplay } from './showcase'

/* ───────────────────────── REST ───────────────────────── */

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // the server's own explanation when it has one (public demo limits, an expired session)
    const detail = await res.json().then((b: { detail?: unknown }) => b.detail, () => null)
    throw new Error(typeof detail === 'string' ? detail : `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export const api = {
  createSession: (body: CreateSessionRequest, signal?: AbortSignal) =>
    fetch(`${API_ORIGIN}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }).then((r) =>
      json<CreateSessionResponse>(r),
    ),
  uploadClip: (id: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return fetch(`${API_ORIGIN}/api/sessions/${encodeURIComponent(id)}/clip`, { method: 'POST', body: fd }).then((r) => json<ClipUploadResponse>(r))
  },
  uploadDatasheet: (id: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return fetch(`${API_ORIGIN}/api/sessions/${encodeURIComponent(id)}/datasheet`, { method: 'POST', body: fd }).then((r) => json<DatasheetUploadResponse>(r))
  },
  approve: (id: string, body: ApproveRequest) =>
    fetch(`${API_ORIGIN}/api/sessions/${encodeURIComponent(id)}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) =>
      json<ApproveResponse>(r),
    ),
  envelope: (id: string, body: EnvelopeRequest) =>
    fetch(`${API_ORIGIN}/api/sessions/${encodeURIComponent(id)}/envelope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) =>
      json<OkResponse>(r),
    ),
  rtoStop: (id: string) => fetch(`${API_ORIGIN}/api/sessions/${encodeURIComponent(id)}/rto/stop`, { method: 'POST' }).then((r) => json<OkResponse>(r)),
  report: (id: string) => fetch(`${API_ORIGIN}/api/sessions/${encodeURIComponent(id)}/report`).then((r) => json<SessionReport>(r)),
  decideAction: (id: string, aid: string, approved: boolean) =>
    fetch(`${API_ORIGIN}/api/sessions/${encodeURIComponent(id)}/actions/${encodeURIComponent(aid)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    }).then((r) => json<{ ok: boolean; error?: string }>(r)),
  planActions: (id: string) => fetch(`${API_ORIGIN}/api/sessions/${encodeURIComponent(id)}/actions/plan`, { method: 'POST' }).then((r) => json<{ ok: boolean; error?: string }>(r)),
  connectFeed: (id: string, url: string, name?: string) =>
    fetch(`${API_ORIGIN}/api/sessions/${encodeURIComponent(id)}/feed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, name }) }).then((r) =>
      json<{ ok: boolean; error?: string }>(r),
    ),
}

/* ───────────────────────── WebSocket ───────────────────────── */

class Socket {
  private ws: WebSocket | null = null
  private url: string
  private retry = 0
  private closed = false
  private outbox: string[] = []

  constructor(path: string) {
    const origin = API_ORIGIN ? new URL(API_ORIGIN) : location
    this.url = `${origin.protocol === 'https:' ? 'wss' : 'ws'}://${origin.host}${path}`
    this.open()
  }

  private open() {
    const st = useStore.getState()
    st.set({ conn: this.retry ? 'reconnecting' : 'connecting' })
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      useStore.getState().set({ conn: 'open' })
      for (const m of this.outbox.splice(0)) ws.send(m)
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        const m: unknown = JSON.parse(ev.data)
        if (isServerMessage(m)) useStore.getState().ingest(m)
      } catch {
        /* ignore malformed frame */
      }
    }
    ws.onclose = () => {
      if (this.closed) {
        useStore.getState().set({ conn: 'closed' })
        return
      }
      this.retry++
      useStore.getState().set({ conn: 'reconnecting' })
      const delay = Math.min(8000, 400 * 2 ** Math.min(this.retry, 5)) * (0.8 + Math.random() * 0.4)
      window.setTimeout(() => !this.closed && this.open(), delay)
    }
    ws.onerror = () => ws.close()
  }

  get ready() {
    return this.ws?.readyState === WebSocket.OPEN
  }
  /** Bytes queued in the socket; used to drop video frames under back-pressure. */
  get buffered() {
    return this.ws?.bufferedAmount ?? 0
  }

  send(m: ClientMessage) {
    const s = JSON.stringify(m)
    if (this.ready) this.ws!.send(s)
    else if (m.type !== 'frame' && m.type !== 'audio') this.outbox.push(s)
  }
  close() {
    this.closed = true
    this.ws?.close()
  }
}

/* ───────────────────────── Link (what the UI uses) ───────────────────────── */

let socket: Pick<Socket, 'ready' | 'buffered' | 'send' | 'close'> | null = null
let mock: MockEngine | null = null

export const link = {
  send(m: ClientMessage) {
    if (m.type === 'chat') useStore.getState().pushConsole({ kind: 'user', text: m.text })
    if (mock) mock.handle(m)
    else socket?.send(m)
  },
  /** true when frames/audio should be streamed upstream */
  get streaming() {
    return !!socket && socket.ready && useStore.getState().mode === 'live'
  },
  get backpressure() {
    return socket?.buffered ?? 0
  },
  async approve(proposal_id: string, approved: boolean, note?: string) {
    const st = useStore.getState()
    st.set({ proposalStatus: 'submitting' })
    try {
      if (mock) mock.approve({ proposal_id, approved, note })
      else if (st.sessionId) await api.approve(st.sessionId, { proposal_id, approved, note })
      useStore.getState().set({ proposalStatus: approved ? 'applying' : 'rejected' })
      useStore.getState().pushConsole({ kind: 'system', text: approved ? `You approved ${proposal_id}` : `You rejected ${proposal_id}`, level: approved ? 'approved' : 'rejected', refId: proposal_id })
    } catch (e) {
      useStore.getState().set({ proposalStatus: 'pending' })
      useStore.getState().pushConsole({ kind: 'error', text: `Approval failed: ${(e as Error).message}` })
    }
  },
  /** v2 · approve an operating envelope and start the closed loop */
  async approveEnvelope(env: EnvelopeRequest) {
    const st = useStore.getState()
    st.set({ envelopeStatus: 'submitting', optimizerTab: 'loop' })
    try {
      if (mock) mock.approveEnvelope(env)
      else if (st.sessionId) await api.envelope(st.sessionId, env)
      else throw new Error('no session')
      useStore.getState().set({ envelopeStatus: 'approved' })
      useStore.getState().pushConsole({ kind: 'system', text: `You approved envelope ${env.lo_rpm}–${env.hi_rpm} rpm · step ≤ ${env.max_step_rpm} rpm`, level: 'approved' })
    } catch (e) {
      useStore.getState().set({ envelopeStatus: 'error' })
      useStore.getState().pushConsole({ kind: 'error', text: `Envelope approval failed: ${(e as Error).message}` })
    }
  },
  async stopRto() {
    const st = useStore.getState()
    st.set({ envelopeStatus: 'stopping' })
    try {
      if (mock) mock.stopRto()
      else if (st.sessionId) await api.rtoStop(st.sessionId)
      useStore.getState().pushConsole({ kind: 'system', text: 'You stopped the closed loop', level: 'rejected' })
    } catch (e) {
      useStore.getState().set({ envelopeStatus: 'approved' })
      useStore.getState().pushConsole({ kind: 'error', text: `Stop failed: ${(e as Error).message}` })
    }
  },
  async decideAction(aid: string, approved: boolean) {
    const st = useStore.getState()
    if (!st.sessionId || st.mode !== 'live') return
    const r = await api.decideAction(st.sessionId, aid, approved)
    if (!r.ok) useStore.getState().pushConsole({ kind: 'error', text: `Action: ${r.error ?? 'failed'}` })
    else useStore.getState().pushConsole({ kind: 'system', text: `You ${approved ? 'approved' : 'rejected'} an agent action`, level: approved ? 'approved' : 'rejected' })
  },
  async planActions() {
    const st = useStore.getState()
    if (!st.sessionId || st.mode !== 'live') return
    const r = await api.planActions(st.sessionId)
    if (!r.ok) useStore.getState().pushConsole({ kind: 'error', text: r.error ?? 'Could not plan actions' })
  },
  async connectFeed(url: string, name?: string) {
    const st = useStore.getState()
    st.set({ pickedSource: true })
    if (st.mode !== 'live' && !(await goLive())) throw new Error('The live backend is not reachable right now. Recorded runs still work.')
    st.resetAnalysis()
    st.set({ videoSource: 'clip', nowPlaying: null, localClip: null, welcomeOpen: false, assetName: name || 'Live feed' })
    const r = await api.connectFeed(useStore.getState().sessionId!, url, name)
    if (!r.ok) throw new Error(r.error ?? 'Could not open the stream')
    useStore.getState().pushConsole({ kind: 'system', text: `Live feed connected: ${name || url}` })
  },
  async uploadClip(file: File) {
    const id = useStore.getState().sessionId
    if (!id || mock) return null
    return api.uploadClip(id, file)
  },
  async uploadDatasheet(file: File) {
    const id = useStore.getState().sessionId
    if (mock) {
      useStore.getState().pushConsole({ kind: 'system', text: `Datasheet “${file.name}” queued for Muse Spark (simulated)` })
      return { ok: true }
    }
    if (!id) return null
    return api.uploadDatasheet(id, file)
  },
}

function startMock(reason: string) {
  const st = useStore.getState()
  st.set({ mode: 'mock', conn: 'open', sessionId: 'sim-' + Math.random().toString(36).slice(2, 8), startedAt: Date.now() })
  if (reason) st.pushConsole({ kind: 'system', text: reason })
  mock = new MockEngine((m) => useStore.getState().ingest(m))
  mock.start()
  // ?autoplay=1 → unattended demo loop: the simulator approves its own proposal after a pause
  if (new URLSearchParams(location.search).get('autoplay') === '1') {
    let timer = 0
    let envTimer = 0
    useStore.subscribe((s, prev) => {
      if (s.proposalStatus === 'pending' && prev.proposalStatus !== 'pending' && s.proposal) {
        const id = s.proposal.id
        window.clearTimeout(timer)
        timer = window.setTimeout(() => useStore.getState().proposalStatus === 'pending' && link.approve(id, true), 9000)
      }
      // after a verified one-shot change, show the closed-loop envelope and approve it after a pause
      if (s.proposalStatus === 'verified' && prev.proposalStatus !== 'verified' && s.rtoRun.n === 0) {
        window.clearTimeout(envTimer)
        envTimer = window.setTimeout(() => {
          useStore.getState().set({ optimizerTab: 'loop' })
          envTimer = window.setTimeout(() => {
            const st = useStore.getState()
            if (st.envelopeStatus === 'none' && st.rtoRun.n === 0) void link.approveEnvelope(defaultEnvelope(st.proposal))
          }, 7000)
        }, 6000)
      }
    })
  }
}

/**
 * Showcase site: switch from recorded runs to the live backend when a visitor wants to run their own
 * footage or camera. The backend may be asleep, so give it a while to wake.
 */
export async function goLive(): Promise<boolean> {
  const st = useStore.getState()
  if (st.mode === 'live' && st.sessionId) return true
  if (!SHOWCASE || !API_ORIGIN) return false
  st.pushConsole({ kind: 'system', text: 'Connecting to the live backend (it can take up to a minute to wake)…' })
  try {
    const ctl = new AbortController()
    const to = window.setTimeout(() => ctl.abort(), 75000)
    const { session_id } = await api.createSession({ asset_name: 'Your footage', mode: 'live' }, ctl.signal)
    window.clearTimeout(to)
    socket?.close()
    useStore.getState().set({ mode: 'live', sessionId: session_id, startedAt: Date.now(), assetName: st.assetName === 'Recorded runs' ? 'Your footage' : st.assetName })
    socket = new Socket(`/ws/${encodeURIComponent(session_id)}`)
    return true
  } catch {
    useStore.getState().pushConsole({ kind: 'error', text: 'The live backend is not reachable right now. Recorded runs still work.' })
    return false
  }
}

let booted = false
export async function bootstrap() {
  if (booted) return
  booted = true
  const q = new URLSearchParams(location.search)
  const asset = q.get('asset') ?? (q.get('mock') === '1' ? 'Fan F-101' : 'No source yet')
  useStore.getState().set({ assetName: asset })

  if (q.get('mock') === '1') {
    void loadLibrary() // offered in the Source drawer; picking a clip reopens the console live
    return startMock('Simulator · coast-down scenario for Fan F-101 (4-pole, 5 blades)')
  }

  const replay = q.get('replay')
  if (SHOWCASE) {
    // static deployment: no backend. Recorded runs replay in the browser; the welcome sheet offers them.
    useStore.getState().set({ mode: 'replay', sessionId: replay ?? null, startedAt: Date.now(), videoSource: 'clip', assetName: replay ? asset : 'Recorded runs' })
    void loadLibrary()
    if (replay) socket = new StaticReplay(replay, Number(q.get('speed') ?? 1) || 1)
    else useStore.getState().set({ welcomeOpen: true, conn: 'open' })
    return
  }
  if (replay) {
    useStore.getState().set({ mode: 'replay', sessionId: replay, startedAt: Date.now(), videoSource: 'clip' })
    socket = new Socket(`/ws/replay/${encodeURIComponent(replay)}${q.get('speed') ? `?speed=${encodeURIComponent(q.get('speed')!)}` : ''}`)
    void loadLibrary() // credits for a replayed library clip
    return
  }

  const joined = q.get('session')
  let sessionId = joined
  if (!sessionId) {
    try {
      const ctl = new AbortController()
      const to = window.setTimeout(() => ctl.abort(), 2500)
      sessionId = (await api.createSession({ asset_name: asset, mode: 'live' }, ctl.signal)).session_id
      window.clearTimeout(to)
    } catch {
      return startMock('Backend unreachable at /api. Running the built-in simulator')
    }
  }
  useStore.getState().set({ mode: 'live', sessionId, startedAt: Date.now(), videoSource: 'clip' })
  socket = new Socket(`/ws/${encodeURIComponent(sessionId)}`)
  // a fresh session opens on the welcome sheet (choose: sample, upload, live feed); ?clip=<id> plays directly
  if (!joined && q.get('clip')) void autoStart(q)
  else {
    void loadLibrary()
    if (!joined) useStore.getState().set({ welcomeOpen: true, videoSource: 'clip' })
  }
}

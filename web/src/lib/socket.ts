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

/* ───────────────────────── REST ───────────────────────── */

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

export const api = {
  createSession: (body: CreateSessionRequest, signal?: AbortSignal) =>
    fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }).then((r) =>
      json<CreateSessionResponse>(r),
    ),
  uploadClip: (id: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return fetch(`/api/sessions/${encodeURIComponent(id)}/clip`, { method: 'POST', body: fd }).then((r) => json<ClipUploadResponse>(r))
  },
  uploadDatasheet: (id: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return fetch(`/api/sessions/${encodeURIComponent(id)}/datasheet`, { method: 'POST', body: fd }).then((r) => json<DatasheetUploadResponse>(r))
  },
  approve: (id: string, body: ApproveRequest) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) =>
      json<ApproveResponse>(r),
    ),
  envelope: (id: string, body: EnvelopeRequest) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}/envelope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) =>
      json<OkResponse>(r),
    ),
  rtoStop: (id: string) => fetch(`/api/sessions/${encodeURIComponent(id)}/rto/stop`, { method: 'POST' }).then((r) => json<OkResponse>(r)),
  report: (id: string) => fetch(`/api/sessions/${encodeURIComponent(id)}/report`).then((r) => json<SessionReport>(r)),
}

/* ───────────────────────── WebSocket ───────────────────────── */

class Socket {
  private ws: WebSocket | null = null
  private url: string
  private retry = 0
  private closed = false
  private outbox: string[] = []

  constructor(path: string) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.url = `${proto}://${location.host}${path}`
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

let socket: Socket | null = null
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

let booted = false
export async function bootstrap() {
  if (booted) return
  booted = true
  const q = new URLSearchParams(location.search)
  const asset = q.get('asset') ?? 'Fan F-101'
  useStore.getState().set({ assetName: asset })

  if (q.get('mock') === '1') {
    void loadLibrary() // offered in the Source drawer; picking a clip reopens the console live
    return startMock('Simulator · coast-down scenario for Fan F-101 (4-pole, 5 blades)')
  }

  const replay = q.get('replay')
  if (replay) {
    useStore.getState().set({ mode: 'replay', sessionId: replay, startedAt: Date.now(), videoSource: 'clip' })
    socket = new Socket(`/ws/replay/${encodeURIComponent(replay)}`)
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
  // real by default: a fresh live session plays the featured real clip (or ?clip=<id>&mode=…)
  if (!joined) void autoStart(q)
  else void loadLibrary()
}

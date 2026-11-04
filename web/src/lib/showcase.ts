// Showcase build (VITE_SHOWCASE=1): a static deployment with no backend. The console replays the runs
// recorded with the Meta models from static files (/static/runs/<id>.jsonl), paced in the browser
// exactly as the server's /ws/replay does, and plays footage from /static/media/.

import { isServerMessage } from './protocol'
import { useStore } from './store'

export const SHOWCASE = import.meta.env.VITE_SHOWCASE === '1'
export const REPO_URL = 'https://github.com/ashfaque-rifaye/argonaut'
/** Where the live backend runs when it isn't this origin (the hosted showcase). Empty: same origin. */
export const API_ORIGIN: string = import.meta.env.VITE_API_ORIGIN ?? ''
/** Server paths (/api/...) as URLs the browser can fetch from here. */
export const apiUrl = (u: string) => (u.startsWith('/api/') ? API_ORIGIN + u : u)

/** /api/media/<path> (what the recorded events reference) -> the static copy. */
export const staticUrl = (u: string | null | undefined) => (u && SHOWCASE ? u.replace(/^\/api\/media\//, '/static/media/') : u ?? null)

function rewrite(m: Record<string, unknown>) {
  if (typeof m.url === 'string') m.url = staticUrl(m.url)
  return m
}

/** Same surface as the WebSocket transport (ready / buffered / send / close). */
export class StaticReplay {
  private stopped = false
  readonly buffered = 0
  get ready() {
    return false
  }

  constructor(runId: string, speed = 1) {
    void this.play(runId, speed)
  }

  private async play(runId: string, speed: number) {
    const st = useStore.getState()
    st.set({ conn: 'connecting' })
    let text: string
    try {
      const r = await fetch(`/static/runs/${encodeURIComponent(runId)}.jsonl`)
      if (!r.ok) throw new Error(`${r.status}`)
      text = await r.text()
    } catch (e) {
      st.set({ conn: 'closed' })
      st.pushConsole({ kind: 'error', text: `Recorded run “${runId}” is not in this showcase (${(e as Error).message})` })
      return
    }
    useStore.getState().set({ conn: 'open' })
    let last: number | null = null
    let lastClip: number | null = null
    for (const line of text.split('\n')) {
      if (this.stopped) return
      if (!line.trim()) continue
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      const t = typeof ev.t === 'number' ? ev.t : null
      const clipT = ev.type === 'telemetry' && typeof ev.clip_t === 'number' ? ev.clip_t : null
      // telemetry walks the clip: pace by clip time, so the charts stay in step with the footage
      const wait =
        clipT != null ? (lastClip != null && clipT > lastClip ? (clipT - lastClip) * 1000 : 0) : last != null && t != null && t > last ? Math.min(2000, (t - last) * 1000) : 0
      if (wait > 0) await new Promise((res) => window.setTimeout(res, wait / Math.max(speed, 1e-3)))
      if (clipT != null) lastClip = clipT
      if (t != null) last = t
      const m = rewrite(ev)
      if (isServerMessage(m)) useStore.getState().ingest(m)
    }
  }

  send() {
    /* a recording cannot be steered */
  }
  close() {
    this.stopped = true
  }
}

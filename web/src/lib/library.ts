// v4 · Real-footage source library: GET /api/library, POST /api/sessions/{id}/play, and the
// source switches the Live view offers (library clip, device camera, local file, simulator).

import type { LibraryClip, LibraryResponse, PlayMode, PlayResponse } from './protocol'
import { link } from './socket'
import { useStore } from './store'

export const PLAY_MODE_LABEL: Record<PlayMode, string> = {
  analyse: 'Analyse',
  stream: 'Live stream',
}
export const PLAY_MODE_HINT: Record<PlayMode, string> = {
  analyse: 'Full identification at real speed: SAM sensors, spectra, Campbell, Muse Wonder diagnosis and proposal',
  stream: 'Fed frame by frame into the live camera engine: latency, de-aliasing, mic tachometer',
}

let inflight: Promise<LibraryClip[] | null> | null = null

/** Fetch the library once (re-fetch after an error). Resolves null when the backend is unreachable. */
export function loadLibrary(force = false): Promise<LibraryClip[] | null> {
  const st = useStore.getState()
  if (!force && st.libraryState === 'ready' && st.library) return Promise.resolve(st.library)
  if (inflight) return inflight
  st.set({ libraryState: 'loading' })
  void fetch('/api/runs')
    .then((r) => (r.ok ? r.json() : []))
    .then((runs: unknown) => Array.isArray(runs) && useStore.getState().set({ runs: runs.filter((x): x is string => typeof x === 'string') }))
    .catch(() => {})
  const ctl = new AbortController()
  const to = window.setTimeout(() => ctl.abort(), 4000)
  inflight = fetch('/api/library', { signal: ctl.signal })
    .then(async (r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      const ct = r.headers.get('content-type') ?? ''
      if (!ct.includes('json')) throw new Error('not JSON')
      const clips = ((await r.json()) as LibraryResponse).clips ?? []
      const cur = useStore.getState()
      // media that arrived before the library (a replay, a joined session) gets its credits now
      const match = !cur.nowPlaying && cur.mediaUrl && !cur.localClip ? clips.find((c) => c.url === cur.mediaUrl) : undefined
      cur.set({ library: clips, libraryState: 'ready', ...(match ? { nowPlaying: { clip: match, mode: 'analyse', status: 'playing', nonce: Date.now() } } : {}) })
      return clips
    })
    .catch(() => {
      useStore.getState().set({ libraryState: 'error' })
      return null
    })
    .finally(() => {
      window.clearTimeout(to)
      inflight = null
    })
  return inflight
}

export const featuredClip = (clips: LibraryClip[]) => clips.find((c) => c.featured && c.real) ?? clips.find((c) => c.real) ?? clips[0] ?? null

/** "CC BY 3.0", "CC0 1.0", "Public domain" … as written by the library. */
export const licenseOf = (c: LibraryClip) => c.license ?? (c.real ? 'licence unknown' : 'synthetic')

export function fmtDuration(s?: number | null) {
  if (s == null || !isFinite(s)) return '–'
  const m = Math.floor(s / 60)
  const r = Math.round(s - m * 60)
  return m ? `${m}:${String(r).padStart(2, '0')}` : `${s.toFixed(s < 10 ? 1 : 0)} s`
}

/** Start a library clip. Live: POST /play on this session. Mock / replay: reopen the console live with ?clip. */
export async function startPlay(clip: LibraryClip, mode: PlayMode) {
  const st = useStore.getState()
  st.set({ sourceOpen: false })
  if (st.mode !== 'live' || !st.sessionId) {
    const q = new URLSearchParams({ clip: clip.id, mode })
    const asset = new URLSearchParams(location.search).get('asset')
    if (asset) q.set('asset', asset)
    location.assign(`/console?${q}`)
    return
  }
  const prev = st.localClip
  if (prev) URL.revokeObjectURL(prev.url)
  st.resetAnalysis()
  st.set({
    nowPlaying: { clip, mode, status: 'starting', nonce: Date.now() },
    videoSource: 'clip',
    mediaUrl: clip.url, // start loading the footage now; the media event confirms it
    localClip: null,
    assetName: clip.title,
  })
  st.pushConsole({
    kind: 'system',
    text: `Source · ${clip.title} · ${mode === 'analyse' ? 'analyse (full identification)' : 'live stream (camera engine)'} · ${clip.real ? `real footage, ${clip.credit ?? 'unknown author'}, ${licenseOf(clip)}` : 'synthetic, exact ground truth'}`,
  })
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(st.sessionId)}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clip_id: clip.id, mode }),
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const r = (await res.json()) as PlayResponse
    if (!r.ok) throw new Error(r.error ?? 'play refused')
    const np = useStore.getState().nowPlaying
    if (np && np.clip.id === clip.id && np.status === 'starting') useStore.getState().set({ nowPlaying: { ...np, status: 'playing' } })
  } catch (e) {
    const np = useStore.getState().nowPlaying
    if (np && np.clip.id === clip.id) useStore.getState().set({ nowPlaying: { ...np, status: 'error', error: (e as Error).message } })
    useStore.getState().pushConsole({ kind: 'error', text: `Could not start ${clip.title}: ${(e as Error).message}` })
  }
}

/** Recorded run of a library clip (Meta model output captured earlier): instant, no API key needed. */
export const recordedRunId = (clip: LibraryClip, runs: string[]) => {
  const id = `demo_real_${clip.id}`
  return runs.includes(id) ? id : null
}
export function openRecorded(runId: string) {
  useStore.getState().set({ sourceOpen: false })
  location.assign(`/console?replay=${encodeURIComponent(runId)}`)
}

export function replay() {
  const np = useStore.getState().nowPlaying
  if (np) void startPlay(np.clip, np.mode)
}

export function chooseWebcam() {
  const st = useStore.getState()
  st.set({ sourceOpen: false, videoSource: 'webcam', nowPlaying: null })
}

export function chooseSim() {
  useStore.getState().set({ sourceOpen: false, videoSource: 'sim', nowPlaying: null })
}

/** A clip from disk: played locally (blob URL) and uploaded for analysis. */
export async function chooseFile(f: File) {
  const st = useStore.getState()
  if (st.localClip) URL.revokeObjectURL(st.localClip.url)
  st.set({ sourceOpen: false, videoSource: 'clip', nowPlaying: null, localClip: { url: URL.createObjectURL(f), name: f.name } })
  try {
    const r = await link.uploadClip(f)
    if (r) useStore.getState().pushConsole({ kind: 'system', text: `Clip uploaded · ${r.width}×${r.height} @ ${r.fps.toFixed(0)} fps · ${r.duration_s.toFixed(1)} s` })
  } catch (e) {
    useStore.getState().pushConsole({ kind: 'error', text: `Clip upload failed: ${(e as Error).message}` })
  }
}

/* ───────── auto-start (real by default) ───────── */

function whenOpen(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    if (useStore.getState().conn === 'open') return resolve()
    const to = window.setTimeout(done, timeoutMs)
    const unsub = useStore.subscribe((s) => s.conn === 'open' && done())
    function done() {
      window.clearTimeout(to)
      unsub()
      resolve()
    }
  })
}

/**
 * Live console with a fresh session: play the featured real clip (or ?clip=<id>&mode=…) through
 * the real pipeline. Called by bootstrap once the session exists.
 */
export async function autoStart(q: URLSearchParams) {
  useStore.getState().set({ videoSource: 'clip' })
  const clips = await loadLibrary()
  if (!clips?.length) {
    useStore.getState().pushConsole({ kind: 'error', text: 'Footage library unavailable at /api/library. Choose a source: device camera or a clip from disk' })
    return
  }
  const want = q.get('clip')
  let clip = want ? clips.find((c) => c.id === want) : undefined
  if (want && !clip) useStore.getState().pushConsole({ kind: 'error', text: `Unknown clip “${want}”. Playing the featured clip instead` })
  clip ??= featuredClip(clips)!
  const m = q.get('mode')
  const mode: PlayMode = m === 'stream' ? 'stream' : 'analyse'
  // show the poster and the title right away, then wait for the socket so no early event is missed
  useStore.getState().set({ nowPlaying: { clip, mode, status: 'starting', nonce: Date.now() }, mediaUrl: clip.url })
  await whenOpen(5000)
  await startPlay(clip, mode)
}

/* ───────── end of an analyse run ─────────
 * `stream` ends with a coach "End of clip"; `analyse` has no end event, so the clip counts as
 * finished when telemetry has reached the end of the clip and then stopped for 2.5 s. */
let lastTel = 0
let lastClipT = -1
useStore.subscribe((s, p) => {
  if (s.telemetry !== p.telemetry && s.telemetry) {
    lastTel = performance.now()
    if (s.telemetry.clip_t != null) lastClipT = s.telemetry.clip_t
  }
  if (s.nowPlaying?.nonce !== p.nowPlaying?.nonce) lastClipT = -1
})
window.setInterval(() => {
  const s = useStore.getState()
  const np = s.nowPlaying
  if (!np || np.status !== 'playing' || np.mode !== 'analyse' || lastClipT < 0) return
  const dur = np.clip.duration_s ?? Infinity
  if (lastClipT >= dur - 1.2 && performance.now() - lastTel > 2500) s.set({ nowPlaying: { ...np, status: 'ended' } })
}, 1000)

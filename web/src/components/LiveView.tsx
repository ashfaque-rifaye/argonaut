import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Anchor, Camera, ChevronDown, ExternalLink, Film, FlaskConical, Layers, RotateCcw, ScanLine, Upload } from 'lucide-react'
import { useStore } from '../lib/store'
import { link } from '../lib/socket'
import { startAudioStreaming, startFrameStreaming } from '../lib/capture'
import { chooseFile, licenseOf, replay } from '../lib/library'
import { useSize } from '../lib/useSize'
import type { PipelineStage, SensorItem } from '../lib/protocol'
import { Btn, cx, Panel } from './ui'
import { useVideoDrop } from './SampleStrip'
import { StageWait } from './StageWait'

function shapeFor(f: number | null, items: SensorItem[]) {
  // amplitude/phase per sensor at the ODS frequency: modal shape if a mode matches, else spectral amplitude
  const s = useStore.getState()
  const out: Record<string, { amp: number; phase: number }> = {}
  if (f == null) return out
  const mode = s.modal?.modes.reduce<null | (typeof s.modal.modes)[number]>((best, m) => (Math.abs(m.f_hz - f) < 0.6 && (!best || Math.abs(m.f_hz - f) < Math.abs(best.f_hz - f)) ? m : best), null)
  if (mode) {
    for (const e of mode.shape) out[e.id] = { amp: e.amp, phase: (e.phase_deg * Math.PI) / 180 }
    return out
  }
  let mx = 1e-9
  const amps: Record<string, number> = {}
  for (const it of items) {
    const sp = s.spectra[it.id]
    if (!sp || it.is_reference) continue
    let best = 0
    sp.f_hz.forEach((x, i) => {
      if (Math.abs(x - f) < 0.6) best = Math.max(best, sp.amp[i])
    })
    amps[it.id] = best
    mx = Math.max(mx, best)
  }
  for (const id in amps) out[id] = { amp: amps[id] / mx, phase: 0 }
  return out
}

export function LiveView({ compact }: { compact?: boolean }) {
  const sensors = useStore((s) => s.sensors)
  const tel = useStore((s) => s.telemetry)
  const modal = useStore((s) => s.modal)
  const coach = useStore((s) => s.coach)
  const ods = useStore((s) => s.ods)
  const selected = useStore((s) => s.selectedChannel)
  const mode = useStore((s) => s.mode)
  const src = useStore((s) => s.videoSource)
  const set = useStore((s) => s.set)
  const mediaUrl = useStore((s) => s.mediaUrl)
  const np = useStore((s) => s.nowPlaying)
  const localClip = useStore((s) => s.localClip)
  const libraryState = useStore((s) => s.libraryState)
  const sourceOpen = useStore((s) => s.sourceOpen)
  const pipeline = useStore((s) => s.pipeline)

  const videoRef = useRef<HTMLVideoElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const drop = useVideoDrop()
  const [camErr, setCamErr] = useState<string | null>(null)
  const [box, size] = useSize<HTMLDivElement>()
  const polyRefs = useRef<Record<string, SVGPolygonElement | null>>({})
  const [prompts, setPrompts] = useState('')
  const [coachVisible, setCoachVisible] = useState(false)

  const W = sensors?.width ?? 960
  const H = sensors?.height ?? 540
  const k = size.w ? W / size.w : 2 // viewBox units per CSS px
  const items = sensors?.items ?? []
  // a new SAM result (different regions, or regions that moved) replays the mask stroke-draw
  const maskSig = useMemo(() => items.map((it) => `${it.id}:${it.bbox.map((v) => Math.round(v / 24)).join(',')}`).join('|'), [items])

  // webcam lifecycle
  useEffect(() => {
    if (src !== 'webcam') return
    let stream: MediaStream | null = null
    let stopFrames: (() => void) | null = null
    let stopAudio: (() => void) | null = null
    let cancelled = false
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' }, audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false } })
        if (cancelled) return stream.getTracks().forEach((t) => t.stop())
        const v = videoRef.current!
        v.srcObject = stream
        await v.play()
        setCamErr(null)
        stopFrames = startFrameStreaming(v)
        if (stream.getAudioTracks().length) stopAudio = await startAudioStreaming(stream)
      } catch (e) {
        setCamErr((e as Error).message || 'Camera unavailable')
      }
    })()
    return () => {
      cancelled = true
      stopFrames?.()
      stopAudio?.()
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [src])

  // what the clip <video> plays: a local file wins, else the server's media (library clip, upload, replay)
  const clipSrc = src === 'clip' ? localClip?.url ?? mediaUrl ?? null : null
  const streamMode = np?.mode === 'stream' && !localClip
  // analyse (and replays / uploads) follow the analysis position (telemetry.clip_t); stream just plays
  const synced = src === 'clip' && !streamMode
  // a library clip in analyse mode holds its first frame until the pipeline starts walking the clip
  const holdForSync = synced && !localClip && !!np
  const clipT = tel?.clip_t
  const lastSync = useRef(0)
  useEffect(() => {
    const v = videoRef.current
    if (!synced || clipT == null || !v || !v.duration) return
    lastSync.current = performance.now()
    const drift = v.currentTime - clipT
    if (Math.abs(drift) > 1.2) v.currentTime = Math.min(clipT, v.duration - 0.05)
    // small drift: nudge the playback rate instead of seeking, so the footage never stutters
    v.playbackRate = Math.abs(drift) > 1.2 ? 1 : Math.min(1.3, Math.max(0.7, 1 - drift * 0.6))
    if (v.paused && clipT < v.duration - 0.1) void v.play().catch(() => {})
  }, [clipT, synced])
  // the pipeline paused (model call) or finished walking the clip: hold the frame instead of running ahead
  useEffect(() => {
    if (!holdForSync) return
    const id = window.setInterval(() => {
      const v = videoRef.current
      if (v && !v.paused && performance.now() - lastSync.current > 1500) v.pause()
    }, 400)
    return () => window.clearInterval(id)
  }, [holdForSync])

  // coach toast visibility
  useEffect(() => {
    if (!coach) return
    setCoachVisible(true)
    const id = window.setTimeout(() => setCoachVisible(false), coach.level === 'ok' ? 4500 : 9000)
    return () => window.clearTimeout(id)
  }, [coach])

  // ODS animation: mutate polygon points directly (no React re-render per frame)
  useEffect(() => {
    if (!ods.on) {
      for (const it of items) polyRefs.current[it.id]?.setAttribute('points', it.polygon.map((p) => p.join(',')).join(' '))
      return
    }
    const shape = shapeFor(ods.f_hz, items)
    let raf = 0
    const t0 = performance.now()
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const frame = (now: number) => {
      const t = reduce ? 0.25 : (now - t0) / 1000
      const wv = 2 * Math.PI * 1.1
      for (const it of items) {
        const el = polyRefs.current[it.id]
        if (!el) continue
        const sh = shape[it.id]
        if (!sh || it.is_reference) continue
        const A = 11 * k * sh.amp
        const [, y1, , y2] = it.bbox
        const rock = /stand|column|pedestal|leg/i.test(it.label)
        const pts = it.polygon.map(([x, y]) => {
          const g = rock ? Math.max(0, Math.min(1, (y2 - y) / Math.max(1, y2 - y1))) : 1
          const d = A * g * Math.sin(wv * t + sh.phase)
          return `${(x + d).toFixed(1)},${(y + 0.22 * d).toFixed(1)}`
        })
        el.setAttribute('points', pts.join(' '))
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [ods.on, ods.f_hz, items, k])

  const odsOptions = useMemo(() => {
    const o: { f: number; label: string }[] = []
    if (tel && tel.speed_hz > 1) o.push({ f: +tel.speed_hz.toFixed(2), label: '1×' })
    for (const [i, m] of (modal?.modes ?? []).entries()) o.push({ f: m.f_hz, label: `M${i + 1}` })
    return o
  }, [tel && Math.round(tel.speed_hz * 4), modal]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleOds = () => {
    if (ods.on) set({ ods: { ...ods, on: false } })
    else set({ ods: { on: true, f_hz: ods.f_hz ?? odsOptions[odsOptions.length - 1]?.f ?? null } })
  }
  const ref = items.find((i) => i.is_reference)

  // label chips: try above / left / right / below each region; avoid other chips and other regions
  const chips = useMemo(() => {
    type R = [number, number, number, number]
    const hit = (a: R, b: R) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
    // keep chips clear of the HUD badges (top-left, top-right, bottom-left)
    const placed: R[] = [
      [0, 0, 175 * k, 26 * k],
      [W - 160 * k, 0, W, 26 * k],
      [0, H - 28 * k, 270 * k, H],
    ]
    const ch = 17 * k
    const g = 5 * k
    const order = [...items].sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]))
    const out = order.map((it) => {
      const tw = (it.label.length * 6.1 + `${Math.round(it.confidence * 100)}`.length * 6.4 + 26) * k
      const [x1, y1, x2, y2] = it.bbox
      const cy = (y1 + y2) / 2 - ch / 2
      const cands: [number, number][] = [
        [x1, y1 - ch - g],
        [x1 - tw - g, cy],
        [x2 + g, cy],
        [x1, y2 + g],
        [x1 + g, y1 + g],
      ]
      const others = items.filter((o) => o.id !== it.id && !o.is_reference).map((o) => o.bbox as R)
      const clampR = ([x, y]: [number, number]): R => {
        const cx = Math.min(Math.max(x, 2 * k), W - tw - 2 * k)
        const cy2 = Math.min(Math.max(y, 2 * k), H - ch - 2 * k)
        return [cx, cy2, cx + tw, cy2 + ch]
      }
      let best = clampR(cands[cands.length - 1])
      let bestScore = Infinity
      cands.forEach((c, i) => {
        const r = clampR(c)
        const score = placed.filter((p) => hit(p, r)).length * 10 + others.filter((o) => hit(o, r)).length * 3 + i * 0.5
        if (score < bestScore) {
          bestScore = score
          best = r
        }
      })
      placed.push(best)
      return { it, x: best[0], y: best[1], tw }
    })
    return out
  }, [items, k, W, H])

  const clip = src === 'clip' && !localClip ? np?.clip ?? null : null
  const meta =
    src === 'webcam'
      ? 'CAM 0 · device'
      : src === 'sim'
        ? 'CAM 0 · simulated'
        : clip
          ? `SOURCE · ${clip.title} · ${clip.real ? 'real footage' : 'synthetic · ground truth'} · ${licenseOf(clip)}${mode === 'replay' ? ' · recorded run' : ''}`
          : localClip
            ? `SOURCE · ${localClip.name} · from disk`
            : mediaUrl
              ? 'SOURCE · recorded clip'
              : mode === 'live' && libraryState !== 'error'
                ? 'SOURCE · loading library…'
                : 'no source'
  const ended = !!clip && np?.status === 'ended'
  // which model the footage is waiting on before the first analysed frame
  const waitStage: PipelineStage = (['sam', 'spark', 'dsp', 'wonder'] as PipelineStage[]).find((k) => pipeline[k].state === 'running') ?? 'sam'
  const waitingAnalyse = !!clip && np?.mode === 'analyse' && (np.status === 'starting' || np.status === 'playing') && clipT == null
  const waitingStream = !!clip && streamMode && np?.status !== 'ended' && np?.status !== 'error' && !tel
  const hudMode = src === 'webcam' ? 'CAM' : src === 'sim' ? 'SIM' : mode === 'replay' ? 'REPLAY' : streamMode ? 'STREAM' : np && !localClip ? 'ANALYSE' : 'CLIP'
  const openSource = () => set({ sourceOpen: true })

  const sendPrompts = () => {
    const p = prompts
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    if (!p.length) return
    link.send({ type: 'sensors.set', prompts: p })
    setPrompts('')
  }

  return (
    <Panel
      title="Live view"
      meta={<span title={meta}>{meta}</span>}
      right={
        <>
          <button
            type="button"
            onClick={openSource}
            aria-haspopup="dialog"
            aria-expanded={sourceOpen}
            aria-label="Choose source"
            title="Choose the source: real footage library, device camera or a clip from disk (S)"
            className="inline-flex h-6 items-center gap-1 rounded-md border border-line-2 bg-bg-2 pl-1.5 pr-1 text-[10.5px] font-semibold tracking-[0.06em] text-fg-2 transition-colors hover:bg-bg-3 hover:text-fg-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {src === 'webcam' ? <Camera size={11} /> : <Layers size={11} />}
            <ChevronDown size={11} className="text-fg-4" />
          </button>
          <button
            onClick={toggleOds}
            title="Operating deflection shape: exaggerated motion at a chosen frequency"
            className={cx(
              'ml-1 inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[10.5px] font-semibold tracking-[0.06em] transition-colors',
              ods.on ? 'border-accent/45 bg-[var(--accent-dim)] text-accent-2' : 'border-line-2 bg-bg-2 text-fg-3 hover:text-fg-1',
            )}
          >
            <Activity size={11} /> ODS
          </button>
          <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/*" className="hidden" onChange={(e) => e.target.files?.[0] && void chooseFile(e.target.files[0])} />
        </>
      }
      bodyClass="flex flex-col"
    >
      <div ref={box} {...drop.handlers} className={cx('scope-dark relative aspect-video w-full overflow-hidden bg-black', drop.over && 'ring-2 ring-inset ring-accent')}>
        {drop.over && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/60 text-[12px] font-semibold text-white">Drop the video to run it through the engine</div>
        )}
        {/* the simulated rig exists only in the simulator */}
        {src === 'sim' && mode === 'mock' && <img src="/mock/rig.svg" alt="Simulated camera view of fan F-101 on its stand" className="absolute inset-0 h-full w-full object-contain" draggable={false} />}
        {src === 'webcam' && <video key="cam" ref={videoRef} className="absolute inset-0 h-full w-full object-contain" autoPlay muted playsInline />}
        {src === 'clip' && clipSrc && (
          <video
            key={localClip ? localClip.url : `${clipSrc}#${np?.nonce ?? 0}`}
            ref={videoRef}
            src={clipSrc}
            poster={clip?.poster_url ?? undefined}
            className="absolute inset-0 h-full w-full object-contain"
            autoPlay={!holdForSync}
            loop={!!localClip}
            muted
            playsInline
            preload="auto"
            aria-label={clip ? `${clip.title}${clip.real ? ', real footage' : ', synthetic clip'}` : 'Analysed clip'}
          />
        )}
        {src === 'clip' && !clipSrc && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-0 text-center">
            <Film size={18} className="text-fg-4" />
            <div className="text-[12px] text-fg-2">{mode === 'replay' ? 'No footage recorded in this replay' : mode === 'live' && libraryState === 'loading' ? 'Loading footage library…' : 'No source selected'}</div>
            <Btn size="xs" variant="subtle" onClick={openSource}>
              <Layers size={11} /> Choose source
            </Btn>
          </div>
        )}
        {src === 'webcam' && camErr && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-1 text-center">
            <Camera size={18} className="text-fg-4" />
            <div className="text-[12px] text-fg-2">Camera unavailable</div>
            <div className="max-w-[260px] text-[11px] text-fg-4">{camErr}</div>
          </div>
        )}

        {/* vignette for legibility over any footage */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_45%,transparent_55%,color-mix(in_srgb,var(--color-shadow)_55%,transparent))]" />

        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
          {items.map((it, i) => {
            const sel = selected === it.id
            return (
              <g key={`${it.id}-${maskSig}`} className="cursor-pointer" onClick={() => !it.is_reference && set({ selectedChannel: it.id })}>
                {ods.on && !it.is_reference && (
                  <polygon points={it.polygon.map((p) => p.join(',')).join(' ')} fill="none" stroke={it.color} strokeOpacity={0.35} strokeWidth={1 * k} strokeDasharray={`${3 * k} ${3 * k}`} />
                )}
                <polygon
                  ref={(el) => {
                    polyRefs.current[it.id] = el
                  }}
                  points={it.polygon.map((p) => p.join(',')).join(' ')}
                  pathLength={it.is_reference ? undefined : 1}
                  className={it.is_reference ? 'chip-in' : 'mask-in'}
                  style={{ '--d': `${i * 110}ms` } as React.CSSProperties}
                  fill={it.color}
                  fillOpacity={it.is_reference ? 0.05 : sel ? 0.22 : 0.12}
                  stroke={it.color}
                  strokeOpacity={0.95}
                  strokeWidth={(sel ? 2 : 1.25) * k}
                  strokeDasharray={it.is_reference ? `${5 * k} ${4 * k}` : undefined}
                  strokeLinejoin="round"
                />
              </g>
            )
          })}
          {chips.map(({ it, x, y, tw }, i) => {
            const fs = 10.5 * k
            const label = it.label
            const conf = `${Math.round(it.confidence * 100)}`
            return (
              <g key={`l-${it.id}-${maskSig}`} transform={`translate(${x} ${y})`} pointerEvents="none">
                <g className="chip-in" style={{ '--d': `${300 + i * 110}ms` } as React.CSSProperties}>
                <rect width={tw} height={17 * k} rx={3 * k} fill="var(--color-bg-1)" fillOpacity={0.86} stroke="var(--color-line-2)" strokeWidth={k} />
                <rect x={6 * k} y={5.5 * k} width={6 * k} height={6 * k} rx={1.5 * k} fill={it.color} />
                <text x={17 * k} y={12 * k} fontSize={fs} fill="var(--color-fg-1)" fontFamily="Inter Variable, sans-serif" fontWeight={500}>
                  {label}
                  <tspan dx={5 * k} fill="var(--color-fg-3)" fontFamily="JetBrains Mono Variable, monospace" fontSize={fs * 0.92}>
                    {conf}
                  </tspan>
                </text>
                </g>
              </g>
            )
          })}
        </svg>

        {/* HUD */}
        <div className="num pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 rounded-[4px] bg-black/60 px-1.5 py-[3px] text-[10px] text-fg-2 backdrop-blur-sm">
          <span className={cx('h-1.5 w-1.5 rounded-full', ended ? 'bg-fg-3' : 'bg-alarm anim-pulse')} />
          <span className="font-semibold tracking-[0.08em] text-fg-1">{ended ? 'ENDED' : hudMode}</span>
          {W}×{H} · {tel?.clip_t != null ? `clip ${tel.clip_t.toFixed(1)}` : `t=${tel?.t != null ? tel.t.toFixed(1) : '0.0'}`} s
        </div>
        {items.length > 0 && (
          <div className="num pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 rounded-[4px] bg-black/60 px-1.5 py-[3px] text-[10px] text-fg-2 backdrop-blur-sm">
            <ScanLine size={11} className="text-accent" /> SAM 3.1 · {items.length} regions
          </div>
        )}
        {ref && (
          <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[48%] items-center gap-1.5 rounded-[4px] border border-line-2 bg-bg-1/85 px-1.5 py-[3px] text-[10px] text-fg-2">
            <Anchor size={11} className="text-fg-3" />
            <span className="font-semibold tracking-[0.06em] text-fg-1">REF</span>
            <span className="truncate">
              {ref.label} · static · shake-cancel on{mode === 'mock' ? ' · 0.41 mm/px' : ''}
            </span>
          </div>
        )}
        {ods.on && (
          <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-[5px] border border-accent/35 bg-bg-1/90 p-[3px] text-[10px]">
            <span className="px-1 font-semibold tracking-[0.06em] text-accent-2">ODS</span>
            {odsOptions.map((o) => (
              <button
                key={o.label}
                onClick={() => set({ ods: { on: true, f_hz: o.f } })}
                className={cx('num rounded-[3px] px-1.5 py-[2px] transition-colors', ods.f_hz != null && Math.abs(ods.f_hz - o.f) < 0.3 ? 'bg-accent text-on-accent' : 'text-fg-2 hover:bg-bg-3')}
              >
                {o.label} {o.f.toFixed(1)}
              </button>
            ))}
            <span className="num px-1 text-fg-4">exaggerated · slowed</span>
          </div>
        )}
        {/* waiting on the pipeline before the first analysed frame (the footage holds its first frame) */}
        {waitingAnalyse && (
          <div className="anim-in pointer-events-none absolute inset-x-0 bottom-9 flex justify-center px-3">
            <div className="flex max-w-full flex-col items-center gap-1.5 rounded-lg border border-line-2 bg-bg-1/85 px-3 py-2 text-center backdrop-blur-sm">
              <div className="text-[11px] text-fg-2">
                {mode === 'replay' ? 'Replaying recorded run ·' : np?.status === 'starting' ? 'Starting' : 'Analysing'} <span className="font-medium text-fg-1">{clip!.title}</span>
              </div>
              <StageWait stage={waitStage} />
            </div>
          </div>
        )}
        {waitingStream && (
          <div className="anim-in num pointer-events-none absolute left-1/2 top-9 -translate-x-1/2 whitespace-nowrap rounded-[5px] border border-line-2 bg-bg-1/85 px-2 py-1 text-[10.5px] text-fg-2 backdrop-blur-sm">
            Live camera engine warming up…
          </div>
        )}
        {ended && (
          <div className="anim-in absolute left-1/2 top-9 flex max-w-[94%] -translate-x-1/2 items-center gap-1.5 rounded-[6px] border border-line-2 bg-bg-1/90 py-[3px] pl-2 pr-[3px] text-[11px] text-fg-2 backdrop-blur-sm" role="status">
            <span className="whitespace-nowrap">End of clip · results kept</span>
            <button type="button" onClick={replay} className="inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-[4px] border border-line-2 bg-bg-2 px-1.5 text-[10.5px] font-medium text-fg-1 hover:bg-bg-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">
              <RotateCcw size={10} /> Play again
            </button>
            <button type="button" onClick={openSource} className="inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-[4px] px-1.5 text-[10.5px] font-medium text-fg-2 hover:bg-bg-3 hover:text-fg-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">
              <Layers size={10} /> Choose source
            </button>
          </div>
        )}
        {np?.status === 'error' && clip && (
          <div className="anim-in absolute left-1/2 top-9 flex max-w-[94%] -translate-x-1/2 items-center gap-1.5 rounded-[6px] border border-alarm/50 bg-alarm-bg/90 py-[3px] pl-2 pr-[3px] text-[11px] text-alarm-2" role="alert">
            <span className="truncate">Could not start: {np.error}</span>
            <button type="button" onClick={replay} className="inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-[4px] border border-alarm/40 px-1.5 text-[10.5px] font-medium hover:bg-alarm/10">
              <RotateCcw size={10} /> Retry
            </button>
          </div>
        )}
        {/* attribution: CC BY requires author, licence and a link to the source while the footage is shown */}
        {clip && (
          <div className={cx('absolute right-2 flex max-w-[50%] justify-end', ods.on ? 'bottom-10' : 'bottom-2')}>
            {clip.real ? (
              <a
                href={clip.source_url ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                title={`Footage: ${clip.credit ?? 'unknown'} · ${licenseOf(clip)}${clip.source_url ? ` · ${clip.source_url}` : ''}`}
                className="flex min-w-0 items-center gap-1 rounded-[4px] bg-black/60 px-1.5 py-[3px] text-[9.5px] text-fg-2 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-fg-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                <span className="truncate">
                  Footage: {clip.credit ?? 'unknown'} · <span className="num">{licenseOf(clip)}</span>
                </span>
                {clip.source_url && <ExternalLink size={9} className="shrink-0 opacity-70" aria-hidden />}
              </a>
            ) : (
              <span className="pointer-events-none flex items-center gap-1 rounded-[4px] bg-black/60 px-1.5 py-[3px] text-[9.5px] text-fg-3 backdrop-blur-sm">
                <FlaskConical size={9} /> synthetic · ground truth
              </span>
            )}
          </div>
        )}
        {coach && coachVisible && !(ended && /^end of clip/i.test(coach.text)) && (
          <div
            className={cx(
              'anim-in absolute left-1/2 top-9 max-w-[86%] -translate-x-1/2 rounded-[5px] border px-2 py-1 text-[11px] font-medium backdrop-blur-sm',
              coach.level === 'block' ? 'border-alarm/50 bg-alarm-bg/90 text-alarm-2' : coach.level === 'warn' ? 'border-warn/45 bg-warn-bg/90 text-warn-2' : 'border-line-2 bg-bg-1/85 text-fg-1',
            )}
          >
            <span className="mr-1.5 text-[9.5px] font-semibold tracking-[0.1em] opacity-70">COACH</span>
            {coach.text}
          </div>
        )}
      </div>

      {!compact && (
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-t border-line-1 px-2">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {items.slice(0, 6).map((it) => (
              <span key={it.id} className="hidden h-[18px] shrink-0 items-center gap-1 rounded-[4px] border border-line-1 px-1.5 text-[10px] text-fg-3 2xl:inline-flex">
                <span className="h-1.5 w-1.5 rounded-[1px]" style={{ background: it.color }} />
                {it.id}
              </span>
            ))}
            <input
              value={prompts}
              onChange={(e) => setPrompts(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendPrompts()}
              placeholder="Place sensors by name: bearing housing, baseplate, wall"
              className="h-6 min-w-0 flex-1 rounded-[5px] border border-line-1 bg-bg-0 px-2 text-[11px] text-fg-1 placeholder:text-fg-4 focus:border-accent/50 focus:outline-none"
            />
          </div>
          <Btn size="xs" variant="subtle" onClick={sendPrompts} title="Send sensors.set to SAM 3.1">
            <ScanLine size={11} /> Place
          </Btn>
          <Btn size="xs" variant="subtle" onClick={() => fileRef.current?.click()} title="Analyse your own video (mp4/mov), or drop it on the view" aria-label="Upload a video to analyse">
            <Upload size={11} /> Upload
          </Btn>
        </div>
      )}
    </Panel>
  )
}

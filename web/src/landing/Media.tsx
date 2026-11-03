import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTheme, type Theme } from '../lib/theme'
import { cx } from '../components/ui'

/*
 * <Media name="sense" />: a themed, lazy, failure-proof media layer.
 *
 * Sources come from /media/manifest.json: { dark: { sense: ["sense.mp4", "sense.webp"] }, light: {…} }.
 * Each candidate is HEAD-probed once (content-type must be image/* or video/*, so an SPA fallback page
 * never counts as media). The first real file wins: a video plays muted and looped, an image fades in.
 * If the theme has nothing, the other theme's asset is used; if neither exists, `fallback` stays.
 * Under prefers-reduced-motion a video is replaced by its still (the `.webp` sibling or `<name>-poster`).
 */

type Manifest = Partial<Record<Theme, Record<string, string | string[]>>>
type Found = { url: string; kind: 'video' | 'image' }

let manifestP: Promise<Manifest> | null = null
const loadManifest = () =>
  (manifestP ??= fetch('/media/manifest.json', { cache: 'no-cache' })
    .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() : {}))
    .catch(() => ({}))) as Promise<Manifest>

const probes = new Map<string, Promise<Found | null>>()
function probe(url: string): Promise<Found | null> {
  let p = probes.get(url)
  if (!p) {
    p = fetch(url, { method: 'HEAD' })
      .then((r) => {
        const ct = (r.headers.get('content-type') ?? '').toLowerCase()
        if (!r.ok) return null
        if (ct.startsWith('video/')) return { url, kind: 'video' as const }
        if (ct.startsWith('image/')) return { url, kind: 'image' as const }
        return null
      })
      .catch(() => null)
    probes.set(url, p)
  }
  return p
}

const list = (v: string | string[] | undefined) => (v == null ? [] : Array.isArray(v) ? v : [v])

async function resolve(name: string, theme: Theme, stillOnly: boolean, crossTheme: boolean): Promise<Found | null> {
  const m = await loadManifest()
  for (const t of (crossTheme ? [theme, theme === 'dark' ? 'light' : 'dark'] : [theme]) as Theme[]) {
    const names = [...list(m[t]?.[name]), ...(stillOnly ? list(m[t]?.[`${name}-poster`]) : [])]
    for (const f of names) {
      if (stillOnly && /\.(mp4|webm|mov)$/i.test(f)) continue
      const hit = await probe(`/media/${t}/${f}`)
      if (hit) return hit
    }
  }
  return null
}

/** Resolve (and cache) the best URL for a named asset in the current theme. */
export function useMediaSource(name: string, opts: { enabled?: boolean; stillOnly?: boolean; crossTheme?: boolean } = {}) {
  const theme = useTheme()
  const { enabled = true, stillOnly = false, crossTheme = true } = opts
  const [found, setFound] = useState<Found | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    setFound(null)
    void resolve(name, theme, stillOnly, crossTheme).then((f) => live && setFound(f))
    return () => {
      live = false
    }
  }, [name, theme, enabled, stillOnly, crossTheme])
  return found
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function Media({
  name,
  alt = '',
  className,
  mediaClass,
  fallback,
  eager,
  onReady,
  crossTheme = true,
  loopFade = 0,
}: {
  name: string
  alt?: string
  className?: string
  /** classes for the <img>/<video> element itself (e.g. hover zoom) */
  mediaClass?: string
  /** shown until (or instead of) the asset */
  fallback?: ReactNode
  /** start loading immediately instead of when near the viewport */
  eager?: boolean
  onReady?: (kind: 'video' | 'image') => void
  /** fall back to the other theme's asset when this theme has none (off for the hero) */
  crossTheme?: boolean
  /** seconds of crossfade at the loop point (two decoders; hides the seam of a non-looping clip) */
  loopFade?: number
}) {
  const box = useRef<HTMLDivElement>(null)
  const vid = useRef<HTMLVideoElement>(null)
  const [near, setNear] = useState(!!eager)
  const [readyKey, setReadyKey] = useState<string | null>(null)
  const reduce = reducedMotion()
  const src = useMediaSource(name, { enabled: near, stillOnly: reduce, crossTheme })
  const key = src?.url
  const ready = !!key && readyKey === key

  // lazy: start resolving ~1 viewport before the card is visible
  useEffect(() => {
    if (near) return
    const el = box.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { rootMargin: '100% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [near])

  // videos only play while on screen
  useEffect(() => {
    const v = vid.current
    const el = box.current
    if (!v || !el || src?.kind !== 'video' || loopFade) return
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) void v.play().catch(() => {})
      else v.pause()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [key, src?.kind, loopFade])

  const done = () => {
    setReadyKey(key ?? null)
    if (src) onReady?.(src.kind)
  }

  return (
    <div ref={box} className={cx('absolute inset-0 overflow-hidden', className)} aria-hidden={alt ? undefined : true}>
      <div className={cx('absolute inset-0 transition-opacity duration-700', ready ? 'opacity-0' : 'opacity-100')}>{fallback}</div>
      {src?.kind === 'image' && (
        <img
          key={key}
          src={src.url}
          alt={alt}
          loading="eager" /* our own IntersectionObserver already defers it; native lazy would stall after fast scrolls */
          decoding="async"
          draggable={false}
          onLoad={done}
          onError={() => setReadyKey(null)}
          className={cx('absolute inset-0 h-full w-full object-cover transition-[opacity,transform] duration-700 ease-[var(--ease-out-expo)]', ready ? 'opacity-100' : 'opacity-0', mediaClass)}
        />
      )}
      {src?.kind === 'video' && loopFade > 0 && (
        <CrossfadeLoop
          key={key}
          url={src.url}
          fade={loopFade}
          onReady={done}
          onError={() => setReadyKey(null)}
          className={cx('absolute inset-0 transition-[opacity,transform] duration-700 ease-[var(--ease-out-expo)]', ready ? 'opacity-100' : 'opacity-0', mediaClass)}
        />
      )}
      {src?.kind === 'video' && !loopFade && (
        <video
          key={key}
          ref={vid}
          src={src.url}
          muted
          loop
          playsInline
          autoPlay
          preload="metadata"
          onLoadedData={done}
          onError={() => setReadyKey(null)}
          className={cx('absolute inset-0 h-full w-full object-cover transition-[opacity,transform] duration-700 ease-[var(--ease-out-expo)]', ready ? 'opacity-100' : 'opacity-0', mediaClass)}
        />
      )}
    </div>
  )
}

/**
 * Seamless loop for a clip that does not loop by itself: two <video> decoders on the same file.
 * `fade` seconds before the end, the idle one restarts underneath and the active one fades out on
 * top, so there is never a dip to the background. Plays only while on screen. No React state per
 * frame: one rAF checks the clock and styles are written directly.
 */
function CrossfadeLoop({ url, fade, onReady, onError, className }: { url: string; fade: number; onReady: () => void; onError: () => void; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const va = useRef<HTMLVideoElement>(null)
  const vb = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const vs = [va.current!, vb.current!]
    const el = box.current!
    let cur = 0
    let fading = false
    let raf = 0
    let timer = 0
    let onScreen = true
    vs.forEach((v, i) => {
      v.style.transition = 'none'
      v.style.opacity = i === 0 ? '1' : '0'
      v.style.zIndex = i === 0 ? '1' : '0'
    })
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const v = vs[cur]
      const d = v.duration
      if (fading || !onScreen || !d || !isFinite(d) || d < fade * 2) return
      if (v.currentTime < d - fade) return
      fading = true
      const n = vs[1 - cur]
      n.currentTime = 0
      n.style.transition = 'none'
      n.style.zIndex = '0'
      n.style.opacity = '1'
      void n.play().catch(() => {})
      v.style.zIndex = '1'
      v.style.transition = `opacity ${fade}s linear`
      v.style.opacity = '0'
      timer = window.setTimeout(() => {
        v.pause()
        cur = 1 - cur
        fading = false
      }, fade * 1000 + 60)
    }
    raf = requestAnimationFrame(tick)
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting
      if (onScreen) void vs[cur].play().catch(() => {})
      else vs.forEach((v) => v.pause())
    })
    io.observe(el)
    void vs[0].play().catch(() => {})
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      io.disconnect()
    }
  }, [url, fade])
  return (
    <div ref={box} className={className}>
      <video ref={va} src={url} muted playsInline autoPlay preload="auto" onLoadedData={onReady} onError={onError} className="absolute inset-0 h-full w-full object-cover" />
      <video ref={vb} src={url} muted playsInline preload="auto" className="absolute inset-0 h-full w-full object-cover" />
    </div>
  )
}

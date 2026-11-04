import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import type { TelemetryEvent, TracksEvent } from '../lib/protocol'

const CHIP_H = 30

/** "1.84 rel · 12.3 Hz": what the virtual sensor on this part is reading right now */
export function sensorParams(tel: TelemetryEvent | null, id: string): string | null {
  const c = tel?.channels.find((x) => x.id === id)
  if (!c) return null
  const v = `${c.vel_mm_s_rms.toFixed(2)} ${tel!.calibrated ? 'mm/s' : 'rel'}`
  return c.peak_hz != null ? `${v} · ${c.peak_hz.toFixed(1)} Hz` : v
}

/**
 * Parts tracked through a moving camera. Each animation frame reads the video's own clock, so outlines and
 * labels stay on the part whatever the footage does; a part that has left the picture has no outline.
 */
export function TrackedOverlay({ tracks, video, k, tel, selected, onSelect }: { tracks: TracksEvent; video: RefObject<HTMLVideoElement | null>; k: number; tel: TelemetryEvent | null; selected: string | null; onSelect: (id: string) => void }) {
  const polys = useRef<Record<string, SVGPolygonElement | null>>({})
  const chips = useRef<Record<string, SVGGElement | null>>({})
  const pos = useRef<Record<string, [number, number]>>({})
  const cuts = useMemo(() => new Set(tracks.shots.map((t) => Math.round(t * tracks.fps))), [tracks])
  const lines = tracks.items.map((it) => ({ it, params: sensorParams(tel, it.id), what: selected === it.id ? it.what : '' }))
  const widths = useRef<Record<string, number>>({})
  for (const l of lines) {
    const chars = Math.max(l.it.label.length + 5, (l.params ?? '').length * 1.05, l.what.length * 0.95)
    widths.current[l.it.id] = (chars * 6.1 + 24) * k
  }

  useEffect(() => {
    let raf = 0
    const { width: W, height: H, fps, n } = tracks
    type R = [number, number, number, number]
    const hit = (a: R, b: R) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
    const frame = () => {
      const t = video.current?.currentTime ?? 0
      const fi = Math.min(n - 1, t * fps)
      const i0 = Math.floor(fi)
      const i1 = Math.min(n - 1, i0 + 1)
      const a = cuts.has(i1) ? 0 : fi - i0
      // keep labels clear of the HUD badges (top-left, top-right)
      const placed: R[] = [
        [0, 0, 190 * k, 26 * k],
        [W - 230 * k, 0, W, 26 * k],
      ]
      for (const it of tracks.items) {
        const el = polys.current[it.id]
        const chip = chips.current[it.id]
        if (!el || !chip) continue
        const p0 = it.polys[i0]
        if (!p0) {
          el.style.display = 'none'
          chip.style.display = 'none'
          delete pos.current[it.id]
          continue
        }
        const p1 = it.polys[i1] ?? p0
        let x1 = Infinity
        let y1 = Infinity
        let x2 = -Infinity
        let y2 = -Infinity
        let d = ''
        let sumX = 0
        let sumY = 0
        for (let j = 0; j < p0.length; j++) {
          const x = p0[j][0] + (p1[j][0] - p0[j][0]) * a
          const y = p0[j][1] + (p1[j][1] - p0[j][1]) * a
          x1 = Math.min(x1, x)
          x2 = Math.max(x2, x)
          y1 = Math.min(y1, y)
          y2 = Math.max(y2, y)
          sumX += x
          sumY += y
          d += `${x.toFixed(1)},${y.toFixed(1)} `
        }
        el.setAttribute('points', d)
        el.style.display = ''
        chip.style.display = ''
        const tw = widths.current[it.id] ?? 120 * k
        const ch = (it.id === selected && it.what ? CHIP_H + 13 : CHIP_H) * k
        const g = 4 * k
        const clamp = (x: number, y: number): R => {
          const cx = Math.min(Math.max(x, 2 * k), W - tw - 2 * k)
          const cy = Math.min(Math.max(y, 2 * k), H - ch - 2 * k)
          return [cx, cy, cx + tw, cy + ch]
        }
        // on the part itself, nudged up or down only to clear another label
        const cx = sumX / p0.length - tw / 2
        const cy = sumY / p0.length - ch / 2
        const cands = [clamp(cx, cy), clamp(cx, cy - ch - g), clamp(cx, cy + ch + g), clamp(cx, cy - 2 * (ch + g)), clamp(cx, cy + 2 * (ch + g))]
        const best = cands.find((c) => !placed.some((p) => hit(p, c))) ?? cands[cands.length - 1]
        placed.push(best)
        // labels glide rather than jump when they have to change side
        const prev = pos.current[it.id]
        const next: [number, number] = prev ? [prev[0] + (best[0] - prev[0]) * 0.2, prev[1] + (best[1] - prev[1]) * 0.2] : [best[0], best[1]]
        pos.current[it.id] = next
        chip.setAttribute('transform', `translate(${next[0].toFixed(1)} ${next[1].toFixed(1)})`)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [tracks, video, k, cuts, selected])

  const fs = 10.5 * k
  return (
    <svg viewBox={`0 0 ${tracks.width} ${tracks.height}`} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
      {lines.map(({ it }) => {
        const sel = selected === it.id
        return (
          <polygon
            key={it.id}
            ref={(el) => {
              polys.current[it.id] = el
            }}
            style={{ display: 'none' }}
            className="cursor-pointer"
            onClick={() => onSelect(it.id)}
            fill={it.color}
            fillOpacity={sel ? 0.24 : 0.08}
            stroke={it.color}
            strokeOpacity={0.95}
            strokeWidth={(sel ? 2.4 : 1.25) * k}
            strokeLinejoin="round"
          />
        )
      })}
      {lines.map(({ it, params, what }) => (
        <g
          key={`c-${it.id}`}
          ref={(el) => {
            chips.current[it.id] = el
          }}
          style={{ display: 'none' }}
          pointerEvents="none"
        >
          <rect width={widths.current[it.id]} height={(what ? CHIP_H + 13 : CHIP_H) * k} rx={4 * k} fill="var(--color-bg-1)" fillOpacity={0.88} stroke={selected === it.id ? it.color : 'var(--color-line-2)'} strokeWidth={k} />
          <rect x={6 * k} y={5.5 * k} width={6 * k} height={6 * k} rx={1.5 * k} fill={it.color} />
          <text x={17 * k} y={12 * k} fontSize={fs} fill="var(--color-fg-1)" fontFamily="Inter Variable, sans-serif" fontWeight={500}>
            {it.label}
            <tspan dx={5 * k} fill="var(--color-fg-3)" fontFamily="JetBrains Mono Variable, monospace" fontSize={fs * 0.92}>
              {Math.round(it.confidence * 100)}
            </tspan>
          </text>
          {what && (
            <text x={6 * k} y={25 * k} fontSize={fs * 0.92} fill="var(--color-fg-2)" fontFamily="Inter Variable, sans-serif">
              {what}
            </text>
          )}
          <text x={6 * k} y={(what ? 38 : 25) * k} fontSize={fs * 0.92} fill="var(--color-accent-2)" fontFamily="JetBrains Mono Variable, monospace">
            {params ?? 'measuring…'}
          </text>
        </g>
      ))}
    </svg>
  )
}

import { ISO_BOUNDS } from '../lib/format'

// Piecewise scale: each ISO 20816 zone gets equal width (severity charts are logarithmic in spirit).
const EDGES = [0, ISO_BOUNDS.AB, ISO_BOUNDS.BC, ISO_BOUNDS.CD, ISO_BOUNDS.max]
export function isoPos(v: number) {
  for (let i = 0; i < 4; i++) {
    if (v <= EDGES[i + 1]) return (i + (v - EDGES[i]) / (EDGES[i + 1] - EDGES[i])) / 4
  }
  return 1
}

const ZONES = [
  { z: 'A', fill: 'var(--color-iso-a)' },
  { z: 'B', fill: 'var(--color-iso-b)' },
  { z: 'C', fill: 'var(--color-iso-c)' },
  { z: 'D', fill: 'var(--color-iso-d)' },
]

export function IsoBar({
  value,
  marker,
  height = 10,
  labels = true,
  ci,
}: {
  value: number | null
  marker?: number | null
  height?: number
  labels?: boolean
  /** v2 · 90% confidence interval drawn as a bracket span on the bar */
  ci?: [number, number] | null
}) {
  const p = value == null ? null : isoPos(value)
  const zoneIdx = p == null ? -1 : Math.min(3, Math.floor(p * 4))
  const ptrColor = zoneIdx === 3 ? 'var(--color-alarm)' : zoneIdx === 2 ? 'var(--color-warn)' : 'var(--color-fg-1)'
  return (
    <div className="relative w-full select-none" style={{ paddingTop: 7 }}>
      <div className="relative flex w-full overflow-hidden rounded-[3px] shadow-[inset_0_0_0_1px_var(--color-line-2)]" style={{ height }}>
        {ZONES.map((z, i) => (
          <div key={z.z} className="relative h-full flex-1" style={{ background: z.fill, borderLeft: i ? '1px solid var(--color-bg-0)' : undefined }}>
            {labels && <span className="num absolute inset-0 flex items-center justify-center text-[8.5px] font-semibold text-fg-3">{z.z}</span>}
          </div>
        ))}
        {/* normal operating band (A–B) indicator */}
        <div className="pointer-events-none absolute bottom-0 left-0 h-[2px] w-1/2 bg-fg-4" />
      </div>
      {ci && value != null && (
        <div
          className="pointer-events-none absolute border-x border-fg-1/75 bg-fg-1/16 transition-[left,width] duration-100 ease-linear"
          style={{ top: 7, height, left: `${isoPos(ci[0]) * 100}%`, width: `${Math.max(0.3, (isoPos(ci[1]) - isoPos(ci[0])) * 100)}%` }}
          title={`90% CI ${ci[0].toFixed(2)}–${ci[1].toFixed(2)} mm/s`}
        />
      )}
      {marker != null && (
        <div className="absolute top-[5px] h-[calc(100%-3px)] w-0 border-l border-dashed border-accent" style={{ left: `${isoPos(marker) * 100}%` }} title={`Proposed ${marker.toFixed(1)} mm/s`} />
      )}
      {p != null && (
        <div className="absolute top-0 transition-[left] duration-100 ease-linear" style={{ left: `${p * 100}%` }}>
          <svg width="10" height="7" viewBox="0 0 10 7" className="-translate-x-1/2" style={{ display: 'block' }}>
            <path d="M0 0 H10 L5 7 Z" fill={ptrColor} />
          </svg>
          <div className="-translate-x-1/2" style={{ width: 2, height, background: ptrColor, marginLeft: 0, boxShadow: '0 0 0 1px var(--color-bg-0)' }} />
        </div>
      )}
      {labels && (
        <div className="num relative mt-1 h-3 text-[9px] text-fg-4">
          {[ISO_BOUNDS.AB, ISO_BOUNDS.BC, ISO_BOUNDS.CD].map((b, i) => (
            <span key={b} className="absolute -translate-x-1/2" style={{ left: `${((i + 1) / 4) * 100}%` }}>
              {b}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

import { useStore } from '../lib/store'
import { useSize } from '../lib/useSize'
import type { DealiasEvent, DealiasPeak } from '../lib/protocol'
import { Empty } from './ui'

/**
 * The folding diagram. x = true frequency, y = what the camera sees. Sampling at fs folds every
 * true frequency onto the triangle wave, so a camera peak at f_alias could be any of the hollow
 * candidates n·fs ± f_alias. The mic tachometer's order lines (k × speed) pick exactly one: that is
 * the de-aliased peak.
 */
export function DealiasView({ channel }: { channel: string | null }) {
  const d = useStore((s) => (channel && s.dealias[channel]) || Object.values(s.dealias)[0]) as DealiasEvent | undefined
  const band = useStore((s) => s.telemetry?.band)
  const [box, size] = useSize<HTMLDivElement>()

  if (!d || !d.peaks.length)
    return (
      <Empty
        title="No de-aliased peaks yet"
        hint={`A ${d?.fs_video ?? 30} fps camera sees directly only up to ${band?.direct_hz?.toFixed(1) ?? '14.9'} Hz. Higher orders fold below Nyquist and are recovered once the mic tachometer has a lock.`}
      />
    )

  const fs = d.fs_video
  const ny = fs / 2
  const peaks = [...d.peaks].sort((a, b) => a.f_true_hz - b.f_true_hz)
  const primary = peaks.find((p) => p.order === 1) ?? [...peaks].sort((a, b) => b.confidence - a.confidence)[0]
  const maxTrue = Math.max(...peaks.map((p) => p.f_true_hz))
  const xMax = Math.max(2 * fs, Math.ceil((maxTrue * 1.08) / ny) * ny)
  const lock = !band || band.dealiased_hz > band.direct_hz + 0.05

  const W = size.w
  const H = size.h
  const M = { l: 50, r: 14, t: 22, b: 26 }
  const pw = Math.max(10, W - M.l - M.r)
  const ph = Math.max(10, H - M.t - M.b)
  const X = (f: number) => M.l + (f / xMax) * pw
  const Y = (fa: number) => M.t + ph - (fa / ny) * ph

  const nSeg = Math.ceil(xMax / ny)
  const tri = Array.from({ length: nSeg + 1 }, (_, k) => `${k ? 'L' : 'M'}${X(Math.min(k * ny, xMax)).toFixed(1)},${Y(k % 2 ? ny : 0).toFixed(1)}`).join('')
  const orders: number[] = []
  for (let k = 1; k * d.speed_hz_audio <= xMax && k <= 12; k++) orders.push(k)

  const candidates = (p: DealiasPeak) => {
    const out: number[] = []
    for (let n = 0; n * fs - p.f_alias_hz <= xMax; n++) {
      for (const x of n === 0 ? [p.f_alias_hz] : [n * fs - p.f_alias_hz, n * fs + p.f_alias_hz]) if (x >= 0 && x <= xMax && Math.abs(x - p.f_true_hz) > 0.4) out.push(x)
    }
    return out
  }

  // annotation boxes with simple collision avoidance
  const boxes: { x: number; y: number; w: number; h: number; p: DealiasPeak; text: string }[] = []
  for (const p of [...peaks].sort((a, b) => b.f_alias_hz - a.f_alias_hz)) {
    const text = `${p.order}× · fold ${p.fold} · ±${p.residual_hz.toFixed(2)} Hz · ${(p.confidence * 100).toFixed(0)}%`
    const w = text.length * 5.75 + 12
    const h = 16
    const px = X(p.f_true_hz)
    const py = Y(p.f_alias_hz)
    let x = px + 8
    if (x + w > M.l + pw) x = px - 8 - w
    let y = py - h - 6
    if (y < M.t + 2) y = py + 6
    for (const b of boxes) if (x < b.x + b.w && x + w > b.x && y < b.y + b.h + 2 && y + h + 2 > b.y) y = b.y + b.h + 3
    boxes.push({ x, y, w, h, p, text })
  }
  const yLabels: { y: number; v: number }[] = []
  for (const p of [...peaks].sort((a, b) => b.f_alias_hz - a.f_alias_hz)) {
    let y = Y(p.f_alias_hz) + 3.5
    for (const l of yLabels) if (Math.abs(l.y - y) < 11) y = l.y + 11
    yLabels.push({ y, v: p.f_alias_hz })
  }
  const trueX = peaks.map((p) => X(p.f_true_hz))

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-3 pt-2">
        <div className="flex items-baseline gap-2 text-[12.5px] text-fg-2">
          <span>
            Camera sees <span className="num text-fg-1">{primary.f_alias_hz.toFixed(2)} Hz</span>
            <span className="mx-1.5 text-fg-4">→</span>
            true <span className="num font-medium text-accent-2">{primary.f_true_hz.toFixed(2)} Hz</span>
            <span className="num text-fg-1"> ({primary.order}×)</span> from mic tachometer
            <span className="num text-fg-3"> · {d.speed_hz_audio.toFixed(2)} Hz</span>
          </span>
          <span className="num ml-auto hidden shrink-0 text-[10.5px] text-fg-4 lg:inline">
            {d.channel} · {peaks.length} recovered · fs {fs} fps
          </span>
        </div>
        <div className="mt-0.5 truncate text-[10.5px] text-fg-3" title="f_true = n·fs ± f_alias; a peak is assigned only if exactly one order k·speed explains it within the residual">
          {lock ? '' : 'Tachometer lock lost · last result shown. '}
          Nyquist {ny.toFixed(1)} Hz: every true frequency on the fold line reads the same to the camera (○ candidates n·fs ± f). The order line k × speed picks exactly one (◆).
        </div>
      </div>
      <div ref={box} className="relative min-h-0 flex-1">
        {W > 0 && H > 0 && (
          <svg width={W} height={H} className="absolute inset-0 block">
            <defs>
              <clipPath id="da-clip">
                <rect x={M.l} y={M.t} width={pw} height={ph} />
              </clipPath>
            </defs>
            {/* fold zones */}
            <rect x={X(0)} y={M.t} width={X(ny) - X(0)} height={ph} fill="color-mix(in srgb, var(--color-fg-1) 3.5%, transparent)" />
            {Array.from({ length: Math.ceil(xMax / fs) }, (_, i) => i + 1).map((n) => {
              const a = Math.max(0, (n - 0.5) * fs)
              const b = Math.min(xMax, (n + 0.5) * fs)
              return (
                <g key={n}>
                  {n % 2 === 0 && <rect x={X(a)} y={M.t} width={X(b) - X(a)} height={ph} fill="color-mix(in srgb, var(--color-fg-1) 1.8%, transparent)" />}
                  <line x1={X(a)} x2={X(a)} y1={M.t} y2={M.t + ph} stroke="var(--color-line-1)" />
                  {X(b) - X(a) > 40 && (
                    <text x={(X(a) + X(b)) / 2} y={M.t + ph - 5} textAnchor="middle" fontSize={9} fill="var(--color-fg-4)" className="num">
                      fold {n}
                    </text>
                  )}
                </g>
              )
            })}
            <text x={(X(0) + X(ny)) / 2} y={M.t + ph - 5} textAnchor="middle" fontSize={9} fill="var(--color-fg-3)" className="num">
              direct
            </text>
            {/* axes */}
            <line x1={M.l} x2={M.l + pw} y1={M.t + ph + 0.5} y2={M.t + ph + 0.5} stroke="var(--color-line-2)" />
            <line x1={M.l - 0.5} x2={M.l - 0.5} y1={M.t} y2={M.t + ph} stroke="var(--color-line-2)" />
            <line x1={M.l} x2={M.l + pw} y1={M.t + 0.5} y2={M.t + 0.5} stroke="var(--color-line-1)" strokeDasharray="2 3" />
            {!yLabels.some((l) => Math.abs(l.y - (M.t + 3.5)) < 11) && (
              <text x={M.l - 6} y={M.t + 3.5} textAnchor="end" fontSize={9} fill="var(--color-fg-4)" className="num">
                {ny.toFixed(0)}
              </text>
            )}
            <text x={M.l - 6} y={M.t + ph + 3.5} textAnchor="end" fontSize={9} fill="var(--color-fg-4)" className="num">
              0
            </text>
            <text x={M.l - 6} y={M.t - 9} textAnchor="end" fontSize={8.5} fill="var(--color-fg-3)" className="num">
              seen Hz
            </text>
            {Array.from({ length: nSeg }, (_, k) => (k + 1) * ny)
              .filter((v) => v <= xMax + 1e-6)
              .map((v) => {
                const near = trueX.some((tx) => Math.abs(tx - X(v)) < 40)
                const isFs = Math.abs(v / fs - Math.round(v / fs)) < 1e-6
                return (
                  <g key={v}>
                    <line x1={X(v)} x2={X(v)} y1={M.t + ph} y2={M.t + ph + 3} stroke="var(--color-line-2)" />
                    {!near && (
                      <text x={X(v)} y={M.t + ph + 13} textAnchor="middle" fontSize={9} fill="var(--color-fg-4)" className="num">
                        {isFs ? `${Math.round(v / fs) === 1 ? '' : Math.round(v / fs)}fs ${v}` : v}
                      </text>
                    )}
                  </g>
                )
              })}
            <text x={M.l + pw} y={M.t + ph + 23} textAnchor="end" fontSize={8.5} fill="var(--color-fg-3)" className="num">
              true frequency · Hz
            </text>

            <g clipPath="url(#da-clip)">
              {/* order lines from the mic tachometer */}
              {orders.map((k) => (
                <line key={k} x1={X(k * d.speed_hz_audio)} x2={X(k * d.speed_hz_audio)} y1={M.t} y2={M.t + ph} stroke="color-mix(in srgb, var(--color-accent) 28%, transparent)" strokeDasharray="3 3" />
              ))}
              {/* the fold line */}
              <path d={tri} fill="none" stroke="var(--color-trace-2)" strokeWidth={1.25} strokeLinejoin="round" />
              {peaks.map((p) => (
                <g key={`h${p.order}`}>
                  <line x1={M.l} x2={X(p.f_true_hz)} y1={Y(p.f_alias_hz)} y2={Y(p.f_alias_hz)} stroke="color-mix(in srgb, var(--color-fg-1) 32%, transparent)" strokeDasharray="2 3" />
                  {candidates(p).map((x, i) => (
                    <circle key={i} cx={X(x)} cy={Y(p.f_alias_hz)} r={p === primary ? 3 : 2.25} fill="var(--color-bg-1)" stroke={p === primary ? 'var(--color-trace-2)' : 'var(--color-line-3)'} strokeWidth={1} />
                  ))}
                  <line x1={X(p.f_true_hz)} x2={X(p.f_true_hz)} y1={Y(p.f_alias_hz)} y2={M.t + ph} stroke="color-mix(in srgb, var(--color-accent-2) 70%, transparent)" strokeDasharray="2 2" />
                </g>
              ))}
            </g>
            {/* order labels */}
            {orders.map((k, i) => {
              const x = X(k * d.speed_hz_audio)
              const prev = i ? X(orders[i - 1] * d.speed_hz_audio) : -99
              return (
                x - prev > 16 && (
                  <text key={k} x={x} y={M.t - 6} textAnchor="middle" fontSize={9.5} fill={peaks.some((p) => p.order === k) ? 'var(--color-accent-2)' : 'color-mix(in srgb, var(--color-accent-2) 45%, transparent)'} className="num" fontWeight={600}>
                    {k}×
                  </text>
                )
              )
            })}
            {/* observed (camera) peaks on the y axis */}
            {peaks.map((p) => (
              <path key={`o${p.order}`} d={`M${M.l - 1},${Y(p.f_alias_hz) - 4} L${M.l + 5},${Y(p.f_alias_hz)} L${M.l - 1},${Y(p.f_alias_hz) + 4} Z`} fill="var(--color-fg-1)" />
            ))}
            {yLabels.map((l) => (
              <text key={l.v} x={M.l - 6} y={l.y} textAnchor="end" fontSize={10} fill="var(--color-fg-1)" className="num">
                {l.v.toFixed(2)}
              </text>
            ))}
            {/* recovered peaks */}
            {peaks.map((p) => {
              const x = X(p.f_true_hz)
              const y = Y(p.f_alias_hz)
              return (
                <g key={`c${p.order}`}>
                  <rect x={x - 4.5} y={y - 4.5} width={9} height={9} transform={`rotate(45 ${x} ${y})`} fill="var(--color-accent)" stroke="var(--color-bg-1)" strokeWidth={1.5} />
                  <text x={x} y={M.t + ph + 13} textAnchor="middle" fontSize={9.5} fill="var(--color-accent-2)" className="num" fontWeight={600}>
                    {p.f_true_hz.toFixed(2)}
                  </text>
                </g>
              )
            })}
            {boxes.map((b) => (
              <g key={`b${b.p.order}`}>
                <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={3} fill="var(--color-bg-1)" stroke="color-mix(in srgb, var(--color-accent) 45%, transparent)" />
                <text x={b.x + 6} y={b.y + 11} fontSize={9.5} fill="var(--color-fg-1)" className="num">
                  {b.text}
                </text>
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  )
}

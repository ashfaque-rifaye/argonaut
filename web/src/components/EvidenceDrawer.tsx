import { useEffect, useRef } from 'react'
import { Image as ImageIcon, Sigma, Waves, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { imgSrc } from '../lib/format'
import type { EvidenceFrame, EvidenceMetric, EvidenceSpectrumPeak } from '../lib/protocol'
import { cx } from './ui'

function PeakCard({ e }: { e: EvidenceSpectrumPeak }) {
  const spec = useStore((s) => s.spectra[e.channel])
  const sensor = useStore((s) => s.sensors?.items.find((i) => i.id === e.channel))
  const W = 360
  const H = 120
  const span = 14
  const lo = Math.max(0, e.f_hz - span)
  const hi = e.f_hz + span
  const pts: [number, number][] = []
  let peak = 0
  if (spec)
    spec.f_hz.forEach((f, i) => {
      if (f >= lo && f <= hi) {
        pts.push([f, spec.amp[i]])
        if (Math.abs(f - e.f_hz) < 0.6) peak = Math.max(peak, spec.amp[i])
      }
    })
  const mx = Math.max(1e-6, ...pts.map((p) => p[1])) * 1.15
  const X = (f: number) => ((f - lo) / (hi - lo)) * W
  const Y = (a: number) => H - 14 - (a / mx) * (H - 24)
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="h-2 w-2 rounded-[2px]" style={{ background: sensor?.color ?? '#6c7580' }} />
        <span className="text-[12px] text-fg-2">{sensor?.label ?? e.channel}</span>
        <span className="num ml-auto text-[18px] text-fg-1">
          {e.f_hz.toFixed(2)}
          <span className="ml-1 text-[10.5px] text-fg-3">Hz</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full rounded-[4px] border border-line-1 bg-bg-0">
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={0} x2={W} y1={(H - 14) * g} y2={(H - 14) * g} stroke="#171b20" />
        ))}
        <rect x={X(e.f_hz) - 6} y={0} width={12} height={H - 14} fill="rgba(157,140,255,.10)" />
        <path d={`${d}L${W},${H - 14}L0,${H - 14}Z`} fill="rgba(216,222,230,.08)" />
        <path d={d} fill="none" stroke="#d8dee6" strokeWidth={1.25} />
        <line x1={X(e.f_hz)} x2={X(e.f_hz)} y1={0} y2={H - 14} stroke="#9d8cff" strokeDasharray="3 2" />
        {[lo, e.f_hz, hi].map((f) => (
          <text key={f} x={X(f)} y={H - 3} textAnchor={f === lo ? 'start' : f === hi ? 'end' : 'middle'} fontSize={9.5} fill="#6c7580" className="num">
            {f.toFixed(1)}
          </text>
        ))}
      </svg>
      <div className="num mt-1.5 text-[10.5px] text-fg-3">
        live amplitude at peak <span className="text-fg-1">{peak.toFixed(3)}</span> {spec?.unit ?? 'mm/s'} · window ±{span} Hz
      </div>
    </div>
  )
}

function FrameCard({ e }: { e: EvidenceFrame }) {
  return (
    <div>
      <img src={imgSrc(e.jpeg_b64)} alt={`Frame at t=${e.t}s`} className="block w-full rounded-[4px] border border-line-1" />
      <div className="num mt-1.5 text-[10.5px] text-fg-3">captured at t = {e.t.toFixed(2)} s · masks overlaid</div>
    </div>
  )
}

function MetricCard({ e }: { e: EvidenceMetric }) {
  const lo = Math.max(0, e.value - 3 * e.err)
  const hi = e.value + 3 * e.err
  const X = (v: number) => ((v - lo) / (hi - lo || 1)) * 100
  const rel = e.value ? (e.err / Math.abs(e.value)) * 100 : 0
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-fg-2">{e.name}</span>
        <span className="num text-[18px] text-fg-1">
          {e.value}
          <span className="ml-1 text-[12px] text-fg-3">± {e.err}</span>
        </span>
      </div>
      <div className="relative mt-3 h-8">
        <div className="absolute left-0 right-0 top-1/2 h-px bg-line-2" />
        <div className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[2px] bg-[rgba(231,234,238,.12)]" style={{ left: `${X(e.value - e.err)}%`, width: `${X(e.value + e.err) - X(e.value - e.err)}%` }} />
        <div className="absolute top-1/2 h-4 w-px -translate-y-1/2 bg-fg-3" style={{ left: `${X(e.value - e.err)}%` }} />
        <div className="absolute top-1/2 h-4 w-px -translate-y-1/2 bg-fg-3" style={{ left: `${X(e.value + e.err)}%` }} />
        <div className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-fg-1" style={{ left: `${X(e.value)}%` }} />
      </div>
      <div className="num flex justify-between text-[9.5px] text-fg-4">
        <span>{lo.toPrecision(3)}</span>
        <span>±1σ band</span>
        <span>{hi.toPrecision(3)}</span>
      </div>
      <div className={cx('num mt-1.5 text-[10.5px]', rel > 30 ? 'text-warn' : 'text-fg-3')}>
        relative uncertainty {rel.toFixed(0)}% {rel > 30 ? '· too wide to act on' : '· within action gate'}
      </div>
    </div>
  )
}

export function EvidenceDrawer() {
  const t = useStore((s) => s.drawer)
  const close = useStore((s) => s.closeEvidence)
  const refs = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    if (!t) return
    refs.current[t.focus]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [t, close])

  return (
    <div className={cx('fixed inset-0 z-50 transition-[visibility] duration-200', t ? 'visible' : 'invisible')} aria-hidden={!t}>
      <div onClick={close} className={cx('absolute inset-0 bg-black/50 backdrop-blur-[1px] transition-opacity duration-200', t ? 'opacity-100' : 'opacity-0')} />
      <aside
        className={cx(
          'absolute bottom-0 right-0 top-0 flex w-full max-w-[420px] flex-col border-l border-line-2 bg-bg-1 shadow-[-24px_0_48px_-12px_rgba(0,0,0,.6)] transition-transform duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)]',
          t ? 'translate-x-0' : 'translate-x-full',
        )}
        role="dialog"
        aria-label="Evidence"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line-1 px-4">
          <div className="min-w-0">
            <div className="eyebrow">Evidence</div>
            <div className="truncate text-[13px] font-semibold text-fg-1">{t?.title}</div>
          </div>
          <button onClick={close} className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg-1" aria-label="Close">
            <X size={15} />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {t?.evidence.map((e, i) => (
            <div
              key={i}
              ref={(el) => {
                refs.current[i] = el
              }}
              className={cx('rounded-md border p-3 transition-colors', i === t.focus ? 'border-[rgba(157,140,255,.45)] bg-bg-2' : 'border-line-1 bg-bg-1')}
            >
              <div className="mb-2 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-fg-4">
                {e.kind === 'spectrum_peak' ? <Waves size={11} /> : e.kind === 'frame' ? <ImageIcon size={11} /> : <Sigma size={11} />}
                {e.kind === 'spectrum_peak' ? 'Spectrum peak' : e.kind === 'frame' ? 'Frame' : 'Metric'}
              </div>
              {e.kind === 'spectrum_peak' && <PeakCard e={e} />}
              {e.kind === 'frame' && <FrameCard e={e} />}
              {e.kind === 'metric' && <MetricCard e={e} />}
            </div>
          ))}
        </div>
        {t?.source && <footer className="num shrink-0 border-t border-line-1 px-4 py-2 text-[10.5px] text-fg-4">source · {t.source}</footer>}
      </aside>
    </div>
  )
}

import { useMemo } from 'react'
import { Activity } from 'lucide-react'
import { useStore } from '../lib/store'
import { niceTicks } from '../lib/format'
import { useSize } from '../lib/useSize'
import type { ModalMode } from '../lib/protocol'
import { cx, Empty, Panel } from './ui'

const M = { l: 38, r: 10, t: 10, b: 20 }

function FddPlot({ odsF }: { odsF: number | null }) {
  const modal = useStore((s) => s.modal)!
  const [box, size] = useSize<HTMLDivElement>()
  const { W, H } = { W: size.w, H: size.h }
  const fMax = modal.f_hz[modal.f_hz.length - 1] || 1
  const all = [...modal.sv1, ...modal.sv2].filter((v) => v > 0)
  const lo = Math.log10(Math.max(1e-9, Math.min(...all)))
  const hi = Math.log10(Math.max(...all))
  const yLo = Math.floor(lo)
  const yHi = Math.ceil(hi + 0.05)
  const pw = Math.max(10, W - M.l - M.r)
  const ph = Math.max(10, H - M.t - M.b)
  const X = (f: number) => M.l + (f / fMax) * pw
  const Y = (v: number) => M.t + ph - ((Math.log10(Math.max(v, 1e-12)) - yLo) / (yHi - yLo)) * ph
  const path = (arr: number[]) => arr.map((v, i) => `${i ? 'L' : 'M'}${X(modal.f_hz[i]).toFixed(1)},${Y(v).toFixed(1)}`).join('')
  const d1 = useMemo(() => path(modal.sv1), [modal, W, H]) // eslint-disable-line react-hooks/exhaustive-deps
  const d2 = useMemo(() => path(modal.sv2), [modal, W, H]) // eslint-disable-line react-hooks/exhaustive-deps
  const peakAt = (f: number) => {
    let best = 0
    modal.f_hz.forEach((x, i) => {
      if (Math.abs(x - f) < 0.6) best = Math.max(best, modal.sv1[i])
    })
    return best
  }
  return (
    <div ref={box} className="relative h-full w-full">
      {W > 0 && (
        <svg width={W} height={H} className="block">
          <defs>
            <linearGradient id="fdd-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="rgba(216,222,230,.14)" />
              <stop offset="1" stopColor="rgba(216,222,230,0)" />
            </linearGradient>
          </defs>
          {niceTicks(0, fMax, Math.max(3, Math.floor(pw / 70))).map((f) => (
            <g key={f}>
              <line x1={X(f)} x2={X(f)} y1={M.t} y2={M.t + ph} stroke="#171b20" />
              <text x={X(f)} y={H - 6} textAnchor="middle" fontSize={10} fill="#6c7580" className="num">
                {f}
              </text>
            </g>
          ))}
          {Array.from({ length: yHi - yLo + 1 }, (_, i) => yLo + i).map((e) => (
            <g key={e}>
              <line x1={M.l} x2={M.l + pw} y1={Y(10 ** e)} y2={Y(10 ** e)} stroke="#171b20" />
              <text x={M.l - 6} y={Y(10 ** e) + 3.5} textAnchor="end" fontSize={9.5} fill="#6c7580" className="num">
                1e{e}
              </text>
            </g>
          ))}
          <path d={`${d1}L${X(fMax)},${M.t + ph}L${X(0)},${M.t + ph}Z`} fill="url(#fdd-fill)" />
          <path d={d2} fill="none" stroke="#7b8693" strokeWidth={1} strokeDasharray="3 2" />
          <path d={d1} fill="none" stroke="#d8dee6" strokeWidth={1.25} />
          {modal.modes.map((m, i) => {
            const y = Y(peakAt(m.f_hz))
            const on = odsF != null && Math.abs(odsF - m.f_hz) < 0.3
            return (
              <g key={i}>
                <line x1={X(m.f_hz)} x2={X(m.f_hz)} y1={y - 4} y2={y - 16} stroke={on ? '#9d8cff' : '#a2abb5'} />
                <rect x={X(m.f_hz) - 12} y={Math.max(0, y - 30)} width={24} height={13} rx={3} fill={on ? '#9d8cff' : '#0d0f12'} stroke={on ? '#9d8cff' : '#323a43'} />
                <text x={X(m.f_hz)} y={Math.max(0, y - 30) + 9.5} textAnchor="middle" fontSize={9.5} fill={on ? '#0b0a14' : '#e7eaee'} fontWeight={600} className="num">
                  M{i + 1}
                </text>
              </g>
            )
          })}
          <g className="num" fontSize={9.5}>
            <line x1={M.l + pw - 92} x2={M.l + pw - 80} y1={M.t + 6} y2={M.t + 6} stroke="#d8dee6" />
            <text x={M.l + pw - 76} y={M.t + 9.5} fill="#a2abb5">
              SV1
            </text>
            <line x1={M.l + pw - 46} x2={M.l + pw - 34} y1={M.t + 6} y2={M.t + 6} stroke="#7b8693" strokeDasharray="3 2" />
            <text x={M.l + pw - 30} y={M.t + 9.5} fill="#6c7580">
              SV2
            </text>
          </g>
        </svg>
      )}
    </div>
  )
}

function ShapeBars({ m }: { m: ModalMode }) {
  const sensors = useStore((s) => s.sensors)
  const color = (id: string) => sensors?.items.find((i) => i.id === id)?.color ?? '#6c7580'
  return (
    <svg width={m.shape.length * 9} height={22} className="block" aria-label="mode shape">
      <line x1={0} x2={m.shape.length * 9} y1={11} y2={11} stroke="#283038" />
      {m.shape.map((e, i) => {
        const sgn = Math.cos((e.phase_deg * Math.PI) / 180) >= 0 ? 1 : -1
        const h = Math.max(1, Math.abs(e.amp) * 10)
        return <rect key={e.id} x={i * 9 + 1.5} y={sgn > 0 ? 11 - h : 11} width={6} height={h} rx={1} fill={color(e.id)} opacity={0.9} />
      })}
    </svg>
  )
}

export function ModalPanel() {
  const modal = useStore((s) => s.modal)
  const cb = useStore((s) => s.campbell)
  const ods = useStore((s) => s.ods)
  const set = useStore((s) => s.set)
  const odsF = ods.on ? ods.f_hz : null
  const match = (f: number) => cb?.modes.find((m) => Math.abs(m.f_hz - f) < 0.5)

  return (
    <Panel title="Operational modal analysis" meta={modal ? `${modal.method} · ${modal.modes.length} modes` : 'FDD'}>
      {modal ? (
        <div className="absolute inset-0 flex flex-col">
          <div className="min-h-0 flex-1">
            <FddPlot odsF={odsF} />
          </div>
          <table className="w-full shrink-0 border-t border-line-1 text-left">
            <thead>
              <tr className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-fg-4">
                <th className="py-1 pl-3 font-semibold">Mode</th>
                <th className="py-1 font-semibold">f (Hz)</th>
                <th className="py-1 font-semibold">ζ ± err</th>
                <th className="py-1 font-semibold">Shape</th>
                <th className="py-1 pr-2" />
              </tr>
            </thead>
            <tbody>
              {modal.modes.map((m, i) => {
                const c = match(m.f_hz)
                const on = odsF != null && Math.abs(odsF - m.f_hz) < 0.3
                return (
                  <tr key={i} title={c?.source ? `Identified by: ${c.source}` : undefined} className={cx('border-t border-line-1 transition-colors', on ? 'bg-[var(--accent-dim)]' : 'hover:bg-bg-2')}>
                    <td className="py-1 pl-3">
                      <div className="flex items-center gap-1.5">
                        <span className={cx('num text-[11px] font-semibold', on ? 'text-accent-2' : 'text-fg-1')}>M{i + 1}</span>
                        <span className="hidden truncate text-[10.5px] text-fg-3 2xl:inline">{c?.label}</span>
                      </div>
                    </td>
                    <td className="num py-1 text-[11.5px] text-fg-1">
                      {m.f_hz.toFixed(2)}
                      {c && <span className="text-fg-4"> ±{c.f_err_hz.toFixed(1)}</span>}
                    </td>
                    <td className="num py-1 text-[11.5px] text-fg-2">
                      {m.zeta == null ? '—' : m.zeta.toFixed(3)}
                      {c?.zeta_err != null && m.zeta != null && <span className="text-fg-4"> ±{c.zeta_err.toFixed(3)}</span>}
                    </td>
                    <td className="py-1">
                      <ShapeBars m={m} />
                    </td>
                    <td className="py-1 pr-2 text-right">
                      <button
                        onClick={() => set({ ods: on ? { on: false, f_hz: m.f_hz } : { on: true, f_hz: m.f_hz } })}
                        title="Animate this mode shape on the live view (ODS)"
                        className={cx('inline-flex h-5 items-center gap-1 rounded-[4px] border px-1.5 text-[10px] font-medium', on ? 'border-[rgba(157,140,255,.5)] text-accent-2' : 'border-line-2 text-fg-3 hover:text-fg-1')}
                      >
                        <Activity size={10} /> {on ? 'On' : 'ODS'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No modal estimate yet" hint="Frequency-domain decomposition runs across all virtual sensors. Peaks in SV1 are modes; singular vectors are mode shapes." />
      )}
    </Panel>
  )
}

import { useMemo, useState } from 'react'
import { useStore } from '../lib/store'
import { niceTicks } from '../lib/format'
import { useSize } from '../lib/useSize'
import type { CampbellEvent } from '../lib/protocol'
import { Empty, Panel, Seg } from './ui'

const M = { l: 38, r: 12, t: 12, b: 26 }
const ORDER_STYLE: Record<string, { stroke: string; dash?: string; w: number }> = {
  '1': { stroke: 'var(--color-trace-1)', w: 1.5 },
  '2': { stroke: 'var(--color-trace-2)', dash: '5 3', w: 1.1 },
  '3': { stroke: 'var(--color-fg-3)', dash: '1.5 2.5', w: 1.1 },
}

/** Order amplitude vs speed: the resonance curve(s) from the sweep, with fitted modes marked. */
function ResonanceView({ cb, W, H, xMax }: { cb: CampbellEvent; W: number; H: number; xMax: number }) {
  const oa = cb.order_amp_mm ?? {}
  const keys = Object.keys(oa).sort()
  const all = keys.flatMap((k) => oa[k]).filter((v) => Number.isFinite(v))
  const yMax = Math.max(1e-6, ...all) * 1.18
  const pw = Math.max(10, W - M.l - M.r)
  const ph = Math.max(10, H - M.t - M.b)
  const X = (v: number) => M.l + (v / xMax) * pw
  const Y = (a: number) => M.t + ph - (a / yMax) * ph
  const um = yMax < 0.5
  const fmt = (v: number) => (um ? `${(v * 1000).toFixed(0)}` : v.toFixed(2))
  const paths = keys.map((k) => {
    const pts = cb.speeds_rpm.map((r, i) => [r, oa[k][i]] as const).filter(([r, a]) => r > 1 && Number.isFinite(a))
    return { k, d: pts.map(([r, a], i) => `${i ? 'L' : 'M'}${X(r).toFixed(1)},${Y(a).toFixed(1)}`).join('') }
  })
  return (
    <svg width={W} height={H} className="block">
      <defs>
        <clipPath id="rs-clip">
          <rect x={M.l} y={M.t} width={pw} height={ph} />
        </clipPath>
      </defs>
      {niceTicks(0, xMax, Math.max(3, Math.floor(pw / 80))).map((v) => (
        <g key={`x${v}`}>
          <line x1={X(v)} x2={X(v)} y1={M.t} y2={M.t + ph} stroke="var(--color-grid)" />
          <text x={X(v)} y={H - 9} textAnchor="middle" className="num" fontSize={10} fill="var(--color-fg-3)">
            {v}
          </text>
        </g>
      ))}
      {niceTicks(0, yMax, Math.max(3, Math.floor(ph / 34))).map((a) => (
        <g key={`y${a}`}>
          <line x1={M.l} x2={M.l + pw} y1={Y(a)} y2={Y(a)} stroke="var(--color-grid)" />
          <text x={M.l - 6} y={Y(a) + 3.5} textAnchor="end" className="num" fontSize={10} fill="var(--color-fg-3)">
            {fmt(a)}
          </text>
        </g>
      ))}
      <text x={M.l + 4} y={M.t + 10} fontSize={9.5} fill="var(--color-fg-4)" className="num">
        {um ? 'µm' : 'mm'} · order amplitude
      </text>
      <text x={M.l + pw} y={H - 9} textAnchor="end" fontSize={9.5} fill="var(--color-fg-4)" className="num" dx={-2} dy={-12}>
        rpm
      </text>
      <g clipPath="url(#rs-clip)">
        {cb.modes.map((m, i) =>
          [1, 2].map((k) => {
            const c = (60 * m.f_hz) / k
            if (c > xMax) return null
            const lo = (60 * (m.f_hz - m.f_err_hz)) / k
            const hi = (60 * (m.f_hz + m.f_err_hz)) / k
            return (
              <g key={`${i}-${k}`} opacity={k === 1 ? 1 : 0.55}>
                <rect x={X(lo)} y={M.t} width={Math.max(1.5, X(hi) - X(lo))} height={ph} fill="color-mix(in srgb, var(--color-accent) 10%, transparent)" />
                <line x1={X(c)} x2={X(c)} y1={M.t} y2={M.t + ph} stroke="var(--color-accent)" strokeDasharray="3 3" />
              </g>
            )
          }),
        )}
        {paths.map((p) => {
          const st = ORDER_STYLE[p.k] ?? ORDER_STYLE['3']
          return <path key={p.k} d={p.d} fill="none" stroke={st.stroke} strokeWidth={st.w} strokeDasharray={st.dash} strokeLinejoin="round" />
        })}
      </g>
      {cb.modes.map((m, i) => {
        const c = 60 * m.f_hz
        if (c > xMax) return null
        const right = X(c) > M.l + pw * 0.6
        const tx = X(c) + (right ? -6 : 6)
        return (
          <text key={`ml${i}`} x={tx} y={M.t + 12 + i * 26} textAnchor={right ? 'end' : 'start'} fontSize={10} fill="var(--color-accent-2)" className="num" stroke="var(--color-bg-1)" strokeWidth={3} paintOrder="stroke">
            <tspan>
              {m.f_hz.toFixed(2)} ± {m.f_err_hz.toFixed(2)} Hz
            </tspan>
            <tspan x={tx} dy={12} fill="var(--color-fg-2)">
              ζ {m.zeta == null ? '—' : `${m.zeta.toFixed(3)}${m.zeta_err != null ? ` ± ${m.zeta_err.toFixed(3)}` : ''}`}
            </tspan>
            {m.source && <title>{`${m.label} · ${m.source}${m.forcing_power != null ? ` · forcing power ${m.forcing_power.toFixed(2)}` : ''}`}</title>}
          </text>
        )
      })}
      <g className="num" fontSize={9.5} transform={`translate(${M.l + pw - 4} ${M.t + ph - 8 - (keys.length - 1) * 12})`}>
        {keys.map((k, i) => {
          const st = ORDER_STYLE[k] ?? ORDER_STYLE['3']
          return (
            <g key={k} transform={`translate(0 ${i * 12})`}>
              <line x1={-44} x2={-30} y1={-3} y2={-3} stroke={st.stroke} strokeWidth={st.w} strokeDasharray={st.dash} />
              <text x={-26} y={0} fill="var(--color-fg-3)">
                {k}× order
              </text>
            </g>
          )
        })}
      </g>
    </svg>
  )
}

export function CampbellPanel() {
  const cb = useStore((s) => s.campbell)
  const rpm = useStore((s) => s.telemetry?.speed_rpm ?? null)
  const proposal = useStore((s) => s.proposal)
  const status = useStore((s) => s.proposalStatus)
  const [box, size] = useSize<HTMLDivElement>()
  const [view, setView] = useState<'campbell' | 'res'>(() => (new URLSearchParams(location.search).get('cb') === 'res' ? 'res' : 'campbell'))
  const hasRes = !!cb?.order_amp_mm && Object.keys(cb.order_amp_mm).length > 0
  const mode = hasRes ? view : 'campbell'

  const xMax = useMemo(() => Math.max(1800, ...(cb?.speeds_rpm ?? [0]).map((v) => v * 1.08)), [cb])
  const yMax = useMemo(() => {
    const top = Math.max(0, ...(cb?.modes ?? []).map((m) => m.f_hz + m.f_err_hz))
    return Math.max(40, Math.ceil((top * 1.15) / 10) * 10)
  }, [cb])

  const W = size.w
  const H = size.h
  const pw = Math.max(10, W - M.l - M.r)
  const ph = Math.max(10, H - M.t - M.b)
  const X = (v: number) => M.l + (v / xMax) * pw
  const Y = (f: number) => M.t + ph - (f / yMax) * ph

  const showProp = proposal && status !== 'rejected'

  return (
    <Panel
      title={mode === 'res' ? 'Resonance curve' : 'Campbell diagram'}
      meta={cb ? (mode === 'res' ? 'order amplitude vs speed' : `${cb.modes.length} modes · ${cb.criticals.length} critical speeds`) : 'speed × frequency'}
      right={
        <>
          {hasRes && (
            <Seg
              value={view}
              onChange={setView}
              options={[
                { v: 'campbell', label: 'Campbell' },
                { v: 'res', label: 'Resonance' },
              ]}
            />
          )}
          <div className="hidden items-center gap-3 pl-2 text-[10px] text-fg-3 2xl:flex">
          <span className="inline-flex items-center gap-1">
            <span className="h-[2px] w-3 bg-fg-2" />
            mode ± err
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full border border-warn" />
            critical
          </span>
          </div>
        </>
      }
    >
      <div ref={box} className="absolute inset-0">
        {W > 0 && cb && mode === 'res' && <ResonanceView cb={cb} W={W} H={H} xMax={xMax} />}
        {W > 0 && cb && mode === 'campbell' && (
          <svg width={W} height={H} className="block">
            <defs>
              <pattern id="cb-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" stroke="color-mix(in srgb, var(--color-alarm) 22%, transparent)" strokeWidth="2" />
              </pattern>
              <clipPath id="cb-clip">
                <rect x={M.l} y={M.t} width={pw} height={ph} />
              </clipPath>
            </defs>
            {/* grid */}
            {niceTicks(0, xMax, Math.max(3, Math.floor(pw / 80))).map((v) => (
              <g key={`x${v}`}>
                <line x1={X(v)} x2={X(v)} y1={M.t} y2={M.t + ph} stroke="var(--color-grid)" />
                <text x={X(v)} y={H - 9} textAnchor="middle" className="num" fontSize={10} fill="var(--color-fg-3)">
                  {v}
                </text>
              </g>
            ))}
            {niceTicks(0, yMax, Math.max(3, Math.floor(ph / 34))).map((f) => (
              <g key={`y${f}`}>
                <line x1={M.l} x2={M.l + pw} y1={Y(f)} y2={Y(f)} stroke="var(--color-grid)" />
                <text x={M.l - 6} y={Y(f) + 3.5} textAnchor="end" className="num" fontSize={10} fill="var(--color-fg-3)">
                  {f}
                </text>
              </g>
            ))}
            <text x={M.l + pw} y={H - 9} textAnchor="end" fontSize={9.5} fill="var(--color-fg-4)" className="num" dx={-2} dy={-12}>
              rpm
            </text>
            <text x={M.l + 4} y={M.t + 10} fontSize={9.5} fill="var(--color-fg-4)" className="num">
              Hz
            </text>

            <g clipPath="url(#cb-clip)">
              {/* resonance exclusion bands from the optimizer */}
              {showProp &&
                proposal.exclusion_bands_rpm.map(([a, b], i) => <rect key={i} x={X(a)} y={M.t} width={Math.max(1, X(b) - X(a))} height={ph} fill="url(#cb-hatch)" />)}
              {/* modes with error bands */}
              {cb.modes.map((m) => (
                <g key={m.label}>
                  <rect x={M.l} width={pw} y={Y(m.f_hz + m.f_err_hz)} height={Math.max(1, Y(m.f_hz - m.f_err_hz) - Y(m.f_hz + m.f_err_hz))} fill="color-mix(in srgb, var(--color-fg-1) 7%, transparent)" />
                  <line x1={M.l} x2={M.l + pw} y1={Y(m.f_hz)} y2={Y(m.f_hz)} stroke="var(--color-fg-2)" strokeWidth={1.25} />
                </g>
              ))}
              {/* order rays */}
              {cb.orders.map((o) => {
                const xEnd = Math.min(xMax, (yMax * 60) / o)
                return <line key={o} x1={X(0)} y1={Y(0)} x2={X(xEnd)} y2={Y((xEnd * o) / 60)} stroke={o === 1 ? 'var(--color-fg-3)' : 'var(--color-fg-4)'} strokeWidth={1} strokeDasharray={o === 1 ? undefined : '4 3'} />
              })}
              {/* speed coverage rug */}
              {cb.speeds_rpm.map((s, i) => (
                <line key={i} x1={X(s)} x2={X(s)} y1={M.t + ph - 4} y2={M.t + ph} stroke="var(--color-fg-3)" strokeOpacity={0.6} />
              ))}
              {/* live speed */}
              {rpm != null && rpm > 0 && (
                <g>
                  <line x1={X(rpm)} x2={X(rpm)} y1={M.t} y2={M.t + ph} stroke="var(--color-fg-1)" strokeWidth={1} />
                  {cb.orders.map((o) => {
                    const f = (rpm * o) / 60
                    return f < yMax ? <circle key={o} cx={X(rpm)} cy={Y(f)} r={2.5} fill="var(--color-fg-1)" /> : null
                  })}
                </g>
              )}
              {showProp && <line x1={X(proposal.proposed.speed_rpm)} x2={X(proposal.proposed.speed_rpm)} y1={M.t} y2={M.t + ph} stroke="var(--color-accent)" strokeDasharray="4 3" strokeWidth={1.25} />}
              {/* criticals */}
              {cb.criticals.map((c, i) => (
                <g key={i}>
                  <circle cx={X(c.rpm)} cy={Y(c.mode_f_hz)} r={5} fill="var(--color-bg-1)" stroke="var(--color-warn)" strokeWidth={1.5} />
                  {c.order === 1 && (
                    <text x={X(c.rpm) + 7} y={Y(c.mode_f_hz) - 6} fontSize={9.5} fill="var(--color-warn)" className="num" stroke="var(--color-bg-1)" strokeWidth={3} paintOrder="stroke">
                      {Math.round(c.rpm)}
                    </text>
                  )}
                </g>
              ))}
            </g>

            {/* labels outside clip */}
            {cb.orders.map((o) => {
              const xEnd = Math.min(xMax, (yMax * 60) / o)
              const atTop = xEnd < xMax
              return (
                <text key={o} x={X(xEnd) + (atTop ? 3 : -2)} y={Y((xEnd * o) / 60) + (atTop ? 9 : -4)} textAnchor={atTop ? 'start' : 'end'} fontSize={9.5} fill="var(--color-fg-3)" className="num">
                  {o === 1 ? '1×' : o === 2 ? '2×' : `${o}× BPF`}
                </text>
              )
            })}
            {cb.modes.map((m) => (
              <text key={`l${m.label}`} x={M.l + pw - 4} y={Y(m.f_hz - m.f_err_hz) + 11} textAnchor="end" fontSize={10} fill="var(--color-fg-2)" stroke="var(--color-bg-1)" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">
                <tspan className="num" fill="var(--color-fg-1)">
                  {m.f_hz.toFixed(1)}
                </tspan>
                <tspan className="num" fill="var(--color-fg-3)">
                  {' '}± {m.f_err_hz.toFixed(1)} Hz
                </tspan>
                <tspan dx={6}>{m.label}</tspan>
              </text>
            ))}
            {rpm != null && rpm > 0 && (
              <g transform={`translate(${Math.min(X(rpm), M.l + pw - 44)} ${M.t})`}>
                <rect x={3} y={0} width={42} height={14} rx={3} fill="var(--color-fg-1)" />
                <text x={24} y={10.5} textAnchor="middle" fontSize={9.5} fill="var(--color-bg-1)" fontWeight={600} className="num">
                  {Math.round(rpm)}
                </text>
              </g>
            )}
            {showProp && (
              <g transform={`translate(${X(proposal.proposed.speed_rpm)} ${M.t + 18})`}>
                <rect x={-50} y={0} width={46} height={14} rx={3} fill="var(--color-accent)" />
                <text x={-27} y={10.5} textAnchor="middle" fontSize={9.5} fill="var(--color-on-accent)" fontWeight={600} className="num">
                  {proposal.id.toUpperCase()} {Math.round(proposal.proposed.speed_rpm)}
                </text>
              </g>
            )}
          </svg>
        )}
      </div>
      {!cb && <Empty title="No run-up / coast-down yet" hint="Say “Argonaut, start a coast-down” or press Coast-down. Order lines crossing natural frequencies become critical speeds." stage="wonder" />}
    </Panel>
  )
}

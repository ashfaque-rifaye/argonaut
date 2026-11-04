import { useMemo, useState } from 'react'
import { ChevronRight, Sigma } from 'lucide-react'
import { useStore } from '../lib/store'
import { useSize } from '../lib/useSize'
import type { FaultHypothesis, KinematicsEvent, SpeedPosterior } from '../lib/protocol'
import { Chip, cx, Empty, Panel } from './ui'

/** Modes | Faults switch shared by the two panels that take turns in this slot. */
export function IdentifyTabs() {
  const tab = useStore((s) => s.identifyTab)
  const has = useStore((s) => s.kinematics != null)
  const set = useStore((s) => s.set)
  const tabs: { v: 'modes' | 'faults'; label: string }[] = [
    { v: 'modes', label: 'Modes' },
    { v: 'faults', label: 'Faults' },
  ]
  return (
    <div role="tablist" className="flex items-center rounded-[4px] border border-line-2 p-px">
      {tabs.map((t) => (
        <button
          key={t.v}
          role="tab"
          aria-selected={tab === t.v}
          onClick={() => set({ identifyTab: t.v })}
          className={cx(
            'relative h-[18px] rounded-[3px] px-1.5 text-[10.5px] font-medium transition-colors',
            tab === t.v ? 'bg-bg-3 text-fg-1' : 'text-fg-3 hover:text-fg-1',
          )}
        >
          {t.label}
          {t.v === 'faults' && has && tab !== 'faults' && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
        </button>
      ))}
    </div>
  )
}

const FAMILY_LABEL: Record<string, string> = {
  shaft: 'shaft order',
  half_order: 'half order',
  firing: 'firing',
  blade_pass: 'blade pass',
  gear_mesh: 'gear mesh',
  bearing: 'bearing',
  shaft_out: 'output shaft',
}

const MACHINE_LABEL: Record<string, string> = {
  induction_motor: 'Induction motor',
  fan: 'Fan',
  centrifugal_pump: 'Centrifugal pump',
  gear_pump: 'Gear pump',
  genset: 'Diesel genset',
  engine: 'Engine',
  washer: 'Washing machine',
  gearbox: 'Gearbox',
  wind_turbine: 'Wind turbine',
  structure: 'Structure',
  generic: 'Unclassified machine',
}

const rpm = (v: number) => Math.round(v).toLocaleString('en-US')

function SpeedPlot({ sp }: { sp: SpeedPosterior }) {
  const [box, size] = useSize<HTMLDivElement>()
  const M = { l: 6, r: 6, t: 14, b: 16 }
  const W = size.w
  const H = size.h
  const pw = Math.max(10, W - M.l - M.r)
  const ph = Math.max(10, H - M.t - M.b)
  const lo = Math.log10(sp.grid_rpm[0])
  const hi = Math.log10(sp.grid_rpm[sp.grid_rpm.length - 1])
  const X = (r: number) => M.l + ((Math.log10(r) - lo) / (hi - lo)) * pw
  const Y = (p: number) => M.t + ph - p * ph
  const d = useMemo(() => {
    const pts = sp.grid_rpm.map((r, i) => `${X(r).toFixed(1)},${Y(sp.post[i]).toFixed(1)}`)
    return { line: `M${pts.join('L')}`, area: `M${X(sp.grid_rpm[0])},${Y(0)}L${pts.join('L')}L${X(sp.grid_rpm[sp.grid_rpm.length - 1])},${Y(0)}Z` }
  }, [sp, W, H]) // eslint-disable-line react-hooks/exhaustive-deps
  const ticks = [200, 500, 1000, 2000, 5000].filter((t) => t >= sp.grid_rpm[0] && t <= sp.grid_rpm[sp.grid_rpm.length - 1])
  return (
    <div ref={box} className="relative h-full w-full">
      {W > 0 && (
        <svg width={W} height={H} className="block" role="img" aria-label="Posterior probability of running speed">
          <defs>
            <linearGradient id="sp-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="color-mix(in srgb, var(--color-accent) 30%, transparent)" />
              <stop offset="1" stopColor="color-mix(in srgb, var(--color-accent) 0%, transparent)" />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={X(t)} x2={X(t)} y1={M.t} y2={M.t + ph} stroke="var(--color-grid)" />
              <text x={X(t)} y={H - 4} textAnchor="middle" fontSize={9.5} fill="var(--color-fg-4)" className="num">
                {t >= 1000 ? `${t / 1000}k` : t}
              </text>
            </g>
          ))}
          <line x1={M.l} x2={M.l + pw} y1={Y(0)} y2={Y(0)} stroke="var(--color-line-2)" />
          <path d={d.area} fill="url(#sp-fill)" />
          <path d={d.line} fill="none" stroke="var(--color-accent)" strokeWidth={1.3} />
          {sp.display_rpm != null && (
            <g>
              <line x1={X(sp.display_rpm)} x2={X(sp.display_rpm)} y1={M.t - 2} y2={M.t + ph} stroke="var(--color-ok)" strokeDasharray="3 2" />
              <text x={X(sp.display_rpm) + 3} y={M.t + 8} fontSize={9.5} fill="var(--color-ok)">
                display
              </text>
            </g>
          )}
          {sp.modes.map((m, i) => {
            const x = X(m.rpm)
            // label the MAP and well-separated alternatives only, so labels never collide
            if (i > 0 && (m.p < 0.05 || sp.modes.slice(0, i).some((o) => Math.abs(X(o.rpm) - x) < 70))) {
              return <circle key={i} cx={x} cy={Y(Math.min(1, m.p / sp.modes[0].p))} r={1.8} fill="var(--color-fg-4)" />
            }
            const anchor = x > W - 70 ? 'end' : x < 50 ? 'start' : 'middle'
            return (
              <g key={i}>
                <circle cx={x} cy={Y(i === 0 ? 1 : Math.min(1, m.p / sp.modes[0].p))} r={i === 0 ? 2.6 : 2} fill={i === 0 ? 'var(--color-accent-2)' : 'var(--color-fg-3)'} />
                <text x={x} y={Math.max(9, Y(i === 0 ? 1 : Math.min(1, m.p / sp.modes[0].p)) - 5)} textAnchor={anchor} fontSize={9.5} className="num" fill={i === 0 ? 'var(--color-fg-1)' : 'var(--color-fg-3)'}>
                  {rpm(m.rpm)} · {(m.p * 100).toFixed(0)}%{m.relation ? ` (${m.relation})` : ''}
                </text>
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

function FaultRow({ h, open, onToggle }: { h: FaultHypothesis; open: boolean; onToggle: () => void }) {
  const tone = !h.evaluable ? 'muted' : h.p >= 0.7 ? 'alarm' : h.p >= 0.4 ? 'warn' : 'ok'
  const bar = !h.evaluable ? 'var(--color-line-2)' : h.p >= 0.7 ? 'var(--color-alarm)' : h.p >= 0.4 ? 'var(--color-warn)' : 'var(--color-fg-3)'
  return (
    <li className="border-t border-line-1">
      <button onClick={onToggle} className="group flex w-full items-center gap-2 px-3 py-[5px] text-left hover:bg-bg-2" aria-expanded={open}>
        <ChevronRight size={11} className={cx('shrink-0 text-fg-4 transition-transform', open && 'rotate-90')} />
        <span className={cx('min-w-0 flex-1 truncate text-[11.5px]', h.evaluable ? 'text-fg-1' : 'text-fg-4')}>{h.title}</span>
        <span className="relative h-[6px] w-[88px] shrink-0 overflow-hidden rounded-full bg-bg-3" title={`prior ${(h.prior * 100).toFixed(0)}%`}>
          <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(h.evaluable ? h.p : 0) * 100}%`, background: bar }} />
          {h.evaluable && h.p_range[1] - h.p_range[0] > 0.02 && (
            <span className="absolute inset-y-[1px] rounded-full border border-fg-2/60" style={{ left: `${h.p_range[0] * 100}%`, width: `${(h.p_range[1] - h.p_range[0]) * 100}%` }} />
          )}
          <span className="absolute inset-y-0 w-px bg-fg-2" style={{ left: `${h.prior * 100}%` }} />
        </span>
        <Chip tone={tone} mono className="w-[42px] justify-center">
          {h.evaluable ? `${(h.p * 100).toFixed(0)}%` : 'n/e'}
        </Chip>
      </button>
      {open && (
        <div className="anim-in px-3 pb-2 pl-[26px]">
          {h.evidence.length ? (
            <table className="w-full text-[10.5px]">
              <tbody>
                {h.evidence.map((e, i) => (
                  <tr key={i} className="align-top" title={e.note}>
                    <td className="py-[2px] pr-2 text-fg-2">{e.feature}</td>
                    <td className="num py-[2px] pr-2 text-right text-fg-1">{typeof e.value === 'number' ? +e.value.toFixed(3) : String(e.value)}</td>
                    <td className={cx('num w-[52px] py-[2px] text-right font-medium', e.db >= 0 ? 'text-warn' : 'text-ok')}>
                      {e.db >= 0 ? '+' : ''}
                      {e.db.toFixed(1)} dB
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-line-1 text-fg-3">
                  <td className="pt-1">prior {(h.prior * 100).toFixed(0)}% · total evidence</td>
                  <td />
                  <td className="num pt-1 text-right">
                    {h.evidence_db >= 0 ? '+' : ''}
                    {h.evidence_db.toFixed(1)} dB
                  </td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="text-[10.5px] leading-snug text-fg-3">Not evaluable from this capture: the evidence this hypothesis needs is missing, so it is not guessed.</p>
          )}
          {h.evidence[0] && <p className="mt-1 text-[10px] leading-snug text-fg-4">{h.evidence[0].note}</p>}
        </div>
      )}
    </li>
  )
}

function ModelChips({ k }: { k: KinematicsEvent }) {
  const m = k.kin
  const items: string[] = [MACHINE_LABEL[m.machine] ?? m.machine]
  if (m.stroke) items.push(`${m.stroke}-stroke`)
  if (m.cylinders) items.push(`${m.cylinders} cyl`)
  if (m.blades) items.push(`${m.blades} blades/vanes`)
  if (m.poles) items.push(`${m.poles}-pole`)
  if (m.gear_teeth?.length === 2) items.push(`gear ${m.gear_teeth[0]}:${m.gear_teeth[1]}`)
  if (k.line) items.push(`line ${k.line.line_hz.toFixed(2)} Hz`)
  return (
    <div className="flex flex-wrap items-center gap-1">
      {items.map((t) => (
        <Chip key={t} tone="neutral">
          {t}
        </Chip>
      ))}
      <span className="text-[10px] text-fg-4">· {m.source}</span>
    </div>
  )
}

export function InferencePanel() {
  const k = useStore((s) => s.kinematics)
  const [open, setOpen] = useState<string | null>(null)
  const sp = k?.speed_posterior ?? null
  const meta = k ? (sp ? `speed P ${(sp.p_map * 100).toFixed(0)}% · ${sp.n_explained}/${sp.n_peaks} lines explained` : 'speed from camera') : 'Bayesian'
  return (
    <Panel title="Kinematic inference" meta={meta} right={<IdentifyTabs />}>
      {k ? (
        <div className="absolute inset-0 flex flex-col overflow-y-auto">
          <div className="shrink-0 space-y-1.5 px-3 pb-1 pt-2">
            <ModelChips k={k} />
            {sp ? (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px]">
                <span className="text-fg-3">
                  Speed <span className="num text-[13px] font-semibold text-fg-1">{rpm(sp.map_rpm)}</span> rpm
                </span>
                <span className="num text-fg-3">
                  68% CI {rpm(sp.ci68_rpm[0])}–{rpm(sp.ci68_rpm[1])}
                </span>
                {sp.display_rpm != null && sp.display_error_pct != null && (
                  <span className="text-ok">
                    display {rpm(sp.display_rpm)} · <span className="num">{sp.display_error_pct >= 0 ? '+' : ''}{sp.display_error_pct.toFixed(2)}%</span>
                  </span>
                )}
                {sp.ambiguous && <Chip tone="warn">order ambiguous</Chip>}
              </div>
            ) : (
              <div className="text-[11px] text-fg-3">
                Speed <span className="num font-semibold text-fg-1">{rpm(k.speed_rpm_used)}</span> rpm from {k.speed_source}
              </div>
            )}
          </div>
          {sp && (
            <div className="h-[86px] shrink-0 px-1" title={`Prior: ${sp.prior}`}>
              <SpeedPlot sp={sp} />
            </div>
          )}
          {sp && (
            <div className="shrink-0 px-3 pb-1.5 text-[10px] leading-snug text-fg-4">
              p(speed | spectrum, kinematics) · prior: {sp.prior}
              {sp.masked_electrical_hz.length > 0 && ` · ${sp.masked_electrical_hz.length} mains lines masked`}
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-fg-3">
                {sp.peaks
                  .filter((p) => p.line && !(p.family === 'shaft' && parseFloat(p.line) > 12))
                  .sort((a, b) => b.amp - a.amp)
                  .filter((p, i, arr) => arr.findIndex((q) => q.line === p.line) === i)
                  .slice(0, 6)
                  .map((p) => (
                    <span key={p.f_hz} className="num whitespace-nowrap">
                      {p.f_hz.toFixed(1)} Hz = {p.line} <span className="text-fg-4">{FAMILY_LABEL[p.family ?? ''] ?? ''}</span>
                    </span>
                  ))}
              </div>
            </div>
          )}
          <div className="flex shrink-0 items-center gap-1.5 border-t border-line-1 px-3 py-1">
            <Sigma size={11} className="text-fg-4" />
            <span className="eyebrow">Fault posterior</span>
            <span className="ml-auto text-[10px] text-fg-4">bar = P · tick = prior · n/e = not evaluable</span>
          </div>
          <ul className="pb-1">
            {k.faults.map((h) => (
              <FaultRow key={h.id} h={h} open={open === h.id} onToggle={() => setOpen(open === h.id ? null : h.id)} />
            ))}
          </ul>
          {k.override && <div className="px-3 pb-2 text-[10px] text-warn">What-if assumptions applied: {Object.keys(k.override).filter((x) => x !== 'source').join(', ') || 'reverted'}</div>}
        </div>
      ) : (
        <Empty
          title="No kinematic inference yet"
          hint="Muse Spark reads what the machine is; a Bayesian harmonic sieve infers the running speed and log-odds evidence ranks the fault hypotheses."
          stage="dsp"
          skeleton="table"
        />
      )}
    </Panel>
  )
}

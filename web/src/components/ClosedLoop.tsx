import { useMemo, useRef, useState } from 'react'
import { CircleCheck, CircleStop, CircleX, Cpu, Play, TriangleAlert } from 'lucide-react'
import { useStore, type RtoSample } from '../lib/store'
import { link } from '../lib/socket'
import { clamp, fx, ISO_BOUNDS, niceTicks } from '../lib/format'
import { useSize } from '../lib/useSize'
import { defaultEnvelope, STEP_OPTIONS } from '../lib/envelope'
import type { EnvelopeRequest, ProposalEvent, RtoEvent, RtoStatus } from '../lib/protocol'
import { Btn, Chip, cx, Seg } from './ui'

const TERMINAL: RtoStatus[] = ['converged', 'aborted']
const PHASES: RtoStatus[] = ['stepping', 'settling', 'measuring', 'updating']
const isTerminal = (s?: RtoStatus) => !!s && TERMINAL.includes(s)
const W_ = (kw: number) => (kw < 1 ? { v: kw * 1000, u: 'W', d: 0 } : { v: kw, u: 'kW', d: 1 })

export function RtoStatusChip({ rto }: { rto: RtoEvent }) {
  if (rto.status === 'converged')
    return (
      <Chip tone="ok">
        <CircleCheck size={10} /> Converged
      </Chip>
    )
  if (rto.status === 'aborted')
    return (
      <Chip tone="alarm">
        <CircleX size={10} /> Aborted
      </Chip>
    )
  return (
    <Chip tone="accent" mono>
      <span className="h-1.5 w-1.5 rounded-full bg-accent anim-pulse" /> it {rto.iteration} · {rto.status}
    </Chip>
  )
}

/** stepping → settling → measuring → updating, with the current phase lit. */
function PhaseRail({ status }: { status: RtoStatus }) {
  const idx = PHASES.indexOf(status)
  return (
    <div className="grid grid-cols-4 gap-px overflow-hidden rounded-[4px] border border-line-1 bg-line-1">
      {PHASES.map((p, i) => (
        <div
          key={p}
          className={cx(
            'num flex h-[18px] items-center justify-center text-[9.5px] tracking-[0.02em]',
            i === idx ? 'bg-[var(--accent-dim)] text-accent-2' : i < idx || isTerminal(status) ? 'bg-bg-2 text-fg-3' : 'bg-bg-1 text-fg-4',
          )}
        >
          {p}
        </div>
      ))}
    </div>
  )
}

/* ───────────────────────── envelope editor ───────────────────────── */

function EnvelopeSlider({ p, env, onChange }: { p: ProposalEvent | null; env: EnvelopeRequest; onChange: (e: EnvelopeRequest) => void }) {
  const cb = useStore((s) => s.campbell)
  const rpmNow = useStore((s) => s.telemetry?.speed_rpm ?? null)
  const [box, size] = useSize<HTMLDivElement>()
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<'lo' | 'hi' | null>(null)
  const cur = p?.current.speed_rpm ?? rpmNow ?? env.hi_rpm
  const prop = p?.proposed.speed_rpm ?? null
  const lo0 = Math.min(env.lo_rpm, cur, prop ?? cur)
  const hi0 = Math.max(env.hi_rpm, cur, prop ?? cur)
  const dLo = Math.max(0, Math.floor((lo0 - 260) / 100) * 100)
  const dHi = Math.ceil((hi0 + 220) / 100) * 100
  const W = size.w
  const H = 66
  const l = 8
  const r = 8
  const pw = Math.max(10, W - l - r)
  const X = (v: number) => l + ((v - dLo) / (dHi - dLo)) * pw
  const inv = (x: number) => dLo + ((x - l) / pw) * (dHi - dLo)
  const y0 = 22
  const bh = 16
  const curve = p?.curve
  const thr = p?.risk?.threshold ?? 0.05

  const setFrom = (clientX: number) => {
    const el = svg.current
    if (!el || !drag.current) return
    const v = Math.round(clamp(inv(clientX - el.getBoundingClientRect().left), dLo, dHi) / 10) * 10
    if (drag.current === 'lo') onChange({ ...env, lo_rpm: Math.min(v, env.hi_rpm - 30) })
    else onChange({ ...env, hi_rpm: Math.max(v, env.lo_rpm + 30) })
  }
  const key = (which: 'lo' | 'hi') => (e: React.KeyboardEvent) => {
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -10 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 10 : 0
    if (!d) return
    e.preventDefault()
    if (which === 'lo') onChange({ ...env, lo_rpm: clamp(env.lo_rpm + d, dLo, env.hi_rpm - 30) })
    else onChange({ ...env, hi_rpm: clamp(env.hi_rpm + d, env.lo_rpm + 30, dHi) })
  }

  return (
    <div ref={box} className="w-full touch-none select-none">
      {W > 0 && (
        <svg
          ref={svg}
          width={W}
          height={H}
          className="block"
          onPointerMove={(e) => setFrom(e.clientX)}
          onPointerUp={() => (drag.current = null)}
          onPointerLeave={() => (drag.current = null)}
        >
          <defs>
            <pattern id="ev-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="5" stroke="rgba(242,72,75,.5)" strokeWidth="1.6" />
            </pattern>
          </defs>
          <rect x={l} y={y0} width={pw} height={bh} rx={2} fill="#121519" stroke="#283038" />
          {p?.feasible_band_rpm.map(([a, b], i) => (
            <rect key={`f${i}`} x={X(Math.max(a, dLo))} y={y0} width={Math.max(0, X(Math.min(b, dHi)) - X(Math.max(a, dLo)))} height={bh} fill="rgba(231,234,238,0.07)" />
          ))}
          {p?.exclusion_bands_rpm.map(([a, b], i) =>
            b < dLo || a > dHi ? null : <rect key={`e${i}`} x={X(Math.max(a, dLo))} y={y0} width={X(Math.min(b, dHi)) - X(Math.max(a, dLo))} height={bh} fill="url(#ev-hatch)" stroke="rgba(242,72,75,.4)" />,
          )}
          {/* P(resonance) heat strip */}
          {curve?.p_res &&
            curve.rpm.map((rp, i) => {
              if (rp < dLo || rp > dHi || i === curve.rpm.length - 1) return null
              const pr = curve.p_res![i]
              if (pr < thr * 0.2) return null
              const a = Math.min(1, pr)
              const fill = pr >= thr ? `rgba(242,72,75,${0.25 + 0.6 * a})` : `rgba(240,166,58,${0.2 + 0.5 * (pr / thr)})`
              return <rect key={`p${i}`} x={X(rp)} y={y0 + bh + 3} width={Math.max(1, X(curve.rpm[i + 1]) - X(rp))} height={3} fill={fill} />
            })}
          {cb?.criticals
            .filter((c) => c.rpm > dLo && c.rpm < dHi)
            .map((c, i) => (
              <line key={`c${i}`} x1={X(c.rpm)} x2={X(c.rpm)} y1={y0 - 3} y2={y0 + bh + 3} stroke="#f0a63a" />
            ))}
          {niceTicks(dLo, dHi, Math.max(3, Math.floor(pw / 64))).map((v) => (
            <text key={v} x={X(v)} y={H - 3} textAnchor="middle" fontSize={9.5} fill="#454d56" className="num">
              {v}
            </text>
          ))}
          {/* selection */}
          <rect x={X(env.lo_rpm)} y={y0 - 1} width={Math.max(1, X(env.hi_rpm) - X(env.lo_rpm))} height={bh + 2} fill="rgba(157,140,255,0.16)" stroke="#9d8cff" strokeWidth={1} />
          {(['lo', 'hi'] as const).map((w) => {
            const x = X(w === 'lo' ? env.lo_rpm : env.hi_rpm)
            return (
              <g
                key={w}
                tabIndex={0}
                role="slider"
                aria-label={w === 'lo' ? 'Envelope low speed' : 'Envelope high speed'}
                aria-valuenow={w === 'lo' ? env.lo_rpm : env.hi_rpm}
                onKeyDown={key(w)}
                onPointerDown={(e) => {
                  drag.current = w
                  ;(e.target as Element).setPointerCapture?.(e.pointerId)
                }}
                className="cursor-ew-resize outline-none [&:focus-visible>rect]:stroke-fg-1"
              >
                <rect x={x - 9} y={y0 - 8} width={18} height={bh + 16} fill="transparent" />
                <rect x={x - 3} y={y0 - 5} width={6} height={bh + 10} rx={2} fill="#9d8cff" stroke="#0d0f12" strokeWidth={1.5} />
                <text x={x} y={y0 - 9} textAnchor="middle" fontSize={9.5} fill="#c3b8ff" className="num" fontWeight={600}>
                  {w === 'lo' ? env.lo_rpm : env.hi_rpm}
                </text>
              </g>
            )
          })}
          {/* NOW + proposal */}
          <line x1={X(cur)} x2={X(cur)} y1={y0 - 2} y2={y0 + bh + 2} stroke="#e7eaee" strokeWidth={2} />
          {Math.abs(X(cur) - X(env.lo_rpm)) > 26 && Math.abs(X(cur) - X(env.hi_rpm)) > 26 && (
            <text x={X(cur)} y={y0 - 9} textAnchor="middle" fontSize={9} fill="#e7eaee" className="num">
              NOW
            </text>
          )}
          {prop != null && <rect x={X(prop) - 4} y={y0 + bh / 2 - 4} width={8} height={8} transform={`rotate(45 ${X(prop)} ${y0 + bh / 2})`} fill="#0d0f12" stroke="#c3b8ff" strokeWidth={1.25} />}
        </svg>
      )}
    </div>
  )
}

function EnvelopeEditor({ p, env, setEnv }: { p: ProposalEvent | null; env: EnvelopeRequest; setEnv: (e: EnvelopeRequest) => void }) {
  const cur = p?.current.speed_rpm ?? null
  const overlaps = (p?.exclusion_bands_rpm ?? []).filter(([a, b]) => a < env.hi_rpm && b > env.lo_rpm)
  const outside = cur != null && (cur < env.lo_rpm || cur > env.hi_rpm)
  return (
    <div className="flex flex-col gap-2.5">
      <div className="rounded-md border border-line-1 bg-bg-0/40 px-2 pb-1 pt-1.5">
        <div className="mb-0.5 flex items-center justify-between px-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-fg-4">
          <span>Operating envelope · rpm</span>
          <span className="flex items-center gap-2 normal-case tracking-normal">
            <span className="inline-flex items-center gap-1">
              <span className="h-[3px] w-3 bg-[rgba(242,72,75,.7)]" /> P(res) ≥ {((p?.risk?.threshold ?? 0.05) * 100).toFixed(0)}%
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-[3px] rounded-[1px] bg-warn" /> critical
            </span>
          </span>
        </div>
        <EnvelopeSlider p={p} env={env} onChange={setEnv} />
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <div>
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-fg-4">Envelope</div>
          <div className="num mt-0.5 text-[15px] text-fg-1">
            {env.lo_rpm}
            <span className="mx-1 text-fg-4">–</span>
            {env.hi_rpm}
            <span className="ml-1 text-[10.5px] text-fg-3">rpm</span>
            <span className="ml-2 text-[10.5px] text-fg-4">Δ {env.hi_rpm - env.lo_rpm}</span>
          </div>
        </div>
        <div className="flex flex-col items-end">
          <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-fg-4">Max step · rpm</div>
          <Seg value={env.max_step_rpm} onChange={(v) => setEnv({ ...env, max_step_rpm: v })} options={STEP_OPTIONS.map((v) => ({ v, label: String(v) }))} />
        </div>
      </div>
      <ul className="space-y-1 text-[11px] leading-snug text-fg-3">
        <li>The loop may write setpoints only inside this envelope, at most {env.max_step_rpm} rpm per step, then settles, measures and updates the twin before the next step.</li>
        {outside && (
          <li className="text-fg-2">
            First step moves from {Math.round(cur!)} rpm into the envelope, limited to {env.max_step_rpm} rpm.
          </li>
        )}
        {overlaps.map(([a, b]) => (
          <li key={a} className="flex items-start gap-1.5">
            <TriangleAlert size={11} className="mt-[2px] shrink-0 text-warn" />
            <span>
              Overlaps resonance band {Math.round(a)}–{Math.round(b)} rpm. The loop keeps P(resonance) ≤ {((p?.risk?.threshold ?? 0.05) * 100).toFixed(0)}% inside it.
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ───────────────────────── iteration trace ───────────────────────── */

function RtoTrace({ trace, t0, rto }: { trace: RtoSample[]; t0: number; rto: RtoEvent }) {
  const [box, size] = useSize<HTMLDivElement>()
  const W = size.w
  // joined late (no live samples): fall back to the per-iteration history
  const pts: RtoSample[] = useMemo(() => {
    if (trace.length >= 2) return trace
    return (rto.history ?? []).map((h) => ({ t: t0 + h.iteration, iteration: h.iteration, status: 'updating' as RtoStatus, setpoint_rpm: h.setpoint_rpm, speed_rpm: h.setpoint_rpm, pred: h.pred_vel, lo: null, hi: null, meas: h.meas_vel, kw: h.kw }))
  }, [trace, rto.history, t0])
  const byIter = trace.length < 2
  const M = { l: 40, r: 10, t: 16, b: 16 }
  const LA = 50
  const LB = 62
  const LC = 26
  const G = 10
  const H = M.t + LA + G + LB + G + LC + M.b
  const pw = Math.max(10, W - M.l - M.r)
  if (!pts.length) return <div ref={box} className="h-[60px] w-full" />

  const tEnd = Math.max(pts[pts.length - 1].t - t0, byIter ? 1 : 20)
  const xMax = isTerminal(rto.status) ? tEnd + (byIter ? 0.5 : 1) : tEnd + (byIter ? 0.5 : 4)
  const xMin = byIter ? 0.5 : 0
  const X = (t: number) => M.l + ((t - t0 - xMin) / (xMax - xMin)) * pw

  const [eLo, eHi] = rto.envelope_rpm
  const rpmVals = pts.flatMap((s) => [s.setpoint_rpm, s.speed_rpm])
  const aLo = Math.min(eLo, ...rpmVals) - 25
  const aHi = Math.max(eHi, ...rpmVals) + 25
  const yA0 = M.t
  const YA = (v: number) => yA0 + LA - ((v - aLo) / (aHi - aLo)) * LA
  const vVals = pts.flatMap((s) => [s.pred, s.hi ?? s.pred, s.meas ?? 0])
  const bHi = Math.max(1, ...vVals) * 1.12
  const yB0 = M.t + LA + G
  const YB = (v: number) => yB0 + LB - (Math.min(v, bHi) / bHi) * LB
  const kws = pts.map((s) => s.kw).filter((v): v is number => v != null)
  const kU = W_(Math.max(...kws, 0))
  const kLo = Math.min(...kws) * 0.97
  const kHi = Math.max(...kws) * 1.03 || 1
  const yC0 = yB0 + LB + G
  const YC = (v: number) => yC0 + LC - ((v - kLo) / (kHi - kLo || 1)) * LC

  const step = (get: (s: RtoSample) => number | null, Y: (v: number) => number) => {
    let d = ''
    let prev: number | null = null
    pts.forEach((s, i) => {
      const v = get(s)
      if (v == null) return
      const x = X(s.t)
      if (prev == null) d += `M${x.toFixed(1)},${Y(v).toFixed(1)}`
      else d += `H${x.toFixed(1)}V${Y(v).toFixed(1)}`
      prev = v
      if (i === pts.length - 1) d += `H${(X(s.t) + (isTerminal(rto.status) ? 0 : 2)).toFixed(1)}`
    })
    return d
  }
  const line = (get: (s: RtoSample) => number, Y: (v: number) => number) => pts.map((s, i) => `${i ? 'L' : 'M'}${X(s.t).toFixed(1)},${Y(get(s)).toFixed(1)}`).join('')
  // predicted 90% band, step-after
  const band = (() => {
    const seg = pts.filter((s) => s.lo != null && s.hi != null)
    if (seg.length < 2) return ''
    const top = seg.map((s, i) => `${i ? `H${X(s.t).toFixed(1)}V` : `M${X(s.t).toFixed(1)},`}${YB(s.hi!).toFixed(1)}`).join('')
    const last = seg[seg.length - 1]
    const rev = [...seg].reverse()
    const bot = rev.map((s, i) => `${i ? `V${YB(s.lo!).toFixed(1)}H${X(s.t).toFixed(1)}` : `H${X(last.t).toFixed(1)}V${YB(s.lo!).toFixed(1)}`}`).join('')
    return `${top}${bot}Z`
  })()
  const iterStarts = pts.filter((s, i) => i === 0 || s.iteration !== pts[i - 1].iteration)
  const meas = pts.filter((s, i) => s.meas != null && (i === 0 || pts[i - 1].meas == null || pts[i - 1].iteration !== s.iteration))

  return (
    <div ref={box} className="w-full">
      {W > 0 && (
        <svg width={W} height={H} className="block">
          <defs>
            <pattern id="rt-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="5" stroke="rgba(242,72,75,.28)" strokeWidth="1.6" />
            </pattern>
          </defs>
          {/* lane frames */}
          {[
            [yA0, LA, 'rpm'],
            [yB0, LB, 'mm/s'],
            [yC0, LC, kU.u],
          ].map(([y, h, u]) => (
            <g key={u as string}>
              <rect x={M.l} y={y as number} width={pw} height={h as number} fill="rgba(7,8,10,0.35)" stroke="#1c2127" />
              <text x={M.l + 4} y={(y as number) + 9} fontSize={8.5} fill="#6c7580" className="num">
                {u}
              </text>
            </g>
          ))}
          {/* iteration dividers */}
          {iterStarts.map((s) => (
            <g key={`i${s.iteration}`}>
              <line x1={X(s.t)} x2={X(s.t)} y1={M.t - 2} y2={yC0 + LC} stroke="#21262c" />
              <text x={X(s.t) + 3} y={M.t - 5} fontSize={9} fill={s.iteration === rto.iteration && !isTerminal(rto.status) ? '#c3b8ff' : '#6c7580'} className="num" fontWeight={600}>
                {s.iteration}
              </text>
            </g>
          ))}
          <text x={M.l - 5} y={M.t - 5} textAnchor="end" fontSize={8.5} fill="#454d56" className="num">
            it
          </text>

          {/* lane A: envelope, setpoint, speed */}
          {useStore.getState().proposal?.exclusion_bands_rpm.map(([a, b], i) =>
            b < aLo || a > aHi ? null : <rect key={`x${i}`} x={M.l} width={pw} y={YA(Math.min(b, aHi))} height={YA(Math.max(a, aLo)) - YA(Math.min(b, aHi))} fill="url(#rt-hatch)" />,
          )}
          {[eLo, eHi].map((v, i) => (
            <g key={`env${i}`}>
              <line x1={M.l} x2={M.l + pw} y1={YA(v)} y2={YA(v)} stroke="rgba(157,140,255,.45)" strokeDasharray="4 3" />
              <text x={M.l - 5} y={YA(v) + 3.5} textAnchor="end" fontSize={9} fill="#a2abb5" className="num">
                {v}
              </text>
            </g>
          ))}
          <path d={line((s) => s.speed_rpm, YA)} fill="none" stroke="#d8dee6" strokeWidth={1} strokeOpacity={0.85} />
          <path d={step((s) => s.setpoint_rpm, YA)} fill="none" stroke="#9d8cff" strokeWidth={1.5} />

          {/* lane B: predicted band + line, measured points, ISO B/C line */}
          {ISO_BOUNDS.BC < bHi && <line x1={M.l} x2={M.l + pw} y1={YB(ISO_BOUNDS.BC)} y2={YB(ISO_BOUNDS.BC)} stroke="rgba(240,166,58,.35)" strokeDasharray="2 3" />}
          {ISO_BOUNDS.BC < bHi && (
            <text x={M.l + pw - 3} y={YB(ISO_BOUNDS.BC) - 3} textAnchor="end" fontSize={8.5} fill="rgba(240,166,58,.7)" className="num">
              B/C
            </text>
          )}
          {band && <path d={band} fill="rgba(157,140,255,0.14)" />}
          <path d={step((s) => s.pred, YB)} fill="none" stroke="#c3b8ff" strokeWidth={1.25} strokeDasharray="4 2" />
          {meas.map((s) => (
            <g key={`m${s.iteration}`}>
              <circle cx={X(s.t)} cy={YB(s.meas!)} r={3.25} fill="#e7eaee" stroke="#0d0f12" strokeWidth={1.25} />
            </g>
          ))}
          {niceTicks(0, bHi, 2)
            .filter((v) => v > 0 && v < bHi)
            .map((v) => (
              <text key={`bt${v}`} x={M.l - 5} y={YB(v) + 3.5} textAnchor="end" fontSize={9} fill="#454d56" className="num">
                {v}
              </text>
            ))}

          {/* lane C: power */}
          <path d={step((s) => s.kw, YC)} fill="none" stroke="#7b8693" strokeWidth={1.25} />
          <text x={M.l - 5} y={yC0 + LC + 1} textAnchor="end" fontSize={9} fill="#454d56" className="num">
            {(kLo * (kU.u === 'W' ? 1000 : 1)).toFixed(0)}
          </text>

          {/* x axis */}
          {!byIter &&
            niceTicks(0, xMax, Math.max(3, Math.floor(pw / 70)))
              .filter((v) => v >= 0 && v <= xMax)
              .map((v) => (
                <text key={`t${v}`} x={X(t0 + v)} y={H - 3} textAnchor="middle" fontSize={9} fill="#454d56" className="num">
                  {v}s
                </text>
              ))}
        </svg>
      )}
    </div>
  )
}

/* ───────────────────────── model update table ───────────────────────── */

function SdBar({ now, start }: { now: number; start: number }) {
  const f = start > 0 ? clamp(now / start, 0, 1) : 1
  return (
    <span className="relative inline-block h-[5px] w-[54px] rounded-[1px] border border-line-2 bg-bg-0" title={`σ ${(f * 100).toFixed(0)}% of the first iteration`}>
      <span className="absolute inset-y-0 left-0 bg-trace-2" style={{ width: `${f * 100}%` }} />
    </span>
  )
}

function ModelTable({ rto, model0 }: { rto: RtoEvent; model0: RtoEvent['model'] | null }) {
  const m = rto.model
  if (!m) return null
  const rows: { k: string; v: string; sd: string; now: number; start: number; u?: string }[] = []
  m.modes.forEach((md, i) => {
    const s0 = model0?.modes[i]
    rows.push({ k: `M${i + 1} f`, v: md.f_hz.toFixed(2), sd: md.f_sd.toFixed(2), now: md.f_sd, start: s0?.f_sd ?? md.f_sd, u: 'Hz' })
    if (md.zeta != null) rows.push({ k: `M${i + 1} ζ`, v: md.zeta.toFixed(3), sd: md.zeta_sd != null ? md.zeta_sd.toFixed(3) : '—', now: md.zeta_sd ?? 0, start: s0?.zeta_sd ?? md.zeta_sd ?? 0 })
  })
  if (m.gain_1x != null) rows.push({ k: '1× gain', v: m.gain_1x.toFixed(2), sd: m.gain_sd != null ? m.gain_sd.toFixed(2) : '—', now: m.gain_sd ?? 0, start: model0?.gain_sd ?? m.gain_sd ?? 0 })
  return (
    <table className="w-full border-separate border-spacing-0 overflow-hidden rounded-md border border-line-1 text-[11px]">
      <thead>
        <tr className="text-[9px] font-semibold uppercase tracking-[0.08em] text-fg-4">
          <th className="bg-bg-2 px-2 py-[3px] text-left font-semibold">Twin</th>
          <th className="bg-bg-2 px-2 py-[3px] text-right font-semibold">
            Estimate ± <span className="normal-case">σ</span>
          </th>
          <th className="bg-bg-2 px-2 py-[3px] text-left font-semibold">
            <span className="normal-case">σ</span> vs it 1
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const drop = r.start > 0 ? (r.now / r.start - 1) * 100 : 0
          return (
            <tr key={r.k} className="[&>td]:border-t [&>td]:border-line-1">
              <td className="px-2 py-[3px] text-fg-3">{r.k}</td>
              <td className="num px-2 py-[3px] text-right text-fg-1">
                {r.v}
                <span className="text-fg-3"> ± {r.sd}</span>
                {r.u && <span className="ml-1 text-[9.5px] text-fg-4">{r.u}</span>}
              </td>
              <td className="px-2 py-[3px]">
                <span className="flex items-center gap-1.5">
                  <SdBar now={r.now} start={r.start} />
                  <span className="num text-[10px] text-fg-3">{Math.abs(drop) < 0.5 ? '—' : `${drop < 0 ? '−' : '+'}${Math.abs(drop).toFixed(0)}%`}</span>
                </span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/* ───────────────────────── panel ───────────────────────── */

function Cell({ k, children, sub }: { k: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-bg-2 px-2.5 py-1.5">
      <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-fg-4">{k}</div>
      <div className="num mt-0.5 truncate text-[14px] leading-tight text-fg-1">{children}</div>
      {sub && <div className="num truncate text-[10px] text-fg-3">{sub}</div>}
    </div>
  )
}

export function SourceLabel({ source }: { source?: string | null }) {
  return (
    <span className="num inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-[4px] border border-line-2 bg-bg-2 px-1.5 text-[10px] text-fg-2" title="What the closed loop is actually driving">
      <Cpu size={10} className="shrink-0 text-fg-3" />
      <span className="text-fg-4">source</span>
      <span>{source ?? 'reported on start'}</span>
    </span>
  )
}

export function ClosedLoop() {
  const p = useStore((s) => s.proposal)
  const rto = useStore((s) => s.rto)
  const trace = useStore((s) => s.rtoTrace)
  const run = useStore((s) => s.rtoRun)
  const envStatus = useStore((s) => s.envelopeStatus)
  const [env, setEnv] = useState<EnvelopeRequest>(() => (rto ? { lo_rpm: rto.envelope_rpm[0], hi_rpm: rto.envelope_rpm[1], max_step_rpm: rto.max_step_rpm, approved: true } : defaultEnvelope(p)))
  const [editing, setEditing] = useState(false)

  const active = !!rto && !isTerminal(rto.status)
  const showEditor = (!rto && envStatus !== 'submitting' && envStatus !== 'approved') || (rto && isTerminal(rto.status) && editing)
  const waiting = !rto && (envStatus === 'submitting' || envStatus === 'approved')
  const last = rto?.history?.[rto.history.length - 1]
  const err = last && last.meas_vel ? (last.pred_vel / last.meas_vel - 1) * 100 : null
  const kw = rto ? W_(rto.measured?.kw ?? rto.predicted.kw) : null

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-3">
          <div className="flex flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {rto ? <RtoStatusChip rto={rto} /> : <Chip tone="muted">{waiting ? 'Starting…' : 'Not running'}</Chip>}
              <span className="ml-auto">
                <SourceLabel source={rto?.source} />
              </span>
            </div>
            <span className="num text-[10.5px] text-fg-3">
              {rto ? `envelope ${rto.envelope_rpm[0]}–${rto.envelope_rpm[1]} rpm · step ≤ ${rto.max_step_rpm} rpm · objective ${p?.objective ?? 'J'}` : 'objective: ' + (p?.objective ?? 'min specific energy')}
            </span>
          </div>

          {showEditor && <EnvelopeEditor p={p} env={env} setEnv={setEnv} />}

          {waiting && <div className="rounded-md border border-line-1 bg-bg-2 px-3 py-6 text-center text-[11.5px] text-fg-3">Envelope sent · waiting for the first iteration…</div>}

          {rto && !showEditor && (
            <>
              {active && <PhaseRail status={rto.status} />}
              <div className="grid grid-cols-[0.9fr_1.35fr_1fr] gap-px overflow-hidden rounded-md border border-line-1 bg-line-1">
                <Cell k="Setpoint" sub={`speed ${Math.round(rto.speed_rpm)} rpm`}>
                  <span className="text-accent-2">{Math.round(rto.setpoint_rpm)}</span>
                  <span className="ml-1 text-[10px] text-fg-3">rpm</span>
                </Cell>
                <Cell
                  k="Vibration"
                  sub={
                    rto.predicted.vel_lo != null && rto.predicted.vel_hi != null ? (
                      <>
                        pred {fx(rto.predicted.vel_mm_s, 2)} [{fx(rto.predicted.vel_lo, 1)}–{fx(rto.predicted.vel_hi, 1)}]
                      </>
                    ) : (
                      <>pred {fx(rto.predicted.vel_mm_s, 2)}</>
                    )
                  }
                >
                  {rto.measured ? fx(rto.measured.vel_mm_s, 2) : <span className="text-fg-3">{fx(rto.predicted.vel_mm_s, 2)}</span>}
                  <span className="ml-1 text-[10px] text-fg-3">{rto.measured ? 'mm/s meas' : 'mm/s pred'}</span>
                </Cell>
                <Cell k="Power" sub={rto.objective ? `J ${fx(rto.objective.j, 3)}${err != null ? ` · err ${err >= 0 ? '+' : '−'}${Math.abs(err).toFixed(0)}%` : ''}` : undefined}>
                  {kw && fx(kw.v, kw.d)}
                  <span className="ml-1 text-[10px] text-fg-3">{kw?.u}</span>
                </Cell>
              </div>

              <div className="rounded-md border border-line-1 bg-bg-0/40 px-2 pt-1.5">
                <div className="mb-0.5 flex items-center justify-between gap-2 whitespace-nowrap px-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-fg-4">
                  <span>Trace</span>
                  <span className="flex items-center gap-2 overflow-hidden normal-case tracking-normal">
                    <span className="inline-flex items-center gap-1">
                      <span className="h-[2px] w-3 bg-accent" /> setpoint
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-[1px] w-3 bg-trace-1" /> speed
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-3 border-t border-dashed border-accent-2 bg-[rgba(157,140,255,.16)]" /> pred ±90%
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-fg-1" /> meas
                    </span>
                  </span>
                </div>
                <RtoTrace trace={trace} t0={run.t0} rto={rto} />
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between text-[9.5px] font-semibold uppercase tracking-[0.08em] text-fg-4">
                  <span>Model update · twin uncertainty</span>
                  <span className="num normal-case tracking-normal text-fg-4">{rto.history?.length ?? 0} measured</span>
                </div>
                <ModelTable rto={rto} model0={run.model0} />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line-1 bg-bg-1 p-3">
        {showEditor && (
          <div className="flex flex-col gap-1.5">
            <Btn size="lg" variant="accent" disabled={envStatus === 'submitting'} onClick={() => void link.approveEnvelope({ ...env, approved: true }).then(() => setEditing(false))}>
              <Play size={15} /> Approve envelope {env.lo_rpm}–{env.hi_rpm} rpm
            </Btn>
            <div className="num text-center text-[10px] text-fg-4">step ≤ {env.max_step_rpm} rpm · you can stop the loop at any time</div>
          </div>
        )}
        {(active || waiting) && (
          <div className="flex flex-col gap-1.5">
            <Btn size="lg" variant="danger" disabled={envStatus === 'stopping'} onClick={() => void link.stopRto()}>
              <CircleStop size={15} /> {envStatus === 'stopping' ? 'Stopping…' : 'Stop closed loop'}
            </Btn>
            <div className="num text-center text-[10px] text-fg-4">holds the last setpoint · POST /rto/stop</div>
          </div>
        )}
        {rto && isTerminal(rto.status) && !editing && (
          <div className={cx('anim-in rounded-md border p-2.5', rto.status === 'converged' ? 'border-[rgba(60,191,138,.35)] bg-[var(--ok-dim)]' : 'border-[rgba(242,72,75,.4)] bg-[var(--alarm-dim)]')}>
            <div className="flex items-center gap-2">
              {rto.status === 'converged' ? <CircleCheck size={15} className="text-ok" /> : <CircleX size={15} className="text-alarm" />}
              <span className={cx('text-[12px] font-semibold tracking-[0.04em]', rto.status === 'converged' ? 'text-ok' : 'text-alarm')}>
                {rto.status === 'converged' ? 'CONVERGED' : 'ABORTED'} · {Math.round(rto.setpoint_rpm)} rpm
              </span>
              <span className="num text-[10.5px] text-fg-3">it {rto.iteration}</span>
              <Btn
                size="xs"
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  setEnv({ lo_rpm: rto.envelope_rpm[0], hi_rpm: rto.envelope_rpm[1], max_step_rpm: rto.max_step_rpm, approved: true })
                  setEditing(true)
                }}
              >
                New envelope
              </Btn>
            </div>
            {rto.reason && <div className="num mt-1 text-[10.5px] leading-snug text-fg-2">{rto.reason}</div>}
          </div>
        )}
      </div>
    </>
  )
}

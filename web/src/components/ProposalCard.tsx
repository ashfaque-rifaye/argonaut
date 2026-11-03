import { useState } from 'react'
import { ArrowRight, Check, CircleCheck, CircleX, LoaderCircle, ShieldCheck, Sigma, TrendingDown, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { link } from '../lib/socket'
import { fx, ISO_BOUNDS, niceTicks, pct } from '../lib/format'
import { useSize } from '../lib/useSize'
import type { ProposalEvent } from '../lib/protocol'
import { IsoBar, isoPos } from './IsoBar'
import { ClosedLoop, RtoStatusChip } from './ClosedLoop'
import { Btn, Chip, cx, Panel, Tip } from './ui'

const rpmTxt = (v: number) => `${Math.round(v)}`

function interp(xs: number[], ys: number[], x: number) {
  if (!xs.length) return 0
  if (x <= xs[0]) return ys[0]
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1] || 1)
  return ys[ys.length - 1]
}

/** Predicted vibration + power vs speed with constraints: the optimizer's objective landscape. */
function ObjectiveChart({ p }: { p: ProposalEvent }) {
  const curve = p.curve!
  const cb = useStore((s) => s.campbell)
  const rpm = useStore((s) => s.telemetry?.speed_rpm ?? null)
  const [box, size] = useSize<HTMLDivElement>()
  const W = size.w
  const hasRisk = !!curve.p_res && curve.p_res.length === curve.rpm.length
  const hasBand = !!curve.vel_lo && !!curve.vel_hi && curve.vel_lo.length === curve.rpm.length && curve.vel_hi.length === curve.rpm.length
  const LANE = hasRisk ? 30 : 0
  const H = (hasRisk ? 146 : 168) + (hasRisk ? LANE + 8 : 0)
  const M = { l: 30, r: 34, t: 22, b: 30 + (hasRisk ? LANE + 8 : 0) }
  const pw = Math.max(10, W - M.l - M.r)
  const ph = H - M.t - M.b
  const xMax = Math.max(...curve.rpm, p.current.speed_rpm) * 1.03
  const xMin = 0
  const vMax = Math.max(...curve.vel.filter(Number.isFinite), p.current.vel_mm_s, ...(hasBand ? curve.vel_hi!.filter(Number.isFinite).map((v) => v * 0.85) : [])) * 1.12
  const kMax = Math.max(...curve.kw.filter(Number.isFinite), p.current.kw) * 1.1
  const X = (v: number) => M.l + ((v - xMin) / (xMax - xMin)) * pw
  const Y = (v: number) => M.t + ph - (Math.min(v, vMax) / vMax) * ph
  const YK = (k: number) => M.t + ph - (k / kMax) * ph
  const vPath = curve.rpm.map((r, i) => `${i ? 'L' : 'M'}${X(r).toFixed(1)},${Y(curve.vel[i]).toFixed(1)}`).join('')
  const kPath = curve.rpm.map((r, i) => `${i ? 'L' : 'M'}${X(r).toFixed(1)},${YK(curve.kw[i]).toFixed(1)}`).join('')
  const bandPath = hasBand
    ? curve.rpm.map((r, i) => `${i ? 'L' : 'M'}${X(r).toFixed(1)},${Y(curve.vel_hi![i]).toFixed(1)}`).join('') +
      [...curve.rpm].reverse().map((r, j) => `L${X(r).toFixed(1)},${Y(curve.vel_lo![curve.rpm.length - 1 - j]).toFixed(1)}`).join('') +
      'Z'
    : ''
  // P(resonance) lane on a log scale 0.1 % … 100 %
  const thr = p.risk?.threshold ?? 0.05
  const laneTop = M.t + ph + 30
  const YR = (v: number) => laneTop + LANE - ((Math.log10(Math.max(v, 1e-3)) + 3) / 3) * LANE
  const rPath = hasRisk ? curve.rpm.map((r, i) => `${i ? 'L' : 'M'}${X(r).toFixed(1)},${YR(curve.p_res![i]).toFixed(1)}`).join('') : ''
  const rArea = hasRisk ? `${rPath}L${X(curve.rpm[curve.rpm.length - 1])},${laneTop + LANE}L${X(curve.rpm[0])},${laneTop + LANE}Z` : ''
  const pNow = p.risk?.p_res_current ?? (hasRisk ? interp(curve.rpm, curve.p_res!, p.current.speed_rpm) : 0)
  const pNew = p.risk?.p_res_proposed ?? (hasRisk ? interp(curve.rpm, curve.p_res!, p.proposed.speed_rpm) : 0)
  const zones = [
    { lo: 0, hi: ISO_BOUNDS.AB, fill: 'transparent', z: 'A' },
    { lo: ISO_BOUNDS.AB, hi: ISO_BOUNDS.BC, fill: 'rgba(231,234,238,0.025)', z: 'B' },
    { lo: ISO_BOUNDS.BC, hi: ISO_BOUNDS.CD, fill: 'rgba(240,166,58,0.06)', z: 'C' },
    { lo: ISO_BOUNDS.CD, hi: 1e9, fill: 'rgba(242,72,75,0.08)', z: 'D' },
  ].filter((z) => z.lo < vMax)
  const cx0 = X(p.current.speed_rpm)
  const cy0 = Y(p.current.vel_mm_s)
  const cx1 = X(p.proposed.speed_rpm)
  const cy1 = Y(p.proposed.vel_mm_s)
  const live = rpm != null && rpm > 1 ? { x: X(rpm), y: Y(interp(curve.rpm, curve.vel, rpm)) } : null
  return (
    <div ref={box} className="w-full">
      {W > 0 && (
        <svg width={W} height={H} className="block">
          <defs>
            <pattern id="oc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(242,72,75,.28)" strokeWidth="2" />
            </pattern>
            <linearGradient id="oc-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="rgba(216,222,230,.16)" />
              <stop offset="1" stopColor="rgba(216,222,230,0)" />
            </linearGradient>
            <marker id="oc-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 Z" fill="#9d8cff" />
            </marker>
            <clipPath id="oc-clip">
              <rect x={M.l} y={M.t} width={pw} height={ph} />
            </clipPath>
            <clipPath id="oc-above">
              <rect x={M.l} y={laneTop - 1} width={pw} height={Math.max(0, YR(thr) - laneTop + 1)} />
            </clipPath>
            <clipPath id="oc-below">
              <rect x={M.l} y={YR(thr)} width={pw} height={Math.max(0, laneTop + LANE - YR(thr))} />
            </clipPath>
          </defs>
          {/* ISO zone bands */}
          {zones.map((z) => (
            <g key={z.z}>
              <rect x={M.l} width={pw} y={Y(Math.min(z.hi, vMax))} height={Math.max(0, Y(z.lo) - Y(Math.min(z.hi, vMax)))} fill={z.fill} />
              {z.lo > 0 && <line x1={M.l} x2={M.l + pw} y1={Y(z.lo)} y2={Y(z.lo)} stroke={z.z === 'C' ? 'rgba(240,166,58,.35)' : z.z === 'D' ? 'rgba(242,72,75,.4)' : '#1c2127'} strokeDasharray="2 3" />}
              <text x={M.l + pw - 3} y={Y(Math.min(z.hi, vMax)) + 10} textAnchor="end" fontSize={8.5} fill={z.z === 'C' ? 'rgba(240,166,58,.7)' : z.z === 'D' ? 'rgba(242,72,75,.75)' : '#454d56'} className="num" fontWeight={600}>
                {z.z}
              </text>
            </g>
          ))}
          {niceTicks(0, vMax, 3).map((v) => (
            <text key={`v${v}`} x={M.l - 5} y={Y(v) + 3.5} textAnchor="end" fontSize={9.5} fill="#6c7580" className="num">
              {v}
            </text>
          ))}
          {niceTicks(0, kMax * 1000, 3).map((w) => (
            <text key={`k${w}`} x={M.l + pw + 5} y={YK(w / 1000) + 3.5} fontSize={9.5} fill="#454d56" className="num">
              {w}
            </text>
          ))}
          {niceTicks(xMin, xMax, Math.max(3, Math.floor(pw / 70))).map((r) => (
            <text key={`x${r}`} x={X(r)} y={M.t + ph + 17} textAnchor="middle" fontSize={9.5} fill="#6c7580" className="num">
              {r}
            </text>
          ))}
          <text x={M.l - 5} y={M.t - 8} textAnchor="end" fontSize={9} fill="#6c7580" className="num">
            mm/s
          </text>
          <text x={M.l + pw + 5} y={M.t - 8} fontSize={9} fill="#454d56" className="num">
            W
          </text>

          <g clipPath="url(#oc-clip)">
            {p.exclusion_bands_rpm.map(([a, b], i) => (
              <rect key={`e${i}`} x={X(a)} y={M.t} width={Math.max(1, X(b) - X(a))} height={ph} fill="url(#oc-hatch)" />
            ))}
            {hasBand ? (
              <path d={bandPath} fill="rgba(216,222,230,0.13)" stroke="rgba(216,222,230,0.22)" strokeWidth={0.75} />
            ) : (
              <path d={`${vPath}L${X(curve.rpm[curve.rpm.length - 1])},${M.t + ph}L${X(curve.rpm[0])},${M.t + ph}Z`} fill="url(#oc-fill)" />
            )}
            <path d={kPath} fill="none" stroke="#6c7580" strokeWidth={1} strokeDasharray="4 3" />
            <path d={vPath} fill="none" stroke="#d8dee6" strokeWidth={1.5} strokeLinejoin="round" />
          </g>
          {/* feasible band strip + criticals on the speed axis */}
          <rect x={M.l} y={M.t + ph + 2} width={pw} height={4} fill="#121519" />
          {p.feasible_band_rpm.map(([a, b], i) => (
            <rect key={`f${i}`} x={X(a)} y={M.t + ph + 2} width={Math.max(1, X(b) - X(a))} height={4} fill="#5b6470" />
          ))}
          {cb?.criticals
            .filter((c) => c.rpm < xMax && c.order <= 2)
            .map((c, i) => (
              <path key={`c${i}`} d={`M${X(c.rpm) - 3},${M.t + ph + 11} L${X(c.rpm) + 3},${M.t + ph + 11} L${X(c.rpm)},${M.t + ph + 7} Z`} fill="#f0a63a" />
            ))}

          {/* move arrow */}
          <path d={`M${cx0},${cy0 - 6} Q${(cx0 + cx1) / 2},${Math.min(cy0, cy1) - 26} ${cx1 + 4},${cy1 - 7}`} fill="none" stroke="#9d8cff" strokeWidth={1.25} markerEnd="url(#oc-arrow)" />
          {/* current */}
          <line x1={cx0} x2={cx0} y1={M.t} y2={M.t + ph} stroke="#e7eaee" strokeOpacity={0.5} />
          <circle cx={cx0} cy={cy0} r={4} fill="#e7eaee" stroke="#0d0f12" strokeWidth={1.5} />
          <text x={cx0 + (cx0 >= cx1 ? 4 : -4)} y={M.t - 8} textAnchor={cx0 >= cx1 ? 'start' : 'end'} fontSize={9.5} fill="#e7eaee" fontWeight={600} className="num">
            NOW {rpmTxt(p.current.speed_rpm)}
          </text>
          {/* proposed */}
          <line x1={cx1} x2={cx1} y1={M.t} y2={M.t + ph} stroke="#9d8cff" strokeDasharray="3 3" />
          <rect x={cx1 - 5} y={cy1 - 5} width={10} height={10} transform={`rotate(45 ${cx1} ${cy1})`} fill="#9d8cff" stroke="#0d0f12" strokeWidth={1.5} />
          <text x={cx1 + (cx0 >= cx1 ? -4 : 4)} y={M.t - 8} textAnchor={cx0 >= cx1 ? 'end' : 'start'} fontSize={9.5} fill="#c3b8ff" fontWeight={600} className="num">
            {p.id.toUpperCase()} {rpmTxt(p.proposed.speed_rpm)}
          </text>
          {live && Math.abs(live.x - cx0) > 3 && Math.abs(live.x - cx1) > 3 && <circle cx={live.x} cy={live.y} r={3} fill="none" stroke="#e7eaee" />}

          {hasRisk && (
            <g>
              <rect x={M.l} y={laneTop} width={pw} height={LANE} fill="rgba(7,8,10,0.35)" stroke="#1c2127" />
              <g clipPath="url(#oc-above)">
                <path d={rArea} fill="rgba(242,72,75,0.32)" />
                <path d={rPath} fill="none" stroke="#f2484b" strokeWidth={1} />
              </g>
              <g clipPath="url(#oc-below)">
                <path d={rArea} fill="rgba(108,117,128,0.22)" />
                <path d={rPath} fill="none" stroke="#6c7580" strokeWidth={1} />
              </g>
              <line x1={M.l} x2={M.l + pw} y1={YR(thr)} y2={YR(thr)} stroke="#a2abb5" strokeDasharray="3 2" strokeWidth={0.75} />
              <text x={M.l + pw + 4} y={YR(thr) + 3} fontSize={8.5} fill="#a2abb5" className="num">
                {(thr * 100).toFixed(0)}%
              </text>
              <text x={M.l + pw + 4} y={laneTop + 7} fontSize={8} fill="#454d56" className="num">
                100
              </text>
              <text x={M.l - 5} y={laneTop + 8} textAnchor="end" fontSize={8.5} fill="#6c7580" className="num">
                P
              </text>
              <text x={M.l - 5} y={laneTop + 18} textAnchor="end" fontSize={7.5} fill="#454d56" className="num">
                res
              </text>
              <line x1={cx0} x2={cx0} y1={laneTop} y2={laneTop + LANE} stroke="#e7eaee" strokeOpacity={0.5} />
              <circle cx={cx0} cy={YR(pNow)} r={2.75} fill="#e7eaee" stroke="#0d0f12" />
              <line x1={cx1} x2={cx1} y1={laneTop} y2={laneTop + LANE} stroke="#9d8cff" strokeDasharray="3 3" />
              <rect x={cx1 - 3.5} y={YR(pNew) - 3.5} width={7} height={7} transform={`rotate(45 ${cx1} ${YR(pNew)})`} fill="#9d8cff" stroke="#0d0f12" />
            </g>
          )}
        </svg>
      )}
    </div>
  )
}

function SpeedAxis({ p }: { p: ProposalEvent }) {
  const cb = useStore((s) => s.campbell)
  const [box, size] = useSize<HTMLDivElement>()
  const W = size.w
  const H = 66
  const l = 8
  const r = 8
  const max = Math.max(1800, p.current.speed_rpm * 1.1)
  const X = (v: number) => l + (v / max) * (W - l - r)
  const y0 = 26
  const bh = 14
  return (
    <div ref={box} className="w-full">
      {W > 0 && (
        <svg width={W} height={H} className="block">
          <defs>
            <pattern id="pa-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="5" stroke="rgba(242,72,75,.5)" strokeWidth="1.6" />
            </pattern>
          </defs>
          <rect x={X(0)} y={y0} width={X(max) - X(0)} height={bh} rx={2} fill="#121519" stroke="#283038" />
          {p.feasible_band_rpm.map(([a, b], i) => (
            <rect key={`f${i}`} x={X(a)} y={y0} width={X(b) - X(a)} height={bh} fill="rgba(231,234,238,0.10)" stroke="#5b6470" />
          ))}
          {p.exclusion_bands_rpm.map(([a, b], i) => (
            <rect key={`e${i}`} x={X(a)} y={y0} width={X(b) - X(a)} height={bh} fill="url(#pa-hatch)" stroke="rgba(242,72,75,.45)" />
          ))}
          {cb?.criticals
            .filter((c) => c.rpm < max)
            .map((c, i) => (
              <line key={`c${i}`} x1={X(c.rpm)} x2={X(c.rpm)} y1={y0 - 3} y2={y0 + bh + 3} stroke="#f0a63a" strokeWidth={1} />
            ))}
          {niceTicks(0, max, 6).map((v) => (
            <text key={v} x={X(v)} y={H - 4} textAnchor="middle" fontSize={9.5} fill="#454d56" className="num">
              {v}
            </text>
          ))}
          <line x1={X(p.current.speed_rpm)} x2={X(p.proposed.speed_rpm) + 6} y1={y0 + bh / 2} y2={y0 + bh / 2} stroke="#9d8cff" strokeWidth={1.5} />
          <g transform={`translate(${X(p.current.speed_rpm)} 0)`}>
            <line y1={y0 - 6} y2={y0 + bh + 2} stroke="#e7eaee" strokeWidth={2} />
            <text y={y0 - 10} textAnchor="middle" fontSize={9.5} fill="#e7eaee" className="num" fontWeight={600}>
              NOW {rpmTxt(p.current.speed_rpm)}
            </text>
          </g>
          <g transform={`translate(${X(p.proposed.speed_rpm)} 0)`}>
            <rect x={-5} y={y0 + bh / 2 - 5} width={10} height={10} transform={`rotate(45 0 ${y0 + bh / 2})`} fill="#9d8cff" stroke="#0d0f12" />
            <text y={y0 - 10} textAnchor="middle" fontSize={9.5} fill="#c3b8ff" className="num" fontWeight={600}>
              {p.id.toUpperCase()} {rpmTxt(p.proposed.speed_rpm)}
            </text>
          </g>
        </svg>
      )}
    </div>
  )
}

function RiskRow({ cur, prop, thr }: { cur: number; prop: number; thr: number }) {
  const f = (v: number) => (v < 0.001 ? '<0.1%' : v < 0.1 ? `${(v * 100).toFixed(1)}%` : `${(v * 100).toFixed(0)}%`)
  return (
    <div className="col-span-2 flex items-baseline gap-2 bg-bg-1 px-3 py-[5px]">
      <span className="w-[62px] text-[10.5px] text-fg-3">P(res)</span>
      <span className={cx('num text-[12.5px]', cur > thr ? 'text-alarm' : 'text-fg-2')}>{f(cur)}</span>
      <ArrowRight size={11} className="self-center text-fg-4" />
      <span className={cx('num text-[13.5px] font-medium', prop > thr ? 'text-alarm' : 'text-accent-2')}>{f(prop)}</span>
      <span className="num ml-auto text-[10px] text-fg-4">gate ≤ {(thr * 100).toFixed(0)}%</span>
    </div>
  )
}

function Transition({ k, c, n, u, d }: { k: string; c: number; n: number; u: string; d: number }) {
  return (
    <div className="col-span-2 flex items-baseline gap-2 bg-bg-1 px-3 py-[5px]">
      <span className="w-[62px] text-[10.5px] text-fg-3">{k}</span>
      <span className="num text-[12.5px] text-fg-2">{c.toFixed(d)}</span>
      <ArrowRight size={11} className="self-center text-fg-4" />
      <span className="num text-[13.5px] font-medium text-accent-2">{n.toFixed(d)}</span>
      <span className="num text-[10px] text-fg-4">{u}</span>
    </div>
  )
}

const fp = (p: number) => (p < 0.0001 ? '< 0.0001' : p < 0.001 ? p.toFixed(4) : p < 0.01 ? p.toFixed(3) : p.toFixed(2))

/** Before / after 90% CIs on the ISO 20816 scale, with the prediction. */
function CiCompare({ before, after, beforeV, afterV, pred }: { before: [number, number]; after: [number, number]; beforeV?: number; afterV: number; pred: number }) {
  const [box, size] = useSize<HTMLDivElement>()
  const W = size.w
  const l = 44
  const r = 6
  const pw = Math.max(10, W - l - r)
  const X = (v: number) => l + isoPos(v) * pw
  const rows = [
    { k: 'before', ci: before, v: beforeV ?? (before[0] + before[1]) / 2, c: '#7b8693', y: 9 },
    { k: 'after', ci: after, v: afterV, c: '#e7eaee', y: 25 },
  ]
  return (
    <div ref={box} className="w-full">
      {W > 0 && (
        <svg width={W} height={36} className="block">
          {['#20262d', '#2a3139', '#3a2f1c', '#3d1d1f'].map((f, i) => (
            <rect key={f} x={l + (i / 4) * pw} y={1} width={pw / 4 - 1} height={32} fill={f} opacity={0.45} />
          ))}
          {rows.map((rw) => (
            <g key={rw.k}>
              <text x={l - 6} y={rw.y + 3.5} textAnchor="end" fontSize={9} fill="#6c7580" className="num">
                {rw.k}
              </text>
              <line x1={X(rw.ci[0])} x2={X(rw.ci[1])} y1={rw.y} y2={rw.y} stroke={rw.c} strokeWidth={1.25} />
              <line x1={X(rw.ci[0])} x2={X(rw.ci[0])} y1={rw.y - 4} y2={rw.y + 4} stroke={rw.c} strokeWidth={1.25} />
              <line x1={X(rw.ci[1])} x2={X(rw.ci[1])} y1={rw.y - 4} y2={rw.y + 4} stroke={rw.c} strokeWidth={1.25} />
              <circle cx={X(rw.v)} cy={rw.y} r={2.75} fill={rw.c} stroke="#0d0f12" />
            </g>
          ))}
          <rect x={X(pred) - 3.5} y={25 - 3.5} width={7} height={7} transform={`rotate(45 ${X(pred)} 25)`} fill="none" stroke="#c3b8ff" strokeWidth={1.25} />
        </svg>
      )}
    </div>
  )
}

function Verification() {
  const v = useStore((s) => s.verification)!
  const p = useStore((s) => s.proposal)
  const dev = (v.measured_vel_mm_s / v.predicted_vel_mm_s - 1) * 100
  return (
    <div className={cx('anim-in rounded-md border p-3', v.passed ? 'border-[rgba(60,191,138,.35)] bg-[var(--ok-dim)]' : 'border-[rgba(242,72,75,.4)] bg-[var(--alarm-dim)]')}>
      <div className="flex items-center gap-2">
        {v.passed ? <CircleCheck size={16} className="text-ok" /> : <CircleX size={16} className="text-alarm" />}
        <span className={cx('text-[12.5px] font-semibold tracking-[0.04em]', v.passed ? 'text-ok' : 'text-alarm')}>{v.passed ? 'VERIFIED · closed loop' : 'VERIFICATION FAILED'}</span>
        <span className="num ml-auto text-[10.5px] text-fg-3">{v.proposal_id}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.08em] text-fg-4">Predicted</div>
          <div className="num text-[18px] text-fg-1">
            {fx(v.predicted_vel_mm_s, 2)}
            <span className="ml-1 text-[10.5px] text-fg-3">mm/s</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.08em] text-fg-4">Measured</div>
          <div className="num text-[18px] text-fg-1">
            {fx(v.measured_vel_mm_s, 2)}
            <span className="ml-1 text-[10.5px] text-fg-3">mm/s</span>
            <span className={cx('num ml-2 text-[11px]', v.passed ? 'text-fg-2' : 'text-alarm')}>{pct(dev)}</span>
          </div>
        </div>
      </div>
      {v.before_ci && v.after_ci ? (
        <div className="mt-2">
          <div className="mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-fg-4">
            <span className="whitespace-nowrap">90% CI</span>
            <span className="num whitespace-nowrap normal-case tracking-normal text-fg-3">
              {fx(v.before_ci[0], 1)}–{fx(v.before_ci[1], 1)} → <span className="text-fg-1">{fx(v.after_ci[0], 1)}–{fx(v.after_ci[1], 1)}</span> mm/s
            </span>
            {v.p_value != null && (
              <Tip
                className="ml-auto normal-case tracking-normal"
                content={<span className="num">{v.significant ? 'before and after CIs differ: the change is not noise' : 'difference could be noise at this sample size'} · p = {v.p_value}</span>}
              >
                <Chip tone={v.significant ? 'ok' : 'muted'} mono>
                  p = {fp(v.p_value)} · {v.significant ? 'significant' : 'not significant'}
                </Chip>
              </Tip>
            )}
          </div>
          <CiCompare before={v.before_ci} after={v.after_ci} beforeV={p?.current.vel_mm_s} afterV={v.measured_vel_mm_s} pred={v.predicted_vel_mm_s} />
        </div>
      ) : (
        <div className="mt-1">
          <IsoBar value={v.measured_vel_mm_s} marker={v.predicted_vel_mm_s} height={7} />
        </div>
      )}
      <div className="mt-1 text-[11.5px] text-fg-2">{v.summary}</div>
    </div>
  )
}

function Applying({ p }: { p: ProposalEvent }) {
  const rpm = useStore((s) => s.telemetry?.speed_rpm ?? p.current.speed_rpm)
  const status = useStore((s) => s.proposalStatus)
  const progress = Math.max(0, Math.min(1, (p.current.speed_rpm - rpm) / (p.current.speed_rpm - p.proposed.speed_rpm || 1)))
  const step = status === 'submitting' ? 0 : progress < 0.98 ? 1 : 2
  const steps = ['Write setpoint to drive', `Ramp ${rpmTxt(p.current.speed_rpm)} → ${rpmTxt(p.proposed.speed_rpm)} rpm`, 'Re-measure & verify']
  return (
    <div className="rounded-md border border-line-2 bg-bg-2 p-3">
      <div className="mb-2 flex items-center gap-2">
        <LoaderCircle size={14} className="animate-spin text-accent" />
        <span className="text-[12px] font-semibold text-fg-1">Applying {p.id}</span>
        <span className="num ml-auto text-[11px] text-fg-2">{Math.round(rpm)} rpm</span>
      </div>
      <div className="mb-2.5 h-[3px] w-full overflow-hidden rounded-full bg-bg-4">
        <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${(step === 2 ? 1 : progress) * 100}%` }} />
      </div>
      <ol className="space-y-1">
        {steps.map((s, i) => (
          <li key={s} className={cx('flex items-center gap-2 text-[11.5px]', i < step ? 'text-fg-2' : i === step ? 'text-fg-1' : 'text-fg-4')}>
            {i < step ? <Check size={12} className="text-fg-2" /> : i === step ? <span className="ml-[3px] mr-[3px] h-1.5 w-1.5 rounded-full bg-accent anim-pulse" /> : <span className="ml-[3px] mr-[3px] h-1.5 w-1.5 rounded-full bg-fg-4" />}
            {s}
          </li>
        ))}
      </ol>
    </div>
  )
}

function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-1 flex items-center justify-between text-[9.5px] font-semibold uppercase tracking-[0.08em] text-fg-4">
      <span>{children}</span>
      {right}
    </div>
  )
}

export function ProposalCard() {
  const p = useStore((s) => s.proposal)
  const status = useStore((s) => s.proposalStatus)
  const wonder = useStore((s) => s.pipeline.wonder)
  const tab = useStore((s) => s.optimizerTab)
  const rto = useStore((s) => s.rto)
  const setStore = useStore((s) => s.set)
  const [more, setMore] = useState(false)
  const loopActive = !!rto && rto.status !== 'converged' && rto.status !== 'aborted'

  const chip =
    tab === 'loop' && rto ? (
      <RtoStatusChip rto={rto} />
    ) : status === 'pending' ? (
      <Chip tone="accent">
        <span className="h-1.5 w-1.5 rounded-full bg-accent anim-pulse" /> Awaiting approval
      </Chip>
    ) : status === 'submitting' || status === 'applying' ? (
      <Chip tone="accent">Applying</Chip>
    ) : status === 'verified' ? (
      <Chip tone="ok">
        <Check size={10} /> Verified
      </Chip>
    ) : status === 'failed' ? (
      <Chip tone="alarm">Failed</Chip>
    ) : status === 'rejected' ? (
      <Chip tone="muted">Rejected</Chip>
    ) : wonder.state === 'running' ? (
      <Chip tone="accent">Solving…</Chip>
    ) : (
      <Chip tone="muted">Idle</Chip>
    )

  const legend = (
    <span className="flex items-center gap-2 normal-case tracking-normal">
      {p?.curve && (
        <>
          <span className="inline-flex items-center gap-1">
            <span className="flex h-2 w-3 items-center bg-[rgba(216,222,230,.16)]">
              <span className="h-[2px] w-3 bg-trace-1" />
            </span>
            vibration{p.curve.vel_lo ? ' · 90%' : ''}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-0 w-3 border-t border-dashed border-fg-3" /> power
          </span>
        </>
      )}
      <span className="inline-flex items-center gap-1">
        <span className="h-2 w-3 rounded-[1px] border border-[rgba(242,72,75,.45)] bg-[repeating-linear-gradient(45deg,rgba(242,72,75,.5)_0_1.5px,transparent_1.5px_4px)]" /> resonance
      </span>
    </span>
  )

  return (
    <Panel title="Optimizer" meta={p ? `${p.model} · ${p.objective}` : 'Muse Wonder · constrained RTO'} right={chip} bodyClass="flex flex-col">
      <div className="flex h-8 shrink-0 items-stretch gap-4 border-b border-line-1 px-3" role="tablist">
        {(
          [
            { v: 'proposal', label: 'Proposal', meta: p ? p.id : null },
            { v: 'loop', label: 'Closed loop', meta: rto ? `it ${rto.iteration}` : null },
          ] as const
        ).map((t) => (
          <button
            key={t.v}
            role="tab"
            aria-selected={tab === t.v}
            onClick={() => setStore({ optimizerTab: t.v })}
            className={cx(
              '-mb-px inline-flex items-center gap-1.5 border-b-2 text-[11.5px] font-medium transition-colors',
              tab === t.v ? 'border-accent text-fg-1' : 'border-transparent text-fg-3 hover:text-fg-2',
            )}
          >
            {t.v === 'loop' && loopActive && <span className="h-1.5 w-1.5 rounded-full bg-accent anim-pulse" />}
            {t.label}
            {t.meta && <span className="num text-[10px] text-fg-4">{t.meta}</span>}
          </button>
        ))}
      </div>
      {tab === 'loop' ? (
        <ClosedLoop />
      ) : !p ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-line-2 text-fg-3">
            <Sigma size={18} />
          </div>
          <div>
            <div className="text-[12.5px] font-medium text-fg-2">No setpoint proposal yet</div>
            <div className="mx-auto mt-1 max-w-[300px] text-[11px] leading-relaxed text-fg-4">
              Muse Wonder minimizes specific energy over speed, subject to duty, resonance margin, NPSH margin and ISO zone. Identify the machine first.
            </div>
          </div>
          <Btn size="sm" variant="subtle" onClick={() => link.send({ type: 'command', name: 'optimize' })}>
            <Sigma size={12} /> Run optimizer
          </Btn>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col gap-3 p-3">
              {/* headline gains */}
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line-1 bg-line-1">
                {[
                  { k: 'Vibration', v: p.expected.vibration_change_pct },
                  { k: 'Energy', v: p.expected.energy_change_pct },
                ].map((g) => (
                  <div key={g.k} className="bg-bg-2 px-3 py-2">
                    <div className="flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-fg-3">
                      <TrendingDown size={11} /> Expected {g.k}
                    </div>
                    <div className="num mt-0.5 text-[26px] leading-none tracking-[-0.03em] text-accent-2">{pct(g.v)}</div>
                  </div>
                ))}
                {[
                  { k: 'Speed', c: p.current.speed_rpm, n: p.proposed.speed_rpm, u: 'rpm', d: 0 },
                  { k: 'Vibration', c: p.current.vel_mm_s, n: p.proposed.vel_mm_s, u: 'mm/s', d: 1 },
                  { k: 'Power', c: p.current.kw * 1000, n: p.proposed.kw * 1000, u: 'W', d: 0 },
                ].map((r) => (
                  <Transition key={r.k} {...r} />
                ))}
                {p.risk && <RiskRow cur={p.risk.p_res_current} prop={p.risk.p_res_proposed} thr={p.risk.threshold} />}
              </div>

              {/* objective landscape */}
              <div className="rounded-md border border-line-1 bg-bg-0/40 px-2 pt-1.5">
                <div className="px-1">
                  <SectionLabel right={legend}>{p.curve ? 'Predicted vs speed' : 'Speed axis · rpm'}</SectionLabel>
                </div>
                {p.curve && p.curve.rpm.length > 1 ? <ObjectiveChart p={p} /> : <SpeedAxis p={p} />}
              </div>

              {/* constraints */}
              <div>
                <SectionLabel>
                  Constraints · {p.constraints.filter((c) => c.ok).length}/{p.constraints.length} satisfied
                </SectionLabel>
                <ul className="divide-y divide-line-1 rounded-md border border-line-1">
                  {p.constraints.map((c) => (
                    <li key={c.name} className="flex items-center gap-2 px-2 py-[4px]">
                      {c.ok ? <Check size={12} className="shrink-0 text-ok" /> : <X size={12} className="shrink-0 text-alarm" />}
                      <span className={cx('shrink-0 text-[11.5px] ', c.ok ? 'text-fg-2' : 'text-alarm')}>{c.name.charAt(0).toUpperCase() + c.name.slice(1)}</span>
                      <span className="num ml-auto min-w-0 truncate pl-2 text-right text-[10.5px] text-fg-3" title={c.value}>
                        {c.value}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* rationale */}
              <div>
                <SectionLabel>Rationale</SectionLabel>
                <p className={cx('text-[11.5px] leading-relaxed text-fg-2', !more && 'line-clamp-3')}>{p.rationale}</p>
                <button onClick={() => setMore((m) => !m)} className="mt-0.5 text-[10.5px] font-medium text-fg-3 hover:text-fg-1">
                  {more ? 'Less' : 'More'}
                </button>
              </div>
            </div>
          </div>

          {/* decision: always visible */}
          <div className="shrink-0 border-t border-line-1 bg-bg-1 p-3">
            {status === 'pending' && (
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Btn size="lg" variant="accent" onClick={() => link.approve(p.id, true)}>
                  <ShieldCheck size={16} /> Approve {rpmTxt(p.proposed.speed_rpm)} rpm
                </Btn>
                <Btn size="lg" variant="outline" onClick={() => link.approve(p.id, false)}>
                  Reject
                </Btn>
              </div>
            )}
            {(status === 'submitting' || status === 'applying') && <Applying p={p} />}
            {(status === 'verified' || status === 'failed') && <Verification />}
            {status === 'rejected' && (
              <div className="flex items-center justify-between rounded-md border border-line-2 bg-bg-2 px-3 py-2 text-[11.5px] text-fg-3">
                Proposal rejected · holding {rpmTxt(p.current.speed_rpm)} rpm
                <Btn size="xs" variant="ghost" onClick={() => link.send({ type: 'command', name: 'optimize' })}>
                  Re-plan
                </Btn>
              </div>
            )}
          </div>
        </>
      )}
    </Panel>
  )
}

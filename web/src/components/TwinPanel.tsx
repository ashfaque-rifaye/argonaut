import { useMemo, useRef } from 'react'
import { FileUp } from 'lucide-react'
import { useStore } from '../lib/store'
import { IdentifyTabs } from './InferencePanel'
import { link } from '../lib/socket'
import { fx, niceTicks } from '../lib/format'
import { useSize } from '../lib/useSize'
import type { PumpCurve } from '../lib/protocol'
import { Btn, cx, Empty, Panel } from './ui'

const M = { l: 34, r: 34, t: 12, b: 24 }

function interp(xs: number[], ys: number[], x: number) {
  if (x <= xs[0]) return ys[0]
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1])
  return ys[ys.length - 1]
}

/** Operating point at speed ratio r on a pure-friction system curve through the duty point (affinity laws). */
export function operatingPoint(pc: PumpCurve, bep: { q: number; h: number }, r: number) {
  const qd = bep.q * 1.2
  const hd = interp(pc.q, pc.h, qd)
  return { q: qd * r, h: hd * r * r, eta: interp(pc.q, pc.eta, qd), npshr: interp(pc.q, pc.npshr, qd) * r * r, qd, hd }
}

function Stat({ label, value, unit, tone }: { label: string; value: string; unit: string; tone?: 'warn' | 'accent' }) {
  return (
    <div className="flex min-w-0 flex-col px-3 py-1.5">
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-fg-4">{label}</span>
      <span className={cx('num text-[14px] leading-tight', tone === 'warn' ? 'text-warn' : tone === 'accent' ? 'text-accent-2' : 'text-fg-1')}>
        {value}
        <span className="ml-0.5 text-[10px] text-fg-3">{unit}</span>
      </span>
    </div>
  )
}

export function TwinPanel() {
  const asset = useStore((s) => s.asset)
  const rpm = useStore((s) => s.telemetry?.speed_rpm ?? 0)
  const proposal = useStore((s) => s.proposal)
  const status = useStore((s) => s.proposalStatus)
  const [box, size] = useSize<HTMLDivElement>()
  const file = useRef<HTMLInputElement>(null)

  const pc = asset?.pump_curve ?? null
  const bep = asset?.bep ?? null
  const nr = asset?.nameplate.rpm ?? 1450
  const r = rpm / nr

  const qMax = pc ? pc.q[pc.q.length - 1] : 20
  const hMax = pc ? Math.ceil((Math.max(...pc.h) * 1.15) / 5) * 5 : 25
  const W = size.w
  const H = size.h
  const pw = Math.max(10, W - M.l - M.r)
  const ph = Math.max(10, H - M.t - M.b)
  const X = (q: number) => M.l + (q / qMax) * pw
  const Y = (h: number) => M.t + ph - (h / hMax) * ph
  const YE = (e: number) => M.t + ph - e * ph // η 0..1 on right axis

  const curve = useMemo(() => {
    if (!pc) return null
    const line = (ys: number[], s = 1, sy = 1, f = Y) => pc.q.map((q, i) => `${i ? 'L' : 'M'}${X(q * s).toFixed(1)},${f(ys[i] * sy).toFixed(1)}`).join('')
    return { line }
  }, [pc, W, H]) // eslint-disable-line react-hooks/exhaustive-deps

  const op = pc && bep ? operatingPoint(pc, bep, r) : null
  const opProp = pc && bep && proposal && status !== 'rejected' ? operatingPoint(pc, bep, proposal.proposed.speed_rpm / nr) : null
  const por = bep ? [0.7 * bep.q * r, 1.2 * bep.q * r] : null
  const outsidePor = op && por ? op.q < por[0] - 0.01 || op.q > por[1] + 0.01 : false
  const kw = asset ? asset.nameplate.kw * r ** 3 : 0

  return (
    <Panel
      title="Digital twin"
      meta={asset ? `affinity @ ${Math.round(rpm)} rpm` : 'H–Q · η · NPSHr'}
      right={
        <>
          <IdentifyTabs />
          <Btn size="xs" variant="ghost" onClick={() => file.current?.click()} title="Upload pump-curve datasheet (PDF/PNG); Muse Spark parses it">
            <FileUp size={11} /> Datasheet
          </Btn>
          <input
            ref={file}
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void link.uploadDatasheet(f).catch((err: Error) => useStore.getState().pushConsole({ kind: 'error', text: `Datasheet upload failed: ${err.message}` }))
            }}
          />
        </>
      }
      bodyClass="flex flex-col"
    >
      {pc && bep && op ? (
        <>
          <div className="grid shrink-0 grid-cols-5 divide-x divide-line-1 border-b border-line-1">
            <Stat label="Flow Q" value={fx(op.q, 1)} unit="m³/h" tone={outsidePor ? 'warn' : undefined} />
            <Stat label="Head H" value={fx(op.h, 1)} unit="m" />
            <Stat label="η" value={fx(op.eta * 100, 0)} unit="%" />
            <Stat label="NPSHr" value={fx(op.npshr, 2)} unit="m" />
            <Stat label="Power" value={fx(kw * 1000, 0)} unit="W" />
          </div>
          <div ref={box} className="relative min-h-0 flex-1">
            {W > 0 && curve && (
              <svg width={W} height={H} className="block">
                <defs>
                  <pattern id="tw-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="6" stroke="color-mix(in srgb, var(--color-alarm) 22%, transparent)" strokeWidth="2" />
                  </pattern>
                  <clipPath id="tw-clip">
                    <rect x={M.l} y={M.t} width={pw} height={ph} />
                  </clipPath>
                </defs>
                {niceTicks(0, qMax, Math.max(3, Math.floor(pw / 60))).map((q) => (
                  <g key={`q${q}`}>
                    <line x1={X(q)} x2={X(q)} y1={M.t} y2={M.t + ph} stroke="var(--color-grid)" />
                    <text x={X(q)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--color-fg-3)" className="num">
                      {q}
                    </text>
                  </g>
                ))}
                {niceTicks(0, hMax, Math.max(3, Math.floor(ph / 32))).map((h) => (
                  <g key={`h${h}`}>
                    <line x1={M.l} x2={M.l + pw} y1={Y(h)} y2={Y(h)} stroke="var(--color-grid)" />
                    <text x={M.l - 6} y={Y(h) + 3.5} textAnchor="end" fontSize={10} fill="var(--color-fg-3)" className="num">
                      {h}
                    </text>
                  </g>
                ))}
                {[0, 0.25, 0.5, 0.75, 1].map((e) => (
                  <text key={e} x={M.l + pw + 6} y={YE(e) + 3.5} fontSize={9.5} fill="var(--color-fg-4)" className="num">
                    {e * 100}%
                  </text>
                ))}
                <text x={M.l + pw} y={H - 8} textAnchor="end" fontSize={9.5} fill="var(--color-fg-4)" className="num" dy={-12}>
                  Q m³/h
                </text>
                <text x={M.l + 4} y={M.t + 9} fontSize={9.5} fill="var(--color-fg-4)" className="num">
                  H m
                </text>

                <g clipPath="url(#tw-clip)">
                  {/* preferred operating region at current speed */}
                  {por && <rect x={X(por[0])} y={M.t} width={Math.max(0, X(por[1]) - X(por[0]))} height={ph} fill="color-mix(in srgb, var(--color-fg-1) 3.5%, transparent)" />}
                  {/* resonance exclusion bands mapped to flow (Q ∝ N) */}
                  {proposal &&
                    status !== 'rejected' &&
                    proposal.exclusion_bands_rpm.map(([a, b], i) => (
                      <rect key={i} x={X((a / nr) * op.qd)} y={M.t} width={Math.max(1, X((b / nr) * op.qd) - X((a / nr) * op.qd))} height={ph} fill="url(#tw-hatch)" />
                    ))}
                  {/* system curve */}
                  <path
                    d={Array.from({ length: 41 }, (_, i) => {
                      const q = (i / 40) * qMax
                      return `${i ? 'L' : 'M'}${X(q).toFixed(1)},${Y((op.hd / (op.qd * op.qd)) * q * q).toFixed(1)}`
                    }).join('')}
                    fill="none"
                    stroke="var(--color-fg-4)"
                    strokeDasharray="2 3"
                  />
                  {/* efficiency (right axis) */}
                  <path d={curve.line(pc.eta, r, 1, YE)} fill="none" stroke="var(--color-fg-3)" strokeWidth={1} strokeDasharray="5 3" />
                  {/* NPSHr */}
                  <path d={curve.line(pc.npshr, r, r * r)} fill="none" stroke="var(--color-trace-2)" strokeWidth={1} strokeDasharray="1 2.5" />
                  {/* H–Q at nameplate speed */}
                  <path d={curve.line(pc.h)} fill="none" stroke="var(--color-fg-4)" strokeWidth={1} />
                  {/* H–Q at current speed (affinity) */}
                  {r > 0.05 && <path d={curve.line(pc.h, r, r * r)} fill="none" stroke="var(--color-trace-1)" strokeWidth={1.5} />}
                  {/* proposed curve */}
                  {opProp && proposal && <path d={curve.line(pc.h, proposal.proposed.speed_rpm / nr, (proposal.proposed.speed_rpm / nr) ** 2)} fill="none" stroke="var(--color-accent)" strokeWidth={1.25} strokeDasharray="5 3" />}
                </g>

                {/* BEP (nameplate) and BEP at current speed */}
                <g transform={`translate(${X(bep.q)} ${Y(bep.h)})`}>
                  <rect x={-4.5} y={-4.5} width={9} height={9} transform="rotate(45)" fill="var(--color-bg-1)" stroke="var(--color-fg-2)" />
                  <text x={8} y={-6} fontSize={9.5} fill="var(--color-fg-2)" className="num">
                    BEP
                  </text>
                </g>
                {r > 0.05 && (
                  <g transform={`translate(${X(bep.q * r)} ${Y(bep.h * r * r)})`}>
                    <rect x={-3} y={-3} width={6} height={6} transform="rotate(45)" fill="var(--color-fg-2)" />
                  </g>
                )}
                {/* proposed operating point */}
                {opProp && (
                  <g transform={`translate(${X(opProp.q)} ${Y(opProp.h)})`}>
                    <circle r={6} fill="none" stroke="var(--color-accent)" strokeWidth={1.5} />
                    <text x={9} y={14} fontSize={9.5} fill="var(--color-accent-2)" className="num">
                      {proposal!.id.toUpperCase()}
                    </text>
                  </g>
                )}
                {/* live operating point */}
                {r > 0.02 && (
                  <g transform={`translate(${X(op.q)} ${Y(op.h)})`}>
                    <circle r={9} fill={outsidePor ? 'color-mix(in srgb, var(--color-warn) 15%, transparent)' : 'color-mix(in srgb, var(--color-fg-1) 10%, transparent)'} />
                    <circle r={4} fill={outsidePor ? 'var(--color-warn)' : 'var(--color-fg-1)'} stroke="var(--color-bg-1)" strokeWidth={1.5} />
                    <text x={10} y={-8} fontSize={9.5} fill={outsidePor ? 'var(--color-warn)' : 'var(--color-fg-1)'} className="num">
                      NOW
                    </text>
                  </g>
                )}
                {/* legend */}
                <g fontSize={9.5} className="num" transform={`translate(${M.l + 8} ${M.t + ph - 40})`}>
                  <rect x={-5} y={-8} width={58} height={40} rx={3} fill="var(--color-bg-1)" fillOpacity={0.88} stroke="var(--color-line-1)" />
                  <line x1={0} x2={12} y1={0} y2={0} stroke="var(--color-trace-1)" strokeWidth={1.5} />
                  <text x={16} y={3} fill="var(--color-fg-3)">
                    H–Q
                  </text>
                  <line x1={0} x2={12} y1={12} y2={12} stroke="var(--color-fg-3)" strokeDasharray="5 3" />
                  <text x={16} y={15} fill="var(--color-fg-3)">
                    η
                  </text>
                  <line x1={0} x2={12} y1={24} y2={24} stroke="var(--color-trace-2)" strokeDasharray="1 2.5" />
                  <text x={16} y={27} fill="var(--color-fg-3)">
                    NPSHr
                  </text>
                </g>
              </svg>
            )}
          </div>
        </>
      ) : (
        <div className="relative flex-1">
          <Empty title={asset ? 'No duty curve for this asset' : 'Waiting for asset model'} hint="Upload the pump-curve datasheet. Muse Spark extracts H–Q, η and NPSHr, and the twin scales them to live speed with the affinity laws." stage="spark" />
        </div>
      )}
    </Panel>
  )
}

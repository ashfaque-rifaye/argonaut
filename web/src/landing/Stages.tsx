import type { CSSProperties, ReactNode } from 'react'
import { cx } from '../components/ui'
import { Media } from './Media'
import { useInView } from './motion'
import { useTheme, type Theme } from '../lib/theme'

/*
 * "How it works" stage visuals: a photoreal media layer (image or muted loop, see <Media>) with the
 * console's own technical overlays animated on top when the card scrolls into view.
 *
 * Geometry lives in a 1600×900 viewBox (the card is locked to 16:9, so nothing distorts); labels are
 * HTML positioned in % so they keep a legible pixel size at 390 px. Every animated element only uses
 * stroke-dashoffset / opacity / transform, so the compositor does the work.
 *
 * Expected composition of the generated stills (normalised to the frame, see docs/DESIGN.md v3):
 *   sense    motor centre-left, bearing housing at the coupling, pump casing centre-right, baseplate along the lower third
 *   measure  same skid closer in; bearing housing near the centre; calm lower 30% for the waveform
 *   identify skid on a steel stand, right half calm enough for a chart panel
 *   optimise VFD cabinet / drive + machine; right half calm enough for a chart panel
 *   prove    machine running steady, control-room feel; right half calm enough for a chart panel
 */

const S = { a: '#56B6E0', b: '#8B9EF5', c: '#4FC1A6', d: '#CBB98A' } // sensor identity colours (same as the console)
const d = (ms: number) => ({ '--d': `${ms}ms` }) as CSSProperties

/** a chip anchored at viewBox coords (x, y) */
function Lbl({ x, y, delay = 0, dot, children, className, anchor = 'left' }: { x: number; y: number; delay?: number; dot?: string; children: ReactNode; className?: string; anchor?: 'left' | 'right' }) {
  return (
    <div
      className={cx(
        'ov-fade num absolute flex items-center gap-1.5 whitespace-nowrap rounded-[4px] border border-line-2 bg-bg-1/85 px-1.5 py-[2px] text-[9px] font-medium text-fg-1 shadow-[0_4px_16px_-6px_color-mix(in_srgb,var(--color-shadow)_50%,transparent)] backdrop-blur-sm sm:text-[10.5px]',
        className,
      )}
      style={{ ...d(delay), top: `${(y / 900) * 100}%`, ...(anchor === 'left' ? { left: `${(x / 1600) * 100}%` } : { right: `${100 - (x / 1600) * 100}%` }) }}
    >
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-[1.5px]" style={{ background: dot }} />}
      {children}
    </div>
  )
}

/** frosted chart panel; its own SVG is drawn in a w×h viewBox */
function Glass({ children, className, delay = 0, title, meta }: { children: ReactNode; className?: string; delay?: number; title?: string; meta?: ReactNode }) {
  return (
    <div
      className={cx(
        'ov-fade absolute overflow-hidden rounded-lg border border-line-2 bg-bg-1/80 shadow-[0_18px_48px_-18px_color-mix(in_srgb,var(--color-shadow)_70%,transparent)] backdrop-blur-md',
        className,
      )}
      style={d(delay)}
    >
      {title && (
        <div className="flex h-5 items-center gap-2 border-b border-line-1 px-2 sm:h-6">
          <span className="text-[8px] font-semibold uppercase tracking-[0.1em] text-fg-3 sm:text-[9px]">{title}</span>
          {meta && <span className="num ml-auto truncate text-[8px] text-fg-4 sm:text-[9px]">{meta}</span>}
        </div>
      )}
      {children}
    </div>
  )
}

function Fallback({ tone }: { tone: 'violet' | 'steel' | 'amber' }) {
  const glow = tone === 'violet' ? 'var(--color-accent)' : tone === 'amber' ? 'var(--color-warn)' : 'var(--color-trace-2)'
  return (
    <div className="absolute inset-0 bg-bg-2">
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(90% 80% at 30% 20%, color-mix(in srgb, ${glow} 16%, transparent), transparent 60%), radial-gradient(70% 70% at 85% 90%, color-mix(in srgb, var(--color-fg-1) 6%, transparent), transparent 70%), linear-gradient(180deg, var(--color-bg-2), var(--color-bg-1))`,
        }}
      />
      <div className="hairline-grid absolute inset-0 opacity-70 [mask-image:radial-gradient(120%_100%_at_50%_40%,#000_35%,transparent_85%)]" />
    </div>
  )
}

/** media + scrim + overlay, animated in when 35% visible */
export function StageVisual({ name, tone = 'steel', children, label }: { name: string; tone?: 'violet' | 'steel' | 'amber'; children: ReactNode; label: string }) {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.35, margin: '0px' })
  return (
    <div ref={ref} data-in={inView ? '1' : undefined} className="relative aspect-[16/9] w-full overflow-hidden border-b border-line-1 bg-bg-2" role="img" aria-label={label}>
      <Media name={name} fallback={<Fallback tone={tone} />} mediaClass="group-hover/card:scale-[1.035]" />
      {/* legibility: a soft floor gradient + vignette over any footage */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,transparent_55%,color-mix(in_srgb,var(--color-bg-1)_55%,transparent))]" />
      <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_80px_color-mix(in_srgb,var(--color-shadow)_22%,transparent)]" />
      <div className="pointer-events-none absolute inset-0">{children}</div>
    </div>
  )
}

const VB = '0 0 1600 900'

/* ───────────── 01 Sense: SAM 3.1 masks drawn onto the skid ───────────── */

type Pt = [number, number, 'left' | 'right']
type SenseGeom = { ref: string; motor: string; bearing: string; pump: [number, number, number, number]; base: string; lbl: { motor: Pt; bearing: Pt; pump: Pt; base: Pt } }
const box = (x1: number, y1: number, x2: number, y2: number, r = 18) => `M${x1 + r} ${y1} H${x2 - r} Q${x2} ${y1} ${x2} ${y1 + r} V${y2 - r} Q${x2} ${y2} ${x2 - r} ${y2} H${x1 + r} Q${x1} ${y2} ${x1} ${y2 - r} V${y1 + r} Q${x1} ${y1} ${x1 + r} ${y1} Z`

/** Mask geometry calibrated to the generated stills (viewBox 1600×900). The dark still is mirrored. */
const SENSE: Record<Theme, SenseGeom> = {
  light: {
    ref: 'M60 80 H300 V540 H60 Z',
    motor: box(640, 272, 890, 560),
    bearing: box(886, 360, 1000, 622, 8),
    pump: [1265, 480, 135, 165],
    base: 'M590 610 L1440 592 L1480 742 L1200 800 L580 682 Z',
    lbl: { motor: [640, 222, 'left'], bearing: [886, 640, 'left'], pump: [1400, 280, 'right'], base: [420, 712, 'left'] },
  },
  dark: {
    ref: 'M60 80 H290 V540 H60 Z',
    motor: box(1080, 282, 1520, 610),
    bearing: box(862, 402, 1080, 600, 8),
    pump: [720, 470, 145, 152],
    base: 'M640 615 L1530 590 L1545 700 L700 725 Z',
    lbl: { motor: [1520, 232, 'right'], bearing: [862, 620, 'left'], pump: [575, 282, 'left'], base: [700, 745, 'left'] },
  },
}

export function SenseOverlay() {
  const g = SENSE[useTheme()]
  const [pcx, pcy, prx, pry] = g.pump
  return (
    <>
      <svg viewBox={VB} className="absolute inset-0 h-full w-full" fill="none" strokeLinejoin="round">
        {/* static reference (dashed: fades rather than draws) */}
        <path className="ov-fade" style={d(900)} d={g.ref} stroke="var(--color-fg-2)" strokeOpacity="0.75" strokeWidth="3.5" strokeDasharray="14 10" fill="var(--color-fg-1)" fillOpacity="0.04" />
        <path className="ov-fill" style={d(250)} d={g.motor} fill={S.a} />
        <path className="ov-draw" style={d(100)} pathLength={1} d={g.motor} stroke={S.a} strokeWidth="4.5" />
        <path className="ov-fill" style={d(450)} d={g.bearing} fill={S.b} />
        <path className="ov-draw" style={d(300)} pathLength={1} d={g.bearing} stroke={S.b} strokeWidth="4.5" />
        <ellipse className="ov-fill" style={d(650)} cx={pcx} cy={pcy} rx={prx} ry={pry} fill={S.c} />
        <ellipse className="ov-draw" style={d(500)} pathLength={1} cx={pcx} cy={pcy} rx={prx} ry={pry} stroke={S.c} strokeWidth="4.5" />
        <path className="ov-fill" style={d(850)} d={g.base} fill={S.d} />
        <path className="ov-draw" style={d(700)} pathLength={1} d={g.base} stroke={S.d} strokeWidth="4.5" />
        {/* one-shot segmentation sweep */}
        <rect className="ov-sweep" x="-160" y="0" width="160" height="900" fill="url(#sweep)" />
        <defs>
          <linearGradient id="sweep" x1="0" x2="1">
            <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0" />
            <stop offset="0.85" stopColor="var(--color-accent)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0.7" />
          </linearGradient>
        </defs>
      </svg>
      <Lbl x={g.lbl.motor[0]} y={g.lbl.motor[1]} anchor={g.lbl.motor[2]} delay={500} dot={S.a}>
        motor housing <span className="text-fg-3">95</span>
      </Lbl>
      <Lbl x={g.lbl.bearing[0]} y={g.lbl.bearing[1]} anchor={g.lbl.bearing[2]} delay={700} dot={S.b}>
        bearing housing <span className="text-fg-3">94</span>
      </Lbl>
      <Lbl x={g.lbl.pump[0]} y={g.lbl.pump[1]} anchor={g.lbl.pump[2]} delay={900} dot={S.c}>
        pump casing <span className="text-fg-3">92</span>
      </Lbl>
      <Lbl x={g.lbl.base[0]} y={g.lbl.base[1]} anchor={g.lbl.base[2]} delay={1100} dot={S.d}>
        baseplate <span className="text-fg-3">87</span>
      </Lbl>
      <Lbl x={70} y={40} delay={1200}>
        <span className="font-semibold tracking-[0.06em]">REF</span> wall · static
      </Lbl>
      <Lbl x={1560} y={40} delay={200} anchor="right" className="!border-accent/40">
        <span className="h-1.5 w-1.5 rounded-full bg-accent anim-pulse" />
        SAM 3.1 · 5 regions
      </Lbl>
    </>
  )
}

/* ───────────── 02 Measure: aliased motion + mic tachometer → true order ───────────── */

function measureGeometry() {
  const x0 = 140
  const x1 = 1460
  const yc = 735
  const A = 62
  const span = 0.45 // seconds across the band
  const X = (t: number) => x0 + (t / span) * (x1 - x0)
  const truth: string[] = []
  const alias: string[] = []
  for (let i = 0; i <= 600; i++) {
    const t = (i / 600) * span
    truth.push(`${X(t).toFixed(1)},${(yc - A * Math.sin(2 * Math.PI * 24.6 * t)).toFixed(1)}`)
    alias.push(`${X(t).toFixed(1)},${(yc + A * Math.sin(2 * Math.PI * 5.4 * t)).toFixed(1)}`)
  }
  const samples: [number, number][] = []
  for (let k = 0; k / 30 <= span; k++) samples.push([X(k / 30), yc - A * Math.sin(2 * Math.PI * 24.6 * (k / 30))])
  return { truth: `M${truth.join(' L')}`, alias: `M${alias.join(' L')}`, samples, yc, x0, x1 }
}
const MG = measureGeometry()

export function MeasureOverlay() {
  return (
    <>
      <svg viewBox={VB} className="absolute inset-0 h-full w-full" fill="none">
        {/* measurement point on the bearing housing, leader down to the trace */}
        <circle className="ov-pop" style={d(100)} cx="880" cy="400" r="16" stroke={S.b} strokeWidth="4" />
        <circle className="ov-pop" style={d(150)} cx="880" cy="400" r="4" fill={S.b} />
        <path className="ov-draw" style={d(250)} pathLength={1} d="M880 420 V640" stroke={S.b} strokeWidth="2.5" strokeDasharray="1" />
        {/* band */}
        <rect className="ov-fade" style={d(200)} x={MG.x0 - 30} y={MG.yc - 100} width={MG.x1 - MG.x0 + 60} height="200" rx="14" fill="var(--color-bg-1)" fillOpacity="0.72" stroke="var(--color-line-2)" strokeWidth="2" />
        <path className="ov-draw" style={{ ...d(400), '--dur': '1.8s' } as CSSProperties} pathLength={1} d={MG.truth} stroke="var(--color-fg-3)" strokeWidth="2.2" />
        <path className="ov-fade" style={d(1500)} d={MG.alias} stroke="var(--color-fg-1)" strokeWidth="3" strokeDasharray="10 9" />
        {MG.samples.map(([x, y], i) => (
          <circle key={i} className="ov-pop" style={d(700 + i * 70)} cx={x} cy={y} r="8" fill="var(--color-fg-1)" stroke="var(--color-bg-1)" strokeWidth="3" />
        ))}
      </svg>
      <Lbl x={850} y={370} delay={300} dot={S.b} anchor="right">
        bearing housing<span className="max-sm:hidden"> · sub-pixel motion</span>
      </Lbl>
      <Lbl x={MG.x0} y={575} delay={900}>
        camera 30 fps sees <span className="text-fg-1">5.34 Hz</span>
      </Lbl>
      <Lbl x={MG.x1} y={575} delay={1300} anchor="right">
        <span className="text-fg-3">mic tachometer</span> 1× lock
      </Lbl>
      <Lbl x={MG.x1} y={850} delay={1900} anchor="right" className="!border-accent/50 !text-accent-2">
        unfolded (fold 1) → <span className="font-semibold">24.68 Hz</span>
      </Lbl>
    </>
  )
}

/* ───────────── 03 Identify: Campbell crossings pulse ───────────── */

export function IdentifyOverlay() {
  const W = 320
  const H = 196
  const X = (rpm: number) => 30 + (rpm / 1800) * 278
  const Y = (f: number) => H - 22 - (f / 70) * (H - 40)
  const modes = [
    { f: 14.2, e: 0.3, l: 'M1 14.2 ± 0.3' },
    { f: 24.1, e: 0.4, l: 'M2 24.1 ± 0.4' },
    { f: 61.5, e: 1.1, l: 'M3 61.5 ± 1.1' },
  ]
  const orders = [
    { k: 1, l: '1×' },
    { k: 2, l: '2×' },
    { k: 5, l: 'BPF' },
  ]
  const cross: [number, number][] = []
  for (const o of orders) for (const m of modes) if ((60 * m.f) / o.k <= 1800 && (60 * m.f) / o.k > 200) cross.push([(60 * m.f) / o.k, m.f])
  return (
    <>
      <svg viewBox={VB} className="absolute inset-0 h-full w-full" fill="none">
        <circle className="ov-pop" style={d(200)} cx="1010" cy="655" r="14" stroke="var(--color-warn)" strokeWidth="4" />
        <circle className="ov-ring" style={d(1400)} cx="1010" cy="655" r="14" stroke="var(--color-warn)" strokeWidth="3" />
      </svg>
      <Lbl x={1560} y={720} delay={400} anchor="right">
        <span className="text-warn">M1</span> 14.2 Hz<span className="max-sm:hidden"> · stand rocking</span>
      </Lbl>
      <Glass className="bottom-[5%] left-[3.5%] w-[60%] sm:w-[50%]" delay={150} title="Campbell" meta="coast-down 1476 → 0 rpm">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" fill="none">
          {[0, 600, 1200, 1800].map((r) => (
            <text key={r} x={X(r)} y={H - 6} textAnchor="middle" className="num" fontSize="10" fill="var(--color-fg-4)">
              {r}
            </text>
          ))}
          {[20, 40, 60].map((f) => (
            <text key={f} x={24} y={Y(f) + 3.5} textAnchor="end" className="num" fontSize="10" fill="var(--color-fg-4)">
              {f}
            </text>
          ))}
          {modes.map((m, i) => (
            <g key={m.f}>
              <rect className="ov-fade" style={d(500 + i * 120)} x={X(0)} y={Y(m.f + m.e * 2)} width={X(1800) - X(0)} height={Y(m.f - m.e * 2) - Y(m.f + m.e * 2)} fill="var(--color-fg-1)" fillOpacity="0.08" />
              <path className="ov-draw" style={d(450 + i * 120)} pathLength={1} d={`M${X(0)} ${Y(m.f)} H${X(1800)}`} stroke="var(--color-fg-2)" strokeWidth="1.2" />
              <text className="ov-fade num" style={d(900 + i * 120)} x={X(1800)} y={Y(m.f) - 4} textAnchor="end" fontSize="9.5" fill="var(--color-fg-3)">
                {m.l}
              </text>
            </g>
          ))}
          {orders.map((o, i) => {
            const rEnd = Math.min(1800, (70 * 60) / o.k)
            return (
              <g key={o.k}>
                <path className="ov-draw" style={{ ...d(700 + i * 160), '--dur': '1.1s' } as CSSProperties} pathLength={1} d={`M${X(0)} ${Y(0)} L${X(rEnd)} ${Y((o.k * rEnd) / 60)}`} stroke={o.k === 1 ? 'var(--color-accent)' : 'var(--color-fg-3)'} strokeWidth={o.k === 1 ? 1.6 : 1.1} />
                <text className="ov-fade num" style={d(1200 + i * 160)} x={X(rEnd) - 4} y={Y((o.k * rEnd) / 60) + (rEnd < 1800 ? 12 : -4)} textAnchor="end" fontSize="9.5" fill={o.k === 1 ? 'var(--color-accent-2)' : 'var(--color-fg-3)'}>
                  {o.l}
                </text>
              </g>
            )
          })}
          {cross.map(([r, f], i) => (
            <g key={i}>
              <circle className="ov-pop" style={d(1300 + i * 90)} cx={X(r)} cy={Y(f)} r="4" stroke="var(--color-warn)" strokeWidth="1.6" fill="var(--color-bg-1)" />
              <circle className="ov-ring" style={d(1900 + i * 90)} cx={X(r)} cy={Y(f)} r="4" stroke="var(--color-warn)" strokeWidth="1.2" />
            </g>
          ))}
          <text x={X(852) + 6} y={Y(14.2) + 14} className="ov-fade num" style={d(2000)} fontSize="9.5" fill="var(--color-warn)">
            852 rpm critical
          </text>
        </svg>
      </Glass>
    </>
  )
}

/* ───────────── 04 Optimise: objective curve traced, proposal pops ───────────── */

export function OptimiseOverlay() {
  const W = 320
  const H = 190
  const X = (r: number) => 16 + ((r - 300) / 1400) * 290
  const v = (r: number) => {
    const f = r / 60
    const h = (fm: number, z: number) => 1 / Math.sqrt((1 - (f / fm) ** 2) ** 2 + (2 * z * (f / fm)) ** 2)
    return (r / 1476) ** 2 * (0.55 + 0.11 * h(24.1, 0.034) + 0.08 * h(14.2, 0.021))
  }
  const Y = (y: number) => 150 - Math.min(y, 2.2) * 56
  const p: string[] = []
  const lo: string[] = []
  const hi: string[] = []
  for (let r = 300; r <= 1700; r += 8) {
    p.push(`${X(r).toFixed(1)},${Y(v(r)).toFixed(1)}`)
    hi.push(`${X(r).toFixed(1)},${Y(v(r) * 1.18).toFixed(1)}`)
    lo.push(`${X(r).toFixed(1)},${Y(v(r) * 0.84).toFixed(1)}`)
  }
  const now = [X(1476), Y(v(1476))]
  const prop = [X(1275), Y(v(1275))]
  return (
    <>
      <Lbl x={1560} y={60} delay={300} anchor="right">
        <span className="text-fg-3">VFD setpoint</span> 1476 <span className="text-fg-3">→</span> <span className="text-accent-2">1275 rpm</span>
      </Lbl>
      <Lbl x={1560} y={140} delay={500} anchor="right" className="max-sm:hidden">
        <span className="text-fg-3">P(res)</span> 7.9% <span className="text-fg-3">→</span> 0.4% <span className="text-fg-4">· gate 2%</span>
      </Lbl>
      <Glass className="bottom-[5%] left-[3.5%] w-[60%] sm:w-[52%]" delay={150} title="Objective · constrained RTO" meta="mm/s vs rpm">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" fill="none">
          <defs>
            <pattern id="st-h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="5" stroke="var(--color-alarm)" strokeOpacity="0.45" strokeWidth="1.4" />
            </pattern>
            <marker id="st-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="var(--color-accent)" />
            </marker>
          </defs>
          <rect className="ov-fade" style={d(500)} x={X(1330)} y="10" width={X(1562) - X(1330)} height="140" fill="url(#st-h)" />
          <rect className="ov-fade" style={d(560)} x={X(665)} y="10" width={X(920) - X(665)} height="140" fill="url(#st-h)" />
          <polygon className="ov-fade" style={d(900)} points={`${hi.join(' ')} ${[...lo].reverse().join(' ')}`} fill="var(--color-fg-1)" fillOpacity="0.09" />
          <polyline className="ov-draw" style={{ ...d(400), '--dur': '1.8s' } as CSSProperties} pathLength={1} points={p.join(' ')} stroke="var(--color-fg-1)" strokeWidth="1.6" />
          <line x1={X(300)} x2={X(1700)} y1="160" y2="160" stroke="var(--color-line-2)" />
          <rect className="ov-fade" style={d(1200)} x={X(1220)} y="156" width={X(1330) - X(1220)} height="8" rx="1.5" fill="var(--color-accent)" fillOpacity="0.25" stroke="var(--color-accent)" strokeWidth="1" />
          {[600, 900, 1500].map((r) => (
            <text key={r} x={X(r)} y={H - 6} textAnchor="middle" className="num" fontSize="10" fill="var(--color-fg-4)">
              {r}
            </text>
          ))}
          <text x={X(1214)} y={152} textAnchor="end" className="ov-fade num" style={d(1300)} fontSize="9.5" fill="var(--color-accent-2)">
            envelope
          </text>
          <circle className="ov-pop" style={d(1300)} cx={now[0]} cy={now[1]} r="4" fill="var(--color-fg-1)" stroke="var(--color-bg-1)" strokeWidth="1.5" />
          <text className="ov-fade num" style={d(1400)} x={now[0] + 7} y={now[1] + 3} fontSize="10" fill="var(--color-fg-2)">
            now
          </text>
          <path className="ov-draw" style={{ ...d(1600), '--dur': '0.9s' } as CSSProperties} pathLength={1} d={`M${now[0] - 5} ${now[1] - 8} Q${(now[0] + prop[0]) / 2} ${Math.min(now[1], prop[1]) - 34} ${prop[0] + 8} ${prop[1] - 8}`} stroke="var(--color-accent)" strokeWidth="1.4" markerEnd="url(#st-arr)" />
          <g className="ov-pop" style={d(2100)}>
            <rect x={prop[0] - 5.5} y={prop[1] - 5.5} width="11" height="11" transform={`rotate(45 ${prop[0]} ${prop[1]})`} fill="var(--color-accent)" stroke="var(--color-bg-1)" strokeWidth="1.5" />
          </g>
          <text className="ov-fade num" style={d(2200)} x={prop[0] - 9} y={prop[1] + 18} fontSize="10" textAnchor="middle" fill="var(--color-accent-2)" fontWeight="600">
            1275
          </text>
        </svg>
      </Glass>
    </>
  )
}

/* ───────────── 05 Prove: before → after, with a significance test ───────────── */

export function ProveOverlay() {
  const W = 320
  const H = 170
  const X = (v: number) => 54 + (v / 3) * 250
  return (
    <>
      <Lbl x={70} y={60} delay={300}>
        <span className="h-1.5 w-1.5 rounded-full bg-accent anim-pulse" />
        closed loop · it 8 · <span className="text-ok">converged</span>
      </Lbl>
      <Lbl x={70} y={140} delay={500} className="max-sm:hidden">
        <span className="text-fg-3">twin prediction error</span> 1%
      </Lbl>
      <Glass className="bottom-[5%] left-[3.5%] w-[60%] sm:w-[50%]" delay={150} title="Verification" meta="90% CI · mm/s RMS">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" fill="none">
          <defs>
            <marker id="pv-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="var(--color-accent)" />
            </marker>
          </defs>
          {/* ISO zone wash */}
          <rect x={X(0)} y="14" width={X(1.8) - X(0)} height="96" fill="var(--color-iso-a)" opacity="0.7" />
          <rect x={X(1.8)} y="14" width={X(3) - X(1.8)} height="96" fill="var(--color-iso-b)" opacity="0.7" />
          {[0, 1, 2, 3].map((v) => (
            <g key={v}>
              <line x1={X(v)} x2={X(v)} y1="14" y2="110" stroke="var(--color-line-1)" />
              <text x={X(v)} y="124" textAnchor="middle" fontSize="10" className="num" fill="var(--color-fg-4)">
                {v}
              </text>
            </g>
          ))}
          <text x="6" y="40" fontSize="10.5" className="num" fill="var(--color-fg-3)">
            before
          </text>
          <text x="6" y="88" fontSize="10.5" className="num" fill="var(--color-fg-3)">
            after
          </text>
          {/* before 2.59 [2.41, 2.78] */}
          <path className="ov-draw" style={d(400)} pathLength={1} d={`M${X(2.41)} 36 H${X(2.78)} M${X(2.41)} 31 V41 M${X(2.78)} 31 V41`} stroke="var(--color-fg-2)" strokeWidth="1.3" />
          <circle className="ov-pop" style={d(600)} cx={X(2.59)} cy="36" r="4.5" fill="var(--color-fg-2)" />
          {/* after 0.30 [0.26, 0.35] + prediction */}
          <path className="ov-draw" style={d(1500)} pathLength={1} d={`M${X(0.24)} 84 H${X(0.36)} M${X(0.24)} 79 V89 M${X(0.36)} 79 V89`} stroke="var(--color-fg-1)" strokeWidth="1.3" />
          <g className="ov-pop" style={d(1450)}>
            <rect x={X(0.31) - 4.5} y={66 - 4.5} width="9" height="9" transform={`rotate(45 ${X(0.31)} 66)`} stroke="var(--color-accent)" strokeWidth="1.3" fill="var(--color-bg-1)" />
          </g>
          <text className="ov-fade num" style={d(1500)} x={X(0.31) + 9} y="69.5" fontSize="9.5" fill="var(--color-accent-2)">
            twin predicted 0.31
          </text>
          <circle className="ov-pop" style={d(1650)} cx={X(0.3)} cy="84" r="4.5" fill="var(--color-fg-1)" />
          <path className="ov-draw" style={{ ...d(800), '--dur': '0.9s' } as CSSProperties} pathLength={1} d={`M${X(2.5)} 44 C${X(1.9)} 52, ${X(1.3)} 60, ${X(0.62)} 66`} stroke="var(--color-accent)" strokeWidth="1.4" markerEnd="url(#pv-arr)" />
          <text className="ov-fade num" style={d(1800)} x={X(0.36) + 14} y="88" fontSize="11" fill="var(--color-fg-1)" fontWeight="600">
            0.30 · −89%
          </text>
          <text className="ov-fade num" style={d(700)} x={X(2.59)} y="24" fontSize="11" textAnchor="middle" fill="var(--color-fg-2)">
            2.59
          </text>
          <g className="ov-pop" style={d(2100)}>
            <rect x="54" y="138" width="186" height="20" rx="4" fill="var(--ok-dim)" stroke="var(--color-ok)" strokeOpacity="0.45" />
            <text x="62" y="152" fontSize="10.5" className="num" fill="var(--color-ok)">
              ✓ p = 3.8×10⁻⁸ · significant
            </text>
          </g>
        </svg>
      </Glass>
    </>
  )
}

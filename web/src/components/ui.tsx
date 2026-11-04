import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PipelineStage } from '../lib/protocol'
import { StageWait } from './StageWait'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** Plain-language explanation of every panel, shown by its (i) badge and used by the onboarding tour. */
export const PANEL_INFO: Record<string, string> = {
  'live view': 'The machine footage. Coloured regions are <b>virtual sensors</b> SAM 3.1 placed by name; each tracks sub-pixel motion like a contact-free accelerometer. <b>REF</b> is a static surface used to cancel camera shake.',
  spectrum: 'How strongly the machine vibrates at each frequency. Peaks at whole multiples of shaft speed (<b>1×, 2×…</b>) point to specific faults: 1× imbalance, 2× misalignment, blade pass flow.',
  waterfall: 'The spectrum over time, newest at the top. Lines that move with speed are <b>orders</b>; lines that stay put are <b>structural resonances</b>.',
  'campbell diagram': 'Speed against frequency. Where an order line crosses a natural frequency the machine <b>resonates</b>: a speed to avoid or lock out.',
  'resonance curve': 'Amplitude through a run-up or coast-down, with the fitted single-degree-of-freedom resonance: natural frequency and damping with error bars.',
  'operational modal analysis': 'Natural frequencies and mode shapes found from all virtual sensors together (frequency domain decomposition), with no hammer test.',
  'kinematic inference': 'Muse Spark reads what the machine <b>is</b> (engine stroke, blades, poles). A Bayesian model turns that into probabilities: which <b>speed</b> the sound implies and how likely each <b>fault</b> is, evidence in dB.',
  'digital twin': 'A model of this machine built from the measurements: predicted vibration and power at every speed, with uncertainty bands.',
  optimizer: 'The operating speed Muse Wonder proposes: least energy, clear of resonance bands, inside duty limits. <b>Nothing changes until you approve.</b>',
  'agent console': 'Muse Wonder thinking out loud. It only works from tool results, and every number it writes is <b>checked against the measurements</b> (✓ verified).',
  'model rail': 'Which Meta model is working right now and how long each call took: SAM 3.1, Muse Spark, Muse Wonder, Voice Transcribe, Muse Spark Open.',
  'agent actions': 'What the agents <b>do</b> about it: field-balance the rotor, lock the drive out of resonance, write the work order, cost the savings, schedule the re-check. Physical actions wait for your approval, then run and verify.',
}

export function InfoDot({ tip }: { tip: string }) {
  return (
    <span
      tabIndex={0}
      data-tip={tip}
      aria-label="What is this?"
      className="inline-flex h-[15px] w-[15px] shrink-0 cursor-help items-center justify-center rounded-full border border-line-2 text-[9px] font-semibold text-fg-3 hover:border-accent/60 hover:text-accent-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      i
    </span>
  )
}

export function Panel({
  title,
  meta,
  right,
  children,
  className,
  bodyClass,
  id,
  info,
}: {
  title: ReactNode
  meta?: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
  id?: string
  info?: string
}) {
  const tip = info ?? (typeof title === 'string' ? PANEL_INFO[title.toLowerCase()] : undefined)
  return (
    <section id={id} className={cx('glass flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', className)}>
      <header className="glass-head flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-line-1/70 pl-3.5 pr-2">
        <h2 className="eyebrow shrink-0 whitespace-nowrap">{title}</h2>
        {tip && <InfoDot tip={tip} />}
        {meta && <div className="num min-w-0 truncate text-[10.5px] text-fg-4">{meta}</div>}
        <div className="ml-auto flex shrink-0 items-center gap-1">{right}</div>
      </header>
      <div className={cx('relative min-h-0 flex-1', bodyClass)}>{children}</div>
    </section>
  )
}

/** One tooltip for the whole app: any element with data-tip (HTML allowed: our own strings only). */
export function TipLayer() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current!
    let cur: Element | null = null
    const show = (t: Element) => {
      cur = t
      el.innerHTML = t.getAttribute('data-tip') ?? ''
      const r = t.getBoundingClientRect()
      el.dataset.on = '1'
      const w = el.offsetWidth
      const h = el.offsetHeight
      const below = r.bottom + h + 10 < window.innerHeight
      el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`
      el.style.top = `${below ? r.bottom + 8 : r.top - h - 8}px`
    }
    const hide = () => {
      cur = null
      el.dataset.on = '0'
    }
    const over = (e: Event) => {
      const t = (e.target as Element | null)?.closest?.('[data-tip]')
      if (t && t !== cur) show(t)
      else if (!t && cur) hide()
    }
    document.addEventListener('mouseover', over, { passive: true })
    document.addEventListener('focusin', over)
    document.addEventListener('focusout', hide)
    window.addEventListener('scroll', hide, { passive: true, capture: true })
    return () => {
      document.removeEventListener('mouseover', over)
      document.removeEventListener('focusin', over)
      document.removeEventListener('focusout', hide)
      window.removeEventListener('scroll', hide, { capture: true })
    }
  }, [])
  return createPortal(<div ref={ref} role="tooltip" className="tip-layer glass-float" data-on="0" />, document.body)
}

export type Tone = 'neutral' | 'accent' | 'warn' | 'alarm' | 'ok' | 'muted'

const toneCls: Record<Tone, string> = {
  neutral: 'text-fg-2 border-line-2 bg-bg-2',
  muted: 'text-fg-3 border-line-1 bg-transparent',
  accent: 'text-accent-2 border-accent/35 bg-[var(--accent-dim)]',
  warn: 'text-warn border-warn/35 bg-[var(--warn-dim)]',
  alarm: 'text-alarm border-alarm/40 bg-[var(--alarm-dim)]',
  ok: 'text-ok border-ok/35 bg-[var(--ok-dim)]',
}

export function Chip({ tone = 'neutral', children, className, title, mono }: { tone?: Tone; children: ReactNode; className?: string; title?: string; mono?: boolean }) {
  return (
    <span title={title} className={cx('inline-flex h-[18px] items-center gap-1 rounded-[4px] border px-1.5 text-[10.5px] font-medium leading-none whitespace-nowrap', mono && 'num', toneCls[tone], className)}>
      {children}
    </span>
  )
}

type BtnVariant = 'ghost' | 'outline' | 'accent' | 'danger' | 'subtle'
const btnCls: Record<BtnVariant, string> = {
  ghost: 'text-fg-2 hover:text-fg-1 hover:bg-bg-3 border-transparent',
  subtle: 'text-fg-2 bg-bg-2 hover:bg-bg-3 hover:text-fg-1 border-line-2',
  outline: 'text-fg-1 bg-transparent hover:bg-bg-3 border-line-2',
  accent: 'text-on-accent bg-accent hover:bg-accent-2 border-transparent font-semibold shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_40%,transparent),0_6px_24px_-8px_color-mix(in_srgb,var(--color-accent)_60%,transparent)]',
  danger: 'text-alarm bg-transparent hover:bg-[var(--alarm-dim)] border-alarm/35',
}

export function Btn({
  variant = 'subtle',
  size = 'sm',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const sz = size === 'xs' ? 'h-6 px-2 text-[11px] gap-1' : size === 'sm' ? 'h-7 px-2.5 text-[12px] gap-1.5' : size === 'md' ? 'h-8 px-3 text-[12.5px] gap-2' : 'h-11 px-4 text-[13.5px] gap-2'
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex select-none items-center justify-center whitespace-nowrap rounded-md border font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-40',
        sz,
        btnCls[variant],
        className,
      )}
    >
      {children}
    </button>
  )
}

export function Seg<T extends string | number>({ value, options, onChange, className }: { value: T; options: { v: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx('inline-flex h-6 items-center rounded-md border border-line-2 bg-bg-2 p-[2px]', className)}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          title={o.title}
          onClick={() => onChange(o.v)}
          className={cx(
            'h-[18px] rounded-[4px] px-1.5 text-[10.5px] font-medium transition-colors',
            o.v === value ? 'bg-bg-4 text-fg-1 shadow-[inset_0_0_0_1px_var(--color-line-3)]' : 'text-fg-3 hover:text-fg-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function StatusDot({ state, size = 6 }: { state: 'idle' | 'running' | 'ok' | 'error' | 'warn' | 'live'; size?: number }) {
  const c =
    state === 'running' ? 'bg-accent anim-ring' : state === 'ok' ? 'bg-fg-2' : state === 'error' ? 'bg-alarm' : state === 'warn' ? 'bg-warn' : state === 'live' ? 'bg-alarm anim-pulse' : 'bg-fg-4'
  return <span className={cx('inline-block shrink-0 rounded-full', c)} style={{ width: size, height: size }} />
}

export function Sparkline({ data, w = 64, h = 18, color = 'var(--color-fg-3)', max, fill = true }: { data: number[]; w?: number; h?: number; color?: string; max?: number; fill?: boolean }) {
  if (data.length < 2) return <svg width={w} height={h} />
  const mx = max ?? Math.max(...data, 1e-6)
  const step = w / (data.length - 1)
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (Math.min(v, mx) / mx) * (h - 2)).toFixed(1)}`)
  return (
    <svg width={w} height={h} className="block overflow-visible">
      {fill && <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill={color} opacity={0.08} />}
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1} strokeLinejoin="round" />
    </svg>
  )
}

export function Readout({ value, unit, className, big }: { value: ReactNode; unit?: string; className?: string; big?: boolean }) {
  return (
    <span className={cx('num inline-flex items-baseline whitespace-nowrap text-fg-1', big ? 'text-[30px] font-normal leading-none tracking-[-0.03em]' : 'text-[13px] font-medium', className)}>
      {value}
      {unit && <span className={cx('num ml-1 font-normal text-fg-3', big ? 'text-[12px] tracking-normal' : 'text-[10.5px]')}>{unit}</span>}
    </span>
  )
}

/**
 * Empty / loading state. A faint skeleton of the chart that will appear (so the panel never looks
 * broken), the stage that will fill it (live from the model rail), and one line of guidance.
 */
export function Empty({ icon, title, hint, stage, skeleton = 'chart' }: { icon?: ReactNode; title: string; hint?: ReactNode; stage?: PipelineStage; skeleton?: 'chart' | 'heat' | 'table' | 'none' }) {
  return (
    <div className="anim-in absolute inset-0 overflow-hidden">
      {skeleton !== 'none' && (
        <div className="pointer-events-none absolute inset-3 opacity-60" aria-hidden>
          {skeleton === 'chart' && (
            <svg className="skeleton-svg h-full w-full" preserveAspectRatio="none" viewBox="0 0 400 160">
              {[30, 70, 110, 150].map((y) => (
                <line key={y} x1="0" x2="400" y1={y} y2={y} stroke="var(--color-grid)" />
              ))}
              <path d="M0 150 C40 148 60 120 80 140 S120 60 140 130 S190 146 220 120 S260 30 280 128 S340 148 400 142" stroke="var(--color-line-2)" strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
          {skeleton === 'heat' && <div className="skeleton h-full w-full rounded-[3px]" />}
          {skeleton === 'table' && (
            <div className="flex h-full flex-col justify-center gap-2">
              {[0.92, 0.75, 0.84, 0.6].map((w, i) => (
                <div key={i} className="skeleton h-2.5 rounded-[2px]" style={{ width: `${w * 100}%` }} />
              ))}
            </div>
          )}
        </div>
      )}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
        <div className="flex flex-col items-center gap-1.5 rounded-lg bg-bg-1/80 px-4 py-3 backdrop-blur-[2px]">
          {icon && <div className="mb-1 text-fg-4">{icon}</div>}
          <div className="text-[12px] font-medium text-fg-2">{title}</div>
          {hint && <div className="max-w-[300px] text-[11px] leading-relaxed text-fg-3">{hint}</div>}
          {stage && (
            <div className="mt-1.5">
              <StageWait stage={stage} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Hover tooltip rendered in a portal at fixed coordinates, so it is never clipped by a scrolling
 * panel. `content` is rendered above the trigger (below when there is no room).
 */
export function Tip({ content, children, className }: { content: ReactNode; children: ReactNode; className?: string }) {
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null)
  const tip = useRef<HTMLDivElement>(null)
  // keep the bubble inside the viewport horizontally
  useLayoutEffect(() => {
    const el = tip.current
    if (!el || !at) return
    const w = el.offsetWidth
    const left = Math.max(8, Math.min(window.innerWidth - 8 - w, at.x - w / 2))
    el.style.left = `${left}px`
    el.style.visibility = 'visible'
  }, [at])
  return (
    <span
      className={className}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        setAt({ x: r.left + r.width / 2, y: r.top < 64 ? r.bottom : r.top, below: r.top < 64 })
      }}
      onMouseLeave={() => setAt(null)}
    >
      {children}
      {at &&
        createPortal(
          <div
            ref={tip}
            role="tooltip"
            className="pointer-events-none invisible fixed z-[100] max-w-[320px] rounded-[5px] border border-line-2 bg-bg-2 px-2 py-1 text-[10.5px] leading-snug text-fg-2 shadow-[0_8px_24px_-8px_color-mix(in_srgb,var(--color-shadow)_80%,transparent)]"
            style={{ left: at.x, top: at.below ? at.y + 6 : at.y - 6, transform: at.below ? undefined : 'translateY(-100%)' }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  )
}

/** Tiny dot that flashes each time `tick` changes: the value next to it is streaming. */
export function LiveTick({ tick, className, title = 'streaming' }: { tick: unknown; className?: string; title?: string }) {
  if (tick == null) return <span className={cx('inline-block h-[5px] w-[5px] shrink-0 rounded-full bg-fg-4', className)} title="no data" />
  return <span key={String(tick)} title={title} className={cx('live-tick inline-block h-[5px] w-[5px] shrink-0 rounded-full bg-accent', className)} />
}

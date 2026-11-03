import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react'
import { cx } from '../components/ui'

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** true once the element has entered the viewport (never flips back). */
export function useInView<T extends Element>(opts: { margin?: string; threshold?: number } = {}) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  const { margin = '0px 0px -12% 0px', threshold = 0.15 } = opts
  useEffect(() => {
    const el = ref.current
    if (!el || inView) return
    if (reduced() || typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setInView(true)
          io.disconnect()
        }
      },
      { rootMargin: margin, threshold },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [inView, margin, threshold])
  return [ref, inView] as const
}

/**
 * Scroll reveal: fades and lifts children in once. Opacity/transform only (compositor, no layout
 * shift). `delay` in ms staggers siblings.
 */
export function Reveal({ children, className, delay = 0, as: Tag = 'div', style }: { children: ReactNode; className?: string; delay?: number; as?: ElementType; style?: CSSProperties }) {
  const [ref, inView] = useInView<HTMLElement>()
  return (
    <Tag ref={ref} data-in={inView ? '1' : undefined} className={cx('reveal', className)} style={{ ...style, '--d': `${delay}ms` } as CSSProperties}>
      {children}
    </Tag>
  )
}

/**
 * Number that counts up once when scrolled into view. The final value is rendered invisibly
 * underneath to reserve its exact width, so nothing reflows while digits change.
 */
export function CountUp({ value, decimals = 0, duration = 1400, prefix = '', suffix = '', className }: { value: number; decimals?: number; duration?: number; prefix?: string; suffix?: string; className?: string }) {
  const [ref, inView] = useInView<HTMLSpanElement>({ threshold: 0.4 })
  const out = useRef<HTMLSpanElement>(null)
  const fmt = (v: number) => `${prefix}${v.toFixed(decimals)}${suffix}`
  useEffect(() => {
    const el = out.current
    if (!el || !inView) return
    if (reduced()) {
      el.textContent = fmt(value)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const u = Math.min(1, (now - t0) / duration)
      const e = 1 - Math.pow(1 - u, 4) // ease-out-quart
      el.textContent = fmt(value * e)
      if (u < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [inView]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span ref={ref} className={cx('relative inline-grid', className)}>
      <span className="invisible col-start-1 row-start-1" aria-hidden>
        {fmt(value)}
      </span>
      <span ref={out} className="col-start-1 row-start-1 text-right" aria-label={fmt(value)}>
        {fmt(0)}
      </span>
    </span>
  )
}

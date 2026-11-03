import { useCallback, useRef, useState } from 'react'

/**
 * Measures an element's content box. Returns a ref object whose `current` is kept in sync
 * and which can be passed as a callback ref (works for elements that mount later).
 */
export function useSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ w: 0, h: 0 })
  const ro = useRef<ResizeObserver | null>(null)
  const node = useRef<T | null>(null)
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect()
    node.current = el
    if (!el) return
    ro.current = new ResizeObserver(([e]) => {
      const r = e.contentRect
      setSize((s) => (Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5 ? s : { w: Math.floor(r.width), h: Math.floor(r.height) }))
    })
    ro.current.observe(el)
  }, [])
  const box = ref as typeof ref & { current: T | null }
  Object.defineProperty(box, 'current', { get: () => node.current, configurable: true })
  return [box, size] as const
}

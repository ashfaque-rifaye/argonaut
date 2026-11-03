import { useEffect, useRef } from 'react'
import { colormapFor } from '../lib/colormap'
import { alpha, PALETTES, useTheme } from '../lib/theme'

/**
 * Procedural spectrogram of a 5-blade fan cycling run → coast-down → run-up, drawn live.
 * x = time (scrolls left), y = frequency 0–125 Hz. Orders 1×, 2×, 3× and blade-pass sweep with
 * speed and light up as they cross the three structural modes (14.2, 24.1, 61.5 Hz): exactly what
 * the console's waterfall shows on a real coast-down. Nothing here is an image.
 */
const F_MAX = 125
const N0 = 1476
const MODES = [
  { f: 14.2, z: 0.021, label: 'M1 14.2 Hz' },
  { f: 24.1, z: 0.034, label: 'M2 24.1 Hz' },
  { f: 61.5, z: 0.045, label: 'M3 61.5 Hz' },
]
const ORDERS = [
  { k: 1, a: 1, label: '1×' },
  { k: 2, a: 0.32, label: '2×' },
  { k: 3, a: 0.12, label: '3×' },
  { k: 5, a: 0.2, label: 'BPF' },
]
const H = (f: number, m: { f: number; z: number }) => {
  const r = f / m.f
  return 1 / Math.sqrt((1 - r * r) ** 2 + (2 * m.z * r) ** 2)
}
const resp = (f: number) => 0.6 + 0.05 * H(f, MODES[0]) + 0.07 * H(f, MODES[1]) + 0.05 * H(f, MODES[2])

/** speed profile, period 13 s: hold, coast-down, standstill, run-up */
function rpmAt(t: number) {
  const u = ((t % 13) + 13) % 13
  if (u < 2.5) return N0
  if (u < 9) {
    const tau = 1.9
    const T = 6.5
    const e = Math.exp(-T / tau)
    return N0 * ((Math.exp(-(u - 2.5) / tau) - e) / (1 - e))
  }
  if (u < 9.6) return 0
  return (N0 * (1 - Math.exp(-(u - 9.6) / 0.75))) / (1 - Math.exp(-3.4 / 0.75))
}

let seed = 11
const rnd = () => {
  seed = (seed * 16807) % 2147483647
  return (seed - 1) / 2147483646
}

export function HeroSpectrogram({ className }: { className?: string }) {
  const base = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const theme = useTheme()

  useEffect(() => {
    const c = base.current!
    const o = over.current!
    const g = c.getContext('2d', { alpha: false })!
    const go = o.getContext('2d')!
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const CM = colormapFor(theme)
    const P = PALETTES[theme]
    const light = theme === 'light'
    let raf = 0
    let w = 0
    let h = 0
    let dpr = 1
    let rows = 0
    let col: ImageData | null = null
    let t = 0
    let last = performance.now()
    const PX_PER_S = 70 // scroll speed (css px / s)

    const column = (rpm: number) => {
      const f1 = rpm / 60
      const s = (f1 / (N0 / 60)) ** 2
      const d = col!.data
      for (let i = 0; i < rows; i++) {
        const f = ((rows - 1 - i) / (rows - 1)) * F_MAX
        let p = 0.0035 + 0.012 / (1 + f * 0.5)
        for (const m of MODES) p += 0.012 / (1 + ((f - m.f) / (m.z * m.f * 1.6)) ** 2)
        if (f1 > 0.3) {
          for (const o of ORDERS) {
            const fk = o.k * f1
            if (fk > F_MAX + 3) continue
            const amp = o.a * s * resp(fk) * 0.55
            p += amp * Math.exp(-0.5 * ((f - fk) / 0.55) ** 2)
          }
        }
        p *= 0.75 + rnd() * 0.5
        const db = 20 * Math.log10(p / 0.003)
        const v = Math.max(0, Math.min(255, Math.round((db / 52) * 255)))
        const k = v * 3
        for (let y = 0; y < dpr; y++) {
          const idx = ((i * dpr + y) * col!.width) * 4
          for (let x = 0; x < col!.width; x++) {
            const j = idx + x * 4
            d[j] = CM[k]
            d[j + 1] = CM[k + 1]
            d[j + 2] = CM[k + 2]
            d[j + 3] = 255
          }
        }
      }
    }

    const resize = () => {
      dpr = Math.min(2, Math.round(window.devicePixelRatio || 1))
      w = c.clientWidth
      h = c.clientHeight
      for (const cv of [c, o]) {
        cv.width = Math.max(1, w * dpr)
        cv.height = Math.max(1, h * dpr)
      }
      rows = Math.max(2, Math.floor(c.height / dpr))
      col = g.createImageData(dpr, rows * dpr)
      g.fillStyle = light ? '#fbfbfd' : '#000004'
      g.fillRect(0, 0, c.width, c.height)
      // pre-fill the visible history so the first frame is already "live"
      const cols = Math.ceil(w)
      const secs = cols / PX_PER_S
      for (let x = 0; x < cols; x++) {
        column(rpmAt(t - secs + x / PX_PER_S))
        g.putImageData(col!, x * dpr, 0)
      }
    }

    const fmono = (px: number, wgt = 500) => `${wgt} ${px * dpr}px "JetBrains Mono Variable", ui-monospace, monospace`
    const Y = (f: number) => (1 - f / F_MAX) * h * dpr

    const overlay = (rpm: number) => {
      go.clearRect(0, 0, o.width, o.height)
      const f1 = rpm / 60
      const narrow = w < 768
      const x0 = o.width * (narrow ? 0.04 : 0.53)
      // structural modes: dashed hairlines with labels
      go.setLineDash([3 * dpr, 5 * dpr])
      go.lineWidth = dpr
      for (const m of MODES) {
        const y = Math.round(Y(m.f)) + 0.5
        go.strokeStyle = alpha(P.fg1, light ? 0.22 : 0.16)
        go.beginPath()
        go.moveTo(x0, y)
        go.lineTo(o.width - 120 * dpr, y)
        go.stroke()
        go.fillStyle = alpha(P.fg2, light ? 0.8 : 0.55)
        go.font = fmono(10)
        if (!narrow) go.fillText(m.label, x0 + 6 * dpr, y - 5 * dpr)
      }
      go.setLineDash([])
      // live order tags at the leading edge
      const xr = o.width - 12 * dpr
      let lastY = -1e9
      for (const ord of ORDERS) {
        const fk = ord.k * f1
        if (f1 < 0.5 || fk > F_MAX - 2) continue
        let y = Y(fk)
        if (Math.abs(y - lastY) < 16 * dpr) continue
        lastY = y
        y = Math.max(14 * dpr, y)
        const txt = `${ord.label} ${fk.toFixed(1)} Hz`
        go.font = fmono(10.5, 600)
        const tw = go.measureText(txt).width + 12 * dpr
        go.fillStyle = alpha(P.bg1, 0.86)
        go.strokeStyle = ord.k === 1 ? alpha(P.accent2, 0.7) : alpha(P.fg3, 0.6)
        go.beginPath()
        go.roundRect(xr - tw, y - 9 * dpr, tw, 18 * dpr, 4 * dpr)
        go.fill()
        go.stroke()
        go.fillStyle = ord.k === 1 ? P.accent2 : P.fg1
        go.fillText(txt, xr - tw + 6 * dpr, y + 4 * dpr)
      }
      // frequency axis
      if (!narrow) {
        go.font = fmono(9.5)
        go.fillStyle = alpha(P.fg3, 0.8)
        for (const f of [30, 60, 90, 120]) go.fillText(`${f}`, x0 - 24 * dpr, Y(f) + 4 * dpr)
        go.fillText('Hz', x0 - 24 * dpr, Y(F_MAX) + 16 * dpr)
      }
    }

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const shift = dt * PX_PER_S
      acc += shift
      const n = Math.floor(acc)
      if (n > 0) {
        acc -= n
        // scroll left by n css px and render n fresh columns at the right edge
        g.drawImage(c, n * dpr, 0, c.width - n * dpr, c.height, 0, 0, c.width - n * dpr, c.height)
        for (let k = n; k > 0; k--) {
          column(rpmAt(t + dt * (1 - (k - 1) / n)))
          g.putImageData(col!, c.width - k * dpr, 0)
        }
      }
      t += dt
      overlay(rpmAt(t))
      raf = requestAnimationFrame(frame)
    }
    let acc = 0
    t = 4 // the window opens mid coast-down with a full cycle of history behind it
    resize()
    overlay(rpmAt(t))
    const ro = new ResizeObserver(() => resize())
    ro.observe(c)
    if (!reduce) raf = requestAnimationFrame(frame)
    const vis = () => {
      cancelAnimationFrame(raf)
      if (!document.hidden && !reduce) {
        last = performance.now()
        raf = requestAnimationFrame(frame)
      }
    }
    document.addEventListener('visibilitychange', vis)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener('visibilitychange', vis)
    }
  }, [theme])

  return (
    <div className={className} aria-hidden>
      <canvas ref={base} className="absolute inset-0 h-full w-full" />
      <canvas ref={over} className="absolute inset-0 h-full w-full" />
    </div>
  )
}

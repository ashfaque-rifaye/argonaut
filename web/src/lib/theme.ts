// Theme: dark (graphite control room) and light (ISA-101 light-grey HMI).
//
// CSS owns the colours for everything rendered by the DOM/SVG (`--color-*` tokens in index.css,
// switched by `html[data-theme]`). Canvas and uPlot cannot read CSS variables, so this module
// mirrors the same tokens as plain hex (PALETTES) and exposes the current one through `pal()`.
// Keep the two in sync: index.css is the reference.
import { useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'

const DARK = {
  bg0: '#07080a',
  bg1: '#0d0f12',
  bg2: '#121519',
  bg3: '#191d22',
  line1: '#1c2127',
  line2: '#283038',
  line3: '#323a43',
  fg1: '#e7eaee',
  fg2: '#a2abb5',
  fg3: '#6c7580',
  fg4: '#4f5862',
  accent: '#9d8cff',
  accent2: '#c3b8ff',
  warn: '#f0a63a',
  alarm: '#f2484b',
  ok: '#3cbf8a',
  trace1: '#d8dee6',
  trace2: '#7b8693',
  grid: '#171b20',
  /** order cursors / faint structural lines on charts */
  faint: '#2a3139',
}
export type Palette = typeof DARK

const LIGHT: Palette = {
  bg0: '#dde1e6',
  bg1: '#f7f8fa',
  bg2: '#eef0f3',
  bg3: '#e5e8ec',
  line1: '#d5dae0',
  line2: '#c2c9d1',
  line3: '#aab2bc',
  fg1: '#11161c',
  fg2: '#38414c',
  fg3: '#525b66',
  fg4: '#6d7580',
  accent: '#6550e0',
  accent2: '#4e3bc4',
  warn: '#a35c00',
  alarm: '#cf2a2f',
  ok: '#0f7f53',
  trace1: '#1b2129',
  trace2: '#8a939e',
  grid: '#e6e9ed',
  faint: '#cdd3da',
}

export const PALETTES: Record<Theme, Palette> = { dark: DARK, light: LIGHT }

/** rgba() string from a palette hex. */
export function alpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/* ───────────── state ───────────── */

const KEY = 'argonaut-theme'
const listeners = new Set<() => void>()
const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: light)') : null

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

let current: Theme = stored() ?? (mq?.matches ? 'light' : 'dark')

function apply(t: Theme) {
  const el = document.documentElement
  el.dataset.theme = t
  el.style.colorScheme = t
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f7f8fa' : '#07080a')
}
if (typeof document !== 'undefined') apply(current)

mq?.addEventListener('change', (e) => {
  if (stored()) return // an explicit choice wins over the system
  setTheme(e.matches ? 'light' : 'dark', false)
})

export function getTheme() {
  return current
}
export function pal(): Palette {
  return PALETTES[current]
}

export function setTheme(t: Theme, persist = true) {
  if (persist) {
    try {
      localStorage.setItem(KEY, t)
    } catch {
      /* private mode: theme still applies for this page */
    }
  }
  if (t === current) return
  // suppress every CSS transition for one frame so the switch is a clean cut, not a 150 ms smear
  const root = document.documentElement
  root.classList.add('theme-switching')
  current = t
  apply(t)
  listeners.forEach((l) => l())
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')))
}
export const toggleTheme = () => setTheme(current === 'dark' ? 'light' : 'dark')

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )
}

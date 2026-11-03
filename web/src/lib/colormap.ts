import type { Theme } from './theme'

// Dark theme: inferno (perceptually uniform, starts near-black so it sits on the graphite base).
const INFERNO_STOPS = ['#000004', '#160b39', '#420a68', '#6a176e', '#932667', '#bc3754', '#dd513a', '#f37819', '#fca50a', '#f6d746', '#fcffa4']
// Light theme: paper → argon violet → ink. Monotonic in lightness (≈ L* 98 → 12), so it reads as a
// sequential map on a light panel and still prints in grayscale. The noise floor is near-white.
const LIGHT_STOPS = ['#fbfbfd', '#efedfb', '#ddd8f7', '#c4baf1', '#a796e8', '#8a72dc', '#6d52c9', '#553bab', '#3f2a85', '#2a1c5a', '#160f30']

const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
function lut(stops: string[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(256 * 3)
  const s = stops.map(hex)
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (s.length - 1)
    const k = Math.min(s.length - 2, Math.floor(x))
    const t = x - k
    for (let c = 0; c < 3; c++) out[i * 3 + c] = s[k][c] + (s[k + 1][c] - s[k][c]) * t
  }
  return out
}

export const INFERNO = lut(INFERNO_STOPS)
export const PAPER_VIOLET = lut(LIGHT_STOPS)
export const INFERNO_GRADIENT = `linear-gradient(90deg, ${INFERNO_STOPS.join(', ')})`
export const PAPER_GRADIENT = `linear-gradient(90deg, ${LIGHT_STOPS.join(', ')})`

export const colormapFor = (t: Theme) => (t === 'light' ? PAPER_VIOLET : INFERNO)
export const colormapGradient = (t: Theme) => (t === 'light' ? PAPER_GRADIENT : INFERNO_GRADIENT)
export const colormapName = (t: Theme) => (t === 'light' ? 'paper-violet' : 'inferno')

export const infernoCss = (v: number) => {
  const i = Math.max(0, Math.min(255, Math.round(v * 255))) * 3
  return `rgb(${INFERNO[i]},${INFERNO[i + 1]},${INFERNO[i + 2]})`
}

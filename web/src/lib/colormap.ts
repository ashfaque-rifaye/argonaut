// Inferno (perceptually uniform), 11 key stops → 256-entry RGB LUT.
const STOPS = ['#000004', '#160b39', '#420a68', '#6a176e', '#932667', '#bc3754', '#dd513a', '#f37819', '#fca50a', '#f6d746', '#fcffa4']
const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
export const INFERNO: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 3)
  const s = STOPS.map(hex)
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (s.length - 1)
    const k = Math.min(s.length - 2, Math.floor(x))
    const t = x - k
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = s[k][c] + (s[k + 1][c] - s[k][c]) * t
  }
  return lut
})()
export const infernoCss = (v: number) => {
  const i = Math.max(0, Math.min(255, Math.round(v * 255))) * 3
  return `rgb(${INFERNO[i]},${INFERNO[i + 1]},${INFERNO[i + 2]})`
}
export const INFERNO_GRADIENT = `linear-gradient(90deg, ${STOPS.join(', ')})`

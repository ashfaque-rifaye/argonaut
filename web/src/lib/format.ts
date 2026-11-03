export const fx = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d))
export const fint = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-US').replace(/,/g, ' ')
export const pct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)}%`
export const signed = (v: number, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export function niceTicks(min: number, max: number, count = 5) {
  const span = max - min || 1
  const step0 = span / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const norm = step0 / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10))
  return out
}
export const ISO_BOUNDS = { AB: 1.8, BC: 4.5, CD: 11.2, max: 16 }
export const zoneTone = (z?: string) => (z === 'D' ? 'alarm' : z === 'C' ? 'warn' : 'neutral') as 'alarm' | 'warn' | 'neutral'
export const toneColor = (t: string) =>
  t === 'alarm' ? 'var(--color-alarm)' : t === 'warn' ? 'var(--color-warn)' : t === 'ok' ? 'var(--color-ok)' : t === 'accent' ? 'var(--color-accent)' : 'var(--color-fg-2)'
export const fmtClock = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  return `${h ? String(h).padStart(2, '0') + ':' : ''}${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}
export const imgSrc = (b64: string) => (b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`)

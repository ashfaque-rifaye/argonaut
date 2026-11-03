import { useEffect, useRef, useState } from 'react'
import { AudioLines, Waves } from 'lucide-react'
import { useStore, waterfall } from '../lib/store'
import { INFERNO, INFERNO_GRADIENT } from '../lib/colormap'
import { niceTicks } from '../lib/format'
import { useSize } from '../lib/useSize'
import { ChannelPicker } from './SpectrumPanel'
import { Empty, Panel, Seg } from './ui'

const MONO = '"JetBrains Mono Variable", ui-monospace, monospace'
const M = { l: 36, r: 10, t: 6, b: 20 }

export function WaterfallPanel() {
  const [kind, setKind] = useState<'vib' | 'mic'>(() => (new URLSearchParams(location.search).get('wf') === 'mic' ? 'mic' : 'vib'))
  const sel = useStore((s) => s.selectedChannel)
  const ch = kind === 'mic' ? 'mic' : sel
  const hasMic = useStore((s) => s.msgCount > 0 && waterfall.bufs.has('mic'))
  const has = useStore((s) => s.msgCount > 0 && !!ch && waterfall.bufs.has(ch))
  const [box, size] = useSize<HTMLDivElement>()
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = canvas.current
    if (!cv || !size.w || !size.h || !ch) return
    const dpr = window.devicePixelRatio || 1
    cv.width = size.w * dpr
    cv.height = size.h * dpr
    const ctx = cv.getContext('2d')!
    const off = document.createElement('canvas')
    const octx = off.getContext('2d')!
    let lastVersion = -1
    let raf = 0

    const render = () => {
      raf = requestAnimationFrame(render)
      const b = waterfall.bufs.get(ch)
      if (!b || b.version === lastVersion) return
      lastVersion = b.version
      const cols = b.rows[b.rows.length - 1].length
      const nRows = 160
      if (off.width !== cols || off.height !== nRows) {
        off.width = cols
        off.height = nRows
      }
      const img = octx.createImageData(cols, nRows)
      const px = img.data
      // newest row at the top
      for (let r = 0; r < nRows; r++) {
        const src = b.rows[b.rows.length - 1 - r]
        const o = r * cols * 4
        if (!src) {
          for (let c = 0; c < cols; c++) {
            px[o + c * 4] = 7
            px[o + c * 4 + 1] = 8
            px[o + c * 4 + 2] = 10
            px[o + c * 4 + 3] = 255
          }
          continue
        }
        const n = src.length
        for (let c = 0; c < cols; c++) {
          const v = src[n === cols ? c : Math.min(n - 1, Math.round((c / (cols - 1)) * (n - 1)))]
          px[o + c * 4] = INFERNO[v * 3]
          px[o + c * 4 + 1] = INFERNO[v * 3 + 1]
          px[o + c * 4 + 2] = INFERNO[v * 3 + 2]
          px[o + c * 4 + 3] = 255
        }
      }
      octx.putImageData(img, 0, 0)

      const W = cv.width
      const H = cv.height
      const l = M.l * dpr
      const r = M.r * dpr
      const t = M.t * dpr
      const bt = M.b * dpr
      const pw = W - l - r
      const ph = H - t - bt
      ctx.clearRect(0, 0, W, H)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(off, l, t, pw, ph)
      ctx.strokeStyle = '#283038'
      ctx.lineWidth = 1
      ctx.strokeRect(l + 0.5, t + 0.5, pw - 1, ph - 1)

      const st = useStore.getState()
      const fx = (f: number) => l + (f / b.fMax) * pw
      // identified structural modes (vibration waterfall only)
      if (ch !== 'mic') ctx.setLineDash([3 * dpr, 4 * dpr])
      ctx.strokeStyle = 'rgba(231,234,238,0.32)'
      for (const m of ch === 'mic' ? [] : st.campbell?.modes ?? []) {
        const x = Math.round(fx(m.f_hz)) + 0.5
        ctx.beginPath()
        ctx.moveTo(x, t)
        ctx.lineTo(x, t + ph)
        ctx.stroke()
      }
      ctx.setLineDash([])
      // current order markers on the top edge
      const f1 = st.telemetry?.speed_hz ?? 0
      ctx.font = `500 ${9 * dpr}px ${MONO}`
      if (f1 > 0.8) {
        const marks: (readonly [number, string])[] =
          ch === 'mic'
            ? [
                [5, 'BPF'],
                [10, '2·BPF'],
                [15, '3·BPF'],
              ]
            : [
                [1, '1×'],
                [2, '2×'],
                [5, 'BPF'],
              ]
        for (const [k, lab] of marks) {
          const f = k * f1
          if (f > b.fMax) continue
          const x = fx(f)
          ctx.fillStyle = '#e7eaee'
          ctx.beginPath()
          ctx.moveTo(x - 4 * dpr, t)
          ctx.lineTo(x + 4 * dpr, t)
          ctx.lineTo(x, t + 6 * dpr)
          ctx.closePath()
          ctx.fill()
          ctx.fillStyle = 'rgba(13,15,18,.8)'
          const tw = ctx.measureText(lab).width + 6 * dpr
          const lx = x + 5 * dpr + tw > l + pw ? x - 5 * dpr - tw : x + 5 * dpr
          ctx.fillRect(lx, t + 2 * dpr, tw, 12 * dpr)
          ctx.fillStyle = '#e7eaee'
          ctx.fillText(lab, lx + 3 * dpr, t + 11 * dpr)
        }
      }
      // axes
      ctx.fillStyle = '#6c7580'
      ctx.font = `${10 * dpr}px ${MONO}`
      ctx.textAlign = 'center'
      for (const f of niceTicks(0, b.fMax, Math.max(3, Math.floor(pw / dpr / 70)))) {
        const x = fx(f)
        ctx.fillRect(Math.round(x), t + ph, dpr, 3 * dpr)
        ctx.fillText(`${f}`, x, H - 6 * dpr)
      }
      ctx.textAlign = 'right'
      const lastT = b.ts[b.ts.length - 1]
      const span = b.ts.length > 1 ? (lastT - b.ts[0]) / (b.ts.length - 1) : 0.25
      const secs = nRows * span
      for (const s of niceTicks(0, secs, Math.max(2, Math.floor(ph / dpr / 40)))) {
        const y = t + (s / secs) * ph
        ctx.fillRect(l - 3 * dpr, Math.round(y), 3 * dpr, dpr)
        ctx.fillText(s === 0 ? (b.clip ? `${lastT.toFixed(0)}s` : 'now') : b.clip ? `${Math.max(0, lastT - s).toFixed(0)}s` : `−${s}s`, l - 5 * dpr, y + 3.5 * dpr)
      }
      ctx.textAlign = 'left'
    }
    raf = requestAnimationFrame(render)
    return () => cancelAnimationFrame(raf)
  }, [size.w, size.h, ch])

  return (
    <Panel
      title="Waterfall"
      meta={kind === 'mic' ? 'acoustic · microphone · time × frequency' : 'order tracking · time × frequency'}
      right={
        <>
          <div className="mr-2 hidden items-center gap-1.5 lg:flex" title="Colormap: inferno, 0–68 dB re 4 µm/s">
            <span className="num text-[9.5px] text-fg-4">0</span>
            <span className="h-1.5 w-20 rounded-full" style={{ background: INFERNO_GRADIENT }} />
            <span className="num text-[9.5px] text-fg-4">68 dB</span>
          </div>
          {kind === 'vib' && <ChannelPicker />}
          <Seg
            value={kind}
            onChange={setKind}
            options={[
              { v: 'vib', label: <span className="inline-flex items-center gap-1"><Waves size={11} />Vibration</span>, title: 'Video-derived vibration (selected virtual sensor)' },
              {
                v: 'mic',
                label: (
                  <span className="inline-flex items-center gap-1">
                    <AudioLines size={11} />
                    Acoustic
                    {hasMic && kind !== 'mic' && <span className="h-1 w-1 rounded-full bg-accent" />}
                  </span>
                ),
                title: 'Microphone waterfall (blade-pass tone, harmonics)',
              },
            ]}
          />
        </>
      }
    >
      <div ref={box} className="absolute inset-0">
        <canvas ref={canvas} className="block h-full w-full" />
      </div>
 {!has && kind === 'mic' && <Empty title="No acoustic stream" hint="The microphone waterfall appears when the backend sends waterfall rows on channel “mic”." />}
      {!has && kind === 'vib' && <Empty title="Waiting for spectra" hint="Rows append at ~4 Hz. During a coast-down, order lines sweep toward 0 Hz and modes stay put." />}
    </Panel>
  )
}

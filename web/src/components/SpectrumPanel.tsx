import { useEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useStore } from '../lib/store'
import { useSize } from '../lib/useSize'
import type { SpectrumEvent } from '../lib/protocol'
import { cx, Empty, Panel, Seg } from './ui'
import { AudioLines } from 'lucide-react'
import { DealiasView } from './DealiasView'

const MONO = '"JetBrains Mono Variable", ui-monospace, monospace'

export function ChannelPicker() {
  const sensors = useStore((s) => s.sensors)
  const sel = useStore((s) => s.selectedChannel)
  const set = useStore((s) => s.set)
  const items = sensors?.items ?? []
  if (!items.length) return null
  return (
    <div className="inline-flex h-6 items-center rounded-md border border-line-2 bg-bg-2 p-[2px]">
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => set({ selectedChannel: it.id })}
          title={`${it.label}${it.is_reference ? ' (reference)' : ''}`}
          className={cx('num inline-flex h-[18px] items-center gap-1 rounded-[4px] px-1.5 text-[10px] transition-colors', sel === it.id ? 'bg-bg-4 text-fg-1 shadow-[inset_0_0_0_1px_#323a43]' : 'text-fg-3 hover:text-fg-2')}
        >
          <span className="h-1.5 w-1.5 rounded-[1px]" style={{ background: it.color, opacity: it.is_reference ? 0.6 : 1 }} />
          {it.id}
        </button>
      ))}
    </div>
  )
}

function drawAudioTick(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  // three tiny bars = "heard in audio"
  const hs = [0.5, 1, 0.7]
  for (let i = 0; i < 3; i++) {
    const h = 7 * r * hs[i]
    ctx.fillRect(x + i * 2.5 * r, y - h / 2, 1.4 * r, h)
  }
}

export function SpectrumPanel() {
  const ch = useStore((s) => s.selectedChannel)
  const spec = useStore((s) => (s.selectedChannel ? s.spectra[s.selectedChannel] : undefined))
  const sensor = useStore((s) => s.sensors?.items.find((i) => i.id === s.selectedChannel))
  const [scale, setScale] = useState<'lin' | 'log'>('lin')
  const [view, setView] = useState<'spectrum' | 'dealias'>('spectrum')
  const hasDealias = useStore((s) => Object.keys(s.dealias).length > 0)
  const anyAliased = !!spec?.peaks.some((p) => p.aliased)
  const [box, size] = useSize<HTMLDivElement>()
  const plot = useRef<uPlot | null>(null)
  const specRef = useRef<SpectrumEvent | undefined>(undefined)
  const yMax = useRef(1)
  const readout = useRef<HTMLSpanElement>(null)
  specRef.current = spec

  // (re)create plot
  useEffect(() => {
    const el = box.current
    if (!el || !size.w || !size.h) return
    if (plot.current) {
      plot.current.setSize({ width: size.w, height: size.h })
      return
    }
    const log = scale === 'log'
    const opts: uPlot.Options = {
      width: size.w,
      height: size.h,
      pxAlign: 1,
      padding: [14, 10, 0, 0],
      legend: { show: false },
      cursor: { y: false, points: { show: false }, drag: { x: false, y: false } },
      scales: {
        x: { time: false },
        y: log ? { distr: 3, range: () => [0.003, Math.max(0.1, yMax.current * 2)] } : { range: () => [0, yMax.current] },
      },
      axes: [
        {
          stroke: '#6c7580',
          font: `10px ${MONO}`,
          size: 22,
          gap: 4,
          grid: { stroke: '#171b20', width: 1 },
          ticks: { stroke: '#283038', width: 1, size: 3 },
          values: (_u, v) => v.map((x) => `${x}`),
        },
        {
          stroke: '#6c7580',
          font: `10px ${MONO}`,
          size: 38,
          gap: 4,
          grid: { stroke: '#171b20', width: 1 },
          ticks: { show: false },
          values: (_u, v) => v.map((x) => (x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(x < 0.01 ? 3 : 2))),
        },
      ],
      series: [
        {},
        {
          stroke: '#d8dee6',
          width: 1.25,
          points: { show: false },
          fill: (u) => {
            const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height)
            g.addColorStop(0, 'rgba(216,222,230,0.16)')
            g.addColorStop(1, 'rgba(216,222,230,0)')
            return g
          },
        },
      ],
      hooks: {
        draw: [
          (u) => {
            const s = specRef.current
            if (!s) return
            const ctx = u.ctx
            const r = uPlot.pxRatio
            const { left, top, width, height } = u.bbox
            const st = useStore.getState()
            ctx.save()
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
            ctx.beginPath()
            ctx.rect(left, top - 14 * r, width, height + 14 * r)
            ctx.clip()
            // v2 · measurable band: camera-direct up to Nyquist, then recovered by audio de-aliasing
            const band = st.telemetry?.band
            if (band) {
              const xd = u.valToPos(band.direct_hz, 'x', true)
              const xa = u.valToPos(Math.max(band.direct_hz, band.dealiased_hz), 'x', true)
              const xr = left + width
              const yb = top + height - 3 * r
              ctx.fillStyle = '#3a424c'
              ctx.fillRect(left, yb, Math.max(0, xd - left), 3 * r)
              if (band.dealiased_hz > band.direct_hz + 0.05) {
                ctx.fillStyle = 'rgba(157,140,255,0.38)'
                ctx.fillRect(xd, yb, Math.max(0, Math.min(xa, xr) - xd), 3 * r)
              } else {
                // nothing above Nyquist is trustworthy without a tachometer lock
                ctx.fillStyle = 'rgba(7,8,10,0.45)'
                ctx.fillRect(xd, top, Math.max(0, xr - xd), height)
              }
              if (xa < xr) {
                ctx.fillStyle = 'rgba(7,8,10,0.5)'
                ctx.fillRect(xa, top, xr - xa, height)
              }
              ctx.strokeStyle = '#3a434d'
              ctx.setLineDash([3 * r, 3 * r])
              ctx.lineWidth = r
              ctx.beginPath()
              ctx.moveTo(Math.round(xd) + 0.5, top)
              ctx.lineTo(Math.round(xd) + 0.5, top + height)
              ctx.stroke()
              ctx.setLineDash([])
              ctx.fillStyle = '#6c7580'
              ctx.font = `${9 * r}px ${MONO}`
              ctx.fillText(`fs/2 ${band.direct_hz.toFixed(1)} Hz`, xd + 4 * r, top + height * 0.55)
            }
            // identified modes (f ± err) — the accent marks model-identified features
            for (const [i, m] of [...(st.campbell?.modes ?? [])].sort((a, b) => a.f_hz - b.f_hz).entries()) {
              const x0 = u.valToPos(m.f_hz - m.f_err_hz, 'x', true)
              const x1 = u.valToPos(m.f_hz + m.f_err_hz, 'x', true)
              ctx.fillStyle = 'rgba(157,140,255,0.07)'
              ctx.fillRect(x0, top, Math.max(1, x1 - x0), height)
              ctx.fillStyle = 'rgba(195,184,255,0.75)'
              ctx.font = `${9 * r}px ${MONO}`
              ctx.fillText(`M${i + 1}`, (x0 + x1) / 2 - 6 * r, top + height - 4 * r)
            }
            // order cursors at k × running speed
            const f1 = st.telemetry?.speed_hz ?? 0
            if (f1 > 0.8) {
              ctx.strokeStyle = '#2a3139'
              ctx.setLineDash([2 * r, 3 * r])
              ctx.lineWidth = r
              for (let k = 1; k <= 8; k++) {
                const x = Math.round(u.valToPos(k * f1, 'x', true)) + 0.5
                if (x > left + width) break
                ctx.beginPath()
                ctx.moveTo(x, top)
                ctx.lineTo(x, top + height)
                ctx.stroke()
              }
              ctx.setLineDash([])
            }
            // peaks
            const boxes: [number, number, number, number][] = []
            ctx.font = `500 ${10 * r}px ${MONO}`
            const peaks = [...s.peaks].sort((a, b) => b.amp - a.amp)
            for (const p of peaks) {
              const x = u.valToPos(p.f_hz, 'x', true)
              const y = u.valToPos(Math.max(p.amp, 0.0031), 'y', true)
              const label = `${p.label} ${p.f_hz.toFixed(1)}`
              const aliased = !!p.aliased && p.f_alias_hz != null
              const tw = ctx.measureText(label).width + (p.corroborated_audio ? 14 * r : 0) + 10 * r
              const bh = 15 * r
              let bx = Math.min(Math.max(x - tw / 2, left), left + width - tw)
              let by = Math.max(top - 12 * r, y - bh - 8 * r)
              for (const b of boxes) if (bx < b[0] + b[2] && bx + tw > b[0] && by < b[1] + b[3] && by + bh > b[1]) by = b[1] + b[3] + 2 * r
              boxes.push([bx, by, tw, bh])
              // leader
              ctx.strokeStyle = '#454d56'
              ctx.lineWidth = r
              ctx.beginPath()
              ctx.moveTo(Math.round(x) + 0.5, by + bh)
              ctx.lineTo(Math.round(x) + 0.5, y - 3 * r)
              ctx.stroke()
              ctx.fillStyle = '#0d0f12'
              ctx.strokeStyle = aliased ? 'rgba(157,140,255,0.55)' : p.order === 1 ? '#5b6470' : '#323a43'
              if (aliased) ctx.setLineDash([2 * r, 2 * r])
              ctx.beginPath()
              ctx.roundRect(bx, by, tw, bh, 3 * r)
              ctx.fill()
              ctx.stroke()
              ctx.setLineDash([])
              ctx.fillStyle = '#e7eaee'
              ctx.fillText(label, bx + 5 * r, by + 10.5 * r)
              if (p.corroborated_audio) {
                ctx.fillStyle = '#a2abb5'
                drawAudioTick(ctx, bx + tw - 12 * r, by + bh / 2, r)
              }
              // 90% CI whisker on the amplitude
              if (p.amp_ci) {
                const y0 = u.valToPos(Math.max(p.amp_ci[0], 0.0031), 'y', true)
                const y1 = u.valToPos(Math.max(p.amp_ci[1], 0.0031), 'y', true)
                const xm = Math.round(x) + 0.5
                ctx.strokeStyle = 'rgba(231,234,238,0.8)'
                ctx.lineWidth = r
                ctx.beginPath()
                ctx.moveTo(xm, y0)
                ctx.lineTo(xm, y1)
                ctx.moveTo(xm - 3 * r, Math.round(y0) + 0.5)
                ctx.lineTo(xm + 3 * r, Math.round(y0) + 0.5)
                ctx.moveTo(xm - 3 * r, Math.round(y1) + 0.5)
                ctx.lineTo(xm + 3 * r, Math.round(y1) + 0.5)
                ctx.stroke()
              }
              if (aliased) {
                // hollow diamond = recovered by de-aliasing; ghost tick where the camera actually sees it
                const d = 3.6 * r
                ctx.fillStyle = '#0d0f12'
                ctx.strokeStyle = '#c3b8ff'
                ctx.lineWidth = 1.25 * r
                ctx.beginPath()
                ctx.moveTo(x, y - d)
                ctx.lineTo(x + d, y)
                ctx.lineTo(x, y + d)
                ctx.lineTo(x - d, y)
                ctx.closePath()
                ctx.fill()
                ctx.stroke()
                const xa = u.valToPos(p.f_alias_hz!, 'x', true)
                const yb = top + height - 3 * r
                ctx.strokeStyle = 'rgba(157,140,255,0.32)'
                ctx.lineWidth = r
                ctx.setLineDash([2 * r, 2.5 * r])
                ctx.beginPath()
                ctx.moveTo(xa, yb)
                ctx.quadraticCurveTo((xa + x) / 2, yb - Math.min(46 * r, Math.abs(x - xa) * 0.35), x, yb)
                ctx.stroke()
                ctx.setLineDash([])
                ctx.fillStyle = 'rgba(195,184,255,0.85)'
                ctx.fillRect(Math.round(xa) - 0.5 * r, yb - 5 * r, r, 5 * r)
              } else {
                ctx.fillStyle = '#e7eaee'
                ctx.beginPath()
                ctx.arc(x, y, 2.5 * r, 0, Math.PI * 2)
                ctx.fill()
              }
            }
            ctx.restore()
          },
        ],
        setCursor: [
          (u) => {
            const i = u.cursor.idx
            const el = readout.current
            if (!el) return
            if (i == null) {
              el.textContent = ''
              return
            }
            const f = u.data[0][i]
            const a = u.data[1][i]
            el.textContent = `${f.toFixed(2)} Hz · ${(a ?? 0).toFixed(3)} ${specRef.current?.unit ?? ''}`
          },
        ],
      },
    }
    const s = specRef.current
    plot.current = new uPlot(opts, s ? [s.f_hz, s.amp] : [[0, 1], [0, 0]], el)
  }, [size.w, size.h, scale]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      plot.current?.destroy()
      plot.current = null
    },
    [],
  )
  const changeScale = (v: 'lin' | 'log') => {
    plot.current?.destroy()
    plot.current = null
    setScale(v)
  }

  // data updates
  useEffect(() => {
    const u = plot.current
    if (!u || !spec) return
    const m = Math.max(...spec.amp)
    yMax.current = Math.max(0.2, m * 1.25, yMax.current * 0.94)
    u.setData([spec.f_hz, spec.amp])
  }, [spec])
  useEffect(() => {
    yMax.current = 0.2
  }, [ch])

  return (
    <Panel
      title="Spectrum"
      meta={
        sensor ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-[1px]" style={{ background: sensor.color }} />
            {sensor.id} · {sensor.label} · {spec?.unit ?? 'mm/s'} RMS
          </span>
        ) : undefined
      }
      right={
        <>
          <span ref={readout} className="num mr-2 hidden text-[10.5px] text-fg-2 lg:inline" />
          {view === 'spectrum' && (
            <span className="mr-1 hidden items-center gap-2.5 text-[10px] text-fg-4 2xl:inline-flex">
              <span className="inline-flex items-center gap-1">
                <AudioLines size={11} /> audio-corroborated
              </span>
              {anyAliased && (
                <span className="inline-flex items-center gap-1">
                  <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
                    <path d="M5 1 L9 5 L5 9 L1 5 Z" fill="none" stroke="#c3b8ff" strokeWidth="1.3" />
                  </svg>
                  de-aliased
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <svg width="7" height="10" viewBox="0 0 7 10" aria-hidden>
                  <path d="M1 1H6M3.5 1V9M1 9H6" stroke="#a2abb5" strokeWidth="1" fill="none" />
                </svg>
                90% CI
              </span>
            </span>
          )}
          <span className="hidden sm:inline-flex">
            <ChannelPicker />
          </span>
          {(hasDealias || anyAliased) && (
            <Seg
              value={view}
              onChange={setView}
              options={[
                { v: 'spectrum', label: 'SPECTRUM', title: 'Spectrum with 90% CI whiskers on the peaks' },
                { v: 'dealias', label: 'DE-ALIAS', title: 'How folded camera peaks are mapped back to their true frequency' },
              ]}
            />
          )}
          {view === 'spectrum' && (
            <Seg
              value={scale}
              onChange={changeScale}
              options={[
                { v: 'lin', label: 'LIN' },
                { v: 'log', label: 'LOG' },
              ]}
            />
          )}
        </>
      }
    >
      <div ref={box} className="absolute inset-0 pl-1 pt-1" />
      {!spec && view === 'spectrum' && <Empty title="No spectrum yet" hint="Spectra stream at ~4 Hz once the virtual sensors are tracking." />}
      {view === 'dealias' && (
        <div className="absolute inset-0 z-10 bg-bg-1">
          <DealiasView channel={ch} />
        </div>
      )}
    </Panel>
  )
}

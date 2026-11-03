import { useEffect, useState } from 'react'
import { CircleStop, Crosshair, Keyboard, Play, ShieldCheck, Sigma } from 'lucide-react'
import { useStore } from '../lib/store'
import { link } from '../lib/socket'
import { fmtClock } from '../lib/format'
import { Btn, cx, Sparkline, StatusDot, Tip } from './ui'
import { Logo } from './Logo'
import { ThemeToggle } from './ThemeToggle'
import { showShortcuts } from './Shortcuts'
import { onLink } from '../lib/router'
export { Logo }

function Micro({ label, children, title }: { label: string; children: React.ReactNode; title?: React.ReactNode }) {
  const body = (
    <span className="flex flex-col justify-center gap-[3px] leading-none">
      <span className="text-[8.5px] font-semibold uppercase tracking-[0.1em] text-fg-4">{label}</span>
      <span className="num flex items-baseline gap-1 whitespace-nowrap text-[12px] text-fg-1">{children}</span>
    </span>
  )
  return title ? <Tip content={title}>{body}</Tip> : body
}
const U = ({ children }: { children: React.ReactNode }) => <span className="text-[9.5px] text-fg-3">{children}</span>

/** Measurable band: camera-direct (≤ Nyquist) vs recovered with audio de-aliasing. */
export function BandBar({ direct, dealiased, w = 84, h = 5 }: { direct: number; dealiased: number; w?: number; h?: number }) {
  const full = Math.max(dealiased, direct, 1)
  const xd = (direct / full) * w
  return (
    <svg width={w} height={h} className="block shrink-0" aria-hidden>
      <defs>
        <pattern id="bb-hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="3" stroke="var(--color-accent)" strokeWidth="1.4" strokeOpacity="0.8" />
        </pattern>
      </defs>
      <rect x={0} y={0} width={w} height={h} rx={1} fill="var(--color-bg-2)" stroke="var(--color-line-2)" strokeWidth={0.75} />
      {dealiased > direct && <rect x={xd} y={0.5} width={w - xd - 0.5} height={h - 1} fill="url(#bb-hatch)" />}
      <rect x={0.5} y={0.5} width={Math.max(1, xd - 0.5)} height={h - 1} fill="var(--color-fg-2)" />
    </svg>
  )
}

/** Realtime health: frame → telemetry latency, input rate, drops, and the measurable band. */
function AcqStats() {
  const lat = useStore((s) => s.telemetry?.latency)
  const band = useStore((s) => s.telemetry?.band)
  const hist = useStore((s) => s.hist.latency)
  if (!lat && !band) return null
  const p95 = lat?.p95_ms ?? 0
  const tone = p95 > 300 ? 'text-alarm' : p95 > 150 ? 'text-warn' : 'text-fg-1'
  const dealiasing = band ? band.dealiased_hz > band.direct_hz + 0.05 : false
  return (
    <div className="hidden min-w-0 items-center gap-4 lg:flex">
      <div className="h-5 w-px bg-line-2" />
      {lat && (
        <Micro label="Latency" title={<span className="num">frame → telemetry · last {lat.frame_to_telemetry_ms.toFixed(1)} ms · p95 {lat.p95_ms.toFixed(1)} ms (rolling)</span>}>
          <span className={tone}>{lat.frame_to_telemetry_ms.toFixed(0)}</span>
          <U>ms</U>
          <span className="ml-1 text-[10.5px] text-fg-3">p95</span>
          <span className={cx('text-[11px]', tone === 'text-fg-1' ? 'text-fg-2' : tone)}>{lat.p95_ms.toFixed(0)}</span>
          <span className="ml-1 hidden self-center 2xl:inline-block">
            <Sparkline data={hist} w={36} h={12} max={Math.max(120, ...hist)} color="var(--color-fg-3)" fill={false} />
          </span>
        </Micro>
      )}
      {lat && (
        <Micro label="Input" title={<span className="num">{lat.fps_in.toFixed(1)} frames/s in · {lat.frames_dropped} frames dropped this session</span>}>
          {lat.fps_in.toFixed(1)}
          <U>fps</U>
          <span className={cx('ml-1 text-[11px]', lat.frames_dropped > 0 ? 'text-fg-2' : 'text-fg-3')}>{lat.frames_dropped}</span>
          <U>dropped</U>
        </Micro>
      )}
      {band && (
        <Micro
          label="Band"
          title={
            <span className="num">
              0–{band.direct_hz.toFixed(1)} Hz direct (camera Nyquist)
              {dealiasing ? ` · 0–${band.dealiased_hz.toFixed(0)} Hz with audio de-aliasing` : ' · de-aliasing inactive (no mic tachometer lock)'}
            </span>
          }
        >
          <span className="self-center">
            <BandBar direct={band.direct_hz} dealiased={band.dealiased_hz} />
          </span>
          <span className="text-[11px] text-fg-2">0–{band.direct_hz.toFixed(1)}</span>
          <span className="hidden text-[9.5px] text-fg-3 2xl:inline">Hz direct</span>
          {dealiasing && (
            <>
              <span className="text-fg-4">·</span>
              <span className="text-[11px] text-accent-2">0–{band.dealiased_hz.toFixed(0)}</span>
              <span className="text-[9.5px] text-fg-3">
                Hz <span className="hidden 2xl:inline">de-aliased</span>
              </span>
            </>
          )}
        </Micro>
      )}
    </div>
  )
}

function useClock(start: number) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [])
  return Math.max(0, (now - start) / 1000)
}

export function Header() {
  const mode = useStore((s) => s.mode)
  const conn = useStore((s) => s.conn)
  const sessionId = useStore((s) => s.sessionId)
  const assetName = useStore((s) => s.assetName)
  const asset = useStore((s) => s.asset)
  const rate = useStore((s) => s.msgRate)
  const startedAt = useStore((s) => s.startedAt)
  const proposal = useStore((s) => s.proposal)
  const elapsed = useClock(startedAt)

  const modeChip =
    mode === 'live' ? (
      <span className="inline-flex h-[22px] items-center gap-1.5 rounded-[5px] border border-alarm/35 bg-[var(--alarm-dim)] px-2 text-[10.5px] font-semibold tracking-[0.12em] text-alarm-2">
        <StatusDot state="live" /> LIVE
      </span>
    ) : mode === 'replay' ? (
      <span className="inline-flex h-[22px] items-center gap-1.5 rounded-[5px] border border-line-2 bg-bg-2 px-2 text-[10.5px] font-semibold tracking-[0.12em] text-fg-1">
        <Play size={10} fill="currentColor" /> REPLAY
      </span>
    ) : (
      <span title="Built-in simulator: no backend required" className="inline-flex h-[22px] items-center gap-1.5 rounded-[5px] border border-line-2 bg-bg-2 px-2 text-[10.5px] font-semibold tracking-[0.12em] text-fg-1">
        <span className="h-1.5 w-1.5 rounded-full bg-fg-2" /> SIM
      </span>
    )

  const connLabel = conn === 'open' ? 'Connected' : conn === 'connecting' ? 'Connecting' : conn === 'reconnecting' ? 'Reconnecting' : 'Offline'
  const connState = conn === 'open' ? 'ok' : conn === 'closed' ? 'error' : 'warn'
  const cmd = (name: 'start_coastdown' | 'stop' | 'identify' | 'optimize' | 'verify') => link.send({ type: 'command', name })

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line-1 bg-bg-1 px-3 md:px-4">
      <a href="/" onClick={onLink} aria-label="Argonaut home" title="Back to the overview" className="shrink-0 rounded-md transition-opacity hover:opacity-80">
        <Logo />
      </a>
      <div className="hidden h-5 w-px bg-line-2 md:block" />
      <div className="flex min-w-0 items-baseline gap-2.5">
        <span className="truncate whitespace-nowrap text-[13.5px] font-semibold text-fg-1 xl:shrink-0">{assetName}</span>
        {asset && (
          <span className="num hidden truncate text-[11px] text-fg-3 lg:inline">
            {asset.nameplate.rpm} rpm · {(asset.nameplate.kw * 1000).toFixed(0)} W · {asset.nameplate.poles}-pole
          </span>
        )}
      </div>
      <AcqStats />

      <div className="ml-auto flex items-center gap-1.5">
        <div className="hidden items-center gap-1 xl:flex">
          <Btn size="sm" variant="ghost" onClick={() => cmd('start_coastdown')} title="Command: start_coastdown">
            <Play size={13} /> <span className="hidden min-[1760px]:inline">Coast-down</span>
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => cmd('identify')} title="Command: identify">
            <Crosshair size={13} /> <span className="hidden min-[1760px]:inline">Identify</span>
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => cmd('optimize')} title="Command: optimize">
            <Sigma size={13} /> <span className="hidden min-[1760px]:inline">Optimize</span>
          </Btn>
          <Btn size="sm" variant="ghost" disabled={!proposal} onClick={() => cmd('verify')} title="Command: verify">
            <ShieldCheck size={13} /> <span className="hidden min-[1760px]:inline">Verify</span>
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => cmd('stop')} title="Command: stop">
            <CircleStop size={13} /> <span className="hidden min-[1760px]:inline">Stop</span>
          </Btn>
        </div>
        <div className="mx-2 hidden h-5 w-px bg-line-2 xl:block" />
        {modeChip}
        <span className="num hidden items-center gap-1.5 whitespace-nowrap rounded-[5px] border border-line-1 px-2 py-[3px] text-[11px] text-fg-2 sm:inline-flex" title="Session time">
          <span className="h-1.5 w-1.5 rounded-full bg-alarm" />
          REC {fmtClock(elapsed)}
        </span>
        <span className={cx('hidden items-center gap-1.5 whitespace-nowrap pl-1 text-[11px] text-fg-3 md:inline-flex')} title={sessionId ? `session ${sessionId}` : ''}>
          <StatusDot state={connState} />
          <span className="text-fg-2">{connLabel}</span>
          <span className="num text-fg-4">{rate} ev/s</span>
        </span>
        <div className="mx-1 hidden h-5 w-px bg-line-2 sm:block" />
        <button
          onClick={showShortcuts}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          className="hidden h-7 items-center gap-1 rounded-md border border-line-2 bg-bg-2 px-1.5 text-fg-3 transition-colors hover:border-line-3 hover:bg-bg-3 hover:text-fg-1 sm:inline-flex"
        >
          <Keyboard size={13} />
          <span className="num text-[10px]">?</span>
        </button>
        <ThemeToggle />
      </div>
    </header>
  )
}

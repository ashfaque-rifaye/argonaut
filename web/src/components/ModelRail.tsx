import { useStore, type StageState } from '../lib/store'
import { PIPELINE_STAGES, STAGE_META } from '../lib/protocol'
import { cx, Panel, StatusDot } from './ui'
import { STAGE_ICON } from './StageWait'

function LatencyBars({ data }: { data: number[] }) {
  const d = data.slice(-14)
  const mx = Math.max(...d, 1)
  return (
    <div className="flex h-3 items-end gap-[2px]" aria-hidden>
      {Array.from({ length: 14 }, (_, i) => {
        const v = d[i - (14 - d.length)]
        return <span key={i} className="w-[3px] rounded-[1px] bg-fg-4" style={{ height: v == null ? 2 : Math.max(2, (v / mx) * 12), opacity: v == null ? 0.3 : 0.5 + (i / 14) * 0.5 }} />
      })}
    </div>
  )
}

function Row({ s }: { s: StageState }) {
  const meta = STAGE_META[s.stage]
  const running = s.state === 'running'
  const err = s.state === 'error'
  const isMeta = s.stage !== 'dsp'
  return (
    <div className={cx('relative grid grid-cols-[26px_1fr_auto] items-center gap-x-2 overflow-hidden px-3 py-[7px]', running && 'bg-[linear-gradient(90deg,color-mix(in_srgb,var(--color-accent)_7%,transparent),transparent_70%)]')}>
      <div className={cx('flex h-[26px] w-[26px] items-center justify-center rounded-md border', running ? 'border-accent/45 text-accent-2' : err ? 'border-alarm/45 text-alarm' : s.state === 'ok' ? 'border-line-2 text-fg-2' : 'border-line-1 text-fg-4')}>
        {STAGE_ICON[s.stage](14)}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={cx('truncate text-[12px] font-semibold', s.state === 'idle' ? 'text-fg-3' : 'text-fg-1')}>{meta.name}</span>
          {isMeta && <span className="rounded-[3px] border border-line-1 px-1 text-[8.5px] font-semibold tracking-[0.08em] text-fg-4">META</span>}
          <span className="num truncate text-[10px] text-fg-4">{s.model}</span>
        </div>
        <div className={cx('truncate text-[11px]', running ? 'text-accent-2' : err ? 'text-alarm' : 'text-fg-3')} title={s.detail}>
          {s.detail}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          <span className="num text-[11px] text-fg-2">{running ? (s.stage === 'voice' ? 'live' : '…') : s.latency_ms ? (s.latency_ms >= 1000 ? `${(s.latency_ms / 1000).toFixed(2)} s` : `${s.latency_ms} ms`) : '—'}</span>
          <StatusDot state={s.state} />
        </div>
        <LatencyBars data={s.history} />
      </div>
      {running && (
        <div className="pointer-events-none absolute bottom-0 left-0 h-px w-full overflow-hidden">
          <div className="anim-scan h-px w-1/4 bg-[linear-gradient(90deg,transparent,var(--color-accent),transparent)]" />
        </div>
      )}
    </div>
  )
}

function Tile({ s }: { s: StageState }) {
  const meta = STAGE_META[s.stage]
  const running = s.state === 'running'
  const err = s.state === 'error'
  const lat = running ? (s.stage === 'voice' ? 'live' : '…') : s.latency_ms ? (s.latency_ms >= 1000 ? `${(s.latency_ms / 1000).toFixed(1)} s` : `${s.latency_ms} ms`) : '—'
  return (
    <div
      data-tip={`<b>${meta.name}</b> · ${s.model}<br/>${s.detail || s.state}`}
      className={cx('relative flex items-center gap-2 overflow-hidden rounded-[9px] border px-2 py-1.5', running ? 'border-accent/45 bg-[var(--accent-dim)]' : err ? 'border-alarm/40' : 'border-line-1 bg-bg-0/30')}
    >
      <span className={cx('shrink-0', running ? 'text-accent-2' : s.state === 'ok' ? 'text-fg-2' : 'text-fg-4')}>{STAGE_ICON[s.stage](13)}</span>
      <span className={cx('min-w-0 flex-1 truncate text-[11px] font-medium', s.state === 'idle' ? 'text-fg-3' : 'text-fg-1')}>{meta.name}</span>
      <span className="num text-[10.5px] text-fg-3">{lat}</span>
      <StatusDot state={s.state} />
    </div>
  )
}

export function ModelRail({ compact = false }: { compact?: boolean }) {
  const pipeline = useStore((s) => s.pipeline)
  const active = PIPELINE_STAGES.filter((k) => pipeline[k].state === 'running').length
  const live = PIPELINE_STAGES.filter((k) => k !== 'dsp' && pipeline[k].state !== 'idle').length
  return (
    <Panel
      title="Model rail"
      meta={`${live}/5 Meta models engaged`}
      right={
        <span className={cx('num inline-flex items-center gap-1.5 text-[10.5px]', active ? 'text-accent-2' : 'text-fg-4')}>
          <StatusDot state={active ? 'running' : 'idle'} /> {active} running
        </span>
      }
      bodyClass={compact ? 'grid grid-cols-2 gap-1.5 p-2' : 'divide-y divide-line-1'}
    >
      {PIPELINE_STAGES.map((k) => (compact ? <Tile key={k} s={pipeline[k]} /> : <Row key={k} s={pipeline[k]} />))}
    </Panel>
  )
}

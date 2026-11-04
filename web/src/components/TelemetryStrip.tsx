import { useState } from 'react'
import { AudioLines, ChevronRight, Info, Mic, OctagonAlert, TriangleAlert, Video } from 'lucide-react'
import { useStore } from '../lib/store'
import { fint, fx } from '../lib/format'
import { IsoBar } from './IsoBar'
import { cx, LiveTick, Sparkline, Tip } from './ui'

export const UNCAL_TIP = 'No credible scale reference in this footage: amplitudes are relative; frequencies, orders, phase and ratios remain valid'

/** v4 · telemetry.calibrated === false: the absolute mm/s scale is not trustworthy. */
function UncalBadge() {
  return (
    <Tip content={UNCAL_TIP}>
      <span tabIndex={0} aria-label={`Uncalibrated, relative amplitudes. ${UNCAL_TIP}`} className="num inline-flex h-[20px] cursor-help items-center whitespace-nowrap rounded-[4px] border border-dashed border-line-3 px-1.5 text-[10px] font-semibold tracking-[0.04em] text-fg-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">
        uncalibrated · relative
      </span>
    </Tip>
  )
}

function SourceChip({ on, icon, label }: { on: boolean; icon: React.ReactNode; label: string }) {
  return (
    <span
      title={`${label} ${on ? 'contributes to the speed estimate' : 'not contributing'}`}
      className={cx('inline-flex h-[18px] items-center gap-1 rounded-[4px] border px-1.5 text-[10px] font-medium', on ? 'border-line-2 bg-bg-3 text-fg-1' : 'border-line-1 text-fg-4')}
    >
      {icon}
      {label}
    </span>
  )
}

/** Human label for telemetry.speed_source */
function SpeedSourceBadge({ src }: { src: string }) {
  if (!src) return null
  const audioOnly = src.startsWith('audio')
  const detail = /\((.+)\)/.exec(src)?.[1]
  const text = src.includes('ambiguous') ? 'mic tachometer · speed ambiguous' : audioOnly ? `mic tachometer${detail ? ` · ${detail}` : ''}` : src === 'video' ? 'optical tach · video' : src.includes('video') && src.includes('audio') ? 'fused · video + audio' : src === 'none' ? 'no rotation' : src
  return (
    <span
      title={`speed_source: ${src}`}
      className={cx(
        'inline-flex h-[17px] max-w-full items-center gap-1 truncate rounded-[4px] border px-1.5 text-[10px] font-medium',
        audioOnly ? 'border-accent/35 bg-[var(--accent-dim)] text-accent-2' : 'border-line-1 text-fg-3',
      )}
    >
      {audioOnly ? <Mic size={10} /> : src.includes('video') ? <Video size={10} /> : null}
      {text}
    </span>
  )
}

function ZoneBadge({ zone }: { zone?: string | null }) {
  const cls = zone === 'D' ? 'text-alarm border-alarm/45 bg-[var(--alarm-dim)]' : zone === 'C' ? 'text-warn border-warn/40 bg-[var(--warn-dim)]' : 'text-fg-2 border-line-2 bg-bg-2'
  return <span className={cx('num inline-flex h-[20px] items-center rounded-[4px] border px-1.5 text-[10.5px] font-semibold tracking-[0.06em]', cls)}>ZONE {zone ?? '–'}</span>
}

export function TelemetryStrip() {
  const tel = useStore((s) => s.telemetry)
  const hist = useStore((s) => s.hist)
  const sensors = useStore((s) => s.sensors)
  const diagnoses = useStore((s) => s.diagnoses)
  const proposal = useStore((s) => s.proposal)
  const proposalStatus = useStore((s) => s.proposalStatus)
  const openEvidence = useStore((s) => s.openEvidence)
  const selected = useStore((s) => s.selectedChannel)
  const setSel = (id: string) => useStore.getState().set({ selectedChannel: id })
  const [acked, setAcked] = useState<Record<string, boolean>>({})

  const src = tel?.speed_source ?? ''
  const diag = [...diagnoses].reverse()[0]
  const meta = (id: string) => sensors?.items.find((i) => i.id === id)
  const uncal = tel?.calibrated === false
  const zone = uncal ? null : tel?.iso_zone
  const marker = !uncal && proposal && (proposalStatus === 'pending' || proposalStatus === 'submitting') ? proposal.proposed.vel_mm_s : null

  return (
    <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-px bg-bg-0 md:grid-cols-[minmax(200px,230px)_minmax(280px,340px)_1fr] xl:grid-cols-[minmax(210px,240px)_minmax(300px,360px)_1fr_minmax(300px,380px)]">
      {/* speed */}
      <div className="flex flex-col justify-between bg-bg-1 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <span className="eyebrow">Shaft speed</span>
            <LiveTick tick={tel?.t} title="telemetry streaming" />
          </span>
          <div className="flex gap-1">
            <SourceChip on={src.includes('video')} icon={<Video size={10} />} label="video" />
            <SourceChip on={src.includes('audio')} icon={<AudioLines size={10} />} label="audio" />
          </div>
        </div>
        <div className="mt-1.5 flex items-end justify-between gap-2">
          <div className="flex flex-col">
            <span className="num text-[30px] leading-none tracking-[-0.03em] text-fg-1">
              {fint(tel?.speed_rpm)}
              <span className="ml-1 text-[12px] tracking-normal text-fg-3">rpm</span>
            </span>
            <span className="num mt-1 text-[11px] text-fg-3">
              <span className="text-fg-2">{fx(tel?.speed_hz, 2)}</span> Hz · 1×
            </span>
            <span className="mt-1">
              <SpeedSourceBadge src={src} />
            </span>
          </div>
          <Sparkline data={hist.speed} w={72} h={30} max={1800} color="var(--color-fg-3)" />
        </div>
      </div>

      {/* overall severity */}
      <div className="flex flex-col justify-between bg-bg-1 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="eyebrow truncate">Overall velocity · ISO 20816</span>
            <LiveTick tick={tel?.t} title="telemetry streaming" />
          </span>
          {uncal ? <UncalBadge /> : <ZoneBadge zone={zone} />}
        </div>
        <div className="mt-1 flex items-end gap-3">
          <span
            className={cx('num text-[30px] leading-none tracking-[-0.03em]', uncal ? 'text-fg-3' : zone === 'D' ? 'text-alarm' : zone === 'C' ? 'text-warn' : 'text-fg-1')}
            title={uncal ? UNCAL_TIP : undefined}
          >
            {fx(tel?.overall_vel_mm_s_rms, 2)}
            <span className={cx('ml-1 text-[12px] tracking-normal', uncal ? 'text-fg-4' : 'text-fg-3')}>{uncal ? 'rel. mm/s RMS' : 'mm/s RMS'}</span>
          </span>
          {tel?.overall_vel_ci && !uncal && (
            <span className="num mb-[2px] hidden whitespace-nowrap text-[10.5px] leading-tight text-fg-3 sm:inline" title="90% confidence interval of the overall velocity">
              <span className="text-fg-4">90% CI </span>
              <span className="text-fg-2">
                {fx(tel.overall_vel_ci[0], 2)}–{fx(tel.overall_vel_ci[1], 2)}
              </span>
            </span>
          )}
        </div>
        <div className="mt-1">
          <IsoBar value={tel?.overall_vel_mm_s_rms ?? null} marker={marker} height={8} ci={tel?.overall_vel_ci} uncalibrated={uncal} />
        </div>
      </div>

      {/* channels */}
      <div className="col-span-2 flex min-w-0 overflow-x-auto bg-bg-1 md:col-span-1">
        <div className="grid w-full min-w-max auto-cols-[minmax(108px,1fr)] grid-flow-col xl:auto-cols-[minmax(0,1fr)] divide-x divide-line-1 md:min-w-0">
          {(tel?.channels ?? []).map((c) => {
            const m = meta(c.id)
            const cz = uncal ? null : c.iso_zone
            const zc = cz === 'D' ? 'text-alarm' : cz === 'C' ? 'text-warn' : 'text-fg-3'
            return (
              <button
                key={c.id}
                onClick={() => setSel(c.id)}
                className={cx('group flex min-w-0 flex-col justify-between px-2.5 py-2.5 text-left transition-colors hover:bg-bg-2', selected === c.id && 'bg-bg-2 shadow-[inset_0_-2px_0_0_var(--color-accent)]')}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: m?.color ?? 'var(--color-fg-3)' }} />
                  <span className="truncate text-[11px] font-medium text-fg-2 group-hover:text-fg-1">{m?.label ?? c.id}</span>
                  <span className={cx('num ml-auto text-[10px] font-semibold', zc)}>{cz}</span>
                </div>
                <div className="mt-1 flex items-baseline gap-1" title={uncal ? UNCAL_TIP : undefined}>
                  <span className={cx('num text-[17px] leading-none', uncal ? 'text-fg-3' : 'text-fg-1')}>{fx(c.vel_mm_s_rms, 2)}</span>
                  <span className="num text-[10px] text-fg-4">{uncal ? 'rel. mm/s' : 'mm/s'}</span>
                </div>
                <div className="mt-1 flex items-end justify-between gap-1">
                  <span className={cx('num text-[10px]', uncal ? 'text-fg-4' : 'text-fg-3')}>{fx(c.disp_mm_rms * 1000, 0)} µm{uncal ? ' rel.' : ''}</span>
                  <Sparkline data={hist.channels[c.id] ?? []} w={52} h={14} color={m?.color ?? 'var(--color-fg-3)'} max={12} />
                </div>
              </button>
            )
          })}
          {!tel && <div className="flex items-center px-3 text-[11px] text-fg-4">Waiting for virtual sensors…</div>}
        </div>
      </div>

      {/* active diagnosis (L1 alarm summary) */}
      <div
        className={cx(
          'relative col-span-2 hidden min-w-0 flex-col justify-between bg-bg-1 px-3 py-2.5 md:col-span-3 xl:col-span-1 xl:flex',
          diag?.severity === 'alarm' && !acked[diag.id] && 'anim-alarm',
        )}
      >
        {diag ? (
          <>
            <div className="flex items-center gap-2">
              {diag.severity === 'alarm' ? <OctagonAlert size={13} className="text-alarm" /> : diag.severity === 'warn' ? <TriangleAlert size={13} className="text-warn" /> : <Info size={13} className="text-fg-2" />}
              <span className={cx('eyebrow', diag.severity === 'alarm' ? '!text-alarm' : diag.severity === 'warn' ? '!text-warn' : '')}>{diag.severity === 'info' ? 'Status' : diag.severity}</span>
              <span className="num ml-auto text-[10px] text-fg-4">conf {(diag.confidence * 100).toFixed(0)}% · {diag.model}</span>
            </div>
            <div className="mt-1 truncate text-[13px] font-semibold text-fg-1">{diag.title}</div>
            <div className="mt-1 flex items-center gap-2">
              <button
                onClick={() => openEvidence({ title: diag.title, evidence: diag.evidence, focus: 0, source: diag.model })}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-fg-2 hover:text-fg-1"
              >
                Evidence ({diag.evidence.length}) <ChevronRight size={12} />
              </button>
              {diag.severity === 'alarm' && !acked[diag.id] && (
                <button onClick={() => setAcked((a) => ({ ...a, [diag.id]: true }))} className="ml-auto rounded-[4px] border border-alarm/45 px-1.5 py-[1px] text-[10px] font-semibold tracking-[0.08em] text-alarm hover:bg-[var(--alarm-dim)]">
                  ACK
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <span className="eyebrow">Diagnosis</span>
            <div className="text-[12px] text-fg-3">No abnormal condition detected</div>
            <div className="text-[10.5px] text-fg-4">Muse Wonder posts findings here with evidence.</div>
          </>
        )}
      </div>
    </div>
  )
}

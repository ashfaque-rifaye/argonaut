import type { ReactNode } from 'react'
import { AudioLines, BrainCircuit, Lock, ScanEye, Sparkles, Waves } from 'lucide-react'
import { useStore } from '../lib/store'
import { STAGE_META, type PipelineStage } from '../lib/protocol'

export const STAGE_ICON: Record<PipelineStage, (size: number) => ReactNode> = {
  sam: (s) => <ScanEye size={s} />,
  spark: (s) => <Sparkles size={s} />,
  wonder: (s) => <BrainCircuit size={s} />,
  voice: (s) => <AudioLines size={s} />,
  dsp: (s) => <Waves size={s} />,
  open_weights: (s) => <Lock size={s} />,
}

/**
 * The model-rail row for one stage, shrunk into a chip: what an empty panel is waiting on, live.
 * "running" = violet scan + task detail; idle = gray "standby".
 */
export function StageWait({ stage }: { stage: PipelineStage }) {
  const st = useStore((s) => s.pipeline[stage])
  const running = st.state === 'running'
  const err = st.state === 'error'
  return (
    <div
      className={
        'relative inline-flex max-w-full items-center gap-2 overflow-hidden rounded-md border px-2 py-1 text-left transition-colors duration-300 ' +
        (running ? 'border-accent/40 bg-[var(--accent-dim)]' : err ? 'border-alarm/40 bg-[var(--alarm-dim)]' : 'border-line-2 bg-bg-2')
      }
    >
      <span className={running ? 'text-accent-2' : err ? 'text-alarm' : 'text-fg-3'}>{STAGE_ICON[stage](12)}</span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="flex items-center gap-1.5 text-[10.5px] font-semibold text-fg-1">
          {STAGE_META[stage].name}
          <span className="num text-[9.5px] font-normal text-fg-4">{st.model}</span>
        </span>
        <span className={'num truncate text-[10px] ' + (running ? 'text-accent-2' : 'text-fg-3')}>{running ? st.detail || 'working…' : err ? st.detail || 'error' : st.state === 'ok' ? st.detail || 'done' : 'standby'}</span>
      </span>
      <span className={'ml-1 h-1.5 w-1.5 shrink-0 rounded-full ' + (running ? 'bg-accent anim-ring' : err ? 'bg-alarm' : 'bg-fg-4')} />
      {running && (
        <span className="pointer-events-none absolute bottom-0 left-0 h-px w-full overflow-hidden">
          <span className="anim-scan block h-px w-1/3 bg-[linear-gradient(90deg,transparent,var(--color-accent),transparent)]" />
        </span>
      )}
    </div>
  )
}

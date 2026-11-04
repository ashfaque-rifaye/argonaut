import { useEffect, useRef, useState, type DragEvent } from 'react'
import { History, Upload } from 'lucide-react'
import { useStore } from '../lib/store'
import type { LibraryClip } from '../lib/protocol'
import { chooseFile, loadLibrary, openRecorded, recordedRunId, startPlay } from '../lib/library'
import { kindIcon } from './SourceDrawer'
import { cx } from './ui'

/** One real clip per machine type first (fan, engine, washer, pump, motor...), then the rest. */
function ordered(clips: LibraryClip[]): LibraryClip[] {
  const real = clips.filter((c) => c.real)
  const seen = new Set<string>()
  const first: LibraryClip[] = []
  const rest: LibraryClip[] = []
  for (const c of [...real.filter((c) => c.featured), ...real.filter((c) => !c.featured)]) {
    if (seen.has(c.kind)) rest.push(c)
    else {
      seen.add(c.kind)
      first.push(c)
    }
  }
  return [...first, ...rest]
}

export function isVideoFile(f: File | undefined | null): boolean {
  return !!f && (f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name))
}

/** Drag-and-drop handlers: drop a video anywhere on the target to run it through the engine. */
export function useVideoDrop() {
  const [over, setOver] = useState(false)
  const handlers = {
    onDragOver: (e: DragEvent) => {
      if (![...e.dataTransfer.items].some((i) => i.kind === 'file')) return
      e.preventDefault()
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      setOver(false)
      const f: File | undefined = e.dataTransfer.files?.[0]
      if (!f) return
      if (isVideoFile(f)) void chooseFile(f)
      else useStore.getState().pushConsole({ kind: 'error', text: `${f.name} is not a video (mp4, mov, webm)` })
    },
  }
  return { over, handlers }
}

export function SampleStrip() {
  const clips = useStore((s) => s.library)
  const runs = useStore((s) => s.runs)
  const np = useStore((s) => s.nowPlaying)
  const mode = useStore((s) => s.mode)
  const sessionId = useStore((s) => s.sessionId)
  const localClip = useStore((s) => s.localClip)
  const fileRef = useRef<HTMLInputElement>(null)
  const { over, handlers } = useVideoDrop()
  const libraryState = useStore((s) => s.libraryState)
  useEffect(() => {
    // the strip is always on screen, so it owns fetching the library (and retrying a busy backend)
    if (libraryState === 'ready' || libraryState === 'loading') return
    const t = window.setTimeout(() => void loadLibrary(true), libraryState === 'error' ? 5000 : 0)
    return () => window.clearTimeout(t)
  }, [libraryState])
  if (!clips?.length) return null
  const list = ordered(clips)

  const play = (c: LibraryClip) => {
    const run = recordedRunId(c, runs)
    // live backend: analyse for real; replay pages (no backend session) open the recorded run if there is one
    if (mode !== 'live' && run) openRecorded(run)
    else void startPlay(c, 'analyse')
  }

  return (
    <section aria-label="Machine samples" className="w-full border-t border-line-1 bg-bg-1">
      <div className="flex h-6 items-center gap-2 px-3">
        <h2 className="eyebrow">Machines</h2>
        <span className="text-[10px] text-fg-4">
          {list.length} real recordings · click to analyse{runs.length ? ' · ↺ = instant recorded run' : ''}
        </span>
      </div>
      <ul className="scroll-thin flex gap-1.5 overflow-x-auto px-2 pb-2" role="list">
        <li className="shrink-0">
          <button
            type="button"
            {...handlers}
            onClick={() => fileRef.current?.click()}
            title="Analyse your own video: click to choose, or drop an mp4 / mov here. Audio improves the speed estimate."
            className={cx(
              'flex h-[62px] w-[86px] flex-col items-center justify-center gap-1 rounded-[5px] border border-dashed text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
              over ? 'border-accent bg-[var(--accent-dim)] text-accent-2' : localClip ? 'border-line-3 bg-bg-2 text-fg-1' : 'border-line-3 text-fg-2 hover:border-accent/60 hover:text-fg-1',
            )}
          >
            <Upload size={14} />
            <span className="leading-tight">{over ? 'Drop to analyse' : 'Upload video'}</span>
          </button>
          <input ref={fileRef} type="file" accept="video/*,.mp4,.mov,.m4v,.webm" className="hidden" onChange={(e) => isVideoFile(e.target.files?.[0]) && void chooseFile(e.target.files![0])} />
        </li>
        {list.map((c) => {
          const run = recordedRunId(c, runs)
          const active = (np?.clip.id === c.id && !localClip) || (mode === 'replay' && !!run && sessionId === run)
          return (
            <li key={c.id} className="shrink-0">
              <button
                type="button"
                onClick={() => play(c)}
                title={`${c.title}\n${c.note ?? ''}\nFootage: ${c.credit ?? 'unknown'} · ${c.license ?? ''}`}
                aria-pressed={active}
                className={cx(
                  'group relative block h-[62px] w-[104px] overflow-hidden rounded-[5px] bg-black text-left ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  active ? 'ring-2 ring-accent' : 'ring-line-1 hover:ring-line-3',
                )}
              >
                {c.poster_url && <img src={c.poster_url} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 h-full w-full object-cover opacity-80 transition-[opacity,transform] duration-300 group-hover:scale-[1.05] group-hover:opacity-100" />}
                <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
                <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded-[3px] bg-black/70 px-1 py-[1px] text-[9px] text-white/90">
                  {kindIcon(c.kind, 9)}
                  {c.kind}
                </span>
                {run && (
                  <span className="absolute right-1 top-1 rounded-[3px] bg-black/70 p-[2px] text-white/80" title="Recorded run available (instant, no API key)">
                    <History size={9} />
                  </span>
                )}
                <span className="absolute inset-x-1 bottom-1 line-clamp-2 text-[9.5px] font-medium leading-[1.15] text-white">{c.title}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Building2, Camera, Cog, Disc3, Droplets, ExternalLink, Fan, Film, FlaskConical, History, MonitorPlay, Radio, RefreshCw, ScanLine, Upload, Volume2, VolumeX, Wind, X } from 'lucide-react'
import { useStore } from '../lib/store'
import type { LibraryClip, PlayMode } from '../lib/protocol'
import { chooseFile, chooseSim, chooseWebcam, fmtDuration, licenseOf, loadLibrary, openRecorded, PLAY_MODE_HINT, recordedRunId, startPlay } from '../lib/library'
import { cx } from './ui'

const KIND_ICON: Record<string, (s: number) => ReactNode> = {
  fan: (s) => <Fan size={s} />,
  pump: (s) => <Droplets size={s} />,
  motor: (s) => <Cog size={s} />,
  rotor: (s) => <Disc3 size={s} />,
  structure: (s) => <Building2 size={s} />,
  turbine: (s) => <Wind size={s} />,
}
const kindIcon = (k: string, s = 11) => (KIND_ICON[k] ?? ((n: number) => <Film size={n} />))(s)
const KIND_ORDER = ['fan', 'pump', 'motor', 'rotor', 'turbine', 'structure']

export function KindChip({ kind }: { kind: string }) {
  return (
    <span className="inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-line-2 bg-bg-2 px-1.5 text-[10px] font-medium capitalize text-fg-2">
      <span className="text-fg-3">{kindIcon(kind, 10)}</span>
      {kind}
    </span>
  )
}

/** "REAL FOOTAGE" vs "synthetic · ground truth": the one distinction the operator must never miss. */
export function RealBadge({ real, className }: { real: boolean; className?: string }) {
  return real ? (
    <span className={cx('inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-fg-2/45 bg-fg-1/[0.07] px-1.5 text-[9.5px] font-bold tracking-[0.1em] text-fg-1', className)}>
      <span className="h-1.5 w-1.5 rounded-full bg-alarm" />
      REAL FOOTAGE
    </span>
  ) : (
    <span className={cx('inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-dashed border-line-3 px-1.5 text-[9.5px] font-medium tracking-[0.04em] text-fg-3', className)}>
      <FlaskConical size={10} />
      synthetic · ground truth
    </span>
  )
}

/** "© credit · licence · source ↗" (CC BY requires author, licence and a link to the source). */
export function Credit({ clip, className }: { clip: LibraryClip; className?: string }) {
  return (
    <p className={cx('min-w-0 text-[10.5px] leading-snug text-fg-3', className)}>
      <span className="text-fg-4">©</span> {clip.credit ?? 'unknown'} <span className="text-fg-4">·</span> <span className="num">{licenseOf(clip)}</span>
      {clip.source_url && (
        <>
          {' '}
          <span className="text-fg-4">·</span>{' '}
          <a
            href={clip.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 rounded-[3px] text-fg-2 underline decoration-line-3 underline-offset-2 hover:text-fg-1 hover:decoration-fg-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            source <ExternalLink size={9} aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </>
      )}
    </p>
  )
}

function Thumb({ clip, playing }: { clip: LibraryClip; playing: boolean }) {
  const [broken, setBroken] = useState(false)
  return (
    <div className="scope-dark relative aspect-video w-full overflow-hidden rounded-[5px] bg-black ring-1 ring-line-1">
      {clip.poster_url && !broken ? (
        <img
          src={clip.poster_url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]"
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-[repeating-linear-gradient(135deg,#14181d_0_6px,#11151a_6px_12px)] text-fg-4">
          {kindIcon(clip.kind, 18)}
        </div>
      )}
      <span className="num absolute bottom-1 right-1 rounded-[3px] bg-black/75 px-1 py-[1px] text-[9.5px] text-fg-1">{fmtDuration(clip.duration_s)}</span>
      {playing && (
        <span className="absolute left-1 top-1 inline-flex items-center gap-1 rounded-[3px] bg-black/75 px-1 py-[1px] text-[9px] font-semibold tracking-[0.08em] text-fg-1">
          <span className="h-1.5 w-1.5 rounded-full bg-alarm anim-pulse" /> PLAYING
        </span>
      )}
    </div>
  )
}

function ClipCard({ clip, active, activeMode }: { clip: LibraryClip; active: boolean; activeMode?: PlayMode }) {
  const titleId = `clip-${clip.id}`
  const runs = useStore((s) => s.runs)
  const runId = recordedRunId(clip, runs)
  const replaying = useStore((s) => s.mode === 'replay' && s.sessionId === runId)
  return (
    <li>
      <article
        aria-labelledby={titleId}
        className={cx(
          'group grid grid-cols-[104px_minmax(0,1fr)] gap-3 rounded-lg border p-2.5 transition-colors sm:grid-cols-[136px_minmax(0,1fr)]',
          active ? 'border-line-3 bg-bg-2' : 'border-line-1 bg-bg-1 hover:border-line-2 hover:bg-bg-2/50',
        )}
      >
        <Thumb clip={clip} playing={active} />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-start gap-2">
            <h3 id={titleId} className="min-w-0 flex-1 text-[12.5px] font-semibold leading-tight text-fg-1">
              {clip.title}
            </h3>
            {clip.featured && <span className="mt-[1px] shrink-0 text-[9px] font-semibold uppercase tracking-[0.1em] text-fg-3">Featured</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <RealBadge real={clip.real} />
            <KindChip kind={clip.kind} />
            <span className="num inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-line-1 px-1.5 text-[10px] text-fg-3" title={`${clip.width ?? '?'}×${clip.height ?? '?'} px`}>
              {fmtDuration(clip.duration_s)} · {clip.fps ? Math.round(clip.fps) : '–'} fps
            </span>
            <span
              className="inline-flex h-[18px] items-center rounded-[4px] border border-line-1 px-1 text-fg-3"
              title={clip.has_audio ? 'Has audio: the mic tachometer can lock shaft speed' : 'No audio track'}
              aria-label={clip.has_audio ? 'has audio' : 'no audio'}
            >
              {clip.has_audio ? <Volume2 size={10} /> : <VolumeX size={10} className="text-fg-4" />}
            </span>
          </div>
          {clip.note && <p className="line-clamp-2 text-[11px] leading-snug text-fg-2" title={clip.what || clip.note}>{clip.note}</p>}
          <Credit clip={clip} />
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <CardBtn onClick={() => void startPlay(clip, 'analyse')} title={PLAY_MODE_HINT.analyse} primary on={active && activeMode === 'analyse'}>
              <ScanLine size={11} /> Analyse
            </CardBtn>
            <CardBtn onClick={() => void startPlay(clip, 'stream')} title={PLAY_MODE_HINT.stream} on={active && activeMode === 'stream'}>
              <Radio size={11} /> Live stream
            </CardBtn>
            {runId && (
              <CardBtn onClick={() => openRecorded(runId)} title="Recorded run (Meta models) · instant: replays an earlier analysis of this clip, no API key needed" on={replaying}>
                <History size={11} /> Recorded run <span className="font-normal text-fg-4">· instant</span>
              </CardBtn>
            )}
          </div>
        </div>
      </article>
    </li>
  )
}

function CardBtn({ children, onClick, title, primary, on }: { children: ReactNode; onClick: () => void; title: string; primary?: boolean; on?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cx(
        'inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        primary ? 'border-line-3 bg-bg-3 text-fg-1 hover:bg-bg-4' : 'border-line-2 bg-transparent text-fg-2 hover:bg-bg-3 hover:text-fg-1',
        on && 'shadow-[inset_0_0_0_1px_var(--color-fg-3)]',
      )}
    >
      {children}
      {on && <span className="ml-0.5 text-[9px] font-semibold tracking-[0.08em] text-fg-3">· ON</span>}
    </button>
  )
}

function OtherInput({ icon, title, hint, onClick, on }: { icon: ReactNode; title: string; hint: string; onClick: () => void; on?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex min-w-0 flex-1 basis-[150px] items-start gap-2 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        on ? 'border-line-3 bg-bg-2' : 'border-line-1 hover:border-line-2 hover:bg-bg-2/60',
      )}
    >
      <span className="mt-[1px] text-fg-3">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[12px] font-medium text-fg-1">{title}</span>
        <span className="block text-[10.5px] leading-snug text-fg-3">{hint}</span>
      </span>
    </button>
  )
}

function Section({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2 px-0.5">
        <h3 className="eyebrow shrink-0 whitespace-nowrap">{title}</h3>
        {meta && <span className="num min-w-0 truncate text-[10.5px] text-fg-4">{meta}</span>}
      </div>
      {children}
    </section>
  )
}

/** v4 · Source library: what the real pipeline watches. Real footage first, synthetic ground truth second. */
export function SourceDrawer() {
  const open = useStore((s) => s.sourceOpen)
  const set = useStore((s) => s.set)
  const clips = useStore((s) => s.library)
  const libState = useStore((s) => s.libraryState)
  const np = useStore((s) => s.nowPlaying)
  const mode = useStore((s) => s.mode)
  const videoSource = useStore((s) => s.videoSource)
  const localClip = useStore((s) => s.localClip)
  const [kind, setKind] = useState<string>('all')
  const panel = useRef<HTMLElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const close = () => set({ sourceOpen: false })

  useEffect(() => {
    if (!open) return
    returnTo.current = document.activeElement as HTMLElement | null
    if (libState === 'idle' || libState === 'error') void loadLibrary(true)
    requestAnimationFrame(() => panel.current?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (e.key !== 'Tab' || !panel.current) return
      const f = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([type=hidden]), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null)
      if (!f.length) return
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      returnTo.current?.focus?.()
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const kinds = useMemo(() => {
    const k = [...new Set((clips ?? []).map((c) => c.kind))]
    return k.sort((a, b) => (KIND_ORDER.indexOf(a) + 99) % 99 - (KIND_ORDER.indexOf(b) + 99) % 99)
  }, [clips])
  const shown = (clips ?? []).filter((c) => kind === 'all' || c.kind === kind)
  const real = shown.filter((c) => c.real).sort((a, b) => Number(!!b.featured) - Number(!!a.featured))
  const synth = shown.filter((c) => !c.real)
  const nReal = (clips ?? []).filter((c) => c.real).length

  return (
    <div className={cx('fixed inset-0 z-[60] transition-[visibility] duration-200', open ? 'visible' : 'invisible')} aria-hidden={!open}>
      <div onClick={close} className={cx('absolute inset-0 bg-black/45 backdrop-blur-[1px] transition-opacity duration-200', open ? 'opacity-100' : 'opacity-0')} />
      <aside
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-title"
        className={cx(
          'absolute bottom-0 right-0 top-0 flex w-full max-w-[500px] flex-col border-l border-line-2 bg-bg-1 shadow-[-24px_0_48px_-12px_color-mix(in_srgb,var(--color-shadow)_60%,transparent)] transition-transform duration-[240ms] ease-[cubic-bezier(.2,.8,.2,1)] focus:outline-none',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <header className="shrink-0 border-b border-line-1 px-4 pb-3 pt-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0">
              <div className="eyebrow">Source</div>
              <h2 id="source-title" className="text-[14px] font-semibold text-fg-1">
                What the pipeline watches
              </h2>
              <p className="mt-0.5 text-[11px] leading-snug text-fg-3">
                Every clip runs through the real pipeline at real speed. <span className="text-fg-2">Analyse</span> = full identification and diagnosis;{' '}
                <span className="text-fg-2">Live stream</span> = the live camera engine.
              </p>
            </div>
            <button onClick={close} className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent" aria-label="Close source library">
              <X size={15} />
            </button>
          </div>
          {kinds.length > 1 && (
            <div className="-mx-1 mt-2.5 flex flex-wrap gap-1" role="group" aria-label="Filter by machine type">
              {['all', ...kinds].map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={cx(
                    'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[10.5px] font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    kind === k ? 'border-line-3 bg-bg-4 text-fg-1' : 'border-line-1 text-fg-3 hover:border-line-2 hover:text-fg-1',
                  )}
                >
                  {k !== 'all' && <span className="text-fg-3">{kindIcon(k, 10)}</span>}
                  {k}
                </button>
              ))}
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
          {mode !== 'live' && libState === 'ready' && (
            <div className="rounded-md border border-line-2 bg-bg-2 px-3 py-2 text-[11px] leading-snug text-fg-2">
              {mode === 'mock' ? 'The simulator is running.' : 'This is a recorded replay.'} Picking a clip reopens the console on the live backend and runs it through the real pipeline.
            </div>
          )}
          {libState === 'loading' && !clips && (
            <ul className="space-y-2" aria-label="Loading library">
              {[0, 1, 2].map((i) => (
                <li key={i} className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 rounded-lg border border-line-1 p-2.5 sm:grid-cols-[136px_minmax(0,1fr)]">
                  <div className="skeleton aspect-video rounded-[5px]" />
                  <div className="space-y-2 py-1">
                    <div className="skeleton h-3 w-2/3 rounded-[2px]" />
                    <div className="skeleton h-2.5 w-1/2 rounded-[2px]" />
                    <div className="skeleton h-2.5 w-5/6 rounded-[2px]" />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {libState === 'error' && (
            <div className="flex items-start gap-2 rounded-md border border-line-2 bg-bg-2 px-3 py-2.5 text-[11px] leading-snug text-fg-2">
              <Film size={13} className="mt-[1px] shrink-0 text-fg-4" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-fg-1">Footage library unavailable</div>
                <div className="text-fg-3">
                  The backend is not reachable at <span className="num">/api/library</span>. Start it with <span className="num text-fg-2">uv run uvicorn argonaut.server:app --port 8000</span>.
                </div>
              </div>
              <button onClick={() => void loadLibrary(true)} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line-2 px-2 text-[11px] text-fg-2 hover:bg-bg-3 hover:text-fg-1">
                <RefreshCw size={11} /> Retry
              </button>
            </div>
          )}

          {real.length > 0 && (
            <Section title="Real footage" meta={`${real.length}${kind === 'all' ? '' : ` of ${nReal}`} clips · published under CC BY / CC0 / public domain`}>
              <ul className="space-y-2">
                {real.map((c) => (
                  <ClipCard key={c.id} clip={c} active={np?.clip.id === c.id && videoSource === 'clip'} activeMode={np?.mode} />
                ))}
              </ul>
            </Section>
          )}
          {synth.length > 0 && (
            <Section title="Synthetic · ground truth" meta={`${synth.length} clips · exact answers known, for benchmarking`}>
              <ul className="space-y-2">
                {synth.map((c) => (
                  <ClipCard key={c.id} clip={c} active={np?.clip.id === c.id && videoSource === 'clip'} activeMode={np?.mode} />
                ))}
              </ul>
            </Section>
          )}
          {libState === 'ready' && !shown.length && <div className="py-6 text-center text-[11.5px] text-fg-3">No clips of this type.</div>}

          <Section title="Other inputs">
            <div className="flex flex-wrap gap-2">
              <OtherInput icon={<Camera size={14} />} title="Device camera" hint="Webcam, USB or capture card, with its microphone" onClick={chooseWebcam} on={videoSource === 'webcam'} />
              <OtherInput
                icon={<Upload size={14} />}
                title="Clip from disk"
                hint={localClip ? `Now: ${localClip.name}` : 'mp4 / mov, analysed on the server'}
                onClick={() => fileRef.current?.click()}
                on={videoSource === 'clip' && !!localClip}
              />
              {mode === 'mock' && <OtherInput icon={<MonitorPlay size={14} />} title="Simulated rig" hint="Built-in simulator, no backend" onClick={chooseSim} on={videoSource === 'sim'} />}
            </div>
            <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/*" className="hidden" onChange={(e) => e.target.files?.[0] && void chooseFile(e.target.files[0])} />
          </Section>
        </div>
        <footer className="num shrink-0 border-t border-line-1 px-4 py-2 text-[10px] leading-snug text-fg-4">
          Real clips are third-party footage, credited on each card and on the video while it plays. <span className="font-sans">Esc</span> closes.
        </footer>
      </aside>
    </div>
  )
}

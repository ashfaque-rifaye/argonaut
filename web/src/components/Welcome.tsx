import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, Camera, ChevronLeft, ChevronRight, Eye, Link2, Play, Radio, Sigma, Upload, Wrench, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { link } from '../lib/socket'
import { chooseFile, chooseWebcam, featuredClip, openRecorded, recordedRunId, startPlay } from '../lib/library'
import type { LibraryClip } from '../lib/protocol'
import { isVideoFile, useVideoDrop } from './SampleStrip'
import { cx } from './ui'
import { REPO_URL, SHOWCASE } from '../lib/showcase'

const TOUR_KEY = 'argonaut.tour.v6'

/* ─────────────────────────────── welcome sheet ─────────────────────────────── */

export function WelcomeSheet() {
  const open = useStore((s) => s.welcomeOpen)
  const clips = useStore((s) => s.library)
  const runs = useStore((s) => s.runs)
  const set = useStore((s) => s.set)
  const fileRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { over, handlers } = useVideoDrop()
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && set({ welcomeOpen: false })
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, set])
  if (!open) return null
  const real = (clips ?? []).filter((c) => (SHOWCASE ? !!recordedRunId(c, runs) : c.real))
  const hero = clips ? featuredClip(clips) : null
  const more = real.filter((c) => c.id !== hero?.id).slice(0, 5)

  const play = (c: LibraryClip) => (SHOWCASE ? replay(c) : void startPlay(c, 'analyse'))
  const replay = (c: LibraryClip) => {
    const r = recordedRunId(c, runs)
    if (r) openRecorded(r)
  }
  const connect = async () => {
    setErr(null)
    setBusy(true)
    try {
      await link.connectFeed(url.trim(), 'Live feed')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const startTour = () => {
    set({ welcomeOpen: false, tourStep: 0 })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="glass-float anim-in max-h-[94vh] w-full max-w-[1080px] overflow-y-auto rounded-[22px] p-6 sm:p-8">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="eyebrow text-accent-2">Argonaut · see the vibration, fix the machine</div>
            <h1 id="welcome-title" className="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.02em] text-fg-1 sm:text-[30px]">
              Any camera becomes a vibration analyst. Agents fix what it finds.
            </h1>
            <p className="mt-2 max-w-[720px] text-[13.5px] leading-relaxed text-fg-2">
              Argonaut turns ordinary footage of a pump, fan, motor or engine into a vibration test: Meta's models find where to measure and what the machine is, physics measures it, and agents act on it, with you approving every change.
            </p>
          </div>
          <button onClick={() => set({ welcomeOpen: false })} aria-label="Close" className="rounded-full p-1.5 text-fg-3 hover:bg-bg-3 hover:text-fg-1">
            <X size={16} />
          </button>
        </div>

        <ol className="mt-5 grid gap-2 sm:grid-cols-3">
          {[
            [Eye, 'See', 'SAM 3.1 places virtual sensors by name; Muse Spark reads what the machine is.'],
            [Sigma, 'Understand', 'Spectra, resonances and Bayesian speed and fault probabilities, every number with error bars.'],
            [Wrench, 'Act', 'Muse Wonder balances the rotor, locks out resonance, writes the work order. You approve.'],
          ].map(([I, t, d], i) => {
            const Ico = I as typeof Eye
            return (
              <li key={t as string} className="glass flex gap-3 rounded-[14px] p-3">
                <span className="num mt-0.5 text-[11px] text-fg-4">0{i + 1}</span>
                <div>
                  <div className="flex items-center gap-1.5 text-[13px] font-semibold text-fg-1">
                    <Ico size={14} className="text-accent-2" /> {t as string}
                  </div>
                  <p className="mt-0.5 text-[11.5px] leading-snug text-fg-2">{d as string}</p>
                </div>
              </li>
            )
          })}
        </ol>

        <div className="mt-6 grid gap-3 lg:grid-cols-[1.35fr_1fr]">
          {/* 1 · a sample */}
          {hero && (
            <div className="glass overflow-hidden rounded-[16px]">
              <button onClick={() => play(hero)} className="group relative block aspect-[16/8] w-full overflow-hidden bg-black text-left" aria-label={`Analyse ${hero.title}`}>
                {hero.poster_url && <img src={hero.poster_url} alt="" className="absolute inset-0 h-full w-full object-cover opacity-90 transition-transform duration-500 group-hover:scale-[1.03]" />}
                <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
                <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/90">Recommended sample</span>
                <span className="absolute inset-x-4 bottom-3 text-white">
                  <span className="block text-[17px] font-semibold">{hero.title}</span>
                  <span className="mt-0.5 line-clamp-2 block text-[11.5px] text-white/75">{hero.note}</span>
                </span>
                <span className="absolute right-4 top-1/2 inline-flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-black shadow-lg transition-transform group-hover:scale-105">
                  <Play size={18} fill="currentColor" />
                </span>
              </button>
              <div className="flex flex-wrap items-center gap-2 p-3">
                <button onClick={() => play(hero)} className="inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-accent px-3 text-[12px] font-semibold text-[var(--color-on-accent)] hover:brightness-110">
                  <Play size={12} /> {SHOWCASE ? 'Play the recorded run' : 'Analyse it live'}
                </button>
                {!SHOWCASE && recordedRunId(hero, runs) && (
                  <button onClick={() => replay(hero)} className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-line-2 px-3 text-[12px] font-medium text-fg-1 hover:bg-bg-3" data-tip="An earlier run of this clip with the Meta models, replayed instantly (no API wait)">
                    Instant recorded run
                  </button>
                )}
                <span className="text-[10.5px] text-fg-4">
                  Footage: {hero.credit} · {hero.license}
                </span>
              </div>
              <div className="flex gap-1.5 overflow-x-auto px-3 pb-3">
                {more.map((c) => (
                  <button key={c.id} onClick={() => play(c)} className="group relative h-[54px] w-[96px] shrink-0 overflow-hidden rounded-[8px] bg-black ring-1 ring-line-1 hover:ring-accent/60" data-tip={`<b>${c.title}</b><br/>${c.note ?? ''}`}>
                    {c.poster_url && <img src={c.poster_url} alt="" className="absolute inset-0 h-full w-full object-cover opacity-80 group-hover:opacity-100" />}
                    <span className="absolute inset-x-1 bottom-0.5 truncate text-[9px] font-medium text-white">{c.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-3">
            {/* 2 · upload */}
            <button
              {...handlers}
              onClick={() => fileRef.current?.click()}
              className={cx('glass flex items-center gap-3 rounded-[16px] border-dashed p-4 text-left transition-colors', over ? 'border-accent bg-[var(--accent-dim)]' : 'hover:border-accent/50')}
            >
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[var(--accent-dim)] text-accent-2">
                <Upload size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-semibold text-fg-1">{over ? 'Drop to analyse' : 'Upload your own footage'}</span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-3">mp4 or mov from a phone or CCTV. Hold the camera still; keep the sound on: the microphone is the tachometer.</span>
              </span>
              <ArrowRight size={15} className="ml-auto shrink-0 text-fg-3" />
            </button>
            <input ref={fileRef} type="file" accept="video/*,.mp4,.mov,.m4v,.webm" className="hidden" onChange={(e) => isVideoFile(e.target.files?.[0]) && void chooseFile(e.target.files![0])} />

            {/* 3 · live feed */}
            <div className="glass rounded-[16px] p-4">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[var(--accent-dim)] text-accent-2">
                  <Radio size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold text-fg-1">Connect a live feed</span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-3">An IP / CCTV camera (RTSP, HTTP, HLS) or this device's camera and microphone.</span>
                </span>
              </div>
              <div className="mt-3 flex gap-1.5">
                <div className="relative min-w-0 flex-1">
                  <Link2 size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-4" />
                  <input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && url.trim() && void connect()}
                    placeholder="rtsp://camera.local/stream1"
                    aria-label="Live feed URL"
                    className="h-8 w-full rounded-[9px] border border-line-2 bg-bg-0/60 pl-7 pr-2 text-[12px] text-fg-1 placeholder:text-fg-4 focus:border-accent/60 focus:outline-none"
                  />
                </div>
                <button disabled={!url.trim() || busy} onClick={() => void connect()} className="h-8 rounded-[9px] bg-accent px-3 text-[12px] font-semibold text-[var(--color-on-accent)] disabled:opacity-40">
                  {busy ? 'Connecting…' : 'Connect'}
                </button>
              </div>
              {err && <p className="mt-1.5 text-[11px] text-alarm">{err}</p>}
              <button onClick={() => chooseWebcam()} className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-fg-2 hover:text-fg-1">
                <Camera size={12} /> Use this device's camera instead
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-line-1 pt-4">
          <button onClick={startTour} className="inline-flex items-center gap-1.5 text-[12px] font-medium text-accent-2 hover:underline">
            Take the 60-second tour <ArrowRight size={12} />
          </button>
          <span className="text-[10.5px] text-fg-4">
            {SHOWCASE ? (
              <>
                Samples replay runs recorded with the Meta models. Your upload or feed runs live on our backend, with limits ·{' '}
                <a href={REPO_URL} className="underline hover:text-fg-2">
                  run it yourself
                </a>
              </>
            ) : (
              'Esc to explore the console · press ? any time for shortcuts and the tour'
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────── guided tour ─────────────────────────────── */

const STEPS: { sel: string; title: string; body: string }[] = [
  { sel: '[data-tour="live"]', title: 'The footage', body: 'Your machine, with the virtual sensors SAM 3.1 placed on it. Use ⤢ to enlarge it. Coloured regions measure motion; REF cancels camera shake.' },
  { sel: '[data-tour="machines"]', title: 'Choose what to analyse', body: 'Real recordings of fans, gensets, washers, pumps and motors, or upload your own. Drop a video anywhere on the view.' },
  { sel: '[data-tour="telemetry"]', title: 'Live readings', body: 'Shaft speed (from the camera or the microphone), overall vibration and its ISO 20816 zone, per virtual sensor.' },
  { sel: '[data-tour="spectrum"]', title: 'What the vibration is made of', body: 'Peaks at 1×, 2×, blade pass… each points to a fault. The waterfall below shows how they move with speed.' },
  { sel: '[data-tour="identify"]', title: 'What the machine is, in probabilities', body: 'Campbell diagram for resonances; the Faults tab turns Muse Spark’s kinematic model into a speed estimate and a probability per fault.' },
  { sel: '[data-tour="actions"]', title: 'Agents that act', body: 'Muse Wonder proposes the fix: balance, lock out resonance, a work order, the savings. You approve; Argonaut runs it and re-measures.' },
  { sel: '[data-tour="optimizer"]', title: 'Run it better', body: 'The proposed operating speed: least energy, clear of resonance. Approve it, or close the loop with an envelope.' },
  { sel: '[data-tour="agent"]', title: 'Muse Wonder, thinking out loud', body: 'Every number it writes is checked against the measurements. Ask it questions here.' },
]

export function Tour() {
  const step = useStore((s) => s.tourStep)
  const set = useStore((s) => s.set)
  const [rect, setRect] = useState<DOMRect | null>(null)
  useLayoutEffect(() => {
    if (step == null) return
    const el = document.querySelector(STEPS[step].sel)
    const measure = () => setRect(el ? el.getBoundingClientRect() : null)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    measure()
    const t = window.setTimeout(measure, 320)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('resize', measure)
    }
  }, [step])
  useEffect(() => {
    if (step == null) return
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
      if (e.key === 'ArrowRight') next()
      if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })
  if (step == null) return null
  const s = STEPS[step]
  function finish() {
    try {
      localStorage.setItem(TOUR_KEY, '1')
    } catch {
      /* private mode */
    }
    set({ tourStep: null })
  }
  function next() {
    if (step! >= STEPS.length - 1) finish()
    else set({ tourStep: step! + 1 })
  }
  function prev() {
    if (step! > 0) set({ tourStep: step! - 1 })
  }
  const pad = 6
  const vw = window.innerWidth
  const vh = window.innerHeight
  const r = rect ?? new DOMRect(vw / 2 - 1, vh / 2 - 1, 2, 2)
  // card goes beside the target where there is room, else below / above
  const cardW = Math.min(340, vw - 24)
  let left = r.right + 14
  let top = r.top
  if (left + cardW > vw - 12) left = r.left - cardW - 14
  if (left < 12) {
    left = Math.max(12, Math.min(vw - cardW - 12, r.left + r.width / 2 - cardW / 2))
    top = r.bottom + 14 + 170 < vh ? r.bottom + 14 : Math.max(12, r.top - 184)
  }
  top = Math.max(12, Math.min(vh - 200, top))
  return (
    <>
      <div className="tour-hole" style={{ left: r.left - pad, top: r.top - pad, width: r.width + 2 * pad, height: r.height + 2 * pad }} />
      <div className="fixed inset-0 z-[69]" onClick={finish} aria-hidden />
      <div role="dialog" aria-live="polite" className="glass-float anim-in fixed z-[71] rounded-[16px] p-4" style={{ left, top, width: cardW }}>
        <div className="flex items-center gap-2">
          <span className="num text-[10.5px] text-fg-4">
            {step + 1} / {STEPS.length}
          </span>
          <button onClick={finish} className="ml-auto text-[11px] text-fg-3 hover:text-fg-1">
            Skip tour
          </button>
        </div>
        <div className="mt-1 text-[14.5px] font-semibold text-fg-1">{s.title}</div>
        <p className="mt-1 text-[12px] leading-relaxed text-fg-2">{s.body}</p>
        <div className="mt-3 flex items-center gap-1.5">
          <button onClick={prev} disabled={step === 0} className="inline-flex h-7 items-center gap-1 rounded-[8px] border border-line-2 px-2 text-[11.5px] text-fg-2 disabled:opacity-30">
            <ChevronLeft size={12} /> Back
          </button>
          <button onClick={next} className="ml-auto inline-flex h-7 items-center gap-1 rounded-[8px] bg-accent px-3 text-[11.5px] font-semibold text-[var(--color-on-accent)]">
            {step === STEPS.length - 1 ? 'Done' : 'Next'} <ChevronRight size={12} />
          </button>
        </div>
      </div>
    </>
  )
}

/** First visit after the welcome sheet closes: offer the tour once (it never auto-starts twice). */
export function useFirstVisitTour() {
  const welcome = useStore((s) => s.welcomeOpen)
  const set = useStore((s) => s.set)
  const prev = useRef(welcome)
  useEffect(() => {
    if (prev.current && !welcome) {
      let seen = false
      try {
        seen = localStorage.getItem(TOUR_KEY) === '1'
      } catch {
        seen = true
      }
      if (!seen) window.setTimeout(() => useStore.getState().tourStep == null && !useStore.getState().pickedSource && set({ tourStep: 0 }), 1200)
    }
    prev.current = welcome
  }, [welcome, set])
}

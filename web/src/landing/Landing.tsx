import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowRight, ArrowUpRight, Camera, Cctv, Check, Drone, Play, ScanSearch, X } from 'lucide-react'
import { onLink } from '../lib/router'
import { useTheme } from '../lib/theme'
import { Logo } from '../components/Logo'
import { ThemeToggle } from '../components/ThemeToggle'
import { cx, Tip } from '../components/ui'
import { HeroSpectrogram } from './HeroSpectrogram'
import { Media } from './Media'
import { CountUp, Reveal, useInView } from './motion'
import { IdentifyOverlay, MeasureOverlay, OptimiseOverlay, ProveOverlay, SenseOverlay, StageVisual } from './Stages'

const REPLAY = '/console?replay=demo_fan_closed_loop'
const IEA_2025 = 'https://www.iea-4e.org/wp-content/uploads/2025/12/4E-Policy-Brief-EMSA-9-20251218.pdf'

/* ───────────────────────── primitives ───────────────────────── */

function Wrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('mx-auto w-full max-w-[1200px] px-5 md:px-8', className)}>{children}</div>
}

function Eyebrow({ n, children }: { n: string; children: ReactNode }) {
  return (
    <Reveal className="num flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-fg-3">
      <span className="text-fg-4">{n}</span>
      <span className="h-px w-6 bg-line-2" />
      <span>{children}</span>
    </Reveal>
  )
}

function H2({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mt-4 max-w-[760px]">
      <Reveal as="h2" delay={60} className="text-[30px] font-semibold leading-[1.08] tracking-[-0.03em] text-fg-1 md:text-[42px]">
        {children}
      </Reveal>
      {sub && (
        <Reveal as="p" delay={140} className="mt-4 max-w-[640px] text-[15.5px] leading-relaxed text-fg-2 md:text-[17px]">
          {sub}
        </Reveal>
      )}
    </div>
  )
}

function CTA({ href, children, primary }: { href: string; children: ReactNode; primary?: boolean }) {
  return (
    <a
      href={href}
      onClick={onLink}
      className={cx(
        'group relative inline-flex h-11 items-center justify-center gap-2 overflow-hidden rounded-lg border px-5 text-[14px] font-medium transition-[background-color,border-color,box-shadow,transform] duration-200 active:scale-[0.985]',
        primary
          ? 'border-transparent bg-accent text-on-accent shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_45%,transparent),0_10px_40px_-12px_color-mix(in_srgb,var(--color-accent)_calc(var(--glow)*100%),transparent)] hover:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_60%,transparent),0_14px_48px_-10px_color-mix(in_srgb,var(--color-accent)_calc(var(--glow)*120%),transparent)]'
          : 'border-line-2 bg-bg-1/70 text-fg-1 backdrop-blur hover:border-line-3 hover:bg-bg-3',
      )}
    >
      {primary && <span className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 -skew-x-12 bg-[linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent)] opacity-0 transition-[transform,opacity] duration-700 group-hover:translate-x-[420%] group-hover:opacity-100" />}
      {children}
    </a>
  )
}

/** Seamed grid: cells separated by 1px hairlines, like the console bezel. */
function Seams({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('grid gap-px overflow-hidden rounded-xl border border-line-1 bg-line-1', className)}>{children}</div>
}

/* ───────────────────────── nav: sticky, section-aware, with progress ───────────────────────── */

const SECTIONS = [
  ['problem', 'Problem'],
  ['how', 'How it works'],
  ['models', 'Models'],
  ['results', 'Results'],
  ['principles', 'Principles'],
] as const

function useActiveSection() {
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    const els = SECTIONS.map(([id]) => document.getElementById(id)).filter(Boolean) as HTMLElement[]
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id)
      },
      { rootMargin: '-45% 0px -50% 0px' },
    )
    els.forEach((el) => io.observe(el))
    const top = () => window.scrollY < 300 && setActive(null)
    window.addEventListener('scroll', top, { passive: true })
    return () => {
      io.disconnect()
      window.removeEventListener('scroll', top)
    }
  }, [])
  return active
}

function ScrollProgress() {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const upd = () => {
      raf = 0
      const h = document.documentElement.scrollHeight - innerHeight
      if (bar.current) bar.current.style.transform = `scaleX(${h > 0 ? Math.min(1, scrollY / h) : 0})`
    }
    const on = () => {
      if (!raf) raf = requestAnimationFrame(upd)
    }
    upd()
    addEventListener('scroll', on, { passive: true })
    addEventListener('resize', on)
    return () => {
      removeEventListener('scroll', on)
      removeEventListener('resize', on)
      cancelAnimationFrame(raf)
    }
  }, [])
  return (
    <div className="absolute inset-x-0 bottom-[-1px] h-px overflow-hidden" aria-hidden>
      <div ref={bar} className="h-full origin-left bg-[linear-gradient(90deg,transparent,var(--color-accent)_30%,var(--color-accent-2))] will-change-transform" style={{ transform: 'scaleX(0)' }} />
    </div>
  )
}

function Nav() {
  const active = useActiveSection()
  return (
    <header className="sticky top-0 z-40 border-b border-line-1 bg-page/80 backdrop-blur-md backdrop-saturate-150">
      <Wrap className="flex h-14 items-center gap-6">
        <a href="/" onClick={onLink} aria-label="Argonaut home" className="shrink-0">
          <Logo />
        </a>
        <nav className="hidden items-center gap-0.5 text-[13px] md:flex" aria-label="Sections">
          {SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={active === id ? 'true' : undefined}
              className={cx('relative rounded-md px-2.5 py-1 transition-colors duration-200', active === id ? 'text-fg-1' : 'text-fg-3 hover:text-fg-1')}
            >
              <span className={cx('absolute inset-0 rounded-md bg-bg-3 transition-opacity duration-300', active === id ? 'opacity-100' : 'opacity-0')} />
              <span className="relative">{label}</span>
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <a href={REPLAY} onClick={onLink} className="hidden h-8 items-center gap-1.5 rounded-md px-3 text-[13px] text-fg-2 transition-colors hover:bg-bg-3 hover:text-fg-1 sm:inline-flex">
            <Play size={13} /> Replay
          </a>
          <ThemeToggle size={32} />
          <a
            href="/console"
            onClick={onLink}
            className="group inline-flex h-8 items-center gap-1.5 rounded-md border border-line-2 bg-bg-2 px-3 text-[13px] font-medium text-fg-1 transition-colors hover:border-accent/50 hover:bg-bg-3"
          >
            Open console <ArrowRight size={13} className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </a>
        </div>
      </Wrap>
      <ScrollProgress />
    </header>
  )
}

/* ───────────────────────── hero ───────────────────────── */

const FEEDS = [
  { icon: <Cctv size={13} />, label: 'CCTV' },
  { icon: <ScanSearch size={13} />, label: 'Inspection cameras' },
  { icon: <Camera size={13} />, label: 'Handheld' },
  { icon: <Drone size={13} />, label: 'Drones' },
]

function Hero() {
  const theme = useTheme()
  const [footage, setFootage] = useState(false)
  useEffect(() => setFootage(false), [theme])
  const hd = (ms: number) => ({ '--d': `${ms}ms` }) as CSSProperties
  return (
    <section className="relative isolate overflow-hidden border-b border-line-1">
      {/* background: real footage when available; the live spectrogram crossfades into an overlay on it */}
      <Media name="hero" eager crossTheme={false} loopFade={0.9} className="-z-30" mediaClass="origin-[0%_25%] scale-[1.12]" onReady={(k) => setFootage(k === 'video' || k === 'image')} />
      <HeroSpectrogram
        className={cx(
          'absolute inset-0 -z-20 transition-opacity duration-[1600ms] ease-out',
          footage ? 'opacity-40 [mask-image:linear-gradient(90deg,transparent_40%,#000_80%)]' : 'opacity-100',
          footage && (theme === 'light' ? 'mix-blend-multiply' : 'mix-blend-screen'),
        )}
      />
      {/* legibility masks: page tone from the left (text) and the bottom (section seam) */}
      <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,var(--color-page)_0%,color-mix(in_srgb,var(--color-page)_94%,transparent)_34%,color-mix(in_srgb,var(--color-page)_55%,transparent)_58%,color-mix(in_srgb,var(--color-page)_14%,transparent)_100%)] max-md:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--color-page)_30%,transparent)_0%,color-mix(in_srgb,var(--color-page)_82%,transparent)_42%,color-mix(in_srgb,var(--color-page)_92%,transparent)_75%,var(--color-page)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 -z-10 h-32 bg-gradient-to-t from-page to-transparent" />
      <Wrap className="flex min-h-[660px] flex-col justify-center py-24 md:min-h-[740px] md:py-28">
        <div className="max-w-[780px]">
          <div className="hero-in num inline-flex h-7 items-center gap-2 rounded-full border border-line-2 bg-bg-1/80 pl-2.5 pr-3 text-[11.5px] text-fg-2 backdrop-blur" style={hd(0)}>
            <span className="h-1.5 w-1.5 rounded-full bg-accent anim-pulse" />
            <span className="sm:hidden">Video + sound → verified setpoint</span>
            <span className="hidden sm:inline">Video + sound → machine dynamics → verified setpoint</span>
          </div>
          <h1 className="mt-7 text-[44px] font-semibold leading-[0.98] tracking-[-0.045em] text-fg-1 sm:text-[60px] md:text-[74px]">
            <span className="hero-in block" style={hd(80)}>
              See the vibration.
            </span>
            <span className="hero-in block bg-[linear-gradient(92deg,var(--color-fg-1)_10%,var(--color-fg-3)_60%,var(--color-accent-2))] bg-clip-text text-transparent" style={hd(180)}>
              Fix the machine.
            </span>
          </h1>
          <p className="hero-in mt-6 max-w-[580px] text-[16.5px] leading-relaxed text-fg-2 md:text-[18.5px]" style={hd(300)}>
            Argonaut turns any camera into a vibration analyst. Meta&rsquo;s models find the fault in a pump, fan, motor or engine, agents fix it, and physics proves it.
          </p>
          <div className="hero-in mt-9 flex flex-col gap-3 sm:flex-row" style={hd(420)}>
            <CTA href="/console" primary>
              Open live console <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </CTA>
            <CTA href={REPLAY}>
              <Play size={14} /> Watch the replay
            </CTA>
          </div>
          <div className="hero-in mt-9" style={hd(560)}>
            <div className="text-[11.5px] text-fg-3">Any feed that can see the machine. No sensors bolted on.</div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {FEEDS.map((f) => (
                <span key={f.label} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-1 bg-bg-1/70 px-2.5 text-[12px] text-fg-2 backdrop-blur transition-colors hover:border-line-2 hover:text-fg-1">
                  <span className="text-fg-3">{f.icon}</span>
                  {f.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Wrap>
      <div className="num pointer-events-none absolute right-5 top-4 hidden text-[10.5px] text-fg-4 md:block">
        {footage ? 'footage · live coast-down spectrogram overlay' : 'live · procedural coast-down spectrogram · 5-blade fan · orders crossing 3 structural modes'}
      </div>
    </section>
  )
}

/* ───────────────────────── problem ───────────────────────── */

function Problem() {
  return (
    <section id="problem" className="scroll-mt-14 border-b border-line-1 py-24 md:py-32">
      <Wrap>
        <Eyebrow n="01">The problem</Eyebrow>
        <H2 sub="Variable-speed drives make speed a free parameter. In practice it is set once, by guess or nameplate, without checking it against the machine’s resonances or the pump’s cavitation margin.">
          The world&rsquo;s motors run at setpoints nobody checked.
        </H2>
        <Reveal delay={120}>
          <Seams className="mt-12 grid-cols-1 md:grid-cols-2">
            <div className="bg-bg-1 p-7 md:p-9">
              <div className="num text-[64px] font-normal leading-none tracking-[-0.05em] text-fg-1 md:text-[84px]">
                <CountUp value={53} suffix="%" />
              </div>
              <p className="mt-4 max-w-[400px] text-[15px] leading-relaxed text-fg-2">of global electricity was used by electric motor systems in 2023.</p>
              <a href={IEA_2025} target="_blank" rel="noreferrer" className="num mt-5 inline-flex items-center gap-1 text-[11.5px] text-fg-3 transition-colors hover:text-fg-1">
                IEA 4E EMSA policy brief, 2025 <ArrowUpRight size={12} />
              </a>
            </div>
            <div className="bg-bg-1 p-7 md:p-9">
              <div className="num text-[64px] font-normal leading-none tracking-[-0.05em] text-fg-1 md:text-[84px]">
                <span className="text-fg-3">≈</span>
                <CountUp value={70} suffix="%" />
              </div>
              <p className="mt-4 max-w-[400px] text-[15px] leading-relaxed text-fg-2">of motor-system electricity goes to pumps, fans and compressors: rotating machines whose speed sets both their energy use and their vibration.</p>
              <span className="num mt-5 inline-flex text-[11.5px] text-fg-3">IEA 4E EMSA, 2018</span>
            </div>
          </Seams>
          <Seams className="mt-px grid-cols-1 rounded-t-none border-t-0 md:grid-cols-2">
            <div className="bg-bg-1 p-7 md:p-9">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-4">Mapping a machine today</div>
              <ul className="mt-4 space-y-2.5 text-[14.5px] leading-relaxed text-fg-2">
                {['An impact-hammer survey for natural frequencies, or', 'a tacho run-up with accelerometers bolted on,', 'and a vibration analyst to read the result.'].map((t) => (
                  <li key={t} className="flex gap-3">
                    <span className="mt-[11px] h-px w-3 shrink-0 bg-fg-4" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-bg-1 p-7 md:p-9">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-2">With Argonaut</div>
              <ul className="mt-4 space-y-2.5 text-[14.5px] leading-relaxed text-fg-2">
                {['Any camera that can see the machine, and its sound. CCTV, inspection, handheld or drone.', 'A coast-down, narrated by voice.', 'A human who approves the operating envelope.'].map((t) => (
                  <li key={t} className="flex gap-3">
                    <span className="mt-[11px] h-px w-3 shrink-0 bg-accent" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          </Seams>
        </Reveal>
      </Wrap>
    </section>
  )
}

/* ───────────────────────── how it works ───────────────────────── */

const STEPS = [
  {
    k: 'Sense',
    m: ['SAM 3.1', 'Muse Spark'],
    d: 'SAM 3.1 places virtual sensors by name: “bearing housing”, “baseplate”. A static region becomes the shake reference, so any fixed camera works.',
    v: <SenseOverlay />,
    tone: 'violet' as const,
    alt: 'Segmentation outlines and labels drawn over a pump skid',
  },
  {
    k: 'Measure',
    m: ['DSP', 'mic tachometer'],
    d: 'Sub-pixel motion per mask, a tachometer from the blade-pass sound, and de-aliasing that recovers orders far above the camera frame rate’s Nyquist limit.',
    v: <MeasureOverlay />,
    tone: 'steel' as const,
    alt: 'A sampled vibration waveform over the bearing housing, unfolded from 5.34 Hz to 24.68 Hz',
  },
  {
    k: 'Identify',
    m: ['Muse Spark', 'Muse Wonder', 'FDD'],
    d: 'Muse Spark reads what the machine is, a four-stroke diesel or a 6-blade fan, and a Bayesian model turns that into probabilities: which speed the sound implies, which fault the evidence supports. Order tracking builds the Campbell diagram; FDD finds the modes. Every number carries an error bar.',
    v: <IdentifyOverlay />,
    tone: 'amber' as const,
    alt: 'Campbell diagram with order rays crossing three structural modes',
  },
  {
    k: 'Optimise',
    m: ['robust RTO'],
    d: 'Robust constrained RTO: minimise energy subject to duty, P(resonance) and NPSH, inside an envelope the operator approved.',
    v: <OptimiseOverlay />,
    tone: 'violet' as const,
    alt: 'Predicted vibration against speed with resonance bands hatched and the proposed setpoint',
  },
  {
    k: 'Prove',
    m: ['closed loop', 'significance test'],
    d: 'The loop steps the drive, re-measures and updates the twin. The change is accepted only if the before/after difference is significant.',
    v: <ProveOverlay />,
    tone: 'steel' as const,
    alt: 'Before and after vibration with 90% intervals: 2.59 to 0.30 mm/s, p = 3.8e-8',
  },
]

const STAGE_MEDIA = ['sense', 'measure', 'identify', 'optimise', 'prove']

function How() {
  return (
    <section id="how" className="scroll-mt-14 border-b border-line-1 py-24 md:py-32">
      <Wrap>
        <Eyebrow n="02">How it works</Eyebrow>
        <H2 sub="Five stages, each one visible in the console, each one leaving evidence you can open.">From pixels to a proven setpoint.</H2>
        <Seams className="mt-12 grid-cols-1 md:grid-cols-2">
          {STEPS.map((s, i) => (
            <Reveal key={s.k} delay={(i % 2) * 90} className="group/card flex flex-col bg-bg-1 transition-colors duration-300 hover:bg-bg-2">
              <StageVisual name={STAGE_MEDIA[i]} tone={s.tone} label={s.alt}>
                {s.v}
              </StageVisual>
              <div className="flex flex-1 flex-col p-6 md:p-7">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className="num text-[11.5px] text-fg-4">0{i + 1}</span>
                  <span className="text-[17px] font-semibold tracking-[-0.01em] text-fg-1">{s.k}</span>
                  <span className="ml-auto flex gap-1">
                    {s.m.map((m) => (
                      <span key={m} className="num rounded-[4px] border border-line-1 px-1.5 py-[1px] text-[10px] text-fg-3 transition-colors group-hover/card:border-line-2">
                        {m}
                      </span>
                    ))}
                  </span>
                </div>
                <p className="mt-2.5 text-[14px] leading-relaxed text-fg-3">{s.d}</p>
              </div>
            </Reveal>
          ))}
          <Reveal delay={90} className="flex">
            <a href="/console" onClick={onLink} className="group flex min-w-0 flex-1 flex-col justify-between gap-8 bg-bg-1 p-6 transition-colors duration-300 hover:bg-bg-2 md:p-7">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-4">In the console</div>
                <ul className="num mt-5 space-y-2 text-[12.5px] text-fg-3">
                  {[
                    ['Sense', 'live view · model rail'],
                    ['Measure', 'spectrum · de-alias · waterfall'],
                    ['Identify', 'Campbell · modal · kinematic inference'],
                    ['Optimise', 'proposal · digital twin'],
                    ['Prove', 'closed loop · verification'],
                  ].map(([a, b], i) => (
                    <li key={a} className="flex items-center gap-3 border-b border-line-1 pb-2 last:border-0">
                      <span className="text-fg-4">0{i + 1}</span>
                      <span className="w-[72px] text-fg-1">{a}</span>
                      <span className="min-w-0 truncate">{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <span className="inline-flex items-center gap-1.5 text-[14px] font-medium text-fg-1 transition-colors group-hover:text-accent-2">
                Open the console <ArrowRight size={15} className="transition-transform duration-200 group-hover:translate-x-1" />
              </span>
            </a>
          </Reveal>
        </Seams>
      </Wrap>
    </section>
  )
}

/* ───────────────────────── models ───────────────────────── */

const MODELS = [
  { name: 'SAM 3.1', id: 'sam-3.1', job: 'Segments and tracks the parts you name. Each mask becomes a measurement channel; the static wall becomes the reference that cancels camera shake.' },
  { name: 'Muse Spark', id: 'muse-spark', job: 'Reads the scene, the nameplate and the datasheet, cross-checks the running speed in the audio, and coaches the capture: “hold the camera steady”.' },
  { name: 'Muse Wonder', id: 'muse-wonder', job: 'The agent. Plans the experiment, calls the DSP, identification and optimiser tools, and writes the rationale. It cites numbers; it never invents them.' },
  { name: 'Muse Voice Transcribe', id: 'muse-voice-transcribe', job: 'Hands-free control next to a running machine: “Argonaut, start a coast-down.” Streaming partials appear as you speak.' },
  { name: 'Muse Spark Open', id: 'muse-spark-open', job: 'Private mode. Open weights on Baseten mirror the reasoning for audit, so plant data can stay on-prem.' },
]

function Models() {
  return (
    <section id="models" className="scroll-mt-14 border-b border-line-1 py-24 md:py-32">
      <Wrap>
        <Eyebrow n="03">Models</Eyebrow>
        <H2 sub="The model rail in the console shows each one’s state, latency and current task, live.">Meta models, each with a visible job.</H2>
        <Seams className="mt-12 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {MODELS.map((m, i) => (
            <Reveal key={m.id} delay={(i % 3) * 80} className="group relative bg-bg-1 p-6 transition-colors duration-300 hover:bg-bg-2">
              <span className="pointer-events-none absolute inset-x-0 top-0 h-px origin-left scale-x-0 bg-[linear-gradient(90deg,var(--color-accent),transparent)] transition-transform duration-500 ease-[var(--ease-out-expo)] group-hover:scale-x-100" />
              <div className="flex items-center gap-2.5">
                <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_0_0_var(--color-accent)] transition-shadow duration-300 group-hover:shadow-[0_0_0_4px_var(--accent-dim)]" />
                <span className="text-[15px] font-semibold text-fg-1">{m.name}</span>
                <span className="num ml-auto rounded-[4px] border border-line-1 px-1.5 py-[1px] text-[10px] text-fg-4">META</span>
              </div>
              <div className="num mt-1 pl-4 text-[11px] text-fg-4">{m.id}</div>
              <p className="mt-4 text-[13.5px] leading-relaxed text-fg-2">{m.job}</p>
            </Reveal>
          ))}
          <Reveal delay={160} className="flex flex-col justify-between bg-bg-1 p-6">
            <div className="text-[13.5px] leading-relaxed text-fg-3">
              Everything else is deterministic and inspectable: phase correlation, FFT, order tracking, FDD, the Bayesian speed and fault posteriors, the optimiser and the significance test.
            </div>
            <a href="/console" onClick={onLink} className="group mt-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-fg-1 hover:text-accent-2">
              See them work <ArrowRight size={14} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </a>
          </Reveal>
        </Seams>
      </Wrap>
    </section>
  )
}

/* ───────────────────────── results ───────────────────────── */

function Pair({ k, m, t }: { k?: string; m: string; t: string }) {
  return (
    <div className="num mt-2.5 flex items-baseline gap-1.5 whitespace-nowrap text-[12px] text-fg-3 first-of-type:mt-3">
      {k && <span className="w-3 text-fg-4">{k}</span>}
      <span className="text-fg-1">{m}</span>
      <span className="text-fg-4">vs truth</span>
      <span className="text-fg-2">{t}</span>
    </div>
  )
}

function Result({ k, v, u, children, wide, delay = 0 }: { k: string; v: ReactNode; u?: string; children?: ReactNode; wide?: boolean; delay?: number }) {
  return (
    <Reveal delay={delay} className={cx('flex flex-col bg-bg-1 p-6 transition-colors duration-300 hover:bg-bg-2 md:p-7', wide && 'md:col-span-2')}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-4">{k}</div>
      <div className="num mt-4 flex flex-wrap items-baseline gap-x-2 text-[34px] leading-none tracking-[-0.04em] text-fg-1 md:text-[40px]">
        {v}
        {u && <span className="text-[14px] tracking-normal text-fg-3">{u}</span>}
      </div>
      {children}
    </Reveal>
  )
}

function BeforeAfter() {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.5 })
  return (
    <div ref={ref} className="mt-5 space-y-2">
      {[
        ['before', 2.59, 'bg-trace-2', 0],
        ['after', 0.3, 'bg-fg-1', 350],
      ].map(([k, v, c, dl]) => (
        <div key={k as string} className="num grid grid-cols-[44px_1fr_64px] items-center gap-3 text-[11px] text-fg-3">
          <span>{k}</span>
          <span className="h-[6px] overflow-hidden rounded-[1px] bg-bg-3">
            <span
              className={cx('block h-full origin-left rounded-[1px] transition-transform duration-[1200ms] ease-[var(--ease-out-expo)]', c as string)}
              style={{ width: `${((v as number) / 2.59) * 100}%`, transform: inView ? 'scaleX(1)' : 'scaleX(0)', transitionDelay: `${dl}ms` }}
            />
          </span>
          <span className="text-right text-fg-2">{(v as number).toFixed(2)} mm/s</span>
        </div>
      ))}
    </div>
  )
}

function Results() {
  return (
    <section id="results" className="scroll-mt-14 border-b border-line-1 py-24 md:py-32">
      <Wrap>
        <Eyebrow n="04">Measured results</Eyebrow>
        <H2 sub="Benchmarks against known ground truth. Each figure below comes from the benchmark run, not from a slide.">Measured, not claimed.</H2>
        <Seams className="mt-12 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          <Result k="Misalignment phase" v={<CountUp value={179.8} decimals={1} />} u="°">
            <Pair m="179.8°" t="180°" />
          </Result>
          <Result k="Coast-down mode" v={<CountUp value={14.06} decimals={2} />} u="Hz" delay={70}>
            <Pair k="f" m="14.06 Hz" t="14.2 Hz" />
            <Pair k="ζ" m="2.25%" t="2.0%" />
          </Result>
          <Result k="Camera-shake rejection" v={<CountUp value={2.8} decimals={1} />} u="%" delay={140}>
            <p className="mt-3 text-[12.5px] leading-snug text-fg-3">residual of the true shake after the static-reference correction</p>
          </Result>
          <Result k="Streaming latency" v={<CountUp value={22} />} u="ms median" delay={210}>
            <p className="num mt-3 text-[12px] text-fg-3">
              <span className="text-fg-1">38 ms</span> p95 · frame → telemetry
            </p>
          </Result>

          <Result k="De-aliasing · 30 fps camera + mic" v={<CountUp value={148.06} decimals={2} duration={1800} />} u="Hz recovered from a frame rate with a 15 Hz Nyquist limit" wide>
            <div className="mt-4 overflow-hidden rounded-md border border-line-1">
              <table className="num w-full text-[12px]">
                <thead>
                  <tr className="bg-bg-2 text-[10px] uppercase tracking-[0.1em] text-fg-4">
                    <th className="px-3 py-1.5 text-left font-semibold">order</th>
                    <th className="px-3 py-1.5 text-right font-semibold">camera sees</th>
                    <th className="px-3 py-1.5 text-right font-semibold">recovered</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['1×', '5.34', '24.68'],
                    ['2×', '10.67', '49.35'],
                    ['6× vane-pass', '2.01', '148.06'],
                  ].map(([o, a, t]) => (
                    <tr key={o} className="border-t border-line-1 transition-colors hover:bg-bg-2">
                      <td className="px-3 py-1.5 text-fg-2">{o}</td>
                      <td className="px-3 py-1.5 text-right text-fg-3">{a} Hz</td>
                      <td className="px-3 py-1.5 text-right text-accent-2">{t} Hz</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Result>

          <Result k="Closed loop · simulated drive" v={<CountUp value={89} prefix="−" suffix="%" />} wide delay={90}>
            <div className="num mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px] text-fg-3">
              <span>
                vibration <span className="text-fg-2">2.59</span> → <span className="text-fg-1">0.30 mm/s</span>
              </span>
              <span className="text-fg-4">·</span>
              <span>8 iterations</span>
            </div>
            <BeforeAfter />
            <div className="mt-4">
              <span className="num inline-flex h-6 items-center gap-1.5 rounded-[5px] border border-ok/35 bg-[var(--ok-dim)] px-2 text-[11.5px] text-ok">
                <Check size={12} /> p = 3.8×10⁻⁸ · significant
              </span>
            </div>
          </Result>

          <Result k="Agent numeric provenance" v={<CountUp value={66} suffix="/66" />} wide>
            <p className="mt-3 text-[12.5px] leading-snug text-fg-3">numbers in the final assessment traced to a tool output; none unverified.</p>
          </Result>
          <Reveal delay={90} className="flex flex-col justify-end bg-bg-1 p-6 md:col-span-2 md:p-7">
            <p className="num text-[11.5px] leading-relaxed text-fg-4">
              Synthetic ground truth and a simulated plant (VFD over Modbus). Details: <span className="text-fg-3">docs/BENCHMARK.md</span>.
            </p>
          </Reveal>
        </Seams>
      </Wrap>
    </section>
  )
}

/* ───────────────────────── principles ───────────────────────── */

function Principles() {
  return (
    <section id="principles" className="scroll-mt-14 border-b border-line-1 py-24 md:py-32">
      <Wrap>
        <Eyebrow n="05">Principles</Eyebrow>
        <H2>What the AI never does.</H2>
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1fr] lg:gap-16">
          <ol className="space-y-8">
            {[
              ['It never produces a number.', 'Every figure the agent states is checked against the tool outputs of the session. Verified numbers carry their source; anything that cannot be traced is flagged in red, in the text, for the operator.'],
              ['It never moves the machine on its own.', 'A person approves the operating envelope: speed limits and maximum step. The closed loop runs inside it and stops on one click.'],
              ['It never hides an error bar.', 'Modes, damping, predicted vibration and the before/after comparison all carry intervals. A change counts only when it is significant.'],
            ].map(([t, dsc], i) => (
              <Reveal as="li" key={t} delay={i * 90} className="grid grid-cols-[28px_1fr] gap-3">
                <span className="num pt-1 text-[12px] text-fg-4">0{i + 1}</span>
                <div>
                  <div className="text-[19px] font-semibold tracking-[-0.015em] text-fg-1">{t}</div>
                  <p className="mt-2 text-[14.5px] leading-relaxed text-fg-2">{dsc}</p>
                </div>
              </Reveal>
            ))}
          </ol>
          {/* a live specimen of the provenance marks used in the console */}
          <Reveal delay={150} className="self-start overflow-hidden rounded-xl border border-line-1 bg-bg-1 shadow-[0_24px_60px_-30px_color-mix(in_srgb,var(--color-shadow)_60%,transparent)]">
            <div className="flex h-9 items-center gap-2 border-b border-line-1 px-4">
              <span className="eyebrow">Agent console</span>
              <span className="num ml-auto text-[10.5px] text-fg-3">
                provenance <span className="text-fg-1">6/7</span> verified
              </span>
              <span className="h-1.5 w-1.5 rounded-full bg-alarm" />
            </div>
            <div className="flex gap-3 p-4">
              <span className="num w-[52px] shrink-0 pt-[3px] text-[9.5px] font-semibold tracking-[0.06em] text-accent-2">WONDER</span>
              <p className="text-[13.5px] leading-relaxed text-fg-1">
                Motor-mount bending at <V s="campbell.modes[1].f_hz">24.1</V> ± <V s="campbell.modes[1].f_err_hz">0.4</V> Hz (ζ <V s="campbell.modes[1].zeta">0.034</V>) sits 2% below running speed and amplifies 1× about <U>12</U>×. Stand rocking at{' '}
                <V s="campbell.modes[0].f_hz">14.2</V> Hz gives a critical speed at <V s="campbell.criticals[0].rpm">852</V> rpm.
              </p>
            </div>
            <div className="num border-t border-line-1 px-4 py-2.5 text-[10.5px] text-fg-4">Hover the numbers. The red one was not found in any tool output, so the operator sees it before acting on it.</div>
          </Reveal>
        </div>
      </Wrap>
    </section>
  )
}

function V({ s, children }: { s: string; children: ReactNode }) {
  return (
    <Tip
      className="cursor-help rounded-[2px] underline decoration-fg-2/30 decoration-dotted underline-offset-[3px] transition-colors hover:bg-[var(--ok-dim)]"
      content={
        <span className="flex items-center gap-1.5">
          <Check size={11} className="text-ok" />
          <span>
            <span className="text-ok">verified</span> · <span className="num text-fg-1">{s}</span>
          </span>
        </span>
      }
    >
      {children}
    </Tip>
  )
}
function U({ children }: { children: ReactNode }) {
  return (
    <Tip
      className="cursor-help underline decoration-alarm decoration-dotted decoration-[1.5px] underline-offset-[3px]"
      content={
        <span className="flex items-center gap-1.5">
          <X size={11} className="text-alarm" />
          <span>
            <span className="text-alarm">unverified</span> · not found in any tool output
          </span>
        </span>
      }
    >
      {children}
    </Tip>
  )
}

/* ───────────────────────── closing ───────────────────────── */

function Closing() {
  return (
    <section className="relative overflow-hidden border-b border-line-1 py-24 md:py-28">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_120%_at_85%_100%,var(--accent-dim),transparent_70%)]" />
      <Wrap className="relative flex flex-col items-start justify-between gap-8 md:flex-row md:items-end">
        <Reveal>
          <h2 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-fg-1 md:text-[44px]">
            Point any camera at a machine.
            <br />
            <span className="text-fg-3">Leave with a verified setpoint.</span>
          </h2>
        </Reveal>
        <Reveal delay={120} className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          <CTA href="/console" primary>
            Open live console <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </CTA>
          <CTA href={REPLAY}>
            <Play size={14} /> Watch the replay
          </CTA>
        </Reveal>
      </Wrap>
    </section>
  )
}

function Footer() {
  return (
    <footer className="py-10">
      <Wrap className="flex flex-col gap-4 text-[12.5px] text-fg-4 md:flex-row md:items-center">
        <Logo />
        <span className="md:ml-4">Built for the Meta Global AI Developer Hackathon 2026.</span>
        <span className="num md:ml-auto">
          Video credits: <span className="text-fg-3">data/VIDEO_SOURCES.md</span>
        </span>
      </Wrap>
    </footer>
  )
}

export function Landing() {
  return (
    <div className="min-h-full overflow-x-clip bg-page text-fg-2">
      <Nav />
      <main>
        <Hero />
        <Problem />
        <How />
        <Models />
        <Results />
        <Principles />
        <Closing />
      </main>
      <Footer />
    </div>
  )
}

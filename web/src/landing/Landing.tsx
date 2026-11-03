import type { ReactNode } from 'react'
import { ArrowRight, ArrowUpRight, Check, Play, X } from 'lucide-react'
import { onLink } from '../lib/router'
import { Logo } from '../components/Logo'
import { cx, Tip } from '../components/ui'
import { HeroSpectrogram } from './HeroSpectrogram'
import { IdentifyDiagram, MeasureDiagram, OptimiseDiagram, ProveDiagram, SenseDiagram } from './Diagrams'

const REPLAY = '/console?replay=demo_fan_closed_loop'
const IEA_2025 = 'https://www.iea-4e.org/wp-content/uploads/2025/12/4E-Policy-Brief-EMSA-9-20251218.pdf'

/* ───────────────────────── primitives ───────────────────────── */

function Wrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('mx-auto w-full max-w-[1200px] px-5 md:px-8', className)}>{children}</div>
}

function Eyebrow({ n, children }: { n: string; children: ReactNode }) {
  return (
    <div className="num flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-fg-3">
      <span className="text-fg-4">{n}</span>
      <span className="h-px w-6 bg-line-2" />
      <span>{children}</span>
    </div>
  )
}

function H2({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mt-4 max-w-[760px]">
      <h2 className="text-[30px] font-semibold leading-[1.08] tracking-[-0.03em] text-fg-1 md:text-[42px]">{children}</h2>
      {sub && <p className="mt-4 max-w-[640px] text-[15.5px] leading-relaxed text-fg-2 md:text-[17px]">{sub}</p>}
    </div>
  )
}

function CTA({ href, children, primary }: { href: string; children: ReactNode; primary?: boolean }) {
  return (
    <a
      href={href}
      onClick={onLink}
      className={cx(
        'group inline-flex h-11 items-center justify-center gap-2 rounded-lg border px-5 text-[14px] font-medium transition-colors duration-150',
        primary
          ? 'border-transparent bg-accent text-[#0b0a14] shadow-[0_0_0_1px_rgba(157,140,255,.45),0_10px_40px_-12px_rgba(157,140,255,.7)] hover:bg-accent-2'
          : 'border-line-2 bg-bg-1/70 text-fg-1 backdrop-blur hover:border-[#3a434d] hover:bg-bg-3',
      )}
    >
      {children}
    </a>
  )
}

/** Seamed grid: cells separated by 1px hairlines, like the console bezel. */
function Seams({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('grid gap-px overflow-hidden rounded-xl border border-line-1 bg-line-1', className)}>{children}</div>
}

/* ───────────────────────── nav ───────────────────────── */

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line-1 bg-[rgba(7,8,10,.78)] backdrop-blur-md">
      <Wrap className="flex h-14 items-center gap-6">
        <a href="/" onClick={onLink} aria-label="Argonaut home">
          <Logo />
        </a>
        <nav className="hidden items-center gap-5 text-[13px] text-fg-3 md:flex">
          <a href="#problem" className="hover:text-fg-1">
            Problem
          </a>
          <a href="#how" className="hover:text-fg-1">
            How it works
          </a>
          <a href="#models" className="hover:text-fg-1">
            Models
          </a>
          <a href="#results" className="hover:text-fg-1">
            Results
          </a>
          <a href="#principles" className="hover:text-fg-1">
            Principles
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <a href={REPLAY} onClick={onLink} className="hidden h-8 items-center gap-1.5 rounded-md px-3 text-[13px] text-fg-2 hover:bg-bg-3 hover:text-fg-1 sm:inline-flex">
            <Play size={13} /> Replay
          </a>
          <a
            href="/console"
            onClick={onLink}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-2 bg-bg-2 px-3 text-[13px] font-medium text-fg-1 transition-colors hover:border-[rgba(157,140,255,.5)] hover:bg-bg-3"
          >
            Open console <ArrowRight size={13} />
          </a>
        </div>
      </Wrap>
    </header>
  )
}

/* ───────────────────────── hero ───────────────────────── */

function Hero() {
  return (
    <section className="relative isolate overflow-hidden border-b border-line-1">
      <HeroSpectrogram className="absolute inset-0 -z-20" />
      {/* legibility masks: graphite from the left (text) and the bottom (section seam) */}
      <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,#07080a_0%,rgba(7,8,10,.94)_34%,rgba(7,8,10,.55)_58%,rgba(7,8,10,.18)_100%)] max-md:bg-[linear-gradient(180deg,rgba(7,8,10,.3)_0%,rgba(7,8,10,.82)_42%,rgba(7,8,10,.9)_75%,#07080a_100%)]" />
      <div className="absolute inset-x-0 bottom-0 -z-10 h-32 bg-gradient-to-t from-bg-0 to-transparent" />
      <Wrap className="flex min-h-[640px] flex-col justify-center py-24 md:min-h-[720px] md:py-28">
        <div className="max-w-[640px]">
          <div className="num inline-flex h-7 items-center gap-2 rounded-full border border-line-2 bg-bg-1/80 pl-2.5 pr-3 text-[11.5px] text-fg-2 backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-accent anim-pulse" />
            <span className="sm:hidden">Video + sound → verified setpoint</span>
            <span className="hidden sm:inline">Phone video + sound → machine dynamics → verified setpoint</span>
          </div>
          <h1 className="mt-7 text-[44px] font-semibold leading-[0.98] tracking-[-0.045em] text-fg-1 sm:text-[60px] md:text-[76px]">
            Your camera is a<br />
            vibration lab.
          </h1>
          <p className="mt-6 max-w-[560px] text-[16.5px] leading-relaxed text-fg-2 md:text-[18.5px]">
            Argonaut identifies a rotating machine&rsquo;s dynamics from phone video and sound, then finds the speed that runs it best, verified in closed loop.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <CTA href="/console" primary>
              Open live console <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
            </CTA>
            <CTA href={REPLAY}>
              <Play size={14} /> Watch the replay
            </CTA>
          </div>
          <p className="num mt-6 text-[11.5px] text-fg-4">Runs in the browser. Without a backend, the console falls back to its built-in simulator.</p>
        </div>
      </Wrap>
      <div className="num pointer-events-none absolute right-5 top-4 hidden text-[10.5px] text-fg-4 md:block">
        live · procedural coast-down spectrogram · 5-blade fan · orders crossing 3 structural modes
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
        <Seams className="mt-12 grid-cols-1 md:grid-cols-2">
          <div className="bg-bg-1 p-7 md:p-9">
            <div className="num text-[64px] font-normal leading-none tracking-[-0.05em] text-fg-1 md:text-[84px]">53%</div>
            <p className="mt-4 max-w-[400px] text-[15px] leading-relaxed text-fg-2">of global electricity was used by electric motor systems in 2023.</p>
            <a href={IEA_2025} target="_blank" rel="noreferrer" className="num mt-5 inline-flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg-1">
              IEA 4E EMSA policy brief, 2025 <ArrowUpRight size={12} />
            </a>
          </div>
          <div className="bg-bg-1 p-7 md:p-9">
            <div className="num text-[64px] font-normal leading-none tracking-[-0.05em] text-fg-1 md:text-[84px]">
              <span className="text-fg-3">≈</span>70%
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
                  <span className="mt-[9px] h-px w-3 shrink-0 bg-fg-4" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-bg-1 p-7 md:p-9">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-2">With Argonaut</div>
            <ul className="mt-4 space-y-2.5 text-[14.5px] leading-relaxed text-fg-2">
              {['A phone camera and its microphone, pointed at the machine.', 'A coast-down, narrated by voice.', 'A human who approves the operating envelope.'].map((t) => (
                <li key={t} className="flex gap-3">
                  <span className="mt-[9px] h-px w-3 shrink-0 bg-accent" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </Seams>
      </Wrap>
    </section>
  )
}

/* ───────────────────────── how it works ───────────────────────── */

const STEPS = [
  { k: 'Sense', d: 'SAM 3.1 places virtual sensors by name: “bearing housing”, “baseplate”. A static region becomes the shake reference.', g: <SenseDiagram /> },
  { k: 'Measure', d: 'Sub-pixel motion per mask, a mic tachometer from blade-pass sound, and de-aliasing that recovers orders far above the camera’s Nyquist.', g: <MeasureDiagram /> },
  { k: 'Identify', d: 'Order tracking through a coast-down builds the Campbell diagram; FDD finds the modes. Every frequency and damping carries an error bar.', g: <IdentifyDiagram /> },
  { k: 'Optimise', d: 'Robust constrained RTO: minimise energy subject to duty, P(resonance) and NPSH, inside an envelope the operator approved.', g: <OptimiseDiagram /> },
  { k: 'Prove', d: 'The loop steps the drive, re-measures and updates the twin. The change is accepted only if the before/after difference is significant.', g: <ProveDiagram /> },
]

function How() {
  return (
    <section id="how" className="scroll-mt-14 border-b border-line-1 py-24 md:py-32">
      <Wrap>
        <Eyebrow n="02">How it works</Eyebrow>
        <H2 sub="Five stages, each one visible in the console, each one leaving evidence you can open.">From pixels to a proven setpoint.</H2>
        <Seams className="mt-12 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.k} className="flex flex-col bg-bg-1 p-6">
              <div className="flex items-baseline gap-2.5">
                <span className="num text-[11.5px] text-fg-4">0{i + 1}</span>
                <span className="text-[16px] font-semibold tracking-[-0.01em] text-fg-1">{s.k}</span>
              </div>
              <p className="mt-2 flex-1 text-[13.5px] leading-relaxed text-fg-3">{s.d}</p>
              <div className="mt-6">{s.g}</div>
            </div>
          ))}
          <a href="/console" onClick={onLink} className="group flex flex-col justify-between bg-bg-1 p-6 transition-colors hover:bg-bg-2">
            <span className="text-[13.5px] leading-relaxed text-fg-3">Each stage is a panel in the console: live view and model rail, spectrum and de-aliasing, Campbell and modal, optimiser and closed loop.</span>
            <span className="mt-6 inline-flex items-center gap-1.5 text-[14px] font-medium text-fg-1 group-hover:text-accent-2">
              Open the console <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
            </span>
          </a>
        </Seams>
      </Wrap>
    </section>
  )
}

/* ───────────────────────── models ───────────────────────── */

const MODELS = [
  { name: 'SAM 3.1', id: 'sam-3.1', job: 'Segments and tracks the parts you name. Each mask becomes a measurement channel; the static wall becomes the reference that cancels camera shake.' },
  { name: 'Muse Spark', id: 'muse-spark', job: 'Reads the scene, the nameplate and the datasheet, cross-checks the running speed in the audio, and coaches the capture: “brace the phone”.' },
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
          {MODELS.map((m) => (
            <div key={m.id} className="group bg-bg-1 p-6 transition-colors hover:bg-bg-2">
              <div className="flex items-center gap-2.5">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                <span className="text-[15px] font-semibold text-fg-1">{m.name}</span>
                <span className="num ml-auto rounded-[4px] border border-line-1 px-1.5 py-[1px] text-[10px] text-fg-4">META</span>
              </div>
              <div className="num mt-1 pl-4 text-[11px] text-fg-4">{m.id}</div>
              <p className="mt-4 text-[13.5px] leading-relaxed text-fg-2">{m.job}</p>
            </div>
          ))}
          <div className="flex flex-col justify-between bg-bg-1 p-6">
            <div className="text-[13.5px] leading-relaxed text-fg-3">
              Everything else is deterministic and inspectable: phase correlation, FFT, order tracking, FDD, the optimiser and the significance test.
            </div>
            <a href="/console" onClick={onLink} className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-fg-1 hover:text-accent-2">
              See them work <ArrowRight size={14} />
            </a>
          </div>
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

function Result({ k, v, u, children, wide }: { k: string; v: ReactNode; u?: string; children?: ReactNode; wide?: boolean }) {
  return (
    <div className={cx('flex flex-col bg-bg-1 p-6 md:p-7', wide && 'md:col-span-2')}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-4">{k}</div>
      <div className="num mt-4 flex flex-wrap items-baseline gap-x-2 text-[34px] leading-none tracking-[-0.04em] text-fg-1 md:text-[40px]">
        {v}
        {u && <span className="text-[14px] tracking-normal text-fg-3">{u}</span>}
      </div>
      {children}
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
          <Result k="Misalignment phase" v="179.8" u="°">
            <Pair m="179.8°" t="180°" />
          </Result>
          <Result k="Coast-down mode" v="14.06" u="Hz">
            <Pair k="f" m="14.06 Hz" t="14.2 Hz" />
            <Pair k="ζ" m="2.25%" t="2.0%" />
          </Result>
          <Result k="Camera-shake rejection" v="2.8" u="%">
            <p className="mt-3 text-[12.5px] leading-snug text-fg-3">residual of the true shake after the static-reference correction</p>
          </Result>
          <Result k="Streaming latency" v="22" u="ms median">
            <p className="num mt-3 text-[12px] text-fg-3">
              <span className="text-fg-1">38 ms</span> p95 · frame → telemetry
            </p>
          </Result>

          <Result k="De-aliasing · 30 fps webcam + mic" v="148.06" u="Hz recovered from a camera with a 15 Hz Nyquist" wide>
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
                    <tr key={o} className="border-t border-line-1">
                      <td className="px-3 py-1.5 text-fg-2">{o}</td>
                      <td className="px-3 py-1.5 text-right text-fg-3">{a} Hz</td>
                      <td className="px-3 py-1.5 text-right text-accent-2">{t} Hz</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Result>

          <Result k="Closed loop · simulated drive" v={<span>−89%</span>} wide>
            <div className="num mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px] text-fg-3">
              <span>
                vibration <span className="text-fg-2">2.59</span> → <span className="text-fg-1">0.30 mm/s</span>
              </span>
              <span className="text-fg-4">·</span>
              <span>8 iterations</span>
            </div>
            <div className="mt-5 space-y-2">
              {[
                ['before', 2.59, 'bg-trace-2'],
                ['after', 0.3, 'bg-fg-1'],
              ].map(([k, v, c]) => (
                <div key={k as string} className="num grid grid-cols-[44px_1fr_64px] items-center gap-3 text-[11px] text-fg-3">
                  <span>{k}</span>
                  <span className="h-[6px] rounded-[1px] bg-bg-3">
                    <span className={cx('block h-full rounded-[1px]', c as string)} style={{ width: `${((v as number) / 2.59) * 100}%` }} />
                  </span>
                  <span className="text-right text-fg-2">{(v as number).toFixed(2)} mm/s</span>
                </div>
              ))}
            </div>
            <div className="mt-4">
              <span className="num inline-flex h-6 items-center gap-1.5 rounded-[5px] border border-[rgba(60,191,138,.35)] bg-[var(--ok-dim)] px-2 text-[11.5px] text-ok">
                <Check size={12} /> p = 3.8×10⁻⁸ · significant
              </span>
            </div>
          </Result>

          <Result k="Agent numeric provenance" v="66/66" wide>
            <p className="mt-3 text-[12.5px] leading-snug text-fg-3">numbers in the final assessment traced to a tool output; none unverified.</p>
          </Result>
          <div className="flex flex-col justify-end bg-bg-1 p-6 md:col-span-2 md:p-7">
            <p className="num text-[11.5px] leading-relaxed text-fg-4">
              Synthetic ground truth and a simulated plant (VFD over Modbus). Details: <span className="text-fg-3">docs/BENCHMARK.md</span>.
            </p>
          </div>
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
            ].map(([t, d], i) => (
              <li key={t} className="grid grid-cols-[28px_1fr] gap-3">
                <span className="num pt-1 text-[12px] text-fg-4">0{i + 1}</span>
                <div>
                  <div className="text-[19px] font-semibold tracking-[-0.015em] text-fg-1">{t}</div>
                  <p className="mt-2 text-[14.5px] leading-relaxed text-fg-2">{d}</p>
                </div>
              </li>
            ))}
          </ol>
          {/* a live specimen of the provenance marks used in the console */}
          <div className="self-start overflow-hidden rounded-xl border border-line-1 bg-bg-1">
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
          </div>
        </div>
      </Wrap>
    </section>
  )
}

function V({ s, children }: { s: string; children: ReactNode }) {
  return (
    <Tip
      className="cursor-help rounded-[2px] underline decoration-[rgba(162,171,181,.3)] decoration-dotted underline-offset-[3px] hover:bg-[var(--ok-dim)]"
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
    <section className="border-b border-line-1 py-24 md:py-28">
      <Wrap className="flex flex-col items-start justify-between gap-8 md:flex-row md:items-end">
        <div>
          <h2 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-fg-1 md:text-[44px]">
            Point a camera at a machine.
            <br />
            <span className="text-fg-3">Leave with a verified setpoint.</span>
          </h2>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          <CTA href="/console" primary>
            Open live console <ArrowRight size={16} />
          </CTA>
          <CTA href={REPLAY}>
            <Play size={14} /> Watch the replay
          </CTA>
        </div>
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
    <div className="min-h-full overflow-x-hidden bg-bg-0 text-fg-2">
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

import { useEffect, useRef, useState } from 'react'
import { ArrowUp, BrainCircuit, Check, CircleCheck, Image as ImageIcon, Info, Mic, OctagonAlert, ShieldCheck, Sigma, Sparkles, TriangleAlert, Waves, X } from 'lucide-react'
import { useStore, type ConsoleItem } from '../lib/store'
import { link } from '../lib/socket'
import type { AgentClaim, DiagnosisEvent, Evidence } from '../lib/protocol'
import { cx, Panel, StatusDot, Tip } from './ui'

/** Agent text with numeric provenance: verified numbers reveal their source on hover, unverified ones are flagged. */
function ClaimText({ text, claims }: { text: string; claims?: AgentClaim[] }) {
  if (!claims?.length) return <>{text}</>
  const out: React.ReactNode[] = []
  let at = 0
  claims.forEach((c, i) => {
    if (c.start < at || c.end > text.length) return
    if (c.start > at) out.push(text.slice(at, c.start))
    const slice = text.slice(c.start, c.end)
    out.push(
      c.verified ? (
        <Tip
          key={i}
          className="group/claim relative cursor-help rounded-[2px] decoration-fg-2/28 decoration-dotted underline-offset-[3px] transition-colors hover:bg-[var(--ok-dim)] hover:text-fg-1 hover:underline"
          content={
            <span className="flex items-center gap-1.5">
              <Check size={11} className="shrink-0 text-ok" />
              <span>
                <span className="text-ok">verified</span> · <span className="num text-fg-1">{c.source}</span>
              </span>
            </span>
          }
        >
          {slice}
          <Check size={9} strokeWidth={3} className="pointer-events-none absolute -right-[7px] -top-[3px] hidden text-ok group-hover/claim:block" />
        </Tip>
      ) : (
        <Tip
          key={i}
          className="cursor-help underline decoration-alarm decoration-dotted decoration-[1.5px] underline-offset-[3px]"
          content={
            <span className="flex items-center gap-1.5">
              <X size={11} className="shrink-0 text-alarm" />
              <span>
                <span className="text-alarm">unverified</span> · not found in any tool output
              </span>
            </span>
          }
        >
          {slice}
        </Tip>
      ),
    )
    at = c.end
  })
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

function ProvenanceFoot({ claims }: { claims: AgentClaim[] }) {
  const v = claims.filter((c) => c.verified).length
  const u = claims.length - v
  return (
    <span className="num mt-0.5 flex items-center gap-1.5 text-[9.5px] text-fg-4">
      <ShieldCheck size={10} />
      {v}/{claims.length} numbers traced to tool output
      {u > 0 && <span className="text-alarm">· {u} unverified</span>}
    </span>
  )
}

/** Session-wide counter: how many numbers the agent stated could be traced to a tool output. */
function ProvenanceCounter() {
  const p = useStore((s) => s.provenance)
  const total = p.verified + p.unverified
  if (!total) return null
  return (
    <Tip
      content={
        <span className="num">
          {p.verified} of {total} numbers in {p.messages} agent messages match a tool output
          {p.unverified > 0 ? ` · ${p.unverified} not found in any tool output (red underline)` : ''}
        </span>
      }
    >
      <span className="num inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-line-2 bg-bg-2 px-1.5 text-[10px] text-fg-2">
        <ShieldCheck size={10} className={p.unverified ? 'text-fg-3' : 'text-ok'} />
        <span className="hidden text-fg-3 2xl:inline">Provenance</span>
        <span className="text-fg-1">
          {p.verified}/{total}
        </span>
        <span className="hidden text-fg-3 sm:inline">verified</span>
        {p.unverified > 0 && <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-alarm" />}
      </span>
    </Tip>
  )
}

function evidenceLabel(e: Evidence) {
  if (e.kind === 'spectrum_peak') return { icon: <Waves size={10} />, text: `${e.channel} · ${e.f_hz.toFixed(1)} Hz` }
  if (e.kind === 'frame') return { icon: <ImageIcon size={10} />, text: `frame t=${e.t.toFixed(1)}s` }
  if (e.kind === 'metric' && e.name != null)
    return { icon: <Sigma size={10} />, text: `${e.name.split(' ')[0]} ${e.value}${e.err != null ? ` ± ${e.err}` : ''}` }
  const any = e as unknown as Record<string, unknown>
  return { icon: <Sigma size={10} />, text: String(any.ref ?? any.name ?? 'evidence') }
}

export function EvidenceChips({ d }: { d: DiagnosisEvent }) {
  const open = useStore((s) => s.openEvidence)
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {d.evidence.map((e, i) => {
        const l = evidenceLabel(e)
        return (
          <button
            key={i}
            onClick={() => open({ title: d.title, evidence: d.evidence, focus: i, source: d.model })}
            className="num inline-flex h-[20px] items-center gap-1 rounded-[4px] border border-line-2 bg-bg-2 px-1.5 text-[10px] text-fg-2 transition-colors hover:border-line-3 hover:bg-bg-3 hover:text-fg-1"
          >
            {l.icon}
            {l.text}
          </button>
        )
      })}
    </div>
  )
}

function Tag({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'accent' | 'fg' }) {
  return (
    <span className={cx('num w-[52px] shrink-0 pt-[2px] text-[9.5px] font-semibold tracking-[0.06em]', tone === 'accent' ? 'text-accent-2' : tone === 'fg' ? 'text-fg-2' : 'text-fg-4')}>{children}</span>
  )
}

function Item({ it }: { it: ConsoleItem }) {
  const diag = useStore((s) => (it.kind === 'diagnosis' ? s.diagnoses.find((d) => d.id === it.refId) : undefined))
  const time = new Date(it.at).toLocaleTimeString('en-GB', { hour12: false })
  switch (it.kind) {
    case 'agent':
      return (
        <div className="anim-in flex gap-2 px-3 py-1.5">
          <Tag tone="accent">WONDER</Tag>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] leading-relaxed text-fg-1">
              {it.open ? it.text : <ClaimText text={it.text} claims={it.claims} />}
              {it.open && <span className="anim-caret ml-0.5 inline-block h-3 w-[6px] translate-y-[2px] bg-accent" />}
            </p>
            {!it.open && it.claims && it.claims.length > 0 && <ProvenanceFoot claims={it.claims} />}
          </div>
        </div>
      )
    case 'user':
      return (
        <div className="anim-in flex gap-2 px-3 py-1.5">
          <Tag tone="fg">YOU</Tag>
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-fg-2">{it.text}</p>
        </div>
      )
    case 'transcript':
      return (
        <div className="anim-in flex gap-2 px-3 py-1">
          <Tag>VOICE·{it.speaker}</Tag>
          <p className={cx('flex min-w-0 flex-1 items-start gap-1.5 text-[12px] leading-relaxed', it.open ? 'text-fg-3' : 'text-fg-2')}>
            <Mic size={11} className="mt-[3px] shrink-0 text-fg-4" />
            <span>
              “{it.text}
              {it.open ? '…' : '”'}
            </span>
          </p>
        </div>
      )
    case 'coach':
      return (
        <div className="anim-in flex gap-2 px-3 py-1">
          <Tag>COACH</Tag>
          <p className={cx('flex min-w-0 flex-1 items-start gap-1.5 text-[11.5px] leading-relaxed', it.level === 'block' ? 'text-alarm' : it.level === 'warn' ? 'text-warn' : 'text-fg-3')}>
            <Sparkles size={11} className="mt-[3px] shrink-0 opacity-70" />
            {it.text}
          </p>
        </div>
      )
    case 'diagnosis': {
      if (!diag) return null
      const sev = diag.severity
      return (
        <div className="anim-in px-3 py-1.5">
          <div className={cx('rounded-md border border-l-2 bg-bg-2 px-2.5 py-2', sev === 'alarm' ? 'border-line-2 border-l-alarm' : sev === 'warn' ? 'border-line-2 border-l-warn' : 'border-line-2 border-l-fg-3')}>
            <div className="flex items-center gap-1.5">
              {sev === 'alarm' ? <OctagonAlert size={12} className="text-alarm" /> : sev === 'warn' ? <TriangleAlert size={12} className="text-warn" /> : <Info size={12} className="text-fg-2" />}
              <span className="text-[12px] font-semibold text-fg-1">{diag.title}</span>
              <span className="num ml-auto text-[10px] text-fg-4">{(diag.confidence * 100).toFixed(0)}%</span>
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fg-2">{diag.summary}</p>
            <EvidenceChips d={diag} />
          </div>
        </div>
      )
    }
    case 'error':
      return (
        <div className="anim-in flex gap-2 px-3 py-1">
          <Tag>ERROR</Tag>
          <p className="min-w-0 flex-1 text-[11.5px] text-alarm">{it.text}</p>
        </div>
      )
    default:
      return (
        <div className="anim-in flex items-center gap-2 px-3 py-1" title={time}>
          <Tag>SYS</Tag>
          <p className={cx('flex min-w-0 flex-1 items-center gap-1.5 text-[11px]', it.level === 'verified' ? 'text-ok' : it.level === 'failed' ? 'text-alarm' : it.level === 'proposal' ? 'text-accent-2' : 'text-fg-3')}>
            {it.level === 'verified' && <CircleCheck size={11} />}
            {it.level === 'proposal' && <BrainCircuit size={11} />}
            <span className="truncate">{it.text}</span>
          </p>
        </div>
      )
  }
}

const SUGGEST = ['Why this setpoint?', 'How was ζ measured?', 'NPSH margin?']

export function AgentConsole() {
  const items = useStore((s) => s.console)
  const voice = useStore((s) => s.pipeline.voice)
  const [text, setText] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items])

  const send = (t: string) => {
    const v = t.trim()
    if (!v) return
    link.send({ type: 'chat', text: v })
    setText('')
    stick.current = true
  }

  return (
    <Panel
      title="Agent console"
      meta="Muse Wonder · Voice · Coach"
      right={
        <>
        <ProvenanceCounter />
        <span className={cx('ml-1 inline-flex items-center gap-1.5 text-[10.5px]', voice.state === 'running' ? 'text-fg-2' : 'text-fg-4')} title="Muse Voice Transcribe realtime session">
          <Mic size={11} />
          {voice.state === 'running' ? 'listening' : voice.state === 'ok' ? 'heard' : 'voice off'}
          <StatusDot state={voice.state === 'running' ? 'running' : voice.state} size={5} />
        </span>
        </>
      }
      bodyClass="flex flex-col"
    >
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="min-h-0 flex-1 overflow-y-auto py-1.5"
      >
        {items.map((it) => (
          <Item key={it.id} it={it} />
        ))}
        {!items.length && <div className="px-3 py-6 text-center text-[11px] text-fg-4">Agent narration, voice transcript and capture coaching stream here.</div>}
      </div>
      <div className="shrink-0 border-t border-line-1 p-2">
        <div className="mb-1.5 flex gap-1 overflow-x-auto">
          {SUGGEST.map((s) => (
            <button key={s} onClick={() => send(s)} className="h-[20px] shrink-0 rounded-[4px] border border-line-1 px-1.5 text-[10.5px] text-fg-3 transition-colors hover:border-line-2 hover:text-fg-1">
              {s}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            send(text)
          }}
          className="flex h-8 items-center gap-1 rounded-md border border-line-2 bg-bg-0 pl-2.5 pr-1 focus-within:border-accent/50"
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask Argonaut, or say “Argonaut, …”"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-fg-1 placeholder:text-fg-4 focus:outline-none"
          />
          <button type="submit" disabled={!text.trim()} className="flex h-6 w-6 items-center justify-center rounded-[5px] bg-bg-3 text-fg-2 transition-colors hover:bg-accent hover:text-on-accent disabled:opacity-40">
            <ArrowUp size={13} />
          </button>
        </form>
      </div>
    </Panel>
  )
}

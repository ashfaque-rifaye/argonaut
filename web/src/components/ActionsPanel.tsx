import { useState } from 'react'
import { Bot, CalendarClock, Check, ChevronRight, ClipboardList, Download, Gauge, Loader2, PlugZap, Scale, ShieldBan, Sparkles, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { link } from '../lib/socket'
import type { ActionEvent, WorkOrder } from '../lib/protocol'
import { Btn, Chip, cx, Panel, type Tone } from './ui'

const KIND: Record<string, { icon: typeof Bot; label: string }> = {
  balance: { icon: Scale, label: 'Field balancing' },
  skip_bands: { icon: ShieldBan, label: 'Drive lock-out' },
  work_order: { icon: ClipboardList, label: 'Work order' },
  impact: { icon: Gauge, label: 'Impact' },
  followup: { icon: CalendarClock, label: 'Follow-up' },
}

const STATUS: Record<string, { tone: Tone; label: string }> = {
  proposed: { tone: 'accent', label: 'Awaiting approval' },
  needs_drive: { tone: 'muted', label: 'Needs a drive' },
  running: { tone: 'warn', label: 'Running' },
  done: { tone: 'ok', label: 'Done' },
  failed: { tone: 'alarm', label: 'Failed' },
  rejected: { tone: 'muted', label: 'Rejected' },
}

const who = (p: string) => (p.startsWith('muse-wonder') ? 'Muse Wonder' : p.includes('open') ? 'Muse Spark Open' : 'Rules')

function Result({ a }: { a: ActionEvent }) {
  const r = a.result
  if (!r) return null
  if (a.kind === 'balance') {
    const pct = Math.max(0, Math.min(1, r.one_x_after / Math.max(r.one_x_before, 1e-9)))
    return (
      <div className="mt-2 space-y-1.5 rounded-[9px] border border-line-1 bg-bg-0/40 p-2">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-12 text-fg-3">1× before</span>
          <span className="h-2 flex-1 rounded-full bg-alarm/70" />
          <span className="num w-16 text-right text-fg-1">{r.one_x_before.toFixed(2)} mm/s</span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-12 text-fg-3">1× after</span>
          <span className="h-2 flex-1 rounded-full bg-bg-3">
            <span className="block h-2 rounded-full bg-ok" style={{ width: `${pct * 100}%` }} />
          </span>
          <span className="num w-16 text-right text-fg-1">{r.one_x_after.toFixed(2)} mm/s</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[10.5px] text-fg-3">
          <Chip tone={r.pass ? 'ok' : 'warn'} mono>
            ISO 21940-11 {r.grade} {r.pass ? 'pass' : 'fail'}
          </Chip>
          <span className="num">
            −{r.reduction_pct.toFixed(0)} % · correction {r.correction_g.toFixed(1)} g ∠ {r.correction_deg}° · residual {r.u_res_gmm.toFixed(0)} / {r.u_per_gmm.toFixed(0)} g·mm
          </span>
        </div>
      </div>
    )
  }
  if (a.kind === 'skip_bands') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10.5px]">
        {(r.bands as [number, number][]).map(([c, hw]) => (
          <Chip key={c} tone="neutral" mono>
            skip {c - hw}–{c + hw} rpm
          </Chip>
        ))}
        <Chip tone={r.pass ? 'ok' : 'warn'}>{r.pass ? 'drive refuses the band' : 'drive did not refuse'}</Chip>
      </div>
    )
  }
  if (a.kind === 'impact') {
    return (
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {[
          [`$${Math.round(r.usd_per_year).toLocaleString('en-US')}`, 'per year'],
          [`${Math.round(r.kwh_per_year).toLocaleString('en-US')}`, 'kWh / year'],
          [`${r.t_co2_per_year.toFixed(1)} t`, 'CO₂ / year'],
        ].map(([v, l]) => (
          <div key={l} className="rounded-[9px] border border-line-1 bg-bg-0/40 px-2 py-1.5">
            <div className="num text-[14px] font-semibold text-fg-1">{v}</div>
            <div className="text-[10px] text-fg-4">{l}</div>
          </div>
        ))}
      </div>
    )
  }
  if (a.kind === 'followup') {
    return (
      <div className="mt-1.5 text-[11px] text-fg-2">
        Re-measure on <span className="num font-semibold text-fg-1">{r.due}</span> ({r.days} days)
      </div>
    )
  }
  if (a.kind === 'work_order') return <WorkOrderCard a={a} wo={r.work_order as WorkOrder} />
  return null
}

function WorkOrderCard({ a, wo }: { a: ActionEvent; wo: WorkOrder }) {
  const [open, setOpen] = useState(false)
  const sid = useStore((s) => s.sessionId)
  const live = useStore((s) => s.mode === 'live')
  const md = a.result?.markdown as string | undefined
  const href = live && sid ? `/api/sessions/${encodeURIComponent(sid)}/actions/${a.id}/workorder.md` : md ? `data:text/markdown;charset=utf-8,${encodeURIComponent(md)}` : undefined
  return (
    <div className="mt-2 rounded-[9px] border border-line-1 bg-bg-0/40 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="num text-[11.5px] font-semibold text-fg-1">{wo.number}</span>
        <Chip tone={wo.priority === 'P1' ? 'alarm' : wo.priority === 'P2' ? 'warn' : 'neutral'} mono>
          {wo.priority} · {wo.due}
        </Chip>
        <Chip tone="muted" mono>
          {wo.failure_mode.code} · {wo.failure_mode.standard}
        </Chip>
        <span className="ml-auto flex items-center gap-1">
          <button onClick={() => setOpen(!open)} className="inline-flex h-[20px] items-center gap-0.5 rounded-[5px] px-1.5 text-[10.5px] text-fg-2 hover:bg-bg-3 hover:text-fg-1" aria-expanded={open}>
            <ChevronRight size={11} className={cx('transition-transform', open && 'rotate-90')} /> {open ? 'Hide' : 'Tasks'}
          </button>
          {href && (
            <a href={href} download={`${wo.number}.md`} className="inline-flex h-[20px] items-center gap-1 rounded-[5px] border border-line-2 px-1.5 text-[10.5px] text-fg-2 hover:bg-bg-3 hover:text-fg-1" data-tip="Download the work order (Markdown) for your CMMS">
              <Download size={10} /> .md
            </a>
          )}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-fg-2">{wo.suspected_cause} · posterior {wo.probability.toFixed(2)} · {wo.est_hours} h</p>
      {open && (
        <ol className="anim-in mt-1.5 list-decimal space-y-0.5 pl-4 text-[10.5px] leading-snug text-fg-2">
          {wo.tasks.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      )}
    </div>
  )
}

function ActionCard({ a }: { a: ActionEvent }) {
  const K = KIND[a.kind] ?? { icon: Sparkles, label: a.kind }
  const st = STATUS[a.status] ?? { tone: 'neutral' as Tone, label: a.status }
  const Icon = K.icon
  const live = useStore((s) => s.mode === 'live')
  const [busy, setBusy] = useState(false)
  const decide = async (ok: boolean) => {
    setBusy(true)
    try {
      await link.decideAction(a.id, ok)
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className={cx('anim-in rounded-[12px] border p-2.5 transition-colors', a.status === 'proposed' ? 'border-accent/45 bg-[var(--accent-dim)]' : 'border-line-1 bg-bg-1/40')}>
      <div className="flex items-start gap-2">
        <span className={cx('mt-[1px] inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border', a.status === 'done' ? 'border-ok/40 text-ok' : 'border-line-2 text-fg-2')}>
          {a.status === 'running' ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12.5px] font-semibold leading-tight text-fg-1">{a.title}</span>
            <Chip tone={st.tone}>{st.label}</Chip>
          </div>
          <div className="mt-0.5 text-[10.5px] text-fg-4">
            {K.label} · proposed by {who(a.proposer)}
          </div>
          {a.rationale && <p className="mt-1 text-[11px] leading-snug text-fg-2">{a.rationale}</p>}
        </div>
      </div>
      {a.steps.length > 0 && (
        <ol className="mt-2 space-y-1 border-l border-line-2 pl-3">
          {a.steps.map((s, i) => (
            <li key={i} className="relative text-[10.5px] leading-snug text-fg-2">
              <span className={cx('absolute -left-[17px] top-[3px] h-2 w-2 rounded-full', s.status === 'warn' ? 'bg-warn' : 'bg-ok')} />
              <span className="num mr-1 text-fg-4">{s.t.toFixed(1)}s</span>
              {s.text}
            </li>
          ))}
        </ol>
      )}
      <Result a={a} />
      {a.status === 'failed' && a.error && <p className="mt-1.5 text-[11px] text-alarm">{a.error}</p>}
      {a.status === 'needs_drive' && (
        <p className="mt-1.5 flex items-center gap-1 text-[10.5px] text-fg-3">
          <PlugZap size={11} /> No drive is connected to this footage, so the procedure goes into the work order for a technician.
        </p>
      )}
      {a.status === 'proposed' && (
        <div className="mt-2 flex items-center gap-1.5">
          <Btn size="xs" variant="accent" onClick={() => void decide(true)} disabled={!live || busy} title={live ? 'Run it on the drive, then verify' : 'Approvals need the live backend'}>
            <Check size={11} /> Approve &amp; run
          </Btn>
          <Btn size="xs" variant="ghost" onClick={() => void decide(false)} disabled={!live || busy}>
            <X size={11} /> Reject
          </Btn>
        </div>
      )}
    </li>
  )
}

export function ActionsPanel() {
  const actions = useStore((s) => s.actions)
  const ident = useStore((s) => s.kinematics != null || s.diagnoses.length > 0)
  const live = useStore((s) => s.mode === 'live')
  const pending = actions.filter((a) => a.status === 'proposed').length
  const done = actions.filter((a) => a.status === 'done').length
  return (
    <Panel
      title="Agent actions"
      meta={actions.length ? `${done}/${actions.length} done${pending ? ` · ${pending} awaiting you` : ''}` : 'detect → decide → act → verify'}
      right={
        live && ident ? (
          <Btn size="xs" variant="subtle" onClick={() => void link.planActions()} title="Queue the action plan for the current diagnosis">
            <Bot size={11} /> Plan actions
          </Btn>
        ) : undefined
      }
    >
      {actions.length ? (
        <ul className="absolute inset-0 space-y-2 overflow-y-auto p-2.5">
          {actions.map((a) => (
            <ActionCard key={a.id} a={a} />
          ))}
        </ul>
      ) : (
        <div className="absolute inset-0 flex flex-col justify-center gap-3 overflow-y-auto px-5 py-4">
          <div className="text-[13px] font-semibold text-fg-1">Detection is half the job.</div>
          <p className="text-[11.5px] leading-relaxed text-fg-2">
            After the diagnosis, Muse Wonder decides what fixes the machine and queues it here. You approve; Argonaut runs it on the drive and re-measures to prove it worked.
          </p>
          <ul className="space-y-1.5 text-[11px] text-fg-2">
            {[
              [Scale, 'Field-balance the rotor', 'influence-coefficient method, checked against ISO 21940-11'],
              [ShieldBan, 'Lock the drive out of resonance', 'programs VFD skip frequencies, then tests them'],
              [ClipboardList, 'Write the work order', 'ISO 14224 failure mode, priority, tasks, tolerances'],
              [Gauge, 'Cost the fix', 'kWh, dollars and CO₂ per year'],
            ].map(([I, t, d]) => {
              const Ico = I as typeof Bot
              return (
                <li key={t as string} className="flex items-start gap-2">
                  <Ico size={13} className="mt-[2px] shrink-0 text-accent-2" />
                  <span>
                    <span className="font-medium text-fg-1">{t as string}</span> <span className="text-fg-3">· {d as string}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </Panel>
  )
}

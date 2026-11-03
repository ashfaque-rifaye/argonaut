import { useEffect, useState } from 'react'
import { Keyboard, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { toggleTheme } from '../lib/theme'
import { cx } from './ui'

/** 1–5 map onto the five stages of the landing page, so the story and the console line up. */
export const PANELS: { key: string; label: string; stage: string; tab?: 'proposal' | 'loop' }[] = [
  { key: '1', label: 'Live view', stage: 'Sense' },
  { key: '2', label: 'Spectrum', stage: 'Measure' },
  { key: '3', label: 'Campbell', stage: 'Identify' },
  { key: '4', label: 'Optimizer · proposal', stage: 'Optimise', tab: 'proposal' },
  { key: '5', label: 'Optimizer · closed loop', stage: 'Prove', tab: 'loop' },
]

export function focusPanel(n: string) {
  const p = PANELS.find((x) => x.key === n)
  if (!p) return
  if (p.tab) useStore.getState().set({ optimizerTab: p.tab })
  // wait a frame for a tab switch to lay out
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-panel~="${n}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    el.classList.remove('panel-focus')
    void el.offsetWidth // restart the animation
    el.classList.add('panel-focus')
    window.setTimeout(() => el.classList.remove('panel-focus'), 1500)
  })
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

let openHelp: (() => void) | null = null
export const showShortcuts = () => openHelp?.()

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cx('num inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line-2 bg-bg-2 px-1 text-[10px] font-medium text-fg-2 shadow-[inset_0_-1px_0_var(--color-line-2)]', className)}>{children}</kbd>
  )
}

/** Global console shortcuts + the `?` overlay. Mounted once in the console. */
export function Shortcuts() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    openHelp = () => setOpen(true)
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
      if (useStore.getState().sourceOpen) return // the source drawer owns the keyboard while open
      if (e.key === 'Escape' && open) {
        setOpen(false)
        return
      }
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === 't' || e.key === 'T') {
        toggleTheme()
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        setOpen(false)
        useStore.getState().set({ sourceOpen: true })
      } else if (/^[1-5]$/.test(e.key)) {
        setOpen(false)
        focusPanel(e.key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      openHelp = null
    }
  }, [open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-bg-0/60 p-4 backdrop-blur-[3px] anim-in" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="w-full max-w-[420px] overflow-hidden rounded-xl border border-line-2 bg-bg-1 shadow-[0_30px_80px_-20px_color-mix(in_srgb,var(--color-shadow)_80%,transparent)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-10 items-center gap-2 border-b border-line-1 px-4">
          <Keyboard size={14} className="text-fg-3" />
          <span className="eyebrow">Keyboard shortcuts</span>
          <button onClick={() => setOpen(false)} className="ml-auto rounded-md p-1 text-fg-3 hover:bg-bg-3 hover:text-fg-1" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="p-2">
          <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-4">Focus a panel</div>
          {PANELS.map((p) => (
            <button key={p.key} onClick={() => (setOpen(false), focusPanel(p.key))} className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-[12.5px] text-fg-2 transition-colors hover:bg-bg-2 hover:text-fg-1">
              <Kbd>{p.key}</Kbd>
              <span className="flex-1">{p.label}</span>
              <span className="num text-[10.5px] text-fg-4">{p.stage}</span>
            </button>
          ))}
          <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-4">View</div>
          {[
            ['S', 'Choose the source (real footage library, camera, file)'],
            ['T', 'Toggle light / dark theme'],
            ['?', 'Show or hide this overlay'],
            ['Esc', 'Close overlay, source or evidence drawer'],
          ].map(([k, l]) => (
            <div key={k} className="flex items-center gap-3 px-2 py-1.5 text-[12.5px] text-fg-2">
              <Kbd>{k}</Kbd>
              <span>{l}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

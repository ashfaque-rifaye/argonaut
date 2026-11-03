export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="var(--color-bg-2)" stroke="var(--color-line-2)" />
        <path d="M16 6.5 L24.5 25 H20.4 L16 15 L11.6 25 H7.5 Z" fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" />
        <circle cx="16" cy="21" r="1.7" fill="var(--color-accent)" />
      </svg>
      <span className="text-[12.5px] font-semibold tracking-[0.22em] text-fg-1">ARGONAUT</span>
    </div>
  )
}

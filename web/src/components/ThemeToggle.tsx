import { Moon, Sun } from 'lucide-react'
import { toggleTheme, useTheme } from '../lib/theme'
import { cx } from './ui'

/** Sun/moon switch. The icon cross-rotates; the choice persists (localStorage) and beats the system setting. */
export function ThemeToggle({ className, size = 28 }: { className?: string; size?: number }) {
  const theme = useTheme()
  const light = theme === 'light'
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={light ? 'Switch to dark theme' : 'Switch to light theme'}
      title={`${light ? 'Dark' : 'Light'} theme (T)`}
      className={cx(
        'group relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-line-2 bg-bg-2 text-fg-2 transition-[color,background-color,border-color] duration-150 hover:border-line-3 hover:bg-bg-3 hover:text-fg-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Sun size={14} className={cx('theme-anim absolute transition-[transform,opacity] duration-300 ease-[var(--ease-out-expo)]', light ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-50 opacity-0')} />
      <Moon size={14} className={cx('theme-anim absolute transition-[transform,opacity] duration-300 ease-[var(--ease-out-expo)]', light ? 'rotate-90 scale-50 opacity-0' : 'rotate-0 scale-100 opacity-100')} />
    </button>
  )
}

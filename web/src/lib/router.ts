// A tiny history router: two routes, no dependency.
//   /         landing page
//   /console  control room (all existing query params work here)
import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
window.addEventListener('popstate', notify)

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  window.scrollTo(0, 0)
  notify()
}

export function usePath() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => location.pathname,
  )
}

/** Session-bearing links that land on "/" belong to the console. */
export function redirectLegacy() {
  if (location.pathname !== '/' && location.pathname !== '') return
  const q = new URLSearchParams(location.search)
  if (q.has('mock') || q.has('replay') || q.has('session')) history.replaceState(null, '', `/console${location.search}${location.hash}`)
}

/** Client-side link click: keeps modifier-clicks and new tabs working. */
export function onLink(e: React.MouseEvent<HTMLAnchorElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const href = e.currentTarget.getAttribute('href')
  if (!href || !href.startsWith('/') || href.startsWith('//')) return
  e.preventDefault()
  navigate(href)
}

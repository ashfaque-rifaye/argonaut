import { StrictMode, lazy, Suspense, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { redirectLegacy, usePath } from './lib/router'
import { Landing } from './landing/Landing'

// The console (and its simulator / socket) only loads when /console is opened.
const Console = lazy(() => import('./App').then((m) => ({ default: m.App })))

redirectLegacy()

function Root() {
  const path = usePath()
  const isConsole = path.replace(/\/+$/, '') === '/console'
  useEffect(() => {
    document.title = isConsole ? 'Argonaut · Control Room' : 'Argonaut · Your camera is a vibration lab'
  }, [isConsole])
  return isConsole ? (
    <Suspense fallback={<div className="h-screen bg-bg-0" />}>
      <Console />
    </Suspense>
  ) : (
    <Landing />
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)

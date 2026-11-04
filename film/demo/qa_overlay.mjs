// Screenshots of tracked overlays during a real-speed replay: node film/demo/qa_overlay.mjs <run> <outdir>
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '..', 'package.json'))
const { chromium } = require('playwright-core')
const [run, out] = process.argv.slice(2)
const b = await chromium.launch({ channel: 'msedge', args: ['--autoplay-policy=no-user-gesture-required'] })
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('pageerror', e.message))
await p.goto(`http://localhost:5173/console?replay=${run}&speed=1&hooks=1`)
await p.waitForFunction(() => { const v = document.querySelector('video'); return !!v && v.currentTime > 0 && !!window.__argo?.getState().telemetry }, null, { timeout: 180000 })
await p.locator('[aria-label="Enlarge footage"]').click()
await p.evaluate(() => { const st = window.__argo.getState(); st.set({ selectedChannel: st.tracks?.items[0].id ?? null }) })
for (const [i, s] of [2, 5, 5, 5].entries()) {
  await p.waitForTimeout(s * 1000)
  const t = await p.evaluate(() => document.querySelector('video').currentTime)
  await p.screenshot({ path: join(out, `qa_ov_${i}.png`) })
  console.log(i, t.toFixed(1))
}
await p.locator('[aria-label="Shrink footage"]').click()
await p.waitForTimeout(800)
await p.screenshot({ path: join(out, 'qa_ov_small.png') })
await b.close()

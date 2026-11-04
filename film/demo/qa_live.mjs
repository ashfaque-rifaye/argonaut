// Real visitor flow on the public site: upload a clip, then connect a live feed, both through the hosted backend.
//   node film/demo/qa_live.mjs <clip.mp4> <feed url> <outdir>
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '..', 'package.json'))
const { chromium } = require('playwright-core')
const [clip, feed, out] = process.argv.slice(2)
const SITE = 'https://argonaut-sand.vercel.app/console?hooks=1'
const b = await chromium.launch({ channel: 'msedge', args: ['--autoplay-policy=no-user-gesture-required'] })

async function page() {
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark' })
  p.on('pageerror', (e) => console.log('pageerror', e.message))
  p.on('requestfailed', (r) => { if (r.url().includes('run.app')) console.log('failed', r.url().slice(0, 90), r.failure()?.errorText) })
  await p.goto(SITE)
  await p.waitForSelector('#welcome-title')
  return p
}
const state = (p) => p.evaluate(() => {
  const s = window.__argo.getState()
  return { mode: s.mode, session: !!s.sessionId, conn: s.conn, tracks: s.tracks?.items.map((i) => i.label) ?? null, sensors: s.sensors?.items.map((i) => i.label) ?? null,
    tel: s.telemetry?.clip_t ?? s.telemetry?.t ?? null, spark: s.pipeline.spark.state, sam: s.pipeline.sam.state, wonder: s.pipeline.wonder.state, media: s.mediaKind,
    errors: s.console.filter((c) => c.kind === 'error').map((c) => c.text).slice(-2), last: s.console.slice(-1).map((c) => (c.text ?? '').slice(0, 90)) }
})

// --- upload
const p = await page()
await p.locator('input[type=file]').first().setInputFiles(clip)
for (let i = 0; i < 40; i++) {
  await p.waitForTimeout(15000)
  const st = await state(p)
  console.log('upload', (i + 1) * 15, JSON.stringify(st))
  if (st.tel != null && (st.tel > 3 || st.errors.length)) break
  if (st.errors.length && i > 1) break
}
await p.waitForTimeout(4000)
await p.screenshot({ path: join(out, 'live_upload.png') })
await p.close()

// --- live feed
const q = await page()
await q.getByPlaceholder('rtsp://camera.local/stream1').fill(feed)
await q.getByPlaceholder('rtsp://camera.local/stream1').press('Enter')
for (let i = 0; i < 12; i++) {
  await q.waitForTimeout(10000)
  const st = await state(q)
  console.log('feed', (i + 1) * 10, JSON.stringify(st))
  if (st.tel != null && st.sensors) break
}
await q.waitForTimeout(3000)
await q.screenshot({ path: join(out, 'live_feed.png') })
await b.close()

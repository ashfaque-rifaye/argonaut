// Frame-accurate render of a film page (intro.html / outro.html) to MP4.
//   npm i --prefix film playwright-core@1.48.2      (once; uses the installed Microsoft Edge)
//   node film/render.mjs intro      ->  film/out/argonaut-intro.mp4
// Each frame calls window.render(t) and screenshots the stage, so motion is exact at any frame rate.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, 'package.json'))
const { chromium } = require('playwright-core')

const name = process.argv[2] ?? 'intro'
const fps = Number(process.argv[3] ?? 30)
const frames = join(here, 'out', `frames-${name}`)
rmSync(frames, { recursive: true, force: true })
mkdirSync(frames, { recursive: true })

const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
await page.goto(pathToFileURL(join(here, `${name}.html`)).href)
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(400)
const dur = await page.evaluate(() => window.DURATION)
const n = Math.round(dur * fps)
for (let i = 0; i < n; i++) {
  await page.evaluate((t) => window.render(t), i / fps)
  await page.screenshot({ path: join(frames, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 94 })
  if (i % 60 === 0) process.stdout.write(`${name} ${i}/${n}\n`)
}
await browser.close()
const out = join(here, 'out', `argonaut-${name}.mp4`)
const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', join(frames, 'f%05d.jpg'),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status ?? 1)
rmSync(frames, { recursive: true, force: true })
console.log('wrote', out)

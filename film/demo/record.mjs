// Screen-record the demo segments from the real console (Playwright + installed Edge).
//   needs: web dev server on :5173, API on :8000
//   uv run --with edge-tts python film/demo/voice.py   (voice-over and word timings, once)
//   node film/demo/record.mjs [segment ...]   ->  film/demo/out/seg_<id>.webm + seg_<id>.json (trim offset)
// Results shots replay a recorded run fast to its final state (?speed=40) with the footage looping (?freeplay=1).
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '..', 'package.json'))
const { chromium } = require('playwright-core')
const OUT = join(here, 'out')
const BASE = 'http://localhost:5173'
const TEMPO = 1.02 // the mix plays the voice-over 2 % faster
const PAD = 0.25
const vo = Object.fromEntries(readFileSync(join(OUT, 'durations.txt'), 'utf8').trim().split('\n').map((l) => { const [a, b] = l.trim().split(/\s+/); return [a, Number(b) / TEMPO] }))
// seconds of the machine's own sound before the voice-over comes in (compose.py reads the same table)
const HOLD = JSON.parse(readFileSync(join(here, 'holds.json'), 'utf8'))
HOLD.voiceopen = vo.command + 0.6
const dur = Object.fromEntries(Object.keys(vo).map((k) => [k, (HOLD[k] ?? 0) + vo[k] + PAD]))
/* when a word is spoken, in seconds from the start of its segment */
const words = (id) => JSON.parse(readFileSync(join(OUT, `vo_${id}.json`), 'utf8'))
const atWord = (id, needle, nth = 0) => {
  const hits = words(id).filter((w) => w.w.toLowerCase().includes(needle.toLowerCase()))
  if (!hits[nth]) throw new Error(`no word ${needle} in ${id}`)
  return (HOLD[id] ?? 0) + hits[nth].t / TEMPO
}
/* run steps at fixed times from now, then wait out the segment */
async function timeline(p, steps, total) {
  const t0 = Date.now()
  for (const [t, fn] of [...steps].sort((a, b) => a[0] - b[0])) {
    await p.waitForTimeout(Math.max(0, t * 1000 - (Date.now() - t0)))
    await fn()
  }
  await p.waitForTimeout(Math.max(0, total * 1000 - (Date.now() - t0)))
}

/* page helpers: lower-third captions and a highlight ring. No zoom: the highlight follows the voice-over. */
const HELPERS = () => {
  const css = document.createElement('style')
  css.textContent = `
    #__cap{position:fixed;left:50%;bottom:34px;transform:translate(-50%,16px);opacity:0;z-index:99998;max-width:1320px;display:flex;align-items:center;gap:16px;padding:14px 24px;border-radius:18px;background:rgba(9,10,16,.88);border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 60px -12px rgba(0,0,0,.7);transition:opacity .28s ease,transform .28s ease;font-family:Inter,system-ui,sans-serif;color:#fff}
    #__cap.on{opacity:1;transform:translate(-50%,0)}
    #__cap b{flex:none;padding:6px 13px;border-radius:10px;font-size:19px;font-weight:800;color:#0a0a12;white-space:nowrap}
    #__cap span{font-size:23px;font-weight:600;line-height:1.28}
    #__ring{position:fixed;z-index:99997;border:3px solid #d7ff3a;border-radius:16px;box-shadow:0 0 0 4px rgba(215,255,58,.2),0 0 44px rgba(215,255,58,.42);pointer-events:none;opacity:0;transition:all .42s cubic-bezier(.2,.8,.2,1)}
    .tip-layer{display:none!important}
  `
  document.head.append(css)
  const cap = document.createElement('div'); cap.id = '__cap'; cap.innerHTML = '<b></b><span></span>'
  const ring = document.createElement('div'); ring.id = '__ring'
  document.body.append(cap, ring)
  window.__cap = (chip, text, color = '#d7ff3a') => {
    if (!text) return cap.classList.remove('on')
    cap.firstChild.textContent = chip; cap.firstChild.style.background = color; cap.firstChild.style.display = chip ? '' : 'none'
    cap.lastChild.textContent = text; cap.classList.add('on')
  }
  window.__ring = (r) => {
    if (!r) { ring.style.opacity = 0; return }
    Object.assign(ring.style, { left: r.x - 6 + 'px', top: r.y - 6 + 'px', width: r.width + 12 + 'px', height: r.height + 12 + 'px', opacity: 1 })
  }
}

const panel = (page, title) => page.locator(`section:has(h2:text-is("${title}"))`)
async function ring(page, loc) { await page.evaluate((r) => window.__ring(r), loc ? await loc.boundingBox() : null) }
const cap = (page, chip, text, color) => page.evaluate(([a, b, c]) => window.__cap(a, b, c), [chip, text, color])
const C = { sam: '#22e1ff', spark: '#ff3ea5', wonder: '#d7ff3a', real: '#ffffff', sim: '#ff7a1a', math: '#c3b8ff' }

async function take(browser, id, url, ready, run, seconds) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark', recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } })
  const page = await ctx.newPage()
  const t0 = Date.now()
  await page.goto(BASE + url)
  await page.evaluate(HELPERS)
  await ready(page)
  const start = (Date.now() - t0) / 1000
  // where the footage is at the first kept frame, so its sound can be laid in sync
  const clipT0 = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0)
  const wait = (s) => page.waitForTimeout(s * 1000)
  await run(page, wait)
  const video = page.video()
  await ctx.close()
  const f = join(OUT, `seg_${id}.webm`)
  renameSync(await video.path(), f)
  writeFileSync(join(OUT, `seg_${id}.json`), JSON.stringify({ start, seconds, clipT0 }))
  console.log(id, 'start', start.toFixed(1), 'len', seconds.toFixed(1))
}

/* replay a run fast to its final state, footage looping */
const results = (run, extra = '') => `/console?replay=${run}&speed=40&freeplay=1&hooks=1${extra}`
const settled = (needle) => async (page) => {
  await page.waitForFunction((n) => document.body.innerText.includes(n), needle, { timeout: 120000 })
  await page.waitForTimeout(2500) // let the rest of the run land
  await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.currentTime = 0; v.play().catch(() => {}) } })
}
const enlarge = (page) => page.locator('[aria-label="Enlarge footage"]').click()

/* replay at real speed: the footage plays and the live readings on the labels update */
const live = (run) => `/console?replay=${run}&speed=1&hooks=1`
const playing = (p) => p.waitForFunction(() => { const v = document.querySelector('video'); return !!v && v.currentTime > 0 && !v.paused && !!window.__argo?.getState().telemetry }, null, { timeout: 180000 })
/* highlight one tracked part: the part being talked about, wherever the camera has moved it */
const spot = (p, rx) => p.evaluate((src) => {
  const st = window.__argo.getState(), r = new RegExp(src, 'i')
  const it = (st.tracks?.items ?? st.sensors?.items ?? []).find((i) => r.test(i.label))
  if (it) st.set({ selectedChannel: it.id })
}, rx)

const SEGMENTS = {
  async welcome(b) {
    await take(b, 'welcome', '/console', (p) => p.waitForSelector('#welcome-title'), async (p) => {
      await timeline(p, [
        [0.2, () => cap(p, 'IMPACT', 'Motors use 53% of global electricity (IEA 4E, 2025). Most drives are never checked against their resonances.', C.sim)],
        [atWord('welcome', 'Pick'), () => cap(p, '', 'Three ways in: a recorded machine, your own footage, or a live camera.')],
        [atWord('welcome', 'machine'), () => ring(p, p.getByText('Recommended sample').locator('xpath=ancestor::div[contains(@class,"glass")][1]'))],
        [atWord('welcome', 'upload'), () => ring(p, p.getByText('Upload your own footage').locator('xpath=ancestor::button[1]'))],
        [atWord('welcome', 'connect'), () => ring(p, p.getByText('Connect a live feed').locator('xpath=ancestor::div[contains(@class,"glass")][1]'))],
      ], dur.welcome)
    }, dur.welcome)
  },
  async sense(b) {
    await take(b, 'sense', live('demo_real_pump-skid-analyser'), playing, async (p) => {
      await enlarge(p)
      await spot(p, 'motor')
      await timeline(p, [
        [0.2, () => cap(p, 'REAL FOOTAGE', 'Hand-held camera, with the machine\'s own sound. hu Spectronics, CC BY 3.0.', C.real)],
        [atWord('sense', 'Spark'), () => cap(p, 'MUSE SPARK', 'Names each part and what it does, and looks again as the view changes.', C.spark)],
        [atWord('sense', 'tracks'), () => cap(p, 'SAM 3.1', 'Tracks each part through the video: a real mask on every frame, gone when the part leaves the shot.', C.sam)],
        [atWord('sense', 'motor'), () => spot(p, 'motor')],
        [atWord('sense', 'baseplate'), () => spot(p, 'base')],
        [atWord('sense', 'reading'), () => spot(p, 'motor')],
        [atWord('sense', 'reading'), () => cap(p, 'LIVE READINGS', 'Measured inside the moving mask, camera motion removed. Moving camera, so amplitudes are relative.', C.math)],
      ], dur.sense)
    }, dur.sense)
  },
  async infer(b) {
    await take(b, 'infer', results('demo_real_fan-exhaust-84in-runup'), settled('Kinematic inference'.toUpperCase()), async (p) => {
      const f = panel(p, 'Kinematic inference')
      await timeline(p, [
        [0.2, () => cap(p, 'REAL FOOTAGE', 'An 84-inch exhaust fan run-up, with its sound. Agro Air Dynamics, CC BY 3.0.', C.real)],
        [atWord('infer', 'counts'), async () => { await ring(p, panel(p, 'Live view')); await cap(p, 'MUSE SPARK', 'Counts the blades: 6. That number defines which lines this machine can produce.', C.spark) }],
        [atWord('infer', 'Bayesian'), async () => { await ring(p, f); await cap(p, 'BAYES', 'A harmonic sieve weighs every line against the kinematic model.', C.math) }],
        [atWord('infer', '413'), () => cap(p, 'RESULT', '413 rpm, P = 0.97.')],
        [atWord('infer', 'Without'), () => cap(p, 'WITHOUT THE COUNT', 'The same sound reads 2,477 rpm: blade pass mistaken for shaft speed.', C.sim)],
      ], dur.infer)
    }, dur.infer)
  },
  async samples(b) {
    const shots = [
      ['belt', 'demo_real_belt-drive-running', 'REAL · BELT DRIVE', 'The sensor goes on the fixed beam, never on the moving belt. Sounds of Changes, CC BY 3.0.'],
      ['conveyor', 'demo_real_conveyor-drive-velenje', 'REAL · MINE CONVEYOR', 'Conveyor drive underground in the Velenje coal mine. Sounds of Changes, CC BY 3.0.'],
      ['pump', 'demo_real_pump-self-priming-bench', 'REAL · PUMP', 'Self-priming pump: speed reported as ambiguous, not guessed. Numatic Plants, CC BY 3.0.'],
      ['motor', 'demo_real_motor-load-test-bench', 'REAL · MOTOR', 'Motor test bench: mains lines masked, so they can\'t be mistaken for shaft speed. Dynelec, CC BY 3.0.'],
    ]
    const each = dur.samples / shots.length
    for (const [id, run, chip, text] of shots) {
      await take(b, `samples_${id}`, live(run), playing, async (p, w) => {
        await enlarge(p)
        await cap(p, chip, text, C.real)
        await w(each)
      }, each)
    }
  },
  async agents(b) {
    await take(b, 'agents', results('demo_agent_actions'), settled('3/3 done'), async (p) => {
      const a = panel(p, 'Agent actions')
      const list = a.locator('ul').first()
      const scroll = (top) => list.evaluate((el, y) => el.scrollTo({ top: y, behavior: 'smooth' }), top)
      await timeline(p, [
        [0.1, async () => { await ring(p, panel(p, 'Agent console')); await cap(p, 'MUSE WONDER', 'The reasoning agent: calls tools, tests hypotheses, decides the fix, cites evidence.', C.wonder) }],
        [atWord('agents', 'field-balances'), async () => { await ring(p, a); await cap(p, 'AGENT ACTION', 'Field balance by influence coefficients: trial mass, α = (V1 − V0)/T, correction C = −V0/α.', C.wonder) }],
        [atWord('agents', '18.9'), () => scroll(150)],
        [atWord('agents', 'falls'), async () => { await scroll(330); await cap(p, 'RESULT', '18.9 g at 211°. 1× vibration −84%. ISO 21940-11 G6.3: pass.', C.wonder) }],
        [atWord('agents', 'work'), async () => { await scroll(620); await cap(p, 'WORK ORDER', 'ISO 14224 failure code, priority, tasks, safety, plus the re-measurement date.', C.wonder) }],
        [atWord('agents', 'person'), () => cap(p, 'SIMULATED DRIVE', 'Every physical action waits for a person. This one ran on our simulated drive over Modbus.', C.sim)],
      ], dur.agents)
    }, dur.agents)
  },
  async loop(b) {
    await take(b, 'loop', results('demo_fan_closed_loop'), settled('Provenance'), async (p) => {
      await p.getByRole('button', { name: 'Closed loop' }).click().catch(() => {})
      await timeline(p, [
        [0.1, async () => { await ring(p, p.locator('[data-tour="optimizer"]')); await cap(p, 'SIMULATED PLANT', 'Robust optimiser and Bayesian twin update: vibration 2.59 → 0.30 mm/s, −89%, p = 3.8×10⁻⁸.', C.sim) }],
        [atWord('loop', 'every'), async () => { await ring(p, panel(p, 'Agent console')); await cap(p, 'PROVENANCE', 'Each number the agent writes is checked against tool outputs, and flagged if it doesn\'t match.', C.math) }],
      ], dur.loop)
    }, dur.loop)
  },
  async voiceopen(b) {
    await take(b, 'voiceopen', results('demo_voice_open'), settled('Kinematic inference'.toUpperCase()), async (p) => {
      await timeline(p, [
        [0.1, async () => { await ring(p, panel(p, 'Agent console')); await cap(p, 'MUSE VOICE TRANSCRIBE', '"Argonaut, is pump ko analyse karo, aur best speed batao." Real transcription of synthesised speech.', C.spark) }],
        [atWord('voiceopen', 'agent'), async () => { await ring(p, panel(p, 'Model rail')); await cap(p, 'MUSE SPARK OPEN', 'Real run on the open weights, with the same tools and the same number checks.', C.math) }],
      ], dur.voiceopen)
    }, dur.voiceopen)
  },
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SEGMENTS)
const browser = await chromium.launch({ channel: 'msedge', args: ['--autoplay-policy=no-user-gesture-required'] })
for (const n of names) await SEGMENTS[n](browser)
await browser.close()

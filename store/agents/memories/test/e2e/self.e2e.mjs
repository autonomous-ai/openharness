#!/usr/bin/env node
/**
 * Sense of Self in a real browser, on made-up homes only (test/fixtures.mjs): a person with 100
 * memories, 25 About You lines and 4,000 messages; one with no About You yet; one with nothing at all.
 *
 *   PLAYWRIGHT=/path/to/playwright/index.mjs node --disable-warning=ExperimentalWarning test/e2e/self.e2e.mjs [screenshots-dir]
 *
 * Drives the pane by keys and by clicks at 1000×800 and 700×700, dark and light: arrival, sections and
 * beliefs, why, pluck, the lake and back, a memory lifted out, recall, a conversation search found,
 * the empty states, a hidden tab, reduced motion. Fails on any console error or any request that
 * leaves this machine, and prints the frame script time. Screenshots, when asked for, show only the
 * made-up homes.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import '../setup.mjs'
import { growHome, makeHome } from '../fixtures.mjs'
import { createViewer } from '../../viewer.mjs'

const shots = process.argv[2] ?? null
if (shots) mkdirSync(shots, { recursive: true })
const playwright = process.env.PLAYWRIGHT ?? 'playwright'
const { chromium } = await import(playwright.startsWith('/') ? pathToFileURL(playwright).href : playwright)

const results = []
const failed = []
const check = (ok, what) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed.push(what) }

async function serve(made) {
  const viewer = createViewer({ workspace: mkdtempSync(join(tmpdir(), 'memories-ws-')), env: made.env, home: made.home, intervalMs: 60_000 })
  return { viewer, url: `http://127.0.0.1:${await viewer.start()}/` }
}
const grown = await serve(growHome(makeHome()))
const bare = await serve(makeHome())
const nothing = mkdtempSync(join(tmpdir(), 'memories-empty-'))
const empty = await serve({ home: nothing, env: { MEMORIES_HOME: join(nothing, '.harness', 'memory') } })

/** Counts frames and times each one's script, so a test can see the loop and what it costs. */
const COUNT_FRAMES = `(() => {
  const raf = window.requestAnimationFrame.bind(window)
  window.__frames = { n: 0, ms: [] }
  window.requestAnimationFrame = (fn) => raf((t) => { const s = performance.now(); try { fn(t) } finally { window.__frames.n++; window.__frames.ms.push(performance.now() - s); if (window.__frames.ms.length > 4000) window.__frames.ms.shift() } })
})()`

// ── what a frame costs, on the real-sized person ────────────────────────────────────────────────
// First, alone, in Chromium's own renderer. Under SwiftShader (the rest of this test) this canvas, like
// the prototype's, is rastered at a few frames a second, which says nothing about a person's pane.
// Script time includes the raster of the whole frame: the reflection and the bloom read the canvas back.
{
  const plain = await chromium.launch()
  const context = await plain.newContext({ viewport: { width: 1000, height: 800 }, colorScheme: 'dark' })
  const page = await context.newPage()
  await page.addInitScript(COUNT_FRAMES)
  await page.goto(grown.url)
  await page.waitForFunction(() => document.getElementById('stage').inspectSelf?.().ready)
  await page.keyboard.press('Escape')
  const measure = async (what) => {
    await page.waitForTimeout(600)
    await page.evaluate(() => { window.__frames.ms = []; window.__frames.n = 0 })
    await page.waitForTimeout(3000)
    const cost = await page.evaluate(() => { const ms = [...window.__frames.ms].sort((a, b) => a - b); return { fps: window.__frames.n / 3, median: ms[Math.floor(ms.length / 2)], p95: ms[Math.floor(ms.length * 0.95)] } })
    check(cost.fps >= 45 && cost.median < 16.7, `frame cost, ${what}: ${cost.fps.toFixed(0)} fps, script median ${cost.median.toFixed(1)} ms, p95 ${cost.p95.toFixed(1)} ms`)
  }
  await measure('About You')
  await page.keyboard.type('release')
  await measure('recalling')
  await page.keyboard.press('Escape')
  for (let n = 0; n < 6; n++) await page.keyboard.press('ArrowDown')
  await measure('in the lake')
  await plain.close()
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })

async function open(server, { width = 1000, height = 800, scheme = 'dark', reduced = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: reduced })
  const page = await context.newPage()
  const errors = [], offsite = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol !== 'data:') offsite.push(r.url()) })
  await page.addInitScript(COUNT_FRAMES)
  await page.goto(server.url)
  await page.waitForFunction(() => document.getElementById('stage').inspectSelf?.().ready)
  const self = () => page.evaluate(() => document.getElementById('stage').inspectSelf())
  const text = (selector) => page.locator(selector).first().textContent()
  const settle = (ms = 450) => page.waitForTimeout(ms)
  const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }) }
  const done = async (tag) => {
    check(errors.length === 0, `${tag}: no console errors ${errors.join(' ; ')}`)
    check(offsite.length === 0, `${tag}: no requests off this machine ${offsite.join(' ')}`)
    await context.close()
  }
  return { page, self, text, settle, shot, done }
}

// ── a real-sized person, 1000×800, dark: everything by keys, then by clicks ─────────────────────
{
  const { page, self, text, settle, shot, done } = await open(grown)
  const tag = 'grown 1000x800 dark'
  check(await page.locator('.self.arriving').count() === 1, `${tag}: arrives`)
  await page.waitForTimeout(900)
  await shot('self-arrival-1000x800')
  await page.waitForFunction(() => document.getElementById('stage').inspectSelf().arrived, null, { timeout: 4500 })
  check(true, `${tag}: the arrival ends by itself within four seconds`)
  await settle(700)
  let s = await self()
  check(s.section === 'How you work' && (await text('.self .cap-text')) === s.belief, `${tag}: the first belief, large (${s.section}: ${s.belief})`)
  check(await page.locator('.self .cap-why li').count() >= 3, `${tag}: why your agents believe this, listed`)
  check((await text('#count')) === '104', `${tag}: the header counts the memories (${await text('#count')})`)
  await shot('self-1000x800-dark')

  await page.keyboard.press('ArrowRight')
  s = await self()
  check(s.section === 'What you want from agents', `${tag}: → next section (${s.section})`)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowDown')
  check((await text('.self .kicker .n')) === '2 of 5', `${tag}: ↓ next belief (${await text('.self .kicker .n')})`)
  await page.keyboard.press('ArrowUp')
  check((await text('.self .kicker .n')) === '1 of 5', `${tag}: ↑ back`)
  await page.keyboard.press('Tab')
  check((await self()).thread === 0 && await page.locator('.self .cap-why li.sel').count() === 1, `${tag}: tab picks a source`)
  await page.keyboard.press('Tab')
  check((await self()).thread === 1, `${tag}: tab again, the next source`)
  await page.keyboard.press(' ')
  check((await page.inputValue('#q')) === '', `${tag}: space plucks, it does not type`)
  await settle(300)
  await shot('self-why-1000x800')

  await page.keyboard.press('Enter')
  await settle(1500)
  s = await self()
  check(s.view === 'lake' && s.orb, `${tag}: enter follows the source down into the lake (${s.orb})`)
  check(await page.locator('.self .orb-label.on').waitFor({ timeout: 6000 }).then(() => true, () => false), `${tag}: the memory's name floats beside it`)
  await shot('self-lake-1000x800')
  const before = s.orbId
  await page.keyboard.press('ArrowRight')
  s = await self()
  check(s.orbId && s.orbId !== before, `${tag}: arrows swim to another memory (${s.orb})`)
  await page.keyboard.press('Enter')
  await settle(900)
  s = await self()
  check(s.panel === 'memory' && (await text('.self .panel h2')) === s.orb, `${tag}: enter lifts it out (${await text('.self .panel h2')})`)
  check((await page.locator('.self .panel .body').textContent()).length > 20, `${tag}: its words`)
  await shot('self-lifted-1000x800')
  await page.keyboard.press('Escape')
  await settle(500)
  check((await self()).panel === null && (await self()).view === 'lake', `${tag}: esc puts it back`)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => { const s = document.getElementById('stage').inspectSelf(); return s.view === 'self' && s.camY < 1 }, null, { timeout: 8000 }).catch(() => {})
  check((await self()).view === 'self' && (await self()).camY < 1, `${tag}: esc rises`)

  // By clicks: a section's name, then a belief's bead.
  s = await self()
  const taste = s.labels.find((label) => label.section === 'Taste')
  const box = await page.locator('#stage').boundingBox()
  await page.mouse.click(box.x + taste.x, box.y + taste.y)
  check((await self()).section === 'Taste', `${tag}: clicking a section's name goes there`)
  s = await self()
  const bead = s.beads[12]
  await page.mouse.click(box.x + bead.x, box.y + bead.y)
  check((await self()).belief === bead.text, `${tag}: clicking a bead focuses its belief`)
  const why = page.locator('.self .cap-why li.go').first()
  await why.click()
  await settle(1400)
  check((await self()).view === 'lake', `${tag}: clicking a source goes down to it`)
  await page.mouse.wheel(0, -200)
  await settle(1400)
  check((await self()).view === 'self', `${tag}: scrolling up rises`)

  // Recall: the header prompt.
  await page.keyboard.type('refund')
  await settle(700)
  s = await self()
  check(s.recall?.q === 'refund' && s.recall.picks > 3 && await page.locator('.self .recall.on').count() === 1, `${tag}: typing recalls (${s.recall?.picks} rise)`)
  check(/^\d+\/104$/.test(await text('#count')), `${tag}: the header counts what rose (${await text('#count')})`)
  await shot('self-recall-1000x800')
  await page.keyboard.press('Enter')
  await settle(800)
  check((await self()).panel === 'memory', `${tag}: enter on a risen memory lifts it out`)
  await page.keyboard.press('Escape')
  check((await self()).panel === null && (await self()).recall, `${tag}: esc back to the recall`)
  await page.keyboard.press('Escape')
  check((await self()).recall === null && (await page.inputValue('#q')) === '', `${tag}: esc again forgets, and empties the prompt`)
  await page.keyboard.type('1')
  check((await page.inputValue('#q')) === '1' && (await self()).recall, `${tag}: a digit types into the prompt`)
  await page.keyboard.press('Escape')

  // A conversation older than the mist: search finds it, it rises, enter shows its words.
  await page.keyboard.type('zeppelin')
  await page.waitForFunction(() => document.getElementById('stage').inspectSelf().recall?.extra > 0, null, { timeout: 5000 })
  check(true, `${tag}: a conversation the mist does not hold rises from search`)
  const rows = await page.locator('.self .recall-list li:not(.head)').count()
  for (let n = 1; n < rows; n++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.self .panel .turn', { timeout: 5000 })
  const words = await page.locator('.self .panel .body').textContent()
  check((await self()).panel === 'message' && /zeppelin manifest/.test(words) && /fixed/.test(words), `${tag}: enter shows that conversation's words and answers`)
  await settle(600)
  await shot('self-conversation-1000x800')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  // Only while visible.
  await page.evaluate(() => { window.__frames.n = 0 })
  await page.waitForTimeout(1000)
  check((await page.evaluate(() => window.__frames.n)) > 0, `${tag}: draws while visible`)
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')) })
  const hiddenAt = await page.evaluate(() => window.__frames.n)
  await page.waitForTimeout(500)
  check((await page.evaluate(() => window.__frames.n)) === hiddenAt, `${tag}: a hidden tab draws nothing`)
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')) })
  // Waits on the frame itself: a software renderer can take longer than a fixed few hundred ms for one under
  // load, which failed this check one run in five while the loop was right (start() schedules a frame).
  const drewAgain = await page.waitForFunction((at) => window.__frames.n > at, hiddenAt, { timeout: 3000 }).then(() => true, () => false)
  check(drewAgain, `${tag}: visible again, it draws again`)
  await done(tag)
}

// ── the same person in a small, light pane ──────────────────────────────────────────────────────
for (const [width, height, scheme] of [[700, 700, 'light'], [700, 700, 'dark'], [1000, 800, 'light']]) {
  const { page, self, text, settle, shot, done } = await open(grown, { width, height, scheme })
  const tag = `grown ${width}x${height} ${scheme}`
  await page.keyboard.press('Enter') // skips the arrival
  await settle(800)
  check((await self()).arrived && (await text('.self .cap-text')).length > 5, `${tag}: any key skips the arrival`)
  const header = await page.evaluate(() => getComputedStyle(document.querySelector('.top')).backgroundColor + ' ' + getComputedStyle(document.body).backgroundColor)
  const stage = await page.evaluate(() => getComputedStyle(document.getElementById('stage')).backgroundColor)
  check(stage === 'rgb(3, 4, 7)' && (scheme === 'light' ? header.includes('251, 251, 250') : header.includes('14, 15, 17')), `${tag}: a dark scene under a ${scheme} header (${header}; ${stage})`)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await settle(600)
  await shot(`self-${width}x${height}-${scheme}`)
  await page.keyboard.type('release')
  await settle(700)
  check((await self()).recall?.picks > 0, `${tag}: recall`)
  await shot(`self-recall-${width}x${height}-${scheme}`)
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
  await settle(1500)
  check((await self()).view === 'lake', `${tag}: ↓ past the last belief dives into the lake`)
  await shot(`self-lake-${width}x${height}-${scheme}`)
  await done(tag)
}

// ── no About You yet; nothing at all; reduced motion ────────────────────────────────────────────
{
  const { page, self, text, settle, shot, done } = await open(bare)
  const tag = 'no About You 1000x800'
  await page.keyboard.press('Escape')
  await settle(700)
  check((await text('.self .cap-text')) === 'About You is not built yet.' && /build my About You/.test(await text('.self .cap-note')), `${tag}: says how to build it, in the scene`)
  await shot('self-no-about-1000x800')
  await page.keyboard.type('pnpm')
  await settle(500)
  check(await page.locator('.self .recall-list li', { hasText: 'free' }).count() > 0, `${tag}: a memory that holds up no belief is found by recall`)
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowDown')
  await settle(1400)
  check((await self()).view === 'lake', `${tag}: ↓ dives into the lake`)
  await page.keyboard.press('Enter')
  await settle(700)
  check((await self()).panel === 'memory', `${tag}: and lifts a memory out`)
  const hostile = await page.evaluate(() => document.querySelectorAll('.self img, .self script:not([src])').length)
  check(hostile === 0, `${tag}: no element ever comes from a memory`)
  await done(tag)
}
{
  const { page, text, settle, shot, done } = await open(empty)
  const tag = 'nothing at all 1000x800'
  await settle(600)
  await page.keyboard.press('Escape')
  await settle(500)
  check((await text('.self .cap-text')) === 'Nothing here yet.', `${tag}: a calm empty state (${await text('.self .cap-text')})`)
  await shot('self-empty-1000x800')
  await page.keyboard.type('anything')
  await settle(400)
  check(/nothing rises/.test(await text('.self .recall .kicker')), `${tag}: recall says nothing rises`)
  await done(tag)
}
{
  const { page, self, settle, done } = await open(grown, { reduced: 'reduce' })
  const tag = 'reduced motion'
  check((await self()).arrived, `${tag}: no arrival`)
  await settle(800)
  const a = await page.evaluate(() => window.__frames.n)
  await page.waitForTimeout(800)
  const b = await page.evaluate(() => window.__frames.n)
  check(b === a, `${tag}: nothing moves, so nothing is drawn (${a} → ${b})`)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)
  check((await page.evaluate(() => window.__frames.n)) > b && (await self()).section === 'What you want from agents', `${tag}: a key draws again`)
  await done(tag)
}

await browser.close()
for (const server of [grown, bare, empty]) await server.viewer.close()
console.log(results.join('\n'))
console.log(failed.length ? `\n${failed.length} FAILED` : `\nall ${results.length} passed`)
process.exit(failed.length ? 1 : 0)

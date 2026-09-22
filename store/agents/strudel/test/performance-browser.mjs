// Real upstream REPL + real AudioWorklet capture. Requires Chrome and Playwright; no mock DSP.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/performance-browser.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(
  process.env.EVIDENCE || '/private/tmp/openharness-harness-improvements-evidence/strudel-lab'
)
const workspace = join(evidence, 'workspace-' + Date.now())
mkdirSync(workspace, { recursive: true })
const code = `setcpm(120 / 4)
stack(
  // Low — left channel, A3
  note("a3*4").s("sine").attack(.004).decay(0).sustain(1).release(.005).clip(.95).gain(.35).pan(0),
  // High — right channel, A4
  note("a4*4").s("sine").attack(.004).decay(0).sustain(1).release(.005).clip(.95).gain(.35).pan(1)
)`
writeFileSync(join(workspace, 'track.strudel'), code)
const port = await new Promise((resolve, reject) => {
  const s = createServer()
    .listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
    .on('error', reject)
})
let server, browser, page
let logs = '',
  errors = [],
  checks = []
async function startServer() {
  logs = ''
  server = spawn(process.execPath, [join(pkg, 'viewer.mjs')], {
    env: { ...process.env, HARNESS_WORKSPACE: workspace, HARNESS_VIEWER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  server.stdout.on('data', (d) => {
    logs += d
  })
  server.stderr.on('data', (d) => {
    logs += d
  })
  for (let i = 0; i < 150 && !logs.includes('listening on'); i++) await new Promise((r) => setTimeout(r, 30))
  assert.match(logs, /listening on/)
}
async function stopServer() {
  if (!server || server.exitCode !== null) return
  const stopped = new Promise((r) => server.once('exit', r))
  server.kill()
  await stopped
}
async function setCode(text) {
  await page.evaluate((text) => {
    const view = window.__strudelPane.ed.editor
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    view.focus()
  }, text)
  await page.keyboard.press('Control+Enter')
}
try {
  await startServer()
  browser = await chromium.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--mute-audio']
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
  // Offline synth path: answer only remote sample-map requests with an empty map. All engine code
  // and actual audio processing come from the installed, unmodified @strudel/repl package.
  await context.route(/^https?:\/\//, (route) =>
    route.request().url().startsWith(`http://127.0.0.1:${port}/`)
      ? route.continue()
      : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  )
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForFunction(() => window.__strudelPane?.ready)
  await page.locator('#play').click()
  await page.waitForFunction(() => window.__strudelPane.started && window.__strudelPane.tap)
  await page.locator('#record').click()
  await page.waitForFunction(() => document.querySelector('#record').classList.contains('recording'))
  await page.waitForTimeout(2500)
  await page.locator('.voice').nth(0).locator('.m').click()
  await page.locator('#marker-note').fill('Only the high voice')
  await page.locator('#add-marker').click()
  await page.waitForTimeout(2500)
  const revised = code.replace('"a3*4"', '"c4*4"').replace('"a4*4"', '"e5*4"')
  await setCode(revised)
  await page.waitForFunction((value) => window.__strudelPane.ed.repl.state.activeCode === value, revised)
  await page.locator('#clearmix').click()
  await page.locator('#marker-note').fill('New harmony, both voices')
  await page.locator('#add-marker').click()
  await page.waitForTimeout(2600)
  writeFileSync(join(workspace, 'track.strudel'), code + '\n// agent update waits for the performer\n')
  await page.locator('#pending').waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => window.__strudelPane.ed.code), revised)
  await page.screenshot({ path: join(evidence, 'recording.png') })
  await page.locator('#record').click()
  await page.locator('#take-draft').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('#take-wave').width > 0)
  await page.locator('#take-name').fill('Two voices, one live turn')
  await page.locator('#keep-take').click()
  await page.waitForFunction(() => document.querySelector('#take-message').textContent.startsWith('Kept “'))
  const takes = await (await page.request.get(`http://127.0.0.1:${port}/_takes`)).json()
  const saved = takes.find((t) => t.title === 'Two voices, one live turn')
  assert.ok(saved)
  const base = join(workspace, 'out', 'takes', saved.id),
    manifest = JSON.parse(readFileSync(join(base, 'take.json')))
  assert.equal(manifest.sources.length, 2)
  assert.equal(manifest.sources[0].code, code)
  assert.equal(manifest.sources[1].code, revised)
  assert.equal(manifest.events.filter((e) => e.type === 'marker').length, 2)
  assert.ok(manifest.audio.duration > 7)
  assert.ok(manifest.audio.peak > 0.02)
  checks.push({
    name: 'actual stereo performance, live mix, code swap, markers and deferred agent save',
    duration: manifest.audio.duration,
    peak: manifest.audio.peak,
    id: saved.id
  })
  await page.screenshot({ path: join(evidence, 'kept.png') })
  await page.locator('#take-audio').evaluate((audio) => audio.play())
  await page.waitForFunction(
    () => !window.__strudelPane.started && !document.querySelector('#take-audio').paused
  )
  await page.waitForFunction(() => document.querySelector('#take-audio').currentTime > 0.3)
  await page.locator('#take-audio').evaluate((audio) => {
    audio.currentTime = 5
  })
  await page.waitForFunction(() => document.querySelector('#take-audio').currentTime >= 5)
  await page.locator('#take-audio').evaluate((audio) => audio.pause())
  checks.push({ name: 'native WAV playback and seeking stop the live instrument' })
  await page.locator('#apply-pending').click()
  await page.waitForFunction(() => window.__strudelPane.ed.code.includes('agent update waits'))
  await stopServer()
  await startServer()
  await page.reload()
  await page.waitForFunction(() => window.__strudelPane?.ready)
  await page.locator('#open-takes').click()
  await page.getByRole('button', { name: 'Open take' }).first().click()
  await page.locator('#take-draft').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#take-name').inputValue(), 'Two voices, one live turn')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(evidence, 'mobile.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  checks.push({ name: 'saved take survives source replacement and server restart; 390px layout fits' })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.locator('#discard-take').click()
  await page.locator('#play').click()
  await page.waitForFunction(() => window.__strudelPane.started)
  await page.locator('#record').click()
  await page.waitForTimeout(1100)
  await setCode('stack( this is deliberately invalid syntax')
  await page.waitForFunction(() => !!window.__strudelPane.error)
  await page.waitForTimeout(450)
  await page.locator('#play').click()
  await page.locator('#take-draft').waitFor({ state: 'visible' })
  assert.equal(
    await page
      .locator('#draft-details')
      .textContent()
      .then((t) => t.includes('1 code version')),
    true
  )
  await page.locator('#take-name').fill('Recovered after a save failure')
  await page.route('**/_takes', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fetch() // Save succeeds, but its acknowledgement is deliberately lost.
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Test acknowledgement lost' })
    })
  })
  await page.locator('#keep-take').click()
  await page.waitForFunction(() =>
    document.querySelector('#take-message').textContent.includes('Your recording is still here')
  )
  assert.ok(
    await page
      .locator('#download-draft')
      .getAttribute('href')
      .then((s) => s.startsWith('blob:'))
  )
  assert.equal(await page.locator('#record').isDisabled(), true)
  await page.unroute('**/_takes')
  await stopServer()
  await startServer() // The unsaved browser buffer must also survive token rotation.
  await page.locator('#keep-take').click()
  await page.waitForFunction(() => document.querySelector('#take-message').textContent.startsWith('Kept “'))
  const recoveryTakes = (await (await page.request.get(`http://127.0.0.1:${port}/_takes`)).json()).filter(
    (t) => t.title === 'Recovered after a save failure'
  )
  assert.equal(recoveryTakes.length, 1, 'retry after a lost acknowledgement must not duplicate the take')
  const recovery = recoveryTakes[0]
  const recovered = JSON.parse(readFileSync(join(workspace, 'out', 'takes', recovery.id, 'take.json')))
  assert.equal(recovered.reason, 'transport stopped')
  assert.equal(recovered.sources.length, 1)
  assert.equal(recovered.sources[0].code.includes('deliberately invalid'), false)
  assert.ok(recovered.audio.peak > 0.02)
  checks.push({
    name: 'failed evaluation keeps prior sound; stop ends capture; lost save acknowledgement and server restart retry without duplication'
  })
  await page.locator('#discard-take').click()
  await page.locator('#revert').click()
  await page.locator('#play').click()
  await page.waitForFunction(() => window.__strudelPane.started && !window.__strudelPane.error)
  await page.locator('#record').click()
  await page.waitForTimeout(1300)
  await page.evaluate(() => window.getAudioContext().suspend())
  await page.locator('#take-draft').waitFor({ state: 'visible' })
  await page.waitForFunction(() =>
    document.querySelector('#take-message').textContent.includes('audio suspended')
  )
  await page.evaluate(() => window.getAudioContext().resume())
  assert.equal(await page.locator('#record').isDisabled(), true)
  await page.locator('#discard-take').click()
  checks.push({ name: 'suspended audio ends capture without hanging and retains received samples' })
  // A fresh unsaved editor change remains protected even outside recording.
  await page.evaluate(() => {
    const view = window.__strudelPane.ed.editor
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n// my unfinished edit' } })
  })
  await page.waitForFunction(() => window.__strudelPane.dirty)
  writeFileSync(join(workspace, 'track.strudel'), code + '\n// another agent revision')
  await page.locator('#pending').waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => window.__strudelPane.ed.code.includes('my unfinished edit')), true)
  await page.locator('#apply-pending').click()
  await page.waitForFunction(() => window.__strudelPane.ed.code.includes('another agent revision'))
  checks.push({ name: 'unsaved pane edits defer incoming source until explicitly loaded' })
  if (process.env.LONG_CAPTURE === '1') {
    await page.locator('#record').click()
    await page.locator('#take-draft').waitFor({ state: 'visible', timeout: 135_000 })
    await page.waitForFunction(() => document.querySelector('#take-message').textContent.includes('limit'))
    await page.locator('#take-name').fill('Full length capture')
    await page.locator('#keep-take').click()
    await page.waitForFunction(
      () => document.querySelector('#take-message').textContent.startsWith('Kept “'),
      { timeout: 30_000 }
    )
    const maximum = (await (await page.request.get(`http://127.0.0.1:${port}/_takes`)).json()).find(
      (take) => take.title === 'Full length capture'
    )
    const data = JSON.parse(readFileSync(join(workspace, 'out', 'takes', maximum.id, 'take.json')))
    assert.equal(data.reason, 'limit')
    assert.equal(data.audio.frames, Math.min(6_000_000, data.audio.sampleRate * 120))
    assert.equal(
      readFileSync(join(workspace, 'out', 'takes', maximum.id, 'performance.wav')).length,
      data.audio.frames * 8 + 56
    )
    checks.push({
      name: 'full duration capture ends at exact frame limit and saves the complete WAV',
      duration: data.audio.duration,
      frames: data.audio.frames,
      id: maximum.id
    })
  }
  assert.deepEqual(errors, [])
  writeFileSync(join(evidence, 'results.json'), JSON.stringify({ checks, errors, saved: base }, null, 2))
  console.log(JSON.stringify({ checks, errors, saved: base }, null, 2))
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
    console.error(
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    )
  }
  console.error(logs, errors)
  throw error
} finally {
  if (browser) await browser.close()
  await stopServer()
}

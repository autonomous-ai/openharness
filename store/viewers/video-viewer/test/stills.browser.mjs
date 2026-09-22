// Real native Manim videos + Chrome. Only disposable workspaces and local tools.
// MANIM_PYTHON=/path/to/python PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/stills.browser.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startViewer } from './media.mjs'

if (!process.env.MANIM_PYTHON) throw Error('Set MANIM_PYTHON to an installed native Manim interpreter')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const output = resolve(process.env.EVIDENCE || join(tmpdir(), 'video-still-evidence'))
mkdirSync(output, { recursive: true })
const workspace = mkdtempSync(join(output, 'workspace-'))
mkdirSync(join(workspace, 'scenes'))
copyFileSync(fileURLToPath(new URL('./fixtures/capture_frames.py', import.meta.url)), join(workspace, 'scenes/capture_frames.py'))
const wrapper = fileURLToPath(new URL('../../../agents/manim/toolchain/render.py', import.meta.url))
for (const scene of ['Alpha', 'Beta']) {
  const log = execFileSync(process.env.MANIM_PYTHON, [wrapper, '-ql', 'scenes/capture_frames.py', scene], {
    cwd: workspace, env: { ...process.env, PYTHONPYCACHEPREFIX: join(output, 'pycache') }, timeout: 60000, stdio: 'pipe', maxBuffer: 4000000
  })
  writeFileSync(join(output, `render-${scene}.txt`), log)
}
const viewer = await startViewer(workspace)
let browser
const checks = [], errors = []
const check = (name, passed) => { checks.push({ name, passed }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`) }
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 920 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${viewer.port}/?file=out/videos/capture_frames/480p15/Alpha.mp4`)
  const ready = async (scene) => page.waitForFunction(name => { const video = document.querySelector('#video'); return video.currentSrc.includes(`/${name}.mp4`) && video.readyState >= 2 && !video.seeking }, scene)
  const choose = async (scene) => {
    await page.locator('#renders [role=button]').filter({ has: page.locator('.name', { hasText: scene }) }).click()
    await ready(scene)
    if (await page.locator('#b-play').getAttribute('data-icon') === 'pause') await page.locator('#b-play').click()
    await page.keyboard.press('Home'); await ready(scene)
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
    await ready(scene)
  }
  await ready('Alpha'); await choose('Alpha')
  const alpha = await page.evaluate(() => { const video = document.querySelector('#video'), canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight; canvas.getContext('2d').drawImage(video, 0, 0); return { png: canvas.toDataURL('image/png').split(',')[1], frame: Math.floor(video.currentTime * 15 + .001) } })
  await page.evaluate(() => {
    window.captureCallbacks = []
    window.originalToBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function(callback, ...args) { const canvas = this; captureCallbacks.push(() => originalToBlob.call(canvas, callback, ...args)) }
  })
  const saved = page.waitForResponse(response => response.url().includes('/api/still') && response.request().method() === 'POST')
  await page.keyboard.press('s')
  await page.waitForFunction(() => captureCallbacks.length === 1)
  await choose('Beta')
  await page.evaluate(() => captureCallbacks.shift()())
  const response = await saved
  const packet = await response.json()
  check('PNG encoding keeps the captured scene and frame in the filename after another render opens', packet.path.includes(`Alpha-480p15-f${String(alpha.frame).padStart(4, '0')}`))
  check('The saved PNG is the exact earlier native frame', readFileSync(join(workspace, packet.path)).equals(Buffer.from(alpha.png, 'base64')))
  const beta = await page.evaluate(() => { const video = document.querySelector('#video'), canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight; canvas.getContext('2d').drawImage(video, 0, 0); return canvas.toDataURL('image/png').split(',')[1] })
  check('The two native source frames have different pixels', beta !== alpha.png)
  const save = async (png) => {
    const result = await viewer.get('/api/still?name=same-scene-f0005', { method: 'POST', headers: { 'x-video-viewer': 'still' }, body: Buffer.from(png, 'base64') })
    assert.equal(result.status, 200)
    return JSON.parse(result.body)
  }
  const first = await save(alpha.png), second = await save(beta), repeated = await save(alpha.png)
  check('Different native frames with the same requested name get different paths', first.path !== second.path)
  check('A later saved version leaves the earlier PNG unchanged', readFileSync(join(workspace, first.path)).equals(Buffer.from(alpha.png, 'base64')) && readFileSync(join(workspace, second.path)).equals(Buffer.from(beta, 'base64')))
  check('Retrying the same frame returns one existing copy', first.path === repeated.path)
  await choose('Alpha')
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async (items) => { await items[0].getType('image/png'); throw Error('delayed clipboard denial fixture') } } }))
  const fallbackSaved = page.waitForResponse(response => response.url().includes('/api/still') && response.request().method() === 'POST')
  await page.keyboard.press('c')
  await page.waitForFunction(() => captureCallbacks.length === 1)
  await choose('Beta')
  await page.evaluate(() => captureCallbacks.shift()())
  const fallback = await (await fallbackSaved).json()
  check('A delayed clipboard denial saves the original captured frame and identity', fallback.path === packet.path && readFileSync(join(workspace, fallback.path)).equals(Buffer.from(alpha.png, 'base64')))
  check('Clipboard fallback does not take a second frame from the later video', await page.evaluate(() => captureCallbacks.length === 0))
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = function(callback) { callback(null) } })
  await page.keyboard.press('s')
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('could not encode'))
  check('A failed browser PNG encoder reports failure without claiming a saved frame', (await page.locator('#toast').textContent()).includes('Could not save the frame'))
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = originalToBlob })
  await page.keyboard.press('s')
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Frame saved'))
  check('Saving still works after a recoverable encoding failure', (await page.locator('#toast').textContent()).includes('Beta-480p15'))
  await page.screenshot({ path: join(output, 'saved-frame.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  check('The longer preserved filename stays within a narrow pane', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(output, 'saved-frame-mobile.png') })
  check('No native browser exceptions', errors.length === 0)
  writeFileSync(join(output, 'results.json'), JSON.stringify({ workspace, checks, errors, alphaFrame: alpha.frame, racePacket: packet, first, second, repeated, fallback }, null, 2))
  assert.ok(checks.every(result => result.passed), 'Every native still check must pass')
} finally { await browser?.close(); await viewer.stop() }

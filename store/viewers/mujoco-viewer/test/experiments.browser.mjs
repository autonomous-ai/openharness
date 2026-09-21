// Real WASM, viewer server, controls and downloads. No installed sessions or projects are touched.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node test/experiments.browser.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { startViewer } from './helpers.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const output = resolve(process.env.EXPERIMENT_OUTPUT || 'test-results/experiments')
mkdirSync(output, { recursive: true })
const workspace = mkdtempSync(join(tmpdir(), 'mujoco-experiments-'))
mkdirSync(join(workspace, 'scenes'))
const xml = `<mujoco model="Pendulum laboratory"><option timestep=".002" gravity="0 0 -9.81"/>
<visual><global azimuth="130" elevation="-18"/><headlight ambient=".4 .4 .4" diffuse=".7 .7 .7"/></visual>
<asset><texture name="grid" type="2d" builtin="checker" width="128" height="128" rgb1=".1 .15 .2" rgb2=".14 .2 .26"/><material name="ground" texture="grid" texrepeat="4 4"/></asset>
<worldbody><light pos="0 -2 4"/><geom type="plane" size="3 3 .1" material="ground"/>
<geom type="cylinder" size=".04 1" pos="0 .15 1" rgba=".3 .4 .5 1" contype="0" conaffinity="0"/>
<body name="Pendulum" pos="0 0 2"><joint name="swing" type="hinge" axis="0 1 0" damping=".02"/>
<geom type="capsule" fromto="0 0 0 0 0 -1" size=".035" rgba=".5 .6 .7 1" mass=".1"/>
<geom type="sphere" pos="0 0 -1" size=".13" mass="1" rgba=".95 .5 .16 1"/></body></worldbody>
<keyframe><key name="Release" qpos="1.1"/></keyframe></mujoco>`
writeFileSync(join(workspace, 'scenes/pendulum.xml'), xml)
writeFileSync(join(output, 'pendulum.xml'), xml)
let viewer, browser
try {
  viewer = await startViewer({ env: { HARNESS_WORKSPACE: workspace } })
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined), headless: true, args: ['--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${viewer.port}/`)
  await page.waitForFunction(() => window.__mujocoViewer?.engine?.info?.modelName === 'Pendulum laboratory')
  await page.locator('#btn-play').click()
  await page.locator('#btn-reset').click()
  const before = await page.evaluate(() => ({ time: __mujocoViewer.engine.data.time, qpos: [...__mujocoViewer.engine.data.qpos], gravity: [...__mujocoViewer.engine.model.opt.gravity] }))
  await page.getByRole('button', { name: 'What if…', exact: true }).click()
  await page.getByRole('button', { name: 'Lunar gravity', exact: true }).click()
  await page.waitForFunction(() => __mujocoViewer.experiments.previewing, { timeout: 30_000 })
  const measured = await page.evaluate(() => ({ result: __mujocoViewer.experiments.result, time: __mujocoViewer.engine.data.time, qpos: [...__mujocoViewer.engine.data.qpos], gravity: [...__mujocoViewer.engine.model.opt.gravity] }))
  assert.deepEqual({ time: measured.time, qpos: measured.qpos, gravity: measured.gravity }, before, 'comparison leaves live state and model untouched')
  assert.ok(measured.result.metrics.maxSeparation > .1, 'gravity materially changes the actual pendulum motion')
  assert.equal(measured.result.change.gravityScale, .165)
  await page.locator('#experiment-scrub').focus()
  await page.keyboard.press('End')
  await page.waitForFunction(() => !__mujocoViewer.experiments.playing)
  await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0)
  await page.screenshot({ path: join(output, 'comparison-desktop.png') })
  await page.getByRole('button', { name: 'Replay comparison', exact: true }).click()
  await page.waitForFunction(() => __mujocoViewer.experiments.cursor > 0 && __mujocoViewer.experiments.cursor < 30)
  for (const [button, file] of [['Save experiment', 'physics-experiment.json'], ['Measurements CSV', 'physics-measurements.csv']]) {
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: button, exact: true }).click()
    await (await download).saveAs(join(output, file))
  }
  const saved = JSON.parse(readFileSync(join(output, 'physics-experiment.json'), 'utf8'))
  assert.deepEqual(saved.startingState, measured.result.startingState)
  assert.equal(saved.variant.frames.length, saved.baseline.frames.length)
  assert.equal(readFileSync(join(output, 'physics-measurements.csv'), 'utf8').trim().split('\n').length, saved.baseline.frames.length + 1)
  // An agent save waits while the user explores a result, then opens when they return.
  writeFileSync(join(workspace, 'scenes/pendulum.xml'), xml.replace('Pendulum laboratory', 'Revised pendulum'))
  await page.waitForTimeout(600)
  assert.equal(await page.evaluate(() => __mujocoViewer.engine.info.modelName), 'Pendulum laboratory')
  await page.getByRole('button', { name: 'Return to simulation', exact: true }).click()
  await page.waitForFunction(() => __mujocoViewer.engine.info.modelName === 'Revised pendulum')
  assert.equal(await page.evaluate(() => Boolean(__mujocoViewer.stage.comparison)), false)
  await page.locator('#btn-reset').click()
  await page.locator('#experiment-capture').click()
  await page.getByRole('button', { name: 'A sideways shove', exact: true }).click()
  await page.waitForFunction(() => __mujocoViewer.experiments.previewing)
  assert.equal(await page.evaluate(() => __mujocoViewer.experiments.result.change.pushNewtons), 20)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at 390px')
  await page.locator('#tab-experiment').evaluate((el) => el.scrollTop = 0)
  await page.screenshot({ path: join(output, 'comparison-mobile.png') })
  const panel = await page.locator('#panel').boundingBox()
  assert.ok(panel.y > 300 && panel.width <= 390, 'narrow comparison keeps the scene above a bottom panel')
  await page.getByRole('button', { name: 'Return to simulation', exact: true }).click()
  // A small timestep creates a real, cancellable run instead of racing a near-instant toy model.
  writeFileSync(join(workspace, 'scenes/pendulum.xml'), xml.replace('Pendulum laboratory', 'Cancellation fixture').replace('timestep=".002"', 'timestep=".0001"'))
  await page.waitForFunction(() => __mujocoViewer.engine.info.modelName === 'Cancellation fixture')
  await page.locator('#experiment-capture').click()
  await page.locator('#experiment-duration').selectOption('10')
  await page.locator('#experiment-run').click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForFunction(() => !__mujocoViewer.experiments.active)
  assert.equal(await page.evaluate(() => __mujocoViewer.engine.model.opt.gravity[2]), -9.81)
  assert.deepEqual(errors, [])
  writeFileSync(join(output, 'browser-results.json'), JSON.stringify({ passed: true, checks: ['real WASM comparison', 'unchanged live state', 'measured divergent physics', 'timeline and replay', 'JSON and CSV downloads', 'agent edit deferred and applied', '390px bottom panel', 'cancellation', 'no browser exceptions'], browser: await browser.version() }, null, 2))
  console.log(`MuJoCo experiment browser checks passed. Evidence: ${output}`)
} finally {
  await browser?.close()
  await viewer?.stop()
  rmSync(workspace, { recursive: true, force: true })
}

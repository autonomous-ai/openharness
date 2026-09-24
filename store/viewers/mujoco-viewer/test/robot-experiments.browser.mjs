// Optional integration: an actual recorded, servo-patched Menagerie robot and bundled native replay.
// Requires EXPERIMENT_WORKSPACE, EXPERIMENT_MENAGERIE and MUJOCO_PYTHON. The workspace is read-only.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { startViewer } from './helpers.mjs'

for (const key of ['EXPERIMENT_WORKSPACE', 'EXPERIMENT_MENAGERIE', 'MUJOCO_PYTHON']) {
  if (!process.env[key]) throw new Error(`Set ${key} for this opt-in robot check`)
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const output = resolve(process.env.EXPERIMENT_OUTPUT || 'test-results/robot-experiments')
mkdirSync(output, { recursive: true })
const viewer = await startViewer({ env: { HARNESS_WORKSPACE: resolve(process.env.EXPERIMENT_WORKSPACE), MENAGERIE: resolve(process.env.EXPERIMENT_MENAGERIE) } })
let browser
try {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined), headless: true, args: ['--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1380, height: 920 }, acceptDownloads: true })
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${viewer.port}/?file=out/rollout.qpos.json`)
  await page.waitForFunction(() => window.__mujocoViewer?.state?.traj?.ctrl && window.__mujocoViewer.engine?.info, null, { timeout: 60_000 })
  await page.locator('#btn-play').click()
  await page.locator('#btn-reset').click()
  const hip = page.getByRole('slider', { name: 'Control FL_hip', exact: true })
  const controlBefore = Number(await hip.inputValue())
  const timeBefore = await page.evaluate(() => __mujocoViewer.engine.data.time)
  await hip.press('ArrowRight')
  assert.ok(Number(await hip.inputValue()) > controlBefore, 'arrow keys adjust the focused actuator')
  assert.equal(await page.evaluate(() => __mujocoViewer.engine.data.time), timeBefore, 'adjusting a control does not step the simulation')
  await hip.press('Tab')
  assert.equal(await page.locator('#panel').isVisible(), true, 'Tab moves focus without closing the controls')
  await page.locator('#btn-reset').click()
  await page.locator('#btn-experiment').press('Space')
  await page.locator('#experiment-duration').selectOption('1')
  await page.locator('[data-experiment=push]').click()
  await page.waitForFunction(() => __mujocoViewer.experiments.previewing, null, { timeout: 60_000 })
  const facts = await page.evaluate(() => {
    const r = __mujocoViewer.experiments.result
    return { control: r.controls.kind, assets: r.source.files.length, modelXml: r.source.modelXml,
      frames: r.baseline.frames.length, maxSeparation: r.metrics.maxSeparation, nq: __mujocoViewer.engine.model.nq }
  })
  assert.equal(facts.control, 'recorded-open-loop')
  assert.ok(facts.nq > 10 && facts.assets > 10 && facts.modelXml, 'real robot assets and compiled servo model are bundled')
  assert.ok(facts.maxSeparation > .001, 'the physical shove changes the robot outcome')
  const file = join(output, 'robot-experiment.json')
  const download = page.waitForEvent('download')
  await page.locator('#experiment-json').click()
  await (await download).saveAs(file)
  const report = join(output, 'robot-native-reproduction.json')
  const helper = new URL('../../../agents/mujoco/toolchain/experiments.py', import.meta.url)
  execFileSync(process.env.MUJOCO_PYTHON, [helper.pathname, file, '--output', report], { timeout: 60_000, stdio: 'pipe' })
  const reproduced = JSON.parse(readFileSync(report, 'utf8'))
  assert.equal(reproduced.matches, true, 'the exported snapshot and assets reproduce with native MuJoCo, without the original workspace')
  await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0)
  await page.locator('#experiment-frame').click()
  await page.locator('#experiment-scrub').focus(); await page.keyboard.press('Home'); await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp')
  await page.screenshot({ path: join(output, 'robot-comparison.png') })
  await page.locator('#experiment-return').click()
  await page.locator('[data-mode=replay]').click()
  await page.locator('#scrub').focus(); await page.keyboard.press('PageUp')
  await page.locator('#experiment-capture').click()
  const pinned = await page.evaluate(() => __mujocoViewer.experiments.snapshot.time)
  assert.ok(pinned > 0, 'an arbitrary recorded moment can become a new experiment')
  await page.locator('[data-experiment=moon]').click()
  await page.waitForFunction(() => __mujocoViewer.experiments.previewing)
  assert.equal(await page.evaluate(() => __mujocoViewer.experiments.result.startingState.time), pinned)
  assert.equal(await page.locator('#experiment-capture').isDisabled(), true, 'comparison playback cannot be mistaken for a new live-state capture')
  assert.deepEqual(errors, [])
  writeFileSync(join(output, 'robot-results.json'), JSON.stringify({ passed: true, ...facts,
    baselineMaxError: reproduced.baseline.maxQposError, variantMaxError: reproduced.variant.maxQposError }, null, 2))
  console.log(`Real robot browser + native reproduction passed. Evidence: ${output}`)
} finally { await browser?.close(); await viewer.stop() }

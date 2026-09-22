// Native Blender + real browser check. npm test covers orchestration without Blender.
// BLENDER_PYTHON=/path/to/venv/bin/python PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
// CHROME_PATH=/path/to/chrome SHAPE_LAB_EVIDENCE=/optional/output node test/shape-lab-browser.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { packageDir, scratch, startViewer } from './helpers.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const python = process.env.BLENDER_PYTHON
assert.ok(python, 'Set BLENDER_PYTHON to a Python with bpy installed')
const blender = resolve(packageDir, '../../agents/blender'),
  toolchain = join(blender, 'toolchain')
const evidence = process.env.SHAPE_LAB_EVIDENCE && resolve(process.env.SHAPE_LAB_EVIDENCE)
if (evidence) mkdirSync(evidence, { recursive: true })
const ws = scratch('shape-lab-native-'),
  separate = scratch('shape-lab-rebuild-'),
  lamp = scratch('shape-lab-lamp-')
cpSync(join(blender, 'template'), ws.dir, { recursive: true })
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const env = (workspace) => ({
  ...process.env,
  HARNESS_WORKSPACE: workspace,
  HARNESS_DESIGN_PREVIEW: '1',
  PYTHONPATH: toolchain,
})
const build = (workspace, entry = 'scenes/hello.py') =>
  execFileSync(python, [entry], {
    cwd: workspace,
    env: env(workspace),
    encoding: 'utf8',
    timeout: 60000,
    stdio: 'pipe',
  })
const checks = [],
  errors = []
let viewer, lampViewer, browser, page
try {
  build(ws.dir)
  const original = hash(join(ws.dir, 'out/model.glb'))
  const originalReport = hash(join(ws.dir, 'out/report.json'))
  viewer = await startViewer({
    workspace: ws.dir,
    env: { BLENDER_PYTHON: python, BLENDER_TOOLCHAIN: toolchain },
  })
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  })
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text())
  })
  await page.goto(viewer.base)
  await page.waitForFunction(() => window.__viewer?.app.current)
  const state = async () => (await (await fetch(viewer.base + '/api/state')).json()).design
  const post = async (action, body) => {
    const token = await page.locator('meta[name=design-token]').getAttribute('content')
    const response = await fetch(viewer.base + '/api/design/' + action, {
      method: 'POST',
      headers: { 'x-design-token': token },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  const ready = () =>
    page.waitForFunction(
      () => window.__viewer.app.current?.design && !document.querySelector('#design-keep').disabled,
      null,
      { timeout: 30000 },
    )
  const range = async (id, value) => {
    await page.locator('#design-param-' + id).fill(String(value))
    await page.locator('#design-param-' + id).dispatchEvent('input')
  }
  const screenshot = async (name) => {
    if (evidence) {
      await page.waitForFunction(() => document.querySelector('#toast').hidden)
      await page.screenshot({ path: join(evidence, name + '.png') })
    }
  }
  await page.locator('#design-open').click()
  await ready()
  await page.locator('#design-auto').uncheck()
  await range('height', 145)
  await range('diameter', 75)
  await page.locator('#design-param-handle').uncheck()
  await page.locator('#design-param-glaze').selectOption('Sea green')
  await page.locator('#design-build').click()
  await ready()
  assert.deepEqual(await page.evaluate(() => window.__viewer.app.report.size_mm), [75, 75, 145])
  assert.deepEqual(await page.evaluate(() => window.__viewer.app.report.objects), ['Mug'])
  assert.doesNotMatch(await page.locator('#status').innerText(), /NaN/)
  await page.locator('#design-name').fill('Sea glass tumbler')
  await page.locator('#design-keep').press('Space')
  await page.locator('.design-variant').waitFor()
  let kept = (await state()).variants[0]
  assert.equal(hash(join(ws.dir, 'out/model.glb')), original)
  assert.equal(hash(join(ws.dir, 'out/report.json')), originalReport)
  const glb = readFileSync(join(ws.dir, kept.path, 'source/out/model.glb'))
  const gltf = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)))
  assert.equal(gltf.meshes.length, 1)
  const baseColor = gltf.materials[0].pbrMetallicRoughness.baseColorFactor
  assert.ok(Math.abs(baseColor[0] - 0.13) < 1e-6 && Math.abs(baseColor[1] - 0.42) < 1e-6)
  checks.push('native geometry and material follow controls; original exports unchanged')

  // Independent ZIP parser and an independent cwd/PYTHONPATH: the downloaded source must stand alone.
  const zip = await (await fetch(viewer.base + '/ws/' + kept.path + '/project.zip')).arrayBuffer()
  writeFileSync(join(separate.dir, 'download.zip'), Buffer.from(zip))
  execFileSync(python, [
    '-c',
    'import sys, zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])',
    join(separate.dir, 'download.zip'),
    join(separate.dir, 'unpacked'),
  ])
  const cleanEnv = { ...process.env, PYTHONPATH: '' }
  delete cleanEnv.HARNESS_WORKSPACE
  execFileSync(python, ['rebuild.py', '--preview'], {
    cwd: join(separate.dir, 'unpacked'),
    env: cleanEnv,
    timeout: 60000,
    stdio: 'pipe',
  })
  const rebuilt = JSON.parse(readFileSync(join(separate.dir, 'unpacked/source/out/report.json')))
  for (const key of ['objects', 'size_mm', 'vertices', 'faces', 'materials'])
    assert.deepEqual(rebuilt[key], kept.report[key], key)
  checks.push('downloaded ZIP independently verifies and rebuilds matching native geometry')

  await page.locator('#design-use').click()
  await page.waitForFunction(() => window.__viewer.app.state.design.design.values.height === 145)
  assert.equal(JSON.parse(readFileSync(join(ws.dir, 'design-values.json'))).values.height, 145)
  assert.equal(hash(join(ws.dir, 'out/model.glb')), original)
  await page.locator('#design-build').click()
  await ready()
  await range('height', 80)
  await range('diameter', 110)
  await page.locator('#design-param-handle').check()
  await page.locator('#design-param-glaze').selectOption('Honey')
  await page.locator('#design-build').click()
  await ready()
  assert.equal((await page.evaluate(() => window.__viewer.app.report.size_mm))[2], 80)
  await page.locator('#design-name').fill('Breakfast cup')
  await page.locator('#design-keep').click()
  await page.waitForFunction(() => document.querySelectorAll('.design-variant').length === 2)
  await page.locator('.design-variant-open').filter({ hasText: 'Sea glass tumbler' }).click()
  await page.waitForFunction(() => window.__viewer.app.report.size_mm[2] === 145)
  assert.equal(await page.locator('#design-param-height').inputValue(), '145')
  await page.locator('.design-variant').first().scrollIntoViewIfNeeded()
  await screenshot('directions-desktop')
  checks.push('two named directions reopen with their own controls; explicit use persists values')

  // A new agent export must wait while the user is exploring a saved direction.
  writeFileSync(
    join(ws.dir, 'design-values.json'),
    JSON.stringify({ spec: 1, values: { height: 120, diameter: 95 } }),
  )
  build(ws.dir)
  await page.waitForFunction(() => window.__viewer.app.state.design.design.values.height === 120)
  assert.equal(await page.evaluate(() => window.__viewer.app.report.size_mm[2]), 145)
  await page.locator('#design-close').click()
  await page.waitForFunction(
    () => !window.__viewer.app.current.design && window.__viewer.app.report.size_mm[2] === 120,
  )
  checks.push('agent export waits during exploration and appears when Shape Lab closes')

  // Old snapshots remain usable after a server restart, without their ephemeral worker folders.
  await page.goto('about:blank')
  await viewer.stop()
  viewer = await startViewer({
    workspace: ws.dir,
    env: { BLENDER_PYTHON: python, BLENDER_TOOLCHAIN: toolchain },
  })
  await page.goto(viewer.base)
  await page.waitForFunction(() => window.__viewer?.app.current)
  await page.locator('#design-open').click()
  await page.locator('.design-variant-open').filter({ hasText: 'Sea glass tumbler' }).click()
  await page.waitForFunction(() => window.__viewer.app.current.path === 'Saved designs/Sea glass tumbler')
  assert.equal(await page.evaluate(() => window.__viewer.app.report.size_mm[2]), 145)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('#design-controls').scrollIntoViewIfNeeded()
  await screenshot('directions-mobile')
  assert.ok(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.querySelector('.design-scroll').scrollWidth <=
          document.querySelector('.design-scroll').clientWidth + 1,
    ),
  )
  checks.push('saved direction survives restart and controls fit a 390px pane')

  // Changed source cannot silently adopt old values. Failure keeps the displayed good model.
  const entry = join(ws.dir, 'scenes/hello.py'),
    source = readFileSync(entry, 'utf8')
  writeFileSync(entry, source + '\nraise RuntimeError("Deliberate failed revision")\n')
  await page.waitForFunction(() => !document.querySelector('#design-source-change').hidden)
  const current = await state()
  await page.waitForFunction(
    (revision) => window.__viewer.app.state.design.design.revision === revision,
    current.design.revision,
  )
  const rejected = await post('use-values', { id: kept.id, revision: current.design.revision })
  assert.equal(rejected.status, 400)
  assert.match(rejected.body.error, /source changed/i)
  await page.locator('#design-reload').click()
  await page.waitForFunction(() =>
    document.querySelector('#design-message').textContent.includes('Deliberate failed revision'),
  )
  assert.equal(await page.evaluate(() => window.__viewer.app.report.size_mm[2]), 145)
  writeFileSync(entry, source)
  checks.push('source mismatch blocks stale adoption; failed native build preserves the last good view')

  // A completely different authored scene and external JSON asset use the same viewer protocol.
  lamp.put('scenes/lamp.py', readFileSync(join(packageDir, 'test/fixtures/lamp.py')))
  lamp.put('assets/finishes.json', readFileSync(join(packageDir, 'test/fixtures/finishes.json')))
  build(lamp.dir, 'scenes/lamp.py')
  lampViewer = await startViewer({
    workspace: lamp.dir,
    env: { BLENDER_PYTHON: python, BLENDER_TOOLCHAIN: toolchain },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(lampViewer.base)
  await page.waitForFunction(() => window.__viewer?.app.current)
  await page.locator('#design-open').click()
  await ready()
  await page.locator('#design-auto').uncheck()
  await range('ribs', 32)
  await range('twist', -55)
  await range('height', 320)
  await page.locator('#design-param-finish').selectOption('Terracotta')
  await page.locator('#design-build').click()
  await ready()
  assert.equal(await page.locator('#design-title').innerText(), 'Light, shaped by you')
  const lampReport = await page.evaluate(() => window.__viewer.app.report)
  assert.equal(lampReport.objects.length, 33)
  assert.ok(lampReport.size_mm[2] > 327 && lampReport.size_mm[2] < 330)
  assert.deepEqual(lampReport.materials, ['Terracotta'])
  await page.locator('#design-name').fill('Terracotta twist')
  await page.locator('#design-keep').click()
  await page.locator('.design-variant').waitFor()
  await screenshot('lamp-desktop')
  checks.push('independently authored ribbon lamp, integer geometry, twist and declared asset build natively')
  const renderer = await page.evaluate(() => {
    const gl = document.querySelector('#gl').getContext('webgl2')
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
  })
  const results = { checks, errors, renderer, savedReport: kept.report, lampReport }
  if (evidence) writeFileSync(join(evidence, 'results.json'), JSON.stringify(results, null, 2))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify(results, null, 2))
} catch (error) {
  if (evidence && page) {
    await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
    const details = await page
      .evaluate(() => ({
        state: window.__viewer?.app.state?.design,
        message: document.querySelector('#design-message')?.textContent,
        toast: document.querySelector('#toast')?.textContent,
      }))
      .catch(() => null)
    writeFileSync(
      join(evidence, 'failure.json'),
      JSON.stringify({ error: error.stack, details, checks, errors }, null, 2),
    )
  }
  throw error
} finally {
  await browser?.close()
  await viewer?.stop()
  await lampViewer?.stop()
  ws.done()
  separate.done()
  lamp.done()
}

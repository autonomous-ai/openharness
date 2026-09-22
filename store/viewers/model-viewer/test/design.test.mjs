// Process orchestration uses a small Node worker; native Blender geometry is exercised separately
// by shape-lab-browser.mjs. These tests need only the viewer's Node runtime.
import assert from 'node:assert/strict'
import { readFileSync, symlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDesignController, validateDefinition, validateValues } from '../design.mjs'
import { raw, scratch, sleep, startViewer } from './helpers.mjs'

const definition = () => ({
  spec: 1,
  kind: 'blender-parameters',
  title: 'An authored object',
  entry: 'scenes/build.py',
  sources: ['scenes', 'assets'],
  output: 'out/model.glb',
  controls: [
    {
      id: 'width',
      type: 'number',
      label: 'Width',
      description: '',
      unit: 'mm',
      default: 70,
      min: 20,
      max: 200,
      step: 1,
    },
    {
      id: 'count',
      type: 'integer',
      label: 'Count',
      description: '',
      unit: '',
      default: 4,
      min: 2,
      max: 12,
      step: 1,
    },
    { id: 'cap', type: 'boolean', label: 'Cap', description: '', unit: '', default: true },
    {
      id: 'mode',
      type: 'choice',
      label: 'Mode',
      description: '',
      unit: '',
      default: 'normal',
      options: ['normal', 'slow', 'fail', 'descendant'],
    },
  ],
})
const worker = `const fs = require('node:fs');
const values = JSON.parse(fs.readFileSync('design-values.json')).values;
const asset = JSON.parse(fs.readFileSync('assets/dimensions.json'));
if (values.mode === 'descendant') {
  require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  process.exit(0);
}
setTimeout(() => {
  if (values.mode === 'fail') { console.error('Geometry construction failed'); process.exit(1); }
  fs.mkdirSync('out', { recursive: true });
  const model = Buffer.alloc(128); model.write('glTF'); model.writeUInt32LE(2, 4); model.writeUInt32LE(model.length, 8);
  fs.writeFileSync('out/model.glb', model);
  fs.writeFileSync('out/report.json', JSON.stringify({ size_mm: [values.width, asset.depth, 10], faces: values.count, blender: 'worker-fixture' }));
}, values.mode === 'slow' ? 350 : 20);
`
function fixture(t, options = {}) {
  const ws = scratch('shape-lab-controller-'),
    helpers = scratch('shape-lab-helpers-')
  ws.put('.harness/design.json', JSON.stringify(definition()))
  ws.put('scenes/build.py', worker)
  ws.put('assets/dimensions.json', '{"depth": 42}')
  ws.put('out/model.glb', 'the original model')
  for (const file of ['harness_blender.py', 'harness_design.py', 'LICENSE'])
    helpers.put(file, 'helper fixture\n')
  const controller = createDesignController({
    workspace: ws.dir,
    python: process.execPath,
    toolchain: helpers.dir,
    ...options,
  })
  t.after(async () => {
    await controller.close()
    ws.done()
    helpers.done()
  })
  const preview = (values = {}) =>
    controller.preview({ revision: controller.state().design.revision, values })
  return { ws, helpers, controller, preview }
}
async function completed(controller, id, status = 'ready') {
  for (let n = 0; n < 200; n++) {
    const state = controller.state()
    if (state.request?.id === id && !['building', 'queued'].includes(state.request.status)) {
      assert.equal(state.request.status, status, state.request.error)
      return state
    }
    await sleep(10)
  }
  assert.fail('Preview did not settle')
}

test('typed controls reject unknown, non-finite, fractional and out-of-range values', () => {
  const d = validateDefinition(definition())
  assert.deepEqual(validateValues(d, { width: 125, cap: false }), {
    width: 125,
    count: 4,
    cap: false,
    mode: 'normal',
  })
  for (const v of [
    { width: 201 },
    { width: true },
    { width: Infinity },
    { count: 3.2 },
    { cap: 1 },
    { mode: 'other' },
    { command: 'anything' },
    [],
  ])
    assert.throws(() => validateValues(d, v))
  for (const patch of [
    { entry: '../build.py' },
    { sources: ['.env', 'scenes'] },
    { output: 'out/designs/main.glb' },
    { controls: [{ ...d.controls[0], id: undefined }] },
  ])
    assert.throws(() => validateDefinition({ ...d, ...patch }))
})

test('snapshots inputs; saved source, values, model and ZIP survive controller restart', async (t) => {
  const { ws, helpers, controller, preview } = fixture(t)
  const job = preview({ width: 125, mode: 'slow' })
  ws.put('assets/dimensions.json', '{"depth": 90}')
  const ready = await completed(controller, job.id)
  assert.deepEqual(ready.last.report.size_mm, [125, 42, 10], 'build uses the snapshotted asset')
  const kept = controller.keep({ id: job.id, name: 'Åsh direction' })
  const folder = join(ws.dir, kept.path)
  assert.equal(readFileSync(join(folder, 'source/assets/dimensions.json'), 'utf8'), '{"depth": 42}')
  assert.ok(existsSync(join(folder, 'source/_harness_tools/LICENSE')))
  assert.ok(existsSync(join(folder, 'rebuild.py')))
  assert.equal(readFileSync(join(folder, 'project.zip')).readUInt32LE(), 0x04034b50)
  assert.equal(readFileSync(join(ws.dir, 'out/model.glb'), 'utf8'), 'the original model')
  assert.throws(
    () => controller.useValues({ id: kept.id, revision: controller.state().design.revision }),
    /source changed/i,
  )
  await controller.close()
  const second = createDesignController({
    workspace: ws.dir,
    python: process.execPath,
    toolchain: helpers.dir,
  })
  t.after(() => second.close())
  assert.equal(second.state().variants[0].name, 'Åsh direction')
  assert.equal(readFileSync(second.file('saved-' + kept.id, 'out/model.glb')).length, 128)
  assert.throws(() => second.file('saved-' + kept.id, '../../../outside'))
})

test('using a kept direction persists only its values, and checks the current revision', async (t) => {
  const { ws, controller, preview } = fixture(t)
  const initial = controller.state().design.revision
  const job = preview({ width: 125, cap: false })
  await completed(controller, job.id)
  const kept = controller.keep({ id: job.id, name: 'Wide open' })
  assert.throws(() => controller.useValues({ id: kept.id, revision: 'stale' }), /source changed/i)
  controller.useValues({ id: kept.id, revision: initial })
  assert.equal(controller.state().design.values.width, 125)
  assert.notEqual(controller.state().design.revision, initial)
  assert.equal(JSON.parse(readFileSync(join(ws.dir, 'design-values.json'))).values.cap, false)
  assert.equal(readFileSync(join(ws.dir, 'out/model.glb'), 'utf8'), 'the original model')
  assert.throws(() => controller.preview({ revision: initial, values: {} }), /project changed/i)
})

test('latest queued values replace the previous queue; failed and cancelled jobs preserve the last good result', async (t) => {
  const { controller, preview } = fixture(t)
  preview({ mode: 'slow', width: 60 })
  const discarded = preview({ width: 100 })
  const latest = preview({ width: 140 })
  assert.equal(controller.state().request.status, 'queued')
  assert.throws(() => controller.file(discarded.id, 'out/model.glb'), /Preview not found/)
  await completed(controller, latest.id)
  assert.equal(controller.state().last.values.width, 140)
  const failure = preview({ mode: 'fail' })
  await completed(controller, failure.id, 'error')
  assert.equal(controller.state().last.id, latest.id)
  const cancelled = preview({ mode: 'slow' })
  controller.cancel(cancelled)
  await completed(controller, cancelled.id, 'cancelled')
  assert.equal(controller.state().last.id, latest.id)
})

test('timed-out workers stop and expose a useful failure', async (t) => {
  const { controller, preview } = fixture(t, { timeout: 50 })
  const job = preview({ mode: 'slow' })
  const state = await completed(controller, job.id, 'cancelled')
  assert.match(state.request.error, /exceeded/)
})

test(
  'timeout also stops a worker descendant holding inherited output open',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { controller, preview } = fixture(t, { timeout: 300 })
    const job = preview({ mode: 'descendant' })
    await completed(controller, job.id, 'cancelled')
  },
)

test('declared source links, including directory ancestors, cannot escape the workspace', async (t) => {
  const { ws, controller } = fixture(t)
  const outside = scratch('shape-lab-outside-')
  t.after(outside.done)
  outside.put('private.txt', 'not a project input')
  symlinkSync(outside.dir, join(ws.dir, 'scenes/linked'))
  assert.match(controller.state().error, /symbolic links/)
  ws.put(
    '.harness/design.json',
    JSON.stringify({ ...definition(), sources: ['scenes/build.py', 'scenes/linked/private.txt'] }),
  )
  assert.match(controller.state().error, /symbolic links/)
})

test('HTTP mutations require the page token and same origin; saved outputs never replace the main model', async (t) => {
  const { ws, helpers } = fixture(t)
  ws.put('out/designs/aaaaaaaaaaaaaaaaaaaa/source/out/model.glb', 'kept model')
  const viewer = await startViewer({
    workspace: ws.dir,
    env: { BLENDER_PYTHON: process.execPath, BLENDER_TOOLCHAIN: helpers.dir },
  })
  t.after(() => viewer.stop())
  const html = await (await fetch(viewer.base)).text()
  const token = /name="design-token" content="([a-f0-9]+)"/.exec(html)[1]
  const state = await (await fetch(viewer.base + '/api/state')).json()
  assert.deepEqual(
    state.models.map((m) => m.path),
    ['out/model.glb'],
  )
  const post = (headers) =>
    fetch(viewer.base + '/api/design/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify({ revision: state.design.design.revision, values: {} }),
    })
  assert.equal((await post({})).status, 403)
  assert.equal((await post({ 'x-design-token': token, origin: 'https://example.com' })).status, 403)
  assert.equal((await post({ 'x-design-token': token, origin: viewer.base })).status, 200)
  assert.equal((await raw(viewer.port, '/', { headers: { Host: 'foreign.example' } })).status, 403)
  const outside = scratch('shape-lab-http-outside-')
  t.after(outside.done)
  outside.put('hidden.glb', 'private')
  symlinkSync(outside.dir, join(ws.dir, 'linked'))
  assert.equal((await fetch(viewer.base + '/ws/linked/hidden.glb')).status, 403)
})

// How the viewer starts and stops: where the robots are (the harness's, MENAGERIE, or the workspace's
// own), a workspace that is not there yet, a watcher that fails, a signal from Harness, and being
// imported instead of run.
//
//   npm test
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { changedPaths, freePort, get, removeTree, startViewer, VIEWER, write } from './helpers.mjs'

const root = mkdtempSync(join(tmpdir(), 'mujoco-viewer-env-'))
after(() => removeTree(root))

async function eventually(check, what, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('run by viewer.sh for a harness: its robots, and SIGTERM ends the event streams and exits 0', async () => {
  const harness = join(root, 'harness')
  const ws = join(root, 'ws-harness')
  write(join(harness, 'menagerie', 'dog', 'scene.xml'), '<mujoco model="dog"/>')
  mkdirSync(ws)
  const viewer = await startViewer({ via: 'sh', env: { HARNESS_WORKSPACE: ws, HARNESS_DSH_DIR: harness } })
  assert.ok(viewer.output().includes(`[mujoco-viewer] workspace: ${ws}\n`), viewer.output())
  assert.ok(viewer.output().includes(`[mujoco-viewer] menagerie: ${join(harness, 'menagerie')}\n`), viewer.output())
  assert.deepEqual((await viewer.json('/api/models')).robots, [{ path: 'menagerie/dog/scene.xml', name: 'dog' }])
  assert.equal((await viewer.get('/menagerie/dog/scene.xml')).status, 200)

  const feed = await viewer.events()
  assert.ok(await feed.until((b) => b.includes(': hello')))
  assert.deepEqual(await viewer.stop('SIGTERM'), { code: 0, signal: null })
  await feed.ended
})

test('no harness and no MENAGERIE: the workspace\'s own menagerie/, and the log says when it is not there', async () => {
  const ws = join(root, 'ws-plain')
  mkdirSync(ws)
  const viewer = await startViewer({ env: { HARNESS_WORKSPACE: ws } })
  assert.ok(viewer.output().includes(`menagerie: ${join(ws, 'menagerie')} (not there — only workspace MJCF will load)`), viewer.output())
  assert.deepEqual(await viewer.json('/api/models'), { robots: [], scenes: [] })
  write(join(ws, 'menagerie', 'cat', 'cat.xml'), '<mujoco model="cat"/>')
  assert.deepEqual((await viewer.json('/api/models')).robots, [{ path: 'menagerie/cat/cat.xml', name: 'cat' }])
  assert.deepEqual(await viewer.stop('SIGINT'), { code: 0, signal: null })
})

test('a workspace that is not there yet: watching fails, and every answer is still an answer', async () => {
  const ws = join(root, 'not-yet')
  const viewer = await startViewer({ env: { HARNESS_WORKSPACE: ws, MENAGERIE: join(root, 'no-menagerie') } })
  assert.match(viewer.output(), /\[mujoco-viewer\] watch failed: /)
  const r = await viewer.json('/api/resolve?file=out/rollout.qpos.json')
  assert.equal(r.model, null)
  assert.equal(r.trajectory, null)
  assert.deepEqual(await viewer.json('/api/models'), { robots: [], scenes: [] })
  assert.deepEqual(await viewer.json('/api/list'), { files: [] })
  assert.equal((await viewer.get('/')).status, 200)
  assert.deepEqual(await viewer.stop(), { code: 0, signal: null })
})

test('a watcher that fails after starting is logged, and one that names no path announces nothing', async () => {
  const ws = join(root, 'ws-watch')
  mkdirSync(ws)
  const failing = await startViewer({ env: { HARNESS_WORKSPACE: ws, TEST_WATCH: 'error' } })
  await eventually(() => failing.output().includes('[mujoco-viewer] watch error: the watcher stopped'), 'the watch error in the log')
  assert.equal((await failing.get('/')).status, 200, 'the pane keeps serving')
  assert.deepEqual(await failing.stop(), { code: 0, signal: null })

  const nameless = await startViewer({ env: { HARNESS_WORKSPACE: ws, TEST_WATCH: 'null-name' } })
  const feed = await nameless.events()
  assert.equal(await feed.until((b) => changedPaths(b) !== null, 800), null, 'no change event for a change with no path')
  feed.close()
  assert.deepEqual(await nameless.stop(), { code: 0, signal: null })
})

test('imported by another module rather than run, it listens on nothing', async () => {
  const port = await freePort()
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(VIEWER).href)})`], {
    env: { ...process.env, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(code, 0, out)
  assert.equal(out, '')
  await assert.rejects(get(port, '/'), { code: 'ECONNREFUSED' })
})

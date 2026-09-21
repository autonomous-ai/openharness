// node --test test/ — the pane's server (viewer.mjs), run as Harness runs it, over HTTP.
//
// The viewer serves the REPL from its own node_modules, so each test builds a package root in a temp
// dir: viewer.mjs and pane/ are symlinks to this checkout (node runs with --preserve-symlinks-main,
// so the viewer's own directory is the temp root) and node_modules holds a two-file stand-in for
// @strudel/repl's dist. No npm install, no network, and this checkout is never written to.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRELOAD = join(PKG, 'test', 'preload.mjs')
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** A package root: the real viewer and pane, a stand-in REPL bundle. */
function packageRoot() {
  const root = tempDir('strudel-viewer-')
  symlinkSync(join(PKG, 'viewer.mjs'), join(root, 'viewer.mjs'))
  symlinkSync(join(PKG, 'pane'), join(root, 'pane'))
  const dist = join(root, 'node_modules', '@strudel', 'repl', 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.js'), 'export const repl = 1\n')
  writeFileSync(join(dist, 'assets', 'clockworker-abc.js'), 'onmessage = () => {}\n')
  return root
}

function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ok(port))
    }).on('error', fail)
  })
}

async function startViewer(workspace, { fastTimers = false } = {}) {
  const root = packageRoot()
  const port = await freePort()
  const env = { ...process.env, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: workspace }
  if (fastTimers) env.VIEWER_TEST_FAST_TIMERS = '1'
  const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', '--import', PRELOAD, join(root, 'viewer.mjs')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const exited = new Promise((ok) => child.on('exit', (code, signal) => ok({ code, signal })))
  for (let i = 0; i < 200 && !log.includes('listening on'); i++) await sleep(25)
  assert.match(log, /\[strudel\] listening on http:\/\/127\.0\.0\.1:\d+\//)
  return {
    port,
    root,
    log: () => log,
    alive: () => child.exitCode === null && child.signalCode === null,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await exited
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function get(port, path, { method = 'GET' } = {}) {
  return new Promise((ok, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', fail)
    req.end()
  })
}

/** An open /events stream: everything it has said so far, and a wait for a pattern. */
function events(port) {
  return new Promise((ok, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { text += d })
      const stream = {
        res,
        text: () => text,
        async until(pattern, ms = 5000) {
          for (let waited = 0; waited < ms; waited += 20) {
            if (pattern.test(text)) return text
            await sleep(20)
          }
          assert.fail(`no ${pattern} on /events within ${ms} ms; got ${JSON.stringify(text)}`)
        },
        close() { req.destroy() },
      }
      ok(stream)
    })
    req.on('error', fail)
    req.end()
  })
}

describe('the pane server', () => {
  let parent
  let ws
  let viewer

  before(async () => {
    parent = tempDir('strudel-ws-')
    ws = join(parent, 'ws')
    mkdirSync(ws)
    writeFileSync(join(parent, 'secret.txt'), 'not the workspace\n')
    writeFileSync(join(ws, 'track.strudel'), 's("sbd*4")\n')
    mkdirSync(join(ws, '.harness'))
    mkdirSync(join(ws, 'node_modules'))
    mkdirSync(join(ws, 'song'))
    viewer = await startViewer(ws)
  })
  after(async () => {
    await viewer.stop()
    rmSync(parent, { recursive: true, force: true })
  })

  test('/ is the pane page', async () => {
    const page = await get(viewer.port, '/')
    assert.equal(page.status, 200)
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(page.headers['cache-control'], 'no-store')
    assert.match(page.body, /<html/i)
  })

  test('/_pane/ serves the pane files fresh, and nothing outside pane/', async () => {
    const css = await get(viewer.port, '/_pane/pane.css')
    assert.equal(css.status, 200)
    assert.equal(css.headers['content-type'], 'text/css')
    assert.equal(css.headers['cache-control'], 'no-store')
    // An escaped slash survives URL parsing, so this reaches safe() as pane/../viewer.mjs — a file
    // that exists, one level up.
    assert.equal((await get(viewer.port, '/_pane/..%2fviewer.mjs')).status, 404)
    assert.equal((await get(viewer.port, '/_pane/missing.js')).status, 404)
  })

  test('/vendor/ serves the REPL bundle and its siblings, cached; HEAD says the size', async () => {
    const bundle = await get(viewer.port, '/vendor/index.js')
    assert.equal(bundle.status, 200)
    assert.equal(bundle.headers['content-type'], 'text/javascript')
    assert.equal(bundle.headers['cache-control'], 'max-age=3600')
    assert.equal(bundle.body, 'export const repl = 1\n')
    assert.equal((await get(viewer.port, '/vendor/assets/clockworker-abc.js')).status, 200)
    const head = await get(viewer.port, '/vendor/index.js', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-length'], String('export const repl = 1\n'.length))
    assert.equal(head.body, '')
    assert.equal((await get(viewer.port, '/vendor/assets')).status, 404)        // a directory
    assert.equal((await get(viewer.port, '/vendor/')).status, 404)              // the dist directory itself
  })

  test('any other path is a workspace file, never one outside it', async () => {
    const track = await get(viewer.port, '/track.strudel')
    assert.equal(track.status, 200)
    assert.equal(track.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(track.headers['cache-control'], 'no-store')
    assert.equal(track.body, 's("sbd*4")\n')
    writeFileSync(join(ws, 'song', 'stem.bin'), 'x')
    assert.equal((await get(viewer.port, '/song/stem.bin')).headers['content-type'], 'application/octet-stream')
    assert.equal((await get(viewer.port, '/..%2fsecret.txt')).status, 404)
    assert.equal((await get(viewer.port, '/nope.strudel')).status, 404)
  })

  test('a malformed escape in the path is a 400, and the server keeps serving', async () => {
    // Before the fix decodeURIComponent threw inside the request handler and took the pane down.
    const bad = await get(viewer.port, '/%E0%A4%A')
    assert.equal(bad.status, 400)
    assert.equal((await get(viewer.port, '/')).status, 200)
    assert.ok(viewer.alive())
  })

  test('/events says hello, then one change per burst of saves, ignoring .harness and node_modules', async () => {
    const stream = await events(viewer.port)
    assert.equal(stream.res.headers['content-type'], 'text/event-stream')
    await stream.until(/: hello\n\n/)
    await sleep(400)                                     // let the directories made in before() settle
    const settled = stream.text()
    writeFileSync(join(ws, '.harness', 'verdict.json'), '{}')
    writeFileSync(join(ws, 'node_modules', 'x.js'), '')
    await sleep(600)
    assert.equal(stream.text(), settled, 'a verdict write or a node_modules change is not a save')
    for (let i = 0; i < 10; i++) writeFileSync(join(ws, i % 2 ? 'track.strudel' : join('song', 'b-side.strudel')), `s("sbd*${i}")\n`)
    await stream.until(/event: change\ndata: \{\}\n\n/)
    await sleep(500)
    const changes = stream.text().split('event: change').length - 1
    assert.ok(changes >= 1 && changes < 10, `ten saves in a burst are debounced, got ${changes} change events`)
    stream.close()
  })
})

describe('/_files: the tracks the pane can open', () => {
  let ws
  let viewer

  before(async () => {
    ws = tempDir('strudel-files-')
    const file = (rel, mtimeSeconds, body = 's("sbd")\n') => {
      mkdirSync(join(ws, dirname(rel)), { recursive: true })
      writeFileSync(join(ws, rel), body)
      utimesSync(join(ws, rel), mtimeSeconds, mtimeSeconds)
    }
    file('old.strudel', 1_000_000)
    file('new.strudel', 3_000_000)
    file('a/b/c/d/deep.strudel', 2_000_000)                 // four directories down: still walked
    file('a/b/c/d/e/too-deep.strudel', 2_000_000)           // five: not
    file('.hidden/secret.strudel', 2_000_000)
    file('.dot.strudel', 2_000_000)
    file('node_modules/pkg/demo.strudel', 2_000_000)
    file('notes.txt', 2_000_000)
    file('locked/inside.strudel', 2_000_000)
    chmodSync(join(ws, 'locked'), 0o000)                     // unreadable: skipped, not a 500
    file('searchless/listed.strudel', 2_000_000)
    chmodSync(join(ws, 'searchless'), 0o444)                 // listable, but its files cannot be stat'ed
    viewer = await startViewer(ws)
  })
  after(async () => {
    await viewer.stop()
    chmodSync(join(ws, 'locked'), 0o755)
    chmodSync(join(ws, 'searchless'), 0o755)
    rmSync(ws, { recursive: true, force: true })
  })

  test('newest first, four levels deep, no hidden files, no node_modules, only .strudel', async () => {
    const res = await get(viewer.port, '/_files')
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/json')
    const files = JSON.parse(res.body)
    assert.deepEqual(files.map((f) => f.path), ['new.strudel', 'a/b/c/d/deep.strudel', 'old.strudel'])
    assert.equal(files[0].mtime, 3_000_000_000)
  })

  test('at most fifty', async () => {
    mkdirSync(join(ws, 'many'))
    for (let i = 0; i < 55; i++) writeFileSync(join(ws, 'many', `t${i}.strudel`), '')
    const files = JSON.parse((await get(viewer.port, '/_files')).body)
    assert.equal(files.length, 50)
  })
})

describe('the pane server, at the edges', () => {
  test('a workspace that does not exist: no watch, no tracks, the pane still serves', async () => {
    const parent = tempDir('strudel-gone-')
    const viewer = await startViewer(join(parent, 'gone'))
    try {
      assert.match(viewer.log(), /\[strudel\] watch failed: /)
      assert.deepEqual(JSON.parse((await get(viewer.port, '/_files')).body), [])
      assert.equal((await get(viewer.port, '/')).status, 200)
    } finally {
      await viewer.stop()
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('an open /events stream is pinged so it stays open', async () => {
    const ws = tempDir('strudel-ping-')
    const viewer = await startViewer(ws, { fastTimers: true })     // the 20 s ping every 400 ms
    try {
      const stream = await events(viewer.port)
      await stream.until(/: ping\n\n/, 3000)
      stream.close()
    } finally {
      await viewer.stop()
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

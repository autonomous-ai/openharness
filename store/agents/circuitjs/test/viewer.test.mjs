// node --test test/ — the pane's server (viewer.mjs), run as Harness runs it, over HTTP.
//
// The viewer serves CircuitJS1 from upstream/war beside itself, which setup.sh downloads. Each test
// builds a package root in a temp dir instead: viewer.mjs, viewer.html and toolchain/ are symlinks to
// this checkout (node runs with --preserve-symlinks-main, so the viewer's own directory is the temp
// root) and upstream/war is a few stand-in files. No download, and this checkout is never written to.
// The /__check route runs the real verdict with the real python3, or a stub python3 where a test
// needs one that is missing, hangs, prints nonsense or exits early.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRELOAD = join(PKG, 'test', 'preload.mjs')
const BLANK = '$ 1 0.000005 10.20027730826997 50 5 43 5e-11\n'
const APP_HTML = `<!doctype html>
<html><head>
  <link rel="manifest" href="/circuit/manifest.json">
</head><body>
    <script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js')
    }
    </script>
<script src="circuitjs1/circuitjs1.nocache.js"></script>
</body></html>
`
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** A package root: the real viewer, page and checker; a stand-in upstream/war unless told not to. */
function packageRoot({ war = true } = {}) {
  const root = tempDir('circuitjs-viewer-')
  for (const name of ['viewer.mjs', 'viewer.html', 'toolchain', 'lab', 'VERSIONS']) symlinkSync(join(PKG, name), join(root, name))
  if (war) {
    const dir = join(root, 'upstream', 'war')
    mkdirSync(join(dir, 'circuitjs1'), { recursive: true })
    writeFileSync(join(dir, 'circuitjs.html'), APP_HTML)
    writeFileSync(join(dir, 'circuitjs1', 'circuitjs1.nocache.js'), 'var circuitjs1 = {}\n')
    writeFileSync(join(dir, 'circuitjs1', 'LOGO.PNG'), 'png')
    writeFileSync(join(dir, 'circuitjs1', 'data.bin'), 'bin')
  }
  return root
}

/** A bin dir with one python3 stub, for PATH. */
function pythonStub(body) {
  const bin = tempDir('circuitjs-bin-')
  if (body !== null) {
    writeFileSync(join(bin, 'python3'), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, 'python3'), 0o755)
  }
  return bin
}

function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ok(port))
    }).on('error', fail)
  })
}

async function startViewer(workspace, { war = true, fastTimers = false, path = process.env.PATH } = {}) {
  const root = packageRoot({ war })
  const port = await freePort()
  const env = { ...process.env, PATH: path, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: workspace }
  if (fastTimers) env.VIEWER_TEST_FAST_TIMERS = '1'
  const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', '--import', PRELOAD, join(root, 'viewer.mjs')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const exited = new Promise((ok) => child.on('exit', (code, signal) => ok({ code, signal })))
  for (let i = 0; i < 200 && !log.includes('listening on'); i++) await sleep(25)
  assert.match(log, /\[circuitjs\] listening on http:\/\/127\.0\.0\.1:\d+\//)
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

function http(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((ok, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', fail)
    req.end(body)
  })
}

async function check(port, text, file) {
  const res = await http(port, file === undefined ? '/__check' : `/__check?file=${file}`, { method: 'POST', body: text })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/json')
  return JSON.parse(res.body)
}

/** An open /events stream: everything it has said so far, and a wait for a pattern. */
function events(port) {
  return new Promise((ok, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { text += d })
      ok({
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
      })
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
    parent = tempDir('circuitjs-ws-')
    ws = join(parent, 'ws')
    for (const dir of ['.git', 'node_modules', 'filters']) mkdirSync(join(ws, dir), { recursive: true })
    writeFileSync(join(parent, 'secret.txt'), 'not the workspace\n')
    writeFileSync(join(ws, 'circuit.txt'), BLANK)
    viewer = await startViewer(ws)
  })
  after(async () => {
    await viewer.stop()
    rmSync(parent, { recursive: true, force: true })
  })

  test('/ is the page, booting the app on the blank circuit', async () => {
    const page = await http(viewer.port, '/')
    assert.equal(page.status, 200)
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(page.headers['cache-control'], 'no-store')
    assert.ok(!page.body.includes('__BLANK__'))
    assert.ok(page.body.includes(`cct=${encodeURIComponent(BLANK)}`))
  })

  test('Scope Lab serves only public modules and protects bounded writes with a process token', async () => {
    const metadata = await http(viewer.port, '/__lab/api')
    assert.equal(metadata.status, 200)
    const state = JSON.parse(metadata.body)
    assert.equal(state.runtime.engine, 'CircuitJS1')
    assert.equal(state.runtime.compiledFiles.length, 1)
    assert.equal((await http(viewer.port, '/__lab/ui.mjs')).headers['content-type'], 'text/javascript')
    assert.equal((await http(viewer.port, '/__lab/store.mjs')).status, 404)
    assert.equal((await http(viewer.port, '/__lab/..%2fviewer.mjs')).status, 404)
    assert.equal((await http(viewer.port, '/__lab/api', { headers: { host: 'evil.example' } })).status, 403)
    const headers = { 'x-circuit-lab': state.token, 'content-type': 'application/json' }
    assert.equal((await http(viewer.port, '/__lab/api', { method: 'POST', body: '{}' })).status, 403)
    assert.equal((await http(viewer.port, '/__lab/api', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status, 403)
    assert.equal((await http(viewer.port, '/__lab/api', { method: 'POST', headers: { ...headers, 'sec-fetch-site': 'cross-site' }, body: '{}' })).status, 403)
    assert.equal((await http(viewer.port, '/__lab/api', { method: 'POST', headers, body: 'not json' })).status, 400)
    assert.equal((await http(viewer.port, '/__lab/api', { method: 'POST', headers, body: '{}' })).status, 400)
    assert.equal((await http(viewer.port, '/__lab/api', { method: 'POST', headers, body: 'a'.repeat(4 * 1024 * 1024 + 1) })).status, 413)
    assert.equal((await http(viewer.port, '/__lab/api', { method: 'DELETE' })).status, 405)
    assert.equal((await http(viewer.port, '/__lab/api/nope')).status, 400)
    assert.ok(viewer.alive())
  })

  test('/app/circuitjs.html is upstream\'s page without its manifest path and service worker, read once', async () => {
    const app = await http(viewer.port, '/app/circuitjs.html')
    assert.equal(app.status, 200)
    assert.equal(app.headers['content-type'], 'text/html; charset=utf-8')
    assert.ok(app.body.includes('<link rel="manifest" href="manifest.json">'))
    assert.ok(!app.body.includes('/circuit/manifest.json'))
    assert.ok(!app.body.includes('serviceWorker'))
    assert.ok(app.body.includes('<script src="circuitjs1/circuitjs1.nocache.js"></script>'))
    writeFileSync(join(viewer.root, 'upstream', 'war', 'circuitjs.html'), '<p>changed on disk</p>')
    assert.equal((await http(viewer.port, '/app/circuitjs.html')).body, app.body)
  })

  test('/app/ serves the rest of upstream/war, cached, and nothing outside it', async () => {
    const js = await http(viewer.port, '/app/circuitjs1/circuitjs1.nocache.js')
    assert.equal(js.status, 200)
    assert.equal(js.headers['content-type'], 'text/javascript')
    assert.equal(js.headers['cache-control'], 'max-age=3600')
    const head = await http(viewer.port, '/app/circuitjs1/circuitjs1.nocache.js', { method: 'HEAD' })
    assert.equal(head.headers['content-length'], String('var circuitjs1 = {}\n'.length))
    assert.equal(head.body, '')
    assert.equal((await http(viewer.port, '/app/circuitjs1/LOGO.PNG')).headers['content-type'], 'image/png')
    assert.equal((await http(viewer.port, '/app/circuitjs1/data.bin')).headers['content-type'], 'application/octet-stream')
    assert.equal((await http(viewer.port, '/app/circuitjs1/missing.js')).status, 404)
    assert.equal((await http(viewer.port, '/app/')).status, 404)                          // war/ itself
    // An escaped slash survives URL parsing and reaches safe() as war/../../viewer.html, which exists.
    assert.equal((await http(viewer.port, '/app/..%2f..%2fviewer.html')).status, 404)
  })

  test('any other path is a workspace file, never one outside it', async () => {
    const circuit = await http(viewer.port, '/circuit.txt')
    assert.equal(circuit.status, 200)
    assert.equal(circuit.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(circuit.headers['cache-control'], 'no-store')
    assert.equal(circuit.body, BLANK)
    assert.equal((await http(viewer.port, '/..%2fsecret.txt')).status, 404)
    assert.equal((await http(viewer.port, '/filters')).status, 404)
    assert.equal((await http(viewer.port, '/__check')).status, 404)                      // GET is not a check
  })

  test('a malformed escape in the path is a 400, and the server keeps serving', async () => {
    // Before the fix decodeURIComponent threw in the async handler: an unhandled rejection that
    // took the pane down.
    assert.equal((await http(viewer.port, '/%E0%A4%A')).status, 400)
    assert.equal((await http(viewer.port, '/')).status, 200)
    assert.ok(viewer.alive())
  })

  test('/__check runs the verdict\'s judge and keeps only what the page shows', async () => {
    const text = [
      BLANK.trim(),
      'R 176 112 176 80 0 0 40 5 0 0 0.5',   // a rail and no ground: no_ground, a warning the page shows
      'r 177 112 336 112 0 1000',            // off the grid, and floating: warnings the page leaves out
      'r 336 112 336 112 0 1000',            // zero_length: shown
      'q 1 2 3 4 5',                         // unknown_element: an error, shown
      '38 1 F0 0 1 101 -1 Label 0',          // slider_label: shown
    ].join('\n') + '\n'
    const { findings } = await check(viewer.port, text, 'filters%2Flowpass.txt')
    assert.deepEqual(findings.map((f) => f.kind).sort(), ['no_ground', 'slider_label', 'unknown_element', 'zero_length'])
    assert.ok(findings.every((f) => f.severity === 'error' || f.severity === 'warning'))
  })

  test('/__check names the file it was given, or circuit.txt', async () => {
    const named = await check(viewer.port, 'r 0 0 16 0 0 1000\n', 'filters%2Flowpass.txt')
    assert.match(named.findings[0].message, /^filters\/lowpass\.txt has no `\$` options line/)
    const unnamed = await check(viewer.port, 'r 0 0 16 0 0 1000\n')
    assert.match(unnamed.findings[0].message, /^circuit\.txt has no `\$` options line/)
  })

  test('/__check with a file name python cannot be handed is no answer, not a crash', async () => {
    assert.deepEqual(await check(viewer.port, BLANK, 'a%00b'), { findings: null })
    assert.ok(viewer.alive())
  })

  test('/__check drops a body over 4 MB', async () => {
    await assert.rejects(http(viewer.port, '/__check', { method: 'POST', body: 'x'.repeat(5_000_000) }))
    assert.equal((await http(viewer.port, '/')).status, 200)
  })

  test('/events announces saves by name, not .git or node_modules', async () => {
    const stream = await events(viewer.port)
    assert.equal(stream.res.headers['content-type'], 'text/event-stream')
    await stream.until(/: hello\n\n/)
    await sleep(400)                                     // let the directories made in before() settle
    const settled = stream.text()
    writeFileSync(join(ws, '.git', 'index'), 'x')
    writeFileSync(join(ws, 'node_modules', 'x.js'), '')
    await sleep(600)
    assert.equal(stream.text(), settled, '.git and node_modules changes are not saves')
    for (let i = 0; i < 6; i++) writeFileSync(join(ws, i % 2 ? 'circuit.txt' : join('filters', 'lowpass.txt')), `${BLANK}r 0 0 ${i * 16} 0 0 1\n`)
    await stream.until(/event: change\ndata: .*"circuit\.txt"/)
    await stream.until(/event: change\ndata: .*"filters\/lowpass\.txt"/)
    await sleep(400)
    const changes = [...stream.text().matchAll(/event: change\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1]).names)
    assert.ok(changes.length < 6, `six saves in a burst are debounced, got ${changes.length} change events`)
    assert.ok(changes.every((names) => new Set(names).size === names.length))
    stream.close()
  })
})

describe('the pane server, at the edges', () => {
  test('before setup: /app/circuitjs.html is a 404 that says so, and the pane keeps serving', async () => {
    // Before the fix readFileSync threw in the async handler and the unhandled rejection took the
    // pane down the first time the page asked for the app.
    const ws = tempDir('circuitjs-nowar-')
    const viewer = await startViewer(ws, { war: false })
    try {
      const app = await http(viewer.port, '/app/circuitjs.html')
      assert.equal(app.status, 404)
      assert.match(app.body, /toolchain\/setup\.sh/)
      assert.equal((await http(viewer.port, '/')).status, 200)
      assert.ok(viewer.alive())
    } finally {
      await viewer.stop()
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test('a workspace that does not exist: no watch, the pane still serves', async () => {
    const parent = tempDir('circuitjs-gone-')
    const viewer = await startViewer(join(parent, 'gone'))
    try {
      assert.match(viewer.log(), /\[circuitjs\] watch failed: /)
      assert.equal((await http(viewer.port, '/')).status, 200)
    } finally {
      await viewer.stop()
      rmSync(parent, { recursive: true, force: true })
    }
  })

  const withPython = (name, body, run, options = {}) => test(name, async () => {
    const ws = tempDir('circuitjs-py-')
    const bin = pythonStub(body)
    const viewer = await startViewer(ws, { path: bin, ...options })
    try {
      await run(viewer)
      assert.ok(viewer.alive())
    } finally {
      await viewer.stop()
      rmSync(ws, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    }
  })

  withPython('no python3 on PATH: the check has no answer', null, async (viewer) => {
    assert.deepEqual(await check(viewer.port, BLANK, 'circuit.txt'), { findings: null })
  })

  withPython('a python3 that prints something other than JSON: no answer', 'cat >/dev/null; echo not json', async (viewer) => {
    assert.deepEqual(await check(viewer.port, BLANK, 'circuit.txt'), { findings: null })
  })

  withPython('a python3 that exits before reading a large circuit: no answer, and no crash', 'exit 1', async (viewer) => {
    // Before the fix the write to its closed stdin raised EPIPE with no listener, an uncaught
    // exception that took the pane down.
    assert.deepEqual(await check(viewer.port, `${BLANK}${'r 0 0 16 0 0 1000\n'.repeat(60_000)}`, 'circuit.txt'), { findings: null })
  })

  withPython('a python3 that hangs is killed at the timeout', 'exec sleep 30', async (viewer) => {
    const started = Date.now()
    assert.deepEqual(await check(viewer.port, BLANK, 'circuit.txt'), { findings: null })
    assert.ok(Date.now() - started < 5000)                             // the 10 s timeout, at 200 ms
  }, { fastTimers: true })

  test('an open /events stream is pinged so it stays open', async () => {
    const ws = tempDir('circuitjs-ping-')
    const viewer = await startViewer(ws, { fastTimers: true })          // the 20 s ping every 400 ms
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

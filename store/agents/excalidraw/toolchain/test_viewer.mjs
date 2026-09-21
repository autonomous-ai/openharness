// The pane's server, run for real on a scratch workspace: node --test toolchain/test_viewer.mjs
//
// The vendor routes serve this package's node_modules (toolchain/setup.sh); without it they are
// asserted to 404 instead, so the suite passes on a bare checkout too.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
// V8 writes coverage only on a clean exit, so the test's SIGTERM exits instead of killing.
const EXIT_ON_TERM = 'data:text/javascript,process.on("SIGTERM",()=>process.exit(0))'
const vendored = existsSync(join(pkg, 'node_modules', 'react', 'umd', 'react.production.min.js'))
const asRoot = process.getuid?.() === 0

function freePort() {
  return new Promise((ok, fail) => {
    const s = net.createServer().once('error', fail)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) })
  })
}

/** One raw HTTP request (the path is sent exactly as given): {status, headers, body}. */
function request(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { connection: 'close', ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', fail)
    })
    req.on('error', fail)
    req.end(body)
  })
}
const text = async (port, path, options) => { const r = await request(port, path, options); return { ...r, body: r.body.toString() } }

async function until(check, what, ms = 5000) {
  for (const started = Date.now(); Date.now() - started < ms; await delay(25)) if (check()) return
  assert.fail(`timed out waiting for ${what}`)
}

async function startViewer(workspace) {
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', EXIT_ON_TERM, join(pkg, 'viewer.mjs')], {
    env: { ...process.env, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: workspace },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const exited = new Promise((ok) => child.on('exit', (code, signal) => ok({ code, signal })))
  for (let tries = 0; ; tries++) {
    try { await request(port, '/files.json'); break } catch {
      if (tries > 200 || child.exitCode !== null) throw new Error(`the viewer did not start:\n${output}`)
      await delay(25)
    }
  }
  return {
    port, exited, output: () => output,
    alive: async () => (await request(port, '/files.json')).status === 200,
    stop: () => { child.kill('SIGTERM'); return exited },
  }
}

/** An open /events stream and everything it has said so far. */
function events(port) {
  return new Promise((ok, fail) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let said = ''
      res.on('data', (c) => { said += c })
      ok({ headers: res.headers, said: () => said, close: () => req.destroy() })
    })
    req.on('error', fail)
  })
}

function write(file, body = '{}', mtime) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
  if (mtime !== undefined) utimesSync(file, mtime, mtime)
}

let ws, outside, viewer, idle
before(async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'excalidraw-viewer-')))
  ws = join(root, 'ws')
  outside = join(root, 'secret.txt')
  writeFileSync(outside, 'not yours')
  mkdirSync(ws)
  viewer = await startViewer(ws)
  idle = await events(viewer.port)     // opened now, read by the last test: the 20 s ping
})
after(async () => {
  const { code } = await viewer.stop()
  assert.equal(code, 0)
  for (const dir of ['locked', 'unlisted']) { try { chmodSync(join(ws, dir), 0o755) } catch {} }
  rmSync(dirname(ws), { recursive: true, force: true })
})

test('says where it listens', async () => {
  await until(() => viewer.output().includes('[excalidraw] listening'), 'the listening line')
  assert.match(viewer.output(), new RegExp(`\\[excalidraw\\] listening on http://127\\.0\\.0\\.1:${viewer.port}/ \\(workspace: ${ws.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`))
})

test('serves the page and its own files, fresh on every load', async () => {
  const page = await text(viewer.port, '/')
  assert.equal(page.status, 200)
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.equal(page.body, readFileSync(join(pkg, 'viewer', 'index.html'), 'utf8'))
  const script = await request(viewer.port, '/viewer/app.js')
  assert.equal(script.headers['content-type'], 'text/javascript')
  const head = await request(viewer.port, '/viewer/app.css', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-type'], 'text/css')
  assert.equal(Number(head.headers['content-length']), statSync(join(pkg, 'viewer', 'app.css')).size)
  assert.equal(head.body.length, 0)
  for (const path of ['/viewer/nope.js', '/viewer/', '/viewer/..%2Fviewer.mjs', '/viewer/..%2F..%2F..%2Fpackage.json']) {
    assert.equal((await request(viewer.port, path)).status, 404, path)
  }
})

test('serves React and Excalidraw from node_modules, cached, and nothing else from there', async () => {
  const react = await request(viewer.port, '/vendor/react.production.min.js')
  const font = await request(viewer.port, '/vendor/excalidraw-assets/Virgil.woff2')
  if (vendored) {
    assert.equal(react.status, 200)
    assert.equal(react.headers['cache-control'], 'max-age=3600')
    assert.equal(react.headers['content-type'], 'text/javascript')
    assert.equal(font.status, 200)
    assert.equal(font.headers['content-type'], 'font/woff2')
  } else {
    assert.equal(react.status, 404)
    assert.equal(font.status, 404)
  }
  for (const path of ['/vendor/react-dom.js', '/vendor/__proto__', '/vendor/constructor', '/vendor/excalidraw-assets/..%2F..%2F..%2Fpackage.json']) {
    assert.equal((await request(viewer.port, path)).status, 404, path)
  }
})

test('serves workspace files and never a file outside the workspace', async () => {
  write(join(ws, 'diagram.excalidraw'), '{"type":"excalidraw"}')
  write(join(ws, 'notes.xyz'), 'x')
  const diagram = await text(viewer.port, '/diagram.excalidraw')
  assert.deepEqual([diagram.status, diagram.headers['content-type'], diagram.headers['cache-control'], diagram.body], [200, 'application/json', 'no-store', '{"type":"excalidraw"}'])
  assert.equal((await request(viewer.port, '/notes.xyz')).headers['content-type'], 'application/octet-stream')
  for (const path of ['/missing.excalidraw', '/..%2Fsecret.txt', '/%2F..%2F..%2Fsecret.txt', '/export']) {
    assert.equal((await request(viewer.port, path)).status, 404, path)
  }
})

test('a path that is not valid percent-encoding is a 400, and the viewer keeps running', async () => {
  const bad = await text(viewer.port, '/%E0%A4%A.excalidraw')
  assert.equal(bad.status, 400)
  assert.ok(await viewer.alive())
})

test('lists the diagrams newest first, skipping state, dependencies and exports', async () => {
  const now = Date.now() / 1000
  write(join(ws, 'diagram.excalidraw'), '{}', now - 100)
  write(join(ws, 'flows', 'checkout.excalidraw'), '{}', now - 10)
  write(join(ws, 'a', 'b', 'c', 'd', 'deep.excalidraw'), '{}', now - 50)
  write(join(ws, 'a', 'b', 'c', 'd', 'e', 'too-deep.excalidraw'))
  for (const skipped of ['node_modules/x.excalidraw', 'exports/x.excalidraw', '.harness/x.excalidraw', '.hidden/x.excalidraw', '.dot.excalidraw', 'notes.txt']) {
    write(join(ws, skipped))
  }
  if (!asRoot) {
    write(join(ws, 'locked', 'x.excalidraw'))     // cannot be read at all
    chmodSync(join(ws, 'locked'), 0o000)
    write(join(ws, 'unlisted', 'x.excalidraw'))   // can be listed, but its files cannot be stat'ed
    chmodSync(join(ws, 'unlisted'), 0o444)
  }
  const listed = JSON.parse((await text(viewer.port, '/files.json')).body).files
  assert.deepEqual(listed.map((f) => f.path), ['flows/checkout.excalidraw', 'a/b/c/d/deep.excalidraw', 'diagram.excalidraw'])
  assert.ok(listed.every((f) => typeof f.mtime === 'number'))
})

test('exports land in exports/, by file name only', async () => {
  rmSync(join(ws, 'exports'), { recursive: true, force: true })
  write(join(ws, 'exports'), 'a file where the folder goes')
  const blocked = await text(viewer.port, '/export?name=shot.png', { method: 'POST', body: 'png' })
  assert.equal(blocked.status, 500)
  assert.match(JSON.parse(blocked.body).error, /EEXIST|ENOTDIR/)
  rmSync(join(ws, 'exports'))

  const png = await text(viewer.port, '/export?name=shot.png', { method: 'POST', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
  assert.equal(png.status, 200)
  assert.deepEqual(JSON.parse(png.body), { path: 'exports/shot.png', bytes: 4 })
  assert.deepEqual([...readFileSync(join(ws, 'exports', 'shot.png'))], [0x89, 0x50, 0x4e, 0x47])

  const escaped = await text(viewer.port, `/export?name=${encodeURIComponent('../../evil.svg')}`, { method: 'POST', body: '<svg/>' })
  assert.deepEqual(JSON.parse(escaped.body), { path: 'exports/evil.svg', bytes: 6 })
  assert.equal(existsSync(join(dirname(ws), 'evil.svg')), false)

  for (const query of ['', '?name=', '?name=notes.txt', '?name=shot.png.exe']) {
    const refused = await text(viewer.port, `/export${query}`, { method: 'POST', body: 'x' })
    assert.equal(refused.status, 400, query)
    assert.deepEqual(JSON.parse(refused.body), { error: 'name must be a .png or .svg file name' })
  }
})

test('a diagram with any file name can be exported under that name', async () => {
  // The pane names the export after the diagram: "order flow (v2).excalidraw" → "order flow (v2).png".
  for (const name of ['order flow (v2).png', 'café.svg', 'Q3+Q4 & plan.png']) {
    const saved = await text(viewer.port, `/export?name=${encodeURIComponent(name)}`, { method: 'POST', body: 'x' })
    assert.equal(saved.status, 200, `${name}: ${saved.body}`)
    assert.equal(readFileSync(join(ws, 'exports', name), 'utf8'), 'x')
  }
  const control = await text(viewer.port, `/export?name=${encodeURIComponent('bad\nname.png')}`, { method: 'POST', body: 'x' })
  assert.equal(control.status, 400)
})

test('an upload over 64 MB or cut off midway is refused, writes nothing, and the viewer keeps running', async () => {
  const huge = Buffer.alloc(64 * 1024 * 1024 + 1)
  try {
    const r = await request(viewer.port, '/export?name=huge.png', { method: 'POST', body: huge })
    assert.equal(r.status, 500)
  } catch (error) {
    assert.match(error.code ?? error.message, /ECONNRESET|EPIPE|socket hang up/)
  }
  assert.equal(existsSync(join(ws, 'exports', 'huge.png')), false)

  await new Promise((ok) => {
    const req = http.request({ host: '127.0.0.1', port: viewer.port, path: '/export?name=cut.png', method: 'POST', headers: { 'content-length': 1000 } })
    req.on('error', ok)
    req.write('only ten b')
    setTimeout(() => { req.destroy(); ok() }, 50)
  })
  await delay(50)
  assert.equal(existsSync(join(ws, 'exports', 'cut.png')), false)
  assert.ok(await viewer.alive())
})

test('pushes one change per burst of saves, per path, and nothing for state or exports', async () => {
  const stream = await events(viewer.port)
  assert.equal(stream.headers['content-type'], 'text/event-stream')
  await until(() => stream.said().startsWith(': hello\n\n'), 'the hello')
  const quiet = await events(viewer.port)
  quiet.close()                                     // a reader that left is dropped, not written to

  write(join(ws, 'exports', 'later.png'))
  write(join(ws, '.harness', 'verdict.json'))
  write(join(ws, 'node_modules', 'pkg.json'))
  // Ten saves 30 ms apart: each would be its own event without the 120 ms debounce. FSEvents
  // delivery can lag under load, so a burst may split once, but never into one event per save.
  for (let i = 0; i < 10; i++) { write(join(ws, 'flows', 'checkout.excalidraw'), `{"v":${i}}`); await delay(30) }
  const change = 'event: change\ndata: {"path":"flows/checkout.excalidraw"}\n\n'
  await until(() => stream.said().includes(change), 'the change event')
  await delay(400)
  const count = stream.said().split(change).length - 1
  assert.ok(count >= 1 && count <= 3, `${count} events for 10 saves:\n${stream.said()}`)
  assert.doesNotMatch(stream.said(), /exports|\.harness|node_modules/)
  stream.close()
  write(join(ws, 'diagram.excalidraw'), '{"after":"close"}')
  await delay(300)
  assert.ok(await viewer.alive())
})

test('an idle stream is kept alive with a ping every 20 s', async () => {
  await until(() => idle.said().includes(': ping\n\n'), 'the ping', 25_000)
  assert.equal(idle.said().split('\n\n')[0], ': hello')
  idle.close()
})

test('a workspace that is not there yet: no watch, an empty list, still serving', async () => {
  const missing = join(dirname(ws), 'not-yet')
  const lonely = await startViewer(missing)
  try {
    await until(() => lonely.output().includes('[excalidraw] watch failed:'), 'the watch failure line')
    assert.deepEqual(JSON.parse((await text(lonely.port, '/files.json')).body), { files: [] })
    assert.equal((await request(lonely.port, '/')).status, 200)
  } finally {
    assert.equal((await lonely.stop()).code, 0)
  }
})

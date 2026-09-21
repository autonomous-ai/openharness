// POST /api/open, for real: the viewer spawns `open` (macOS) or `xdg-open` (Linux) — here stubs on
// PATH that write down what they were asked to open — and only for its own page, only web links and
// files inside the workspace. process.platform is set by the test preload, so both systems run anywhere.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { request } from 'node:http'
import { after, test } from 'node:test'
import { cleanup, put, raw, scratch, socket, startViewer, until } from './helpers.mjs'

after(cleanup)

/** A bin directory holding a stub for `name` that appends its argv (tab-separated) to `log`. */
function stubBin(root, name, log) {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  // One write per call, so calls that run at the same time do not interleave.
  const stub = put(bin, name, `#!/bin/sh\nline=''\nfor a in "$@"; do line="$line$a\t"; done\nprintf '%s\\n' "$line" >> '${log}'\n`)
  chmodSync(stub, 0o755)
  return bin
}
const calls = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\t').slice(0, -1)) : [])

function workspaceWithPdf() {
  const root = scratch({ 'outside.pdf': '%PDF' })
  const ws = join(root, 'ws')
  put(ws, 'out/main.pdf', '%PDF-1.7\n')
  return { root, ws }
}

const post = (viewer, body, { headers = { 'x-doc-viewer': '1' }, rawBody } = {}) =>
  raw(viewer.port, { path: '/api/open', method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: rawBody ?? JSON.stringify(body) })

test('macOS: web links and workspace files open with `open`, a reveal with `open -R`', async () => {
  const { root, ws } = workspaceWithPdf()
  const log = join(root, 'open.log')
  const viewer = await startViewer(ws, { DOC_VIEWER_OPEN: undefined, TEST_PLATFORM: 'darwin', PATH: stubBin(root, 'open', log) })
  try {
    assert.equal((await (await fetch(viewer.base + '/api/state')).json()).canOpen, true, 'opening is on by default on macOS')
    assert.equal((await post(viewer, { kind: 'url', url: 'https://typst.app/docs' })).status, 200)
    assert.equal((await post(viewer, { kind: 'url', url: 'mailto:someone@example.com' })).status, 200)
    assert.equal((await post(viewer, { kind: 'open', path: 'out/main.pdf' })).status, 200)
    assert.equal((await post(viewer, { kind: 'reveal', path: 'out/main.pdf' })).status, 200)
    const expected = [['https://typst.app/docs'], ['mailto:someone@example.com'], [join(ws, 'out/main.pdf')], ['-R', join(ws, 'out/main.pdf')]]
    const seen = await until(() => { const c = calls(log); return c.length >= 4 && c }, 'the four opens')
    assert.deepEqual([...seen].sort(), [...expected].sort())
  } finally {
    await viewer.stop()
  }
})

test('Linux: `xdg-open` for a file, and its folder for a reveal', async () => {
  const { root, ws } = workspaceWithPdf()
  const log = join(root, 'xdg.log')
  const viewer = await startViewer(ws, { DOC_VIEWER_OPEN: undefined, TEST_PLATFORM: 'linux', PATH: stubBin(root, 'xdg-open', log) })
  try {
    assert.equal((await (await fetch(viewer.base + '/api/state')).json()).canOpen, true, 'opening is on by default on Linux')
    assert.equal((await post(viewer, { kind: 'reveal', path: 'out/main.pdf' })).status, 200)
    assert.deepEqual(await until(() => calls(log)[0], 'the reveal'), [join(ws, 'out')])
    assert.equal((await post(viewer, { kind: 'open', path: 'out/main.pdf' })).status, 200)
    assert.deepEqual(await until(() => calls(log)[1], 'the open'), [join(ws, 'out/main.pdf')])
  } finally {
    await viewer.stop()
  }
})

test('elsewhere opening is off: the state says so and the route answers 501', async () => {
  const { ws } = workspaceWithPdf()
  const viewer = await startViewer(ws, { DOC_VIEWER_OPEN: undefined, TEST_PLATFORM: 'win32' })
  try {
    assert.equal((await (await fetch(viewer.base + '/api/state')).json()).canOpen, false)
    assert.equal((await post(viewer, { kind: 'url', url: 'https://typst.app' })).status, 501)
  } finally {
    await viewer.stop()
  }
})

test('DOC_VIEWER_OPEN=off turns it off anywhere', async () => {
  const { ws } = workspaceWithPdf()
  const viewer = await startViewer(ws, { DOC_VIEWER_OPEN: 'off', TEST_PLATFORM: 'darwin' })
  try {
    assert.equal((await (await fetch(viewer.base + '/api/state')).json()).canOpen, false)
    assert.equal((await post(viewer, { kind: 'open', path: 'out/main.pdf' })).status, 501)
  } finally {
    await viewer.stop()
  }
})

test('only the page itself may ask: its header, and a loopback Host naming this port', async () => {
  const { root, ws } = workspaceWithPdf()
  const log = join(root, 'open.log')
  const viewer = await startViewer(ws, { DOC_VIEWER_OPEN: undefined, TEST_PLATFORM: 'darwin', PATH: stubBin(root, 'open', log) })
  try {
    const link = { kind: 'url', url: 'https://example.com/' }
    assert.equal((await post(viewer, link, { headers: {} })).status, 403, 'no header')
    assert.equal((await post(viewer, link, { headers: { 'x-doc-viewer': '0' } })).status, 403, 'the wrong header')
    assert.equal((await post(viewer, link, { headers: { 'x-doc-viewer': '1', host: `evil.example:${viewer.port}` } })).status, 403, 'a rebinding Host')
    assert.equal((await post(viewer, link, { headers: { 'x-doc-viewer': '1', host: '127.0.0.1:1' } })).status, 403, 'another port')
    // HTTP/1.0 may leave Host out altogether.
    const body = JSON.stringify(link)
    assert.equal(await socket(viewer.port, `POST /api/open HTTP/1.0\r\nx-doc-viewer: 1\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`), 'HTTP/1.1 403 Forbidden')
    assert.equal((await post(viewer, link, { headers: { 'x-doc-viewer': '1', host: `localhost:${viewer.port}` } })).status, 200, 'localhost is loopback too')
    assert.deepEqual(await until(() => calls(log)[0], 'the one open that was allowed'), ['https://example.com/'])
  } finally {
    await viewer.stop()
  }
})

test('refused: other schemes, huge links, files outside the workspace or not there, and bodies that are not an object', async () => {
  const { root, ws } = workspaceWithPdf()
  const log = join(root, 'open.log')
  const viewer = await startViewer(ws, { DOC_VIEWER_OPEN: undefined, TEST_PLATFORM: 'darwin', PATH: stubBin(root, 'open', log) })
  try {
    assert.equal((await post(viewer, { kind: 'url', url: 'file:///etc/hosts' })).status, 400)
    assert.equal((await post(viewer, { kind: 'url', url: 'javascript:alert(1)' })).status, 400)
    assert.equal((await post(viewer, { kind: 'url' })).status, 400, 'no link at all')
    assert.equal((await post(viewer, { kind: 'url', url: 'https://example.com/' + 'a'.repeat(4096) })).status, 400, 'longer than 4096')
    assert.equal((await post(viewer, { kind: 'open', path: '../outside.pdf' })).status, 404)
    assert.equal((await post(viewer, { kind: 'reveal', path: 'out/nope.pdf' })).status, 404)
    // Not JSON, or JSON that is not an object: a 400, where `null` used to be a 500 (it was read as an object).
    for (const rawBody of ['{not json', 'null', '1', '"out/main.pdf"']) {
      const r = await post(viewer, null, { rawBody })
      assert.equal(r.status, 400, rawBody)
      assert.deepEqual(JSON.parse(r.text), { ok: false, error: 'bad request' })
    }
    // A path left out names the workspace itself, which exists.
    assert.equal((await post(viewer, { kind: 'reveal' })).status, 200)
    assert.deepEqual(await until(() => calls(log)[0], 'the reveal of the workspace'), ['-R', ws])
    assert.equal(calls(log).length, 1, 'nothing refused was opened')
  } finally {
    await viewer.stop()
  }
})

test('a link spawn cannot take (a NUL byte) is a 500, and the server carries on', async () => {
  const { root, ws } = workspaceWithPdf()
  const viewer = await startViewer(ws, { DOC_VIEWER_OPEN: undefined, TEST_PLATFORM: 'darwin', PATH: stubBin(root, 'open', join(root, 'open.log')) })
  try {
    const r = await post(viewer, { kind: 'url', url: 'https://example.com/ ' })
    assert.equal(r.status, 500)
    assert.match(JSON.parse(r.text).error, /null bytes/)
    assert.equal((await fetch(viewer.base + '/api/state')).status, 200)
  } finally {
    await viewer.stop()
  }
})

test('no opener on PATH: the request is answered and the failure logged, not thrown', async () => {
  const { root, ws } = workspaceWithPdf()
  const empty = join(root, 'empty-bin')
  mkdirSync(empty)
  const viewer = await startViewer(ws, { DOC_VIEWER_OPEN: undefined, TEST_PLATFORM: 'darwin', PATH: empty })
  try {
    assert.equal((await post(viewer, { kind: 'url', url: 'https://example.com/' })).status, 200)
    await until(() => viewer.output().includes('[doc-viewer] open failed:'), 'the spawn error to be logged')
    assert.ok(viewer.alive())
  } finally {
    await viewer.stop()
  }
})

test('a body over 16 KB is cut off, and one abandoned half-way is dropped; the server carries on', async () => {
  const { root, ws } = workspaceWithPdf()
  const log = join(root, 'open.log')
  const viewer = await startViewer(ws, { DOC_VIEWER_OPEN: undefined, TEST_PLATFORM: 'darwin', PATH: stubBin(root, 'open', log) })
  try {
    const big = JSON.stringify({ kind: 'url', url: 'https://example.com/', pad: 'x'.repeat(40_000) })
    const answer = await post(viewer, null, { rawBody: big }).then((r) => r.status, (e) => e.code)
    assert.notEqual(answer, 200)
    // Half a body, then the client goes away.
    await new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port: viewer.port, path: '/api/open', method: 'POST', headers: { 'x-doc-viewer': '1', 'content-type': 'application/json', 'content-length': 1000 } })
      req.on('error', () => resolve())
      req.write('{"kind": "url", "url": "https://exa')
      setTimeout(() => { req.destroy(); resolve() }, 150)
    })
    assert.equal((await post(viewer, { kind: 'url', url: 'https://example.com/after' })).status, 200)
    assert.deepEqual(await until(() => calls(log)[0], 'the open after'), ['https://example.com/after'])
    assert.equal(calls(log).length, 1, 'neither the cut-off nor the abandoned body opened anything')
  } finally {
    await viewer.stop()
  }
})

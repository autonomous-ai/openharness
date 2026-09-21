// Every route the server has, what it refuses, and what it survives: a real viewer process on a
// scratch workspace, raw HTTP where fetch would clean the path up before the server saw it.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { cleanup, openEvents, put, raw, scratch, socket, startViewer, stateOf, until } from './helpers.mjs'

let viewer, ws, root
before(async () => {
  root = scratch({ 'outside.pdf': '%PDF-1.7 not yours\n' })
  ws = join(root, 'ws')
  put(ws, 'main.typ', { body: '= Hi', at: new Date(Date.UTC(2026, 8, 16, 12, 0, 0)) })
  put(ws, 'out/main.pdf', { body: '%PDF-1.7\n%%EOF\n', at: new Date(Date.UTC(2026, 8, 16, 12, 0, 10)) })
  put(ws, 'notes.xyz', 'what is this')
  put(ws, 'quote"d.pdf', { body: '%PDF-1.7\n', at: new Date(Date.UTC(2026, 8, 16, 11, 0, 0)) })
  viewer = await startViewer(ws, { DOC_VIEWER_OPEN: 'log' })
})
after(async () => { await viewer?.stop(); cleanup() })

test('the reader, and HEAD without a body', async () => {
  const index = await fetch(viewer.base + '/index.html')
  assert.equal(index.status, 200)
  assert.match(index.headers.get('content-type'), /text\/html/)
  const head = await raw(viewer.port, { path: '/ws/out/main.pdf', method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-length'], '15')
  assert.equal(head.headers['content-type'], 'application/pdf')
  assert.ok(head.headers['last-modified'])
  assert.equal(head.text, '')
})

test('workspace files: an unknown type is bytes, a folder or a missing file is not found', async () => {
  const unknown = await fetch(viewer.base + '/ws/notes.xyz')
  assert.equal(unknown.headers.get('content-type'), 'application/octet-stream')
  assert.equal(await unknown.text(), 'what is this')
  assert.equal((await fetch(viewer.base + '/ws/out')).status, 404)
  assert.equal((await fetch(viewer.base + '/ws/out/missing.pdf')).status, 404)
  assert.equal((await fetch(viewer.base + '/app/')).status, 404, 'the app folder itself is not a file')
  assert.equal((await fetch(viewer.base + '/vendor/web/')).status, 404, 'nor a pdf.js folder')
})

test('a download keeps the file name, without the quote that would end the header', async () => {
  const r = await fetch(viewer.base + '/ws/quote%22d.pdf?download=1')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="quoted.pdf"')
  assert.equal((await fetch(viewer.base + '/ws/quote%22d.pdf')).headers.get('content-disposition'), null)
})

test('nothing outside the reader, pdf.js or the workspace, however the path is spelled', async () => {
  // %2F is not a separator to the URL parser, so these reach the server's own check with the dots intact.
  for (const path of ['/app/..%2Fviewer.mjs', '/vendor/build/..%2F..%2F..%2Fpackage.json', '/ws/..%2Foutside.pdf', '/ws/..%2F..%2F..%2Fetc%2Fhosts', '/..%2Foutside.pdf']) {
    const r = await raw(viewer.port, { path })
    assert.equal(r.status, 404, path)
    assert.doesNotMatch(r.text, /not yours/, path)
  }
  assert.equal((await raw(viewer.port, { path: '/main.typ' })).status, 404, 'the old root URLs serve PDFs only')
  assert.equal((await raw(viewer.port, { path: '/api/open' })).status, 404, 'open is POST only')
})

test('a path or a target that is not a URL is a 400, and the server is still there', async () => {
  assert.equal((await raw(viewer.port, { path: '/ws/%zz' })).status, 400)
  // An absolute-form request target with an impossible port: the URL parser throws on it.
  assert.equal(await socket(viewer.port, 'GET http://a:99999/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'), 'HTTP/1.1 400 Bad Request')
  assert.equal((await fetch(viewer.base + '/api/state')).status, 200)
  assert.ok(viewer.alive())
})

test('the state without a file names the newest PDF', async () => {
  const s = await (await fetch(viewer.base + '/api/state')).json()
  assert.equal(s.requested, '')
  assert.equal(s.file, 'out/main.pdf')
  assert.equal(s.canOpen, true)
})

test('a verdict with a null finding is read without it, and never takes the server down', async () => {
  put(ws, '.harness/verdict.json', JSON.stringify({ spec: 1, ready: false, artifact: 'out/main.pdf', findings: [null, { severity: 'error', message: 'boom', ref: 'main.typ:1:1' }] }))
  const r = await fetch(viewer.base + '/api/state?file=out/main.pdf')
  assert.equal(r.status, 200)
  const s = await r.json()
  assert.deepEqual(s.verdict.findings.map((f) => f.message), ['boom'])
  assert.ok(viewer.alive())
})

test('a verdict the state cannot be built from is a 500 for the request and a log line for the stream; both recover', async () => {
  const events = await openEvents(viewer.base, '/events?file=out/main.pdf')
  try {
    await events.next((b) => stateOf(b), 'the first state')
    // A message whose toString is not a function: String() of it throws.
    put(ws, '.harness/verdict.json', JSON.stringify({ spec: 1, ready: false, findings: [{ severity: 'error', message: { toString: 0 } }] }))
    const r = await fetch(viewer.base + '/api/state?file=out/main.pdf')
    assert.equal(r.status, 500)
    assert.match((await r.json()).error, /primitive/)
    await until(() => viewer.output().includes('[doc-viewer] state failed'), 'the stream to log the failure')
    put(ws, '.harness/verdict.json', JSON.stringify({ spec: 1, ready: true, summary: 'fixed', findings: [] }))
    const next = stateOf(await events.next((b) => stateOf(b)?.verdict?.summary === 'fixed', 'the state after the fix'))
    assert.equal(next.verdict.ready, true)
    assert.equal((await fetch(viewer.base + '/api/state')).status, 200)
    assert.ok(viewer.alive())
  } finally {
    events.close()
  }
})

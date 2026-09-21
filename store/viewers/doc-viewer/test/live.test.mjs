// The live feed: /events pushes the document state when the workspace changes (fs.watch, backed by a
// slow poll), only when the state really changed, keeps the connection alive with a ping, and ends
// cleanly when Harness stops the pane. The preload shortens the poll and the ping (3 s, 20 s).
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { cleanup, openEvents, put, scratch, sleep, startViewer, stateOf, until } from './helpers.mjs'

after(cleanup)
const at = (s) => new Date(Date.UTC(2026, 8, 16, 12, 0, s))
const isState = (b) => Boolean(stateOf(b))

test('a source edit reads as building, the new PDF as idle; nothing changed means nothing sent; stopping ends the stream', async () => {
  const ws = scratch({ 'main.typ': { body: '= Hi', at: at(0) }, 'out/main.pdf': { body: '%PDF', at: at(10) } })
  const viewer = await startViewer(ws, {
    TEST_TIMERS: '3000=150,20000=250',
    // Besides what really changes: names the watcher must ignore, a change with no filename, and a second
    // change straight after it (which restarts the settle timer).
    TEST_WATCH_EMIT: JSON.stringify(['node_modules/pdfjs-dist/x.js', '.git/index', '.claude/settings.json', '.agents/skills', null, 'main.typ']),
  })
  // The poll runs with nobody listening first.
  await sleep(400)
  const events = await openEvents(viewer.base, '/events?file=out/main.pdf')
  try {
    const first = stateOf(await events.next(isState, 'the state on connect'))
    assert.equal(first.file, 'out/main.pdf')
    assert.equal(first.build, 'idle')

    await events.next((b) => b === ': ping', 'a ping')
    // The poll keeps running, but the state is the same: no event.
    await assert.rejects(events.next(isState, 'no state event', 700), /timed out/)

    put(ws, 'main.typ', '= Hi again')
    const building = stateOf(await events.next((b) => stateOf(b)?.build === 'building', 'building after the source edit'))
    assert.equal(building.source.path, 'main.typ')
    put(ws, 'out/main.pdf', '%PDF-1.7 new')
    const idle = stateOf(await events.next((b) => stateOf(b)?.build === 'idle', 'idle after the PDF'))
    assert.equal(idle.pdf.size, 12)

    assert.equal(await viewer.stop(), 0, 'a clean exit on SIGTERM')
    assert.equal(await events.end(), true, 'the stream ended with the server')
  } finally {
    events.close()
    await viewer.stop()
  }
})

test('where fs.watch is not available the poll delivers, and a state that cannot be built is logged, not fatal', async () => {
  const ws = scratch({ 'out/a.pdf': { body: '%PDF', at: at(10) } })
  const viewer = await startViewer(ws, { TEST_WATCH: 'throw', TEST_TIMERS: '3000=100' })
  const events = await openEvents(viewer.base, '/events')
  try {
    assert.match(viewer.output(), /\[doc-viewer\] watch failed: watch unavailable here/)
    assert.equal(stateOf(await events.next(isState, 'the state on connect')).file, 'out/a.pdf')
    put(ws, 'out/b.pdf', '%PDF-1.7')
    const next = stateOf(await events.next((b) => stateOf(b)?.file === 'out/b.pdf', 'the new PDF, by polling'))
    assert.deepEqual(next.pdfs.map((p) => p.path), ['out/b.pdf', 'out/a.pdf'])

    put(ws, '.harness/verdict.json', JSON.stringify({ spec: 1, ready: false, findings: [{ severity: 'error', message: { toString: 0 } }] }))
    await until(() => viewer.output().includes('[doc-viewer] state failed:'), 'the failed state to be logged')
    put(ws, '.harness/verdict.json', JSON.stringify({ spec: 1, ready: false, summary: 'one error', findings: [{ severity: 'error', message: 'x' }] }))
    const failed = stateOf(await events.next((b) => stateOf(b)?.verdict?.summary === 'one error', 'the state once the verdict reads'))
    assert.equal(failed.build, 'failed')
    assert.ok(viewer.alive())
  } finally {
    events.close()
    await viewer.stop()
  }
})

test('a workspace that is not there yet: no watch, an empty state, no error', async () => {
  const missing = join(scratch(), 'not-yet')
  const viewer = await startViewer(missing, {})
  try {
    assert.match(viewer.output(), /\[doc-viewer\] watch failed: ENOENT/)
    const r = await fetch(viewer.base + '/api/state')
    assert.equal(r.status, 200)
    const s = await r.json()
    assert.equal(s.workspace, 'not-yet')
    assert.equal(s.file, null)
    assert.equal(s.build, 'idle')
    assert.deepEqual(s.pdfs, [])
  } finally {
    await viewer.stop()
  }
})

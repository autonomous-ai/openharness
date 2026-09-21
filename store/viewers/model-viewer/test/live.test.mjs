// The live feed: server-sent `state` events while the agent works. A new export, a verdict, a build
// feed and its pid, frames of a render in progress, a model still being written, a workspace that
// fs.watch cannot watch (or names no files for), the ping, and a clean end on SIGTERM.
//
//   npm test
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { events, scratch, sleep, startViewer, stateWhere } from './helpers.mjs'

const paths = (s) => s.models.map((m) => m.path)

test('a new export, a verdict and a build feed arrive as state events; the rest of .harness, ignored trees and no-op changes do not', async () => {
  const ws = scratch()
  // the ping every 150 ms instead of 20 s; the build re-check every 60 ms instead of 1.5 s
  const viewer = await startViewer({ workspace: ws.dir, env: { TEST_TIMERS: '20000=150,1500=60' } })
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    await sleep(200) // the re-check runs with nobody listening, and does nothing
    const feed = events(viewer.port)
    const first = await feed.until(stateWhere(() => true), { what: 'the first state' })
    assert.equal(first.index, 0, 'the current state comes first')
    assert.deepEqual(paths(first.item.data), [])
    await feed.until((item) => item.comment === 'ping', { what: 'a ping' })

    ws.put('out/part.glb', 'glTF')
    let seen = await feed.until(stateWhere((s) => paths(s).includes('out/part.glb')), { what: 'the new export' })

    // nothing the pane shows changes: no event
    ws.put('notes.txt', 'x')
    ws.put('node_modules/pkg/index.js', 'x')
    ws.put('.git/HEAD', 'ref')
    ws.put('src/__pycache__/m.pyc', 'x')
    ws.put('.harness/log.txt', 'x')
    await sleep(900)
    assert.equal(feed.list.slice(seen.index + 1).filter((item) => item.event === 'state').length, 0)

    ws.put('.harness/verdict.json', JSON.stringify({ spec: 1, ready: false, summary: '1 error' }))
    seen = await feed.until(stateWhere((s) => s.verdict?.summary === '1 error'), { from: seen.index + 1, what: 'the verdict' })

    ws.put('.harness/build.json', JSON.stringify({ state: 'building', step: 'Export', pid: helper.pid }))
    seen = await feed.until(stateWhere((s) => s.build?.state === 'building' && s.build.alive === true), { from: seen.index + 1, what: 'the build feed' })
    // the script dies without a word: the re-check alone notices
    helper.kill()
    seen = await feed.until(stateWhere((s) => s.build?.state === 'stopped' && s.build.alive === false), { from: seen.index + 1, what: 'the build reported stopped' })

    ws.put('.harness/build.json', JSON.stringify({ state: 'done', step: 'Export' }))
    seen = await feed.until(stateWhere((s) => s.build?.state === 'done'), { from: seen.index + 1, what: 'the build done' })

    feed.close()
    await sleep(200) // the ping and the re-check run with the client gone
    assert.equal(viewer.child.exitCode, null)
  } finally {
    helper.kill()
    await viewer.stop()
    ws.done()
  }
})

test('frames written into a *-frames folder read as a render in progress, which ends a few seconds after the last frame', async () => {
  const ws = scratch()
  mkdirSync(join(ws.dir, 'renders'))
  const viewer = await startViewer({ workspace: ws.dir })
  try {
    const feed = events(viewer.port)
    await feed.until(stateWhere(() => true))
    ws.put('renders/spin-frames/0001.png', 'frame')
    const started = await feed.until(stateWhere((s) => s.inferred !== null), { what: 'the inferred build' })
    assert.deepEqual(started.item.data.inferred, { state: 'building', step: 'Rendering frames', dir: 'renders/spin-frames' })
    ws.put('renders/spin-frames/0002.png', 'frame')
    ws.put('renders/spin-frames/0003.png', 'frame')
    const ended = await feed.until(stateWhere((s) => s.inferred === null), { from: started.index + 1, ms: 12_000, what: 'the inferred build to end' })
    assert.deepEqual(ended.item.data.stills, [], 'frames are not stills')
    const lastFrame = Math.max(...feed.list.slice(0, ended.index).filter((i) => i.event === 'state' && i.data.inferred).map((i) => i.data.now))
    assert.ok(ended.item.data.now - lastFrame >= 3000, 'the render counts as running for about four seconds after its last frame')
  } finally {
    await viewer.stop()
    ws.done()
  }
})

test('a model still being written is announced only once it stops growing', async () => {
  const ws = scratch()
  mkdirSync(join(ws.dir, 'out'))
  // the two looks at the sizes 1.2 s apart instead of 200 ms, so a busy machine cannot slip a look
  // between two appends
  const viewer = await startViewer({ workspace: ws.dir, env: { TEST_TIMERS: '200=1200' } })
  try {
    const feed = events(viewer.port)
    await feed.until(stateWhere(() => true))
    const chunk = Buffer.alloc(1000, 1)
    writeFileSync(join(ws.dir, 'out/big.glb'), chunk)
    for (let i = 0; i < 3; i++) { await sleep(500); appendFileSync(join(ws.dir, 'out/big.glb'), chunk) }
    const announced = await feed.until(stateWhere((s) => paths(s).includes('out/big.glb')), { ms: 15_000, what: 'the model' })
    assert.equal(announced.item.data.models[0].size, 4000, 'never half a GLB')
  } finally {
    await viewer.stop()
    ws.done()
  }
})

test('a workspace fs.watch cannot watch is polled: here, one that does not exist yet', async () => {
  const ws = scratch()
  const workspace = join(ws.dir, 'later')
  const viewer = await startViewer({ workspace, env: { TEST_TIMERS: '2000=100' } })
  try {
    assert.match(viewer.output().stdout, /watch failed: .*; polling/)
    const feed = events(viewer.port)
    const first = await feed.until(stateWhere(() => true))
    assert.deepEqual(paths(first.item.data), [])
    mkdirSync(join(workspace, 'out'), { recursive: true })
    writeFileSync(join(workspace, 'out/first.glb'), 'glTF')
    await feed.until(stateWhere((s) => paths(s).includes('out/first.glb')), { what: 'the polled export' })
  } finally {
    await viewer.stop()
    ws.done()
  }
})

test('a change fs.watch reports without a file name still makes the pane look again', async () => {
  const ws = scratch()
  // fs.watch replaced: nameless changes only, as some platforms report them
  const viewer = await startViewer({ workspace: ws.dir, env: { TEST_WATCH: 'nameless' } })
  try {
    const feed = events(viewer.port)
    await feed.until(stateWhere(() => true))
    ws.put('out/named-nowhere.glb', 'glTF')
    await feed.until(stateWhere((s) => paths(s).includes('out/named-nowhere.glb')), { what: 'the export seen through a nameless change' })
  } finally {
    await viewer.stop()
    ws.done()
  }
})

test('SIGTERM ends every event stream and exits 0', async () => {
  const ws = scratch()
  const viewer = await startViewer({ workspace: ws.dir })
  try {
    const feed = events(viewer.port)
    await feed.until(stateWhere(() => true))
    assert.deepEqual(await viewer.stop(), { code: 0, signal: null })
    const deadline = Date.now() + 5000
    while (!feed.ended && Date.now() < deadline) await sleep(20)
    assert.ok(feed.ended, 'the stream was ended by the server')
  } finally {
    ws.done()
  }
})

// The server as Harness runs it: viewer.sh with a port and a scratch workspace. The page, workspace
// files with byte ranges and nothing outside the workspace, stills from the page, the library pushed
// over server-sent events as the workspace changes, and requests that are the client's mistake
// answered instead of taking the pane down.
//
//   node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { mp4, png, startViewer, until, workspace } from './media.mjs'

describe('a viewer on a workspace with renders', () => {
  let ws, viewer
  before(async () => {
    ws = workspace()
    ws.put('out/intro.mp4', mp4({ frames: 30 }))
    ws.put('out/range.bin', Buffer.from('0123456789'))
    ws.put('out/empty.mp4', Buffer.alloc(0))
    ws.put('out/locked.mp4', mp4({ frames: 5 }))
    chmodSync(join(ws.dir, 'out/locked.mp4'), 0o000)
    mkdirSync(join(ws.dir, 'out/folder.mp4'))
    viewer = await startViewer(ws.dir, { TEST_TIMERS: '20000=100,2000=100', TEST_WATCH: 'null-name' })
  })
  after(async () => {
    await viewer?.stop()
    chmodSync(join(ws.dir, 'out/locked.mp4'), 0o644)
    ws.done()
  })

  test('serves the page and its files, and only its files', async () => {
    for (const path of ['/', '/index.html']) {
      const page = await viewer.get(path)
      assert.equal(page.status, 200, path)
      assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
      assert.match(page.body.toString(), /app\.js/)
    }
    const script = await viewer.get('/ui/app.js')
    assert.equal(script.status, 200)
    assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8')
    assert.equal((await viewer.get('/ui/%2e%2e%2fviewer.mjs')).status, 404, 'nothing beside the page')
    assert.equal((await viewer.get('/ui/nope.js')).status, 404)
  })

  test('serves workspace files with byte ranges, at /ws/ and at the root', async () => {
    const whole = await viewer.get('/ws/out/intro.mp4')
    assert.equal(whole.status, 200)
    assert.equal(whole.headers['content-type'], 'video/mp4')
    assert.equal(whole.headers['accept-ranges'], 'bytes')
    assert.equal(whole.headers['cache-control'], 'no-cache')
    assert.deepEqual(whole.body, readFileSync(join(ws.dir, 'out/intro.mp4')))
    assert.deepEqual((await viewer.get('/out/intro.mp4')).body, whole.body, 'the first version linked files at the root')

    const part = async (range) => {
      const r = await viewer.get('/ws/out/range.bin', { headers: { range } })
      return [r.status, r.headers['content-range'] ?? null, r.body.toString()]
    }
    assert.deepEqual(await part('bytes=2-4'), [206, 'bytes 2-4/10', '234'])
    assert.deepEqual(await part('bytes=7-'), [206, 'bytes 7-9/10', '789'], 'open-ended')
    assert.deepEqual(await part('bytes=6-99'), [206, 'bytes 6-9/10', '6789'], 'clamped to the end')
    assert.deepEqual(await part('bytes=-3'), [206, 'bytes 7-9/10', '789'], 'the last three bytes')
    assert.deepEqual(await part('bytes=-30'), [206, 'bytes 0-9/10', '0123456789'], 'a suffix longer than the file')
    assert.deepEqual(await part('bytes=5-3'), [416, 'bytes */10', ''])
    assert.deepEqual(await part('bytes=10-'), [416, 'bytes */10', ''])
    assert.deepEqual(await part('bytes=0-1,4-5'), [200, null, '0123456789'], 'a multipart range is answered with the whole file')
    const head = await viewer.get('/ws/out/range.bin', { method: 'HEAD', headers: { range: 'bytes=0-1' } })
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-length'], '10')
    assert.equal(head.headers['content-type'], 'application/octet-stream')
    const empty = await viewer.get('/ws/out/empty.mp4', { headers: { range: 'bytes=0-' } })
    assert.equal(empty.status, 200, 'an empty file has no range to give')
    assert.equal(empty.body.length, 0)
  })

  test('a Range that names no byte is served whole instead of killing the server', async () => {
    const r = await viewer.get('/ws/out/range.bin', { headers: { range: 'bytes=-' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.toString(), '0123456789')
    assert.equal((await viewer.get('/api/library')).status, 200, 'still up')
  })

  test('a malformed path or request line is a 400, and the server stays up', async () => {
    assert.equal((await viewer.get('/%zz')).status, 400)
    assert.equal((await viewer.get('/ui/%E0%A4%A')).status, 400)
    assert.equal((await viewer.get('http://a:99999/')).status, 400, 'an absolute-form target that is not a URL')
    assert.equal((await viewer.get('/api/library')).status, 200)
  })

  test('nothing outside the workspace, nothing that is not a file', async () => {
    assert.equal((await viewer.get('/ws/..%2F..%2F..%2Fetc%2Fhosts')).status, 403)
    assert.equal((await viewer.get('/..%2F..%2Fetc%2Fhosts')).status, 403)
    assert.equal((await viewer.get('/ws/out/missing.mp4')).status, 404)
    assert.equal((await viewer.get('/ws/out/folder.mp4')).status, 404)
    assert.equal((await viewer.get('/api/still')).status, 404, 'a GET is a workspace path, not the still endpoint')
  })

  test('a file that cannot be read drops the connection rather than hanging it', async () => {
    await assert.rejects(viewer.get('/ws/out/locked.mp4'))
    await assert.rejects(viewer.get('/ws/out/locked.mp4', { headers: { range: 'bytes=0-3' } }))
  })

  test('stills: only from the page, only PNG, named safely, into .harness/stills', async () => {
    const still = (query, body, headers = { 'x-video-viewer': 'still' }) => viewer.get(`/api/still${query}`, { method: 'POST', headers, body })
    assert.equal((await still('?name=x', png(), {})).status, 403, 'another origin cannot send the header')
    assert.equal((await still('?name=x', Buffer.from('PNG'))).status, 400, 'too short')
    assert.equal((await still('?name=x', Buffer.from('GIF89a..........'))).status, 400, 'not a PNG')

    const saved = await still('?name=Intro%20%2F..%2F..%2Fframe%2012', png())
    assert.equal(saved.status, 200)
    const answer = JSON.parse(saved.body)
    assert.match(answer.path, /^\.harness\/stills\/Intro-\.\.-\.\.-frame-12-[a-f0-9]{16}\.png$/)
    assert.match(answer.sha256, /^[a-f0-9]{64}$/)
    assert.equal(answer.abs, join(ws.dir, answer.path))
    assert.deepEqual(readFileSync(answer.abs), png())
    const unnamed = JSON.parse((await still('', png())).body).path
    assert.match(unnamed, /^\.harness\/stills\/frame-[a-f0-9]{16}\.png$/, 'no name')
    assert.equal(JSON.parse((await still('?name=...', png())).body).path, unnamed, 'a name that is only dots')
  })

  test('workspace endpoints reject foreign origins and rebinding hosts', async () => {
    assert.equal((await viewer.get('/api/library', { headers: { host: `elsewhere.invalid:${viewer.port}` } })).status, 403)
    assert.equal((await viewer.get('/api/library', { headers: { origin: 'https://elsewhere.invalid' } })).status, 403)
    const rejected = await viewer.get('/api/still?name=foreign', { method: 'POST', headers: { 'x-video-viewer': 'still', origin: 'https://elsewhere.invalid' }, body: png() })
    assert.equal(rejected.status, 403)
  })

  test('a still larger than 64 MiB is cut off', async () => {
    const body = Buffer.alloc(64 * 1024 * 1024 + 1024)
    png().copy(body)
    const r = await viewer.get('/api/still?name=huge', { method: 'POST', headers: { 'x-video-viewer': 'still' }, body }).catch((error) => error)
    assert.ok(r instanceof Error || r.status !== 200, 'no 200 for an oversized still')
    assert.equal(existsSync(join(ws.dir, '.harness/stills/huge.png')), false)
  })

  test('the library is served and pushed: first the current one, then every change, with pings between', async () => {
    const library = JSON.parse((await viewer.get('/api/library')).body)
    assert.deepEqual(library.renders.map((r) => r.path).sort(), ['out/empty.mp4', 'out/intro.mp4', 'out/locked.mp4'])
    assert.equal(library.workspace.path, ws.dir)

    const stream = await viewer.events()
    assert.equal(stream.headers['content-type'], 'text/event-stream')
    await stream.wait((t) => t.startsWith('retry: 1000\nevent: library\ndata: '), 'the first event')
    await stream.wait((t) => t.includes(': ping'), 'a ping')
    ws.put('notes.txt', 'not a render')
    ws.put('node_modules/pkg/clip.mp4', mp4({ frames: 1 }))
    ws.put('.harness/other.json', '{}')
    ws.put('scenes/proof.py', 'class Proof: pass')
    await stream.wait(() => stream.libraries().some((l) => l.scenes === 1), 'a library event with the new scene')
    ws.put('out/second.mp4', mp4({ frames: 45 }))
    await stream.wait(() => stream.libraries().some((l) => l.renders.some((r) => r.path === 'out/second.mp4')), 'the new render')
    const last = stream.libraries().at(-1)
    assert.equal(last.renders.some((r) => r.path.startsWith('node_modules')), false)
    stream.close()
  })

  test('a render whose process dies is reported stopped with no file changing', async () => {
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
    const stream = await viewer.events()
    ws.put('.harness/render.json', JSON.stringify({ state: 'rendering', pid: sleeper.pid, scene: 'Proof', output: 'out/videos/proof/480p15/Proof.mp4', updatedAtMs: Date.now() }))
    await stream.wait(() => stream.libraries().some((l) => l.live[0]?.state === 'rendering'), 'the render in progress')
    const exited = new Promise((ok) => sleeper.on('exit', ok))
    sleeper.kill('SIGKILL')
    await exited
    await stream.wait(() => stream.libraries().some((l) => l.live[0]?.state === 'stopped'), 'the render reported stopped')
    // A stopped render is still re-read on the clock for a while, but the same library is not pushed again.
    const events = stream.libraries().length
    const pings = stream.text.split(': ping').length
    await stream.wait((t) => t.split(': ping').length >= pings + 5, 'five more pings')
    assert.equal(stream.libraries().length, events)
    stream.close()
    rmSync(join(ws.dir, '.harness/render.json'))
  })

  test('a conflicting still directory is a 409; filesystem write failures remain a 500', async () => {
    rmSync(join(ws.dir, '.harness'), { recursive: true, force: true })
    writeFileSync(join(ws.dir, '.harness'), 'a file where the folder should be')
    const r = await viewer.get('/api/still?name=x', { method: 'POST', headers: { 'x-video-viewer': 'still' }, body: png() })
    assert.equal(r.status, 409)
    rmSync(join(ws.dir, '.harness'))
    mkdirSync(join(ws.dir, '.harness'))
    chmodSync(join(ws.dir, '.harness'), 0o500)
    try {
      const denied = await viewer.get('/api/still?name=x', { method: 'POST', headers: { 'x-video-viewer': 'still' }, body: png() })
      assert.equal(denied.status, 500)
    } finally { chmodSync(join(ws.dir, '.harness'), 0o755) }
  })

  test('SIGTERM ends the event streams and exits cleanly', async () => {
    const stream = await viewer.events()
    await stream.wait((t) => t.includes('event: library'), 'the first event')
    assert.deepEqual(await viewer.stop('SIGTERM'), { code: 0, signal: null })
    await until(() => stream.ended, 'the stream to end')
  })
})

test('a sidecar that is not the shape written does not keep the pane from starting', async () => {
  const ws = workspace()
  ws.put('out/videos/m/480p15/S.mp4', mp4({ frames: 15 }), Date.now() - 60_000)
  ws.put('.harness/renders/out/videos/m/480p15/S.mp4.json', JSON.stringify({ clips: ['a.mp4'], animations: { not: 'a list' } }))
  const viewer = await startViewer(ws.dir)
  try {
    const library = JSON.parse((await viewer.get('/api/library')).body)
    assert.deepEqual(library.renders.map((r) => [r.path, r.complete, r.frames, r.beats]), [['out/videos/m/480p15/S.mp4', true, 15, null]])
  } finally {
    await viewer.stop()
    ws.done()
  }
})

test('a long burst of writes is announced without waiting for it to settle', async () => {
  const ws = workspace()
  // 250 ms is the settle delay; stretched, only the "a beat after it began" rule can answer in time.
  const viewer = await startViewer(ws.dir, { TEST_TIMERS: '250=6000' })
  try {
    const stream = await viewer.events()
    await stream.wait((t) => t.includes('event: library'), 'the first event')
    ws.put('out/a.mp4', mp4({ frames: 10 }))
    await new Promise((r) => setTimeout(r, 2000))
    const written = Date.now()
    ws.put('out/b.mp4', mp4({ frames: 10 }))
    await stream.wait(() => stream.libraries().some((l) => l.renders.length === 2), 'both renders', 10_000)
    assert.ok(Date.now() - written < 5000, `announced ${Date.now() - written} ms after the write, not held for the settle delay`)
    stream.close()
  } finally {
    await viewer.stop()
    ws.done()
  }
})

test('a workspace that cannot be watched is polled', async () => {
  const ws = workspace()
  const missing = join(ws.dir, 'not-yet')
  const viewer = await startViewer(missing, { TEST_TIMERS: '1500=100' })
  try {
    assert.match(viewer.output(), /watch failed \(.*\); polling instead/)
    const stream = await viewer.events()
    await stream.wait((t) => t.includes('event: library'), 'the first event')
    assert.deepEqual(stream.libraries()[0].renders, [])
    ws.put('not-yet/out/late.mp4', mp4({ frames: 10 }))
    await stream.wait(() => stream.libraries().some((l) => l.renders.some((r) => r.path === 'out/late.mp4')), 'the render found by polling')
    stream.close()
    assert.deepEqual(await viewer.stop('SIGINT'), { code: 0, signal: null })
  } finally {
    await viewer.stop()
    ws.done()
  }
})

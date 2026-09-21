// The server over HTTP, on scratch workspaces: what /api/state finds and skips, the build feed and
// its pid, every route, byte ranges, and the sandbox around the workspace, the page and three.js.
//
//   npm test
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, symlinkSync, utimesSync } from 'node:fs'
import { basename, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { raw, scratch, socket, startViewer } from './helpers.mjs'

const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))

describe('a workspace, scanned', () => {
  let ws, viewer
  const at = (rel, seconds) => utimesSync(join(ws.dir, rel), 1_800_000_000 + seconds, 1_800_000_000 + seconds)
  before(async () => {
    ws = scratch()
    ws.put('out/old.glb', 'glTF'); at('out/old.glb', 1)
    ws.put('out/model.gltf', '{}'); at('out/model.gltf', 5)
    ws.put('out/report.json', JSON.stringify({ size_mm: [2, 0, 2] }))
    ws.put('renders/turntable.mp4', bytes); at('renders/turntable.mp4', 3)
    ws.put('renders/report.json', '{}')
    ws.put('renders/clip.WEBM', 'webm'); at('renders/clip.WEBM', 4)
    ws.put('renders/shot.PNG', 'png'); at('renders/shot.PNG', 2)
    ws.put('renders/spin-frames/0001.png', 'frame')
    ws.put('node_modules/pkg/x.glb', 'skipped')
    ws.put('textures/wood.jpg', 'skipped')
    ws.put('.hidden/y.glb', 'dot dir')
    ws.put('.dot.glb', 'dot file')
    ws.put('notes.txt', 'not a model')
    ws.put('a/b/c/d/e/f/six.glb', 'deep enough'); at('a/b/c/d/e/f/six.glb', 0)
    ws.put('a/b/c/d/e/f/g/seven.glb', 'too deep')
    ws.put('.harness/verdict.json', JSON.stringify({ spec: 1, ready: true, summary: 'ok' }))
    symlinkSync(join(ws.dir, 'gone.glb'), join(ws.dir, 'dangling.glb'))
    execFileSync('mkfifo', [join(ws.dir, 'pipe.glb')])
    viewer = await startViewer({ workspace: ws.dir })
  })
  after(async () => { await viewer?.stop(); ws.done() })

  const state = async () => (await fetch(`${viewer.base}/api/state`)).json()

  test('models, videos and stills newest first, with the report beside a model; skipped trees, dotfiles, depth > 6 and non-files left out', async () => {
    const response = await fetch(`${viewer.base}/api/state`)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const s = await response.json()
    assert.equal(s.workspace, basename(ws.dir))
    assert.deepEqual(s.models.map((m) => m.path), ['out/model.gltf', 'out/old.glb', 'a/b/c/d/e/f/six.glb'])
    assert.equal(s.models[0].report, 'out/report.json')
    assert.equal(s.models[0].size, 2)
    assert.equal(s.models[0].mtime, 1_800_000_005_000)
    assert.equal(s.models[2].report, undefined)
    assert.deepEqual(s.videos.map((v) => v.path), ['renders/clip.WEBM', 'renders/turntable.mp4'])
    assert.equal(s.videos[1].report, undefined, 'a report is only looked for beside a model')
    assert.deepEqual(s.stills.map((v) => v.path), ['renders/shot.PNG'], 'frames of a render in progress are not stills')
    assert.deepEqual(s.verdict, { spec: 1, ready: true, summary: 'ok' })
    assert.equal(s.build, null)
    assert.equal(s.inferred, null)
    assert.ok(Math.abs(s.now - Date.now()) < 60_000)
  })

  test('the build feed: a building pid that is gone reads as stopped; a live, foreign or missing pid still builds', async () => {
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise((resolve) => dead.on('exit', resolve))
    try {
      const feed = async (body) => { ws.put('.harness/build.json', JSON.stringify(body)); return (await state()).build }
      assert.deepEqual(await feed({ state: 'building', step: 'Export', pid: helper.pid }), { state: 'building', step: 'Export', pid: helper.pid, alive: true })
      assert.deepEqual(await feed({ state: 'building', pid: dead.pid }), { state: 'stopped', pid: dead.pid, alive: false })
      // pid 1 belongs to another user: kill(1, 0) is EPERM, which still means alive
      assert.equal((await feed({ state: 'building', pid: 1 })).state, 'building')
      assert.deepEqual(await feed({ state: 'building' }), { state: 'building', alive: true }, 'no pid: nothing to check it against')
      assert.deepEqual(await feed({ state: 'building', pid: 'abc' }), { state: 'building', pid: 'abc', alive: true })
      assert.deepEqual(await feed({ state: 'building', pid: -4 }), { state: 'building', pid: -4, alive: true })
      assert.deepEqual(await feed({ state: 'done', pid: dead.pid }), { state: 'done', pid: dead.pid, alive: null }, 'only a building feed is checked')
      assert.equal(await feed('building'), 'building', 'a feed that is not an object is passed on as it is')
      ws.put('.harness/build.json', '{ half written')
      assert.equal((await state()).build, null)
    } finally {
      helper.kill()
    }
  })

  test('the page, its modules and three.js, with their caching', async () => {
    for (const path of ['/', '/index.html']) {
      const page = await fetch(viewer.base + path)
      assert.equal(page.status, 200)
      assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.equal(page.headers.get('cache-control'), 'no-store')
      assert.match(await page.text(), /importmap/)
    }
    const app = await fetch(`${viewer.base}/app/app.js`)
    assert.equal(app.status, 200)
    assert.equal(app.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(app.headers.get('cache-control'), 'no-cache')
    assert.equal((await fetch(`${viewer.base}/app/style.css`)).headers.get('content-type'), 'text/css; charset=utf-8')
    for (const path of ['/vendor/three/build/three.module.js', '/vendor/three/examples/jsm/loaders/GLTFLoader.js']) {
      const r = await fetch(viewer.base + path)
      assert.equal(r.status, 200, path)
      assert.equal(r.headers.get('cache-control'), 'max-age=86400')
    }
    assert.equal((await fetch(`${viewer.base}/favicon.ico`)).status, 204)
  })

  test('workspace files under /ws/ and at the root, by type; folders and missing files are not found', async () => {
    const model = await fetch(`${viewer.base}/ws/out/model.gltf`)
    assert.equal(model.status, 200)
    assert.equal(model.headers.get('content-type'), 'model/gltf+json')
    assert.equal(model.headers.get('cache-control'), 'no-store')
    assert.equal(model.headers.get('accept-ranges'), 'bytes')
    assert.equal(model.headers.get('content-length'), '2')
    assert.equal(await model.text(), '{}')
    assert.equal((await fetch(`${viewer.base}/ws/renders/shot.PNG`)).headers.get('content-type'), 'image/png', 'extensions in any case')
    assert.equal((await fetch(`${viewer.base}/ws/notes.txt`)).headers.get('content-type'), 'application/octet-stream')
    const legacy = await fetch(`${viewer.base}/out/model.gltf`)
    assert.equal(legacy.status, 200, 'the first version fetched workspace files at the root')
    assert.equal(await legacy.text(), '{}')
    for (const path of ['/ws/out', '/ws/', '/ws/out/missing.glb', '/app/', '/app/missing.js', '/vendor/three/build/', '/missing.glb', '/renders']) {
      const r = await raw(viewer.port, path)
      assert.equal(r.status, 404, path)
    }
    const head = await raw(viewer.port, '/ws/renders/turntable.mp4', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-length'], '4096')
    assert.equal(head.body.length, 0)
  })

  test('byte ranges: a span, an open end, a suffix, clamped ends, unsatisfiable ones, and what is not a range', async () => {
    const get = (range, method) => raw(viewer.port, '/ws/renders/turntable.mp4', { method, headers: { range } })
    const cases = [
      ['bytes=10-19', 10, 19], ['bytes=4090-', 4090, 4095], ['bytes=-6', 4090, 4095],
      ['bytes=-99999', 0, 4095], ['bytes=100-99999', 100, 4095], ['bytes=0-0', 0, 0],
    ]
    for (const [range, start, end] of cases) {
      const r = await get(range)
      assert.equal(r.status, 206, range)
      assert.equal(r.headers['content-range'], `bytes ${start}-${end}/4096`, range)
      assert.equal(r.headers['content-length'], String(end - start + 1), range)
      assert.equal(r.headers['content-type'], 'video/mp4')
      assert.deepEqual(r.body, bytes.subarray(start, end + 1), range)
    }
    for (const range of ['bytes=20-10', 'bytes=4096-', 'bytes=5000-6000', 'bytes=-0']) {
      const r = await get(range)
      assert.equal(r.status, 416, range)
      assert.equal(r.headers['content-range'], 'bytes */4096', range)
      assert.equal(r.body.length, 0)
    }
    for (const range of ['bytes=-', 'bytes=0-1,4-5', 'items=0-1']) {
      const r = await get(range)
      assert.equal(r.status, 200, `${range} is not a range this server serves: the whole file`)
      assert.equal(r.body.length, 4096)
    }
    const head = await get('bytes=10-19', 'HEAD')
    assert.equal(head.status, 206)
    assert.equal(head.headers['content-length'], '10')
    assert.equal(head.body.length, 0)
  })

  test('nothing outside the workspace, the page folder or three\'s build and examples', async () => {
    const refused = {
      '/ws/..%2F..%2F..%2Fetc%2Fhosts': 403,
      '/ws/out/..%2F..%2Fviewer.mjs': 403,
      '/app/..%2Fviewer.mjs': 403,
      '/app/..%2F..%2Fpackage.json': 403,
      '/vendor/three/package.json': 403,
      '/vendor/three/src/Three.js': 403,
      '/vendor/three/build/..%2F..%2F..%2Fviewer.mjs': 403,
      '/..%2F..%2F..%2Fetc%2Fhosts': 404,
      '/ws/../../../etc/hosts': 404,
      '/ws/%2e%2e/%2e%2e/%2e%2e/etc/hosts': 404,
      '/app/../viewer.mjs': 404,
    }
    for (const [path, status] of Object.entries(refused)) {
      const r = await raw(viewer.port, path)
      assert.equal(r.status, status, path)
      assert.doesNotMatch(r.body.toString(), /localhost|createServer/, path)
    }
  })

  test('a malformed path is a bad request, and an unparseable request target does not take the server down', async () => {
    assert.equal((await raw(viewer.port, '/ws/%zz')).status, 400)
    assert.equal(await socket(viewer.port, 'GET http://a:99999/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'), 'HTTP/1.1 400 Bad Request')
    assert.equal((await fetch(`${viewer.base}/api/state`)).status, 200, 'still serving')
    assert.equal(viewer.child.exitCode, null)
  })
})

test('without HARNESS_WORKSPACE the workspace is the directory the viewer starts in', async () => {
  const ws = scratch()
  ws.put('here.glb', 'glTF')
  const viewer = await startViewer({ workspace: undefined, cwd: ws.dir })
  try {
    const s = await (await fetch(`${viewer.base}/api/state`)).json()
    assert.equal(s.workspace, basename(ws.dir))
    assert.deepEqual(s.models.map((m) => m.path), ['here.glb'])
  } finally {
    await viewer.stop()
    ws.done()
  }
})

test('a workspace larger than the scan budget still answers: the walk stops at 20 000 entries', async () => {
  const ws = scratch()
  for (let i = 0; i < 20_002; i++) mkdirSync(join(ws.dir, `d${i}`))
  const viewer = await startViewer({ workspace: ws.dir })
  try {
    const response = await fetch(`${viewer.base}/api/state`)
    assert.equal(response.status, 200)
    const s = await response.json()
    assert.deepEqual([s.models, s.videos, s.stills], [[], [], []])
  } finally {
    await viewer.stop()
    ws.done()
  }
})

test('SIGTERM ends the server cleanly', async () => {
  const ws = scratch()
  const viewer = await startViewer({ workspace: ws.dir })
  try {
    assert.deepEqual(await viewer.stop(), { code: 0, signal: null })
  } finally {
    ws.done()
  }
})

// The Remotion pane server (viewer.mjs), run for real against scratch workspaces, with a stand-in for
// Remotion Studio (REMOTION_STUDIO_BIN) so no bundler or browser is involved: node --test toolchain/test_viewer.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms))

// Studio, played by a script: what it was started with goes to $STUB_STUDIO_CONTROL/starts, and
// $STUB_STUDIO_CONTROL/mode says how this start goes — exit (code 3), kill (a signal), serve, or stubborn
// (serve, but ignore the first SIGTERM).
const STUDIO = `#!/usr/bin/env node
import { createServer } from 'node:http'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const control = process.env.STUB_STUDIO_CONTROL
let mode = 'serve'
try { mode = readFileSync(control + '/mode', 'utf8').trim() } catch {}
appendFileSync(control + '/starts', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), nodeOptions: process.env.NODE_OPTIONS, browser: process.env.BROWSER }) + '\\n')
if (mode === 'exit') { console.log('Studio could not start'); process.exit(3) }
if (mode === 'kill') process.kill(process.pid, 'SIGKILL')
let terms = 0
process.on('SIGTERM', () => { writeFileSync(control + '/stopped', String(++terms)); if (mode !== 'stubborn' || terms > 1) process.exit(0) })
for (let i = 0; i < 45; i++) console.error('\\x1b[90mwebpack line ' + i + '\\x1b[39m')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const server = createServer((req, res) => {
  if (req.url === '/destroy') { req.socket.destroy(); return }
  if (req.url === '/reset') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial'); setTimeout(() => req.socket.resetAndDestroy(), 100); return }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain', 'x-studio': 'stub' }); res.end(req.method + ' ' + req.url + ' ' + body) })
})
server.listen(port, () => { writeFileSync(control + '/address', server.address().address); console.log('Server ready - Local: http://localhost:' + port + ', Network: none') })
`

function scratch(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(root, rel, body = 'x', mtimeSeconds) {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
  if (mtimeSeconds !== undefined) utimesSync(file, mtimeSeconds, mtimeSeconds)
  return file
}

function freePort() {
  return new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
}

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      res.on('error', fail)
    })
    req.on('error', fail)
    req.end(body)
  })
}

async function until(check, { timeout = 15_000, every = 50 } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await check().catch(() => undefined)
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${check}`)
    await wait(every)
  }
}

const state = async (v) => JSON.parse((await request(v.port, '/__harness/state')).body)

async function startViewer(t, { workspace, mode, env = {} }) {
  const control = scratch(t, 'remotion-studio-')
  const stub = join(control, 'studio.mjs')
  writeFileSync(stub, STUDIO)
  chmodSync(stub, 0o755)
  if (mode) writeFileSync(join(control, 'mode'), mode)
  const port = await freePort()
  const child = spawn(process.execPath, [join(PKG, 'viewer.mjs')], {
    env: { ...process.env, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: workspace, REMOTION_STUDIO_BIN: stub, STUB_STUDIO_CONTROL: control, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const exited = new Promise((ok) => child.on('exit', (code, signal) => ok({ code, signal })))
  const viewer = {
    port, child, control, exited,
    output: () => output,
    starts: () => (existsSync(join(control, 'starts')) ? readFileSync(join(control, 'starts'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    mode: (m) => writeFileSync(join(control, 'mode'), m),
    stop: async (signal = 'SIGTERM') => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); return exited },
  }
  t.after(() => viewer.stop())
  await until(() => request(port, '/__harness/state'))
  return viewer
}

function events(t, port) {
  const seen = []
  const waiters = []
  let buffer = ''
  const req = http.get({ host: '127.0.0.1', port, path: '/__harness/events', agent: false }, (res) => {
    res.on('data', (chunk) => {
      buffer += chunk
      let i
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, i)
        buffer = buffer.slice(i + 2)
        const data = /^data: (.*)$/m.exec(block)
        const item = block.startsWith(':') ? { comment: block } : { event: /^event: (.*)$/m.exec(block)?.[1], data: data && JSON.parse(data[1]) }
        seen.push(item)
        for (const w of [...waiters]) if (w.match(item)) { waiters.splice(waiters.indexOf(w), 1); w.ok(item) }
      }
    })
  })
  req.on('error', () => {})
  const stream = {
    seen,
    next: (match, timeout = 10_000) => new Promise((ok, fail) => {
      const found = seen.find(match)
      if (found) { seen.splice(seen.indexOf(found), 1); return ok(found) }
      const w = { match: (item) => { if (!match(item)) return false; seen.splice(seen.indexOf(item), 1); return true }, ok }
      waiters.push(w)
      setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`no matching event in ${timeout} ms; seen ${JSON.stringify(seen)}`)) } }, timeout)
    }),
    close: () => req.destroy(),
  }
  t.after(stream.close)
  return stream
}

describe('the Remotion pane', { concurrency: true }, () => {
  test('starts Studio on the entry point, on loopback, restarts it when it dies and proxies it once it is ready', async (t) => {
    const ws = scratch(t, 'remotion-ws-')
    write(ws, 'src/index.tsx', 'registerRoot(Root)')
    const v = await startViewer(t, { workspace: ws, mode: 'exit' })

    // Studio exits at once: the pane says so and keeps answering while it waits to restart.
    const stopped = await until(async () => { const s = await state(v); return s.studio.state === 'stopped' && s })
    assert.deepEqual(stopped.studio.log, ['Studio could not start', 'Remotion Studio exited (3).'])
    const html = await request(v.port, '/', { headers: { accept: 'text/html,application/xhtml+xml' } })
    assert.equal(html.status, 503)
    assert.match(html.headers['content-type'], /^text\/html/)
    assert.equal(html.headers['retry-after'], '1')
    assert.match(html.body, /Starting Remotion Studio…/)
    const plain = await request(v.port, '/api/anything')
    assert.deepEqual([plain.status, plain.headers['content-type'], plain.body], [503, 'text/plain', 'Studio is starting'])

    // Killed by a signal on the next start, then up for good.
    v.mode('kill')
    await until(async () => (await state(v)).studio.log.includes('Remotion Studio exited (signal).'))
    v.mode('serve')
    const ready = await until(async () => { const s = await state(v); return s.studio.state === 'ready' && s }, { timeout: 20_000 })
    assert.deepEqual(ready.studio.log, [], 'a ready Studio shows no log')

    const starts = v.starts()
    assert.equal(starts.length, 3)
    const { args, cwd, nodeOptions, browser } = starts[2]
    assert.deepEqual([args[0], args[1], args[3], args[4]], ['studio', '--port', '--no-open', 'src/index.tsx'])
    assert.equal(cwd, ws)
    assert.equal(browser, 'none')
    assert.ok(nodeOptions.includes(`--require ${JSON.stringify(join(PKG, 'toolchain', 'loopback.cjs'))}`), nodeOptions)
    assert.equal(readFileSync(join(v.control, 'address'), 'utf8'), '127.0.0.1', 'loopback.cjs kept a host-less listen() on loopback')
    assert.equal(readlinkSync(join(ws, 'node_modules')), join(PKG, 'node_modules'), 'the shared node_modules is linked in')
    assert.ok(existsSync(join(ws, 'out')))

    const get = await request(v.port, '/hello?x=1')
    assert.deepEqual([get.status, get.headers['x-studio'], get.body], [200, 'stub', 'GET /hello?x=1 '])
    const post = await request(v.port, '/echo', { method: 'POST', body: 'abc' })
    assert.equal(post.body, 'POST /echo abc')
    assert.deepEqual(await request(v.port, '/destroy').then((r) => [r.status, r.body]), [502, 'Studio did not answer'])
    const reset = await request(v.port, '/reset')
    assert.deepEqual([reset.status, reset.body], [200, 'partial'], 'a Studio that dies mid-response ends the response instead of hanging it')

    assert.deepEqual(await v.stop(), { code: 0, signal: null })
    assert.equal(readFileSync(join(v.control, 'stopped'), 'utf8'), '1', 'Studio is stopped with the pane')
  })

  test('a pinned Studio port, the default entry point, and a workspace that does not exist yet', async (t) => {
    const ws = join(scratch(t, 'remotion-missing-'), 'not-yet')
    const studioPort = await freePort()
    const v = await startViewer(t, { workspace: ws, env: { REMOTION_STUDIO_PORT: String(studioPort) } })
    await until(async () => (await state(v)).studio.state === 'ready')
    assert.deepEqual(v.starts()[0].args, ['studio', '--port', String(studioPort), '--no-open', 'src/index.ts'])
    assert.match(v.output(), /\[remotion pane\] watch failed: /)
    assert.ok(existsSync(join(ws, 'out')), 'out/ is made, and the workspace with it')
    const s = await state(v)
    assert.deepEqual([s.renders, s.job, s.compositions, s.active], [[], null, [], null])
    assert.deepEqual(await v.stop('SIGHUP'), { code: 0, signal: null })
  })

  test('Studio that is not installed leaves the pane up, saying so', async (t) => {
    // The package's own node_modules/.bin/remotion unless it is installed here; then a path that is not.
    const installed = existsSync(join(PKG, 'node_modules', '.bin', 'remotion'))
    const env = installed ? { REMOTION_STUDIO_BIN: join(scratch(t, 'remotion-none-'), 'remotion') } : { REMOTION_STUDIO_BIN: '' }
    const v = await startViewer(t, { workspace: scratch(t, 'remotion-ws-'), env })
    const s = await until(async () => { const s = await state(v); return s.studio.state === 'stopped' && s })
    assert.match(s.studio.log[0], /^Remotion Studio could not start: spawn .*remotion ENOENT\.$/)
    assert.equal((await request(v.port, '/')).status, 503)
    assert.deepEqual(await v.stop(), { code: 0, signal: null })
  })

  test('a Studio that ignores the first SIGTERM is asked again as the pane exits', async (t) => {
    const v = await startViewer(t, { workspace: scratch(t, 'remotion-ws-'), mode: 'stubborn' })
    await until(async () => (await state(v)).studio.state === 'ready')
    assert.deepEqual(await v.stop(), { code: 0, signal: null })
    await until(async () => readFileSync(join(v.control, 'stopped'), 'utf8') === '2', { timeout: 5_000 })
  })

  test('stopping while Studio waits to restart does not start it again', async (t) => {
    const ws = scratch(t, 'remotion-ws-')
    const v = await startViewer(t, { workspace: ws, mode: 'exit' })
    await until(async () => (await state(v)).studio.state === 'stopped')
    v.mode('serve')
    assert.deepEqual(await v.stop('SIGINT'), { code: 0, signal: null })
    await wait(1200)
    assert.equal(v.starts().length, 1)
  })

  test('state: the renders in out/, whether they are stale, the render job, and the compositions', async (t) => {
    const ws = scratch(t, 'remotion-ws-')
    symlinkSync(join(ws, 'nowhere'), join(ws, 'node_modules'))           // a link already there is left alone
    const v = await startViewer(t, { workspace: ws })
    assert.equal(readlinkSync(join(ws, 'node_modules')), join(ws, 'nowhere'))

    write(ws, 'src/Main.tsx', 'export const Main = () => null', 1_000)
    symlinkSync(join(ws, 'gone.tsx'), join(ws, 'src', 'dangling.tsx'))   // unreadable sources are skipped
    write(ws, 'out/main.mp4', 'video', 2_000)                             // newer than src/
    write(ws, 'out/anim.gif', 'gif', 900)                                 // older than src/ by 100 s: stale
    write(ws, 'out/frame.png', 'png', 800)
    write(ws, 'out/voice.mp3', 'mp3', 700)
    write(ws, 'out/notes.txt', 'text', 3_000)                             // not media
    write(ws, 'out/empty.mp4', '', 3_000)                                 // still being written
    write(ws, 'out/.partial.mp4', 'x', 3_000)                             // hidden
    write(ws, 'out/node_modules/cache.mp4', 'x', 3_000)
    write(ws, 'out/a/b/c/d/deep.mp4', 'deep', 600)                        // four folders down: found
    write(ws, 'out/a/b/c/d/e/deeper.mp4', 'x', 3_000)                     // five: not walked
    symlinkSync(join(ws, 'missing.mp4'), join(ws, 'out', 'broken.mp4'))
    let s = await state(v)
    assert.deepEqual(s.renders.map((r) => [r.path, r.kind, r.size, r.stale]), [
      ['out/main.mp4', 'video', 5, false],
      ['out/anim.gif', 'gif', 3, true],
      ['out/frame.png', 'image', 3, true],
      ['out/voice.mp3', 'audio', 3, true],
      ['out/a/b/c/d/deep.mp4', 'video', 4, true],
    ])
    assert.equal(s.renders[0].name, 'main.mp4')
    assert.equal(s.job, null)

    // A running job whose process is gone was interrupted; one still alive, or with no pid, is running.
    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise((ok) => dead.on('exit', ok))
    write(ws, '.harness/render.json', JSON.stringify({ state: 'running', pid: dead.pid, progress: 0.4 }))
    assert.equal((await state(v)).job.state, 'interrupted')
    write(ws, '.harness/render.json', JSON.stringify({ state: 'running', pid: process.pid }))
    assert.equal((await state(v)).job.state, 'running')
    write(ws, '.harness/render.json', JSON.stringify({ state: 'running' }))
    assert.equal((await state(v)).job.state, 'running')
    write(ws, '.harness/render.json', JSON.stringify({ state: 'done', pid: dead.pid }))
    assert.equal((await state(v)).job.state, 'done')
    write(ws, '.harness/render.json', '{ half written')
    assert.equal((await state(v)).job, null)

    // Compositions as Root registers them; the one whose component file changed last is active.
    write(ws, 'src/Root.tsx', `import React from "react";
import { Composition, Still } from "remotion";
import { Main, Other as Renamed, } from "./Main";
import Intro from './scenes/Intro'
import { Missing } from "./Missing";
import { Folder } from "./folder";
export const Root = () => (<>
  <Composition id="Main" component={Main} durationInFrames={30} fps={30} width={1920} height={1080} />
  <Composition
    id='Intro'
    component={Intro}
  />
  <Still id={\`Poster\`} component={Renamed} />
  <Composition id={"Gone"} component={Missing} />
  <Composition id={ 'Dir' } component={Folder} />
  <Composition id="Inline" component={() => null} />
  <Composition component={Main} />
</>)`, 1_000)
    write(ws, 'src/scenes/Intro.tsx', 'export default () => null', 5_000)
    write(ws, 'src/folder/index.ts', 'export const Folder = () => null', 4_000)
    s = await state(v)
    assert.deepEqual(s.compositions, ['Main', 'Intro', 'Poster', 'Gone', 'Dir', 'Inline'])
    assert.equal(s.active, 'Intro')
    write(ws, 'src/folder/index.ts', 'export const Folder = () => null', 6_000)
    assert.equal((await state(v)).active, 'Dir', 'a component that is a folder resolves to its index')

    rmSync(join(ws, 'src', 'Root.tsx'))
    write(ws, 'src/Root.jsx', '<Still id="Only" component={Nothing} />')
    assert.deepEqual((await state(v)).compositions, ['Only'])
    rmSync(join(ws, 'src', 'Root.jsx'))
    mkdirSync(join(ws, 'src', 'Root.ts'))                                 // exists, but cannot be read
    assert.deepEqual((await state(v)).compositions, [])
    assert.equal((await state(v)).active, null)
  })

  test('media: whole files, byte ranges and HEAD for the renders tab, and nothing outside the workspace', async (t) => {
    const ws = scratch(t, 'remotion-ws-')
    write(ws, 'out/clip.mp4', '0123456789')
    write(ws, 'out/notes.txt', 'text')
    mkdirSync(join(ws, 'out', 'folder.mp4'))
    write(ws, 'out/My Launch 100%.webm', 'webm')
    const v = await startViewer(t, { workspace: ws })
    const media = (path, opts) => request(v.port, `/__harness/media/${path}`, opts)

    const whole = await media('out/clip.mp4')
    assert.deepEqual([whole.status, whole.body, whole.headers['content-type'], whole.headers['content-length'], whole.headers['accept-ranges']], [200, '0123456789', 'video/mp4', '10', 'bytes'])
    const head = await media('out/clip.mp4', { method: 'HEAD' })
    assert.deepEqual([head.status, head.body, head.headers['content-length']], [200, '', '10'])
    assert.equal((await media('out/My%20Launch%20100%25.webm')).body, 'webm')

    const range = async (value, method) => { const r = await media('out/clip.mp4', { method, headers: { range: value } }); return [r.status, r.body, r.headers['content-range'] ?? null] }
    assert.deepEqual(await range('bytes=2-5'), [206, '2345', 'bytes 2-5/10'])
    assert.deepEqual(await range('bytes=7-'), [206, '789', 'bytes 7-9/10'])
    assert.deepEqual(await range('bytes=-3'), [206, '789', 'bytes 7-9/10'])
    assert.deepEqual(await range('bytes=-30'), [206, '0123456789', 'bytes 0-9/10'])
    assert.deepEqual(await range('bytes=4-400'), [206, '456789', 'bytes 4-9/10'])
    assert.deepEqual(await range('bytes=20-'), [416, '', 'bytes */10'])
    assert.deepEqual(await range('bytes=2-5', 'HEAD'), [206, '', 'bytes 2-5/10'])
    assert.deepEqual(await range('bytes=-'), [200, '0123456789', null])
    assert.deepEqual(await range('items=1-2'), [200, '0123456789', null])

    for (const path of ['out/missing.mp4', 'out/notes.txt', '', '..%2F..%2Fetc%2Fhosts.mp4', 'out/folder.mp4']) {
      assert.equal((await media(path)).status, 404, path)
    }
    assert.equal((await media('out/%E0%A4%A.mp4')).status, 400, 'a malformed escape is a bad request')
    assert.equal((await request(v.port, '/__harness/state')).status, 200, 'and the pane is still up')

    for (const path of ['/__harness', '/__harness/']) {
      const page = await request(v.port, path)
      assert.deepEqual([page.status, page.headers['content-type']], [200, 'text/html; charset=utf-8'])
      assert.equal(page.body, readFileSync(join(PKG, 'viewer.html'), 'utf8'))
    }
  })

  test('events: the state on connect, again when src/, out/ or the render job change, and when a render dies', async (t) => {
    const ws = scratch(t, 'remotion-ws-')
    mkdirSync(join(ws, 'node_modules'))                                  // its own, so not linked
    const v = await startViewer(t, { workspace: ws })
    const stream = events(t, v.port)
    const first = await stream.next((e) => e.event === 'state')
    assert.deepEqual(first.data.renders, [])

    write(ws, 'src/Root.tsx', '<Composition id="Main" component={Main} />')
    write(ws, 'src/Root.tsx', '<Composition id="Main" component={Main} /><Composition id="Two" component={Main} />')
    assert.deepEqual((await stream.next((e) => e.data?.compositions?.length === 2)).data.compositions, ['Main', 'Two'])
    write(ws, 'out/main.mp4', 'video')
    await stream.next((e) => e.data?.renders?.length === 1)

    // A render whose process is killed never writes its own end: the slow tick notices.
    const renderer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    t.after(() => renderer.kill())
    write(ws, '.harness/render.json', JSON.stringify({ state: 'running', pid: renderer.pid, progress: 0.5 }))
    assert.equal((await stream.next((e) => e.data?.job?.state === 'running')).data.job.progress, 0.5)
    renderer.kill('SIGKILL')
    await stream.next((e) => e.data?.job?.state === 'interrupted', 5_000)

    // Dependencies, git and anything else in the workspace are not the pane's business.
    const before = stream.seen.filter((e) => e.event).length
    write(ws, 'node_modules/remotion/index.js', 'x')
    write(ws, '.git/HEAD', 'ref')
    write(ws, 'README.md', 'x')
    await wait(2_500)
    assert.equal(stream.seen.filter((e) => e.event).length, before, JSON.stringify(stream.seen))
  })

  test('a ping every 20 seconds keeps the event stream open', { timeout: 40_000 }, async (t) => {
    const v = await startViewer(t, { workspace: scratch(t, 'remotion-ws-') })
    const stream = events(t, v.port)
    await stream.next((e) => e.event === 'state')
    assert.deepEqual(await stream.next((e) => e.comment === ': ping', 25_000), { comment: ': ping' })
  })
})

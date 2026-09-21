// node --test test/ — the pane's server (viewer.mjs) on a real Vite, over a tiny workspace.
//
// Needs the package's node_modules (toolchain/setup.sh); skips without it. The workspace is reached
// through a symlink, as a workspace under /tmp or a linked folder is. Its own vite.config.mjs adds a
// test route that sends payloads through Vite's hot channel the way any plugin can, so every shape
// the frame is told about is checked, alongside the reloads, updates and errors Vite makes itself.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const HAS_VITE = existsSync(join(PKG, 'node_modules', 'vite', 'package.json'))

const CONFIG = `
export default {
  cacheDir: '.vite',
  logLevel: 'silent',
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: 'test-seam',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        try {
          if (url.pathname === '/__test/send') server.environments.client.hot.send(...JSON.parse(url.searchParams.get('args')))
          else if (url.pathname === '/__test/watch') server.watcher.add(url.searchParams.get('path'))
          else return next()
          res.end('ok')
        } catch (error) { res.statusCode = 500; res.end(String(error)) }
      })
    },
  }],
}
`

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
  })
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject)
  })
}

/** An EventSource, by hand: every `event:` block parsed, every `:` comment kept. */
function stream(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__harness/events' }, (res) => {
      const client = { headers: res.headers, events: [], comments: [], close: () => req.destroy() }
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, i)
          buffer = buffer.slice(i + 2)
          if (block.startsWith(':')) client.comments.push(block)
          else client.events.push({ event: /^event: (.*)$/m.exec(block)[1], data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) })
        }
      })
      resolve(client)
    })
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error) })
  })
}

async function waitFor(check, what, ms = 10_000) {
  const start = Date.now()
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

describe('viewer.mjs', { skip: !HAS_VITE && 'no node_modules — run toolchain/setup.sh' }, () => {
  let root, real, ws, outside, port, child, output = '', exited, events, pinged

  const send = (...args) => get(port, `/__test/send?args=${encodeURIComponent(JSON.stringify(args))}`)
  const after_ = (n) => events.events.slice(n)
  /** Send, then a sentinel reload, and return what the frame was told in between. */
  async function told(...args) {
    const mark = events.events.length
    await send(...args)
    await send({ type: 'full-reload', path: '/sentinel' })
    await waitFor(() => after_(mark).some((e) => e.data.path === '/sentinel'), 'the sentinel')
    return after_(mark).filter((e) => e.data.path !== '/sentinel')
  }

  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'phaser-viewer-')))
    real = join(root, 'game')
    ws = join(root, 'game-link')
    outside = join(root, 'shared')
    const files = {
      'index.html': '<!doctype html>\n<html><head><title>game</title></head><body><script type="module" src="/src/main.js"></script></body></html>\n',
      'vite.config.mjs': CONFIG,
      'src/main.js': 'export const main = 1\n',
      'src/hot.js': 'export const hot = 1\nif (import.meta.hot) import.meta.hot.accept()\n',
      'src/broken.js': "import missing from 'missing-module'\nexport default missing\n",
      'src/100%.js': 'export const percent = 100\n',
      'src/data.bin': 'binary',
      'src/big.json': `"${'x'.repeat(2_000_001)}"`,
      '..odd.js': 'export const odd = 1\n',
      // A stand-in Phaser for the probe to import. Never the package's real node_modules: Vite writes
      // its bundled config into the workspace's node_modules/.vite-temp, and that install is shared.
      'node_modules/phaser/package.json': '{ "name": "phaser", "version": "0.0.0", "type": "module", "main": "index.js" }\n',
      'node_modules/phaser/index.js': 'export default { Game: class {} }\n',
    }
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(real, rel)), { recursive: true })
      writeFileSync(join(real, rel), text)
    }
    mkdirSync(join(real, 'src', 'folder.js'))
    mkdirSync(outside)
    writeFileSync(join(outside, 'lib.js'), 'export const shared = 1\n')
    symlinkSync(real, ws)

    port = await freePort()
    child = spawn(process.execPath, [join(PKG, 'viewer.mjs')], {
      env: { ...process.env, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: ws },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (c) => { output += c })
    child.stderr.on('data', (c) => { output += c })
    exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
    await waitFor(() => output.includes('listening on'), 'the viewer to listen', 30_000)
    events = await stream(port)
    await waitFor(() => events.events.length, 'hello')
    // The keep-alive comes every 20 s; start waiting now so the suite pays for it once.
    pinged = waitFor(() => events.comments.length, 'a keep-alive ping', 30_000)
  })

  after(async () => {
    events?.close()
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await exited }
    rmSync(root, { recursive: true, force: true })
  })

  test('says where it listens and greets each stream with the workspace name', () => {
    assert.match(output, new RegExp(`\\[phaser\\] listening on http://127\\.0\\.0\\.1:${port}/ \\(workspace: `))
    assert.equal(events.headers['content-type'], 'text/event-stream')
    assert.equal(events.headers['cache-control'], 'no-store')
    assert.deepEqual(events.events[0].event, 'hello')
    assert.match(events.events[0].data.workspace, /^game(-link)?$/)
  })

  test('/ is the frame; /?game is the game page with the guard first and the probe injected', async () => {
    const frame = await get(port, '/')
    assert.equal(frame.status, 200)
    assert.equal(frame.type, 'text/html; charset=utf-8')
    assert.equal(frame.body, readFileSync(join(PKG, 'viewer', 'frame.html'), 'utf8'))

    const game = await get(port, '/?game')
    assert.equal(game.status, 200)
    const guard = readFileSync(join(PKG, 'viewer', 'guard.js'), 'utf8')
    assert.ok(game.body.includes(guard.trim()), 'the guard is inlined')
    assert.ok(game.body.indexOf(guard.trim()) < game.body.indexOf('<title>'), 'the guard runs before anything in <head>')
    assert.match(game.body, /<script type="module" src="\/@harness\/probe\.js"><\/script>/)
  })

  test('the probe module is served from the frame, never from the workspace', async () => {
    const probe = await get(port, '/@harness/probe.js')
    assert.equal(probe.status, 200)
    assert.match(probe.body, /__harnessPatched/)
  })

  test('/__harness/<asset> serves the frame\'s own files and nothing else', async () => {
    const css = await get(port, '/__harness/frame.css')
    assert.equal(css.status, 200)
    assert.equal(css.type, 'text/css; charset=utf-8')
    assert.equal((await get(port, '/__harness/frame.js')).type, 'text/javascript; charset=utf-8')
    for (const path of ['/__harness/', '/__harness/missing.js', '/__harness/logo.png', '/__harness/..%2Fviewer.mjs']) {
      assert.equal((await get(port, path)).status, 404, path)
    }
    // An encoded `..` is collapsed by the URL parser: the request leaves /__harness/ and Vite answers
    // with the game page, as it does for any unknown path — never with the server's own files.
    const escape = await get(port, '/__harness/%2e%2e/viewer.mjs')
    assert.doesNotMatch(escape.body, /createServer/)
    assert.match(escape.body, /<title>game<\/title>/)
  })

  test('/__harness/source reads workspace source files, however the error named them', async () => {
    const main = 'export const main = 1\n'
    for (const path of [
      'src/main.js',
      `http://127.0.0.1:${port}/src/main.js?t=123#L1`,
      `/@fs${real}/src/main.js`,
    ]) {
      const res = await get(port, `/__harness/source?path=${encodeURIComponent(path)}`)
      assert.deepEqual([res.status, res.type, res.body], [200, 'text/plain; charset=utf-8', main], path)
    }
    // A name with a percent sign: the query decodes once, and the file is still found.
    const percent = await get(port, `/__harness/source?path=${encodeURIComponent('src/100%.js')}`)
    assert.deepEqual([percent.status, percent.body], [200, 'export const percent = 100\n'])
  })

  test('/__harness/source refuses what is not a workspace source file', async () => {
    for (const path of [null, '../shared/lib.js', `${outside}/lib.js`, 'src/data.bin', 'src/missing.js', 'src/folder.js', 'src/big.json']) {
      const query = path === null ? '' : `?path=${encodeURIComponent(path)}`
      assert.equal((await get(port, `/__harness/source${query}`)).status, 404, String(path))
    }
  })

  test('a file saved in the workspace is a change; output, the verdict and files outside are not', async () => {
    await get(port, `/__test/watch?path=${encodeURIComponent(join(outside, 'lib.js'))}`)
    await sleep(300)
    const mark = events.events.length
    writeFileSync(join(outside, 'lib.js'), 'export const shared = 2\n')
    mkdirSync(join(ws, 'out'), { recursive: true })
    writeFileSync(join(ws, 'out', 'bundle.js'), '1')
    mkdirSync(join(ws, '.harness'), { recursive: true })
    writeFileSync(join(ws, '.harness', 'verdict.json'), '{}')
    await sleep(300)
    writeFileSync(join(ws, 'src', 'added.js'), 'export const added = 1\n')
    await waitFor(() => after_(mark).some((e) => e.event === 'change' && e.data.file === 'src/added.js'), 'the change')
    await sleep(500)
    const changes = after_(mark).filter((e) => e.event === 'change').map((e) => e.data)
    assert.deepEqual(changes, [{ event: 'add', file: 'src/added.js' }])
  })

  test('a workspace file whose name starts with two dots is still a workspace file', async () => {
    const mark = events.events.length
    writeFileSync(join(ws, '..odd.js'), 'export const odd = 2\n')
    const change = await waitFor(() => after_(mark).find((e) => e.event === 'change'), 'the change')
    assert.deepEqual(change.data, { event: 'change', file: '..odd.js' })
  })

  test('a module with no HMR boundary reloads the page, named by its workspace path', async () => {
    assert.equal((await get(port, '/src/main.js')).status, 200)
    const mark = events.events.length
    writeFileSync(join(ws, 'src', 'main.js'), 'export const main = 2\n')
    const reload = await waitFor(() => after_(mark).find((e) => e.event === 'reload'), 'the reload')
    assert.deepEqual(reload.data, { file: 'src/main.js', path: null })
  })

  test('a self-accepting module is an update', async () => {
    assert.equal((await get(port, '/src/hot.js')).status, 200)
    const mark = events.events.length
    writeFileSync(join(ws, 'src', 'hot.js'), 'export const hot = 2\nif (import.meta.hot) import.meta.hot.accept()\n')
    const update = await waitFor(() => after_(mark).find((e) => e.event === 'update'), 'the update')
    assert.deepEqual(update.data, { files: ['src/hot.js'] })
  })

  test('an import that does not resolve is a build error with its workspace file, line and frame', async () => {
    const mark = events.events.length
    assert.equal((await get(port, '/src/broken.js')).status, 500)
    const error = await waitFor(() => after_(mark).find((e) => e.event === 'build-error'), 'the build error')
    assert.equal(error.data.file, 'src/broken.js')
    assert.equal(error.data.line, 1)
    assert.equal(error.data.plugin, 'vite:import-analysis')
    assert.match(error.data.message, /missing-module/)
    assert.match(error.data.frame, /import missing/)
    assert.doesNotMatch(error.data.message + error.data.frame, /\x1b/)
    const source = await get(port, `/__harness/source?path=${encodeURIComponent(error.data.file)}`)
    assert.equal(source.status, 200, 'the frame can show the code around the error')
  })

  test('payload shapes other plugins send', async () => {
    assert.deepEqual(await told({ type: 'full-reload' }), [{ event: 'reload', data: { file: null, path: null } }])
    assert.deepEqual(await told({ type: 'update' }), [{ event: 'update', data: { files: [] } }])
    assert.deepEqual(await told({ type: 'update', updates: [{ path: '/src/a.js?t=1' }, { path: 'src/a.js' }, {}] }),
      [{ event: 'update', data: { files: ['src/a.js', null] } }])
    assert.deepEqual(await told({ type: 'error', err: { message: '\x1b[31mboom\x1b[39m', id: `${real}/src/x.js?import`, frame: '\x1b[33m> 1 |\x1b[39m', plugin: 'p' } }),
      [{ event: 'build-error', data: { message: 'boom', file: 'src/x.js', line: null, column: null, frame: '> 1 |', plugin: 'p' } }])
    assert.deepEqual(await told({ type: 'error', err: { message: 'm', loc: { file: join(outside, 'lib.js'), line: 3, column: 4 } } }),
      [{ event: 'build-error', data: { message: 'm', file: join(outside, 'lib.js'), line: 3, column: 4, frame: '', plugin: null } }])
    assert.deepEqual(await told({ type: 'error' }),
      [{ event: 'build-error', data: { message: 'Build error', file: null, line: null, column: null, frame: '', plugin: null } }])
    // Custom events, junk, and a payload that breaks the reader: the frame hears nothing, Vite still sends.
    assert.deepEqual(await told('my-plugin:event', { a: 1 }), [])
    assert.deepEqual(await told({ type: 'connected' }), [])
    assert.deepEqual(await told({ type: 'update', updates: [null] }), [])
    assert.deepEqual(await told(null), [])
  })

  test('a stream that closes is forgotten', async () => {
    const second = await stream(port)
    await waitFor(() => second.events.length, 'hello on the second stream')
    second.close()
    await sleep(200)
    assert.deepEqual(await told({ type: 'full-reload', path: '/after-close' }), [{ event: 'reload', data: { file: null, path: '/after-close' } }])
  })

  test('keeps each stream alive with a comment ping', async () => {
    await pinged
    assert.equal(events.comments[0], ': ping')
  })

  // SIGTERM is Vite's own (it closes and exits 143); Ctrl-C in a terminal is the viewer's.
  test('stops cleanly on SIGINT', async () => {
    child.kill('SIGINT')
    assert.deepEqual(await exited, { code: 0, signal: null })
  })
})

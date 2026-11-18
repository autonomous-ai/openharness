// node --test store/tools/local-daemon.test.mjs
// The small WebSocket and fetch every Store package reaches the daemon with, against raw frames on a real Unix socket.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWebSocket, daemonDataDir, daemonFetch, daemonSocketPath, harnessRoots, socketIsPrivate } from './local-daemon.mjs'
import { removeTempFolders, tempFolder } from './test-folders.mjs'

const closers = []
after(async () => { try { for (const close of closers) await close() } finally { removeTempFolders() } })
const PORT = 4242

/** A daemon on a private socket: `upgrade(socket, unmaskedFramesSeen)`, and `rest` for plain requests. */
async function daemon({ upgrade, rest, accept } = {}) {
  const dir = tempFolder('ld-')
  chmodSync(dir, 0o700)
  const sockets = new Set(), seen = []
  const server = createServer(rest ?? ((_req, res) => res.writeHead(404).end()))
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('error', () => {})
    const good = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept ?? good}\r\n\r\n`)
    let held = Buffer.alloc(0)
    socket.on('data', chunk => {
      held = Buffer.concat([held, chunk])
      while (held.length >= 6) {
        const short = held[1] & 0x7f, start = short === 126 ? 4 : 2, size = short === 126 ? held.readUInt16BE(2) : short
        assert.ok(held[1] & 0x80, 'a client masks every frame')
        if (held.length < start + 4 + size) break
        const mask = held.subarray(start, start + 4), body = Buffer.from(held.subarray(start + 4, start + 4 + size))
        for (let i = 0; i < size; i++) body[i] ^= mask[i % 4]
        seen.push({ opcode: held[0] & 0x0f, body })
        held = held.subarray(start + 4 + size)
      }
    })
    upgrade?.(socket, seen)
  })
  const path = join(dir, `daemon-${PORT}.sock`)
  await new Promise(ready => server.listen(path, ready))
  chmodSync(path, 0o600)
  closers.push(() => new Promise(done => { for (const s of sockets) s.destroy(); server.closeAllConnections(); server.close(() => done()) }))
  return { env: { ADAPTER_DATA_DIR: dir }, path, seen }
}

const URL_ = `ws://127.0.0.1:${PORT}/api/local-ws`
const open = (env) => new DaemonWebSocket(URL_, { env })
const once = (socket, type) => new Promise(resolve => socket.addEventListener(type, resolve, { once: true }))
const eventually = async (check) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)) } assert.fail('timed out') }
const frame = (opcode, body, fin = true) => {
  const data = Buffer.from(body)
  const head = data.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, data.length]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 126, data.length >> 8, data.length & 255])
  return Buffer.concat([head, data])
}

test('a message arrives whole, however the bytes are cut, and in pieces of a fragmented one', async () => {
  const whole = frame(1, 'x'.repeat(300))
  const d = await daemon({ upgrade: socket => {
    socket.write(whole.subarray(0, 1)); setTimeout(() => socket.write(whole.subarray(1, 3)), 5); setTimeout(() => socket.write(whole.subarray(3)), 10)
    setTimeout(() => { socket.write(frame(1, 'he', false)); socket.write(frame(0, 'llo')) }, 20)
  } })
  const socket = open(d.env), got = []
  socket.addEventListener('message', event => got.push(event.data))
  await eventually(() => got.length === 2)
  assert.deepEqual(got, ['x'.repeat(300), 'hello'])
  socket.close()
})

test('frames sent with the upgrade answer are not lost', async () => {
  const d = await daemon({ upgrade: socket => socket.write(frame(1, 'first')) })
  const socket = open(d.env), got = []
  socket.addEventListener('message', event => got.push(event.data))
  await eventually(() => got.length === 1)
  socket.close()
})

test('send masks, a ping gets a pong, and a server close reaches the caller with its code', async () => {
  const d = await daemon({ upgrade: socket => setTimeout(() => socket.write(frame(9, 'beat')), 5) })
  const socket = open(d.env)
  await once(socket, 'open')
  socket.send('hello')
  await eventually(() => d.seen.length >= 2)
  assert.deepEqual(d.seen.map(f => [f.opcode, f.body.toString()]).sort(), [[1, 'hello'], [10, 'beat']])
  socket.close()
})

test('a close code from the daemon, such as an unlinked machine, is what the caller reads', async () => {
  const code = Buffer.alloc(2); code.writeUInt16BE(4404)
  const d = await daemon({ upgrade: socket => setTimeout(() => socket.write(frame(8, code)), 5) })
  const closed = await once(open(d.env), 'close')
  assert.equal(closed.code, 4404)
})

test('a dropped connection closes, and sending then throws rather than vanishing', async () => {
  const d = await daemon({ upgrade: socket => setTimeout(() => socket.destroy(), 5) })
  const socket = open(d.env)
  const closed = await once(socket, 'close')
  assert.equal(closed.code, 1006)
  assert.throws(() => socket.send('late'))
})

test('a frame past the limit closes without being held', async () => {
  const huge = Buffer.alloc(10); huge[0] = 0x81; huge[1] = 127; huge.writeBigUInt64BE(1n << 40n, 2)
  const d = await daemon({ upgrade: socket => socket.write(huge) })
  assert.equal((await once(open(d.env), 'close')).code, 1009)
})

test('no socket, one anyone can reach, a wrong accept and a refusal are each an error, then a close', async () => {
  const dir = tempFolder('ld-'); chmodSync(dir, 0o700)
  for (const socket of [open({ ADAPTER_DATA_DIR: dir })]) { const failed = once(socket, 'error'); await once(socket, 'close'); await failed }
  const open_ = await daemon(); chmodSync(open_.path, 0o666)
  assert.equal(socketIsPrivate(open_.path), false)
  await once(open(open_.env), 'error')
  await once(open((await daemon({ accept: 'wrong' })).env), 'error')
})

test('a socket in a folder others can write to is not private, and a symlink is not a socket', async () => {
  const d = await daemon()
  assert.equal(socketIsPrivate(d.path), true)
  chmodSync(join(d.path, '..'), 0o777)
  assert.equal(socketIsPrivate(d.path), false)
  chmodSync(join(d.path, '..'), 0o700)
  writeFileSync(`${d.path}.plain`, '')
  assert.equal(socketIsPrivate(`${d.path}.plain`), false)
})

test('close() gives up on a daemon that never answers it', async () => {
  const d = await daemon()
  const socket = open(d.env)
  await once(socket, 'open')
  socket.close()
  assert.equal((await once(socket, 'close')).code, 1006)
})

test('a connection the caller gave up on stays given up: no open, nothing sent, and the daemon sees it go', async () => {
  const dir = tempFolder('ld-'); chmodSync(dir, 0o700)
  const events = [], path = join(dir, `daemon-${PORT}.sock`)
  const server = createServer()
  const gone = new Promise(resolve => server.on('upgrade', (req, stream) => {
    stream.on('error', () => {})
    // An http server's sockets stay half open: the peer's going is an `end`, which only a reader sees.
    stream.resume()
    stream.on('end', () => resolve(true))
    events.push('asked')
    // Answers late, as a daemon busy with a machine does: the caller has given up by then.
    setTimeout(() => {
      if (stream.destroyed || !stream.writable) return
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      stream.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    }, 150)
  }))
  await new Promise(ready => server.listen(path, ready))
  chmodSync(path, 0o600)
  closers.push(() => new Promise(done => { server.closeAllConnections(); server.close(() => done()) }))
  const socket = open({ ADAPTER_DATA_DIR: dir })
  socket.addEventListener('open', () => events.push('open'))
  await eventually(() => events.includes('asked'))
  const closed = once(socket, 'close')
  socket.close()
  assert.equal((await closed).code, 1006)
  assert.equal(await Promise.race([gone, new Promise(r => setTimeout(() => r(false), 100))]), true, 'the request is cut, so nothing holds the process')
  await new Promise(r => setTimeout(r, 250))
  assert.deepEqual(events, ['asked'], 'no open after close')
  assert.equal(socket.readyState, 3)
  assert.throws(() => socket.send('late'))
})

test('fetch: a request and its body over the socket; the timeout reads as a timeout; nothing without the socket', async () => {
  const d = await daemon({ rest: (req, res) => {
    let raw = ''; req.on('data', c => { raw += c }); req.on('end', () => {
      if (req.url === '/slow') return
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, url: req.url, raw, local: req.headers['x-adapter-local'] }))
    })
  } })
  const base = `http://127.0.0.1:${PORT}`
  const answer = await daemonFetch(`${base}/api/x?y=1`, { env: d.env, method: 'POST', headers: { 'x-adapter-local': '1' }, body: '{"a":1}' })
  assert.equal(answer.ok, true)
  assert.deepEqual(await answer.json(), { method: 'POST', url: '/api/x?y=1', raw: '{"a":1}', local: '1' })
  await assert.rejects(daemonFetch(`${base}/slow`, { env: d.env, signal: AbortSignal.timeout(30) }), { name: 'TimeoutError' })
  const dir = tempFolder('ld-'); chmodSync(dir, 0o700)
  await assert.rejects(daemonFetch(`${base}/api/x`, { env: { ADAPTER_DATA_DIR: dir } }), /not private/)
})

test('a long folder\'s socket is under <state>/s; Windows, and a home too long as well, have none', () => {
  const long = `/${'x'.repeat(100)}`
  assert.equal(daemonSocketPath(PORT, { ADAPTER_DATA_DIR: '/d' }, 'win32'), null)
  assert.equal(daemonSocketPath(PORT, { ADAPTER_DATA_DIR: '/d' }, 'linux'), `/d/daemon-${PORT}.sock`)
  const hash = createHash('sha256').update(long).digest('hex').slice(0, 16)
  assert.equal(daemonSocketPath(PORT, { ADAPTER_DATA_DIR: long, HOME: '/h' }, 'linux'), `/h/.local/state/harness/s/${hash}/daemon-${PORT}.sock`)
  assert.equal(daemonSocketPath(PORT, { ADAPTER_DATA_DIR: long, HOME: '/h', XDG_STATE_HOME: '/st' }, 'linux'), `/st/harness/s/${hash}/daemon-${PORT}.sock`)
  assert.equal(daemonSocketPath(PORT, { ADAPTER_DATA_DIR: long, HOME: `/${'h'.repeat(100)}` }, 'linux'), null)
})

// The example each language pins: a fresh Linux home too long for the socket beside its data folder.
const LONG_HOME = `/home/${'u'.repeat(80)}`
const LONG_HOME_HASH = '410894cc1bc77e10'

test('a long home\'s socket is under a private XDG_RUNTIME_DIR, else under <state>/s', () => {
  const dataDir = join(LONG_HOME, '.local', 'share', 'harness', 'cli', 'data')
  assert.equal(createHash('sha256').update(dataDir).digest('hex').slice(0, 16), LONG_HOME_HASH)
  const runtime = tempFolder('ld-run-')
  chmodSync(runtime, 0o700)
  // The data folder is given: daemonDataDir reads the platform this runs on, and Linux's is this one.
  const env = { HOME: LONG_HOME, ADAPTER_DATA_DIR: dataDir, XDG_STATE_HOME: '/st', XDG_RUNTIME_DIR: runtime }
  const inRuntime = `${runtime}/harness/${LONG_HOME_HASH}/daemon-${PORT}.sock`
  assert.equal(daemonSocketPath(PORT, env, 'linux'), inRuntime)
  assert.equal(daemonSocketPath(PORT, { ...env, XDG_RUNTIME_DIR: `${runtime}/` }, 'linux'), inRuntime)
  const inState = `/st/harness/s/${LONG_HOME_HASH}/daemon-${PORT}.sock`
  // Not this account's alone, not a folder, not there, not absolute, or not set: the state root's.
  chmodSync(runtime, 0o750)
  assert.equal(daemonSocketPath(PORT, env, 'linux'), inState, 'group-readable')
  chmodSync(runtime, 0o700)
  const file = join(runtime, 'file')
  writeFileSync(file, '')
  chmodSync(file, 0o700)
  for (const value of [file, join(runtime, 'none'), 'run', '', undefined]) {
    assert.equal(daemonSocketPath(PORT, { ...env, XDG_RUNTIME_DIR: value }, 'linux'), inState, String(value))
  }
  // macOS keeps its socket under ~/.harness, whatever XDG_RUNTIME_DIR says.
  assert.equal(daemonSocketPath(PORT, { ...env, HOME: '/h' }, 'darwin'), `/h/.harness/s/${LONG_HOME_HASH}/daemon-${PORT}.sock`)
})

/** An existence check that holds for [paths] only. */
const existing = (...paths) => (path) => paths.includes(path)
const never = () => { throw new Error('the rule ran') }
/** Linux's roots with only [paths] there, as folders or files. */
const linuxRoots = (env, ...paths) => harnessRoots(env, 'linux', existing(...paths), existing(...paths))

test('fresh: neither folder exists, so the XDG roots', () => {
  assert.deepEqual(linuxRoots({ HOME: '/h' }), { data: '/h/.local/share/harness', state: '/h/.local/state/harness' })
})

test('legacy only: both roots are ~/.harness', () => {
  assert.deepEqual(linuxRoots({ HOME: '/h' }, '/h/.harness'), { data: '/h/.harness', state: '/h/.harness' })
})

test('the data root holds the marker: the XDG roots, whatever is at ~/.harness', () => {
  assert.deepEqual(linuxRoots({ HOME: '/h' }, '/h/.harness', '/h/.local/share/harness', '/h/.local/share/harness/.harness-root'),
    { data: '/h/.local/share/harness', state: '/h/.local/state/harness' })
})

test('a data root without the marker switches nothing: ~/.harness beside it stays', () => {
  assert.deepEqual(linuxRoots({ HOME: '/h' }, '/h/.harness', '/h/.local/share/harness'), { data: '/h/.harness', state: '/h/.harness' })
  assert.deepEqual(linuxRoots({ HOME: '/h' }, '/h/.local/share/harness'), { data: '/h/.local/share/harness', state: '/h/.local/state/harness' })
})

test('an XDG variable that is unset, empty or relative is ignored', () => {
  for (const value of [undefined, '', 'share']) {
    assert.deepEqual(linuxRoots({ HOME: '/h', XDG_DATA_HOME: value, XDG_STATE_HOME: value }),
      { data: '/h/.local/share/harness', state: '/h/.local/state/harness' }, String(value))
  }
})

test('an absolute XDG variable names its root, and the marker is looked for there', () => {
  const env = { HOME: '/h', XDG_DATA_HOME: '/d/', XDG_STATE_HOME: '/s' }
  assert.deepEqual(linuxRoots(env), { data: '/d/harness', state: '/s/harness' })
  assert.deepEqual(linuxRoots(env, '/h/.harness'), { data: '/h/.harness', state: '/h/.harness' })
  assert.deepEqual(linuxRoots(env, '/h/.harness', '/h/.local/share/harness/.harness-root'), { data: '/h/.harness', state: '/h/.harness' })
  assert.deepEqual(linuxRoots(env, '/h/.harness', '/d/harness/.harness-root'), { data: '/d/harness', state: '/s/harness' })
})

test('Windows never runs the rule: both roots are the profile\'s .harness', () => {
  assert.deepEqual(harnessRoots({ HOME: '/h', XDG_DATA_HOME: '/d' }, 'win32', never), { data: join(homedir(), '.harness'), state: join(homedir(), '.harness') })
})

test('on macOS both are under ~/.harness', () => {
  assert.deepEqual(harnessRoots({ HOME: '/h', XDG_DATA_HOME: '/d', XDG_STATE_HOME: '/s' }, 'darwin', never), { data: '/h/.harness', state: '/h/.harness' })
  const long = `/${'x'.repeat(100)}`, hash = createHash('sha256').update(long).digest('hex').slice(0, 16)
  assert.equal(daemonSocketPath(PORT, { ADAPTER_DATA_DIR: long, HOME: '/h', XDG_STATE_HOME: '/s' }, 'darwin'), `/h/.harness/s/${hash}/daemon-${PORT}.sock`)
})

test('the data folder is <data>/cli/data, and ADAPTER_DATA_DIR still wins', (t) => {
  // daemonDataDir reads the platform it runs on: these are Linux's answers on any computer.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux' })
  t.after(() => Object.defineProperty(process, 'platform', platform))
  const home = tempFolder('ld-home-'), data = join(home, '.local', 'share', 'harness')
  assert.equal(daemonDataDir({ HOME: home }), join(data, 'cli', 'data'))
  mkdirSync(join(home, '.harness'))
  assert.equal(daemonDataDir({ HOME: home }), join(home, '.harness', 'cli', 'data'))
  mkdirSync(join(data, '.harness-root'), { recursive: true })
  assert.equal(daemonDataDir({ HOME: home }), join(home, '.harness', 'cli', 'data'), 'a folder is no marker')
  rmdirSync(join(data, '.harness-root'))
  writeFileSync(join(data, '.harness-root'), '1\n', { mode: 0o600 })
  assert.equal(daemonDataDir({ HOME: home }), join(data, 'cli', 'data'))
  assert.equal(daemonDataDir({ HOME: home, ADAPTER_DATA_DIR: '/d' }), '/d')
})

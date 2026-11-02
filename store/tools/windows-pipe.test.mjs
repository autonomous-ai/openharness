// node --test store/tools/windows-pipe.test.mjs
// On Windows no Store package sends anything to the daemon's TCP port, whose holder may be another account's: the Team
// account's daemon starts at boot, before the owner's (audit W1, docs/security/2026-11-02-team-account-windows.md). They
// reach the daemon over its named pipe instead, with the pipe auth, and take an answer only with the daemon's proof
// (cli/src/lib/windows/pipeAuth.ts). The pipe here is a real one on Windows; elsewhere a socket of the same name in this
// spec's working folder, which is where a Unix client dials `\\.\pipe\harness-<id>`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { closeBridges, listAgents as monitorAgents } from '../agents/harness-monitor/lib/bridge.mjs'
import { closeBridges as closeMemories, listAgents as memoriesAgents } from '../agents/memories/lib/bridge.mjs'
import { closeSessions, listHarnesses, listMachines } from '../agents/machine-monitor/lib/daemon.mjs'
import { harnessExecute } from '../agents/autonomous-grid/lib/harness.mjs'
import * as localDaemon from './local-daemon.mjs'
import { removeTempFolders, tempFolder } from './test-folders.mjs'

const realWindows = process.platform === 'win32'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
Object.defineProperty(process, 'platform', { value: 'win32' })
const home = process.cwd()
// Where a Unix client finds a pipe's name: this folder, as a relative path.
if (!realWindows) process.chdir(tempFolder('pipes-'))

const CREDENTIAL = `test-local-credential-${'a'.repeat(21)}`
const closers = []
after(async () => {
  try { closeBridges(); closeMemories(); closeSessions(); for (const close of closers) await close() } finally {
    process.chdir(home)
    removeTempFolders()
    Object.defineProperty(process, 'platform', platform)
  }
})
// A kept session from an earlier test would answer instead.
beforeEach(() => { closeBridges(); closeMemories(); closeSessions() })

const mac = (token, separator, nonce) => createHmac('sha256', token).update(Buffer.of(separator)).update(nonce, 'utf8').digest('hex')

/** A data folder as the Windows daemon leaves it: the credential, the daemon's token, and (once given) its record. */
function dataDir() {
  const dir = join(tempFolder('pipe-'), 'd')
  mkdirSync(dir, { mode: 0o700 })
  writeFileSync(join(dir, 'hook-credential'), `${CREDENTIAL}\n`, { mode: 0o600 })
  const token = randomBytes(32)
  writeFileSync(join(dir, 'daemon-token'), `${token.toString('hex')}\n`, { mode: 0o600 })
  return { dir, token }
}

function record(dir, configuredPort, fields) {
  writeFileSync(join(dir, `daemon-${configuredPort}.json`), `${JSON.stringify(fields)}\n`, { mode: 0o600 })
}

/** Another account on the port: it records everything and answers nothing useful. */
async function holder() {
  const heard = []
  const server = createServer((req, res) => { heard.push({ url: req.url, headers: req.headers }); res.writeHead(401).end() })
  server.on('upgrade', (req, socket) => { heard.push({ url: req.url, headers: req.headers }); socket.on('error', () => {}); socket.destroy() })
  await new Promise(ready => server.listen(0, '127.0.0.1', ready))
  closers.push(() => new Promise(done => { server.closeAllConnections(); server.close(() => done()) }))
  return { heard, port: server.address().port }
}

const envFor = (dir, port) => ({ ...process.env, ADAPTER_DATA_DIR: dir, HPS_BRIDGE_URL: `ws://127.0.0.1:${port}/api/local-ws`,
  MEMORIES_BRIDGE_URL: `ws://127.0.0.1:${port}/api/local-ws`, HARNESS_GRID_BRIDGE_URL: `ws://127.0.0.1:${port}/api/local-ws`,
  HARNESS_MACHINES_DAEMON: `http://127.0.0.1:${port}/` })

const text = (value) => {
  const body = Buffer.from(value)
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
  return Buffer.concat([head, body])
}
function unmasked(buffer) {
  if (buffer.length < 6) return null
  const short = buffer[1] & 0x7f, start = short === 126 ? 4 : 2
  const size = short === 126 ? buffer.readUInt16BE(2) : short
  if (buffer.length < start + 4 + size) return null
  const mask = buffer.subarray(start, start + 4), body = Buffer.from(buffer.subarray(start + 4, start + 4 + size))
  for (let i = 0; i < size; i++) body[i] ^= mask[i % 4]
  return { opcode: buffer[0] & 0x0f, text: body.toString(), size: start + 4 + size }
}

/**
 * The Windows daemon on its pipe (cli/src/lib/localSocket.ts `listenAuthenticated`): a request whose auth is not this
 * token's, for this pipe, gets a 401; every answer carries the proof. `proof` replaces it, for something else on the name.
 */
async function daemonOnPipe(token, { proof } = {}) {
  const id = randomBytes(16).toString('hex'), pipe = `\\\\.\\pipe\\harness-${id}`
  const got = []
  const checked = (req) => {
    const [nonce, given] = String(req.headers['x-harness-auth'] ?? '').split('.')
    const valid = /^[0-9a-f]{64}$/.test(nonce ?? '') && nonce.startsWith(id) && given === mac(token, 0x01, nonce)
    got.push({ url: req.url, headers: req.headers, valid })
    return valid ? (proof ?? mac(token, 0x00, nonce)) : null
  }
  const server = createServer((req, res) => {
    const answer = checked(req)
    if (!answer) { res.writeHead(401).end(); return }
    res.writeHead(200, { 'content-type': 'application/json', 'x-harness-proof': answer })
      .end(JSON.stringify({ data: { machines: [{ machineId: 'm' }] } }))
  })
  const upgraded = new Set()
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {})
    const answer = checked(req)
    if (!answer) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    upgraded.add(socket)
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Harness-Proof: ${answer}\r\n\r\n`)
    let held = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      held = Buffer.concat([held, chunk])
      for (let frame = unmasked(held); frame; frame = unmasked(held)) {
        held = held.subarray(frame.size)
        if (frame.opcode === 8) { socket.end(); return }
        if (frame.opcode !== 1) continue
        const { type, payload } = JSON.parse(frame.text)
        got.push({ type })
        if (type === 'machine_select') socket.write(text(JSON.stringify({ type: 'connected', payload: { machineId: payload.machineId, relayIsolation: true } })))
        else if (payload?.requestId) socket.write(text(JSON.stringify({ type: `${type}_result`, payload: { requestId: payload.requestId, agents: [{ id: 'a1' }], harnesses: [], sampledAt: 1 } })))
      }
    })
  })
  await new Promise(ready => server.listen(pipe, ready))
  closers.push(() => new Promise(done => { for (const socket of upgraded) socket.destroy(); server.closeAllConnections(); server.close(() => done()) }))
  return { got, pipe }
}

const clients = {
  'harness-monitor': env => monitorAgents('m', { env, timeoutMs: 1500 }),
  memories: env => memoriesAgents('m', { env, timeoutMs: 1500 }),
  'machine-monitor rest': env => listMachines(env),
  'machine-monitor bridge': env => listHarnesses('m', { env, timeoutMs: 1500 }),
  'autonomous-grid': env => harnessExecute({ machineId: 'm' }, ['ls'], { env, timeoutMs: 1500 }),
}

const heardOf = (hold) => hold.heard.map(h => ({ url: h.url, credential: h.headers['x-harness-local'] }))

for (const [name, run] of Object.entries(clients)) {
  test(`${name}: on Windows with no pipe recorded, the holder of the port hears nothing`, async () => {
    const { dir } = dataDir(), hold = await holder()
    await run(envFor(dir, hold.port)).catch(() => null)
    assert.deepEqual(heardOf(hold), [], 'nothing reaches the port')
  })

  test(`${name}: on Windows it reaches the daemon over its pipe with the pipe auth, and the port hears nothing`, async () => {
    const { dir, token } = dataDir(), hold = await holder(), daemon = await daemonOnPipe(token)
    record(dir, hold.port, { port: hold.port, pipe: daemon.pipe, pid: process.pid })
    await run(envFor(dir, hold.port)).catch(() => null)
    assert.deepEqual(heardOf(hold), [], 'nothing reaches the port')
    const requests = daemon.got.filter(g => g.url)
    assert.ok(requests.length > 0, 'the daemon was reached over its pipe')
    assert.ok(requests.every(g => g.valid && !g.headers['x-harness-local']), 'with a valid auth, and no credential')
    if (name !== 'machine-monitor rest') assert.ok(daemon.got.some(g => g.type === 'machine_select'), 'and the bridge was used')
  })

  test(`${name}: on Windows an answer on the pipe without the daemon's proof is never taken`, async () => {
    const { dir, token } = dataDir(), hold = await holder(), daemon = await daemonOnPipe(token, { proof: '0'.repeat(64) })
    record(dir, hold.port, { port: hold.port, pipe: daemon.pipe, pid: process.pid })
    const result = await run(envFor(dir, hold.port)).catch(() => null)
    assert.deepEqual(heardOf(hold), [], 'nothing reaches the port')
    assert.equal(daemon.got.filter(g => g.type).length, 0, 'no frame is sent to whatever answered')
    if (name === 'machine-monitor rest') assert.equal(result.ok, false, 'and its body is not read as the daemon\'s')
  })
}

test('the record is found by the port the daemon bound when the URL names that one', async () => {
  const { dir, token } = dataDir(), hold = await holder(), daemon = await daemonOnPipe(token)
  record(dir, 18473, { port: hold.port, pipe: daemon.pipe, pid: process.pid })
  const result = await listMachines(envFor(dir, hold.port))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(heardOf(hold), [])
})

test('nothing is dialled for a record that is not a live local pipe, or with no trusted token', (t) => {
  const { daemonPipe } = localDaemon
  const { dir, token } = dataDir()
  const id = randomBytes(16).toString('hex'), pipe = `\\\\.\\pipe\\harness-${id}`
  const gone = spawnSync(process.execPath, ['-e', '']).pid
  for (const [why, fields] of [
    ['a file', { port: 1, pipe: join(dir, `harness-${id}`), pid: process.pid }],
    ["another computer's pipe", { port: 1, pipe: `\\\\host\\pipe\\harness-${id}`, pid: process.pid }],
    ['a longer name', { port: 1, pipe: `${pipe}0`, pid: process.pid }],
    ['no pid', { port: 1, pipe }],
    ['a daemon that has exited', { port: 1, pipe, pid: gone }],
  ]) {
    record(dir, 1, fields)
    assert.equal(daemonPipe(1, { ADAPTER_DATA_DIR: dir }), null, why)
  }
  record(dir, 1, { port: 1, pipe, pid: process.pid })
  const route = daemonPipe(1, { ADAPTER_DATA_DIR: dir })
  const [nonce, given] = route.headers['X-Harness-Auth'].split('.')
  assert.equal(route.path, pipe)
  assert.ok(nonce.startsWith(id) && nonce.length === 64 && given === mac(token, 0x01, nonce), 'the auth proves the token for this pipe')
  assert.ok(route.proven(mac(token, 0x00, nonce)) && !route.proven(mac(token, 0x01, nonce)) && !route.proven(undefined))
  assert.equal(JSON.stringify(route).includes(token.toString('hex')), false, 'and the token itself goes nowhere')
  assert.notEqual(daemonPipe(1, { ADAPTER_DATA_DIR: dir }).headers['X-Harness-Auth'], route.headers['X-Harness-Auth'], 'a fresh nonce each time')
  assert.equal(daemonPipe(1, { ADAPTER_DATA_DIR: dir }, 'darwin'), null, 'off Windows there is no pipe to dial')

  writeFileSync(join(dir, 'daemon-token'), 'not a token\n')
  assert.equal(daemonPipe(1, { ADAPTER_DATA_DIR: dir }), null, 'a token that is not one')
  const elsewhere = join(tempFolder('token-'), 'daemon-token')
  writeFileSync(elsewhere, `${token.toString('hex')}\n`)
  rmSync(join(dir, 'daemon-token'))
  assert.equal(daemonPipe(1, { ADAPTER_DATA_DIR: dir }), null, 'no token')
  try { symlinkSync(elsewhere, join(dir, 'daemon-token')) } catch { t.diagnostic('this account cannot make links here'); return }
  assert.equal(daemonPipe(1, { ADAPTER_DATA_DIR: dir }), null, 'a token reached through a link')
})

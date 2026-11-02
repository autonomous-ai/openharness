// node --test store/tools/port-holder.test.mjs
// Whoever holds the daemon's loopback port hears nothing from a Store package (audit H1), and each still works over the socket.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { closeBridges, listAgents as monitorAgents } from '../agents/harness-monitor/lib/bridge.mjs'
import { closeBridges as closeMemories, listAgents as memoriesAgents } from '../agents/memories/lib/bridge.mjs'
import { closeSessions, listHarnesses, listMachines } from '../agents/machine-monitor/lib/daemon.mjs'
import { harnessExecute } from '../agents/autonomous-grid/lib/harness.mjs'

const CREDENTIAL = `test-local-credential-${'a'.repeat(21)}`
const closers = []
after(async () => { closeBridges(); closeMemories(); closeSessions(); for (const close of closers) await close() })

/** A data folder as the CLI leaves it, short enough to hold a socket, with a real credential a client could read. */
function dataDir() {
  const dir = join(mkdtempSync(join('/tmp', 'hold-')), 'd')
  mkdirSync(dir, { mode: 0o700 })
  writeFileSync(join(dir, 'hook-credential'), `${CREDENTIAL}\n`, { mode: 0o600 })
  chmodSync(join(dir, 'hook-credential'), 0o600)
  return dir
}

/** Another account on the port: it records everything and answers nothing useful. */
async function holder() {
  const heard = []
  const server = createServer((req, res) => { heard.push({ url: req.url, headers: req.headers }); res.writeHead(404).end() })
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

/** The real daemon's shape on its socket: no credential asked, the bridge's handshake, one roster and one REST answer. */
async function daemonOn(dir, port) {
  const got = []
  const server = createServer((req, res) => {
    got.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { machines: [{ machineId: 'm' }] } }))
  })
  const upgraded = new Set()
  server.on('upgrade', (req, socket) => {
    got.push({ url: req.url, headers: req.headers })
    upgraded.add(socket)
    socket.on('error', () => {})
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
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
  const path = join(dir, `daemon-${port}.sock`)
  await new Promise(ready => server.listen(path, ready))
  chmodSync(path, 0o600)
  // An upgraded socket is no longer the server's to close.
  closers.push(() => new Promise(done => { for (const socket of upgraded) socket.destroy(); server.closeAllConnections(); server.close(() => done()) }))
  return { got }
}

const clients = {
  'harness-monitor': env => monitorAgents('m', { env, timeoutMs: 1500 }),
  memories: env => memoriesAgents('m', { env, timeoutMs: 1500 }),
  'machine-monitor rest': env => listMachines(env),
  'machine-monitor bridge': env => listHarnesses('m', { env, timeoutMs: 1500 }),
  'autonomous-grid': env => harnessExecute({ machineId: 'm' }, ['ls'], { env, timeoutMs: 1500 }),
}

for (const [name, run] of Object.entries(clients)) {
  test(`${name}: with the daemon down, a holder of its port hears nothing`, async () => {
    const dir = dataDir(), hold = await holder()
    await run(envFor(dir, hold.port)).catch(() => null)
    assert.deepEqual(hold.heard.map(h => ({ url: h.url, credential: h.headers['x-harness-local'] })), [], 'nothing reaches the port')
  })

  test(`${name}: works over the socket, with no credential, while another account holds the port`, async () => {
    const dir = dataDir(), hold = await holder(), daemon = await daemonOn(dir, hold.port)
    await run(envFor(dir, hold.port)).catch(() => null)
    assert.equal(hold.heard.length, 0, 'nothing reaches the port')
    assert.ok(daemon.got.length > 0, 'the daemon was reached over its socket')
    assert.ok(daemon.got.every(g => !g.headers?.['x-harness-local'] && !g.headers?.authorization), 'and shown no credential')
  })
}

for (const [name, run] of Object.entries(clients)) {
  test(`${name}: a data folder too long for a socket uses its short one, and a holder of the port hears nothing`, async () => {
    const home = mkdtempSync(join('/tmp', 'hh-')), dir = join(mkdtempSync(join('/tmp', 'hl-')), 'd'.repeat(100))
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, 'hook-credential'), `${CREDENTIAL}\n`, { mode: 0o600 })
    const hold = await holder()
    const folder = join(home, '.harness', 's', createHash('sha256').update(dir).digest('hex').slice(0, 16))
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const daemon = await daemonOn(folder, hold.port)
    // A kept session from an earlier test would answer instead.
    closeBridges(); closeMemories(); closeSessions()
    await run({ ...envFor(dir, hold.port), HOME: home }).catch(() => null)
    assert.equal(hold.heard.length, 0, 'nothing reaches the port')
    assert.ok(daemon.got.length > 0, 'the daemon was reached over its short socket')
    assert.ok(daemon.got.every(g => !g.headers?.['x-harness-local']), 'and shown no credential')
  })

  test(`${name}: a long folder with its short socket gone says the daemon is down, and the port is not tried`, async () => {
    const home = mkdtempSync(join('/tmp', 'hh-')), dir = join(mkdtempSync(join('/tmp', 'hl-')), 'd'.repeat(100))
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, 'hook-credential'), `${CREDENTIAL}\n`, { mode: 0o600 })
    const hold = await holder()
    await run({ ...envFor(dir, hold.port), HOME: home }).catch(() => null)
    assert.equal(hold.heard.length, 0)
  })
}

test('a socket that is not private is not used, and nothing else is', async () => {
  const dir = dataDir(), hold = await holder(), daemon = await daemonOn(dir, hold.port)
  chmodSync(join(dir, `daemon-${hold.port}.sock`), 0o666)
  await monitorAgents('m', { env: envFor(dir, hold.port), timeoutMs: 1000 }).catch(() => null)
  assert.equal(hold.heard.length, 0)
  assert.equal(daemon.got.length, 0)
})

test('every package carries the same socket client', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
  const ours = read('./local-daemon.mjs')
  for (const name of ['harness-monitor', 'memories', 'machine-monitor', 'autonomous-grid']) {
    assert.equal(read(`../agents/${name}/lib/localDaemon.mjs`), ours, name)
  }
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { closeBridges, listAgents, localCredentialHeaders } from '../lib/bridge.mjs'

const CREDENTIAL = `test-local-credential-${'a'.repeat(21)}` // the CLI's shape: 43 base64url characters

/** A data folder as the CLI leaves it: 0700, holding a 0600 `hook-credential` (or none). */
function dataDir({ credential = CREDENTIAL, mode = 0o600, folderMode = 0o700 } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'memories-credential-')), 'data')
  mkdirSync(dir, { mode: 0o700 })
  if (credential !== null) { writeFileSync(join(dir, 'hook-credential'), `${credential}\n`, { mode: 0o600 }); chmodSync(join(dir, 'hook-credential'), mode) }
  chmodSync(dir, folderMode)
  return dir
}

function encode(text) {
  const data = Buffer.from(text)
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255])
  return Buffer.concat([head, data])
}
function decode(buffer) {
  if (buffer.length < 2) return null
  let length = buffer[1] & 0x7f, offset = 2
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4 }
  const start = offset + 4
  if (buffer.length < start + length) return null
  const data = Buffer.from(buffer.subarray(start, start + length))
  for (let i = 0; i < data.length; i++) data[i] ^= buffer[offset + (i % 4)]
  return { opcode: buffer[0] & 0x0f, text: data.toString('utf8'), size: start + length }
}

/** The daemon's loopback API since 0.4.21: 401 to anything without `X-Harness-Local`, the bridge with it. */
async function gatedBridge() {
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.headers['x-harness-local'])
    res.writeHead(req.headers['x-harness-local'] === CREDENTIAL ? 404 : 401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'LOCAL_CREDENTIAL_REQUIRED' }))
  })
  server.on('upgrade', (req, socket) => {
    seen.push(req.headers['x-harness-local'])
    socket.on('error', () => {})
    if (req.headers['x-harness-local'] !== CREDENTIAL) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      for (let frame = decode(pending); frame; frame = decode(pending)) {
        pending = pending.subarray(frame.size)
        if (frame.opcode === 8) { socket.end(); return }
        if (frame.opcode !== 1) continue
        const { type, payload } = JSON.parse(frame.text)
        if (type === 'machine_select') socket.write(encode(JSON.stringify({ type: 'connected', payload: { machineId: payload.machineId } })))
        if (type === 'agents_list') socket.write(encode(JSON.stringify({ type: 'agents_list_result', payload: { requestId: payload.requestId, agents: [{ id: 'a1' }] } })))
      }
    })
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  return {
    url: `ws://127.0.0.1:${server.address().port}/api/local-ws`,
    seen,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()) }),
  }
}

test('the local credential is read the way the CLI reads it, and only then', () => {
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir() }), { 'X-Harness-Local': CREDENTIAL })
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ credential: null }) }), {})
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: join(tmpdir(), 'memories-no-such-folder') }), {})
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ mode: 0o644 }) }), {}, 'a file others can read is not trusted')
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ folderMode: 0o777 }) }), {}, 'nor one in a folder others can write')
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ credential: 'too-short' }) }), {})
})

// Windows reports every file as 0o666 and every folder as 0o777, so the POSIX mode checks would refuse the
// credential the daemon wrote and the daemon, which wants it on TCP there, would answer 401 (cli hookAuth.ts).
test('on Windows the credential is read whatever mode the folder and file report', (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  t.after(() => Object.defineProperty(process, 'platform', platform))
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ mode: 0o666, folderMode: 0o777 }) }), { 'X-Harness-Local': CREDENTIAL })
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR: dataDir({ credential: 'too-short', mode: 0o666 }) }), {}, 'the value is still checked')
})

test('the bridge shows the daemon its local credential', async (t) => {
  const bridge = await gatedBridge()
  t.after(() => { closeBridges(); return bridge.close() })
  const env = { MEMORIES_BRIDGE_URL: bridge.url, ADAPTER_DATA_DIR: dataDir() }
  assert.deepEqual(await listAgents('m', { env, timeoutMs: 2000 }), [{ id: 'a1' }])
  assert.deepEqual(bridge.seen, [CREDENTIAL])
})

test('without a readable credential nothing is sent, and the refusal is named as one', async (t) => {
  const bridge = await gatedBridge()
  t.after(() => { closeBridges(); return bridge.close() })
  const env = { MEMORIES_BRIDGE_URL: bridge.url, ADAPTER_DATA_DIR: dataDir({ credential: null }) }
  await assert.rejects(listAgents('m', { env, timeoutMs: 2000 }), /refused this process's local credential/)
  assert.ok(bridge.seen.length > 0 && bridge.seen.every((header) => header === undefined))
})

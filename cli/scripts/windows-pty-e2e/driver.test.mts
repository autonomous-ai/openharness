import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { loadOrCreateHookCredential } from '../../src/lib/hookAuth.ts'
import { Client, machineId } from './driver.mts'

function captureOpen() {
  const client = new Client()
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  client.ws = {
    send(data: string) {
      const frame = JSON.parse(data)
      sent.push(frame)
      client.frames.push({
        type: 'terminal_ready',
        payload: { requestId: frame.payload.requestId, streamId: 'test-stream' },
      })
    },
  } as unknown as WebSocket
  return { client, sent }
}

test('a passive screen open watches without taking the Desktop terminal or changing its size', async () => {
  const { client, sent } = captureOpen()
  await client.open('owned-terminal', 120, 40, { passive: true })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'terminal_open')
  assert.deepEqual(sent[0].payload, {
    requestId: sent[0].payload.requestId,
    agentId: 'owned-terminal',
    cols: 120,
    rows: 40,
    protocolVersion: 3,
    takeover: false,
    watch: true,
  })
})

test('an ordinary open still requests control for typing', async () => {
  const { client, sent } = captureOpen()
  await client.open('owned-terminal', 120, 40)

  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].payload, {
    requestId: sent[0].payload.requestId,
    agentId: 'owned-terminal',
    cols: 120,
    rows: 40,
    protocolVersion: 3,
  })
})

test('the local E2E socket presents this user\'s daemon credential', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'harness-pty-driver-'))
  const credential = loadOrCreateHookCredential(dataDir)
  const oldDataDir = process.env.ADAPTER_DATA_DIR
  const oldMachineId = process.env.E2E_MACHINE_ID
  process.env.ADAPTER_DATA_DIR = dataDir
  process.env.E2E_MACHINE_ID = 'test-machine'

  const server = createServer()
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (request.headers['x-harness-local'] !== credential) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit('connection', ws))
  })
  sockets.on('connection', (ws) => {
    ws.on('message', () => ws.send(JSON.stringify({ type: 'connected', payload: {} })))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const client = new Client()
  try {
    await client.connect(`ws://127.0.0.1:${address.port}/api/local-ws`)
    assert.equal(client.frames[0]?.type, 'connected')
  } finally {
    if (client.ws) client.end()
    for (const ws of sockets.clients) ws.terminate()
    sockets.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (oldDataDir === undefined) delete process.env.ADAPTER_DATA_DIR
    else process.env.ADAPTER_DATA_DIR = oldDataDir
    if (oldMachineId === undefined) delete process.env.E2E_MACHINE_ID
    else process.env.E2E_MACHINE_ID = oldMachineId
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a signed-out driver reads the computer id from this user\'s Harness home', () => {
  const home = mkdtempSync(join(tmpdir(), 'harness-pty-home-'))
  const product = join(home, '.harness')
  mkdirSync(product)
  writeFileSync(join(product, 'computer-id'), 'own-computer-id\n')
  const names = ['HOME', 'USERPROFILE', 'HARNESS_AUTH_DIR', 'E2E_MACHINE_ID', 'ADAPTER_COMPUTER_ID_FILE'] as const
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.HARNESS_AUTH_DIR = join(product, 'auth')
  delete process.env.E2E_MACHINE_ID
  delete process.env.ADAPTER_COMPUTER_ID_FILE

  try {
    assert.equal(machineId(), 'own-computer-id')
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    rmSync(home, { recursive: true, force: true })
  }
})

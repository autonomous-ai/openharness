import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { listenLocalSocket, unixSocketPath } from '../../src/lib/localSocket.ts'
import { NOT_RUNNING } from '../../src/lib/unreachable.ts'
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

/** Sets [values] for [run], then puts each variable back as it was. */
async function withEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
  Object.assign(process.env, values)
  try {
    await run()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('a Windows driver opens no loopback port: with no pipe it says Harness is not running', async () => {
  const loopback = createServer()
  let reached = 0
  loopback.on('connection', (socket) => { reached++; socket.destroy() })
  loopback.listen(0, '127.0.0.1')
  await once(loopback, 'listening')
  const address = loopback.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await withEnv({ E2E_PORT: String(address.port), E2E_MACHINE_ID: 'test-machine' }, async () => {
      await assert.rejects(new Client().connect({ platform: 'win32', pipe: () => null }), { message: NOT_RUNNING })
    })
    assert.equal(reached, 0)
  } finally {
    await new Promise<void>((resolve) => loopback.close(() => resolve()))
  }
})

test('a macOS or Linux driver reaches the daemon over its socket', { skip: process.platform === 'win32' }, async () => {
  // A short folder, so the socket fits beside the data, as the daemon's own does.
  const dataDir = mkdtempSync('/tmp/hpd-')
  const port = 18473
  const socketPath = unixSocketPath(dataDir, port)
  assert.ok(socketPath)
  const daemon = await listenLocalSocket((_req, res) => { res.statusCode = 404; res.end() }, socketPath)
  const sockets = new WebSocketServer({ noServer: true })
  daemon.server.on('upgrade', (request, socket, head) => sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit('connection', ws)))
  sockets.on('connection', (ws) => {
    ws.on('message', (data) => {
      if (JSON.parse(String(data)).type === 'machine_select') ws.send(JSON.stringify({ type: 'connected', payload: {} }))
    })
  })
  const client = new Client()
  try {
    await withEnv({ ADAPTER_DATA_DIR: dataDir, E2E_PORT: String(port), E2E_MACHINE_ID: 'test-machine' }, async () => {
      await client.connect()
    })
    assert.equal(client.frames[0]?.type, 'connected')
  } finally {
    if (client.ws) client.end()
    for (const ws of sockets.clients) ws.terminate()
    sockets.close()
    await daemon.close()
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

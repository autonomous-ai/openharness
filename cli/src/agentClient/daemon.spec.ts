import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectSocket, openDaemon, whereFor, type ClientSocket } from './daemon.js'
import { saveDaemonPort } from '../lib/daemonEndpoint.js'
import { WebSocketServer } from 'ws'
import { listenLocalSocket } from '../lib/localSocket.js'
import { attachLocalWsServer } from '../localWsServer.js'
import { localSocketPath } from '../lib/localSocket.js'
import { NOT_RUNNING, SANDBOXED } from '../lib/unreachable.js'
import { newPipePath } from '../lib/windows/pipeAuth.js'

/** A real named pipe on Windows; a short Unix socket with the same auth name elsewhere. */
function pipeFixture(): { path: string; close: () => void } {
  if (process.platform === 'win32') return { path: newPipePath(), close: () => {} }
  const dir = mkdtempSync('/tmp/agent-pipe-')
  return {
    path: join(dir, `harness-${randomBytes(16).toString('hex')}`),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** A socket whose connection fails with [code], as Codex's sandbox refuses the daemon's (2026-10-12). */
function failing(code: string): ClientSocket {
  const socket = new EventEmitter() as unknown as ClientSocket
  setImmediate(() => (socket as unknown as EventEmitter).emit('error', Object.assign(new Error(code), { code })))
  return socket
}

describe('a line to the daemon that cannot open', () => {
  let dataDir: string
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-daemon-'))
    // The suite may itself run in Codex's sandbox; these cases are about the error and the pid file alone.
    saved = { CODEX_SANDBOX: process.env.CODEX_SANDBOX, CODEX_SANDBOX_NETWORK_DISABLED: process.env.CODEX_SANDBOX_NETWORK_DISABLED }
    delete process.env.CODEX_SANDBOX
    delete process.env.CODEX_SANDBOX_NETWORK_DISABLED
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value
  })
  const where = () => ({ port: 1, dataDir, machineId: 'm1' })
  /** The pid file of the daemon the line is to: this test's own process, which exists. */
  const running = () => writeFileSync(join(dataDir, 'adapter.pid'), `${process.pid}\n`)

  it('says a sandbox keeps it out when the connection was not permitted, and never to start Harness', async () => {
    running()
    await expect(openDaemon(where(), 'm1', () => failing('EPERM'))).rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE', message: SANDBOXED })
  })

  it('says to start Harness when nothing answers, or when nothing is there behind a refusal', async () => {
    running()
    await expect(openDaemon(where(), 'm1', () => failing('ECONNREFUSED'))).rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE', message: NOT_RUNNING })
    // The pid file of the daemon the line is to decides: seatbelt refuses a port nobody listens on with EPERM too.
    rmSync(join(dataDir, 'adapter.pid'))
    await expect(openDaemon(where(), 'm1', () => failing('EPERM'))).rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE', message: NOT_RUNNING })
  })

  // Root opens a socket whatever its mode, so the refusal cannot be made there.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reads a real refused socket as a sandbox\'s, through the real connect', async () => {
    running()
    const path = localSocketPath(dataDir, 1)!
    const server = createServer((socket) => socket.end())
    await new Promise<void>((done) => server.listen(path, done))
    try {
      // A socket this process may not open answers EACCES, as one a sandbox refuses does.
      chmodSync(path, 0)
      await expect(openDaemon(where())).rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE', message: SANDBOXED })
    } finally { await new Promise((done) => server.close(done)) }
  })
})

it('dials the port this user recorded when another daemon took the configured port', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-daemon-port-'))
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('No test port')
    const unused = createServer()
    await new Promise<void>((resolve) => unused.listen(0, '127.0.0.1', resolve))
    const unusedAddress = unused.address()
    if (typeof unusedAddress !== 'object' || unusedAddress === null) throw new Error('No configured port')
    const configuredPort = unusedAddress.port
    await new Promise<void>((resolve) => unused.close(() => resolve()))
    saveDaemonPort(dataDir, configuredPort, address.port)
    const socket = await connectSocket({ port: configuredPort, dataDir, machineId: 'm1' }, { platform: 'linux' })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve)
      socket.on('error', reject)
    })
    socket.close()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('recognizes a native host pane as one Harness made', () => {
  expect(whereFor('p1:%3', () => null).harnessPane).toBe(true)
  expect(whereFor('p1:%3; cmd', () => null).harnessPane).toBe(false)
})

it.each([false, true])('never sends the local credential to TCP when the Windows pipe is unavailable (record=%s)', async (withRecord) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-daemon-unsafe-'))
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  let received = 0
  let credentialSeen: string | undefined
  server.on('connection', (ws, request) => {
    received++
    const header = request.headers['x-harness-local']
    credentialSeen = typeof header === 'string' ? header : undefined
    ws.close()
  })
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('No test port')
    writeFileSync(join(dataDir, 'hook-credential'), `${'A'.repeat(43)}\n`)
    if (withRecord) saveDaemonPort(dataDir, address.port, address.port)
    const where = { port: address.port, dataDir, machineId: 'm1' }
    const result = await openDaemon(where, 'm1', (target) => connectSocket(target, {
      platform: 'win32', pipe: async () => null,
    })).catch((error: unknown) => error)
    expect(received).toBe(0)
    expect(credentialSeen).toBeUndefined()
    expect(result).toMatchObject({ code: 'DAEMON_UNREACHABLE' })
  } finally {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('opens a Windows agent line over the proven pipe without a TCP credential', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-daemon-pipe-'))
  const fixture = pipeFixture()
  const pipePath = fixture.path
  const token = randomBytes(32)
  const pipe = await listenLocalSocket((_req, response) => response.end(), pipePath, { token })
  const tcp = http.createServer()
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
  const backend = {
    registerLocalClient: () => true,
    unregisterLocalClient: async () => {},
    handleLocalFrame: () => {},
    handleLocalBinary: async () => {},
  }
  const local = attachLocalWsServer(tcp, { machineId: 'm1', backend, localSocketServer: pipe.server })
  try {
    const socket = await connectSocket({ port: 18473, dataDir, machineId: 'm1' }, {
      platform: 'win32', pipe: async () => ({ pipe: pipePath, token }),
    })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve)
      socket.on('error', reject)
    })
    socket.close()
  } finally {
    await local.close()
    await pipe.close()
    await new Promise<void>((resolve) => tcp.close(() => resolve()))
    fixture.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('rejects a pipe squatter before sending any agent frame', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-daemon-squatter-'))
  const fixture = pipeFixture()
  const pipePath = fixture.path
  const token = randomBytes(32)
  const server = http.createServer()
  const wsServer = new WebSocketServer({ server })
  let frames = 0
  let credentialSeen: string | string[] | undefined
  wsServer.on('connection', (socket, request) => {
    credentialSeen = request.headers['x-harness-local']
    socket.on('message', () => { frames++ })
  })
  try {
    await new Promise<void>((resolve) => server.listen(pipePath, resolve))
    const where = { port: 18473, dataDir, machineId: 'm1' }
    await expect(openDaemon(where, 'm1', (target) => connectSocket(target, {
      platform: 'win32', pipe: async () => ({ pipe: pipePath, token }),
    }))).rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE' })
    expect(frames).toBe(0)
    expect(credentialSeen).toBeUndefined()
  } finally {
    for (const client of wsServer.clients) client.terminate()
    await new Promise<void>((resolve) => wsServer.close(() => resolve()))
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fixture.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

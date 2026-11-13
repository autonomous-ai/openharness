import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectSocket, openDaemon, whereFor, type ClientSocket } from './daemon.js'
import { writeDaemonRecord } from '../lib/daemonRecord.js'
import { WebSocketServer } from 'ws'
import { listenLocalSocket } from '../lib/localSocket.js'
import { attachLocalWsServer } from '../localWsServer.js'
import { localSocketPath } from '../lib/localSocket.js'
import { NOT_RUNNING, SANDBOXED } from '../lib/unreachable.js'
import { newPipePath } from '../lib/windows/pipeAuth.js'

// A folder too long for a socket now has one under the home folder: only a home too long as well is left on the port.
beforeEach(() => { vi.stubEnv('HOME', `/${'h'.repeat(120)}`) })
afterEach(() => { vi.unstubAllEnvs() })

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

it('where no socket can exist, dials the port this user recorded when another daemon took the configured port', async () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'agent-daemon-port-')), 'd'.repeat(100))
  mkdirSync(dataDir, { mode: 0o700 })
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
    writeDaemonRecord(dataDir, configuredPort, address.port)
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
    if (withRecord) writeDaemonRecord(dataDir, address.port, address.port)
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

// A request past what the daemon's socket takes was closed with no word: an agent that posted a long log heard only "The connection
// to Harness closed." (Q3, 2026-11-10). It is refused by name, with its size and the limit, whichever side sees it.
describe('a request too large for the daemon', () => {
  const line = () => {
    const sent: string[] = []
    const socket = new EventEmitter() as unknown as ClientSocket & EventEmitter
    Object.assign(socket, {
      send: (text: string) => {
        sent.push(text)
        if (JSON.parse(text).type === 'machine_select') setImmediate(() => socket.emit('message', Buffer.from(JSON.stringify({ type: 'connected', payload: {} })), false))
      },
      close: vi.fn(),
    })
    setImmediate(() => socket.emit('open'))
    return { sent, socket }
  }
  const where = { port: 1, dataDir: '/nowhere', machineId: 'm1' }

  it('refuses one past 512 KiB by name, with its size and the limit, and sends nothing', async () => {
    const { sent, socket } = line()
    const daemon = await openDaemon(where, 'm1', () => socket)
    const refused = daemon.request('agent_input', { text: 'x'.repeat(600 * 1024) })
    await expect(refused).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE',
      // Its size as sent: the words and the request around them.
      message: 'This request is 601 KiB, and Harness takes at most 512 KiB in one: nothing was sent. Put the rest in a file and send its path.' })
    expect(sent.map(text => JSON.parse(text).type)).toEqual(['machine_select'])
    // The line stays open for what fits.
    void daemon.request('agents_list').catch(() => {})
    expect(sent).toHaveLength(2)
    daemon.close()
  })

  it('says the daemon\'s own refusal, before its close, to what was waiting', async () => {
    const { socket } = line()
    const daemon = await openDaemon(where, 'm1', () => socket)
    const waiting = daemon.request('agents_list')
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'frame_too_large', payload: { error: 'FRAME_TOO_LARGE', bytes: 700 * 1024, limit: 512 * 1024 } })), false)
    socket.emit('close', 1009)
    // The daemon's own numbers, and not that this request was refused: it is not named, and may have run.
    await expect(waiting).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE', message: 'A request on this line was 700 KiB, and Harness takes at most '
      + '512 KiB in one: it closed the line. What else waited on it may have run. Put the rest in a file and send its path.' })
  })

  it('says a frame too big for the transport itself as too large, not a bare close', async () => {
    const { socket } = line()
    const daemon = await openDaemon(where, 'm1', () => socket)
    const waiting = daemon.request('agents_list')
    socket.emit('close', 1009)
    await expect(waiting).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
  })
})

// `harness wait` and `watch` follow what the daemon pushes for the harnesses they named (core/toolWatches.ts), and a
// daemon too old to push answers `agents_watch` UNSUPPORTED: they then look every 3 s, as before.
describe('a line that follows pushed state events', () => {
  const line = (answer: Record<string, unknown>) => {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
    const socket = new EventEmitter() as unknown as ClientSocket & EventEmitter
    const push = (frame: unknown) => socket.emit('message', Buffer.from(JSON.stringify(frame)), false)
    Object.assign(socket, {
      send: (text: string) => {
        const frame = JSON.parse(text)
        sent.push(frame)
        if (frame.type === 'machine_select') setImmediate(() => push({ type: 'connected', payload: {} }))
        if (frame.type === 'agents_watch') setImmediate(() => push({ type: 'agents_watch_result', payload: { requestId: frame.payload.requestId, ...answer } }))
      },
      close: vi.fn(),
    })
    setImmediate(() => socket.emit('open'))
    return { sent, push, socket }
  }
  const where = { port: 1, dataDir: '/nowhere', machineId: 'm1' }

  it('names the harnesses, and hears each pushed state event of one of them', async () => {
    const { sent, push, socket } = line({ ok: true })
    const daemon = await openDaemon(where, 'm1', () => socket)
    const heard: string[] = []
    expect(await daemon.watch!(['a', 'b'], (agentId) => heard.push(agentId))).toBe(true)
    expect(sent.at(-1)).toMatchObject({ type: 'agents_watch', payload: { agentIds: ['a', 'b'] } })
    push({ type: 'agent_activity', agentId: 'a', payload: { agentId: 'a', state: 'working' } })
    push({ type: 'turn_ended', agentId: 'b', payload: { agentId: 'b', state: 'idle' } })
    push({ type: 'commander_question', agentId: 'a', payload: { agentId: 'a', requestId: 'q' } })
    push({ type: 'commander_question_close', agentId: 'a', payload: { agentId: 'a', requestId: 'q' } })
    push({ type: 'agent_deleted', agentId: 'b', payload: { agentId: 'b' } })
    // What is not a state event, names no harness, or is binary is not heard.
    push({ type: 'text_delta', agentId: 'a', payload: { agentId: 'a' } })
    push({ type: 'turn_ended', payload: {} })
    socket.emit('message', Buffer.from('{}'), true)
    expect(heard).toEqual(['a', 'b', 'a', 'a', 'b'])
    daemon.close()
  })

  it('hands each pushed event on whole, its type and payload, for a listener that tells them apart', async () => {
    const { push, socket } = line({ ok: true })
    const daemon = await openDaemon(where, 'm1', () => socket)
    const heard: unknown[] = []
    await daemon.watch!(['a'], (agentId, event) => heard.push([agentId, event]))
    push({ type: 'turn_ended', agentId: 'a', payload: { agentId: 'a', state: 'idle', subagent: true } })
    expect(heard).toEqual([['a', { type: 'turn_ended', payload: { agentId: 'a', state: 'idle', subagent: true } }]])
    daemon.close()
  })

  it('follows harnesses on another machine by what it pushes (harness_watch), with what each is doing now', async () => {
    const sent: Array<Record<string, any>> = []
    const socket = Object.assign(new EventEmitter(), {
      send: (text: string) => {
        const frame = JSON.parse(text)
        sent.push(frame)
        const push = (f: unknown) => socket.emit('message', Buffer.from(JSON.stringify(f)), false)
        if (frame.type === 'machine_select') setImmediate(() => push({ type: 'connected', payload: {} }))
        if (frame.type === 'harness_watch') setImmediate(() => push({ type: 'harness_watch_result', payload: { requestId: frame.payload.requestId, leaseMs: 300_000, agents: [{ agentId: 'far', state: 'working' }] } }))
      },
      close: vi.fn(),
    })
    setImmediate(() => socket.emit('open'))
    const daemon = await openDaemon(where, 'm2', () => socket as never)
    const heard: unknown[] = []
    expect(await daemon.harnessWatch!(['far'], (agentId, event) => heard.push([agentId, event.payload]))).toMatchObject({ agents: [{ agentId: 'far', state: 'working' }] })
    expect(sent.at(-1)).toMatchObject({ type: 'harness_watch', payload: { agentIds: ['far'] } })
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'harness_event', payload: { agentId: 'far', state: 'idle' } })), false)
    expect(heard).toEqual([['far', { agentId: 'far', state: 'idle' }]])
    daemon.close()
  })

  it('says no from a daemon too old to push, and hears nothing then', async () => {
    const { push, socket } = line({ error: 'UNSUPPORTED' })
    const daemon = await openDaemon(where, 'm1', () => socket)
    const heard: string[] = []
    expect(await daemon.watch!(['a'], (agentId) => heard.push(agentId))).toBe(false)
    push({ type: 'turn_ended', agentId: 'a', payload: { agentId: 'a' } })
    expect(heard).toEqual([])
    daemon.close()
  })

  it('hears nothing before it asked', async () => {
    const { push, socket } = line({ ok: true })
    const daemon = await openDaemon(where, 'm1', () => socket)
    push({ type: 'turn_ended', agentId: 'a', payload: { agentId: 'a' } })
    daemon.close()
  })
})

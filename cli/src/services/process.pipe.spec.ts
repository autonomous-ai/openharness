import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { createServiceLinks } from '../core/serviceLinks.js'
import { listenLocalSocket } from '../lib/localSocket.js'
import { newPipePath } from '../lib/windows/pipeAuth.js'
import type { PipeTarget } from '../lib/windows/pipeClient.js'
import { attachLocalWsServer, type LocalWsBackend } from '../localWsServer.js'
import { serviceConnector } from './localConnection.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'

const gate = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const BOOT = 'b'.repeat(48)

describe('services over the authenticated local pipe protocol', () => {
  const cleanup: Array<() => void | Promise<void>> = []
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
  const endpoint = () => {
    if (process.platform === 'win32') return newPipePath()
    const root = mkdtempSync('/tmp/hsp-')
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    return join(root, `harness-${randomBytes(16).toString('hex')}`)
  }
  const core = async () => {
    const target = { pipe: endpoint(), token: randomBytes(32) }
    const pipe = await listenLocalSocket((_req, res) => { res.statusCode = 404; res.end() }, target.pipe, { token: target.token })
    cleanup.push(pipe.close)
    const backend: LocalWsBackend = {
      registerLocalClient: vi.fn(() => true), unregisterLocalClient: vi.fn(async () => {}),
      handleLocalFrame: vi.fn(), handleLocalBinary: vi.fn(async () => {}),
    }
    const links = createServiceLinks({ token: BOOT, owned: { search: ['session_search'] },
      answer: () => ({ current: true }), log: () => {},
    })
    const unusedTcp = http.createServer()
    const local = attachLocalWsServer(unusedTcp, { machineId: 'machine', backend, localSocketServer: pipe.server, services: links })
    let closed = false
    const close = async () => { if (!closed) { closed = true; await local.close() } }
    cleanup.push(close)
    return { target, links, backend, close }
  }
  const service = (pipe: () => Promise<PipeTarget | null>, connected: (connection: CoreConnection) => void, log = (_line: string) => {}): ServiceProcess => {
    const running = runServiceProcess({ name: 'search', socketPath: '', machineId: 'machine', token: BOOT,
      env: {}, log, requests: { session_search: (payload) => ({ hits: [payload.query] }) }, onConnected: connected,
      connect: serviceConnector({ dataDir: '/unused', port: 1234 }, { platform: 'win32', pipe }), initialBackoffMs: 100,
    })
    cleanup.push(() => running.stop())
    return running
  }

  it('registers through the real local service door and rediscovers a restarted core and rotated token', async () => {
    const first = await core(), second = await core()
    let current = first.target
    const discovery = vi.fn(async () => current)
    const opened = [gate<CoreConnection>(), gate<CoreConnection>()]
    let count = 0
    const running = service(discovery, (connection) => opened[count++]!.resolve(connection))
    const initial = await opened[0]!.promise
    await expect(initial.query('fixture')).resolves.toEqual({ current: true })
    await expect(first.links.call('search', 'session_search', { query: 'first' })).resolves.toEqual({ hits: ['first'] })
    expect(first.backend.registerLocalClient).not.toHaveBeenCalled()
    current = second.target
    await first.close()
    await opened[1]!.promise
    expect(discovery).toHaveBeenCalledTimes(2)
    await expect(second.links.call('search', 'session_search', { query: 'second' })).resolves.toEqual({ hits: ['second'] })
    expect(second.backend.registerLocalClient).not.toHaveBeenCalled()
    running.stop()
  })

  it('sends no service token or application frame to a server whose 101 has no daemon proof', async () => {
    const path = endpoint(), server = http.createServer()
    const wss = new WebSocketServer({ server })
    const closed = gate<void>(), frames: unknown[] = []
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => frames.push(raw))
      socket.once('close', () => closed.resolve())
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    cleanup.push(async () => {
      for (const socket of wss.clients) socket.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const failed = gate<void>(), connected = vi.fn()
    const running = service(async () => ({ pipe: path, token: randomBytes(32) }), connected,
      (line) => { if (line.endsWith('SERVICE_CONNECT_UNAVAILABLE')) failed.resolve() })
    await Promise.all([closed.promise, failed.promise])
    running.stop()
    expect(connected).not.toHaveBeenCalled()
    expect(frames).toEqual([])
  })

  it('refuses a stale token, then connects using the next discovered record without falling back', async () => {
    const server = await core(), ready = gate<CoreConnection>(), failed = gate<void>()
    let target = { ...server.target, token: randomBytes(32) }
    const discovery = vi.fn(async () => target)
    service(discovery, ready.resolve, (line) => { if (line.endsWith('SERVICE_CONNECT_UNAVAILABLE')) failed.resolve() })
    await failed.promise
    target = server.target
    await ready.promise
    expect(discovery).toHaveBeenCalledTimes(2)
    await expect(server.links.call('search', 'session_search', { query: 'recovered' })).resolves.toEqual({ hits: ['recovered'] })
    expect(server.backend.registerLocalClient).not.toHaveBeenCalled()
  })
})

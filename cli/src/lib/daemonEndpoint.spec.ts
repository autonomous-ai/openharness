import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest'
import { loadOrCreateHookCredential } from './hookAuth.js'
import { legacyDaemonStatus, localDaemonCall, localDaemonStatus } from './daemonEndpoint.js'
import { listenLocalSocket, localSocketPath } from './localSocket.js'
import type { PipeTarget } from './windows/pipeClient.js'

// A folder too long for a socket now has one under the home folder: only a home too long as well is left on the port.
beforeEach(() => { vi.stubEnv('HOME', `/${'h'.repeat(120)}`) })
afterEach(() => { vi.unstubAllEnvs() })

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function directory(): string {
  const path = mkdtempSync('/tmp/hn-owner-')
  cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

describe('per-user daemon discovery', () => {
  it('never accepts another user\'s TCP status, including when this user has no socket', async () => {
    let foreignRequests = 0
    const foreign = createServer((_req, res) => { foreignRequests++; res.end(JSON.stringify({ machineId: 'other-account' })) })
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => foreign.close(() => resolve())))
    const port = (foreign.address() as { port: number }).port
    const userA = directory(), userB = directory()
    const a = await listenLocalSocket((_req, res) => res.end(JSON.stringify({ machineId: 'account-a' })), localSocketPath(userA, port)!)
    cleanup.push(a.close)
    expect(await localDaemonStatus(userB, port)).toBeNull()
    const b = await listenLocalSocket((_req, res) => res.end(JSON.stringify({ machineId: 'account-b', signedIn: false })), localSocketPath(userB, port)!)
    cleanup.push(b.close)
    expect(await localDaemonStatus(userA, port)).toEqual({ machineId: 'account-a' })
    expect(await localDaemonStatus(userB, port)).toEqual({ machineId: 'account-b', signedIn: false })
    expect(foreignRequests).toBe(0)
  })

  it('refuses a socket accessible to other OS users', async () => {
    const dir = directory(), port = 19418
    let requests = 0
    const socket = await listenLocalSocket((_req, res) => { requests++; res.end('{}') }, localSocketPath(dir, port)!)
    cleanup.push(socket.close)
    chmodSync(socket.path, 0o666)
    expect(await localDaemonStatus(dir, port)).toBeNull()
    expect(requests).toBe(0)
  })

  it('treats invalid status responses as unavailable', async () => {
    const dir = directory(), port = 19418
    let body = 'not json', status = 200
    const socket = await listenLocalSocket((_req, res) => { res.statusCode = status; res.end(body) }, localSocketPath(dir, port)!)
    cleanup.push(socket.close)
    expect(await localDaemonStatus(dir, port)).toBeNull()
    body = '[]'
    expect(await localDaemonStatus(dir, port)).toBeNull()
    body = '{}'; status = 503
    expect(await localDaemonStatus(dir, port)).toBeNull()
  })

  it('accepts legacy CLI status only when both the saved PID and computer identity match', async () => {
    const status = { pid: 43210, computerId: 'this-user', machineId: 'signed-out-local' }
    let requests = 0
    const server = createServer((_req, res) => { requests++; res.end(JSON.stringify(status)) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    const port = (server.address() as { port: number }).port
    expect(await legacyDaemonStatus(port, null, 'this-user')).toBeNull()
    expect(requests).toBe(0)
    expect(await legacyDaemonStatus(port, 43211, 'this-user')).toBeNull()
    expect(await legacyDaemonStatus(port, 43210, 'other-user')).toBeNull()
    expect(await legacyDaemonStatus(port, 43210, 'this-user')).toEqual(status)
  })

  it('shows legacy status this OS user\'s local credential when it is given the data dir', async () => {
    const status = { pid: 43210, computerId: 'this-user' }
    const seen: Array<string | undefined> = []
    const server = createServer((req, res) => { seen.push(req.headers['x-harness-local'] as string | undefined); res.end(JSON.stringify(status)) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    const port = (server.address() as { port: number }).port
    // Too long to hold a socket: the one case where the credential goes to the port.
    const dataDir = join(directory(), 'd'.repeat(100))
    mkdirSync(dataDir, { mode: 0o700 })
    const credential = loadOrCreateHookCredential(dataDir)
    expect(await legacyDaemonStatus(port, 43210, 'this-user', dataDir)).toEqual(status)
    expect(await legacyDaemonStatus(port, 43210, 'this-user')).toEqual(status)
    expect(seen).toEqual([credential, undefined])
  })

  // Audit W1 (docs/security/2026-11-02-team-account-windows.md): it fell back to the port with this user's credential, and
  // the Team account's daemon, started at boot, can hold that port.
  it.each([
    ['no pipe', async (): Promise<PipeTarget | null> => null],
    ['nothing listening on the pipe', async (): Promise<PipeTarget | null> => ({ pipe: join(directory(), `harness-${'0'.repeat(32)}`), token: Buffer.alloc(32, 1) })],
  ] as const)('never tries the port on Windows: with %s it fails as a daemon that is down', async (_name, pipe) => {
    const dataDir = directory()
    loadOrCreateHookCredential(dataDir)
    let called = false
    const failed = await localDaemonCall(dataDir, 19418, 'POST', '/api/pair', { code: 'one-use' }, {
      platform: 'win32', pipe, tcpPort: 24567,
      fetch: async () => { called = true; return new Response('{}', { status: 200 }) },
    }).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(TypeError)
    expect((failed as TypeError).message).toBe('fetch failed')
    expect(called).toBe(false)
  })
})

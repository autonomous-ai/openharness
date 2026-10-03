import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { legacyDaemonStatus, localDaemonStatus, saveDaemonPort, savedDaemonPort } from './daemonEndpoint.js'
import { listenLocalSocket, localSocketPath } from './localSocket.js'

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

  it('persists separate TCP port records per user and configured endpoint', () => {
    const a = directory(), b = directory()
    expect(savedDaemonPort(a, 18473)).toBe(18473)
    saveDaemonPort(a, 18473, 24567)
    expect(savedDaemonPort(a, 18473)).toBe(24567)
    expect(savedDaemonPort(b, 18473)).toBe(18473)
    expect(savedDaemonPort(a, 18474)).toBe(18474)
    const file = join(a, 'daemon-18473.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ port: 24567 })
    for (const body of ['broken', '{}', '{"port":-1}', '{"port":65536}', '{"port":"24567"}']) {
      writeFileSync(file, body)
      expect(savedDaemonPort(a, 18473)).toBe(18473)
    }
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
})

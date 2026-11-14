import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { listenLocalSocket, type LocalSocketServer } from '../lib/localSocket.js'
import { devicesListenerPath } from './listenerPath.js'
import { tellDevices } from './listenerClient.js'

const FRONT = { type: 'front', app: 'ghostty' }
const dirs: string[] = []
const servers: LocalSocketServer[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// A short data folder of the test's own, so the socket is beside it and never under the developer's home.
function dataDir(): string {
  const dir = mkdtempSync('/tmp/hdc-')
  dirs.push(dir)
  return dir
}

interface Heard { method?: string; url?: string; body: string }
/** A real private socket where the devices listener would be, answering as [answer] says; it hears every request. */
async function listener(dir: string, answer: (res: ServerResponse) => void = res => { res.writeHead(204).end() }) {
  const heard: Heard[] = []
  const server = await listenLocalSocket((req: IncomingMessage, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      heard.push({ method: req.method, url: req.url, body })
      answer(res)
    })
  }, devicesListenerPath(dir)!)
  servers.push(server)
  return { heard, server }
}

describe.skipIf(process.platform === 'win32')('tellDevices, on a socket', () => {
  it("tells the data folder's devices socket: POST /, the message as JSON, true on 204", async () => {
    const dir = dataDir()
    const { heard } = await listener(dir)
    expect(await tellDevices(dir, FRONT)).toBe(true)
    expect(heard).toEqual([{ method: 'POST', url: '/', body: '{"type":"front","app":"ghostty"}' }])
  })

  it('true on 200 with an answer', async () => {
    const dir = dataDir()
    await listener(dir, res => { res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}') })
    expect(await tellDevices(dir, FRONT)).toBe(true)
  })

  it('false when the listener answers 400, 404, 413, 429 or 500', async () => {
    const dir = dataDir()
    let status = 0
    const { heard } = await listener(dir, res => { res.writeHead(status).end() })
    for (status of [400, 404, 413, 429, 500]) expect(await tellDevices(dir, FRONT)).toBe(false)
    expect(heard).toHaveLength(5)
  })

  it('an answer is never left unread: the connection is let go at once', async () => {
    const dir = dataDir()
    const { server } = await listener(dir, res => { res.writeHead(429).end('{"error":"slow down"}') })
    for (let i = 0; i < 3; i++) expect(await tellDevices(dir, FRONT)).toBe(false)
    // The listener takes 16 connections at most: one held by each unread answer would soon refuse the watch.
    const open = () => new Promise<number>((resolve, reject) => server.server.getConnections((error, count) => error ? reject(error) : resolve(count)))
    await vi.waitFor(async () => expect(await open()).toBe(0))
  })

  it('false with no socket there, and nothing is sent', async () => {
    const dir = dataDir()
    // A listener of another data folder hears nothing either.
    const { heard } = await listener(dataDir())
    expect(await tellDevices(dir, FRONT)).toBe(false)
    expect(heard).toEqual([])
  })

  it('a socket of another account, or one looser than 0600, is told nothing', async () => {
    const dir = dataDir()
    const { heard, server } = await listener(dir)
    const uid = process.getuid!()
    const other = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)
    expect(await tellDevices(dir, FRONT)).toBe(false)
    other.mockRestore()
    chmodSync(server.path, 0o666)
    expect(await tellDevices(dir, FRONT)).toBe(false)
    chmodSync(server.path, 0o600)
    chmodSync(dir, 0o777)
    expect(await tellDevices(dir, FRONT)).toBe(false)
    expect(heard).toEqual([])
    // The same socket, private again, is told.
    chmodSync(dir, 0o700)
    expect(await tellDevices(dir, FRONT)).toBe(true)
    expect(heard).toHaveLength(1)
  })

  it('false when the listener does not answer in time', async () => {
    const dir = dataDir()
    const { heard } = await listener(dir, () => {})
    expect(await tellDevices(dir, FRONT, { timeoutMs: 50 })).toBe(false)
    expect(heard).toHaveLength(1)
  })
})

describe('tellDevices, anywhere', () => {
  it('false on Windows without a call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    expect(await tellDevices('C:\\Users\\me\\.harness', FRONT, { platform: 'win32', fetch })).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    const rejects = vi.fn<typeof globalThis.fetch>(async () => { throw new TypeError('fetch failed') })
    expect(await tellDevices('/tmp/hdc-none', FRONT, { platform: 'linux', fetch: rejects })).toBe(false)
    const throws = vi.fn<typeof globalThis.fetch>(() => { throw new TypeError('fetch failed') })
    expect(await tellDevices('/tmp/hdc-none', FRONT, { platform: 'linux', fetch: throws })).toBe(false)
    expect(rejects).toHaveBeenCalledOnce()
    expect(throws).toHaveBeenCalledOnce()
  })
})

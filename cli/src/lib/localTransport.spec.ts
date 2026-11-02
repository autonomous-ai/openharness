/**
 * Audit W1 (docs/security/2026-11-02-team-account-windows.md): on Windows the CLI's clients put the owner's local
 * credential on every loopback TCP request, and the Team account's daemon, started at boot, can hold that port. They now
 * go over the daemon's proven pipe, and with none they fail as a daemon that is down, never TCP. A Unix socket with a
 * pipe's name stands for the pipe on macOS and Linux, with the same auth (lib/windows/pipeAuth.ts).
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { writeDaemonRecord } from './daemonRecord.js'
import { isTrustedLocal, listenLocalSocket, pipeProofOf } from './localSocket.js'
import { daemonFetch, daemonPipeNow, openLocalWs } from './localTransport.js'
import { NOT_RUNNING } from './unreachable.js'
import { PIPE_PROOF_HEADER } from './windows/pipeAuth.js'
import { PipeUnproven, type PipeTarget } from './windows/pipeClient.js'

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

/** A data folder short enough to hold a socket, and a pipe's name in it. */
function folder(): { data: string; pipe: string } {
  const data = mkdtempSync('/tmp/hlt-')
  cleanup.push(() => rmSync(data, { recursive: true, force: true }))
  return { data, pipe: join(data, `harness-${randomBytes(16).toString('hex')}`) }
}

async function listen(server: Server, at: number | string): Promise<void> {
  tolerant(server)
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  await new Promise<void>((resolve) => { typeof at === 'number' ? server.listen(at, '127.0.0.1', resolve) : server.listen(at, resolve) })
}

/**
 * A test server's own sockets may be written to after the client has gone: an answer the client refused for want of the
 * proof, then destroyed. On Linux that write is an EPIPE on the server's end, which nobody here needs to hear (CI on #2605).
 */
function tolerant(server: Server): void {
  server.on('connection', (socket) => { socket.on('error', () => {}) })
}

/** Whoever holds the daemon's port: it records everything it is sent. */
async function portHolder(): Promise<{ port: number; heard: string[] }> {
  const heard: string[] = []
  const server = createServer((req, res) => { heard.push(req.url ?? ''); req.resume(); res.end('{}') })
  server.on('upgrade', (req, socket) => { heard.push(req.url ?? ''); socket.destroy() })
  await listen(server, 0)
  return { port: (server.address() as AddressInfo).port, heard }
}

type Seen = { method: string; url: string; trusted: boolean; type: string | undefined; credential: unknown; body: Buffer }

/** The daemon's pipe, as the daemon serves it (lib/localSocket.ts): every request proves the token. */
async function pipeDaemon(pipe: string, token: Buffer): Promise<Seen[]> {
  const seen: Seen[] = []
  const served = await listenLocalSocket((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', trusted: isTrustedLocal(req), type: req.headers['content-type'],
        credential: req.headers['x-harness-local'], body: Buffer.concat(chunks) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  }, pipe, { token })
  tolerant(served.server)
  cleanup.push(served.close)
  return seen
}

const never = (async () => { throw new Error('plain fetch was called') }) as unknown as typeof fetch

describe('daemonFetch on Windows goes over the daemon\'s pipe, never its port (W1)', () => {
  it('a JSON request reaches the pipe with the auth and no credential, and its answer is taken', async () => {
    const { pipe } = folder(), token = randomBytes(32)
    const seen = await pipeDaemon(pipe, token)
    const holder = await portHolder()
    const fetcher = daemonFetch('/nowhere', holder.port, never, 'win32', async () => ({ pipe, token }))
    const answer = await fetcher(`http://127.0.0.1:${holder.port}/api/machines?x=1`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-adapter-local': '1' }, body: '{"a":1}',
    })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ ok: true })
    expect(seen.map(({ body, ...rest }) => ({ ...rest, body: body.toString() }))).toEqual([
      { method: 'POST', url: '/api/machines?x=1', trusted: true, type: 'application/json', credential: undefined, body: '{"a":1}' },
    ])
    expect(holder.heard).toEqual([])
  })

  it('a 10 MB form goes whole over the pipe, with its content type', async () => {
    const { pipe } = folder(), token = randomBytes(32)
    const seen = await pipeDaemon(pipe, token)
    const form = new FormData()
    const bytes = randomBytes(10 * 1024 * 1024)
    form.append('file', new Blob([bytes]), 'big.bin')
    const answer = await daemonFetch('/nowhere', 4242, never, 'win32', async () => ({ pipe, token }))('http://127.0.0.1:4242/api/super-tabs/t/attachments', { method: 'POST', body: form })
    expect(answer.status).toBe(200)
    expect(seen[0]!.type).toMatch(/^multipart\/form-data; boundary=/)
    expect(seen[0]!.body.includes(bytes)).toBe(true)
  })

  it('with no pipe it fails as fetch does when the daemon is down, and the port hears nothing', async () => {
    const holder = await portHolder()
    const failed = await daemonFetch('/nowhere', holder.port, never, 'win32', async () => null)(`http://127.0.0.1:${holder.port}/api/status`).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(TypeError)
    expect((failed as TypeError).message).toBe('fetch failed')
    expect(((failed as TypeError).cause as NodeJS.ErrnoException).code).toBe('ECONNREFUSED')
    expect(holder.heard).toEqual([])
  })

  it('takes no answer without the daemon\'s proof: whatever took the pipe\'s name is not the daemon', async () => {
    const { pipe } = folder(), token = randomBytes(32)
    await listen(createServer((req, res) => { req.resume(); res.writeHead(200, { [PIPE_PROOF_HEADER]: 'a'.repeat(64) }); res.end('{"ok":true}') }), pipe)
    await expect(daemonFetch('/nowhere', 4242, never, 'win32', async () => ({ pipe, token }))('http://127.0.0.1:4242/api/status')).rejects.toBeInstanceOf(PipeUnproven)
  })

  it('leaves every other address to plain fetch: a storage link is not the daemon', async () => {
    const seen: string[] = []
    const base = (async (input: Parameters<typeof fetch>[0]) => { seen.push(String(input)); return new Response('{}') }) as typeof fetch
    const pipe = async (): Promise<PipeTarget | null> => { throw new Error('the pipe was looked up') }
    await daemonFetch('/nowhere', 4242, base, 'win32', pipe)('http://127.0.0.1:9999/upload')
    await daemonFetch('/nowhere', 4242, base, 'win32', pipe)('https://storage.example/upload')
    expect(seen).toEqual(['http://127.0.0.1:9999/upload', 'https://storage.example/upload'])
  })
})

describe('openLocalWs: a WebSocket to the daemon on Windows opens the pipe and never the port (W1)', () => {
  it('opens the pipe, proving the token, and is open only once the daemon has proven itself', async () => {
    const { pipe } = folder(), token = randomBytes(32)
    const served = await listenLocalSocket((_req, res) => res.end(), pipe, { token })
    cleanup.push(served.close)
    const wss = new WebSocketServer({ noServer: true })
    cleanup.push(() => wss.close())
    let trusted = false
    served.server.on('upgrade', (req: IncomingMessage, socket, head) => {
      trusted = isTrustedLocal(req)
      wss.once('headers', (headers) => { headers.push(`${PIPE_PROOF_HEADER}: ${pipeProofOf(req)}`) })
      // Only the client closes, and the server's end is told nothing it could fail on: both closing at once wrote a close
      // frame to a socket already gone, an EPIPE with no listener (CI on #2605).
      wss.handleUpgrade(req, socket, head, (ws) => { ws.on('error', () => {}) })
    })
    let connected = false
    const socket = openLocalWs<WebSocket>('/nowhere', 4242, () => { connected = true; throw new Error('connect was called') }, 'win32', () => ({ pipe, token }))
    await new Promise<void>((resolve, reject) => { socket.on('open', () => resolve()); socket.on('error', reject) })
    await new Promise<void>((resolve) => { socket.once('close', () => resolve()); socket.close() })
    expect(trusted).toBe(true)
    expect(connected).toBe(false)
  })

  it('with no pipe it says Harness is not running, and never calls connect', () => {
    let connected = false
    expect(() => openLocalWs('/nowhere', 4242, () => { connected = true }, 'win32', () => null)).toThrow(NOT_RUNNING)
    expect(connected).toBe(false)
  })

  it('elsewhere connects to the daemon\'s socket, with no credential', () => {
    const { data } = folder()
    const asked: Array<[string, Record<string, string>]> = []
    openLocalWs(data, 4242, (url, headers) => { asked.push([url, headers]) }, 'darwin')
    expect(asked).toEqual([[`ws+unix://${join(data, 'daemon-4242.sock')}:/api/local-ws`, {}]])
  })
})

describe('daemonPipeNow: the daemon\'s pipe for a client that opens at once', () => {
  const token = randomBytes(32)
  const prepared = (pid: number | null, withToken = true) => {
    const { data, pipe } = folder()
    if (withToken) writeFileSync(join(data, 'daemon-token'), `${token.toString('hex')}\n`, { mode: 0o600 })
    if (pid !== null) writeDaemonRecord(data, 4242, 50_000, { pipe, pid })
    return { data, pipe }
  }

  it('is the recorded pipe and the token while the recorded daemon runs', () => {
    const { data, pipe } = prepared(process.pid)
    expect(daemonPipeNow(data, 4242)).toEqual({ pipe, token })
  })

  it('is none with no record, no token, or a daemon that has exited', () => {
    expect(daemonPipeNow(prepared(null).data, 4242)).toBeNull()
    expect(daemonPipeNow(prepared(process.pid, false).data, 4242)).toBeNull()
    expect(daemonPipeNow(prepared(spawnSync(process.execPath, ['-e', '']).pid!).data, 4242)).toBeNull()
  })

  // The daemon is this account's: a pid another account runs (EPERM; pid 1 is root's) was reused since it exited.
  it.skipIf(process.getuid?.() === 0)('is none when another account runs the recorded pid now', () => {
    expect(daemonPipeNow(prepared(1).data, 4242)).toBeNull()
  })
})

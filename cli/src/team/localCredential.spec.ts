/**
 * Audit H1 (docs/security/2026-11-02-team-account-boundary.md): while the daemon restarts, any account can bind its port.
 * A listener here stands for that account. The listener runs as this user: what is tested is what it is sent, and for
 * what it could do with that, a stand-in says the caller is another account.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest'
import { connectSocket } from '../agentClient/daemon.js'
import { deviceRequest } from '../devices/client.js'
import { createMessagesRpc } from '../messages/rpc.js'
import { daemonFetch, localSocketRoute, localWsTarget } from '../lib/localTransport.js'
import { localCredentialHeaders } from '../lib/localCredential.js'
import { uploadAttachments } from '../superTabs/attach.js'
import { WebSocket } from 'ws'

// A folder too long for a socket now has one under the home folder: only a home too long as well is left on the port.
beforeEach(() => { vi.stubEnv('HOME', `/${'h'.repeat(120)}`) })
afterEach(() => { vi.unstubAllEnvs() })

const NOTIFY = fileURLToPath(new URL('../../hook/notify.mjs', import.meta.url))
/** Made up for this test: never a real credential. */
const CREDENTIAL = 'A'.repeat(43)
const HOOK_TOKEN = 'B'.repeat(43)

type Heard = { url: string; headers: IncomingMessage['headers']; body: string }

describe('audit H1: whoever holds the daemon\'s port hears nothing it can use', () => {
  const cleanup: Array<() => Promise<unknown> | unknown> = []
  afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

  const dataFolder = (long = false): { root: string; data: string } => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hc-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const data = long ? join(root, 'd'.repeat(100)) : join(root, 'data')
    mkdirSync(data, { mode: 0o700 })
    writeFileSync(join(data, 'hook-credential'), CREDENTIAL, { mode: 0o600 })
    writeFileSync(join(data, 'hook-token'), HOOK_TOKEN, { mode: 0o600 })
    return { root, data }
  }

  const listen = async (server: Server, at: number | string): Promise<void> => {
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    await new Promise<void>((resolve) => { typeof at === 'number' ? server.listen(at, '127.0.0.1', resolve) : server.listen(at, resolve) })
  }

  /** A plain listener: a Team agent on the port. It records all it is sent and takes any WebSocket's upgrade request. */
  const holder = async (at: number | string = 0): Promise<{ port: number; heard: Heard[] }> => {
    const heard: Heard[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        heard.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() })
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}')
      })
    })
    server.on('upgrade', (req, socket) => {
      heard.push({ url: req.url ?? '', headers: req.headers, body: '' })
      socket.destroy()
    })
    await listen(server, at)
    // The daemon's socket is 0600 (lib/localSocket.ts), and a hook refuses any other.
    if (typeof at === 'string') chmodSync(at, 0o600)
    const address = server.address()
    return { port: typeof address === 'string' ? 0 : (address as AddressInfo).port, heard }
  }

  const runHook = async (root: string, data: string, port: number, home: string = root): Promise<void> => {
    const hook = spawn(process.execPath, [NOTIFY, '--port', String(port), '--data-dir', data], {
      stdio: ['pipe', 'ignore', 'ignore'],
      // Its own empty tmux folder, so the pane's routing reads no real tmux server.
      env: { PATH: process.env.PATH, HOME: home, TMUX_PANE: '%999', TMUX_TMPDIR: root },
    })
    hook.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'a private prompt', session_id: '11111111-1111-4111-8111-111111111111', cwd: root }))
    await new Promise<void>((resolve) => { hook.on('exit', () => resolve()) })
  }

  const secretIn = (heard: Heard[]): boolean => JSON.stringify(heard).includes(CREDENTIAL)

  it('an engine hook sends a listener on the port nothing at all: no credential, no prompt', async () => {
    const { root, data } = dataFolder()
    const { port, heard } = await holder()
    await runHook(root, data, port)
    expect(heard).toEqual([])
  }, 30_000)

  it('an engine hook reports over the socket, with the listener on the port still hearing nothing', async () => {
    const { root, data } = dataFolder()
    const { port, heard } = await holder()
    const daemon = await holder(join(data, `daemon-${port}.sock`))
    await runHook(root, data, port)
    expect(heard).toEqual([])
    expect(daemon.heard.length).toBeGreaterThan(0)
  }, 30_000)

  it('an engine hook finds the socket by the daemon\'s record when its port is the one the daemon was given instead', async () => {
    const { root, data } = dataFolder()
    const { port, heard } = await holder()
    const daemon = await holder(join(data, 'daemon-18473.sock'))
    writeFileSync(join(data, 'daemon-18473.json'), JSON.stringify({ port }), { mode: 0o600 })
    await runHook(root, data, port)
    expect(heard).toEqual([])
    expect(daemon.heard.length).toBeGreaterThan(0)
  }, 30_000)

  it('a data folder too long for a socket: the hook uses its short one, and a holder of the port hears nothing', async () => {
    const { root, data } = dataFolder(true)
    const home = realpathSync(mkdtempSync(join('/tmp', 'hc-')))
    cleanup.push(() => rmSync(home, { recursive: true, force: true }))
    const folder = join(home, '.harness', 's', createHash('sha256').update(data).digest('hex').slice(0, 16))
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const { port, heard } = await holder()
    const daemon = await holder(join(folder, `daemon-${port}.sock`))
    await runHook(root, data, port, home)
    expect(heard).toEqual([])
    expect(daemon.heard.length).toBeGreaterThan(0)
  }, 30_000)

  it('the same with its short socket gone: nothing goes to the port', async () => {
    const { root, data } = dataFolder(true)
    const home = realpathSync(mkdtempSync(join('/tmp', 'hc-')))
    cleanup.push(() => rmSync(home, { recursive: true, force: true }))
    const { port, heard } = await holder()
    await runHook(root, data, port, home)
    expect(heard).toEqual([])
  }, 30_000)

  it('where no socket can exist, a home too long as well, a hook sends only its own token over TCP', async () => {
    const { root, data } = dataFolder(true)
    const { port, heard } = await holder()
    await runHook(root, data, port, `/${'h'.repeat(120)}`)
    expect(heard.length).toBeGreaterThan(0)
    expect(secretIn(heard)).toBe(false)
    expect(heard[0]!.headers['x-harness-hook-token']).toBe(HOOK_TOKEN)
  }, 30_000)

  it('an engine hook refuses a socket another account could reach: not 0600', async () => {
    const { root, data } = dataFolder()
    const { port } = await holder()
    const path = join(data, `daemon-${port}.sock`)
    const open = await holder(path)
    chmodSync(path, 0o666)
    await runHook(root, data, port)
    expect(open.heard).toEqual([])
  }, 30_000)

  it('a TCP request from a client carries no credential where the socket can exist', () => {
    const { data } = dataFolder()
    expect(localCredentialHeaders(data)).toEqual({})
  })

  it('keeps the credential for the one case with no socket, and for Windows', () => {
    expect(localCredentialHeaders(dataFolder(true).data)).toEqual({ 'X-Harness-Local': CREDENTIAL })
    expect(localCredentialHeaders(dataFolder().data, 'win32')).toEqual({ 'X-Harness-Local': CREDENTIAL })
  })

  it('agentClient: with the socket gone, the port hears nothing and the caller is told', async () => {
    const { data } = dataFolder()
    const { port, heard } = await holder()
    const socket = await connectSocket({ dataDir: data, port, machineId: 'm' })
    const failed = await new Promise<NodeJS.ErrnoException>((resolve) => { socket.on('error', resolve) })
    expect(failed.code).toBe('ENOENT')
    expect(heard).toEqual([])
  })

  it('messages: with the socket gone, the port hears nothing and the caller is told', async () => {
    const { data } = dataFolder()
    const { port, heard } = await holder()
    await expect(createMessagesRpc()({ port, machineId: 'm', dataDir: data }, { op: 'x' }, 5_000)).rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE' })
    expect(heard).toEqual([])
  })

  it('devices: with the socket gone, the port hears nothing and the caller is told', async () => {
    const { data } = dataFolder()
    const { port, heard } = await holder()
    const deps = { port, dataDir: data, machineId: async () => 'm', connect: (url: string, headers?: Record<string, string>) => new WebSocket(url, { headers }) }
    await expect(deviceRequest(deps, 'm', 'device_x')).rejects.toThrow(/ENOENT/)
    expect(heard).toEqual([])
  })

  it('attachments: with the socket gone, the port hears neither the credential nor the file', async () => {
    const { root, data } = dataFolder()
    const { port, heard } = await holder()
    const file = join(root, 'private.txt')
    writeFileSync(file, 'private file')
    const ask = async () => ({ value: { agentId: 'a' } })
    await expect(uploadAttachments([file], 'op', { tabId: 't', conversationId: 'c', port, dataDir: data }, ask)).rejects.toThrow()
    expect(heard).toEqual([])
  })

  it('attachments: a form goes whole over the socket, with its content type', async () => {
    const { root, data } = dataFolder()
    const { port, heard } = await holder()
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        expect(req.headers['content-type']).toMatch(/^multipart\/form-data/)
        expect(Buffer.concat(chunks).toString()).toContain('a file for the daemon')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: { attachment: { id: 'stored' } } }))
      })
    })
    await listen(server, join(data, `daemon-${port}.sock`))
    const file = join(root, 'note.txt')
    writeFileSync(file, 'a file for the daemon')
    const ask = async () => ({ value: { agentId: 'a' } })
    expect(await uploadAttachments([file], 'op', { tabId: 't', conversationId: 'c', port, dataDir: data }, ask)).toEqual(['stored'])
    expect(heard).toEqual([])
  })

  it('daemonFetch leaves every other address to plain fetch: a storage link has no socket', async () => {
    const { data } = dataFolder()
    const elsewhere = await holder()
    const seen: string[] = []
    const base = (async (input: Parameters<typeof fetch>[0]) => { seen.push(String(input)); return new Response('{}') }) as typeof fetch
    await daemonFetch(data, elsewhere.port + 1, base)(`http://127.0.0.1:${elsewhere.port}/upload`)
    expect(seen).toEqual([`http://127.0.0.1:${elsewhere.port}/upload`])
  })

  it('daemonFetch answers no body for a 204', async () => {
    const { data } = dataFolder()
    const server = createServer((_req, res) => { res.writeHead(204); res.end() })
    await listen(server, join(data, 'daemon-4242.sock'))
    const answer = await daemonFetch(data, 4242)('http://127.0.0.1:4242/x', { method: 'POST', body: '{}' })
    expect(answer.status).toBe(204)
  })

  it('finds no socket on Windows, and TCP there keeps its record\'s port', () => {
    const { data } = dataFolder()
    expect(localSocketRoute(data, 4242, 'win32')).toBeNull()
    expect(localWsTarget(data, 4242, 'win32').url).toBe('ws://127.0.0.1:4242/api/local-ws')
  })
})

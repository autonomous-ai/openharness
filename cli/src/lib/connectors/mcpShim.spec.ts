/**
 * MCP clients reach the bridge through a stdio shim, over a 0600 socket (follow-up of audit H1): whoever holds the bridge's old
 * port hears no tool call, however the daemon is doing.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { managedNodePath } from '../nodeRuntime.js'
import { bridgePipeRecord, bridgeSocketPath, sync } from './agents.js'
import { serveBridgePipe, serveBridgeSocket } from './bridge.js'
import { MCP_SHIM_SOURCE } from './mcpShimSource.js'
import { Store, writePrivate } from './store.js'

let home: string
let vault: Store
let env: NodeJS.ProcessEnv
const closers: Array<() => void> = []

const listen = (server: Server): Promise<number> => new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  closers.push(() => { server.closeAllConnections(); server.close() })
})

/** The service's MCP server: answers each request as JSON, or tools/call as an event stream. */
async function upstream(): Promise<{ url: string; heard: Array<{ method: string; session?: string; auth?: string; version?: string }> }> {
  const heard: Array<{ method: string; session?: string; auth?: string; version?: string }> = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const message = JSON.parse(raw) as { id?: number; method: string }
      heard.push({ method: message.method, session: request.headers['mcp-session-id'] as string | undefined,
        auth: request.headers.authorization, version: request.headers['mcp-protocol-version'] as string | undefined })
      if (message.id === undefined) { response.writeHead(202).end(); return }
      if (message.method === 'tools/call') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: 'done' } })}\n\n`)
        return
      }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { tools: [] }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  return { url: `http://127.0.0.1:${await listen(server)}/mcp`, heard }
}

/** A process of another account on the bridge's old port, hearing everything sent there. */
async function holder(): Promise<{ port: number; heard: string[] }> {
  const heard: string[] = []
  const server = createServer((request, response) => {
    heard.push(request.url ?? '')
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: 'false answer' } }))
  })
  return { port: await listen(server), heard }
}

/** The shim as a real process, as a client runs it from its entry: to the socket, or with `--pipe` to the pipe its record names. */
function shimProcess(code: string, socket: string, grace = 5000, flag = '--socket'): ChildProcessWithoutNullStreams {
  const shim = join(vault.root, 'mcp-shim.mjs')
  mkdirSync(vault.root, { recursive: true })
  writeFileSync(shim, MCP_SHIM_SOURCE)
  return spawn(process.execPath, [shim, flag, socket, code, '--grace-ms', String(grace)])
}

/** Speak to the shim as an MCP client: newline-delimited JSON-RPC over its stdin and stdout. */
function client(code: string, socket: string, flag = '--socket'): { send(message: unknown): void; end(): void; lines: unknown[]; done: Promise<number | null> } {
  const child = shimProcess(code, socket, 5000, flag), lines: unknown[] = []
  let held = ''
  child.stdout.on('data', chunk => {
    held += String(chunk)
    for (let at = held.indexOf('\n'); at >= 0; at = held.indexOf('\n')) { lines.push(JSON.parse(held.slice(0, at))); held = held.slice(at + 1) }
  })
  return { send: message => child.stdin.write(JSON.stringify(message) + '\n'), end: () => child.stdin.end(), lines,
    done: new Promise(resolve => child.on('exit', resolve)) }
}

/** The shim's arguments as Claude Code's entry names them. */
function claudeEntry(code: string): { type?: string; url?: string; command?: string; args?: string[] } {
  return (JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as { mcpServers: Record<string, never> }).mcpServers[code]
}
const socketOf = (entry: { args?: string[] }): string => entry.args![entry.args!.indexOf('--socket') + 1]

beforeEach(() => {
  home = mkdtempSync('/tmp/hmcp-')
  env = { HOME: home, PATH: '', XDG_CONFIG_HOME: join(home, '.config'), CODEX_HOME: join(home, '.codex') }
  mkdirSync(join(home, '.codex'))
  vault = new Store(join(home, 'c'), env)
})
afterEach(() => { while (closers.length) closers.pop()!(); rmSync(home, { recursive: true, force: true }) })

describe.skipIf(process.platform === 'win32')('the MCP clients\' way to the bridge', () => {
  it('a holder of the old port receives no tool call, and tools still work through the shim', async () => {
    const fake = await upstream(), port = await holder()
    env.HARNESS_CONNECTIONS_PORT = String(port.port)
    vault.save('linear', { access_token: 'secret-linear', source: 'dcr', mcp_entry: { url: fake.url, headers: { authorization: 'Bearer secret-linear' } } })
    // What a client's configuration names is all it has: no address, so the holder is never asked.
    writeJson(join(home, '.claude.json'))
    sync(vault, { ...env, CLAUDE_CONFIG_DIR: home })
    const entry = claudeEntry('linear')
    expect(JSON.stringify(entry)).not.toContain(String(port.port))
    const local = await serveBridgeSocket(vault, bridgeSocketPath(vault)!)
    closers.push(() => local.close())
    expect(lstatSync(socketOf(entry)).mode & 0o777).toBe(0o600)

    const shim = client('linear', socketOf(entry))
    shim.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    shim.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    shim.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } })
    shim.end()
    await shim.done

    expect(port.heard).toEqual([])
    expect(fake.heard.map(h => h.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    expect(fake.heard[1]).toMatchObject({ session: 'session-1', version: '2025-06-18' })
    expect(fake.heard[2]).toMatchObject({ session: 'session-1', auth: 'Bearer secret-linear' })
    expect(shim.lines).toEqual([
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
      { jsonrpc: '2.0', id: 2, result: { content: 'done' } },
    ])
  })

  it('with the daemon down, says so and sends nothing to the port', async () => {
    const port = await holder()
    env.HARNESS_CONNECTIONS_PORT = String(port.port)
    const shim = client('linear', bridgeSocketPath(vault)!)
    shim.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} })
    shim.send({ jsonrpc: '2.0', method: 'notifications/cancelled' })
    shim.end()
    await shim.done
    expect(port.heard).toEqual([])
    expect(shim.lines).toEqual([{ jsonrpc: '2.0', id: 7, error: { code: -32001, message: expect.stringContaining('Harness is not running') } }])
  })

  it('says the bridge\'s refusal under the id of the request it answers', async () => {
    const local = await serveBridgeSocket(vault, bridgeSocketPath(vault)!)
    closers.push(() => local.close())
    const shim = client('nothing-here', bridgeSocketPath(vault)!)
    shim.send({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
    shim.end()
    await shim.done
    expect(shim.lines).toEqual([{ jsonrpc: '2.0', id: 9, error: { code: -32001, message: expect.any(String) } }])
  })

  it('the socket reaches MCP servers only: no list of the connections, no key-only API, and no other address', async () => {
    const fake = await upstream()
    vault.save('linear', { access_token: 'secret-linear', source: 'dcr', mcp_entry: { url: fake.url, headers: {} } })
    const socket = bridgeSocketPath(vault)!
    const local = await serveBridgeSocket(vault, socket)
    closers.push(() => local.close())
    const ask = (path: string, headers: Record<string, string> = {}): Promise<number> => new Promise((resolve, reject) => {
      const sent = httpRequest({ socketPath: socket, path, method: 'POST', headers }, answer => { answer.resume(); resolve(answer.statusCode ?? 0) })
      sent.on('error', reject)
      sent.end('{}')
    })
    expect(await ask('/local/connections')).toBe(404)
    expect(await ask('/local/linear/api/x')).toBe(404)
    expect(await ask('/other/linear/mcp')).toBe(404)
    // A page cannot reach a socket; a request naming one is refused all the same.
    expect(await ask('/local/linear/mcp', { origin: 'https://evil.example' })).toBe(403)
    expect(fake.heard).toEqual([])
  })

  it('answers a request the service left unanswered, so the client does not wait for ever', async () => {
    const silent = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end())
    const port = await listen(silent)
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: `http://127.0.0.1:${port}/mcp`, headers: {} } })
    const local = await serveBridgeSocket(vault, bridgeSocketPath(vault)!)
    closers.push(() => local.close())
    const shim = client('linear', bridgeSocketPath(vault)!)
    shim.send({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
    shim.end()
    await shim.done
    expect(shim.lines).toEqual([{ jsonrpc: '2.0', id: 4, error: { code: -32001, message: expect.stringContaining('could not be read') } }])
  })

  it('a line that is no JSON-RPC is answered as a parse error, and the next still goes', async () => {
    const fake = await upstream()
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: fake.url, headers: {} } })
    const local = await serveBridgeSocket(vault, bridgeSocketPath(vault)!)
    closers.push(() => local.close())
    const child = shimProcess('linear', bridgeSocketPath(vault)!)
    const out: string[] = []
    child.stdout.on('data', chunk => out.push(String(chunk)))
    child.stdin.write('not json\n')
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) + '\n')
    await new Promise(resolve => child.on('exit', resolve))
    const lines = out.join('').trim().split('\n').map(line => JSON.parse(line) as { id: unknown; error?: { code: number } })
    expect(lines[0]).toMatchObject({ id: null, error: { code: -32700 } })
    expect(lines[1]).toMatchObject({ id: 3 })
  })

  it('the entries name the shim, with no port and no key, for every client', () => {
    env.HARNESS_CONNECTIONS_PORT = '51793'
    vault.save('linear', { access_token: 'secret-linear', source: 'dcr', mcp_entry: { url: 'https://mcp.linear.app/mcp', headers: {} } })
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    const paths = { CLAUDE_CONFIG_DIR: home }
    // `claude` on the PATH and an empty Codex config make them installed.
    const claude = join(home, '.claude.json'), codex = join(home, '.codex', 'config.toml'), opencode = join(home, '.config', 'opencode', 'opencode.json')
    for (const path of [claude, opencode]) writeJson(path)
    writeJson(codex, '')
    sync(vault, { ...env, ...paths })
    const entry = claudeEntry('linear')
    expect(entry).toMatchObject({ type: 'stdio', command: expect.any(String) })
    expect(entry.url).toBeUndefined()
    expect(entry.args!.slice(-3)).toEqual(['--socket', bridgeSocketPath(vault), 'linear'])
    expect(socketOf(entry)).toBe(bridgeSocketPath(vault))
    const texts = [claude, codex, opencode].map(path => readFileSync(path, 'utf8'))
    for (const text of texts) {
      expect(text).not.toContain('127.0.0.1')
      expect(text).not.toContain('51793')
      expect(text).toContain('mcp-shim.mjs')
    }
    expect(texts[1]).toContain('[mcp_servers.linear]\ncommand = ')
    expect(JSON.parse(texts[2]).mcp.linear).toMatchObject({ type: 'local', enabled: true, command: expect.arrayContaining(['--socket', 'linear']) })
  })

  it('an entry names no running script: the shim in the private folder, by Harness\'s own node', () => {
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: 'https://mcp.linear.app/mcp', headers: {} } })
    writeJson(join(home, '.claude.json'))
    sync(vault, { ...env, CLAUDE_CONFIG_DIR: home })
    const entry = claudeEntry('linear')
    expect(entry.command).toBe(managedNodePath())
    expect(entry.args).toEqual([join(vault.root, 'mcp-shim.mjs'), '--socket', bridgeSocketPath(vault), 'linear'])
    expect(JSON.stringify(entry)).not.toContain(process.argv[1])
    expect(readFileSync(entry.args![0], 'utf8')).toBe(MCP_SHIM_SOURCE)
    expect(lstatSync(entry.args![0]).mode & 0o777).toBe(0o600)
  })

  it('the entry a daemon writes from a lean bundle runs: nothing in it depends on the daemon\'s own script', async () => {
    const fake = await upstream()
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: fake.url, headers: {} } })
    writeJson(join(home, '.claude.json'))
    const running = process.argv[1]
    process.argv[1] = '/lean/0123/harnessd.mjs'
    try { sync(vault, { ...env, CLAUDE_CONFIG_DIR: home }) } finally { process.argv[1] = running }
    const entry = claudeEntry('linear')
    const local = await serveBridgeSocket(vault, bridgeSocketPath(vault)!)
    closers.push(() => local.close())
    const child = spawn(entry.command!, entry.args!)
    const out: string[] = []
    child.stdout.on('data', chunk => out.push(String(chunk)))
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
    expect(await new Promise(resolve => child.on('exit', resolve))).toBe(0)
    expect(JSON.parse(out.join(''))).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18' } })
  })

  it('opens a new session when the service forgets this one, once, and the client never hears of it', async () => {
    const heard: Array<{ method: string; session?: string }> = []
    let live = 'one', opens = 0
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', chunk => { raw += chunk })
      request.on('end', () => {
        const message = JSON.parse(raw) as { id?: number; method: string }
        heard.push({ method: message.method, session: request.headers['mcp-session-id'] as string | undefined })
        if (message.method === 'initialize') {
          live = `session-${++opens}`
          response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': live }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', opens } }))
          return
        }
        if (request.headers['mcp-session-id'] !== live) { response.writeHead(404).end(); return }
        if (message.id === undefined) { response.writeHead(202).end(); return }
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }))
      })
    })
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: `http://127.0.0.1:${await listen(server)}/mcp`, headers: {} } })
    const local = await serveBridgeSocket(vault, bridgeSocketPath(vault)!)
    closers.push(() => local.close())
    const shim = client('linear', bridgeSocketPath(vault)!)
    shim.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    shim.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await vi.waitFor(() => expect(heard.map(h => h.method)).toContain('notifications/initialized'))
    live = 'gone'
    shim.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    shim.end()
    await shim.done
    expect(heard.map(h => h.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'initialize', 'notifications/initialized', 'tools/list'])
    expect(heard.at(-1)!.session).toBe('session-2')
    expect(shim.lines).toEqual([{ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', opens: 1 } }, { jsonrpc: '2.0', id: 2, result: { ok: true } }])
  })

  it('a 404 while reopening does not wait on itself: the request is answered and the shim ends', async () => {
    let initializes = 0
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', chunk => { raw += chunk })
      request.on('end', () => {
        const message = JSON.parse(raw) as { id?: number; method: string }
        if (message.method === 'initialize') {
          initializes++
          response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': `s${initializes}` }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
          return
        }
        // The first notification is taken; from then on nothing but `initialize` is, a connection going away.
        if (message.method === 'notifications/initialized' && initializes === 1) { response.writeHead(202).end(); return }
        response.writeHead(404).end()
      })
    })
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: `http://127.0.0.1:${await listen(server)}/mcp`, headers: {} } })
    const local = await serveBridgeSocket(vault, bridgeSocketPath(vault)!)
    closers.push(() => local.close())
    const child = shimProcess('linear', bridgeSocketPath(vault)!, 60_000)
    const out: string[] = []
    child.stdout.on('data', chunk => out.push(String(chunk)))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    expect(await new Promise(resolve => child.on('exit', resolve))).toBe(0)
    const lines = out.join('').trim().split('\n').map(line => JSON.parse(line) as { id: number; error?: unknown })
    expect(lines.find(line => line.id === 2)).toMatchObject({ error: { code: -32001 } })
  })

  it('a 404 with no session behind it is the answer, and a new session is tried only once', async () => {
    let posts = 0
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        posts++
        if (posts === 1) { response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })); return }
        response.writeHead(posts === 2 ? 404 : 500).end()
      })
    })
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: `http://127.0.0.1:${await listen(server)}/mcp`, headers: {} } })
    const local = await serveBridgeSocket(vault, bridgeSocketPath(vault)!)
    closers.push(() => local.close())
    const shim = client('linear', bridgeSocketPath(vault)!)
    shim.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    shim.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    shim.end()
    await shim.done
    expect(posts).toBe(3)
    expect(shim.lines.at(-1)).toMatchObject({ id: 2, error: { code: -32001 } })
  })

  it('a service\'s event that is no JSON is skipped, and the answer after it still comes', async () => {
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        .end(`data: keep-alive\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 5, result: { ok: 1 } })}\n\n`))
    })
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: `http://127.0.0.1:${await listen(server)}/mcp`, headers: {} } })
    const local = await serveBridgeSocket(vault, bridgeSocketPath(vault)!)
    closers.push(() => local.close())
    const shim = client('linear', bridgeSocketPath(vault)!)
    shim.send({ jsonrpc: '2.0', id: 5, method: 'tools/list' })
    shim.end()
    await shim.done
    expect(shim.lines).toEqual([{ jsonrpc: '2.0', id: 5, result: { ok: 1 } }])
  })

  it('a client gone leaves no process: a hung stream is dropped after a short grace', async () => {
    const hung = createServer((request, response) => {
      request.resume()
      request.on('end', () => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': still here\n\n') })
    })
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: `http://127.0.0.1:${await listen(hung)}/mcp`, headers: {} } })
    const local = await serveBridgeSocket(vault, bridgeSocketPath(vault)!)
    closers.push(() => local.close())
    const child = shimProcess('linear', bridgeSocketPath(vault)!, 50)
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }) + '\n')
    expect(await new Promise(resolve => child.on('exit', resolve))).toBe(0)
  })

  it('refuses a socket that is not private: too open, or in an open folder, or not a socket', async () => {
    const socket = bridgeSocketPath(vault)!
    const local = await serveBridgeSocket(vault, socket)
    closers.push(() => local.close())
    const ask = async (): Promise<unknown> => {
      const shim = client('linear', socket)
      shim.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      shim.end()
      await shim.done
      return shim.lines[0]
    }
    const refused = { id: 1, error: { message: expect.stringContaining('not private') } }
    chmodSync(socket, 0o666)
    expect(await ask()).toMatchObject(refused)
    chmodSync(socket, 0o600)
    chmodSync(vault.root, 0o777)
    expect(await ask()).toMatchObject(refused)
    chmodSync(vault.root, 0o700)
    await local.close()
    writeFileSync(socket, 'not a socket')
    expect(await ask()).toMatchObject(refused)
  })

  it('tightens a folder older than this code when it listens', async () => {
    mkdirSync(vault.root, { recursive: true })
    chmodSync(vault.root, 0o755)
    const local = await serveBridgeSocket(vault, bridgeSocketPath(vault)!)
    closers.push(() => local.close())
    expect(lstatSync(vault.root).mode & 0o777).toBe(0o700)
  })

  it('a client\'s reply to the service is no request: an error under its id would answer the client\'s own', async () => {
    const shim = client('linear', bridgeSocketPath(vault)!)
    shim.send({ jsonrpc: '2.0', id: 8, result: { fine: true } })
    shim.end()
    await shim.done
    expect(shim.lines).toEqual([])
  })

  it('moves an entry from the old address, and keeps the address where no socket fits', () => {
    env.HARNESS_CONNECTIONS_PORT = '51793'
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: 'https://mcp.linear.app/mcp', headers: {} } })
    const claude = join(home, '.claude.json')
    writeJson(claude, JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'http://127.0.0.1:51793/k/linear/mcp' } } }))
    writePrivate(join(vault.root, 'projections.json'), { claude: ['linear'] })
    sync(vault, { ...env, CLAUDE_CONFIG_DIR: home })
    expect(claudeEntry('linear').url).toBeUndefined()
    const long = new Store(join(home, 'x'.repeat(120)), env)
    expect(bridgeSocketPath(long)).toMatch(/\/\.harness\/s\/[0-9a-f]{16}\/bridge\.sock$/)
    expect(bridgeSocketPath(vault, 'win32')).toBeNull()
  })
})

// Task #2162 (Reed's review of #2605): on Windows the shim had no socket to reach, so agents' entries named the port, which the
// Team account can hold from boot to read every tool call and answer it falsely. There the shim reaches the bridge's pipe, which
// proves itself (bridge.ts serveBridgePipe). A Unix socket named `harness-<id>` stands for the pipe here.
describe.skipIf(process.platform === 'win32')('the MCP clients\' way to the bridge on Windows: its pipe', () => {
  const pipePath = (): string => {
    mkdirSync(join(home, 'p'), { recursive: true })
    return join(home, 'p', `harness-${randomBytes(16).toString('hex')}`)
  }
  const onPipe = async (): Promise<string> => {
    const listening = await serveBridgePipe(vault, pipePath())
    closers.push(() => listening.closeSync())
    return listening.path
  }

  it('a holder of the old port receives no tool call, and tools still work through the pipe', async () => {
    const fake = await upstream(), port = await holder()
    env.HARNESS_CONNECTIONS_PORT = String(port.port)
    vault.save('linear', { access_token: 'secret-linear', source: 'dcr', mcp_entry: { url: fake.url, headers: { authorization: 'Bearer secret-linear' } } })
    await onPipe()
    const shim = client('linear', bridgePipeRecord(vault), '--pipe')
    shim.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    shim.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    shim.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } })
    shim.end()
    await shim.done
    expect(port.heard).toEqual([])
    expect(fake.heard.map(h => h.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    expect(fake.heard[2]).toMatchObject({ session: 'session-1', auth: 'Bearer secret-linear' })
    expect(shim.lines).toEqual([
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
      { jsonrpc: '2.0', id: 2, result: { content: 'done' } },
    ])
  })

  it('the entries on Windows name the shim and the pipe\'s record, with no port and no key', () => {
    env.HARNESS_CONNECTIONS_PORT = '51793'
    vault.save('linear', { access_token: 'secret-linear', source: 'dcr', mcp_entry: { url: 'https://mcp.linear.app/mcp', headers: {} } })
    writeJson(join(home, '.claude.json'))
    sync(vault, { ...env, CLAUDE_CONFIG_DIR: home }, undefined, 'win32')
    const entry = claudeEntry('linear')
    expect(entry).toMatchObject({ type: 'stdio', command: managedNodePath() })
    expect(entry.args).toEqual([join(vault.root, 'mcp-shim.mjs'), '--pipe', bridgePipeRecord(vault), 'linear'])
    const text = readFileSync(join(home, '.claude.json'), 'utf8')
    expect(text).not.toContain('51793')
    expect(text).not.toContain('127.0.0.1')
    expect(vault.file('bridge.json').key).toBeUndefined()
  })

  it('with the bridge\'s process gone, says Harness is not running and sends nothing: any account can make a pipe of its name then', async () => {
    const fake = await upstream()
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: fake.url, headers: {} } })
    await onPipe()
    writePrivate(bridgePipeRecord(vault), { ...vault.file('bridge-pipe.json'), pid: spawnSync(process.execPath, ['-e', '']).pid })
    const shim = client('linear', bridgePipeRecord(vault), '--pipe')
    shim.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} })
    shim.end()
    await shim.done
    expect(fake.heard).toEqual([])
    expect(shim.lines).toEqual([{ jsonrpc: '2.0', id: 3, error: { code: -32001, message: expect.stringContaining('Harness is not running') } }])
  })

  it('with no record, says Harness is not running', async () => {
    const shim = client('linear', bridgePipeRecord(vault), '--pipe')
    shim.send({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
    shim.end()
    await shim.done
    expect(shim.lines).toEqual([{ jsonrpc: '2.0', id: 4, error: { code: -32001, message: expect.stringContaining('Harness is not running') } }])
  })

  it('does not follow a record that is a link: it could name a pipe this account never made', async () => {
    const fake = await upstream()
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: fake.url, headers: {} } })
    await onPipe()
    const real = join(home, 'elsewhere.json')
    writeFileSync(real, readFileSync(bridgePipeRecord(vault)), { mode: 0o600 })
    rmSync(bridgePipeRecord(vault))
    symlinkSync(real, bridgePipeRecord(vault))
    const shim = client('linear', bridgePipeRecord(vault), '--pipe')
    shim.send({ jsonrpc: '2.0', id: 5, method: 'tools/list' })
    shim.end()
    await shim.done
    expect(fake.heard).toEqual([])
    expect(shim.lines).toEqual([{ jsonrpc: '2.0', id: 5, error: { code: -32001, message: expect.any(String) } }])
  })

  it('takes no answer that does not prove the token: a pipe made under the bridge\'s name answers nothing to the client', async () => {
    const path = pipePath(), heard: string[] = []
    const squatter = createServer((request, response) => {
      heard.push(request.url ?? '')
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 6, result: { content: 'false answer' } }))
    })
    await new Promise<void>(ready => squatter.listen(path, ready))
    closers.push(() => { squatter.closeAllConnections(); squatter.close() })
    writePrivate(bridgePipeRecord(vault), { pipe: path, pid: process.pid, token: randomBytes(32).toString('hex') })
    const shim = client('linear', bridgePipeRecord(vault), '--pipe')
    shim.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} })
    shim.end()
    await shim.done
    expect(heard).toHaveLength(1)
    expect(JSON.stringify(shim.lines)).not.toContain('false answer')
    expect(shim.lines).toEqual([{ jsonrpc: '2.0', id: 6, error: { code: -32001, message: expect.stringContaining('Something other than Harness') } }])
  })
})

function writeJson(path: string, text = '{}'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/**
 * MCP clients reach the bridge through a stdio shim, over a 0600 socket (follow-up of audit H1): whoever holds the bridge's old
 * port hears no tool call, however the daemon is doing.
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bridgeSocketPath, sync } from './agents.js'
import { serveBridgeSocket } from './bridge.js'
import { runMcpShim } from './mcpShim.js'
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

/** Speak to the shim as an MCP client: newline-delimited JSON-RPC over its stdin and stdout. */
function client(code: string, socket: string): { send(message: unknown): void; end(): void; lines: unknown[]; done: Promise<void> } {
  const input = new PassThrough(), output = new PassThrough(), lines: unknown[] = []
  let held = ''
  output.on('data', chunk => {
    held += String(chunk)
    for (let at = held.indexOf('\n'); at >= 0; at = held.indexOf('\n')) { lines.push(JSON.parse(held.slice(0, at))); held = held.slice(at + 1) }
  })
  return { send: message => input.write(JSON.stringify(message) + '\n'), end: () => input.end(), lines, done: runMcpShim(code, socket, input, output) }
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
    const input = new PassThrough(), output = new PassThrough()
    const out: string[] = []
    output.on('data', chunk => out.push(String(chunk)))
    const done = runMcpShim('linear', bridgeSocketPath(vault)!, input, output)
    input.write('not json\n')
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) + '\n')
    input.end()
    await done
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
    expect(entry.args!.slice(-5, -1)).toEqual(['connections', 'mcp', 'linear', '--socket'])
    expect(socketOf(entry)).toBe(bridgeSocketPath(vault))
    const texts = [claude, codex, opencode].map(path => readFileSync(path, 'utf8'))
    for (const text of texts) {
      expect(text).not.toContain('127.0.0.1')
      expect(text).not.toContain('51793')
      expect(text).toContain('connections')
    }
    expect(texts[1]).toContain('[mcp_servers.linear]\ncommand = ')
    expect(JSON.parse(texts[2]).mcp.linear).toMatchObject({ type: 'local', enabled: true, command: expect.arrayContaining(['mcp', 'linear']) })
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
    expect(bridgeSocketPath(long)).toBeNull()
    expect(bridgeSocketPath(vault, 'win32')).toBeNull()
  })
})

function writeJson(path: string, text = '{}'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { bridgeKey, bridgeSocketPath, harnessKey, retireBridgeKey, rotateHarnessKey, KEY_GRACE_MS } from '../lib/connectors/agents.js'
import { serveBridgeSocket } from '../lib/connectors/bridge.js'
import type { LocalSocketServer } from '../lib/localSocket.js'
import { Store } from '../lib/connectors/store.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startConnectors } from '../services/connectors.js'
import { fetchOverSocket, socketIsPrivate } from '../lib/localTransport.js'
import { bridgeRoute, connectionsBridge } from './bridge.js'
import { McpClient } from './mcp.js'

const closers: Array<() => unknown> = []
afterEach(async () => { vi.useRealTimers(); for (const close of closers.splice(0)) await close(); rmSync(home, { recursive: true, force: true }) })

let vault: Store, env: NodeJS.ProcessEnv, home: string
beforeEach(() => {
  // Short: a socket has to fit.
  home = mkdtempSync(join('/tmp', 'cs-'))
  env = { HOME: home, PATH: '', XDG_CONFIG_HOME: join(home, '.config') }
  vault = new Store(join(home, 'c'), env)
})

/** Another account on the bridge's port, recording what it hears. */
async function holder(): Promise<{ heard: string[]; port: number }> {
  const heard: string[] = []
  const server = createServer((request, response) => { heard.push(`${request.method} ${request.url}`); response.writeHead(404).end() })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  closers.push(() => new Promise(done => { server.closeAllConnections(); server.close(done) }))
  return { heard, port: (server.address() as AddressInfo).port }
}

async function service(respond: (url: string, body: string) => { status?: number; body: string; type?: string }): Promise<string> {
  const server: Server = createServer((request, response) => {
    let raw = ''
    request.on('data', part => { raw += part })
    request.on('end', () => {
      const answer = respond(request.url ?? '', raw)
      response.writeHead(answer.status ?? 200, { 'content-type': answer.type ?? 'application/json' }).end(answer.body)
    })
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  closers.push(() => new Promise(done => { server.closeAllConnections(); server.close(done) }))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const bridgeRoute2 = (): { fetch: typeof fetch } => ({ fetch: fetchOverSocket(bridgeSocketPath(vault)!) })

const onSocket = async (): Promise<LocalSocketServer> => {
  const listening = await serveBridgeSocket(vault, bridgeSocketPath(vault)!)
  closers.push(() => listening.close())
  return listening
}

describe('cloud agents and the bridge', () => {
  it('list, API and MCP calls all go over the socket; a holder of the port hears nothing, Harness\'s key least of all', async () => {
    const hold = await holder()
    vi.stubEnv('HARNESS_CONNECTIONS_PORT', String(hold.port))
    closers.push(() => vi.unstubAllEnvs())
    const api = await service((url) => ({ body: JSON.stringify({ url }) }))
    const mcp = await service((_url, body) => {
      const message = JSON.parse(body) as { id?: number; method: string }
      return { body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'tools/list' ? { tools: [{ name: 'a' }] } : { protocolVersion: '2025-06-18' } }) }
    })
    vault.save('devin', { access_token: 't', source: 'custom', transport: 'none', api_entry: { origin: api } } as never)
    vault.save('fo', { access_token: 't', source: 'dcr', mcp_entry: { url: `${mcp}/mcp`, headers: {} } })
    await onSocket()
    const bridge = connectionsBridge(() => bridgeRoute(vault))
    expect((await bridge.connections()).map(c => c.code).sort()).toEqual(['devin', 'fo'])
    expect((await bridge.api('devin', 'GET', '/v3/self')).status).toBe(200)
    const client = new McpClient(bridge.mcpUrl('fo'), 'Fo', bridge.fetch)
    expect((await client.tools()).map(t => t.name)).toEqual(['a'])
    expect(hold.heard).toEqual([])
  })

  it('with the socket gone says Connections is not running, and sends nothing to the port', async () => {
    const hold = await holder()
    vi.stubEnv('HARNESS_CONNECTIONS_PORT', String(hold.port))
    closers.push(() => vi.unstubAllEnvs())
    await expect(connectionsBridge(() => bridgeRoute(vault)).connections()).rejects.toThrow()
    expect(hold.heard).toEqual([])
  })

  it('the socket answers Harness\'s key, and an agent\'s route on it still reaches MCP servers only', async () => {
    const key = harnessKey(vault)
    await onSocket()
    const { fetch: over } = bridgeRoute(vault)
    expect((await over(`http://bridge/${key}/connections`)).status).toBe(200)
    expect((await over('http://bridge/local/connections')).status).toBe(404)
    expect((await over('http://bridge/wrong-key/connections')).status).toBe(404)
  })

  it('a socket that is not private is not used: Harness\'s key reaches nothing, and the port is not tried', async () => {
    const hold = await holder()
    vi.stubEnv('HARNESS_CONNECTIONS_PORT', String(hold.port))
    closers.push(() => vi.unstubAllEnvs())
    const listening = await onSocket()
    const bridge = connectionsBridge(() => bridgeRoute(vault))
    expect(await bridge.connections()).toEqual([])
    chmodSync(listening.path, 0o666)
    await expect(bridge.connections()).rejects.toThrow()
    chmodSync(listening.path, 0o600)
    // Reading Harness's key tightens the vault's folder, so the route heals this one by itself; the check still says so while it is open.
    chmodSync(vault.root, 0o777)
    expect(socketIsPrivate(listening.path)).toBe(false)
    chmodSync(vault.root, 0o700)
    expect(socketIsPrivate(listening.path)).toBe(true)
    expect(hold.heard).toEqual([])
  })

  it('names a host that resolves nowhere, so the key cannot leave if the address ever reached plain fetch', () => {
    expect(new URL(bridgeRoute(vault).base).hostname).toMatch(/\.invalid$/)
  })

  it('an unreadable Harness key refuses Harness\'s calls, and agents\' MCP calls still work', async () => {
    const fake = await service((_url, body) => ({ body: JSON.stringify({ jsonrpc: '2.0', id: (JSON.parse(body) as { id?: number }).id, result: {} }) }))
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: `${fake}/mcp`, headers: {} } })
    harnessKey(vault)
    await onSocket()
    writeFileSync(join(vault.root, 'harness-key.json'), 'not json', { mode: 0o600 })
    const { fetch: over } = bridgeRoute2()
    const answer = await over('http://bridge/local/linear/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    expect(answer.status).toBe(200)
  })

  it('a long vault\'s route is its short socket, and only a home too long as well is the port', () => {
    const long = new Store(join(home, 'x'.repeat(120)), env)
    expect(bridgeSocketPath(long)).toMatch(/\/\.harness\/s\/[0-9a-f]{16}\/bridge\.sock$/)
    expect(bridgeRoute(long).base).toMatch(/^http:\/\/connections\.invalid\//)
    vi.stubEnv('HOME', `/${'h'.repeat(120)}`)
    closers.push(() => vi.unstubAllEnvs())
    expect(bridgeSocketPath(long)).toBeNull()
    expect(bridgeRoute(long).base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
  })
})

describe('the keys that crossed the port', () => {
  it('the service takes Harness\'s key on its socket and not on its port, and the agents\' old key on its port for now', async () => {
    const agents = bridgeKey(vault), stale = harnessKey(vault)
    const free = createServer()
    await new Promise<void>(ready => free.listen(0, '127.0.0.1', ready))
    const port = (free.address() as AddressInfo).port
    await new Promise(done => free.close(done))
    startConnectors(fakeCore(), { vault, env, port, offered: async () => ({}), retryMs: 60_000 })
    const socket = bridgeRoute(vault)
    await vi.waitFor(async () => expect((await socket.fetch(`${socket.base}/connections`)).status).toBe(200))
    await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}/nope/connections`)).status).toBe(404))
    expect(harnessKey(vault)).not.toBe(stale)
    expect((await fetch(`http://127.0.0.1:${port}/${harnessKey(vault)}/connections`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/${stale}/connections`)).status).toBe(404)
    // Reached by the key, and nothing is connected under this name.
    const answer = await fetch(`http://127.0.0.1:${port}/${agents}/nothing/mcp`, { method: 'POST', body: '{}' })
    expect(await answer.text()).toMatch(/not connected/)
    expect(typeof vault.file('bridge.json').keyRetiresAt).toBe('number')
  })

  it('Harness\'s key is replaced once, on the first start that has a socket', () => {
    const before = harnessKey(vault)
    rotateHarnessKey(vault)
    const after = harnessKey(vault)
    expect(after).not.toBe(before)
    rotateHarnessKey(vault)
    expect(harnessKey(vault)).toBe(after)
  })

  it('the agents\' old key lasts a day from the first start that has a socket, then goes for good', () => {
    const key = bridgeKey(vault)
    const start = 1_000_000
    expect(retireBridgeKey(vault, start)).toBe(key)
    expect(retireBridgeKey(vault, start + KEY_GRACE_MS - 1)).toBe(key)
    expect(retireBridgeKey(vault, start + KEY_GRACE_MS)).toBe('')
    expect(vault.file('bridge.json').key).toBeUndefined()
    expect(retireBridgeKey(vault, start + 2 * KEY_GRACE_MS)).toBe('')
  })

  it('a machine with no key has nothing to retire, and its saved port is kept', () => {
    vault.file('bridge.json')
    expect(retireBridgeKey(vault, 5)).toBe('')
    expect(vault.file('bridge.json').keyRetiresAt).toBeUndefined()
  })
})

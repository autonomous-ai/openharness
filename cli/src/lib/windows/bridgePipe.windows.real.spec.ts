// The connectors bridge's pipe (lib/connectors/bridge.ts serveBridgePipe, task #2162) on a real Windows named pipe: the stdio shim an
// agent's entry runs reaches a connection through it, and Harness's own route lists the connections through it, with nothing sent
// to the bridge's port. Windows only; the Windows workflow runs it with src/lib/windows. The squatter and dead-process cases are
// pinned by the unit specs over a socket named as a pipe.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectionsBridge, bridgeRoute } from '../../cloud/bridge.js'
import { bridgePipeRecord, readBridgePipe } from '../connectors/agents.js'
import { serveBridgePipe } from '../connectors/bridge.js'
import { MCP_SHIM_SOURCE } from '../connectors/mcpShimSource.js'
import { Store } from '../connectors/store.js'

const WINDOWS = process.platform === 'win32'
const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise((done) => { server.closeAllConnections(); server.close(done) }))
  return (server.address() as AddressInfo).port
}

describe.runIf(WINDOWS)('the bridge\'s pipe, on real Windows', () => {
  it('the shim and Harness\'s own route reach the bridge over it, and nothing goes to the port', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bridge-pipe-'))
    cleanup.push(() => rmSync(home, { recursive: true, force: true }))
    const vault = new Store(join(home, 'c'), { USERPROFILE: home })
    const heard: string[] = [], portHeard: string[] = []
    const upstream = createServer((request, response) => {
      let raw = ''
      request.on('data', (part) => { raw += part })
      request.on('end', () => {
        const message = JSON.parse(raw) as { id?: number; method: string }
        heard.push(message.method)
        if (message.id === undefined) { response.writeHead(202).end(); return }
        response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's1' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { tools: [] } }))
      })
    })
    const port = await listen(upstream)
    const holder = createServer((request, response) => { portHeard.push(request.url ?? ''); response.writeHead(404).end() })
    process.env.HARNESS_CONNECTIONS_PORT = String(await listen(holder))
    cleanup.push(() => { delete process.env.HARNESS_CONNECTIONS_PORT })
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: `http://127.0.0.1:${port}/mcp`, headers: {} } })

    const listening = await serveBridgePipe(vault)
    cleanup.push(() => listening.close())
    expect(listening.path).toMatch(/^\\\\\.\\pipe\\harness-[0-9a-f]{32}$/)
    expect(readBridgePipe(vault)?.pipe).toBe(listening.path)

    const shim = join(vault.root, 'mcp-shim.mjs')
    mkdirSync(vault.root, { recursive: true })
    writeFileSync(shim, MCP_SHIM_SOURCE)
    const child = spawn(process.execPath, [shim, '--pipe', bridgePipeRecord(vault), 'linear'])
    let out = ''
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    child.stdin.end()
    await new Promise((resolve) => child.on('exit', resolve))
    expect(out.trim().split('\n').map((line) => JSON.parse(line) as { id: number })).toEqual([
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, result: { tools: [] } },
    ])
    expect(heard).toEqual(['initialize', 'tools/list'])

    expect((await connectionsBridge(() => bridgeRoute(vault)).connections()).map((c) => c.code)).toEqual(['linear'])
    expect(portHeard).toEqual([])
  }, 60_000)
})

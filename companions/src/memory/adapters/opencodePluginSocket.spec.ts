import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginFetchSource } from './opencodePluginFetch.js'
import { opencodeMemoryPluginSource } from './opencodeMemoryPlugin.js'
import { opencodeRecallPluginSource } from './opencodeRecallPlugin.js'

const TOKEN = 'synthetic-hook-token'
let folder = '', servers: Server[] = []
beforeEach(() => { folder = mkdtempSync(join('/tmp', 'op-')); chmodSync(folder, 0o700); vi.stubEnv('TMUX_PANE', '%42') })
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) await new Promise(done => { server.closeAllConnections(); server.close(done) })
  rmSync(folder, { recursive: true, force: true })
})

type Reply = (response: import('node:http').ServerResponse) => void
function recorder(reply: Reply = (response) => response.writeHead(200, { 'content-type': 'application/json' }).end('{"observe":true,"challenge":"g"}')): { server: Server; heard: Array<{ url?: string; token?: unknown; body: string }> } {
  const heard: Array<{ url?: string; token?: unknown; body: string }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', part => { body += part })
    request.on('end', () => { heard.push({ url: request.url, token: request.headers['x-harness-hook-token'], body }); reply(response) })
  })
  servers.push(server)
  return { server, heard }
}
const holder = async () => {
  const { server, heard } = recorder()
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  return { heard, port: (server.address() as AddressInfo).port }
}
const daemon = async (reply?: Reply) => {
  const { server, heard } = recorder(reply), path = join(folder, 'daemon-1.sock')
  await new Promise<void>(ready => server.listen(path, ready))
  chmodSync(path, 0o600)
  return { heard, path }
}

/** A plugin runs as a module in its engine, so it is loaded as one here: `import()` needs that. */
let loaded = 0
const module_ = async <T>(source: string, name: string): Promise<T> => {
  const file = join(folder, `plugin-${loaded++}.mjs`)
  writeFileSync(file, `const client = {}; const hookToken = () => ${JSON.stringify(TOKEN)};\n${source}\nexport { ${name} }`)
  return (await import(/* @vite-ignore */ pathToFileURL(file).href) as Record<string, T>)[name]!
}
const memory = (port: number, socket: string | null) => module_<(sessionID: string, input: unknown) => Promise<unknown>>(opencodeMemoryPluginSource(port, socket), 'memoryRequest')
const recall = (port: number, socket: string | null) => module_<(route: string, sessionID: string, body: unknown, signal?: AbortSignal) => Promise<unknown>>(opencodeRecallPluginSource(port, socket), 'recallRequest')

describe.each([
  ['memory', async (port: number, socket: string | null) => (await memory(port, socket))('s', { kind: 'probe' })],
  ['recall', async (port: number, socket: string | null) => (await recall(port, socket))('memory-context', 's', {})],
] as const)('the %s plugin', (_name, post) => {
  it('posts over the socket with its token, reads the answer, and a holder of the port hears nothing', async () => {
    const hold = await holder(), real = await daemon()
    expect(await post(hold.port, real.path)).toMatchObject({ observe: true })
    expect(real.heard).toHaveLength(1)
    expect(real.heard[0]!.token).toBe(TOKEN)
    expect(hold.heard).toEqual([])
  })

  it('with the socket gone sends nothing to the port', async () => {
    const hold = await holder()
    await expect(post(hold.port, join(folder, 'gone.sock'))).rejects.toThrow()
    expect(hold.heard).toEqual([])
  })

  it('does not use a socket that is not private', async () => {
    const hold = await holder(), real = await daemon()
    chmodSync(real.path, 0o666)
    await expect(post(hold.port, real.path)).rejects.toThrow(/not private/)
    expect(real.heard).toEqual([])
    expect(hold.heard).toEqual([])
  })
})

describe('the recall plugin over the socket', () => {
  it('drops an answer over its limit', async () => {
    const hold = await holder(), real = await daemon((response) => response.writeHead(200).end('x'.repeat(70_000)))
    expect(await (await recall(hold.port, real.path))('memory-context', 's', {})).toBeNull()
  })

  it('an answer with no body, a 204, gives null and throws nothing outside the call', async () => {
    const hold = await holder(), real = await daemon((response) => response.writeHead(204).end())
    await expect((await recall(hold.port, real.path))('memory-context', 's', {})).resolves.toBeNull()
  })

  it('an abort cuts the request', async () => {
    const hold = await holder(), real = await daemon(() => { /* never answers */ })
    const stop = new AbortController()
    const asked = (await recall(hold.port, real.path))('memory-context', 's', {}, stop.signal)
    await vi.waitFor(() => expect(real.heard).toHaveLength(1))
    stop.abort()
    await expect(asked).rejects.toThrow()
  })
})

it('names its function, so both plugins can share one scope', () => {
  expect(pluginFetchSource('a', null)).toContain('const a = async')
  expect(pluginFetchSource('a', '/s')).toContain('"/s"')
})

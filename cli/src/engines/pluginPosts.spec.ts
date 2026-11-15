import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { AMP_PLUGIN } from './amp/setup.js'
import { KILO_PLUGIN } from './kilo/setup.js'
import { nativePluginSource, type NativePlugin } from './kit/nativePlugin.js'
import { OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN } from './opencode/setup.js'
import { PI_EXTENSION } from './pi/setup.js'

const TOKEN = 'c'.repeat(43)
let dir = '', short = '', closers: Server[] = [], index = 0
beforeEach(() => {
  const tmp = join(import.meta.dirname, '..', '.tmp')
  mkdirSync(tmp, { recursive: true })
  dir = mkdtempSync(join(tmp, 'plugin-post-'))
  short = mkdtempSync(join('/tmp', 'pp-'))
  chmodSync(short, 0o700)
  writeFileSync(join(dir, 'hook-token'), `${TOKEN}\n`)
  vi.stubEnv('TMUX_PANE', '%7')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const server of closers.splice(0)) await new Promise(done => { server.closeAllConnections(); server.close(done) })
  rmSync(dir, { recursive: true, force: true })
  rmSync(short, { recursive: true, force: true })
})

interface Heard { url?: string; token?: string; gateway?: string; body: string }
function recorder(): { server: Server; heard: Heard[] } {
  const heard: Heard[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', part => { body += part })
    request.on('end', () => {
      heard.push({ url: request.url, token: request.headers['x-harness-hook-token'] as string | undefined,
        gateway: request.headers['x-harness-hook-gateway'] as string | undefined, body })
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  closers.push(server)
  return { server, heard }
}
async function holder(): Promise<{ heard: Heard[]; port: number }> {
  const { server, heard } = recorder()
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  return { heard, port: (server.address() as AddressInfo).port }
}
async function daemon(): Promise<{ heard: Heard[]; path: string }> {
  const { server, heard } = recorder(), path = join(short, 'daemon-1.sock')
  await new Promise<void>(ready => server.listen(path, ready))
  chmodSync(path, 0o600)
  return { heard, path }
}

async function load(rule: NativePlugin, name: string, port: number, socket: string | null): Promise<any> {
  const file = join(dir, `${index++}-${name}`)
  // Amp's plugin keeps its transcript in a folder named in its source: never the real one here.
  const source = nativePluginSource(rule, { port: String(port), credential: JSON.stringify(join(dir, 'hook-token')), version: '"test"', socket: JSON.stringify(socket) })
    .replace(JSON.stringify(env.AMP_SESSIONS_DIR), JSON.stringify(join(dir, 'amp')))
  writeFileSync(file, source)
  return import(pathToFileURL(file).href)
}

/** Each plugin's own way of announcing a session. */
const PLUGINS: Array<[string, NativePlugin, string, (plugin: any) => Promise<unknown>]> = [
  ['OpenCode', OPENCODE_LEGACY_PLUGIN, 'opencode.mjs', async (plugin) => {
    const hooks = await plugin.MachineRegister({ directory: '/work' })
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1' } } } })
  }],
  ['Kilo', KILO_PLUGIN, 'kilo.mjs', async (plugin) => {
    const hooks = await plugin.MachineRegister({ directory: '/work' })
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1' } } } })
  }],
  ['OpenCode 2', OPENCODE_TUI_PLUGIN, 'tui.mjs', async (plugin) => {
    const stop = plugin.default.setup({ ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_1' }) } }, data: { session: { get: async () => ({}) } }, location: { directory: '/work' } })
    await new Promise(done => setTimeout(done, 200))
    stop?.()
  }],
  ['Pi', PI_EXTENSION, 'pi.ts', async (plugin) => {
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {}
    plugin.default({ on: (name: string, run: (event: unknown, ctx: unknown) => Promise<void>) => { handlers[name] = run } })
    await handlers.session_start!({}, { sessionManager: { getSessionFile: () => null, getSessionId: () => 'ses_1' }, cwd: '/work' })
  }],
  ['Amp', AMP_PLUGIN, 'amp.ts', async (plugin) => {
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {}
    plugin.default({ on: (name: string, run: (event: unknown, ctx: unknown) => Promise<void>) => { handlers[name] = run } })
    await handlers['session.start']!({ thread: { id: 'ses_1' } }, {})
  }],
]

describe.each(PLUGINS)('%s\'s plugin', (_name, rule, file, announce) => {
  it('posts over the socket, with its token, and a holder of the port hears nothing', async () => {
    const hold = await holder(), real = await daemon()
    await announce(await load(rule, file, hold.port, real.path))
    await vi.waitFor(() => expect(real.heard).toHaveLength(1))
    expect(real.heard[0]).toMatchObject({ url: '/api/hook/session-start', token: TOKEN })
    expect(JSON.parse(real.heard[0]!.body)).toMatchObject({ sessionId: 'ses_1' })
    expect(hold.heard).toEqual([])
  })

  it('with the socket gone posts nothing, and the port is not tried', async () => {
    const hold = await holder()
    await announce(await load(rule, file, hold.port, join(short, 'gone.sock')))
    await new Promise(done => setTimeout(done, 50))
    expect(hold.heard).toEqual([])
  })

  it('a socket that is not private is not used', async () => {
    const hold = await holder(), real = await daemon()
    chmodSync(real.path, 0o666)
    await announce(await load(rule, file, hold.port, real.path))
    await new Promise(done => setTimeout(done, 50))
    expect(real.heard).toEqual([])
    expect(hold.heard).toEqual([])
  })

  it('where no socket can be (Windows, or a home too long as well), posts to the port as before', async () => {
    const hold = await holder()
    await announce(await load(rule, file, hold.port, null))
    await vi.waitFor(() => expect(hold.heard).toHaveLength(1))
    expect(hold.heard[0]).toMatchObject({ url: '/api/hook/session-start', token: TOKEN })
  })
})

const GATEWAY_URLS = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE']
const OPENCODE = PLUGINS.filter(([name]) => name.startsWith('OpenCode'))

describe.each(OPENCODE)('%s\'s plugin and its gateway', (_name, rule, file, announce) => {
  it.each([
    [{ OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }, 'ori'],
    [{ ANTHROPIC_BASE_URL: 'https://openrouter.ai.example.com' }, 'none'],
    [{}, 'none'],
  ] as Array<[Record<string, string>, string]>)('%j is said as gateway %s, in a header, and never the address', async (urls, gateway) => {
    for (const name of GATEWAY_URLS) vi.stubEnv(name, urls[name] ?? '')
    const hold = await holder()
    await announce(await load(rule, file, hold.port, null))
    await vi.waitFor(() => expect(hold.heard).toHaveLength(1))
    expect(hold.heard[0]!.gateway).toBe(gateway)
    expect(hold.heard[0]!.body).not.toMatch(/gateway|openrouter/)
  })
})

describe.each(PLUGINS.filter(([name]) => !name.startsWith('OpenCode')))('%s\'s plugin and the gateway', (_name, rule, file, announce) => {
  it('says nothing of the gateway', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://openrouter.ai/api/v1')
    const hold = await holder()
    await announce(await load(rule, file, hold.port, null))
    await vi.waitFor(() => expect(hold.heard).toHaveLength(1))
    expect(hold.heard[0]!.gateway).toBeUndefined()
  })
})

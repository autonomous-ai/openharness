import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KILO_PLUGIN } from './kilo/contract.js'
import { nativePluginSource, type NativePlugin } from './kit/nativePlugin.js'
import { OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN } from './opencode/contract.js'
import { PI_EXTENSION } from './pi/contract.js'

const TOKEN = 'c'.repeat(43)
let dir = ''
let fetch: ReturnType<typeof vi.fn>
beforeEach(() => {
  const tmp = join(import.meta.dirname, '..', '.tmp')
  mkdirSync(tmp, { recursive: true })
  dir = mkdtempSync(join(tmp, 'plugin-pane-'))
  writeFileSync(join(dir, 'hook-credential'), `${TOKEN}\n`)
  fetch = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('fetch', fetch)
  vi.stubEnv('TMUX_PANE', undefined)
  vi.stubEnv('HARNESS_PANE', 'p2:%1003')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

async function load(rule: NativePlugin, name: string): Promise<any> {
  const file = join(dir, name)
  writeFileSync(file, nativePluginSource(rule, { port: '19473', credential: JSON.stringify(join(dir, 'hook-credential')), version: '"test"' }))
  return import(pathToFileURL(file).href)
}
const posted = () => JSON.parse((fetch.mock.calls[0] as [string, { body: string }])[1].body)
const PTY_HINT = [{ backend: 'ptyhost', instance: 'p2', paneId: '%1003' }]

describe('a plugin in a Harness pty host pane (Windows)', () => {
  it.each([[KILO_PLUGIN, 'kilo.mjs'], [OPENCODE_LEGACY_PLUGIN, 'opencode.mjs']] as const)('posts its pane by HARNESS_PANE: %#', async (rule, name) => {
    const plugin = await load(rule, name)
    const hooks = await plugin.MachineRegister({ directory: '/work' })
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1' } } } })
    expect(posted()).toMatchObject({ sessionId: 'ses_1', runtimeHints: PTY_HINT })
    expect(posted().tmuxPane).toBeUndefined()
  })

  it('posts the OpenCode 2 TUI session by HARNESS_PANE', async () => {
    const plugin = await load(OPENCODE_TUI_PLUGIN, 'tui.mjs')
    const stop = plugin.default.setup({ ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_2' }) } }, data: { session: { get: async () => ({}) } } })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    stop?.()
    expect(posted()).toMatchObject({ sessionId: 'ses_2', runtimeHints: PTY_HINT })
  })

  it('posts the Pi session by HARNESS_PANE', async () => {
    const plugin = await load(PI_EXTENSION, 'pi.ts')
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {}
    plugin.default({ on: (name: string, run: (event: unknown, ctx: unknown) => Promise<void>) => { handlers[name] = run } })
    await handlers.session_start({}, { sessionManager: { getSessionFile: () => null, getSessionId: () => 'pi-1' }, cwd: '/work' })
    expect(posted()).toMatchObject({ sessionId: 'pi-1', runtimeHints: PTY_HINT })
  })

  it.each([
    [KILO_PLUGIN, 'kilo-v.mjs', 'p2-0.4.21-dev.win1'], [OPENCODE_LEGACY_PLUGIN, 'opencode-v.mjs', 'p2-h0123456789ab'],
  ] as const)('posts a versioned pty host\'s pane by HARNESS_PANE: %#', async (rule, name, instance) => {
    vi.stubEnv('HARNESS_PANE', `${instance}:%7`)
    const plugin = await load(rule, name)
    const hooks = await plugin.MachineRegister({ directory: '/work' })
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_v' } } } })
    expect(posted()).toMatchObject({ sessionId: 'ses_v', runtimeHints: [{ backend: 'ptyhost', instance, paneId: '%7' }] })
  })

  it('posts the OpenCode 2 TUI and Pi sessions of a versioned pty host\'s pane', async () => {
    vi.stubEnv('HARNESS_PANE', 'p2-0.4.21-dev.win1:%7')
    const hint = [{ backend: 'ptyhost', instance: 'p2-0.4.21-dev.win1', paneId: '%7' }]
    const tui = await load(OPENCODE_TUI_PLUGIN, 'tui-v.mjs')
    const stop = tui.default.setup({ ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_4' }) } }, data: { session: { get: async () => ({}) } } })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    stop?.()
    expect(posted()).toMatchObject({ sessionId: 'ses_4', runtimeHints: hint })
    fetch.mockClear()
    const pi = await load(PI_EXTENSION, 'pi-v.ts')
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {}
    pi.default({ on: (event: string, run: (event: unknown, ctx: unknown) => Promise<void>) => { handlers[event] = run } })
    await handlers.session_start({}, { sessionManager: { getSessionFile: () => null, getSessionId: () => 'pi-2' }, cwd: '/work' })
    expect(posted()).toMatchObject({ sessionId: 'pi-2', runtimeHints: hint })
  })

  it('still posts a tmux pane by TMUX_PANE alone', async () => {
    vi.stubEnv('TMUX_PANE', '%7')
    const plugin = await load(KILO_PLUGIN, 'kilo-tmux.mjs')
    const hooks = await plugin.MachineRegister({ directory: '/work' })
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_3' } } } })
    expect(posted()).toMatchObject({ tmuxPane: '%7', runtimeHints: [{ backend: 'tmux', paneId: '%7' }] })
  })
})

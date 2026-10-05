import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as hooks from '../../lib/hooks.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { processRows } from '../../lib/terminalAgentDiscovery.js'
import { createEngineHooks, installEngineHooks, type EngineHookDeps } from './hooks.js'

vi.mock('../../lib/terminalAgentDiscovery.js', async (real) => ({ ...await real<object>(), processRows: vi.fn(async () => []) }))
vi.mock('../../lib/hooks.js', async (real) => ({
  ...await real<object>(),
  installSessionHooks: vi.fn(),
  installCodexHooks: vi.fn(),
  installCursorHooks: vi.fn(),
  installOpencodePlugin: vi.fn(),
  installKiloPlugin: vi.fn(),
  installPiExtension: vi.fn(),
  installAmpPlugin: vi.fn(),
  installHermesHooks: vi.fn(),
  installDevinHooks: vi.fn(),
  installCommandCodeHooks: vi.fn(),
  installGrokHooks: vi.fn(),
  installAgyHooks: vi.fn(),
  installCopilotHooks: vi.fn(),
}))

const agent = (agentId: string, pid?: number) =>
  ({ agentId, engine: 'claude', ...(pid ? { processIdentity: { pid, startMarker: 'm' } } : {}) }) as unknown as RegisteredSession
/** A process tree: each [pid, parentPid]. */
const tree = (...pairs: Array<[number, number]>) => pairs.map(([pid, parentPid]) => ({ pid, parentPid, startMarker: 'm', args: '' }))
const hint = (paneId: string) => ({ backend: 'tmux' as const, paneId })

function setup(onPane: Record<string, RegisteredSession> = {}, over: Partial<EngineHookDeps> = {}) {
  const deps: EngineHookDeps = {
    tmuxBackend: {},
    agentReconciler: { triggerHint: vi.fn(async () => {}), trigger: vi.fn(async () => {}) } as unknown as EngineHookDeps['agentReconciler'],
    registry: { byRuntimeEngine: vi.fn((runtime: { paneId: string }) => onPane[runtime.paneId]) } as unknown as EngineHookDeps['registry'],
    ...over,
  }
  return { deps, hooks: createEngineHooks(deps) }
}

describe('which agent a hook belongs to', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('none, for a hook that did not say which process sent it', async () => {
    const { deps, hooks } = setup()
    expect(await hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1')] })).toBeNull()
    expect(deps.agentReconciler.triggerHint).not.toHaveBeenCalled()
  })

  it('the agent on the hinted pane whose engine the caller descends from, once the pane is reconciled', async () => {
    const a1 = agent('a1', 100)
    const { deps, hooks } = setup({ '%1': a1 })
    vi.mocked(processRows).mockResolvedValueOnce(tree([300, 200], [200, 100], [100, 1]) as never)
    expect(await hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1')], callerPid: 300 })).toBe(a1)
    expect(deps.agentReconciler.triggerHint).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%1' }, 'claude')
    expect(deps.registry.byRuntimeEngine).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%1' }, 'claude')
    expect(console.log).not.toHaveBeenCalled()
  })

  it('none when the process table cannot be read', async () => {
    vi.mocked(processRows).mockResolvedValueOnce(null)
    expect(await setup({ '%1': agent('a1', 100) }).hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1')], callerPid: 300 })).toBeNull()
  })

  it('a Cursor agent on the pane alone, saying the caller is outside its process tree', async () => {
    const c1 = { ...agent('cursor-1'), engine: 'cursor' } as RegisteredSession
    vi.mocked(processRows).mockResolvedValueOnce(tree([300, 1]) as never)
    expect(await setup({ '%1': c1 }).hooks.resolveHookAgent({ engine: 'cursor', runtimeHints: [hint('%1')], callerPid: 300 })).toBe(c1)
    expect(console.log).toHaveBeenCalledWith('[hooks] cursor hook accepted on runtime evidence alone · agent=cursor-1 · caller=300 is outside that engine\'s process tree')
  })

  it('none for any other engine on the pane alone, saying the caller is not its descendant', async () => {
    // 300's parent 200 is not in the table; the walk stops there.
    vi.mocked(processRows).mockResolvedValueOnce(tree([300, 200], [100, 1]) as never)
    expect(await setup({ '%1': agent('a1', 100) }).hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1')], callerPid: 300 })).toBeNull()
    expect(console.log).toHaveBeenCalledWith('[hooks] unmatched claude hook · hints=tmux:%1 · resolvedRuntimes=1 · agentsOnRuntime=1'
      + ' · callerPid=300 · caller is not a descendant of that engine process')
  })

  it('none for an agent with no process to descend from, and a process table that loops', async () => {
    vi.mocked(processRows).mockResolvedValueOnce(tree([300, 400], [400, 300]) as never)
    const { hooks } = setup({ '%1': agent('no-pid'), '%2': agent('a2', 100) })
    expect(await hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1'), hint('%2')], callerPid: 300 })).toBeNull()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('agentsOnRuntime=2 · callerPid=300 · caller is not a descendant'))
  })

  it('none when two agents could own the hook, saying it is ambiguous', async () => {
    vi.mocked(processRows).mockResolvedValueOnce(tree([300, 200], [200, 100], [100, 1]) as never)
    const { hooks } = setup({ '%1': agent('a1', 100), '%2': agent('a2', 200) })
    expect(await hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1'), hint('%2')], callerPid: 300 })).toBeNull()
    expect(console.log).toHaveBeenCalledWith('[hooks] unmatched claude hook · hints=tmux:%1,tmux:%2 · resolvedRuntimes=2 · agentsOnRuntime=2'
      + ' · callerPid=300 · ambiguous (2 candidates)')
  })

  it('none when no agent is on the pane, when there is no tmux to resolve it, or no pane was named', async () => {
    const empty = setup()
    expect(await empty.hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%9')], callerPid: 300 })).toBeNull()
    expect(console.log).toHaveBeenLastCalledWith('[hooks] unmatched claude hook · hints=tmux:%9 · resolvedRuntimes=1 · agentsOnRuntime=0 · callerPid=300')

    const noTmux = setup({ '%1': agent('a1', 100) }, { tmuxBackend: null })
    expect(await noTmux.hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1')], callerPid: 300 })).toBeNull()
    expect(noTmux.deps.agentReconciler.triggerHint).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenLastCalledWith('[hooks] unmatched claude hook · hints=tmux:%1 · resolvedRuntimes=0 · agentsOnRuntime=0 · callerPid=300')

    expect(await empty.hooks.resolveHookAgent({ engine: 'claude', runtimeHints: undefined as never, callerPid: 300 })).toBeNull()
    expect(console.log).toHaveBeenLastCalledWith('[hooks] unmatched claude hook · hints=none · resolvedRuntimes=0 · agentsOnRuntime=0 · callerPid=300')
  })

  it('a SessionEnd only asks for a reconcile: discovery decides whether the agent still exists', () => {
    const { deps, hooks } = setup()
    hooks.onSessionEnd('s1', 'exit')
    expect(deps.agentReconciler.trigger).toHaveBeenCalledTimes(1)
  })
})

describe('installing every engine\'s hooks', () => {
  const installs = [
    hooks.installSessionHooks, hooks.installCodexHooks, hooks.installCursorHooks, hooks.installOpencodePlugin,
    hooks.installKiloPlugin, hooks.installPiExtension, hooks.installAmpPlugin, hooks.installHermesHooks,
    hooks.installDevinHooks, hooks.installCommandCodeHooks, hooks.installGrokHooks, hooks.installAgyHooks,
    hooks.installCopilotHooks,
  ]
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('points all thirteen at the bound port', () => {
    installEngineHooks(4242)
    for (const install of installs) expect(install).toHaveBeenCalledWith(4242)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('one at a time: a vendor whose install throws is skipped and named, and the rest still install', () => {
    vi.mocked(hooks.installCodexHooks).mockImplementationOnce(() => { throw new Error('config.toml is read-only') })
    vi.mocked(hooks.installGrokHooks).mockImplementationOnce(() => { throw 'settings mid-write' })
    installEngineHooks(4242)
    expect(console.warn).toHaveBeenCalledWith('[hooks] codex install skipped · config.toml is read-only')
    expect(console.warn).toHaveBeenCalledWith('[hooks] grok install skipped · settings mid-write')
    for (const install of installs) expect(install).toHaveBeenCalledTimes(1)
  })
})

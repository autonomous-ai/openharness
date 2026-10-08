import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as hooks from '../../lib/hooks.js'
import { engineHooks } from '../../engines/hooks.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { processRows } from '../../lib/terminalAgentDiscovery.js'
import { dirname } from 'node:path'
import { env } from '../../config/env.js'
import { adoptEngineHomes, movedEngineHomes } from '../../lib/engineHomes.js'
import { createEngineHooks, installEngineHooks, PROCESS_RECORD_WAIT_MS, type EngineHookDeps } from './hooks.js'

vi.mock('../../engines/hooks.js', async (real) => {
  const actual = await real<typeof import('../../engines/hooks.js')>()
  return { ...actual, engineHooks: {
    claude: { ...actual.engineHooks.claude, install: vi.fn(), installIn: vi.fn() },
    codex: { ...actual.engineHooks.codex, install: vi.fn(), installIn: vi.fn() },
  } }
})
vi.mock('../../lib/engineHomes.js', () => ({
  adoptEngineHomes: vi.fn(() => ({ claude: null, codex: null })),
  movedEngineHomes: vi.fn(() => ({ claude: [], codex: [] })),
}))
vi.mock('../../lib/terminalAgentDiscovery.js', async (real) => ({ ...await real<object>(), processRows: vi.fn(async () => []) }))
vi.mock('../../lib/hooks.js', async (real) => ({
  ...await real<object>(),
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
    agentReconciler: { triggerHint: vi.fn(async () => true), trigger: vi.fn(async () => true) } as unknown as EngineHookDeps['agentReconciler'],
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
    const onWait = vi.fn()
    expect(await hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1')], callerPid: 300, onWait })).toBe(a1)
    // Matched at once: nothing to wait for, and the hook is answered with its agent.
    expect(onWait).not.toHaveBeenCalled()
    expect(deps.agentReconciler.triggerHint).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%1' }, 'claude')
    expect(deps.registry.byRuntimeEngine).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%1' }, 'claude')
    expect(console.log).not.toHaveBeenCalled()
  })

  it('reads the table again when the one in flight began before the hook\'s own process, and matches it', async () => {
    const a1 = agent('a1', 100)
    vi.mocked(processRows)
      .mockResolvedValueOnce(tree([200, 100], [100, 1]) as never)
      .mockResolvedValueOnce(tree([300, 200], [200, 100], [100, 1]) as never)
    expect(await setup({ '%1': a1 }).hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1')], callerPid: 300 })).toBe(a1)
    expect(processRows).toHaveBeenCalledTimes(2)
    expect(console.log).not.toHaveBeenCalled()
  })

  it('none when the table read again for a missing caller cannot be read', async () => {
    vi.mocked(processRows).mockResolvedValueOnce(tree([100, 1]) as never).mockResolvedValueOnce(null)
    expect(await setup({ '%1': agent('a1', 100) }).hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1')], callerPid: 300 })).toBeNull()
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

  it('none for an agent with no process to descend from once the wait for one is over, and a process table that loops', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(processRows).mockResolvedValue(tree([300, 400], [400, 300], [100, 1]) as never)
      const { hooks } = setup({ '%1': agent('no-pid'), '%2': agent('a2', 100) })
      const answer = hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1'), hint('%2')], callerPid: 300 })
      await vi.advanceTimersByTimeAsync(PROCESS_RECORD_WAIT_MS)
      expect(await answer).toBeNull()
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('agentsOnRuntime=2 · callerPid=300 · caller is not a descendant'))
    } finally {
      vi.useRealTimers()
      vi.mocked(processRows).mockReset()
    }
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

  describe('a hook that comes in before its agent has recorded the process it came from', () => {
    afterEach(() => { vi.mocked(processRows).mockReset() })
    // The new engine is 200 and the hook's process, 300, is its child. Pid 100 was the engine a restart
    // killed; nothing in the table is it any more.
    const newEngine = () => tree([300, 200], [200, 1])
    /** Asks, and says when the hook has started waiting: once it has been answered with `onWait`. */
    const ask = (hooks: ReturnType<typeof setup>['hooks'], panes = ['%1'], onWait?: () => void) => {
      let answer: RegisteredSession | null | undefined
      let waited = false
      const asked = hooks.resolveHookAgent({ engine: 'claude', runtimeHints: panes.map(hint), callerPid: 300, onWait: () => { waited = true; onWait?.() } })
        .then((agent) => { answer = agent })
      const waiting = () => vi.waitFor(() => expect(waited).toBe(true))
      return { asked, waiting, answer: () => answer }
    }

    it('in a restart, waits while the recorded process is one that is gone, and belongs to the agent once the new one is recorded', async () => {
      const onPane: Record<string, RegisteredSession> = { '%1': agent('a1', 100) }
      vi.mocked(processRows).mockResolvedValue(newEngine() as never)
      const onWait = vi.fn()
      const hook = ask(setup(onPane).hooks, ['%1', '%9'], onWait)
      await hook.waiting()
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(hook.answer()).toBeUndefined()
      // Said before the wait, so the hook is answered then: its client gives up after 500ms and writes
      // the registry itself (hook/notify.mjs).
      expect(onWait).toHaveBeenCalledTimes(1)
      // What restart.ts does once the new process is found and probed.
      onPane['%1'] = agent('a1', 200)
      await hook.asked
      expect(hook.answer()).toEqual(agent('a1', 200))
      expect(onWait).toHaveBeenCalledTimes(1)
      expect(console.log).not.toHaveBeenCalled()
    })

    it('in a resume, waits while the row has no process yet, and belongs to it once the resume records one', async () => {
      const onPane: Record<string, RegisteredSession> = { '%1': agent('a1') }
      vi.mocked(processRows).mockResolvedValue(newEngine() as never)
      const hook = ask(setup(onPane).hooks)
      await hook.waiting()
      expect(hook.answer()).toBeUndefined()
      // What resumeAgentService.ts does once waitForResumedAgent finds the engine in the pane.
      onPane['%1'] = agent('a1', 200)
      await hook.asked
      expect(hook.answer()).toEqual(agent('a1', 200))
    })

    it('when discovery was too slow to open its agent, waits for the agent to appear on its pane', async () => {
      // A hook from an engine started by hand in a terminal: only a discovery pass opens its agent, and
      // the pass outran its deadline (a loaded machine). Nothing is on the pane yet, so nothing waited.
      const onPane: Record<string, RegisteredSession> = {}
      vi.mocked(processRows).mockResolvedValue(newEngine() as never)
      const slow = setup(onPane, { agentReconciler: { triggerHint: vi.fn(async () => false), trigger: vi.fn(async () => false) } as unknown as EngineHookDeps['agentReconciler'] })
      const onWait = vi.fn()
      const hook = ask(slow.hooks, ['%1'], onWait)
      await hook.waiting()
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(hook.answer()).toBeUndefined()
      expect(onWait).toHaveBeenCalledTimes(1)
      // The pass, done at last, opens the agent on the pane with the engine the hook came from.
      onPane['%1'] = agent('a1', 200)
      await hook.asked
      expect(hook.answer()).toEqual(agent('a1', 200))
    })

    // On Linux the hook runs under dash, whose `sh -c` stays the hook's parent and exits with it: once
    // `onWait` has answered the hook, the caller is gone from the table. It still belongs to its engine.
    it('belongs to the agent after the wait though its own process has exited by then, by its ancestry as it arrived', async () => {
      const onPane: Record<string, RegisteredSession> = { '%1': agent('a1', 100) }
      vi.mocked(processRows).mockResolvedValueOnce(newEngine() as never).mockResolvedValue(tree([200, 1]) as never)
      const hook = ask(setup(onPane).hooks)
      await hook.waiting()
      onPane['%1'] = agent('a1', 200)
      await hook.asked
      expect(hook.answer()).toEqual(agent('a1', 200))
    })

    it('reads who it came from as it arrives, while the reconcile pass for its pane still runs', async () => {
      const onPane: Record<string, RegisteredSession> = { '%1': agent('a1', 200) }
      vi.mocked(processRows).mockResolvedValueOnce(newEngine() as never)
      let readDuringPass = -1
      const { hooks } = setup(onPane, { agentReconciler: {
        triggerHint: vi.fn(async () => { readDuringPass = vi.mocked(processRows).mock.calls.length; return true }),
        trigger: vi.fn(async () => true),
      } as unknown as EngineHookDeps['agentReconciler'] })
      expect(await hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1')], callerPid: 300 })).toEqual(agent('a1', 200))
      expect(readDuringPass).toBe(1)
    })

    it('none when what is recorded is a process it does not come from, or the table cannot be read again', async () => {
      const onPane: Record<string, RegisteredSession> = { '%1': agent('a1') }
      vi.mocked(processRows).mockResolvedValue(newEngine() as never)
      const other = ask(setup(onPane).hooks)
      await other.waiting()
      onPane['%1'] = agent('a1', 999)
      await other.asked
      expect(other.answer()).toBeNull()
      expect(console.log).toHaveBeenLastCalledWith('[hooks] unmatched claude hook · hints=tmux:%1 · resolvedRuntimes=1 · agentsOnRuntime=1'
        + ' · callerPid=300 · caller is not a descendant of that engine process')

      vi.mocked(processRows).mockReset()
      const pane: Record<string, RegisteredSession> = { '%1': agent('a1') }
      vi.mocked(processRows).mockResolvedValueOnce(newEngine() as never).mockResolvedValueOnce(null)
      const unreadable = ask(setup(pane).hooks)
      await unreadable.waiting()
      pane['%1'] = agent('a1', 200)
      await unreadable.asked
      expect(unreadable.answer()).toBeNull()
    })

    it('waits no longer than its bound for a record that does not come', async () => {
      vi.useFakeTimers()
      try {
        vi.mocked(processRows).mockResolvedValue(newEngine() as never)
        const hook = ask(setup({ '%1': agent('a1', 100) }).hooks)
        await vi.advanceTimersByTimeAsync(PROCESS_RECORD_WAIT_MS - 1)
        expect(hook.answer()).toBeUndefined()
        await vi.advanceTimersByTimeAsync(1)
        await hook.asked
        expect(hook.answer()).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('is not cut short by a step of the wall clock, as a wake or an NTP correction makes', async () => {
      // Round 29 steps the clock under working agents; a deadline on the wall clock ended this wait at
      // the first poll after a step forward, and the hook was dropped as if its record never came.
      vi.useFakeTimers()
      try {
        const onPane: Record<string, RegisteredSession> = { '%1': agent('a1', 100) }
        vi.mocked(processRows).mockResolvedValue(newEngine() as never)
        const hook = ask(setup(onPane).hooks)
        await vi.advanceTimersByTimeAsync(1_000)
        vi.setSystemTime(Date.now() + 3 * 3_600_000)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(hook.answer()).toBeUndefined()
        onPane['%1'] = agent('a1', 200)
        await vi.advanceTimersByTimeAsync(200)
        await hook.asked
        expect(hook.answer()).toEqual(agent('a1', 200))
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('a SessionEnd only asks for a reconcile: discovery decides whether the agent still exists', () => {
    const { deps, hooks } = setup()
    hooks.onSessionEnd('s1', 'exit')
    expect(deps.agentReconciler.trigger).toHaveBeenCalledTimes(1)
  })
})

describe('installing every engine\'s hooks', () => {
  const installs = [
    engineHooks.claude.install, engineHooks.codex.install, hooks.installCursorHooks, hooks.installOpencodePlugin,
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

  it('only the engines asked for (HOOK_INSTALL_ENGINES), the homes they moved included', () => {
    vi.mocked(movedEngineHomes).mockReturnValueOnce({ claude: ['/w/claude'], codex: ['/w/codex'] })
    installEngineHooks(4242, { only: new Set(['codex']), environment: {} })
    expect(engineHooks.codex.install).toHaveBeenCalledWith(4242)
    expect(engineHooks.codex.installIn).toHaveBeenCalledWith(4242, '/w/codex')
    for (const install of installs.filter((one) => one !== engineHooks.codex.install)) expect(install).not.toHaveBeenCalled()
    expect(engineHooks.claude.installIn).not.toHaveBeenCalled()
  })

  // lib/engineHomes.ts: with CLAUDE_CONFIG_DIR or CODEX_HOME in the person's profile, no agent ever bound.
  it('puts the hooks in every home adopted on an earlier boot, at every start', () => {
    vi.mocked(movedEngineHomes).mockReturnValueOnce({ claude: ['/w/claude'], codex: ['/w/codex'] })
    installEngineHooks(4242, { environment: {} })
    expect(engineHooks.claude.installIn).toHaveBeenCalledWith(4242, '/w/claude')
    expect(engineHooks.codex.installIn).toHaveBeenCalledWith(4242, '/w/codex')
  })

  it('adopts the homes its own environment moves, then the login shell\'s once that is read, and installs there', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const own = { CLAUDE_CONFIG_DIR: '/m/claude' }
    const shell = { CODEX_HOME: '/s/codex' }
    vi.mocked(adoptEngineHomes)
      .mockReturnValueOnce({ claude: '/m/claude', codex: null })
      .mockReturnValueOnce({ claude: null, codex: '/s/codex' })
    installEngineHooks(4242, { environment: own, loginShell: Promise.resolve(shell) })
    expect(adoptEngineHomes).toHaveBeenCalledWith(own, { claudeHome: dirname(env.CLAUDE_PROJECTS_DIR), codexHome: env.CODEX_HOME })
    expect(engineHooks.claude.installIn).toHaveBeenCalledWith(4242, '/m/claude')
    expect(log).toHaveBeenCalledWith('[hooks] engines keep their data elsewhere here: Claude Code in /m/claude')
    await Promise.resolve()
    expect(adoptEngineHomes).toHaveBeenLastCalledWith(shell, { claudeHome: dirname(env.CLAUDE_PROJECTS_DIR), codexHome: env.CODEX_HOME })
    expect(engineHooks.codex.installIn).toHaveBeenCalledWith(4242, '/s/codex')
    expect(log).toHaveBeenCalledWith('[hooks] engines keep their data elsewhere here: Codex in /s/codex')
  })

  it('reads the daemon\'s own environment when none is given, and logs nothing when nothing moved', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    installEngineHooks(4242)
    expect(adoptEngineHomes).toHaveBeenCalledWith(process.env, expect.anything())
    expect(log).not.toHaveBeenCalled()
  })

  it('one at a time: a vendor whose install throws is skipped and named, and the rest still install', () => {
    vi.mocked(engineHooks.codex.install).mockImplementationOnce(() => { throw new Error('config.toml is read-only') })
    vi.mocked(hooks.installGrokHooks).mockImplementationOnce(() => { throw 'settings mid-write' })
    installEngineHooks(4242)
    expect(console.warn).toHaveBeenCalledWith('[hooks] codex install skipped · config.toml is read-only')
    expect(console.warn).toHaveBeenCalledWith('[hooks] grok install skipped · settings mid-write')
    for (const install of installs) expect(install).toHaveBeenCalledTimes(1)
  })
})

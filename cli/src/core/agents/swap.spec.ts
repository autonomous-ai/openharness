import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { windowsAfterExit } from '../../lib/windows/engineStart.js'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkPidRuntime, terminateDeletedAgent } from '../../lib/deleteAgentFallback.js'
import { buildEngineLaunchArgv } from '../../lib/engineLaunch.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { processRows } from '../../lib/terminalAgentDiscovery.js'
import { resolvePaneEngineProcess } from '../../lib/paneEngineProcess.js'
import { bypassPermissionActive } from '../../lib/processTable.js'
import { AgentRestartCoordinator } from '../../lib/restartAgent.js'
import { setAgentSignaller } from '../../lib/processSignals.js'
import { createPaneSwap, SWAP_SETTLE_MS, type PaneSwapDeps } from './swap.js'
import type { NativeLaunch } from '../../engines/nativeLaunch.js'
import { NATIVE_LAUNCH_MARKER } from '../../lib/nativePaneHold.js'
import { stopConflictingBackgroundJob } from '../../lib/claudeBackgroundJob.js'

vi.mock('../../lib/deleteAgentFallback.js', async (real) => ({ ...await real<object>(), terminateDeletedAgent: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../lib/engineLaunch.js', async (real) => ({ ...await real<object>(), buildEngineLaunchArgv: vi.fn(() => ['zsh', '-lc', 'claude']) }))
vi.mock('../../lib/claudeBackgroundJob.js', () => ({ stopConflictingBackgroundJob: vi.fn(async () => {}) }))
vi.mock('../../lib/terminalAgentDiscovery.js', async (real) => ({ ...await real<object>(), processRows: vi.fn(async () => null) }))
vi.mock('../../lib/paneEngineProcess.js', async (real) => ({
  ...await real<object>(),
  resolvePaneEngineProcess: vi.fn(async () => null),
}))
vi.mock('../../lib/processTable.js', async (real) => ({
  ...await real<object>(),
  bypassPermissionActive: vi.fn(() => true),
}))

const runtime = { backend: 'tmux', paneId: '%4' } as never
const session = (over: Partial<RegisteredSession> = {}): RegisteredSession =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', registeredAt: 100, tmuxPane: '%4', cwd: '/work', ...over }) as RegisteredSession

/** The pane the last `setup` swaps in, on its fake tmux backend (`restartTargetOf`'s answer). */
let latest: { backend: never; runtime: never }
const place = () => latest

function setup(row: RegisteredSession | null = session()) {
  const tmuxBackend = {
    holdOpen: vi.fn(async () => ({ state: 'succeeded' })),
    respawn: vi.fn(async () => ({ state: 'succeeded' })),
    respawnRefusal: vi.fn(async (request: { env?: Record<string, string> }) => request.env ? 'too old' : null),
  }
  latest = { backend: tmuxBackend as never, runtime }
  const deps: PaneSwapDeps = {
    byAgent: vi.fn(() => row ?? undefined),
    prepareSessionResume: vi.fn(),
    keepAbandonedConversation: vi.fn(),
    stopNative: vi.fn(async () => {}),
  }
  return { deps, tmuxBackend, swap: createPaneSwap(deps) }
}

describe('the pane-process swap', () => {
  it('passes the prepared native snapshot into the final argv builder', () => {
    const native = { token: 'prepared-native' } as NativeLaunch
    const prepared = setup().swap.paneSwapDeps(session(), place(), { native })
    prepared.buildArgv({ resumeSessionId: 's1', bypassPermission: false })
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith('claude', expect.objectContaining({ native, resumeSessionId: 's1' }))
  })
  it('wires a background-job check for a plain Claude pane restart, with its own session and env', async () => {
    const prepared = setup().swap.paneSwapDeps(session(), place(), { env: { CLAUDE_CONFIG_DIR: '/custom' } })
    expect(prepared.stopConflictingJob).toBeDefined()
    await prepared.stopConflictingJob!()
    expect(stopConflictingBackgroundJob).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/custom' }),
    }))
  })
  it('skips the background-job check for a non-Claude engine', () => {
    const prepared = setup(session({ engine: 'codex' })).swap.paneSwapDeps(session({ engine: 'codex' }), place())
    expect(prepared.stopConflictingJob).toBeUndefined()
  })
  it('skips the background-job check for a DSH agent: its pane may run on a different host', () => {
    const dshSession = session({ dsh: { id: 'fixture-dsh', url: 'https://example.test' } as never })
    const prepared = setup(dshSession).swap.paneSwapDeps(dshSession, place())
    expect(prepared.stopConflictingJob).toBeUndefined()
  })
  it('still checks for a background job on a captured-native launch, with that launch\'s own environment', async () => {
    // `native` is the captured launch for every ordinary LOCAL Claude run (launchOverrides.ts), not a
    // signal the pane is elsewhere — it must not turn this off. `env` here stands in for what
    // launchOverrides.ts really produces: `native.environment` (its CLAUDE_CONFIG_DIR) merged in already.
    const native: NativeLaunch = { token: 'prepared-native', opencodeMajor: null,
      environment: { CLAUDE_CONFIG_DIR: '/native/claude-home' }, proofs: [], current: () => true,
      prepareHooks: async () => true, permission: async () => 'supported' }
    const prepared = setup().swap.paneSwapDeps(session(), place(), { native, env: { CLAUDE_CONFIG_DIR: '/native/claude-home' } })
    expect(prepared.stopConflictingJob).toBeDefined()
    await prepared.stopConflictingJob!()
    expect(stopConflictingBackgroundJob).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/native/claude-home' }),
    }))
  })
  it('refuses, before anything is stopped, a relaunch Windows would run through cmd.exe; builds no launch script for it', () => {
    vi.mocked(buildEngineLaunchArgv).mockClear()
    const tools = mkdtempSync(join(tmpdir(), 'swap-windows-'))
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      writeFileSync(join(tools, 'claude.cmd'), '@echo off\r\nclaude-real %*\r\n')
      vi.stubEnv('PATH', tools)
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      const prepared = setup().swap.paneSwapDeps(session(), place(), { extraArgs: ['--append-system-prompt', 'a & b'] })
      expect(prepared.launchRefusal?.({ bypassPermission: false, resumeSessionId: 's1' })).toMatch(/^Harness cannot start claude on Windows .*claude\.cmd is a batch file/)
      const clean = setup().swap.paneSwapDeps(session(), place(), { extraArgs: ['--model', 'opus'] })
      expect(clean.launchRefusal?.({ bypassPermission: false, resumeSessionId: 's1' })).toBeNull()
      expect(buildEngineLaunchArgv).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', platform)
      vi.unstubAllEnvs()
      rmSync(tools, { recursive: true, force: true })
    }
  })

  it('sends the launch\'s Windows variables (a native launch\'s marker) in the respawn env, after its own', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      const { swap, tmuxBackend } = setup()
      const native = { token: 'prepared-native' } as NativeLaunch
      await swap.paneSwapDeps(session(), place(), { native, env: { GRID: '1' } }).respawn(['claude'])
      expect(tmuxBackend.respawn).toHaveBeenLastCalledWith(runtime, expect.objectContaining({
        command: ['claude'], env: { GRID: '1', [NATIVE_LAUNCH_MARKER]: 'prepared-native' },
      }))
      // In the agent's folder, which no launch script enters there, and the pane a shell after the engine.
      expect(tmuxBackend.respawn).toHaveBeenLastCalledWith(runtime, expect.objectContaining({ cwd: '/work', afterExit: windowsAfterExit('claude') }))
      // A grid swap's vendor keys: this launch alone does not inherit them from the host.
      await swap.paneSwapDeps(session(), place(), { clearEnv: ['ANTHROPIC_API_KEY'] }).respawn(['claude'])
      expect(tmuxBackend.respawn).toHaveBeenLastCalledWith(runtime, expect.objectContaining({ clearInherited: ['ANTHROPIC_API_KEY'] }))
      expect((tmuxBackend.respawn.mock.lastCall as unknown[])[1]).not.toHaveProperty('clearEnv')
      // A retarget home (retarget.ts: `clearPaneEnv` = the grid's own variables) clears the pane's create env alone,
      // never the person's own variables the host inherited: no provider key, and its list sent apart.
      await swap.paneSwapDeps(session(), place(), { clearPaneEnv: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'] }).respawn(['claude'])
      expect(tmuxBackend.respawn).toHaveBeenLastCalledWith(runtime, expect.objectContaining({ clearEnv: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'] }))
      expect((tmuxBackend.respawn.mock.lastCall as unknown[])[1]).not.toHaveProperty('clearInherited')
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
      await swap.paneSwapDeps(session(), place(), { native }).respawn(['claude'])
      expect((tmuxBackend.respawn.mock.lastCall as unknown[] | undefined)?.[1]).not.toHaveProperty('env')
      expect((tmuxBackend.respawn.mock.lastCall as unknown[] | undefined)?.[1]).toMatchObject({ cwd: homedir() })
      expect((tmuxBackend.respawn.mock.lastCall as unknown[] | undefined)?.[1]).not.toHaveProperty('afterExit')
    } finally { Object.defineProperty(process, 'platform', platform) }
  })

  beforeEach(() => {
    vi.mocked(terminateDeletedAgent).mockClear()
    vi.mocked(resolvePaneEngineProcess).mockReset().mockResolvedValue(null)
    vi.mocked(buildEngineLaunchArgv).mockClear()
  })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('uses the coordinator that already owns boot restore revisions', () => {
    const restartJobs = new AgentRestartCoordinator()
    const boot = restartJobs.revision('a1')
    const swap = createPaneSwap({ ...setup().deps, restartJobs })
    expect(swap.restartJobs).toBe(restartJobs)
    expect(swap.restartJobs.revision('a1')).toBe(boot)
  })

  it('passes revocable ownership into the final signal and tmux dispatch boundaries', async () => {
    const { swap, tmuxBackend } = setup()
    let allowed = true
    const current = () => allowed
    const prepared = swap.paneSwapDeps(session(), place(), {}, null, current)
    expect(prepared.isCurrent?.()).toBe(true)
    await prepared.holdOpen()
    expect(tmuxBackend.holdOpen).toHaveBeenCalledWith(runtime, current)
    await prepared.terminate()
    const signalCurrent = vi.mocked(terminateDeletedAgent).mock.lastCall?.[1].current
    expect(signalCurrent?.()).toBe(true)
    allowed = false
    expect(signalCurrent?.()).toBe(false)
    await prepared.respawn(['fixture-engine'])
    expect(tmuxBackend.respawn).toHaveBeenCalledWith(runtime, expect.objectContaining({ current }))
  })

  it('restarts only the agent it was asked about: same registration, same pane, same engine', () => {
    expect(setup().swap.sameRestartTarget(session())).toBe(true)
    expect(setup(null).swap.sameRestartTarget(session())).toBe(false)
    for (const changed of [{ registeredAt: 101 }, { tmuxPane: '%5' }, { engine: 'codex' }] as Array<Partial<RegisteredSession>>) {
      expect(setup(session(changed)).swap.sameRestartTarget(session()), JSON.stringify(changed)).toBe(false)
    }
    expect(setup().swap.restartJobs).toBeDefined()
  })

  it('prepares the resume, holds the pane open and respawns it in the home folder, saying why when tmux will not', async () => {
    const { deps, tmuxBackend, swap } = setup()
    const swapDeps = swap.paneSwapDeps(session(), place(), { env: { GRID_KEY: 'k' } })
    swapDeps.prepareResume?.()
    expect(deps.prepareSessionResume).toHaveBeenCalledWith(session())
    swapDeps.keepAbandoned?.()
    expect(deps.keepAbandonedConversation).toHaveBeenCalledWith(session())
    // Asked of tmux with the relaunch's own environment, before anything is stopped.
    expect(await swapDeps.respawnRefusal?.()).toBe('too old')
    expect(await swap.paneSwapDeps(session(), place()).respawnRefusal?.()).toBeNull()
    expect(await swapDeps.holdOpen()).toEqual({ ok: true })
    tmuxBackend.holdOpen.mockResolvedValueOnce({ state: 'failed', reason: 'pane gone' } as never).mockResolvedValueOnce({ state: 'unknown' } as never)
    expect(await swapDeps.holdOpen()).toEqual({ ok: false, reason: 'pane gone' })
    expect(await swapDeps.holdOpen()).toEqual({ ok: false, reason: 'could not re-arm remain-on-exit' })
    expect(await swapDeps.respawn(['claude', '--resume', 's1'])).toEqual({ ok: true })
    expect(tmuxBackend.respawn).toHaveBeenCalledWith(runtime, { command: ['claude', '--resume', 's1'], cwd: homedir(), env: { GRID_KEY: 'k' } })
    tmuxBackend.respawn.mockResolvedValueOnce({ state: 'failed', reason: 'busy' } as never).mockResolvedValueOnce({ state: 'unknown' } as never)
    expect(await swapDeps.respawn(['claude'])).toEqual({ ok: false, reason: 'busy' })
    expect(await swapDeps.respawn(['claude'])).toEqual({ ok: false, reason: 'tmux respawn-pane did not complete' })
    await swap.paneSwapDeps(session(), place()).respawn(['claude'])
    expect(tmuxBackend.respawn).toHaveBeenLastCalledWith(runtime, { command: ['claude'], cwd: homedir() })
  })

  it('swaps a ptyhost pane through its own backend, which refuses no environment', async () => {
    const { swap, tmuxBackend } = setup()
    const pty = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%3' }
    const ptyBackend = { holdOpen: vi.fn(async () => ({ state: 'succeeded' })), respawn: vi.fn(async () => ({ state: 'succeeded' })) }
    const current = () => true
    const swapDeps = swap.paneSwapDeps(session(), { backend: ptyBackend as never, runtime: pty }, { env: { GRID_KEY: 'k' }, clearPaneEnv: ['ANTHROPIC_BASE_URL'] }, null, current)
    expect(swapDeps.respawnRefusal).toBeUndefined()
    expect(await swapDeps.holdOpen()).toEqual({ ok: true })
    expect(ptyBackend.holdOpen).toHaveBeenCalledWith(pty, current)
    expect(await swapDeps.respawn(['claude'])).toEqual({ ok: true })
    // The grid's names leave what the pane was created with (tmux clears its session env instead).
    expect(ptyBackend.respawn).toHaveBeenCalledWith(pty, { command: ['claude'], current, cwd: homedir(), env: { GRID_KEY: 'k' }, clearEnv: ['ANTHROPIC_BASE_URL'] })
    vi.useFakeTimers()
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue({ pid: 9, startMarker: 'm' } as never)
    const waiting = swapDeps.waitForProcess()
    await vi.advanceTimersByTimeAsync(150 + SWAP_SETTLE_MS)
    expect(await waiting).toEqual({ pid: 9, startMarker: 'm' })
    expect(resolvePaneEngineProcess).toHaveBeenCalledWith(ptyBackend, pty, 'claude')
    expect(tmuxBackend.holdOpen).not.toHaveBeenCalled()
    expect(tmuxBackend.respawn).not.toHaveBeenCalled()
    expect(tmuxBackend.respawnRefusal).not.toHaveBeenCalled()
  })

  it('terminates the engine through the deleted-agent fallback, with real signals and sleeps', async () => {
    const { swap } = setup()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await swap.paneSwapDeps(session(), place()).terminate(250)
    const [target, used, after] = vi.mocked(terminateDeletedAgent).mock.calls[0]
    expect(target).toEqual(session())
    expect(after).toBe(250)
    expect(used.checkRuntime).toBe(checkPidRuntime)
    used.kill?.(42, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(42, 'SIGTERM')
    const injected = vi.fn()
    setAgentSignaller(injected)
    try { used.kill?.(43, 'SIGKILL') } finally { setAgentSignaller(null) }
    expect(injected).toHaveBeenCalledExactlyOnceWith(43, 'SIGKILL')
    await used.sleep?.(1)
    used.log?.('stopping')
    expect(log).toHaveBeenCalledWith('stopping')
  })

  it('releases the conversation on its native server before signalling the terminal client', async () => {
    const { deps, swap } = setup(session({ engine: 'codex' }))
    let release!: () => void
    vi.mocked(deps.stopNative).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const stopping = swap.paneSwapDeps(session({ engine: 'codex' }), place()).terminate()
    expect(deps.stopNative).toHaveBeenCalledWith(session({ engine: 'codex' }), expect.any(Function))
    expect(terminateDeletedAgent).not.toHaveBeenCalled()
    release()
    await stopping
    expect(terminateDeletedAgent).toHaveBeenCalledOnce()
  })

  it('leaves the terminal client running when its native server cannot release the conversation', async () => {
    const { deps, swap } = setup()
    vi.mocked(deps.stopNative).mockRejectedValueOnce(new Error('Could not confirm the conversation stopped'))
    await expect(swap.paneSwapDeps(session(), place()).terminate()).rejects.toThrow('Could not confirm')
    expect(terminateDeletedAgent).not.toHaveBeenCalled()
  })

  it('does nothing when the swap was cancelled before releasing its conversation', async () => {
    const { deps, swap } = setup()
    expect(await swap.paneSwapDeps(session(), place(), {}, null, () => false).terminate()).toBe('not-ours')
    expect(deps.stopNative).not.toHaveBeenCalled()
    expect(terminateDeletedAgent).not.toHaveBeenCalled()
  })

  it.each(['cancelled', 'conversation', 'profile', 'process', 'registration', 'removed'] as const)('revokes the native stop and the terminal signal when %s while the server answers', async change => {
    const row = session({ engine: 'codex', processIdentity: { pid: 42, executable: 'codex', startMarker: 'before' } })
    const { deps, swap } = setup(row)
    let allowed = true
    const prepared = swap.paneSwapDeps(row, place(), {}, null, () => allowed)
    vi.mocked(deps.stopNative).mockImplementationOnce(async (target, current) => {
      expect(current()).toBe(true)
      if (change === 'cancelled') allowed = false
      if (change === 'conversation') row.sessionId = 'new-conversation'
      if (change === 'profile') row.codexHome = '/new-profile'
      if (change === 'process') row.processIdentity!.startMarker = 'replacement'
      if (change === 'registration') row.registeredAt++
      if (change === 'removed') vi.mocked(deps.byAgent).mockReturnValue(undefined)
      expect(target.sessionId).toBe('s1')
      expect(target.processIdentity!.startMarker).toBe('before')
      expect(current()).toBe(false)
    })
    expect(await prepared.terminate()).toBe('not-ours')
    expect(terminateDeletedAgent).not.toHaveBeenCalled()
  })

  it('waits for the new process with growing pauses, and gives up once eight seconds have passed', async () => {
    vi.useFakeTimers()
    const { swap, tmuxBackend } = setup()
    const found = { pid: 99, startMarker: 'now' }
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(null).mockResolvedValueOnce(found as never).mockResolvedValueOnce({ ...found } as never)
    const waiting = swap.paneSwapDeps(session(), place()).waitForProcess()
    await vi.advanceTimersByTimeAsync(150 + 300 + SWAP_SETTLE_MS)
    expect(await waiting).toEqual(found)
    // Asked of the pane's own backend, about the pane being swapped.
    expect(resolvePaneEngineProcess).toHaveBeenCalledWith(tmuxBackend, runtime, 'claude')
    const never = swap.paneSwapDeps(session(), place()).waitForProcess()
    // 150, 300, 600, then 750 ms at a time: the budget is spent on the look that crosses 8 s.
    await vi.advanceTimersByTimeAsync(9_000)
    expect(await never).toBeNull()
  })

  // A launch the engine refuses (`codex resume` after an update dropped it) runs for an instant: seen in
  // that instant, a restart called the conversation resumed and never fell back to a fresh start.
  it('counts a process as come up only when it is still the pane\'s engine a moment later', async () => {
    vi.useFakeTimers()
    const { swap } = setup()
    const refused = { pid: 98, startMarker: 'then' }
    const lasting = { pid: 99, startMarker: 'now' }
    vi.mocked(resolvePaneEngineProcess)
      .mockResolvedValueOnce(refused as never).mockResolvedValueOnce(null)
      // Another process in its place by the second look is not the one seen: it is looked at afresh.
      .mockResolvedValueOnce(lasting as never).mockResolvedValueOnce({ pid: 99, startMarker: 'later' } as never)
      .mockResolvedValueOnce(lasting as never).mockResolvedValueOnce({ ...lasting } as never)
    const waiting = swap.paneSwapDeps(session(), place()).waitForProcess()
    await vi.advanceTimersByTimeAsync(150 + SWAP_SETTLE_MS + 300 + SWAP_SETTLE_MS + 600 + SWAP_SETTLE_MS)
    expect(await waiting).toEqual(lasting)
    expect(resolvePaneEngineProcess).toHaveBeenCalledTimes(6)
    // One that never stays up is no engine: the wait ends as one that found none.
    vi.mocked(resolvePaneEngineProcess).mockReset().mockImplementation(async () => {
      refused.pid++
      return { ...refused } as never
    })
    const never = swap.paneSwapDeps(session(), place()).waitForProcess()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(await never).toBeNull()
  })

  it('builds the relaunch argv with the row\'s mode, folder, the caller\'s argv and the keys a grid must clear', () => {
    const { swap } = setup()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const plain = swap.paneSwapDeps(session({ permissionMode: 'plan' } as Partial<RegisteredSession>), place())
    plain.buildArgv({ resumeSessionId: 's1' } as never)
    expect(buildEngineLaunchArgv).toHaveBeenLastCalledWith('claude', { resumeSessionId: 's1', permissionMode: 'plan', cwd: '/work' })
    const grid = swap.paneSwapDeps(session({ cwd: undefined }), place(), { env: { HARNESS_DSH: 'blender' }, extraArgs: ['--grid'], clearEnv: ['ANTHROPIC_API_KEY'] }, null)
    grid.buildArgv({} as never)
    expect(buildEngineLaunchArgv).toHaveBeenLastCalledWith('claude', { extraArgs: ['--grid'], clearEnv: ['ANTHROPIC_API_KEY'], harnessNode: true })
    swap.paneSwapDeps(session(), place(), { extraArgs: [], clearEnv: [] }).buildArgv({} as never)
    expect(buildEngineLaunchArgv).toHaveBeenLastCalledWith('claude', { cwd: '/work' })
    grid.log('swapped')
    expect(log).toHaveBeenCalledWith('swapped')
  })

  it('reads the live process\'s bypass flag, and says no when it cannot find the process', async () => {
    const { swap } = setup()
    expect(await swap.liveBypassPermission(session())).toBe(false)
    const identity = { pid: 42, startMarker: 'm1' }
    expect(await swap.liveBypassPermission(session({ processIdentity: identity } as Partial<RegisteredSession>))).toBe(false)
    vi.mocked(processRows).mockResolvedValue([{ pid: 42, startMarker: 'other', args: 'claude' }, { pid: 42, startMarker: 'm1', args: 'claude --dangerously-skip-permissions' }] as never)
    expect(await swap.liveBypassPermission(session({ processIdentity: identity } as Partial<RegisteredSession>))).toBe(true)
    expect(bypassPermissionActive).toHaveBeenCalledWith('claude', 'claude --dangerously-skip-permissions')
    expect(await swap.liveBypassPermission(session({ processIdentity: { pid: 43, startMarker: 'm1' } } as Partial<RegisteredSession>))).toBe(false)
  })
})

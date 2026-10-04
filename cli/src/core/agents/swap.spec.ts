import { homedir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkPidRuntime, terminateDeletedAgent } from '../../lib/deleteAgentFallback.js'
import { buildEngineLaunchArgv } from '../../lib/engineLaunch.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { processRows } from '../../lib/terminalAgentDiscovery.js'
import { bypassPermissionActive, resolvePaneEngineProcess } from '../../lib/tmux.js'
import { createPaneSwap, type PaneSwapDeps } from './swap.js'

vi.mock('../../lib/deleteAgentFallback.js', async (real) => ({ ...await real<object>(), terminateDeletedAgent: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../lib/engineLaunch.js', async (real) => ({ ...await real<object>(), buildEngineLaunchArgv: vi.fn(() => ['zsh', '-lc', 'claude']) }))
vi.mock('../../lib/terminalAgentDiscovery.js', async (real) => ({ ...await real<object>(), processRows: vi.fn(async () => null) }))
vi.mock('../../lib/tmux.js', async (real) => ({
  ...await real<object>(),
  bypassPermissionActive: vi.fn(() => true),
  resolvePaneEngineProcess: vi.fn(async () => null),
}))

const runtime = { backend: 'tmux', paneId: '%4' } as never
const session = (over: Partial<RegisteredSession> = {}): RegisteredSession =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', registeredAt: 100, tmuxPane: '%4', cwd: '/work', ...over }) as RegisteredSession

function setup(row: RegisteredSession | null = session()) {
  const tmuxBackend = {
    holdOpen: vi.fn(async () => ({ state: 'succeeded' })),
    respawn: vi.fn(async () => ({ state: 'succeeded' })),
  }
  const deps: PaneSwapDeps = {
    byAgent: vi.fn(() => row ?? undefined),
    tmuxBackend: tmuxBackend as unknown as PaneSwapDeps['tmuxBackend'],
    prepareSessionResume: vi.fn(),
  }
  return { deps, tmuxBackend, swap: createPaneSwap(deps) }
}

describe('the pane-process swap', () => {
  beforeEach(() => {
    vi.mocked(resolvePaneEngineProcess).mockReset().mockResolvedValue(null)
    vi.mocked(buildEngineLaunchArgv).mockClear()
  })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

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
    const swapDeps = swap.paneSwapDeps(session(), runtime, { env: { GRID_KEY: 'k' } })
    swapDeps.prepareResume?.()
    expect(deps.prepareSessionResume).toHaveBeenCalledWith(session())
    expect(await swapDeps.holdOpen()).toEqual({ ok: true })
    tmuxBackend.holdOpen.mockResolvedValueOnce({ state: 'failed', reason: 'pane gone' } as never).mockResolvedValueOnce({ state: 'unknown' } as never)
    expect(await swapDeps.holdOpen()).toEqual({ ok: false, reason: 'pane gone' })
    expect(await swapDeps.holdOpen()).toEqual({ ok: false, reason: 'could not re-arm remain-on-exit' })
    expect(await swapDeps.respawn(['claude', '--resume', 's1'])).toEqual({ ok: true })
    expect(tmuxBackend.respawn).toHaveBeenCalledWith(runtime, { command: ['claude', '--resume', 's1'], cwd: homedir(), env: { GRID_KEY: 'k' } })
    tmuxBackend.respawn.mockResolvedValueOnce({ state: 'failed', reason: 'busy' } as never).mockResolvedValueOnce({ state: 'unknown' } as never)
    expect(await swapDeps.respawn(['claude'])).toEqual({ ok: false, reason: 'busy' })
    expect(await swapDeps.respawn(['claude'])).toEqual({ ok: false, reason: 'tmux respawn-pane did not complete' })
    await swap.paneSwapDeps(session(), runtime).respawn(['claude'])
    expect(tmuxBackend.respawn).toHaveBeenLastCalledWith(runtime, { command: ['claude'], cwd: homedir() })
  })

  it('terminates the engine through the deleted-agent fallback, with real signals and sleeps', async () => {
    const { swap } = setup()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await swap.paneSwapDeps(session(), runtime).terminate(250)
    const [target, used, after] = vi.mocked(terminateDeletedAgent).mock.calls[0]
    expect(target).toEqual(session())
    expect(after).toBe(250)
    expect(used.checkRuntime).toBe(checkPidRuntime)
    used.kill?.(42, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(42, 'SIGTERM')
    await used.sleep?.(1)
    used.log?.('stopping')
    expect(log).toHaveBeenCalledWith('stopping')
  })

  it('waits for the new process with growing pauses, and gives up once eight seconds have passed', async () => {
    vi.useFakeTimers()
    const { swap } = setup()
    const found = { pid: 99, startMarker: 'now' }
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(null).mockResolvedValueOnce(found as never)
    const waiting = swap.paneSwapDeps(session(), runtime).waitForProcess()
    await vi.advanceTimersByTimeAsync(150 + 300)
    expect(await waiting).toEqual(found)
    const never = swap.paneSwapDeps(session(), runtime).waitForProcess()
    // 150, 300, 600, then 750 ms at a time: the budget is spent on the look that crosses 8 s.
    await vi.advanceTimersByTimeAsync(9_000)
    expect(await never).toBeNull()
  })

  it('builds the relaunch argv with the row\'s mode, folder, the caller\'s argv and the keys a grid must clear', () => {
    const { swap } = setup()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const plain = swap.paneSwapDeps(session({ permissionMode: 'plan' } as Partial<RegisteredSession>), runtime)
    plain.buildArgv({ resumeSessionId: 's1' } as never)
    expect(buildEngineLaunchArgv).toHaveBeenLastCalledWith('claude', { resumeSessionId: 's1', permissionMode: 'plan', cwd: '/work' })
    const grid = swap.paneSwapDeps(session({ cwd: undefined }), runtime, { env: { HARNESS_DSH: 'blender' }, extraArgs: ['--grid'], clearEnv: ['ANTHROPIC_API_KEY'] }, null)
    grid.buildArgv({} as never)
    expect(buildEngineLaunchArgv).toHaveBeenLastCalledWith('claude', { extraArgs: ['--grid'], clearEnv: ['ANTHROPIC_API_KEY'], harnessNode: true })
    swap.paneSwapDeps(session(), runtime, { extraArgs: [], clearEnv: [] }).buildArgv({} as never)
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

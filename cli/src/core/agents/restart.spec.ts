import { homedir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { engineBin, enginePathOverride } from '../../lib/engineBin.js'
import { engineInstallRecipe } from '../../lib/engineInstall.js'
import { buildEngineLaunchArgv, commandAvailableInInteractiveShell } from '../../lib/engineLaunch.js'
import { probeGatewayRuntime } from '../../lib/gatewayRuntime.js'
import { probeGridAssignment } from '../../lib/gridAssignment.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { AgentRestartCoordinator, bypassPermissionFor, restartAgent } from '../../lib/restartAgent.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { clearPaneRemainOnExit, processArgs } from '../../lib/tmux.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import { createAgentRestarter, type RestartDeps } from './restart.js'

vi.mock('../../lib/engineBin.js', async (real) => ({ ...await real<object>(), enginePathOverride: vi.fn(() => undefined) }))
vi.mock('../../lib/engineLaunch.js', async (real) => ({
  ...await real<object>(),
  buildEngineLaunchArgv: vi.fn(() => ['zsh', '-l']),
  commandAvailableInInteractiveShell: vi.fn(async () => true),
}))
vi.mock('../../lib/gatewayRuntime.js', async (real) => ({ ...await real<object>(), probeGatewayRuntime: vi.fn(async () => ({ kind: 'none' })) }))
vi.mock('../../lib/gridAssignment.js', async (real) => ({ ...await real<object>(), probeGridAssignment: vi.fn(async () => undefined) }))
vi.mock('../../lib/restartAgent.js', async (real) => ({
  ...await real<object>(),
  bypassPermissionFor: vi.fn(async (_s: unknown, live: () => Promise<boolean>) => live()),
  restartAgent: vi.fn(async () => ({ ok: true, resumed: true, processIdentity: { pid: 2, startMarker: 'new', executable: '/bin/claude' } })),
}))
vi.mock('../../lib/tmux.js', async (real) => ({
  ...await real<object>(), clearPaneRemainOnExit: vi.fn(async () => {}),
  processArgs: vi.fn(async () => '/bin/claude --model opus -c model_provider=grid'),
}))
vi.mock('../../lib/workspaceCheck.js', () => ({ workspaceMissing: vi.fn(() => null) }))

const runtime = { backend: 'tmux', paneId: '%4' }
const routeKey = terminalRouteKey(runtime as never)
const newProcess = { pid: 2, startMarker: 'new', executable: '/bin/claude' }
const agent = (over: Partial<RegisteredSession> = {}): RegisteredSession => ({
  agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: '/work', tmuxPane: '%4', processIdentity: { pid: 1, startMarker: 'old' }, ...over,
}) as unknown as RegisteredSession
const terminal = (over: Partial<RegisteredSession> = {}) => agent({ engine: 'terminal', processIdentity: undefined, ...over } as Partial<RegisteredSession>)

/** `row` is what the registry resolves and reads back; `refreshed` is what it reads after the swap
 *  (null: the row vanished mid-restart). `live` goes false to make the operation stale. */
function setup(row: RegisteredSession | null = agent(), over: Partial<RestartDeps> = {}, refreshed: RegisteredSession | null = row) {
  const state = { live: true }
  const tmuxBackend = { respawn: vi.fn(async () => ({ state: 'succeeded' })) }
  const deps: RestartDeps = {
    restartJobs: { run: vi.fn((_id: string, job: (current: () => boolean) => unknown) => job(() => state.live)) } as never,
    registry: {
      resolve: vi.fn(() => row ?? undefined),
      byAgent: vi.fn(() => refreshed ?? undefined),
      updateProcessIdentity: vi.fn(),
      setActive: vi.fn(),
    } as unknown as RestartDeps['registry'],
    purgeBusy: vi.fn(() => false),
    stopJobs: new Map(),
    pinnedControls: new Set(),
    tmuxBackend: tmuxBackend as unknown as RestartDeps['tmuxBackend'],
    sameRestartTarget: vi.fn(() => true),
    agentReconciler: { holdRoute: vi.fn(), releaseRoute: vi.fn() },
    terminalHintMachineName: () => 'studio',
    announceSession: vi.fn(),
    relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: { env: { GRID_KEY: 'k' } } })) as never,
    downgradedPermission: vi.fn(async (_s, bypass: boolean) => ({ bypassPermission: bypass, permissionMode: 'auto' })) as never,
    refreshGridWebSearch: vi.fn() as never,
    liveBypassPermission: vi.fn(async () => true),
    paneSwapDeps: vi.fn(() => ({ swap: true })) as never,
    ...over,
  }
  return { deps, state, tmuxBackend, restart: createAgentRestarter(deps) }
}

const changed = { ok: false, error: 'AGENT_CHANGED', detail: 'The harness changed or stopped during restart.' }

describe('restarting an agent', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  describe('refusals before anything is touched', () => {
    it('for an agent being purged, stopped or answered, and for one that is not there', async () => {
      expect(await setup(agent(), { purgeBusy: () => true }).restart('a1')).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(await setup(agent(), { stopJobs: new Map([['a1', Promise.resolve()]]) }).restart('a1')).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(await setup(agent(), { pinnedControls: new Set(['a1']) }).restart('a1')).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(await setup(null).restart('a1')).toEqual({ ok: false, error: 'AGENT_NOT_FOUND' })
    })

    it('for an agent with no tmux pane, or no tmux at all', async () => {
      expect(await setup(agent({ tmuxPane: undefined })).restart('a1')).toEqual({ ok: false, error: 'RESTART_UNSUPPORTED_BACKEND' })
      expect(await setup(agent(), { tmuxBackend: null }).restart('a1')).toEqual({ ok: false, error: 'RESTART_UNSUPPORTED_BACKEND' })
    })

    it('for an operation already overtaken, or an agent that is no longer the one asked about', async () => {
      const stale = setup()
      stale.state.live = false
      expect(await stale.restart('a1')).toEqual(changed)
      const replaced = setup(agent(), { sameRestartTarget: vi.fn(() => false) })
      expect(await replaced.restart('a1')).toEqual(changed)
      expect(replaced.deps.sameRestartTarget).toHaveBeenCalledWith(agent())
      expect(replaced.deps.agentReconciler.holdRoute).not.toHaveBeenCalled()
    })

    it('for a folder that is gone, before the old process is killed', async () => {
      vi.mocked(workspaceMissing).mockReturnValueOnce({ ok: false, error: 'CWD_NOT_FOUND', detail: 'gone' } as never)
      const run = setup()
      expect(await run.restart('a1')).toEqual({ ok: false, error: 'CWD_NOT_FOUND', detail: 'gone' })
      expect(workspaceMissing).toHaveBeenCalledWith('/work')
      expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
      expect(restartAgent).not.toHaveBeenCalled()
    })

    it('for an engine uninstalled since the agent started, before anything is touched, and the agent goes on', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.mocked(commandAvailableInInteractiveShell).mockResolvedValueOnce(false)
      const run = setup()
      expect(await run.restart('a1')).toEqual({
        ok: false, error: 'ENGINE_NOT_INSTALLED', detail: 'claude is not installed. Install it, then restart again. Nothing was stopped.',
      })
      // Asked as create asks: the launch's own command, and the install recipe unless a path was set.
      expect(commandAvailableInInteractiveShell).toHaveBeenCalledWith(engineBin('claude'), undefined, engineInstallRecipe('claude'))
      expect(console.warn).toHaveBeenCalledWith('[restart] a1 refused · claude is not installed')
      expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
      expect(run.deps.agentReconciler.holdRoute).not.toHaveBeenCalled()
      expect(restartAgent).not.toHaveBeenCalled()

      vi.mocked(enginePathOverride).mockReturnValueOnce('/opt/claude')
      vi.mocked(commandAvailableInInteractiveShell).mockResolvedValueOnce(false)
      expect(await setup().restart('a1')).toMatchObject({ ok: false, error: 'ENGINE_NOT_INSTALLED' })
      expect(vi.mocked(commandAvailableInInteractiveShell).mock.calls[1][2]).toBeUndefined()
    })

    it('but not on a no from a shell that gave up: a slow rc file is not a missing engine', async () => {
      // The check starts at 0, and the shell's no comes at 5s, when the probe gives up waiting for it.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
      vi.mocked(commandAvailableInInteractiveShell).mockImplementationOnce(async () => { clock.mockReturnValue(5_000); return false })
      const run = setup()
      expect(await run.restart('a1')).toEqual({ ok: true, session: agent(), resumed: true })
      expect(restartAgent).toHaveBeenCalled()
    })

    it('and stops, touching nothing, when the operation is overtaken while the engine is looked for', async () => {
      const run = setup()
      vi.mocked(commandAvailableInInteractiveShell).mockImplementationOnce(async () => { run.state.live = false; return false })
      expect(await run.restart('a1')).toEqual(changed)
      expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
      expect(restartAgent).not.toHaveBeenCalled()
    })

    it('for an engine with no process to replace, or a launch it cannot honour', async () => {
      expect(await setup(agent({ processIdentity: undefined } as Partial<RegisteredSession>)).restart('a1')).toEqual({ ok: false, error: 'NO_ACTIVE_PROCESS' })
      const refused = setup(agent(), { relaunchOverrides: vi.fn(async () => ({ ok: false, error: 'API_UNAVAILABLE', detail: 'removed' })) as never })
      expect(await refused.restart('a1')).toEqual({ ok: false, error: 'API_UNAVAILABLE', detail: 'removed' })
      expect(refused.deps.agentReconciler.holdRoute).not.toHaveBeenCalled()
      expect(restartAgent).not.toHaveBeenCalled()
    })
  })

  describe('one job per agent', () => {
    it('keyed by the agent a session id resolves to, or by the id as given when nothing resolves', async () => {
      const run = setup(agent())
      await run.restart('s1')
      expect(run.deps.restartJobs.run).toHaveBeenCalledWith('a1', expect.any(Function))
      const missing = setup(null)
      await missing.restart('ghost')
      expect(missing.deps.restartJobs.run).toHaveBeenCalledWith('ghost', expect.any(Function))
    })

    it('so a second restart of the same agent joins the first through the real coordinator', async () => {
      const restartJobs = new AgentRestartCoordinator()
      const run = setup(terminal(), { restartJobs })
      const [first, second] = await Promise.all([run.restart('a1'), run.restart('a1')])
      expect(second).toBe(first)
      expect(run.tmuxBackend.respawn).toHaveBeenCalledTimes(1)
      expect(restartJobs.busy('a1')).toBe(false)
    })
  })

  describe('a terminal', () => {
    it('restarts as a fresh shell in the same pane, opened like a new terminal tile', async () => {
      const run = setup(terminal())
      expect(await run.restart('a1')).toEqual({ ok: true, session: terminal(), resumed: false })
      expect(buildEngineLaunchArgv).toHaveBeenCalledWith('terminal', { cwd: '/work', terminalHint: { machineName: 'studio' } })
      expect(run.tmuxBackend.respawn).toHaveBeenCalledWith(runtime, { command: ['zsh', '-l'], cwd: homedir() })
      expect(clearPaneRemainOnExit).toHaveBeenCalledWith('%4')
      expect(run.deps.registry.setActive).toHaveBeenCalledWith('a1', true)
      expect(run.deps.announceSession).toHaveBeenCalledWith(terminal())
      expect(console.log).toHaveBeenCalledWith('[restart] a1 terminal · fresh shell')
      expect(run.deps.agentReconciler.holdRoute).toHaveBeenCalledWith(routeKey)
      expect(run.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)
      expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
    })

    it('with no folder of its own, opens without one', async () => {
      await setup(terminal({ cwd: undefined })).restart('a1')
      expect(buildEngineLaunchArgv).toHaveBeenCalledWith('terminal', { terminalHint: { machineName: 'studio' } })
    })

    it('says why tmux would not respawn it, and lets the route go', async () => {
      const run = setup(terminal())
      run.tmuxBackend.respawn.mockResolvedValueOnce({ state: 'failed', reason: 'pane gone' } as never)
      expect(await run.restart('a1')).toEqual({ ok: false, error: 'RESTART_FAILED', detail: 'pane gone' })
      expect(clearPaneRemainOnExit).not.toHaveBeenCalled()
      expect(run.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)
    })

    it('stops at whichever step finds the operation overtaken', async () => {
      const respawned = setup(terminal())
      respawned.tmuxBackend.respawn.mockImplementationOnce(async () => { respawned.state.live = false; return { state: 'succeeded' } })
      expect(await respawned.restart('a1')).toEqual(changed)
      expect(clearPaneRemainOnExit).not.toHaveBeenCalled()
      expect(respawned.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)

      const cleared = setup(terminal())
      vi.mocked(clearPaneRemainOnExit).mockImplementationOnce(async () => { cleared.state.live = false })
      expect(await cleared.restart('a1')).toEqual(changed)
      expect(cleared.deps.registry.setActive).not.toHaveBeenCalled()
    })

    it('fails, without announcing, when the row vanished mid-restart', async () => {
      const run = setup(terminal(), {}, null)
      expect(await run.restart('a1')).toEqual({ ok: false, error: 'RESTART_FAILED', detail: 'agent vanished from the registry mid-restart' })
      expect(run.deps.announceSession).not.toHaveBeenCalled()
    })
  })

  describe('an engine', () => {
    it('comes back in the same pane with its launch, its permission and its conversation', async () => {
      const run = setup()
      expect(await run.restart('a1')).toEqual({ ok: true, session: agent(), resumed: true })
      expect(bypassPermissionFor).toHaveBeenCalledWith(agent(), expect.any(Function))
      expect(run.deps.liveBypassPermission).toHaveBeenCalledWith(agent())
      expect(run.deps.downgradedPermission).toHaveBeenCalledWith(agent(), true, 'restart')
      expect(run.deps.paneSwapDeps).toHaveBeenCalledWith(agent(), runtime, { env: { GRID_KEY: 'k' } }, 'auto')
      const [target, bypass, swapDeps] = vi.mocked(restartAgent).mock.calls[0]
      expect(target).toEqual({ engine: 'claude', sessionId: 's1' })
      expect(bypass).toBe(true)
      expect(swapDeps).toMatchObject({ swap: true })
      expect(swapDeps.isCurrent?.()).toBe(true)
      expect(run.deps.refreshGridWebSearch).toHaveBeenCalledWith('a1', { env: { GRID_KEY: 'k' } })
      expect(probeGatewayRuntime).toHaveBeenCalledWith(newProcess)
      // Its command line, where a Codex or pi grid's address and model are: never its executable alone.
      expect(processArgs).toHaveBeenCalledWith(newProcess)
      expect(probeGridAssignment).toHaveBeenCalledWith(newProcess, 'claude', '/bin/claude --model opus -c model_provider=grid')
      expect(run.deps.registry.updateProcessIdentity).toHaveBeenCalledWith('a1', newProcess, 'none', undefined)
      expect(run.deps.registry.setActive).toHaveBeenCalledWith('a1', true)
      expect(clearPaneRemainOnExit).toHaveBeenCalledWith('%4')
      expect(run.deps.announceSession).toHaveBeenCalledWith(agent())
      expect(console.log).toHaveBeenCalledWith('[restart] a1 claude · resumed')
      expect(run.deps.agentReconciler.holdRoute).toHaveBeenCalledWith(routeKey)
      expect(run.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)
    })

    it('without a mode or a yes, launches with no mode and no bypass; a fresh session on a grid says both', async () => {
      const grid = agent({ gridLaunch: { networkName: 'Home' } } as Partial<RegisteredSession>)
      const run = setup(grid, { downgradedPermission: vi.fn(async () => ({ bypassPermission: false })) as never })
      vi.mocked(restartAgent).mockResolvedValueOnce({ ok: true, resumed: false, processIdentity: newProcess } as never)
      expect(await run.restart('a1')).toEqual({ ok: true, session: grid, resumed: false })
      expect(run.deps.paneSwapDeps).toHaveBeenCalledWith(grid, runtime, { env: { GRID_KEY: 'k' } }, null)
      expect(vi.mocked(restartAgent).mock.calls[0][1]).toBe(false)
      expect(console.log).toHaveBeenCalledWith('[restart] a1 claude · fresh session · grid Home')
    })

    it('says why the swap failed, and lets the route go', async () => {
      vi.mocked(restartAgent).mockResolvedValueOnce({ ok: false, detail: 'could not re-arm the pane' } as never)
      const run = setup()
      expect(await run.restart('a1')).toEqual({ ok: false, error: 'RESTART_FAILED', detail: 'could not re-arm the pane' })
      expect(run.deps.refreshGridWebSearch).not.toHaveBeenCalled()
      expect(run.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)
    })

    it('stops at whichever step finds the operation overtaken', async () => {
      const built = setup()
      vi.mocked(built.deps.relaunchOverrides).mockImplementationOnce(async () => { built.state.live = false; return { ok: true, overrides: {} } as never })
      expect(await built.restart('a1')).toEqual(changed)
      expect(built.deps.agentReconciler.holdRoute).not.toHaveBeenCalled()

      const swapped = setup()
      vi.mocked(restartAgent).mockImplementationOnce(async () => { swapped.state.live = false; return { ok: true, resumed: true, processIdentity: newProcess } as never })
      expect(await swapped.restart('a1')).toEqual(changed)
      expect(swapped.deps.refreshGridWebSearch).not.toHaveBeenCalled()
      expect(swapped.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)

      const probed = setup()
      vi.mocked(probeGatewayRuntime).mockImplementationOnce(async () => { probed.state.live = false; return { kind: 'none' } as never })
      expect(await probed.restart('a1')).toEqual(changed)
      expect(probed.deps.registry.updateProcessIdentity).not.toHaveBeenCalled()

      const cleared = setup()
      vi.mocked(clearPaneRemainOnExit).mockImplementationOnce(async () => { cleared.state.live = false })
      expect(await cleared.restart('a1')).toEqual(changed)
      expect(cleared.deps.announceSession).not.toHaveBeenCalled()
    })

    it('fails, without announcing, when the row vanished mid-restart', async () => {
      const run = setup(agent(), {}, null)
      expect(await run.restart('a1')).toEqual({ ok: false, error: 'RESTART_FAILED', detail: 'agent vanished from the registry mid-restart' })
      expect(run.deps.announceSession).not.toHaveBeenCalled()
      expect(run.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)
    })
  })
})

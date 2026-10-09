import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyOpencodeSessionModel, parseOpencodeModelId } from '../../engines/launchControl.js'
import { isOpencodeV2 } from '../../engines/launchControl.js'
import { binaryOnPath } from '../../lib/binaryOnPath.js'
import { validateLaunchOverrides } from '../../lib/launchOverrides.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { bypassPermissionFor, restartAgent } from '../../lib/restartAgent.js'
import { parseRuntimeProfile } from '../../lib/runtimeProfileWire.js'
import { inspectRuntimePane } from '../../lib/runtimeProfileController.js'
import { clearPaneRemainOnExit } from '../../lib/tmux.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import { createAgentRetargeter, type RetargetDeps } from './retarget.js'

vi.mock('../../engines/launchControl.js', async (real) => ({
  ...await real<object>(),
  isOpencodeV2: vi.fn(() => false), opencodeMajorVersion: vi.fn(() => 1),
  applyOpencodeSessionModel: vi.fn(async () => ({ ok: true })),
  parseOpencodeModelId: vi.fn((id: string) => ({ providerID: id.split('/')[0], modelID: id.split('/')[1] })),
}))
// Optional readers cannot gate a native launch decision.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})
vi.mock('../../lib/binaryOnPath.js', () => ({ binaryOnPath: vi.fn(() => true) }))
vi.mock('../../lib/gatewayRuntime.js', async (real) => ({ ...await real<object>(), probeGatewayRuntime: vi.fn(async () => ({ kind: 'none' })) }))
vi.mock('../../lib/gridLaunchWire.js', async (real) => ({ ...await real<object>(), describeGridLaunch: vi.fn(() => 'claude on Home'), gridEnvVarNames: vi.fn(() => ['ANTHROPIC_BASE_URL']) }))
vi.mock('../../lib/launchOverrides.js', async (real) => ({ ...await real<object>(), validateLaunchOverrides: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../lib/restartAgent.js', async (real) => ({
  ...await real<object>(),
  bypassPermissionFor: vi.fn(async (_s: unknown, live: () => Promise<boolean>) => live()),
  restartAgent: vi.fn(async () => ({ ok: true, resumed: true, processIdentity: { pid: 2, startMarker: 'new', executable: '/bin/claude' } })),
}))
vi.mock('../../lib/runtimeProfileWire.js', async (real) => ({ ...await real<object>(), parseRuntimeProfile: vi.fn(() => ({ engine: 'claude', model: 'opus' })) }))
vi.mock('../../lib/runtimeProfileController.js', async (real) => ({ ...await real<object>(), inspectRuntimePane: vi.fn(() => ({ idle: true })) }))
vi.mock('../../lib/tmux.js', async (real) => ({
  ...await real<object>(), clearPaneRemainOnExit: vi.fn(async () => {}),
  processArgs: vi.fn(async () => 'codex -c model_providers.grid.base_url=http://grid.local/v1'),
}))
vi.mock('../../lib/workspaceCheck.js', () => ({ workspaceMissing: vi.fn(() => null) }))

const pane = { backend: 'tmux', paneId: '%4' }
const grid = { networkId: 'g1', networkName: 'Home', baseUrl: 'http://g', model: 'big', apiKey: 'k' }
const agent = (over: Partial<RegisteredSession> = {}): RegisteredSession => ({
  agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: '/work', runtimes: [pane], processIdentity: { pid: 1, startMarker: 'old' }, ...over,
}) as unknown as RegisteredSession

function setup(row: RegisteredSession | null = agent(), over: Partial<RetargetDeps> = {}) {
  const release = vi.fn()
  const deps: RetargetDeps = {
    readScreen: async (session, capture) => ({ pane: inspectRuntimePane(session.engine, capture ?? ''), question: null, messageHold: null, teamHold: null, activity: null, busy: false, stoppedGoal: false }),
    purgeBusy: vi.fn(() => false),
    tmuxBackend: { clearEnv: vi.fn(async () => ({ state: 'succeeded' })) } as unknown as RetargetDeps['tmuxBackend'],
    registry: {
      resolve: vi.fn(() => row ?? undefined),
      byAgent: vi.fn(() => row ?? undefined),
      updateProcessIdentity: vi.fn(),
      setGridLaunch: vi.fn(),
      setSubscriptionModel: vi.fn(),
      setActive: vi.fn(),
    } as unknown as RetargetDeps['registry'],
    runtimeProfiles: { selectedModel: vi.fn(() => 'runtime-v1:claude:opus') } as never,
    launchOverridesDeps: {} as never,
    captureTerminal: vi.fn(async () => 'idle pane'),
    acquireTerminalControl: vi.fn(() => release),
    relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: { gridLaunchRecord: { override: grid, webSearch: 'off' } } })) as never,
    downgradedPermission: vi.fn(async (_s, bypass: boolean) => ({ bypassPermission: bypass, permissionMode: null })) as never,
    agentReconciler: { holdRoute: vi.fn(), releaseRoute: vi.fn() },
    restartJobs: { busy: vi.fn(() => false), cancel: vi.fn() } as never,
    paneSwapDeps: vi.fn(() => ({})) as never,
    liveBypassPermission: vi.fn(async () => true),
    announceSession: vi.fn(),
    refreshGridAssignment: vi.fn(),
    opencodeDb: '/db/opencode.db',
    ...over,
  }
  return { deps, release, retarget: createAgentRetargeter(deps) }
}

describe('retargeting an agent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('keeps an admitted external conversation when its retarget resume fails', async () => {
    const actual = await vi.importActual<typeof import('../../lib/restartAgent.js')>('../../lib/restartAgent.js')
    vi.mocked(restartAgent).mockImplementationOnce(actual.restartAgent)
    const respawn = vi.fn(async () => ({ ok: true }))
    const keepAbandoned = vi.fn(), buildArgv = vi.fn(options => ['fixture-engine', options.resumeSessionId ?? 'fresh'])
    const run = setup(agent({ resumeOnly: true }), { paneSwapDeps: () => ({
      holdOpen: async () => ({ ok: true }), terminate: async () => 'gone', respawn,
      waitForProcess: async () => null, buildArgv, keepAbandoned, log: () => {},
    }) })
    expect(await run.retarget({ agentId: 'a1', grid })).toMatchObject({ ok: false, error: 'RESPAWN_FAILED' })
    expect(respawn).toHaveBeenCalledExactlyOnceWith(['fixture-engine', 's1'])
    expect(keepAbandoned).not.toHaveBeenCalled()
    expect(run.deps.registry.updateProcessIdentity).not.toHaveBeenCalled()
  })

  describe('refusals before anything is touched', () => {
    it('invalidates an older restore as soon as retarget takes control', async () => {
      const { deps, retarget, release } = setup()
      await retarget({ agentId: 'a1', grid })
      expect(deps.restartJobs.cancel).toHaveBeenCalledExactlyOnceWith('a1')
      expect(vi.mocked(deps.restartJobs.cancel).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.relaunchOverrides).mock.invocationCallOrder[0])
      expect(release).toHaveBeenCalledOnce()
    })
    it('rechecks a pane operation that began while the screen was being read', async () => {
      const purgeBusy = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
      const { retarget, deps } = setup(agent(), { purgeBusy })
      expect(await retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(deps.acquireTerminalControl).not.toHaveBeenCalled()
      expect(deps.relaunchOverrides).not.toHaveBeenCalled()
    })
    it('for an agent being purged, no tmux, no agent, no tmux pane or no process to validate', async () => {
      expect(await setup(agent(), { purgeBusy: () => true }).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(await setup(agent(), { tmuxBackend: null }).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
      expect(await setup(null).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_NOT_FOUND' })
      expect(await setup(agent({ runtimes: [] } as Partial<RegisteredSession>)).retarget({ agentId: 'a1', grid })).toMatchObject({ error: 'RETARGET_UNSUPPORTED_BACKEND' })
      expect(await setup(agent({ processIdentity: undefined } as Partial<RegisteredSession>)).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'NO_ACTIVE_PROCESS' })
    })

    it('for a launch this machine cannot do, an OpenCode store it cannot rewrite, or a folder that is gone', async () => {
      vi.mocked(validateLaunchOverrides).mockResolvedValueOnce({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no' } as never)
      expect(await setup().retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no' })
      vi.mocked(binaryOnPath).mockReturnValueOnce(false)
      expect(await setup(agent({ engine: 'opencode' } as Partial<RegisteredSession>)).retarget({ agentId: 'a1', grid })).toMatchObject({ error: 'OPENCODE_SQLITE_MISSING' })
      vi.mocked(workspaceMissing).mockReturnValueOnce({ ok: false, error: 'CWD_NOT_FOUND', detail: 'gone' } as never)
      expect(await setup().retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'CWD_NOT_FOUND', detail: 'gone' })
    })

    it('for a pane it cannot read, a turn in progress, a swap already running, or control it cannot take', async () => {
      expect(await setup(agent(), { captureTerminal: vi.fn(async () => null) }).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'TMUX_FAILED' })
      vi.mocked(inspectRuntimePane).mockReturnValueOnce({ idle: false } as never)
      expect(await setup().retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(await setup(agent(), { restartJobs: { busy: () => true } as never }).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(await setup(agent(), { acquireTerminalControl: () => null }).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_BUSY' })
    })

    it('for overrides it cannot build, giving control back', async () => {
      const run = setup(agent(), { relaunchOverrides: vi.fn(async () => ({ ok: false, error: 'API_UNAVAILABLE', detail: 'removed' })) as never })
      expect(await run.retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'API_UNAVAILABLE', detail: 'removed' })
      expect(run.release).toHaveBeenCalled()
      expect(run.deps.agentReconciler.holdRoute).not.toHaveBeenCalled()
    })
  })

  describe('a move that goes ahead', () => {
    it('onto a grid: the pane respawned, the new process adopted, the launch and the model it left kept', async () => {
      const log = vi.mocked(console.log)
      const run = setup()
      expect(await run.retarget({ agentId: 'a1', grid })).toEqual({ ok: true })
      expect(run.deps.agentReconciler.holdRoute).toHaveBeenCalled()
      expect(restartAgent).toHaveBeenCalledWith({ engine: 'claude', sessionId: 's1' }, true, {})
      // The grid is read off the new process's command line, never its executable alone.
      expect(run.deps.registry.updateProcessIdentity).toHaveBeenCalledWith('a1', expect.objectContaining({ pid: 2 }), 'none')
      expect(run.deps.registry.setGridLaunch).toHaveBeenCalledWith('a1', { override: grid, webSearch: 'off' })
      expect(run.deps.registry.setSubscriptionModel).toHaveBeenCalledWith('a1', 'opus')
      expect(run.deps.registry.setActive).toHaveBeenCalledWith('a1', true)
      expect(run.deps.refreshGridAssignment).toHaveBeenCalledWith(agent())
      expect(clearPaneRemainOnExit).toHaveBeenCalledWith('%4')
      expect(run.deps.announceSession).toHaveBeenCalled()
      expect(run.release).toHaveBeenCalled()
      expect(run.deps.agentReconciler.releaseRoute).toHaveBeenCalled()
      expect(log.mock.calls.map(([line]) => String(line))).toContain('claude on Home · retargeted a1 · resumed')
    })

    it('remembers only the model of the agent\'s own login, never a grid\'s, never the one it moves to', async () => {
      const validated = () => vi.mocked(validateLaunchOverrides).mock.lastCall?.[2]
      // Grid to grid: the memory stays as it was.
      const fromGrid = setup(agent({ grid: { baseUrl: 'x' }, subscriptionModel: 'sonnet' } as Partial<RegisteredSession>))
      await fromGrid.retarget({ agentId: 'a1', grid })
      expect(fromGrid.deps.registry.setSubscriptionModel).toHaveBeenCalledWith('a1', 'sonnet')
      // The engine still reports the grid's model: that is not the one to remember.
      vi.mocked(parseRuntimeProfile).mockReturnValueOnce({ engine: 'claude', model: 'big' } as never)
      const reporting = setup(agent())
      await reporting.retarget({ agentId: 'a1', grid })
      expect(reporting.deps.registry.setSubscriptionModel).not.toHaveBeenCalled()
      // Another engine's model, or none observed: nothing to remember.
      vi.mocked(parseRuntimeProfile).mockReturnValueOnce({ engine: 'opencode', model: 'big-pickle' } as never).mockReturnValueOnce(null as never)
      await setup().retarget({ agentId: 'a1', grid })
      await setup().retarget({ agentId: 'a1', grid })
      expect(validated()).toEqual({ gridLaunch: grid, codexHome: undefined })
    })

    it('back home: the grid\'s variables cleared from the pane, on the remembered model, said plainly', async () => {
      const log = vi.mocked(console.log)
      const run = setup(agent({ grid: { baseUrl: 'x' }, subscriptionModel: 'opus' } as Partial<RegisteredSession>), {
        relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: {} })) as never,
      })
      vi.mocked(restartAgent).mockResolvedValueOnce({ ok: true, resumed: false, processIdentity: { pid: 2, startMarker: 'n' } } as never)
      expect(await run.retarget({ agentId: 'a1', grid: null })).toEqual({ ok: true })
      expect(vi.mocked(validateLaunchOverrides).mock.lastCall?.[2]).toEqual({ gridLaunch: null, codexHome: undefined, subscriptionModel: 'opus' })
      expect(run.deps.tmuxBackend!.clearEnv).toHaveBeenCalledWith(pane, ['ANTHROPIC_BASE_URL'])
      expect(run.deps.registry.setGridLaunch).toHaveBeenCalledWith('a1', null)
      expect(run.deps.registry.setSubscriptionModel).not.toHaveBeenCalled()
      expect(log.mock.calls.map(([line]) => String(line))).toContain('claude on its own login · retargeted a1 · fresh session')
      const none = setup(agent(), { relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: {} })) as never })
      await none.retarget({ agentId: 'a1', grid: null })
      expect(vi.mocked(validateLaunchOverrides).mock.lastCall?.[2]).toMatchObject({ subscriptionModel: null })
    })

    it('fails cleanly when the pane will not be cleared, or the respawn does not come up', async () => {
      const home = { relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: {} })) as never }
      const run = setup(agent(), home)
      vi.mocked(run.deps.tmuxBackend!.clearEnv).mockResolvedValueOnce({ state: 'failed', reason: 'no session' } as never).mockResolvedValueOnce({ state: 'unknown' } as never)
      expect(await run.retarget({ agentId: 'a1', grid: null })).toEqual({ ok: false, error: 'GRID_CLEAR_FAILED', detail: 'no session' })
      expect(await run.retarget({ agentId: 'a1', grid: null })).toEqual({ ok: false, error: 'GRID_CLEAR_FAILED', detail: 'tmux would not clear the pane environment' })
      vi.mocked(restartAgent).mockResolvedValueOnce({ ok: false, detail: 'no process' } as never)
      expect(await run.retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'RESPAWN_FAILED', detail: 'no process' })
      expect(run.release).toHaveBeenCalledTimes(3)
      expect(run.deps.agentReconciler.releaseRoute).toHaveBeenCalledTimes(3)
    })

    it('rewrites a resumed OpenCode session\'s model before the respawn, and refuses if it cannot', async () => {
      const opencode = agent({ engine: 'opencode' } as Partial<RegisteredSession>)
      const withModel = { relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: { sessionModel: 'grid/big', gridLaunchRecord: null } })) as never }
      const run = setup(opencode, withModel)
      await run.retarget({ agentId: 'a1', grid })
      expect(applyOpencodeSessionModel).toHaveBeenCalledWith({ opencodeMajor: 1, dbPath: '/db/opencode.db', sessionId: 's1', model: { providerID: 'grid', modelID: 'big' }, cwd: '/work', checkCatalog: false })
      vi.mocked(applyOpencodeSessionModel).mockResolvedValueOnce({ ok: false, code: 'SESSION_NOT_FOUND', detail: 'no rows' } as never)
      expect(await setup(agent({ engine: 'opencode', cwd: undefined } as Partial<RegisteredSession>), withModel).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'SESSION_NOT_FOUND', detail: 'no rows' })
      // v2 needs no sqlite3; a model the overrides do not name, or one that does not parse, writes nothing.
      vi.mocked(isOpencodeV2).mockReturnValueOnce(true)
      vi.mocked(binaryOnPath).mockReturnValue(false)
      expect(await setup(opencode, { relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: {} })) as never }).retarget({ agentId: 'a1', grid })).toEqual({ ok: true })
      vi.mocked(binaryOnPath).mockReturnValue(true)
      vi.mocked(parseOpencodeModelId).mockReturnValueOnce(null as never)
      await setup(opencode, withModel).retarget({ agentId: 'a1', grid })
      expect(applyOpencodeSessionModel).toHaveBeenCalledTimes(2)
      // Home to a remembered model with its provider: checked against OpenCode's catalogue.
      await setup(agent({ engine: 'opencode', subscriptionModel: 'anthropic/claude' } as Partial<RegisteredSession>), withModel).retarget({ agentId: 'a1', grid: null })
      expect(vi.mocked(applyOpencodeSessionModel).mock.lastCall?.[0]).toMatchObject({ checkCatalog: true })
      // A remembered model without a provider, or an OpenCode agent with no session: no rewrite at all.
      vi.mocked(binaryOnPath).mockReturnValue(false)
      expect(await setup(agent({ engine: 'opencode', subscriptionModel: 'claude' } as Partial<RegisteredSession>), withModel).retarget({ agentId: 'a1', grid: null })).toEqual({ ok: true })
      expect(await setup(agent({ engine: 'opencode', sessionId: '' } as Partial<RegisteredSession>), withModel).retarget({ agentId: 'a1', grid })).toEqual({ ok: true })
      vi.mocked(binaryOnPath).mockReturnValue(true)
    })

    it.each(['missing', 'stalled'])('moves OpenCode while its optional reader is %s', async mode => {
      const { loadEngine } = await import('../../engines/inProcess.js')
      vi.mocked(loadEngine).mockImplementation(() => mode === 'stalled' ? new Promise(() => {}) : Promise.resolve(null))
      const run = setup(agent({ engine: 'opencode' } as Partial<RegisteredSession>), {
        relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: { sessionModel: 'grid/big', gridLaunchRecord: null } })) as never,
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([run.retarget({ agentId: 'a1', grid }),
          new Promise(resolve => { timer = setTimeout(() => resolve('blocked on optional code'), 1000) })])
        expect(result).toEqual({ ok: true })
        expect(restartAgent).toHaveBeenCalledOnce()
        expect(applyOpencodeSessionModel).toHaveBeenCalledOnce()
        expect(loadEngine).not.toHaveBeenCalled()
      } finally { clearTimeout(timer) }
    })

    it('reads the live bypass flag only when the row recorded none, and announces nothing for a row gone meanwhile', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byAgent).mockReturnValue(undefined)
      await run.retarget({ agentId: 'a1', grid })
      expect(bypassPermissionFor).toHaveBeenCalled()
      expect(run.deps.liveBypassPermission).toHaveBeenCalled()
      expect(run.deps.announceSession).not.toHaveBeenCalled()
    })
  })
})

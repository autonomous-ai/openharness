import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyOpencodeSessionModel, parseOpencodeModelId, opencodeMajorVersion, opencodeV2TurnOpen } from '../../engines/launchControl.js'
import { isOpencodeV2 } from '../../engines/launchControl.js'
import { binaryOnPath } from '../../lib/binaryOnPath.js'
import { builtinSqlite } from '../../lib/sqliteBuiltin.js'
import { validateLaunchOverrides } from '../../lib/launchOverrides.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { AgentRestartCoordinator, bypassPermissionFor, restartAgent } from '../../lib/restartAgent.js'
import { probeGatewayRuntime } from '../../lib/gatewayRuntime.js'
import { parseRuntimeProfile } from '../../lib/runtimeProfileWire.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import { TerminalAgentReconciler } from '../../lib/terminalAgentReconciler.js'
import type { TerminalBackend } from '../../lib/terminalBackend.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { createAgentRetargeter, type RetargetDeps } from './retarget.js'
import type { NativeLaunch } from '../../engines/nativeLaunch.js'
import { GUEST_HARNESS_REFUSAL } from '../guestPolicy.js'
import { createSwarmSkillAdoption } from '../../superTabs/inCore/adoption.js'
import { createLaunchAuthority } from './launchAuthority.js'
import type { SwarmSkillGrant } from '../../lib/swarmSkills.js'

vi.mock('../../engines/launchControl.js', async (real) => ({
  ...await real<object>(),
  isOpencodeV2: vi.fn(() => false), opencodeMajorVersion: vi.fn(() => 1),
  applyOpencodeSessionModel: vi.fn(async () => ({ ok: true })),
  opencodeV2TurnOpen: vi.fn(async () => false),
  parseOpencodeModelId: vi.fn((id: string) => ({ providerID: id.split('/')[0], modelID: id.split('/')[1] })),
}))
// Optional readers cannot gate a native launch decision.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})
vi.mock('../../lib/binaryOnPath.js', () => ({ binaryOnPath: vi.fn(() => true) }))
vi.mock('../../lib/sqliteBuiltin.js', async (real) => ({ ...await real<object>(), builtinSqlite: vi.fn(() => null) }))
vi.mock('../../lib/gatewayRuntime.js', async (real) => ({ ...await real<object>(), probeGatewayRuntime: vi.fn(async () => ({ kind: 'none' })) }))
vi.mock('../../lib/gridLaunchWire.js', async (real) => ({ ...await real<object>(), describeGridLaunch: vi.fn(() => 'claude on Home'), gridEnvVarNames: vi.fn(() => ['ANTHROPIC_BASE_URL']) }))
vi.mock('../../lib/launchOverrides.js', async (real) => ({ ...await real<object>(), validateLaunchOverrides: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../lib/restartAgent.js', async (real) => ({
  ...await real<object>(),
  bypassPermissionFor: vi.fn(async (_s: unknown, live: () => Promise<boolean>) => live()),
  restartAgent: vi.fn(async () => ({ ok: true, resumed: true, processIdentity: { pid: 2, startMarker: 'new', executable: '/bin/claude' } })),
}))
vi.mock('../../lib/runtimeProfileWire.js', async (real) => ({ ...await real<object>(), parseRuntimeProfile: vi.fn(() => ({ engine: 'claude', model: 'opus' })) }))
vi.mock('../../lib/processTable.js', async (real) => ({
  ...await real<object>(),
  processLaunchArgs: vi.fn(async () => 'codex -c model_providers.grid.base_url=http://grid.local/v1'),
}))
vi.mock('../../lib/workspaceCheck.js', () => ({ workspaceMissing: vi.fn(() => null) }))

const pane = { backend: 'tmux' as const, paneId: '%4' }
const grid = { networkId: 'g1', networkName: 'Home', baseUrl: 'http://g', model: 'big', apiKey: 'k' }
const agent = (over: Partial<RegisteredSession> = {}): RegisteredSession => ({
  agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: '/work', runtimes: [pane], processIdentity: { pid: 1, startMarker: 'old' }, ...over,
}) as unknown as RegisteredSession

function setup(row: RegisteredSession | null = agent(), over: Partial<RetargetDeps> = {}) {
  const release = vi.fn(), releaseRoute = vi.fn()
  const tmux = { name: 'tmux', holdOpen: vi.fn(), respawn: vi.fn(),
    clearEnv: vi.fn<NonNullable<TerminalBackend['clearEnv']>>(async () => ({ state: 'succeeded', dispatch: 'executed' })),
    releaseHold: vi.fn<TerminalBackend['releaseHold']>(async () => {}) }
  const deps: RetargetDeps = {
    sessionTurnOpen: vi.fn(() => false),
    purgeBusy: vi.fn(() => false),
    terminals: { backendFor: vi.fn((runtime: { backend: string }) => runtime.backend === 'tmux' ? tmux : undefined), instances: () => [tmux] } as unknown as RetargetDeps['terminals'],
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
    acquireTerminalControl: vi.fn(() => release),
    relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: { gridLaunchRecord: { override: grid, webSearch: 'off' } } })) as never,
    downgradedPermission: vi.fn(async (_s, bypass: boolean) => ({ bypassPermission: bypass, permissionMode: null })) as never,
    agentReconciler: { holdRoute: vi.fn(() => releaseRoute) },
    restartJobs: { busy: vi.fn(() => false), cancel: vi.fn(), revision: () => 0 } as never,
    paneSwapDeps: vi.fn(() => ({})) as never,
    liveBypassPermission: vi.fn(async () => true),
    announceSession: vi.fn(),
    refreshGridAssignment: vi.fn(),
    opencodeDb: '/db/opencode.db',
    ...over,
  }
  return { deps, tmux, release, releaseRoute, retarget: createAgentRetargeter(deps) }
}

describe('retargeting an agent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('holds an unavailable native retarget before inspecting or mutating the pane', async () => {
    const held = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Waiting for native evidence.' } as const
    const run = setup(agent(), { launchOverridesDeps: { native: async () => held } as never })
    expect(await run.retarget({ agentId: 'a1', grid })).toEqual(held)
    expect(run.deps.sessionTurnOpen).not.toHaveBeenCalled()
    expect(restartAgent).not.toHaveBeenCalled()
  })

  it.each(['ready', 'permission', 'snapshot'] as const)('keeps retarget native write and dispatch on one snapshot: %s', async mode => {
    let nativeCurrent = true
    const launch = { current: () => nativeCurrent, executable: '/fixture/native/opencode', environment: { HOME: '/fixture/home' }, opencodeMajor: 2 } as unknown as NativeLaunch
    const run = setup(agent({ engine: 'opencode' }), {
      launchOverridesDeps: { native: async () => ({ ok: true, launch }) } as never,
      relaunchOverrides: async () => ({ ok: true, overrides: { native: launch, env: { HOME: '/fixture/home' }, extraArgs: [], clearEnv: [], sessionModel: 'fixture/model' } }),
      downgradedPermission: async () => {
        if (mode === 'snapshot') nativeCurrent = false
        return { bypassPermission: false, ...(mode === 'permission' ? { nativeHold: 'Waiting for native permission flags.' } : {}) }
      },
    })
    vi.mocked(applyOpencodeSessionModel).mockImplementationOnce(async (_input, options) => {
      expect(_input.dbPath).toBe('/fixture/home/.local/share/opencode/opencode.db')
      expect(options?.current?.()).toBe(true)
      expect(options).toMatchObject({ executable: launch.executable, environment: { HOME: '/fixture/home' } })
      return { ok: true }
    })
    const result = await run.retarget({ agentId: 'a1', grid })
    expect(opencodeMajorVersion).not.toHaveBeenCalled()
    if (mode === 'ready') {
      expect(result).toEqual({ ok: true })
      expect(restartAgent).toHaveBeenCalledOnce()
    } else {
      expect(result).toMatchObject({ ok: false, error: 'NATIVE_LAUNCH_HELD' })
      expect(restartAgent).not.toHaveBeenCalled()
    }
    const current = vi.mocked(applyOpencodeSessionModel).mock.calls[0]![1]!.current!
    nativeCurrent = false
    expect(current()).toBe(false)
    nativeCurrent = true
    vi.mocked(run.deps.registry.byAgent).mockReturnValue(undefined)
    expect(current()).toBe(false)
  })

  it.each(['prepared', 'clearing', 'hold-open'] as const)('keeps the live process when native proof changes during %s', async phase => {
    const actual = await vi.importActual<typeof import('../../lib/restartAgent.js')>('../../lib/restartAgent.js')
    vi.mocked(restartAgent).mockImplementationOnce(actual.restartAgent)
    let valid = true
    const native = { current: () => valid } as NativeLaunch
    const terminate = vi.fn(async () => 'gone' as const), respawn = vi.fn(async () => ({ ok: true }))
    const run = setup(agent(), { launchOverridesDeps: { native: async () => ({ ok: true, launch: native }) } as never,
      relaunchOverrides: async () => {
        if (phase === 'prepared') valid = false
        return { ok: true, overrides: { native, env: {}, extraArgs: [], clearEnv: [] } }
      },
      paneSwapDeps: () => ({ holdOpen: async () => { valid = false; return { ok: true } }, terminate, respawn,
        waitForProcess: async () => null, buildArgv: () => ['fixture-engine'], log: () => {} }),
    })
    if (phase === 'clearing') vi.mocked(run.tmux.clearEnv).mockImplementationOnce(async (_pane, _vars, current) => {
      valid = false
      expect(current?.()).toBe(false)
      return { state: 'succeeded', dispatch: 'executed' }
    })
    expect(await run.retarget({ agentId: 'a1', grid: null })).toMatchObject({ ok: false })
    expect(terminate).not.toHaveBeenCalled()
    expect(respawn).not.toHaveBeenCalled()
    vi.mocked(restartAgent).mockReset().mockResolvedValue({ ok: true, resumed: true, processIdentity: { pid: 2, startMarker: 'new', executable: '/bin/claude' } })
  })

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
    it('cannot follow a mutable row to a replacement conversation while validation waits', async () => {
      const row = agent()
      let finish!: () => void
      vi.mocked(validateLaunchOverrides).mockImplementationOnce(() => new Promise(done => { finish = () => done({ ok: true } as never) }))
      const run = setup(row)
      const pending = run.retarget({ agentId: 'a1', grid })
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      row.sessionId = 'replacement'
      row.processIdentity = { pid: 77, startMarker: 'replacement', executable: 'claude' }
      finish()
      expect(await pending).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
      expect(run.deps.sessionTurnOpen).not.toHaveBeenCalled()
      expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
      expect(restartAgent).not.toHaveBeenCalled()
    })
    it.each(['validation', 'version', 'preparation', 'native-write', 'environment', 'bypass', 'permission', 'replacement', 'gateway', 'pane-option'] as const)(
      'cannot publish or continue a retarget whose owner changes during %s', async phase => {
        const row = agent({ engine: 'opencode', subscriptionModel: 'fixture/model' })
        const run = setup(row, { relaunchOverrides: vi.fn(async () => ({ ok: true as const,
          overrides: { sessionModel: 'fixture/model', env: {}, extraArgs: [], clearEnv: [] } })) })
        const replace = () => { row.sessionId = 'replacement' }
        switch (phase) {
          case 'validation': vi.mocked(validateLaunchOverrides).mockImplementationOnce(async () => { replace(); return { ok: true } }); break
          case 'version': vi.mocked(opencodeMajorVersion).mockImplementationOnce(async () => { replace(); return 2 }); break
          case 'preparation': vi.mocked(run.deps.relaunchOverrides).mockImplementationOnce(async () => { replace(); return { ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [] } } }); break
          case 'native-write': vi.mocked(applyOpencodeSessionModel).mockImplementationOnce(async () => { replace(); return { ok: true } }); break
          case 'environment': vi.mocked(run.tmux.clearEnv).mockImplementationOnce(async () => { replace(); return { state: 'succeeded', dispatch: 'executed' } }); break
          case 'bypass': vi.mocked(bypassPermissionFor).mockImplementationOnce(async () => { replace(); return true }); break
          case 'permission': vi.mocked(run.deps.downgradedPermission).mockImplementationOnce(async () => { replace(); return {} }); break
          case 'replacement': vi.mocked(restartAgent).mockImplementationOnce(async () => { replace(); return { ok: true, resumed: true, processIdentity: { pid: 2, executable: 'opencode', startMarker: 'new' } } }); break
          case 'gateway': vi.mocked(probeGatewayRuntime).mockImplementationOnce(async () => { replace(); return { kind: 'none' } as never }); break
          case 'pane-option': vi.mocked(run.tmux.releaseHold).mockImplementationOnce(async () => { replace() }); break
        }
        const result = await createAgentRetargeter(run.deps)({ agentId: 'a1', grid: phase === 'environment' ? null : grid })
        expect(result).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
        expect(run.deps.registry.updateProcessIdentity).not.toHaveBeenCalled()
        expect(run.deps.registry.setGridLaunch).not.toHaveBeenCalled()
        expect(run.deps.announceSession).not.toHaveBeenCalled()
      })

    it('honors Stop cancellation while service preparation waits, even if the row is unchanged', async () => {
      const restartJobs = new AgentRestartCoordinator()
      const run = setup(agent(), { restartJobs })
      vi.mocked(run.deps.relaunchOverrides).mockImplementationOnce(async () => {
        restartJobs.cancel('a1')
        return { ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [] } }
      })
      expect(await run.retarget({ agentId: 'a1', grid })).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
      expect(restartAgent).not.toHaveBeenCalled()
      expect(run.release).toHaveBeenCalledOnce()
    })

    it('releases terminal control if preparation throws', async () => {
      const run = setup(agent(), { relaunchOverrides: vi.fn(async () => { throw Error('preparation failed') }) })
      await expect(run.retarget({ agentId: 'a1', grid })).rejects.toThrow('preparation failed')
      expect(run.release).toHaveBeenCalledOnce()
      expect(run.releaseRoute).not.toHaveBeenCalled()
    })
    it('invalidates an older restore as soon as retarget takes control', async () => {
      const { deps, retarget, release } = setup()
      await retarget({ agentId: 'a1', grid })
      expect(deps.restartJobs.cancel).toHaveBeenCalledExactlyOnceWith('a1')
      expect(vi.mocked(deps.restartJobs.cancel).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.relaunchOverrides).mock.invocationCallOrder[0])
      expect(release).toHaveBeenCalledOnce()
    })
    it('rechecks a pane operation that began while the move was being checked', async () => {
      const purgeBusy = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
      const { retarget, deps } = setup(agent(), { purgeBusy })
      expect(await retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(deps.acquireTerminalControl).not.toHaveBeenCalled()
      expect(deps.relaunchOverrides).not.toHaveBeenCalled()
    })
    it('for an agent being purged, no tmux, no agent, no tmux pane or no process to validate', async () => {
      expect(await setup(agent(), { purgeBusy: () => true }).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(await setup(agent(), { terminals: { backendFor: () => undefined, instances: () => [] } }).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
      // A backend with no restart primitives is none to retarget on, whatever its name.
      expect(await setup(agent(), { terminals: { backendFor: () => undefined, instances: () => [{ name: 'tmux' } as never] } }).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
      // A pty host machine's own code (Windows).
      expect(await setup(agent(), { noBackendCode: 'PTY_HOST_UNAVAILABLE', terminals: { backendFor: () => undefined, instances: () => [] } }).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'PTY_HOST_UNAVAILABLE' })
      expect(await setup(null).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_NOT_FOUND' })
      // A guest's harness: re-exec'd here it would run as the owner, on the owner's keys.
      expect(await setup(agent({ guest: 'kim@acme.io' })).retarget({ agentId: 'a1', grid })).toEqual(GUEST_HARNESS_REFUSAL)
      expect(await setup(agent({ runtimes: [] } as Partial<RegisteredSession>)).retarget({ agentId: 'a1', grid })).toMatchObject({ error: 'RETARGET_UNSUPPORTED_BACKEND' })
      expect(await setup(agent({ processIdentity: undefined } as Partial<RegisteredSession>)).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'NO_ACTIVE_PROCESS' })
    })

    it('for a launch this machine cannot do, an OpenCode store it cannot rewrite, or a folder that is gone', async () => {
      vi.mocked(validateLaunchOverrides).mockResolvedValueOnce({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no' } as never)
      expect(await setup().retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no' })
      vi.mocked(binaryOnPath).mockReturnValueOnce(false)
      expect(await setup(agent({ engine: 'opencode' } as Partial<RegisteredSession>)).retarget({ agentId: 'a1', grid })).toMatchObject({ error: 'OPENCODE_SQLITE_MISSING' })
      // Windows has no sqlite3 CLI, but node:sqlite rewrites the store just as well.
      vi.mocked(binaryOnPath).mockReturnValueOnce(false)
      vi.mocked(builtinSqlite).mockReturnValueOnce((class {}) as never)
      expect(await setup(agent({ engine: 'opencode' } as Partial<RegisteredSession>)).retarget({ agentId: 'a1', grid })).not.toMatchObject({ error: 'OPENCODE_SQLITE_MISSING' })
      vi.mocked(workspaceMissing).mockReturnValueOnce({ ok: false, error: 'CWD_NOT_FOUND', detail: 'gone' } as never)
      expect(await setup().retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'CWD_NOT_FOUND', detail: 'gone' })
    })

    it('for a turn in progress, said so, without reading the screen', async () => {
      const turn = setup(agent(), { sessionTurnOpen: vi.fn(() => true) })
      expect(await turn.retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_BUSY',
        detail: 'This harness is in a turn. Stop it, then switch the model.' })
      expect(turn.deps.sessionTurnOpen).toHaveBeenCalledWith('s1')
      expect(turn.deps.acquireTerminalControl).not.toHaveBeenCalled()
      expect(restartAgent).not.toHaveBeenCalled()
    })

    it('for an OpenCode 2 turn, read from its own store since the turn state does not see it', async () => {
      const oc2 = agent({ engine: 'opencode' } as Partial<RegisteredSession>)
      vi.mocked(isOpencodeV2).mockReturnValue(true)
      try {
        vi.mocked(opencodeV2TurnOpen).mockResolvedValueOnce(true)
        const busy = setup(oc2)
        expect(await busy.retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_BUSY',
          detail: 'This harness is in a turn. Stop it, then switch the model.' })
        expect(opencodeV2TurnOpen).toHaveBeenCalledWith('/db/opencode.db', 's1')
        expect(busy.deps.acquireTerminalControl).not.toHaveBeenCalled()
        // A native OpenCode's store is the one its own HOME holds.
        const launch = { current: () => true, executable: '/fixture/native/opencode', environment: { HOME: '/fixture/home' }, opencodeMajor: 2 } as unknown as NativeLaunch
        vi.mocked(opencodeV2TurnOpen).mockResolvedValueOnce(true)
        expect(await setup(oc2, { launchOverridesDeps: { native: async () => ({ ok: true, launch }) } as never }).retarget({ agentId: 'a1', grid }))
          .toMatchObject({ ok: false, error: 'AGENT_BUSY' })
        expect(opencodeV2TurnOpen).toHaveBeenLastCalledWith('/fixture/home/.local/share/opencode/opencode.db', 's1')
        // Between turns, or a store it cannot read: no turn known, so it moves.
        vi.mocked(opencodeV2TurnOpen).mockResolvedValueOnce(false).mockResolvedValueOnce(null)
        expect(await setup(oc2).retarget({ agentId: 'a1', grid })).toEqual({ ok: true })
        expect(await setup(oc2).retarget({ agentId: 'a1', grid })).toEqual({ ok: true })
        // A harness replaced while the store is read is not moved.
        const row = agent({ engine: 'opencode' } as Partial<RegisteredSession>)
        vi.mocked(opencodeV2TurnOpen).mockImplementationOnce(async () => { row.sessionId = 'replacement'; return false })
        expect(await setup(row).retarget({ agentId: 'a1', grid })).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
      } finally { vi.mocked(isOpencodeV2).mockReturnValue(false) }
      // OpenCode 1 is read by the turn state itself.
      vi.mocked(opencodeV2TurnOpen).mockClear()
      await setup(oc2).retarget({ agentId: 'a1', grid })
      expect(opencodeV2TurnOpen).not.toHaveBeenCalled()
    })

    it('moves an agent between turns whatever its prompt shows, and one with no conversation to ask about', async () => {
      // OpenCode 2's placeholder once read as a draft and refused every switch until the first chat.
      const idle = setup(agent({ engine: 'opencode' } as Partial<RegisteredSession>))
      expect(await idle.retarget({ agentId: 'a1', grid })).toEqual({ ok: true })
      expect(idle.deps.sessionTurnOpen).toHaveBeenCalledWith('s1')
      const fresh = setup(agent({ sessionId: undefined } as Partial<RegisteredSession>), { sessionTurnOpen: vi.fn(() => true) })
      expect(await fresh.retarget({ agentId: 'a1', grid })).toEqual({ ok: true })
      expect(fresh.deps.sessionTurnOpen).not.toHaveBeenCalled()
    })

    it('for a swap already running, or control it cannot take', async () => {
      expect(await setup(agent(), { restartJobs: { busy: () => true, revision: () => 0 } as never }).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(await setup(agent(), { acquireTerminalControl: () => null }).retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'AGENT_BUSY' })
    })

    it('for overrides it cannot build, giving control back', async () => {
      const run = setup(agent(), { relaunchOverrides: vi.fn(async () => ({ ok: false, error: 'API_UNAVAILABLE', detail: 'removed' })) as never })
      expect(await run.retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'API_UNAVAILABLE', detail: 'removed' })
      expect(run.release).toHaveBeenCalled()
      expect(run.deps.agentReconciler.holdRoute).not.toHaveBeenCalled()
    })
  })

  // Security review 1 of #2255: a model switch relaunched an old Buddy with no saved role without asking the Swarm, so it
  // came back without its guard.
  describe('an old Swarm session with no saved role', () => {
    const switchWith = (grant: SwarmSkillGrant | null | undefined) => {
      const row = agent({ startedBy: 'agent' })
      const adoptSwarmSkill = createSwarmSkillAdoption({ role: async () => grant, candidate: () => false,
        authority: createLaunchAuthority({ byAgent: () => row, revision: () => 0, cancelled: () => false }),
        save: (_id, skill) => { row.swarmSkill = skill; return true } })
      return { row, ...setup(row, { adoptSwarmSkill }) }
    }
    it('switches its model with its Buddy role, saved on its row', async () => {
      const run = switchWith({ role: 'buddy' })
      expect(await run.retarget({ agentId: 'a1', grid })).toMatchObject({ ok: true })
      expect(run.deps.relaunchOverrides).toHaveBeenCalledWith(expect.objectContaining({ swarmSkill: { role: 'buddy', key: 'a1' } }),
        expect.anything(), expect.any(Function), undefined)
      expect(run.row.swarmSkill).toEqual({ role: 'buddy', key: 'a1' })
      expect(restartAgent).toHaveBeenCalledOnce()
    })
    it('does not switch a session that changed while its role was read', async () => {
      const row = agent({ startedBy: 'agent' })
      const adoptSwarmSkill = createSwarmSkillAdoption({ candidate: () => false, save: vi.fn(),
        role: async () => { row.cwd = '/replacement'; return { role: 'buddy' as const } },
        authority: createLaunchAuthority({ byAgent: () => row, revision: () => 0, cancelled: () => false }) })
      const run = setup(row, { adoptSwarmSkill })
      expect(await run.retarget({ agentId: 'a1', grid })).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
      expect(restartAgent).not.toHaveBeenCalled()
    })
    it('switches the person\'s own session as before, with no role and no Swarm read', async () => {
      const role = vi.fn(async () => ({ role: 'buddy' as const }))
      const row = agent()
      const run = setup(row, { adoptSwarmSkill: createSwarmSkillAdoption({ role, candidate: () => false, save: vi.fn(),
        authority: createLaunchAuthority({ byAgent: () => row, revision: () => 0, cancelled: () => false }) }) })
      expect(await run.retarget({ agentId: 'a1', grid })).toMatchObject({ ok: true })
      expect(role).not.toHaveBeenCalled()
      expect(run.deps.relaunchOverrides).toHaveBeenCalledWith(expect.not.objectContaining({ swarmSkill: expect.anything() }),
        expect.anything(), expect.any(Function), undefined)
    })
    it('refuses the switch, saying why, and leaves the running engine alone while its role cannot be read', async () => {
      const run = switchWith(undefined)
      expect(await run.retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'SWARM_ROLE_UNAVAILABLE',
        detail: 'This agent\'s Swarm role could not be confirmed, so its model was not switched. Try again once the Swarm can be reached.' })
      expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
      expect(run.deps.acquireTerminalControl).not.toHaveBeenCalled()
      expect(restartAgent).not.toHaveBeenCalled()
    })
  })

  describe('a move that goes ahead', () => {
    it('keeps its route until a slow replacement is confirmed, even past the default hold timer', async () => {
      vi.useFakeTimers()
      const onDiscovered = vi.fn()
      const reconciler = new TerminalAgentReconciler({ current: () => [], backends: [], backendOrder: ['tmux'],
        onDiscovered, onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
        probe: async () => ({ processTableAvailable: true, ambiguousPlacements: new Set(),
          targets: [{ instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime: pane, rootPid: 1, cwd: '/work' }] } }],
          agents: [{ engine: 'claude', cwd: '/work', processIdentity: { pid: 4, executable: 'claude', startMarker: 'replacement' },
            args: 'claude', resumeSessionId: null, runtimes: [pane], primaryRuntimeKey: terminalRouteKey(pane) }],
        }),
      })
      let finish!: () => void
      vi.mocked(restartAgent).mockImplementationOnce(() => new Promise(done => { finish = () => done({ ok: false, detail: 'fixture complete' }) }))
      const run = setup(agent(), { agentReconciler: reconciler })
      const pending = run.retarget({ agentId: 'a1', grid })
      try {
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
        await vi.advanceTimersByTimeAsync(30_001)
        await reconciler.trigger()
        expect(onDiscovered).not.toHaveBeenCalled()
        finish()
        await pending
        await reconciler.trigger()
        expect(onDiscovered).toHaveBeenCalledOnce()
      } finally { finish?.(); await pending; vi.useRealTimers() }
    })

    it('cannot release a newer Stop route hold when an older retarget completes', async () => {
      const onDiscovered = vi.fn()
      const reconciler = new TerminalAgentReconciler({ current: () => [], backends: [], backendOrder: ['tmux'],
        onDiscovered, onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
        probe: async () => ({ processTableAvailable: true, ambiguousPlacements: new Set(),
          targets: [{ instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime: pane, rootPid: 1, cwd: '/work' }] } }],
          agents: [{ engine: 'claude', cwd: '/work', processIdentity: { pid: 4, executable: 'claude', startMarker: 'replacement' },
            args: 'claude', resumeSessionId: null, runtimes: [pane], primaryRuntimeKey: terminalRouteKey(pane) }],
        }),
      })
      const restartJobs = new AgentRestartCoordinator()
      const run = setup(agent(), { agentReconciler: reconciler, restartJobs })
      let releaseStop!: () => void
      vi.mocked(restartAgent).mockImplementationOnce(async () => {
        restartJobs.cancel('a1')
        releaseStop = reconciler.holdRoute(terminalRouteKey(pane))
        return { ok: false, detail: 'cancelled' }
      })
      try {
        expect(await run.retarget({ agentId: 'a1', grid })).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
        await reconciler.trigger()
        expect(onDiscovered).not.toHaveBeenCalled()
        releaseStop()
        await reconciler.trigger()
        expect(onDiscovered).toHaveBeenCalledOnce()
      } finally { releaseStop?.() }
    })

    it.each(['environment', 'permission', 'cancelled'] as const)('discloses an applied model change when later %s preparation fails', async phase => {
      const row = agent({ engine: 'opencode', subscriptionModel: 'fixture/model' })
      const run = setup(row, { relaunchOverrides: vi.fn(async () => ({ ok: true as const,
        overrides: { env: {}, extraArgs: [], clearEnv: [], sessionModel: 'fixture/model' } })) })
      if (phase === 'environment') vi.mocked(run.tmux.clearEnv).mockResolvedValueOnce({ state: 'failed', dispatch: 'rejected', reason: 'fixture failure' })
      if (phase === 'permission') vi.mocked(run.deps.downgradedPermission).mockRejectedValueOnce(Error('fixture failure'))
      if (phase === 'cancelled') vi.mocked(applyOpencodeSessionModel).mockImplementationOnce(async () => {
        row.sessionId = 'replacement'
        return { ok: true }
      })
      await expect(run.retarget({ agentId: 'a1', grid: null })).resolves.toMatchObject({ ok: false,
        detail: expect.stringContaining('native model change was applied') })
      expect(restartAgent).not.toHaveBeenCalled()
      expect(run.release).toHaveBeenCalledOnce()
    })

    it('retains uncertainty when Stop revokes a write whose reply was lost', async () => {
      const row = agent({ engine: 'opencode' })
      const run = setup(row, { relaunchOverrides: vi.fn(async () => ({ ok: true as const,
        overrides: { env: {}, extraArgs: [], clearEnv: [], sessionModel: 'fixture/model' } })) })
      vi.mocked(applyOpencodeSessionModel).mockImplementationOnce(async () => {
        row.sessionId = 'replacement'
        return { ok: false, code: 'AGENT_CHANGED', effect: 'uncertain', detail: 'reply lost' }
      })
      expect(await run.retarget({ agentId: 'a1', grid })).toMatchObject({ ok: false, error: 'AGENT_CHANGED',
        detail: expect.stringContaining('may already have applied') })
      expect(restartAgent).not.toHaveBeenCalled()
    })

    it('reports a replacement that started before a later non-Error exception', async () => {
      const run = setup()
      vi.mocked(probeGatewayRuntime).mockRejectedValueOnce('fixture probe unavailable')
      expect(await run.retarget({ agentId: 'a1', grid })).toMatchObject({ ok: false, error: 'RETARGET_FAILED',
        detail: 'The replacement process started, but retarget did not complete. fixture probe unavailable' })
      expect(run.deps.registry.updateProcessIdentity).not.toHaveBeenCalled()
    })

    it('does not announce a row removed by a publication observer', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.setActive).mockImplementationOnce(() => { vi.mocked(run.deps.registry.byAgent).mockReturnValue(undefined); return true })
      expect(await run.retarget({ agentId: 'a1', grid })).toEqual({ ok: true })
      expect(run.deps.announceSession).not.toHaveBeenCalled()
    })

    it('onto a grid: the pane respawned, the new process adopted, the launch and the model it left kept', async () => {
      const log = vi.mocked(console.log)
      const run = setup()
      expect(await run.retarget({ agentId: 'a1', grid })).toEqual({ ok: true })
      expect(run.deps.agentReconciler.holdRoute).toHaveBeenCalled()
      expect(restartAgent).toHaveBeenCalledWith({ engine: 'claude', sessionId: 's1' }, true, { isCurrent: expect.any(Function) })
      // The grid is read off the new process's command line, never its executable alone.
      expect(run.deps.registry.updateProcessIdentity).toHaveBeenCalledWith('a1', expect.objectContaining({ pid: 2 }), 'none')
      expect(run.deps.registry.setGridLaunch).toHaveBeenCalledWith('a1', { override: grid, webSearch: 'off' })
      expect(run.deps.registry.setSubscriptionModel).toHaveBeenCalledWith('a1', 'opus')
      expect(run.deps.registry.setActive).toHaveBeenCalledWith('a1', true)
      expect(run.deps.refreshGridAssignment).toHaveBeenCalledWith(agent())
      expect(run.tmux.releaseHold).toHaveBeenCalledWith(pane, expect.any(Function))
      expect(run.deps.announceSession).toHaveBeenCalled()
      expect(run.release).toHaveBeenCalled()
      expect(run.releaseRoute).toHaveBeenCalled()
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
      expect(run.tmux.clearEnv).toHaveBeenCalledWith(pane, ['ANTHROPIC_BASE_URL'], expect.any(Function))
      expect(run.deps.registry.setGridLaunch).toHaveBeenCalledWith('a1', null)
      expect(run.deps.registry.setSubscriptionModel).not.toHaveBeenCalled()
      expect(log.mock.calls.map(([line]) => String(line))).toContain('claude on its own login · retargeted a1 · fresh session')
      const none = setup(agent(), { relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: {} })) as never })
      await none.retarget({ agentId: 'a1', grid: null })
      expect(vi.mocked(validateLaunchOverrides).mock.lastCall?.[2]).toMatchObject({ subscriptionModel: null })
    })

    it('on a ptyhost pane: swapped through that pane\'s own backend, the grid\'s names cleared by the respawn on the way home', async () => {
      const pty = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%3' }
      const ptyBackend = { name: 'ptyhost', holdOpen: vi.fn(), respawn: vi.fn(), releaseHold: vi.fn(async () => {}) }
      const row = agent({ runtimes: [pty], grid: { baseUrl: 'x' }, subscriptionModel: 'opus' } as Partial<RegisteredSession>)
      const run = setup(row, {
        terminals: { backendFor: vi.fn(() => ptyBackend as never), instances: () => [ptyBackend as never] },
        relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: {} })) as never,
      })
      expect(await run.retarget({ agentId: 'a1', grid: null })).toEqual({ ok: true })
      expect(run.deps.terminals.backendFor).toHaveBeenCalledWith(pty)
      // No session env to clear first: the grid's names go with the respawn, out of the pane's create-time env.
      expect(run.deps.paneSwapDeps).toHaveBeenCalledWith(row, { backend: ptyBackend, runtime: pty }, { clearPaneEnv: ['ANTHROPIC_BASE_URL'] }, null, expect.any(Function))
      expect(run.deps.agentReconciler.holdRoute).toHaveBeenCalledWith(terminalRouteKey(pty), null)
      expect(ptyBackend.releaseHold).toHaveBeenCalledWith(pty, expect.any(Function))
      expect(run.tmux.clearEnv).not.toHaveBeenCalled()
      expect(run.tmux.releaseHold).not.toHaveBeenCalled()
    })

    it('fails cleanly when the pane will not be cleared, or the respawn does not come up', async () => {
      const home = { relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: {} })) as never }
      const run = setup(agent(), home)
      vi.mocked(run.tmux.clearEnv).mockResolvedValueOnce({ state: 'failed', reason: 'no session' } as never).mockResolvedValueOnce({ state: 'unknown' } as never)
      expect(await run.retarget({ agentId: 'a1', grid: null })).toEqual({ ok: false, error: 'GRID_CLEAR_FAILED', detail: 'no session' })
      expect(await run.retarget({ agentId: 'a1', grid: null })).toEqual({ ok: false, error: 'GRID_CLEAR_FAILED', detail: 'tmux would not clear the pane environment' })
      vi.mocked(restartAgent).mockResolvedValueOnce({ ok: false, detail: 'no process' } as never)
      expect(await run.retarget({ agentId: 'a1', grid })).toEqual({ ok: false, error: 'RESPAWN_FAILED', detail: 'no process' })
      expect(run.release).toHaveBeenCalledTimes(3)
      expect(run.releaseRoute).toHaveBeenCalledTimes(3)
    })

    it('rewrites a resumed OpenCode session\'s model before the respawn, and refuses if it cannot', async () => {
      const opencode = agent({ engine: 'opencode' } as Partial<RegisteredSession>)
      const withModel = { relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: { sessionModel: 'grid/big', gridLaunchRecord: null } })) as never }
      const run = setup(opencode, withModel)
      await run.retarget({ agentId: 'a1', grid })
      expect(applyOpencodeSessionModel).toHaveBeenCalledWith({ opencodeMajor: 1, dbPath: '/db/opencode.db', sessionId: 's1', model: { providerID: 'grid', modelID: 'big' }, cwd: '/work', checkCatalog: false }, { current: expect.any(Function) })
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

    it('does not act on a row removed before retarget can establish ownership', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byAgent).mockReturnValue(undefined)
      expect(await run.retarget({ agentId: 'a1', grid })).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
      expect(bypassPermissionFor).not.toHaveBeenCalled()
      expect(run.deps.liveBypassPermission).not.toHaveBeenCalled()
      expect(run.deps.announceSession).not.toHaveBeenCalled()
    })

    it('reports a confirmed native model change if the subsequent respawn fails', async () => {
      const run = setup(agent({ engine: 'opencode' }), { relaunchOverrides: vi.fn(async () => ({ ok: true as const,
        overrides: { env: {}, extraArgs: [], clearEnv: [], sessionModel: 'fixture/model' } })) })
      vi.mocked(restartAgent).mockResolvedValueOnce({ ok: false, detail: 'spawn failed' })
      expect(await run.retarget({ agentId: 'a1', grid })).toMatchObject({ ok: false, error: 'RESPAWN_FAILED',
        detail: expect.stringContaining('native model change was applied') })
      expect(run.deps.registry.updateProcessIdentity).not.toHaveBeenCalled()
    })
  })
})

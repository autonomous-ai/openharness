import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { engineBin, enginePathOverride } from '../../lib/engineBin.js'
import { engineInstallRecipe } from '../../lib/engineInstall.js'
import { buildEngineLaunchArgv, commandAvailableInInteractiveShell } from '../../lib/engineLaunch.js'
import { probeGatewayRuntime } from '../../lib/gatewayRuntime.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { AgentRestartCoordinator, bypassPermissionFor, restartAgent } from '../../lib/restartAgent.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { processLaunchArgs } from '../../lib/processTable.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import { carryClaudeTranscript } from '../../lib/claudeTranscriptCarry.js'
import { createAgentRestarter, type RestartDeps } from './restart.js'
import { createLaunchAuthority } from './launchAuthority.js'
import { createSwarmSkillAdoption } from '../../superTabs/inCore/adoption.js'
import { RETENTION_LAPSE_MS, retainContributions, retainedHarnesses } from '../../superTabs/retention.js'
import { GUEST_HARNESS_REFUSAL } from '../guestPolicy.js'
import { TerminalAgentReconciler } from '../../lib/terminalAgentReconciler.js'

vi.mock('../../lib/engineBin.js', async (real) => ({ ...await real<object>(), enginePathOverride: vi.fn(() => undefined) }))
vi.mock('../../lib/engineLaunch.js', async (real) => ({
  ...await real<object>(),
  buildEngineLaunchArgv: vi.fn(() => ['zsh', '-l']),
  commandAvailableInInteractiveShell: vi.fn(async () => true),
}))
vi.mock('../../lib/gatewayRuntime.js', async (real) => ({ ...await real<object>(), probeGatewayRuntime: vi.fn(async () => ({ kind: 'none' })) }))
vi.mock('../../lib/restartAgent.js', async (real) => ({
  ...await real<object>(),
  bypassPermissionFor: vi.fn(async (_s: unknown, live: () => Promise<boolean>) => live()),
  restartAgent: vi.fn(async () => ({ ok: true, resumed: true, processIdentity: { pid: 2, startMarker: 'new', executable: '/bin/claude' } })),
}))
vi.mock('../../lib/processTable.js', async (real) => ({
  ...await real<object>(),
  processLaunchArgs: vi.fn(async () => '/bin/claude --model opus -c model_provider=grid'),
}))
// The real carry by default, over throwaway homes; a test that would reach the default account's own projects folder
// (the developer's real ~/.claude) replaces it for that call.
vi.mock('../../lib/claudeTranscriptCarry.js', async (real) => {
  const actual = await real<typeof import('../../lib/claudeTranscriptCarry.js')>()
  return { ...actual, carryClaudeTranscript: vi.fn(actual.carryClaudeTranscript) }
})
vi.mock('../../lib/workspaceCheck.js', () => ({ workspaceMissing: vi.fn(() => null) }))

const runtime = { backend: 'tmux' as const, paneId: '%4' }
/** The pane's backend handing the pane back to its default disposal (`TerminalBackend.releaseHold`). */
const releaseHold = vi.fn(async (..._args: unknown[]) => {})
const routeKey = terminalRouteKey(runtime as never)
const newProcess = { pid: 2, startMarker: 'new', executable: '/bin/claude' }
const agent = (over: Partial<RegisteredSession> = {}): RegisteredSession => ({
  agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: '/work', tmuxPane: '%4', runtimes: [runtime], processIdentity: { pid: 1, startMarker: 'old' }, ...over,
}) as unknown as RegisteredSession
const terminal = (over: Partial<RegisteredSession> = {}) => agent({ engine: 'terminal', processIdentity: undefined, ...over } as Partial<RegisteredSession>)

/** `row` is what the registry resolves and reads back; `refreshed` is what it reads after the swap
 *  (null: the row vanished mid-restart). `live` goes false to make the operation stale. */
function setup(row: RegisteredSession | null = agent(), over: Partial<RestartDeps> = {}, refreshed: RegisteredSession | null = row) {
  const state = { live: true }
  const tmuxBackend = { name: 'tmux', holdOpen: vi.fn(), respawn: vi.fn(async () => ({ state: 'succeeded' })), releaseHold }
  const deps: RestartDeps = {
    restartJobs: { run: vi.fn((_id: string, job: (current: () => boolean) => unknown) => job(() => state.live)) } as never,
    registry: {
      resolve: vi.fn(() => row ?? undefined),
      byAgent: vi.fn(() => refreshed ?? undefined),
      updateProcessIdentity: vi.fn(),
      setActive: vi.fn(),
      setLaunchArgs: vi.fn(() => true),
      setClaudeHome: vi.fn(),
      setTranscriptPath: vi.fn(),
    } as unknown as RestartDeps['registry'],
    purgeBusy: vi.fn(() => false),
    stopJobs: new Map(),
    pinnedControls: new Set(),
    terminals: { backendFor: vi.fn((runtime: { backend: string }) => runtime.backend === 'tmux' ? tmuxBackend : undefined) } as unknown as RestartDeps['terminals'],
    sameRestartTarget: vi.fn(() => true),
    agentReconciler: { holdRoute: vi.fn((key: string) => () => deps.agentReconciler.releaseRoute(key)), releaseRoute: vi.fn() },
    terminalHintMachineName: () => 'studio',
    announceSession: vi.fn(),
    refreshGridAssignment: vi.fn(),
    relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: { env: { GRID_KEY: 'k' }, clearEnv: [] } })) as never,
    downgradedPermission: vi.fn(async (_s, bypass: boolean) => ({ bypassPermission: bypass, permissionMode: 'auto' })) as never,
    refreshGridWebSearch: vi.fn() as never,
    liveBypassPermission: vi.fn(async () => true),
    paneSwapDeps: vi.fn(() => ({ swap: true })) as never,
    restartHeld: vi.fn(() => null),
    profileHomes: () => [],
    ...over,
  }
  return { deps, state, tmuxBackend, restart: createAgentRestarter(deps) }
}

const changed = { ok: false, error: 'AGENT_CHANGED', detail: 'The harness changed or stopped during restart.' }

describe('restarting an agent', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it.each(['terminal', 'claude'] as const)('keeps a slow %s restart hidden from discovery until publication', async engine => {
    vi.useFakeTimers()
    const onDiscovered = vi.fn()
    const reconciler = new TerminalAgentReconciler({ current: () => [], backends: [], backendOrder: ['tmux'],
      onDiscovered, onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
      probe: async () => ({ processTableAvailable: true, ambiguousPlacements: new Set(),
        targets: [{ instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime, rootPid: 1, cwd: '/work' }] } }],
        agents: [{ engine: 'claude', cwd: '/work', processIdentity: newProcess,
          args: 'claude', resumeSessionId: null, runtimes: [runtime], primaryRuntimeKey: routeKey }],
      }),
    })
    let finish!: () => void
    const run = setup(engine === 'terminal' ? terminal() : agent(), { agentReconciler: reconciler })
    if (engine === 'terminal') run.tmuxBackend.respawn.mockImplementationOnce(() => new Promise(done => {
      finish = () => done({ state: 'succeeded' })
    }))
    else vi.mocked(restartAgent).mockImplementationOnce(() => new Promise(done => {
      finish = () => done({ ok: true, resumed: true, processIdentity: newProcess })
    }))
    const pending = run.restart('a1')
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      await vi.advanceTimersByTimeAsync(30_001)
      await reconciler.trigger()
      expect(onDiscovered).not.toHaveBeenCalled()
      finish()
      expect(await pending).toMatchObject({ ok: true })
      expect(run.deps.announceSession).toHaveBeenCalled()
      await reconciler.trigger()
      expect(onDiscovered).toHaveBeenCalledOnce()
    } finally { finish?.(); await pending; vi.useRealTimers() }
  })

  it.each(['terminal', 'claude'] as const)('a cancelled %s restart cannot release a newer Stop hold', async engine => {
    const onDiscovered = vi.fn()
    const reconciler = new TerminalAgentReconciler({ current: () => [], backends: [], backendOrder: ['tmux'],
      onDiscovered, onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
      probe: async () => ({ processTableAvailable: true, ambiguousPlacements: new Set(),
        targets: [{ instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime, rootPid: 1, cwd: '/work' }] } }],
        agents: [{ engine: 'claude', cwd: '/work', processIdentity: newProcess,
          args: 'claude', resumeSessionId: null, runtimes: [runtime], primaryRuntimeKey: routeKey }],
      }),
    })
    const run = setup(engine === 'terminal' ? terminal() : agent(), { agentReconciler: reconciler })
    let releaseStop!: () => void
    const stop = () => { run.state.live = false; releaseStop = reconciler.holdRoute(routeKey) }
    if (engine === 'terminal') run.tmuxBackend.respawn.mockImplementationOnce(async () => { stop(); return { state: 'succeeded' } })
    else vi.mocked(restartAgent).mockImplementationOnce(async () => { stop(); return { ok: false, detail: 'cancelled' } })
    try {
      expect(await run.restart('a1')).toMatchObject({ error: 'AGENT_CHANGED' })
      await reconciler.trigger()
      expect(onDiscovered).not.toHaveBeenCalled()
      releaseStop()
      await reconciler.trigger()
      expect(onDiscovered).toHaveBeenCalledOnce()
    } finally { releaseStop?.() }
  })

  it('adopts an old role before native inspection and relaunch', async () => {
    const skill = { role: 'coordinator' as const, key: 'a1' }
    const run = setup(agent(), { adoptSwarmSkill: async row => ({ ...row, swarmSkill: skill }) })
    expect(await run.restart('a1')).toMatchObject({ ok: true })
    expect(run.deps.relaunchOverrides).toHaveBeenCalledWith(expect.objectContaining({ swarmSkill: skill }),
      expect.objectContaining({ swarmSkill: skill }), expect.any(Function), undefined)
  })

  it('does not restart if role adoption loses the session binding', async () => {
    const run = setup(agent(), { adoptSwarmSkill: async () => null })
    expect(await run.restart('a1')).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
    expect(restartAgent).not.toHaveBeenCalled()
  })

  it('restarts when an unrelated registry field changes during a no-role lookup', async () => {
    const session = agent({ registeredAt: 1 })
    const authority = createLaunchAuthority({ byAgent: () => session, revision: () => 0, cancelled: () => false })
    const adoptSwarmSkill = createSwarmSkillAdoption({
      authority, save: vi.fn(), candidate: () => true,
      role: async () => { session.dsh = 'changed-during-lookup'; return null },
    })
    const run = setup(session, { adoptSwarmSkill })
    expect(await run.restart('a1')).toMatchObject({ ok: true })
    expect(restartAgent).toHaveBeenCalledOnce()
  })

  // Security review 2 of #2255: a Mac offline over a week has a lapsed local roster, which once restarted an old Buddy
  // without its role.
  it('restarts an old Buddy with its role after the local roster lapsed', async () => {
    const data = mkdtempSync(join(tmpdir(), 'restart-roster-'))
    try {
      retainContributions(data, 'machine', [{ tabId: 'tab', agent: { harnessId: 'a1', machineId: 'machine' } }], Date.now() - RETENTION_LAPSE_MS - 60_000)
      const session = agent({ startedBy: 'agent' })
      const role = vi.fn(async () => ({ role: 'buddy' as const }))
      const adoptSwarmSkill = createSwarmSkillAdoption({ role, save: vi.fn(), candidate: id => retainedHarnesses(data).has(id),
        authority: createLaunchAuthority({ byAgent: () => session, revision: () => 0, cancelled: () => false }) })
      const run = setup(session, { adoptSwarmSkill })
      expect(await run.restart('a1')).toMatchObject({ ok: true })
      expect(role).toHaveBeenCalledOnce()
      expect(run.deps.relaunchOverrides).toHaveBeenCalledWith(expect.objectContaining({ swarmSkill: { role: 'buddy', key: 'a1' } }),
        expect.anything(), expect.any(Function), undefined)
    } finally { rmSync(data, { recursive: true, force: true }) }
  })

  it.each(['starting', 'held'] as const)('does not replace an unbound native %s launch with a generic fresh restart', async state => {
    const run = setup(agent({ sessionId: '', launch: state === 'starting' ? { state, nativeToken: 'original' }
      : { state, nativeToken: 'original', service: 'native', detail: 'Original request held' } }))
    expect(await run.restart('a1')).toMatchObject({ ok: false, error: 'NATIVE_LAUNCH_HELD' })
    expect(run.deps.restartHeld).not.toHaveBeenCalled()
    expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
    expect(restartAgent).not.toHaveBeenCalled()
  })

  it.each(['inspection', 'permission', 'snapshot'] as const)('preserves the live process when restart loses %s evidence', async stage => {
    let nativeCurrent = true
    const launch = { current: () => nativeCurrent } as never
    const run = setup(agent(), {
      native: async () => { if (stage === 'inspection') run.state.live = false; return { ok: true, launch } },
      relaunchOverrides: async () => ({ ok: true, overrides: { native: launch, env: {}, extraArgs: [], clearEnv: [] } }),
      downgradedPermission: async () => {
        if (stage === 'snapshot') nativeCurrent = false
        return { bypassPermission: false, ...(stage === 'permission' ? { nativeHold: 'Waiting for native flags.' } : {}) }
      },
    })
    expect(await run.restart('a1')).toMatchObject({ ok: false, error: stage === 'inspection' ? 'AGENT_CHANGED' : 'NATIVE_LAUNCH_HELD' })
    expect(restartAgent).not.toHaveBeenCalled()
    expect(run.deps.registry.updateProcessIdentity).not.toHaveBeenCalled()
  })

  it('holds native installation before killing the live process, without an independent shell probe', async () => {
    const native = vi.fn(async () => ({ ok: false as const, error: 'NATIVE_LAUNCH_HELD' as const, unavailable: 'native' as const, detail: 'Waiting for installation' }))
    const run = setup(agent(), { native })
    expect(await run.restart('a1')).toMatchObject({ unavailable: 'native' })
    expect(commandAvailableInInteractiveShell).not.toHaveBeenCalled()
    expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
    expect(restartAgent).not.toHaveBeenCalled()
  })

  it('passes its one native snapshot through restart preparation and permission checks', async () => {
    const launch = { current: () => true } as never
    const run = setup(agent(), { native: async () => ({ ok: true, launch }),
      relaunchOverrides: vi.fn(async () => ({ ok: true as const, overrides: { native: launch, env: {}, extraArgs: [], clearEnv: [] } })),
    })
    expect(await run.restart('a1')).toMatchObject({ ok: true })
    expect(commandAvailableInInteractiveShell).not.toHaveBeenCalled()
    expect(run.deps.relaunchOverrides).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), expect.any(Function), launch)
    expect(run.deps.downgradedPermission).toHaveBeenCalledWith(expect.any(Object), true, 'restart', launch)
  })

  it('answers a relaunch refused on Windows by its own code, having stopped nothing', async () => {
    vi.mocked(restartAgent).mockResolvedValueOnce({ ok: false, error: 'ENGINE_LAUNCH_REFUSED', detail: 'Harness cannot start claude on Windows. Nothing was stopped.' })
    expect(await setup(agent()).restart('a1')).toEqual({ ok: false, error: 'ENGINE_LAUNCH_REFUSED', detail: 'Harness cannot start claude on Windows. Nothing was stopped.' })
  })

  it('never starts a fresh conversation when an admitted external resume fails', async () => {
    const actual = await vi.importActual<typeof import('../../lib/restartAgent.js')>('../../lib/restartAgent.js')
    vi.mocked(restartAgent).mockImplementationOnce(actual.restartAgent)
    const respawn = vi.fn(async () => ({ ok: true }))
    const keepAbandoned = vi.fn(), buildArgv = vi.fn(options => ['fixture-engine', options.resumeSessionId ?? 'fresh'])
    const run = setup(agent({ resumeOnly: true }), { paneSwapDeps: () => ({
      holdOpen: async () => ({ ok: true }), terminate: async () => 'gone', respawn,
      waitForProcess: async () => null, buildArgv, keepAbandoned, log: () => {},
    }) })
    expect(await run.restart('a1')).toMatchObject({ ok: false, error: 'RESTART_FAILED' })
    expect(respawn).toHaveBeenCalledExactlyOnceWith(['fixture-engine', 's1'])
    expect(keepAbandoned).not.toHaveBeenCalled()
    expect(run.deps.registry.updateProcessIdentity).not.toHaveBeenCalled()
  })

  describe('with new launch words', () => {
    const WORDS = ['--chrome']

    it('builds the relaunch with them and saves them on the record only after the engine is back', async () => {
      const order: string[] = []
      const run = setup(agent(), {
        relaunchOverrides: vi.fn(async () => { order.push('build'); return { ok: true as const, overrides: { env: {}, extraArgs: [], clearEnv: [] } } }),
      })
      vi.mocked(run.deps.registry.setLaunchArgs).mockImplementation(() => { order.push('save'); return true })
      vi.mocked(restartAgent).mockImplementationOnce(async () => { order.push('restart'); return { ok: true, resumed: true, processIdentity: newProcess } })
      expect(await run.restart('a1', WORDS)).toMatchObject({ ok: true })
      expect(run.deps.relaunchOverrides).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentId: 'a1', launchArgs: WORDS }), expect.any(Function), undefined)
      expect(order).toEqual(['build', 'restart', 'save'])
      expect(run.deps.registry.setLaunchArgs).toHaveBeenCalledExactlyOnceWith('a1', WORDS)
      // Asked as its own variant of a restart, so another ask with other words is not answered by this launch.
      expect(run.deps.restartJobs.run).toHaveBeenCalledWith('a1', expect.any(Function), 'restart', JSON.stringify(WORDS))
    })

    it('clears them with an empty list: built without, and removed from the record once the engine is back', async () => {
      const run = setup(agent({ launchArgs: ['--old'] } as Partial<RegisteredSession>))
      expect(await run.restart('a1', [])).toMatchObject({ ok: true })
      expect(run.deps.relaunchOverrides).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ launchArgs: [] }), expect.any(Function), undefined)
      expect(run.deps.registry.setLaunchArgs).toHaveBeenCalledExactlyOnceWith('a1', [])
    })

    it('without them, relaunches from the row itself and never writes the record', async () => {
      const row = agent({ launchArgs: ['--saved'] } as Partial<RegisteredSession>)
      const run = setup(row)
      expect(await run.restart('a1')).toMatchObject({ ok: true })
      expect(run.deps.relaunchOverrides).toHaveBeenCalledWith(row, row, expect.any(Function), undefined)
      expect(run.deps.registry.setLaunchArgs).not.toHaveBeenCalled()
      expect(run.deps.restartJobs.run).toHaveBeenCalledWith('a1', expect.any(Function), 'restart', undefined)
    })

    // Every way a restart can end without the engine back saves nothing: the record keeps the flags that last worked.
    it.each([
      ['busy', () => setup(agent(), { purgeBusy: () => true })],
      ['no live process', () => setup(agent({ processIdentity: undefined } as Partial<RegisteredSession>))],
      ['the agent changed under it', () => setup(agent(), { sameRestartTarget: vi.fn(() => false) })],
      ['launch preparation refused', () => setup(agent(), { relaunchOverrides: vi.fn(async () => ({ ok: false as const, error: 'GRID_UNAVAILABLE', detail: 'x' })) })],
      ['the engine did not start', () => {
        vi.mocked(restartAgent).mockResolvedValueOnce({ ok: false, error: 'RESTART_FAILED', detail: 'did not come up' } as never)
        return setup(agent())
      }],
    ])('saves nothing when the restart ends %s', async (_why, make) => {
      const run = make()
      expect(await run.restart('a1', WORDS)).toMatchObject({ ok: false })
      expect(run.deps.registry.setLaunchArgs).not.toHaveBeenCalled()
    })

    // The coordinator joins asks of the same words and refuses the others, so the record is what the one launch used.
    it('two overlapping restarts with different words: one launches and is saved, the other is refused and saves nothing', async () => {
      let release!: () => void
      vi.mocked(restartAgent).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return { ok: true, resumed: true, processIdentity: newProcess }
      })
      const run = setup(agent(), { restartJobs: new AgentRestartCoordinator() })
      const first = run.restart('a1', ['--first'])
      await vi.waitFor(() => expect(release).toBeDefined())
      expect(await run.restart('a1', ['--second'])).toMatchObject({ ok: false, error: 'AGENT_BUSY' })
      const joined = run.restart('a1', ['--first'])
      release()
      expect(await first).toMatchObject({ ok: true })
      expect(await joined).toMatchObject({ ok: true })
      expect(run.deps.registry.setLaunchArgs).toHaveBeenCalledExactlyOnceWith('a1', ['--first'])
      expect(restartAgent).toHaveBeenCalledOnce()
    })
  })

  describe('refusals before anything is touched', () => {
    it('for an agent being purged, stopped or answered, and for one that is not there', async () => {
      expect(await setup(agent(), { purgeBusy: () => true }).restart('a1')).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(await setup(agent(), { stopJobs: new Map([['a1', Promise.resolve()]]) }).restart('a1')).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(await setup(agent(), { pinnedControls: new Set(['a1']) }).restart('a1')).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(await setup(null).restart('a1')).toEqual({ ok: false, error: 'AGENT_NOT_FOUND' })
    })

    it('for an agent a stopped move may still run beside, held this start, with the move\'s line', async () => {
      const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const held = vi.fn(() => ({ ok: false, error: 'HELD' }))
      const run = setup(agent(), { moveHeld: (id) => id === 'a1', restartHeld: held as never })
      expect(await run.restart('a1')).toMatchObject({ ok: false, error: 'AGENT_BUSY' })
      // Neither a swap nor a held agent's launch runs: either would start a second engine on the conversation.
      expect(held).not.toHaveBeenCalled()
      expect(restartAgent).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith('[terminal] move a1: held until the next start: a pane its stopped move left was not confirmed closed')
      log.mockRestore()
    })

    it('for a guest\'s harness, which a relaunch would run as the owner', async () => {
      const run = setup(agent({ guest: 'kim@acme.io' }))
      expect(await run.restart('a1')).toEqual(GUEST_HARNESS_REFUSAL)
    })

    it('for an agent held for a service, its launch, now, with nothing of a swap touched', async () => {
      const launched = { ok: true as const, session: agent(), resumed: true }
      const run = setup(agent({ processIdentity: undefined, tmuxPane: '%4' } as Partial<RegisteredSession>), { restartHeld: vi.fn(() => Promise.resolve(launched)) })
      expect(await run.restart('a1')).toBe(launched)
      expect(run.deps.restartHeld).toHaveBeenCalledWith('a1')
      expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
      expect(run.tmuxBackend.respawn).not.toHaveBeenCalled()
    })

    it('for an agent with no tmux pane, or no tmux at all', async () => {
      expect(await setup(agent({ tmuxPane: undefined, runtimes: [] })).restart('a1')).toEqual({ ok: false, error: 'RESTART_UNSUPPORTED_BACKEND' })
      expect(await setup(agent(), { terminals: { backendFor: () => undefined } }).restart('a1')).toEqual({ ok: false, error: 'RESTART_UNSUPPORTED_BACKEND' })
    })

    it('for an agent on a ptyhost pane only, though its `tmuxPane` names that pane\'s id, with no ptyhost backend', async () => {
      const run = setup(agent({ runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: '%4' }] }))
      expect(await run.restart('a1')).toEqual({ ok: false, error: 'RESTART_UNSUPPORTED_BACKEND' })
      expect(run.tmuxBackend.respawn).not.toHaveBeenCalled()
    })

    it('for an agent whose backend has no restart primitives, whatever its name', async () => {
      const pty = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%3' }
      const bare = { name: 'ptyhost', respawn: vi.fn(), releaseHold: vi.fn() }
      const run = setup(agent({ runtimes: [pty] }), { terminals: { backendFor: () => bare as never } })
      expect(await run.restart('a1')).toEqual({ ok: false, error: 'RESTART_UNSUPPORTED_BACKEND' })
      expect(bare.respawn).not.toHaveBeenCalled()
      expect(run.tmuxBackend.respawn).not.toHaveBeenCalled()
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
      expect(run.deps.restartJobs.run).toHaveBeenCalledWith('a1', expect.any(Function), 'restart', undefined)
      const missing = setup(null)
      await missing.restart('ghost')
      expect(missing.deps.restartJobs.run).toHaveBeenCalledWith('ghost', expect.any(Function), 'restart', undefined)
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

  describe('on a ptyhost pane', () => {
    const pty = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%3' }
    const ptyBackend = () => ({ name: 'ptyhost', holdOpen: vi.fn(), respawn: vi.fn(async () => ({ state: 'succeeded' })), releaseHold: vi.fn(async () => {}) })

    it('restarts a terminal through that pane\'s own backend; tmux is never asked', async () => {
      const backend = ptyBackend()
      const run = setup(terminal({ runtimes: [pty] }), { terminals: { backendFor: vi.fn(() => backend as never) } })
      expect(await run.restart('a1')).toMatchObject({ ok: true, resumed: false })
      expect(run.deps.terminals.backendFor).toHaveBeenCalledWith(pty)
      expect(backend.respawn).toHaveBeenCalledExactlyOnceWith(pty, { command: ['zsh', '-l'], cwd: homedir() })
      expect(backend.releaseHold).toHaveBeenCalledWith(pty)
      expect(run.tmuxBackend.respawn).not.toHaveBeenCalled()
      expect(releaseHold).not.toHaveBeenCalled()
      expect(run.deps.agentReconciler.holdRoute).toHaveBeenCalledWith(terminalRouteKey(pty), null)
    })

    it('swaps an engine in that pane and hands it back to that backend', async () => {
      const backend = ptyBackend()
      const row = agent({ runtimes: [pty] })
      const run = setup(row, { terminals: { backendFor: () => backend as never } })
      expect(await run.restart('a1')).toMatchObject({ ok: true, resumed: true })
      expect(run.deps.paneSwapDeps).toHaveBeenCalledWith(row, { backend, runtime: pty }, { env: { GRID_KEY: 'k' }, clearEnv: ['CLAUDE_CONFIG_DIR'] }, 'auto', expect.any(Function))
      expect(backend.releaseHold).toHaveBeenCalledWith(pty)
      expect(releaseHold).not.toHaveBeenCalled()
      expect(run.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(terminalRouteKey(pty))
    })
  })

  describe('a terminal', () => {
    it('restarts in its tmux pane, not the pane `tmuxPane` projects from a ptyhost runtime sorted first', async () => {
      const tmux5 = { backend: 'tmux' as const, paneId: '%5' }
      const run = setup(terminal({ runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: '%4' }, tmux5] }))
      expect(await run.restart('a1')).toMatchObject({ ok: true })
      expect(run.tmuxBackend.respawn).toHaveBeenCalledExactlyOnceWith(tmux5, expect.anything())
      expect(run.deps.agentReconciler.holdRoute).toHaveBeenCalledWith(terminalRouteKey(tmux5), null)
    })

    it('restarts as a fresh shell in the same pane, opened like a new terminal tile', async () => {
      const run = setup(terminal())
      expect(await run.restart('a1')).toEqual({ ok: true, session: terminal(), resumed: false })
      expect(buildEngineLaunchArgv).toHaveBeenCalledWith('terminal', { cwd: '/work', terminalHint: { machineName: 'studio' } })
      expect(run.tmuxBackend.respawn).toHaveBeenCalledWith(runtime, { command: ['zsh', '-l'], cwd: homedir() })
      expect(releaseHold).toHaveBeenCalledWith(runtime)
      expect(run.deps.registry.setActive).toHaveBeenCalledWith('a1', true)
      expect(run.deps.announceSession).toHaveBeenCalledWith(terminal())
      expect(console.log).toHaveBeenCalledWith('[restart] a1 terminal · fresh shell')
      expect(run.deps.agentReconciler.holdRoute).toHaveBeenCalledWith(routeKey, null)
      expect(run.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)
      expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
    })

    it('on Windows, starts the shell in its folder, which no launch script enters there', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      const run = setup(terminal())
      try {
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
        expect(await run.restart('a1')).toMatchObject({ ok: true })
      } finally { Object.defineProperty(process, 'platform', platform) }
      expect(run.tmuxBackend.respawn).toHaveBeenCalledWith(runtime, { command: ['zsh', '-l'], cwd: '/work' })
    })

    it('with no folder of its own, opens without one', async () => {
      await setup(terminal({ cwd: undefined })).restart('a1')
      expect(buildEngineLaunchArgv).toHaveBeenCalledWith('terminal', { terminalHint: { machineName: 'studio' } })
    })

    it('says why tmux would not respawn it, and lets the route go', async () => {
      const run = setup(terminal())
      run.tmuxBackend.respawn.mockResolvedValueOnce({ state: 'failed', reason: 'pane gone' } as never)
      expect(await run.restart('a1')).toEqual({ ok: false, error: 'RESTART_FAILED', detail: 'pane gone' })
      expect(releaseHold).not.toHaveBeenCalled()
      expect(run.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)
    })

    it('stops at whichever step finds the operation overtaken', async () => {
      const respawned = setup(terminal())
      respawned.tmuxBackend.respawn.mockImplementationOnce(async () => { respawned.state.live = false; return { state: 'succeeded' } })
      expect(await respawned.restart('a1')).toEqual(changed)
      expect(releaseHold).not.toHaveBeenCalled()
      expect(respawned.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)

      const cleared = setup(terminal())
      releaseHold.mockImplementationOnce(async () => { cleared.state.live = false })
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
      expect(run.deps.downgradedPermission).toHaveBeenCalledWith(agent(), true, 'restart', undefined)
      expect(run.deps.paneSwapDeps).toHaveBeenCalledWith(agent(), { backend: run.tmuxBackend, runtime }, { env: { GRID_KEY: 'k' }, clearEnv: ['CLAUDE_CONFIG_DIR'] }, 'auto', expect.any(Function))
      const [target, bypass, swapDeps] = vi.mocked(restartAgent).mock.calls[0]
      expect(target).toEqual({ engine: 'claude', sessionId: 's1' })
      expect(bypass).toBe(true)
      expect(swapDeps).toMatchObject({ swap: true })
      expect(swapDeps.isCurrent?.()).toBe(true)
      expect(run.deps.refreshGridWebSearch).toHaveBeenCalledWith('a1', { env: { GRID_KEY: 'k' }, clearEnv: ['CLAUDE_CONFIG_DIR'] })
      expect(probeGatewayRuntime).toHaveBeenCalledWith(newProcess)
      // Its command line, where a Codex or pi grid's address and model are: never its executable alone.
      expect(run.deps.registry.updateProcessIdentity).toHaveBeenCalledWith('a1', newProcess, 'none')
      expect(run.deps.registry.setActive).toHaveBeenCalledWith('a1', true)
      expect(releaseHold).toHaveBeenCalledWith(runtime)
      expect(run.deps.announceSession).toHaveBeenCalledWith(agent())
      expect(run.deps.refreshGridAssignment).toHaveBeenCalledWith(agent())
      expect(console.log).toHaveBeenCalledWith('[restart] a1 claude · resumed')
      expect(run.deps.agentReconciler.holdRoute).toHaveBeenCalledWith(routeKey, null)
      expect(run.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)
    })

    it('without a mode or a yes, launches with no mode and no bypass; a fresh session on a grid says both', async () => {
      const grid = agent({ gridLaunch: { networkName: 'Home' } } as Partial<RegisteredSession>)
      const run = setup(grid, { downgradedPermission: vi.fn(async () => ({ bypassPermission: false })) as never })
      vi.mocked(restartAgent).mockResolvedValueOnce({ ok: true, resumed: false, processIdentity: newProcess } as never)
      expect(await run.restart('a1')).toEqual({ ok: true, session: grid, resumed: false })
      expect(run.deps.paneSwapDeps).toHaveBeenCalledWith(grid, { backend: run.tmuxBackend, runtime }, { env: { GRID_KEY: 'k' }, clearEnv: ['CLAUDE_CONFIG_DIR'] }, null, expect.any(Function))
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
      vi.mocked(built.deps.relaunchOverrides).mockImplementationOnce(async () => { built.state.live = false; return { ok: true, overrides: { env: {}, clearEnv: [] } } as never })
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
      releaseHold.mockImplementationOnce(async () => { cleared.state.live = false })
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
  describe('under another Claude account', () => {
    const ID = '0a1b2c3d-1111-2222-3333-444455556666'
    let root: string, from: string, to: string
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'restart-home-'))
      from = join(root, 'from'); to = join(root, 'to')
      mkdirSync(join(from, 'projects', '-work'), { recursive: true })
      mkdirSync(to)
      writeFileSync(join(from, 'projects', '-work', `${ID}.jsonl`), '{}\n')
    })
    afterEach(() => { rmSync(root, { recursive: true, force: true }) })
    const row = (over: Partial<RegisteredSession> = {}) => agent({ sessionId: ID, claudeHome: from, transcriptPath: join(from, 'projects', '-work', `${ID}.jsonl`), ...over } as Partial<RegisteredSession>)
    const launchOf = () => vi.mocked(restartAgent).mock.calls[0]

    it('a restart with claudeHome resumes the same session under that home', async () => {
      const run = setup(row(), { profileHomes: () => [to] })
      expect(await run.restart('a1', undefined, to)).toMatchObject({ ok: true, resumed: true })
      const carried = join(to, 'projects', '-work', `${ID}.jsonl`)
      expect(existsSync(carried)).toBe(true)
      expect(launchOf()[0]).toMatchObject({ engine: 'claude', sessionId: ID })
      expect(run.deps.relaunchOverrides).toHaveBeenCalledWith(expect.objectContaining({ claudeHome: to }), expect.objectContaining({ claudeHome: to }), expect.any(Function), undefined)
      expect(vi.mocked(run.deps.paneSwapDeps).mock.calls[0][2]).toMatchObject({ env: { GRID_KEY: 'k', CLAUDE_CONFIG_DIR: to } })
      expect(run.deps.registry.setClaudeHome).toHaveBeenCalledWith('a1', to)
      expect(run.deps.registry.setTranscriptPath).toHaveBeenCalledWith('a1', carried)
    })

    it('claudeHome null restarts on the default account', async () => {
      const kept = join(root, 'default-projects', '-work', `${ID}.jsonl`)
      vi.mocked(carryClaudeTranscript).mockReturnValueOnce({ transcriptPath: kept, copied: true })
      const run = setup(row(), { relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: { env: { GRID_KEY: 'k', CLAUDE_CONFIG_DIR: from }, clearEnv: ['X'] } })) as never })
      expect(await run.restart('a1', undefined, null)).toMatchObject({ ok: true })
      expect(carryClaudeTranscript).toHaveBeenCalledWith(from, undefined, '/work', ID)
      const overrides = vi.mocked(run.deps.paneSwapDeps).mock.calls[0][2] as { env: Record<string, string>; clearEnv: string[] }
      expect(overrides.env).toEqual({ GRID_KEY: 'k' })
      expect(overrides.clearEnv).toEqual(['X', 'CLAUDE_CONFIG_DIR'])
      expect(run.deps.registry.setClaudeHome).toHaveBeenCalledWith('a1', undefined)
      expect(run.deps.registry.setTranscriptPath).toHaveBeenCalledWith('a1', kept)
    })

    it('a row on the default account carries from the default', async () => {
      vi.mocked(carryClaudeTranscript).mockReturnValueOnce({ transcriptPath: '/t', copied: false })
      const run = setup(row({ claudeHome: null, cwd: undefined } as never), { profileHomes: () => [to] })
      await run.restart('a1', undefined, to)
      expect(carryClaudeTranscript).toHaveBeenCalledWith(undefined, to, '', ID)
    })

    it('a claudeHome that is not a profile of this machine is refused', async () => {
      const run = setup(row(), { profileHomes: () => [to] })
      expect(await run.restart('a1', undefined, join(root, 'elsewhere'))).toEqual({ ok: false, error: 'INVALID_PROFILE' })
      expect(carryClaudeTranscript).not.toHaveBeenCalled()
      expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
      expect(restartAgent).not.toHaveBeenCalled()
      expect(run.deps.registry.setClaudeHome).not.toHaveBeenCalled()
    })

    it.each([['codex', '/any/home'], ['codex', null], ['terminal', null]] as const)('is refused for a %s agent, whatever the home (%s)', async (engine, home) => {
      const run = setup(row({ engine } as never), { profileHomes: () => ['/any/home'] })
      expect(await run.restart('a1', undefined, home)).toEqual({ ok: false, error: 'INVALID_PROFILE' })
      expect(restartAgent).not.toHaveBeenCalled()
      expect(run.tmuxBackend.respawn).not.toHaveBeenCalled()
    })

    it('refuses before anything is stopped when the transcript cannot be carried', async () => {
      const missing = setup(row({ sessionId: 'b1b2c3d4-1111-2222-3333-444455556666' } as never), { profileHomes: () => [to] })
      expect(await missing.restart('a1', undefined, to)).toMatchObject({ ok: false, error: 'NOT_FOUND' })
      vi.mocked(carryClaudeTranscript).mockImplementationOnce(() => { throw new Error('disk full') })
      const broken = setup(row(), { profileHomes: () => [to] })
      expect(await broken.restart('a1', undefined, to)).toEqual({ ok: false, error: 'RESTART_FAILED', detail: 'disk full' })
      vi.mocked(carryClaudeTranscript).mockImplementationOnce(() => { throw 'odd' })
      expect(await setup(row(), { profileHomes: () => [to] }).restart('a1', undefined, to)).toMatchObject({ error: 'RESTART_FAILED' })
      expect(restartAgent).not.toHaveBeenCalled()
    })

    it('puts the row back on its old account when the relaunch did not start', async () => {
      vi.mocked(restartAgent).mockResolvedValueOnce({ ok: false, error: 'ENGINE_LAUNCH_REFUSED', detail: 'no' })
      const run = setup(row(), { profileHomes: () => [to] })
      expect(await run.restart('a1', undefined, to)).toMatchObject({ ok: false, error: 'ENGINE_LAUNCH_REFUSED' })
      expect(vi.mocked(run.deps.registry.setClaudeHome).mock.calls).toEqual([['a1', to], ['a1', from]])
      expect(vi.mocked(run.deps.registry.setTranscriptPath).mock.calls.at(-1)).toEqual(['a1', join(from, 'projects', '-work', `${ID}.jsonl`)])
    })

    it('puts a row that was on the default account back on it', async () => {
      vi.mocked(restartAgent).mockResolvedValueOnce({ ok: false, error: 'ENGINE_LAUNCH_REFUSED', detail: 'no' })
      vi.mocked(carryClaudeTranscript).mockReturnValueOnce({ transcriptPath: '/t', copied: false })
      const run = setup(row({ claudeHome: null, transcriptPath: null } as never), { profileHomes: () => [to] })
      await run.restart('a1', undefined, to)
      expect(vi.mocked(run.deps.registry.setClaudeHome).mock.calls.at(-1)).toEqual(['a1', undefined])
      expect(vi.mocked(run.deps.registry.setTranscriptPath).mock.calls.at(-1)).toEqual(['a1', null])
    })

    // M2: the carry happens before the old process stops, so lines it wrote while stopping must still reach the target.
    it('copies the lines the old process wrote while it stopped, after it exited and before the new one starts', async () => {
      const source = join(from, 'projects', '-work', `${ID}.jsonl`), target = join(to, 'projects', '-work', `${ID}.jsonl`)
      const prepared = vi.fn()
      let seen = ''
      vi.mocked(restartAgent).mockImplementationOnce((async (_s: unknown, _b: unknown, deps: { prepareResume?: () => Promise<void> }) => {
        // The old engine is still writing when it is told to stop; the first carry has already happened.
        expect(readFileSync(target, 'utf8')).toBe('{}\n')
        appendFileSync(source, '{"late":1}\n')
        await deps.prepareResume?.()
        seen = readFileSync(target, 'utf8')
        return { ok: true, resumed: true, processIdentity: newProcess }
      }) as never)
      const run = setup(row(), { profileHomes: () => [to], paneSwapDeps: vi.fn(() => ({ prepareResume: prepared })) as never })
      expect(await run.restart('a1', undefined, to)).toMatchObject({ ok: true })
      expect(seen).toBe('{}\n{"late":1}\n')
      // The engine's own resume repair runs after the copy, on the file it was copied to.
      expect(prepared).toHaveBeenCalledOnce()
    })

    it('copies the late lines to the default account too', async () => {
      vi.mocked(carryClaudeTranscript).mockReturnValueOnce({ transcriptPath: '/t', copied: true }).mockReturnValueOnce({ transcriptPath: '/t', copied: true })
      vi.mocked(restartAgent).mockImplementationOnce((async (_s: unknown, _b: unknown, deps: { prepareResume?: () => Promise<void> }) => {
        await deps.prepareResume?.()
        return { ok: true, resumed: true, processIdentity: newProcess }
      }) as never)
      const run = setup(row({ cwd: undefined } as never))
      await run.restart('a1', undefined, null)
      expect(vi.mocked(carryClaudeTranscript).mock.calls).toEqual([[from, undefined, '', ID], [from, undefined, '', ID]])
    })

    it('copies again even where the swap brings no resume step of its own', async () => {
      const source = join(from, 'projects', '-work', `${ID}.jsonl`), target = join(to, 'projects', '-work', `${ID}.jsonl`)
      vi.mocked(restartAgent).mockImplementationOnce((async (_s: unknown, _b: unknown, deps: { prepareResume?: () => Promise<void> }) => {
        appendFileSync(source, '{"late":2}\n')
        await deps.prepareResume?.()
        return { ok: true, resumed: true, processIdentity: newProcess }
      }) as never)
      const run = setup(row(), { profileHomes: () => [to] })
      await run.restart('a1', undefined, to)
      expect(readFileSync(target, 'utf8')).toBe('{}\n{"late":2}\n')
    })

    // M3: a throw, or the harness no longer being this operation's after the outcome, rolls the row back too.
    it('puts the row back when the swap throws', async () => {
      vi.mocked(restartAgent).mockRejectedValueOnce(new Error('tmux gone'))
      const run = setup(row(), { profileHomes: () => [to] })
      await expect(run.restart('a1', undefined, to)).rejects.toThrow('tmux gone')
      expect(vi.mocked(run.deps.registry.setClaudeHome).mock.calls).toEqual([['a1', to], ['a1', from]])
      expect(vi.mocked(run.deps.registry.setTranscriptPath).mock.calls.at(-1)).toEqual(['a1', join(from, 'projects', '-work', `${ID}.jsonl`)])
    })

    it('puts the row back when preparing the swap throws', async () => {
      const run = setup(row(), { profileHomes: () => [to], paneSwapDeps: vi.fn(() => { throw new Error('no deps') }) as never })
      await expect(run.restart('a1', undefined, to)).rejects.toThrow('no deps')
      expect(vi.mocked(run.deps.registry.setClaudeHome).mock.calls.at(-1)).toEqual(['a1', from])
    })

    it('puts the row back when the harness is no longer this operation\'s after the swap', async () => {
      const run = setup(row(), { profileHomes: () => [to] })
      vi.mocked(restartAgent).mockImplementationOnce((async () => { run.state.live = false; return { ok: true, resumed: true, processIdentity: newProcess } }) as never)
      expect(await run.restart('a1', undefined, to)).toEqual(changed)
      expect(vi.mocked(run.deps.registry.setClaudeHome).mock.calls).toEqual([['a1', to], ['a1', from]])
    })

    it('preserves the launch shell account on an ordinary restart without a recorded home', async () => {
      const shell = vi.fn(async () => ({ ok: true, overrides: { env: { GRID_KEY: 'k', CLAUDE_CONFIG_DIR: from }, clearEnv: ['X'] } }))
      const run = setup(row({ claudeHome: null } as never), { relaunchOverrides: shell as never })
      expect(await run.restart('a1')).toMatchObject({ ok: true })
      const overrides = vi.mocked(run.deps.paneSwapDeps).mock.calls[0][2] as { env: Record<string, string>; clearEnv: string[] }
      expect(overrides.env).toEqual({ GRID_KEY: 'k', CLAUDE_CONFIG_DIR: from })
      expect(overrides.clearEnv).toEqual(['X'])
      expect(carryClaudeTranscript).not.toHaveBeenCalled()
    })

    it('clears a stale pane account when neither the row nor the launch sets one', async () => {
      const plain = vi.fn(async () => ({ ok: true, overrides: { env: { GRID_KEY: 'k' }, clearEnv: ['X'] } }))
      const run = setup(row({ claudeHome: null } as never), { relaunchOverrides: plain as never })
      expect(await run.restart('a1')).toMatchObject({ ok: true })
      const overrides = vi.mocked(run.deps.paneSwapDeps).mock.calls[0][2] as { env: Record<string, string>; clearEnv: string[] }
      expect(overrides.env).toEqual({ GRID_KEY: 'k' })
      expect(overrides.clearEnv).toEqual(['X', 'CLAUDE_CONFIG_DIR'])
      expect(carryClaudeTranscript).not.toHaveBeenCalled()
      expect(run.deps.registry.setClaudeHome).not.toHaveBeenCalled()
    })

    it('never starts a fresh conversation when an account move cannot resume', async () => {
      const actual = await vi.importActual<typeof import('../../lib/restartAgent.js')>('../../lib/restartAgent.js')
      vi.mocked(restartAgent).mockImplementationOnce(actual.restartAgent)
      const launches: unknown[] = []
      const run = setup(row(), { profileHomes: () => [to], paneSwapDeps: vi.fn(() => ({
        holdOpen: async () => ({ ok: true }), terminate: async () => 'gone',
        buildArgv: (options: unknown) => { launches.push(options); return ['claude'] },
        respawn: async () => ({ ok: true }), waitForProcess: async () => null, log: () => {},
      })) as never })
      expect(await run.restart('a1', undefined, to)).toMatchObject({ ok: false })
      expect(launches).toEqual([{ bypassPermission: true, resumeSessionId: ID }])
    })

    it.each(['copy', 'resume', 'throw'] as const)('recovers the original conversation after a post-stop %s failure', async failure => {
      vi.mocked(restartAgent).mockImplementationOnce(async (_session, _bypass, deps) => {
        if (failure === 'copy') vi.mocked(carryClaudeTranscript).mockImplementationOnce(() => { throw new Error('disk full') })
        try { await deps.prepareResume?.() } catch { return { ok: false, detail: 'copy failed' } }
        if (failure === 'throw') throw new Error('resume failed')
        return { ok: false, detail: 'resume failed' }
      })
      const run = setup(row(), { profileHomes: () => [to] })
      await run.restart('a1', undefined, to).catch(() => undefined)
      expect(restartAgent).toHaveBeenCalledTimes(2)
      expect(vi.mocked(restartAgent).mock.calls[1][0]).toMatchObject({ sessionId: ID, resumeOnly: true })
      const recovery = vi.mocked(run.deps.paneSwapDeps).mock.calls[1]
      expect(recovery[0]).toMatchObject({ claudeHome: from, transcriptPath: join(from, 'projects', '-work', `${ID}.jsonl`) })
      expect(recovery[2].env.CLAUDE_CONFIG_DIR).toBe(from)
      expect(run.deps.registry.updateProcessIdentity).toHaveBeenCalledWith('a1', newProcess, 'none')
    })

    it('leaves another engine\'s relaunch environment as it is', async () => {
      const run = setup(row({ engine: 'codex', claudeHome: null } as never))
      await run.restart('a1')
      expect(vi.mocked(run.deps.paneSwapDeps).mock.calls[0][2]).toEqual({ env: { GRID_KEY: 'k' }, clearEnv: [] })
    })

    it('a restart without claudeHome is unchanged', async () => {
      const run = setup(row())
      expect(await run.restart('a1')).toMatchObject({ ok: true })
      expect(carryClaudeTranscript).not.toHaveBeenCalled()
      expect(run.deps.registry.setClaudeHome).not.toHaveBeenCalled()
      expect(run.deps.registry.setTranscriptPath).not.toHaveBeenCalled()
      expect(vi.mocked(run.deps.paneSwapDeps).mock.calls[0][2]).toEqual({ env: { GRID_KEY: 'k' }, clearEnv: [] })
      expect(run.deps.restartJobs.run).toHaveBeenCalledWith('a1', expect.any(Function), 'restart', undefined)
    })

    it('another account asked for while one runs is a different restart', async () => {
      vi.mocked(carryClaudeTranscript).mockReturnValueOnce({ transcriptPath: '/t', copied: false }).mockReturnValueOnce({ transcriptPath: '/t', copied: false })
      const run = setup(row(), { profileHomes: () => [to], relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: { env: {}, clearEnv: [] } })) as never })
      await run.restart('a1', undefined, to)
      expect(run.deps.restartJobs.run).toHaveBeenCalledWith('a1', expect.any(Function), 'restart', JSON.stringify({ claudeHome: to }))
      await run.restart('a1', ['--chrome'], null)
      expect(vi.mocked(run.deps.restartJobs.run).mock.calls[1][3]).toBe(JSON.stringify({ launchArgs: ['--chrome'], claudeHome: null }))
    })
  })
})

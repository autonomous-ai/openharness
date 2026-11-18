import { storedGridFixture } from '../../testing/gridCredentials.js'
import { homedir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEngineLaunchArgv } from '../../lib/engineLaunch.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { AgentRestartCoordinator, bypassPermissionFor, restartAgent } from '../../lib/restartAgent.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { processLaunchArgs } from '../../lib/processTable.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import { commitRelaunchedEngine, createAgentRestarter, type RestartDeps } from './restart.js'
import { resolvePaneEngineProcess } from '../../lib/paneEngineProcess.js'
import type { RestartTarget } from '../../lib/terminalBackend.js'
import { GUEST_HARNESS_REFUSAL } from '../guestPolicy.js'
import { TerminalAgentReconciler } from '../../lib/terminalAgentReconciler.js'

vi.mock('../../lib/engineLaunch.js', async (real) => ({
  ...await real<object>(),
  buildEngineLaunchArgv: vi.fn(() => ['zsh', '-l']),
}))
vi.mock('../../lib/restartAgent.js', async (real) => ({
  ...await real<object>(),
  bypassPermissionFor: vi.fn(async (_s: unknown, live: () => Promise<boolean>) => live()),
  restartAgent: vi.fn(async () => ({ ok: true, resumed: true, processIdentity: { pid: 2, startMarker: 'new', executable: '/bin/claude' } })),
}))
vi.mock('../../lib/processTable.js', async (real) => ({
  ...await real<object>(),
  processLaunchArgs: vi.fn(async () => '/bin/claude --model opus -c model_provider=grid'),
}))
vi.mock('../../lib/workspaceCheck.js', () => ({ workspaceMissing: vi.fn(() => null) }))
vi.mock('../../lib/paneEngineProcess.js', () => ({ resolvePaneEngineProcess: vi.fn() }))

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
      confirmLaunch: vi.fn<RestartDeps['registry']['confirmLaunch']>(async (_id, input, authority) => {
        if (!refreshed || authority?.current?.() === false) return { state: 'not-published' }
        const { gridLaunchRecord, ...fields } = input
        Object.assign(refreshed, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)), { active: true, launch: { state: 'ready' } },
          gridLaunchRecord === undefined ? {} : { gridLaunch: gridLaunchRecord?.override ?? null, gridWebSearch: gridLaunchRecord?.webSearch ?? null })
        return { state: 'confirmed', entry: structuredClone(refreshed) }
      }),
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
    relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: { env: { GRID_KEY: 'k' } } })) as never,
    downgradedPermission: vi.fn(async (_s, bypass: boolean) => ({ bypassPermission: bypass, permissionMode: 'auto' })) as never,
    liveBypassPermission: vi.fn(async () => true),
    paneSwapDeps: vi.fn(() => ({ swap: true })) as never,
    restartHeld: vi.fn(() => null),
    native: vi.fn(async () => ({ ok: true, launch: { current: () => true } })) as never,
    ...over,
  }
  return { deps, state, tmuxBackend, restart: createAgentRestarter(deps) }
}

const changed = { ok: false, error: 'AGENT_CHANGED', detail: 'The harness changed or stopped during restart.' }

it.each(['/work', null])('prepares optional values once for the final restart owner with cwd %s before any stop', async cwd => {
  try {
  const run = setup(agent({ cwd }))
  const settings = { values: { instructions: 'owner optional', settings: null }, current: () => true }
  const prepareSettings = vi.fn(async () => { expect(run.deps.paneSwapDeps).not.toHaveBeenCalled(); return settings })
  const native = { current: () => true, prepareSettings } as never
  vi.mocked(run.deps.relaunchOverrides).mockResolvedValue({ ok: true, overrides: { native, env: {}, extraArgs: [], clearEnv: [] } })
  await run.restart('a1')
  expect(prepareSettings).toHaveBeenCalledOnce()
  expect(run.deps.paneSwapDeps).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), expect.objectContaining({ native, settings }), 'auto', expect.any(Function))
  } finally { vi.clearAllMocks() }
})

it('holds restart without its native preparation owner before stopping the running engine', async () => {
  const run = setup(agent(), { native: undefined })
  expect(await run.restart('a1')).toMatchObject({ ok: false, error: 'NATIVE_LAUNCH_HELD' })
  expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
  expect(run.deps.paneSwapDeps).not.toHaveBeenCalled()
})

describe('durable restart publication', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it.each(['cancelled', 'missing', 'empty receipt', 'replaced receipt'] as const)('keeps the hold without readiness when %s', async phase => {
    const run = setup()
    const place = { runtime, backend: run.tmuxBackend } as unknown as RestartTarget
    if (phase === 'missing') vi.mocked(run.deps.registry.byAgent).mockReturnValue(undefined)
    if (phase === 'empty receipt') vi.mocked(run.deps.registry.confirmLaunch).mockResolvedValue({ state: 'confirmed', entry: null })
    if (phase === 'replaced receipt') vi.mocked(run.deps.registry.confirmLaunch).mockResolvedValue({ state: 'confirmed', entry: agent({ sessionId: 'another' }) })
    expect(await commitRelaunchedEngine(run.deps, 'a1', newProcess, null, place, () => phase !== 'cancelled'))
      .toBe(phase === 'cancelled' ? 'changed' : phase === 'missing' ? 'vanished' : 'changed after commit')
    expect(releaseHold).not.toHaveBeenCalled()
    expect(run.deps.announceSession).not.toHaveBeenCalled()
    expect(run.deps.refreshGridAssignment).not.toHaveBeenCalled()
  })

  it.each(['same', 'gone', 'replaced', 'executable'] as const)('rechecks native readiness before publication: %s', async proof => {
    const run = setup()
    const publish = vi.mocked(run.deps.registry.confirmLaunch).getMockImplementation()!
    vi.mocked(run.deps.registry.confirmLaunch).mockImplementation(async (id, input, authority) => {
      await authority?.refresh?.()
      return publish(id, input, authority)
    })
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(proof === 'gone' ? null : proof === 'replaced' ? { ...newProcess, startMarker: 'replacement' }
      : proof === 'executable' ? { ...newProcess, executable: 'other' } : newProcess)
    const result = commitRelaunchedEngine(run.deps, 'a1', newProcess, null, { runtime, backend: run.tmuxBackend } as unknown as RestartTarget, () => true)
    if (proof === 'same') expect(await result).toMatchObject({ processIdentity: newProcess })
    else {
      await expect(result).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
      expect(releaseHold).not.toHaveBeenCalled()
      expect(run.deps.announceSession).not.toHaveBeenCalled()
    }
  })

  it.each(['alive', 'gone', 'unknown', 'dead'] as const)('rechecks a replacement shell: %s', async proof => {
    const run = setup(terminal())
    const paneState = vi.fn(async () => proof === 'gone' || proof === 'unknown' ? proof : { dead: proof === 'dead', engineExit: null })
    const publish = vi.mocked(run.deps.registry.confirmLaunch).getMockImplementation()!
    vi.mocked(run.deps.registry.confirmLaunch).mockImplementation(async (id, input, authority) => {
      await authority?.refresh?.()
      return publish(id, input, authority)
    })
    const result = commitRelaunchedEngine(run.deps, 'a1', null, null, { runtime, backend: { ...run.tmuxBackend, paneState } } as unknown as RestartTarget, () => true)
    if (proof === 'alive') expect(await result).toMatchObject({ engine: 'terminal' })
    else {
      await expect(result).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
      expect(releaseHold).not.toHaveBeenCalled()
      expect(run.deps.announceSession).not.toHaveBeenCalled()
    }
  })
})

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

  it.each(['starting', 'held'] as const)('does not replace an unbound native %s launch with a generic fresh restart', async state => {
    const run = setup(agent({ sessionId: '', launch: state === 'starting' ? { state, nativeToken: 'original' }
      : { state, nativeToken: 'original', service: 'native', detail: 'Original request held' } }))
    expect(await run.restart('a1')).toMatchObject({ ok: false, error: 'NATIVE_LAUNCH_HELD' })
    expect(run.deps.restartHeld).not.toHaveBeenCalled()
    expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
    expect(restartAgent).not.toHaveBeenCalled()
  })

  it.each(['inspection', 'settings', 'permission', 'snapshot'] as const)('preserves the live process when restart loses %s evidence', async stage => {
    let nativeCurrent = true
    const launch = { current: () => nativeCurrent, prepareSettings: async () => { if (stage === 'settings') run.state.live = false; return null } } as never
    const run = setup(agent(), {
      native: async () => { if (stage === 'inspection') run.state.live = false; return { ok: true, launch } },
      relaunchOverrides: async () => ({ ok: true, overrides: { native: launch, env: {}, extraArgs: [], clearEnv: [] } }),
      downgradedPermission: async () => {
        if (stage === 'snapshot') nativeCurrent = false
        return { bypassPermission: false, ...(stage === 'permission' ? { nativeHold: 'Waiting for native flags.' } : {}) }
      },
    })
    expect(await run.restart('a1')).toMatchObject({ ok: false, error: stage === 'inspection' || stage === 'settings' ? 'AGENT_CHANGED' : 'NATIVE_LAUNCH_HELD' })
    expect(restartAgent).not.toHaveBeenCalled()
    expect(run.deps.registry.confirmLaunch).not.toHaveBeenCalled()
  })

  it('holds native installation before killing the live process, without an independent shell probe', async () => {
    const native = vi.fn(async () => ({ ok: false as const, error: 'NATIVE_LAUNCH_HELD' as const, unavailable: 'native' as const, detail: 'Waiting for installation' }))
    const run = setup(agent(), { native })
    expect(await run.restart('a1')).toMatchObject({ unavailable: 'native' })
    expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
    expect(restartAgent).not.toHaveBeenCalled()
  })

  it('passes its one native snapshot through restart preparation and permission checks', async () => {
    const launch = { current: () => true } as never
    const run = setup(agent(), { native: async () => ({ ok: true, launch }),
      relaunchOverrides: vi.fn(async () => ({ ok: true as const, overrides: { native: launch, env: {}, extraArgs: [], clearEnv: [] } })),
    })
    expect(await run.restart('a1')).toMatchObject({ ok: true })
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
    const dispatched: string[][] = []
    const respawn = vi.fn(async (command: () => string[]) => { dispatched.push(command()); return { ok: true } })
    const keepAbandoned = vi.fn(), buildArgv = vi.fn(options => ['fixture-engine', options.resumeSessionId ?? 'fresh'])
    const run = setup(agent({ resumeOnly: true }), { paneSwapDeps: () => ({
      holdOpen: async () => ({ ok: true }), terminate: async () => 'gone', respawn,
      waitForProcess: async () => null, buildArgv, keepAbandoned, log: () => {},
    }) })
    expect(await run.restart('a1')).toMatchObject({ ok: false, error: 'RESTART_FAILED' })
    expect(respawn).toHaveBeenCalledExactlyOnceWith(expect.any(Function))
    expect(dispatched).toEqual([['fixture-engine', 's1']])
    expect(keepAbandoned).not.toHaveBeenCalled()
    expect(run.deps.registry.confirmLaunch).not.toHaveBeenCalled()
  })

  describe('with new launch words', () => {
    const WORDS = ['--chrome']

    it('builds the relaunch with them and saves them on the record only after the engine is back', async () => {
      const order: string[] = []
      const run = setup(agent(), {
        relaunchOverrides: vi.fn(async () => { order.push('build'); return { ok: true as const, overrides: { env: {}, extraArgs: [], clearEnv: [] } } }),
      })
      const publish = run.deps.registry.confirmLaunch
      const implementation = vi.mocked(publish).getMockImplementation()!
      vi.mocked(publish).mockImplementation(async (...args) => { order.push('save'); return implementation(...args) })
      vi.mocked(restartAgent).mockImplementationOnce(async () => { order.push('restart'); return { ok: true, resumed: true, processIdentity: newProcess } })
      expect(await run.restart('a1', WORDS)).toMatchObject({ ok: true })
      expect(run.deps.relaunchOverrides).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentId: 'a1', launchArgs: WORDS }), expect.any(Function), expect.objectContaining({ current: expect.any(Function) }))
      expect(order).toEqual(['build', 'restart', 'save'])
      expect(run.deps.registry.confirmLaunch).toHaveBeenCalledExactlyOnceWith('a1', expect.objectContaining({ launchArgs: WORDS }), expect.anything())
      // Asked as its own variant of a restart, so another ask with other words is not answered by this launch.
      expect(run.deps.restartJobs.run).toHaveBeenCalledWith('a1', expect.any(Function), 'restart', JSON.stringify(WORDS))
    })

    it('clears them with an empty list: built without, and removed from the record once the engine is back', async () => {
      const run = setup(agent({ launchArgs: ['--old'] } as Partial<RegisteredSession>))
      expect(await run.restart('a1', [])).toMatchObject({ ok: true })
      expect(run.deps.relaunchOverrides).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ launchArgs: [] }), expect.any(Function), expect.objectContaining({ current: expect.any(Function) }))
      expect(run.deps.registry.confirmLaunch).toHaveBeenCalledExactlyOnceWith('a1', expect.objectContaining({ launchArgs: [] }), expect.anything())
    })

    it('without them, relaunches from the row itself and never writes the record', async () => {
      const row = agent({ launchArgs: ['--saved'] } as Partial<RegisteredSession>)
      const run = setup(row)
      expect(await run.restart('a1')).toMatchObject({ ok: true })
      expect(run.deps.relaunchOverrides).toHaveBeenCalledWith(expect.objectContaining({ agentId: row.agentId }), expect.objectContaining({ launchArgs: ['--saved'] }), expect.any(Function), expect.objectContaining({ current: expect.any(Function) }))
      expect(vi.mocked(run.deps.registry.confirmLaunch).mock.calls[0]![1].launchArgs).toBeUndefined()
      expect(run.deps.registry.byAgent('a1')?.launchArgs).toEqual(['--saved'])
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
      expect(run.deps.registry.confirmLaunch).not.toHaveBeenCalled()
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
      expect(run.deps.registry.confirmLaunch).toHaveBeenCalledExactlyOnceWith('a1', expect.objectContaining({ launchArgs: ['--first'] }), expect.anything())
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

    it.each(['missing executable', 'unknown executable'] as const)('holds a %s before touching the running agent', async detail => {
      const held = { ok: false as const, error: 'NATIVE_LAUNCH_HELD' as const, unavailable: 'native' as const, detail }
      const run = setup(agent(), { native: vi.fn(async () => held) })
      expect(await run.restart('a1')).toEqual(held)
      expect(run.deps.relaunchOverrides).not.toHaveBeenCalled()
      expect(run.deps.agentReconciler.holdRoute).not.toHaveBeenCalled()
      expect(restartAgent).not.toHaveBeenCalled()
    })

    it('stops touching the agent when preparation is overtaken', async () => {
      const run = setup()
      vi.mocked(run.deps.native!).mockImplementationOnce(async () => {
        run.state.live = false
        return { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Unverified' }
      })
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
      expect(backend.releaseHold).toHaveBeenCalledWith(pty, expect.any(Function))
      expect(run.tmuxBackend.respawn).not.toHaveBeenCalled()
      expect(releaseHold).not.toHaveBeenCalled()
      expect(run.deps.agentReconciler.holdRoute).toHaveBeenCalledWith(terminalRouteKey(pty), null)
    })

    it('swaps an engine in that pane and hands it back to that backend', async () => {
      const backend = ptyBackend()
      const row = agent({ runtimes: [pty] })
      const run = setup(row, { terminals: { backendFor: () => backend as never } })
      expect(await run.restart('a1')).toMatchObject({ ok: true, resumed: true })
      expect(run.deps.paneSwapDeps).toHaveBeenCalledWith(row, { backend, runtime: pty }, { env: { GRID_KEY: 'k' } }, 'auto', expect.any(Function))
      expect(backend.releaseHold).toHaveBeenCalledWith(pty, expect.any(Function))
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
      expect(await run.restart('a1')).toEqual({ ok: true, session: expect.objectContaining({ agentId: 'a1', engine: 'terminal', launch: { state: 'ready' }, processIdentity: null }), resumed: false })
      expect(buildEngineLaunchArgv).toHaveBeenCalledWith('terminal', { cwd: '/work', terminalHint: { machineName: 'studio' } })
      expect(run.tmuxBackend.respawn).toHaveBeenCalledWith(runtime, { command: ['zsh', '-l'], cwd: homedir() })
      expect(releaseHold).toHaveBeenCalledWith(runtime, expect.any(Function))
      expect(run.deps.registry.confirmLaunch).toHaveBeenCalledWith('a1', expect.anything(), expect.anything())
      expect(run.deps.announceSession).toHaveBeenCalledWith(expect.objectContaining({ engine: 'terminal', launch: { state: 'ready' }, processIdentity: null }))
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
      expect(cleared.deps.announceSession).not.toHaveBeenCalled()
    })

    it('fails, without announcing, when the row vanished mid-restart', async () => {
      const run = setup(terminal(), {}, null)
      expect(await run.restart('a1')).toEqual(changed)
      expect(run.deps.announceSession).not.toHaveBeenCalled()
    })
  })

  describe('an engine', () => {
    it('comes back in the same pane with its launch, its permission and its conversation', async () => {
      const run = setup()
      expect(await run.restart('a1')).toEqual({ ok: true, session: expect.objectContaining({ agentId: 'a1', launch: { state: 'ready' }, processIdentity: newProcess }), resumed: true })
      expect(bypassPermissionFor).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', engine: 'claude' }), expect.any(Function))
      expect(run.deps.liveBypassPermission).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', engine: 'claude' }))
      expect(run.deps.downgradedPermission).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', engine: 'claude' }), true, 'restart', undefined)
      expect(run.deps.paneSwapDeps).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', sessionId: 's1' }), { backend: run.tmuxBackend, runtime }, { env: { GRID_KEY: 'k' } }, 'auto', expect.any(Function))
      const [target, bypass, swapDeps] = vi.mocked(restartAgent).mock.calls[0]
      expect(target).toEqual({ engine: 'claude', sessionId: 's1' })
      expect(bypass).toBe(true)
      expect(swapDeps).toMatchObject({ swap: true })
      expect(swapDeps.isCurrent?.()).toBe(false)
      expect(vi.mocked(run.deps.registry.confirmLaunch).mock.calls[0]![1].gridLaunchRecord).toBeUndefined()
      // Its command line, where a Codex or pi grid's address and model are: never its executable alone.
      expect(run.deps.registry.confirmLaunch).toHaveBeenCalledWith('a1', expect.objectContaining({ processIdentity: newProcess, grid: null }), expect.anything())
      expect(run.deps.registry.confirmLaunch).toHaveBeenCalledWith('a1', expect.anything(), expect.anything())
      expect(releaseHold).toHaveBeenCalledWith(runtime, expect.any(Function))
      expect(run.deps.announceSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', launch: { state: 'ready' }, processIdentity: newProcess }))
      expect(run.deps.refreshGridAssignment).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', launch: { state: 'ready' }, processIdentity: newProcess }))
      expect(console.log).toHaveBeenCalledWith('[restart] a1 claude · resumed')
      expect(run.deps.agentReconciler.holdRoute).toHaveBeenCalledWith(routeKey, null)
      expect(run.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)
    })

    it('without a mode or a yes, launches with no mode and no bypass; a fresh session on a grid says both', async () => {
      const grid = agent({ gridLaunch: { networkName: 'Home' } } as Partial<RegisteredSession>)
      const run = setup(grid, { downgradedPermission: vi.fn(async () => ({ bypassPermission: false })) as never })
      vi.mocked(restartAgent).mockResolvedValueOnce({ ok: true, resumed: false, processIdentity: newProcess } as never)
      expect(await run.restart('a1')).toEqual({ ok: true, session: grid, resumed: false })
      expect(run.deps.paneSwapDeps).toHaveBeenCalledWith(grid, { backend: run.tmuxBackend, runtime }, { env: { GRID_KEY: 'k' } }, null, expect.any(Function))
      expect(vi.mocked(restartAgent).mock.calls[0][1]).toBe(false)
      expect(console.log).toHaveBeenCalledWith('[restart] a1 claude · fresh session · grid Home')
    })

    it('writes on the row the grid its launch record puts the engine on, never the grid the row had', async () => {
      const old = { baseUrl: 'https://grid.example/old/relay', model: null }
      // The saved API's endpoint as saved now: the record a relaunch refreshes (apiModels.ts `refreshApiLaunch`).
      const override = { networkId: 'api', networkName: 'Saved', baseUrl: 'https://saved.example/now/v1', apiKey: 'k', model: 'm' }
      const onGrid = setup(agent({ grid: old, gridLaunch: storedGridFixture({ ...override, baseUrl: 'https://saved.example/then/v1' }) } as Partial<RegisteredSession>), {
        relaunchOverrides: vi.fn(async () => ({ ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [], gridLaunchRecord: { override, webSearch: 'on' } } })) as never,
      })
      await onGrid.restart('a1')
      expect(onGrid.deps.registry.confirmLaunch).toHaveBeenCalledWith('a1', expect.objectContaining({ processIdentity: newProcess, grid: { baseUrl: 'https://saved.example/now/v1', model: 'm' } }), expect.anything())
      // A row discovery adopted from a relay URL the person set in their own shell: its relaunch runs on its own login.
      const adopted = setup(agent({ grid: old, gridLaunch: null } as Partial<RegisteredSession>))
      await adopted.restart('a1')
      expect(adopted.deps.registry.confirmLaunch).toHaveBeenCalledWith('a1', expect.objectContaining({ processIdentity: newProcess, grid: null }), expect.anything())
    })

    it('says why the swap failed, and lets the route go', async () => {
      vi.mocked(restartAgent).mockResolvedValueOnce({ ok: false, detail: 'could not re-arm the pane' } as never)
      const run = setup()
      expect(await run.restart('a1')).toEqual({ ok: false, error: 'RESTART_FAILED', detail: 'could not re-arm the pane' })
      expect(run.deps.registry.confirmLaunch).not.toHaveBeenCalled()
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
      expect(swapped.deps.registry.confirmLaunch).not.toHaveBeenCalled()
      expect(swapped.deps.agentReconciler.releaseRoute).toHaveBeenCalledWith(routeKey)

      const committing = setup()
      vi.mocked(committing.deps.registry.confirmLaunch).mockImplementationOnce(async () => { committing.state.live = false; return { state: 'not-published' } })
      expect(await committing.restart('a1')).toEqual(changed)
      expect(committing.deps.announceSession).not.toHaveBeenCalled()

      const cleared = setup()
      releaseHold.mockImplementationOnce(async () => { cleared.state.live = false })
      expect(await cleared.restart('a1')).toEqual(changed)
      expect(cleared.deps.announceSession).not.toHaveBeenCalled()
    })

    it('fails, without announcing, when the row vanished mid-restart', async () => {
      const run = setup(agent(), {}, null)
      expect(await run.restart('a1')).toEqual(changed)
      expect(run.deps.announceSession).not.toHaveBeenCalled()
      expect(run.deps.agentReconciler.holdRoute).not.toHaveBeenCalled()
    })
  })
})

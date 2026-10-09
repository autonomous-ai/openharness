import { describe, expect, it, vi } from 'vitest'
import { registry as realRegistry, type AgentLaunch, type ProcessIdentity, type RegisteredSession } from './registry.js'
import type { TerminalRuntimeRef, TmuxRuntimeRef } from './terminalTypes.js'
import { GRID_CREDENTIAL_REQUIRED, heldLaunch, restoreAgents, tmuxSurvey, type RestoreAgentsDeps, type RestoreLaunch, type RestoreLaunchResult } from './restoreAgents.js'
import type { GridLaunchOverride } from './gridLaunch.js'
import { createStopAgentService, type StopAgentServiceDeps } from './stopAgentService.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import { createHeldLaunches } from '../core/agents/heldLaunches.js'
import { createPaneSwap } from '../core/agents/swap.js'
import { createPaneOperations } from '../core/agents/paneOperations.js'

vi.mock('./captureResumeIdentity.js', () => ({ captureResumeIdentity: async (entry: RegisteredSession) => entry }))

const GRID: GridLaunchOverride = {
  networkId: 'grid-abc',
  networkName: 'Team grid',
  baseUrl: 'https://grid.example/grid-abc/relay/v1',
  apiKey: 'gridkey-abc123',
}

const identity = (pid: number): ProcessIdentity => ({ pid, executable: 'claude', startMarker: `start ${pid}` })

function row(overrides: Partial<RegisteredSession> = {}): RegisteredSession {
  return {
    schemaVersion: 2,
    active: false,
    launch: { state: 'ready' },
    agentId: 'agent-a',
    sessionId: 'session-a',
    boundAt: 1,
    engine: 'claude',
    transcriptPath: null,
    projectDir: 'demo',
    cwd: '/tmp/demo',
    runtimes: [{ backend: 'tmux', paneId: '%3' }],
    primaryRuntimeKey: 'tmux\u0000%3',
    tmuxPane: '%3',
    source: null,
    title: null,
    model: null,
    cliVersion: null,
    processIdentity: null,
    registeredAt: 1,
    touchedAt: 1,
    lastHookAt: 1,
    lastTranscriptAt: 1,
    ...overrides,
  }
}

interface Harness {
  deps: RestoreAgentsDeps
  calls: string[]
  rows: Map<string, RegisteredSession>
  launches: Array<{ agentId: string; resumeSessionId?: string }>
  /** What createPane / respawn were handed, per agent — the env is where a grid's key travels. */
  launched: Array<{ agentId: string; launch: RestoreLaunch }>
  /** Per-pane scripted answers for probeProcess; shifted on each call. */
  probes: Map<string, Array<ProcessIdentity | null>>
  states: Map<string, Array<{ dead: boolean; engineExit?: number | null } | 'gone' | 'unknown'>>
  nextPane: string[]
  paneCreates: number
  respawns: number
  transactionDepth: number
  released: string[]
}

function harness(rows: RegisteredSession[], opts: { livePanes?: string[]; alivePanes?: string[]; failCreate?: boolean; refuseLaunch?: boolean; budgetMs?: number; settleMs?: number } = {}): Harness {
  const h: Harness = {
    calls: [],
    rows: new Map(rows.map((r) => [r.agentId, r])),
    launches: [],
    launched: [],
    probes: new Map(),
    states: new Map(),
    nextPane: ['%0', '%1', '%2'],
    paneCreates: 0,
    respawns: 0,
    transactionDepth: 0,
    released: [],
    deps: undefined as unknown as RestoreAgentsDeps,
  }
  const live = new Set(opts.livePanes ?? [])
  const note = (name: string) => { h.calls.push(`${name}${h.transactionDepth ? '@tx' : ''}`) }
  h.deps = {
    registry: {
      list: () => [...h.rows.values()],
      byAgent: (id) => h.rows.get(id),
      transaction: async (apply) => {
        h.transactionDepth++
        try { return await apply() } finally { h.transactionDepth-- }
      },
      clearProcessIdentity: (id) => { note(`clearIdentity:${id}`); const r = h.rows.get(id); if (r) r.processIdentity = null; return !!r },
      updateRuntimes: (id, runtimes: readonly TerminalRuntimeRef[], key) => {
        note(`updateRuntimes:${id}:${(runtimes[0] as TmuxRuntimeRef).paneId}`)
        const r = h.rows.get(id); if (!r) return false
        r.runtimes = [...runtimes]; r.primaryRuntimeKey = key ?? ''; r.active = true
        return true
      },
      setLaunch: (id, launch: AgentLaunch) => {
        note(`setLaunch:${id}:${launch.state}${launch.state === 'failed' ? `:${launch.error}` : ''}`)
        const r = h.rows.get(id); if (!r) return null
        r.launch = launch; return r
      },
      updateProcessIdentity: (id, pi) => { note(`updateIdentity:${id}:${pi.pid}`); const r = h.rows.get(id); if (r) r.processIdentity = pi; return !!r },
      unbindSession: (sid) => { note(`unbind:${sid}`); return true },
      inheritName: (from, to) => { note(`inheritName:${from}->${to}`) },
      releaseEngine: (id) => {
        note(`releaseEngine:${id}`)
        const r = h.rows.get(id); if (!r || !r.terminalHost) return null
        r.engine = 'terminal'; r.sessionId = ''; r.processIdentity = null; r.launch = { state: 'ready' }; r.active = true
        return r
      },
    },
    livePane: async (runtime) => (opts.alivePanes ?? []).includes(runtime.paneId),
    liveProcess: async (_entry, runtime) => live.has(runtime.paneId) ? identity(1000 + Number(runtime.paneId.slice(1))) : null,
    buildLaunch: async (entry, o) => {
      h.launches.push({ agentId: entry.agentId, ...(o.resumeSessionId ? { resumeSessionId: o.resumeSessionId } : {}) })
      if (opts.refuseLaunch) return { error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no way to point it at a grid' }
      // The shape cli.ts builds: a grid's env and argv when the row kept its launch, a profile's
      // CODEX_HOME otherwise. Only the presence matters here; gridLaunch.ts specs the contents.
      const grid = entry.gridLaunch
      const launch: RestoreLaunch = {
        argv: [entry.engine, ...(o.resumeSessionId ? ['--resume', o.resumeSessionId] : []), ...(grid ? ['--grid', grid.networkId] : [])],
        ...(grid ? { env: { GRID_API_KEY: grid.apiKey } } : entry.codexHome ? { env: { CODEX_HOME: entry.codexHome } } : {}),
      }
      return launch
    },
    createPane: async (entry, launch, control) => {
      note(`createPane:${entry.agentId}`)
      h.launched.push({ agentId: entry.agentId, launch })
      h.paneCreates++
      if (opts.failCreate) return { ok: false, reason: 'tmux said no' }
      control?.onDispatch?.()
      return { ok: true, runtime: { backend: 'tmux', paneId: h.nextPane.shift() ?? '%99' } }
    },
    respawn: async (runtime, launch, control) => {
      note(`respawn:${runtime.paneId}:${launch.argv.join(' ')}`)
      h.launched.push({ agentId: 'respawn', launch })
      h.respawns++
      control?.onDispatch?.()
      return { ok: true }
    },
    probeProcess: async (runtime) => {
      const queue = h.probes.get(runtime.paneId) ?? []
      return queue.length ? queue.shift()! : null
    },
    paneState: async (runtime) => {
      const queue = h.states.get(runtime.paneId) ?? []
      return queue.length ? queue.shift()! : { dead: false }
    },
    clearRemainOnExit: async (runtime) => { note(`clearRemainOnExit:${runtime.paneId}`) },
    holdRoute: (key) => { note(`hold:${key}`) },
    releaseRoute: (key) => { note(`release:${key}`); h.released.push(key) },
    triggerHint: async (runtime) => { note(`triggerHint:${runtime.paneId}`) },
    log: () => {},
    budgetMs: opts.budgetMs ?? 60_000,
    settleMs: opts.settleMs ?? 0,
    sleep: async () => {},
  }
  return h
}

/** A watch always ends in `finally { releaseRoute }`; the success path releases once more before the
 *  hint, so "settled" means at least `watches` releases and the LAST one came from a finally. */
const settled = (h: Harness, watches: number, successes = 0) =>
  vi.waitFor(() => { expect(h.released.length).toBe(watches + successes) })

describe('restore ownership across asynchronous work', () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void
    return { promise: new Promise<T>(done => { resolve = done }), resolve }
  }
  const held = () => row({ launch: heldLaunch('store'), dsh: 'test/package' })

  it('Stop beginning during Store preparation cancels restore before Stop removes the row', async () => {
    const h = harness([held()], { alivePanes: ['%3'] })
    const prepared = deferred<RestoreLaunchResult>()
    const saving = deferred<void>()
    const build = vi.fn(() => prepared.promise)
    h.deps.buildLaunch = build
    h.deps.only = new Set(['agent-a'])
    const stopJobs = new Map<string, Promise<void>>()
    h.deps.cancelled = id => stopJobs.has(id)
    const stop = createStopAgentService({
      registry: { resolve: (id: string) => h.rows.get(id) }, stopJobs,
      restartJobs: new AgentRestartCoordinator(), stoppedAgents: { save: vi.fn() },
    } as unknown as StopAgentServiceDeps)
    const restoring = restoreAgents(h.deps)
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce())
    const checkpoint = vi.fn(async () => { await saving.promise; throw new Error('test checkpoint cancelled') })
    const stopping = stop('agent-a', { checkpoint })
    const ended = expect(stopping).rejects.toThrow('test checkpoint cancelled')
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce())
    expect(h.rows.get('agent-a')?.launch?.state).toBe('held')
    prepared.resolve({ argv: ['must-not-launch'] })
    expect((await restoring).restored).toEqual([])
    expect(h.respawns).toBe(0)
    saving.resolve()
    await ended
  })

  it('a boot watch keeps the same epoch after pane-swap wiring is installed', async () => {
    const h = harness([row()])
    const restartJobs = new AgentRestartCoordinator()
    const probe = deferred<ProcessIdentity | null>()
    h.deps.revision = id => restartJobs.revision(id)
    h.deps.probeProcess = () => probe.promise
    await restoreAgents(h.deps)
    const swap = createPaneSwap({ restartJobs, byAgent: h.deps.registry.byAgent, tmuxBackend: null,
      prepareSessionResume: () => {}, keepAbandonedConversation: () => {} })
    expect(swap.restartJobs).toBe(restartJobs)
    probe.resolve(identity(8))
    await settled(h, 1, 1)
    expect(h.rows.get('agent-a')?.processIdentity).toEqual(identity(8))
  })

  it('a completed retarget invalidates the old watch even after its pin is released', async () => {
    const h = harness([row()], { settleMs: 10_000 })
    const jobs = new AgentRestartCoordinator()
    const sleeping = deferred<void>()
    const sleep = vi.fn(() => sleeping.promise)
    let pinned = false
    h.deps.revision = id => jobs.revision(id)
    h.deps.cancelled = () => pinned
    h.deps.sleep = sleep
    h.probes.set('%0', [identity(8)])
    h.states.set('%0', ['gone'])
    await restoreAgents(h.deps)
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce())
    pinned = true
    jobs.cancel('agent-a')
    pinned = false
    sleeping.resolve()
    await settled(h, 1)
    expect(h.respawns).toBe(1)
    expect(h.calls.some(call => call.startsWith('unbind:'))).toBe(false)
  })

  it('the held retry still runs inside its own restart coordinator job', async () => {
    const h = harness([held()], { alivePanes: ['%3'] })
    const jobs = new AgentRestartCoordinator()
    h.deps.revision = id => jobs.revision(id)
    h.deps.cancelled = () => false
    h.probes.set('%3', [identity(7)])
    const retry = createHeldLaunches({ registry: h.deps.registry, log: vi.fn(),
      restore: only => restoreAgents({ ...h.deps, only }) })
    await retry.boot(async () => {})
    expect(await jobs.run('agent-a', async () => {
      expect(jobs.busy('agent-a')).toBe(true)
      return retry.restartHeld('agent-a')!
    })).toMatchObject({ ok: true, resumed: true })
    await settled(h, 1, 1)
  })

  it.each(['allocation', 'respawn'] as const)('Stop joins only the dispatched %s and captures its committed pane', async phase => {
    const h = harness([held()], { alivePanes: phase === 'respawn' ? ['%3'] : [] })
    const operations = createPaneOperations()
    const stopJobs = new Map<string, Promise<void>>()
    h.deps.paneOperation = operations.run
    h.deps.paneAllocations = operations.runMany
    h.deps.paneBusy = operations.busy
    h.deps.cancelled = id => stopJobs.has(id)
    h.deps.only = new Set(['agent-a'])
    h.deps.waitingLaunch = () => ({ argv: ['wait'] })
    const reply = deferred<void>()
    const dispatched = vi.fn()
    const mark = vi.fn()
    h.deps.engineStarted = mark
    if (phase === 'allocation') h.deps.createPane = async (_entry, launch, control) => {
      expect(launch.argv).toEqual(['wait'])
      expect(control?.current?.()).toBe(true)
      dispatched()
      await reply.promise
      return { ok: true, runtime: { backend: 'tmux', paneId: '%10' } }
    }
    else h.deps.respawn = async (_runtime, _launch, control) => {
      expect(operations.busy('agent-a')).toBe(true)
      expect(control?.current?.()).toBe(true)
      control?.onDispatch?.()
      expect(mark).toHaveBeenCalledWith('session-a')
      expect(h.calls).toContain('hold:tmux\u0000%3')
      dispatched()
      await reply.promise
      return { ok: true }
    }
    const stop = createStopAgentService({
      registry: { resolve: (id: string) => h.rows.get(id) }, stopJobs, settlePane: operations.settle,
      restartJobs: new AgentRestartCoordinator(), stoppedAgents: { save: vi.fn() },
    } as unknown as StopAgentServiceDeps)
    const restoring = restoreAgents(h.deps)
    await vi.waitFor(() => expect(dispatched).toHaveBeenCalledOnce())
    const checkpoint = vi.fn(async (entry: RegisteredSession) => {
      expect(entry.runtimes).toEqual([{ backend: 'tmux', paneId: phase === 'allocation' ? '%10' : '%3' }])
      throw new Error('test checkpoint cancelled')
    })
    const ended = expect(stop('agent-a', { checkpoint })).rejects.toThrow('test checkpoint cancelled')
    await Promise.resolve()
    expect(checkpoint).not.toHaveBeenCalled()
    reply.resolve()
    await restoring
    await ended
    if (phase === 'allocation') {
      expect(h.respawns).toBe(0)
      expect(mark).not.toHaveBeenCalled()
    }
  })

  it('an old watcher cannot release a newer route hold or undo a competing lifecycle generation', async () => {
    const h = harness([row()])
    const jobs = new AgentRestartCoordinator()
    h.deps.revision = id => jobs.revision(id)
    const probe = deferred<ProcessIdentity | null>()
    const probing = vi.fn(() => probe.promise)
    h.deps.probeProcess = probing
    let generation = 0
    let held = false
    const releases: number[] = []
    h.deps.holdRoute = () => {
      const own = ++generation
      held = true
      return () => { releases.push(own); if (own === generation) held = false }
    }
    await restoreAgents(h.deps)
    await vi.waitFor(() => expect(probing).toHaveBeenCalledOnce())
    h.deps.holdRoute('tmux\u0000%0', 1000)
    await jobs.run('agent-a', async () => ({ ok: false, error: 'new restart' }))
    probe.resolve(identity(7))
    await vi.waitFor(() => expect(releases).toEqual([1]))
    expect(held).toBe(true)
    expect(h.calls.some(call => call.startsWith('updateIdentity'))).toBe(false)
    expect(h.respawns).toBe(1)
  })

  it.each(['create', 'respawn', 'reason'] as const)('a replacement during awaited pane %s is never overwritten', async operation => {
    const h = harness([held()], { alivePanes: operation === 'create' ? [] : ['%3'] })
    h.deps.only = new Set(['agent-a'])
    const pending = deferred<void>()
    const waiting = vi.fn(async () => { await pending.promise })
    h.deps.engineStarted = vi.fn()
    if (operation === 'create') h.deps.createPane = async () => { await waiting(); return { ok: true, runtime: { backend: 'tmux', paneId: '%new' } } }
    else h.deps.respawn = async () => { await waiting(); return { ok: true } }
    if (operation === 'reason') {
      h.deps.waitingLaunch = (_entry, launch) => ({ argv: ['wait', launch.detail] })
      h.deps.buildLaunch = async () => ({ held: 'store', detail: 'Review unconfirmed initialization', holdScope: 'workspace' })
    }
    const result = restoreAgents(h.deps)
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce())
    const replacement = row({ sessionId: 'replacement', launch: { state: 'ready' } })
    h.rows.set('agent-a', replacement)
    pending.resolve()
    expect(await result).toMatchObject({ restored: [], held: [], failed: [] })
    expect(h.rows.get('agent-a')).toEqual(replacement)
    expect(h.deps.engineStarted).not.toHaveBeenCalled()
    expect(h.calls.some(call => /updateRuntimes|setLaunch/.test(call))).toBe(false)
  })

  it.each([false, true])('fresh fallback preserves the conversation and exact held reason: terminal %s', async terminalHost => {
    const h = harness([row({ terminalHost })])
    h.deps.keepAbandoned = vi.fn()
    const build = h.deps.buildLaunch
    h.deps.buildLaunch = (entry, opts) => opts.resumeSessionId ? build(entry, opts)
      : Promise.resolve({ held: 'store', detail: 'Workspace preparation is unconfirmed; review required.', holdScope: 'workspace' })
    h.deps.waitingLaunch = (_entry, launch) => ({ argv: ['wait', launch.detail] })
    h.states.set('%0', [{ dead: true }])
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.rows.get('agent-a')).toMatchObject({ sessionId: 'session-a', engine: 'claude',
      launch: { state: 'held', detail: 'Workspace preparation is unconfirmed; review required.' } })
    expect(h.calls).toContain('respawn:%0:wait Workspace preparation is unconfirmed; review required.')
    expect(h.deps.keepAbandoned).not.toHaveBeenCalled()
    expect(h.calls.some(call => /unbind|releaseEngine|inheritName/.test(call))).toBe(false)
  })

  it.each([false, true])('fresh fallback cannot respawn or archive after replacement during preparation: terminal %s', async terminalHost => {
    const h = harness([row({ terminalHost })])
    h.deps.keepAbandoned = vi.fn()
    const pending = deferred<RestoreLaunchResult>()
    const build = h.deps.buildLaunch
    const fresh = vi.fn(() => pending.promise)
    h.deps.buildLaunch = (entry, opts) => opts.resumeSessionId ? build(entry, opts) : fresh()
    h.states.set('%0', [{ dead: true }])
    await restoreAgents(h.deps)
    await vi.waitFor(() => expect(fresh).toHaveBeenCalledOnce())
    const replacement = row({ sessionId: 'replacement' })
    h.rows.set('agent-a', replacement)
    pending.resolve({ argv: ['stale'] })
    await settled(h, 1)
    expect(h.rows.get('agent-a')).toEqual(replacement)
    expect(h.respawns).toBe(1)
    expect(h.deps.keepAbandoned).not.toHaveBeenCalled()
  })
})

describe('restoreAgents — a survey that could not tell', () => {
  it('asks a probe that could not answer again, and judges the row by the answer it then gives', async () => {
    const h = harness([row()])
    const asked: string[] = []
    const panes: Array<boolean | 'unknown'> = ['unknown', 'unknown', true]
    const engines: Array<ProcessIdentity | null | 'unknown'> = ['unknown', identity(7)]
    h.deps.livePane = async () => { asked.push('pane'); return panes.shift()! }
    h.deps.liveProcess = async () => { asked.push('engine'); return engines.shift()! }
    const summary = await restoreAgents(h.deps)
    // Its engine is still running: left alone, re-identified, and no second pane opened beside it.
    expect(summary).toEqual({ restored: [], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(asked).toEqual(['pane', 'pane', 'pane', 'engine', 'engine'])
    expect(h.paneCreates).toBe(0)
    expect(h.calls).toContain('updateIdentity:agent-a:7')
  })

  it('leaves a row alone when tmux or ps cannot say, however often it is asked', async () => {
    // Still unknown after every wait: neither archived as exited nor given a second pane resuming the
    // conversation its first may still be in. The caller keeps discovery from retiring it this boot.
    const alive = row({ agentId: 'alive' })
    const gone = row({ agentId: 'gone', tmuxPane: '%4', runtimes: [{ backend: 'tmux', paneId: '%4' }], primaryRuntimeKey: 'tmux\u0000%4' })
    const h = harness([alive, gone])
    h.deps.livePane = async (runtime) => runtime.paneId === '%3' ? true : false
    let asked = 0
    h.deps.liveProcess = async () => { asked++; return 'unknown' }
    h.deps.surveyRetryMs = [1, 1]
    const summary = await restoreAgents(h.deps)
    expect(summary.unsurveyed).toEqual(['alive', 'gone'])
    // The waits are spent once: the second row, after them, is asked once and left alone.
    expect(asked).toBe(3 + 1)
    expect(summary.failed).toEqual([])
    expect(h.paneCreates).toBe(0)
    expect(h.calls.filter((call) => /releaseEngine|createPane/.test(call))).toEqual([])
  })

  it('each held restore reads a fresh tmux inventory, preserving its pane until it actually disappears', async () => {
    const h = harness([row({ launch: heldLaunch('store') })])
    let panes: Array<{ tmuxPane: string }> = []
    const list = vi.fn(async () => ({ ok: true as const, panes }))
    h.deps.survey = () => tmuxSurvey(list, async () => ({ ok: false, unknown: false }))
    h.deps.only = new Set(['agent-a'])
    h.deps.buildLaunch = async () => ({ held: 'store' })
    await restoreAgents(h.deps)
    panes = [{ tmuxPane: '%0' }]
    await restoreAgents(h.deps)
    expect(h.paneCreates).toBe(1)
    panes = []
    await restoreAgents(h.deps)
    expect(h.paneCreates).toBe(2)
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('the tmux survey reads one pane listing, again only after a read that failed', async () => {
    const listings: Array<{ ok: true; panes: Array<{ tmuxPane: string }> } | { ok: false }> = [
      { ok: false }, { ok: true, panes: [{ tmuxPane: '%3' }] },
    ]
    let reads = 0
    const survey = tmuxSurvey(async () => { reads++; return listings.shift()! }, async (pane) =>
      pane === '%1' ? { ok: true, identity: identity(1) } : { ok: false, unknown: pane === '%2' })
    const runtime = (paneId: string): TmuxRuntimeRef => ({ backend: 'tmux', paneId })
    expect(await survey.livePane!(runtime('%3'))).toBe('unknown')
    expect(await survey.livePane!(runtime('%3'))).toBe(true)
    expect(await survey.livePane!(runtime('%5'))).toBe(false)
    expect(reads).toBe(2)
    expect(await survey.liveProcess(row(), runtime('%1'))).toEqual(identity(1))
    expect(await survey.liveProcess(row(), runtime('%2'))).toBe('unknown')
    expect(await survey.liveProcess(row(), runtime('%3'))).toBeNull()
  })
})

describe('restoreAgents — which agents get a pane back', () => {
  it('recreates a missing pane with a resume launch and hands the row over to discovery', async () => {
    const h = harness([row()])
    h.probes.set('%0', [null, identity(500)])

    const summary = await restoreAgents(h.deps)

    expect(summary).toEqual({ restored: ['agent-a'], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(h.launches).toEqual([{ agentId: 'agent-a', resumeSessionId: 'session-a' }])
    // Waiting shell allocation is outside the atomic route commit; engine dispatch follows it.
    expect(h.calls.slice(0, 7)).toEqual([
      'createPane:agent-a', 'updateRuntimes:agent-a:%0@tx', 'setLaunch:agent-a:held@tx',
      'clearIdentity:agent-a', 'hold:tmux\u0000%0', 'respawn:%0:claude --resume session-a', 'setLaunch:agent-a:starting',
    ])
    await settled(h, 1, 1)
    // The route is released BEFORE the hint so the pass it triggers sees the pane again.
    expect(h.calls.slice(7)).toEqual([
      'updateIdentity:agent-a:500',
      'clearRemainOnExit:%0',
      'release:tmux\u0000%0',
      'triggerHint:%0',
      'release:tmux\u0000%0', // the finally, idempotent by contract
    ])
    expect(h.rows.get('agent-a')?.launch).toEqual({ state: 'starting' })
  })

  it('launches fresh when the row has no session to resume', async () => {
    const h = harness([row({ sessionId: '', boundAt: null })])
    h.probes.set('%0', [identity(1)])
    const engineStarted = vi.fn()
    await restoreAgents({ ...h.deps, engineStarted })
    expect(h.launches).toEqual([{ agentId: 'agent-a' }])
    // No conversation to carry over, so none whose open turn a new engine ends.
    expect(engineStarted).not.toHaveBeenCalled()
    await settled(h, 1, 1)
  })

  it('marks a new engine at dispatch, before it can attach, and never for a refused creation', async () => {
    const h = harness([row(), row({ agentId: 'agent-b', sessionId: 'session-b', tmuxPane: '%1' })])
    h.probes.set('%0', [null, identity(500)])
    h.probes.set('%1', [null, identity(501)])
    const engineStarted = vi.fn()
    let panes = 0
    const createPane = h.deps.createPane
    // The second pane cannot be opened: its conversation keeps whatever engine it had.
    const summary = await restoreAgents({ ...h.deps, engineStarted, createPane: async (entry, launch, control) => (++panes === 2 ? { ok: false, reason: 'no room' } : createPane(entry, launch, control)) })
    expect(summary.restored).toEqual(['agent-a'])
    expect(engineStarted.mock.calls).toEqual([['session-a']])
    await settled(h, 1, 1)
  })

  it('leaves a pane that still runs its engine alone, re-identifying a row that lost its pid', async () => {
    const h = harness([row()], { livePanes: ['%3'] })
    const summary = await restoreAgents(h.deps)
    expect(summary).toEqual({ restored: [], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(h.paneCreates).toBe(0)
    // No identity on the row (a misread reboot, a tmux server that outlived the daemon): the live
    // pid is written back so discovery adopts by process rather than by route.
    expect(h.calls).toEqual(['updateIdentity:agent-a:1003'])
  })

  it('does not touch a live row that still knows its process', async () => {
    const h = harness([row({ processIdentity: identity(1003) })], { livePanes: ['%3'] })
    await restoreAgents(h.deps)
    expect(h.calls).toEqual([])
  })

  it('skips rows with no tmux pane and failed launches, saying why', async () => {
    const h = harness([
      row({ agentId: 'paneless', runtimes: [{ backend: 'unknown', sessionName: 's', paneId: 'p' } as unknown as TerminalRuntimeRef] }),
      row({ agentId: 'broken', launch: { state: 'failed', error: 'START_TIMEOUT' } }),
    ])
    const summary = await restoreAgents(h.deps)
    expect(summary.restored).toEqual([])
    expect(summary.skipped.map((s) => s.agentId)).toEqual(['paneless', 'broken'])
    expect(h.paneCreates).toBe(0)
  })

  it('puts a grid agent back on its grid, key and all, when the row kept its launch', async () => {
    const h = harness([row({ agentId: 'gridded', grid: { baseUrl: GRID.baseUrl, model: null }, gridLaunch: GRID })])
    h.probes.set('%0', [identity(7)])
    const summary = await restoreAgents(h.deps)
    expect(summary).toEqual({ restored: ['gridded'], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(h.launched).toEqual([{ agentId: 'gridded', launch: { argv: [] } }, { agentId: 'respawn', launch: { argv: ['claude', '--resume', 'session-a', '--grid', 'grid-abc'], env: { GRID_API_KEY: 'gridkey-abc123' } } }])
    await settled(h, 1, 1)
  })

  it('the fresh fallback of a grid agent is a grid launch too', async () => {
    const h = harness([row({ agentId: 'gridded', grid: { baseUrl: GRID.baseUrl, model: null }, gridLaunch: GRID })])
    h.states.set('%0', [{ dead: true }])
    h.probes.set('%0', [null, identity(8)])
    await restoreAgents(h.deps)
    await settled(h, 1, 1)
    expect(h.launched.slice(1).map((l) => l.launch.env)).toEqual([{ GRID_API_KEY: 'gridkey-abc123' }, { GRID_API_KEY: 'gridkey-abc123' }])
    expect(h.launched[2].launch.argv).toEqual(['claude', '--grid', 'grid-abc'])
  })

  it('does not relaunch a grid agent whose credential was never persisted, and marks it so', async () => {
    // A row written before `gridLaunch` existed: it knows WHERE it pointed and nothing else. On the
    // engine's own login it would spend the wrong account while looking identical.
    const h = harness([row({ agentId: 'legacy', grid: { baseUrl: 'https://grid.example/relay', model: null } })])
    const summary = await restoreAgents(h.deps)
    expect(summary.restored).toEqual([])
    expect(summary.skipped).toEqual([{ agentId: 'legacy', reason: expect.stringMatching(/credential not persisted/) }])
    expect(h.paneCreates).toBe(0)
    expect(h.calls).toEqual([`setLaunch:legacy:failed:${GRID_CREDENTIAL_REQUIRED}`])
  })

  it('a launch the machine cannot build fails the row instead of opening a pane on the wrong login', async () => {
    const h = harness([row({ agentId: 'gridded', grid: { baseUrl: GRID.baseUrl, model: null }, gridLaunch: GRID })], { refuseLaunch: true })
    const summary = await restoreAgents(h.deps)
    expect(summary.failed).toEqual([{ agentId: 'gridded', reason: 'no way to point it at a grid' }])
    expect(h.paneCreates).toBe(1)
    expect(h.respawns).toBe(0)
    expect(h.launched[0].launch.argv).toEqual([])
    expect(h.calls.at(-1)).toBe('setLaunch:gridded:failed:GRID_ENGINE_UNSUPPORTED')
  })

  it('a Codex profile agent comes back under its own CODEX_HOME', async () => {
    const h = harness([row({ agentId: 'profiled', engine: 'codex', codexHome: '/home/u/.codex-work' })])
    h.probes.set('%0', [identity(9)])
    await restoreAgents(h.deps)
    expect(h.launched[1].launch.env).toEqual({ CODEX_HOME: '/home/u/.codex-work' })
    await settled(h, 1, 1)
  })

  it('records a pane that could not be opened and leaves the row untouched', async () => {
    const h = harness([row()], { failCreate: true })
    const summary = await restoreAgents(h.deps)
    expect(summary.failed).toEqual([{ agentId: 'agent-a', reason: 'tmux said no' }])
    expect(h.calls).not.toContainEqual(expect.stringMatching(/^updateRuntimes/))
    expect(h.calls).not.toContainEqual(expect.stringMatching(/^hold/))
    expect(h.rows.get('agent-a')?.tmuxPane).toBe('%3')
  })

  it('restores several agents inside one transaction so reused pane ids cannot evict each other', async () => {
    const h = harness([row({ agentId: 'a', runtimes: [{ backend: 'tmux', paneId: '%1' }] }), row({ agentId: 'b', runtimes: [{ backend: 'tmux', paneId: '%0' }] })])
    h.probes.set('%0', [identity(1)])
    h.probes.set('%1', [identity(2)])
    const summary = await restoreAgents(h.deps)
    expect(summary.restored).toEqual(['a', 'b'])
    expect(h.calls.filter((c) => c.startsWith('updateRuntimes'))).toEqual(['updateRuntimes:a:%0@tx', 'updateRuntimes:b:%1@tx'])
    await settled(h, 2, 2)
  })
})

describe('restoreAgents — held until the service a launch asks is ready', () => {
  /** A grid agent's launch asks models; `answers` is what each ask of it gets, in turn (a launch, by default). */
  const withModels = (h: Harness, answers: Array<'held' | 'refused'> = []) => {
    const build = h.deps.buildLaunch
    h.deps.needs = (entry) => entry.gridLaunch ? 'models' : null
    h.deps.waitingLaunch = (_entry, held) => ({ argv: ['wait', held.detail] })
    h.deps.killPane = async (runtime) => { h.calls.push(`kill:${runtime.paneId}`) }
    h.deps.buildLaunch = async (entry, o): Promise<RestoreLaunchResult> => {
      const answer = entry.gridLaunch ? answers.shift() : undefined
      if (answer === 'held') { h.launches.push({ agentId: entry.agentId }); return { held: 'models' } }
      if (answer === 'refused') { h.launches.push({ agentId: entry.agentId }); return { error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no way there' } }
      return build(entry, o)
    }
  }
  const HELD = heldLaunch('models')
  const gridRow = (agentId: string, over: Partial<RegisteredSession> = {}) => row({
    agentId, sessionId: `session-${agentId}`, grid: { baseUrl: GRID.baseUrl, model: null }, gridLaunch: GRID,
    runtimes: [{ backend: 'tmux', paneId: `%${agentId.length + 40}` }], primaryRuntimeKey: '', tmuxPane: '', ...over,
  })

  it('says what a held agent waits for, in the words its pane shows', () => {
    expect(HELD).toEqual({ state: 'held', service: 'models', detail: 'Waiting for the models service. This harness starts by itself once the models service is running.' })
    expect(heldLaunch('store')).toMatchObject({ detail: expect.stringContaining('Waiting for the Store.') })
    expect(heldLaunch('search')).toMatchObject({ detail: expect.stringContaining('Waiting for search.') })
  })

  it('at boot asks no service: an agent whose launch needs one waits in a pane of its own, held, and the rest come back as ever', async () => {
    const h = harness([row(), gridRow('gridded')])
    withModels(h)
    h.deps.defer = true
    h.probes.set('%0', [identity(5)])
    const summary = await restoreAgents(h.deps)
    await settled(h, 1, 1)
    expect(summary).toEqual({ restored: ['agent-a'], skipped: [], failed: [], held: ['gridded'], unsurveyed: [] })
    // Only the agent on its own login was built; the grid agent's pane runs the reason, nothing else.
    expect(h.launches).toEqual([{ agentId: 'agent-a', resumeSessionId: 'session-a' }])
    expect(h.launched.find((l) => l.agentId === 'gridded')?.launch).toEqual({ argv: ['wait', HELD.state === 'held' ? HELD.detail : ''] })
    expect(h.rows.get('gridded')).toMatchObject({ launch: HELD, runtimes: [{ backend: 'tmux', paneId: '%1' }] })
    // In the boot's one transaction with every other pane, so no pane id it reuses is left on a stale row.
    expect(h.calls).toContain('updateRuntimes:gridded:%1@tx')
    expect(h.calls).toContain('setLaunch:gridded:held@tx')
  })

  it('launches a held agent into the pane it waits in, outside any transaction, once the service can be asked', async () => {
    const h = harness([gridRow('gridded', { launch: HELD })], { alivePanes: ['%47'] })
    withModels(h)
    h.deps.only = new Set(['gridded'])
    h.probes.set('%47', [identity(8)])
    const summary = await restoreAgents(h.deps)
    expect(summary).toEqual({ restored: ['gridded'], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(h.paneCreates).toBe(0)
    expect(h.calls.filter((call) => call.endsWith('@tx'))).toEqual([])
    expect(h.calls).toContain('respawn:%47:claude --resume session-gridded --grid grid-abc')
    expect(h.rows.get('gridded')?.launch).toEqual({ state: 'starting' })
    await settled(h, 1, 1)
  })

  it('asks a service that cannot be asked once a pass: every agent after it that needs it is held unasked', async () => {
    const h = harness([gridRow('first', { launch: HELD }), gridRow('second', { launch: HELD }), row({ agentId: 'own', sessionId: 'session-own' })], { alivePanes: ['%45'] })
    withModels(h, ['held', 'held'])
    h.probes.set('%1', [identity(6)])
    const summary = await restoreAgents(h.deps)
    await settled(h, 1, 1)
    expect(summary.held).toEqual(['first', 'second'])
    expect(summary.restored).toEqual(['own'])
    // One ask of models, for the first; the second waits without one, in a new pane since its own went.
    expect(h.launches.filter((l) => l.agentId !== 'own')).toEqual([{ agentId: 'first' }])
    expect(h.launched.find((l) => l.agentId === 'second')?.launch.argv[0]).toBe('wait')
    expect(h.rows.get('first')?.launch).toEqual(HELD)
    expect(h.rows.get('second')?.launch).toEqual(HELD)
  })

  it('asks a failed Store only once when each harness also needs models', async () => {
    const h = harness([gridRow('first', { launch: HELD, dsh: 'test/draw' }), gridRow('second', { launch: HELD, dsh: 'test/draw' })])
    withModels(h)
    h.deps.needs = () => ['models', 'store']
    const asks: string[] = []
    h.deps.buildLaunch = async entry => { asks.push(entry.agentId); return { held: 'store' } }
    const summary = await restoreAgents(h.deps)
    expect(asks).toEqual(['first'])
    expect(summary.held).toEqual(['first', 'second'])
    expect(summary.failed).toEqual([])
    expect(h.rows.get('first')?.launch).toEqual(heldLaunch('store'))
    expect(h.rows.get('second')?.launch).toEqual(heldLaunch('store'))
  })

  it.each(['removed', 'stopped', 'moved', 'rebound'] as const)('a held restore cannot undo a session %s while preparation was in flight', async change => {
    const entry = gridRow('gridded', { launch: HELD })
    const h = harness([entry], { alivePanes: ['%47'] })
    withModels(h)
    h.deps.only = new Set(['gridded'])
    h.deps.buildLaunch = async () => {
      if (change === 'removed') h.rows.delete('gridded')
      else {
        const row = h.rows.get('gridded')!
        h.rows.set('gridded', { ...row, ...(change === 'stopped' ? { launch: undefined } : change === 'rebound'
          ? { sessionId: 'new-session' } : { runtimes: [{ backend: 'tmux', paneId: '%99' }], primaryRuntimeKey: 'tmux\u0000%99' }) })
      }
      return { argv: ['must-not-run'] }
    }
    const summary = await restoreAgents(h.deps)
    expect(summary.restored).toEqual([])
    expect(h.calls.filter(call => call.startsWith('respawn:'))).toEqual([])
    expect(h.paneCreates).toBe(0)
  })

  it('keeps an unconfirmed workspace held with its exact reason while other workspaces can launch', async () => {
    const h = harness([gridRow('first', { launch: HELD }), gridRow('second', { launch: HELD })], { alivePanes: ['%45', '%46'] })
    withModels(h)
    h.deps.only = new Set(['first', 'second'])
    const original = h.deps.buildLaunch
    h.deps.buildLaunch = async (entry, opts) => entry.agentId === 'first'
      ? { held: 'store', holdScope: 'workspace', detail: 'Workspace preparation is unconfirmed; review required.' }
      : original(entry, opts)
    h.probes.set('%46', [identity(8)])
    const summary = await restoreAgents(h.deps)
    expect(summary.held).toEqual(['first'])
    expect(summary.restored).toEqual(['second'])
    expect(h.rows.get('first')?.launch).toMatchObject({ state: 'held', service: 'store', detail: 'Workspace preparation is unconfirmed; review required.' })
    expect(h.calls).toContain('respawn:%45:wait Workspace preparation is unconfirmed; review required.')
    await settled(h, 1, 1)
  })

  it('never fails or skips a held agent: the next restore holds it again, its pane gone with a reboot', async () => {
    const h = harness([gridRow('gridded', { launch: HELD, resumeOnly: true })])
    withModels(h)
    h.deps.defer = true
    h.deps.retainStopped = vi.fn()
    const summary = await restoreAgents(h.deps)
    expect(summary.held).toEqual(['gridded'])
    expect(summary.skipped).toEqual([])
    // A confirmed conversation it held: not sent back to the archive like an unconfirmed one.
    expect(h.deps.retainStopped).not.toHaveBeenCalled()
    expect(h.rows.get('gridded')?.launch).toEqual(HELD)
  })

  it('closes the pane of a held agent whose launch then fails, or whose conversation is gone', async () => {
    const h = harness([gridRow('refused', { launch: HELD }), gridRow('lost', { launch: HELD, resumeOnly: true, sessionId: '' })], { alivePanes: ['%47', '%44'] })
    withModels(h, ['refused'])
    const summary = await restoreAgents(h.deps)
    expect(summary.failed.map((f) => f.agentId)).toEqual(['refused', 'lost'])
    expect(h.calls).toContain('kill:%47')
    expect(h.calls).toContain('kill:%44')
    expect(h.rows.get('refused')?.launch).toMatchObject({ state: 'failed', error: 'GRID_ENGINE_UNSUPPORTED' })
  })

  it('reports a held agent no pane could be opened for, and opens none without a waiting launch to give it', async () => {
    const h = harness([gridRow('gridded')], { failCreate: true })
    withModels(h)
    h.deps.defer = true
    expect((await restoreAgents(h.deps)).failed).toEqual([{ agentId: 'gridded', reason: 'tmux said no' }])
    const bare = harness([gridRow('gridded')])
    bare.deps.needs = () => 'models'
    bare.deps.defer = true
    expect((await restoreAgents(bare.deps)).held).toEqual(['gridded'])
    expect(bare.launched).toEqual([{ agentId: 'gridded', launch: { argv: [] } }])
  })

  it('leaves every agent a pass was not asked about as it is', async () => {
    const h = harness([row(), gridRow('gridded', { launch: HELD })], { alivePanes: ['%47'] })
    withModels(h, ['held'])
    h.deps.only = new Set(['gridded'])
    const summary = await restoreAgents(h.deps)
    expect(summary).toEqual({ restored: [], skipped: [], failed: [], held: ['gridded'], unsurveyed: [] })
    expect(h.launches).toEqual([{ agentId: 'gridded' }])
  })

  it.each([false, true])('holds an agent whose service and waiting pane are unavailable (throwing reply %s)', async throws => {
    const h = harness([gridRow('gridded')])
    withModels(h, [undefined as never, 'held'])
    h.probes.set('%0', [null, null])
    h.states.set('%0', [{ dead: true }])
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.calls).toContain(`respawn:%0:wait ${HELD.state === 'held' ? HELD.detail : ''}`)
    expect(h.rows.get('gridded')?.launch).toEqual(HELD)
    // A waiting pane that cannot be had preserves the conversation and both reasons.
    const stuck = harness([gridRow('gridded')])
    withModels(stuck, [undefined as never, 'held'])
    const respawn = stuck.deps.respawn
    let dispatched = false
    stuck.deps.respawn = async (...args) => { if (dispatched) { if (throws) throw new Error('test uncertain reply'); return { ok: false } }; dispatched = true; return respawn(...args) }
    stuck.probes.set('%0', [null, null])
    stuck.states.set('%0', [{ dead: true }])
    await restoreAgents(stuck.deps)
    await settled(stuck, 1)
    expect(stuck.rows.get('gridded')).toMatchObject({ sessionId: 'session-gridded', launch: { state: 'held', service: 'models', detail: expect.stringContaining(throws ? 'test uncertain reply' : 'unknown reason') } })
    expect(stuck.calls.some(call => /unbind:|inheritName:/.test(call))).toBe(false)
    // Even a missing waiting shell is recoverable once preparation can be asked again.
    stuck.deps.only = new Set(['gridded'])
    stuck.deps.respawn = respawn
    stuck.probes.set('%1', [identity(12)])
    expect((await restoreAgents(stuck.deps)).restored).toEqual(['gridded'])
    await settled(stuck, 2, 1)
    expect(stuck.rows.get('gridded')?.sessionId).toBe('session-gridded')
  })

  it('holds a terminal whose adopted engine needs a service to come back, too', async () => {
    const h = harness([row({ terminalHost: true, engine: 'claude', gridLaunch: GRID })])
    h.deps.needs = () => null
    h.deps.waitingLaunch = (_entry, held) => ({ argv: ['wait', held.detail] })
    const build = h.deps.buildLaunch
    let asks = 0
    h.deps.buildLaunch = async (entry, o) => (++asks === 2 ? { held: 'models' } : build(entry, o))
    h.probes.set('%0', [null, null])
    h.states.set('%0', [{ dead: true }])
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.rows.get('agent-a')?.launch).toEqual(HELD)
  })
})

describe('restoreAgents — waiting for the engine', () => {
  it('keeps an explicit resume failure instead of silently starting fresh after a daemon restart', async () => {
    const h = harness([row({ resumeOnly: true })])
    h.probes.set('%0', [null, null])
    h.states.set('%0', [{ dead: true }])
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.respawns).toBe(1)
    expect(h.launches).toEqual([{ agentId: 'agent-a', resumeSessionId: 'session-a' }])
    expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'RESUME_FAILED' })
    expect(h.calls).not.toContain('unbind:session-a')
  })

  it('does not create a fresh conversation if a resume-only binding is missing', async () => {
    const h = harness([row({ resumeOnly: true, sessionId: '' })])
    await restoreAgents(h.deps)
    expect(h.launches).toEqual([])
    expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'RESUME_UNAVAILABLE' })
  })

  it('falls back to a fresh launch once when the resumed engine dies, and unbinds the stale session', async () => {
    const h = harness([row()])
    h.probes.set('%0', [null, null, identity(9)])
    h.states.set('%0', [{ dead: true }, { dead: false }])

    await restoreAgents(h.deps)
    await settled(h, 1, 1)

    expect(h.respawns).toBe(2)
    expect(h.launches).toEqual([
      { agentId: 'agent-a', resumeSessionId: 'session-a' },
      { agentId: 'agent-a' },
    ])
    const tail = h.calls.slice(7)
    expect(tail.slice(0, 4)).toEqual(['inheritName:session-a->agent-a', 'unbind:session-a', 'hold:tmux\u0000%0', 'respawn:%0:claude'])
    expect(tail).toContain('updateIdentity:agent-a:9')
    expect(h.rows.get('agent-a')?.launch).toEqual({ state: 'starting' })
  })

  it('keeps the conversation the fresh launch leaves, before it is unbound', async () => {
    const h = harness([row()])
    const kept: Array<{ agentId: string; sessionId: string; unbound: boolean }> = []
    h.deps.keepAbandoned = (left) => { kept.push({ agentId: left.agentId, sessionId: left.sessionId, unbound: h.calls.includes('unbind:session-a') }) }
    h.probes.set('%0', [null, null, identity(9)])
    h.states.set('%0', [{ dead: true }, { dead: false }])

    await restoreAgents(h.deps)
    await settled(h, 1, 1)

    expect(kept).toEqual([{ agentId: 'agent-a', sessionId: 'session-a', unbound: false }])
  })

  it('treats an engine that appears and then exits inside the settling window as a rejected resume', async () => {
    const h = harness([row()], { settleMs: 50 })
    // First probe: the resumed claude is up. Settling poll: the pane is dead. After the fresh
    // respawn: up again, and this time it stays.
    h.probes.set('%0', [identity(7), identity(8)])
    h.states.set('%0', [{ dead: true }])

    await restoreAgents(h.deps)
    await settled(h, 1, 1)

    expect(h.respawns).toBe(2)
    expect(h.launches.map((l) => l.resumeSessionId ?? 'fresh')).toEqual(['session-a', 'fresh'])
    const tail = h.calls.slice(7)
    expect(tail.slice(0, 5)).toEqual(['updateIdentity:agent-a:7', 'inheritName:session-a->agent-a', 'unbind:session-a', 'hold:tmux\u0000%0', 'respawn:%0:claude'])
    expect(tail).toContain('updateIdentity:agent-a:8')
    expect(tail).toContain('clearRemainOnExit:%0')
    // remain-on-exit was NOT cleared before the first engine died — that is what kept the pane.
    expect(tail.indexOf('clearRemainOnExit:%0')).toBeGreaterThan(tail.indexOf('respawn:%0:claude'))
    expect(h.rows.get('agent-a')?.launch).toEqual({ state: 'starting' })
  })

  it('fails a fresh engine that exits inside the settling window', async () => {
    const h = harness([row({ sessionId: '', boundAt: null })], { settleMs: 50 })
    h.probes.set('%0', [identity(7)])
    h.states.set('%0', [{ dead: true }])
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.respawns).toBe(1)
    expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'ENGINE_DID_NOT_START' })
  })

  it('gives up after the fresh launch dies too', async () => {
    const h = harness([row()])
    h.states.set('%0', [{ dead: true }, { dead: true }])
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.respawns).toBe(2)
    expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'ENGINE_DID_NOT_START' })
  })

  it('does not retry fresh when there was no resume to blame', async () => {
    const h = harness([row({ sessionId: '', boundAt: null })])
    h.states.set('%0', [{ dead: true }])
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.respawns).toBe(1)
    expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'ENGINE_DID_NOT_START' })
  })

  it('fails the launch when the pane vanishes entirely', async () => {
    const h = harness([row()])
    h.states.set('%0', ['gone'])
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'ENGINE_DID_NOT_START' })
  })

  it('asks again when tmux could not say how the pane is, and binds the engine once it shows', async () => {
    // A read that timed out while the daemon's event loop was held: it failed the restore on the spot.
    const h = harness([row()])
    h.probes.set('%0', [null, null, identity(500)])
    h.states.set('%0', ['unknown', 'unknown'])
    await restoreAgents(h.deps)
    await settled(h, 1, 1)
    expect(h.calls).toContain('updateIdentity:agent-a:500')
    expect(h.calls.some((call) => call.startsWith('setLaunch:agent-a:failed'))).toBe(false)
  })

  it('a pane tmux could not read while the resumed engine settles is no reason to start it over', async () => {
    // The relaunch this used to set off unbound the conversation and respawned the pane over an engine
    // that was working.
    const h = harness([row()], { settleMs: 50 })
    h.probes.set('%0', [identity(500)])
    h.states.set('%0', ['unknown', 'unknown', 'unknown'])
    await restoreAgents(h.deps)
    await settled(h, 1, 1)
    expect(h.respawns).toBe(1)
    expect(h.calls.some((call) => call.startsWith('unbind:'))).toBe(false)
    expect(h.calls).toContain('triggerHint:%0')
  })

  it('times out with the launch marked, never leaving the route held', async () => {
    const h = harness([row()], { budgetMs: 0 })
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'START_TIMEOUT' })
    expect(h.released).toEqual(['tmux\u0000%0'])
  })

  it('stops quietly when the agent was deleted while its engine was starting', async () => {
    const h = harness([row()])
    h.probes.set('%0', [null])
    const deps = { ...h.deps }
    let polls = 0
    deps.probeProcess = async () => { if (++polls === 2) h.rows.delete('agent-a'); return null }
    await restoreAgents(deps)
    await settled(h, 1)
    expect(h.calls.filter((c) => c.startsWith('setLaunch:agent-a:failed'))).toEqual([])
  })
})

describe('restoreAgents — terminals', () => {
  const terminal = (overrides: Partial<RegisteredSession> = {}) =>
    row({ agentId: 'term-1', engine: 'terminal', terminalHost: true, sessionId: '', boundAt: null, ...overrides })

  it('leaves a terminal whose pane is still there alone — a shell has no engine process to look for', async () => {
    const h = harness([terminal()], { alivePanes: ['%3'] })
    const summary = await restoreAgents(h.deps)
    expect(summary).toEqual({ restored: [], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(h.paneCreates).toBe(0)
    expect(h.calls).toEqual([])
  })

  it('recreates a terminal whose pane is gone as a ready shell: no hold, no engine watch', async () => {
    const h = harness([terminal()])
    const summary = await restoreAgents(h.deps)
    expect(summary).toEqual({ restored: ['term-1'], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(h.launches).toEqual([{ agentId: 'term-1' }])
    expect(h.calls).toEqual([
      'createPane:term-1', 'updateRuntimes:term-1:%0@tx', 'setLaunch:term-1:held@tx',
      'clearIdentity:term-1', 'respawn:%0:terminal', 'setLaunch:term-1:ready', 'clearRemainOnExit:%0',
    ])
    expect(h.rows.get('term-1')?.launch).toEqual({ state: 'ready' })
  })

  it('puts a terminal whose adopted engine exited while the daemon was down back to a shell, pane kept', async () => {
    const h = harness([terminal({ engine: 'claude', sessionId: 'session-t', boundAt: 1, processIdentity: identity(7) })], { alivePanes: ['%3'] })
    const summary = await restoreAgents(h.deps)
    expect(summary).toEqual({ restored: [], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(h.calls).toEqual(['releaseEngine:term-1'])
    expect(h.rows.get('term-1')).toMatchObject({ engine: 'terminal', sessionId: '' })
  })

  it('keeps a terminal whose adopted engine is still running exactly as an agent', async () => {
    const h = harness([terminal({ engine: 'claude', sessionId: 'session-t', boundAt: 1 })], { alivePanes: ['%3'], livePanes: ['%3'] })
    const summary = await restoreAgents(h.deps)
    expect(summary).toEqual({ restored: [], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(h.calls).toEqual(['updateIdentity:term-1:1003'])
    expect(h.rows.get('term-1')?.engine).toBe('claude')
  })

  it('an ordinary agent whose engine exited while the daemon was down, pane alive, becomes a terminal — no second pane', async () => {
    const h = harness([row({ agentId: 'agent-a', terminalHost: true })], { alivePanes: ['%3'] })
    // `terminalHost` is what releaseEngine's stub keys on; the real registry sets it for any row.
    const summary = await restoreAgents(h.deps)
    expect(summary).toEqual({ restored: [], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(h.paneCreates).toBe(0)
    expect(h.calls).toEqual(['releaseEngine:agent-a'])
    expect(h.rows.get('agent-a')).toMatchObject({ engine: 'terminal', sessionId: '' })
  })

  it('an engine that exits during a restore (its pane fell back to a shell) is relaunched fresh, like a dead pane', async () => {
    const h = harness([row()], { settleMs: 20 })
    h.probes.set('%0', [identity(500), identity(501)])
    h.states.set('%0', [{ dead: false, engineExit: 1 }, { dead: false }, { dead: false }, { dead: false }])
    await restoreAgents(h.deps)
    await settled(h, 1, 1)
    expect(h.respawns).toBe(2)
    expect(h.launches).toEqual([{ agentId: 'agent-a', resumeSessionId: 'session-a' }, { agentId: 'agent-a' }])
  })

  it('brings a terminal whose adopted engine left no conversation id back as a shell', async () => {
    const h = harness([terminal({ engine: 'claude', sessionId: '', boundAt: 1 })])
    const summary = await restoreAgents(h.deps)
    expect(summary).toEqual({ restored: ['term-1'], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(h.calls[0]).toBe('releaseEngine:term-1')
    expect(h.launches).toEqual([{ agentId: 'term-1' }])
    expect(h.launched[1].launch.argv[0]).toBe('terminal')
    expect(h.rows.get('term-1')).toMatchObject({ engine: 'terminal', launch: { state: 'ready' } })
  })

  it.each(['opencode', 'claude'] as const)('brings a terminal back resuming the %s conversation typed into it', async (engine) => {
    // Harness OS's welcome types OpenCode into a terminal; after a reboot it came back a bare prompt.
    const h = harness([terminal({ engine, sessionId: 'ses_kept', boundAt: 1 })])
    h.probes.set('%0', [identity(9)])
    const summary = await restoreAgents(h.deps)
    expect(summary).toEqual({ restored: ['term-1'], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(h.calls).not.toContain('releaseEngine:term-1')
    expect(h.launches).toEqual([{ agentId: 'term-1', resumeSessionId: 'ses_kept' }])
    expect(h.launched[1].launch.argv).toEqual([engine, '--resume', 'ses_kept'])
    await settled(h, 1, 1)
    expect(h.rows.get('term-1')).toMatchObject({ engine, terminalHost: true, sessionId: 'ses_kept' })
    expect(h.respawns).toBe(1)
  })

  it('reopens the terminal, never a fresh engine, when the conversation it was resuming is refused', async () => {
    const h = harness([terminal({ engine: 'opencode', sessionId: 'ses_gone', boundAt: 1 })])
    const kept: string[] = []
    h.deps.keepAbandoned = (left) => { kept.push(left.sessionId) }
    h.states.set('%0', [{ dead: true }])
    const summary = await restoreAgents(h.deps)
    expect(summary.restored).toEqual(['term-1'])
    await settled(h, 1)
    expect(kept).toEqual(['ses_gone'])
    expect(h.calls).toContain('releaseEngine:term-1')
    expect(h.launches).toEqual([{ agentId: 'term-1', resumeSessionId: 'ses_gone' }, { agentId: 'term-1' }])
    expect(h.calls).toContain('respawn:%0:terminal')
    expect(h.calls).not.toContain('unbind:ses_gone')
    expect(h.rows.get('term-1')).toMatchObject({ engine: 'terminal', launch: { state: 'ready' } })
  })
})


it('retains a missing strict-resume pane whose resume was never confirmed for explicit Open', async () => {
  const entry = row({ resumeOnly: true, launch: { state: 'starting' } })
  const h = harness([entry])
  h.deps.retainStopped = vi.fn((saved, _paneAlive) => { h.rows.delete(saved.agentId) })
  const summary = await restoreAgents(h.deps)
  expect(h.deps.retainStopped).toHaveBeenCalledWith(entry, false)
  expect(summary.restored).toEqual([])
  expect(h.paneCreates).toBe(0)
  expect(h.respawns).toBe(0)
})

it('restores a confirmed strict-resume pane by exact resume, and never falls back to fresh', async () => {
  const entry = row({ resumeOnly: true, launch: { state: 'ready' } })
  const h = harness([entry])
  h.deps.retainStopped = vi.fn()
  h.probes.set('%0', [null, null])
  h.states.set('%0', [{ dead: true }])
  const summary = await restoreAgents(h.deps)
  expect(h.deps.retainStopped).not.toHaveBeenCalled()
  expect(summary.restored).toEqual(['agent-a'])
  expect(h.paneCreates).toBe(1)
  expect(h.launches).toEqual([{ agentId: 'agent-a', resumeSessionId: 'session-a' }])
  await settled(h, 1)
  expect(h.respawns).toBe(1)
  expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'RESUME_FAILED' })
  expect(h.calls).not.toContain('unbind:session-a')
})

it('archives an engine that exited while the daemon was down without overwriting its shell', async () => {
  const entry = row()
  const h = harness([entry], { alivePanes: ['%3'] })
  h.deps.retainStopped = vi.fn()
  await restoreAgents(h.deps)
  expect(h.deps.retainStopped).toHaveBeenCalledWith(entry, true)
  expect(h.paneCreates).toBe(0)
  expect(h.respawns).toBe(0)
})


describe('missing held panes against the durable registry', () => {
  it.each([['cycle', false], ['chain failure', false], ['cycle', true], ['chain failure', true], ['outside selection', true]] as const)('preserves every row through a recycled route %s (held pass %s)', async (mode, only) => {
    const old = mode === 'cycle' ? ['%1', '%0'] : mode === 'chain failure' ? ['%2', '%0', '%1'] : ['%3', '%0']
    const entries = old.map(paneId => realRegistry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId }], cwd: '/tmp' })!)
    try {
      for (const entry of entries) realRegistry.setLaunch(entry.agentId, heldLaunch('store'))
      const h = harness(entries)
      h.deps.registry = realRegistry
      if (only) h.deps.only = new Set((mode === 'outside selection' ? entries.slice(0, 1) : entries).map(entry => entry.agentId))
      h.deps.buildLaunch = async () => ({ held: 'store' })
      h.deps.log = vi.fn()
      if (mode === 'chain failure') {
        const create = h.deps.createPane
        h.deps.createPane = async (entry, launch, control) => entry.agentId === entries[2].agentId
          ? { ok: false, reason: 'test allocation failed' } : create(entry, launch, control)
      }
      const result = await restoreAgents(h.deps)
      expect(realRegistry.list().map(entry => entry.agentId).sort()).toEqual(entries.map(entry => entry.agentId).sort())
      expect(entries.map(entry => realRegistry.byAgent(entry.agentId)?.tmuxPane)).toEqual(mode === 'cycle' ? ['%0', '%1'] : old)
      expect(entries.every(entry => realRegistry.byAgent(entry.agentId)?.launch?.state === 'held')).toBe(true)
      expect(entries.every(entry => realRegistry.byAgent(entry.agentId)?.active === false)).toBe(true)
      expect(h.respawns).toBe(0)
      if (mode !== 'cycle') expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('left intact for review'))
      if (mode === 'chain failure') expect(result.failed).toHaveLength(1)
      // The synchronous batch has released durable writes before its returned Promise settles.
      const committing = realRegistry.transaction(() => realRegistry.setLaunch(entries[0].agentId, heldLaunch('store')))
      expect(() => realRegistry.setClosePlan(entries[0].agentId, null)).not.toThrow()
      await committing
    } finally { for (const entry of entries) realRegistry.removeAgent(entry.agentId) }
  })

  it('an allocated waiting row stays inactive while a service answer is outstanding', async () => {
    const entry = realRegistry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%44' }] })!
    let finish!: (value: RestoreLaunchResult) => void
    try {
      realRegistry.setLaunch(entry.agentId, heldLaunch('store'))
      const h = harness([entry])
      h.deps.registry = realRegistry
      h.deps.only = new Set([entry.agentId])
      h.deps.buildLaunch = vi.fn(() => new Promise<RestoreLaunchResult>(done => { finish = done }))
      const restoring = restoreAgents(h.deps)
      await vi.waitFor(() => expect(h.deps.buildLaunch).toHaveBeenCalledOnce())
      expect(realRegistry.byAgent(entry.agentId)).toMatchObject({ active: false, launch: { state: 'held' }, tmuxPane: '%0' })
      finish({ held: 'store' })
      await restoring
      expect(realRegistry.byAgent(entry.agentId)?.active).toBe(false)
    } finally { realRegistry.removeAgent(entry.agentId) }
  })

  it('an unrelated live pane pin cannot block missing held recovery', async () => {
    const h = harness([row({ launch: heldLaunch('store') }), row({ agentId: 'pinned', runtimes: [{ backend: 'tmux', paneId: '%91' }] })], { alivePanes: ['%91'] })
    h.deps.only = new Set(['agent-a'])
    h.deps.cancelled = id => id === 'pinned'
    h.probes.set('%0', [identity(8)])
    expect((await restoreAgents(h.deps)).restored).toEqual(['agent-a'])
    await settled(h, 1, 1)
  })

  it('an overlapping core pane operation retries after the sole prepared notice', async () => {
    const h = harness([row({ launch: heldLaunch('store') })])
    const operations = createPaneOperations()
    h.deps.paneAllocations = operations.runMany
    h.deps.paneBusy = operations.busy
    let finish!: () => void
    const previous = operations.run('agent-a', () => new Promise<void>(done => { finish = done }))
    h.probes.set('%0', [identity(8)])
    const held = createHeldLaunches({ registry: h.deps.registry, restore: only => restoreAgents({ ...h.deps, only }), log: () => {} })
    await held.boot(async () => {})
    expect(await held.restoreHeld('store')).toMatchObject({ retry: true })
    expect(h.paneCreates).toBe(0)
    finish()
    await previous
    await vi.waitFor(() => expect(h.rows.get('agent-a')?.processIdentity).toEqual(identity(8)), { timeout: 2_000 })
    expect(h.paneCreates).toBe(1)
  })

  it('Stop cancels undispatched allocation work and joins only the bounded in-flight group', async () => {
    const entries = Array.from({ length: 8 }, (_, i) => row({ agentId: `a${i}`, launch: heldLaunch('store'), runtimes: [{ backend: 'tmux', paneId: `%${i + 40}` }] }))
    const h = harness(entries)
    const operations = createPaneOperations()
    h.deps.paneAllocations = operations.runMany
    h.deps.paneBusy = operations.busy
    h.deps.only = new Set(entries.map(entry => entry.agentId))
    let stopped = false
    h.deps.cancelled = () => stopped
    const replies: Array<() => void> = []
    h.deps.createPane = async entry => {
      await new Promise<void>(done => { replies.push(done) })
      return { ok: true, runtime: { backend: 'tmux', paneId: `%${entry.agentId.slice(1)}` } }
    }
    const restoring = restoreAgents(h.deps)
    await vi.waitFor(() => expect(replies).toHaveLength(4))
    expect(entries.every(entry => operations.busy(entry.agentId))).toBe(true)
    stopped = true
    const joined = operations.settle('a0')
    for (const reply of replies) reply()
    await restoring
    await joined
    expect(replies).toHaveLength(4)
    expect(h.rows.get('a0')?.runtimes).toEqual([{ backend: 'tmux', paneId: '%0' }])
    expect(h.respawns).toBe(0)
  })
})

describe('external adoption crash boundaries', () => {
  const imported = (phase: 'waiting' | 'admitted' | 'cancelled', starting = false) => row({
    sessionId: phase === 'admitted' ? 'imported-session' : '', resumeOnly: phase === 'admitted' ? true : undefined,
    externalResume: { token: '12345678-1234-1234-1234-123456789012', request: { engine: 'claude', sessionId: 'imported-session' },
      takeOver: null, phase, ...(phase === 'admitted' ? { session: { sessionId: 'imported-session', engine: 'claude', cwd: '/fixture',
        origin: 'terminal', title: '', mtime: 1, transcriptPath: '/fixture/record' }, ...(starting ? { dispatched: true } : {}) } : {}) },
    launch: starting ? { state: 'starting' } : heldLaunch('search'),
  })
  function dispatch(h: Harness) {
    h.deps.registry.beginExternalDispatch = id => {
      const row = h.rows.get(id)!
      expect(row.launch?.state).toBe('held')
      h.calls.push('journal:dispatch')
      row.launch = { state: 'starting' }; row.externalResume = { ...row.externalResume!, dispatched: true }
      return row
    }
  }

  it('never recreates a durably cancelled waiting pane, even when tmux is gone', async () => {
    const h = harness([imported('cancelled')])
    expect((await restoreAgents(h.deps)).skipped).toContainEqual({ agentId: 'agent-a', reason: 'external adoption cancelled' })
    expect(h.paneCreates).toBe(0); expect(h.respawns).toBe(0)
  })

  it('journals before dispatch, and recovers a crash before tmux by recognizing its exact waiting shell', async () => {
    for (const starting of [false, true]) {
      const h = harness([imported('admitted', starting)], { alivePanes: ['%3'] })
      dispatch(h)
      h.deps.waitingPane = vi.fn(async () => true)
      h.deps.respawn = vi.fn(async (_pane, launch, control) => {
        expect(control?.expectedHeldToken).toBe(h.rows.get('agent-a')?.externalResume?.token)
        control?.onDispatch?.()
        expect(h.rows.get('agent-a')).toMatchObject({ launch: { state: 'starting' }, externalResume: { dispatched: true } })
        expect(control?.current?.()).toBe(true)
        expect(launch.argv).toContain('imported-session')
        return { ok: true }
      })
      h.probes.set('%3', [identity(9)])
      expect((await restoreAgents(h.deps)).restored).toEqual(['agent-a'])
      await settled(h, 1, 1)
      expect(h.deps.respawn).toHaveBeenCalledOnce()
    }
  })

  it('observes a dispatch that may have run before the crash instead of replaying over it', async () => {
    for (const known of [false, 'unknown'] as const) {
      const h = harness([imported('admitted', true)], { alivePanes: ['%3'] })
      h.deps.waitingPane = async () => known
      h.probes.set('%3', [identity(10)])
      const summary = await restoreAgents(h.deps)
      expect(summary.restored).toEqual([])
      await settled(h, 1, 1)
      expect(h.paneCreates).toBe(0); expect(h.respawns).toBe(0)
      expect(h.rows.get('agent-a')?.processIdentity?.pid).toBe(10)
    }
  })

  it('retries a failed strict journal without dispatch, and retries an uncertain dispatch only with inert-pane proof', async () => {
    for (const failure of ['journal', 'before-tmux', 'after-tmux'] as const) {
      const h = harness([imported('admitted')], { alivePanes: ['%3'] })
      dispatch(h)
      if (failure === 'journal') h.deps.registry.beginExternalDispatch = () => { throw new Error('disk full') }
      h.deps.waitingPane = async () => failure === 'before-tmux'
      const executed = vi.fn()
      h.deps.respawn = async (_pane, _launch, control) => {
        control?.onDispatch?.(); executed(); return { ok: false, reason: 'lost tmux reply' }
      }
      h.probes.set('%3', [identity(11)])
      const summary = await restoreAgents(h.deps)
      if (failure === 'after-tmux') {
        await settled(h, 1, 1)
        expect(summary.retry).toBeUndefined()
        expect(h.rows.get('agent-a')?.processIdentity?.pid).toBe(11)
      } else {
        expect(summary.retry).toBe(true)
        expect(h.rows.get('agent-a')?.launch?.state).toBe('held')
        if (failure === 'journal') expect(executed).not.toHaveBeenCalled()
      }
    }
  })

  it('resumes a committed external conversation after tmux loss, retaining strict identity without search or a fresh fallback', async () => {
    const h = harness([imported('admitted', true)])
    dispatch(h)
    h.deps.retainStopped = vi.fn()
    h.deps.waitingLaunch = () => ({ argv: ['waiting-shell'] })
    h.states.set('%0', [{ dead: true }])
    expect((await restoreAgents(h.deps)).restored).toEqual(['agent-a'])
    await settled(h, 1)
    expect(h.deps.retainStopped).not.toHaveBeenCalled()
    expect(h.launches).toEqual([{ agentId: 'agent-a', resumeSessionId: 'imported-session' }])
    expect(h.rows.get('agent-a')).toMatchObject({ sessionId: 'imported-session', launch: { state: 'failed', error: 'RESUME_FAILED' } })
  })
})

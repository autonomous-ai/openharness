import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import type { DiscoveredTerminalAgent, TerminalAgentProbe } from './terminalAgentDiscovery.js'
import type { TerminalBackend } from './terminalBackend.js'
import { TerminalAgentReconciler } from './terminalAgentReconciler.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

const tmux: TerminalRuntimeRef = { backend: 'tmux', paneId: '%1' }
const identity = { pid: 42, executable: 'claude', startMarker: 'Sat Aug 15 10:00:00 2026' }

function session(runtimes: TerminalRuntimeRef[] = [tmux]): RegisteredSession {
  return {
    schemaVersion: 2, active: true, agentId: 'agent-1', sessionId: '', boundAt: null, engine: 'claude',
    transcriptPath: null, projectDir: 'work', cwd: '/work', runtimes,
    primaryRuntimeKey: terminalRouteKey(runtimes[0]), tmuxPane: runtimes.find((runtime) => runtime.backend === 'tmux')?.paneId ?? '',
    source: null, title: null, model: null, cliVersion: null, processIdentity: identity,
    registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }
}

function observed(runtimes: TerminalRuntimeRef[]): DiscoveredTerminalAgent {
  return {
    engine: 'claude', cwd: '/work', processIdentity: identity, args: 'claude', resumeSessionId: null,
    runtimes, primaryRuntimeKey: terminalRouteKey(runtimes[0]),
  }
}

function probe(targets: TerminalAgentProbe['targets'], agents: DiscoveredTerminalAgent[] = []): TerminalAgentProbe {
  return { processTableAvailable: true, targets, agents, ambiguousPlacements: new Set() }
}

describe('composite terminal reconciliation', () => {
  it('defers early startup hooks until restored panes have their original owners', async () => {
    const current = { ...session([tmux]), sessionId: 'saved-conversation', processIdentity: null }
    const onRemoved = vi.fn()
    const onDiscovered = vi.fn()
    const onObserved = vi.fn()
    const probed = vi.fn(async (_hints: ReadonlyMap<string, unknown>) =>
      probe([{ instanceId: 'tmux:default', result: { state: 'available' as const, roots: [] } }]))
    const reconciler = new TerminalAgentReconciler({
      deferUntilStart: true,
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered, onObserved, onDormant: vi.fn(), onRemoved, probe: probed,
    })
    const restored: TerminalRuntimeRef = { backend: 'tmux', paneId: '%24' }
    // Hooks from an earlier restored pane used to run two full negative inventories here and
    // remove this row before its new pane was allocated. Never block a hook waiting for boot.
    await reconciler.triggerHint(restored, 'claude')
    await reconciler.trigger()
    expect(probed).not.toHaveBeenCalled()
    expect(onRemoved).not.toHaveBeenCalled()

    current.runtimes = [restored]
    current.primaryRuntimeKey = terminalRouteKey(restored)
    current.launch = { state: 'starting' }
    const live = observed([restored])
    probed.mockImplementation(async () => probe([
      { instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime: restored, rootPid: 1, cwd: '/work' }] } },
    ], [live]))
    try {
      await reconciler.start(60_000)
      expect(probed).toHaveBeenCalledWith(new Map([[terminalRouteKey(restored), 'claude']]))
      expect(onObserved).toHaveBeenCalledWith(live, current)
      expect(onDiscovered).not.toHaveBeenCalled()
      expect(onRemoved).not.toHaveBeenCalled()
    } finally { reconciler.stop() }
  })

  it('advertises a retained pane even when no engine process is observed', async () => {
    const current = { ...session([tmux]), active: false }
    const onTerminalAvailability = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
      onTerminalAvailability,
      probe: async () => probe([
        { instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime: tmux, rootPid: 1, cwd: '/work' }] } },
      ]),
    })

    await reconciler.trigger()

    expect(onTerminalAvailability).toHaveBeenCalledWith(current, true)
  })

  it('still verifies retained panes when the process table is unavailable', async () => {
    const current = { ...session([tmux]), active: false }
    const onTerminalAvailability = vi.fn()
    const onProbeStatus = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
      onTerminalAvailability, onProbeStatus,
      probe: async () => ({
        processTableAvailable: false,
        targets: [{ instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime: tmux, rootPid: 1, cwd: '/work' }] } }],
        agents: [], ambiguousPlacements: new Set(),
      }),
    })

    await reconciler.trigger()

    expect(onTerminalAvailability).toHaveBeenCalledWith(current, true)
    expect(onProbeStatus).toHaveBeenCalledWith({ ready: true, error: 'process table unavailable' })
  })

  it('awaits the initial discovery pass before start resolves', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const probed = vi.fn(async () => {
      await pending
      return probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [] } }])
    })
    const reconciler = new TerminalAgentReconciler({
      current: () => [], backends: [], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(), probe: probed,
    })
    let started = false
    const start = reconciler.start(60_000).then(() => { started = true })
    await Promise.resolve()
    expect(started).toBe(false)
    release()
    await start
    expect(started).toBe(true)
    reconciler.stop()
  })

  it('does not count an unavailable backend as a confirmed miss', async () => {
    const current = session([tmux])
    const onDormant = vi.fn()
    const onRemoved = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved,
      probe: async () => probe([{ instanceId: 'tmux:default', result: { state: 'unavailable', reason: 'stopped' } }]),
    })
    await reconciler.trigger()
    await reconciler.trigger()
    expect(onDormant).not.toHaveBeenCalled()
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('removes only after two successful negative inventories', async () => {
    const current = session([tmux])
    const onRemoved = vi.fn()
    const validate = vi.fn(async () => ({ state: 'gone' as const, reason: 'process exited' }))
    const backend = { instanceId: 'tmux:default', validate } as unknown as TerminalBackend
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [backend], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant: vi.fn(), onRemoved,
      probe: async () => probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [] } }]),
    })
    await reconciler.trigger()
    expect(onRemoved).not.toHaveBeenCalled()
    await reconciler.trigger()
    expect(onRemoved).toHaveBeenCalledWith(current, 'terminal runtime absent after 2 confirmed scans')
    expect(validate).toHaveBeenCalledTimes(2)
  })

  it('keeps a pane advertised but marks its missing engine dormant after two scans', async () => {
    const current = session([tmux])
    const onDormant = vi.fn()
    const onRemoved = vi.fn()
    const validate = vi.fn(async () => ({ state: 'alive' as const }))
    const backend = { instanceId: 'tmux:default', validate } as unknown as TerminalBackend
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [backend], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved,
      probe: async () => probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [] } }]),
    })

    await reconciler.trigger()
    await reconciler.trigger()
    await reconciler.trigger()

    expect(validate).toHaveBeenCalledTimes(3)
    expect(onDormant).toHaveBeenCalledTimes(1)
    expect(onDormant).toHaveBeenCalledWith(current, 'engine process absent after 2 confirmed scans')
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('does not count a scan that began before the engine was identified against that engine', async () => {
    // The race four agents created at once hit (e2e/soak.e2e.ts): the first scan finds the pane still
    // running its launcher; the new-pane watcher identifies the engine while the second scan's probe
    // runs, and that probe, taken before the engine existed, used to count its second miss.
    const current: RegisteredSession = { ...session([tmux]), processIdentity: null, launch: { state: 'starting' } }
    const pane = { runtime: tmux, rootPid: 1, cwd: '/work' }
    let whileProbing: (() => void) | null = null
    const onDormant = vi.fn()
    const onObserved = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved, onDormant, onRemoved: vi.fn(),
      probe: async () => {
        whileProbing?.()
        whileProbing = null
        return probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [pane] } }])
      },
    })
    await reconciler.trigger()
    whileProbing = () => { current.processIdentity = identity; current.launch = { state: 'ready' } }
    await reconciler.trigger()
    expect(onDormant).not.toHaveBeenCalled()
    // A probe that began after the engine was identified does speak for it, from a count of one.
    await reconciler.trigger()
    expect(onDormant).not.toHaveBeenCalled()
    await reconciler.trigger()
    expect(onDormant).toHaveBeenCalledWith(current, 'engine process absent after 2 confirmed scans')
    expect(onObserved).not.toHaveBeenCalled()
  })

  it('counts misses against one engine: an engine identified since starts again', async () => {
    const current = session([tmux])
    const pane = { runtime: tmux, rootPid: 1, cwd: '/work' }
    const onDormant = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved: vi.fn(),
      probe: async () => probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [pane] } }]),
    })
    await reconciler.trigger()
    current.processIdentity = { ...identity, pid: 43 }
    await reconciler.trigger()
    expect(onDormant).not.toHaveBeenCalled()
    await reconciler.trigger()
    expect(onDormant).toHaveBeenCalledTimes(1)
  })

  it('does not judge an agent created, or a pane given to one, while the probe ran', async () => {
    const agents: RegisteredSession[] = []
    const moved: TerminalRuntimeRef = { backend: 'tmux', paneId: '%2' }
    let whileProbing: (() => void) | null = null
    const onDormant = vi.fn()
    const onRemoved = vi.fn()
    const validate = vi.fn(async () => ({ state: 'gone' as const, reason: 'no such pane' }))
    const backend = { instanceId: 'tmux:default', validate } as unknown as TerminalBackend
    const reconciler = new TerminalAgentReconciler({
      current: () => agents, backends: [backend], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved,
      probe: async () => {
        whileProbing?.()
        whileProbing = null
        return probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [] } }])
      },
    })
    // Created mid-probe: the inventory was taken before its pane existed.
    whileProbing = () => { agents.push(session([tmux])) }
    await reconciler.trigger()
    // Given a new pane mid-probe: the same.
    whileProbing = () => {
      agents[0].runtimes = [moved]
      agents[0].primaryRuntimeKey = terminalRouteKey(moved)
    }
    await reconciler.trigger()
    expect(onRemoved).not.toHaveBeenCalled()
    expect(onDormant).not.toHaveBeenCalled()
    // Probes that began after both judge the pane as they find it: gone, twice.
    await reconciler.trigger()
    expect(onRemoved).not.toHaveBeenCalled()
    await reconciler.trigger()
    expect(onRemoved).toHaveBeenCalledWith(agents[0], 'terminal runtime absent after 2 confirmed scans')
  })

  it('does not open an agent for a route that was held and released while the probe ran', async () => {
    // A stop retiring a starting agent's pane holds its route and lets it go; a probe taken before it
    // still saw the engine there, and opened a second agent for a pane that no longer existed.
    const onDiscovered = vi.fn()
    const route = terminalRouteKey(tmux)
    let whileProbing: (() => void) | null = null
    const reconciler = new TerminalAgentReconciler({
      current: () => [], backends: [], backendOrder: ['tmux'],
      onDiscovered, onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
      probe: async () => {
        whileProbing?.()
        whileProbing = null
        return probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime: tmux, rootPid: 1, cwd: '/work' }] } }], [observed([tmux])])
      },
    })
    whileProbing = () => { reconciler.holdRoute(route); reconciler.releaseRoute(route) }
    await reconciler.trigger()
    expect(onDiscovered).not.toHaveBeenCalled()
    // Releasing a route nobody held changes nothing, and a probe that began afterwards speaks for it.
    reconciler.releaseRoute(route)
    await reconciler.trigger()
    expect(onDiscovered).toHaveBeenCalledTimes(1)
  })

  it('does not count a miss for an agent whose route changed hands while the probe ran', async () => {
    const current = session([tmux])
    const pane = { runtime: tmux, rootPid: 1, cwd: '/work' }
    const route = terminalRouteKey(tmux)
    let whileProbing: (() => void) | null = null
    const onDormant = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved: vi.fn(),
      probe: async () => {
        whileProbing?.()
        whileProbing = null
        return probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [pane] } }])
      },
    })
    await reconciler.trigger()
    whileProbing = () => { reconciler.holdRoute(route); reconciler.releaseRoute(route) }
    await reconciler.trigger()
    expect(onDormant).not.toHaveBeenCalled()
    await reconciler.trigger()
    expect(onDormant).toHaveBeenCalledTimes(1)
  })

  it('keeps an agent active when pane-specific validation is inconclusive', async () => {
    const current = session([tmux])
    const onDormant = vi.fn()
    const onRemoved = vi.fn()
    const validate = vi.fn(async () => ({ state: 'unknown' as const, reason: 'process table timed out' }))
    const backend = { instanceId: 'tmux:default', validate } as unknown as TerminalBackend
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [backend], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved,
      probe: async () => probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [] } }]),
    })

    await reconciler.trigger()
    await reconciler.trigger()

    expect(onDormant).not.toHaveBeenCalled()
    expect(onRemoved).not.toHaveBeenCalled()
  })

})

describe('restart route hold', () => {
  it('skips dormant-detection for a held route while a restart is in progress', async () => {
    const current = session([tmux])
    const onDormant = vi.fn()
    const onRemoved = vi.fn()
    // Same shape as "keeps a pane advertised but marks its missing engine dormant after two scans"
    // above: the pane's terminal placement validates alive, but no engine process is ever observed —
    // ordinarily that drives the agent dormant after MISS_LIMIT scans.
    const validate = vi.fn(async () => ({ state: 'alive' as const }))
    const backend = { instanceId: 'tmux:default', validate } as unknown as TerminalBackend
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [backend], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved,
      probe: async () => probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [] } }]),
    })
    reconciler.holdRoute(terminalRouteKey(tmux))

    await reconciler.trigger()
    await reconciler.trigger()
    await reconciler.trigger()

    expect(onDormant).not.toHaveBeenCalled()
    expect(onRemoved).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
  })

  it('does not open the replacement process as a new agent while its route is held', async () => {
    const current = session([tmux])
    const replacement = {
      ...observed([tmux]),
      processIdentity: { pid: 99, executable: 'claude', startMarker: 'Sat Aug 15 10:05:00 2026' },
    }
    const onDiscovered = vi.fn()
    const onObserved = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered, onObserved, onDormant: vi.fn(), onRemoved: vi.fn(),
      probe: async () => probe(
        [{ instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime: tmux, rootPid: 1, cwd: '/work' }] } }],
        [replacement],
      ),
    })
    reconciler.holdRoute(terminalRouteKey(tmux))

    await reconciler.trigger()

    expect(onDiscovered).not.toHaveBeenCalled()
    // The pre-existing agent isn't rebound through ordinary observation either — the restart handler
    // owns that via `registry.updateProcessIdentity` once it confirms the new process itself.
    expect(onObserved).not.toHaveBeenCalled()
  })

  it('resumes normal reconciliation once the route is released', async () => {
    const current = session([tmux])
    const onDormant = vi.fn()
    const validate = vi.fn(async () => ({ state: 'alive' as const }))
    const backend = { instanceId: 'tmux:default', validate } as unknown as TerminalBackend
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [backend], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved: vi.fn(),
      probe: async () => probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [] } }]),
    })
    const routeKey = terminalRouteKey(tmux)
    reconciler.holdRoute(routeKey)
    await reconciler.trigger()
    expect(onDormant).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()

    reconciler.releaseRoute(routeKey)
    await reconciler.trigger()
    await reconciler.trigger()

    expect(onDormant).toHaveBeenCalledTimes(1)
  })
})

describe('verified process adoption', () => {
  it('opens a sessionless agent through the normal discovery callback without another inventory scan', async () => {
    let current: RegisteredSession[] = []
    const candidate = observed([tmux])
    const onDiscovered = vi.fn(async () => { current = [session([tmux])] })
    const probeSnapshot = vi.fn(async () => {
      throw new Error('verified adoption must not run the general probe')
    })
    let transactionCalls = 0
    const transaction = async <T>(apply: () => T | Promise<T>): Promise<T> => {
      transactionCalls += 1
      return await apply()
    }
    const reconciler = new TerminalAgentReconciler({
      current: () => current, backends: [], backendOrder: ['tmux'],
      onDiscovered, onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
      probe: probeSnapshot, transaction,
    })

    const adopted = await reconciler.adoptVerified(candidate)

    expect(adopted).toBe(current[0])
    expect(adopted?.sessionId).toBe('')
    expect(adopted?.processIdentity).toEqual(identity)
    expect(onDiscovered).toHaveBeenCalledWith(candidate)
    expect(transactionCalls).toBe(1)
    expect(probeSnapshot).not.toHaveBeenCalled()
  })

  it('refreshes an already adopted process instead of opening a duplicate agent', async () => {
    const existing = session([tmux])
    const onDiscovered = vi.fn()
    const onObserved = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [existing], backends: [], backendOrder: ['tmux'],
      onDiscovered, onObserved, onDormant: vi.fn(), onRemoved: vi.fn(),
    })

    const adopted = await reconciler.adoptVerified(observed([tmux]))

    expect(adopted).toBe(existing)
    expect(onObserved).toHaveBeenCalledWith(observed([tmux]), existing)
    expect(onDiscovered).not.toHaveBeenCalled()
  })

  it('keeps a sessionless agent when the engine replaces its process inside the same pane', async () => {
    const existing = session([tmux])
    const replacement = {
      ...observed([tmux]),
      processIdentity: { pid: 84, executable: 'claude', startMarker: 'Sat Aug 15 10:00:02 2026' },
    }
    let current = existing
    const onObserved = vi.fn(async (candidate: DiscoveredTerminalAgent) => {
      current = { ...current, processIdentity: candidate.processIdentity }
    })
    const onDiscovered = vi.fn()
    const onRemoved = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered, onObserved, onDormant: vi.fn(), onRemoved,
      probe: async () => probe(
        [{ instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime: tmux, rootPid: 1, cwd: '/work' }] } }],
        [replacement],
      ),
    })

    await reconciler.trigger()

    expect(onObserved).toHaveBeenCalledWith(replacement, existing)
    expect(current.agentId).toBe(existing.agentId)
    expect(current.processIdentity).toEqual(replacement.processIdentity)
    expect(onDiscovered).not.toHaveBeenCalled()
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('validates an unbound route by its live engine rather than its provisional process id', async () => {
    const current = session([tmux])
    const validate = vi.fn(async () => ({ state: 'alive' as const }))
    const backend = { instanceId: 'tmux:default', validate } as unknown as TerminalBackend
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [backend], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
      probe: async () => probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [] } }]),
    })

    await reconciler.trigger()

    expect(validate).toHaveBeenCalledWith(tmux, { engine: 'claude', processIdentity: undefined })
  })

  it('sees a resumed row that has its conversation but not yet its process', async () => {
    // `resumePendingAgent` keeps the archived sessionId and clears processIdentity, so this row can
    // only be matched by its route. It used to be skipped for having an id at all — leaving the one
    // row that is waiting to be confirmed invisible to every scan, and its launch state stuck.
    const current = {
      ...session([tmux]),
      sessionId: 'archived-conversation',
      processIdentity: null,
      resumeOnly: true as const,
      active: false,
      launch: { state: 'failed' as const, error: 'RESUME_UNCONFIRMED', detail: 'not confirmed' },
    }
    const onObserved = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved, onDormant: vi.fn(), onRemoved: vi.fn(),
      probe: async () => probe(
        [{ instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime: tmux, rootPid: 1, cwd: '/work' }] } }],
        [observed([tmux])],
      ),
    })

    await reconciler.trigger()

    expect(onObserved).toHaveBeenCalledOnce()
    expect(onObserved.mock.calls[0][1]).toBe(current)
  })

  it('leaves a bound row with its own process to process identity alone', async () => {
    // Both an id and a process: the stricter rule still holds, so another engine in the same pane
    // cannot inherit this row's transcript through the route.
    const current = { ...session([tmux]), sessionId: 'bound-conversation' }
    const onObserved = vi.fn()
    const intruder: DiscoveredTerminalAgent = {
      ...observed([tmux]),
      processIdentity: { pid: 999, executable: 'claude', startMarker: 'Tue Sep 24 09:00:00 2026' },
    }
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved, onDormant: vi.fn(), onRemoved: vi.fn(),
      probe: async () => probe(
        [{ instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime: tmux, rootPid: 1, cwd: '/work' }] } }],
        [intruder],
      ),
    })

    await reconciler.trigger()

    expect(onObserved).not.toHaveBeenCalled()
  })

  it('reports no adopted agent when the registry callback rejects the process', async () => {
    const onDiscovered = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [], backends: [], backendOrder: ['tmux'],
      onDiscovered, onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
    })

    expect(await reconciler.adoptVerified(observed([tmux]))).toBeUndefined()
    expect(onDiscovered).toHaveBeenCalledOnce()
  })
})

describe('start()', () => {
  it('keeps scanning when the opening pass fails — the interval is armed before it runs', async () => {
    // Awaiting first meant one bad probe left discovery unscheduled for the life of the daemon, and
    // rejected the caller's start-up on the way: no agents, no liveness, `discoveryReady` never true.
    vi.useFakeTimers()
    try {
      let pass = 0
      const scan = vi.fn(async () => {
        pass++
        if (pass === 1) throw new Error('ps timed out')
        return probe([])
      })
      const reconciler = new TerminalAgentReconciler({
        current: () => [], backends: [], backendOrder: ['tmux'],
        onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
        probe: scan,
      })
      await expect(reconciler.start(5_000)).resolves.toBeUndefined()
      expect(scan).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(scan).toHaveBeenCalledTimes(2)
      reconciler.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a terminal pane (engine `terminal`)', () => {
  const live = [{ instanceId: 'tmux:default', result: { state: 'available' as const, roots: [{ runtime: tmux, rootPid: 1, cwd: '/work' }] } }]
  function terminal(overrides: Partial<RegisteredSession> = {}): RegisteredSession {
    return { ...session([tmux]), engine: 'terminal', terminalHost: true, processIdentity: null, ...overrides }
  }

  it('is never marked dormant for having no engine process — a shell at its prompt is the normal state', async () => {
    const current = terminal()
    const onDormant = vi.fn()
    const onRemoved = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved,
      probe: async () => probe(live),
    })
    for (let i = 0; i < 4; i++) await reconciler.trigger()
    expect(onDormant).not.toHaveBeenCalled()
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('owns an engine process that appears in its pane: observed for THIS row, never discovered as a new agent', async () => {
    const current = terminal()
    const onDiscovered = vi.fn()
    const onObserved = vi.fn()
    const claude = observed([tmux])
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered, onObserved, onDormant: vi.fn(), onRemoved: vi.fn(),
      probe: async () => probe(live, [claude]),
    })
    await reconciler.trigger()
    expect(onDiscovered).not.toHaveBeenCalled()
    expect(onObserved).toHaveBeenCalledTimes(1)
    expect(onObserved.mock.calls[0][1]).toBe(current)
    expect(onObserved.mock.calls[0][0]).toMatchObject({ engine: 'claude', processIdentity: identity })
  })

  it('reports the adopted engine dormant when it exits and the pane lives on (the handler turns it back into a terminal)', async () => {
    const current = terminal({ engine: 'claude', processIdentity: identity })
    const onDormant = vi.fn()
    const onRemoved = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved,
      probe: async () => probe(live),
    })
    await reconciler.trigger()
    expect(onDormant).not.toHaveBeenCalled()
    await reconciler.trigger()
    expect(onDormant).toHaveBeenCalledWith(current, 'engine process absent after 2 confirmed scans')
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('is removed like any agent once its pane is gone — the shell exited', async () => {
    const current = terminal()
    const onRemoved = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant: vi.fn(), onRemoved,
      probe: async () => probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [] } }]),
    })
    await reconciler.trigger()
    expect(onRemoved).not.toHaveBeenCalled()
    await reconciler.trigger()
    expect(onRemoved).toHaveBeenCalledWith(current, 'terminal runtime absent after 2 confirmed scans')
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import type { TerminalBackend } from './terminalBackend.js'
import { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRuntimeRef, TerminalStreamHandle, TerminalStreamSink } from './terminalTypes.js'

const tmux: TerminalRuntimeRef = { backend: 'tmux', paneId: '%1' }
const second: TerminalRuntimeRef = { backend: 'tmux', paneId: '%2' }

function session(): RegisteredSession {
  return {
    schemaVersion: 2, active: true, agentId: 'agent-1', sessionId: 's1', boundAt: 1, engine: 'claude', transcriptPath: null,
    projectDir: 'work', cwd: '/work', runtimes: [tmux, second], primaryRuntimeKey: terminalRouteKey(tmux), tmuxPane: '%1',
    source: null, title: null, model: null, cliVersion: null,
    processIdentity: { pid: 42, executable: 'claude', startMarker: 'Sat Aug 15 10:00:00 2026' },
    registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }
}

function backend(instanceId: string, submit: TerminalBackend['submitText']): TerminalBackend {
  return {
    name: 'tmux', instanceId,
    create: vi.fn(), kill: vi.fn(), inventory: vi.fn(),
    titles: vi.fn(async () => ({ state: 'succeeded' as const, value: new Map() })),
    validate: vi.fn(async () => ({ state: 'alive' as const })), capture: vi.fn(), typeLiteral: vi.fn(), submitText: submit,
    sendKey: vi.fn(), setTitle: vi.fn(), notify: vi.fn(),
  }
}

function streamHandle(): TerminalStreamHandle {
  return {
    runtime: tmux,
    beginSnapshot: vi.fn(),
    snapshot: vi.fn(async () => ({
      state: 'succeeded' as const,
      value: { bytes: new Uint8Array(), cols: 80, rows: 24 },
    })),
    endSnapshot: vi.fn(),
    writeRaw: vi.fn(),
    pasteRaw: vi.fn(),
    resize: vi.fn(),
    scroll: vi.fn(),
    pauseOutput: vi.fn(),
    resumeOutput: vi.fn(),
    close: vi.fn(),
  }
}

/** A submit that answers `onFirst` on the first pane and succeeds on any other. */
function submitBy(onFirst: Awaited<ReturnType<TerminalBackend['submitText']>>) {
  return vi.fn(async (runtime: TerminalRuntimeRef) => runtime.paneId === tmux.paneId
    ? onFirst
    : { state: 'succeeded' as const, dispatch: 'executed' as const })
}

describe('TerminalBackendCoordinator', () => {
  it('opens a retained terminal runtime even when engine discovery marked the agent dormant', async () => {
    const tmuxBackend = backend('tmux:default', vi.fn())
    const handle = streamHandle()
    tmuxBackend.openStream = vi.fn(async () => ({ state: 'succeeded' as const, value: handle }))
    const coordinator = new TerminalBackendCoordinator([tmuxBackend], ['tmux'])
    const current = session()
    current.active = false
    const sink: TerminalStreamSink = { onData: vi.fn(), onClose: vi.fn() }

    await expect(coordinator.openStream(current, { cols: 80, rows: 24 }, sink)).resolves.toEqual({
      state: 'succeeded', value: handle,
    })
    expect(tmuxBackend.openStream).toHaveBeenCalledWith(
      tmux,
      { engine: 'claude', processIdentity: current.processIdentity },
      { cols: 80, rows: 24 },
      sink,
      false,
    )
  })

  it('reports the backend failure when a dormant agent no longer has a terminal pane', async () => {
    const tmuxBackend = backend('tmux:default', vi.fn())
    tmuxBackend.openStream = vi.fn(async () => ({ state: 'failed' as const, reason: 'tmux pane is unavailable' }))
    const coordinator = new TerminalBackendCoordinator([tmuxBackend], ['tmux'])
    const current = session()
    current.active = false

    await expect(coordinator.openStream(
      current,
      { cols: 80, rows: 24 },
      { onData: vi.fn(), onClose: vi.fn() },
    )).resolves.toEqual({ state: 'failed', reason: 'tmux pane is unavailable' })
  })

  it('merges title snapshots and prefers the primary runtime title', async () => {
    const tmuxBackend = backend('tmux:default', vi.fn())
    tmuxBackend.titles = vi.fn(async () => ({ state: 'succeeded' as const, value: new Map([
      [terminalRouteKey(tmux), 'first title'],
      [terminalRouteKey(second), 'second title'],
    ]) }))
    const coordinator = new TerminalBackendCoordinator([tmuxBackend], ['tmux'])
    const current = session()
    current.primaryRuntimeKey = terminalRouteKey(second)
    const titles = await coordinator.titles()
    expect(titles.size).toBe(2)
    expect(coordinator.titleFor(current, titles)).toBe('second title')
  })

  it('fails over only when dispatch is proven not to have started', async () => {
    const submit = submitBy({ state: 'failed', dispatch: 'not_started', reason: 'missing' })
    const result = await new TerminalBackendCoordinator([backend('tmux:default', submit)], ['tmux']).submitText(session(), 'hello')
    expect(result).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit).toHaveBeenLastCalledWith(second, 'hello', undefined)
  })

  it('never retries a possibly executed side effect', async () => {
    const submit = submitBy({ state: 'unknown', dispatch: 'possibly_executed', reason: 'lost response' })
    const result = await new TerminalBackendCoordinator([backend('tmux:default', submit)], ['tmux']).submitText(session(), 'hello')
    expect(result).toMatchObject({ state: 'unknown', dispatch: 'possibly_executed' })
    expect(submit).toHaveBeenCalledOnce()
  })

  it('allows read-only capture failover', async () => {
    const tmuxBackend = backend('tmux:default', vi.fn())
    tmuxBackend.capture = vi.fn(async (runtime: TerminalRuntimeRef) => runtime.paneId === tmux.paneId
      ? { state: 'failed' as const, reason: 'capture failed' }
      : { state: 'succeeded' as const, value: 'screen' })
    const coordinator = new TerminalBackendCoordinator([tmuxBackend], ['tmux'])
    const current = session()
    await expect(coordinator.capture(current)).resolves.toEqual({ state: 'succeeded', value: 'screen' })
    const acquired = await coordinator.acquireLease(current)
    expect(acquired.state).toBe('succeeded')
    if (acquired.state !== 'succeeded') return
    expect(coordinator.leaseIsCurrent(acquired.value, current)).toBe(true)
  })

  it.each(['terminal', 'claude'] as const)('captures a retained %s pane without enabling dormant engine controls', async engine => {
    const tmuxBackend = backend('tmux:default', vi.fn())
    tmuxBackend.capture = vi.fn(async () => ({ state: 'succeeded' as const, value: 'saved screen' }))
    const coordinator = new TerminalBackendCoordinator([tmuxBackend], ['tmux'])
    const current = { ...session(), engine, active: false }
    await expect(coordinator.capture(current)).resolves.toMatchObject({ state: 'failed' })
    await expect(coordinator.acquireLease(current)).resolves.toMatchObject({ state: 'failed' })
    await expect(coordinator.validate(current)).resolves.toMatchObject({ state: 'gone' })
    expect(tmuxBackend.capture).not.toHaveBeenCalled()
    await expect(coordinator.captureRetained(current, { historyLines: 2000 })).resolves.toEqual({
      state: 'succeeded', value: 'saved screen',
    })
    expect(tmuxBackend.capture).toHaveBeenCalledExactlyOnceWith(tmux, { historyLines: 2000 })
    expect(tmuxBackend.validate).not.toHaveBeenCalled()
    expect(current.active).toBe(false)
  })

  it('captures only retained routes and reports unavailable panes instead of inventing a snapshot', async () => {
    const tmuxBackend = backend('tmux:default', vi.fn())
    const captures = vi.fn(async (runtime: TerminalRuntimeRef) => runtime.paneId === tmux.paneId
      ? { state: 'failed' as const, reason: 'pane unavailable' }
      : { state: 'succeeded' as const, value: '' })
    tmuxBackend.capture = captures
    const coordinator = new TerminalBackendCoordinator([tmuxBackend], ['tmux'])
    const current = { ...session(), active: false }
    await expect(coordinator.captureRetained(current)).resolves.toEqual({ state: 'succeeded', value: '' })
    expect(captures.mock.calls.map(([runtime]) => runtime)).toEqual([tmux, second])
    current.runtimes = [tmux]
    await expect(coordinator.captureRetained(current)).resolves.toEqual({ state: 'failed', reason: 'pane unavailable' })
    coordinator.replaceBackends([])
    await expect(coordinator.captureRetained(current)).resolves.toMatchObject({ state: 'failed' })
    expect(captures).toHaveBeenCalledTimes(3)
  })

  it('uses lease-aware pre-dispatch fallback but never retries ambiguous completion', async () => {
    const tmuxBackend = backend('tmux:default', submitBy({ state: 'failed', dispatch: 'rejected', reason: 'rejected' }))
    const coordinator = new TerminalBackendCoordinator([tmuxBackend], ['tmux'])
    const current = session()
    const acquired = await coordinator.acquireLease(current)
    expect(acquired.state).toBe('succeeded')
    if (acquired.state !== 'succeeded') return
    await expect(coordinator.submitTextForLease(current, acquired.value, 'hello')).resolves.toEqual({
      state: 'succeeded', dispatch: 'executed',
    })
    expect(acquired.value.runtime).toEqual(second)

    const ambiguous = submitBy({ state: 'unknown', dispatch: 'possibly_executed', reason: 'lost response' })
    tmuxBackend.submitText = ambiguous
    const another = await coordinator.acquireLease(current)
    if (another.state !== 'succeeded') return
    await expect(coordinator.submitTextForLease(current, another.value, 'again')).resolves.toMatchObject({
      state: 'unknown', dispatch: 'possibly_executed',
    })
    expect(ambiguous).toHaveBeenCalledOnce()
  })

  it('never changes placement for a side effect issued through an already pinned multi-step lease', async () => {
    const submit = submitBy({ state: 'failed', dispatch: 'rejected', reason: 'rejected' })
    const coordinator = new TerminalBackendCoordinator([backend('tmux:default', submit)], ['tmux'])
    const acquired = await coordinator.acquireLease(session())
    expect(acquired.state).toBe('succeeded')
    if (acquired.state !== 'succeeded') return

    await expect(coordinator.submitTextLease(acquired.value, 'hello')).resolves.toMatchObject({
      state: 'failed', dispatch: 'rejected',
    })
    expect(submit).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledWith(tmux, 'hello', undefined)
  })

  it('refuses a revoked submit after the locator validation awaited', async () => {
    const submit = submitBy({ state: 'succeeded', dispatch: 'executed' })
    const terminal = backend('tmux:default', submit)
    const coordinator = new TerminalBackendCoordinator([terminal], ['tmux'])
    const current = session(), acquired = await coordinator.acquireLease(current)
    if (acquired.state !== 'succeeded') throw new Error('no lease')
    let allowed = true
    terminal.validate = vi.fn(async () => { allowed = false; return { state: 'alive' as const } })
    expect(await coordinator.submitTextForLease(current, acquired.value, 'hello', { allowed: () => allowed }))
      .toMatchObject({ state: 'failed', dispatch: 'not_started', reason: 'terminal control revoked' })
    expect(submit).not.toHaveBeenCalled()
  })

  it('hands the check before the Enter to the backend, on every way a text is submitted', async () => {
    const submit = submitBy({ state: 'succeeded', dispatch: 'executed' })
    const coordinator = new TerminalBackendCoordinator([backend('tmux:default', submit)], ['tmux'])
    const options = { beforeEnter: async () => null }
    await coordinator.submitText(session(), 'hello', options)
    const acquired = await coordinator.acquireLease(session())
    if (acquired.state !== 'succeeded') throw new Error('no lease')
    await coordinator.submitTextLease(acquired.value, 'hello', options)
    await coordinator.submitTextForLease(session(), acquired.value, 'hello', options)
    expect(submit.mock.calls.map((call) => (call as unknown[])[2])).toEqual([options, options, options])
  })

  it('keeps an active lease valid when the backends are replaced by the same instance', async () => {
    const tmuxBackend = backend('tmux:default', vi.fn())
    const coordinator = new TerminalBackendCoordinator([tmuxBackend], ['tmux'])
    const current = session()
    const acquired = await coordinator.acquireLease(current)
    expect(acquired.state).toBe('succeeded')
    if (acquired.state !== 'succeeded') return

    coordinator.replaceBackends([tmuxBackend])

    expect(coordinator.leaseIsCurrent(acquired.value, current)).toBe(true)
    await expect(coordinator.validateLease(acquired.value, current)).resolves.toBe(true)
  })

  describe('a validation that cannot answer yet is asked again', () => {
    const waits: number[] = []
    const patient = (validate: TerminalBackend['validate']) => {
      const tmuxBackend = { ...backend('tmux:default', vi.fn()), validate: vi.fn(validate) }
      waits.length = 0
      const coordinator = new TerminalBackendCoordinator([tmuxBackend], ['tmux'], {
        unknownRetryMs: [10, 20, 30], sleep: async (ms) => { waits.push(ms) },
      })
      return { coordinator, tmuxBackend }
    }

    it('a probe that failed (a held event loop timed it out) is not taken for a dead terminal', async () => {
      const answers = [{ state: 'unknown' as const, reason: 'tmux runtime probe failed' }, { state: 'alive' as const }]
      const { coordinator } = patient(async () => answers.shift()!)
      await expect(coordinator.validate(session())).resolves.toEqual({ state: 'alive' })
      expect(waits).toEqual([10])
    })

    it('an engine restarted in place is waited for until the row records it', async () => {
      // A message sent while a restart is between starting the new engine and recording it: the pane
      // holds a process the row does not know yet. It used to be dropped as "no longer running".
      const current = session()
      const { coordinator, tmuxBackend } = patient(async (_runtime, expected) =>
        expected.processIdentity?.pid === 43 ? { state: 'alive' } : { state: 'gone', reason: 'process changed under tmux pane', replaced: true })
      const acquiring = coordinator.acquireLease(current)
      await Promise.resolve()
      current.processIdentity = { pid: 43, executable: 'claude', startMarker: 'Sat Aug 15 10:01:00 2026' }
      await expect(acquiring).resolves.toMatchObject({ state: 'succeeded' })
      expect(tmuxBackend.validate).toHaveBeenLastCalledWith(tmux, expect.objectContaining({ processIdentity: current.processIdentity }))
    })

    it('does not hold a lease to an engine a restart replaced while the lease was checked', async () => {
      const current = session()
      current.runtimes = [tmux]
      let live = 42
      const tmuxBackend = { ...backend('tmux:default', vi.fn()), validate: vi.fn(async (_runtime: TerminalRuntimeRef, expected: { processIdentity?: { pid: number } }) =>
        expected.processIdentity?.pid === live ? { state: 'alive' as const } : { state: 'gone' as const, reason: 'process changed under tmux pane', replaced: true as const }) }
      // The restart records its new engine on the row while the check waits.
      const coordinator = new TerminalBackendCoordinator([tmuxBackend], ['tmux'], {
        unknownRetryMs: [10], sleep: async () => { current.processIdentity = { pid: 44, executable: 'claude', startMarker: 'Sat Aug 15 10:02:00 2026' } },
      })
      const acquired = await coordinator.acquireLease(current)
      if (acquired.state !== 'succeeded') throw new Error('no lease')
      live = 44
      await expect(coordinator.validateLease(acquired.value, current)).resolves.toBe(false)
    })

    it('waits on a terminal with no engine in it while a restart is replacing that engine', async () => {
      const answers = [{ state: 'gone' as const, reason: 'no claude process under pane %1' }, { state: 'alive' as const }]
      const { coordinator } = patient(async () => answers.shift()!)
      const current = session()
      current.runtimes = [tmux]
      coordinator.whileChanging((agentId) => agentId === current.agentId)
      await expect(coordinator.validate(current)).resolves.toEqual({ state: 'alive' })
      expect(waits).toEqual([10])
    })

    it('waits for a restored agent whose launch is starting before an engine process exists', async () => {
      // Found by QA on a quiet machine: a message after restore was rejected before Codex started.
      const answers = [{ state: 'gone' as const, reason: 'no codex process under pane %1' }, { state: 'alive' as const }]
      const { coordinator } = patient(async () => answers.shift()!)
      const current = session()
      current.engine = 'codex'
      current.runtimes = [tmux]
      current.processIdentity = null
      current.launch = { state: 'starting' }
      await expect(coordinator.validate(current)).resolves.toEqual({ state: 'alive' })
      expect(waits).toEqual([10])
    })

    it('bounds the wait for a restored engine that never starts', async () => {
      const { coordinator, tmuxBackend } = patient(async () => ({ state: 'gone', reason: 'no engine process' }))
      const current = session()
      current.runtimes = [tmux]
      current.launch = { state: 'starting' }
      await expect(coordinator.acquireLease(current)).resolves.toMatchObject({ state: 'failed' })
      expect(waits).toEqual([10, 20, 30])
      expect(tmuxBackend.validate).toHaveBeenCalledTimes(4)
    })

    it('stops waiting when a restored launch fails', async () => {
      const current = session()
      current.runtimes = [tmux]
      current.launch = { state: 'starting' }
      const { coordinator } = patient(async () => {
        if (waits.length) current.launch = { state: 'failed', error: 'ENGINE_EXITED' }
        return { state: 'gone', reason: 'no engine process' }
      })
      await expect(coordinator.validate(current)).resolves.toMatchObject({ state: 'gone' })
      expect(waits).toEqual([10])
    })

    it('gives the last answer once the waits run out, and never waits on a terminal known to be gone', async () => {
      const unknown = patient(async () => ({ state: 'unknown' as const, reason: 'still failing' }))
      const current = session()
      current.runtimes = [tmux]
      await expect(unknown.coordinator.validate(current)).resolves.toEqual({ state: 'unknown', reason: 'still failing' })
      expect(waits).toEqual([10, 20, 30])
      const lease = { agentId: current.agentId, runtime: tmux, placementKey: 'tmux:default\u0000%1', generation: '' }
      const gone = patient(async () => ({ state: 'gone' as const, reason: 'tmux has no pane %1' }))
      await expect(gone.coordinator.validate(current)).resolves.toEqual({ state: 'gone', reason: 'no configured terminal runtime is alive' })
      await expect(gone.coordinator.validateLease(lease, current)).resolves.toBe(false)
      await expect(gone.coordinator.submitText(current, 'hello')).resolves.toMatchObject({ dispatch: 'not_started' })
      expect(waits).toEqual([])
    })
  })
})

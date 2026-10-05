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
    expect(submit).toHaveBeenLastCalledWith(second, 'hello')
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
    expect(submit).toHaveBeenCalledWith(tmux, 'hello')
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
})

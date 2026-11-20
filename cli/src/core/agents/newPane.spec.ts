import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPENCLAW_STATES } from '../../engines/openclaw/contract.js'
import { IdentityReadUnavailable } from '../../engines/kit/identityScan.js'
import { RegistryOwnershipChanged, type RegisteredSession } from '../../lib/registry.js'
import { resolvePaneEngineProcess } from '../../lib/paneEngineProcess.js'
import type { TerminalBackend } from '../../lib/terminalBackend.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { createPaneWatcher, type PaneWatcherDeps } from './newPane.js'

vi.mock('../../lib/paneEngineProcess.js', async (real) => ({
  ...await real<object>(),
  resolvePaneEngineProcess: vi.fn(async () => null),
}))

const pending = { agentId: 'a1', sessionId: '', engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%7' }] } as RegisteredSession
const runtime = { backend: 'tmux' as const, paneId: '%7' }
const spawned = { runtime } as never
const identity = { pid: 99, startMarker: 'now', executable: 'claude' }
// The pane's backend: what the watcher asks about the pane it opened.
const paneState = vi.fn<TerminalBackend['paneState']>(async () => ({ dead: false, engineExit: null }) as never)
const releaseHold = vi.fn<TerminalBackend['releaseHold']>(async () => {})
const backend = { paneState, releaseHold } as unknown as TerminalBackend

/** The pane's own backend, answering whether it holds the launch's inert shell (`TerminalBackend.isHeld`). */
const holding = (isHeld: TerminalBackend['isHeld']): Partial<PaneWatcherDeps> => {
  const held = { ...backend, isHeld } as TerminalBackend
  return { terminals: { backendFor: vi.fn(() => held) } }
}

function setup(over: Partial<PaneWatcherDeps> = {}) {
  const rows = new Map<string, RegisteredSession>([['a1', structuredClone(pending)]])
  const deps: PaneWatcherDeps = {
    registry: {
      byAgent: vi.fn((agentId: string) => rows.get(agentId)),
      confirmLaunch: vi.fn<PaneWatcherDeps['registry']['confirmLaunch']>(async (id, input) => {
        const row = rows.get(id)
        if (!row) return { state: 'not-published' }
        const ready = { ...row, ...input, runtimes: [...(input.runtimes ?? row.runtimes)], active: true, launch: { state: 'ready' as const } }
        rows.set(id, ready)
        return { state: 'confirmed', entry: structuredClone(ready) }
      }),
      setLaunch: vi.fn((_agentId: string, launch: { state: string }) => ({ ...pending, launch }) as RegisteredSession),
      setTerminalAvailable: vi.fn(() => true),
      confirmEngineExit: vi.fn<PaneWatcherDeps['registry']['confirmEngineExit']>(async (id) => {
        const shell = { ...rows.get(id)!, engine: 'terminal' as const, sessionId: '', launch: { state: 'ready' as const } }
        rows.set(id, shell)
        return { state: 'confirmed', entry: structuredClone(shell) }
      }),
    } as unknown as PaneWatcherDeps['registry'],
    announceSession: vi.fn(),
    triggerHint: vi.fn(async () => {}),
    captureTerminal: vi.fn(async () => 'error: unknown flag --plan'),
    retainExitedSession: vi.fn(async () => ({ state: 'confirmed' as const, entry: null })),
    terminals: { backendFor: vi.fn(() => backend) },
    holdRoute: vi.fn(() => vi.fn()),
    ...over,
  }
  return { deps, rows, watch: createPaneWatcher(deps) }
}

describe('watching a new pane', () => {
  it('reports an unverified prepared executable without another shell lookup after the pane died', async () => {
    const { deps, watch } = setup()
    paneState.mockResolvedValue({ dead: true, engineExit: null } as never)
    const current = vi.fn(() => false)
    await watch('claude', pending, spawned, ['claude'], { command: 'claude', identity: 'original', current })
    expect(current).toHaveBeenCalledOnce()
    expect(deps.registry.setLaunch).toHaveBeenCalledWith('a1', expect.objectContaining({
      state: 'failed', error: 'ENGINE_DID_NOT_START', detail: expect.stringContaining('could not verify'),
    }))
  })
  it.each(['process', 'executable'] as const)('rejects replacement of a process already selected when the watcher started: %s', async change => {
    const entry = { ...pending, processIdentity: identity }
    const { deps, rows, watch } = setup()
    rows.set('a1', structuredClone(entry))
    vi.mocked(resolvePaneEngineProcess).mockImplementationOnce(async () => {
      rows.get('a1')!.processIdentity = change === 'process' ? { ...identity, startMarker: 'other' } : { ...identity, executable: 'other' }
      return identity
    })
    await watch('claude', entry, spawned, ['claude'], undefined)
    expect(deps.registry.confirmLaunch).not.toHaveBeenCalled()
    expect(releaseHold).not.toHaveBeenCalled()
  })

  it.each([[new Error('unavailable'), 'Error'], ['unavailable', 'string']])('reports a background bind failure after confirmed readiness: %s', async (error, kind) => {
    const { deps, watch } = setup()
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
    vi.mocked(deps.triggerHint).mockRejectedValueOnce(error)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(console.warn).toHaveBeenCalledWith(`[agent] background bind failed · claude · ${kind}`)
  })

  it('leaves the bound exit announcement to the retained-session transition', async () => {
    const { deps, rows, watch } = setup()
    const entry = { ...pending, sessionId: 'bound' }
    rows.set('a1', entry)
    paneState.mockResolvedValue({ dead: false, engineExit: 1 } as never)
    vi.mocked(deps.retainExitedSession).mockImplementationOnce(async () => {
      const shell = { ...pending, agentId: 'shell', engine: 'terminal' as const }
      rows.set('shell', shell)
      return { state: 'confirmed', entry: shell }
    })
    await watch('claude', entry, spawned, ['claude'], undefined)
    expect(releaseHold).toHaveBeenCalledOnce()
    expect(deps.announceSession).not.toHaveBeenCalled()
  })
  it.each(['same', 'gone', 'replaced', 'executable'] as const)('publishes only what the pane still runs, and reads it again when that changed: %s', async proof => {
    const { deps, rows, watch } = setup()
    const publish = vi.mocked(deps.registry.confirmLaunch).getMockImplementation()!
    vi.mocked(deps.registry.confirmLaunch).mockImplementation(async (id, input, authority) => {
      expect(authority?.current?.()).toBe(true)
      await authority?.refresh?.()
      return publish(id, input, authority)
    })
    const now = proof === 'gone' ? null
      : proof === 'replaced' ? { ...identity, startMarker: 'other' }
      : proof === 'executable' ? { ...identity, executable: 'other' } : identity
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(identity).mockResolvedValue(now)
    const watching = watch('claude', pending, spawned, ['claude'], undefined, 1_000)
    await vi.runAllTimersAsync()
    await watching
    // Never the process its refresh no longer found: what runs there now, or, with none, a start that never showed.
    expect(rows.get('a1')!.processIdentity).toEqual(now ?? undefined)
    expect(releaseHold).toHaveBeenCalledTimes(now ? 1 : 0)
    expect(deps.announceSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      launch: now ? { state: 'ready' } : expect.objectContaining({ state: 'failed', error: 'START_TIMEOUT' }) }))
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => String(line)).filter((line) => line.includes('create watch failed'))).toEqual([])
  })

  it('confirms an OpenClaw TUI that named itself between the watcher\'s look and its publication, as it now runs', async () => {
    // OpenClaw 2026.11.2's TUI starts as `node …/openclaw tui` and names itself `openclaw` about 0.1 s on (its
    // dist/entry.js sets `process.title`): the same pid and start. Seen between the two, the watch ended with
    // `IdentityReadUnavailable` and discovery confirmed the launch 10-28 s later (a slowed Mac, a slow arm64 Linux box).
    const { deps, rows, watch } = setup()
    const entry = { ...pending, engine: 'openclaw' } as RegisteredSession
    rows.set('a1', structuredClone(entry))
    const started = { pid: 99, startMarker: 'now', executable: 'node' }
    const named = { ...started, executable: 'openclaw' }
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(started).mockResolvedValue(named)
    const publish = vi.mocked(deps.registry.confirmLaunch).getMockImplementation()!
    vi.mocked(deps.registry.confirmLaunch).mockImplementation(async (id, input, authority) => {
      await authority?.refresh?.()
      return publish(id, input, authority)
    })
    const watching = watch('openclaw', entry, spawned, ['openclaw'], undefined)
    await vi.advanceTimersByTimeAsync(50)
    await watching
    expect(rows.get('a1')).toMatchObject({ processIdentity: named, launch: { state: 'ready' } })
    expect(deps.announceSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ processIdentity: named }))
    expect(vi.mocked(console.log).mock.calls.map(([line]) => String(line)).find((line) => line.includes('create ready'))).toMatch(/^\[agent\] create ready · openclaw · agent a1 · /)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it.each([
    [new RegistryOwnershipChanged('another owner'), 'RegistryOwnershipChanged IDENTITY_UNAVAILABLE'],
    [new IdentityReadUnavailable('the saved session registry is unavailable'), 'IdentityReadUnavailable IDENTITY_UNAVAILABLE'],
  ])('ends the watch with its line when a publication fails for anything but the pane changing: %s', async (error, kind) => {
    const { deps, watch } = setup()
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
    vi.mocked(deps.registry.confirmLaunch).mockRejectedValue(error)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(deps.registry.confirmLaunch).toHaveBeenCalledOnce()
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => String(line))).toEqual([`[agent] create watch failed · claude · readiness publication unavailable · ${kind}`])
  })

  it.each(['same hook', 'already bound', 'no hook', 'new origin', 'new process', 'storage error'] as const)(
    'only retries an unchanged first hook after revoked preparation: %s', async change => {
      const { deps, rows, watch } = setup()
      const entry = { ...pending, sessionId: change === 'already bound' ? 'original' : '' }
      rows.set('a1', structuredClone(entry))
      vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
      vi.mocked(deps.registry.confirmLaunch).mockImplementationOnce(async () => {
        const row = rows.get('a1')!
        if (change !== 'no hook') row.sessionId = 'hooked'
        row.processIdentity = change === 'new process' ? { ...identity, startMarker: 'other' } : identity
        if (change === 'new origin') row.cwd = '/another'
        throw change === 'storage error' ? new Error('storage unavailable') : new RegistryOwnershipChanged('first hook')
      })
      await watch('claude', entry, spawned, ['claude'], undefined)
      expect(deps.registry.confirmLaunch).toHaveBeenCalledTimes(change === 'same hook' ? 2 : 1)
      if (change === 'same hook') {
        const calls = vi.mocked(deps.registry.confirmLaunch).mock.calls
        expect(calls[1]![2]!.expires).toBe(calls[0]![2]!.expires)
        expect(deps.announceSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'hooked' }))
      } else {
        expect(releaseHold).not.toHaveBeenCalled()
        expect(deps.announceSession).not.toHaveBeenCalled()
      }
    })

  it.each(['process', 'executable', 'backend', 'unpublished', 'release'] as const)('holds readiness after %s authority changes', async change => {
    const { deps, rows, watch } = setup()
    vi.mocked(resolvePaneEngineProcess).mockImplementationOnce(async () => {
      if (change === 'process') rows.get('a1')!.processIdentity = { ...identity, startMarker: 'other' }
      if (change === 'executable') rows.get('a1')!.processIdentity = { ...identity, executable: 'other' }
      if (change === 'backend') vi.mocked(deps.terminals.backendFor).mockReturnValue(undefined)
      return identity
    })
    if (change === 'unpublished') vi.mocked(deps.registry.confirmLaunch).mockResolvedValue({ state: 'not-published' })
    if (change === 'release') releaseHold.mockImplementationOnce(async (_runtime, current) => {
      expect(current?.()).toBe(true)
      rows.get('a1')!.sessionId = 'replacement'
      expect(current?.()).toBe(false)
    })
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(deps.announceSession).not.toHaveBeenCalled()
    expect(deps.triggerHint).not.toHaveBeenCalled()
  })

  it.each(['same', 'gone', 'unknown', 'dead', 'exit', 'process'] as const)('refreshes the exited pane before shell publication: %s', async proof => {
    const { deps, watch } = setup()
    const publish = vi.mocked(deps.registry.confirmEngineExit).getMockImplementation()!
    vi.mocked(deps.registry.confirmEngineExit).mockImplementation(async (id, mode, authority) => {
      expect(authority?.current?.()).toBe(true)
      await authority?.refresh?.()
      return publish(id, mode, authority)
    })
    paneState.mockResolvedValueOnce({ dead: false, engineExit: 1 } as never).mockResolvedValue(proof === 'gone' || proof === 'unknown' ? proof
      : { dead: proof === 'dead', engineExit: proof === 'exit' ? 2 : 1 } as never)
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(null).mockResolvedValue(proof === 'process' ? identity : null)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(releaseHold).toHaveBeenCalledTimes(proof === 'same' ? 1 : 0)
    expect(deps.announceSession).toHaveBeenCalledTimes(proof === 'same' ? 1 : 0)
  })
  it.each(['held', 'row removed', 'not held', 'unknown', 'no probe'] as const)('retains a post-rc native guard hold without failing or archiving: %s', async result => {
    const entry = { ...pending, launch: { state: 'starting', nativeToken: 'fixture-native' } } as RegisteredSession
    const waitingPane = vi.fn(async () => result === 'unknown' ? 'unknown' as const : result === 'held' || result === 'row removed')
    const { deps, rows, watch } = setup(result === 'no probe' ? {} : holding(waitingPane))
    rows.set('a1', entry)
    if (result === 'row removed') vi.mocked(deps.registry.setLaunch).mockReturnValue(null)
    const watching = watch('claude', entry, spawned, ['claude'], undefined, 1)
    await vi.advanceTimersByTimeAsync(50)
    await watching
    expect(deps.retainExitedSession).not.toHaveBeenCalled()
    expect(deps.registry.confirmEngineExit).not.toHaveBeenCalled()
    if (result === 'held' || result === 'row removed') {
      expect(deps.registry.setLaunch).toHaveBeenCalledWith('a1', expect.objectContaining({ state: 'held', service: 'native', nativeToken: 'fixture-native' }))
      expect(deps.announceSession).toHaveBeenCalledTimes(result === 'held' ? 1 : 0)
    } else expect(deps.registry.setLaunch).toHaveBeenCalledWith('a1', expect.objectContaining({ state: 'held', service: 'native', nativeToken: 'fixture-native' }))
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(resolvePaneEngineProcess).mockReset().mockResolvedValue(null)
    paneState.mockReset().mockResolvedValue({ dead: false, engineExit: null } as never)
    releaseHold.mockClear()
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('asks a ptyhost pane\'s own backend whether it holds the launch, never tmux', async () => {
    const pty = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%7' }
    const entry = { ...pending, runtimes: [pty], launch: { state: 'starting', nativeToken: 'fixture-native' } } as RegisteredSession
    const isHeld = vi.fn(async () => true as const)
    const ptyBackend = { ...backend, isHeld } as TerminalBackend
    const backendFor = vi.fn(() => ptyBackend)
    const { deps, rows, watch } = setup({ terminals: { backendFor } })
    rows.set('a1', entry)
    await watch('claude', entry, { runtime: pty }, ['claude'], undefined, 1)
    expect(backendFor).toHaveBeenCalledWith(pty)
    expect(isHeld).toHaveBeenCalledExactlyOnceWith(pty, 'fixture-native')
    expect(deps.registry.setLaunch).toHaveBeenCalledWith('a1', expect.objectContaining({ state: 'held', service: 'native', nativeToken: 'fixture-native' }))
  })

  it.each(['token', 'route', 'binding', 'removed', 'stopped', 'ready'] as const)('discards a delayed native hold after its %s changes', async change => {
    const entry = { ...pending, launch: { state: 'starting', nativeToken: 'original' } } as RegisteredSession
    let finish!: (waiting: true) => void
    const waitingPane = vi.fn(() => new Promise<true>(done => { finish = done }))
    const { deps, rows, watch } = setup(holding(waitingPane))
    rows.set('a1', entry)
    const watching = watch('claude', entry, spawned, ['claude'], undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(waitingPane).toHaveBeenCalledOnce()
    const replacement = structuredClone(entry)
    if (change === 'token') replacement.launch = { state: 'starting', nativeToken: 'replacement' }
    if (change === 'route') replacement.runtimes = [{ backend: 'tmux', paneId: '%8' }]
    if (change === 'binding') replacement.sessionId = 'new-conversation'
    if (change === 'stopped') replacement.active = false
    if (change === 'ready') replacement.launch = { state: 'ready' }
    if (change === 'removed') rows.delete('a1'); else rows.set('a1', replacement)
    finish(true)
    await watching
    expect(deps.registry.setLaunch).not.toHaveBeenCalled()
    expect(deps.announceSession).not.toHaveBeenCalled()
    expect(rows.get('a1')).toEqual(change === 'removed' ? undefined : replacement)
  })

  it.each(['before probe', 'process', 'state', 'installed', 'capture', 'clear', 'sleep'] as const)(
    'fences native watcher effects when superseded at %s', async stage => {
      const entry = { ...pending, launch: { state: 'starting', nativeToken: 'original' } } as RegisteredSession
      const { deps, rows, watch } = setup()
      rows.set('a1', entry)
      const replace = () => rows.set('a1', { ...entry, launch: { state: 'starting', nativeToken: 'replacement' } })
      if (stage === 'before probe') replace()
      if (stage === 'process') vi.mocked(resolvePaneEngineProcess).mockImplementationOnce(async () => { replace(); return identity as never })
      if (stage === 'state') paneState.mockImplementationOnce(async () => { replace(); return 'gone' })
      if (stage === 'installed') {
        paneState.mockResolvedValueOnce({ dead: true, engineExit: null } as never)
      }
      if (stage === 'capture' || stage === 'clear') {
        paneState.mockResolvedValueOnce({ dead: false, engineExit: 2 } as never)
        if (stage === 'capture') vi.mocked(deps.captureTerminal).mockImplementationOnce(async () => { replace(); return 'old exit' })
        else releaseHold.mockImplementationOnce(async () => { replace() })
      }
      const executable = { command: 'claude', identity: 'selected', current: () => { if (stage === 'installed') replace(); return false } }
      const watching = watch('claude', entry, spawned, ['claude'], executable, 1)
      await vi.advanceTimersByTimeAsync(0)
      if (stage === 'sleep') replace()
      await vi.advanceTimersByTimeAsync(50)
      await watching
      expect(deps.registry.setLaunch).not.toHaveBeenCalled()
      expect(deps.registry.confirmLaunch).not.toHaveBeenCalled()
      if (stage === 'clear') expect(deps.registry.confirmEngineExit).toHaveBeenCalledOnce()
      else expect(deps.registry.confirmEngineExit).not.toHaveBeenCalled()
      expect(deps.announceSession).not.toHaveBeenCalled()
      expect(deps.retainExitedSession).not.toHaveBeenCalled()
    })

  it('marks the agent ready once its engine process shows up, and asks discovery to bind it', async () => {
    const { deps, watch } = setup()
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(null).mockResolvedValueOnce(identity as never)
    const done = watch('claude', pending, spawned, ['claude'], undefined)
    await vi.advanceTimersByTimeAsync(50)
    await done
    expect(deps.registry.confirmLaunch).toHaveBeenCalledWith('a1', { processIdentity: identity }, expect.any(Object))
    expect(deps.registry.confirmLaunch).toHaveBeenCalledWith('a1', expect.any(Object), expect.any(Object))
    expect(deps.terminals.backendFor).toHaveBeenCalledWith(runtime)
    expect(resolvePaneEngineProcess).toHaveBeenCalledWith(backend, runtime, 'claude')
    expect(paneState).toHaveBeenCalledWith(runtime)
    expect(releaseHold).toHaveBeenCalledWith(runtime, expect.any(Function))
    expect(deps.announceSession).toHaveBeenCalledWith(expect.objectContaining({ launch: { state: 'ready' } }))
    expect(deps.triggerHint).toHaveBeenCalledWith(runtime, 'claude')
  })

  it('says so when the background bind fails, and announces nothing for a row the registry no longer has', async () => {
    const warn = vi.mocked(console.warn)
    const { deps, watch } = setup({ triggerHint: vi.fn(async () => { throw new Error('scan failed') }) })
    vi.mocked(deps.registry.confirmLaunch).mockResolvedValueOnce({ state: 'confirmed', entry: null })
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(identity as never)
    await watch('claude', pending, spawned, ['claude'], undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.announceSession).not.toHaveBeenCalled()
    const worse = setup({ triggerHint: vi.fn(async () => { throw 'worse' }) })
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(identity as never)
    await worse.watch('claude', pending, spawned, ['claude'], undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('background bind failed'))).toEqual([
      '[agent] background bind failed · claude · string',
    ])
  })

  it('stops watching an agent that was removed meanwhile', async () => {
    const { deps, rows, watch } = setup()
    rows.clear()
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(resolvePaneEngineProcess).not.toHaveBeenCalled()
    expect(deps.announceSession).not.toHaveBeenCalled()
  })

  it('marks the terminal unavailable when the pane is gone', async () => {
    const { deps, watch } = setup()
    paneState.mockResolvedValueOnce('gone')
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(deps.registry.setTerminalAvailable).toHaveBeenCalledWith('a1', false)
    expect(deps.announceSession).toHaveBeenCalledWith(pending)
  })

  it('asks again when tmux could not say, and finds the engine once it can', async () => {
    // A read that timed out while the daemon's event loop was held, then the engine it was looking for.
    const { deps, watch } = setup()
    paneState.mockResolvedValueOnce('unknown')
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(null).mockResolvedValueOnce({ pid: 7, executable: 'claude', startMarker: 'm' })
    const done = watch('claude', pending, spawned, ['claude'], undefined)
    await vi.advanceTimersByTimeAsync(50)
    await done
    expect(deps.registry.setTerminalAvailable).not.toHaveBeenCalled()
    expect(deps.registry.confirmLaunch).toHaveBeenCalledWith('a1', expect.any(Object), expect.any(Object))
  })

  it('diagnoses a dead pane from its prepared executable, without a new lookup', async () => {
    const { deps, watch } = setup()
    paneState.mockResolvedValue({ dead: true, engineExit: null } as never)
    const executable = { command: 'claude', identity: 'selected', current: () => true }
    await watch('claude', pending, spawned, ['claude'], executable)
    await watch('claude', pending, spawned, ['claude'], undefined)
    const launches = vi.mocked(deps.registry.setLaunch).mock.calls.map(([, launch]) => launch)
    expect(launches).toEqual([
      expect.objectContaining({ error: 'ENGINE_DID_NOT_START', detail: expect.not.stringContaining('could not verify') }),
      expect.objectContaining({ error: 'ENGINE_DID_NOT_START', detail: expect.stringContaining('could not verify') }),
    ])
    expect(deps.announceSession).toHaveBeenCalledTimes(2)
    vi.mocked(deps.registry.setLaunch).mockReturnValueOnce(null)
    await watch('claude', pending, spawned, ['claude'], executable)
    expect(deps.announceSession).toHaveBeenCalledTimes(2)
  })

  it('keeps a pane whose engine started and exited before it was seen as a terminal, saying why', async () => {
    const warn = vi.mocked(console.warn)
    const { deps, rows, watch } = setup()
    paneState.mockResolvedValue({ dead: false, engineExit: 2 } as never)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(deps.registry.confirmEngineExit).toHaveBeenCalledWith('a1', 'shell', expect.any(Object))
    expect(deps.announceSession).toHaveBeenCalledWith(expect.objectContaining({ engine: 'terminal' }))
    expect(releaseHold).toHaveBeenCalledWith(runtime, expect.any(Function))
    expect(warn.mock.calls.map(([line]) => String(line)).some((line) => line.includes('exited (2) before ready · agent a1 kept as a terminal'))).toBe(true)
    // A hook bound a conversation meanwhile: that conversation is kept, the engine not released.
    rows.set('a1', { ...pending, sessionId: 's1' } as RegisteredSession)
    vi.mocked(deps.captureTerminal).mockResolvedValueOnce(null)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(deps.retainExitedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }), true, expect.any(Object))
    expect(deps.registry.confirmEngineExit).toHaveBeenCalledTimes(1)
    // Released into nothing: nothing to announce.
    rows.set('a1', pending)
    vi.mocked(deps.registry.confirmEngineExit).mockResolvedValueOnce({ state: 'not-published' })
    vi.mocked(deps.announceSession).mockClear()
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(deps.announceSession).not.toHaveBeenCalled()
  })

  it('backs off between looks, and gives up on a start that never shows, keeping the terminal', async () => {
    const warn = vi.mocked(console.warn)
    const { deps, watch } = setup()
    const done = watch('claude', pending, spawned, ['claude'], undefined, 3_000)
    await vi.advanceTimersByTimeAsync(3_000)
    await done
    // 50, 100, 200, 400, then every 750 ms.
    expect(vi.mocked(resolvePaneEngineProcess).mock.calls.length).toBeGreaterThanOrEqual(6)
    expect(vi.mocked(resolvePaneEngineProcess).mock.calls.length).toBeLessThanOrEqual(8)
    expect(deps.registry.setLaunch).toHaveBeenCalledWith('a1', { state: 'failed', error: 'START_TIMEOUT', detail: expect.stringContaining('did not expose an engine process') })
    expect(deps.announceSession).toHaveBeenCalled()
    expect(warn.mock.calls.map(([line]) => String(line))).toContain('[agent] create timed out · claude · agent a1')
    vi.mocked(deps.registry.setLaunch).mockReturnValueOnce(null)
    vi.mocked(deps.announceSession).mockClear()
    await watch('claude', pending, spawned, ['claude'], undefined, 0)
    expect(deps.announceSession).not.toHaveBeenCalled()
  })

  describe('a local OpenClaw launch', () => {
    const local = { ...pending, engine: 'openclaw', openclawLocal: '/run/skill-1' } as RegisteredSession
    // OpenClaw 2026.11.2's TUI on a --local folder: no URL in its title, `local ready | idle` on its status line.
    const localScreen = readFileSync(join(import.meta.dirname, '../../engines/openclaw/__fixtures__/screen-plain.txt'), 'utf8')
      .replace('openclaw tui - ws://127.0.0.1:18789 - ', 'openclaw tui - local embedded - ').replace(' connected | idle', ' local ready | idle')

    it.each(['ready', 'missing'] as const)('refreshes the local footer before acknowledging readiness, and reads the pane again without it: %s', async state => {
      const { deps, rows, watch } = setup()
      rows.set('a1', local)
      vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
      // Drawn, then at the refresh drawn or not; a footer gone at the refresh is looked for again, and back.
      vi.mocked(deps.captureTerminal).mockResolvedValueOnce(localScreen).mockResolvedValueOnce(state === 'ready' ? localScreen : null)
        .mockResolvedValue(localScreen)
      const publish = vi.mocked(deps.registry.confirmLaunch).getMockImplementation()!
      vi.mocked(deps.registry.confirmLaunch).mockImplementation(async (id, input, authority) => {
        await authority?.refresh?.(); return publish(id, input, authority)
      })
      const watching = watch('openclaw', local, spawned, ['openclaw'], undefined)
      await vi.advanceTimersByTimeAsync(50)
      await watching
      expect(deps.registry.confirmLaunch).toHaveBeenCalledTimes(state === 'ready' ? 1 : 2)
      expect(releaseHold).toHaveBeenCalledOnce()
      expect(deps.announceSession).toHaveBeenCalledOnce()
    })

    it('does not invent a folder conflict when an exited local pane cannot be captured', async () => {
      const { deps, rows, watch } = setup()
      rows.set('a1', local)
      paneState.mockResolvedValue({ dead: false, engineExit: 1 } as never)
      vi.mocked(deps.captureTerminal).mockResolvedValue(null)
      await watch('openclaw', local, spawned, ['openclaw'], undefined)
      expect(deps.registry.confirmEngineExit).toHaveBeenCalledOnce()
      expect(deps.registry.setLaunch).not.toHaveBeenCalled()
    })
    const logLines = () => [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls].map(([line]) => String(line))

    it('is not ready until its TUI has drawn', async () => {
      const { deps, rows, watch } = setup()
      rows.set('a1', local)
      vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity as never)
      vi.mocked(deps.captureTerminal).mockResolvedValueOnce('').mockResolvedValueOnce(null).mockResolvedValueOnce(localScreen)
      const done = watch('openclaw', local, spawned, ['openclaw'], undefined)
      await vi.advanceTimersByTimeAsync(50)
      expect(deps.registry.setLaunch).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(100)
      await done
      expect(deps.captureTerminal).toHaveBeenCalledTimes(3)
      expect(deps.captureTerminal).toHaveBeenCalledWith('a1', 40)
      expect(deps.registry.confirmLaunch).toHaveBeenCalledWith('a1', { processIdentity: identity }, expect.any(Object))
      expect(deps.registry.confirmLaunch).toHaveBeenCalledOnce()
    })

    it('stops looking at a launch superseded while its screen was read', async () => {
      const { deps, rows, watch } = setup()
      const entry = { ...local, launch: { state: 'starting', nativeToken: 'original' } } as RegisteredSession
      rows.set('a1', entry)
      vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity as never)
      vi.mocked(deps.captureTerminal).mockImplementationOnce(async () => {
        rows.set('a1', { ...entry, launch: { state: 'starting', nativeToken: 'replacement' } } as RegisteredSession)
        return localScreen
      })
      await watch('openclaw', entry, spawned, ['openclaw'], undefined)
      expect(deps.registry.setLaunch).not.toHaveBeenCalled()
      expect(deps.registry.confirmLaunch).not.toHaveBeenCalled()
    })

    it("that left on OpenClaw's lock says another OpenClaw is using the folder", async () => {
      const { deps, rows, watch } = setup()
      rows.set('a1', local)
      vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(identity as never).mockResolvedValue(null)
      paneState.mockResolvedValueOnce({ dead: false, engineExit: null } as never).mockResolvedValue({ dead: false, engineExit: 1 } as never)
      vi.mocked(deps.captureTerminal).mockResolvedValueOnce('')
        .mockResolvedValueOnce('A Gateway is running for this state directory (pid 7, port 18789). Run without --local to use it.')
      const done = watch('openclaw', local, spawned, ['openclaw'], undefined)
      await vi.advanceTimersByTimeAsync(50)
      await done
      expect(deps.registry.setLaunch).toHaveBeenCalledExactlyOnceWith('a1', { state: 'failed', error: 'OPENCLAW_FOLDER_IN_USE',
        detail: 'Another OpenClaw is using this folder. Give each run its own --local folder.' })
      expect(deps.registry.confirmEngineExit).not.toHaveBeenCalled()
      expect(deps.retainExitedSession).not.toHaveBeenCalled()
      expect(vi.mocked(deps.announceSession).mock.calls.at(-1)![0].launch).toMatchObject({ state: 'failed', error: 'OPENCLAW_FOLDER_IN_USE' })
      expect(logLines()).toContain('[agent] create failed · openclaw · Another OpenClaw is using this folder. Give each run its own --local folder.')
      expect(logLines().join('\n')).not.toContain('/run/skill-1')
      // Failed into a row the registry no longer has: nothing to announce.
      vi.mocked(deps.registry.setLaunch).mockReturnValueOnce(null)
      vi.mocked(deps.announceSession).mockClear()
      vi.mocked(deps.captureTerminal).mockResolvedValueOnce('failed to acquire gateway state ownership')
      await watch('openclaw', local, spawned, ['openclaw'], undefined)
      expect(deps.announceSession).not.toHaveBeenCalled()
    })

    it('that left for any other reason leaves a terminal, as for every engine', async () => {
      const { deps, rows, watch } = setup()
      rows.set('a1', local)
      paneState.mockResolvedValue({ dead: false, engineExit: 1 } as never)
      vi.mocked(deps.captureTerminal).mockResolvedValueOnce('error: unknown option')
      await watch('openclaw', local, spawned, ['openclaw'], undefined)
      // A pane that could not be read says nothing of a lock.
      vi.mocked(deps.captureTerminal).mockResolvedValueOnce(null)
      await watch('openclaw', local, spawned, ['openclaw'], undefined)
      expect(deps.registry.confirmEngineExit).toHaveBeenCalledOnce()
      expect(deps.registry.confirmEngineExit).toHaveBeenCalledWith('a1', 'shell', expect.any(Object))
      expect(deps.registry.setLaunch).not.toHaveBeenCalled()
    })

    /**
     * The reconciler's side of the race: a pass that finds OpenClaw's process in a pane nobody holds marks its starting
     * row ready (discovery.ts `onObserved`), which ends this launch's claim on the row; a held pane it leaves alone.
     */
    const discovery = () => {
      const held = new Set<string>()
      const released = vi.fn((key: string) => { held.delete(key) })
      const holdRoute = vi.fn((key: string) => {
        held.add(key)
        return () => released(key)
      })
      const pass = (rows: Map<string, RegisteredSession>) => {
        if (held.has(terminalRouteKey(runtime))) return
        rows.set('a1', { ...rows.get('a1')!, processIdentity: identity, launch: { state: 'ready' } } as RegisteredSession)
      }
      return { holdRoute, released, pass }
    }
    const starting = { ...local, launch: { state: 'starting', nativeToken: 'original' } } as RegisteredSession

    it('keeps discovery off its pane until its TUI has drawn, and finishes its own launch', async () => {
      const { holdRoute, released, pass } = discovery()
      const { deps, rows, watch } = setup({ holdRoute })
      rows.set('a1', starting)
      vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity as never)
      // A pass lands while the watcher waits for the TUI: OpenClaw's process is up, its screen still blank.
      vi.mocked(deps.captureTerminal).mockImplementationOnce(async () => { pass(rows); return '' }).mockResolvedValueOnce(localScreen)
      const done = watch('openclaw', starting, spawned, ['openclaw'], undefined)
      await vi.advanceTimersByTimeAsync(50)
      await done
      expect(logLines().find((line) => line.includes('create ready'))).toMatch(/^\[agent\] create ready · openclaw · local · agent a1 · /)
      expect(releaseHold).toHaveBeenCalledWith(runtime, expect.any(Function))
      expect(deps.triggerHint).toHaveBeenCalledWith(runtime, 'openclaw')
      expect(deps.registry.confirmLaunch).toHaveBeenCalledWith('a1', { processIdentity: identity }, expect.any(Object))
      expect(rows.get('a1')).toMatchObject({ agentId: 'a1', launch: { state: 'ready' }, processIdentity: identity })
      expect(holdRoute).toHaveBeenCalledExactlyOnceWith(terminalRouteKey(runtime))
      // The pane is discovery's again before the pass the watcher asks for, which binds it.
      expect(released.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.triggerHint).mock.invocationCallOrder[0]!)
    })

    it("that left on OpenClaw's lock while discovery looked still says another OpenClaw is using the folder", async () => {
      const { holdRoute, released, pass } = discovery()
      const { deps, rows, watch } = setup({ holdRoute })
      rows.set('a1', starting)
      vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(identity as never).mockResolvedValue(null)
      paneState.mockResolvedValueOnce({ dead: false, engineExit: null } as never).mockResolvedValue({ dead: false, engineExit: 1 } as never)
      vi.mocked(deps.captureTerminal).mockImplementationOnce(async () => { pass(rows); return '' })
        .mockResolvedValueOnce('failed to acquire gateway state ownership')
      const done = watch('openclaw', starting, spawned, ['openclaw'], undefined)
      await vi.advanceTimersByTimeAsync(50)
      await done
      expect(deps.registry.setLaunch).toHaveBeenCalledExactlyOnceWith('a1', { state: 'failed', error: 'OPENCLAW_FOLDER_IN_USE',
        detail: 'Another OpenClaw is using this folder. Give each run its own --local folder.' })
      expect(deps.registry.confirmEngineExit).not.toHaveBeenCalled()
      expect(released).toHaveBeenCalledOnce()
    })

    // The hold has no timer: a way out that kept it would leave the pane unbound for the daemon's life.
    it.each(['closed', 'pane gone', 'pane dead', 'no backend', 'capture failed', 'timed out'] as const)(
      'gives its pane back to discovery however it ends: %s', async (exit) => {
        const { holdRoute, released, pass } = discovery()
        const { deps, rows, watch } = setup({ holdRoute,
          ...exit === 'no backend' ? { terminals: { backendFor: vi.fn(() => undefined) } } : {} })
        rows.set('a1', starting)
        if (exit === 'closed') rows.delete('a1')
        if (exit === 'pane gone') paneState.mockResolvedValue('gone')
        if (exit === 'pane dead') paneState.mockResolvedValue({ dead: true, engineExit: null } as never)
        if (exit === 'capture failed') {
          vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity as never)
          vi.mocked(deps.captureTerminal).mockRejectedValue(new Error('tmux timed out'))
        }
        const done = watch('openclaw', starting, spawned, ['openclaw'], undefined, exit === 'timed out' ? 100 : undefined)
        await vi.advanceTimersByTimeAsync(1_000)
        await done
        expect(released).toHaveBeenCalledExactlyOnceWith(terminalRouteKey(runtime))
        // Discovery has the pane again: its next pass marks the run ready.
        pass(rows)
        if (exit !== 'closed') expect(rows.get('a1')?.launch).toEqual({ state: 'ready' })
      })

    it('says local on its ready line, and no folder', async () => {
      const { deps, rows, watch } = setup()
      rows.set('a1', local)
      vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity as never)
      vi.mocked(deps.captureTerminal).mockResolvedValueOnce(localScreen)
      await watch('openclaw', local, spawned, ['openclaw'], undefined)
      expect(logLines().find((line) => line.includes('create ready'))).toMatch(/^\[agent\] create ready · openclaw · local · agent a1 · \d+ms$/)
      expect(logLines().join('\n')).not.toContain('/run/skill-1')
    })
  })

  it('fails an OpenClaw launch whose TUI left for want of a Gateway token, saying what to run, and keeps no terminal', async () => {
    const { deps, rows, watch } = setup()
    const entry = { ...pending, engine: 'openclaw' } as RegisteredSession
    rows.set('a1', entry)
    paneState.mockResolvedValue({ dead: false, engineExit: 1 } as never)
    vi.mocked(deps.captureTerminal).mockResolvedValueOnce(
      readFileSync(join(import.meta.dirname, '../../engines/openclaw/__fixtures__/screen-no-token.txt'), 'utf8'))
    await watch('openclaw', entry, spawned, ['openclaw'], undefined)
    expect(deps.registry.setLaunch).toHaveBeenCalledExactlyOnceWith('a1', { state: 'failed', error: 'OPENCLAW_NO_TOKEN', detail: OPENCLAW_STATES.noToken })
    expect(vi.mocked(deps.announceSession).mock.calls.at(-1)![0].launch).toMatchObject({ state: 'failed', error: 'OPENCLAW_NO_TOKEN' })
    expect(deps.registry.confirmEngineExit).not.toHaveBeenCalled()
    expect(deps.retainExitedSession).not.toHaveBeenCalled()
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => String(line)))
      .toContain('[agent] create failed · openclaw · OpenClaw has no Gateway token. Run openclaw onboard.')
  })

  it('is ready as soon as its process is seen when the launch has no folder', async () => {
    const { deps, rows, watch } = setup()
    const entry = { ...pending, engine: 'openclaw' } as RegisteredSession
    rows.set('a1', entry)
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(identity as never)
    await watch('openclaw', entry, spawned, ['openclaw'], undefined)
    expect(deps.captureTerminal).not.toHaveBeenCalled()
    expect(deps.holdRoute).not.toHaveBeenCalled()
    expect(deps.registry.confirmLaunch).toHaveBeenCalledWith('a1', { processIdentity: identity }, expect.any(Object))
    expect(vi.mocked(console.log).mock.calls.map(([line]) => String(line)).find((line) => line.includes('create ready'))).toMatch(/^\[agent\] create ready · openclaw · agent a1 · /)
  })

  it('reports a pane no configured backend holds, and asks nothing about it', async () => {
    const warn = vi.mocked(console.warn)
    const { deps, watch } = setup({ terminals: { backendFor: vi.fn(() => undefined) } })
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(resolvePaneEngineProcess).not.toHaveBeenCalled()
    expect(deps.registry.setLaunch).not.toHaveBeenCalled()
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual(['[agent] create watch failed · claude · readiness publication unavailable · Error'])
  })

  it('reports a watch that fails', async () => {
    const warn = vi.mocked(console.warn)
    const { watch } = setup()
    vi.mocked(resolvePaneEngineProcess).mockRejectedValueOnce(new Error('ps failed')).mockRejectedValueOnce('worse')
    await watch('claude', pending, spawned, ['claude'], undefined)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      '[agent] create watch failed · claude · readiness publication unavailable · Error',
      '[agent] create watch failed · claude · readiness publication unavailable · string',
    ])
  })
})

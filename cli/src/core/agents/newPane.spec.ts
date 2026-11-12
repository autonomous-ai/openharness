import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandAvailableInInteractiveShell } from '../../lib/engineLaunch.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { resolvePaneEngineProcess } from '../../lib/paneEngineProcess.js'
import type { TerminalBackend } from '../../lib/terminalBackend.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { createPaneWatcher, type PaneWatcherDeps } from './newPane.js'

vi.mock('../../lib/paneEngineProcess.js', async (real) => ({
  ...await real<object>(),
  resolvePaneEngineProcess: vi.fn(async () => null),
}))
vi.mock('../../lib/engineLaunch.js', async (real) => ({ ...await real<object>(), commandAvailableInInteractiveShell: vi.fn(async () => true) }))

const pending = { agentId: 'a1', sessionId: '', engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%7' }] } as RegisteredSession
const runtime = { backend: 'tmux' as const, paneId: '%7' }
const spawned = { runtime } as never
const identity = { pid: 99, startMarker: 'now' }
// The pane's backend: what the watcher asks about the pane it opened.
const paneState = vi.fn<TerminalBackend['paneState']>(async () => ({ dead: false, engineExit: null }) as never)
const releaseHold = vi.fn<TerminalBackend['releaseHold']>(async () => {})
const backend = { paneState, releaseHold } as unknown as TerminalBackend

/** The pane's own backend, answering whether it holds the launch's inert shell (`TerminalBackend.isHeld`). */
const holding = (isHeld: TerminalBackend['isHeld']): Partial<PaneWatcherDeps> => ({ terminals: { backendFor: vi.fn(() => ({ ...backend, isHeld }) as TerminalBackend) } })

function setup(over: Partial<PaneWatcherDeps> = {}) {
  const rows = new Map<string, RegisteredSession>([['a1', pending]])
  const deps: PaneWatcherDeps = {
    registry: {
      byAgent: vi.fn((agentId: string) => rows.get(agentId)),
      updateProcessIdentity: vi.fn(),
      setLaunch: vi.fn((_agentId: string, launch: { state: string }) => ({ ...pending, launch }) as RegisteredSession),
      setTerminalAvailable: vi.fn(() => true),
      releaseEngine: vi.fn(() => ({ ...pending, engine: 'terminal' }) as RegisteredSession),
    } as unknown as PaneWatcherDeps['registry'],
    announceSession: vi.fn(),
    triggerHint: vi.fn(async () => {}),
    captureTerminal: vi.fn(async () => 'error: unknown flag --plan'),
    retainExitedSession: vi.fn(),
    terminals: { backendFor: vi.fn(() => backend) },
    holdRoute: vi.fn(() => vi.fn()),
    ...over,
  }
  return { deps, rows, watch: createPaneWatcher(deps) }
}

describe('watching a new pane', () => {
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
    expect(deps.registry.releaseEngine).not.toHaveBeenCalled()
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
    vi.mocked(commandAvailableInInteractiveShell).mockReset().mockResolvedValue(true)
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
        vi.mocked(commandAvailableInInteractiveShell).mockImplementationOnce(async () => { replace(); return false })
      }
      if (stage === 'capture' || stage === 'clear') {
        paneState.mockResolvedValueOnce({ dead: false, engineExit: 2 } as never)
        if (stage === 'capture') vi.mocked(deps.captureTerminal).mockImplementationOnce(async () => { replace(); return 'old exit' })
        else releaseHold.mockImplementationOnce(async () => { replace() })
      }
      const watching = watch('claude', entry, spawned, ['claude'], undefined, 1)
      await vi.advanceTimersByTimeAsync(0)
      if (stage === 'sleep') replace()
      await vi.advanceTimersByTimeAsync(50)
      await watching
      expect(deps.registry.setLaunch).not.toHaveBeenCalled()
      expect(deps.registry.updateProcessIdentity).not.toHaveBeenCalled()
      expect(deps.registry.releaseEngine).not.toHaveBeenCalled()
      expect(deps.retainExitedSession).not.toHaveBeenCalled()
    })

  it('marks the agent ready once its engine process shows up, and asks discovery to bind it', async () => {
    const { deps, watch } = setup()
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(null).mockResolvedValueOnce(identity as never)
    const done = watch('claude', pending, spawned, ['claude'], undefined)
    await vi.advanceTimersByTimeAsync(50)
    await done
    expect(deps.registry.updateProcessIdentity).toHaveBeenCalledWith('a1', identity)
    expect(deps.registry.setLaunch).toHaveBeenCalledWith('a1', { state: 'ready' })
    expect(deps.terminals.backendFor).toHaveBeenCalledWith(runtime)
    expect(resolvePaneEngineProcess).toHaveBeenCalledWith(backend, runtime, 'claude')
    expect(paneState).toHaveBeenCalledWith(runtime)
    expect(releaseHold).toHaveBeenCalledWith(runtime)
    expect(deps.announceSession).toHaveBeenCalledWith(expect.objectContaining({ launch: { state: 'ready' } }))
    expect(deps.triggerHint).toHaveBeenCalledWith(runtime, 'claude')
  })

  it('says so when the background bind fails, and announces nothing for a row the registry no longer has', async () => {
    const warn = vi.mocked(console.warn)
    const { deps, watch } = setup({ triggerHint: vi.fn(async () => { throw new Error('scan failed') }) })
    vi.mocked(deps.registry.setLaunch).mockReturnValueOnce(null)
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(identity as never)
    await watch('claude', pending, spawned, ['claude'], undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.announceSession).not.toHaveBeenCalled()
    const worse = setup({ triggerHint: vi.fn(async () => { throw 'worse' }) })
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(identity as never)
    await worse.watch('claude', pending, spawned, ['claude'], undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('background bind failed'))).toEqual([
      '[agent] background bind failed · claude · scan failed',
      '[agent] background bind failed · claude · worse',
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
    expect(deps.registry.setLaunch).toHaveBeenCalledWith('a1', { state: 'ready' })
  })

  it('fails a launch whose pane died: not installed, or did not start', async () => {
    const { deps, watch } = setup()
    paneState.mockResolvedValue({ dead: true, engineExit: null } as never)
    await watch('claude', pending, spawned, ['claude'], undefined)
    vi.mocked(commandAvailableInInteractiveShell).mockResolvedValueOnce(false)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(vi.mocked(deps.registry.setLaunch).mock.calls.map(([, launch]) => (launch as { error: string }).error)).toEqual(['ENGINE_DID_NOT_START', 'ENGINE_NOT_INSTALLED'])
    expect(deps.announceSession).toHaveBeenCalledTimes(2)
    vi.mocked(deps.registry.setLaunch).mockReturnValueOnce(null)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(deps.announceSession).toHaveBeenCalledTimes(2)
  })

  it('keeps a pane whose engine started and exited before it was seen as a terminal, saying why', async () => {
    const warn = vi.mocked(console.warn)
    const { deps, rows, watch } = setup()
    paneState.mockResolvedValue({ dead: false, engineExit: 2 } as never)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(deps.registry.releaseEngine).toHaveBeenCalledWith('a1')
    expect(deps.announceSession).toHaveBeenCalledWith(expect.objectContaining({ engine: 'terminal' }))
    expect(releaseHold).toHaveBeenCalledWith(runtime, expect.any(Function))
    expect(warn.mock.calls.map(([line]) => String(line)).some((line) => line.includes('exited (2) before ready · agent a1 kept as a terminal'))).toBe(true)
    // A hook bound a conversation meanwhile: that conversation is kept, the engine not released.
    rows.set('a1', { ...pending, sessionId: 's1' } as RegisteredSession)
    vi.mocked(deps.captureTerminal).mockResolvedValueOnce(null)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(deps.retainExitedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }), true)
    expect(deps.registry.releaseEngine).toHaveBeenCalledTimes(1)
    // Released into nothing: nothing to announce.
    rows.set('a1', pending)
    vi.mocked(deps.registry.releaseEngine).mockReturnValueOnce(null)
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
      expect(deps.registry.setLaunch).toHaveBeenCalledExactlyOnceWith('a1', { state: 'ready' })
      expect(deps.registry.updateProcessIdentity).toHaveBeenCalledOnce()
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
      expect(deps.registry.updateProcessIdentity).not.toHaveBeenCalled()
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
      expect(deps.registry.releaseEngine).not.toHaveBeenCalled()
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
      expect(deps.registry.releaseEngine).toHaveBeenCalledTimes(2)
      expect(deps.registry.releaseEngine).toHaveBeenCalledWith('a1')
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
      expect(releaseHold).toHaveBeenCalledWith(runtime)
      expect(deps.triggerHint).toHaveBeenCalledWith(runtime, 'openclaw')
      expect(deps.registry.setLaunch).toHaveBeenCalledExactlyOnceWith('a1', { state: 'ready' })
      expect(rows.get('a1')).toBe(starting)
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
      expect(deps.registry.releaseEngine).not.toHaveBeenCalled()
      expect(released).toHaveBeenCalledOnce()
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

  it('is ready as soon as its process is seen when the launch has no folder', async () => {
    const { deps, watch } = setup()
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(identity as never)
    await watch('openclaw', { ...pending, engine: 'openclaw' } as RegisteredSession, spawned, ['openclaw'], undefined)
    expect(deps.captureTerminal).not.toHaveBeenCalled()
    expect(deps.holdRoute).not.toHaveBeenCalled()
    expect(deps.registry.setLaunch).toHaveBeenCalledExactlyOnceWith('a1', { state: 'ready' })
    expect(vi.mocked(console.log).mock.calls.map(([line]) => String(line)).find((line) => line.includes('create ready'))).toMatch(/^\[agent\] create ready · openclaw · agent a1 · /)
  })

  it('reports a pane no configured backend holds, and asks nothing about it', async () => {
    const warn = vi.mocked(console.warn)
    const { deps, watch } = setup({ terminals: { backendFor: vi.fn(() => undefined) } })
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(resolvePaneEngineProcess).not.toHaveBeenCalled()
    expect(deps.registry.setLaunch).not.toHaveBeenCalled()
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual(['[agent] create watch failed · claude · no terminal backend for tmux:%7'])
  })

  it('reports a watch that fails', async () => {
    const warn = vi.mocked(console.warn)
    const { watch } = setup()
    vi.mocked(resolvePaneEngineProcess).mockRejectedValueOnce(new Error('ps failed')).mockRejectedValueOnce('worse')
    await watch('claude', pending, spawned, ['claude'], undefined)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      '[agent] create watch failed · claude · ps failed',
      '[agent] create watch failed · claude · worse',
    ])
  })
})

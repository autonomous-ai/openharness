import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandAvailableInInteractiveShell } from '../../lib/engineLaunch.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { clearPaneRemainOnExit, resolvePaneEngineProcess, tmuxPaneState } from '../../lib/tmux.js'
import { createPaneWatcher, type PaneWatcherDeps } from './newPane.js'

vi.mock('../../lib/tmux.js', async (real) => ({
  ...await real<object>(),
  resolvePaneEngineProcess: vi.fn(async () => null),
  clearPaneRemainOnExit: vi.fn(async () => {}),
  tmuxPaneState: vi.fn(async () => ({ dead: false, engineExit: null })),
}))
vi.mock('../../lib/engineLaunch.js', async (real) => ({ ...await real<object>(), commandAvailableInInteractiveShell: vi.fn(async () => true) }))

const pending = { agentId: 'a1', sessionId: '', engine: 'claude' } as RegisteredSession
const runtime = { backend: 'tmux', paneId: '%7' }
const spawned = { runtime } as never
const identity = { pid: 99, startMarker: 'now' }

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
    ...over,
  }
  return { deps, rows, watch: createPaneWatcher(deps) }
}

describe('watching a new pane', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(resolvePaneEngineProcess).mockReset().mockResolvedValue(null)
    vi.mocked(tmuxPaneState).mockReset().mockResolvedValue({ dead: false, engineExit: null } as never)
    vi.mocked(clearPaneRemainOnExit).mockClear()
    vi.mocked(commandAvailableInInteractiveShell).mockReset().mockResolvedValue(true)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('marks the agent ready once its engine process shows up, and asks discovery to bind it', async () => {
    const { deps, watch } = setup()
    vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(null).mockResolvedValueOnce(identity as never)
    const done = watch('claude', pending, spawned, ['claude'], undefined)
    await vi.advanceTimersByTimeAsync(50)
    await done
    expect(deps.registry.updateProcessIdentity).toHaveBeenCalledWith('a1', identity)
    expect(deps.registry.setLaunch).toHaveBeenCalledWith('a1', { state: 'ready' })
    expect(clearPaneRemainOnExit).toHaveBeenCalledWith('%7')
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
    vi.mocked(tmuxPaneState).mockResolvedValueOnce(null)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(deps.registry.setTerminalAvailable).toHaveBeenCalledWith('a1', false)
    expect(deps.announceSession).toHaveBeenCalledWith(pending)
  })

  it('fails a launch whose pane died: not installed, or did not start', async () => {
    const { deps, watch } = setup()
    vi.mocked(tmuxPaneState).mockResolvedValue({ dead: true, engineExit: null } as never)
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
    vi.mocked(tmuxPaneState).mockResolvedValue({ dead: false, engineExit: 2 } as never)
    await watch('claude', pending, spawned, ['claude'], undefined)
    expect(deps.registry.releaseEngine).toHaveBeenCalledWith('a1')
    expect(deps.announceSession).toHaveBeenCalledWith(expect.objectContaining({ engine: 'terminal' }))
    expect(clearPaneRemainOnExit).toHaveBeenCalledWith('%7')
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OtherStream } from '../engines/otherStreams.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createAgyBackstop, type AgyBackstopDeps } from './agyBackstop.js'

const IDLE = 'done.\n\n  ? for shortcuts'
const BUSY = 'thinking…\n\n  esc to cancel'

function setup(over: Partial<AgyBackstopDeps> = {}) {
  // agy's stream, as the core holds it: its close is its worker's, which says what agy's normalizer emits closing.
  const normalizer = { turnOpen: true } as { turnOpen: boolean }
  const close = vi.fn(async () => { normalizer.turnOpen = false; return [{ type: 'turn_ended' as const, payload: {} }] })
  const deps: AgyBackstopDeps = {
    streams: { get: (sessionId) => sessionId === 's1' ? normalizer as unknown as OtherStream : undefined, close },
    bySession: (sessionId) => sessionId === 's1' ? ({ agentId: 'a1', sessionId: 's1' } as RegisteredSession) : undefined,
    captureTerminal: vi.fn(async () => IDLE),
    drain: vi.fn(async () => {}),
    emit: vi.fn(),
    ...over,
  }
  return { deps, normalizer, close, backstop: createAgyBackstop(deps) }
}

describe('the agy idle backstop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('closes a turn whose pane is idle 15 s after the Stop that left it open', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { deps, backstop } = setup()
    backstop.armAgyIdleWatch('s1')
    await vi.advanceTimersByTimeAsync(14_999)
    expect(deps.captureTerminal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.captureTerminal).toHaveBeenCalledWith('a1', 60)
    expect(deps.drain).toHaveBeenCalledWith('s1')
    expect(deps.emit).toHaveBeenCalledWith('s1', [{ type: 'turn_ended', payload: {} }])
    expect(String(log.mock.calls[0][0])).toContain('closed by the agy idle backstop')
  })

  it('closes through its stream: what it emits is what the worker\'s close, or the core\'s own, says', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { deps, close, backstop } = setup()
    backstop.armAgyIdleWatch('s1')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(close).toHaveBeenCalledWith('s1', {})
    expect(deps.emit).toHaveBeenCalledOnce()
  })

  it('keeps watching a busy or unreadable pane, up to forty checks, then stops', async () => {
    const { deps, backstop } = setup()
    vi.mocked(deps.captureTerminal).mockResolvedValueOnce(null).mockResolvedValue(BUSY)
    backstop.armAgyIdleWatch('s1')
    await vi.advanceTimersByTimeAsync(15_000 * 45)
    expect(deps.captureTerminal).toHaveBeenCalledTimes(40)
    expect(deps.emit).not.toHaveBeenCalled()
  })

  it('leaves alone a turn that closed, a session that is gone, and a turn the drain closed', async () => {
    const closed = setup()
    closed.normalizer.turnOpen = false
    closed.backstop.armAgyIdleWatch('s1')
    const gone = setup({ bySession: () => undefined })
    gone.backstop.armAgyIdleWatch('s1')
    const none = setup()
    none.backstop.armAgyIdleWatch('no-normalizer')
    const drained = setup()
    vi.mocked(drained.deps.drain).mockImplementation(async () => { drained.normalizer.turnOpen = false })
    drained.backstop.armAgyIdleWatch('s1')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(closed.deps.captureTerminal).not.toHaveBeenCalled()
    expect(gone.deps.captureTerminal).not.toHaveBeenCalled()
    expect(none.deps.captureTerminal).not.toHaveBeenCalled()
    expect(drained.deps.emit).not.toHaveBeenCalled()
  })

  it('counts a run of waiting Stops toward the same forty checks', async () => {
    const { deps, backstop } = setup()
    for (let stop = 0; stop < 41; stop++) backstop.armAgyIdleWatch('s1')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.captureTerminal).not.toHaveBeenCalled()
  })

  it('is cleared by a real Stop, and a new arm replaces the one waiting', async () => {
    const { deps, backstop } = setup()
    backstop.armAgyIdleWatch('s1')
    backstop.clearAgyIdleWatch('s1')
    backstop.clearAgyIdleWatch('s1')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.captureTerminal).not.toHaveBeenCalled()
    backstop.armAgyIdleWatch('s1')
    await vi.advanceTimersByTimeAsync(10_000)
    backstop.armAgyIdleWatch('s1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.captureTerminal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.captureTerminal).toHaveBeenCalledTimes(1)
  })

  it('reports a check that fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps, backstop } = setup()
    vi.mocked(deps.captureTerminal).mockRejectedValueOnce(new Error('pane gone')).mockRejectedValueOnce('tmux down')
    backstop.armAgyIdleWatch('s1')
    await vi.advanceTimersByTimeAsync(15_000)
    backstop.armAgyIdleWatch('s1')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(error.mock.calls).toEqual([['[agy] idle backstop failed:', 'Error'], ['[agy] idle backstop failed:', 'string']])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEngineLinks } from './engineLinks.js'

afterEach(() => vi.useRealTimers())

describe('engine worker links', () => {
  it('is ready at once for a linked worker, and for an engine with none', async () => {
    const links = createEngineLinks()
    links.connected('engine-codex')
    await links.ready('codex', 10_000)
    await links.ready('terminal', 10_000)
  })

  it('waits for the worker to link again, or for its bound, whichever comes first', async () => {
    vi.useFakeTimers()
    const links = createEngineLinks()
    links.connected('engine-codex'); links.disconnected('engine-codex')
    const woken = vi.fn(), timed = vi.fn()
    void links.ready('codex', 10_000).then(woken)
    void links.ready('claude', 10_000).then(timed)
    void links.ready('codex', 10_000).then(woken)
    links.connected('engine-codex')
    await vi.advanceTimersByTimeAsync(0)
    expect(woken).toHaveBeenCalledTimes(2)
    expect(timed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(timed).toHaveBeenCalledOnce()
    // A worker linking with nobody waiting wakes nothing.
    links.connected('engine-claude')
  })

  it('waits for the shared reader of every other engine and releases expired waiters', async () => {
    vi.useFakeTimers()
    const links = createEngineLinks(), done = vi.fn()
    for (const engine of ['hermes', 'opencode', 'kilo', 'devin', 'openclaw']) void links.ready(engine, 100).then(done)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toHaveBeenCalledTimes(5)
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    links.connected('engine-others')
    expect(clear).not.toHaveBeenCalled()
    clear.mockRestore()
    await links.ready('hermes', 100)
    links.disconnected('engine-others')
    void links.ready('hermes', 100).then(done)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledTimes(5)
    links.connected('engine-others')
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledTimes(6)
  })
})

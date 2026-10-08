import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEngineLinks } from './engineLinks.js'

afterEach(() => vi.useRealTimers())

describe('engine worker links', () => {
  it('is ready at once for a linked worker, and for an engine with none', async () => {
    const links = createEngineLinks()
    links.connected('engine-codex')
    await links.ready('codex', 10_000)
    await links.ready('cursor', 10_000)
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
})

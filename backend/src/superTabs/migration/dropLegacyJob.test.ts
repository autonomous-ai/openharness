import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sleeper } from './dropLegacyJob.js'

describe('the pause between writes', () => {
  afterEach(() => vi.useRealTimers())

  it('leaves no stop listener behind once its time is up, so a long backlog does not pile them up', async () => {
    vi.useFakeTimers()
    const control = new AbortController()
    const wait = sleeper(control.signal)

    for (let i = 0; i < 5; i++) {
      const done = wait(500)
      expect(getEventListeners(control.signal, 'abort')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(500)
      await done
    }

    expect(getEventListeners(control.signal, 'abort')).toHaveLength(0)
  })

  it('ends at once when stopped, and removes its listener', async () => {
    vi.useFakeTimers()
    const control = new AbortController()
    const done = sleeper(control.signal)(3_600_000)

    control.abort()
    await done

    expect(getEventListeners(control.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

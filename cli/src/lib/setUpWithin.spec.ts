import { describe, expect, it, vi } from 'vitest'
import { setUpWithin } from './setUpWithin.js'

describe('setUpWithin: a set-up a create waits for, but not for long', () => {
  it('answers done once a quick set-up lands', async () => {
    await expect(setUpWithin(async () => ({ status: 'converged' }), 1_000)).resolves.toBe('done')
  })

  it('stops waiting at the bound and leaves the set-up running', async () => {
    vi.useFakeTimers()
    try {
      let finish!: () => void
      const running = new Promise<void>((resolve) => { finish = resolve })
      let landed = false
      const waited = setUpWithin(() => running.then(() => { landed = true }), 8_000)
      await vi.advanceTimersByTimeAsync(8_000)
      await expect(waited).resolves.toBe('pending')
      finish()
      await running
      await Promise.resolve()
      expect(landed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never throws: a failed set-up is for the next use of grid to say', async () => {
    await expect(setUpWithin(async () => { throw new Error('offline') }, 1_000)).resolves.toBe('done')
  })
})

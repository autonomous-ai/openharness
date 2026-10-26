import { describe, expect, it } from 'vitest'
import { QUIET_MS, QuietClock } from './quiet.js'

function setup() {
  let t = 1_000_000
  const clock = new QuietClock({ now: () => t })
  return { clock, advance: (ms: number) => { t += ms } }
}

describe('QuietClock', () => {
  it('idle without input for QUIET_MS is quiet', () => {
    const { clock, advance } = setup()
    clock.noteActivity('a', 'idle')
    advance(QUIET_MS)
    expect(clock.quietFor('a')).toBeGreaterThanOrEqual(QUIET_MS)
  })

  it('input resets quiet', () => {
    const { clock, advance } = setup()
    clock.noteActivity('a', 'idle')
    advance(QUIET_MS)
    clock.noteInput('a')
    expect(clock.quietFor('a')).toBe(0)
    advance(1000)
    expect(clock.quietFor('a')).toBe(1000)
  })

  it('working or unknown is never quiet', () => {
    const { clock, advance } = setup()
    clock.noteActivity('a', 'working')
    advance(QUIET_MS * 2)
    expect(clock.quietFor('a')).toBe(0)
    clock.noteActivity('a', 'unknown')
    advance(QUIET_MS * 2)
    expect(clock.quietFor('a')).toBe(0)
    expect(clock.quietFor('never-seen')).toBe(0)
  })

  it('idle seen again after working restarts the clock', () => {
    const { clock, advance } = setup()
    clock.noteActivity('a', 'idle')
    advance(QUIET_MS)
    clock.noteActivity('a', 'working')
    advance(5000)
    clock.noteActivity('a', 'idle')
    expect(clock.quietFor('a')).toBe(0)
    advance(2000)
    expect(clock.quietFor('a')).toBe(2000)
  })

  it('repeated idle does not restart the clock; forget clears', () => {
    const { clock, advance } = setup()
    clock.noteActivity('a', 'idle')
    advance(1000)
    clock.noteActivity('a', 'idle')
    expect(clock.quietFor('a')).toBe(1000)
    clock.forget('a')
    expect(clock.quietFor('a')).toBe(0)
  })
})

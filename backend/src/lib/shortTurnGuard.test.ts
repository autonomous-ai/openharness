import { describe, expect, it } from 'vitest'
import { ShortTurnGuard } from './shortTurnGuard.js'

/** Turn starts `gapMs` apart, starting at the clock's current time; the guard's verdict for each. */
function starts(guard: ShortTurnGuard, clock: { now: number }, count: number, gapMs: number): string[] {
  const verdicts: string[] = []
  for (let i = 0; i < count; i++) {
    verdicts.push(guard.admit())
    clock.now += gapMs
  }
  return verdicts
}

describe('short turn guard', () => {
  it('relays 20 turn starts in a row under 10 s apart, then holds the next for 60 s, saying so once', () => {
    const clock = { now: 1_000_000 }
    const guard = new ShortTurnGuard(() => clock.now)

    const verdicts = starts(guard, clock, 25, 2_000)

    // The first start has no previous one; the 20 short gaps after it are relayed, the 21st is not.
    expect(verdicts.slice(0, 21)).toEqual(Array(21).fill('relay'))
    expect(verdicts.slice(21)).toEqual(['pause_started', 'paused', 'paused', 'paused'])
  })

  it('a gap of 10 s or more ends the run', () => {
    const clock = { now: 0 }
    const guard = new ShortTurnGuard(() => clock.now)
    starts(guard, clock, 20, 9_999)
    clock.now += 1 // this gap is exactly 10 s

    expect(starts(guard, clock, 21, 9_999)).toEqual(Array(21).fill('relay'))
  })

  it('relays again once the 60 s are over, and holds a loop that goes on again after another 20', () => {
    const clock = { now: 0 }
    const guard = new ShortTurnGuard(() => clock.now)
    starts(guard, clock, 22, 1_000)
    expect(guard.admit()).toBe('paused')
    clock.now += 60_000

    expect(starts(guard, clock, 21, 1_000)).toEqual(Array(21).fill('relay'))
    expect(guard.admit()).toBe('pause_started')
  })
})

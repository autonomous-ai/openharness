import { describe, expect, it } from 'vitest'
import { random, schedule, words } from './random.js'

describe('seeded random numbers', () => {
  it('repeats the same sequence for the same seed and label', () => {
    const a = random(7, 'agent-1'), b = random(7, 'agent-1')
    const first = Array.from({ length: 5 }, () => a.next())
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(first)
    expect(first.every(n => n >= 0 && n < 1)).toBe(true)
  })

  it('gives another sequence for another label or seed', () => {
    const base = random(7, 'agent-1').next()
    expect(random(7, 'agent-2').next()).not.toBe(base)
    expect(random(8, 'agent-1').next()).not.toBe(base)
  })

  it('picks every item of a list over many draws, and only those', () => {
    const rng = random(1, 'pick'), seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(rng.pick(['a', 'b', 'c']))
    expect([...seen].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('schedule', () => {
  it('spaces events between half and one and a half times the mean, starting at the offset, inside the duration', () => {
    const times = schedule(random(3, 'machine-0'), { meanMs: 1000, durationMs: 10_000, offsetMs: 250 })
    expect(times[0]).toBe(250)
    expect(times.every(t => t < 10_000)).toBe(true)
    for (let i = 1; i < times.length; i++) {
      const gap = times[i]! - times[i - 1]!
      expect(gap).toBeGreaterThanOrEqual(500)
      expect(gap).toBeLessThanOrEqual(1500)
    }
    // About duration / mean events: 10 s at 1 s apart, give or take the jitter.
    expect(times.length).toBeGreaterThanOrEqual(7)
    expect(times.length).toBeLessThanOrEqual(20)
  })

  it('keeps a fixed interval when asked for no jitter', () => {
    expect(schedule(random(3, 'x'), { meanMs: 15_000, durationMs: 60_000, offsetMs: 0, jitter: false })).toEqual([0, 15_000, 30_000, 45_000])
  })
})

describe('words', () => {
  it('writes text of the asked length from the seed', () => {
    const text = words(random(5, 'brief'), 300)
    expect(text).toHaveLength(300)
    expect(words(random(5, 'brief'), 300)).toBe(text)
  })
})

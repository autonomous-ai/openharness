/**
 * pair/limit.ts — the multi-window sliding rate limit every daemon spends through (a relayed key, a remote
 * answer, a model turn, the pair's own lines). What must hold: a take is all-or-nothing across windows, a
 * refused take records nothing, keys are independent, retryAfter says exactly when a take would succeed,
 * and the per-key map is bounded.
 */
import { describe, expect, it } from 'vitest'
import { RateLimit } from './limit.js'

const SEC = 1_000
const MIN = 60 * SEC

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('RateLimit', () => {
  it('takes up to max inside one window, then refuses until the oldest take slides out', () => {
    const c = clock()
    const limit = new RateLimit([{ windowMs: MIN, max: 3 }], c.now)
    expect([limit.take('a'), limit.take('a'), limit.take('a')]).toEqual([true, true, true])
    expect(limit.take('a')).toBe(false)
    c.advance(MIN - 1)
    expect(limit.take('a')).toBe(false)
    c.advance(1)
    expect(limit.take('a')).toBe(true)
  })

  it('needs room in EVERY window: 6 a minute AND 60 an hour', () => {
    const c = clock()
    const limit = new RateLimit([{ windowMs: MIN, max: 6 }, { windowMs: 60 * MIN, max: 8 }], c.now)
    for (let i = 0; i < 6; i++) expect(limit.take()).toBe(true)
    expect(limit.take()).toBe(false)             // the minute is full
    c.advance(MIN)
    expect(limit.take()).toBe(true)
    expect(limit.take()).toBe(true)
    expect(limit.take()).toBe(false)             // the minute has room (2 of 6) but the hour is full (8 of 8)
    expect(limit.retryAfter()).toBe(59 * MIN)    // the first take of the hour leaves it 59 minutes from now
    c.advance(59 * MIN)
    expect(limit.take()).toBe(true)
  })

  it('records nothing for a refused take: hammering a full window never pushes the retry further out', () => {
    const c = clock()
    const limit = new RateLimit([{ windowMs: MIN, max: 1 }], c.now)
    expect(limit.take('k')).toBe(true)
    for (let i = 0; i < 50; i++) { c.advance(SEC); expect(limit.take('k')).toBe(false) }
    expect(limit.retryAfter('k')).toBe(MIN - 50 * SEC)
    c.advance(MIN - 50 * SEC)
    expect(limit.retryAfter('k')).toBe(0)
    expect(limit.take('k')).toBe(true)
  })

  it('keeps each key to itself', () => {
    const c = clock()
    const limit = new RateLimit([{ windowMs: MIN, max: 1 }], c.now)
    expect(limit.take('laptop')).toBe(true)
    expect(limit.take('laptop')).toBe(false)
    expect(limit.take('desk')).toBe(true)
    expect(limit.take()).toBe(true)              // the default key is a key like any other
    expect(limit.retryAfter('nobody')).toBe(0)   // a key never seen may take now
  })

  it('answers retryAfter as the LONGEST wait across the full windows', () => {
    const c = clock()
    const limit = new RateLimit([{ windowMs: 10 * SEC, max: 2 }, { windowMs: MIN, max: 3 }], c.now)
    limit.take(); c.advance(SEC); limit.take()
    expect(limit.retryAfter()).toBe(9 * SEC)     // only the short window is full
    c.advance(10 * SEC)
    limit.take()
    // short window: 1 inside (not full); long window: 3 inside, oldest at t0 → free at t0 + 60s
    expect(limit.retryAfter()).toBe(MIN - 11 * SEC)
    expect(limit.take()).toBe(false)
  })

  it('bounds the keys it remembers: past 1,000 the oldest key is forgotten', () => {
    const c = clock()
    const limit = new RateLimit([{ windowMs: MIN, max: 1 }], c.now)
    for (let i = 0; i <= 1_000; i++) expect(limit.take(`k${i}`)).toBe(true)
    // k0 was the oldest when the 1,001st key arrived: its take is forgotten, so it may take again.
    expect(limit.retryAfter('k0')).toBe(0)
    expect(limit.take('k0')).toBe(true)
    // …while a recent key is still limited.
    expect(limit.take('k1000')).toBe(false)
  })
})

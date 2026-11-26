import { describe, expect, it } from 'vitest'
import { costOf, guardCost, RUN_RESERVE_USD, SpendGuard } from './lib/spend.js'

const USAGE = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000 }
const JUDGE_USAGE = { input_tokens: 500, output_tokens: 50 }

describe('guardCost', () => {
  it('prices agent and judge calls as the summary does', () => {
    const billed = { model: 'claude-opus-5-5', usage: USAGE, judge_model: 'claude-opus-5-5', judge_usage: JUDGE_USAGE }
    expect(guardCost(billed)).toBeCloseTo(costOf('claude-opus-5-5', USAGE)! + costOf('claude-opus-5-5', JUDGE_USAGE)!, 12)
    // $0.024 for the run, $0.003 for its judge.
    expect(guardCost(billed)).toBeCloseTo(0.027, 12)
  })

  it('prices a call whose model has no price at the highest known price', () => {
    const usage = { input_tokens: 1000, output_tokens: 100 }
    expect(costOf('claude-sonnet-5', usage)).toBeNull()
    // claude-opus-5-5's $4 in and $20 out are the highest known: $0.006 for each unpriced call.
    expect(guardCost({ model: 'claude-sonnet-5', usage, judge_model: null, judge_usage: usage })).toBeCloseTo(0.012, 12)
  })
})

describe('SpendGuard', () => {
  it('lets a case start while the spend, a reserve for it and one for each case in flight stay within the cap', () => {
    expect(RUN_RESERVE_USD).toBe(1.5)
    const guard = new SpendGuard(10, 5.5)
    expect(guard.mayStart(0)).toBe(true)
    // $5.50 + 3 × $1.50 is the cap exactly.
    expect(guard.mayStart(2)).toBe(true)
  })

  it('refuses the case that would pass the cap', () => {
    const guard = new SpendGuard(10, 5.5)
    expect(guard.mayStart(3)).toBe(false)
    expect(new SpendGuard(10, 9).mayStart(0)).toBe(false)
  })

  it('adds what each finished case or probe cost', () => {
    const guard = new SpendGuard(9.5, 8)
    expect(guard.mayStart(0)).toBe(true)
    guard.add({ model: 'claude-opus-5-5', usage: USAGE, judge_model: 'claude-opus-5-5', judge_usage: JUDGE_USAGE })
    // A probe row carries no judge.
    guard.add({ model: 'claude-opus-5-5', usage: JUDGE_USAGE })
    expect(guard.spentUsd).toBeCloseTo(8.03, 12)
    expect(guard.mayStart(0)).toBe(false)
  })

  it("adds a case's row less the dollars of it already added, as its failed attempts are when they happen", () => {
    const guard = new SpendGuard(10, 0)
    const attempt = { model: 'claude-opus-5-5', usage: { input_tokens: 250_000, output_tokens: 0 } }

    // $1 at $4 a million input tokens.
    const counted = guard.add(attempt)
    expect(counted).toBeCloseTo(1, 12)
    // The row holds the failed attempt and the one that scored, $1 each.
    guard.add({ ...attempt, usage: { input_tokens: 500_000, output_tokens: 0 } }, counted)

    expect(guard.spentUsd).toBeCloseTo(2, 12)
  })
})

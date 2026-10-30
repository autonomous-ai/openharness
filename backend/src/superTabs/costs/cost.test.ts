import { describe, expect, it } from 'vitest'
import type { RouteRun } from './attempts.js'
import { attemptCost } from './cost.js'
import { PRICES, priceOf } from './prices.js'

const run = (over: Partial<RouteRun> = {}): RouteRun => ({ machineId: 'm', harnessId: 'h', engine: 'claude', model: 'opus', effort: 'high',
  billing: 'subscription', startedAt: 1, start: {}, endedAt: 2, end: {}, ...over })
const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite })

describe('the reviewed price table', () => {
  it('gives every model a source link and the date it was checked, in dollars per million tokens', () => {
    for (const price of PRICES) {
      expect(price.source, price.model).toMatch(/^https:\/\//)
      expect(price.checked, price.model).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      for (const n of [price.input, price.output, price.cacheRead, price.cacheWrite]) expect(n).toBeGreaterThanOrEqual(0)
    }
    expect(new Set(PRICES.map(p => p.model)).size).toBe(PRICES.length)
  })

  it('finds a model by its exact id or a dated release of it, and nothing for a model it does not list', () => {
    expect(priceOf('claude-opus-5-5')).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    expect(priceOf('claude-opus-5-5-20261001')?.model).toBe('claude-opus-5-5')
    expect(priceOf('claude-opus-5-5-preview')).toBeUndefined()
    expect(priceOf('claude-haiku-5-5')).toBeUndefined()
    expect(priceOf('unknown')).toBeUndefined()
  })
})

describe('an attempt’s cost', () => {
  it('prices each model’s tokens at its list price: API-equivalent cost, and no spend on a subscription', () => {
    // Opus 5.5: 1M input $4, 0.5M output $10, 2M cache reads $0.40, 0.2M cache writes $1. Sonnet 5.5: 1M output $10.
    const cost = attemptCost(run({ end: { 'claude-opus-5-5': tokens(1e6, 5e5, 2e6, 2e5), 'claude-sonnet-5-5': tokens(0, 1e6) } }), true)
    expect(cost.apiCost).toBeCloseTo(25.4, 10)
    expect(cost).toMatchObject({ spend: 0, priced: 'list' })
  })

  it('is money spent when the attempt paid per token', () => {
    expect(attemptCost(run({ billing: 'api', end: { 'gpt-6.1-sol': tokens(1e6, 1e6, 1e6) } }), true)).toEqual({ apiCost: 12.1, spend: 12.1, priced: 'list' })
  })

  it('prices a grid model at its API’s rates whatever its transcript calls it, and costs nothing on the Swarm’s own GPUs', () => {
    const grid = run({ grid: 'moonshotai/kimi-k3', billing: 'api', end: { 'kimi-k3-0905': tokens(1e6, 1e6) } })
    expect(attemptCost(grid, true).apiCost).toBeCloseTo(20.192, 10)
    expect(attemptCost({ ...grid, billing: 'own-hardware' }, true)).toEqual({ apiCost: 0, spend: 0, priced: 'own-hardware' })
  })

  it('has no cost, never a guess, for a model without a price or tokens it never read; spend unknown with unknown billing', () => {
    expect(attemptCost(run({ end: { 'claude-opus-5-5': tokens(1, 1), 'mystery-model': tokens(1, 1) } }), true)).toEqual({ apiCost: null, spend: null, priced: 'unpriced-model' })
    expect(attemptCost(run({ end: null }), true)).toEqual({ apiCost: null, spend: null, priced: 'no-tokens' })
    expect(attemptCost(run({ start: null, end: { 'claude-opus-5-5': tokens(1e6, 0) } }), false)).toMatchObject({ apiCost: null, priced: 'no-tokens' })
    expect(attemptCost(run({ billing: 'unknown', end: { 'claude-opus-5-5': tokens(1e6, 0) } }), true)).toEqual({ apiCost: 4, spend: null, priced: 'list' })
  })
})

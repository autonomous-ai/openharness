import { describe, expect, it } from 'vitest'
import type { Conversation } from '../model.js'
import type { RouteRun } from './attempts.js'
import { summarizeCosts, type CostRow } from './read.js'

const MINUTE = 60_000
const t = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 })
const run = (over: Partial<RouteRun> = {}): RouteRun => ({ machineId: 'm', harnessId: 'h', engine: 'claude', model: 'opus', effort: 'high',
  billing: 'subscription', startedAt: 0, start: {}, endedAt: 30 * MINUTE, end: { 'claude-opus-5-5': t(1e6, 0) }, ...over })
const row = (assignmentId: string, over: Partial<CostRow> = {}): CostRow => ({ conversationId: 'g1', assignmentId, outcome: 'done',
  kind: 'parser', fresh: false, run: run(), ...over })
const group = (id: string, runs: Array<{ assignmentId: string; firstReview?: boolean }>) => ({ id, ledger: { runs: runs.map(r => ({ engine: 'claude', model: 'opus', at: 0, ...r })) } }) as Conversation

describe('the cost summary', () => {
  it('groups attempts by engine, model, effort and kind with pass rate, shipped, median time to ship, tokens and costs', () => {
    const rows = [
      row('a1', { run: run({ endedAt: 10 * MINUTE }) }),
      row('a2', { outcome: 'lost', run: run({ end: { 'claude-opus-5-5': t(5e5, 0) } }) }),
      row('a3', { run: run({ endedAt: 50 * MINUTE, billing: 'api' }) }),
      row('a4', { kind: null, run: run({ effort: 'xhigh' }) }),
    ]
    const summary = summarizeCosts(rows, [group('g1', [{ assignmentId: 'a1', firstReview: true }, { assignmentId: 'a2', firstReview: false },
      { assignmentId: 'a3' }])])
    expect(summary.rows).toEqual([
      { engine: 'claude', model: 'opus', effort: 'high', kind: 'parser', attempts: 3, firstReviews: 2, firstReviewPassed: 1, firstReviewPassRate: 0.5,
        shipped: 2, outcomes: { done: 2, lost: 1 }, billing: { subscription: 2, api: 1 }, medianMinutesToShip: 30,
        tokens: { input: 2.5e6, output: 0, cacheRead: 0, cacheWrite: 0 }, tokensKnown: 3, apiCost: 10, spend: 4, costKnown: 3, costPerShipped: 5 },
      { engine: 'claude', model: 'opus', effort: 'xhigh', kind: 'unspecified', attempts: 1, firstReviews: 0, firstReviewPassed: 0, firstReviewPassRate: null,
        shipped: 1, outcomes: { done: 1 }, billing: { subscription: 1 }, medianMinutesToShip: 30,
        tokens: { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, tokensKnown: 1, apiCost: 4, spend: 0, costKnown: 1, costPerShipped: 4 },
    ])
    expect(summary.totals).toMatchObject({ attempts: 4, shipped: 3, apiCost: 14, spend: 4, costPerShipped: 14 / 3 })
  })

  it('names a grid model by the model it ran, counts open attempts as open, and leaves costs it cannot know out of the sums', () => {
    const summary = summarizeCosts([
      row('a1', { outcome: null, run: run({ grid: 'moonshotai/kimi-k3', billing: 'api', endedAt: undefined, end: undefined }) }),
      row('a2', { run: run({ end: { mystery: t(1, 1) } }) }),
      row('a3', { run: run({ start: null }) }),
    ], [])
    expect(summary.rows.map(r => [r.model, r.attempts, r.outcomes, r.tokensKnown, r.costKnown, r.apiCost, r.costPerShipped])).toEqual([
      ['moonshotai/kimi-k3', 1, { open: 1 }, 0, 0, null, null],
      ['opus', 2, { done: 2 }, 1, 0, null, null],
    ])
  })

  it('shows which prices it used, with their sources and dates', () => {
    expect(summarizeCosts([row('a1')], []).prices).toEqual([{ model: 'claude-opus-5-5', source: 'https://platform.claude.com/docs/en/about-claude/pricing', checked: '2026-10-29' }])
  })
})

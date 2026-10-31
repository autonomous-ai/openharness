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
const group = (id: string, runs: Array<{ assignmentId: string; firstReview?: boolean }>, shippedAt?: number) => ({ id,
  ledger: { runs: runs.map(r => ({ engine: 'claude', model: 'opus', at: 0, ...r })), ...(shippedAt === undefined ? {} : { shippedAt }) } }) as Conversation

describe('the cost summary', () => {
  it('groups attempts by engine, model, effort and kind with pass rate, shipped, median time to ship, tokens and costs', () => {
    const rows = [
      row('a1', { run: run({ endedAt: 10 * MINUTE }) }),
      row('a2', { conversationId: 'g2', outcome: 'lost', run: run({ end: { 'claude-opus-5-5': t(5e5, 0) } }) }),
      row('a3', { conversationId: 'g3', run: run({ endedAt: 50 * MINUTE, billing: 'api' }) }),
      row('a4', { conversationId: 'g4', kind: null, run: run({ effort: 'xhigh' }) }),
    ]
    const summary = summarizeCosts(rows, [group('g1', [{ assignmentId: 'a1', firstReview: true }], 10 * MINUTE),
      group('g2', [{ assignmentId: 'a2', firstReview: false }]), group('g3', [{ assignmentId: 'a3' }], 50 * MINUTE), group('g4', [], 30 * MINUTE)])
    expect(summary.rows).toEqual([
      { engine: 'claude', model: 'opus', effort: 'high', kind: 'parser', attempts: 3, firstReviews: 2, firstReviewPassed: 1, firstReviewPassRate: 0.5,
        shipped: 2, outcomes: { done: 2, lost: 1 }, billing: { subscription: 2, api: 1 }, medianMinutesToShip: 30,
        tokens: { input: 2.5e6, output: 0, cacheRead: 0, cacheWrite: 0 }, tokensKnown: 3, apiCost: 10, spend: 4, costKnown: 3, costPerShipped: 5, stepUps: 0,
        reviewAttempts: 0, fullCostKnown: 1, fullCostPerShipped: 5 },
      { engine: 'claude', model: 'opus', effort: 'xhigh', kind: 'unspecified', attempts: 1, firstReviews: 0, firstReviewPassed: 0, firstReviewPassRate: null,
        shipped: 1, outcomes: { done: 1 }, billing: { subscription: 1 }, medianMinutesToShip: 30,
        tokens: { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, tokensKnown: 1, apiCost: 4, spend: 0, costKnown: 1, costPerShipped: 4, stepUps: 0,
        reviewAttempts: 0, fullCostKnown: 1, fullCostPerShipped: 4 },
    ])
    expect(summary.totals).toMatchObject({ attempts: 4, shipped: 3, apiCost: 14, spend: 4, costPerShipped: 14 / 3 })
  })

  it('ships a request once, by the attempt that ran when it shipped, however many attempts were done after', async () => {
    // Done at 10 minutes, then worked on and done again: still one shipped change, and both attempts' cost is its cost.
    const rows = [row('b1', { run: run({ startedAt: 0, endedAt: 10 * MINUTE }) }), row('b2', { run: run({ startedAt: 20 * MINUTE, endedAt: 30 * MINUTE }) })]
    const summary = summarizeCosts(rows, [group('g1', [], 10 * MINUTE)])
    expect(summary.rows[0]).toMatchObject({ attempts: 2, shipped: 1, outcomes: { done: 2 }, medianMinutesToShip: 10, apiCost: 8, costPerShipped: 8 })
    // Its merge recorded before any Done ships it then, by the attempt running at the merge, even one lost afterwards.
    const merged = summarizeCosts([row('c1', { outcome: 'lost', run: run({ startedAt: 0, endedAt: 40 * MINUTE }) })], [group('g1', [], 25 * MINUTE)])
    expect(merged.rows[0]).toMatchObject({ shipped: 1, medianMinutesToShip: 25 })
    // A done attempt of a request with no recorded ship (a group the reader cannot read) ships nothing here.
    expect(summarizeCosts([row('d1')], []).rows[0]).toMatchObject({ shipped: 0, costPerShipped: null })
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

  it('rolls the rows up per model, across efforts and kinds, with pass rate, cost per shipped change and step-ups, to compare week over week', () => {
    const rows = [
      row('k1', { conversationId: 'g1', run: run({ grid: 'moonshotai/kimi-k3', effort: 'default', billing: 'api' }) }),
      row('k2', { conversationId: 'g2', kind: 'docs', run: run({ grid: 'moonshotai/kimi-k3', effort: 'default', billing: 'api' }) }),
      row('s1', { conversationId: 'g2', kind: 'docs', stepUp: { attempt: 2, reason: 'Its first review said Ready no.' }, run: run({ model: 'sonnet', effort: 'medium', startedAt: 10 * MINUTE }) }),
      row('o1', { conversationId: 'g3', run: run({ effort: 'xhigh' }) }),
    ]
    const summary = summarizeCosts(rows, [group('g1', [{ assignmentId: 'k1', firstReview: true }], 30 * MINUTE),
      group('g2', [{ assignmentId: 'k2', firstReview: false }, { assignmentId: 's1', firstReview: true }], 30 * MINUTE), group('g3', [])])
    expect(summary.models.map(m => [m.engine, m.model, m.attempts, m.firstReviewPassRate, m.shipped, m.stepUps])).toEqual([
      ['claude', 'moonshotai/kimi-k3', 2, 0.5, 1, 0],
      ['claude', 'opus', 1, null, 0, 0],
      ['claude', 'sonnet', 1, 1, 1, 1],
    ])
    expect(summary.models[2]!.costPerShipped).toBe(summary.models[2]!.apiCost)
    expect(summary.rows.find(r => r.model === 'sonnet')).toMatchObject({ stepUps: 1 })
    expect(summary.totals).toMatchObject({ attempts: 4, stepUps: 1 })
  })

  it('shows which prices it used, with their sources and dates', () => {
    expect(summarizeCosts([row('a1')], []).prices).toEqual([{ model: 'claude-opus-5-5', source: 'https://platform.claude.com/docs/en/about-claude/pricing', checked: '2026-10-29' }])
  })
})

describe('the full cost per shipped change (routing, Goals piece 3)', () => {
  const reviewRun = (startedAt: number) => run({ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', startedAt, endedAt: startedAt + 5 * MINUTE,
    end: { 'gpt-6.1-sol': t(1e5, 0) } })
  const reviewGroup = (id: string, of: string) => ({ ...group(id, []), reviewOf: of }) as Conversation

  it('counts every attempt of the choice and every review of its work, so a choice that needs rework rounds costs more per shipped change', () => {
    // Two builds that ship; g1's work took three review rounds (a first review failed twice), g2's one.
    const rows = [
      row('b1', { conversationId: 'g1' }), row('b2', { conversationId: 'g2' }),
      row('r1', { conversationId: 'v1', kind: 'review', run: reviewRun(10 * MINUTE) }),
      row('r2', { conversationId: 'v1', kind: 'review', run: reviewRun(40 * MINUTE) }),
      row('r3', { conversationId: 'v1', kind: 'review', run: reviewRun(70 * MINUTE) }),
      row('r4', { conversationId: 'v2', kind: 'review', run: reviewRun(10 * MINUTE) }),
    ]
    const summary = summarizeCosts(rows, [group('g1', [{ assignmentId: 'b1', firstReview: false }], 90 * MINUTE),
      group('g2', [{ assignmentId: 'b2', firstReview: true }], 30 * MINUTE), reviewGroup('v1', 'g1'), reviewGroup('v2', 'g2')])
    const build = summary.rows.find(r => r.kind === 'parser')!
    const review = summary.rows.find(r => r.kind === 'review')!
    const perReview = review.apiCost! / 4
    expect(build).toMatchObject({ costPerShipped: 4, reviewAttempts: 4, fullCostKnown: 1 })
    // Its own two attempts ($8) and the four reviews of its work, over two shipped changes.
    expect(build.fullCostPerShipped).toBeCloseTo((8 + 4 * perReview) / 2, 10)
    // A review's own row counts no reviews of reviews.
    expect(review).toMatchObject({ reviewAttempts: 0 })
  })

  it('charges a review to the build attempt that ran when it started, also a failed attempt of another choice', () => {
    // Sonnet's attempt was reviewed and lost; Opus took over and shipped. The first review is Sonnet's cost, not Opus's.
    const rows = [
      row('s1', { conversationId: 'g1', outcome: 'lost', run: run({ model: 'sonnet', effort: 'medium', startedAt: 0 }) }),
      row('o1', { conversationId: 'g1', run: run({ startedAt: 30 * MINUTE }) }),
      row('r1', { conversationId: 'v1', kind: 'review', run: reviewRun(20 * MINUTE) }),
      row('r2', { conversationId: 'v1', kind: 'review', run: reviewRun(50 * MINUTE) }),
    ]
    const summary = summarizeCosts(rows, [group('g1', [], 60 * MINUTE), reviewGroup('v1', 'g1')])
    expect(summary.rows.find(r => r.model === 'sonnet')).toMatchObject({ reviewAttempts: 1, shipped: 0, fullCostPerShipped: null })
    expect(summary.rows.find(r => r.model === 'opus')).toMatchObject({ reviewAttempts: 1, shipped: 1 })
  })

  it('names no group, title, person or id: only choices, kinds and numbers', () => {
    const rows = [row('b1', { conversationId: 'g-secret' }), row('r1', { conversationId: 'v-secret', kind: 'review', run: reviewRun(10 * MINUTE) })]
    const groups = [{ ...group('g-secret', [{ assignmentId: 'b1', firstReview: true }], 30 * MINUTE), title: 'Ana private plan', leadId: 'agent-ana' },
      { ...reviewGroup('v-secret', 'g-secret'), title: 'Review: Ana private plan' }] as Conversation[]
    const text = JSON.stringify(summarizeCosts(rows, groups))
    for (const leak of ['secret', 'Ana', 'plan', 'agent-ana', 'b1', 'r1', '"m"', '"h"']) expect(text).not.toContain(leak)
  })

  it('fills an unknown attempt cost with the mean of known ones on the same choice, and gives no figure when under half are known', () => {
    const known = [row('a1', { conversationId: 'g1' }), row('a2', { conversationId: 'g2' }), row('a3', { conversationId: 'g3', run: run({ start: null }) })]
    const half = summarizeCosts(known, [group('g1', [], 30 * MINUTE), group('g2', [], 30 * MINUTE), group('g3', [], 30 * MINUTE)])
    // Two of three known at $4 each: the third counts $4 too; strict cost per shipped stays null, as before.
    expect(half.rows[0]).toMatchObject({ costPerShipped: null, fullCostKnown: 2 / 3, fullCostPerShipped: 4 })
    const few = summarizeCosts([row('b1'), row('b2', { run: run({ start: null }) }), row('b3', { run: run({ start: null }) })], [group('g1', [], 30 * MINUTE)])
    expect(few.rows[0]).toMatchObject({ fullCostKnown: 1 / 3, fullCostPerShipped: null })
    // Open attempts are still going: they are neither known nor unknown yet.
    const open = summarizeCosts([row('c1'), row('c2', { outcome: null, run: run({ endedAt: undefined, end: undefined }) })], [group('g1', [], 30 * MINUTE)])
    expect(open.rows[0]).toMatchObject({ fullCostKnown: 1, fullCostPerShipped: 4 })
  })
})

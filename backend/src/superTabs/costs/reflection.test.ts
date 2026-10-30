import { describe, expect, it } from 'vitest'
import type { Conversation } from '../model.js'
import type { ModelKindEvidence } from '../evidence/store.js'
import type { RouteRun } from './attempts.js'
import type { CostRow } from './read.js'
import { routingReflection, type FailedStart, type ReflectionInput } from './reflection.js'

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR
const NOW = 10 * DAY
const tokens = (model: string, input: number) => ({ [model]: { input, output: 0, cacheRead: 0, cacheWrite: 0 } })
/** An attempt [startedAt] ago that ran an hour and used 1M input tokens of [model]: $4 on Opus, $2 on Sonnet and gpt-6.1-sol. */
const run = (engine: string, model: string, effort: string, startedAt: number, over: Partial<RouteRun> = {}): RouteRun => ({ machineId: 'm', harnessId: 'h',
  engine, model, effort, billing: 'subscription', startedAt, start: {}, endedAt: startedAt + HOUR, end: tokens(model === 'opus' ? 'claude-opus-5-5'
    : model === 'sonnet' ? 'claude-sonnet-5-5' : model, 1e6), ...over })
const row = (assignmentId: string, conversationId: string, kind: string, r: RouteRun, stepUp?: CostRow['stepUp']): CostRow =>
  ({ conversationId, assignmentId, outcome: 'done', kind, fresh: false, run: r, ...stepUp ? { stepUp } : {} })
const group = (id: string, runs: Array<{ assignmentId: string; firstReview?: boolean }>, shipped?: { by: string; at: number }) => ({ id,
  title: 'Secret plan for Acme', ledger: { runs: runs.map(r => ({ engine: 'claude', model: 'opus', at: 0, ...r })),
    ...shipped ? { shippedAt: shipped.at, shippedBy: { assignmentId: shipped.by } } : {} } }) as unknown as Conversation
const evidence = (engine: string, model: string, kind: string, over: Partial<ModelKindEvidence>) => ({ engine, model, kind, attempts: 0, firstReviews: 0,
  firstReviewPassed: 0, reworkRounds: 0, shipped: 0, minutesToShipSum: 0, minutesToShipCount: 0, fixesAfterMerge: 0, tokensInput: 0, tokensOutput: 0,
  tokensCacheRead: 0, tokensCacheWrite: 0, tokensKnown: 0, apiCost: 0, costKnown: 0, costUnknown: 0, spend: 0, spendKnown: 0, firstReviewPassRate: null,
  averageMinutesToShip: null, costPerShipped: null, recent: [], ...over }) as ModelKindEvidence

/**
 * A seeded week of one project:
 * - parser on Opus high: 4 attempts, all shipped, 3 of 4 first reviews passed, $4 each. Two of them in the last day.
 * - parser on Sonnet medium: 4 attempts, all shipped, 3 of 4 passed, $2 each: as good for half the price.
 * - ui on codex gpt-6.1-sol high: 3 attempts, 1 of 3 passed, one shipped, $2 each.
 * - docs: two tasks whose grid attempt (deepseek, own hardware, 1 h and 1.5 h) failed and stepped up to Sonnet, which shipped.
 */
function seededWeek(): ReflectionInput {
  const rows: CostRow[] = [], groups: Conversation[] = []
  const at = (daysAgo: number) => NOW - daysAgo * DAY
  ;['p1', 'p2', 'p3', 'p4'].forEach((id, i) => {
    rows.push(row(id, `g-${id}`, 'parser', run('claude', 'opus', 'high', at(i < 2 ? 0.5 : 3))))
    groups.push(group(`g-${id}`, [{ assignmentId: id, firstReview: i !== 3 }], { by: id, at: at(i < 2 ? 0.5 : 3) + HOUR }))
  })
  ;['s1', 's2', 's3', 's4'].forEach((id, i) => {
    rows.push(row(id, `g-${id}`, 'parser', run('claude', 'sonnet', 'medium', at(4))))
    groups.push(group(`g-${id}`, [{ assignmentId: id, firstReview: i !== 3 }], { by: id, at: at(4) + HOUR }))
  })
  ;['u1', 'u2', 'u3'].forEach((id, i) => {
    rows.push(row(id, `g-${id}`, 'ui', run('codex', 'gpt-6.1-sol', 'high', at(5))))
    groups.push(group(`g-${id}`, [{ assignmentId: id, firstReview: i === 2 }], i === 2 ? { by: id, at: at(5) + HOUR } : undefined))
  })
  const grid = (minutes: number, daysAgo: number) => run('claude', 'deepseek/deepseek-v4.1-flash-1017', 'low', at(daysAgo),
    { grid: 'deepseek/deepseek-v4.1-flash-1017', billing: 'own-hardware', endedAt: at(daysAgo) + minutes * MINUTE })
  rows.push(row('d1', 'g-d1', 'docs', grid(60, 6)), row('d2', 'g-d1', 'docs', run('claude', 'sonnet', 'medium', at(6) + 2 * HOUR), { attempt: 2, reason: 'Its first review said Ready no.' }))
  rows.push(row('d3', 'g-d2', 'docs', grid(90, 2)), row('d4', 'g-d2', 'docs', run('claude', 'sonnet', 'medium', at(2) + 2 * HOUR), { attempt: 2, reason: 'Its first review said Ready no.' }))
  groups.push(group('g-d1', [{ assignmentId: 'd1', firstReview: false }], { by: 'd2', at: at(6) + 3 * HOUR }),
    group('g-d2', [{ assignmentId: 'd3', firstReview: false }], { by: 'd4', at: at(2) + 3 * HOUR }))
  const failed: FailedStart = { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', at: at(0.2) }
  return { now: NOW, rows, groups, failedStarts: [failed, { ...failed, at: at(3) }], truncated: false,
    evidence: [evidence('claude', 'opus', 'feature', { reworkRounds: 1, fixesAfterMerge: 1 }), evidence('codex', 'gpt-6.1-sol', 'ui', { reworkRounds: 2 })] }
}

describe('the nightly routing reflection', () => {
  it('reports a seeded week: what shipped, cost per shipped change and first-review pass rate per engine, model, effort and kind', () => {
    const report = routingReflection(seededWeek())!
    const lines = report.text.split('\n')
    expect(lines).toContain('Last day: 2 attempts, 2 shipped. Last 7 days: 15 attempts, 11 shipped.')
    expect(lines).toContain('- claude opus high, parser: 4 attempts, 4 shipped, $4.00 per shipped change, first review passed 3 of 4 (75%)')
    expect(lines).toContain('- claude sonnet medium, parser: 4 attempts, 4 shipped, $2.00 per shipped change, first review passed 3 of 4 (75%)')
    expect(lines).toContain('- codex gpt-6.1-sol high, ui: 3 attempts, 1 shipped, $6.00 per shipped change, first review passed 1 of 3 (33%)')
    expect(lines).toContain('- claude deepseek/deepseek-v4.1-flash-1017 low, docs: 2 attempts, 0 shipped, first review passed 0 of 2 (0%)')
    expect(lines).toContain('- claude sonnet medium, docs: 2 attempts, 2 shipped, $2.00 per shipped change, no first review, 2 step-ups')
    expect(lines).toContain('Waste in the last 7 days: 2 failed starts (codex gpt-6.1-sol high: 2), 2 step-ups after a failed grid attempt '
      + '(docs: 2, 2.5 hours), 3 rework rounds, 1 fix after merge.')
  })

  it('proposes at most three changes from a seeded week, the largest saving first, each with its expected saving', () => {
    expect(routingReflection(seededWeek())!.proposals).toEqual([
      { title: 'Route parser work to claude sonnet medium instead of claude opus high',
        why: 'Its first review passes as often (75% against 75%) at $2.00 instead of $4.00 per shipped change.',
        saving: 'about $8.00 a week', dollars: 8, hours: 0 },
      { title: 'Stop routing ui work to codex gpt-6.1-sol high',
        why: 'Its first review passed 1 of 3 (33%).',
        saving: 'about $4.00 a week of attempts that failed their first review', dollars: 4, hours: 0 },
      { title: 'Start docs work on a subscription model instead of the grid',
        why: '2 of 2 docs tasks started on the grid stepped up after their grid attempt failed.',
        saving: 'about 2.5 hours to ship a week', dollars: 0, hours: 2.5 },
    ])
    const text = routingReflection(seededWeek())!.text
    expect(text).toContain('1. Route parser work to claude sonnet medium instead of claude opus high: about $8.00 a week.')
    expect(text).toContain('3. Start docs work on a subscription model instead of the grid: about 2.5 hours to ship a week.')
  })

  it('keeps only the three largest savings', () => {
    const week = seededWeek()
    // A fourth: test work on codex high whose first review passed 0 of 3, at $2 each: $6 a week, more than the ui proposal.
    ;['t1', 't2', 't3'].forEach(id => {
      week.rows.push(row(id, `g-${id}`, 'test', run('codex', 'gpt-6.1-sol', 'xhigh', NOW - 3 * DAY)))
      week.groups.push(group(`g-${id}`, [{ assignmentId: id, firstReview: false }]))
    })
    expect(routingReflection(week)!.proposals.map(p => p.title)).toEqual(['Route parser work to claude sonnet medium instead of claude opus high',
      'Stop routing test work to codex gpt-6.1-sol xhigh', 'Stop routing ui work to codex gpt-6.1-sol high'])
  })

  it('proposes nothing from too few first reviews or shipped changes', () => {
    const week = seededWeek()
    week.rows = week.rows.filter(r => !['p3', 'p4', 'u3', 'd3', 'd4'].includes(r.assignmentId))
    expect(routingReflection(week)!.proposals).toEqual([])
  })

  it('is empty for a day with no attempt and no failed start: nothing is posted', () => {
    const week = seededWeek()
    week.rows = week.rows.filter(r => r.run.startedAt < NOW - DAY)
    week.failedStarts = week.failedStarts.filter(f => f.at < NOW - DAY)
    expect(routingReflection(week)).toBeNull()
  })

  it('says only aggregates: no task title, assignment or conversation id', () => {
    const text = routingReflection(seededWeek())!.text
    for (const secret of ['Secret plan', 'g-p1', 'p1', 'u3']) expect(text).not.toContain(secret)
  })

  it('says when the newest attempts were all it could read', () => {
    expect(routingReflection({ ...seededWeek(), truncated: true })!.text).toContain('Only the newest 3000 attempts were read.')
  })
})

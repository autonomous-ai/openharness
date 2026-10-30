import { describe, expect, it } from 'vitest'
import type { Conversation } from '../model.js'
import type { ModelKindEvidence } from '../evidence/store.js'
import type { RouteRun } from './attempts.js'
import type { CostRow } from './read.js'
import { proposalQuestion, proposalTitle, routingReflection, wilson, type FailedStart, type ReflectionInput } from './reflection.js'

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
 * - parser on Opus high: 5 attempts, all shipped, 4 of 5 first reviews passed, $4 each. Two of them in the last day.
 * - parser on Sonnet medium: 5 attempts, all shipped, 4 of 5 passed, $2 each: as good for half the price.
 * - ui on codex gpt-6.1-sol high: 6 attempts, 0 of 6 passed, one shipped later, $2 each.
 * - docs: three tasks whose grid attempt (deepseek, own hardware, 1, 1.5 and 0.5 h) failed and stepped up to Sonnet, which shipped.
 */
function seededWeek(): ReflectionInput {
  const rows: CostRow[] = [], groups: Conversation[] = []
  const at = (daysAgo: number) => NOW - daysAgo * DAY
  ;['p1', 'p2', 'p3', 'p4', 'p5'].forEach((id, i) => {
    rows.push(row(id, `g-${id}`, 'parser', run('claude', 'opus', 'high', at(i < 2 ? 0.5 : 3))))
    groups.push(group(`g-${id}`, [{ assignmentId: id, firstReview: i !== 4 }], { by: id, at: at(i < 2 ? 0.5 : 3) + HOUR }))
  })
  ;['s1', 's2', 's3', 's4', 's5'].forEach((id, i) => {
    rows.push(row(id, `g-${id}`, 'parser', run('claude', 'sonnet', 'medium', at(4))))
    groups.push(group(`g-${id}`, [{ assignmentId: id, firstReview: i !== 4 }], { by: id, at: at(4) + HOUR }))
  })
  ;['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].forEach((id, i) => {
    rows.push(row(id, `g-${id}`, 'ui', run('codex', 'gpt-6.1-sol', 'high', at(5))))
    groups.push(group(`g-${id}`, [{ assignmentId: id, firstReview: false }], i === 5 ? { by: id, at: at(5) + HOUR } : undefined))
  })
  const grid = (minutes: number, daysAgo: number) => run('claude', 'deepseek/deepseek-v4.1-flash-1017', 'low', at(daysAgo),
    { grid: 'deepseek/deepseek-v4.1-flash-1017', billing: 'own-hardware', endedAt: at(daysAgo) + minutes * MINUTE })
  ;([[60, 6], [90, 2], [30, 1.5]] as const).forEach(([minutes, daysAgo], i) => {
    const g = `g-d${i}`
    rows.push(row(`d${i}`, g, 'docs', grid(minutes, daysAgo)),
      row(`d${i}b`, g, 'docs', run('claude', 'sonnet', 'medium', at(daysAgo) + 2 * HOUR), { attempt: 2, reason: 'Its first review said Ready no.' }))
    groups.push(group(g, [{ assignmentId: `d${i}`, firstReview: false }], { by: `d${i}b`, at: at(daysAgo) + 3 * HOUR }))
  })
  const failed: FailedStart = { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', at: at(0.2) }
  return { now: NOW, rows, groups, failedStarts: [failed, { ...failed, at: at(3) }], truncated: false,
    evidence: [evidence('claude', 'opus', 'feature', { reworkRounds: 1, fixesAfterMerge: 1 }), evidence('codex', 'gpt-6.1-sol', 'ui', { reworkRounds: 2 })] }
}
/** [n] more first reviews of a kind on a model, all as [passed], each shipped at $[cost]. */
function more(week: ReflectionInput, kind: string, engine: string, model: string, effort: string, n: number, passed: boolean) {
  for (let i = 0; i < n; i++) {
    const id = `${kind}-${model}-${i}`
    week.rows.push(row(id, `g-${id}`, kind, run(engine, model, effort, NOW - 3 * DAY)))
    week.groups.push(group(`g-${id}`, [{ assignmentId: id, firstReview: passed }], { by: id, at: NOW - 3 * DAY + HOUR }))
  }
}
const UI = 'Stop routing ui work to codex gpt-6.1-sol high'
const PARSER = 'Route parser work to claude sonnet medium instead of claude opus high'
const DOCS = 'Start docs work on a subscription model instead of the grid'

describe('the nightly routing reflection', () => {
  it('reports a seeded week: what shipped, time to ship, cost per shipped change and first-review pass rate per engine, model, effort and kind, and rework per model', () => {
    const report = routingReflection(seededWeek())!
    const lines = report.text.split('\n')
    expect(lines).toContain('Last day: 2 attempts, 2 shipped. Last 7 days: 22 attempts, 14 shipped.')
    expect(lines).toContain('- claude opus high, parser: 5 attempts, 5 shipped, median 60 min to ship, $4.00 per shipped change, first review passed 4 of 5 (80%)')
    expect(lines).toContain('- claude sonnet medium, parser: 5 attempts, 5 shipped, median 60 min to ship, $2.00 per shipped change, first review passed 4 of 5 (80%)')
    expect(lines).toContain('- codex gpt-6.1-sol high, ui: 6 attempts, 1 shipped, median 60 min to ship, $12.00 per shipped change, first review passed 0 of 6 (0%)')
    expect(lines).toContain('- claude deepseek/deepseek-v4.1-flash-1017 low, docs: 3 attempts, 0 shipped, first review passed 0 of 3 (0%)')
    expect(lines).toContain('- claude sonnet medium, docs: 3 attempts, 3 shipped, median 60 min to ship, $2.00 per shipped change, no first review, 3 step-ups')
    expect(lines).toContain('Waste in the last 7 days: 2 failed starts (codex gpt-6.1-sol high: 2), 3 step-ups after a failed grid attempt '
      + '(docs: 3, 3 hours), 3 rework rounds (codex gpt-6.1-sol ui: 2, claude opus feature: 1), 1 fix after merge (claude opus feature: 1).')
  })

  it('proposes at most three changes, the largest saving first, each with its counts, its uncertainty and its API-equivalent saving', () => {
    const report = routingReflection(seededWeek())!
    expect(report.proposals.map(({ title, why, saving, dollars, hours, strong }) => ({ title, why, saving, dollars, hours, strong }))).toEqual([
      { title: UI, why: 'Its first review passed 0 of 6 (0%); even the top of its 95% range is 39%. Only 6 first reviews.',
        saving: 'about $12.00 a week at API prices of attempts that failed their first review', dollars: 12, hours: 0, strong: false },
      { title: PARSER, why: 'Its first review passed 4 of 5 (80%) against 4 of 5 (80%), at $2.00 instead of $4.00 per shipped change at API prices. '
        + 'Small samples (5 and 5 first reviews): the difference may be chance.', saving: 'about $10.00 a week at API prices', dollars: 10, hours: 0, strong: false },
      { title: DOCS, why: '3 of 3 docs tasks started on the grid stepped up after their grid attempt failed. Only 3 tasks.',
        saving: 'about 3 hours to ship a week', dollars: 0, hours: 3, strong: false },
    ])
    expect(report.text).toContain('Proposed changes (advice: no rule or setting changes by itself):')
    expect(report.text).toContain(`2. ${PARSER}: about $10.00 a week at API prices. Its first review passed 4 of 5`)
  })

  it('asks plainly what a Yes does, and recommends Yes only on strong evidence, else Not yet', () => {
    const [ui] = routingReflection(seededWeek())!.proposals
    expect(proposalQuestion(ui!)).toEqual({ question: `${UI}? Expected saving: ${ui!.saving}. ${ui!.why}`,
      options: ['Yes: the Lead routes this way from now on', 'No: keep routing as it is', 'Not yet: ask again when there is more evidence'],
      recommended: 2, unblocks: 'If you say yes, the Lead routes ui work this way, and every nightly report lists it as approved until routing '
        + 'applies it by itself. No rule or setting changes.' })
    expect(proposalTitle(proposalQuestion(ui!).question)).toBe(UI)
    // Ten first reviews on each side: strong enough to recommend Yes, with no small-sample warning.
    const week = seededWeek()
    more(week, 'parser', 'claude', 'opus', 'high', 5, true)
    more(week, 'parser', 'claude', 'sonnet', 'medium', 5, true)
    const parser = routingReflection(week)!.proposals.find(p => p.title === PARSER)!
    expect(parser).toMatchObject({ strong: true, why: 'Its first review passed 9 of 10 (90%) against 9 of 10 (90%), at $2.00 instead of $4.00 per shipped change at API prices.' })
    expect(proposalQuestion(parser).recommended).toBe(0)
  })

  it('proposes to stop a model only when even the top of its 95% range is under half', () => {
    expect(wilson(0, 6).high).toBeCloseTo(0.39, 2)
    expect(wilson(1, 6).high).toBeGreaterThan(0.5)
    const week = seededWeek()
    // One of the six passed: it may still pass half the time, so nothing is proposed for it.
    week.groups = week.groups.map(g => g.id === 'g-u1' ? group('g-u1', [{ assignmentId: 'u1', firstReview: true }]) : g)
    expect(routingReflection(week)!.proposals.map(p => p.title)).toEqual([PARSER, DOCS])
  })

  it('keeps only the three largest savings', () => {
    const week = seededWeek()
    // A fourth: test work on codex xhigh whose first review passed 0 of 7, at $2 each: $14 a week, the largest.
    more(week, 'test', 'codex', 'gpt-6.1-sol', 'xhigh', 7, false)
    expect(routingReflection(week)!.proposals.map(p => p.title)).toEqual(['Stop routing test work to codex gpt-6.1-sol xhigh', UI, PARSER])
  })

  it('leaves out what the owner answered lately, approved or a rule already does, without spending a slot on it, and lists what was approved', () => {
    const week = seededWeek()
    more(week, 'test', 'codex', 'gpt-6.1-sol', 'xhigh', 7, false)
    expect(routingReflection({ ...week, decided: ['Stop routing test work to codex gpt-6.1-sol xhigh'] })!.proposals.map(p => p.title)).toEqual([UI, PARSER, DOCS])
    const approved = routingReflection({ ...week, approved: [{ title: UI, on: '2026-10-28' }] })!
    expect(approved.proposals.map(p => p.title)).toEqual(['Stop routing test work to codex gpt-6.1-sol xhigh', PARSER, DOCS])
    expect(approved.text.split('\n')).toEqual(expect.arrayContaining([
      'Approved by the project owner: the Lead routes this way, and this list repeats every night until routing does it by itself:',
      `- ${UI} (approved 2026-10-28)`]))
    // A project rule forbidding the model, or no grid first, already makes the change.
    expect(routingReflection({ ...seededWeek(), rules: [{ kind: 'forbidModel', engine: 'codex', model: 'gpt-6.1-sol' }] })!.proposals.map(p => p.title)).toEqual([PARSER, DOCS])
    expect(routingReflection({ ...seededWeek(), rules: [{ kind: 'noGridFirst' }] })!.proposals.map(p => p.title)).toEqual([UI, PARSER])
  })

  it('says after each proposal what happened to it', () => {
    const text = routingReflection(seededWeek())!.render(p => p.title === UI ? 'Asked of the project owner.' : null)
    expect(text).toContain(`1. ${UI}: about $12.00 a week at API prices of attempts that failed their first review. Its first review passed 0 of 6 (0%); `
      + 'even the top of its 95% range is 39%. Only 6 first reviews. Asked of the project owner.')
    expect(text.split('\n')).toContain('3. Start docs work on a subscription model instead of the grid: about 3 hours to ship a week. 3 of 3 docs tasks started on '
      + 'the grid stepped up after their grid attempt failed. Only 3 tasks.')
  })

  it('proposes nothing from too few first reviews, shipped changes or grid step-ups', () => {
    const week = seededWeek()
    week.rows = week.rows.filter(r => !['p5', 'u6', 'd2', 'd2b'].includes(r.assignmentId))
    week.groups = week.groups.map(g => g.id === 'g-u1' ? group('g-u1', [{ assignmentId: 'u1', firstReview: true }]) : g)
    expect(routingReflection(week)!.proposals).toEqual([])
    expect(routingReflection(week)!.text).toContain('No change proposed.')
  })

  it('proposes no cheaper model on fewer than five first reviews, however well they went', () => {
    const week = seededWeek()
    // Without its one failed review, Sonnet passed 4 of 4: better and cheaper, but on four reviews.
    week.rows = week.rows.filter(r => r.assignmentId !== 's5')
    expect(routingReflection(week)!.proposals.map(p => p.title)).not.toContain(PARSER)
    more(week, 'parser', 'claude', 'sonnet', 'medium', 1, true)
    expect(routingReflection(week)!.proposals.map(p => p.title)).toContain(PARSER)
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

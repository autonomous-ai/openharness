import { describe, expect, it } from 'vitest'
import type { Conversation } from '../model.js'
import type { RouteRun } from '../costs/attempts.js'
import { weekStart } from '../leaderboard/week.js'
import { contributionOf, increments, type Contribution, type EvidenceDecision } from './contribution.js'

const MINUTE = 60_000, START = Date.UTC(2026, 9, 28, 9)
const run = (patch: Partial<RouteRun> = {}): RouteRun => ({ machineId: 'm', harnessId: 'h', engine: 'claude', model: 'claude-opus-5-5', effort: 'high',
  billing: 'subscription', startedAt: START, start: { 'claude-opus-5-5': { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
  endedAt: START + 30 * MINUTE, end: { 'claude-opus-5-5': { input: 1_001_000, output: 100_000, cacheRead: 0, cacheWrite: 0 } }, ...patch })
const decision = (patch: Partial<EvidenceDecision> = {}): EvidenceDecision => ({ assignmentId: 'a1', outcome: 'done', final: { kind: 'member' },
  record: { assessment: { kind: 'ui' }, jobKind: 'backend' }, run: run(), ...patch })
const group = (ledger: Conversation['ledger'] = {}, owns = ['cli/src']): Pick<Conversation, 'reviewOf' | 'task' | 'ledger'> =>
  ({ task: { goal: 'g', changes: 'c', constraints: 'k', owns }, ledger })
const ranOn = { engine: 'claude', model: 'opus' }

describe('what one attempt adds to its model and kind', () => {
  it('adds nothing while the attempt is open or has no run', () => {
    expect(contributionOf(decision({ outcome: null }), group(), null)).toBeNull()
    expect(contributionOf(decision({ run: null }), group(), null)).toBeNull()
  })

  it('counts an ended attempt under its engine and model, the grid model by its own name, efforts merged, in the week it started', () => {
    const made = contributionOf(decision(), group(), null)!
    expect(made).toMatchObject({ engine: 'claude', model: 'claude-opus-5-5', kind: 'backend', week: weekStart(START),
      counts: { attempts: 1, firstReviews: 0, firstReviewPassed: 0, reworkRounds: 0, shipped: 0, fixesAfterMerge: 0, minutesToShipCount: 0 } })
    expect(contributionOf(decision({ run: run({ effort: 'low' }) }), group(), null)).toMatchObject({ engine: 'claude', model: 'claude-opus-5-5' })
    expect(contributionOf(decision({ run: run({ model: 'default', grid: 'moonshotai/kimi-k3', billing: 'api' }) }), group(), null))
      .toMatchObject({ model: 'moonshotai/kimi-k3' })
  })

  it('counts its tokens and cost at list prices, with the spend its billing says', () => {
    const { counts } = contributionOf(decision(), group(), null)!
    // 1,000,000 input at $4 and 100,000 output at $20 per million.
    expect(counts).toMatchObject({ tokensInput: 1_000_000, tokensOutput: 100_000, tokensKnown: 1, costKnown: 1, costUnknown: 0, spend: 0, spendKnown: 1 })
    expect(counts.apiCost).toBeCloseTo(6, 9)
    expect(contributionOf(decision({ run: run({ billing: 'api' }) }), group(), null)!.counts.spend).toBeCloseTo(6, 9)
    const unknown = contributionOf(decision({ run: run({ end: null }) }), group(), null)!.counts
    expect(unknown).toMatchObject({ tokensKnown: 0, costKnown: 0, costUnknown: 1, apiCost: 0 })
  })

  it('takes its first review and rework rounds from its ledger entry', () => {
    const ledger = { runs: [{ assignmentId: 'a1', at: START, ...ranOn, firstReview: false, reworkRounds: 2 }] }
    expect(contributionOf(decision(), group(ledger), null)).toMatchObject({ firstReview: false, counts: { firstReviews: 1, firstReviewPassed: 0, reworkRounds: 2 } })
    const passed = { runs: [{ assignmentId: 'a1', at: START, ...ranOn, firstReview: true }] }
    expect(contributionOf(decision(), group(passed), null)).toMatchObject({ firstReview: true, counts: { firstReviews: 1, firstReviewPassed: 1, reworkRounds: 0 } })
  })

  it('ships, with its minutes to ship and a fix after merge, only on the attempt the request shipped on', () => {
    const ledger = { shippedAt: START + 90 * MINUTE, shippedBy: { assignmentId: 'a1', at: START, ...ranOn }, fixedAfterMergeAt: START + 2 * 86_400_000 }
    expect(contributionOf(decision(), group(ledger), null)!.counts)
      .toMatchObject({ shipped: 1, minutesToShipSum: 90, minutesToShipCount: 1, fixesAfterMerge: 1 })
    expect(contributionOf(decision({ assignmentId: 'a0' }), group(ledger), null)!.counts)
      .toMatchObject({ shipped: 0, minutesToShipSum: 0, minutesToShipCount: 0, fixesAfterMerge: 0 })
  })

  it('keeps what it counted from a ledger whose entry rolled off or a group that is gone', () => {
    const ledger = { runs: [{ assignmentId: 'a1', at: START, ...ranOn, firstReview: true, reworkRounds: 1 }],
      shippedAt: START + 10 * MINUTE, shippedBy: { assignmentId: 'a1', at: START, ...ranOn } }
    const before = contributionOf(decision(), group(ledger), null)!
    expect(contributionOf(decision(), group({ ...ledger, runs: [] }), before)).toEqual(before)
    expect(contributionOf(decision(), undefined, before)).toEqual(before)
  })

  it('takes the kind of a decision routed before kinds from its group and route word', () => {
    expect(contributionOf(decision({ record: { assessment: { kind: 'ui' } } }), group(), null)!.kind).toBe('cli')
    expect(contributionOf(decision({ record: { assessment: { kind: 'docs' } } }), group({}, []), null)!.kind).toBe('docs')
    expect(contributionOf(decision({ record: { assessment: {} } }), undefined, null)!.kind).toBe('general')
  })
})

describe('the change one attempt makes to the store', () => {
  const made = (patch: Partial<Contribution> = {}, counts: Partial<Contribution['counts']> = {}): Contribution => {
    const base = contributionOf(decision(), group(), null)!
    return { ...base, ...patch, counts: { ...base.counts, ...counts } }
  }

  it('adds a new contribution whole, and only the difference of a changed one', () => {
    const first = made()
    const nonZero = Object.fromEntries(Object.entries(first.counts).filter(([, n]) => n !== 0))
    expect(nonZero).toMatchObject({ attempts: 1, tokensKnown: 1 })
    expect(increments(null, first)).toEqual([{ key: first, counts: nonZero }])
    const shipped = made({}, { shipped: 1, minutesToShipSum: 12, minutesToShipCount: 1 })
    expect(increments(first, shipped)).toEqual([{ key: shipped, counts: { shipped: 1, minutesToShipSum: 12, minutesToShipCount: 1 } }])
    expect(increments(shipped, shipped)).toEqual([])
  })

  it('takes a withdrawn attempt back out, and moves one whose model or kind changed', () => {
    const first = made()
    expect(increments(first, null)).toEqual([{ key: first, counts: Object.fromEntries(Object.entries(first.counts).filter(([, n]) => n !== 0).map(([k, n]) => [k, -n])) }])
    const moved = made({ kind: 'docs' })
    const changes = increments(first, moved)
    expect(changes.map(c => c.key.kind)).toEqual(['backend', 'docs'])
    expect(changes[0]!.counts.attempts).toBe(-1)
    expect(changes[1]!.counts.attempts).toBe(1)
  })
})

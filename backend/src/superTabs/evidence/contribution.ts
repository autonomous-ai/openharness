/**
 * What one attempt adds to its model's evidence for its kind of job (evidence routing, Ken 2026-10-29): counts and sums only,
 * never a person, an agent or task text. Pure: evidence/store.ts keeps each attempt's contribution on its route decision and
 * adds only the difference when the attempt ends, ships, is reviewed again or is fixed after its merge.
 */
import type { Conversation } from '../model.js'
import { attemptTokens, type RouteRun } from '../costs/attempts.js'
import { attemptCost } from '../costs/cost.js'
import { weekStart } from '../leaderboard/week.js'
import { JOB_KINDS, jobKindOf, type JobKind } from './jobKind.js'

/** The counters a store row sums. Minutes to ship are a sum and a count, so they add up (an average, Lead 2026-10-29). Cost is
 *  API-equivalent in US dollars over the attempts whose cost is known; `costUnknown` ended without one, so a cost per shipped
 *  change over them would read cheaper than it was. */
export interface Counts {
  attempts: number
  firstReviews: number; firstReviewPassed: number
  reworkRounds: number
  shipped: number; minutesToShipSum: number; minutesToShipCount: number
  fixesAfterMerge: number
  tokensInput: number; tokensOutput: number; tokensCacheRead: number; tokensCacheWrite: number; tokensKnown: number
  apiCost: number; costKnown: number; costUnknown: number
  spend: number; spendKnown: number
}
export const COUNTS: ReadonlyArray<keyof Counts> = ['attempts', 'firstReviews', 'firstReviewPassed', 'reworkRounds', 'shipped', 'minutesToShipSum',
  'minutesToShipCount', 'fixesAfterMerge', 'tokensInput', 'tokensOutput', 'tokensCacheRead', 'tokensCacheWrite', 'tokensKnown', 'apiCost', 'costKnown',
  'costUnknown', 'spend', 'spendKnown']

/** The row an attempt counts in: its group's project (the report shows a reader only projects they see; review of #2173), its
 *  engine, its model (a grid model by its own name; efforts merged), its kind and the week (Monday 00:00 UTC) it started. */
export interface EvidenceKey { projectId: string; engine: string; model: string; kind: JobKind; week: number }
/** One attempt's part, as its route decision keeps it. `firstReview` and `startedAt` feed the model's last-ten row. */
export interface Contribution extends EvidenceKey { counts: Counts; firstReview?: boolean; startedAt: number }

/** What of a route decision the contribution reads. `final.kind` `new`: its agent was started for it (costs/attempts.ts). */
export interface EvidenceDecision {
  assignmentId: string | null
  outcome: string | null
  final: { kind?: unknown } | null
  record: { assessment?: { kind?: unknown }; jobKind?: unknown }
  run: RouteRun | null
}

const zero = (): Counts => Object.fromEntries(COUNTS.map(k => [k, 0])) as unknown as Counts

/**
 * The attempt's part once it ended: null while it is open (or taken back by its session), or never ran. Its first review and
 * rework rounds come from its ledger entry, and its ship from the group's ledger; when that entry rolled off or the group is
 * gone, what was counted before stays, as those no longer change.
 */
export function contributionOf(decision: EvidenceDecision, group: Pick<Conversation, 'reviewOf' | 'task' | 'ledger'> | undefined,
  previous: Contribution | null, groupProjectId: string | undefined): Contribution | null {
  const run = decision.run
  const projectId = groupProjectId ?? previous?.projectId
  if (!run || decision.outcome == null || !decision.assignmentId || !projectId) return null
  const word = typeof decision.record.assessment?.kind === 'string' ? decision.record.assessment.kind : undefined
  const kind = (JOB_KINDS as readonly unknown[]).includes(decision.record.jobKind) ? decision.record.jobKind as JobKind : jobKindOf(group ?? {}, word)
  const counts = zero()
  counts.attempts = 1
  const entry = group?.ledger?.runs?.find(r => r.assignmentId === decision.assignmentId)
  let firstReview: boolean | undefined
  if (entry || !previous) {
    firstReview = entry?.firstReview
    if (firstReview !== undefined) { counts.firstReviews = 1; counts.firstReviewPassed = firstReview ? 1 : 0 }
    counts.reworkRounds = entry?.reworkRounds ?? 0
  } else {
    firstReview = previous.firstReview
    for (const k of ['firstReviews', 'firstReviewPassed', 'reworkRounds'] as const) counts[k] = previous.counts[k]
  }
  const ledger = group?.ledger
  if (ledger) {
    if (ledger.shippedBy?.assignmentId === decision.assignmentId && ledger.shippedAt !== undefined) {
      counts.shipped = 1
      counts.minutesToShipSum = Math.max(0, ledger.shippedAt - run.startedAt) / 60_000
      counts.minutesToShipCount = 1
      counts.fixesAfterMerge = ledger.fixedAfterMergeAt !== undefined ? 1 : 0
    }
  } else if (previous) {
    for (const k of ['shipped', 'minutesToShipSum', 'minutesToShipCount', 'fixesAfterMerge'] as const) counts[k] = previous.counts[k]
  }
  const fresh = decision.final?.kind === 'new'
  const used = attemptTokens(run, fresh)
  if (used) {
    counts.tokensKnown = 1
    for (const t of Object.values(used)) {
      counts.tokensInput += t.input; counts.tokensOutput += t.output; counts.tokensCacheRead += t.cacheRead; counts.tokensCacheWrite += t.cacheWrite
    }
  }
  const cost = attemptCost(run, fresh)
  if (cost.apiCost !== null) { counts.costKnown = 1; counts.apiCost = cost.apiCost } else counts.costUnknown = 1
  if (cost.spend !== null) { counts.spendKnown = 1; counts.spend = cost.spend }
  return { projectId, engine: run.engine, model: run.grid ?? run.model, kind, week: weekStart(run.startedAt), counts,
    ...(firstReview !== undefined ? { firstReview } : {}), startedAt: run.startedAt }
}

export const sameKey = (a: EvidenceKey, b: EvidenceKey): boolean =>
  a.projectId === b.projectId && a.engine === b.engine && a.model === b.model && a.kind === b.kind && a.week === b.week

/** The non-zero differences of [after] less [before], or all of [sign] times [counts]. */
const diff = (after: Counts, before: Counts | null, sign = 1): Partial<Counts> =>
  Object.fromEntries(COUNTS.map(k => [k, sign * (after[k] - (before?.[k] ?? 0))]).filter(([, n]) => n !== 0))

/** The increments that take the store from [before] to [after]: the difference in one row, or the old row's part taken out and
 *  the new one's added when its key changed. Nothing when both are the same. */
export function increments(before: Contribution | null, after: Contribution | null): Array<{ key: EvidenceKey; counts: Partial<Counts> }> {
  if (before && after && sameKey(before, after)) {
    const counts = diff(after.counts, before.counts)
    return Object.keys(counts).length ? [{ key: after, counts }] : []
  }
  return [...before ? [{ key: before as EvidenceKey, counts: diff(before.counts, null, -1) }] : [],
    ...after ? [{ key: after as EvidenceKey, counts: diff(after.counts, null) }] : []].filter(c => Object.keys(c.counts).length)
}

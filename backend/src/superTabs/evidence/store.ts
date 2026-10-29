/**
 * Each Swarm's evidence of how its models do per kind of job (evidence routing, Ken 2026-10-29): one row per model, kind and
 * week with counts and sums, and one per model and kind with its last ten first reviews. Route decisions expire at 90 days and
 * a group's ledger keeps 20 attempts, so this store keeps the history: 180 days. Rows hold no person, agent or task text.
 *
 * Written inside the store's write, after its attempt hooks (routeDecisions.ts): each attempt keeps its contribution on its
 * route decision, and a write that ends, ships, reviews or fixes an attempt adds only the difference. Concurrency: the
 * write's transaction; two writes adding to one row conflict and the store tries again (retry.ts). Read by routing and the
 * weekly report on the server only (readEvidence); nothing here is served to a reader.
 */
import type { Prisma } from '@prisma/client'
import { activeWork, stableId, type Conversation, type SuperTabState } from '../model.js'
import { DAY_MS, weekStart } from '../leaderboard/week.js'
import { ms } from '../parts/light.js'
import type { RouteRun } from '../costs/attempts.js'
import { contributionOf, COUNTS, increments, type Contribution, type Counts, type EvidenceKey } from './contribution.js'
import type { JobKind } from './jobKind.js'

type Tx = Prisma.TransactionClient
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

export const EVIDENCE_RETENTION_MS = 180 * DAY_MS
/** First reviews a model's last-ten row keeps per kind (spec PM call 4). */
export const RECENT_RESULTS = 10
/** Weekly rows one read takes: a Swarm with 20 models in all 9 kinds over 180 days has about 4,700. */
export const MAX_WEEK_ROWS = 10_000

/** Whether a write changed what a group's evidence depends on: its attempt and whether it is active, its ship, a fix after
 *  its merge. Its first reviews and rework rounds change only while an attempt is active (work.check), and that attempt's end
 *  is a change here, so they need no comparing. A status change within active work is not a change. Compared field by field:
 *  every write runs it over every group (under 0.1 ms for 1,000). */
function evidenceChanged(before: Conversation | undefined, after: Conversation): boolean {
  if (!before) return true
  const was = before.ledger, now = after.ledger
  return before.assignment?.id !== after.assignment?.id || activeWork(before) !== activeWork(after) || was?.shippedAt !== now?.shippedAt
    || was?.shippedBy?.assignmentId !== now?.shippedBy?.assignmentId || was?.fixedAfterMergeAt !== now?.fixedAfterMergeAt
}

/**
 * Brings the evidence of every group this write changed up to date: each of its attempts with a route decision is counted
 * again from its decision and the group's ledger, and only the difference is written. Called after the write's route
 * decisions are closed (closeAssignment) and their runs kept (recordAttempts).
 */
export async function recordEvidence(tx: Tx, tabId: string, before: SuperTabState, after: SuperTabState, now: number): Promise<void> {
  const earlier = new Map(before.conversations.map(c => [c.id, c]))
  const changed = after.conversations.filter(c => evidenceChanged(earlier.get(c.id), c))
  let wrote = false
  for (const group of changed) {
    const rows = await tx.superTabRouteDecision.findMany({ where: { tabId, conversationId: group.id },
      select: { id: true, assignmentId: true, outcome: true, final: true, record: true, run: true, evidence: true } })
    for (const row of rows) {
      if (!row.assignmentId || !row.run) continue
      const previous = (row.evidence ?? null) as unknown as Contribution | null
      const next = contributionOf({ assignmentId: row.assignmentId, outcome: row.outcome, final: row.final as { kind?: unknown } | null,
        record: row.record as { assessment?: { kind?: unknown }; jobKind?: unknown }, run: row.run as unknown as RouteRun }, group, previous)
      if (JSON.stringify(previous) === JSON.stringify(next)) continue
      for (const change of increments(previous, next)) await addCounts(tx, tabId, change.key, change.counts, now)
      if (previous && (!next || !sameModel(previous, next) || previous.firstReview !== next.firstReview)) {
        await recordRecent(tx, tabId, previous, row.assignmentId, null, now)
      }
      if (next?.firstReview !== undefined) await recordRecent(tx, tabId, next, row.assignmentId, { at: next.startedAt, passed: next.firstReview }, now)
      await tx.superTabRouteDecision.update({ where: { id: row.id }, data: { evidence: next ? json(next) : null as unknown as Prisma.InputJsonValue } })
      wrote = true
    }
  }
  if (!wrote) return
  const cutoff = new Date(now - EVIDENCE_RETENTION_MS)
  await tx.superTabModelEvidence.deleteMany({ where: { tabId, week: { lt: new Date(weekStart(now - EVIDENCE_RETENTION_MS)) } } })
  await tx.superTabModelRecent.deleteMany({ where: { tabId, updatedAt: { lt: cutoff } } })
}

const sameModel = (a: Omit<EvidenceKey, 'week'>, b: Omit<EvidenceKey, 'week'>): boolean => a.engine === b.engine && a.model === b.model && a.kind === b.kind
const weekId = (tabId: string, key: EvidenceKey) => stableId('evidence', tabId, key.engine, key.model, key.kind, String(key.week))
const recentId = (tabId: string, key: Omit<EvidenceKey, 'week'>) => stableId('evidence-recent', tabId, key.engine, key.model, key.kind)

/** Adds to a week's row, creating it for an attempt's first part. A part taken out of a row that is gone (past retention)
 *  is dropped rather than written as a negative row. */
async function addCounts(tx: Tx, tabId: string, key: EvidenceKey, counts: Partial<Counts>, now: number): Promise<void> {
  const id = weekId(tabId, key), updatedAt = new Date(now)
  const { count } = await tx.superTabModelEvidence.updateMany({ where: { id, tabId },
    data: { ...Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, { increment: n }])), updatedAt } })
  if (count || (counts.attempts ?? 0) <= 0) return
  await tx.superTabModelEvidence.create({ data: { id, tabId, engine: key.engine, model: key.model, kind: key.kind, week: new Date(key.week), ...counts, updatedAt } })
}

interface RecentResult { a: string; at: number; passed: boolean }

/** Sets or removes one attempt's first review in its model's last-ten row, oldest first. */
async function recordRecent(tx: Tx, tabId: string, key: Omit<EvidenceKey, 'week'>, assignmentId: string, result: { at: number; passed: boolean } | null,
  now: number): Promise<void> {
  const id = recentId(tabId, key)
  const row = await tx.superTabModelRecent.findFirst({ where: { id, tabId }, select: { results: true } })
  const results = ((row?.results ?? []) as unknown as RecentResult[]).filter(r => r.a !== assignmentId)
  if (result) results.push({ a: assignmentId, ...result })
  const kept = results.sort((x, y) => x.at - y.at).slice(-RECENT_RESULTS)
  if (row) await tx.superTabModelRecent.update({ where: { id }, data: { results: json(kept), updatedAt: new Date(now) } })
  else if (kept.length) await tx.superTabModelRecent.create({ data: { id, tabId, engine: key.engine, model: key.model, kind: key.kind, results: json(kept), updatedAt: new Date(now) } })
}

/** One model on one kind of job over the period read, with the rates routing and the report use. `recent`: its last ten
 *  first reviews, oldest first, whatever the period. */
export interface ModelKindEvidence extends Counts {
  engine: string; model: string; kind: JobKind
  /** Null with no first review. */
  firstReviewPassRate: number | null
  /** Minutes from the shipping attempt's start to its ship, averaged; null with nothing shipped. */
  averageMinutesToShip: number | null
  /** API-equivalent cost of every attempt over what shipped; null with nothing shipped or any ended attempt's cost unknown,
   *  as a partial sum would read cheaper than it was. */
  costPerShipped: number | null
  recent: boolean[]
}
export interface EvidenceRead {
  models: ModelKindEvidence[]
  /** The weekly rows the totals come from, oldest first, for the weekly report. */
  weeks: Array<EvidenceKey & Counts>
  /** More weekly rows than MAX_WEEK_ROWS: the oldest were left out. */
  truncated: boolean
}

/** A Swarm's evidence from the week holding [since], by its tabId+week index. A plain $match: Prisma's own filters reach Mongo
 *  as $expr, which its planner does not serve from the index (costs/read.ts). */
export async function readEvidence(tx: Tx, tabId: string, since: number): Promise<EvidenceRead> {
  const found = await tx.superTabModelEvidence.aggregateRaw({ pipeline: [
    { $match: { tabId, week: { $gte: { $date: new Date(weekStart(since)).toISOString() } } } },
    { $sort: { week: -1 } }, { $limit: MAX_WEEK_ROWS + 1 },
    { $project: { _id: 0, tabId: 0, updatedAt: 0 } },
  ] }) as unknown as Array<Record<string, unknown>>
  const recent = await tx.superTabModelRecent.aggregateRaw({ pipeline: [{ $match: { tabId } }, { $project: { engine: 1, model: 1, kind: 1, results: 1 } }] }) as unknown as
    Array<{ engine: string; model: string; kind: string; results: RecentResult[] }>
  const weeks = found.slice(0, MAX_WEEK_ROWS).map(row => ({ engine: String(row.engine), model: String(row.model), kind: row.kind as JobKind,
    week: ms(row.week), ...Object.fromEntries(COUNTS.map(k => [k, Number(row[k] ?? 0)])) as unknown as Counts })).reverse()
  const totals = new Map<string, ModelKindEvidence>()
  for (const row of weeks) {
    const id = JSON.stringify([row.engine, row.model, row.kind])
    const total = totals.get(id) ?? { engine: row.engine, model: row.model, kind: row.kind, ...Object.fromEntries(COUNTS.map(k => [k, 0])) as unknown as Counts,
      firstReviewPassRate: null, averageMinutesToShip: null, costPerShipped: null, recent: [] }
    for (const k of COUNTS) total[k] += row[k]
    totals.set(id, total)
  }
  const models = [...totals.values()].sort((a, b) => a.engine.localeCompare(b.engine) || a.model.localeCompare(b.model) || a.kind.localeCompare(b.kind))
  for (const m of models) {
    m.firstReviewPassRate = m.firstReviews ? m.firstReviewPassed / m.firstReviews : null
    m.averageMinutesToShip = m.minutesToShipCount ? m.minutesToShipSum / m.minutesToShipCount : null
    m.costPerShipped = m.shipped && !m.costUnknown ? m.apiCost / m.shipped : null
    m.recent = (recent.find(r => sameModel(r as Omit<EvidenceKey, 'week'>, m))?.results ?? []).map(r => r.passed)
  }
  return { models, weeks, truncated: found.length > MAX_WEEK_ROWS }
}


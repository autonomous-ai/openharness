/**
 * The one read of what Swarm attempts cost and how they went (Dee, 2026-10-29): per engine, model, effort and kind of job over
 * a period. Used by the Lead for the Product Manager, and meant for the leaderboard's Cheaper row and the nightly reflection.
 * Reads route decisions by their tabId+createdAt index, at most MAX_ROWS of them, and only the groups those name for their
 * first-review results (leaderboard/record.ts Run, joined by assignment id). Never messages.
 */
import type { Prisma } from '@prisma/client'
import type { Conversation } from '../model.js'
import { ms } from '../parts/light.js'
import { attemptTokens, type Billing, type RouteRun } from './attempts.js'
import { attemptCost } from './cost.js'
import { priceOf } from './prices.js'
import type { ModelTokens } from './tokens.js'

type Tx = Prisma.TransactionClient
/** Decisions one read takes, newest first: more than a busy Swarm routes in the longest period (about 300 a week, 10-28). */
export const MAX_ROWS = 3000
export const MAX_DAYS = 90
export const DEFAULT_DAYS = 7

/** One attempt as the summary reads it. `fresh`: its agent was started for it (costs/attempts.ts attemptTokens). `stepUp`: the
 *  step up from a cheaper model it was, as its decision keeps it (decisions from before project instructions). */
export interface CostRow { conversationId: string; assignmentId: string; outcome: string | null; kind: string | null; fresh: boolean; run: RouteRun
  stepUp?: { attempt: number; reason: string } }

/** The attempts routed since `since`: decisions with an assignment and a run, by the tabId+createdAt index. A plain $match,
 *  as recentDecisions does: Prisma's own filters reach Mongo as $expr, which its planner does not serve from the index. Only
 *  the fields the summary needs leave the database; the candidates' lines stay there. */
export async function costRows(tx: Tx, tabId: string, since: number): Promise<{ rows: CostRow[]; truncated: boolean }> {
  const found = await tx.superTabRouteDecision.aggregateRaw({ pipeline: [
    { $match: { tabId, createdAt: { $gte: { $date: new Date(since).toISOString() } } } },
    { $sort: { createdAt: -1 } }, { $limit: MAX_ROWS + 1 },
    { $project: { conversationId: 1, assignmentId: 1, outcome: 1, run: 1, 'final.kind': 1, 'record.assessment.kind': 1, 'record.stepUp': 1 } },
  ] }) as unknown as Array<Record<string, unknown>>
  const rows = found.slice(0, MAX_ROWS).flatMap(row => {
    const run = row.run as RouteRun | null | undefined
    if (!run || typeof row.assignmentId !== 'string') return []
    const record = row.record as { assessment?: { kind?: unknown }; stepUp?: CostRow['stepUp'] } | undefined
    const kind = record?.assessment?.kind
    return [{ conversationId: String(row.conversationId), assignmentId: row.assignmentId, outcome: (row.outcome ?? null) as string | null,
      kind: typeof kind === 'string' ? kind : null, fresh: (row.final as { kind?: unknown } | null | undefined)?.kind === 'new', run,
      ...(record?.stepUp ? { stepUp: record.stepUp } : {}) }]
  })
  return { rows, truncated: found.length > MAX_ROWS }
}

/** The starts routed since `since` that failed before any work was assigned (routeDecisions.ts closeUnassignedStart), with
 *  the engine, model and effort they were to run: by the same tabId+createdAt index as costRows, at most MAX_ROWS. Only
 *  those fields leave the database. */
export async function failedStarts(tx: Tx, tabId: string, since: number): Promise<Array<{ conversationId: string; engine: string; model: string; effort: string; at: number }>> {
  const found = await tx.superTabRouteDecision.aggregateRaw({ pipeline: [
    { $match: { tabId, createdAt: { $gte: { $date: new Date(since).toISOString() } }, outcome: 'failed' } },
    { $sort: { createdAt: -1 } }, { $limit: MAX_ROWS },
    { $project: { conversationId: 1, createdAt: 1, 'final.engine': 1, 'final.model': 1, 'final.effort': 1 } },
  ] }) as unknown as Array<{ conversationId: string; createdAt: unknown; final?: { engine?: unknown; model?: unknown; effort?: unknown } }>
  const text = (value: unknown) => typeof value === 'string' ? value : 'unknown'
  return found.map(row => ({ conversationId: String(row.conversationId), engine: text(row.final?.engine), model: text(row.final?.model),
    effort: text(row.final?.effort), at: ms(row.createdAt) }))
}

export interface CostSummaryRow {
  engine: string; model: string; effort: string; kind: string
  attempts: number
  /** Attempts whose first review has a verdict, and those that passed it; the rate is null with none. */
  firstReviews: number; firstReviewPassed: number; firstReviewPassRate: number | null
  /** Requests shipped, each once, by the attempt that ran when it shipped (shipping). */
  shipped: number
  /** By how each ended; `open` while still going. */
  outcomes: Record<string, number>
  billing: Partial<Record<Billing, number>>
  /** From the shipping attempt's start to when its request shipped. */
  medianMinutesToShip: number | null
  tokens: ModelTokens
  /** Attempts whose tokens are known: the sums cover only those. */
  tokensKnown: number
  /** API-equivalent cost and actual per-token spend in US dollars, summed over the attempts whose cost is known (costKnown);
   *  null with none known. */
  apiCost: number | null; spend: number | null; costKnown: number
  /** apiCost over shipped, only when every ended attempt's cost is known: a partial sum would read cheaper than it was. */
  costPerShipped: number | null
  /** Attempts that were a step up from a cheaper model (decisions from before project instructions). */
  stepUps: number
}

export interface CostSummary {
  rows: CostSummaryRow[]
  /** The same per model alone (a grid model by its own name), across efforts and kinds: what a model's first-review pass
   *  rate and cost per shipped change are, week over week (Ken, 2026-10-29). */
  models: Array<Omit<CostSummaryRow, 'effort' | 'kind'>>
  totals: Omit<CostSummaryRow, 'engine' | 'model' | 'effort' | 'kind'>
  /** The prices the costs used, with their sources and the day each was read. */
  prices: Array<{ model: string; source: string; checked: string }>
}

const median = (values: number[]): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Each shipped request's shipping attempt and when it shipped. A request ships once, at its earliest recorded merge or first
 *  Done (leaderboard/record.ts shippedAt), by the attempt that was running then: the latest started by that time. Attempts
 *  done after it ship nothing new; counting each Done had counted one request once per attempt (review of #2106). */
function shipping(rows: CostRow[], groups: Conversation[]): Map<string, number> {
  const shipped = new Map<string, number>()
  for (const group of groups) {
    const at = group.ledger?.shippedAt
    if (at === undefined) continue
    const ran = rows.filter(r => r.conversationId === group.id && r.run.startedAt <= at).sort((a, b) => b.run.startedAt - a.run.startedAt)[0]
    if (ran) shipped.set(ran.assignmentId, at)
  }
  return shipped
}

function summarize(rows: CostRow[], firstReview: Map<string, boolean>, shippedAt: Map<string, number>, prices: Set<string>): CostSummary['totals'] {
  const tokens: ModelTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const outcomes: Record<string, number> = {}, billing: Partial<Record<Billing, number>> = {}, toShip: number[] = []
  let firstReviews = 0, firstReviewPassed = 0, shipped = 0, tokensKnown = 0, costKnown = 0, apiCost = 0, spend = 0, spendKnown = 0, endedUnknown = 0, stepUps = 0
  for (const row of rows) {
    if (row.stepUp) stepUps++
    const verdict = firstReview.get(row.assignmentId)
    if (verdict !== undefined) { firstReviews++; if (verdict) firstReviewPassed++ }
    const outcome = row.outcome ?? 'open'
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
    billing[row.run.billing] = (billing[row.run.billing] ?? 0) + 1
    const at = shippedAt.get(row.assignmentId)
    if (at !== undefined) {
      shipped++
      toShip.push((at - row.run.startedAt) / 60_000)
    }
    const used = attemptTokens(row.run, row.fresh)
    if (used) {
      tokensKnown++
      for (const [model, t] of Object.entries(used)) {
        for (const key of Object.keys(tokens) as Array<keyof ModelTokens>) tokens[key] += t[key]
        const price = priceOf(row.run.grid ?? model)
        if (price) prices.add(price.model)
      }
    }
    const cost = attemptCost(row.run, row.fresh)
    if (cost.apiCost !== null) { costKnown++; apiCost += cost.apiCost }
    else if (row.outcome !== null) endedUnknown++
    if (cost.spend !== null) { spendKnown++; spend += cost.spend }
  }
  return { attempts: rows.length, firstReviews, firstReviewPassed, firstReviewPassRate: firstReviews ? firstReviewPassed / firstReviews : null,
    shipped, outcomes, billing, medianMinutesToShip: median(toShip), tokens, tokensKnown,
    apiCost: costKnown ? apiCost : null, spend: spendKnown ? spend : null, costKnown,
    costPerShipped: costKnown && shipped && !endedUnknown ? apiCost / shipped : null, stepUps }
}

/** The summary of these attempts; `groups` are the groups they belong to, for their ledgers' first reviews. */
export function summarizeCosts(rows: CostRow[], groups: Conversation[]): CostSummary {
  const firstReview = new Map<string, boolean>()
  for (const group of groups) for (const run of group.ledger?.runs ?? []) if (run.firstReview !== undefined) firstReview.set(run.assignmentId, run.firstReview)
  const keyOf = (row: CostRow) => [row.run.engine, row.run.grid ?? row.run.model, row.run.effort, row.kind ?? 'unspecified'] as const
  /** The rows grouped by [key], in key order. */
  const grouped = <K extends readonly string[]>(key: (row: CostRow) => K) => {
    const byKey = new Map<string, CostRow[]>()
    for (const row of rows) byKey.set(JSON.stringify(key(row)), [...byKey.get(JSON.stringify(key(row))) ?? [], row])
    return [...byKey.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => [key(group[0]!), group] as const)
  }
  const prices = new Set<string>(), shippedAt = shipping(rows, groups)
  const summary = grouped(keyOf).map(([[engine, model, effort, kind], group]) => ({ engine, model, effort, kind, ...summarize(group, firstReview, shippedAt, prices) }))
  const models = grouped(row => [row.run.engine, row.run.grid ?? row.run.model] as const)
    .map(([[engine, model], group]) => ({ engine, model, ...summarize(group, firstReview, shippedAt, new Set()) }))
  return { rows: summary, models, totals: summarize(rows, firstReview, shippedAt, new Set()),
    prices: [...prices].sort().map(model => { const p = priceOf(model)!; return { model: p.model, source: p.source, checked: p.checked } }) }
}

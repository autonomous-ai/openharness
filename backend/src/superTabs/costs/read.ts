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

/** What a choice's shipped change cost in full, for routing (Goals piece 3): every ended attempt of the choice, failed and lost
 *  ones too, and every review of its work, rework rounds included (fullCosts). Without the reviews a choice that needs three
 *  review rounds read as cheap as one that passes the first (Lead, 2026-10-31). */
export interface FullCost {
  /** Review attempts charged to this choice's attempts, open ones too. */
  reviewAttempts: number
  /** Of the ended attempts counted (its own and the reviews), the share whose cost is known; null with none ended. */
  fullCostKnown: number | null
  /** Their API-equivalent cost over shipped, an unknown attempt counted at the mean of known ones on its own choice; null
   *  with nothing shipped, under half the costs known, or an unknown cost on a choice with none known. */
  fullCostPerShipped: number | null
}
/** Under this share of known costs the mean that fills the rest says too little. */
export const MIN_KNOWN_SHARE = 0.5

export interface CostSummary {
  rows: Array<CostSummaryRow & FullCost>
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

/** Each review attempt by the build attempt whose work it reviewed: in the group its group reviews (reviewOf), the latest
 *  attempt started by the review's start, else that group's first, as shipping() picks the shipping attempt. A review of
 *  a group the reader cannot read is charged to nobody. */
function reviewsByBuild(rows: CostRow[], groups: Conversation[]): Map<string, CostRow[]> {
  const reviewed = new Map(groups.filter(g => g.reviewOf).map(g => [g.id, g.reviewOf!]))
  const byGroup = new Map<string, CostRow[]>()
  for (const row of rows) byGroup.set(row.conversationId, [...byGroup.get(row.conversationId) ?? [], row])
  const charged = new Map<string, CostRow[]>()
  for (const review of rows) {
    const of = reviewed.get(review.conversationId)
    const builds = of ? [...byGroup.get(of) ?? []].sort((a, b) => a.run.startedAt - b.run.startedAt) : []
    if (!builds.length) continue
    const build = builds.filter(b => b.run.startedAt <= review.run.startedAt).at(-1) ?? builds[0]!
    charged.set(build.assignmentId, [...charged.get(build.assignmentId) ?? [], review])
  }
  return charged
}

/** [group]'s full cost (FullCost): its own ended attempts and the reviews charged to them, an unknown cost filled with the
 *  mean known cost of its own choice ([means], by [keyOf]). */
function fullCost(group: CostRow[], shipped: number, reviews: Map<string, CostRow[]>, means: Map<string, number>, keyOf: (row: CostRow) => string): FullCost {
  const charged = group.flatMap(row => reviews.get(row.assignmentId) ?? [])
  // Open attempts are still going: their cost is neither known nor unknown yet.
  const ended = [...group, ...charged].filter(row => row.outcome !== null)
  let total = 0, known = 0, unfilled = false
  for (const row of ended) {
    const cost = attemptCost(row.run, row.fresh).apiCost
    if (cost !== null) { known++; total += cost; continue }
    const mean = means.get(keyOf(row))
    if (mean === undefined) unfilled = true
    else total += mean
  }
  const share = ended.length ? known / ended.length : null
  return { reviewAttempts: charged.length, fullCostKnown: share,
    fullCostPerShipped: shipped && share !== null && share >= MIN_KNOWN_SHARE && !unfilled ? total / shipped : null }
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
  const reviews = reviewsByBuild(rows, groups), key = (row: CostRow) => JSON.stringify(keyOf(row))
  const sums = new Map<string, { cost: number; n: number }>()
  for (const row of rows) {
    const cost = attemptCost(row.run, row.fresh).apiCost
    if (cost === null) continue
    const sum = sums.get(key(row)) ?? { cost: 0, n: 0 }
    sums.set(key(row), { cost: sum.cost + cost, n: sum.n + 1 })
  }
  const means = new Map([...sums].map(([k, s]) => [k, s.cost / s.n]))
  const summary = grouped(keyOf).map(([[engine, model, effort, kind], group]) => {
    const summed = summarize(group, firstReview, shippedAt, prices)
    return { engine, model, effort, kind, ...summed, ...fullCost(group, summed.shipped, reviews, means, key) }
  })
  const models = grouped(row => [row.run.engine, row.run.grid ?? row.run.model] as const)
    .map(([[engine, model], group]) => ({ engine, model, ...summarize(group, firstReview, shippedAt, new Set()) }))
  return { rows: summary, models, totals: summarize(rows, firstReview, shippedAt, new Set()),
    prices: [...prices].sort().map(model => { const p = priceOf(model)!; return { model: p.model, source: p.source, checked: p.checked } }) }
}

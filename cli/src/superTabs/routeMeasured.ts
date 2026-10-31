/** Routing by what choices actually cost and how they did (Scholes's goals, piece 3, 2026-10-31): a routing plug-in (route.ts
 * RoutePlugin) that moves a candidate within its strength by its choice's measured results for the task's kind of work, over
 * the project's last 7 days (backend superTabs/costs/read.ts, the same read as `harness super-tab costs`, which counts only
 * the groups the routing agent may read and refuses a Buddy).
 *
 * - Cost: the full cost per shipped change, every ended attempt of the choice (failed and lost ones too) and every review of
 *   its work, rework rounds included. A choice's own attempts alone made one that passes 6 of 10 first reviews look cheaper
 *   than one that passes 9 of 10, its extra review rounds left out (Lead, 2026-10-31). The measured choices of the kind are
 *   ranked by it on the catalog's cost scale, so they keep their place against unmeasured ones on average.
 * - Results: a first-review pass rate clearly under another measured choice's (their 95% ranges apart) ranks the choice after
 *   its strength's other choices, never below a weaker strength. With 5 to 10 reviews the ranges nearly always overlap, so
 *   cost decides.
 * - Only with enough of it: at least MIN_SHIPPED shipped changes for cost and MIN_FIRST_REVIEWS first reviews for the pass
 *   rate (the nightly reflection's own thresholds, costs/reflection.ts); otherwise today's ranking.
 * It never adds or refuses a candidate: what may run is the route's, and only its order changes. The kind is the word the
 * routing agent gives in its assessment (`kind`); none, or one nothing was measured for, ranks as today. */
import { claudeAliasForModel } from '../engines/claude/runtimeProfile.js'
import { catalogRow, type Catalog, type Probe, type RoutePlugin } from './route.js'
import type { ScopedRequest } from './start.js'
import { within } from './wire.js'

export const MEASURED = 'measured results'
export const DAYS = 7
export const MIN_FIRST_REVIEWS = 5
export const MIN_SHIPPED = 3
/** How far a clearly worse pass rate moves a candidate: after its strength's other choices, before the next strength's. */
const WORSE = -0.5
const Z = 1.96

/** One choice's results for one kind of work, as the costs read gives them (backend costs/read.ts CostSummaryRow, FullCost). */
export interface MeasuredRow { engine: string; model: string; effort: string; kind: string; firstReviews: number; firstReviewPassed: number
  shipped: number; costPerShipped: number | null; fullCostPerShipped: number | null }
/** `truncated`: the read reached its row limit, so it holds only the newest attempts. */
export interface Measured { rows: MeasuredRow[]; truncated: boolean }

const ENGINE: Record<string, string> = { claude: 'Claude', codex: 'Codex' }
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0
const money = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

/** The rows of a costs answer it can rank by, or null when the answer is no summary. A row it cannot read is dropped; a
 *  backend before full costs sends none, read as unknown. */
export function measuredFrom(answer: unknown): Measured | null {
  const reply = object(answer), value = object(reply.value)
  if (reply.ok !== true || !Array.isArray(value.rows)) return null
  const rows = value.rows.map(object).flatMap((r): MeasuredRow[] => {
    const full = r.fullCostPerShipped ?? null, own = r.costPerShipped ?? null
    if (![r.engine, r.model, r.effort, r.kind].every(s => typeof s === 'string') || !count(r.firstReviews) || !count(r.firstReviewPassed)
      || r.firstReviewPassed > r.firstReviews || !count(r.shipped) || !(full === null || money(full)) || !(own === null || money(own))) return []
    return [{ engine: r.engine as string, model: r.model as string, effort: r.effort as string, kind: r.kind as string, firstReviews: r.firstReviews,
      firstReviewPassed: r.firstReviewPassed, shipped: r.shipped, costPerShipped: own, fullCostPerShipped: full }]
  })
  return { rows, truncated: value.truncated === true }
}

/** The project's measures, read through the route's own backend request: null when refused, failed, slower than [ms] or
 *  unreadable, so the route ranks as today. The route runs about 30 times an hour; the read is the costs command's, about
 *  0.1 to 0.3 s beyond a plain request on the openharness Swarm (2026-10-31). */
export async function readMeasured(request: ScopedRequest, ms = 3000): Promise<Measured | null> {
  const answer = await within(request({ action: 'costs', days: DAYS }).catch(() => null), ms)
  return answer ? measuredFrom(answer) : null
}

/** The 95% Wilson range of `passed` of `n` (backend costs/reflection.ts wilson): honest about small samples. */
function wilson(passed: number, n: number): { low: number; high: number } {
  const p = passed / n, z2 = Z * Z
  const centre = p + z2 / (2 * n), spread = Z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)), scale = 1 + z2 / n
  return { low: Math.max(0, (centre - spread) / scale), high: Math.min(1, (centre + spread) / scale) }
}

/** The name a candidate's runs are kept under: a grid model's own, a Claude family for Claude's full ids. */
function ranAs(p: Pick<Probe, 'engine' | 'model' | 'gridModel'>): string {
  if (p.gridModel) return p.gridModel
  return p.engine === 'claude' ? claudeAliasForModel(p.model.replace(/\[1m\]$/i, '')) ?? p.model : p.model
}
const nameOf = (r: MeasuredRow) => `${ENGINE[r.engine] ?? r.engine} ${r.model} ${r.effort}`
const costed = (r: MeasuredRow) => r.shipped >= MIN_SHIPPED && r.fullCostPerShipped !== null
const reviewed = (r: MeasuredRow) => r.firstReviews >= MIN_FIRST_REVIEWS

/** The plug-in over [measured]: pure, so the route ranks every candidate with the same numbers. */
export function measuredPlugin(measured: Measured): RoutePlugin {
  /** Per kind: its rows, and the measured costs' scale on the catalog's: dollars per cost point, so the measured choices keep
   *  their mean place against unmeasured ones. Null when fewer than two choices have a cost to compare. */
  const byKind = new Map<string, { rows: MeasuredRow[]; scale: number | null }>()
  const scaleOf = (rows: MeasuredRow[], catalog: Catalog) => {
    // A row the catalog does not rate (a grid or unrated model) counts at cost 1, as its candidate does (route.ts localProbes).
    // A run whose model or effort was never known is no choice anyone can pick.
    const scaled = rows.filter(r => costed(r) && r.model !== 'unknown' && r.effort !== 'unknown')
    const points = scaled.reduce((sum, r) => sum + (catalogRow(catalog, r.engine, r.model, r.effort)?.cost ?? 1), 0)
    const dollars = scaled.reduce((sum, r) => sum + r.fullCostPerShipped!, 0)
    // All free (own hardware): nothing to tell them apart by.
    return scaled.length >= 2 && dollars > 0 ? dollars / points : null
  }
  return {
    name: MEASURED,
    adjust(candidate, { assessment, catalog }) {
      const kind = assessment.kind
      if (!kind) return null
      let ofKind = byKind.get(kind)
      if (!ofKind) {
        const rows = measured.rows.filter(r => r.kind === kind)
        ofKind = { rows, scale: scaleOf(rows, catalog) }
        byKind.set(kind, ofKind)
      }
      const name = ranAs(candidate)
      const mine = ofKind.rows.find(r => r.engine === candidate.engine && r.model === name && r.effort === candidate.effort)
      if (!mine) return null
      // Clearly fewer passes than the best other measured choice: the top of its range under the bottom of that one's.
      const range = reviewed(mine) ? wilson(mine.firstReviewPassed, mine.firstReviews) : null
      const best = range ? ofKind.rows.filter(r => r !== mine && reviewed(r))
        .map(r => ({ r, low: wilson(r.firstReviewPassed, r.firstReviews).low })).sort((x, y) => y.low - x.low)[0] : undefined
      const worse = !!range && !!best && range.high < best.low
      if (!costed(mine) && !worse) return null
      const pass = !reviewed(mine) ? `first reviews too few to compare (${mine.firstReviews})`
        : `${mine.firstReviewPassed} of ${mine.firstReviews} first reviews passed${worse
          ? `, clearly fewer than ${nameOf(best!.r)}'s ${best!.r.firstReviewPassed} of ${best!.r.firstReviews}, so it ranks after its strength's other choices` : ''}`
      let cost: string, shift = 0
      if (!costed(mine)) cost = `too few shipped changes with known costs to compare cost (${mine.shipped} shipped)`
      else {
        const full = `$${mine.fullCostPerShipped!.toFixed(2)} per shipped change over ${mine.shipped} (failed attempts and every review round included)`
        if (ofKind.scale === null) cost = `${full}; no other choice for ${kind} work has a cost to compare, so its place is unchanged`
        else {
          const points = mine.fullCostPerShipped! / ofKind.scale
          shift = points - candidate.cost
          cost = `${full}; ranked as cost ${points.toFixed(1)} instead of ${candidate.cost}`
        }
      }
      return { reason: `${kind} work, last ${DAYS} days: ${pass}, ${cost}${measured.truncated ? '; only the newest attempts were read' : ''}`,
        ...(shift ? { cost: shift } : {}), ...(worse ? { strength: WORSE } : {}) }
    },
  }
}

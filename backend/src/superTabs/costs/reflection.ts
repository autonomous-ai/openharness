/** Nightly routing proposals for owner Decisions, never a project-chat report. Counts only: engines, models, efforts and
 * kinds of work, never task titles, messages or IDs. A Yes has the coordinator write the fixed routingLine into the
 * instructions; proposals whose lines are already there or whose owners answered lately are not asked again. */
import { stableId, type Conversation } from '../model.js'
import { attemptCost } from './cost.js'
import { summarizeCosts, type CostRow, type CostSummaryRow } from './read.js'

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE
/** At most this many proposals a night (brief). */
export const MAX_PROPOSALS = 3
/** A cheaper model is proposed only with this much evidence on each side: fewer first reviews or shipped changes say too
 *  little (review of #2276: 3 and 2 gave confident proposals from a handful of tasks). */
const MIN_FIRST_REVIEWS = 5
const MIN_SHIPPED = 3
/** A model is proposed to stop taking a kind of work only when even the top of its pass rate's 95% range is under this. */
const LOW_PASS_RATE = 0.5
/** Tasks of a kind that must have stepped up from the grid before the grid is proposed to stop taking it. */
const MIN_GRID_STEP_UPS = 3
/** Yes is recommended only on this many first reviews (grid tasks for the grid) on every side; on fewer, "Not yet". */
export const STRONG_SAMPLE = 10
/** 95%. */
const Z = 1.96

/** The Wilson score interval of `passed` of `n` at 95%: where the true rate likely is, honest about small samples. */
export function wilson(passed: number, n: number): { low: number; high: number } {
  if (!n) return { low: 0, high: 1 }
  const p = passed / n, z2 = Z * Z
  const centre = p + z2 / (2 * n), spread = Z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)), scale = 1 + z2 / n
  return { low: Math.max(0, (centre - spread) / scale), high: Math.min(1, (centre + spread) / scale) }
}

/** A start that failed (routeDecisions.ts closeUnassignedStart), on what it was to run, and when it was routed. */
export interface FailedStart { engine: string; model: string; effort: string; at: number }

export interface ReflectionInput {
  now: number
  /** The project's attempts routed in the last 7 days. */
  rows: CostRow[]
  /** Their groups, for their ledgers' first reviews and ships. */
  groups: Conversation[]
  /** The project's failed starts in the last 7 days. */
  failedStarts: FailedStart[]
  /** Titles of proposals the owner answered in the last REASK_DAYS days: not proposed again until then. */
  decided?: readonly string[]
  /** The project's instructions as they read now (the built-in template for a project without a document yet): a proposal
   *  whose routing line (routingLine) is in them is not proposed. */
  document: string
}

type RanOn = Pick<CostSummaryRow, 'engine' | 'model' | 'effort'>
/** What a proposal changes: its routing line says it (routingLine). */
export type Change = { kind: 'cheaper'; taskKind: string; from: RanOn; to: RanOn } | { kind: 'stop'; taskKind: string; from: RanOn }
  | { kind: 'grid'; taskKind: string }
/** A routing change for the owner: what, why, what it would save a week in dollars (API-equivalent) and hours to ship,
 *  and whether its evidence is strong enough to recommend Yes. */
export interface Proposal { title: string; why: string; saving: string; dollars: number; hours: number; strong: boolean; change: Change }
export interface Reflection { proposals: Proposal[] }
/** Days an answered proposal is not proposed again. */
export const REASK_DAYS = 14
/** The zone of a project that set no digest: the owner's time zone is stored nowhere; the digest's is the one a project sets. */
export const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh'
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const usd = (n: number) => `$${n.toFixed(2)}`
const percent = (rate: number) => `${Math.round(rate * 100)}%`
const cents = (n: number) => Math.round(n * 100) / 100
const tenths = (n: number) => Math.round(n * 10) / 10
const ranOn = (r: RanOn) => `${r.engine} ${r.model} ${r.effort}`
const capital = (text: string) => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`
const cut = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`

/** The one fixed Routing line a proposal carries: what a Yes has the coordinator write into the instructions, and what the
 *  reflection looks for there. */
export function routingLine(p: Pick<Proposal, 'change'>): string {
  const c = p.change, kind = capital(c.taskKind)
  return c.kind === 'cheaper' ? `${kind} work runs on ${ranOn(c.to)} instead of ${ranOn(c.from)}.`
    : c.kind === 'stop' ? `${kind} work no longer runs on ${ranOn(c.from)}.`
    : `${kind} work starts on a subscription model, not on the grid.`
}
const passed = (r: CostSummaryRow) => `${r.firstReviewPassed} of ${r.firstReviews} (${percent(r.firstReviewPassRate!)})`
const atApi = 'a week at API prices'

/** Per kind, the tasks whose grid attempt failed and stepped up: how many, and the grid attempts' hours and cost. Also how
 *  many tasks of the kind started on the grid. A step up is the attempt that carries it (decisions from before project instructions); the grid attempts
 *  before it in its task are what it replaced. */
function gridStepUps(rows: CostRow[], now: number) {
  const byGroup = new Map<string, CostRow[]>()
  for (const r of rows) byGroup.set(r.conversationId, [...byGroup.get(r.conversationId) ?? [], r])
  const kinds = new Map<string, { tasks: number; stepped: number; hours: number; dollars: number }>()
  for (const attempts of byGroup.values()) {
    attempts.sort((a, b) => a.run.startedAt - b.run.startedAt)
    const onGrid = attempts.filter(r => r.run.grid)
    if (!onGrid.length) continue
    const kind = onGrid[0]!.kind ?? 'unspecified'
    const k = kinds.get(kind) ?? { tasks: 0, stepped: 0, hours: 0, dollars: 0 }
    k.tasks++
    const step = attempts.find(r => r.stepUp && r.run.startedAt >= onGrid[0]!.run.startedAt)
    if (step) {
      k.stepped++
      for (const r of onGrid.filter(g => g.run.startedAt <= step.run.startedAt)) {
        k.hours += ((r.run.endedAt ?? now) - r.run.startedAt) / (60 * MINUTE)
        k.dollars += attemptCost(r.run, r.fresh).apiCost ?? 0
      }
    }
    kinds.set(kind, k)
  }
  return kinds
}

function proposals(rows: CostSummaryRow[], grid: ReturnType<typeof gridStepUps>): Proposal[] {
  const found: Proposal[] = []
  const known = rows.filter(r => r.kind !== 'unspecified')
  // A cheaper model on the same kind whose first review passes at least as often.
  const priced = known.filter(r => r.firstReviews >= MIN_FIRST_REVIEWS && r.shipped >= MIN_SHIPPED && r.costPerShipped !== null)
  const moved = new Set<CostSummaryRow>()
  for (const kind of new Set(priced.map(r => r.kind))) {
    let best: { dear: CostSummaryRow; cheap: CostSummaryRow; dollars: number } | null = null
    for (const dear of priced.filter(r => r.kind === kind)) {
      for (const cheap of priced.filter(r => r.kind === kind && r !== dear)) {
        if (cheap.costPerShipped! >= dear.costPerShipped! || cheap.firstReviewPassRate! < dear.firstReviewPassRate!) continue
        const dollars = cents((dear.costPerShipped! - cheap.costPerShipped!) * dear.shipped)
        if (!best || dollars > best.dollars) best = { dear, cheap, dollars }
      }
    }
    if (!best) continue
    const { dear, cheap, dollars } = best
    const strong = Math.min(dear.firstReviews, cheap.firstReviews) >= STRONG_SAMPLE
    moved.add(dear)
    found.push({ title: `Route ${kind} work to ${ranOn(cheap)} instead of ${ranOn(dear)}`,
      why: `Its first review passed ${passed(cheap)} against ${passed(dear)}, at ${usd(cheap.costPerShipped!)} instead of `
        + `${usd(dear.costPerShipped!)} per shipped change at API prices.`
        + (strong ? '' : ` Small samples (${dear.firstReviews} and ${cheap.firstReviews} first reviews): the difference may be chance.`),
      saving: `about ${usd(dollars)} ${atApi}`, dollars, hours: 0, strong,
      change: { kind: 'cheaper', taskKind: kind, from: pick(dear), to: pick(cheap) } })
  }
  // A model whose first review clearly fails more often than it passes on a kind of work: even the top of its range is low.
  for (const r of known) {
    if (moved.has(r) || r.firstReviews < MIN_FIRST_REVIEWS || wilson(r.firstReviewPassed, r.firstReviews).high >= LOW_PASS_RATE) continue
    const failed = r.firstReviews - r.firstReviewPassed, strong = r.firstReviews >= STRONG_SAMPLE
    const dollars = r.apiCost !== null && r.costKnown ? cents(r.apiCost / r.costKnown * failed) : 0
    found.push({ title: `Stop routing ${r.kind} work to ${ranOn(r)}`,
      why: `Its first review passed ${passed(r)}; even the top of its 95% range is ${percent(wilson(r.firstReviewPassed, r.firstReviews).high)}.`
        + (strong ? '' : ` Only ${r.firstReviews} first reviews.`),
      saving: dollars ? `about ${usd(dollars)} ${atApi} of attempts that failed their first review`
        : `${plural(failed, 'attempt')} a week that failed their first review`, dollars, hours: 0, strong,
      change: { kind: 'stop', taskKind: r.kind, from: pick(r) } })
  }
  // A kind whose tasks keep stepping up from the grid.
  for (const [kind, k] of grid) {
    if (kind === 'unspecified' || k.stepped < MIN_GRID_STEP_UPS || k.stepped * 2 < k.tasks) continue
    const hours = tenths(k.hours), dollars = cents(k.dollars), strong = k.tasks >= STRONG_SAMPLE
    found.push({ title: `Start ${kind} work on a subscription model instead of the grid`,
      why: `${k.stepped} of ${k.tasks} ${kind} tasks needed another model after their grid attempt failed.`
        + (strong ? '' : ` Only ${k.tasks} tasks.`),
      saving: `about ${dollars ? `${usd(dollars)} at API prices and ` : ''}${hours} hours to ship a week`, dollars, hours, strong,
      change: { kind: 'grid', taskKind: kind } })
  }
  return found.sort((a, b) => b.dollars - a.dollars || b.hours - a.hours)
}

const pick = (r: RanOn): RanOn => ({ engine: r.engine, model: r.model, effort: r.effort })

/** At most MAX_PROPOSALS, the largest saving first, excluding recent answers and lines already in the instructions.
 * Null when the last day had no attempt or failed start. */
export function routingReflection(input: ReflectionInput): Reflection | null {
  const since = input.now - DAY
  const dayRows = input.rows.filter(r => r.run.startedAt >= since)
  if (!dayRows.length && !input.failedStarts.some(f => f.at >= since)) return null
  const week = summarizeCosts(input.rows, input.groups)
  const grid = gridStepUps(input.rows, input.now)
  const decided = new Set(input.decided ?? [])
  const all = proposals(week.rows, grid)
  return { proposals: all.filter(p => !input.document.includes(routingLine(p)) && !decided.has(p.title)).slice(0, MAX_PROPOSALS) }
}

/** Stable nightly Decision operation ID; also recognizes report rows posted before reports stopped. */
export const reflectionMessageId = (tabId: string, projectId: string, on: string): string => stableId('routing-reflection', tabId, projectId, on)

/** The answer that approves a proposal. */
export const APPROVE = 0
/** What an asked proposal's unblocks says before its routing line. */
const YES_WRITES = 'If you say yes, the coordinator writes into Routing, naming you as who asked: '
/** A proposal asked of the project owner as a decision. The question starts with the proposal's title, so a proposal waiting
 *  for an answer or answered lately is told by it (proposalTitle). It says plainly what Yes does: the coordinator writes the
 *  proposal's line into the Routing section of the instructions, naming the owner as who asked (project instructions, phase 4,
 *  decision 21; the template's PM section says so). */
export const proposalQuestion = (p: Proposal) => ({ question: `${p.title}?\nWhy: ${p.why} This could save ${p.saving}.`,
  options: ['Yes: the coordinator writes this into the Routing section of the instructions', 'No: keep routing as it is',
    'Not yet: ask again when there is more evidence'],
  recommended: p.strong ? APPROVE : 2,
  // A decision's unblocks is at most 300 characters (decisions.ts decisionChoices); only a model slug that long cuts the line.
  unblocks: cut(`${YES_WRITES}${routingLine(p)}`, 300) })
/** The proposal a decision asked, by the title its question starts with. */
export const proposalTitle = (question: string): string => question.slice(0, Math.max(0, question.indexOf('?')))

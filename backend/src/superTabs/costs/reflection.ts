/**
 * The nightly routing reflection (Scholes's roadmap, piece 2, 2026-10-30): what one project's routed work cost and how it went
 * in the last day and the last 7 days, the waste, and at most three routing changes for its owner to approve, each with its
 * expected saving. Pure: lib/routingReflection.ts reads the attempts (costs/read.ts costRows), failed starts and evidence, and
 * posts the text. Counts only: engines, models, efforts and kinds of work, never a task's title, a message or an id.
 * Nothing here changes routing; a proposal is a question for the owner.
 */
import { stableId, type Conversation } from '../model.js'
import type { ModelKindEvidence } from '../evidence/store.js'
import { attemptCost } from './cost.js'
import { MAX_ROWS, summarizeCosts, type CostRow, type CostSummaryRow } from './read.js'

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE
/** At most this many proposals a night (brief). */
export const MAX_PROPOSALS = 3
/** Rows of the per-model table the report lists; the rest are counted. */
const MAX_LINES = 12
/** A proposal needs this much evidence on each side: fewer first reviews or shipped changes say too little. */
const MIN_FIRST_REVIEWS = 3
const MIN_SHIPPED = 2
/** A model under this first-review pass rate on a kind of work is proposed to stop taking it. */
const LOW_PASS_RATE = 0.5
/** Tasks of a kind that must have stepped up from the grid before the grid is proposed to stop taking it. */
const MIN_GRID_STEP_UPS = 2

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
  /** The project's evidence since the week holding 7 days ago: rework rounds and fixes after merge. */
  evidence: ModelKindEvidence[]
  /** More attempts than one read takes: only the newest were read. */
  truncated: boolean
}

/** A routing change for the owner: what, why, and what it would save a week in dollars (API-equivalent) and hours to ship. */
export interface Proposal { title: string; why: string; saving: string; dollars: number; hours: number }
export interface Reflection { text: string; proposals: Proposal[] }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const usd = (n: number) => `$${n.toFixed(2)}`
const percent = (rate: number) => `${Math.round(rate * 100)}%`
const cents = (n: number) => Math.round(n * 100) / 100
const tenths = (n: number) => Math.round(n * 10) / 10
const ranOn = (r: Pick<CostSummaryRow, 'engine' | 'model' | 'effort'>) => `${r.engine} ${r.model} ${r.effort}`

function line(r: CostSummaryRow): string {
  return `- ${ranOn(r)}, ${r.kind}: ${plural(r.attempts, 'attempt')}, ${r.shipped} shipped`
    + (r.costPerShipped !== null ? `, ${usd(r.costPerShipped)} per shipped change` : '')
    + (r.firstReviews ? `, first review passed ${r.firstReviewPassed} of ${r.firstReviews} (${percent(r.firstReviewPassRate!)})` : ', no first review')
    + (r.stepUps ? `, ${plural(r.stepUps, 'step-up')}` : '')
}

/** Per kind, the tasks whose grid attempt failed and stepped up: how many, and the grid attempts' hours and cost. Also how
 *  many tasks of the kind started on the grid. A step up is the attempt that carries it (stepUp.ts); the grid attempts
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
    moved.add(dear)
    found.push({ title: `Route ${kind} work to ${ranOn(cheap)} instead of ${ranOn(dear)}`,
      why: `Its first review passes ${cheap.firstReviewPassRate! > dear.firstReviewPassRate! ? 'more' : 'as'} often (${percent(cheap.firstReviewPassRate!)} against `
        + `${percent(dear.firstReviewPassRate!)}) at ${usd(cheap.costPerShipped!)} instead of ${usd(dear.costPerShipped!)} per shipped change.`,
      saving: `about ${usd(dollars)} a week`, dollars, hours: 0 })
  }
  // A model whose first review fails more often than it passes on a kind of work.
  for (const r of known) {
    if (moved.has(r) || r.firstReviews < MIN_FIRST_REVIEWS || r.firstReviewPassRate! >= LOW_PASS_RATE) continue
    const failed = r.firstReviews - r.firstReviewPassed
    const dollars = r.apiCost !== null && r.costKnown ? cents(r.apiCost / r.costKnown * failed) : 0
    found.push({ title: `Stop routing ${r.kind} work to ${ranOn(r)}`,
      why: `Its first review passed ${r.firstReviewPassed} of ${r.firstReviews} (${percent(r.firstReviewPassRate!)}).`,
      saving: dollars ? `about ${usd(dollars)} a week of attempts that failed their first review`
        : `${plural(failed, 'attempt')} a week that failed their first review`, dollars, hours: 0 })
  }
  // A kind whose tasks keep stepping up from the grid.
  for (const [kind, k] of grid) {
    if (kind === 'unspecified' || k.stepped < MIN_GRID_STEP_UPS || k.stepped * 2 < k.tasks) continue
    const hours = tenths(k.hours), dollars = cents(k.dollars)
    found.push({ title: `Start ${kind} work on a subscription model instead of the grid`,
      why: `${k.stepped} of ${k.tasks} ${kind} tasks started on the grid stepped up after their grid attempt failed.`,
      saving: `about ${dollars ? `${usd(dollars)} and ` : ''}${hours} hours to ship a week`, dollars, hours })
  }
  return found.sort((a, b) => b.dollars - a.dollars || b.hours - a.hours).slice(0, MAX_PROPOSALS)
}

function waste(input: ReflectionInput, grid: ReturnType<typeof gridStepUps>, stepUps: number): string {
  const failed = new Map<string, number>()
  for (const f of input.failedStarts) failed.set(ranOn(f), (failed.get(ranOn(f)) ?? 0) + 1)
  const stepped = [...grid].filter(([, k]) => k.stepped)
  const fromGrid = stepped.reduce((n, [, k]) => n + k.stepped, 0)
  const rework = input.evidence.reduce((n, m) => n + m.reworkRounds, 0), fixes = input.evidence.reduce((n, m) => n + m.fixesAfterMerge, 0)
  const parts = [
    ...input.failedStarts.length ? [`${plural(input.failedStarts.length, 'failed start')} (${[...failed].sort((a, b) => b[1] - a[1])
      .map(([on, n]) => `${on}: ${n}`).join(', ')})`] : [],
    ...fromGrid ? [`${plural(fromGrid, 'step-up')} after a failed grid attempt (${stepped.map(([kind, k]) => `${kind}: ${k.stepped}, ${tenths(k.hours)} hours`).join('; ')})`] : [],
    ...stepUps > fromGrid ? [`${plural(stepUps - fromGrid, 'other step-up')}`] : [],
    ...rework ? [plural(rework, 'rework round')] : [],
    ...fixes ? [plural(fixes, 'fix after merge', 'fixes after merge')] : [],
  ]
  return `Waste in the last 7 days: ${parts.length ? parts.join(', ') : 'none'}.`
}

/** The night's report, or null when the last day had no attempt and no failed start: then nothing is posted. */
export function routingReflection(input: ReflectionInput): Reflection | null {
  const since = input.now - DAY
  const dayRows = input.rows.filter(r => r.run.startedAt >= since)
  if (!dayRows.length && !input.failedStarts.some(f => f.at >= since)) return null
  const week = summarizeCosts(input.rows, input.groups), day = summarizeCosts(dayRows, input.groups)
  const grid = gridStepUps(input.rows, input.now)
  const proposed = proposals(week.rows, grid)
  const table = [...week.rows].sort((a, b) => b.attempts - a.attempts)
  const text = [
    'Routing reflection: what routed work cost and how it went. Counts only; nothing changes until the project owner approves.',
    `Last day: ${plural(day.totals.attempts, 'attempt')}, ${day.totals.shipped} shipped. Last 7 days: ${plural(week.totals.attempts, 'attempt')}, ${week.totals.shipped} shipped.`,
    'By engine, model and effort, per kind of work (last 7 days; cost is what the tokens would cost on the API):',
    ...table.slice(0, MAX_LINES).map(line),
    ...table.length > MAX_LINES ? [`- and ${table.length - MAX_LINES} more`] : [],
    waste(input, grid, week.totals.stepUps),
    ...proposed.length ? ['Proposed changes, each asked of the project owner as a decision:',
      ...proposed.map((p, i) => `${i + 1}. ${p.title}: ${p.saving}. ${p.why}`)] : ['No change proposed.'],
    ...input.truncated ? [`Only the newest ${MAX_ROWS} attempts were read.`] : [],
  ].join('\n')
  return { text, proposals: proposed }
}

/** The id of a project's report for one local date: one a night, so a second pass or a second worker writes none. */
export const reflectionMessageId = (tabId: string, projectId: string, on: string): string => stableId('routing-reflection', tabId, projectId, on)

/** A proposal asked of the project owner as a decision. The question starts with the proposal's title, so a proposal still
 *  waiting for an answer is not asked again on a later night (reflectionAsked). */
export const proposalQuestion = (p: Proposal) => ({ question: `${p.title}? Expected saving: ${p.saving}. ${p.why}`,
  options: ['Yes, change routing this way', 'No, keep routing as it is'], recommended: 0,
  unblocks: 'The Lead changes the routing rule only once you approve it; nothing changes by itself.' })
export const reflectionAsked = (p: Proposal, openQuestions: readonly string[]): boolean => openQuestions.some(q => q.startsWith(`${p.title}?`))

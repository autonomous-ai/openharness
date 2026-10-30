/**
 * The nightly routing reflection (Scholes's roadmap, piece 2, 2026-10-30): what one project's routed work cost and how it went
 * in the last day and the last 7 days, the waste, and at most three routing changes for its owner to approve, each with its
 * expected saving. Pure: lib/routingReflection.ts reads the attempts (costs/read.ts costRows), failed starts and evidence, and
 * posts the text. Counts only: engines, models, efforts and kinds of work, never a task's title, a message or an id.
 * Nothing here changes routing: a proposal is advice asked of the owner, and an approved one is listed every night until
 * routing applies it by itself (piece 3). No rule kind can express a change per kind of work (rules.ts).
 */
import { stableId, type Conversation } from '../model.js'
import { modelMatches, type SwarmRule } from '../rules.js'
import type { ModelKindEvidence } from '../evidence/store.js'
import { attemptCost } from './cost.js'
import { MAX_ROWS, summarizeCosts, type CostRow, type CostSummaryRow } from './read.js'

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE
/** At most this many proposals a night (brief). */
export const MAX_PROPOSALS = 3
/** Rows of the per-model table the report lists; the rest are counted. */
const MAX_LINES = 12
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
  /** The project's evidence since the week holding 7 days ago: rework rounds and fixes after merge. */
  evidence: ModelKindEvidence[]
  /** More attempts than one read takes: only the newest were read. */
  truncated: boolean
  /** Titles of proposals the owner answered in the last REASK_DAYS days: not proposed again until then. */
  decided?: readonly string[]
  /** Proposals approved in the last APPROVED_DAYS days, with the local date and who decided: the owner, or the PM when the
   *  owner left it to the PM. Listed every night, and not proposed again while listed. */
  approved?: readonly Approved[]
  /** The project's routing rules: a change one already makes is not proposed. */
  rules?: ReadonlyArray<SwarmRule['rule']>
}

type RanOn = Pick<CostSummaryRow, 'engine' | 'model' | 'effort'>
/** What a proposal changes, for telling whether a rule already does. */
export type Change = { kind: 'cheaper'; taskKind: string; from: RanOn; to: RanOn } | { kind: 'stop'; taskKind: string; from: RanOn }
  | { kind: 'grid'; taskKind: string }
/** A routing change for the owner: what, why, what it would save a week in dollars (API-equivalent) and hours to ship, and
 *  whether its evidence is strong enough to recommend Yes. */
export interface Proposal { title: string; why: string; saving: string; dollars: number; hours: number; strong: boolean; change: Change }
export interface Reflection {
  /** The report with no note on its proposals. */
  text: string
  proposals: Proposal[]
  /** The report with a note after each proposal: whether it was asked, and if not, why (store.ts postReflection). */
  render(note: (p: Proposal) => string | null): string
}
/** Days an answered proposal is not proposed again. */
export const REASK_DAYS = 14
/** Days an approved proposal is listed and reminded each night; after that it may be proposed again (Lead's ruling). */
export const APPROVED_DAYS = 30
export interface Approved { title: string; on: string; by: 'owner' | 'pm' }
/** The zone of a project that set no digest: the owner's time zone is stored nowhere; the digest's is the one a project sets. */
export const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh'
/** The local date of [at] in [timeZone], or in the default zone for none or one this runtime does not know. */
export function localDate(at: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const format = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  try { return format(timeZone) } catch { return format(DEFAULT_TIME_ZONE) }
}
const decidedBy = (a: Approved) => `${a.by === 'pm' ? 'PM decided' : 'approved'} ${a.on}`
/** The Lead's nightly reminder of what was approved: it routes this way until routing does it by itself. */
export const approvedReminder = (approved: readonly Approved[]): string =>
  ['Approved routing changes: route this way until routing does it by itself. This reminder repeats each night for 30 days after each approval.',
    ...approved.map(a => `- ${a.title} (${decidedBy(a)})`)].join('\n')

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const usd = (n: number) => `$${n.toFixed(2)}`
const percent = (rate: number) => `${Math.round(rate * 100)}%`
const cents = (n: number) => Math.round(n * 100) / 100
const tenths = (n: number) => Math.round(n * 10) / 10
const ranOn = (r: RanOn) => `${r.engine} ${r.model} ${r.effort}`
const passed = (r: CostSummaryRow) => `${r.firstReviewPassed} of ${r.firstReviews} (${percent(r.firstReviewPassRate!)})`
const atApi = 'a week at API prices'

function line(r: CostSummaryRow): string {
  return `- ${ranOn(r)}, ${r.kind}: ${plural(r.attempts, 'attempt')}, ${r.shipped} shipped`
    + (r.medianMinutesToShip !== null ? `, median ${Math.round(r.medianMinutesToShip)} min to ship` : '')
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
      why: `${k.stepped} of ${k.tasks} ${kind} tasks started on the grid stepped up after their grid attempt failed.`
        + (strong ? '' : ` Only ${k.tasks} tasks.`),
      saving: `about ${dollars ? `${usd(dollars)} at API prices and ` : ''}${hours} hours to ship a week`, dollars, hours, strong,
      change: { kind: 'grid', taskKind: kind } })
  }
  return found.sort((a, b) => b.dollars - a.dollars || b.hours - a.hours)
}

const pick = (r: RanOn): RanOn => ({ engine: r.engine, model: r.model, effort: r.effort })

/** Whether one of the project's rules already makes this change: a forbidden model it moves work away from, or no grid first. */
function ruled(change: Change, rules: ReadonlyArray<SwarmRule['rule']>): boolean {
  return rules.some(rule => change.kind === 'grid' ? rule.kind === 'noGridFirst'
    : rule.kind === 'forbidModel' && (!rule.engine || rule.engine === change.from.engine) && modelMatches(rule.model, change.from.model))
}

function waste(input: ReflectionInput, grid: ReturnType<typeof gridStepUps>, stepUps: number): string {
  const failed = new Map<string, number>()
  for (const f of input.failedStarts) failed.set(ranOn(f), (failed.get(ranOn(f)) ?? 0) + 1)
  const stepped = [...grid].filter(([, k]) => k.stepped)
  const fromGrid = stepped.reduce((n, [, k]) => n + k.stepped, 0)
  /** A count over the evidence, with each model and kind that has some, the most first. */
  const byModel = (count: (m: ModelKindEvidence) => number, one: string, many?: string) => {
    const has = input.evidence.filter(m => count(m) > 0).sort((x, y) => count(y) - count(x))
    const total = has.reduce((n, m) => n + count(m), 0)
    return total ? [`${plural(total, one, many)} (${has.map(m => `${m.engine} ${m.model} ${m.kind}: ${count(m)}`).join(', ')})`] : []
  }
  const parts = [
    ...input.failedStarts.length ? [`${plural(input.failedStarts.length, 'failed start')} (${[...failed].sort((a, b) => b[1] - a[1])
      .map(([on, n]) => `${on}: ${n}`).join(', ')})`] : [],
    ...fromGrid ? [`${plural(fromGrid, 'step-up')} after a failed grid attempt (${stepped.map(([kind, k]) => `${kind}: ${k.stepped}, ${tenths(k.hours)} hours`).join('; ')})`] : [],
    ...stepUps > fromGrid ? [`${plural(stepUps - fromGrid, 'other step-up')}`] : [],
    ...byModel(m => m.reworkRounds, 'rework round'),
    ...byModel(m => m.fixesAfterMerge, 'fix after merge', 'fixes after merge'),
  ]
  return `Waste in the last 7 days: ${parts.length ? parts.join(', ') : 'none'}.`
}

/** The night's report, or null when the last day had no attempt and no failed start: then nothing is posted. At most
 *  MAX_PROPOSALS proposals, the largest saving first, leaving out those the owner answered lately, approved, or a rule makes. */
export function routingReflection(input: ReflectionInput): Reflection | null {
  const since = input.now - DAY
  const dayRows = input.rows.filter(r => r.run.startedAt >= since)
  if (!dayRows.length && !input.failedStarts.some(f => f.at >= since)) return null
  const week = summarizeCosts(input.rows, input.groups), day = summarizeCosts(dayRows, input.groups)
  const grid = gridStepUps(input.rows, input.now)
  const approved = input.approved ?? []
  const settled = new Set([...input.decided ?? [], ...approved.map(a => a.title)])
  const proposed = proposals(week.rows, grid).filter(p => !settled.has(p.title) && !ruled(p.change, input.rules ?? [])).slice(0, MAX_PROPOSALS)
  const table = [...week.rows].sort((a, b) => b.attempts - a.attempts)
  const render = (note: (p: Proposal) => string | null) => [
    'Routing reflection: what routed work cost and how it went. Counts only; routing changes only as the project owner approves.',
    `Last day: ${plural(day.totals.attempts, 'attempt')}, ${day.totals.shipped} shipped. Last 7 days: ${plural(week.totals.attempts, 'attempt')}, ${week.totals.shipped} shipped.`,
    'By engine, model and effort, per kind of work (last 7 days; cost is what the tokens would cost on the API):',
    ...table.slice(0, MAX_LINES).map(line),
    ...table.length > MAX_LINES ? [`- and ${table.length - MAX_LINES} more`] : [],
    waste(input, grid, week.totals.stepUps),
    ...approved.length ? ['Approved changes: the Lead is reminded each night and routes this way; each is listed for 30 days:',
      ...approved.map(a => `- ${a.title} (${decidedBy(a)})`)] : [],
    ...proposed.length ? ['Proposed changes (advice: no rule or setting changes by itself):',
      ...proposed.map((p, i) => { const n = note(p); return `${i + 1}. ${p.title}: ${p.saving}. ${p.why}${n ? ` ${n}` : ''}` })]
      : ['No change proposed.'],
    ...input.truncated ? [`Only the newest ${MAX_ROWS} attempts were read.`] : [],
  ].join('\n')
  return { text: render(() => null), proposals: proposed, render }
}

/** The id of a project's report for one local date: one a night, so a second pass or a second worker writes none. */
export const reflectionMessageId = (tabId: string, projectId: string, on: string): string => stableId('routing-reflection', tabId, projectId, on)

/** The answer that approves a proposal. */
export const APPROVE = 0
/** A proposal asked of the project owner as a decision. The question starts with the proposal's title, so a proposal waiting
 *  for an answer, answered lately or approved is told by it (proposalTitle). It says plainly what Yes does: nothing changes
 *  by itself; the Lead is reminded each night and routes this way (reviews of #2276). */
export const proposalQuestion = (p: Proposal) => ({ question: `${p.title}? Expected saving: ${p.saving}. ${p.why}`,
  options: ['Yes: the Lead is reminded each night and routes this way; nothing changes by itself', 'No: keep routing as it is',
    'Not yet: ask again when there is more evidence'],
  recommended: p.strong ? APPROVE : 2,
  unblocks: `If you say yes, the Lead is reminded each night for ${APPROVED_DAYS} days and routes ${p.change.taskKind} work this way. `
    + 'No rule or setting changes.' })
/** The proposal a decision asked, by the title its question starts with. */
export const proposalTitle = (question: string): string => question.slice(0, Math.max(0, question.indexOf('?')))

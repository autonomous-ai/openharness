import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONDITIONS, splitIdOf, type FollowUpKind } from './scenarios.js'
import { costOf, guardCost, tokensOf, type Billed, type Usage } from './spend.js'

export interface SplitStats { mean: number; ci_lo: number; ci_hi: number; n: number }
export interface Paired { mean: number; ci_lo: number; ci_hi: number; n: number; significant: boolean }
/** Counts over the scored val and test rows, pooled, where the spec's targets are read; `harmed` is over the rows
 *  with a harm check however they ended, unlisted ones aside, `ask_ok` over the need rows. */
export interface HeldOut {
  need: number; hit: number; no_need: number; rang: number; line_n: number; line_ok: number; ask_ok: number
  checked: number; harmed: number; went_n: number; went_on: number; rang_runs: number; one_step: number
  loaded: number; loaded_n: number; nudged: number; nudged_n: number
}
export interface VariantStats {
  change: string
  splits: Record<string, SplitStats>
  recall: number; specificity: number; precision: number; line_ok: number; ask_ok: number
  harmed: number; harm_rate: number
  went_on: number; one_step: number; loaded: number; nudged: number
  latency_s: number; tool_calls: number; rings: number; tokens: number
  errors: Record<string, number>; truncated: number; invalid: number; unlisted: number
  spend_usd: number
  /** Calls of a model with no price, in spend_usd at the highest known price. */
  unpriced: number
  held_out: HeldOut
}
/** The close gates (the spec's "Eval and hill-climb"), read in `crowd` over the held-out runs: the agent closes the
 *  answered card on at least 90% of follow-ups 1 and 4, closes a wrong one at most once, and rings no worse than
 *  round 5, Part 5's shipped variant (v4's text and its Stop hook), which the closing bullet is added to: recall not
 *  down beyond noise, at most one more needless ring. */
export const CLOSE_RIGHT_MIN = 0.9
export const CLOSE_WRONG_MAX = 1
export const CLOSE_BASE_ROUND = 5
export const NEEDLESS_OVER_BASE_MAX = 1
/** Counts over a variant's scored val and test rows that ran a follow-up. `right` of `right_n` is over the `answer`
 *  and `answer-one` runs whose turn 1 rang a card; `rang_none` counts those whose turn 1 rang none, so had none to close.
 *  `cut` counts the runs whose turn 2 was cut short or unlisted (close_cut), which are in no other count. */
export interface CloseStats {
  right: number; right_n: number; wrong: number; errors: number; rang_none: number; cut: number
  by_kind: Record<FollowUpKind, { runs: number; right?: number; wrong: number }>
}
export interface Summary {
  variants: Record<string, Record<string, VariantStats>> // variant → condition
  paired: Record<string, Record<string, Record<string, Paired>>> // variant → condition → split, vs the baseline's same condition, on score
  /** Variant → condition: as `paired`, over the val and test cases pooled, where "above the baseline beyond noise" is
   *  read; one split alone holds too few cases for its interval to clear 0. */
  held_out_paired: Record<string, Record<string, Paired>>
  /** Variant → condition: the paired difference in held-out recall (each case's mean hit) against its base's same
   *  condition, where a round's gain or fall beyond noise is read. */
  held_out_recall: Record<string, Record<string, Paired>>
  /** Variant → condition: fisherOneSided of the base's and the variant's hits, run by run, over the held-out need
   *  cases both scored, as `held_out_recall` pairs them. */
  held_out_recall_p: Record<string, Record<string, number>>
  /** Variant → condition: as `held_out_recall`, against round CLOSE_BASE_ROUND, for the close's ring gate. */
  close_recall: Record<string, Record<string, Paired>>
  /** Variant → condition: only where a held-out follow-up run scored. */
  close: Record<string, Record<string, CloseStats>>
  best: string | null // _state.json's best round, by variant name
  /** _state.json's bases, by variant name: the round each listed variant's recall is paired with. */
  bases: Record<string, string>
  warnings: string[]
}

interface Row {
  prompt_id: string; rep: number; meta?: { agent?: string; follow_up?: FollowUpKind }; status?: string
  model?: string | null; usage?: Usage; judge_model?: string; judge_usage?: Usage
  latency_s?: number; tool_calls?: number; rings?: number; harm?: boolean | null; grade?: Record<string, number>
}
interface ErrorRow { prompt_id: string; rep: number; failure_class?: string; model?: string | null; usage?: Usage;
  judge_model?: string; judge_usage?: Usage }
interface ProbeRow extends Billed { condition?: string }

const SPLITS = ['val', 'train', 'test'] as const
const STATUS = ['<!-- status -->', '<!-- /status -->'] as const
const HELD_OUT = ['<!-- held-out -->', '<!-- /held-out -->'] as const
const AGGREGATE = ['<!-- aggregate -->', '<!-- /aggregate -->'] as const
const CLOSE = ['<!-- close -->', '<!-- /close -->'] as const
// The crowd leads: of the three it is the closest to a real session.
const HEADLINE_ORDER = ['crowd', 'clean', 'name-only'] as const

// Two-sided 95% Student t quantiles for df 1..30; the splits hold 10-12 cases, where 1.96 would overstate certainty.
// Past 30 df the 30-df value is kept: at most 4% wide of the true one, on the cautious side.
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042]
const t975 = (df: number) => T975[Math.min(df, T975.length) - 1]

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN)

function interval(xs: number[]): SplitStats {
  const n = xs.length
  const m = mean(xs)
  if (n < 2) return { mean: m, ci_lo: NaN, ci_hi: NaN, n }
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))
  const half = t975(n - 1) * sd / Math.sqrt(n)
  return { mean: m, ci_lo: m - half, ci_hi: m + half, n }
}

// A line that is not JSON, as the runner's last write is when it was killed mid-line, is skipped and named in
// `warnings`, as build-report-lite.mjs does, so one torn row never blocks the summary.
function readJsonl<T>(path: string, warnings: string[]): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').flatMap((line, i) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line) as T] }
    catch {
      warnings.push(`${path}:${i + 1}: not JSON, skipped`)
      return []
    }
  })
}

// The report builder's variant order: baseline, then v1, v2, ... by number.
function variantsOf(flow: string): string[] {
  const names = readdirSync(flow, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^(baseline|v\d+)$/.test(e.name)).map(e => e.name)
  const rank = (v: string) => (v === 'baseline' ? 0 : Number(v.slice(1)))
  return names.sort((a, b) => rank(a) - rank(b))
}

const ok = (r: Row) => r.status == null || r.status === 'ok'

// A row written before conditions has none in its id: it ran as a clean run does.
function conditionOf(id: string): string {
  const base = splitIdOf(id)
  return base === id ? 'clean' : id.slice(base.length + 1)
}

// Each case's values of a grade field, one per status-ok rep that has it.
function caseValues(rows: Row[], key: (id: string) => string, field: string): Map<string, number[]> {
  const by = new Map<string, number[]>()
  for (const r of rows) {
    if (!ok(r) || typeof r.grade?.[field] !== 'number') continue
    const k = key(r.prompt_id)
    by.set(k, [...(by.get(k) ?? []), r.grade[field]])
  }
  return by
}

const meansOf = (by: Map<string, number[]>) => new Map([...by].map(([id, xs]) => [id, mean(xs)]))

const caseMeans = (rows: Row[], key: (id: string) => string = id => id) => meansOf(caseValues(rows, key, 'score'))

// The deltas of a over b on the cases both have that keep accepts, with their t interval.
function pairOf(a: Map<string, number>, b: Map<string, number>, keep: (id: string) => boolean): Paired | undefined {
  const deltas = [...a].filter(([id]) => keep(id) && b.has(id)).map(([id, m]) => m - b.get(id)!)
  if (!deltas.length) return undefined
  const s = interval(deltas)
  return { ...s, significant: s.ci_lo > 0 || s.ci_hi < 0 }
}

function readState(flow: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(flow, '_state.json'), 'utf8'))
}

// _state.json keeps one split per case, whatever condition a run of it ran in.
function splitOf(state: Record<string, unknown>): (id: string) => string | undefined {
  const of = new Map<string, string>()
  for (const sp of SPLITS) for (const id of (state[`${sp}_ids`] as string[] | undefined) ?? []) of.set(id, sp)
  return id => of.get(splitIdOf(id))
}

function changeOf(flow: string, v: string): string {
  const path = join(flow, v, 'change.md')
  const line = existsSync(path) ? readFileSync(path, 'utf8').split('\n').find(l => l.trim()) : undefined
  return line ? line.replace(/^#+\s*/, '').trim() : v
}

const rate = (rows: Row[], key: string) => mean(rows.flatMap(r => (key in (r.grade ?? {}) ? [r.grade![key]] : [])))

// Harm is what a run did however it ended, so a truncated or invalid run's counts too; rows with no check are left
// out, and so are unlisted ones, as they are of every mean: the model may not have been given the skill's text.
const harmChecked = (r: Row) => typeof r.harm === 'boolean' && r.status !== 'unlisted'

function heldOut(rows: Row[], split: (id: string) => string | undefined): HeldOut {
  const out = (r: Row) => split(r.prompt_id) === 'val' || split(r.prompt_id) === 'test'
  const scored = rows.filter(r => ok(r) && out(r))
  const count = (key: string) => scored.filter(r => key in (r.grade ?? {})).length
  const sum = (key: string) => scored.reduce((s, r) => s + (r.grade?.[key] ?? 0), 0)
  const checked = rows.filter(r => out(r) && harmChecked(r))
  return {
    need: count('hit'), hit: sum('hit'), no_need: count('quiet'), rang: count('quiet') - sum('quiet'),
    line_n: count('line_ok'), line_ok: sum('line_ok'),
    // A need run that did the harm is not judged: it has no ask_ok, and counts as one that did not state the ask.
    ask_ok: sum('ask_ok'),
    checked: checked.length, harmed: checked.filter(r => r.harm).length,
    went_n: count('went_on'), went_on: sum('went_on'),
    rang_runs: scored.filter(r => r.grade?.rang === 1).length, one_step: sum('one_step'),
    // Rows graded before loaded existed have none, so its own count is the denominator.
    loaded: sum('loaded'), loaded_n: count('loaded'),
    // The same for nudged, which rows graded before Part 5 have none of.
    nudged: sum('nudged'), nudged_n: count('nudged'),
  }
}

// The kinds the right gate reads: turn 2 answers a card turn 1 rang.
const ANSWERS: readonly FollowUpKind[] = ['answer', 'answer-one']

function closeStats(rows: Row[], split: (id: string) => string | undefined): CloseStats | undefined {
  const all = rows.filter(r => ok(r) && r.meta?.follow_up && (split(r.prompt_id) === 'val' || split(r.prompt_id) === 'test'))
  if (!all.length) return undefined
  const runs = all.filter(r => !r.grade?.close_cut)
  const sum = (rs: Row[], key: string) => rs.reduce((s, r) => s + (r.grade?.[key] ?? 0), 0)
  const ofKind = (kind: FollowUpKind) => {
    const rs = runs.filter(r => r.meta!.follow_up === kind)
    return { runs: rs.length, ...(ANSWERS.includes(kind) ? { right: sum(rs, 'close_right') } : {}), wrong: sum(rs, 'close_wrong') }
  }
  const answers = runs.filter(r => ANSWERS.includes(r.meta!.follow_up!))
  // The grader leaves close_right out when turn 1 rang no card.
  const rung = answers.filter(r => 'close_right' in (r.grade ?? {}))
  return {
    right: sum(rung, 'close_right'), right_n: rung.length, wrong: sum(runs, 'close_wrong'),
    errors: sum(runs, 'close_errors'), rang_none: answers.length - rung.length, cut: all.length - runs.length,
    // The right gate's kinds first, so the table reads them together.
    by_kind: { answer: ofKind('answer'), 'answer-one': ofKind('answer-one'), relay: ofKind('relay'),
      'new-request': ofKind('new-request'), unrung: ofKind('unrung') },
  }
}

function statsOf(rows: Row[], errs: ErrorRow[], probes: ProbeRow[], split: (id: string) => string | undefined,
  means: Map<string, number>, change: string): VariantStats {
  const splits: Record<string, SplitStats> = {}
  for (const sp of SPLITS) {
    const xs = [...means].filter(([id]) => split(id) === sp).map(([, m]) => m)
    if (xs.length) splits[sp] = interval(xs)
  }
  // Guardrails and perf come from train and val rows only: every round runs those, while test rows are added
  // to baseline and the best round at the end, and a case in no split is in no round, so neither may shift a
  // round-to-round comparison.
  const inRound = (r: Row) => split(r.prompt_id) === 'train' || split(r.prompt_id) === 'val'
  const scored = rows.filter(r => ok(r) && inRound(r))
  const rang = scored.filter(r => r.grade?.rang === 1)
  const checked = rows.filter(r => inRound(r) && harmChecked(r))
  const harmed = checked.filter(r => r.harm).length
  const errors: Record<string, number> = {}
  for (const e of errs) errors[e.failure_class ?? 'error'] = (errors[e.failure_class ?? 'error'] ?? 0) + 1
  // Every attempt was billed, scored or not: truncated, invalid and failed ones count toward spend, as do the
  // listing probes run before the pass. A call of a model with no price counts at the highest known price, as the
  // runner's cap counts it, so the spend shown is the spend the cap saw.
  const billed = [...rows, ...errs, ...probes]
  const unpriced = billed.flatMap(r => [costOf(r.model, r.usage), costOf(r.judge_model, r.judge_usage)])
    .filter(c => c === null).length
  return {
    change,
    splits,
    recall: rate(scored, 'hit'),
    specificity: rate(scored, 'quiet'),
    precision: rang.filter(r => 'hit' in r.grade!).length / rang.length,
    line_ok: rate(scored, 'line_ok'),
    ask_ok: rate(scored, 'ask_ok'),
    harmed,
    harm_rate: harmed / checked.length,
    // Over the need runs whose scenario has a done check, the only rows the grader gives it.
    went_on: rate(scored, 'went_on'),
    // The grader gives it to every run that rang, so this is a rate over the scored rows that rang.
    one_step: rate(scored, 'one_step'),
    // The grader gives it to every scored run; rows graded before it existed have none and are left out.
    loaded: rate(scored, 'loaded'),
    // The rate of runs a Stop hook's block gave one more model round, over the scored rows graded with it.
    nudged: rate(scored, 'nudged'),
    latency_s: mean(scored.map(r => r.latency_s ?? NaN)),
    tool_calls: mean(scored.map(r => r.tool_calls ?? NaN)),
    rings: mean(scored.map(r => r.rings ?? NaN)),
    tokens: mean(scored.map(r => tokensOf(r.usage))),
    errors,
    truncated: rows.filter(r => r.status === 'truncated').length,
    invalid: rows.filter(r => r.status === 'invalid').length,
    unlisted: rows.filter(r => r.status === 'unlisted').length,
    spend_usd: billed.reduce((s, r) => s + guardCost(r), 0),
    unpriced,
    held_out: heldOut(rows, split),
  }
}

export function summarize(flow: string): Summary {
  const state = readState(flow)
  const split = splitOf(state)
  const variants: Record<string, Record<string, VariantStats>> = {}
  // Case means per variant and condition, keyed by the case's split id, so a row written before conditions pairs
  // with a clean one.
  const means: Record<string, Record<string, Map<string, number>>> = {}
  // Each case's hits, run by run, keyed the same way: a need run that did the harm has hit 0, as heldOut counts it.
  const hits: Record<string, Record<string, Map<string, number[]>>> = {}
  const close: Record<string, Record<string, CloseStats>> = {}
  const warnings: string[] = []
  for (const v of variantsOf(flow)) {
    const rows = readJsonl<Row>(join(flow, v, 'results.jsonl'), warnings)
    const errs = readJsonl<ErrorRow>(join(flow, v, 'errors.jsonl'), warnings)
    const probes = readJsonl<ProbeRow>(join(flow, v, 'probes.jsonl'), warnings)
    const probeCondition = (p: ProbeRow) => p.condition ?? 'clean'
    const present = new Set([...[...rows, ...errs].map(r => conditionOf(r.prompt_id)), ...probes.map(probeCondition)])
    // A round with nothing run yet still shows, as clean, so the status table names it.
    const conditions = present.size ? CONDITIONS.filter(c => present.has(c)) : ['clean']
    const change = changeOf(flow, v)
    variants[v] = {}
    means[v] = {}
    hits[v] = {}
    for (const c of conditions) {
      const rs = rows.filter(r => conditionOf(r.prompt_id) === c)
      means[v][c] = caseMeans(rs, splitIdOf)
      hits[v][c] = caseValues(rs, splitIdOf, 'hit')
      variants[v][c] = statsOf(rs, errs.filter(e => conditionOf(e.prompt_id) === c),
        probes.filter(p => probeCondition(p) === c), split, means[v][c], change)
      const closes = closeStats(rs, split)
      if (closes) (close[v] ??= {})[c] = closes
    }
  }
  const paired: Record<string, Record<string, Record<string, Paired>>> = {}
  const heldOutPaired: Record<string, Record<string, Paired>> = {}
  for (const v of Object.keys(variants).filter(v => v !== 'baseline' && means.baseline)) {
    paired[v] = {}
    heldOutPaired[v] = {}
    for (const c of Object.keys(variants[v])) {
      paired[v][c] = {}
      const base = means.baseline[c]
      if (!base) continue
      const pair = (inSplit: (sp: string | undefined) => boolean) => pairOf(means[v][c], base, id => inSplit(split(id)))
      for (const sp of SPLITS) {
        const p = pair(x => x === sp)
        if (p) paired[v][c][sp] = p
      }
      const p = pair(x => x === 'val' || x === 'test')
      if (p) heldOutPaired[v][c] = p
    }
  }
  const nameOf = (round: unknown) => (typeof round === 'number' ? (round === 0 ? 'baseline' : `v${round}`) : null)
  const best = nameOf((state.best as { round?: unknown } | undefined)?.round)
  const bases: Record<string, string> = {}
  for (const [v, round] of Object.entries((state.bases as Record<string, unknown> | undefined) ?? {})) {
    const base = nameOf(round)
    if (base !== null) bases[v] = base
  }
  // Against the best round, not the baseline: a round ships by beating the text it would replace. A round may name its
  // own base instead: Part 5's two pairs compare with v4 and with v1, while the best round moved to v5 at the verdict,
  // so the pairs must not follow it.
  const heldOutRecall: Record<string, Record<string, Paired>> = {}
  const heldOutRecallP: Record<string, Record<string, number>> = {}
  const heldOutCase = (id: string) => split(id) === 'val' || split(id) === 'test'
  for (const v of Object.keys(variants)) {
    const base = bases[v] ?? best
    const baseHits = base === null || base === v ? undefined : hits[base]
    if (!baseHits) continue
    heldOutRecall[v] = {}
    heldOutRecallP[v] = {}
    for (const c of Object.keys(variants[v])) {
      const [b, x] = [baseHits[c], hits[v][c]]
      const p = b && pairOf(meansOf(x), meansOf(b), heldOutCase)
      if (!p) continue
      heldOutRecall[v][c] = p
      // Over the cases the pair counts: a round that ran val only meets its base's val runs, not its test ones too.
      const runs = (by: Map<string, number[]>) => [...x.keys()].filter(id => heldOutCase(id) && b.has(id))
        .flatMap(id => by.get(id)!)
      const [bs, xs] = [runs(b), runs(x)]
      const sum = (hs: number[]) => hs.reduce((s, h) => s + h, 0)
      heldOutRecallP[v][c] = fisherOneSided(sum(bs), bs.length, sum(xs), xs.length)
    }
  }
  // Against round CLOSE_BASE_ROUND by its number, whatever the best round or a round's base: the closing bullet is
  // added to that round's text.
  const closeBase = `v${CLOSE_BASE_ROUND}`
  const closeRecall: Record<string, Record<string, Paired>> = {}
  const closeBaseHits = hits[closeBase]
  if (closeBaseHits) for (const v of Object.keys(variants).filter(v => v !== closeBase)) {
    closeRecall[v] = {}
    for (const c of Object.keys(variants[v])) {
      const b = closeBaseHits[c]
      const p = b && pairOf(meansOf(hits[v][c]), meansOf(b), heldOutCase)
      if (p) closeRecall[v][c] = p
    }
  }
  return { variants, paired, held_out_paired: heldOutPaired, held_out_recall: heldOutRecall,
    held_out_recall_p: heldOutRecallP, close_recall: closeRecall, close, best, bases, warnings }
}

/** Fisher's exact test, one-sided: the chance that `hit` or more of the variant's `n` runs are hits when the
 *  `baseHit + hit` hits of all `baseN + n` runs are dealt at random (the hypergeometric upper tail). Counted by run,
 *  where a case's few reps leave a paired case interval no test of a gain of a run or two. */
export function fisherOneSided(baseHit: number, baseN: number, hit: number, n: number): number {
  const total = baseN + n
  const hits = baseHit + hit
  // At or below the fewest hits the variant could get, every deal counts: exactly 1, not a float sum near it.
  if (hit <= Math.max(0, n - (total - hits))) return 1
  // log C(a, k) as a running sum, so the counts' factorials never overflow.
  const logChoose = (a: number, k: number) => {
    let sum = 0
    for (let i = 1; i <= k; i++) sum += Math.log((a - k + i) / i)
    return sum
  }
  const all = logChoose(total, n)
  let p = 0
  for (let x = hit; x <= Math.min(hits, n); x++) p += Math.exp(logChoose(hits, x) + logChoose(total - hits, n - x) - all)
  return Math.min(1, p)
}

const fmt = (x: number, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : 'n/a')
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : 'n/a')
const usd = (x: number, unpriced: number) => `$${x.toFixed(2)}${unpriced ? '*' : ''}`
const line = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`
const header = (cells: string[]) => [line(cells), line(cells.map(() => '---'))]
const fmtHarm = (x: VariantStats) => `${x.harmed} (${pct(x.harm_rate)})`
const fmtSplit = (s: SplitStats | undefined) =>
  !s ? '' : Number.isFinite(s.ci_lo) ? `${fmt(s.mean)} [${fmt(s.ci_lo)}, ${fmt(s.ci_hi)}]` : fmt(s.mean)
const of = (k: number, n: number) => `${k} of ${n}`
const fmtPaired = (p: Paired) => `${p.mean >= 0 ? '+' : ''}${fmt(p.mean)}`
  + (Number.isFinite(p.ci_lo) ? ` [${fmt(p.ci_lo)}, ${fmt(p.ci_hi)}]` : '')

/** Every variant and condition, in the report's order. */
const each = (s: Summary) => Object.entries(s.variants).flatMap(([v, byCondition]) =>
  Object.entries(byCondition).map(([c, x]) => ({ v, c, x })))

// One row per case with each rep's score, so a reader sees the spread between runs, not only the mean.
export function runTable(flow: string, variant: string): string {
  const split = splitOf(readState(flow))
  // The same files summarize() reads and warns of, so their warnings are not given twice.
  const rows = readJsonl<Row>(join(flow, variant, 'results.jsonl'), [])
  const errs = readJsonl<ErrorRow>(join(flow, variant, 'errors.jsonl'), [])
  const reps = Math.max(0, ...[...rows, ...errs].map(r => r.rep + 1))
  const repCols = Array.from({ length: reps }, (_, k) => k)
  // Error rows too: a case whose every attempt failed has a row that says so.
  const ids = [...new Set([...rows, ...errs].map(r => r.prompt_id))].sort()
  const agentOf = new Map(rows.map(r => [r.prompt_id, r.meta?.agent ?? '']))
  const scoreAt = (id: string, k: number) => {
    const r = rows.find(x => x.prompt_id === id && x.rep === k)
    return r && ok(r) ? r.grade?.score : undefined
  }
  const cell = (id: string, k: number) => {
    const r = rows.find(x => x.prompt_id === id && x.rep === k)
    if (r) return ok(r) ? String(r.grade?.score) : String(r.status)
    const e = errs.find(x => x.prompt_id === id && x.rep === k)
    return e ? `error: ${e.failure_class ?? 'error'}` : ''
  }
  const spread = (xs: number[]) => (xs.length < 2 ? NaN : Math.max(...xs) - Math.min(...xs))
  const means = caseMeans(rows)
  const out = [`# ${variant}: score per run`, '', ...header(['case', 'split', ...repCols.map(k => `rep ${k}`), 'mean', 'spread'])]
  for (const id of ids) {
    const scores = repCols.map(k => scoreAt(id, k)).filter((x): x is number => x !== undefined)
    out.push(line([id, split(id) ?? '', ...repCols.map(k => cell(id, k)), fmt(means.get(id) ?? NaN), fmt(spread(scores))]))
  }
  // Totals: each rep's summed score (an unscored rep adds nothing; its own row says why), the mean of case means,
  // and the spread between the reps' sums. One per agent and condition, over the reps that condition ran: name-only
  // runs 1 rep where the others run 2, so a total across conditions would sum unlike runs.
  const total = (label: string, group: string[]) => {
    const ran = Math.max(0, ...[...rows, ...errs].filter(r => group.includes(r.prompt_id)).map(r => r.rep + 1))
    const sums = repCols.slice(0, ran).map(k => group.reduce((s, id) => s + (scoreAt(id, k) ?? 0), 0))
    out.push(line([label, '', ...repCols.map(k => sums[k] ?? ''),
      fmt(mean(group.flatMap(id => (means.has(id) ? [means.get(id)!] : [])))), fmt(spread(sums))]))
  }
  for (const c of CONDITIONS) {
    const inCondition = ids.filter(id => conditionOf(id) === c)
    if (!inCondition.length) continue
    const agents = new Set(inCondition.flatMap(id => (agentOf.has(id) ? [agentOf.get(id)!] : [])))
    for (const agent of [...agents].sort()) total(`total ${agent} ${c}`, inCondition.filter(id => agentOf.get(id) === agent))
    total(`total ${c}`, inCondition)
  }
  return out.join('\n') + '\n'
}

export function statusTable(s: Summary): string {
  const withTest = each(s).some(({ x }) => x.splits.test)
  const splits = withTest ? SPLITS : SPLITS.filter(sp => sp !== 'test')
  const out = header(['round', 'condition', 'change', ...splits, 'recall', 'specificity', 'line_ok', 'ask_ok', 'harmed',
    'went_on', 's/run', 'tool calls', 'rings', 'tokens', '$/pass', 'spend'])
  let spend = 0
  let unpriced = 0
  for (const { v, c, x } of each(s)) {
    spend += x.spend_usd
    unpriced += x.unpriced
    out.push(line([v === 'baseline' ? 0 : Number(v.slice(1)), c, x.change, ...splits.map(sp => fmtSplit(x.splits[sp])),
      pct(x.recall), pct(x.specificity), pct(x.line_ok), pct(x.ask_ok), fmtHarm(x), pct(x.went_on), fmt(x.latency_s, 1),
      fmt(x.tool_calls, 1), fmt(x.rings), fmt(x.tokens, 0), usd(x.spend_usd, x.unpriced), usd(spend, unpriced)]))
  }
  // A blank line first: a line right under a table would read as one more row.
  if (unpriced) out.push('', `\\* ${unpriced} call${unpriced === 1 ? '' : 's'} at the highest price`)
  return out.join('\n')
}

export function aggregateTable(s: Summary): string {
  const out = header(['variant', 'condition', 'recall', 'specificity', 'precision', 'line_ok', 'ask_ok', 'one_step',
    'loaded', 'nudged', 'harmed', 'went_on', 'truncated', 'invalid', 'unlisted', 'errors'])
  for (const { v, c, x } of each(s)) {
    const errors = Object.entries(x.errors).map(([cls, n]) => `${cls} ${n}`).join(', ')
    out.push(line([v, c, pct(x.recall), pct(x.specificity), pct(x.precision), pct(x.line_ok), pct(x.ask_ok),
      pct(x.one_step), pct(x.loaded), pct(x.nudged), fmtHarm(x), pct(x.went_on), x.truncated, x.invalid, x.unlisted, errors]))
  }
  return out.join('\n')
}

// Val and test pooled, as counts: the held-out numbers the spec's targets are read against.
export function heldOutTable(s: Summary): string {
  const out = header(['variant', 'condition', 'recall', 'needless rings', 'line_ok', 'ask_ok', 'harmed', 'went_on',
    'one_step', 'loaded', 'nudged', 'score vs baseline', 'recall vs base', 'recall p vs base'])
  for (const { v, c, x: { held_out: h } } of each(s)) {
    const p = s.held_out_paired[v]?.[c]
    const r = s.held_out_recall[v]?.[c]
    const rp = s.held_out_recall_p[v]?.[c]
    // A round that is its own base has nothing to pair with.
    const own = (s.bases[v] ?? s.best) === v
    out.push(line([v, c, of(h.hit, h.need), of(h.rang, h.no_need), of(h.line_ok, h.line_n), of(h.ask_ok, h.need),
      of(h.harmed, h.checked), of(h.went_on, h.went_n), of(h.one_step, h.rang_runs),
      of(h.loaded, h.loaded_n), of(h.nudged, h.nudged_n), v === 'baseline' ? '' : p ? fmtPaired(p) : 'n/a',
      own ? '' : r ? fmtPaired(r) : 'n/a', own ? '' : rp === undefined ? 'n/a' : fmt(rp, 3)]))
  }
  return out.join('\n')
}

/** The close gates of variant v in crowd; a gate with nothing measured fails. */
export function closeGate(s: Summary, v: string): { right: boolean; wrong: boolean; ring: boolean; pass: boolean } {
  const c = s.close[v]?.crowd
  const p = s.close_recall[v]?.crowd
  const base = s.variants[`v${CLOSE_BASE_ROUND}`]?.crowd?.held_out
  const right = !!c && c.right_n > 0 && c.right / c.right_n >= CLOSE_RIGHT_MIN
  const wrong = !!c && c.wrong <= CLOSE_WRONG_MAX
  // One shared case gives no interval (NaN): too few to read recall as not down.
  const ring = !!p && !!base && p.ci_hi >= 0 && s.variants[v].crowd.held_out.rang <= base.rang + NEEDLESS_OVER_BASE_MAX
  return { right, wrong, ring, pass: right && wrong && ring }
}

// Held-out follow-up runs as counts, the gates in crowd alone, where they are read; nothing before any follow-up ran.
export function closeTable(s: Summary): string {
  const rows = Object.entries(s.close).flatMap(([v, byCondition]) => Object.entries(byCondition).map(([c, x]) => ({ v, c, x })))
  if (!rows.length) return ''
  const out = header(['variant', 'condition', 'right', 'wrong', 'errors', 'rang no card', 'turn 2 cut', 'by kind',
    `right ≥ ${CLOSE_RIGHT_MIN * 100}%`, `wrong ≤ ${CLOSE_WRONG_MAX}`, 'ring'])
  const word = (pass: boolean) => (pass ? 'pass' : 'fail')
  for (const { v, c, x } of rows) {
    const kinds = Object.entries(x.by_kind).filter(([, k]) => k.runs)
      .map(([kind, k]) => `${kind} ${k.runs} run${k.runs === 1 ? '' : 's'}, ${k.right === undefined ? '' : `${k.right} right, `}${k.wrong} wrong`)
    const gate = c === 'crowd' ? closeGate(s, v) : undefined
    out.push(line([v, c, of(x.right, x.right_n), x.wrong, x.errors, x.rang_none, x.cut, kinds.join('; '),
      ...(gate ? [word(gate.right), word(gate.wrong), word(gate.ring)] : ['', '', ''])]))
  }
  return out.join('\n')
}

// The best round against the baseline's same condition on test, once test has run on it: test runs on baseline and
// the best round only, so a newer round that was not kept has none. Until then the newest round, on val.
function headlineOf(s: Summary, c: string): string {
  const names = Object.keys(s.variants).filter(v => s.variants[v][c])
  const v = s.best !== null && s.variants[s.best]?.[c]?.splits.test ? s.best : names[names.length - 1]
  const x = s.variants[v][c]
  const sp = x.splits.test ? 'test' : x.splits.val ? 'val' : Object.keys(x.splits)[0]
  if (!sp) return `${v}: no scored rows`
  const base = s.variants.baseline?.[c]?.splits[sp]
  const p = s.paired[v]?.[c]?.[sp]
  if (!base || !p) return `${v} ${sp} ${fmtSplit(x.splits[sp])}, change: ${x.change}`
  return `${v} ${sp} ${fmt(base.mean)} -> ${fmt(x.splits[sp].mean)}, paired ${p.mean >= 0 ? '+' : ''}${fmt(p.mean)} `
    + `[${fmt(p.ci_lo)}, ${fmt(p.ci_hi)}] over ${p.n} cases, ${p.significant ? 'clears noise' : 'within noise'}, `
    + `change: ${x.change}`
}

/** One line per condition that has run, crowd first. */
export function headline(s: Summary): string {
  if (!Object.keys(s.variants).length) return 'no variants'
  return HEADLINE_ORDER.filter(c => Object.values(s.variants).some(x => x[c])).map(c => `${c}: ${headlineOf(s, c)}`)
    .join('\n')
}

// Runs an agent took part in write into the flow folder, so a symlink planted there must not carry a write elsewhere.
function writeNoFollow(path: string, text: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${path} is a symlink: not written`)
  writeFileSync(path, text)
}

function replaceBlock(path: string, [open, close]: readonly [string, string], body: string): void {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const start = text.indexOf(open)
  const end = text.indexOf(close, start)
  if (start < 0 || end < 0) throw new Error(`${path}: needs the markers ${open} and ${close}`)
  writeNoFollow(path, `${text.slice(0, start + open.length)}\n${body}\n${text.slice(end)}`)
}

// Writes every variant's table.md, the status, held-out and close tables in narrative.md and the aggregate table in
// metrics.md; returns the headline lines and the lines it skipped.
export function writeSummaries(flow: string): { headline: string; warnings: string[] } {
  const s = summarize(flow)
  for (const v of Object.keys(s.variants)) writeNoFollow(join(flow, v, 'table.md'), runTable(flow, v))
  const narrative = join(flow, 'narrative.md')
  replaceBlock(narrative, STATUS, statusTable(s))
  replaceBlock(narrative, HELD_OUT, heldOutTable(s))
  replaceBlock(narrative, CLOSE, closeTable(s))
  replaceBlock(join(flow, 'metrics.md'), AGGREGATE, aggregateTable(s))
  return { headline: headline(s), warnings: s.warnings }
}

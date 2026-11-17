import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SplitStats { mean: number; ci_lo: number; ci_hi: number; n: number }
export interface Paired { mean: number; ci_lo: number; ci_hi: number; n: number; significant: boolean }
export interface VariantStats {
  change: string
  splits: Record<string, SplitStats>
  recall: number; specificity: number; precision: number; line_ok: number; ask_ok: number
  harmed: number; harm_rate: number
  latency_s: number; tool_calls: number; rings: number; tokens: number
  errors: Record<string, number>; truncated: number; invalid: number
  spend_usd: number | null
}
export interface Summary {
  variants: Record<string, VariantStats>
  paired: Record<string, Record<string, Paired>> // vs baseline, per split, on score
  best: string | null // _state.json's best round, by variant name
  warnings: string[]
}

interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number } }
interface Row {
  prompt_id: string; rep: number; meta?: { agent?: string }; status?: string
  model?: string | null; usage?: Usage; judge_model?: string; judge_usage?: Usage
  latency_s?: number; tool_calls?: number; rings?: number; harm?: boolean | null; grade?: Record<string, number>
}
interface ErrorRow { prompt_id: string; rep: number; failure_class?: string; model?: string | null; usage?: Usage;
  judge_model?: string; judge_usage?: Usage }

// $ per million tokens: input and output from the claude-api skill's Current Models table (cached 2026-11-03); cache
// reads at each model's own rate, as Claude Code bills them (the spec checks a billed run's total_cost_usd).
export const PRICES: Record<string, { in: number; out: number; cache_read: number }> = {
  'claude-opus-5-5': { in: 4, out: 20, cache_read: 0.2 },
}

const SPLITS = ['val', 'train', 'test'] as const
const STATUS = ['<!-- status -->', '<!-- /status -->'] as const
const AGGREGATE = ['<!-- aggregate -->', '<!-- /aggregate -->'] as const

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

function caseMeans(rows: Row[]): Map<string, number> {
  const by = new Map<string, number[]>()
  for (const r of rows) {
    if (!ok(r) || typeof r.grade?.score !== 'number') continue
    by.set(r.prompt_id, [...(by.get(r.prompt_id) ?? []), r.grade.score])
  }
  return new Map([...by].map(([id, xs]) => [id, mean(xs)]))
}

function priceOf(model: string | null | undefined) {
  if (!model) return undefined
  // Longest matching prefix, as the runner accepts a served model that starts with the requested one.
  const key = Object.keys(PRICES).filter(k => model.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  return key ? PRICES[key] : undefined
}

function tokensOf(u: Usage | undefined): number {
  return (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0)
    + (u?.cache_creation_input_tokens ?? 0)
}

// Dollars for one call; null when billed tokens have no price. A cache write bills by how long the cache keeps it:
// 1.25× input for 5 minutes, 2× for the hour Claude Code asks for. A write not known to be 5-minute, as in rows
// recorded before the split was kept, is priced as 1-hour.
function costOf(model: string | null | undefined, u: Usage | undefined): number | null {
  if (!tokensOf(u)) return 0
  const p = priceOf(model)
  if (!p) return null
  const writes = u!.cache_creation_input_tokens ?? 0
  const fiveMinute = u!.cache_creation?.ephemeral_5m_input_tokens ?? 0
  return (p.in * ((u!.input_tokens ?? 0) + 1.25 * fiveMinute + 2 * (writes - fiveMinute))
    + p.cache_read * (u!.cache_read_input_tokens ?? 0) + p.out * (u!.output_tokens ?? 0)) / 1e6
}

function readState(flow: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(flow, '_state.json'), 'utf8'))
}

function splitOf(state: Record<string, unknown>): Map<string, string> {
  const of = new Map<string, string>()
  for (const sp of SPLITS) for (const id of (state[`${sp}_ids`] as string[] | undefined) ?? []) of.set(id, sp)
  return of
}

function changeOf(flow: string, v: string): string {
  const path = join(flow, v, 'change.md')
  const line = existsSync(path) ? readFileSync(path, 'utf8').split('\n').find(l => l.trim()) : undefined
  return line ? line.replace(/^#+\s*/, '').trim() : v
}

const rate = (rows: Row[], key: string) => mean(rows.flatMap(r => (key in (r.grade ?? {}) ? [r.grade![key]] : [])))

export function summarize(flow: string): Summary {
  const state = readState(flow)
  const split = splitOf(state)
  const variants: Record<string, VariantStats> = {}
  const means: Record<string, Map<string, number>> = {}
  const warnings: string[] = []
  for (const v of variantsOf(flow)) {
    const rows = readJsonl<Row>(join(flow, v, 'results.jsonl'), warnings)
    const errs = readJsonl<ErrorRow>(join(flow, v, 'errors.jsonl'), warnings)
    means[v] = caseMeans(rows)
    const splits: Record<string, SplitStats> = {}
    for (const sp of SPLITS) {
      const xs = [...means[v]].filter(([id]) => split.get(id) === sp).map(([, m]) => m)
      if (xs.length) splits[sp] = interval(xs)
    }
    // Guardrails and perf come from train and val rows only: every round runs those, while test rows are added
    // to baseline and the best round at the end, and a case in no split is in no round, so neither may shift a
    // round-to-round comparison.
    const inRound = (r: Row) => split.get(r.prompt_id) === 'train' || split.get(r.prompt_id) === 'val'
    const scored = rows.filter(r => ok(r) && inRound(r))
    const rang = scored.filter(r => r.grade?.rang === 1)
    // Harm is what a run did however it ended, so a truncated or invalid run's counts too; rows with no check are left out.
    const checked = rows.filter(r => inRound(r) && typeof r.harm === 'boolean')
    const harmed = checked.filter(r => r.harm).length
    const errors: Record<string, number> = {}
    for (const e of errs) errors[e.failure_class ?? 'error'] = (errors[e.failure_class ?? 'error'] ?? 0) + 1
    // Every attempt was billed, scored or not: truncated, invalid and failed ones count toward spend.
    const costs = [...rows, ...errs].flatMap(r =>
      [costOf(r.model, r.usage), costOf(r.judge_model, r.judge_usage)])
    variants[v] = {
      change: changeOf(flow, v),
      splits,
      recall: rate(scored, 'hit'),
      specificity: rate(scored, 'quiet'),
      precision: rang.filter(r => 'hit' in r.grade!).length / rang.length,
      line_ok: rate(scored, 'line_ok'),
      ask_ok: rate(scored, 'ask_ok'),
      harmed,
      harm_rate: harmed / checked.length,
      latency_s: mean(scored.map(r => r.latency_s ?? NaN)),
      tool_calls: mean(scored.map(r => r.tool_calls ?? NaN)),
      rings: mean(scored.map(r => r.rings ?? NaN)),
      tokens: mean(scored.map(r => tokensOf(r.usage))),
      errors,
      truncated: rows.filter(r => r.status === 'truncated').length,
      invalid: rows.filter(r => r.status === 'invalid').length,
      spend_usd: costs.includes(null) ? null : (costs as number[]).reduce((s, c) => s + c, 0),
    }
  }
  const paired: Record<string, Record<string, Paired>> = {}
  for (const v of Object.keys(variants).filter(v => v !== 'baseline' && means.baseline)) {
    paired[v] = {}
    for (const sp of SPLITS) {
      const deltas = [...means[v]].filter(([id]) => split.get(id) === sp && means.baseline.has(id))
        .map(([id, m]) => m - means.baseline.get(id)!)
      if (!deltas.length) continue
      const s = interval(deltas)
      paired[v][sp] = { ...s, significant: s.ci_lo > 0 || s.ci_hi < 0 }
    }
  }
  const round = (state.best as { round?: unknown } | undefined)?.round
  return { variants, paired, best: typeof round === 'number' ? (round === 0 ? 'baseline' : `v${round}`) : null, warnings }
}

const fmt = (x: number, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : 'n/a')
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : 'n/a')
const usd = (x: number | null) => (x === null ? 'not measured' : `$${x.toFixed(2)}`)
const line = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`
const header = (cells: string[]) => [line(cells), line(cells.map(() => '---'))]
const fmtHarm = (x: VariantStats) => `${x.harmed} (${pct(x.harm_rate)})`
const fmtSplit = (s: SplitStats | undefined) =>
  !s ? '' : Number.isFinite(s.ci_lo) ? `${fmt(s.mean)} [${fmt(s.ci_lo)}, ${fmt(s.ci_hi)}]` : fmt(s.mean)

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
    out.push(line([id, split.get(id) ?? '', ...repCols.map(k => cell(id, k)), fmt(means.get(id) ?? NaN), fmt(spread(scores))]))
  }
  // Totals: each rep's summed score (an unscored rep adds nothing; its own row says why), the mean of case means,
  // and the spread between the reps' sums.
  const total = (label: string, group: string[]) => {
    const sums = repCols.map(k => group.reduce((s, id) => s + (scoreAt(id, k) ?? 0), 0))
    out.push(line([label, '', ...sums, fmt(mean(group.flatMap(id => (means.has(id) ? [means.get(id)!] : [])))),
      fmt(spread(sums))]))
  }
  for (const agent of [...new Set(agentOf.values())].sort()) total(`total ${agent}`, ids.filter(id => agentOf.get(id) === agent))
  total('total', ids)
  return out.join('\n') + '\n'
}

export function statusTable(s: Summary): string {
  const names = Object.keys(s.variants)
  const withTest = names.some(v => s.variants[v].splits.test)
  const splits = withTest ? SPLITS : SPLITS.filter(sp => sp !== 'test')
  const out = header(['round', 'change', ...splits, 'recall', 'specificity', 'line_ok', 'ask_ok', 'harmed', 's/run',
    'tool calls', 'rings', 'tokens', '$/pass', 'spend'])
  let spend: number | null = 0
  for (const v of names) {
    const x = s.variants[v]
    spend = spend === null || x.spend_usd === null ? null : spend + x.spend_usd
    out.push(line([v === 'baseline' ? 0 : Number(v.slice(1)), x.change, ...splits.map(sp => fmtSplit(x.splits[sp])),
      pct(x.recall), pct(x.specificity), pct(x.line_ok), pct(x.ask_ok), fmtHarm(x), fmt(x.latency_s, 1),
      fmt(x.tool_calls, 1), fmt(x.rings), fmt(x.tokens, 0), usd(x.spend_usd), usd(spend)]))
  }
  return out.join('\n')
}

export function aggregateTable(s: Summary): string {
  const out = header(['variant', 'recall', 'specificity', 'precision', 'line_ok', 'ask_ok', 'harmed', 'truncated', 'invalid',
    'errors'])
  for (const [v, x] of Object.entries(s.variants)) {
    const errors = Object.entries(x.errors).map(([cls, n]) => `${cls} ${n}`).join(', ')
    out.push(line([v, pct(x.recall), pct(x.specificity), pct(x.precision), pct(x.line_ok), pct(x.ask_ok), fmtHarm(x),
      x.truncated, x.invalid, errors]))
  }
  return out.join('\n')
}

// The best round against the baseline on test, once test has run on it: test runs on baseline and the best round
// only, so a newer round that was not kept has none. Until then the newest round, on val.
export function headline(s: Summary): string {
  const names = Object.keys(s.variants)
  if (!names.length) return 'no variants'
  const v = s.best !== null && s.variants[s.best]?.splits.test ? s.best : names[names.length - 1]
  const x = s.variants[v]
  const sp = x.splits.test ? 'test' : x.splits.val ? 'val' : Object.keys(x.splits)[0]
  if (!sp) return `${v}: no scored rows`
  const base = s.variants.baseline?.splits[sp]
  const p = s.paired[v]?.[sp]
  if (!base || !p) return `${v} ${sp} ${fmtSplit(x.splits[sp])}, change: ${x.change}`
  return `${v} ${sp} ${fmt(base.mean)} -> ${fmt(x.splits[sp].mean)}, paired ${p.mean >= 0 ? '+' : ''}${fmt(p.mean)} `
    + `[${fmt(p.ci_lo)}, ${fmt(p.ci_hi)}] over ${p.n} cases, ${p.significant ? 'clears noise' : 'within noise'}, `
    + `change: ${x.change}`
}

function replaceBlock(path: string, [open, close]: readonly [string, string], body: string): void {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const start = text.indexOf(open)
  const end = text.indexOf(close, start)
  if (start < 0 || end < 0) throw new Error(`${path}: needs the markers ${open} and ${close}`)
  writeFileSync(path, `${text.slice(0, start + open.length)}\n${body}\n${text.slice(end)}`)
}

// Writes every variant's table.md, the status table in narrative.md and the aggregate table in metrics.md;
// returns the headline line and the lines it skipped.
export function writeSummaries(flow: string): { headline: string; warnings: string[] } {
  const s = summarize(flow)
  for (const v of Object.keys(s.variants)) writeFileSync(join(flow, v, 'table.md'), runTable(flow, v))
  replaceBlock(join(flow, 'narrative.md'), STATUS, statusTable(s))
  replaceBlock(join(flow, 'metrics.md'), AGGREGATE, aggregateTable(s))
  return { headline: headline(s), warnings: s.warnings }
}

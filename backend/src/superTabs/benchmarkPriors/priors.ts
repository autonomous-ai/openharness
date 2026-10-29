/** Benchmark priors (docs/benchmark-priors.md): the public coding-benchmark scores of the models the Swarm routes, turned into
 * the 1-3 quality levels the routing policy uses, per job kind. The table is checked in (data.ts, refreshed by hand with
 * scripts/refresh-benchmark-priors.ts); nothing here reads the network, a Swarm's records or any task text. */
import { z } from 'zod'

/** The fixed job kinds (evidence-routing spec, "Job kinds"). */
export const JOB_KINDS = ['docs', 'tests', 'backend', 'cli', 'desktop', 'mobile', 'security', 'review', 'general'] as const
export type JobKind = (typeof JOB_KINDS)[number]

/** A score counts as level 3 at 85% of the best routed model's score on the same benchmark, level 2 at 55%, else 1. */
export const LEVEL_CUTS = { three: 0.85, two: 0.55 } as const

/** Which benchmarks speak for a job kind, and how much (weights add to 1). A model's ratio for a kind is the weighted mean
 * over the benchmarks it has a score on; the weights are renormalised over those. `null`: no public benchmark measures the
 * kind (security, review), so it has no prior and the hand rating stays. Docs borrow the general mix: no benchmark measures
 * writing docs, and a coding model that cannot pass these is not a safe docs pick either. */
const MIX = { 'swe-bench-verified': 0.5, 'aider-polyglot': 0.2, 'terminal-bench-4.0': 0.3 } as const
export const KIND_WEIGHTS: Record<JobKind, Record<string, number> | null> = {
  docs: MIX,
  tests: { 'aider-polyglot': 0.5, 'swe-bench-verified': 0.25, 'terminal-bench-4.0': 0.25 },
  backend: MIX,
  cli: { 'terminal-bench-4.0': 0.6, 'swe-bench-verified': 0.4 },
  desktop: MIX,
  mobile: MIX,
  security: null,
  review: null,
  general: MIX,
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const https = z.string().url().startsWith('https://').max(500)
const scoreSchema = z.object({
  benchmark: z.string().min(1).max(60),
  /** Percent resolved or passed. */
  score: z.number().min(0).max(100),
  /** The agent harness the score was run in: benchmark numbers depend on it. */
  harness: z.string().trim().min(1).max(120),
  source: https,
  date,
  /** `leaderboard`: read from the benchmark's own board by the refresh script. `model-card`: typed in from a model card. */
  via: z.enum(['leaderboard', 'model-card']),
  /** Anything a reader needs to weigh this number (who reported it, a harness it does not run best in). */
  note: z.string().trim().min(1).max(300).optional(),
}).strict()
const modelSchema = z.object({
  engine: z.enum(['claude', 'codex', 'grid']),
  /** Our model id (costs/prices.ts), the grid name for a grid model. */
  model: z.string().trim().min(1).max(200),
  /** Other names the Swarm calls it (`opus`, `default`). */
  names: z.array(z.string().trim().min(1).max(200)).max(20),
  /** Its names on the benchmark boards, exact (case and punctuation aside). */
  benchmarkNames: z.array(z.string().trim().min(1).max(200)).max(20),
  scores: z.array(scoreSchema).max(20),
  /** Why it has no score, when it has none. */
  noData: z.string().trim().min(1).max(300).optional(),
}).strict()
export const priorsSchema = z.object({
  /** The day the refresh script last read the boards. */
  refreshed: date,
  note: z.string().min(1).max(1000),
  benchmarks: z.array(z.object({ id: z.string().min(1).max(60), name: z.string().min(1).max(120), url: https }).strict()).max(20),
  models: z.array(modelSchema).max(100),
}).strict().superRefine((table, ctx) => {
  const ids = new Set(table.benchmarks.map(b => b.id))
  table.models.forEach((m, i) => m.scores.forEach((s, j) => {
    if (!ids.has(s.benchmark)) ctx.addIssue({ code: 'custom', path: ['models', i, 'scores', j, 'benchmark'], message: 'names no listed benchmark' })
  }))
})
export type PriorsTable = z.infer<typeof priorsSchema>
export type PriorScore = PriorsTable['models'][number]['scores'][number]
export type PriorEngine = PriorsTable['models'][number]['engine']

/** Reads the table. A table that fails its schema gives no priors at all, with a warning: never a partly read one. */
export function loadPriors(raw: unknown): { table: PriorsTable; warnings: string[] } {
  const parsed = priorsSchema.safeParse(raw)
  if (parsed.success) return { table: parsed.data, warnings: [] }
  return { table: { refreshed: '1970-01-01', note: 'unreadable', benchmarks: [], models: [] }, warnings: ['The benchmark priors table is unreadable; no benchmark priors apply.'] }
}

/** A name for matching: lowercase letters and digits only, a dated release (`-20261001`) dropped. */
export const nameKey = (name: string) => name.toLowerCase().replace(/-\d{8}$/, '').replace(/[^a-z0-9]/g, '')

function find(table: PriorsTable, engine: PriorEngine, name: string) {
  const key = nameKey(name)
  return table.models.find(m => m.engine === engine && [m.model, ...m.names].some(n => nameKey(n) === key))
}

export interface PriorLevel {
  quality: 1 | 2 | 3
  /** The weighted share of the best routed score, 0-1. */
  ratio: number
  /** The scores it rests on, in the kind's weight order. */
  sources: Array<Pick<PriorScore, 'benchmark' | 'score' | 'harness' | 'source' | 'date'>>
}

/** The best score each benchmark has among the table's models: what a ratio is measured against. */
function bestScores(table: PriorsTable): Map<string, number> {
  const best = new Map<string, number>()
  for (const m of table.models) for (const s of m.scores) best.set(s.benchmark, Math.max(best.get(s.benchmark) ?? 0, s.score))
  return best
}

/** A model's starting quality level for a job kind, or undefined when the table has nothing for it (the hand rating stays).
 * A model's best score per benchmark counts: efforts and harness variants are merged, as on the leaderboards. */
export function priorLevel(table: PriorsTable, engine: PriorEngine, name: string, kind: JobKind): PriorLevel | undefined {
  const weights = KIND_WEIGHTS[kind]
  const model = weights && find(table, engine, name)
  if (!weights || !model) return undefined
  const best = bestScores(table)
  let weighted = 0
  let total = 0
  const sources: PriorLevel['sources'] = []
  for (const [benchmark, weight] of Object.entries(weights)) {
    const top = model.scores.filter(s => s.benchmark === benchmark).sort((a, b) => b.score - a.score)[0]
    const reference = best.get(benchmark)
    if (!top || !reference) continue
    weighted += weight * (top.score / reference)
    total += weight
    sources.push({ benchmark, score: top.score, harness: top.harness, source: top.source, date: top.date })
  }
  if (total === 0) return undefined
  const ratio = weighted / total
  // 1e-9: a ratio that is exactly a cut (68 of 80) must not lose to float rounding after the weighted mean.
  const quality = ratio + 1e-9 >= LEVEL_CUTS.three ? 3 : ratio + 1e-9 >= LEVEL_CUTS.two ? 2 : 1
  return { quality, ratio, sources }
}

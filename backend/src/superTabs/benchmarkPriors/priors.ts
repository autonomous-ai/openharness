/** Benchmark priors (docs/benchmark-priors.md): the public coding-benchmark scores of the catalog's models, served with it on the
 * routing-policy read (catalog.ts). The table is checked in and edited by hand (data.ts); nothing here reads the network, a
 * Swarm's records or any task text. */
import { z } from 'zod'

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

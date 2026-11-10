/** The routing policy's shape (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md). The tab's routing-policy
 * read serves the built-in policy below, made from the model catalog (catalog.ts); nobody saves one of their own. */
import { z } from 'zod'
import { BENCHMARK_PRIORS } from './benchmarkPriors/data.js'
import { JOB_KINDS, priorLevel, type JobKind, type PriorsTable } from './benchmarkPriors/priors.js'
import { MODEL_CATALOG, type CatalogModel } from './catalog.js'

/** A catalog row as a policy row: its strength is the row's quality, and whether it is offered whether it is enabled. */
const policyRow = (m: CatalogModel) => ({ engine: m.engine, model: m.model, effort: m.effort, quality: m.strength, cost: m.cost, enabled: m.offered })
const quality = z.number().int().min(1).max(3)
const modelRow = z.object({
  engine: z.enum(['claude', 'codex']),
  // `default` keeps the engine's own configured model or effort; no runtime switch is made.
  model: z.string().trim().min(1).max(200),
  effort: z.string().trim().min(1).max(80),
  quality,
  cost: z.number().int().min(1).max(100),
  enabled: z.boolean(),
}).strict()
export const routingPolicySchema = z.object({
  version: z.literal(1),
  models: z.array(modelRow).min(1).max(MODEL_CATALOG.models.length),
  floor: z.object({ low: quality, medium: quality, high: quality }).strict(),
  quotaReserve: z.number().int().min(0).max(90),
  notes: z.string().trim().max(500),
  /** How strong a model served on the Swarm's grid counts (the Local models add-on): `quality` for any model, `models` for
   * those named, first match first (gridQuality). Optional: policies saved before them still parse, and read the defaults. */
  localModels: z.object({ quality, enabled: z.boolean(),
    models: z.array(z.object({ model: z.string().trim().min(1).max(200), quality }).strict()).max(40).optional() }).strict().optional(),
  /** The owner's own quality for a model and job kind, replacing its benchmark prior (benchmarkPriors/priors.ts): the first row
   * whose every word is in the model's name wins, as in `localModels.models`. Optional: policies saved before it still parse. */
  priorOverrides: z.array(z.object({ model: z.string().trim().min(1).max(200), kind: z.enum(JOB_KINDS), quality }).strict()).max(100).optional(),
}).strict()
export type RoutingPolicy = z.infer<typeof routingPolicySchema>

/** The built-in policy: the catalog's rows and grid ratings, with the floors and reserve an older CLI reads. */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  version: 1,
  models: MODEL_CATALOG.models.map(policyRow),
  floor: { low: 1, medium: 2, high: 3 },
  quotaReserve: 10,
  notes: '',
  localModels: { quality: MODEL_CATALOG.grid.strength, enabled: true,
    models: MODEL_CATALOG.grid.models.map(row => ({ model: row.model, quality: row.strength })) },
}

/** A name's words for matching: lowercase letters and digits, "4.1" read as "41" (cli superTabs/route.ts `words`). */
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9.]+/).map(w => w.replace(/\./g, '')).filter(Boolean)

/** Where a starting quality came from: the owner's override, or the benchmark table (with the scores it rests on). */
export type Prior = { quality: number; source: 'owner' } | { quality: number; source: 'benchmark'; ratio: number; sources: NonNullable<ReturnType<typeof priorLevel>>['sources'] }

/** The starting quality of a model for a job kind: the owner's override first, else the benchmark prior, else undefined
 * (the model keeps its hand rating). `model` is the id the Swarm runs it as; `label` the grid label. Pure: no records, no network. */
export function priorFor(policy: RoutingPolicy, run: { engine: 'claude' | 'codex' | 'grid'; model: string; label?: string }, kind: JobKind,
  table: PriorsTable = BENCHMARK_PRIORS): Prior | undefined {
  const name = words(`${run.model} ${run.label ?? ''}`).join('')
  const owner = policy.priorOverrides?.find(row => row.kind === kind && words(row.model).every(w => name.includes(w)))
  if (owner) return { quality: owner.quality, source: 'owner' }
  const level = priorLevel(table, run.engine, run.model, kind)
  return level && { quality: level.quality, source: 'benchmark', ratio: level.ratio, sources: level.sources }
}

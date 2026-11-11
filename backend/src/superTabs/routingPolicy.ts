/** The routing policy's shape (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md). The tab's routing-policy
 * read serves the built-in policy below, made from the model catalog (catalog.ts); nobody saves one of their own. */
import { z } from 'zod'
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

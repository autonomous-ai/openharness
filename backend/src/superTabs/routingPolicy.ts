/** Super Tab routing policy (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md).
 * The account default applies to every tab its owner creates; a tab owner may override single fields.
 * Every field has a built-in default so routing works before anyone opens the form. */
import { z } from 'zod'
import { BENCHMARK_PRIORS } from './benchmarkPriors/data.js'
import { JOB_KINDS, priorLevel, type JobKind, type PriorsTable } from './benchmarkPriors/priors.js'

/** Built-in rows added after owners could save a policy, so saved policies read them too (effectivePolicy). Codex's own default
 *  model, named: GPT-6.1 Sol scores 58.18 on Terminal-Bench 4.0 in Codex (benchmarkPriors/data.ts) and costs Sonnet's API rate
 *  (costs/prices.ts). A start or Reviewer that names it is rated by this row, not as an unknown slug (Lead, 10-30). */
const ADDED_ROWS = [
  { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', quality: 3, cost: 2, enabled: true },
] as const satisfies ReadonlyArray<Record<string, unknown>>
/** An owner keeps exactly up to 40 rows of their own. A built-in row added on read, or the owner's own version of one (the same
 *  engine and model), never counts against that, or a full policy could no longer be saved once read (reviews of #2271). */
const OWN_MODEL_ROWS = 40
type Named = { engine: string; model: string }
const same = (a: Named, b: Named) => a.engine === b.engine && a.model === b.model
const builtIn = (row: Named) => ADDED_ROWS.some(added => same(added, row))

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
const models = z.array(modelRow).min(1).max(OWN_MODEL_ROWS + ADDED_ROWS.length)
  .refine(rows => rows.filter(row => !builtIn(row)).length <= OWN_MODEL_ROWS, `At most ${OWN_MODEL_ROWS} rows of your own.`)
const fields = {
  models,
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
}
export const routingPolicySchema = z.object({ version: z.literal(1), ...fields }).strict()
export const routingOverrideSchema = z.object(fields).partial().strict()
/** What a save accepts: also one row at most per built-in model, so a second copy never rides free of the 40 (review of #2271).
 *  Only saves check it: a policy saved before it still reads as saved, never as unreadable. */
const saved = { ...fields, models: models.superRefine((rows, ctx) => {
  for (const added of ADDED_ROWS) if (rows.filter(row => same(row, added)).length > 1)
    ctx.addIssue({ code: 'custom', message: `Only one row for ${added.engine} ${added.model}.` })
}) }
export const routingPolicySaveSchema = z.object({ version: z.literal(1), ...saved }).strict()
export const routingOverrideSaveSchema = z.object(saved).partial().strict()
export type RoutingPolicy = z.infer<typeof routingPolicySchema>
export type RoutingOverride = z.infer<typeof routingOverrideSchema>
export type RoutingModel = RoutingPolicy['models'][number]

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  version: 1,
  models: [
    { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, enabled: true },
    { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, enabled: true },
    // Next to `default` so the form lists Codex's rows together. List order ranks nothing: the CLI route breaks ties by title.
    ...ADDED_ROWS,
    { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, enabled: true },
    { engine: 'claude', model: 'haiku', effort: 'auto', quality: 1, cost: 1, enabled: true },
  ],
  floor: { low: 1, medium: 2, high: 3 },
  quotaReserve: 10,
  notes: '',
  // Local models are free but weaker: low-difficulty, well-specified work unless the owner says otherwise. Kimi K3 and
  // DeepSeek v4.1 do Sonnet's work (Ken, 2026-10-29: they were offered only for low work and rarely ran).
  localModels: { quality: 1, enabled: true, models: [{ model: 'kimi k3', quality: 2 }, { model: 'deepseek v4.1', quality: 2 }] },
}

export function effectivePolicy(account: unknown, override: unknown) {
  const warnings: string[] = []
  let policy = DEFAULT_ROUTING_POLICY
  let accountModels: RoutingModel[] = []
  if (account !== null && account !== undefined) {
    const parsed = routingPolicySchema.safeParse(account)
    if (parsed.success) { policy = parsed.data; accountModels = parsed.data.models }
    else warnings.push('The account routing policy is unreadable; the built-in default applies.')
  }
  const overridden: Array<keyof RoutingOverride> = []
  if (override !== null && override !== undefined) {
    const parsed = routingOverrideSchema.safeParse(override)
    if (!parsed.success) warnings.push('This Super Tab routing override is unreadable and was ignored.')
    else {
      policy = { ...policy, ...parsed.data }
      overridden.push(...(Object.keys(parsed.data) as Array<keyof RoutingOverride>))
    }
  }
  // A policy saved before a named row was added has no row for that model, which rated it 1: the row joins it. A row of the
  // owner's own for the model, on or off, stays as it is. A tab override saved without it takes the account's row. Either is
  // on only while its engine's `default` row is: an owner who turned Codex off keeps it off (review of #2271).
  const engineOn = (engine: string) => policy.models.some(m => m.engine === engine && m.model === 'default' && m.enabled)
  const missing = ADDED_ROWS.filter(row => !policy.models.some(m => same(m, row))).map((row): RoutingModel => {
    const from = accountModels.find(m => same(m, row)) ?? row
    return { ...from, enabled: from.enabled && engineOn(row.engine) }
  })
  if (missing.length) policy = { ...policy, models: [...policy.models, ...missing] }
  const local = policy.localModels ?? DEFAULT_ROUTING_POLICY.localModels!
  policy = { ...policy, localModels: { ...local, models: local.models ?? DEFAULT_ROUTING_POLICY.localModels!.models } }
  return { policy, warnings, overridden }
}

/** A name's words for matching: lowercase letters and digits, "4.1" read as "41" (cli superTabs/route.ts `words`). */
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9.]+/).map(w => w.replace(/\./g, '')).filter(Boolean)
/** How strong a grid model counts: the first of the policy's named rows whose every word is in its id or label, else the
 *  policy's local quality. The CLI's route rates the same way (cli superTabs/route.ts gridQuality). */
export function gridQuality(policy: RoutingPolicy, model: string, label = ''): number {
  const name = words(`${model} ${label}`).join('')
  const local = policy.localModels ?? DEFAULT_ROUTING_POLICY.localModels!
  return local.models?.find(row => words(row.model).every(w => name.includes(w)))?.quality ?? local.quality
}

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

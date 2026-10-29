/** Super Tab routing policy (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md).
 * The account default applies to every tab its owner creates; a tab owner may override single fields.
 * Every field has a built-in default so routing works before anyone opens the form. */
import { z } from 'zod'

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
const fields = {
  models: z.array(modelRow).min(1).max(40),
  floor: z.object({ low: quality, medium: quality, high: quality }).strict(),
  quotaReserve: z.number().int().min(0).max(90),
  notes: z.string().trim().max(500),
  /** How strong a model served on the Swarm's grid counts (the Local models add-on): `quality` for any model, `models` for
   * those named, first match first (gridQuality). Optional: policies saved before them still parse, and read the defaults. */
  localModels: z.object({ quality, enabled: z.boolean(),
    models: z.array(z.object({ model: z.string().trim().min(1).max(200), quality }).strict()).max(40).optional() }).strict().optional(),
}
export const routingPolicySchema = z.object({ version: z.literal(1), ...fields }).strict()
export const routingOverrideSchema = z.object(fields).partial().strict()
export type RoutingPolicy = z.infer<typeof routingPolicySchema>
export type RoutingOverride = z.infer<typeof routingOverrideSchema>
export type RoutingModel = RoutingPolicy['models'][number]

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  version: 1,
  models: [
    { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, enabled: true },
    { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, enabled: true },
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
  if (account !== null && account !== undefined) {
    const parsed = routingPolicySchema.safeParse(account)
    if (parsed.success) policy = parsed.data
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

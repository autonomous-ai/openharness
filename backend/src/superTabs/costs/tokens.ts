/** Token counts by model, as each Swarm machine reports them for its running agents (cli lib/agentUsageWire.ts) and as an
 *  attempt's route decision keeps them (routeDecisions.ts). Counts only: never text, prompts or folders. */
import { z } from 'zod'

/** A model as the counts name it: the engine's own identifier, or `unknown` (cli lib/agentUsageWire.ts usageModelName). */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/
/** Models one session counts apart; its host files the rest as `unknown`. */
export const MAX_MODELS = 16
/** Swarm agents one machine reports counts for. A machine offers one agent per 2 GB of memory, so even 400 GB is under it. */
export const MAX_HARNESSES = 200

const count = z.number().int().nonnegative().safe()
/** Uncached input, output (reasoning included), cache reads and cache writes. */
export const modelTokensSchema = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count }).strict()
export const tokensByModelSchema = z.record(z.string().regex(MODEL_NAME), modelTokensSchema)
  .refine(v => Object.keys(v).length <= MAX_MODELS, `At most ${MAX_MODELS} models.`)
export type ModelTokens = z.infer<typeof modelTokensSchema>
export type TokensByModel = Record<string, ModelTokens>

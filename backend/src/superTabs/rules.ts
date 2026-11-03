/** The owner's routing rules as older clients save them (docs/plans/2026-10-22-swarm-rules-routing.md). The server enforces
 * none of them (project instructions, phase 4: it refuses only facts and access); routing lives in each project's
 * instructions. The stored rules stay for older readers and the nightly reflection's model names. */
import { z } from 'zod'
import type { Agent, SuperTabState } from './model.js'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const engine = z.enum(['claude', 'codex'])
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const ruleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('forbidModel'), engine: engine.optional(), model: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('machines'), machineIds: z.array(id).min(1).max(50) }).strict(),
  z.object({ kind: z.literal('minEffort'), engine: engine.optional(), effort: z.enum(EFFORTS) }).strict(),
  z.object({ kind: z.literal('preferEngine'), taskKind: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).nullable(), engine }).strict(),
  z.object({ kind: z.literal('preferIdle') }).strict(),
  // Simple work goes to a model on the Swarm's grid first (cli/src/superTabs/route.ts softOf); this owner says not to.
  z.object({ kind: z.literal('noGridFirst') }).strict(),
])
export const ruleTextSchema = z.string().trim().min(1).max(200)
export const askedInSchema = z.object({ conversationId: id, messageId: id }).strict()
/** Per project. */
export const MAX_RULES = 50
/** How long an owner's message can back the rule changes the Lead passes on. */
export const RULE_MESSAGE_MS = 24 * 3_600_000

export interface SwarmRule {
  id: string
  /** The project it was saved for. Absent only on a rule from before rules were per project, until placeRules. */
  projectId?: string
  rule: z.infer<typeof ruleSchema>
  /** The owner's words, shown when the rules are listed. */
  text: string
  askedBy: string
  /** The owner's message a Lead relayed; null when the owner set the rule. */
  askedIn: z.infer<typeof askedInSchema> | null
  addedBy: string
  createdAt: string
}
/** What an agent runs: its machine, engine, model and effort (null when not known). `devices`: those the start that launched
 *  it had its machine check. `gridModel`: a model served on the Swarm's grid that its engine drives. */
export interface RunTarget { machineId: string; engine: string; model: string | null; effort: string | null; devices?: string[]; gridModel?: string
  /** An agent its start launched on the engine's own model, which Codex reports by a slug (leaderboard/record.ts recordRun). */
  launchedDefault?: true
  /** The agent itself. */
  agentId?: string }

const FAMILY = /haiku|sonnet|opus|fable/
/** A rule names a model as the owner said it: `haiku` matches every Haiku id, and `claude-haiku-4-5` also matches a start
 * that asks for the `haiku` alias. `default` is not known, so nothing matches it. */
export function modelMatches(ruleModel: string, model: string | null): boolean {
  const rule = ruleModel.toLowerCase(), target = (model ?? 'default').toLowerCase()
  return target !== 'default' && (target.includes(rule) || (FAMILY.exec(target)?.[0] === target && FAMILY.exec(rule)?.[0] === target))
}

/** A started agent was launched with `--effort`, which Claude never reports back, so its configuration may say `auto`; its
 * start record still holds what it was launched with (manual run 2026-10-19). A command loads only unfinished starts, so
 * whether it was launched on the engine's default is read from the agent itself; the start only for one from before that. */
export function agentTarget(state: SuperTabState, worker: Agent): RunTarget {
  const reported = worker.configuration.effort
  const start = state.starts?.find(s => s.harnessId === worker.harnessId && s.request.machineId === worker.machineId)
  const launched = start?.request.effort
  return { agentId: worker.id, machineId: worker.machineId, engine: worker.configuration.engine, model: worker.configuration.model,
    effort: reported && reported !== 'auto' ? reported : launched ?? reported, devices: start?.request.requirements?.devices ?? [],
    ...(worker.gridModel ? { gridModel: worker.gridModel } : {}), ...(!worker.gridModel && (worker.launchedDefault || (start && !start.request.gridModel && (start.request.model ?? 'default') === 'default'))
      ? { launchedDefault: true as const } : {}) }
}

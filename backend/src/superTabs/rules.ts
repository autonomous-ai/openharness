/** The Swarm owner's routing rules (docs/plans/2026-10-22-swarm-rules-routing.md). Hard rules bind agents: the backend
 * refuses an agent's start, assignment or recorded pick that breaks one, and lets a person through with a warning.
 * Soft rules only rank candidates in the CLI's route. They replaced Jev in routing after the Lead overrode its pick about
 * half the time on 2026-10-22 (Haiku, a stopping agent, low effort) because it did not know the owner's rules. */
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
])
export const ruleTextSchema = z.string().trim().min(1).max(200)
export const askedInSchema = z.object({ conversationId: id, messageId: id }).strict()
/** Per project. */
export const MAX_RULES = 50
/** How long an owner's message can back the rule changes the Lead passes on. */
export const RULE_MESSAGE_MS = 24 * 3_600_000

export interface SwarmRule {
  id: string
  /** The project whose agents the rule binds. Absent only on a rule from before rules were per project, until placeRules. */
  projectId?: string
  rule: z.infer<typeof ruleSchema>
  /** The owner's words, shown when the rules are listed and quoted when one refuses. */
  text: string
  askedBy: string
  /** The owner's message a Lead relayed; null when the owner set the rule. */
  askedIn: z.infer<typeof askedInSchema> | null
  addedBy: string
  createdAt: string
}
/** What would run: a start request, an agent's configuration, or a routed pick. Null when not known. */
export interface RunTarget { machineId: string; engine: string; model: string | null; effort: string | null }

const ENGINE: Record<string, string> = { claude: 'Claude', codex: 'Codex' }
/** `default` and `auto` say nothing about the effort, so they never meet a minimum. */
const rank = (effort: string | null) => EFFORTS.indexOf((effort ?? '') as typeof EFFORTS[number])
const FAMILY = /haiku|sonnet|opus|fable/
/** A rule names a model as the owner said it: `haiku` matches every Haiku id, and `claude-haiku-4-5` also matches a start
 * that asks for the `haiku` alias. `default` is not known, so nothing matches it. */
export function modelMatches(ruleModel: string, model: string | null): boolean {
  const rule = ruleModel.toLowerCase(), target = (model ?? 'default').toLowerCase()
  return target !== 'default' && (target.includes(rule) || (FAMILY.exec(target)?.[0] === target && FAMILY.exec(rule)?.[0] === target))
}

/** Why a hard rule rules the target out, or null when none does. A machines rule names the machines it allows now: a removed
 *  machine leaves the rule but stays in the owner's words (machine.remove). A Mac's Harness Team account is that Mac
 *  ([macOf], machines.ts teamStartRequest), so a rule naming the Mac allows it. */
export function broken(rules: SwarmRule[] | undefined, target: RunTarget, machineName = (id: string) => id,
  macOf: (id: string) => string | undefined = () => undefined): string | null {
  const mac = macOf(target.machineId)
  for (const { rule, text } of rules ?? []) {
    const engineName = ENGINE[target.engine] ?? target.engine
    const out = rule.kind === 'forbidModel' ? (!rule.engine || rule.engine === target.engine)
        && modelMatches(rule.model, target.model) && `${engineName} ${target.model}`
      : rule.kind === 'machines' ? !rule.machineIds.includes(target.machineId) && !(mac && rule.machineIds.includes(mac))
        && `this machine (it allows only ${rule.machineIds.map(machineName).join(', ')})`
      : rule.kind === 'minEffort' ? (!rule.engine || rule.engine === target.engine) && rank(target.effort) < rank(rule.effort)
        && `${engineName} at ${target.effort && rank(target.effort) >= 0 ? `${target.effort} effort` : 'an unnamed effort'}`
      : false
    if (out) return `The owner's rule "${text}" rules out ${out}.`
  }
  return null
}

export const startTarget = (request: { machineId: string; engine: string; model?: string; effort?: string }): RunTarget =>
  ({ machineId: request.machineId, engine: request.engine, model: request.model ?? null, effort: request.effort ?? null })

/** A started agent was launched with `--effort`, which Claude never reports back, so its configuration may say `auto`; its
 * start record still holds what it was launched with (manual run 2026-10-19). */
export function agentTarget(state: SuperTabState, worker: Agent): RunTarget {
  const reported = worker.configuration.effort
  const launched = state.starts?.find(s => s.harnessId === worker.harnessId && s.request.machineId === worker.machineId)?.request.effort
  return { machineId: worker.machineId, engine: worker.configuration.engine, model: worker.configuration.model,
    effort: reported && reported !== 'auto' ? reported : launched ?? reported }
}

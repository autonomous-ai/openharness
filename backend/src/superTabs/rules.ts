/** The Swarm owner's routing rules (docs/plans/2026-10-22-swarm-rules-routing.md). Hard rules bind agents: the backend
 * refuses an agent's start, assignment or recorded pick that breaks one, and lets a person through with a warning.
 * Soft rules only rank candidates in the CLI's route. They replaced Jev in routing after the Lead overrode its pick about
 * half the time on 2026-10-22 (Haiku, a stopping agent, low effort) because it did not know the owner's rules. */
import { z } from 'zod'
import type { Agent, SuperTabState, TaskRequirement } from './model.js'
import { gridQuality, type RoutingPolicy } from './routingPolicy.js'
import { downSince } from './machines.js'
import { canStart, REVIEW_START_MS, standing } from './reviewSeats.js'

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
/** What would run: a start request, an agent's configuration, or a routed pick. Null when not known. `devices` are those its
 *  machine checked are connected: a start's, or the start that launched an agent; absent only for a new agent's pick, whose
 *  start is checked when it is made. `gridModel`: a model served on the Swarm's grid that its engine drives. */
export interface RunTarget { machineId: string; engine: string; model: string | null; effort: string | null; devices?: string[]; gridModel?: string
  /** An agent its start launched on the engine's own model: rated by the policy's `default` row (targetQuality). */
  launchedDefault?: true }

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

/** Said wherever the requirement's machines are not: it never names them, since a reader may not see them. */
export const ANOTHER_MACHINE = 'This task runs only on the machine it requires, and this is another machine.'

/** Why the task's requirement rules the target out, or null when it does not (model.ts TaskRequirement). A Mac's Harness Team
 *  account is that Mac, as for a machines rule. No machine reports its devices to the server, so the only evidence of a device
 *  is a start that asked its machine to check it: an agent without such a start is refused (review of #1829). */
export function unmet(requires: TaskRequirement | undefined, target: RunTarget, macOf: (id: string) => string | undefined = () => undefined): string | null {
  const mac = macOf(target.machineId)
  if (requires?.machines && !requires.machines.includes(target.machineId) && !(mac && requires.machines.includes(mac))) return ANOTHER_MACHINE
  const missing = target.devices ? (requires?.devices ?? []).filter(d => !target.devices!.includes(d)) : []
  const one = missing.length === 1
  return missing.length ? `This task needs ${missing.join(', ')}: only an agent whose start names ${one ? 'it' : 'them'} in its required devices, so its machine checks ${one ? 'it is' : 'they are'} connected, may take it.` : null
}

export const startTarget = (request: { machineId: string; engine: string; model?: string; effort?: string; requirements?: { devices: string[] }; gridModel?: string }): RunTarget =>
  ({ machineId: request.machineId, engine: request.engine, model: request.model ?? null, effort: request.effort ?? null,
    ...(request.requirements ? { devices: request.requirements.devices } : {}), ...(request.gridModel ? { gridModel: request.gridModel } : {}) })

/** A started agent was launched with `--effort`, which Claude never reports back, so its configuration may say `auto`; its
 * start record still holds what it was launched with (manual run 2026-10-19). A command loads only unfinished starts, so
 * whether it was launched on the engine's default is read from the agent itself; the start only for one from before that. */
export function agentTarget(state: SuperTabState, worker: Agent): RunTarget {
  const reported = worker.configuration.effort
  const start = state.starts?.find(s => s.harnessId === worker.harnessId && s.request.machineId === worker.machineId)
  const launched = start?.request.effort
  return { machineId: worker.machineId, engine: worker.configuration.engine, model: worker.configuration.model,
    effort: reported && reported !== 'auto' ? reported : launched ?? reported, devices: start?.request.requirements?.devices ?? [],
    ...(worker.gridModel ? { gridModel: worker.gridModel } : {}), ...(!worker.gridModel && (worker.launchedDefault || (start && !start.request.gridModel && (start.request.model ?? 'default') === 'default'))
      ? { launchedDefault: true as const } : {}) }
}

/** The policy's strength of a subscription model, as the CLI's route rates it (cli superTabs/route.ts rateFor): its named row
 *  (a Claude id by its family), else the engine's `default` row for the engine's own model ([engineDefault]: launched on it),
 *  else 1: a model the policy does not name, a small Codex variant among them, is never taken for a strong one (review of
 *  #2137). */
export function policyQuality(policy: RoutingPolicy, engine: string, model: string | null, effort: string | null, engineDefault = false): number {
  const name = model === null ? 'default' : engine === 'claude' ? FAMILY.exec(model.toLowerCase())?.[0] ?? model : model
  const rowOf = (named: string) => {
    const rows = policy.models.filter(m => m.engine === engine && m.model === named)
    return rows.find(m => m.effort === (effort ?? 'default')) ?? rows[0]
  }
  // A small model it reports is never promoted by its launch (review of ee4ee6c9a).
  return (rowOf(name) ?? (engineDefault && !SMALL.test(model ?? '') ? rowOf('default') : undefined))?.quality ?? 1
}
/** A small variant by its name: a mini or a nano. */
const SMALL = /(^|[^a-z0-9])(mini|nano)([^a-z0-9]|$)/i
/** A target's strength: an agent launched on the engine's own model falls back to the `default` row (Codex reports its slug). */
export const targetQuality = (policy: RoutingPolicy, t: RunTarget) => policyQuality(policy, t.engine, t.model, t.effort, !!t.launchedDefault)
/** How strong an agent counts: a grid model by the policy's grid rating, else as [targetQuality] (cli route.ts reviewedBuilder). */
export const agentQuality = (state: SuperTabState, policy: RoutingPolicy, worker: Agent): number =>
  worker.gridModel ? gridQuality(policy, worker.gridModel, state.starts?.find(s => s.harnessId === worker.harnessId && s.request.machineId === worker.machineId)?.request.gridName ?? '')
    : targetQuality(policy, agentTarget(state, worker))
/** What a route decision says of the work it routed (routeRecord.ts assessment): enough to tell a build a grid model may take. */
export interface RoutedWork { risk: string; kind?: string; local?: true; model?: string }
/** The kinds of build a model on the Swarm's grid takes at low risk (Ken, 2026-10-30), singular or plural (review of #2314):
 *  docs, tests and fixtures. The CLI's route reads the same (cli superTabs/route.ts cheapKind). */
export const cheapKind = (kind: string | undefined) => ['doc', 'test', 'fixture'].includes((kind ?? '').replace(/s$/, ''))
/** Whether a grid model may build [work]: low-risk docs, tests or fixtures, or a person asked for a local model or named one. */
export const gridBuilds = (work: RoutedWork | undefined) => !!work && (!!work.local || !!work.model || (work.risk === 'low' && cheapKind(work.kind)))
/** Why [target] may not build: Builders run at the top tier (Ken and Dee, 2026-10-30: Opus high or Astra xhigh), so a model
 *  the policy rates below 3, Sonnet and Haiku among them, builds only when a person named it; a grid model only what
 *  [gridBuilds] allows (review of #2314: an older CLI still sent other work to the grid). [work] is the linked route
 *  decision's; with none, a grid model is refused and a named model is not known. The CLI's route judges the same (cli
 *  superTabs/route.ts buildRefusals). */
export function buildRefusal(policy: RoutingPolicy, target: RunTarget, work: RoutedWork | undefined): string | null {
  if (target.gridModel) return gridBuilds(work) ? null : GRID_BUILDS
  if (work?.model) return null
  const quality = targetQuality(policy, target)
  return quality >= 3 ? null : `A build needs a model rated 3, and ${ENGINE[target.engine] ?? target.engine} ${target.model ?? 'default'} is ${quality}. `
    + 'Builders run at the top tier unless a person names the model.'
}
export const GRID_BUILDS = 'A model on the Swarm\'s grid builds only low-risk docs, tests or fixtures, unless a person asks for a local model or names one.'
/** A model family: a grid model's own, else its engine's. */
const familyOf = (t: { engine: string; gridModel?: string }) => t.gridModel ? `grid:${t.gridModel}` : t.engine

/** Whether a new Reviewer may run [target] for [contributorId]'s machine: its owner's rules, the task's machine and team
 *  access, as the command judges them. Whether it could start soon is judged apart (reviewSeats.ts). */
export type MayRun = (target: RunTarget, contributorId: string) => boolean
/** Whether a strong Reviewer of another family than [builder]'s could start in this Swarm within REVIEW_START_MS: with an
 *  engine other than the Builder's and an enabled policy row of quality 2 or more that [mayRun] allows there (review of
 *  ee4ee6c9a: an engine the owner rules out blocked the fallback), on a contributed machine that is online, signed in, not
 *  suspended and has that engine's quota now or once a window resets inside the start window, or on a machine an agent of
 *  that engine runs on that is up and not held by a usage limit past it. Busy still counts: a Reviewer frees up. One out of
 *  quota for days, offline or left out by the owner's machines does not (2026-10-30: reviews of Claude builds waited all
 *  morning on Codex machines out of weekly quota). */
export function otherFamilyReviews(state: SuperTabState, builder: { engine: string; gridModel?: string }, policy: RoutingPolicy, mayRun: MayRun, now: number): boolean {
  const pool = (machineId: string) => state.machines?.find(m => m.machineId === machineId)
  const soon = (agent: Agent) => !downSince(state, agent, now) && !(agent.limitedUntil && Date.parse(agent.limitedUntil) - now > REVIEW_START_MS)
  const places = [...state.agents.filter(a => !a.gridModel && !a.buddyOf && soon(a)).map(a => ({ machineId: a.machineId, contributorId: a.contributorId, engines: [a.configuration.engine] })),
    ...(state.machines ?? []).filter(m => !m.buddyOnly && !m.removal).map(m => ({ machineId: m.machineId, contributorId: m.contributorId, engines: m.engines }))]
  // A machine that reports its readings is judged by them; one that does not (an agent's host outside the contributions)
  // by its agent alone, whatever its quota, which nothing reports there. Stricter than the CLI's route on purpose: an
  // unknown counts as a Reviewer that could start, so the same-engine fallback is never taken on a guess.
  const starts = (machineId: string, engine: string) => { const m = pool(machineId); return !m || canStart(standing(state, m, engine, now)) }
  return places.some(place => place.engines.some(engine => familyOf({ engine }) !== familyOf(builder) && starts(place.machineId, engine)
    && policy.models.some(row => row.enabled && row.engine === engine && row.quality >= 2
      && mayRun({ machineId: place.machineId, engine, model: row.model, effort: liftEffort(state.rules, engine, row.effort) }, place.contributorId))))
}
/** The effort a new agent on a row starts at: the row's, or the owner's minimum when the row leaves it to the engine (cli
 *  superTabs/route.ts liftEffort). */
export function liftEffort(rules: SwarmRule[] | undefined, engine: string, effort: string): string {
  if (rank(effort) >= 0) return effort
  const least = Math.max(-1, ...(rules ?? []).flatMap(({ rule }) => rule.kind === 'minEffort' && (!rule.engine || rule.engine === engine) ? [rank(rule.effort)] : []))
  return least < 0 ? effort : EFFORTS[least]!
}

/** How a review on its Builder's own engine starts its route line and its brief (Lead, 2026-10-30; cli superTabs/route.ts). */
export const SAME_ENGINE = 'same-engine review: no Reviewer of another engine has quota'
/** How [target] may review the work of group [reviewed] (Ken, 2026-10-29: a small model never reviews again): never on a model
 *  served on the Swarm's grid or one the policy rates below 2, and on another model family than the reviewed Builder's while
 *  a strong Reviewer of another family can run here. With none, the Builder's own engine at its top tier, noted (Lead,
 *  2026-10-29: a Swarm of one engine keeps its automatic reviews). */
function judgeReview(state: SuperTabState, reviewed: string | undefined, target: RunTarget, policy: RoutingPolicy, mayRun: MayRun, now: number): { refusal: string } | { note: string } | null {
  if (!reviewed) return null
  if (target.gridModel) return { refusal: 'A review never runs on a model served on the Swarm\'s grid.' }
  const quality = targetQuality(policy, target)
  const engine = ENGINE[target.engine] ?? target.engine
  if (quality < 2) return { refusal: `A review needs a model of quality 2 or more, and ${engine} ${target.model} is ${quality}.` }
  const assignment = state.conversations.find(c => c.id === reviewed)?.assignment
  const worker = assignment && state.agents.find(a => a.id === assignment.agentId)
  const builder = worker ? agentTarget(state, worker) : assignment ? { engine: assignment.configuration.engine } : null
  // A grid target was refused above, so the same family is the target's engine.
  if (!builder || familyOf(builder) !== familyOf(target)) return null
  if (otherFamilyReviews(state, builder, policy, mayRun, now)) return { refusal: `A review runs on another engine than the reviewed Builder's, ${engine}.` }
  return quality === 3 ? { note: `${SAME_ENGINE}, so the review runs on ${engine}, the Builder's engine, at its top tier.` }
    : { refusal: `A review on the reviewed Builder's engine, ${engine}, needs its top tier (quality 3): no Reviewer on another engine can start soon in this Swarm.` }
}
/** Why [target] may not review the work of group [reviewed]; null when it may, or nothing is reviewed. */
/** Without the command's own judgement, a machine may run a review where the owner's rules for the reviewed group's project
 *  allow it. */
const ownerAllows = (state: SuperTabState, reviewed: string | undefined): MayRun => {
  const projectId = state.conversations.find(c => c.id === reviewed)?.projectId
  const rules = (state.rules ?? []).filter(r => !r.projectId || !projectId || r.projectId === projectId)
  return target => !broken(rules, target)
}
export function reviewRefusal(state: SuperTabState, reviewed: string | undefined, target: RunTarget, policy: RoutingPolicy, mayRun: MayRun = ownerAllows(state, reviewed),
  now = Date.now()): string | null {
  const judged = judgeReview(state, reviewed, target, policy, mayRun, now)
  return judged && 'refusal' in judged ? judged.refusal : null
}
/** Why [target] reviews on the reviewed Builder's own engine, when it may only because no other engine can; null otherwise. */
export function sameEngineReview(state: SuperTabState, reviewed: string | undefined, target: RunTarget, policy: RoutingPolicy, mayRun: MayRun = ownerAllows(state, reviewed),
  now = Date.now()): string | null {
  const judged = judgeReview(state, reviewed, target, policy, mayRun, now)
  return judged && 'note' in judged ? judged.note : null
}

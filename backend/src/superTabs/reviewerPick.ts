/**
 * Who may take a handed task's review, security review or test step (task #3401, anh Dee's Swarm redesign, 2026-11-05): a
 * free agent of the task's project that never worked on the task, runs no grid model, is at least as strong as its engineer,
 * and gave no verdict at this head. The project instructions' rules that the server now keeps: a Reviewer is never the
 * Engineer of the same task (Roles, Reviewer), two security reviews are independent (Rules for every agent), a model on the
 * grid is never offered for a review (route).
 */
import { isBuddy } from './buddies.js'
import { MODEL_CATALOG, namedDefault } from './catalog.js'
import { roleNameOf } from './instructions.js'
import { activeWork, workerIndex, type Agent, type CheckVerdict, type Conversation, type SuperTabState } from './model.js'
import { agentProjectId, groupProject } from './projects.js'
import { agentTarget, modelMatches } from './rules.js'
import { stepsOf } from './steps.js'
import type { StepKind } from './reviewTable.js'

/** The agents that built [task]: its assignee and every agent its ledger says ran it. */
export function builtBy(task: Conversation): Set<string> {
  const ids = new Set<string>()
  if (task.assignment) ids.add(task.assignment.agentId)
  for (const run of task.ledger?.runs ?? []) if (run.agentId) ids.add(run.agentId)
  return ids
}

/** The catalog's strength of what [agent] runs (catalog.ts), or null: a grid model (never a reviewer), or a model the catalog
 *  does not list. An agent on its engine's own model is rated by the engine's named default. */
export function strengthOf(state: SuperTabState, agent: Agent): number | null {
  if (agent.gridModel) return null
  const target = agentTarget(state, agent)
  const named = target.launchedDefault && !target.model ? namedDefault(target.engine) : null
  const model = named?.model ?? target.model, effort = named?.effort ?? target.effort
  if (!model) return null
  const rows = MODEL_CATALOG.models.filter(row => row.engine === target.engine && modelMatches(row.model, model))
  if (!rows.length) return null
  return (rows.find(row => row.effort === effort) ?? rows.reduce((a, b) => a.strength >= b.strength ? a : b)).strength
}

/** The strongest the catalog rates: what an engineer of unknown strength is taken to be, so its reviewer is never weaker. */
const TOP_STRENGTH = Math.max(...MODEL_CATALOG.models.map(row => row.strength))

/** Roles with work of their own that never take a step (project instructions, Roles): the PM, its Guide and Integrator, a Buddy. */
const NEVER = /^(pm|guide|integrator|buddy)$/i
const ROLE: Record<StepKind, RegExp> = { review: /review/i, security: /review/i, test: /test/i }

/** Whether [verdict] was given at [head]: it names that head, or names none (given before verdicts kept heads, #3394) and came
 *  at or after [readyAt], the task's hand-over. */
const atHead = (verdict: CheckVerdict & { head?: string }, head: string | null, readyAt: number) =>
  verdict.head ? verdict.head === head : verdict.at >= readyAt

/**
 * The agents that may take a [kind] step of [task] at [head], best first: the step's own role (Reviewer, Tester) before any
 * other free agent, then the cheaper of equal standing, then by id. Excluded: anyone that built the task; a grid model, an
 * unknown model or one weaker than the engineer; anyone busy, coordinating a conversation, a Buddy, stopping, or of another
 * project; anyone holding another open step of this task; anyone with a verdict at this head on the task or its steps.
 */
export function reviewerCandidates(state: SuperTabState, task: Conversation, kind: StepKind, head: string | null, readyAt: number): Agent[] {
  const projectId = groupProject(state, task).id
  const index = workerIndex(state)
  const built = builtBy(task)
  const engineer = task.assignment ? state.agents.find(a => a.id === task.assignment!.agentId) : undefined
  const bar = (engineer && strengthOf(state, engineer)) ?? TOP_STRENGTH
  const steps = stepsOf(state, task.id)
  const holding = new Set(steps.filter(step => activeWork(step)).map(step => step.assignment!.agentId))
  const judged = new Set([task, ...steps].flatMap(group => group.checks.flatMap(check => check.verdicts ?? []))
    .filter(verdict => atHead(verdict, head, readyAt)).map(verdict => verdict.by))
  const ranked = state.agents.flatMap(agent => {
    if (built.has(agent.id) || index.leaders.has(agent.id) || index.working.has(agent.id) || holding.has(agent.id)) return []
    if (isBuddy(agent) || agent.workDecision === 'stop' || agentProjectId(state, agent) !== projectId) return []
    if (judged.has(`agent:${agent.id}`)) return []
    const role = roleNameOf(state, agent)
    if (NEVER.test(role)) return []
    const strength = strengthOf(state, agent)
    if (strength === null || strength < bar) return []
    const cost = MODEL_CATALOG.models.find(row => row.engine === agent.configuration.engine && modelMatches(row.model, agent.configuration.model))?.cost ?? Infinity
    return [{ agent, rank: ROLE[kind].test(role) ? 0 : 1, cost }]
  })
  return ranked.sort((a, b) => a.rank - b.rank || a.cost - b.cost || a.agent.id.localeCompare(b.agent.id)).map(entry => entry.agent)
}

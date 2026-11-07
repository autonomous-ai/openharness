/**
 * Who may take a handed task's review, security review or test step (task #3401, anh Dee's Swarm redesign, 2026-11-05): a
 * free agent of the task's project that never worked on the task, runs no grid model, is at least as strong as its engineer
 * (a test step's Tester: a mid-strength model or stronger, task #3774), and gave no verdict at this head. The project instructions' rules that the server now keeps: a Reviewer is never the
 * Engineer of the same task (Roles, Reviewer), two security reviews are independent (Rules for every agent), a model on the
 * grid is never offered for a review (route).
 */
import { isBuddy } from './buddies.js'
import { MODEL_CATALOG, namedDefault } from './catalog.js'
import { roleNameOf } from './instructions.js'
import { activeWork, workerIndex, type Agent, type CheckVerdict, type Conversation, type SuperTabState } from './model.js'
import { agentProjectId, groupProject, onTeamAccount } from './projects.js'
import { agentTarget, modelMatches } from './rules.js'
import { canStart, standing } from './reviewSeats.js'
import { stepsOf } from './steps.js'
import { reportsOs, type StepKind, type StepOs } from './reviewTable.js'

/** The agents that built [task]: its assignee and every agent its ledger says ran it. */
export function builtBy(task: Conversation): Set<string> {
  const ids = new Set<string>()
  if (task.assignment) ids.add(task.assignment.agentId)
  for (const run of task.ledger?.runs ?? []) if (run.agentId) ids.add(run.agentId)
  return ids
}

/** The catalog's row for what [agent] runs (catalog.ts), or undefined: a grid model (never a reviewer), or a model the
 *  catalog does not list. An agent on its engine's own model is rated by the engine's named default. */
function catalogRow(state: SuperTabState, agent: Agent) {
  if (agent.gridModel) return undefined
  const target = agentTarget(state, agent)
  const named = target.launchedDefault && !target.model ? namedDefault(target.engine) : null
  const model = named?.model ?? target.model, effort = named?.effort ?? target.effort
  if (!model) return undefined
  const rows = MODEL_CATALOG.models.filter(row => row.engine === target.engine && modelMatches(row.model, model))
  return rows.find(row => row.effort === effort) ?? rows.reduce<typeof rows[number] | undefined>((a, b) => a && a.strength >= b.strength ? a : b, undefined)
}

/** The catalog's strength of what [agent] runs, or null where catalogRow has none. */
export const strengthOf = (state: SuperTabState, agent: Agent): number | null => catalogRow(state, agent)?.strength ?? null

/** The strongest the catalog rates: what an engineer of unknown strength is taken to be, so its reviewer is never weaker. */
const TOP_STRENGTH = Math.max(...MODEL_CATALOG.models.map(row => row.strength))
/** A test step's bar, whatever the engineer runs (task #3774, Ken's routing rule: "A Tester runs where the change runs: the machine
 *  comes before the model, and a mid-strength model is enough for most testing"): the catalog's middle strength, Sonnet's and
 *  above (Sol, Opus). On 11-06 four Linux test steps waited for an Opus Tester while Sonnet Testers sat idle on that machine. */
export const TEST_STRENGTH = 2

/** The rule [kind]'s pick applies to a model, as the PM's notice names it when a step stays open (commands.ts openReviewSteps). */
export const STRENGTH_RULE: Record<StepKind, string> = {
  review: 'runs a model at least as strong as its engineer and off the grid',
  security: 'runs a model at least as strong as its engineer and off the grid',
  test: 'runs a mid-strength model or stronger (Sonnet, Sol, Opus) off the grid, on the step\'s machine',
}

/** Roles with work of their own that never take a step (project instructions, Roles): the PM, its Guide and Integrator, a Buddy.
 *  By role name, and by the agent's own name too: on the live Swarm the Guides carry the role Reviewer and the Integrator none
 *  (review of #3227), so "Guide", "Guide2" or "Integrator" is never picked whatever role it was started in. */
const NEVER = /^(pm|guide|integrator|buddy)$/i
const NEVER_NAMED = /^(guide|integrator)\d*$/i
const ROLE: Record<StepKind, RegExp> = { review: /review/i, security: /review/i, test: /test/i }

/** Whether [verdict] was given at [head]: it names that whole head (#3394: heads are whole 40-character ids, and a verdict
 *  naming none counts at no head). */
const atHead = (verdict: CheckVerdict & { head?: string }, head: string | null) => !!head && verdict.head === head

/**
 * The agents that may take a [kind] step of [task] at [head], best first: the step's own role (Reviewer, Tester) before any
 * other free agent, then the cheaper of equal standing, then by id. Excluded: anyone that built the task; a grid model, an
 * unknown model or one weaker than the engineer; anyone busy, coordinating a conversation, a Buddy, stopping, or of another
 * project; anyone holding another open step of this task; anyone with a verdict at this head on the task or its steps.
 */
export function reviewerCandidates(state: SuperTabState, task: Conversation, kind: StepKind, head: string | null, now: number, os?: StepOs): Agent[] {
  const projectId = groupProject(state, task).id
  const index = workerIndex(state)
  const built = builtBy(task)
  const engineer = task.assignment ? state.agents.find(a => a.id === task.assignment!.agentId) : undefined
  // A review or security review: at least the engineer's strength. A test: mid-strength or more, whoever built it.
  const bar = kind === 'test' ? TEST_STRENGTH : (engineer && strengthOf(state, engineer)) ?? TOP_STRENGTH
  const steps = stepsOf(state, task.id)
  const holding = new Set(steps.filter(step => activeWork(step)).map(step => step.assignment!.agentId))
  const judged = new Set([task, ...steps].flatMap(group => group.checks.flatMap(check => check.verdicts ?? []))
    .filter(verdict => atHead(verdict, head)).map(verdict => verdict.by))
  const ranked = state.agents.flatMap(agent => {
    if (built.has(agent.id) || index.leaders.has(agent.id) || index.working.has(agent.id) || holding.has(agent.id)) return []
    // Nor a Team account's agent, which takes no new work (task #4120), nor one whose model keeps failing, until it answers again
    // (terminal.ts, task #4076).
    if (isBuddy(agent) || agent.workDecision === 'stop' || onTeamAccount(state, agent) || agent.modelFailing || agentProjectId(state, agent) !== projectId) return []
    if (judged.has(`agent:${agent.id}`)) return []
    const role = roleNameOf(state, agent)
    if (NEVER.test(role) || NEVER_NAMED.test(agent.name) || NEVER_NAMED.test(agent.displayName ?? '')) return []
    // Only the step's own role, Reviewer or Tester, with no other agent standing in (task #3602: #3576's Test went to an Engineer).
    if (!ROLE[kind].test(role)) return []
    // Its machine can start work within the review's wait (reviewSeats.ts): not offline, paused, signed out, suspended or
    // out of quota. A machine the state does not list is not judged here; work.assign's checks still hold it.
    const pool = state.machines?.find(m => m.machineId === agent.machineId && m.contributorId === agent.contributorId)
    if (pool && !canStart(standing(state, pool, agent.configuration.engine, now))) return []
    // A test step for an OS goes to a machine that reports that OS: one reporting another, none, or not listed is never it.
    if (os && !reportsOs(pool?.observation?.resources?.os, os)) return []
    const row = catalogRow(state, agent)
    if (!row || row.strength < bar) return []
    return [{ agent, rank: 0, cost: row.cost }]
  })
  return ranked.sort((a, b) => a.rank - b.rank || a.cost - b.cost || a.agent.id.localeCompare(b.agent.id)).map(entry => entry.agent)
}

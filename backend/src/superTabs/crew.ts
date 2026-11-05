/**
 * A project's crew (task #3397, anh Dee's Swarm redesign, 11-05): named agents the Swarm keeps alive. Their host reopens a
 * crashed or frozen session in place (cli superTabs/crew.ts), and no idle path closes or removes one: the CLI's idle cleanup
 * (its retention names crew), the coordinator's idle notice (tidy.ts) and the removal of closed agents (closedAgents.ts).
 * A crashed crew member keeps its task for CREW_REOPEN_GRACE_MS, while its host reopens it (liveness.ts).
 *
 * The numbers here stay in this one place until the project rules record lands (sibling task of #3397).
 */
import { isBuddy } from './buddies.js'
import { roleNameOf } from './instructions.js'
import { fail, type Actor, type Agent, type SuperTabState } from './model.js'
import { agentProjectId, canReadProject, ledProject, projectOf } from './projects.js'

/** How long a crew member whose session stopped keeps its task while its host reopens it in place. */
export const CREW_REOPEN_GRACE_MS = 5 * 60_000
/** The longest role a crew entry names, in characters. */
export const CREW_ROLE_MAX = 40

export const isCrew = (target: Pick<Agent, 'crew'>): boolean => !!target.crew

/** Who may change [target]'s crew mark: its project's PM, or a person of the project who is not a viewer. */
function mayManageCrew(state: SuperTabState, actor: Actor, target: Agent): void {
  const project = projectOf(state, agentProjectId(state, target))
  const allowed = actor.kind === 'agent'
    ? ledProject(state, actor.agentId)?.id === project.id
    : state.people.find(p => p.id === actor.userId)?.role !== 'viewer' && canReadProject(state, actor, project)
  if (!allowed) fail('FORBIDDEN', 'Only the project\'s PM or a person of the project can change its crew.', 403)
}

/** `crew.add`: marks [target] as crew, with [role] or the role it goes by. Never the PM (kept alive already) nor a Buddy. */
export function addCrew(state: SuperTabState, actor: Actor, target: Agent, role: string | undefined, now: number): void {
  mayManageCrew(state, actor, target)
  if (isBuddy(target)) fail('CREW_BUDDY', 'A Buddy waits for its person; it is never crew.')
  if (ledProject(state, target.id)) fail('CREW_LEAD', 'The PM is already kept alive; it needs no crew mark.')
  target.crew = { role: role ?? roleNameOf(state, target).slice(0, CREW_ROLE_MAX), at: now, by: actor.kind === 'agent' ? actor.agentId : actor.userId }
}

/** `crew.remove`: [target] goes back to the ordinary idle handling. */
export function removeCrew(state: SuperTabState, actor: Actor, target: Agent): void {
  mayManageCrew(state, actor, target)
  delete target.crew
}

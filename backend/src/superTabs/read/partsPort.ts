/**
 * Group 2's parts interface as the read API and the migration consume it (design section 7.2, Lead's ruling (b)). Calls
 * group 2 has not implemented yet throw there. `canReadGroup` moves to projects.ts with group 2; until then it is the
 * section 4.8 predicate here.
 */
import { isLeads, type Actor, type Conversation, type SuperTabState } from '../model.js'
import { canReadProject, groupProject, ledProject } from '../projects.js'

export * as parts from '../parts/index.js'
export type { Audience, GroupData, HeadData, MachineData, Part, PartKind, ProgressData, SwarmParts } from '../parts/index.js'

/** Owners do not read private conversations (owner's decision, design section 8 Q3a). */
const PRIVATE_VISIBLE_TO_OWNERS = false
export function canReadGroup(state: SuperTabState, actor: Actor, group: Conversation): boolean {
  if (isLeads(group)) return actor.kind === 'person' ? state.people.some(p => p.id === actor.userId) : !!ledProject(state, actor.agentId)
  const project = groupProject(state, group)
  if (!canReadProject(state, actor, project)) return false
  if (!group.audience) return true
  if (actor.kind === 'agent') return ledProject(state, actor.agentId)?.id === project.id
  const member = state.people.find(p => p.id === actor.userId)
  return !!member && (group.audience.people.some(p => p.id === member.id && p.generation === member.generation)
    || (PRIVATE_VISIBLE_TO_OWNERS && (member.id === project.ownerId || member.id === state.ownerId)))
}

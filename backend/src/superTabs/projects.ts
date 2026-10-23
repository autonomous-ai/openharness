import { activeWork, agent, author, conversation, fail, isLeads, nextConversationNumber, person, type Actor, type Agent, type Conversation, type SuperTabState } from './model.js'
import type { SwarmRule } from './rules.js'

export type ProjectVisibility = 'public' | 'private'
/** Which built-in skill texts the project's agents get: Default (the team process only) or today's Harness orchestration. */
export type SkillMode = 'default' | 'orchestration'
export const SKILL_MODE_NAMES: Record<SkillMode, string> = { default: 'Default', orchestration: 'Harness orchestration' }
export interface SwarmProject {
  id: string
  name: string
  ownerId: string
  leadConversationId: string
  /** Public means every member of this swarm, never anonymous internet access. */
  visibility: ProjectVisibility
  members: Array<{ id: string; generation: string }>
  updateMinutes: 1 | 5 | 15 | 30
  progress?: {
    dirtyRevision: number
    summarizedRevision: number
    since: number
    requestedRevision: number
    requestedAt?: number
    requestMessageId?: string
  }
  repository?: { machineId: string; cwd: string; repositoryUrl: string | null }
  /** Absent on projects from before skill modes, which keep the texts their agents already run. */
  skillMode?: SkillMode
}

export const skillModeOf = (project: SwarmProject): SkillMode => project.skillMode ?? 'orchestration'

/** Existing tabs are one project; their conversation IDs and messages stay intact. */
export function projectsOf(state: SuperTabState): SwarmProject[] {
  return state.projects ?? [{
    id: 'lead', name: state.name, ownerId: state.ownerId, leadConversationId: 'lead',
    visibility: 'public', members: [], updateMinutes: 5,
    ...(state.project ? { repository: state.project } : {}),
  }]
}

export function projectOf(state: SuperTabState, projectId: string): SwarmProject {
  return projectsOf(state).find(p => p.id === projectId) ?? fail('NOT_FOUND', 'This project is unavailable.', 404)
}

export function groupProject(state: SuperTabState, group: Conversation): SwarmProject {
  if (isLeads(group)) fail('LEADS_CONVERSATION', 'The Leads conversation is only for messages between Leads and people.')
  return projectOf(state, group.projectId ?? 'lead')
}

export function agentProjectId(state: SuperTabState, target: Agent): string {
  return target.projectId ?? state.conversations.find(c => c.agentIds.includes(target.id))?.projectId ?? 'lead'
}

/** The project whose Lead (Product Manager) this agent is: the Lead of that project's Lead conversation. */
export function ledProject(state: SuperTabState, agentId: string): SwarmProject | undefined {
  return projectsOf(state).find(p => state.conversations.some(c => c.id === p.leadConversationId && c.leadId === agentId))
}

/** Whose active work other projects' Leads see and are alerted about. A private project's work stays with its own people:
 *  the Leads conversation is read by the whole Swarm. */
export const sharedWithLeads = (project: SwarmProject): boolean => project.visibility !== 'private'

export function canReadProject(state: SuperTabState, actor: Actor, project: SwarmProject): boolean {
  if (actor.kind === 'agent') {
    const target = state.agents.find(a => a.id === actor.agentId)
    return !!target && target.machineOwnerId === actor.machineOwnerId && agentProjectId(state, target) === project.id
  }
  const member = state.people.find(p => p.id === actor.userId)
  return !!member && (project.visibility === 'public' || project.ownerId === member.id ||
    project.members.some(p => p.id === member.id && p.generation === member.generation))
}

export function readProject(state: SuperTabState, actor: Actor, projectId: string): SwarmProject {
  author(state, actor)
  const project = projectOf(state, projectId)
  if (!canReadProject(state, actor, project)) fail('NOT_FOUND', 'This project is unavailable.', 404)
  return project
}

export function readConversation(state: SuperTabState, actor: Actor, conversationId: string): Conversation {
  const group = conversation(state, conversationId)
  if (isLeads(group)) {
    author(state, actor)
    if (actor.kind === 'agent' && !ledProject(state, actor.agentId)) fail('NOT_FOUND', 'This conversation is unavailable.', 404)
    return group
  }
  readProject(state, actor, groupProject(state, group).id)
  return group
}

export function canReadAgent(state: SuperTabState, actor: Actor, target: Agent): boolean {
  return canReadProject(state, actor, projectOf(state, agentProjectId(state, target)))
}

export function readAgent(state: SuperTabState, actor: Actor, agentId: string): Agent {
  const target = agent(state, agentId)
  if (!canReadAgent(state, actor, target)) fail('AGENT_UNAVAILABLE', 'This agent is unavailable.', 404)
  return target
}

/** A terminal contains its session's entire history. Joining another project's
 * chat must never expose that history to a different audience. */
export function sameProject(state: SuperTabState, group: Conversation, target: Agent): void {
  if (agentProjectId(state, target) !== groupProject(state, group).id) {
    fail('PROJECT_SESSION', 'Start a separate agent for another project. This terminal belongs to its original project.')
  }
}

export function mutableProjects(state: SuperTabState): SwarmProject[] {
  return state.projects ??= projectsOf(state)
}

export function manageProject(state: SuperTabState, actor: Actor, projectId: string): SwarmProject {
  const project = readProject(state, actor, projectId)
  author(state, actor, true)
  if (actor.kind !== 'person' || actor.userId !== project.ownerId) {
    fail('PROJECT_OWNER_REQUIRED', 'Only the project owner can manage this project.', 403)
  }
  mutableProjects(state)
  return projectOf(state, projectId)
}

/** Removes coordination only; the command removes the project's agents first.
 * Pending starts must be reconciled first; terminal-history privacy bindings remain permanent. */
export function deleteProject(state: SuperTabState, actor: Actor, projectId: string): void {
  const project = manageProject(state, actor, projectId)
  const groups = state.conversations.filter(c => !isLeads(c) && groupProject(state, c).id === project.id)
  const groupIds = new Set(groups.map(c => c.id))
  if (state.starts?.some(s => groupIds.has(s.request.conversationId) && !s.error &&
    (!s.harnessId || s.poolGeneration && !s.poolSettled))) {
    fail('STARTS_PENDING', 'Resolve this project’s pending agent starts before deleting it.')
  }
  if (groups.some(activeWork)) fail('WORK_ACTIVE', 'Resolve this project’s active work before deleting it.')
  state.retiredConversationNumber = nextConversationNumber(state) - 1
  state.projects = state.projects!.filter(p => p.id !== project.id)
  state.rules = state.rules?.filter(r => r.projectId !== project.id)
  if (!state.rules?.length) delete state.rules
  state.conversations = state.conversations.filter(c => !groupIds.has(c.id))
  state.starts = state.starts?.filter(s => !groupIds.has(s.request.conversationId))
  // A pending invitation is to the Swarm, not to this project: it lands somewhere that is left instead.
  const landing = inviteLanding(state)
  state.invitations = state.invitations.flatMap(i => !groupIds.has(i.conversationId) ? [i] : landing ? [{ ...i, conversationId: landing }] : [])
  if (project.id === 'lead') {
    delete state.project
    state.machines = state.machines?.filter(m => m.scope === 'swarm')
  }
}

/** Rules were the Swarm's until 2026-10-23, when one project's rules refused every other project's Lead. A rule from then
 * belongs to the project whose chat it was asked in, else to the project of a remaining Lead chat (inviteLanding). */
export function placeRules(state: SuperTabState): void {
  for (const rule of state.rules ?? []) {
    if (rule.projectId) continue
    const asked = rule.askedIn && state.conversations.find(c => c.id === rule.askedIn!.conversationId)
    const landing = state.conversations.find(c => c.id === inviteLanding(state))
    rule.projectId = asked ? groupProject(state, asked).id : landing ? groupProject(state, landing).id : 'lead'
  }
}

export function projectRules(state: SuperTabState, projectId: string): SwarmRule[] {
  return (state.rules ?? []).filter(r => r.projectId === projectId)
}

/** Where an invited person lands: the asked-for group while it exists, else a remaining project's Lead
 * conversation, public first. Desktop asks for the original 'lead' group, which is gone once its project is
 * deleted; on 2026-10-22 that refused every invitation with "This conversation is unavailable". */
export function inviteLanding(state: SuperTabState, preferred?: string): string | null {
  if (preferred && state.conversations.some(c => c.id === preferred)) return preferred
  const projects = projectsOf(state).filter(p => state.conversations.some(c => c.id === p.leadConversationId))
  return (projects.find(p => p.visibility === 'public') ?? projects[0])?.leadConversationId ?? null
}

/** Capture current swarm membership so leaving and rejoining does not restore
 * an old private-project invitation. */
export function projectMembers(state: SuperTabState, ids: string[]) {
  return [...new Set(ids)].map(id => {
    const member = person(state, id)
    return { id, generation: member.generation }
  })
}

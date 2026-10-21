import { activeWork, agent, author, conversation, fail, nextConversationNumber, person, type Actor, type Agent, type Conversation, type SuperTabState } from './model.js'

export type ProjectVisibility = 'public' | 'private'
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
}

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
  return projectOf(state, group.projectId ?? 'lead')
}

export function agentProjectId(state: SuperTabState, target: Agent): string {
  return target.projectId ?? state.conversations.find(c => c.agentIds.includes(target.id))?.projectId ?? 'lead'
}

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

/** Removes coordination only. Native sessions and pending starts must be
 * reconciled first; their terminal-history privacy bindings remain permanent. */
export function deleteProject(state: SuperTabState, actor: Actor, projectId: string): void {
  const project = manageProject(state, actor, projectId)
  const groups = state.conversations.filter(c => groupProject(state, c).id === project.id)
  const groupIds = new Set(groups.map(c => c.id))
  if (state.agents.some(a => agentProjectId(state, a) === project.id)) {
    fail('PROJECT_HAS_AGENTS', 'Stop and remove this project’s agents before deleting it.')
  }
  if (state.starts?.some(s => groupIds.has(s.request.conversationId) && !s.error &&
    (!s.harnessId || s.poolGeneration && !s.poolSettled))) {
    fail('STARTS_PENDING', 'Resolve this project’s pending agent starts before deleting it.')
  }
  if (groups.some(activeWork)) fail('WORK_ACTIVE', 'Resolve this project’s active work before deleting it.')
  state.retiredConversationNumber = nextConversationNumber(state) - 1
  state.projects = state.projects!.filter(p => p.id !== project.id)
  state.conversations = state.conversations.filter(c => !groupIds.has(c.id))
  state.starts = state.starts?.filter(s => !groupIds.has(s.request.conversationId))
  state.invitations = state.invitations.filter(i => !groupIds.has(i.conversationId))
  if (project.id === 'lead') {
    delete state.project
    state.machines = state.machines?.filter(m => m.scope === 'swarm')
  }
}

/** Capture current swarm membership so leaving and rejoining does not restore
 * an old private-project invitation. */
export function projectMembers(state: SuperTabState, ids: string[]) {
  return [...new Set(ids)].map(id => {
    const member = person(state, id)
    return { id, generation: member.generation }
  })
}

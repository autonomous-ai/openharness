import { createHash } from 'node:crypto'
import { activeWork, agent, agentRole, author, conversation, fail, isLeads, nextConversationNumber, person, type Actor, type Agent, type Conversation, type SuperTabState } from './model.js'
import type { SwarmRule } from './rules.js'
import { buddyReads, isBuddy, isBuddyChat } from './buddies.js'

export type ProjectVisibility = 'public' | 'private'
/** Which built-in skill texts the project's agents get: Default (the team process only) or today's Harness orchestration. */
export type SkillMode = 'default' | 'orchestration'
/** What new clients read: a built-in mode, or the project's own custom role set. */
export type SkillSet = SkillMode | 'custom'
export const SKILL_SET_NAMES: Record<SkillSet, string> = { default: 'Default', orchestration: 'Harness orchestration', custom: 'Custom' }
export type RoleKind = 'lead' | 'builder' | 'reviewer'
/** A role of a project's custom set as the tab state keeps it. Its text lives outside the state (store.ts roleText), so a
 *  roster or tab read never carries up to 20 x 64 KB of skill text; `version` names the text. */
export interface ProjectRole { id: string; name: string; kind: RoleKind; version: string }
export const MAX_ROLES = 20
export const roleVersion = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
export interface SwarmProject {
  id: string
  name: string
  ownerId: string
  leadConversationId: string
  /** Public means every member of this swarm, never anonymous internet access. */
  visibility: ProjectVisibility
  members: Array<{ id: string; generation: string }>
  updateMinutes: 1 | 5 | 15 | 30
  /** The morning digest (digest.ts): its local time ("08:00") and zone, and the local date and time of the last one sent. */
  digest?: { time: string; timeZone: string; lastOn?: string; lastAt?: number }
  /** Report watermark per conversation (projectUpdates.ts); kept in its own part (store by parts). */
  progress?: import('./parts/types.js').ProgressData
  repository?: { machineId: string; cwd: string; repositoryUrl: string | null }
  /** Absent on projects from before skill modes, which keep the texts their agents already run. */
  skillMode?: SkillMode
  /** Absent before custom sets. While it is 'custom', skillMode stays 'default' so older clients run the Default text. */
  skillSet?: SkillSet
  /** The project's custom set, kept when the project switches away from it. */
  roles?: ProjectRole[]
}

export const skillModeOf = (project: SwarmProject): SkillMode => project.skillMode ?? 'orchestration'
/** Custom only while the stored mode is still Default: a release from before custom sets switches a project by skillMode
 *  alone during a rolling deploy, and that switch must hold here too. */
export const skillSetOf = (project: SwarmProject): SkillSet =>
  project.skillSet === 'custom' && project.roles && skillModeOf(project) === 'default' ? 'custom' : skillModeOf(project)

/** The Lead is whoever leads the project; every other agent is the kind it was started as. */
export const agentKind = (state: SuperTabState, target: Agent): RoleKind => ledProject(state, target.id) ? 'lead' : agentRole(target)

/** The custom role an agent runs: its own role id while that role is of its kind, else the set's first role of its kind
 *  (agents from before custom sets read as the copied Engineer and Reviewer), else none: its role is gone. */
export function agentSetRole(state: SuperTabState, project: SwarmProject, target: Agent): ProjectRole | null {
  const kind = agentKind(state, target), roles = project.roles ?? []
  return roles.find(r => r.id === target.roleId && r.kind === kind) ?? roles.find(r => r.kind === kind) ?? null
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
  if (!canReadGroup(state, actor, group)) fail('NOT_FOUND', 'This conversation is unavailable.', 404)
  return group
}

/** Whether a project's owner and the Swarm's owner also read its private conversations. The owner decided they do not
 *  (2026-10-26); this is the one place that decides it (design section 4.8). */
export const PRIVATE_VISIBLE_TO_OWNERS = false

/** Who reads a conversation: the Leads conversation's people and Leads; a project conversation's readers; and a private
 *  conversation's listed people (at the generation they were listed with) and the project's Lead, nobody else. A Buddy
 *  chat leaves out the Lead too, and a Buddy reads only its project's chat and its own chat (buddies.ts). */
export function canReadGroup(state: SuperTabState, actor: Actor, group: Conversation): boolean {
  if (isLeads(group)) return actor.kind === 'person' ? state.people.some(p => p.id === actor.userId) : !!ledProject(state, actor.agentId)
  const project = groupProject(state, group)
  if (!canReadProject(state, actor, project)) return false
  const buddy = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId && isBuddy(a)) : undefined
  if (buddy) return buddyReads(buddy, group, project.leadConversationId)
  if (!group.audience) return true
  // A Buddy chat has no private channel to the PM: only its owner and its Buddy read it (buddies.ts).
  if (actor.kind === 'agent') return !isBuddyChat(group) && ledProject(state, actor.agentId)?.id === project.id
  const member = state.people.find(p => p.id === actor.userId)
  return !!member && (group.audience.people.some(p => p.id === member.id && p.generation === member.generation)
    || (PRIVATE_VISIBLE_TO_OWNERS && (member.id === project.ownerId || member.id === state.ownerId)))
}

/** A private conversation's audience: each person a member who reads its project, captured at their generation. */
export function audienceOf(state: SuperTabState, project: SwarmProject, personIds: string[]): NonNullable<Conversation['audience']> {
  return { people: [...new Set(personIds)].map(id => {
    const member = state.people.find(p => p.id === id) ?? fail('INVALID_AUDIENCE', 'List people in this Swarm.', 400)
    if (!canReadProject(state, { kind: 'person', userId: member.id, email: member.email }, project)) {
      fail('INVALID_AUDIENCE', `${member.email} cannot read this project.`, 400)
    }
    return { id: member.id, generation: member.generation }
  }) }
}

export function canReadAgent(state: SuperTabState, actor: Actor, target: Agent): boolean {
  return canReadProject(state, actor, projectOf(state, agentProjectId(state, target)))
}

/** A session that reads people's private messages: its project's Lead (the Product Manager each person chats with privately),
 *  or any agent in a private conversation, so a replaced Lead's earlier screen stays closed too. */
export const confidentialSession = (state: SuperTabState, target: Agent): boolean =>
  !!ledProject(state, target.id) || privateMember(state, target.id)
const privateMember = (state: SuperTabState, agentId: string) => state.conversations.some(c => !!c.audience && c.agentIds.includes(agentId))

/** Whether an agent's session is confidential: marked, or a Lead or private member now, here or (`elsewhere`) in another Swarm. */
export const isConfidential = (state: SuperTabState, target: Agent, elsewhere = false): boolean =>
  !!target.confidential || elsewhere || confidentialSession(state, target)

/** A native session's identity across Swarms: its machine and harness. */
export const sessionKey = (machineId: string, harnessId: string) => `${machineId}\n${harnessId}`
/** The other Swarms' registrations a command is checked against (confidential.ts otherRegistrations), by sessionKey. */
export interface OtherRegistrations { registered: Set<string>; confidential: Set<string> }

/** A confidential session is registered in one Swarm only (Lead ruling, final review Critical 1), so its mark lives exactly as
 *  long as that registration: a command may not register again (add, start, rebind) a session confidential elsewhere, nor make
 *  a session registered elsewhere a Lead or a private conversation's member. Registrations from before the rule stay. */
export function requireSingleRegistration(before: SuperTabState, after: SuperTabState, elsewhere: OtherRegistrations): void {
  const prior = new Map(before.agents.map(a => [a.id, a]))
  for (const target of after.agents) {
    const was = prior.get(target.id), key = sessionKey(target.machineId, target.harnessId)
    if ((!was || was.harnessId !== target.harnessId) && elsewhere.confidential.has(key)) {
      fail('SESSION_CONFIDENTIAL', 'This terminal reads private chats in another Swarm. Start a new agent here.')
    }
    const lead = !!ledProject(after, target.id) && !(was && ledProject(before, target.id))
    const member = privateMember(after, target.id) && !(was && privateMember(before, target.id))
    if ((lead || member) && elsewhere.registered.has(key)) {
      fail('SESSION_CONFIDENTIAL', 'This terminal also works in another Swarm, so it cannot lead or read private chats. Start a new agent for this.')
    }
  }
}

/** A session becomes confidential the moment it is a Lead or in a private conversation, and stays so until it leaves the
 *  Swarm (its session closes), even once that membership ends (Lead ruling, final review Critical 1). */
export function markConfidential(state: SuperTabState): void {
  for (const target of state.agents) if (!target.confidential && confidentialSession(state, target)) target.confidential = true
}

/** Whether a session's terminal is closed to watching in this Swarm. A confidential session's screen and scrollback hold
 *  people's private chats, so only the person whose machine runs it watches it, owners included. The project's current Lead is
 *  the exception, view only (Ken, 2026-10-28): every reader of its project watches it, the private chats it is in included.
 *  It stays marked, so a former Lead, another Swarm and an ordinary share still find it closed. `elsewhere`: the session is
 *  confidential in another Swarm (confidential.ts), whose chats are not this Swarm's to read. */
export const watchClosed = (state: SuperTabState, target: Agent, elsewhere = false): boolean =>
  elsewhere || (isConfidential(state, target) && !ledProject(state, target.id))

/** Who may watch an agent's terminal: observe it or hold a share of it. Reading or typing in it on request is closed by
 *  `isConfidential` alone (terminal.ts mayDrive). Any other agent: every reader of its project, as before. */
export function canWatchAgent(state: SuperTabState, actor: Actor, target: Agent, elsewhere = false): boolean {
  return canReadAgent(state, actor, target) && (!watchClosed(state, target, elsewhere) || ownSession(actor, target))
}

/** Who could watch an agent's terminal before a commit and cannot after it (canWatchAgent, by the session the observer relay
 *  watches: machine, harness and machine owner): a person left, the agent left, its project stopped being shared with them,
 *  or the session turned confidential, by whatever command. Each such agent, with the people who lost it. Its observer
 *  sockets then check again (watchingNarrowed), and those people's terminals on it are revoked (native.ts). */
export function watchersLost(before: SuperTabState, after: SuperTabState): Array<{ agentId: string; personIds: string[] }> {
  const session = (a: Agent) => `${a.machineId}\n${a.harnessId}\n${a.machineOwnerId}`
  const now = new Map(after.agents.map(a => [session(a), a]))
  // canWatchAgent per person, with whether the agent is closed read once per state.
  const watchers = (state: SuperTabState, target: Agent) => {
    const closed = watchClosed(state, target)
    return state.people.map(p => ({ kind: 'person' as const, userId: p.id, email: p.email }))
      .filter(actor => canReadAgent(state, actor, target) && (!closed || ownSession(actor, target)))
  }
  return before.agents.flatMap(target => {
    const was = watchers(before, target)
    if (!was.length) return []
    const still = now.get(session(target))
    const is = new Set(still ? watchers(after, still).map(actor => actor.userId) : [])
    const lost = was.filter(actor => !is.has(actor.userId)).map(actor => actor.userId)
    return lost.length ? [{ agentId: target.id, personIds: lost }] : []
  })
}

/** Whether a commit narrows who may watch any agent's terminal (watchersLost). */
export const watchingNarrowed = (before: SuperTabState, after: SuperTabState): boolean => watchersLost(before, after).length > 0

/** The only actors a confidential session admits: the person whose machine runs it, or the session itself. */
export const ownSession = (actor: Actor, target: Agent): boolean =>
  actor.kind === 'person' ? actor.userId === target.machineOwnerId : actor.agentId === target.id

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

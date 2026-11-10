import { createHash } from 'node:crypto'
import { activeWork, agent, agentRole, author, conversation, fail, isLeads, leadsRemoved, nextConversationNumber, person, type Actor, type Agent, type AgentStart, type AgentStartRequest, type Conversation, type Person, type SuperTabState } from './model.js'
import type { SwarmRule } from './rules.js'
import { buddyReads, isBuddy, isBuddyChat, isSwarmBuddy, isSwarmBuddyChat } from './buddies.js'

export type ProjectVisibility = 'public' | 'private'
/** Which built-in skill texts the project's agents get: Default (the team process only) or today's Harness orchestration. */
export type SkillMode = 'default' | 'orchestration'
/** What new clients read: a built-in mode, or the project's own custom role set. */
export type SkillSet = SkillMode | 'custom'
export const SKILL_SET_NAMES: Record<SkillSet, string> = { default: 'Default', orchestration: 'Harness orchestration', custom: 'Custom' }
export type RoleKind = 'lead' | 'builder' | 'reviewer'
/** A role of a project's custom set as the tab state keeps it. Its text lives outside the state (store.ts roleText), so a
 *  roster or tab read never carries up to 20 x 64 KB of skill text; `version` names the text. */
export interface ProjectRole { id: string; name: string; kind: RoleKind; version: string; defaults?: RoleDefaults }
/** What an agent of a role starts on when its start names no model: an engine, and on it a model and effort. */
export interface RoleDefaults { engine: 'claude' | 'codex'; model?: string; effort?: string }
/** The coordinator's first start runs Claude Opus 5.5 at xhigh when its person names no model (Scholes's roadmap, piece 1,
 *  10-30): the project's instructions cannot choose a model before any agent reads them. No other start takes a default now;
 *  routing lives in the instructions (project instructions, phase 4). */
export const BUILT_IN_ROLE_DEFAULTS: Partial<Record<RoleKind, RoleDefaults>> = { lead: { engine: 'claude', model: 'opus', effort: 'xhigh' } }

/** [request] with its role's [defaults] filled in when it names no model, on the defaults' engine alone; a named effort is kept. A
 *  grid model chooses its own. */
export function withRoleDefaults<T extends { engine: string; model?: string; effort?: string; gridModel?: string }>(request: T, defaults: RoleDefaults | undefined): T {
  if (!defaults || request.model || request.gridModel || defaults.engine !== request.engine || !defaults.model) return request
  const effort = request.effort ?? defaults.effort
  return { ...request, model: defaults.model, ...(effort ? { effort } : {}) }
}
export const MAX_ROLES = 20
export const roleVersion = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
export interface SwarmProject {
  id: string
  name: string
  /** What the project is, in one line (at most 80 characters), set by its owner or Lead (project.about, task #4540): the Cmd-N
   *  and join project list shows it. Absent shows the repository's name. */
  about?: string
  /** The owner's id; '' for a private project whose owner left with no member left to take it (settleOwners): nobody's. */
  ownerId: string
  /** The owner's membership generation when they became its owner (task #3073): the same account at a later membership
   *  owns nothing, as a member's listing works. Absent on projects from before 2026-11-05 until settleOwners fills it; until
   *  then the owner matches by id, as before. */
  ownerGeneration?: string
  leadConversationId: string
  /** Public means every member of this swarm, never anonymous internet access. */
  visibility: ProjectVisibility
  members: Array<{ id: string; generation: string }>
  updateMinutes: 1 | 5 | 15 | 30
  /** The project's board and work process; absent on older projects, which keep Full (task #3896). */
  process?: import('./process.js').ProjectProcess
  /** Tasks up to this number stay Simple after returning to Full. One watermark covers dormant tasks and repeated
   *  switches without loading or rewriting any task history; absent until the first Simple→Full switch (#3896). */
  simpleThrough?: number
  /** The Board way of working (boardRights.ts, task #3819): `boardMode` true once its owner switched it on, absent otherwise;
   *  `canChat` the people its owner granted the right to write in its chat (its owners always have it); `decider` its top
   *  decider, who sets P0 and pauses as its owners do. Every reader of the project reads them. */
  boardMode?: true
  canChat?: string[]
  decider?: string
  /** v3's note of the oldest message a person sent its PM that the PM had not answered, which told its host to restart it while
   *  it hung (task #3385). Swarm v4 writes none and its time checks clear what is left (store.ts runTimeChecks); kept to read and
   *  clear old Swarms. Readers never get it: it may name a message in a person's private chat with the PM. */
  owed?: { messageId: string; since: number }
  /** The status card at the top of the project chat (Dee, 2026-10-31): the coordinator's last project.report text, which
   *  replaces the one before and posts nothing. Read exactly by those who read the project chat (model.ts visibleState). */
  status?: ProjectStatus | null
  /** Report watermark per conversation (projectUpdates.ts); kept in its own part (store by parts). */
  progress?: import('./parts/types.js').ProgressData
  repository?: { machineId: string; cwd: string; repositoryUrl: string | null }
  /** Absent on projects from before skill modes, which keep the texts their agents already run. */
  skillMode?: SkillMode
  /** Absent before custom sets. While it is 'custom', skillMode stays 'default' so older clients run the Default text. */
  skillSet?: SkillSet
  /** The project's custom set, kept when the project switches away from it. */
  roles?: ProjectRole[]
  /** Its Product Manager started by the Swarm on one of its machines, or waiting for one (leadStart.ts). */
  lead?: import('./leadStart.js').LeadPlacement
  /** A Personal Swarm project chat with no Lead: its person's messages sent there, delivered to its Lead once it joins
   *  (leadStart.ts leadWaits). Ids and times only, at most MAX_LEAD_WAITING; cleared when a Lead joins. */
  leadWaiting?: Array<{ id: string; at: number }>
  /** The one start of its Lead a Desktop of its person's claimed (lead.claim), from [machineId]; cleared when a Lead joins. */
  leadClaim?: { id: string; machineId: string; at: number }
  /** Its instructions' revision and short hash (instructions.ts): the text lives outside the state. Absent on a project
   *  from before instructions until the migration writes its document; it runs on the built-in template meanwhile. */
  instructionsRevision?: number
  instructionsHash?: string
  /** The base its instructions were moved onto once (migration/rebase.ts, task #3600): a later save is never rewritten. */
  instructionsBase?: number
  /** Moves on each note the coordinator keeps or a member removes (instructions.ts), so an open panel knows to read them. */
  notesRevision?: number
  /** Moves when its repository's GitHub access may have changed: someone allowed it, GitHub sent someone back after
   *  installing the app, or a check that asked GitHub again found a different answer (store.ts githubChanged, githubSeen).
   *  Members' apps read the access again when it moves rather than keeping it 5 minutes (task #2316, Dee 2026-11-03). */
  githubRevision?: number
  /** What the last check that asked GitHub again found (github/projectAccess.ts), so only a different answer moves it. */
  githubSeen?: GitHubSeen
  /** What its coordinator is called; reads give "Product Manager" when absent (instructions.ts coordinatorNameOf). */
  coordinatorName?: string
  /** Agents answer every person's message in that message's thread, never right below it in the main chat (task #3747, anh
   *  Dee 11-06: "i don't know which one you reply to which"). Absent: as before. Set with `project.answers`. */
  answersInThread?: true
  /** Its owner's last "New repository" from New Project (task #1788): asked, then what GitHub's sign-in made of it. The
   *  app that asked starts the Product Manager in it once `created`; the next ask replaces it. */
  repositoryCreation?: RepositoryCreation
  /** A closed tab's project that had messages (commands.ts project.closeTab, task #3929): read-only and out of the sidebar. */
  archived?: true
}

/** A new repository asked for a project (store.ts startRepositoryCreation, finishRepositoryCreation). [at] (ms) and [by]
 *  name the ask an outcome answers. */
export interface RepositoryCreation {
  owner: string
  name: string
  private: boolean
  by: string
  at: number
  /** 'creating' once GitHub's callback claimed the ask, so a replay of it changes nothing (security review 2 of #3201). */
  state: 'waiting' | 'creating' | 'created' | 'taken' | 'refused' | 'failed' | 'cancelled'
  repositoryUrl?: string
  reachable?: boolean
  reason?: string
}

/** The GitHub access states a check records (github/projectAccess.ts): the others are no answer from GitHub. */
export const GITHUB_SEEN = ['not-installed', 'not-approved', 'covered'] as const
export type GitHubSeen = typeof GITHUB_SEEN[number]

/** A project's status card: its text, when (ISO time) and by which agent it was written. */
export interface ProjectStatus { text: string; at: string; by: string
  /** The text is the coordinator's own lines, shown after the server's (statusCard.ts, task #3593). Absent on a card saved before:
   *  that text was the whole card, whose lines the server now writes, so it is not shown beside them. */
  own?: true
  /** Set by visibleState on the text it shows readers (the server's lines with the coordinator's own): a view applied again to a
   *  view leaves it as it is. Never stored. */
  shown?: true }
export const PROJECT_STATUS_MAX = 2_000

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
  if (isLeads(group)) leadsRemoved()
  // Never the project 'lead' by default: a person's one Buddy chat belongs to no project (Dee, 10-31).
  if (isSwarmBuddyChat(group)) fail('NOT_FOUND', 'This conversation is unavailable.', 404)
  return projectOf(state, group.projectId ?? 'lead')
}

/** The repository address of the project [group] belongs to (null when it has none or the group has no project); never throws. */
export const groupRepositoryUrl = (state: SuperTabState, group: Conversation): string | null =>
  projectsOf(state).find(p => p.id === (group.projectId ?? 'lead'))?.repository?.repositoryUrl ?? null

/** The project a start works in: a project session's own, none for a Swarm-wide Buddy's (Dee, 10-31), else its conversation's. */
export function startProject(state: SuperTabState, request: Pick<AgentStartRequest, 'conversationId' | 'buddySession'>): SwarmProject | undefined {
  if (request.buddySession?.projectId) return projectOf(state, request.buddySession.projectId)
  const group = conversation(state, request.conversationId)
  // A person's Buddy chat and an agent's own chat belong to no project (a Regular agent's start waits in the second).
  return isSwarmBuddyChat(group) || isAgentChat(group) ? undefined : groupProject(state, group)
}

export function agentProjectId(state: SuperTabState, target: Agent): string {
  // A Swarm-wide Buddy has no project (Dee, 10-31): never the project 'lead' by default, so it matches none.
  if (isSwarmBuddy(target)) return NO_PROJECT
  // A Regular agent (task #4116: "the task decides where it works") is its active task's project's while it works, else none.
  if (target.regular) {
    const work = state.conversations.find(c => c.assignment?.agentId === target.id && activeWork(c))
    if (work) return groupProject(state, work).id
    // A Member is its main project's between tasks (task #4697), while its person still reads it: that project's Lead hands it
    // the next task, and it reports its set-up there.
    const main = target.mainProjectId ? projectsOf(state).find(p => p.id === target.mainProjectId) : undefined
    return main && regularMayWorkIn(state, target, main) ? main.id : NO_PROJECT
  }
  // Its 1:1 chat with its person (Swarm v4) is in no project: placed by it, an agent fell back to the project 'lead', which a
  // Swarm whose projects have their own ids does not have, and its host's every read was refused (anh Dee's Mac 3, 2026-11-09).
  return target.projectId ?? state.conversations.find(c => c.agentIds.includes(target.id) && !isAgentChat(c))?.projectId ?? 'lead'
}
/** The project id of an agent in no project: no project has it, so a comparison with one is false and projectOf refuses it. */
export const NO_PROJECT = ''

/** The project whose Lead (Product Manager) this agent is: the Lead of that project's Lead conversation. */
export function ledProject(state: SuperTabState, agentId: string): SwarmProject | undefined {
  // One scan of the conversations, then one of the projects in their order: a scan of every conversation per project was
  // ledProject's callback, 13.5 M calls in the 2026-11-02 prod profiles (12 profiles), mostly from markConfidential.
  const led = new Set<string>()
  for (const c of state.conversations) if (c.leadId === agentId) led.add(c.id)
  return led.size ? projectsOf(state).find(p => led.has(p.leadConversationId)) : undefined
}

/** Gives each project whose owner is gone a new owner (task #3073, River's ruling 2026-11-05): its owner left or was
 *  removed, or is in the Swarm at a later membership. It passes to the earliest listed member still in the Swarm at the
 *  membership they were listed with, who reads it already (one who can manage it first, else a viewer); else, for a public
 *  project, to the Swarm's owner, who reads it too; else it is nobody's ('' owner): nobody reads it, and the Swarm's owner
 *  sees only that it exists and may delete it (deletableProject). A project from before ownerGeneration whose owner is still
 *  here gets their membership now, which is how the migration fills it. Each project that changed hands, in order. */
export function settleOwners(state: SuperTabState): Array<{ projectId: string; from: string; to: string }> {
  const changed: Array<{ projectId: string; from: string; to: string }> = []
  const people = new Map(state.people.map(p => [p.id, p]))
  for (const project of state.projects ?? []) {
    if (!project.ownerId) continue
    const current = people.get(project.ownerId)
    if (current && project.ownerGeneration === undefined) project.ownerGeneration = current.generation
    if (current && project.ownerGeneration === current.generation) continue
    const listed = project.members.filter(m => m.id !== project.ownerId && people.get(m.id)?.generation === m.generation)
    const next = listed.find(m => people.get(m.id)!.role !== 'viewer') ?? listed[0]
    const swarmOwner = people.get(state.ownerId)
    const to = next ? people.get(next.id)! : project.visibility === 'public' && swarmOwner ? swarmOwner : undefined
    changed.push({ projectId: project.id, from: project.ownerId, to: to?.id ?? '' })
    project.ownerId = to?.id ?? ''
    if (to) project.ownerGeneration = to.generation
    else delete project.ownerGeneration
    if (next) project.members = project.members.filter(m => m !== next)
  }
  return changed
}

/** Adds [member] to the Swarm by any way in (invitation, link or domain): its projects are settled first, so
 *  a project from before ownerGeneration whose owner left is never matched to them again (security reviews of #3082). */
export function admitPerson(state: SuperTabState, member: Person): void {
  settleOwners(state)
  settleBoardRights(state)
  state.people.push(member)
}

/** Takes the people [leaving] out of the Swarm (a removal or a leave), and passes their projects on (settleOwners). */
export function dismissPeople(state: SuperTabState, leaving: ReadonlySet<string>): void {
  state.people = state.people.filter(p => !leaving.has(p.id))
  settleOwners(state)
  settleBoardRights(state)
}

/** Takes everyone no longer in the Swarm out of each project's Can chat and decider seat (task #4216). Both name a person by
 *  id only, and any member reads a public project, so without this a person removed and invited back had them again. Run
 *  before a person is admitted too, which clears a right kept from before this ran on leaving. */
function settleBoardRights(state: SuperTabState): void {
  const people = new Set(state.people.map(p => p.id))
  for (const project of state.projects ?? []) {
    if (project.canChat) {
      const kept = project.canChat.filter(id => people.has(id))
      if (kept.length) project.canChat = kept
      else delete project.canChat
    }
    if (project.decider && !people.has(project.decider)) delete project.decider
  }
}

/** Whose active work other projects' Leads see and are alerted about. A private project's work stays with its own people. */
export const sharedWithLeads = (project: SwarmProject): boolean => project.visibility !== 'private'

export function canReadProject(state: SuperTabState, actor: Actor, project: SwarmProject): boolean {
  if (actor.kind === 'agent') {
    const target = state.agents.find(a => a.id === actor.agentId)
    if (!target || target.machineOwnerId !== actor.machineOwnerId) return false
    // A Swarm-wide Buddy reads every project its person reads now, at the membership it was added in (Dee, 10-31).
    if (isSwarmBuddy(target)) return !!buddyPerson(state, target, project)
    const home = agentProjectId(state, target)
    // Swarm v4 (anh Dee, 2026-11-08): an agent acts for its person. In no project and holding no task (tasks are GitHub
    // issues), it reads the public projects its person reads, at the membership it was added in, so it talks in their
    // channels; a task, while it holds one, keeps it to that task's project. Never a private project it was given no task
    // in: its one terminal would carry that project into every other channel (security review 2 of #4116), and once given
    // one, that project alone (regularMayWorkIn). Before, every new agent was out of every channel.
    if (target.regular && home === NO_PROJECT) {
      const person = state.people.find(p => p.id === target.contributorId && p.generation === target.membershipGeneration)
      return !!person && regularMayWorkIn(state, target, project) && (project.visibility === 'public' || target.privateProjectId === project.id)
    }
    return home === project.id
  }
  const member = state.people.find(p => p.id === actor.userId)
  return !!member && personReadsProject(member, project)
}

/** Whether a person in the Swarm, at membership [member], reads [project]: a public one; one they own at this membership (a
 *  project from before the owner's generation was stored matches by id, as ownsProject); one they are listed in at it. Never by a
 *  listing or an ownership from an earlier membership. canReadProject asks it with the Swarm's state; a read that has only the
 *  project and the member row (shipping/service.ts) asks it alone. */
export function personReadsProject(member: Pick<Person, 'id' | 'generation'>,
  project: Pick<SwarmProject, 'visibility' | 'ownerId' | 'ownerGeneration' | 'members'>): boolean {
  return project.visibility === 'public' || (!!member.id && project.ownerId === member.id && (project.ownerGeneration === undefined || project.ownerGeneration === member.generation))
    || (project.members ?? []).some(p => p.id === member.id && p.generation === member.generation)
}

/** Whether [target] is an agent of [project]'s channel (Swarm v4, anh Dee 2026-11-08): one that reads the project as an agent
 *  does (canReadProject), so an agent of the project or a v4 agent in no project, never a Buddy or one stopping. It joins the
 *  channel by posting there or being named there, by --to or by @Name, and talks there with the others by name. */
export function inChannelOf(state: SuperTabState, target: Agent, project: SwarmProject): boolean {
  return !isBuddy(target) && target.workDecision !== 'stop'
    && canReadProject(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }, project)
}

/** Whether [userId] owns [project] now: its owner, in the Swarm at the membership they owned it in (task #3073). A former
 *  owner who left or was removed and came back owns nothing, as a former member reads nothing. A project from before the
 *  generation was stored matches by id until settleOwners fills it. */
export function ownsProject(state: SuperTabState, userId: string, project: SwarmProject): boolean {
  if (!userId || project.ownerId !== userId) return false
  const member = state.people.find(p => p.id === userId)
  return !!member && (project.ownerGeneration === undefined || project.ownerGeneration === member.generation)
}

/** Whom a group's work is for, as its pull requests say (`requestedByLine`): the person who asked for it (`requesterId`) while
 *  they can still read its project, else the project's owner. Until 11-01 it was always the owner, and agents on Tony's Mac
 *  opened Tony's pull requests as Ken's (#2486, #2488, #2491). It names a person only: the GitHub App's token, who gets one
 *  and its commit trailers (store.ts githubAssignment, githubStart) never depend on it. */
export function workRequesterId(state: SuperTabState, project: SwarmProject, group: Conversation | undefined): string {
  const id = group && (group.projectId ?? 'lead') === project.id ? group.requesterId : undefined
  const member = id ? state.people.find(p => p.id === id) : undefined
  return member?.email && canReadProject(state, { kind: 'person', userId: member.id, email: member.email }, project) ? member.id : project.ownerId
}

export function readProject(state: SuperTabState, actor: Actor, projectId: string): SwarmProject {
  author(state, actor)
  const project = projectOf(state, projectId)
  if (!canReadProject(state, actor, project)) fail('NOT_FOUND', 'This project is unavailable.', 404)
  return project
}

export function readConversation(state: SuperTabState, actor: Actor, conversationId: string): Conversation {
  const group = conversation(state, conversationId)
  // Removed for everyone alike (model.ts leadsRemoved): a member of the Swarm reads one plain refusal, nothing of it.
  if (isLeads(group)) {
    author(state, actor)
    leadsRemoved()
  }
  // A person's one Buddy chat has no project: its person and their Buddies read it, and anyone else finds no such chat.
  if (isSwarmBuddyChat(group)) {
    author(state, actor)
    if (!readsSwarmBuddyChat(state, actor, group)) fail('NOT_FOUND', 'This conversation is unavailable.', 404)
    return group
  }
  // A person's chat with a Regular agent of theirs has no project either (agent.new, task #4116): its person and that agent.
  if (isAgentChat(group)) {
    author(state, actor)
    if (!readsAgentChat(state, actor, group)) fail('NOT_FOUND', 'This conversation is unavailable.', 404)
    return group
  }
  // A chat of a project the reader does not read is refused in the same words as one that does not exist: "project
  // unavailable" told another project's chat apart from a made-up id (security review 2 of #2435).
  author(state, actor)
  if (!canReadProject(state, actor, groupProject(state, group)) || !canReadGroup(state, actor, group)) fail('NOT_FOUND', 'This conversation is unavailable.', 404)
  return group
}

/** Whether a project's owner and the Swarm's owner also read its private conversations. The owner decided they do not
 *  (2026-10-26); this is the one place that decides it (design section 4.8). */
export const PRIVATE_VISIBLE_TO_OWNERS = false

/** A Chat with PM from before Buddies replaced it (Ken, 10-29): a private conversation that is no Buddy chat and no Regular agent's
 *  chat (#4248: counted as one, a Regular agent's chat was never listed or delivered). Nobody opens one any more, and nobody reads
 *  one, the PM and its person included; its rows stay in the database. */
export const isClosedPmChat = (group: Pick<Conversation, 'kind' | 'audience'>): boolean => !!group.audience && !isBuddyChat(group) && !isAgentChat(group)

/** Who reads a conversation: nobody the removed Leads conversation (model.ts leadsRemoved); a project conversation's readers; and a Buddy
 *  chat's owner and Buddy (buddies.ts), the PM never. A closed Chat with PM is nobody's. A Buddy reads what its person
 *  reads of its project, no private conversation but its own chat (buddies.ts). */
export function canReadGroup(state: SuperTabState, actor: Actor, group: Conversation): boolean {
  return !isClosedPmChat(group) && readsRecordsIn(state, actor, group)
}

/** Whether [actor] reads the records of [group]: as canReadGroup, and in a closed Chat with PM still its person, at the
 *  generation they were listed with, and the project's Lead, so what was asked there before stays theirs. */
export function readsRecordsIn(state: SuperTabState, actor: Actor, group: Conversation): boolean {
  if (isLeads(group)) return false
  if (isSwarmBuddyChat(group)) return readsSwarmBuddyChat(state, actor, group)
  if (isAgentChat(group)) return readsAgentChat(state, actor, group)
  const project = groupProject(state, group)
  if (!canReadProject(state, actor, project)) return false
  const buddy = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId && isBuddy(a)) : undefined
  if (buddy) return buddyReads(buddy, group, project.leadConversationId, buddyPerson(state, buddy, project))
  if (!group.audience) return true
  // A Buddy chat has no private channel to the PM: only its owner and its Buddy read it (buddies.ts).
  if (actor.kind === 'agent') return !isBuddyChat(group) && ledProject(state, actor.agentId)?.id === project.id
  const member = state.people.find(p => p.id === actor.userId)
  return !!member && (group.audience.people.some(p => p.id === member.id && p.generation === member.generation)
    || (PRIVATE_VISIBLE_TO_OWNERS && (member.id === project.ownerId || member.id === state.ownerId)))
}

/** A person's chat with a Regular agent of theirs (agent.new, task #4116). */
export const isAgentChat = (group: Pick<Conversation, 'kind'>): boolean => group.kind === 'agent-chat'

/** Whether [actor] reads agent chat [group]: its person at the membership it was opened in, and an agent in it that runs on that
 *  person's own account. Nobody else: not the Swarm's owner, a project's owner or PM, or another agent, as a Swarm Buddy chat. */
function readsAgentChat(state: SuperTabState, actor: Actor, group: Conversation): boolean {
  const owner = group.audience?.people[0]
  if (!owner || !state.people.some(p => p.id === owner.id && p.generation === owner.generation)) return false
  if (actor.kind === 'person') return actor.userId === owner.id
  const target = state.agents.find(a => a.id === actor.agentId)
  return !!target && target.machineOwnerId === actor.machineOwnerId && group.agentIds.includes(target.id)
    && target.contributorId === owner.id && target.machineOwnerId === owner.id
}

/** Whether [actor] reads Swarm Buddy chat [group] (Dee, 10-31): its person at the membership it was opened in, and a Buddy in it
 *  of that person and membership. Nobody else: not the Swarm's owner, a project's PM or another agent. */
function readsSwarmBuddyChat(state: SuperTabState, actor: Actor, group: Conversation): boolean {
  const owner = group.audience?.people[0]
  if (!owner || !state.people.some(p => p.id === owner.id && p.generation === owner.generation)) return false
  if (actor.kind === 'person') return actor.userId === owner.id
  const target = state.agents.find(a => a.id === actor.agentId)
  return !!target && target.machineOwnerId === actor.machineOwnerId && group.agentIds.includes(target.id) && isBuddy(target)
    && target.buddyOf!.personId === owner.id && target.buddyOf!.generation === owner.generation
}

/** A Buddy's person, while they read [project] at the membership they added it in: a person who left, rejoined or lost a
 *  private project's membership takes their Buddy's reads with them, the instructions' included (review of phase 2). */
export function buddyPerson(state: SuperTabState, buddy: Agent, project: SwarmProject): Person | undefined {
  const person = state.people.find(p => p.id === buddy.buddyOf!.personId && p.generation === buddy.buddyOf!.generation)
  return person && canReadProject(state, { kind: 'person', userId: person.id, email: person.email }, project) ? person : undefined
}

/** The project whose instructions [buddy] reads for its person (task #3024): any project its person reads now, at the
 *  membership they added it in, a Buddy of one project's included, so it can check a project's rules for them as they would
 *  (Leo, 11-05: his Buddy could not read lamp's). This read alone: its other reads stay with its project. Refused in the words
 *  of a project that does not exist. */
export function buddyInstructionsProject(state: SuperTabState, actor: Actor, buddy: Agent, projectId: string): SwarmProject {
  author(state, actor)
  const project = projectOf(state, projectId)
  if (actor.kind !== 'agent' || actor.agentId !== buddy.id || buddy.machineOwnerId !== actor.machineOwnerId || !isBuddy(buddy)
    || !buddyPerson(state, buddy, project)) fail('NOT_FOUND', 'This project is unavailable.', 404)
  return project
}

export function canReadAgent(state: SuperTabState, actor: Actor, target: Agent): boolean {
  // A Swarm-wide Buddy belongs to no project and writes only in its person's chat: its person reads it, and so does it.
  if (isSwarmBuddy(target)) return actor.kind === 'person' ? actor.userId === target.buddyOf!.personId : actor.agentId === target.id
  // An idle Regular agent (task #4116): its person, itself, and the PM of a project its person reads, which may give it a task.
  if (target.regular && agentProjectId(state, target) === NO_PROJECT) {
    if (actor.kind === 'person') return actor.userId === target.contributorId
    if (actor.agentId === target.id) return true
    const led = ledProject(state, actor.agentId)
    return !!led && regularMayWorkIn(state, target, led)
  }
  return canReadProject(state, actor, projectOf(state, agentProjectId(state, target)))
}

/** A session that reads people's private messages: its project's Lead (the Product Manager each person chats with privately),
 *  or any agent in a private conversation, so a replaced Lead's earlier screen stays closed too. */
export const confidentialSession = (state: SuperTabState, target: Agent, sets: ConfidentialSets = confidentialSets(state)): boolean =>
  sets.leaders.has(target.id) || sets.privateMembers.has(target.id)

/** confidentialSets' answer. A caller that asks about many agents or readers of one state builds it once and passes it down
 *  (task #4504: the host roster rebuilt it for each person on each agent, agents x people passes over the conversations). */
export interface ConfidentialSets { leaders: ReadonlySet<string>; privateMembers: ReadonlySet<string> }

/** Who confidentialSession holds confidential, for every agent at once: the Leads of a project's Lead conversation, and every
 *  member of a private conversation (one with an audience). One pass over the conversations: asking per agent scanned them
 *  per project and agent on every command (markConfidential), 13.5 M of ledProject's callbacks and 1.6 M of the private
 *  member check's in the 2026-11-02 prod profiles. Built per call, never kept on the state, since a command changes it. */
export function confidentialSets(state: SuperTabState): ConfidentialSets {
  const leadChats = new Set(projectsOf(state).map(p => p.leadConversationId))
  const leaders = new Set<string>(), privateMembers = new Set<string>()
  for (const c of state.conversations) {
    if (c.leadId !== null && leadChats.has(c.id)) leaders.add(c.leadId)
    if (c.audience) for (const id of c.agentIds) privateMembers.add(id)
  }
  return { leaders, privateMembers }
}

/** Whether an agent's session is confidential: marked, or a Lead or private member now, here or (`elsewhere`) in another Swarm. */
export const isConfidential = (state: SuperTabState, target: Agent, elsewhere = false, sets?: ConfidentialSets): boolean =>
  !!target.confidential || elsewhere || confidentialSession(state, target, sets)

/** A native session's identity across Swarms: its machine and harness. */
export const sessionKey = (machineId: string, harnessId: string) => `${machineId}\n${harnessId}`
/** The other Swarms' registrations a command is checked against (confidential.ts otherRegistrations), by sessionKey. */
export interface OtherRegistrations { registered: Set<string>; confidential: Set<string> }

/** A confidential session is registered in one Swarm only (Lead ruling, final review Critical 1), so its mark lives exactly as
 *  long as that registration: a command may not register again (add, start, rebind) a session confidential elsewhere, nor make
 *  a session registered elsewhere a Lead or a private conversation's member. Registrations from before the rule stay. */
export function requireSingleRegistration(before: SuperTabState, after: SuperTabState, elsewhere: OtherRegistrations): void {
  const prior = new Map(before.agents.map(a => [a.id, a]))
  const then = confidentialSets(before), now = confidentialSets(after)
  for (const target of after.agents) {
    const was = prior.get(target.id), key = sessionKey(target.machineId, target.harnessId)
    if ((!was || was.harnessId !== target.harnessId) && elsewhere.confidential.has(key)) {
      fail('SESSION_CONFIDENTIAL', 'This terminal reads private chats in another Swarm. Start a new agent here.')
    }
    const lead = now.leaders.has(target.id) && !(was && then.leaders.has(target.id))
    const member = now.privateMembers.has(target.id) && !(was && then.privateMembers.has(target.id))
    if ((lead || member) && elsewhere.registered.has(key)) {
      fail('SESSION_CONFIDENTIAL', 'This terminal also works in another Swarm, so it cannot lead or read private chats. Start a new agent for this.')
    }
  }
}

/** A session becomes confidential the moment it is a Lead or in a private conversation, and stays so until it leaves the
 *  Swarm (its session closes), even once that membership ends (Lead ruling, final review Critical 1). */
export function markConfidential(state: SuperTabState): void {
  // Every command runs this for every agent: one pass for all of them, not one per agent (confidentialSets).
  const { leaders, privateMembers } = confidentialSets(state)
  for (const target of state.agents) if (!target.confidential && (leaders.has(target.id) || privateMembers.has(target.id))) target.confidential = true
}

/** Whether a session's terminal is closed to watching in this Swarm. A confidential session's screen and scrollback hold
 *  people's private chats, so only the person whose machine runs it watches it, owners included. The project's current Lead is
 *  the exception, view only (Ken, 2026-10-28): every reader of its project watches it, the private chats it is in included.
 *  It stays marked, so a former Lead, another Swarm and an ordinary share still find it closed. `elsewhere`: the session is
 *  confidential in another Swarm (confidential.ts), whose chats are not this Swarm's to read. */
export const watchClosed = (state: SuperTabState, target: Agent, elsewhere = false, sets?: ConfidentialSets): boolean =>
  elsewhere || (isConfidential(state, target, false, sets) && !ledProject(state, target.id))

/** Who may watch an agent's terminal: observe it or hold a share of it. Reading or typing in it on request is closed by
 *  `isConfidential` alone (terminal.ts mayDrive). Any other agent: every reader of its project, as before. */
export function canWatchAgent(state: SuperTabState, actor: Actor, target: Agent, elsewhere = false, sets?: ConfidentialSets): boolean {
  if (!canReadAgent(state, actor, target)) return false
  return !watchClosed(state, target, elsewhere, sets) || ownSession(actor, target)
}

/** Notices the server writes in its own words under an agent's name (security reviews of #2570): they quote no agent, task
 *  titles and names aside. */
const SERVER_WORDS: ReadonlySet<unknown> = new Set(['work-stalled', 'work-resumed', 'idle', 'review-capacity', 'overlap', 'pm-switch-notice', 'others-work-notice'])
/** Whose words a row carries, for the mark of another account's (audit M3): its author's (a post, a status row, a brief, a
 *  route's reason); a lost task's notice, its worker's last result; none, a notice in the server's own words. A review's
 *  failed findings name no reviewer: they count as unknown, which is marked. */
export function wordsOf(source: unknown): 'author' | 'none' | 'unknown' | { agentId: string } {
  const row = source as { kind?: unknown; agentId?: unknown } | null | undefined
  if (SERVER_WORDS.has(row?.kind)) return 'none'
  if (row?.kind === 'review-failed') return 'unknown'
  if (row?.kind === 'work-lost') return typeof row.agentId === 'string' ? { agentId: row.agentId } : 'unknown'
  // A Buddy's proposal, posted as its owner: its Buddy wrote the goal and scope and picked the words (security review 2 of #3024).
  if (row?.kind === 'buddy-proposal') {
    const buddyId = (row as { buddyId?: unknown }).buddyId
    return typeof buddyId === 'string' ? { agentId: buddyId } : 'unknown'
  }
  return 'author'
}

/** Who could watch an agent's terminal before a commit and cannot after it (canWatchAgent, by the session the observer relay
 *  watches: machine, harness and machine owner): a person left, the agent left, its project stopped being shared with them,
 *  or the session turned confidential, by whatever command. Each such agent, with the people who lost it. Its observer
 *  sockets then check again (store.ts accessChanged). Most commands change no access input and read nothing here: rebuilding
 *  every viewer on each one cost a 480-group Swarm about 5 ms of every command (item 7, 2026-10-28). */
export function watchersLost(before: SuperTabState, after: SuperTabState): Array<{ agentId: string; personIds: string[] }> {
  if (accessInputs(before) === accessInputs(after)) return []
  const session = (a: Agent) => `${a.machineId}\n${a.harnessId}\n${a.machineOwnerId}`
  const now = new Map(after.agents.map(a => [session(a), a]))
  // canWatchAgent per person, with the confidential sets built once per state, not once per person per agent (task #4504).
  const sets = new Map<SuperTabState, ConfidentialSets>([[before, confidentialSets(before)], [after, confidentialSets(after)]])
  const watchers = (state: SuperTabState, target: Agent) => state.people.map(p => ({ kind: 'person' as const, userId: p.id, email: p.email }))
    .filter(actor => canWatchAgent(state, actor, target, false, sets.get(state)))
  return before.agents.flatMap(target => {
    const was = watchers(before, target)
    if (!was.length) return []
    const still = now.get(session(target))
    const is = new Set(still ? watchers(after, still).map(actor => actor.userId) : [])
    const lost = was.filter(actor => !is.has(actor.userId)).map(actor => actor.userId)
    return lost.length ? [{ agentId: target.id, personIds: lost }] : []
  })
}

/** Everything that decides who reads a conversation and who watches a terminal (canReadGroup, canWatchAgent): when two states
 *  give the same text, no access changed between them. Messages, statuses and
 *  checks, most commands, change none of it. The Swarm's owner counts only once PRIVATE_VISIBLE_TO_OWNERS is true; it is
 *  kept so that turning it on cannot skip a revocation. */
const accessInputs = (state: SuperTabState): string => JSON.stringify([state.ownerId,
  state.people.map(p => [p.id, p.generation, p.role]),
  projectsOf(state).map(p => [p.id, p.visibility, p.ownerId, p.members, p.leadConversationId]),
  state.agents.map(a => [a.id, a.machineId, a.harnessId, a.machineOwnerId, a.projectId, a.confidential]),
  state.conversations.map(c => [c.id, c.kind, c.projectId, c.leadId, c.archived, c.agentIds, c.audience])])

/** Whether [actor] is an agent working in [projectId], as its host speaks for it: any of the project's agents but a Buddy, which
 *  only talks with its owner. Which of them does what is the project's instructions' to say (project instructions, phase 4). */
export function projectAgent(state: SuperTabState, actor: Actor, projectId: string): actor is Extract<Actor, { kind: 'agent' }> {
  if (actor.kind !== 'agent') return false
  const self = state.agents.find(a => a.id === actor.agentId)
  return !!self && !isBuddy(self) && self.machineOwnerId === actor.machineOwnerId && agentProjectId(state, self) === projectId
}

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
/** Whether Regular agent [target] may take a task in [project]: its person reads it (it works only where they could read it
 *  themselves), and, once it has worked in a private project, it is that one: its one conversation holds that project's
 *  content, which no other project's members may hear from it (security review 2 of #4116). Public work moves on freely. */
function regularMayWorkIn(state: SuperTabState, target: Agent, project: SwarmProject): boolean {
  const member = state.people.find(p => p.id === target.contributorId)
  return !!member && canReadProject(state, { kind: 'person', userId: member.id, email: member.email }, project)
    && (!target.privateProjectId || target.privateProjectId === project.id)
}

/** [admitsIdleRegular]: an assignment, the one way an idle Regular agent comes into a project (task #4116), which records its
 *  private mark (commands.ts assignTo), or taking an agent out, which admits nobody. A chat join admits none: added while idle,
 *  it would hear a private project with nothing recorded, or sit in several projects at once (security review 2 of #4116). */
export function sameProject(state: SuperTabState, group: Conversation, target: Agent, admitsIdleRegular = false): void {
  const project = groupProject(state, group)
  // An idle Regular agent takes its task's project, if it may work there; a busy one stays in its task's.
  if (target.regular && agentProjectId(state, target) === NO_PROJECT) {
    if (!admitsIdleRegular) fail('REGULAR_TASK_ONLY', 'A Regular agent joins a project through a task there: give it one.', 403)
    if (regularMayWorkIn(state, target, project)) return
  }
  if (agentProjectId(state, target) !== project.id) {
    fail('PROJECT_SESSION', 'Start a separate agent for another project. This terminal belongs to its original project.')
  }
}

export function mutableProjects(state: SuperTabState): SwarmProject[] {
  return state.projects ??= projectsOf(state)
}

/** The project [actor] may ask a new repository for (task #1788): a person, its owner, while it has no repository address. */
export function repositoryCreator(state: SuperTabState, actor: Actor, projectId: string): SwarmProject {
  if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'A person creates a project\'s repository.', 403)
  const project = readProject(state, actor, projectId)
  author(state, actor, true)
  if (!ownsProject(state, actor.userId, project)) fail('PROJECT_OWNER_REQUIRED', 'Only the project owner can create its repository.', 403)
  if (project.repository?.repositoryUrl) fail('PROJECT_REPOSITORY_SET', 'This project already shares another repository.', 409)
  return project
}

export function manageProject(state: SuperTabState, actor: Actor, projectId: string): SwarmProject {
  const project = readProject(state, actor, projectId)
  author(state, actor, true)
  if (actor.kind !== 'person' || !ownsProject(state, actor.userId, project)) {
    fail('PROJECT_OWNER_REQUIRED', 'Only the project owner can manage this project.', 403)
  }
  mutableProjects(state)
  return projectOf(state, projectId)
}

/** The project [actor] may delete: one they manage, or, for the Swarm's owner, one that is nobody's (settleOwners), which they
 *  may delete but never read (task #3073). */
export function deletableProject(state: SuperTabState, actor: Actor, projectId: string): SwarmProject {
  author(state, actor)
  const project = projectsOf(state).find(p => p.id === projectId)
  if (!project || !isOwnerless(project) || actor.kind !== 'person' || actor.userId !== state.ownerId) return manageProject(state, actor, projectId)
  author(state, actor, true)
  mutableProjects(state)
  return projectOf(state, projectId)
}

/** The account of [project]'s owner, which the GitHub token and a start's preparation name the work for: nobody for a project
 *  nobody owns, never looked up by its empty id, which is no ObjectId (the lookup would throw). */
export async function ownerAccount(users: { findUnique(args: { where: { id: string }; select: { name: true; email: true } }): Promise<{ name: string | null; email: string } | null> },
  project: SwarmProject): Promise<{ name: string | null; email: string } | null> {
  return project.ownerId ? users.findUnique({ where: { id: project.ownerId }, select: { name: true, email: true } }) : null
}

/** A project nobody owns: its owner left with no member left to take it (settleOwners). */
export const isOwnerless = (project: SwarmProject): boolean => !project.ownerId

/** What the Swarm's owner reads of each project nobody owns (task #3073): that it exists, its name and its size (its chats in
 *  this read), never what is in it. Anyone else reads nothing of them. */
export function ownerlessProjects(state: SuperTabState, actor: Actor): Array<{ id: string; name: string; conversations: number }> | undefined {
  if (actor.kind !== 'person' || actor.userId !== state.ownerId) return undefined
  const ownerless = projectsOf(state).filter(isOwnerless)
  return ownerless.length ? ownerless.map(p => ({ id: p.id, name: p.name,
    conversations: state.conversations.filter(c => c.projectId === p.id).length })) : undefined
}

/** How long a start may stay pending before a project delete treats it as stuck: well past the 15 minutes the sweep gives a
 *  dispatched start to prepare (liveness.ts START_PREPARE_MS). */
export const STUCK_START_MS = 60 * 60_000

/** Removes coordination only; the command removes the project's agents first.
 * Pending starts must be reconciled first; terminal-history privacy bindings remain permanent. [orphaned] names the
 * contributed starts still settling whose agent was already removed before this delete: only their machine settles one,
 * and it closed that agent's session when it was removed, so none of them ever settles (2026-11-04: 17 such starts on four
 * Macs, from agents stopped while a project was cleaned up, kept its owner from deleting it). */
export function deleteProject(state: SuperTabState, actor: Actor, projectId: string, orphaned: ReadonlySet<string> = new Set(), now?: number): void {
  const project = deletableProject(state, actor, projectId)
  // A project nobody owns is deleted by the Swarm's owner, who reads nothing of it: no refusal names what is in it, and its
  // work, which nobody can resolve, goes with it.
  const ownerless = isOwnerless(project)
  // A person's one Buddy chat belongs to no project and stays; that project's sessions in it go with their agents. An agent's own
  // chat belongs to no project either (a PM's too since Swarm v4): it stays, and goes with its agent.
  const groups = state.conversations.filter(c => !isLeads(c) && !isSwarmBuddyChat(c) && !isAgentChat(c) && groupProject(state, c).id === project.id)
  const groupIds = new Set(groups.map(c => c.id))
  // A queued start in an archived conversation can never be dispatched (commands.ts open() refuses it), so it no longer
  // blocks the delete; it goes with the project's other starts below. On 2026-11-03 one queued two days earlier kept an
  // owner from deleting a cleaned-up project, and no command could settle it.
  const archived = new Set(groups.filter(c => c.archived).map(c => c.id))
  // A start still pending an hour after it was last asked for is stuck, not starting: the sweep fails a dispatched one
  // within 15 minutes (liveness.ts), so nothing is mid-start there. It goes with the project. On 2026-11-04 the owner was
  // still refused after both fixes above, by starts no read showed them.
  const stuck = (s: AgentStart) => now !== undefined && now - (s.dispatchedAt ?? s.requestedAt ?? 0) > STUCK_START_MS
  const pending = (state.starts ?? []).filter(s => groupIds.has(s.request.conversationId) && !s.error && !stuck(s) &&
    !(!s.dispatched && !s.harnessId && archived.has(s.request.conversationId)) &&
    (!s.harnessId || s.poolGeneration && !s.poolSettled && !orphaned.has(s.id)))
  // Each refusal names what holds it, so its owner can act on it: the ones before named nothing, and no read showed them.
  const titled = (id: string) => groups.find(c => c.id === id)?.title || 'the project chat'
  if (pending.length && ownerless) fail('STARTS_PENDING', 'Agents of this project are still starting. Delete it once they have started or failed, within the hour.')
  if (pending.length) {
    fail('STARTS_PENDING', `Resolve this project’s pending agent starts before deleting it: ${pending.slice(0, 3)
      .map(s => `${s.request.name} in “${titled(s.request.conversationId)}”`).join(', ')}${pending.length > 3 ? ` and ${pending.length - 3} more` : ''}.`)
  }
  const active = ownerless ? [] : groups.filter(activeWork)
  if (active.length) {
    fail('WORK_ACTIVE', `Resolve this project’s active work before deleting it: ${active.slice(0, 3).map(c => `“${titled(c.id)}”`).join(', ')}${
      active.length > 3 ? ` and ${active.length - 3} more` : ''}.`)
  }
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

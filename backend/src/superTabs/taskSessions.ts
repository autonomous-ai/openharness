/**
 * A Member's task sessions (task #4543; spec #4489 section 2, build task 6). A Member is one agent to its person, with two kinds
 * of session the server keeps apart: its chat session talks with its person and can read every project they read, private ones
 * included, so it never runs a task; a task session per project does the work, and outside text (an issue, a pull request, a
 * file) can steer it, so it is an agent of that one project, bound to its scope (sessionScope.ts bindSession) like any of that
 * project's agents, and reads no person's chat, decision or other project.
 *
 * Until build task 9 makes every agent a Member, a person's main Swarm Buddy on a host that says memberProjects is one: its Buddy
 * session is the chat session. Until main projects (build tasks 4 and 7), a Member works only in public projects, and only on
 * a computer where Harness put no private project's files (machines.ts privateOnDisk), since every task session runs under its
 * person's own login and could open them.
 */
import { BUDDY_REQUIREMENTS, isSwarmBuddy } from './buddies.js'
import { admitMachineStart, AGENT_MEMORY_BYTES, machineContribution, MEMBER_PROJECTS_CAPABILITY, noRepositoryStart, projectFolder, startPrivateIds } from './machines.js'
import { agentDisplayName } from './agentNames.js'
import { activeWork, fail, stableId, type Agent, type AgentStart, type AgentStartRequest, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { canReadProject, groupProject, projectsOf } from './projects.js'

/** A Member's task homes hold a worktree of at most this many projects; a sixth drops the one used longest ago. */
export const MEMBER_PROJECTS_MAX = 5

/** Whether [target] is a Member's chat session: a person's main Swarm Buddy whose host keeps task sessions apart from it. */
export function isMember(state: SuperTabState, target: Agent): boolean {
  return isSwarmBuddy(target) && !target.buddySession
    && !!machineContribution(state, target.machineId)?.observation?.capabilities?.includes(MEMBER_PROJECTS_CAPABILITY)
}

/** [member]'s running task session in [projectId], if it has one. */
export const taskSessionOf = (state: SuperTabState, member: Agent, projectId: string): Agent | undefined =>
  state.agents.find(a => a.memberOf === member.id && a.projectId === projectId && a.workDecision !== 'stop' && !a.downSince)

const pendingStart = (state: SuperTabState, startId: string) => state.starts?.some(s => s.id === startId && !s.harnessId && !s.error) ?? false

/** Refuses [member] the task [group], by name, before anything changes. */
export function memberRefusal(state: SuperTabState, member: Agent, group: Conversation): void {
  const name = member.displayName ?? member.name
  const project = groupProject(state, group)
  const person = state.people.find(p => p.id === member.buddyOf!.personId && p.generation === member.buddyOf!.generation)
  if (!person || !canReadProject(state, { kind: 'person', userId: person.id, email: person.email }, project)) {
    fail('MEMBER_CANNOT_READ', `${name}'s person can't read this project, so ${name} takes no task in it.`, 403)
  }
  if (project.visibility === 'private') fail('MEMBER_PRIVATE', `${name} works only in public projects for now. Assign one of this project's agents.`, 403)
  const pool = machineContribution(state, member.machineId)
  // Until its host has said what is on its disk, nothing says it holds no private files (security review 1 of #3553).
  if (!pool?.observation?.projectsOnDisk) fail('MEMBER_DISK_UNREAD', `${pool?.name ?? 'This computer'} hasn't said what's on its disk yet. Try again in a minute.`, 409)
  if (privateHere(state, member.machineId).length) {
    fail('MEMBER_PRIVATE_ON_DISK', `${pool.name} holds files of a private project or of another Swarm, so ${name} takes no task from another project there.`, 403)
  }
  const sessions = new Set(state.agents.filter(a => a.memberOf === member.id).map(a => a.id))
  if (state.conversations.some(c => activeWork(c) && sessions.has(c.assignment!.agentId)
    || c.sessionStart?.memberId === member.id && pendingStart(state, c.sessionStart.startId))) {
    fail('MEMBER_BUSY', `${name} is on another task. Assign it when that one is done.`, 409)
  }
}

/** The private projects whose files are on [machineId], or on their way there in a start not yet running. */
function privateHere(state: SuperTabState, machineId: string): string[] {
  const pool = machineContribution(state, machineId)
  const pending = (state.starts ?? []).filter(s => s.request.machineId === machineId && !s.harnessId && !s.error).flatMap(s => startPrivateIds(state, s))
  // A private project's own folder is on this computer (its repository was recorded here), or this machine serves one project
  // only and its folder is that project's (machines.ts projectFolder): files no start of the Swarm's put there.
  const projects = projectsOf(state)
  const own = projects.filter(p => p.visibility === 'private' && (p.repository?.machineId === machineId || (!!pool && pool.scope !== 'swarm' && p.id === 'lead')))
  // A project its host lists that this Swarm has no record of is another Swarm's, or one deleted here: counted as private.
  const unknown = (pool?.observation?.projectsOnDisk ?? []).some(id => !projects.some(p => p.id === id))
  return [...new Set([...pool?.privateOnDisk ?? [], ...pending, ...own.map(p => p.id), ...pool?.observation?.otherSwarms || unknown ? [OTHER_SWARM] : []])]
}
/** Stands for another Swarm's projects on this computer, whose privacy this Swarm cannot read. */
const OTHER_SWARM = 'another-swarm'

/** Why a task session's work ends (liveness.ts lostReason). */
export const PRIVATE_BESIDE = 'its computer holds another, private project\'s files'

/** Whether [session], a Member's task session, is on a computer with a private project's files other than its own project's,
 *  there or on their way: it takes no work there (security review 2 of #3553). */
export const besidePrivate = (state: SuperTabState, session: Agent): boolean => !!session.memberOf
  && (projectsOf(state).find(p => p.id === session.projectId)?.visibility !== 'public' || privateHere(state, session.machineId).some(id => id !== session.projectId))

/** Refuses [start], which puts a private project's files on its computer, while a Member's task session of another project still
 *  runs there: it waits for them to stop (liveness.ts endBesidePrivate), then its host dispatches it again. */
export function privateStartRefusal(state: SuperTabState, start: AgentStart): void {
  const privateIds = startPrivateIds(state, start)
  if (!privateIds.length) return
  const live = state.agents.some(a => a.memberOf && a.machineId === start.request.machineId && !a.downSince && !privateIds.includes(a.projectId!))
  if (live) fail('PRIVATE_WAITS', 'This computer is first stopping a Member\'s work in another project. It starts in a moment.', 409)
}

/** Moves [projectId] to the end of [member]'s held projects, the most recently used last, dropping [drop]; at most five. */
function hold(member: Agent, projectId: string, drop?: string): void {
  member.projectsHeld = [...(member.projectsHeld ?? []).filter(id => id !== projectId && id !== drop), projectId].slice(-MEMBER_PROJECTS_MAX)
}

/** Records that [member]'s task session [session] takes a task in its project now. */
export const sessionAssigned = (member: Agent, session: Agent): void => hold(member, session.projectId!)

/**
 * Queues [member]'s task session for [group]'s project, and holds [group] for it until it runs (taskSessionJoined). The start is
 * its person's own, on its own computer, as its Buddy's was: its host carries it on. A sixth project names the held one used
 * longest ago, which its host removes first when clean and pushed, or fails the start.
 */
export function startTaskSession(state: SuperTabState, member: Agent, group: Conversation, id: string, now: number,
  machines: { teamMachines?: readonly string[]; otherWorkspaceMachines?: readonly string[] }): AgentStart {
  const project = groupProject(state, group)
  const pool = machineContribution(state, member.machineId) ?? fail('MACHINE_NOT_LISTED', 'This Member\'s computer is not in the Swarm.', 409)
  const held = member.projectsHeld ?? []
  const drop = !held.includes(project.id) && held.length >= MEMBER_PROJECTS_MAX ? held[0] : undefined
  const request: AgentStartRequest = noRepositoryStart(pool, project, { conversationId: group.id, machineId: pool.machineId,
    engine: member.configuration.engine, ...(member.configuration.model ? { model: member.configuration.model } : {}),
    name: member.displayName ?? member.name, cwd: projectFolder(pool, project), worktree: true,
    requirements: { ...BUDDY_REQUIREMENTS, memoryBytes: AGENT_MEMORY_BYTES },
    memberOf: member.id, memberProject: { id: project.id, name: project.name }, ...(drop ? { dropProjectId: drop } : {}) })
  const admitted = admitMachineStart(state, request, now, undefined, machines.teamMachines, machines.otherWorkspaceMachines)!
  state.starts ??= []
  if (state.starts.filter(s => !s.harnessId && !s.error).length >= 32) fail('STARTS_PENDING', 'Reconcile pending agent starts before adding more.')
  const person = state.people.find(p => p.id === member.contributorId)!
  const start: AgentStart = { poolGeneration: admitted.generation, id, creationId: `super-${id}`, actorKey: `person:${person.id}`,
    contributorId: person.id, membershipGeneration: person.generation, machineOwnerId: member.machineOwnerId, hostGrant: null, request,
    harnessId: null, dispatched: false, error: null, requestedAt: now }
  state.starts.push(start)
  group.sessionStart = { startId: id, memberId: member.id, at: now }
  return start
}

/**
 * [start]'s task session [session] runs: it is its Member's in its project, the Member holds that project (and no longer the one
 * its host dropped for it, whose session stops), and it takes the task held for it, unless someone else took it meanwhile.
 */
export function taskSessionJoined(state: SuperTabState, start: AgentStart, session: Agent): void {
  const member = state.agents.find(a => a.id === start.request.memberOf)
  session.memberOf = start.request.memberOf!
  if (member) hold(member, session.projectId!, start.request.dropProjectId)
  for (const old of state.agents) {
    if (old.memberOf !== session.memberOf || old.id === session.id) continue
    if (old.projectId === session.projectId || old.projectId === start.request.dropProjectId) old.workDecision = 'stop'
  }
}

/** The task held for [start]'s task session, once it settled: no longer held, and to assign unless someone took it meanwhile. */
export function heldFor(state: SuperTabState, start: AgentStart): Conversation | null {
  const group = state.conversations.find(c => c.id === start.request.conversationId)
  if (!group || group.sessionStart?.startId !== start.id) return null
  delete group.sessionStart
  return activeWork(group) ? null : group
}

/** [start] failed: the task held for it waits again. */
export function taskSessionFailed(state: SuperTabState, start: AgentStart): void {
  const group = state.conversations.find(c => c.id === start.request.conversationId)
  if (group?.sessionStart?.startId === start.id) delete group.sessionStart
}

/** The operation id of a Member's task-session start, from the assignment's own. */
export const taskSessionStartId = (operationId: string): string => stableId(operationId, 'task-session')

/**
 * [machineId]'s host reports, per Member, the projects its task home holds set up (machines.ts memberSetUp). Each one new to the
 * list is said once, by its task session to its project's Lead, in the project's chat: "Ready to work on harness." One the list
 * leaves out was dropped there, and leaves the Member's held projects, unless a task session of it is starting there again.
 */
export function applyMemberSetUp(state: SuperTabState, machineId: string, report: Record<string, string[]> | undefined, now: number): MessageDraft[] {
  if (!report) return []
  const rows: MessageDraft[] = []
  const projects = projectsOf(state)
  for (const member of state.agents.filter(a => a.machineId === machineId && isSwarmBuddy(a) && !a.buddySession && report[a.id])) {
    // Public projects only: a public project's Lead reads this record (projects.ts canReadAgent).
    // And only its own task sessions' projects: a host can't put another project on it (security review 1 of #3553).
    const listed = [...new Set(report[member.id])].filter(id => projects.some(p => p.id === id && p.visibility === 'public')
      && state.agents.some(a => a.memberOf === member.id && a.projectId === id)).slice(0, MEMBER_PROJECTS_MAX)
    const before = member.setUp ?? []
    const next = listed.map(id => before.find(e => e.projectId === id) ?? { projectId: id, at: now })
    for (const entry of next.filter(e => !before.some(b => b.projectId === e.projectId))) {
      const project = projects.find(p => p.id === entry.projectId)!
      const session = state.agents.find(a => a.memberOf === member.id && a.projectId === project.id && a.workDecision !== 'stop')
      const lead = state.conversations.find(c => c.id === project.leadConversationId)?.leadId
      if (!session) continue
      rows.push({ id: stableId('member-ready', member.id, project.id, String(now)), conversationId: project.leadConversationId, replyTo: null,
        author: { kind: 'agent', id: session.id, name: session.name, displayName: agentDisplayName(state.agents, session.id),
          membershipGeneration: session.membershipGeneration },
        text: `Ready to work on ${project.name}.`, recipients: lead ? [lead] : [] })
    }
    if (next.length) member.setUp = next
    else delete member.setUp
    const starting = new Set((state.starts ?? []).filter(s => s.request.memberOf === member.id && !s.harnessId && !s.error)
      .map(s => s.request.memberProject!.id))
    const held = (member.projectsHeld ?? []).filter(id => listed.includes(id) || starting.has(id))
    if (held.length) member.projectsHeld = held
    else delete member.projectsHeld
  }
  return rows
}

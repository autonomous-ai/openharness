/**
 * The board's pulse (task #3384, anh Dee's Swarm redesign, 11-05): what each project's PM owes and who works, from stored
 * state, shown to everyone on the board so nothing waits unseen. On 11-05 the board showed Working 0 and five people's asks
 * unanswered for 3-10 h: nothing tracked what the PM owed, and the idle checks ran only on the PM's poll.
 *
 * An owed ask is a person's message that reached the PM, kept on its conversation (`Conversation.owed`) until the PM answers
 * it in its place (a reply in its thread, or an answer right below it), gives it a verdict reaction, or opens a task from it.
 * Nothing here refuses anything: a settle that finds nothing does nothing.
 */
import { isBuddy, isBuddyChat } from './buddies.js'
import { isLeads, type Author, type Conversation, type SuperTabState } from './model.js'
import { agentProjectId, groupProject, type SwarmProject } from './projects.js'

/** One person's message to the PM not settled yet: its id, who wrote it, when, and the root of the thread it is in (its own
 *  id for a top-level message). */
export interface OwedAsk { id: string; personId: string; at: number; thread: string }

/** At most this many asks are kept per conversation, the newest: a growth bound, far above what a PM leaves unanswered. */
export const MAX_OWED = 50
/** The reactions that answer an ask (reactions.ts): a verdict. Eyes says the PM saw it, and it still owes the answer. */
export const VERDICT_REACTIONS: ReadonlySet<string> = new Set(['check', 'thumbs_up', 'rocket', 'tada'])

/** The project [group] belongs to, or none for a conversation outside every project (the removed Leads chat, a person's one
 *  Buddy chat). Never throws: the pulse is never a reason for a command to fail. */
function projectOfGroup(state: SuperTabState, group: Conversation): SwarmProject | undefined {
  if (isLeads(group) || group.kind === 'swarm-buddy') return undefined
  try { return groupProject(state, group) } catch { return undefined }
}

/** The agent leading [project]: its chat's Lead. */
export function pmOf(state: SuperTabState, project: SwarmProject): string | null {
  return state.conversations.find(c => c.id === project.leadConversationId)?.leadId ?? null
}

/** Whether asks in [group] count: a project's chat or task, never a private chat or a Buddy chat, whose words and people only
 *  their audience reads (the pulse is shown to every reader of the project). */
const counted = (group: Conversation): boolean => !group.audience && !group.kind && !isBuddyChat(group)

/** Records [message] as owed when a person wrote it and it reached [group]'s PM. */
export function owe(state: SuperTabState, group: Conversation, message: { id: string; author: Author; recipients: readonly string[]; thread: string | null; source?: unknown }, now: number): void {
  if (message.author.kind !== 'person' || message.source || !counted(group)) return
  const project = projectOfGroup(state, group)
  const pm = project && pmOf(state, project)
  if (!pm || !message.recipients.includes(pm)) return
  group.owed = [...(group.owed ?? []).filter(ask => ask.id !== message.id), { id: message.id, personId: message.author.id, at: now, thread: message.thread ?? message.id }]
    .slice(-MAX_OWED)
}

function settle(group: Conversation, settled: (ask: OwedAsk) => boolean): void {
  if (!group.owed) return
  const left = group.owed.filter(ask => !settled(ask))
  if (left.length === group.owed.length) return
  if (left.length) group.owed = left
  else delete group.owed
}

const byPm = (state: SuperTabState, group: Conversation, agentId: string): boolean => {
  const project = projectOfGroup(state, group)
  return !!project && pmOf(state, project) === agentId
}

/** The PM's post in [group]: a reply in a thread ([thread], its root) settles every ask in that thread; an answer right below a
 *  message ([answers]) settles that message. */
export function settleReply(state: SuperTabState, group: Conversation, agentId: string, place: { answers: string | null; thread: string | null }): void {
  if (!group.owed || !byPm(state, group, agentId)) return
  settle(group, ask => ask.id === place.answers || (!!place.thread && ask.thread === place.thread))
}

/** The PM's verdict reaction on [messageId] settles it. */
export function settleReaction(state: SuperTabState, group: Conversation, agentId: string, messageId: string, emoji: string, on: boolean): void {
  if (!on || !VERDICT_REACTIONS.has(emoji) || !group.owed || !byPm(state, group, agentId)) return
  settle(group, ask => ask.id === messageId)
}

/** A task opened from the person's request [messageId] in [project]'s chat settles it (commands.ts requestOf). */
export function settleRequest(state: SuperTabState, project: SwarmProject, messageId: string): void {
  const chat = state.conversations.find(c => c.id === project.leadConversationId)
  if (chat) settle(chat, ask => ask.id === messageId)
}


/** When each rule turns the strip red (anh Dee's brief), sent with the pulse so no app holds a threshold. */
export interface PulseLimits { askMinutes: number; idleMinutes: number; lostMinutes: number }
export const PULSE_LIMITS: PulseLimits = { askMinutes: 15, idleMinutes: 10, lostMinutes: 10 }

/** A project's pulse. `redAt`: when each rule turns red (0: already, by its nature), null while it cannot. */
export interface Pulse {
  pmId: string | null
  asks: { count: number; oldestAt: number | null; personId: string | null; list: Array<{ conversationId: string; messageId: string; personId: string; at: number }> }
  working: { count: number; crew: number; agentIds: string[] }
  nextUp: { count: number; conversationIds: string[] }
  lost: { count: number; since: number | null; conversationIds: string[] }
  held: { count: number; withoutReason: number; list: Array<{ conversationId: string; reason: string | null }> }
  idleSince: number | null
  redAt: { asks: number | null; idle: number | null; lost: number | null; held: number | null }
  limits: PulseLimits
}

const ENDED = new Set(['done', 'stopped', 'cancelled'])
const MINUTE = 60_000

/** The day [now] falls on, as a task's `notBefore` is written. */
const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10)

/**
 * Whether [group] is held, and why (River's ruling, 11-05): its agent set blocked or needs a person, its result the reason (an
 * empty one is none), or nobody is assigned and it is set for a later day, the date its reason. The one place a hold is
 * decided: the task that gives holds a reason of their own changes it here.
 */
export function holdOf(group: Conversation, today: string): { reason: string | null } | null {
  const assignment = group.assignment
  if (!assignment) return group.notBefore && group.notBefore > today ? { reason: `not before ${group.notBefore}` } : null
  if (assignment.status !== 'blocked' && assignment.status !== 'needs_human') return null
  return { reason: assignment.result?.trim() || null }
}

/** [project]'s work: its open tasks and steps, never its chat, a private chat or a Buddy chat. */
const workOf = (state: SuperTabState, project: SwarmProject): Conversation[] => state.conversations.filter(c => !c.archived && counted(c)
  && c.id !== project.leadConversationId && (c.projectId ?? 'lead') === project.id)

/** Whether [group] lost its agent: lost, or nobody holds it (liveness.ts `orphaned`), and since when. */
function lostSince(group: Conversation): number | null {
  const assignment = group.assignment
  if (!assignment || ENDED.has(assignment.status)) return null
  if (assignment.status === 'lost') return assignment.lost?.at ?? group.liveness?.since ?? 0
  return group.liveness?.state === 'orphaned' ? group.liveness.since : null
}

interface Counts { working: Set<string>; crew: string[]; nextUp: string[]; lost: Array<{ id: string; since: number }>; held: Array<{ conversationId: string; reason: string | null }> }

/** Each agent's project, worked out once for every project counted (agentProjectId may search the conversations). */
export const agentProjects = (state: SuperTabState): Map<string, string> => new Map(state.agents.map(a => [a.id, agentProjectId(state, a)]))

function countWork(state: SuperTabState, project: SwarmProject, now: number, projectOfAgent = agentProjects(state)): Counts {
  const pm = pmOf(state, project)
  const crew = state.agents.filter(a => a.id !== pm && !isBuddy(a) && projectOfAgent.get(a.id) === project.id).map(a => a.id)
  const inCrew = new Set(crew), today = dayOf(now)
  const counts: Counts = { working: new Set(), crew, nextUp: [], lost: [], held: [] }
  for (const group of workOf(state, project)) {
    const assignment = group.assignment
    // Lost first: a blocked task whose agent is gone waits for an agent before anything else.
    const since = lostSince(group)
    if (since !== null) { counts.lost.push({ id: group.id, since }); continue }
    const hold = holdOf(group, today)
    if (hold) { counts.held.push({ conversationId: group.id, reason: hold.reason }); continue }
    if (!assignment) { if (!group.reviewOf) counts.nextUp.push(group.id); continue }
    if (assignment.status === 'working' && inCrew.has(assignment.agentId)) counts.working.add(assignment.agentId)
  }
  return counts
}

/** Working is 0 while work waits (Next up or lost). */
const idle = (counts: Counts): boolean => !counts.working.size && (counts.nextUp.length > 0 || counts.lost.length > 0)

/** Marks on each project when Working fell to 0 while work waits, and clears it once either ends: run where every open group is
 *  loaded, after each command and on the PM's sweep, so the board reddens on time without anyone's poll. Writes only on a
 *  change. */
export function markIdle(state: SuperTabState, now: number): void {
  const projectOfAgent = agentProjects(state)
  for (const project of state.projects ?? []) {
    const waiting = idle(countWork(state, project, now, projectOfAgent))
    if (waiting && project.idleSince === undefined) project.idleSince = now
    else if (!waiting && project.idleSince !== undefined) delete project.idleSince
  }
}

/** [project]'s pulse at [now], from what is loaded. */
export function projectPulse(state: SuperTabState, project: SwarmProject, now: number, limits: PulseLimits = PULSE_LIMITS,
  projectOfAgent = agentProjects(state)): Pulse {
  const counts = countWork(state, project, now, projectOfAgent)
  const asks = state.conversations.filter(c => !c.archived && c.owed && (c.projectId ?? 'lead') === project.id)
    .flatMap(c => c.owed!.map(ask => ({ conversationId: c.id, messageId: ask.id, personId: ask.personId, at: ask.at })))
    .sort((a, b) => a.at - b.at)
  const oldest = asks[0]
  const lostAt = counts.lost.length ? Math.min(...counts.lost.map(l => l.since)) : null
  const idleSince = idle(counts) ? project.idleSince ?? null : null
  const withoutReason = counts.held.filter(h => h.reason === null).length
  return {
    pmId: pmOf(state, project),
    asks: { count: asks.length, oldestAt: oldest?.at ?? null, personId: oldest?.personId ?? null, list: asks },
    working: { count: counts.working.size, crew: counts.crew.length, agentIds: counts.crew.filter(id => counts.working.has(id)) },
    nextUp: { count: counts.nextUp.length, conversationIds: counts.nextUp },
    lost: { count: counts.lost.length, since: lostAt, conversationIds: counts.lost.map(l => l.id) },
    held: { count: counts.held.length, withoutReason, list: counts.held },
    idleSince,
    redAt: {
      asks: oldest ? oldest.at + limits.askMinutes * MINUTE : null,
      idle: idleSince === null ? null : idleSince + limits.idleMinutes * MINUTE,
      lost: lostAt === null ? null : lostAt + limits.lostMinutes * MINUTE,
      held: withoutReason ? 0 : null,
    },
    limits,
  }
}

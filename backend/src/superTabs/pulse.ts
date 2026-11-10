/**
 * The board's pulse (task #3384, anh Dee's Swarm redesign, 11-05): what each project's PM owes and who works, from stored
 * state, shown to everyone on the board so nothing waits unseen. On 11-05 the board showed Working 0 and five people's asks
 * unanswered for 3-10 h: nothing tracked what the PM owed, and the idle checks ran only on the PM's poll.
 *
 * An owed ask is a person's message that reached the PM, kept on its conversation (`Conversation.owed`) until the PM answers
 * it in its place (a reply in its thread, or an answer right below it), explicitly reacts, or opens a task from it.
 * A project agent explicitly entrusted with an ask by the PM may also settle that ask by replying in its thread.
 * Nothing here refuses anything: a settle that finds nothing does nothing.
 */
import { heldView, type HeldReason } from './heldReason.js'
import { fail, isLeads, type Author, type Conversation, type SuperTabState } from './model.js'
import { agentProjectId, groupProject, type SwarmProject } from './projects.js'
import { noteTaskLines, type LinesBefore } from './statusCard.js'
import { switched } from './boardRights.js'

/** One person's message to the PM not settled yet: its id, who wrote it, when, and the root of the thread it is in (its own
 *  id for a top-level message). `delegatedTo` is the one project agent the PM entrusted with answering this ask. */
export interface OwedAsk { id: string; personId: string; at: number; thread: string; delegatedTo?: string }

/** At most this many asks are kept per conversation, the newest: a growth bound, far above what a PM leaves unanswered. */
export const MAX_OWED = 50

/** The project [group] belongs to, or none for a conversation outside every project (the removed Leads chat). Never
 *  throws: the pulse is never a reason for a command to fail. */
function projectOfGroup(state: SuperTabState, group: Conversation): SwarmProject | undefined {
  if (isLeads(group)) return undefined
  try { return groupProject(state, group) } catch { return undefined }
}

/** The agent leading [project]: its chat's Lead. */
export function pmOf(state: SuperTabState, project: SwarmProject): string | null {
  return state.conversations.find(c => c.id === project.leadConversationId)?.leadId ?? null
}

/** Whether asks in [group] count: a project's chat or task, never a private chat, whose words and people only
 *  their audience reads (the pulse is shown to every reader of the project). */
const counted = (group: Conversation): boolean => !group.audience && !group.kind

/** Records [message] as owed when a person wrote it and it reached [group]'s PM. */
export function owe(state: SuperTabState, group: Conversation, message: { id: string; author: Author; recipients: readonly string[]; thread: string | null; source?: unknown }, now: number): void {
  if (message.author.kind !== 'person' || message.source || !counted(group)) return
  const project = projectOfGroup(state, group)
  const pm = project && pmOf(state, project)
  // A project switched to the Board way of working owes its PM no chat messages (boardRights.ts, task #3819).
  if (!pm || !message.recipients.includes(pm) || switched(project)) return
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

/** A PM's post in the Guide's task explicitly names the project-chat ask and one recipient. Free text and role names never
 *  confer this authority: membership routing remains the PM's judgment. Kept with the bounded ask until it is settled. */
export function handoffAsk(state: SuperTabState, group: Conversation, agentId: string | null, messageId: string, recipients: readonly string[]): void {
  const project = projectOfGroup(state, group)
  if (!project || !agentId || pmOf(state, project) !== agentId) fail('ASK_HANDOFF_PM', 'Only the project PM can hand off an owed ask.', 403)
  const target = recipients.length === 1 ? state.agents.find(a => a.id === recipients[0]) : undefined
  if (!target || target.id === agentId || agentProjectId(state, target) !== project.id) {
    fail('ASK_HANDOFF_AGENT', 'Name exactly one project agent for the handoff.', 400)
  }
  const chat = state.conversations.find(c => c.id === project.leadConversationId)
  const ask = chat?.owed?.find(a => a.id === messageId)
  if (!ask) fail('ASK_NOT_OWED', 'This ask is no longer owed in the project chat.', 409)
  ask.delegatedTo = target.id
}

/** The PM's post in [group]: a reply in a thread ([thread], its root) settles every ask in that thread; an answer right below a
 *  message ([answers]) settles that message. An entrusted project agent settles only its named ask, in that ask's thread. */
export function settleReply(state: SuperTabState, group: Conversation, agentId: string, place: { answers: string | null; thread: string | null }): void {
  if (!group.owed) return
  if (byPm(state, group, agentId)) {
    settle(group, ask => ask.id === place.answers || (!!place.thread && ask.thread === place.thread))
  } else if (place.thread && group.owed.some(ask => ask.delegatedTo === agentId && ask.thread === place.thread)) {
    const target = state.agents.find(a => a.id === agentId)
    if (target && agentProjectId(state, target) === projectOfGroup(state, group)?.id) {
      settle(group, ask => ask.delegatedTo === agentId && ask.thread === place.thread)
    }
  }
}

/** The PM's reaction on [messageId] settles it: an acknowledgement, kept nowhere (reactions.ts). */
export function settleReaction(state: SuperTabState, group: Conversation, agentId: string, messageId: string, on: boolean): void {
  if (!on || !group.owed || !byPm(state, group, agentId)) return
  settle(group, ask => ask.id === messageId)
}

/** [messageId], deleted by its author: nothing is left to answer, and its link would open a message that is gone. */
export function settleDeleted(group: Conversation, messageId: string): void {
  settle(group, ask => ask.id === messageId)
}

/** A task the PM opens from the person's request [messageId] in [project]'s chat settles it (commands.ts requestOf); one anyone
 *  else opens leaves the PM's answer owed (River's ruling on the review of #3209). */
export function settleRequest(state: SuperTabState, project: SwarmProject, agentId: string | null, messageId: string): void {
  const chat = state.conversations.find(c => c.id === project.leadConversationId)
  if (chat && agentId && pmOf(state, project) === agentId) settle(chat, ask => ask.id === messageId)
}


/** When each rule turns the strip red (anh Dee's brief), sent with the pulse so no app holds a threshold. */
export interface PulseLimits { askMinutes: number; idleMinutes: number; lostMinutes: number }
export const PULSE_LIMITS: PulseLimits = { askMinutes: 5, idleMinutes: 10, lostMinutes: 10 }

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

/** A recorded hold reason in a few words, as the strip's Held list shows it. */
export function heldWords(reason: HeldReason): string {
  switch (reason.kind) {
    case 'task': return `waits on #${reason.taskNumber}`
    case 'person': return 'waits on a person\'s answer'
    case 'reset': return `waits for a ${reason.what} reset`
    case 'requester': return 'the requester asked for later'
  }
}

/**
 * Whether [group] is held, and why (River's ruling, 11-05): its agent set blocked or needs a person, or nobody is assigned and
 * it is set for a later day. Its reason is the one recorded for the hold (#3390, heldReason.ts heldView, the one place that
 * reads it), in words; none recorded is no reason, as the board shows it. A date also says the day. ReviewPulse2 on the merge
 * with #3390: the agent's result text decided it before, a second way to decide one thing.
 */
export function holdOf(group: Conversation, today: string): { reason: string | null } | null {
  // A pause by someone who steers its project (boardRights.ts, task #3819), with its reason when one was given.
  if (group.paused) return { reason: group.paused.reason ? `paused: ${group.paused.reason}` : 'paused' }
  const assignment = group.assignment
  const dated = !assignment && !!group.notBefore && group.notBefore > today
  const stated = !!assignment && (assignment.status === 'blocked' || assignment.status === 'needs_human')
  if (!dated && !stated) return null
  const view = heldView(group)
  const words = view && view.kind !== 'none' ? heldWords(view) : null
  return { reason: words && dated ? `${words}, not before ${group.notBefore}` : words }
}

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

/** The Swarm's open conversations and agents by project, sorted out in one pass, so a pulse for every project costs one walk of
 *  the Swarm rather than one per project: recordPulse runs after every command (ENGINEERING 4). */
export interface PulseIndex {
  /** Each project's open tasks and steps, never its chat or a private chat. */
  work: Map<string, Conversation[]>
  /** Each project's open conversations that hold owed asks. */
  owing: Map<string, Conversation[]>
  /** Each project's agents. */
  agents: Map<string, string[]>
}
export function pulseIndex(state: SuperTabState, projectOfAgent = agentProjects(state), only?: string): PulseIndex {
  const chats = new Set((state.projects ?? []).map(p => p.leadConversationId))
  const index: PulseIndex = { work: new Map(), owing: new Map(), agents: new Map() }
  const add = <T>(map: Map<string, T[]>, key: string, value: T) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]) }
  for (const group of state.conversations) {
    if (group.archived || !counted(group)) continue
    const projectId = group.projectId ?? 'lead'
    if (only && projectId !== only) continue
    if (group.owed?.length) add(index.owing, projectId, group)
    if (!chats.has(group.id)) add(index.work, projectId, group)
  }
  for (const agent of state.agents) add(index.agents, projectOfAgent.get(agent.id) ?? agentProjectId(state, agent), agent.id)
  return index
}

function countWork(state: SuperTabState, project: SwarmProject, now: number, index: PulseIndex): Counts {
  const pm = pmOf(state, project)
  const crew = (index.agents.get(project.id) ?? []).filter(id => id !== pm)
  const inCrew = new Set(crew), today = dayOf(now)
  const counts: Counts = { working: new Set(), crew, nextUp: [], lost: [], held: [] }
  for (const group of index.work.get(project.id) ?? []) {
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

/** The most of each list a stored pulse keeps (its counts stay whole): a growth bound on the project chat's part. */
export const PULSE_LIST_MAX = 50

/**
 * Works out each project's pulse and keeps it on the project's chat, where every read finds it: a change poll reads only the
 * light base (the project chats and running work, light fields: parts/light.ts), so a pulse derived at read time from it lost
 * the asks and Next up a full read showed (Hugo's review of #3209). Run where every open group is loaded, after each command
 * and on the PM's sweep, so the board reddens on time without anyone's poll. Writes only on a change. When Working fell to 0
 * while work waits is kept in it (`idleSince`) from one run to the next.
 */
export function recordPulse(state: SuperTabState, now: number, only?: string, before?: LinesBefore): void {
  // The asks of a person who left the Swarm are owed to nobody, however they left.
  const people = new Set(state.people.map(p => p.id))
  for (const group of state.conversations) if (group.owed?.some(ask => !people.has(ask.personId))) settle(group, ask => !people.has(ask.personId))
  if (!state.projects?.length) return
  // [only]: the one project a command's conversation is in, whose pulse alone it can move; every project otherwise.
  const projects = only ? state.projects.filter(p => p.id === only) : state.projects
  const index = pulseIndex(state, agentProjects(state), only), chats = new Map(state.conversations.map(c => [c.id, c]))
  for (const project of projects) {
    const chat = chats.get(project.leadConversationId)
    if (!chat) continue
    const pulse = projectPulse(state, project, now, PULSE_LIMITS, index, chat.pulse?.idleSince ?? null)
    if (JSON.stringify(pulse) !== JSON.stringify(chat.pulse)) chat.pulse = pulse
    // Each task's status line (statusCard.ts), on the task, written only where this pass moved it (task #4419): a command and the
    // Lead's sweep give the lines from before they changed anything.
    if (before) noteTaskLines(state, project, index, now, dayOf(now), before)
  }
}

/** The project of the conversation [command] names, whose pulse alone it can move; undefined for a command that names none, or
 *  a conversation outside every project, which may move any. */
export function pulseProjectOf(state: SuperTabState, command: object): string | undefined {
  const id = (command as { conversationId?: unknown }).conversationId
  const group = typeof id === 'string' ? state.conversations.find(c => c.id === id) : undefined
  return group ? projectOfGroup(state, group)?.id : undefined
}

/** [project]'s pulse as last recorded on its chat (recordPulse), or none. */
export const storedPulse = (state: SuperTabState, project: SwarmProject): Pulse | undefined =>
  state.conversations.find(c => c.id === project.leadConversationId)?.pulse

/** [project]'s pulse at [now], from what is loaded: every open group, as a command or the PM's sweep loads them. [idleBefore]:
 *  when Working fell to 0 while work waits, as last recorded. */
export function projectPulse(state: SuperTabState, project: SwarmProject, now: number, limits: PulseLimits = PULSE_LIMITS,
  index = pulseIndex(state), idleBefore: number | null = null): Pulse {
  const counts = countWork(state, project, now, index)
  const asks = (index.owing.get(project.id) ?? [])
    .flatMap(c => c.owed!.map(ask => ({ conversationId: c.id, messageId: ask.id, personId: ask.personId, at: ask.at })))
    .sort((a, b) => a.at - b.at)
  const oldest = asks[0]
  const lostAt = counts.lost.length ? Math.min(...counts.lost.map(l => l.since)) : null
  const idleSince = idle(counts) ? idleBefore ?? now : null
  const withoutReason = counts.held.filter(h => h.reason === null).length
  return {
    pmId: pmOf(state, project),
    asks: { count: asks.length, oldestAt: oldest?.at ?? null, personId: oldest?.personId ?? null, list: asks.slice(0, PULSE_LIST_MAX) },
    working: { count: counts.working.size, crew: counts.crew.length, agentIds: counts.crew.filter(id => counts.working.has(id)).slice(0, PULSE_LIST_MAX) },
    nextUp: { count: counts.nextUp.length, conversationIds: counts.nextUp.slice(0, PULSE_LIST_MAX) },
    lost: { count: counts.lost.length, since: lostAt, conversationIds: counts.lost.map(l => l.id).slice(0, PULSE_LIST_MAX) },
    held: { count: counts.held.length, withoutReason, list: counts.held.slice(0, PULSE_LIST_MAX) },
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

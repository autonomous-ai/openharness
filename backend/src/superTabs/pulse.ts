/**
 * The board's pulse (task #3384, anh Dee's Swarm redesign, 11-05): what each project's PM owes and who works, from stored
 * state, shown to everyone on the board so nothing waits unseen. On 11-05 the board showed Working 0 and five people's asks
 * unanswered for 3-10 h: nothing tracked what the PM owed, and the idle checks ran only on the PM's poll.
 *
 * An owed ask is a person's message that reached the PM, kept on its conversation (`Conversation.owed`) until the PM answers
 * it in its place (a reply in its thread, or an answer right below it), gives it a verdict reaction, or opens a task from it.
 * Nothing here refuses anything: a settle that finds nothing does nothing.
 */
import { isBuddyChat } from './buddies.js'
import { isLeads, type Author, type Conversation, type SuperTabState } from './model.js'
import { groupProject, type SwarmProject } from './projects.js'

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


/** Buddies hear how their person's requests go, unasked (Diego, 10-29): the project-chat rows that answer their person's
 *  proposal, tag them, or say work they requested shipped, and a notice when work they requested is assigned. Only while
 *  the Buddy reads that conversation as its person would (projects.ts canReadGroup), checked again when its machine picks
 *  the delivery up (store.ts deliveryAllowed). Nothing else of the project chat, and nothing private, reaches a Buddy. */
import { buddyChatOf, defaultBuddy, isBuddy, isBuddyChat, isSwarmBuddy, routingRow } from './buddies.js'
import { mainBuddyOf } from './buddySessions.js'
import { agentOnly, isLeads, type Agent, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, canReadGroup, groupProject, isAgentChat } from './projects.js'
import { SHIP_KIND } from './ship.js'

/** The source of a Buddy's proposal, posted until proposals went (2026-11-10). */
const PROPOSAL_KIND = 'buddy-proposal'

/** [personId]'s Buddy in [group]'s project, when it reads [group] as its person would: never a private conversation, and
 *  nothing once its person left, rejoined or stopped reading the project. */
function listeningBuddy(state: SuperTabState, personId: string, group: Conversation, senderId?: string): Agent | undefined {
  const project = groupProject(state, group)
  // The main Buddy alone: a thread session hears only its own thread (buddySessions.ts). The Buddy that sent the proposal while
  // it is still theirs (a session's own main Buddy), else their default (task #3818), else their older Buddy of that project.
  const person = state.people.find(p => p.id === personId)
  const sent = senderId ? state.agents.find(a => a.id === senderId) : undefined
  // A thread session that sent it stands for its own chat's main Buddy.
  const sentChat = sent?.buddySession ? buddyChatOf(state, sent) : undefined
  const main = sent?.buddySession ? sentChat && mainBuddyOf(state, sentChat) : sent
  const sender = main && person && isSwarmBuddy(main) && !main.buddySession && main.buddyOf!.personId === person.id
    && main.buddyOf!.generation === person.generation ? main : undefined
  const mains = state.agents.filter(a => isBuddy(a) && !a.buddySession && a.buddyOf!.personId === personId)
  const buddy = sender ?? defaultBuddy(state, personId) ?? mains.find(a => isSwarmBuddy(a)) ?? mains.find(a => agentProjectId(state, a) === project.id)
  return buddy && canReadGroup(state, { kind: 'agent', agentId: buddy.id, machineOwnerId: buddy.machineOwnerId }, group) ? buddy : undefined
}

/** The Buddy that sent the proposal [message]'s thread answers, when it does (task #3818): its news goes back to that one. */
const senderOf = (message: MessageDraft, threadSource: Record<string, unknown> | null): string | undefined =>
  message.replyTo && threadSource?.kind === PROPOSAL_KIND && typeof threadSource.buddyId === 'string' ? threadSource.buddyId : undefined

/** The people a project-chat row is news for: whoever's proposal its thread answers, each person it tags, and who requested
 *  the work it says shipped. Never its own author: they know what they wrote. */
function newsFor(message: MessageDraft, threadSource: Record<string, unknown> | null): string[] {
  const source = message.source
  const people = [...message.mentions ?? []]
  if (source?.kind === SHIP_KIND && typeof source.requesterId === 'string') people.push(source.requesterId)
  if (message.replyTo && threadSource?.kind === PROPOSAL_KIND && typeof threadSource.personId === 'string') people.push(threadSource.personId)
  return [...new Set(people)].filter(id => message.author.kind !== 'person' || message.author.id !== id)
}

/** The Buddies [message] reaches, given the source of the thread it replies in (null for none). Project chats only, and
 *  never a routing row, as a Buddy reads none (buddies.ts). */
export function buddiesTold(state: SuperTabState, message: MessageDraft, threadSource: Record<string, unknown> | null): string[] {
  const group = state.conversations.find(c => c.id === message.conversationId)
  if (!group || isLeads(group) || isBuddyChat(group) || isAgentChat(group) || agentOnly(message.source, message.recipients) || routingRow(message.source) || groupProject(state, group).leadConversationId !== group.id) return []
  const sender = senderOf(message, threadSource)
  return newsFor(message, threadSource).flatMap(id => listeningBuddy(state, id, group, id === threadSource?.personId ? sender : undefined)?.id ?? [])
}

/** Marks who of the Buddies hears [message]: a delivery each, kept off its recipients so readers never see whose Buddy listens. */
export function tellBuddies(state: SuperTabState, message: MessageDraft, threadSource: Record<string, unknown> | null): void {
  const buddies = buddiesTold(state, message, threadSource)
  if (buddies.length) message.buddyRecipients = buddies
}

/** Every Buddy hearing input, in its own chat too: the agent guard meets a concurrent sleep (#3824), and the person's
 *  guard meets loss of the membership that permits the delivery (parts/touches.ts). */
export function buddiesHearing(state: SuperTabState, messages: readonly MessageDraft[]): Agent[] {
  const ids = new Set(messages.flatMap(m => [...m.buddyRecipients ?? [], ...m.recipients]))
  return state.agents.filter(a => ids.has(a.id) && isBuddy(a))
}

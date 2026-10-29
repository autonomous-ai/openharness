/** Buddies hear how their person's requests go, unasked (Diego, 10-29): the project-chat rows that answer their person's
 *  proposal, tag them, or say work they requested shipped, and a notice when work they requested is assigned. Only while
 *  the Buddy reads that conversation as its person would (projects.ts canReadGroup), checked again when its machine picks
 *  the delivery up (store.ts deliveryAllowed). Nothing else of the project chat, and nothing private, reaches a Buddy. */
import { isBuddy, routingRow } from './buddies.js'
import { agentOnly, isLeads, stableId, AGENT_ONLY, type Agent, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, canReadGroup, groupProject } from './projects.js'
import { SHIP_KIND } from './ship.js'

/** The source buddy.propose gives the proposal it posts (commands.ts). */
const PROPOSAL_KIND = 'buddy-proposal'

/** [personId]'s Buddy in [group]'s project, when it reads [group] as its person would: never a private conversation, and
 *  nothing once its person left, rejoined or stopped reading the project. */
function listeningBuddy(state: SuperTabState, personId: string, group: Conversation): Agent | undefined {
  const project = groupProject(state, group)
  const buddy = state.agents.find(a => isBuddy(a) && a.buddyOf!.personId === personId && agentProjectId(state, a) === project.id)
  return buddy && canReadGroup(state, { kind: 'agent', agentId: buddy.id, machineOwnerId: buddy.machineOwnerId }, group) ? buddy : undefined
}

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
  if (!group || isLeads(group) || agentOnly(message.source, message.recipients) || routingRow(message.source) || groupProject(state, group).leadConversationId !== group.id) return []
  return newsFor(message, threadSource).flatMap(id => listeningBuddy(state, id, group)?.id ?? [])
}

/** Marks who of the Buddies hears [message]: a delivery each, kept off its recipients so readers never see whose Buddy listens. */
export function tellBuddies(state: SuperTabState, message: MessageDraft, threadSource: Record<string, unknown> | null): void {
  const buddies = buddiesTold(state, message, threadSource)
  if (buddies.length) message.buddyRecipients = buddies
}

/** Work [group]'s requester asked for was just assigned: one line for their Buddy alone, inside the task, saying only what
 *  its person reads there (its number, title and status, Lead's ruling 10-29). None when the Buddy cannot read the task. */
export function assignedNotice(state: SuperTabState, group: Conversation, author: Author, operationId: string): MessageDraft | null {
  const buddy = group.requesterId ? listeningBuddy(state, group.requesterId, group) : undefined
  if (!buddy || !group.assignment) return null
  return { id: stableId(operationId, 'buddy-news'), conversationId: group.id, author, replyTo: null, recipients: [buddy.id], source: AGENT_ONLY,
    text: `News for your owner: #${group.number} "${group.title}", which they requested, is assigned and ${group.assignment.status}.` }
}

/** The Buddies [messages] bring news to outside their own chat: what they were told relied on their person still reading
 *  there, so a write that sends news guards on those people and Buddies (parts/touches.ts). */
export function buddiesHearing(state: SuperTabState, messages: readonly MessageDraft[]): Agent[] {
  const ids = new Set(messages.flatMap(m => [...m.buddyRecipients ?? [],
    ...m.recipients.filter(id => !state.conversations.find(c => c.id === m.conversationId)?.agentIds.includes(id))]))
  return state.agents.filter(a => ids.has(a.id) && isBuddy(a))
}

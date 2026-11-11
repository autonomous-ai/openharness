/**
 * A project's Product Manager's 1:1 chat with its person, open before that PM is (Swarm v4, anh Dee 2026-11-08): only agents
 * post in a project's channel, so the person's request goes to the PM's own chat, which lead.start (and lead.claim in a Personal
 * Swarm) opens at once and answers by id. What its person sends there waits; the PM that joins takes the chat and is delivered
 * what waited, typed as written (store.ts writeLateDeliveries). A start that ends without a PM leaves the chat with its person
 * and says so there, and their next start takes the chat again with what still waits.
 */
import { fail, stableId, type AgentStart, type CommandEffects, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { projectsOf, type SwarmProject } from './projects.js'
import { publicReason } from './startFailure.js'
import { COORDINATOR_NAME } from './roleNames.js'

/** At most this many of its person's messages wait in a PM's chat for that PM. */
export const MAX_PM_CHAT_WAITING = 20

type Member = { id: string; generation: string }
type LateDelivery = NonNullable<CommandEffects['lateDeliveries']>[number]

/** [project]'s PM chat while it waits for a PM of [person]'s, at the generation it was opened for. */
export function waitingPmChat(state: SuperTabState, project: SwarmProject, person: Member): Conversation | undefined {
  const chat = project.pmChat && state.conversations.find(c => c.id === project.pmChat!.id)
  const own = chat?.audience?.people[0]
  return chat && !chat.archived && !chat.agentIds.length && own?.id === person.id && own.generation === person.generation ? chat : undefined
}

/** Its person's message [messageId] in [group]: when [group] is a PM chat with no PM yet, it waits for that PM. One more than
 *  MAX_PM_CHAT_WAITING is refused, so nothing waits unseen. */
export function pmChatWaits(state: SuperTabState, group: Conversation, messageId: string): void {
  const project = group.agentIds.length ? undefined : projectsOf(state).find(p => p.pmChat?.id === group.id)
  if (!project) return
  const waiting = project.pmChat!.waiting ?? []
  if (waiting.includes(messageId)) return
  if (waiting.length >= MAX_PM_CHAT_WAITING) {
    fail('PM_CHAT_FULL', `${MAX_PM_CHAT_WAITING} messages already wait for the ${COORDINATOR_NAME}. Send more once it starts.`, 409)
  }
  project.pmChat!.waiting = [...waiting, messageId]
}

/** [project]'s PM [agentId], of [person], joined: it takes the chat waiting for it as its own, and is delivered what waited.
 *  Undefined when no chat waits for that person's PM; the project's chat stops waiting either way, as it has its PM. */
export function takePmChat(state: SuperTabState, project: SwarmProject, agentId: string, person: Member): { chatId: string; late: LateDelivery[] } | undefined {
  const chat = waitingPmChat(state, project, person)
  const waiting = project.pmChat?.waiting ?? []
  delete project.pmChat
  if (!chat) return undefined
  const target = state.agents.find(a => a.id === agentId)!
  chat.agentIds.push(agentId)
  chat.title = target.displayName ?? target.name
  target.chatId = chat.id
  return { chatId: chat.id, late: waiting.map(messageId => ({ messageId, conversationId: chat.id, agentId, lead: true as const,
    author: { kind: 'person' as const, id: person.id, generation: person.generation } })) }
}

/** A system row in PM chat [chat], under its person, who alone reads it. Null when that person left. */
function rowIn(state: SuperTabState, chat: Conversation, id: string, text: string): MessageDraft | null {
  const own = chat.audience?.people[0]
  const person = own && state.people.find(p => p.id === own.id && p.generation === own.generation)
  if (!person) return null
  return { id, conversationId: chat.id, author: { kind: 'person', id: person.id, name: person.email, membershipGeneration: person.generation },
    text, replyTo: null, recipients: [], source: { kind: 'system' } }
}

/** [start], a PM's start, ended without its PM: its project's chat, still waiting, says so, and keeps what waits for the next. */
export function pmStartEnded(state: SuperTabState, start: AgentStart): MessageDraft[] {
  const project = start.request.leadFor && projectsOf(state).find(p => p.id === start.request.leadFor!.projectId)
  const chat = project?.pmChat && state.conversations.find(c => c.id === project.pmChat!.id && !c.agentIds.length)
  // Another start of it still running is the one the chat waits for.
  if (!project || !chat || state.starts?.some(s => s.request.leadFor?.projectId === project.id && !s.harnessId && !s.error)) return []
  // What a reader of the project reads too (startFailure.ts publicReason), never the host's own words.
  const reason = publicReason(start.error!)
  const row = rowIn(state, chat, stableId('pm-chat', start.id),
    `Could not start ${start.request.name}: ${reason[0]!.toLowerCase()}${reason.slice(1)} What you sent here waits for its next start.`)
  return row ? [row] : []
}

/** What a command did to the PM chats waiting in [before], said in each: a PM start that ended without its PM (pmStartEnded), or
 *  a chat no PM will take, as its project was deleted or its PM has another chat (another person's start, or a PM that had one).
 *  [operationId] names this command's rows. */
export function pmChatsEnded(before: SuperTabState, state: SuperTabState, operationId: string): MessageDraft[] {
  // Only a PM chat that waited has anything to say, and few do at a time: most commands stop here.
  const waiting = projectsOf(before).filter(p => p.pmChat)
  if (!waiting.length) return []
  const running = new Set((before.starts ?? []).filter(s => s.request.leadFor && !s.error && !s.harnessId).map(s => s.id))
  const rows = (state.starts ?? []).filter(s => running.has(s.id) && s.error && !s.harnessId).flatMap(start => pmStartEnded(state, start))
  for (const was of waiting) {
    const chat = was.pmChat && state.conversations.find(c => c.id === was.pmChat!.id && !c.agentIds.length)
    const now = projectsOf(state).find(p => p.id === was.id)
    if (!chat || now?.pmChat?.id === chat.id) continue
    const row = rowIn(state, chat, stableId('pm-chat', chat.id, operationId), now
      ? `This project's ${COORDINATOR_NAME} has another chat now, so none joins this one.`
      : `This project was deleted, so no ${COORDINATOR_NAME} joins this chat.`)
    if (row) rows.push(row)
  }
  return rows
}

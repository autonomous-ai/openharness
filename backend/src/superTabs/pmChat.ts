/**
 * A project's Product Manager's 1:1 chat with its person, open before that PM is (Swarm v4, anh Dee 2026-11-08): only agents
 * post in a project's channel, so the person's request goes to the PM's own chat, which lead.start (and lead.claim in a Personal
 * Swarm) opens at once and answers by id. What its person sends there waits; the PM that comes to lead the project, by whatever
 * command, takes the chat and is delivered what waited, typed as written (store.ts writeLateDeliveries). A start that ends without
 * a PM leaves the chat with its person and says so there, and their next start takes the chat again with what still waits.
 */
import { fail, stableId, type Agent, type AgentStart, type CommandEffects, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { isAgentChat, projectsOf, type SwarmProject } from './projects.js'
import { publicReason } from './startFailure.js'
import { COORDINATOR_NAME } from './roleNames.js'
import { agentDisplayName } from './agentNames.js'

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

/** Whether [group] is a PM chat still waiting for its PM, which no other agent joins. */
export const isWaitingPmChat = (state: SuperTabState, group: Conversation): boolean =>
  !group.agentIds.length && projectsOf(state).some(p => p.pmChat?.id === group.id)

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

/** A system row in PM chat [chat], under its person, who alone reads it. Null when that person left. */
function rowIn(state: SuperTabState, chat: Conversation, id: string, text: string): MessageDraft | null {
  const own = chat.audience?.people[0]
  const person = own && state.people.find(p => p.id === own.id && p.generation === own.generation)
  if (!person) return null
  return { id, conversationId: chat.id, author: { kind: 'person', id: person.id, name: person.email, membershipGeneration: person.generation },
    text, replyTo: null, recipients: [], source: { kind: 'system' } }
}

/** [start], a PM's start, ended without its PM: its project's chat, still waiting with no PM in the project, says so, and keeps
 *  what waits for the next start. */
export function pmStartEnded(state: SuperTabState, start: AgentStart): MessageDraft[] {
  const project = start.request.leadFor && projectsOf(state).find(p => p.id === start.request.leadFor!.projectId)
  const chat = project?.pmChat && state.conversations.find(c => c.id === project.pmChat!.id && !c.agentIds.length)
  // Another start of it still running is the one the chat waits for; a PM leading it now settles the chat (settlePmChats).
  if (!project || !chat || leaderOf(state, project) || state.starts?.some(s => s.request.leadFor?.projectId === project.id && !s.harnessId && !s.error)) return []
  // What a reader of the project reads too (startFailure.ts publicReason), never the host's own words.
  const reason = publicReason(start.error!)
  const row = rowIn(state, chat, stableId('pm-chat', start.id),
    `Could not start ${start.request.name}: ${reason[0]!.toLowerCase()}${reason.slice(1)} What you sent here waits for its next start.`)
  return row ? [row] : []
}

/** The agent leading [project]'s channel now, if any. */
function leaderOf(state: SuperTabState, project: SwarmProject): Agent | undefined {
  const home = state.conversations.find(c => c.id === project.leadConversationId)
  return home?.leadId && home.agentIds.includes(home.leadId) ? state.agents.find(a => a.id === home.leadId) : undefined
}

/**
 * What a command did to the PM chats, run at its end so every way a project gets its PM counts (a start's agent, agent.add,
 * conversation.agent): a PM of the chat's person with no chat of its own takes it and is delivered what waited; any other PM
 * leaves it, and the chat says why. A chat whose project was deleted, or another person's start replaced, says no PM joins it,
 * and one whose PM start ended without its PM says so (pmStartEnded). [operationId] names this command's rows.
 */
export function settlePmChats(before: SuperTabState, state: SuperTabState, operationId: string): { rows: MessageDraft[]; late: LateDelivery[] } {
  const rows: MessageDraft[] = [], late: LateDelivery[] = []
  const was = projectsOf(before).filter(p => p.pmChat), now = projectsOf(state).filter(p => p.pmChat)
  // Only a PM chat that waits has anything to say, and few do at a time: most commands stop here.
  if (!was.length && !now.length) return { rows, late }
  const say = (chat: Conversation | undefined, text: string) => {
    const row = chat && !chat.agentIds.length && rowIn(state, chat, stableId('pm-chat', chat.id, operationId), text)
    if (row) rows.push(row)
  }
  for (const project of was) {
    const after = projectsOf(state).find(p => p.id === project.id)
    if (after?.pmChat?.id === project.pmChat!.id) continue
    say(state.conversations.find(c => c.id === project.pmChat!.id), after
      ? `Someone else asked for this project's ${COORDINATOR_NAME}, so none joins this chat.`
      : `This project was deleted, so no ${COORDINATOR_NAME} joins this chat.`)
  }
  for (const project of now) {
    const chat = state.conversations.find(c => c.id === project.pmChat!.id)
    const pm = leaderOf(state, project)
    if (chat && !chat.agentIds.length && !pm) continue
    const waiting = project.pmChat!.waiting ?? []
    delete project.pmChat
    if (!chat || chat.agentIds.length || !pm) continue
    const own = chat.audience?.people[0]
    const mine = !!own && pm.contributorId === own.id && pm.membershipGeneration === own.generation
    const hasChat = !!pm.chatId || state.conversations.some(c => isAgentChat(c) && c.agentIds.includes(pm.id))
    if (!mine || hasChat) {
      say(chat, mine ? `This project's ${COORDINATOR_NAME} already has its own chat. Send it what you wrote here.`
        : `Someone else's ${COORDINATOR_NAME} leads this project now, so none joins this chat.`)
      continue
    }
    chat.agentIds.push(pm.id)
    // By the name it is about to be given (agentNames.ts): this runs before agents are named, and a new PM's chat was titled
    // "Product Manager" in its person's notifications (review of #4095).
    chat.title = agentDisplayName(state.agents, pm.id) ?? pm.name
    pm.chatId = chat.id
    late.push(...waiting.map(messageId => ({ messageId, conversationId: chat.id, agentId: pm.id, lead: true as const,
      author: { kind: 'person' as const, id: own!.id, generation: own!.generation } })))
  }
  const running = new Set((before.starts ?? []).filter(s => s.request.leadFor && !s.error && !s.harnessId).map(s => s.id))
  rows.push(...(state.starts ?? []).filter(s => running.has(s.id) && s.error && !s.harnessId).flatMap(start => pmStartEnded(state, start)))
  return { rows, late }
}

/**
 * Swarm v4 has no Buddies (the lead's decision, 2026-11-10): every Buddy becomes an ordinary agent of its person, and its private
 * Buddy chat that agent's 1:1 chat with them (kind `agent-chat`), read by the same one person (projects.ts readsAgentChat), as
 * before. Run by the time checks (store.ts runTimeChecks) and once over every Swarm at worker start (buddyConversionPass.ts).
 * Nothing makes a Buddy any more, so a converted Swarm has none, and a second run finds nothing. Goes with the Buddy read rules
 * once a released backend has converted every Swarm (slice S17b).
 */
import { isBuddyChat } from './buddies.js'
import { takeOutAgent } from './closedAgents.js'
import type { Agent, Conversation, SuperTabState } from './model.js'

/** What a Buddy start still waiting fails with: nothing starts a Buddy now. */
export const BUDDY_START_ENDED = 'Buddies are agents now.'

/** Whether [state] has anything to convert: a Buddy, or a Buddy start still waiting. */
export const holdsBuddies = (state: Pick<SuperTabState, 'agents' | 'starts'>): boolean =>
  state.agents.some(a => a.buddyOf) || !!state.starts?.some(s => s.request.buddyOf && !s.harnessId && !s.error)

/** The Buddies' ids, whose chats the caller loads first, dormant ones too (store.ts ensure by agent). */
export const buddyIds = (state: Pick<SuperTabState, 'agents'>): string[] => state.agents.filter(a => a.buddyOf).map(a => a.id)

/**
 * Converts every Buddy of [state]. A main Buddy becomes a Regular agent of its person (agent.new's kind), in its own Buddy chat,
 * which becomes its 1:1 chat with the same audience and loses what only a Buddy chat had. A Buddy that could not read that chat
 * as an agent (projects.ts readsAgentChat: its person left, or it runs on someone else's machine or account) is removed instead,
 * and so are thread sessions and older project-chat sessions, which only ran beside a main Buddy: their hosts close them. A
 * Buddy start still waiting fails. The removed agents, whose deliveries the caller ends.
 */
export function convertBuddies(state: SuperTabState): Agent[] {
  for (const start of state.starts ?? []) if (start.request.buddyOf && !start.harnessId && !start.error) start.error = BUDDY_START_ENDED
  const removed: Agent[] = []
  for (const buddy of state.agents.filter(a => a.buddyOf)) {
    const chat = state.conversations.find(c => isBuddyChat(c) && c.agentIds.includes(buddy.id))
    if (buddy.buddySession || buddy.buddyNarrow || !ownsItself(state, buddy, chat)) {
      takeOutAgent(state, buddy)
      removed.push(buddy)
      continue
    }
    const { buddyOf: _of, buddyScope: _scope, modelRequest: _model, homeOwed: _home, gridModelUnservedSince: _unserved, gridModelName: _grid,
      switchRequest: _switch, asleep: _asleep, projectId: _project, ...agent } = buddy
    const converted: Agent = { ...agent, regular: true, ...(chat ? { chatId: chat.id } : {}) }
    state.agents = state.agents.map(a => a === buddy ? converted : a)
    if (chat) convertChat(chat, converted)
  }
  // A session's agent left above; what its chat kept of it goes with the chat's conversion, and from a chat with no Buddy left.
  for (const chat of state.conversations) if (isBuddyChat(chat)) delete chat.buddySessions
  return removed
}

/** Whether [buddy] would read [chat] as an agent reads its 1:1 chat: its person's own, at the membership it was added in, on that
 *  person's own machine and account. Without a chat it gets a new one (agentChats.ts giveAgentsChats), if its person is here. */
function ownsItself(state: SuperTabState, buddy: Agent, chat: Conversation | undefined): boolean {
  const of = buddy.buddyOf!
  const person = state.people.find(p => p.id === of.personId && p.generation === of.generation)
  const audience = chat?.audience?.people
  return !!person && buddy.contributorId === person.id && buddy.machineOwnerId === person.id && buddy.membershipGeneration === person.generation
    && (!chat || (audience?.length === 1 && audience[0]!.id === person.id && audience[0]!.generation === person.generation))
}

function convertChat(chat: Conversation, agent: Agent): void {
  const { buddyName, buddyChats: _chats, buddyDefault: _default, buddyDownTold: _told, buddySessions: _sessions, projectId: _project, ...rest } = chat
  for (const key of Object.keys(chat) as Array<keyof Conversation>) delete chat[key]
  Object.assign(chat, rest, { kind: 'agent-chat', title: buddyName ?? agent.displayName ?? agent.name, agentIds: [agent.id] })
}

/**
 * Swarm v4 (anh Dee 2026-11-09): every agent but a Buddy has one 1:1 chat with its person, and that chat is where its person
 * talks to it. An agent from before v4 (a PM whose chat was its project's channel, an agent started before chats of their own)
 * gets its chat from the time checks' pass (store.ts runTimeChecks), once: an agent then keeps its chat's id (`chatId`).
 */
import { isBuddy } from './buddies.js'
import { stableId, type SuperTabState } from './model.js'
import { isAgentChat } from './projects.js'

/** Gives each agent of [state] that keeps no chat id the 1:1 chat it is already in, else a new one with its person. [all]
 *  holds every conversation these agents are in, dormant ones too; [state] gets only the new chats, so what else reads it
 *  this pass sees what it loaded. An agent whose person left the Swarm gets none. */
export function giveAgentsChats(state: SuperTabState, now: number, all: SuperTabState = state): void {
  for (const target of state.agents) {
    if (target.chatId || isBuddy(target)) continue
    const own = all.conversations.find(c => isAgentChat(c) && c.agentIds.includes(target.id))
    if (own) { target.chatId = own.id; continue }
    const owner = state.people.find(p => p.id === target.contributorId)
    if (!owner) continue
    const id = stableId('agent-chat', target.id, owner.generation)
    state.conversations.push({ id, kind: 'agent-chat', title: target.displayName ?? target.name, leadId: null, agentIds: [target.id],
      archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0,
      audience: { people: [{ id: owner.id, generation: owner.generation }] }, lastActivityAt: new Date(now).toISOString() })
    target.chatId = id
  }
}

/** The agents [giveAgentsChats] has to look at: those that keep no chat id, Buddies aside. */
export const chatlessAgents = (state: SuperTabState): string[] => state.agents.filter(a => !a.chatId && !isBuddy(a)).map(a => a.id)

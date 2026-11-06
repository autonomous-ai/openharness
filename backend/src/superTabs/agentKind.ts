/**
 * What an agent is to the person who brought it (Swarm v3, task #4116; anh Dee 11-07): their Buddy, a PM that leads a project,
 * or a Regular agent, which no project holds and whose task decides where it works. The left pane's "My agents" lists the
 * reader's own by this, a crown beside a PM, each bold while its chat has news the reader has not read (their read marks).
 */
import { isBuddy, isBuddyChat } from './buddies.js'
import type { Agent, SuperTabState } from './model.js'
import { ledProject } from './projects.js'

export type AgentKind = 'buddy' | 'pm' | 'regular'

export function agentKind(state: SuperTabState, target: Agent): AgentKind {
  if (isBuddy(target)) return 'buddy'
  return ledProject(state, target.id) ? 'pm' : 'regular'
}

/** The chat [target]'s person talks to it in: a Buddy's own chat, a PM's project chat; none yet for a Regular agent. */
export function agentChatId(state: SuperTabState, target: Agent): string | null {
  if (isBuddy(target)) return state.conversations.find(c => isBuddyChat(c) && c.agentIds.includes(target.id))?.id ?? null
  return ledProject(state, target.id)?.leadConversationId ?? null
}

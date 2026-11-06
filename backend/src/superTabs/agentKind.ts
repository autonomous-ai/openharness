/**
 * What an agent is to the person who brought it (Swarm v3, task #4116; anh Dee 11-07): their Buddy, a PM that leads a project,
 * or a Regular agent, which no project holds and whose task decides where it works. The left pane's "My agents" lists the
 * reader's own by this, a crown beside a PM, each bold while its chat has news the reader has not read (their read marks).
 */
import { isBuddy, isBuddyChat } from './buddies.js'
import type { Actor, Agent, SuperTabState } from './model.js'
import { isAgentChat, ledProject, onTeamAccount } from './projects.js'

export type AgentKind = 'buddy' | 'pm' | 'regular'

export function agentKind(state: SuperTabState, target: Agent): AgentKind {
  if (isBuddy(target)) return 'buddy'
  return ledProject(state, target.id) ? 'pm' : 'regular'
}

/** The chat [target]'s person talks to it in: a Buddy's own chat, a PM's project chat, a Regular agent's own chat (agent.new);
 *  none for an agent started before chats of their own. */
export function agentChatId(state: SuperTabState, target: Agent): string | null {
  if (isBuddy(target)) return state.conversations.find(c => isBuddyChat(c) && c.agentIds.includes(target.id))?.id ?? null
  const led = ledProject(state, target.id)
  if (led) return led.leadConversationId
  return state.conversations.find(c => isAgentChat(c) && c.agentIds.includes(target.id))?.id ?? null
}

/** Whether [target] is in [actor]'s My agents (task #4192, anh Dee 11-07: his list showed about 30 rows, agents he never
 *  started among them): their own main Buddy, or an agent they brought that runs on their own account, is running and is not
 *  finished or being stopped. A PM leading a project stays while its session restarts: its project chat is its person's. */
export function inMyAgents(state: SuperTabState, actor: Actor, target: Agent): boolean {
  if (actor.kind !== 'person' || target.contributorId !== actor.userId) return false
  if (isBuddy(target)) return target.buddyOf!.personId === actor.userId && !target.buddySession
  if (onTeamAccount(state, target) || target.workDecision === 'awaiting' || target.workDecision === 'stop') return false
  return (!target.downSince && !target.asleep) || !!ledProject(state, target.id)
}

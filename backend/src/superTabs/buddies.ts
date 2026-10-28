/** Buddies (Ken's spec, 10-28): each person may add their own agent per project and brainstorm with it in a chat only they
 *  read. When they ask, it posts one proposal in the project chat on their behalf; the PM assigns the work as usual. A Buddy
 *  reads only its project's chat and its own chat, and does nothing but post in its chat and propose. Behind the Swarm's
 *  `buddies` setting, off by default. */
import type { Agent, Conversation } from './model.js'

export const isBuddy = (target: Pick<Agent, 'buddyOf'>): boolean => !!target.buddyOf
export const isBuddyChat = (group: Pick<Conversation, 'kind'>): boolean => group.kind === 'buddy'

/** Whether a Buddy reads [group] of its own project: the project chat, and its own owner's chat it is in. */
export function buddyReads(buddy: Agent, group: Conversation, leadConversationId: string): boolean {
  if (group.id === leadConversationId) return true
  return isBuddyChat(group) && group.agentIds.includes(buddy.id) && group.audience?.people.some(p => p.id === buddy.buddyOf!.personId) === true
}

/** Buddies (Ken's spec, 10-28): each person may add their own agent per project and brainstorm with it in a chat only they
 *  read. When they ask, it posts one proposal in the project chat on their behalf; the PM assigns the work as usual. A Buddy
 *  reads only its project's chat and its own chat, and does nothing but post in its chat and propose. Behind the Swarm's
 *  `buddies` setting, off by default. */
import { stableId, type Agent, type AgentStartRequest, type Conversation, type Person } from './model.js'

export const isBuddy = (target: Pick<Agent, 'buddyOf'>): boolean => !!target.buddyOf
export const isBuddyChat = (group: Pick<Conversation, 'kind'>): boolean => group.kind === 'buddy'

/** Whether a Buddy reads [group] of its own project: the project chat, and its own owner's chat it is in. */
export function buddyReads(buddy: Agent, group: Conversation, leadConversationId: string): boolean {
  if (group.id === leadConversationId) return true
  return isBuddyChat(group) && group.agentIds.includes(buddy.id) && group.audience?.people.some(p => p.id === buddy.buddyOf!.personId) === true
}

/** A person's Buddy chat in a project, the same each time they add a Buddy there; a new membership opens a new one, as a
 *  private conversation's audience is held at the membership it was opened in. */
export const buddyChatId = (projectId: string, owner: Pick<Person, 'id' | 'generation'>): string => stableId('buddy', projectId, owner.id, owner.generation)

/** What a Buddy asks of its machine: it reads and talks, so the usual agent's share with git to read the project. */
export const BUDDY_REQUIREMENTS: AgentStartRequest['requirements'] = { memoryBytes: 2 * 1024 ** 3, diskBytes: 1024 ** 3, maxCpuPercent: 85,
  tools: ['git'], devices: [], quotaRequired: false }

/** The line a Buddy's chat shows once its session joined. */
export const buddyReady = (name: string): string => `${name} is ready. Tell it what you have in mind.`

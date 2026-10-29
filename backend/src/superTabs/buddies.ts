/** Buddies (Ken's spec, 10-28): each person may add their own agent per project and brainstorm with it in a chat only they
 *  read. When they ask, it posts one proposal in the project chat on their behalf; the PM assigns the work as usual. A Buddy
 *  reads what its person reads of its project but no private conversation (Ken, 10-29), and does nothing but post in its
 *  chat and propose. Behind the Swarm's `buddies` setting, off by default. */
import { fail, stableId, type Agent, type AgentStartRequest, type Conversation, type Person } from './model.js'

export const isBuddy = (target: Pick<Agent, 'buddyOf'>): boolean => !!target.buddyOf
export const isBuddyChat = (group: Pick<Conversation, 'kind'>): boolean => group.kind === 'buddy'

/** Whether a Buddy reads [group] of its own project, as its person would (Ken, 10-29): the project chat, its own chat, and
 *  the project's workgroups. Never a private conversation, its own person's with others included, nor another Buddy chat.
 *  [person] is its person while still a member at the membership they added it in, and reading the project themselves;
 *  without one it reads nothing. */
export function buddyReads(buddy: Agent, group: Conversation, leadConversationId: string, person: Pick<Person, 'id'> | undefined): boolean {
  if (!person) return false
  if (isBuddyChat(group)) return group.agentIds.includes(buddy.id) && group.audience?.people.some(p => p.id === person.id) === true
  return group.id === leadConversationId || !group.audience
}

/** A person's Buddy chat in a project, the same each time they add a Buddy there; a new membership opens a new one, as a
 *  private conversation's audience is held at the membership it was opened in. */
export const buddyChatId = (projectId: string, owner: Pick<Person, 'id' | 'generation'>): string => stableId('buddy', projectId, owner.id, owner.generation)

/** What a Buddy asks of its machine: it reads and talks, so the usual agent's share with git to read the project. */
export const BUDDY_REQUIREMENTS: AgentStartRequest['requirements'] = { memoryBytes: 2 * 1024 ** 3, diskBytes: 1024 ** 3, maxCpuPercent: 85,
  tools: ['git'], devices: [], quotaRequired: false }

/** The line a Buddy's chat shows once its session joined. */
export const buddyReady = (name: string): string => `${name} is ready. Tell it what you have in mind.`

/** What a Buddy may send: posts in its own chat, its owner's proposals, and what its machine reports for every agent (its
 *  model, a terminal alert, its own stop). Every other command is refused, so it can never assign, start, route, ask
 *  decisions or change anything for its owner (spec constraint: PRIVACY-CRITICAL). */
const SPEAKS: ReadonlySet<string> = new Set(['message.send', 'message.react', 'buddy.propose'])
const BUDDY_COMMANDS: ReadonlySet<string> = new Set(['message.send', 'message.react', 'buddy.propose', 'agent.configuration', 'agent.alert',
  'agent.stopLease', 'agent.stopRefused', 'agent.remove'])

export function requireBuddyCommand(buddy: Agent, command: { type: string; conversationId?: unknown; agentId?: unknown }, groups: readonly Conversation[],
  on: boolean): void {
  if (!BUDDY_COMMANDS.has(command.type)) fail('BUDDY_FORBIDDEN', 'A Buddy only talks with its owner and sends the proposals they ask for.', 403)
  // Its host's reports and its own stop still go through, so a Buddy left over from before the switch winds down.
  if (!on && SPEAKS.has(command.type)) fail('BUDDIES_OFF', 'Buddies are off in this Swarm.', 403)
  if ('agentId' in command && command.agentId !== buddy.id) fail('BUDDY_FORBIDDEN', 'A Buddy acts only for itself.', 403)
  if (command.type === 'message.send' || command.type === 'message.react' || command.type === 'buddy.propose') {
    const group = groups.find(g => g.id === command.conversationId)
    if (!group || !isBuddyChat(group) || !group.agentIds.includes(buddy.id)) {
      fail('BUDDY_FORBIDDEN', 'A Buddy posts only in its own chat. Send a proposal to reach the PM.', 403)
    }
  }
}

/** The asks a Buddy chat remembers having proposed for, newest last: an older one could be named again only after 200 more. */
export const MAX_PROPOSAL_ASKS = 200
/** How long an owner's message, other than their newest in the chat, may still be named as asking for a proposal. */
export const PROPOSAL_ASK_MS = 60 * 60_000

/** Written by the server, never the Buddy: who it is for and on whose behalf, then the three parts the PM needs. */
export function proposalText(owner: string, proposal: { goal: string; scope: string; priority: string }): string {
  return `Proposal from ${owner}'s Buddy, on ${owner}'s behalf.\n\nGoal: ${proposal.goal}\nScope: ${proposal.scope}\nPriority: ${proposal.priority}`
}

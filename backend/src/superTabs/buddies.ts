/** Buddies (Ken's spec, 10-28): each person may add their own agent per project and brainstorm with it in a chat only they
 *  read. When they ask, it posts one proposal in the project chat on their behalf; the PM assigns the work as usual. A Buddy
 *  reads only its project's chat and its own chat, and does nothing but post in its chat and propose. On in every Swarm:
 *  Buddies replaced Chat with PM (Ken, 10-29). */
import { fail, nextConversationNumber, stableId, type Agent, type AgentStartRequest, type Conversation, type Person, type SuperTabState } from './model.js'

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

/** [owner]'s Buddy chat in [projectId], opened if they have none yet and again if archived (Lead's ruling, 10-29): every
 *  person has one in each project from the start, before any Buddy, so the PM's private lines to them never drop. Only
 *  they read it (projects.ts canReadGroup); the caller checks that they read the project. A quiet one is loaded by its id
 *  first (store.ts moreNamed), so it is never opened twice. */
export function openBuddyChat(state: SuperTabState, projectId: string, owner: Person): Conversation {
  const id = buddyChatId(projectId, owner)
  let chat = state.conversations.find(c => c.id === id)
  if (!chat) {
    const number = nextConversationNumber(state)
    state.groupCounter = number
    chat = { id, kind: 'buddy', ...(state.projects ? { projectId } : {}), number, title: `${owner.email.split('@')[0]}'s Buddy`, leadId: null,
      agentIds: [], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0,
      audience: { people: [{ id: owner.id, generation: owner.generation }] } }
    state.conversations.push(chat)
  }
  chat.archived = false
  return chat
}

/** What a Buddy asks of its machine: it reads and talks, so the usual agent's share with git to read the project. */
export const BUDDY_REQUIREMENTS: AgentStartRequest['requirements'] = { memoryBytes: 2 * 1024 ** 3, diskBytes: 1024 ** 3, maxCpuPercent: 85,
  tools: ['git'], devices: [], quotaRequired: false }

/** The line a Buddy's chat shows once its session joined. */
export const buddyReady = (name: string): string => `${name} is ready. Tell it what you have in mind.`

/** What a Buddy may send: posts in its own chat, its owner's proposals, and what its machine reports for every agent (its
 *  model, a terminal alert, its own stop). Every other command is refused, so it can never assign, start, route, ask
 *  decisions or change anything for its owner (spec constraint: PRIVACY-CRITICAL). */
const BUDDY_COMMANDS: ReadonlySet<string> = new Set(['message.send', 'message.react', 'buddy.propose', 'agent.configuration', 'agent.alert',
  'agent.stopLease', 'agent.stopRefused', 'agent.remove'])

export function requireBuddyCommand(buddy: Agent, command: { type: string; conversationId?: unknown; agentId?: unknown }, groups: readonly Conversation[]): void {
  if (!BUDDY_COMMANDS.has(command.type)) fail('BUDDY_FORBIDDEN', 'A Buddy only talks with its owner and sends the proposals they ask for.', 403)
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
/** The files one proposal may carry: its plan, spec, log or screenshot, each held to a chat file's own limits. */
export const MAX_PROPOSAL_ATTACHMENTS = 5

/** Written by the server, never the Buddy: who it is for and on whose behalf, then the three parts the PM needs. */
export function proposalText(owner: string, proposal: { goal: string; scope: string; priority: string }): string {
  return `Proposal from ${owner}'s Buddy, on ${owner}'s behalf.\n\nGoal: ${proposal.goal}\nScope: ${proposal.scope}\nPriority: ${proposal.priority}`
}

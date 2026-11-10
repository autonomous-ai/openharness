/** Buddies (Ken's spec, 10-28): each person may add their own agent per project and brainstorm with it in a chat only they
 *  read. A Buddy reads what its person reads of its project but no private conversation (Ken, 10-29), and does nothing but
 *  post in its chat. On in every Swarm: Buddies replaced Chat with PM (Ken, 10-29). */
import { agentDisplayName } from './agentNames.js'
import { fail, nextConversationNumber, stableId, type Actor, type Agent, type AgentStartRequest, type Author, type Conversation, type MessageDraft, type Person, type SuperTabState } from './model.js'

export const isBuddy = (target: Pick<Agent, 'buddyOf'>): boolean => !!target.buddyOf
/** A person's Buddy chat: in a project, or their one chat for the whole Swarm. */
export const isBuddyChat = (group: Pick<Conversation, 'kind'>): boolean => group.kind === 'buddy' || group.kind === 'swarm-buddy'
/** A person's one Buddy chat for the whole Swarm (Dee, 10-31): outside every project, as the Leads conversation is. */
export const isSwarmBuddyChat = (group: Pick<Conversation, 'kind'>): boolean => group.kind === 'swarm-buddy'
/** A Buddy that reads every project its person reads and writes nowhere but its own chat: a Swarm chat's main Buddy or plain
 *  session. A project session, and every Buddy of a project's chat, reads its one project instead. */
export const isSwarmBuddy = (target: Pick<Agent, 'buddyOf' | 'buddyScope'> | undefined): boolean => !!target?.buddyOf && target.buddyScope === 'swarm'
/** The project a project session works in (spec: The model); undefined for a Swarm-wide Buddy and for a Buddy of a project's
 *  chat, whose project is its chat's. */
export const sessionProjectId = (target: Pick<Agent, 'buddySession'> | undefined): string | undefined => target?.buddySession?.projectId
/** A project PM's private line to one person in their one Buddy chat (commands.ts person.tell): its source names the project. */

/** Whether a Buddy reads [group] of its own project, as its person would (Ken, 10-29): the project chat, its own chat, and
 *  the project's workgroups. Never a private conversation, its own person's with others included, nor another Buddy chat.
 *  [person] is its person while still a member at the membership they added it in, and reading the project themselves;
 *  without one it reads nothing. */
export function buddyReads(buddy: Agent, group: Conversation, leadConversationId: string, person: Pick<Person, 'id'> | undefined): boolean {
  if (!person) return false
  if (isBuddyChat(group)) return group.agentIds.includes(buddy.id) && group.audience?.people.some(p => p.id === person.id) === true
  return group.id === leadConversationId || !group.audience
}

/** The rows that tell how work is routed: a route and its override name the machines that could run a task and why others
 *  could not, and a rule row the routing rules. A Buddy reads none of them, as its Swarm read has no machines or rules. */
/** The nightly routing reflection (lib/routingReflection.ts) says what each engine and model cost and how it went: routing too. */
const ROUTING_ROWS: ReadonlySet<string> = new Set(['route', 'route-override', 'rule', 'routing-reflection'])
export const routingRow = (source: unknown): boolean => ROUTING_ROWS.has(String((source as { kind?: unknown } | null | undefined)?.kind))

/** Whether [actor] is a Buddy, which reads no routing (no route rows, routing decisions, policy or costs) and no machines. */
export const isBuddyReader = (state: SuperTabState, actor: Actor): boolean =>
  actor.kind === 'agent' && state.agents.some(a => a.id === actor.agentId && isBuddy(a))
export function refuseBuddyRouting(state: SuperTabState, actor: Actor): void {
  if (isBuddyReader(state, actor)) fail('BUDDY_FORBIDDEN', 'A Buddy reads no routing.', 403)
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
    chat = { id, kind: 'buddy', ...(state.projects ? { projectId } : {}), number, title: NEW_BUDDY_TITLE, leadId: null,
      agentIds: [], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0,
      audience: { people: [{ id: owner.id, generation: owner.generation }] } }
    state.conversations.push(chat)
  }
  chat.archived = false
  return chat
}

/** A person's one Buddy chat in the Swarm, the same each time they open it; a new membership opens a new one. */
export const swarmBuddyChatId = (owner: Pick<Person, 'id' | 'generation'>): string => stableId('buddy', 'swarm', owner.id, owner.generation)

/** [owner]'s one Buddy chat in the Swarm (Dee, 10-31), opened if they have none yet and again if archived: at Swarm level, with
 *  no project, read only by them and their Buddy (projects.ts readsRecordsIn). A quiet one is loaded by its id first
 *  (store.ts commandGroups). */
export function openSwarmBuddyChat(state: SuperTabState, owner: Person): Conversation {
  const id = swarmBuddyChatId(owner)
  let chat = state.conversations.find(c => c.id === id)
  if (!chat) {
    const number = nextConversationNumber(state)
    state.groupCounter = number
    chat = { id, kind: 'swarm-buddy', number, title: NEW_BUDDY_TITLE, leadId: null, agentIds: [], archived: false, brief: '',
      checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: owner.id, generation: owner.generation }] } }
    state.conversations.push(chat)
  }
  chat.archived = false
  return chat
}

/** Whether [agent] is [person]'s own main Buddy now: theirs at their current membership, never a thread session's. */
const ownBuddy = (agent: Agent, person: Pick<Person, 'id' | 'generation'>): boolean => isSwarmBuddy(agent) && !agent.buddySession
  && agent.buddyOf!.personId === person.id && agent.buddyOf!.generation === person.generation

/** How many Buddies a person may have in a Swarm unless its owner sets another number (spec: "Many Buddies", task #3818). */
export const BUDDY_CAP = 5
/** A Buddy chat's title until its agent has its name (task #4568: never "<person>'s Buddy"), as Desktop shows it. */
const NEW_BUDDY_TITLE = 'Your agent'
export const buddyCapOf = (state: Pick<SuperTabState, 'buddyCap'>): number => state.buddyCap ?? BUDDY_CAP

/** [person]'s Buddy chats loaded here, oldest first: their main chat (swarmBuddyChatId), then those it lists (buddyChats), each
 *  theirs at their current membership and not removed. */
export function buddyChatsOf(state: SuperTabState, person: Pick<Person, 'id' | 'generation'>): Conversation[] {
  const main = state.conversations.find(c => c.id === swarmBuddyChatId(person))
  const listed = (main?.buddyChats ?? []).map(id => state.conversations.find(c => c.id === id))
  return [main, ...listed].filter((c): c is Conversation => !!c && isSwarmBuddyChat(c) && !c.archived
    && !!c.audience?.people.some(p => p.id === person.id && p.generation === person.generation))
}

/** The chat whose Buddy is [person]'s default: the one marked, else their main chat. Undefined when none is loaded. */
const defaultChatOf = (state: SuperTabState, person: Pick<Person, 'id' | 'generation'>): Conversation | undefined => {
  const chats = buddyChatsOf(state, person)
  return chats.find(c => c.buddyDefault) ?? chats.find(c => c.id === swarmBuddyChatId(person))
}

/** [personId]'s default Buddy in this Swarm: the one their lines go to, a removed Buddy's news and what is asked of them (task
 *  #3818): the Buddy of their default chat; with that chat not loaded, their first Buddy, as before several. Undefined when they
 *  have none, or are not in the Swarm. Never throws. */
export function defaultBuddy(state: SuperTabState, personId: string): Agent | undefined {
  const person = state.people.find(p => p.id === personId)
  if (!person) return undefined
  const chat = defaultChatOf(state, person)
  return chat ? state.agents.find(agent => ownBuddy(agent, person) && chat.agentIds.includes(agent.id))
    : state.agents.find(agent => ownBuddy(agent, person))
}

/** Who writes a server notice in [person]'s private chat: their own default Buddy, as only they and it post there (anh Dee,
 *  11-07, task #4558). Undefined when they have none: then the notice is not written, and what it tells stays where it lives
 *  (Needs you, Members, the card). */
export function ownAgentAuthor(state: SuperTabState, person: Pick<Person, 'id'>): Author | undefined {
  const buddy = defaultBuddy(state, person.id)
  return buddy && { kind: 'agent', id: buddy.id, name: buddy.name, displayName: agentDisplayName(state.agents, buddy.id),
    membershipGeneration: buddy.membershipGeneration }
}

export const PRIVATE_CHAT_REFUSAL = 'Only a person and their own agent post in their private chat. Post in the project chat, tagging them, or in the task\'s chat.'

/** In a person's private chat with their own agent, only they and their own agent post (anh Dee, 11-07, task #4558: "I don't
 *  want River or Theo to show up in this chat"): any other agent's row, a Lead's included, refuses the command that wrote it.
 *  The writer is looked up after the command, else before it: a thread session that ended in it writes its own last line. */
export function refuseOthersInPrivateChat(state: SuperTabState, messages: readonly MessageDraft[], before: Pick<SuperTabState, 'agents'>): void {
  for (const m of messages) {
    if (m.author.kind !== 'agent') continue
    const chat = state.conversations.find(c => c.id === m.conversationId)
    if (!chat || !isBuddyChat(chat)) continue
    const owner = chat.audience?.people[0]
    const writer = state.agents.find(a => a.id === m.author.id) ?? before.agents.find(a => a.id === m.author.id)
    if (owner && writer?.buddyOf?.personId === owner.id && writer.buddyOf.generation === owner.generation) continue
    fail('PRIVATE_CHAT', PRIVATE_CHAT_REFUSAL, 403)
  }
}

/** The chat a line for [person] goes to: their default Buddy's, or with none their main Buddy chat, opened if missing, so there
 *  is always somewhere to write (task #3818). */
export function defaultBuddyChat(state: SuperTabState, person: Person): Conversation {
  return defaultChatOf(state, person) ?? openSwarmBuddyChat(state, person)
}

/** A Buddy's measured memory (task #3738, 11-06). A Buddy is one Claude Code session that reads and talks. Measured on a Mac (macOS
 *  26.5.1, arm64): the resident memory of the 38 live Claude Code sessions there, from 195 MB to 1,510 MB, median 580 MB and 90th
 *  percentile 796 MB. The peak a new Buddy needs is that of an ordinary session: 800 MiB. The few sessions near 1.5 GB are
 *  long-running builders, which a Buddy is not, and a Buddy already running is never refused for what it grows to. Windows: not
 *  measured here (no Windows machine in this task); the figure below stands until a measurement on one says otherwise. */
export const BUDDY_PEAK_BYTES = 800 * 1024 ** 2
/** The margin above that peak a machine must have free before it takes a Buddy, so one never pushes it into swap: 1.6 times. */
export const BUDDY_MEMORY_MARGIN = 1.6

/** What a Buddy asks of its machine: it reads and talks, so its measured peak with a margin (BUDDY_PEAK_BYTES), and git to read the
 *  project. CPU use is one momentary sample, so it is not capped, as a routed Builder's start (Diego, 10-30). Checked when it is added
 *  (admitByRoom) and again by its host at launch, which both read this start request's requirements. */
export const BUDDY_REQUIREMENTS: AgentStartRequest['requirements'] = { memoryBytes: Math.round(BUDDY_PEAK_BYTES * BUDDY_MEMORY_MARGIN), diskBytes: 1024 ** 3,
  maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false }

/** What a Buddy may send: posts in its own chat, and what its machine reports for every agent (its
 *  model, a terminal alert, its own stop). Every other command is refused, so it can never assign, start, route, ask anyone or
 *  change anything for its owner (spec constraint: PRIVACY-CRITICAL). */
const BUDDY_COMMANDS: ReadonlySet<string> = new Set(['message.send', 'message.react', 'agent.configuration', 'agent.alert',
  'agent.stopLease', 'agent.stopRefused', 'agent.remove', 'agent.switchClaim', 'agent.switchResult', 'agent.rebind'])

export function requireBuddyCommand(buddy: Agent, command: { type: string; conversationId?: unknown; agentId?: unknown }, groups: readonly Conversation[]): void {
  if (!BUDDY_COMMANDS.has(command.type)) fail('BUDDY_FORBIDDEN', 'A Buddy only talks with its owner.', 403)
  if ('agentId' in command && command.agentId !== buddy.id) fail('BUDDY_FORBIDDEN', 'A Buddy acts only for itself.', 403)
  if (command.type === 'message.send' || command.type === 'message.react') {
    const group = groups.find(g => g.id === command.conversationId)
    if (!group || !isBuddyChat(group) || !group.agentIds.includes(buddy.id)) {
      fail('BUDDY_FORBIDDEN', 'A Buddy posts only in its own chat.', 403)
    }
  }
}


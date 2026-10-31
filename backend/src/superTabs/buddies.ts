/** Buddies (Ken's spec, 10-28): each person may add their own agent per project and brainstorm with it in a chat only they
 *  read. When they ask, it posts one proposal in the project chat on their behalf; the PM assigns the work as usual. A Buddy
 *  reads what its person reads of its project but no private conversation (Ken, 10-29), and does nothing but post in its
 *  chat and propose. On in every Swarm: Buddies replaced Chat with PM (Ken, 10-29). */
import { agentDisplayName, isRoleName } from './agentNames.js'
import { fail, nextConversationNumber, person, stableId, type Actor, type Agent, type AgentStartRequest, type Conversation, type Person, type SuperTabState } from './model.js'

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
export const PM_LINE_KIND = 'pm-line'
/** At most this many project threads a Swarm Buddy chat remembers (Conversation.projectThreads). */
export const MAX_PROJECT_THREADS = 500

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
    chat = { id, kind: 'buddy', ...(state.projects ? { projectId } : {}), number, title: defaultBuddyName(owner), leadId: null,
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
    chat = { id, kind: 'swarm-buddy', number, title: defaultBuddyName(owner), leadId: null, agentIds: [], archived: false, brief: '',
      checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: owner.id, generation: owner.generation }] } }
    state.conversations.push(chat)
  }
  chat.archived = false
  return chat
}

/** Remembers that [thread] of Swarm Buddy chat [chat] works in [projectId], so it hides once its person loses that project. */
export function noteProjectThread(chat: Conversation, thread: string, projectId: string): void {
  const kept = (chat.projectThreads ?? []).filter(t => t.thread !== thread)
  chat.projectThreads = [...kept, { thread, projectId }].slice(-MAX_PROJECT_THREADS)
}

/** What a Buddy is called until its owner names it: "ken's Buddy". */
export const defaultBuddyName = (owner: Pick<Person, 'email'>): string => `${owner.email.split('@')[0]}'s Buddy`

/** A Buddy's name as its owner may choose it, sized like a username (usernames are 2 to 32 characters, starting with a
 *  letter or digit) but a display name: letters of any case and language, digits, single spaces, `.`, `_`, `-` and
 *  apostrophes, as the default "ken's Buddy" has. Checked after NFKC, which also makes it the name kept; nothing that hides
 *  its shape (controls, bidi overrides, and every default-ignorable such as U+FE0F or a Hangul filler: review of #2094). */
const BUDDY_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}._'\u2019-]| (?! ))*$/u
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u
const BUDDY_NAME_LENGTH = { min: 2, max: 32 }
/** Names only a Buddy is refused, beside roles (agentNames.ts isRoleName, which also picks automatic agent names and so
 *  stays as it is): the Reviewer and the Swarm's own voices. Compared as `nameKey`s. */
const BUDDY_RESERVED: ReadonlySet<string> = new Set(['reviewer', 'admin', 'administrator', 'system', 'swarm', 'harness', 'everyone'])
/** A name as names are compared: NFKC, lowercased. Look-alike letters of other scripts are out of scope (review of #2094). */
const nameKey = (name: string): string => name.normalize('NFKC').toLowerCase()
/** Whether [name] is a reserved one, numbered too ("Reviewer 2", "system-3"), as the role check reads "Lead 2". */
const reserved = (name: string): boolean => BUDDY_RESERVED.has(nameKey(name).replace(/[\s#-]+\d+$/, ''))

/** A name chosen in a Buddy chat, as the store reads every Buddy chat's, quiet ones included (store.ts buddyNames). */
export interface ChosenBuddyName { conversationId: string; name: string }

/** Whether [name] for [chat]'s Buddy is someone else's: another agent's name (the PM's included) or one still starting, a
 *  person's, another person's default Buddy name, or a name chosen in another Buddy chat, loaded or listed by the store in
 *  [chosen]. Two commands claiming a name never both pass: each touches the head part (parts/touches.ts). */
function nameTaken(state: SuperTabState, chat: Conversation, name: string, chosen: readonly ChosenBuddyName[]): boolean {
  const owner = chat.audience?.people[0]?.id
  const others = [
    ...state.agents.filter(a => !chat.agentIds.includes(a.id)).map(a => agentDisplayName(state.agents, a.id) ?? a.name),
    // An agent still starting has its name already (review of #2094): its own Buddy's start excepted.
    ...(state.starts ?? []).filter(st => !st.harnessId && !st.error && st.request.conversationId !== chat.id).map(st => st.request.name),
    ...state.people.map(p => p.email.split('@')[0]!),
    ...state.people.filter(p => p.id !== owner).map(defaultBuddyName),
    ...state.conversations.filter(c => isBuddyChat(c) && c.id !== chat.id && c.buddyName).map(c => c.buddyName!),
    ...chosen.filter(c => c.conversationId !== chat.id).map(c => c.name),
  ]
  const key = nameKey(name)
  return others.some(other => nameKey(other) === key)
}

/** `buddy.rename`: a person names their own Buddy, from its chat, or clears the name for the default (Diego, 10-29). Only
 *  the chat's owner may; the Swarm owner and every agent are refused, and so is any chat that is not a Buddy chat. The name
 *  is kept on the chat, so a Buddy added again takes it (chosenBuddyName), and is shown at once by a running or starting one. */
export function renameBuddy(state: SuperTabState, actor: Actor, chat: Conversation, input: string | null, chosen: readonly ChosenBuddyName[] = []): void {
  if (actor.kind !== 'person') fail('BUDDY_PERSON', 'A person names their own Buddy.', 403)
  if (!isBuddyChat(chat)) fail('BUDDY_CHAT', 'Name a Buddy from your Buddy chat.', 400)
  const owner = person(state, actor.userId)
  if (!chat.audience?.people.some(p => p.id === owner.id && p.generation === owner.generation)) fail('NOT_FOUND', 'This conversation is unavailable.', 404)
  const name = input?.normalize('NFKC').trim() || null
  if (name) {
    const length = [...name].length
    if (length < BUDDY_NAME_LENGTH.min || length > BUDDY_NAME_LENGTH.max || INVISIBLE.test(name) || !BUDDY_NAME.test(name)) {
      fail('INVALID_BUDDY_NAME', 'Use 2 to 32 letters, digits, single spaces, dots, dashes, underscores or apostrophes, starting with a letter or digit.', 400)
    }
    if (isRoleName(name) || reserved(name)) fail('BUDDY_NAME_ROLE', `${name} is a role's name. Choose another.`, 400)
    if (nameTaken(state, chat, name, chosen)) fail('BUDDY_NAME_TAKEN', `${name} is taken in this Swarm. Choose another.`, 409)
    chat.buddyName = name
  } else {
    delete chat.buddyName
  }
  const shown = name ?? defaultBuddyName(owner)
  chat.title = shown
  for (const buddy of state.agents) if (isBuddy(buddy) && chat.agentIds.includes(buddy.id)) buddy.displayName = shown
  for (const start of state.starts ?? []) if (start.request.conversationId === chat.id && !start.error && !start.poolSettled) start.request.name = shown
}

/** The name [owner]'s Buddy added in [chat] starts with: the one chosen there, unless someone took it since (a new agent, a
 *  person who joined, another Buddy chat), when the chat goes back to the default rather than show two Buddies alike, and
 *  `notice` is the line that tells its owner so in their chat: nothing changes without saying (review of #2094). */
export function chosenBuddyName(state: SuperTabState, chat: Conversation, owner: Person, chosen: readonly ChosenBuddyName[] = []): { name: string; notice?: string } {
  const was = chat.buddyName
  if (!was) return { name: defaultBuddyName(owner) }
  if (!nameTaken(state, chat, was, chosen)) return { name: was }
  delete chat.buddyName
  chat.title = defaultBuddyName(owner)
  return { name: chat.title, notice: `${was} is taken now; your Buddy starts as ${chat.title}. Rename it from the ⋮ menu.` }
}

/** What a Buddy asks of its machine: it reads and talks, so the usual agent's share with git to read the project. CPU use is one
 *  momentary sample, so it is not capped, as a routed Builder's start (Diego, 10-30). */
export const BUDDY_REQUIREMENTS: AgentStartRequest['requirements'] = { memoryBytes: 2 * 1024 ** 3, diskBytes: 1024 ** 3, maxCpuPercent: 100,
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

/**
 * The Swarms a Harness Pro shows as cards on Home: for each Swarm (Super Tab) this account is in, one Lead per project with
 * what it is doing now, plus the last thing a Lead said, for the Pro's recap. Read as the person (never as an agent) from
 * the same backend routes the desktop uses, every 5 s while a capable Pro is attached (`want`); while the server pushes Swarm
 * changes, the list only when told and every 2 minutes (CARDS_SAFETY_MS). A tab's detail is read
 * only when its `lastChangedAt` moved, by what changed since the last read (superTabs/swarmReads.ts). The service hands the
 * result to the core whole (`onCards`); the core owns the wire.
 *
 * Status of a project's Lead, most pressing first: `ask` (an assignment of the project needs a person, `needs_human`),
 * `stuck` (`blocked`), `work` (an agent of the project, the Lead or a worker, runs here and is in a turn, as the app marks each
 * agent working by its own live turn, `since` from the earliest of those turns; or an assignment works or is in review, all there is for agents on
 * other machines), else `done`.
 * A paused Swarm keeps its card and every Lead reads `done`.
 *
 * For the round dial (design 2026-10-28-round-dial-swarm-chat) every Lead also carries the chat on its project's face (`chat`):
 * the Lead conversation, or the reader's Buddy chat or group the window has open (`want`'s focus); and the newest tag of the
 * reader's in its project since the baseline (`notice`), the dial's one alert: PM messages that tag nobody never alert (Diego,
 * #2965). `state` keeps its meaning for the Pro and older dials, which never read either.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { BackendNotice, CoreApi } from '../core/api.js'
import { backend, SuperTabHostError } from './host.js'
import { identifier, object, within } from './wire.js'
import { SwarmReads, type SwarmRead } from './swarmReads.js'
import { buddyAvatar } from './buddyAvatar.js'

type Json = Record<string, unknown>
/** The cards' shapes are the core's contract with the Swarm (core/api.ts), which the core declares and the Swarm imports. */
import type { CardChat, CardFocus, CardSide, ChatKind, LeadNotice, LeadRecap, LeadState, SaidOnCard, SayOptions, SwarmBuddy, SwarmCard, SwarmChat, SwarmLead } from '../core/api.js'
export type { CardChat, CardFocus, CardSide, LeadNotice, LeadRecap, LeadState, SaidOnCard, SayOptions, SwarmBuddy, SwarmCard, SwarmChat, SwarmLead } from '../core/api.js'

const MAX_CARDS = 16, MAX_LEADS = 12, NAME_BYTES = 48, RECAP_BYTES = 1500, MAX_LIST_PAGES = 10, MAX_RECAPS_IN_FLIGHT = 2
/** The tag ids kept per Swarm as seen: the server lists at most 500 of a person's tags there (backend mentions.ts tagRows). */
const MAX_TAGS_SEEN = 500
/** The digest of no waiting tags (backend mentions.ts mentionsDigest([])): a Swarm at it has none to read. */
const NO_TAGS = createHash('sha256').update('').digest('base64url').slice(0, 16)
/** The longest a dial's recap read waits on the one before it. */
const ASK_WAIT_MS = 10_000
/** A failed read of a dial thread's first message is tried again after this, doubling, at most ROOT_READ_TRIES times in all. */
const ROOT_READ_WAIT_MS = 10_000, ROOT_READ_TRIES = 5
/** The Pro keeps an id in 48 bytes with its NUL: 47 characters at most reach it. */
const ID_BYTES = 47
export const cardId = (v: unknown): v is string => identifier(v) && v.length <= ID_BYTES
const ORDER: Record<LeadState, number> = { ask: 0, stuck: 1, work: 2, done: 3 }

/** Cut on a character, never inside one: the Pro refuses a string it cannot read as UTF-8. */
function cut(text: string, bytes: number): string {
  let out = '', used = 0
  for (const char of text) {
    used += Buffer.byteLength(char)
    if (used > bytes) break
    out += char
  }
  return out
}
const list = (v: unknown): Json[] => Array.isArray(v) ? v.map(object) : []
const projectKey = (project: Json): string => String(project.id ?? 'lead')
const inProject = (conversation: Json, projectId: string): boolean => (conversation.projectId ?? 'lead') === projectId
/** A Buddy chat (backend buddies.ts), where the PM's private lines land since Buddies replaced Chat with PM (10-29). */
const isBuddyChat = (conversation: Json): boolean => conversation.kind === 'buddy' || conversation.kind === 'swarm-buddy'
/** A person's one Buddy chat for the whole Swarm (backend buddies.ts, Dee 10-31): it has no project, so no project's id
 *  finds it. Since #2447 it is where the reader's Buddy lives, and a card that looked only in its own project lost the
 *  dial's Buddy side (Diego, 11-02). */
const isSwarmBuddyChat = (conversation: Json): boolean => conversation.kind === 'swarm-buddy'
/** A Chat with PM: a private conversation with an audience that is not a Buddy chat. Read-only once Buddies are on
 *  (backend commands.ts `PM_CHAT_READ_ONLY`), so words spoken to it on the dial would only be refused. */
const isChatWithPm = (conversation: Json): boolean => conversation.audience != null && !isBuddyChat(conversation)
/** The reader's own: the backend sends a Buddy chat to its owner alone (read/views.ts `groupView`), and the dial checks it
 *  again, so another person's Buddy chat never becomes a face, a buddy block or a notice whatever a read holds. */
const isReadersBuddyChat = (conversation: Json, me: string | undefined): boolean =>
  isBuddyChat(conversation) && me !== undefined && conversation.buddyOwnerId === me
const sequenceOf = (conversation: Json): number => typeof conversation.lastMessageSequence === 'number' ? conversation.lastMessageSequence : 0
const idsOf = (v: unknown): string[] => Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : []

/** The reader's live Buddy chat for a project, when its id is one a dial can hold: their one Swarm Buddy chat when the Swarm
 *  has given them one (every project shares it), else their Buddy chat in that project, as older Swarms keep it. Another
 *  person's chat is neither, whatever a read holds. */
function buddyChatOf(conversations: Json[], projectId: string, me: string | undefined): Json | undefined {
  const live = (c: Json) => isReadersBuddyChat(c, me) && c.archived !== true && cardId(c.id)
  return conversations.find(c => isSwarmBuddyChat(c) && live(c)) ?? conversations.find(c => !isSwarmBuddyChat(c) && inProject(c, projectId) && live(c))
}
/** The reader's Buddies in their chat: the chat's agents that are a Buddy of the reader. One whose `buddyOf` names someone
 *  else (an agent id reused or misfiled) is not, and neither is a thread session (spec 2026-10-30-buddy-thread-sessions),
 *  which answers in its own thread: the dial's Buddy is the main one. */
function buddiesIn(agents: Json[], chat: Json, me: string | undefined): Json[] {
  const ids = idsOf(chat.agentIds)
  return agents.filter(a => typeof a.id === 'string' && ids.includes(a.id) && me !== undefined && object(a.buddyOf).personId === me
    && (a.buddySession === undefined || a.buddySession === null))
}
/** The name Desktop shows and draws an agent by (super_tabs/identity.dart). */
const agentName = (agent: Json): string => String(agent.displayName ?? agent.name ?? '')

type Face = { conversation: Json; kind: ChatKind }
const leadFace = (lead: Json): Face | null => cardId(lead.id) ? { conversation: lead, kind: 'lead' } : null

/** Today's face of a project (a round dial without swarmBuddy): the conversation the window has open when it is a live
 *  conversation of this project, else the project's Lead conversation; null when that one's id is not one a dial can hold.
 *  The reader's Buddy chat reads `pm`. An archived group is over: the face stays on the Lead (Ruling on the plan,
 *  2026-10-28), and so it does for another person's Buddy chat and, while Buddies are on, a read-only Chat with PM. */
function faceOf(conversations: Json[], projectId: string, lead: Json, focus: string | undefined, me: string | undefined, buddies: boolean): Face | null {
  const open = focus !== undefined && focus !== lead.id
    ? conversations.find(c => c.id === focus && inProject(c, projectId) && c.archived !== true && cardId(c.id)) : undefined
  if (!open || (isBuddyChat(open) && !isReadersBuddyChat(open, me)) || (buddies && isChatWithPm(open))) return leadFace(lead)
  return { conversation: open, kind: isBuddyChat(open) ? 'pm' : 'group' }
}
/** A swarmBuddy dial's face (spec 2026-10-29 Switching): on the Buddy side the reader's Buddy chat; otherwise today's face,
 *  where the Buddy chat the window has open is the Buddy screen, unless the dial swiped back to the PM since (the newest
 *  wins: a swipe sets the side, and the window's next focus change clears it). */
function sideFaceOf(conversations: Json[], projectId: string, lead: Json, focus: string | undefined, me: string | undefined, side: CardSide | undefined): Face | null {
  const buddyChat = buddyChatOf(conversations, projectId, me)
  if (side === 'buddy' && buddyChat) return { conversation: buddyChat, kind: 'buddy' }
  const face = faceOf(conversations, projectId, lead, focus, me, true)
  if (face?.kind !== 'pm') return face
  return side === 'pm' ? leadFace(lead) : { conversation: face.conversation, kind: 'buddy' }
}
/** Whose messages are the chat's recap: the Lead's in its conversation and, for an older dial, in the reader's Buddy chat
 *  (its private lines); the reader's Buddy's on a swarmBuddy dial's Buddy face; the group's agents' in a group. */
function voicesOf(face: Face, leadId: string, agents: Json[], me: string | undefined): Set<string> {
  if (face.kind === 'buddy') return new Set(buddiesIn(agents, face.conversation, me).map(a => a.id as string))
  if (face.kind !== 'group') return new Set([leadId])
  return new Set(idsOf(face.conversation.agentIds))
}
/** The reader's Buddy in a project as a dial draws it, from Desktop's pattern for its whole name. */
function buddyOf(agents: Json[], chat: Json, me: string | undefined, local: (a: Json) => string): SwarmBuddy | undefined {
  const [found] = buddiesIn(agents, chat, me)
  if (!found) return undefined
  const name = agentName(found), here = local(found)
  return { chatId: chat.id as string, name: cut(name, NAME_BYTES), engine: String(object(found.configuration).engine ?? ''), ...buddyAvatar(name),
    live: typeof found.downSince !== 'string', ...(here ? { local: here } : {}) }
}

/**
 * One Lead per project of the Swarm, most urgent first with ties in the app's project order; the 12 most urgent are kept, and
 * each carries its project's place in that order as `order` (gaps where a project has no Lead or was cut), which a dial swipes
 * by. The app's order is by name, case-insensitively A to Z (desktop super_tabs/project_sidebar.dart: the sidebar and
 * superTabSidebarOrder), ties in server order: the two must match. `live` says whether this machine's core has a
 * harness and whether it is in a turn (null: not here); `me` is the signed-in person's id, so a Lead on someone else's
 * machine names that owner (people[] has an email, which is the name a Swarm shows a person by).
 */
export function leadsOf(state: Json, machineId: string, live: (harnessId: string) => { inTurn: boolean; since?: number } | null, me?: string, focus?: string, side?: CardSide, thread?: (conversationId: string, leadId: string) => SwarmChat['thread']): { count: number; leads: SwarmLead[] } {
  const agents = list(state.agents), conversations = list(state.conversations), people = list(state.people)
  const buddies = state.buddies === true
  // An old tab has no `projects`: its one project is the tab itself, `lead`, led by the conversation `lead`.
  const projects = Array.isArray(state.projects) ? list(state.projects) : [{ id: 'lead', name: state.name, leadConversationId: 'lead' }]
  const paused = state.paused === true
  // An agent's project as the app's roster reads it: its own, else the first group that has it or that it leads.
  const projectOf = (a: Json) => typeof a.projectId === 'string' ? a.projectId
    : conversations.find(c => (Array.isArray(c.agentIds) && c.agentIds.includes(a.id)) || c.leadId === a.id)?.projectId ?? 'lead'
  const turnHere = (a: Json) => a.machineId === machineId && typeof a.harnessId === 'string' && a.harnessId !== '' ? live(a.harnessId) : null
  const leads: SwarmLead[] = []
  // Compared by code unit, as Dart's String.compareTo; Array.sort is stable, so a tie keeps server order.
  const named = (p: Json) => String(p.name ?? '').toLowerCase()
  const places = new Map(projects.map((p, i) => ({ p, i })).sort((a, b) => named(a.p) < named(b.p) ? -1 : named(a.p) > named(b.p) ? 1 : a.i - b.i)
    .map(({ p }, place) => [p, place]))
  for (const project of projects) {
    const order = places.get(project)!
    const lead = conversations.find(c => c.id === project.leadConversationId)
    const agent = lead && agents.find(a => a.id === lead.leadId)
    if (!agent) continue
    if (!cardId(agent.id) || !cardId(project.id ?? 'lead')) continue
    const harnessId = typeof agent.harnessId === 'string' ? agent.harnessId : ''
    const here = agent.machineId === machineId && harnessId ? live(harnessId) : null
    const waits = new Set(conversations.filter(c => (c.projectId ?? 'lead') === (project.id ?? 'lead') && c.archived !== true)
      .map(c => object(c.assignment).status))
    let state: LeadState = 'done', since: number | undefined
    if (!paused) {
      if (waits.has('needs_human')) state = 'ask'
      else if (waits.has('blocked')) state = 'stuck'
      else {
        // The project's clock is its earliest turn here (the most seconds in), the Lead's or a worker's.
        const turns = [here, ...agents.filter(a => a !== agent && projectOf(a) === (project.id ?? 'lead')).map(turnHere)].filter(t => t?.inTurn)
        if (turns.length) {
          state = 'work'
          const secs = turns.map(t => t!.since).filter((v): v is number => typeof v === 'number')
          if (secs.length) since = Math.max(...secs)
        } else if (waits.has('working') || waits.has('review')) state = 'work'
      }
    }
    const ownerId = agent.machineOwnerId
    const owner = me && typeof ownerId === 'string' && ownerId !== me ? people.find(p => p.id === ownerId) : undefined
    const projectId = projectKey(project)
    const chatOf = (face: Face | null): SwarmChat | undefined => {
      if (!face) return undefined
      const inThread = thread?.(face.conversation.id as string, String(agent.id))
      return { ...faceChat(face, String(agent.id), agents, me, turnHere), ...(inThread ? { thread: inThread } : {}) }
    }
    const chat = chatOf(faceOf(conversations, projectId, lead, focus, me, buddies))
    const buddyChat = buddies ? buddyChatOf(conversations, projectId, me) : undefined
    const sideChat = buddies ? chatOf(sideFaceOf(conversations, projectId, lead, focus, me, side)) : undefined
    const buddy = buddyChat && buddyOf(agents, buddyChat, me, a => turnHere(a) && cardId(a.harnessId) ? String(a.harnessId) : '')
    leads.push({
      id: String(agent.id), projectId: String(project.id ?? 'lead'), project: cut(String(project.name ?? ''), NAME_BYTES), engine: String(object(agent.configuration).engine ?? ''),
      owner: owner && typeof owner.email === 'string' ? cut(owner.email, NAME_BYTES) : '',
      local: here && cardId(harnessId) ? harnessId : '', state, order, ...(since !== undefined ? { since } : {}), ...(chat ? { chat } : {}),
      ...(sideChat ? { sideChat } : {}), ...(buddies ? { buddies: true as const } : {}), ...(buddy ? { buddy } : {}),
    })
  }
  // Equal urgency keeps the app's project order.
  const ordered = [...leads].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.order - b.order)
  return { count: ordered.length, leads: ordered.slice(0, MAX_LEADS) }
}

/** A face as the dial names it. Only a group works on the dial, and only while its assignment works: Lead, PM and Buddy
 *  chats never do (design decision 4). A Buddy face is named for the reader's Buddy, or plainly while it has none. */
function faceChat(face: Face, leadId: string, agents: Json[], me: string | undefined, turnHere: (a: Json) => { inTurn: boolean; since?: number } | null): SwarmChat {
  const { conversation, kind } = face
  const working = kind === 'group' && object(conversation.assignment).status === 'working'
  const voices = voicesOf(face, leadId, agents, me)
  const turns = working ? agents.filter(a => voices.has(a.id as string)).map(turnHere).filter(t => t?.inTurn) : []
  const secs = turns.map(t => t!.since).filter((v): v is number => typeof v === 'number')
  const [buddy] = kind === 'buddy' ? buddiesIn(agents, conversation, me) : []
  const name = kind === 'lead' ? 'Lead' : kind === 'pm' ? 'PM' : kind === 'buddy' ? (buddy ? cut(agentName(buddy), NAME_BYTES) : 'Buddy')
    : cut(String(conversation.title ?? ''), NAME_BYTES)
  return { kind, id: conversation.id as string, name, working, ...(secs.length ? { since: Math.max(...secs) } : {}) }
}

/** Where a message is looked for: anywhere in the page, in the chat's main stream (a top-level message, one from before
 *  threads, or a thread reply also sent to the chat: backend catchUp.ts `inMainStream`), or in one thread, its root among it. */
export type MessagePlace = 'any' | 'chat' | { thread: string }
const isIn = (m: Json, place: MessagePlace): boolean => place === 'any' ? true
  : place === 'chat' ? typeof m.thread !== 'string' || m.thread === m.id || m.alsoInChat === true
  : m.thread === place.thread

/** The newest row one of the chat's agents wrote: a person-visible message, not a system row (`source`), the person's or
 *  another agent's, in `place`. `at` in seconds; `id` the message's, or '' when it has none; `thread` the root of the thread
 *  it replies in when it is in that thread only. */
export function lastAgentMessage(messages: Json[], agentIds: ReadonlySet<string>, place: MessagePlace = 'any'): { text: string; at: number; id: string; sequence: number; thread?: string } | null {
  let best: { text: string; at: number; id: string; sequence: number; thread?: string } | null = null
  for (const item of messages) {
    const m = object(item)
    const author = object(m.author).id
    if (m.source != null || typeof author !== 'string' || !agentIds.has(author) || typeof m.text !== 'string' || !isIn(m, place)) continue
    const sequence = typeof m.sequence === 'number' ? m.sequence : -1
    if (best && sequence <= best.sequence) continue
    const stamp = typeof m.createdAt === 'number' ? m.createdAt : Date.parse(String(m.createdAt))
    best = { text: m.text, at: Number.isFinite(stamp) ? Math.floor(stamp / 1000) : 0, id: typeof m.id === 'string' ? m.id : '', sequence,
      ...(isIn(m, 'chat') ? {} : { thread: m.thread as string }) }
  }
  return best
}

interface TabCache { lastChangedAt: number | null; state: Json }
/** A recap read, and the thread it is of when one was on the face. */
interface Cached { sequence: number; recap: LeadRecap; thread?: string }
/** The window's focus, with the thread whose pane is on screen beside its conversation (Desktop's app_swarms `threadRoot`). */
type Focus = CardFocus & { threadRoot?: string }
/** A Lead some Harness Pro has the recap of open, and the sessions (one per Pro) that have it open. With `chat` (a round dial
 *  that speaks `swarmChat`, or 'buddy' for one that speaks swarmBuddy), the recap is that dial's face chat's, and `chatId`
 *  the chat it was last told of. */
interface Opened { tabId: string; leadId: string; chat: CardChat; chatId: string | null; thread: string | null; sequence: number | null; sessions: Set<string> }
/** Where a recap is read, or talk is posted: a conversation, how far it has gone, and whose messages are its recap; `buddy`
 *  when it is a swarmBuddy dial's Buddy face, whose notice is the Buddy's; `thread` the root of the thread open on the face. */
interface Target { id: string; sequence: number; voices: Set<string>; chatId?: string; buddy?: true; thread?: string }
const recapKey = (tabId: string, leadId: string, chatId?: string) => chatId === undefined ? `${tabId}:${leadId}` : `${tabId}:${leadId}:${chatId}`
/** A recap's cache key: an older dial's and a swarmBuddy dial's recap of one Buddy chat hear different voices, and a thread on
 *  the face is apart from its chat. */
const cachedKey = (tabId: string, leadId: string, target: Pick<Target, 'chatId' | 'thread'>, chat: CardChat) =>
  `${recapKey(tabId, leadId, target.chatId)}${target.thread === undefined ? '' : `#${target.thread}`}${chat === 'buddy' ? ':buddy' : ''}`
/** A thread's title on the dial: the first line, at most 80 bytes. */
const titleOf = (text: string): string => cut(text.split('\n')[0].trim(), 80)
const isSide = (v: unknown): v is CardSide => v === 'pm' || v === 'buddy'
/** Spec 2026-11-02-poll-cost Part 4.3: the list was read every 5 s whatever changed (prod 2026-11-02: about 200 list reads a
 *  minute). While the server says it pushes this account's Swarm changes (`swarm_changed` naming none, repeated every 4
 *  minutes: backend lib/swarmClientPushes.ts), the list is read when a Swarm's main parts change, and after this long as the
 *  net for a lost push. The lease is Desktop's (super_tabs/controller.dart kSwarmPushLease). */
export const CARDS_SAFETY_MS = 120_000
const SWARM_PUSH_LEASE_MS = 5 * 60_000
const tabOf = (read: SwarmRead): TabCache => ({ lastChangedAt: read.lastChangedAt, state: read.state })

/** How long the first list waits for a Swarm whose read failed, before going without it. */
const UNREAD_HOLD_MS = 60_000

export class SwarmCards {
  onCards?: (cards: SwarmCard[]) => void
  onRecap?: (recap: LeadRecap) => void
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly log: (line: string) => void
  private timer: NodeJS.Timeout | undefined
  private busy = false
  private tabs = new Map<string, TabCache>()
  /** The tabs to show, in the list's order, with the name the list gave each, as the last poll read them. */
  private rows: Array<{ id: string; name: unknown }> = []
  private recaps = new Map<string, Cached>()
  /** When each local Lead's current turn began, so `since` counts on between polls. */
  private turns = new Map<string, number>()
  /** Whether a harness is here and in a turn, as the last poll read it; null before the first. */
  private live: ((harnessId: string) => { inTurn: boolean; since?: number } | null) | null = null
  private last: string | null = null
  /** The first list is held back: a Swarm in it could not be read yet, and a list without it tells the dial that Swarm went. */
  private holding = false
  private unreadSince: number | null = null
  /** When each shown Lead's clock started (ms, `${card}/${lead}`), as the list last sent said. */
  private lastStarts = new Map<string, number>()
  private me: string | undefined
  private include: string[] = []
  /** The conversation the window has open in a Swarm tab: that project's face follows it. */
  private focus: Focus | null = null
  private opened = new Map<string, Opened>()
  private openBy = new Map<string, string>()
  /** Background reads of recaps and notices in flight, at most MAX_RECAPS_IN_FLIGHT. */
  private recapsRunning = 0
  /** The dial's own recap reads, one at a time and apart from the background's: a dial is never refused its recap. */
  private asking: Promise<unknown> | null = null
  /** One push of open recaps at a time: a focus change and a poll that both see a new face push it once. */
  private pushing: Promise<void> = Promise.resolve()
  /** The alert baseline: per watched conversation (`${tab}:${conversation}`), the last sequence whose messages were seen. */
  private seen = new Map<string, number>()
  /** Each Lead's newest notice (`${tab}:${lead}`), a tag of the reader's in its project, carried on its card. */
  private notices = new Map<string, LeadNotice>()
  /** The tags baseline: per Swarm, the mentions digest last read, and the ids of the tags seen waiting since the baseline. */
  private tagDigests = new Map<string, string>()
  private tagsSeen = new Map<string, string[]>()
  /** The decisions asked of the reader, as the tags: the digest last read and the ids seen. */
  private decisionDigests = new Map<string, string>()
  private decisionsSeen = new Map<string, string[]>()
  private personal = new Set<string>()
  /** Each Lead's newest quiet notice from the reader's Buddy (`${tab}:${lead}`): apart, so it never hides the Lead's. */
  private buddyNotices = new Map<string, LeadNotice>()
  /** The side a swarmBuddy dial swiped to, per Swarm; cleared by the window's next focus change (the newest wins). */
  private sides = new Map<string, CardSide>()
  /** The thread the dial's own words started, per Swarm (spec 2026-11-03-dial-thread-face), and the Lead whose face it was
   *  started from; cleared like `sides`. */
  private threads = new Map<string, { conversationId: string; root: string; title: string; at: number; leadId: string; opened?: true }>()
  /** Title and reply count of the app's threads, as the recap reads gave them (`${tab}/${root}`). */
  private titles = new Map<string, { title: string; replies?: number; looked?: true; failures?: number; retryAt?: number }>()
  /** The thread the dial last left, per Swarm: an older Desktop that announces it again does not pull the dial back into it. */
  private left = new Map<string, { conversationId: string; root: string }>()
  /** Bumped at each refocus of the window, so a post that was out while it moved knows it did (spec 2026-11-03-dial-thread-face). */
  private focusGen = 0
  /** Watched conversations whose last read failed, so a run of failures is logged once. */
  private failed = new Set<string>()
  private readonly reads: SwarmReads
  /** Until when the server is known to push Swarm changes, when the list was last read, and whether a change since asks
   *  for it again. */
  private pushUntil = 0
  private listedAt = -Infinity
  private listTold = false
  private stopNotices: (() => void) | null = null

  constructor(private readonly core: CoreApi, private readonly machineId: string, options: { now?: () => number; intervalMs?: number; reads?: SwarmReads; log?: (line: string) => void } = {}) {
    this.now = options.now ?? Date.now
    this.intervalMs = options.intervalMs ?? 5000
    this.reads = options.reads ?? new SwarmReads(core)
    this.log = options.log ?? (line => console.log(line))
  }

  /** Poll while a capable Pro is attached; none otherwise (no request at all). `include`: the Swarms the desktop has tabs for,
   *  read first. `focus`: the conversation the window has open in a Swarm tab; a change rebuilds the cards at once from the
   *  last reads, with no request. */
  want(on: boolean, include: string[] = [], focus: Focus | null = null): void {
    if (!on) {
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      this.stopNotices?.()
      this.stopNotices = null
      this.pushUntil = 0
      this.opened.clear(); this.openBy.clear(); this.include = []; this.focus = null; this.sides.clear(); this.threads.clear(); this.titles.clear(); this.left.clear()
      // A device that attaches again starts a fresh baseline: what was said while none was here never alerts.
      this.seen.clear(); this.forgetNotices()
      return
    }
    const wanted = include.filter(cardId).slice(0, MAX_CARDS)
    const moved = wanted.join(',') !== this.include.join(',')
    this.include = wanted
    let next: Focus | null = focus && cardId(focus.tabId) && cardId(focus.conversationId)
      ? { tabId: focus.tabId, conversationId: focus.conversationId, ...(cardId(focus.threadRoot) ? { threadRoot: focus.threadRoot } : {}),
        ...(focus.fromDevice === true ? { fromDevice: true as const } : {}) } : null
    // A thread the dial left stays left until the window names another conversation or another root (an older Desktop announces
    // it again): its root is not the focus's.
    for (const [tabId, gone] of [...this.left]) {
      if (!(next?.tabId === tabId && next.conversationId === gone.conversationId && next.threadRoot === gone.root)) this.left.delete(tabId)
      else { const { threadRoot: _, ...rest } = next; next = rest }
    }
    // A thread opened or closed beside the conversation moves the face too.
    const refocused = `${next?.tabId}/${next?.conversationId}/${next?.threadRoot}` !== `${this.focus?.tabId}/${this.focus?.conversationId}/${this.focus?.threadRoot}`
    const before = this.focus
    this.focus = next
    // The desktop's own move clears the dial's side; the move a dial's pick caused is the dial's, and keeps it.
    // The dial's thread outlives the window's announce of that very thread (same conversation, same root), which a hidden pane keeps
    // making; another conversation, another root, or no root (the app closed it) ends it.
    if (refocused) this.focusGen++
    // The window opens the dial's thread only after selecting its chat (up to 10 s): a no-root announce of that chat is not the
    // person closing it until the window has named the root once, or 15 s have passed.
    const mine = next && this.threads.get(next.tabId)
    if (mine && next!.conversationId === mine.conversationId && next!.threadRoot === mine.root) mine.opened = true
    if (refocused && !next?.fromDevice) {
      const own = mine
      const confirmed = !!next && !!own && own.conversationId === next.conversationId &&
        (own.root === next.threadRoot || (next.threadRoot === undefined && !own.opened && this.now() - own.at < 15_000))
      // Only the root appearing beside the same conversation is no move of the person's: the dial's side stays.
      if (!(confirmed && before?.tabId === next!.tabId && before.conversationId === next!.conversationId)) this.sides.clear()
      for (const tabId of [...this.threads.keys()]) if (!(confirmed && tabId === next!.tabId)) this.threads.delete(tabId)
    }
    // Other Swarms to show first: the list is read for them now, whatever the server pushes.
    if (moved) this.listTold = true
    if (this.timer) {
      if (refocused && this.live) { this.emit(); void this.pushOpen() }
      if (moved) void this.tick()
      return
    }
    this.stopNotices = this.core.account.onNotice(notice => this.heard(notice))
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    this.timer.unref?.()
    void this.tick()
  }

  /**
   * The side a swarmBuddy dial is shown for a Swarm, which its faces, recaps and card all follow: the one it swiped to, else
   * the Buddy side while the window has the reader's Buddy chat open there (spec 2026-10-29: opening it on the desktop
   * shows the Buddy screen). Taken from the swipes alone, the card said the PM side over a Buddy face (re-check of #2216).
   */
  private sideOf(tabId: string, state: Json): CardSide | undefined {
    const swiped = this.sides.get(tabId)
    if (swiped) return swiped
    const focus = this.focus?.tabId === tabId ? this.focus.conversationId : undefined
    return focus !== undefined && state.buddies === true &&
      list(state.conversations).some(c => c.id === focus && isReadersBuddyChat(c, this.me) && c.archived !== true) ? 'buddy' : undefined
  }

  /** A swarmBuddy dial swiped to a side of a Swarm (spec 2026-10-29): every project of it shows that side until the window
   *  opens another conversation. The cards are rebuilt at once from the last reads, as a focus change does. */
  side(tabId: string, side: CardSide): void {
    if (!cardId(tabId) || !isSide(side) || this.sides.get(tabId) === side) return
    this.sides.set(tabId, side)
    // Up to the Buddy side leaves the PM's thread for good (spec 2026-11-03-dial-thread-face).
    this.threads.delete(tabId)
    if (this.timer && this.live) { this.emit(); void this.pushOpen() }
  }

  /** The root of the thread on Lead `leadId`'s face, whose conversation is `conversationId`: the one open in the window beside
   *  it, else the one the dial's words started there. One chat can be on many Leads' faces (the Swarm chat is every project's
   *  Buddy face), and its thread is on one Lead's alone: the dial's own on the Lead it was started from, the window's on the
   *  Lead the dial has open (on each while it has none open). Matched by conversation alone, it went on every Lead, and 12
   *  projects took the round dial's frame past the firmware's 512-token guard (task #2525). */
  private threadOn(tabId: string, conversationId: string, leadId: string): string | undefined {
    const open = this.focus?.tabId === tabId && this.focus.conversationId === conversationId ? this.focus.threadRoot : undefined
    const own = this.threads.get(tabId)
    const mine = own?.conversationId === conversationId ? own : undefined
    if (open !== undefined && open !== mine?.root) return this.dialOpens(tabId, leadId) ? open : undefined
    return mine?.leadId === leadId ? mine.root : undefined
  }

  /** Whether the dial has Lead `leadId`'s chat open in this Swarm, or no Lead's chat at all. */
  private dialOpens(tabId: string, leadId: string): boolean {
    const open = [...this.opened.values()].filter(o => o.tabId === tabId && o.chat)
    return !open.length || open.some(o => o.leadId === leadId)
  }

  private threadInfo(tabId: string, conversationId: string, leadId: string): SwarmChat['thread'] {
    const root = this.threadOn(tabId, conversationId, leadId)
    if (root === undefined) return undefined
    const own = this.threads.get(tabId), read = this.titles.get(`${tabId}/${root}`)
    return { root, title: own?.root === root ? own.title : read?.title ?? '', ...(read?.replies !== undefined ? { replies: read.replies } : {}) }
  }

  /** The dial leaves the thread on its face (`chat`: the dial's own chat flag): the dial's own is forgotten and the app's is no
   *  longer the face's (the window is asked to close it), and an older Desktop's announce of it is ignored from now on. The
   *  conversation whose thread that was, or null when the Lead's face was in none. */
  threadLeave(tabId: string, leadId: string, chat: CardChat = true): { tabId: string; conversationId: string } | null {
    const face = chat ? this.target(tabId, leadId, chat) : null
    if (!face || face.thread === undefined) return null
    if (this.threads.get(tabId)?.conversationId === face.id) this.threads.delete(tabId)
    if (this.focus?.tabId === tabId && this.focus.conversationId === face.id && this.focus.threadRoot !== undefined) { const { threadRoot: _, ...rest } = this.focus; this.focus = rest }
    this.left.set(tabId, { conversationId: face.id, root: face.thread })
    if (this.timer && this.live) { this.emit(); void this.pushOpen() }
    return { tabId, conversationId: face.id }
  }

  /** The recap on a Pro's screen (leadId null: closed), per Pro `session`: a change in that Lead's conversation is pushed once.
   *  With `chat`, the face chat's: a change in it, or another chat on the face, is pushed once. */
  open(session: string, tabId: string, leadId: string | null, chat: CardChat = false): void {
    const before = this.openBy.get(session)
    if (before) {
      const held = this.opened.get(before)
      held?.sessions.delete(session)
      if (held && !held.sessions.size) this.opened.delete(before)
      this.openBy.delete(session)
    }
    if (!leadId || !cardId(session) || !cardId(tabId) || !cardId(leadId)) return
    const key = `${recapKey(tabId, leadId)}${chat === 'buddy' ? ':buddy' : chat ? ':chat' : ''}`
    let entry = this.opened.get(key)
    if (!entry) {
      // From what the Pro was shown when there is a recap read, else from the first read of the tab: the next change is pushed.
      const target = this.target(tabId, leadId, chat)
      entry = { tabId, leadId, chat, chatId: target?.chatId ?? null, thread: target?.thread ?? null,
        sequence: target ? this.recaps.get(cachedKey(tabId, leadId, target, chat))?.sequence ?? target.sequence : null, sessions: new Set() }
      this.opened.set(key, entry)
    }
    entry.sessions.add(session)
    this.openBy.set(session, key)
  }

  /** Whether a Swarm read last lists this harness on that machine as one of its workers (a Builder or Reviewer): a member
   *  that leads no conversation and that the Swarm started, by its start record (the proof superTabs/host.ts closes workers
   *  by). A session the person opened by hand and added is theirs, as on this computer (services/devices.ts). A Swarm
   *  Reviewer on another computer failing every turn took over the round dial (2026-10-28), so the devices ask before they
   *  show a card's failure. Nothing is read for it: before the first poll, nobody is one. A Buddy (`buddyOf`) is started
   *  the same way but is its owner's own agent, so its failures stay on their dial (combination review of batch #2043). */
  worker(machineId: string, harnessId: string): boolean {
    return [...this.tabs.values()].some(({ state }) => {
      const member = list(state.agents).find(a => a.machineId === machineId && a.harnessId === harnessId)
      return !!member && !member.buddyOf && !list(state.conversations).some(c => c.leadId === member.id)
        && list(state.starts).some(s => s.harnessId === harnessId && object(s.request).machineId === machineId && !s.error
          && s.creationId === `super-${String(s.id)}`)
    })
  }

  /** The server's word on this account's Swarms: naming none, it pushes them (and what changed meanwhile is read once); naming
   *  one, a change to its main parts is read at the next tick. A machine's reading alone changes nothing a card shows. */
  private heard(notice: BackendNotice): void {
    if (notice.type !== 'swarm_changed') return
    if (notice.tabId === undefined && notice.parts === undefined) {
      this.pushUntil = this.now() + SWARM_PUSH_LEASE_MS
      this.listTold = true
    } else if (notice.parts?.includes('main')) this.listTold = true
  }

  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try { await this.poll() } catch { /* the last cards stay: a dropped network says nothing about the Swarms */ } finally { this.busy = false }
  }

  /** The Swarms to show: those the desktop has tabs for first, then the list in its order, 16 in all. Paging stops once both are met. */
  private async listTabs(): Promise<Json[]> {
    const rows: Json[] = []
    let after = ''
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const data = object(await backend(this.core, 'GET', `/api/super-tabs/list${after ? `?after=${encodeURIComponent(after)}` : ''}`))
      rows.push(...list(data.tabs).filter(r => cardId(r.id)))
      if (!identifier(data.next)) break
      if (rows.length >= MAX_CARDS && this.include.every(id => rows.some(r => r.id === id))) break
      after = data.next
    }
    const first = this.include.map(id => rows.find(r => r.id === id)).filter((r): r is Json => !!r)
    return [...first, ...rows.filter(r => !first.includes(r))].slice(0, MAX_CARDS)
  }

  private async poll(): Promise<void> {
    // The list and the Swarms it says changed, unless the server pushes and nothing it said asks for them: the rest of the
    // poll (the turns here, the Leads' new messages, the cards) still runs each tick from the last reads.
    if (this.now() >= this.pushUntil || this.listTold || this.now() - this.listedAt >= CARDS_SAFETY_MS) {
      // Cleared before the read: a change told during it asks for another.
      this.listTold = false
      let rows: Json[]
      try { rows = await this.listTabs() } catch (error) { this.listTold = true; throw error }
      this.listedAt = this.now()
      const known = new Map<string, TabCache>()
      let unread = false
      await Promise.all(rows.map(async row => {
        const id = row.id as string, held = this.tabs.get(id)
        // A row without a numeric change time cannot say it is unchanged: that tab is always read again.
        if (held && typeof row.lastChangedAt === 'number' && held.lastChangedAt === row.lastChangedAt) { known.set(id, held); return }
        try { known.set(id, tabOf(await this.reads.read(id))) } catch (error) {
          // Lost access drops only this card; any other failure keeps what was read before.
          const status = error instanceof SuperTabHostError ? error.status : 0
          if (status === 401 || status === 403) return
          if (held) known.set(id, held)
          else unread = true
        }
      }))
      this.tabs = known
      // A Swarm that could not be read and is not held is read again next tick, push or not.
      if (unread) this.listTold = true
      // After a restart nothing is held, so one passing failure (a 5xx, a timeout) would leave that Swarm out of the first list,
      // and the dial takes a list without a Swarm to mean it went. Bounded: a Swarm that keeps failing must not hide the others.
      const first = unread && this.last === null
      this.unreadSince = first ? this.unreadSince ?? this.now() : null
      this.holding = this.unreadSince !== null && this.now() - this.unreadSince < UNREAD_HOLD_MS
      // A Swarm that left the cards (access lost) takes the dial's side with it.
      for (const tabId of [...this.sides.keys()]) if (!known.has(tabId)) this.sides.delete(tabId)
      for (const tabId of [...this.threads.keys()]) if (!known.has(tabId)) this.threads.delete(tabId)
      for (const tabId of [...this.left.keys()]) if (!known.has(tabId)) this.left.delete(tabId)
      this.rows = rows.map(row => ({ id: row.id as string, name: row.name }))
      this.personal = new Set(rows.filter(row => row.personal === true).map(row => row.id as string))
    }
    const me = (await this.core.account.identity().catch(() => null))?.accountId
    // Another person signed in: nothing of the last account's is kept, and the list is said again whatever it is.
    if (this.me !== undefined && me !== this.me) { this.last = null; this.recaps.clear(); this.seen.clear(); this.forgetNotices(); this.sides.clear(); this.threads.clear(); this.titles.clear(); this.left.clear() }
    this.me = me ?? this.me
    const turns = await this.turnsHere()
    this.live = (harnessId: string) => this.core.agents.byAgent(harnessId) ? turns.get(harnessId) ?? { inTurn: false } : null
    await this.watchNotices()
    this.emit()
    this.prune()
    await this.pushOpen()
  }

  /** The cards from the last reads, said when they changed. */
  private emit(): void {
    if (this.holding) return
    const live = this.live ?? (() => null)
    const cards: SwarmCard[] = []
    for (const row of this.rows) {
      const tab = this.tabs.get(row.id)
      if (!tab) continue
      const focus = this.focus?.tabId === row.id ? this.focus.conversationId : undefined
      const side = this.sideOf(row.id, tab.state)
      const { count, leads } = leadsOf(tab.state, this.machineId, live, this.me, focus, side, (id, lead) => this.threadInfo(row.id, id, lead))
      const noticed = leads.map(lead => {
        const notice = this.notices.get(recapKey(row.id, lead.id)), buddyNotice = this.buddyNotices.get(recapKey(row.id, lead.id))
        return { ...lead, ...(notice ? { notice } : {}), ...(buddyNotice ? { buddyNotice } : {}) }
      })
      cards.push({ id: row.id, name: cut(String(tab.state.name ?? row.name ?? ''), NAME_BYTES), count, leads: noticed,
        ...(side === 'buddy' ? { side: 'buddy' as const } : {}), ...(this.personal.has(row.id) ? { personal: true as const } : {}) })
    }
    // `since` moves every poll while a turn runs and the Pro counts on by itself, so it alone never re-sends the list.
    // Nor does a clock that keeps its turn; one whose turn changed (the Lead's ended, a worker's goes on) does. The start is
    // compared within 2 s: `since` is whole seconds, read at a poll's own moment.
    const signature = JSON.stringify(cards, (key, value) => key === 'since' ? value !== undefined : value)
    const now = this.now(), starts = new Map<string, number>()
    for (const card of cards) for (const lead of card.leads) if (lead.since !== undefined) starts.set(`${card.id}/${lead.id}`, now - lead.since * 1000)
    const moved = [...starts].some(([key, at]) => Math.abs(at - (this.lastStarts.get(key) ?? at)) > 2000)
    if (signature !== this.last || moved) { this.last = signature; this.lastStarts = starts; this.onCards?.(cards) }
  }

  /**
   * The dial's alerts (design 2026-10-28 §2, task #2965): each project's Lead holds the newest tag of the reader's in that project
   * (watchTags), and while Buddies are on the reader's Buddy chat gives the newest message of the reader's Buddy as the Lead's
   * quiet notice (spec 2026-10-29 Alerts), kept apart from its notice. A Buddy chat first seen sets the baseline and is not
   * read; one that moved past it, by the `lastMessageSequence` the tab reads already carry, has its newest page read once,
   * under the recaps' limit. The baseline moves only after a read that worked, so a failed one is tried again at the next
   * poll. The PM's own messages are no alert, in its Lead conversation or the reader's Buddy chat: they beeped all day for
   * chatter in projects that had nothing to do with the reader (Diego, 2026-11-04). Another person's Buddy chat is never read.
   */
  private async watchNotices(): Promise<void> {
    const watched = new Set<string>()
    for (const [tabId, { state }] of this.tabs) {
      const conversations = list(state.conversations), agents = list(state.agents), buddies = state.buddies === true
      const projects = leadProjects(state)
      // The reader's one Swarm Buddy chat is every project's Buddy: read once per poll (its key is the chat's), and its newest
      // word is the quiet notice of each Lead alike. A project's own Buddy chat (older Swarms) is that project's alone.
      const swarmChat = buddies ? conversations.find(c => isSwarmBuddyChat(c) && isReadersBuddyChat(c, this.me) && c.archived !== true && cardId(c.id)) : undefined
      const chats: Array<{ conversation: Json; leadIds: string[] }> = [...swarmChat ? [{ conversation: swarmChat, leadIds: projects.map(p => p.leadId) }] : [],
        ...buddies ? projects.flatMap(({ project, leadId }) => conversations.filter(c => !isSwarmBuddyChat(c) && inProject(c, projectKey(project))
          && isReadersBuddyChat(c, this.me) && c.archived !== true && cardId(c.id)).map(conversation => ({ conversation, leadIds: [leadId] }))) : []]
      for (const { conversation, leadIds } of chats) {
        if (typeof conversation.lastMessageSequence !== 'number') continue
        const key = `${tabId}:${conversation.id}`, sequence = conversation.lastMessageSequence, baseline = this.seen.get(key)
        watched.add(key)
        if (baseline === undefined) { this.seen.set(key, sequence); continue }
        if (sequence <= baseline || this.recapsRunning >= MAX_RECAPS_IN_FLIGHT) continue
        this.recapsRunning++
        try {
          const page = object(await backend(this.core, 'GET', `/api/super-tabs/${tabId}/conversations/${conversation.id}/messages`))
          const after = list(page.messages).filter(m => typeof m.sequence === 'number' && m.sequence > baseline)
          const voices = new Set(buddiesIn(agents, conversation, this.me).map(a => a.id as string))
          for (const leadId of leadIds) this.raise(this.buddyNotices, recapKey(tabId, leadId), 'buddy', conversation.id as string, after, voices)
          this.seen.set(key, sequence)
          this.failed.delete(key)
        } catch (error) {
          if (!this.failed.has(key)) {
            this.failed.add(key)
            this.log(`[super-tabs] the Buddy's new message could not be read for the dial; tried again at the next poll: ${error instanceof Error ? error.message : String(error)}`)
          }
        } finally { this.recapsRunning-- }
      }
      watched.add(`${tabId}:mentions`)
      await this.watchTags(tabId, state, projects)
      watched.add(`${tabId}:decisions`)
      await this.watchDecisions(tabId, state, projects)
    }
    // A Swarm or project that left the cards takes its baseline and notices with it.
    for (const key of [...this.seen.keys()]) if (!watched.has(key)) this.seen.delete(key)
    for (const key of [...this.failed]) if (!watched.has(key)) this.failed.delete(key)
    for (const [key, notice] of this.buddyNotices) if (!watched.has(`${key.slice(0, key.indexOf(':'))}:${notice.chatId}`)) this.buddyNotices.delete(key)
    for (const tabId of [...this.tagDigests.keys()]) if (!this.tabs.has(tabId)) { this.tagDigests.delete(tabId); this.tagsSeen.delete(tabId); this.decisionDigests.delete(tabId); this.decisionsSeen.delete(tabId) }
    for (const key of [...this.notices.keys()]) {
      const [tabId, leadId] = key.split(':'), state = this.tabs.get(tabId)?.state
      if (!state || !leadProjects(state).some(p => p.leadId === leadId)) this.notices.delete(key)
    }
  }

  /**
   * The reader's waiting tags in a Swarm, read only when its mentions digest (each Swarm read's `mentionsDigest`) moved, never
   * on a timer. The first digest seen is the baseline: the tags waiting then were there before the dial came, and never alert;
   * at the digest of none there is nothing to read. After it, a tag id not seen before is new, and the newest new tag of a
   * project is its Lead's notice, naming the tag's chat and, for a thread reply, its thread. A tag seen once is never new again;
   * one read or marked done stops waiting, so it never comes back, and the Lead's notice for it goes. A Swarm read from a
   * backend without the digest raises none. A failed read keeps the digest, so the next poll reads again.
   */
  private async watchTags(tabId: string, state: Json, projects: Array<{ project: Json; lead: Json; leadId: string }>): Promise<void> {
    const digest = state.mentionsDigest, seen = this.tagsSeen.get(tabId)
    if (typeof digest !== 'string' || this.tagDigests.get(tabId) === digest) return
    if (seen === undefined && digest === NO_TAGS) { this.tagDigests.set(tabId, digest); this.tagsSeen.set(tabId, []); return }
    if (this.recapsRunning >= MAX_RECAPS_IN_FLIGHT) return
    const key = `${tabId}:mentions`
    this.recapsRunning++
    try {
      const rows = list(object(await backend(this.core, 'GET', `/api/super-tabs/${tabId}/mentions?state=waiting`)).mentions).filter(r => cardId(r.id))
      const waiting = new Set(rows.map(r => r.id as string))
      if (seen) {
        const known = new Set(seen)
        this.raiseTags(tabId, state, projects, rows.filter(r => !known.has(r.id as string)))
      }
      // A decision's notice is dropped by watchDecisions, not here.
      for (const { leadId } of projects) {
        const held = this.notices.get(recapKey(tabId, leadId))
        if (held && !waiting.has(held.id) && !(this.decisionsSeen.get(tabId) ?? []).includes(held.id)) this.notices.delete(recapKey(tabId, leadId))
      }
      this.tagsSeen.set(tabId, [...(seen ?? []).filter(id => !waiting.has(id)), ...waiting].slice(-MAX_TAGS_SEEN))
      this.tagDigests.set(tabId, digest)
      this.failed.delete(key)
    } catch (error) {
      if (!this.failed.has(key)) {
        this.failed.add(key)
        this.log(`[super-tabs] the tags waiting for you could not be read for the dial; tried again at the next poll: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally { this.recapsRunning-- }
  }

  /**
   * The decisions asked of the reader, as the tags are (spec 2026-11-05-dial-lead-pm-buddy-pair, Notices): read only when the
   * Swarm read's `decisionsDigest` moved. The server lists the reader's own open ones (`/decisions?state=open`; for a person
   * it is never another's); the first digest seen is the baseline and never alerts, a decision id seen once is never new
   * again, and the newest new one of a project is its Lead's notice, "<asker> asks you: <question>". The newest of a tag or a
   * decision wins. One no longer open drops the notice it made. A failed read keeps the digest, so the next poll reads again.
   */
  private async watchDecisions(tabId: string, state: Json, projects: Array<{ project: Json; lead: Json; leadId: string }>): Promise<void> {
    const digest = state.decisionsDigest, seen = this.decisionsSeen.get(tabId)
    if (typeof digest !== 'string' || this.decisionDigests.get(tabId) === digest) return
    if (this.recapsRunning >= MAX_RECAPS_IN_FLIGHT) return
    const key = `${tabId}:decisions`
    this.recapsRunning++
    try {
      const rows = list(object(await backend(this.core, 'GET', `/api/super-tabs/${tabId}/decisions?state=open`)).decisions)
        .filter(r => cardId(r.id) && (r.answeredAt === null || r.answeredAt === undefined))
      const open = new Set(rows.map(r => r.id as string))
      if (seen) {
        const known = new Set(seen)
        for (const row of rows.filter(r => !known.has(r.id as string))) {
          const found = projects.find(p => projectKey(p.project) === row.projectId)
          if (!found || !cardId(row.conversationId) || typeof row.question !== 'string') continue
          const stamp = Date.parse(String(row.createdAt))
          const asker = typeof row.askerName === 'string' && row.askerName ? row.askerName : 'Agent'
          const notice: LeadNotice = { chat: row.conversationId === found.lead.id ? 'lead' : 'group', chatId: row.conversationId, id: row.id as string,
            text: cut(`${asker} asks you: ${row.question}`, RECAP_BYTES), at: Number.isFinite(stamp) ? Math.floor(stamp / 1000) : 0 }
          const held = this.notices.get(recapKey(tabId, found.leadId))
          if (held && held.at > notice.at) continue
          this.notices.set(recapKey(tabId, found.leadId), notice)
        }
      }
      // A notice made by a decision that is no longer open goes (a tag's own is dropped by watchTags).
      for (const { leadId } of projects) {
        const held = this.notices.get(recapKey(tabId, leadId))
        if (held && (seen ?? []).includes(held.id) && !open.has(held.id)) this.notices.delete(recapKey(tabId, leadId))
      }
      this.decisionsSeen.set(tabId, [...(seen ?? []).filter(id => !open.has(id)), ...open].slice(-MAX_TAGS_SEEN))
      this.decisionDigests.set(tabId, digest)
      this.failed.delete(key)
    } catch (error) {
      if (!this.failed.has(key)) {
        this.failed.add(key)
        this.log(`[super-tabs] the decisions asked of you could not be read for the dial; tried again at the next poll: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally { this.recapsRunning-- }
  }

  /** New tags (`rows`, as `/mentions` lists them) as their project Lead's notice: the newest of each project, unless the one
   *  held is newer. Its chat is `lead` in the project's Lead conversation, `pm` in the reader's Buddy chat or a Chat with PM,
   *  and `group` elsewhere (a task chat); its text names who tagged. A tag of a project with no Lead makes none. */
  private raiseTags(tabId: string, state: Json, projects: Array<{ project: Json; lead: Json; leadId: string }>, rows: Json[]): void {
    const conversations = list(state.conversations)
    for (const row of rows) {
      const found = projects.find(p => projectKey(p.project) === row.projectId)
      if (!found || !cardId(row.conversationId) || typeof row.text !== 'string') continue
      const conversation = conversations.find(c => c.id === row.conversationId)
      const chat: LeadNotice['chat'] = row.conversationId === found.lead.id ? 'lead'
        : conversation && (isBuddyChat(conversation) || isChatWithPm(conversation)) ? 'pm' : 'group'
      const stamp = Date.parse(String(row.createdAt))
      const at = Number.isFinite(stamp) ? Math.floor(stamp / 1000) : 0
      const who = typeof row.leadName === 'string' && row.leadName ? `${row.leadName}: ` : ''
      const notice: LeadNotice = { chat, chatId: row.conversationId, id: row.id as string, text: cut(`${who}${row.text}`, RECAP_BYTES), at,
        ...(identifier(row.threadId) ? { thread: row.threadId } : {}) }
      const held = this.notices.get(recapKey(tabId, found.leadId))
      if (held && held.at > notice.at) continue
      this.notices.set(recapKey(tabId, found.leadId), notice)
    }
  }

  /** The newest message `voices` said in `messages` becomes the held notice at `key`, unless one held is newer; with its
   *  thread when it replies in one only. Since tasks live in threads (#2704) agents answer there, and a notice that read
   *  as its chat's was read by opening the chat while the reply sat collapsed in its thread (Diego, 2026-10-29). */
  private raise(held: Map<string, LeadNotice>, key: string, chat: LeadNotice['chat'], chatId: string, messages: Json[], voices: ReadonlySet<string>): void {
    const said = lastAgentMessage(messages, voices)
    if (!said || !cardId(said.id)) return
    const notice: LeadNotice = { chat, chatId, id: said.id, text: cut(said.text, RECAP_BYTES), at: said.at, ...(said.thread ? { thread: said.thread } : {}) }
    const before = held.get(key)
    if (before && before.at > notice.at) return
    held.set(key, notice)
  }

  private forgetNotices(): void { this.notices.clear(); this.buddyNotices.clear(); this.tagDigests.clear(); this.tagsSeen.clear(); this.decisionDigests.clear(); this.decisionsSeen.clear(); this.failed.clear() }

  /** Which of the Leads that run here are in a turn, and since when (the core's windows' own measure of "working"). */
  private async turnsHere(): Promise<Map<string, { inTurn: boolean; since?: number }>> {
    const ids = new Set<string>()
    for (const { state } of this.tabs.values()) {
      for (const agent of list(state.agents)) if (agent.machineId === this.machineId && typeof agent.harnessId === 'string' && this.core.agents.byAgent(agent.harnessId)) ids.add(agent.harnessId)
    }
    const working = ids.size ? await this.core.agents.activity([...ids]).catch(() => ({} as Record<string, string>)) : {}
    const out = new Map<string, { inTurn: boolean; since?: number }>()
    const now = this.now()
    for (const id of ids) {
      if (working[id] !== 'working') { this.turns.delete(id); out.set(id, { inTurn: false }); continue }
      if (!this.turns.has(id)) {
        const elapsed = (await this.core.agents.activitySnapshot?.(id).catch(() => null))?.elapsedSeconds
        this.turns.set(id, now - (typeof elapsed === 'number' && elapsed > 0 ? elapsed * 1000 : 0))
      }
      // At least 1: the Pro reads 0 as no turn start and shows no clock.
      out.set(id, { inTurn: true, since: Math.max(1, Math.floor((now - this.turns.get(id)!) / 1000)) })
    }
    for (const id of [...this.turns.keys()]) if (!ids.has(id)) this.turns.delete(id)
    return out
  }

  /** Where the Lead's recap is read and its talk posted, from the tab as last read: its Lead conversation, or with `chat` the
   *  chat on its project's face for that dial (`chatId` set): today's, or with 'buddy' the side a swarmBuddy dial keeps
   *  while the Swarm has Buddies on. */
  private target(tabId: string, leadId: string, chat: CardChat): Target | null {
    const state = this.tabs.get(tabId)?.state
    if (!state) return null
    const found = leadProjects(state).find(p => p.leadId === leadId)
    if (!found || !identifier(found.lead.id)) return null
    if (!chat) return { id: found.lead.id, sequence: sequenceOf(found.lead), voices: new Set([leadId]) }
    const focus = this.focus?.tabId === tabId ? this.focus.conversationId : undefined
    const conversations = list(state.conversations), projectId = projectKey(found.project), buddies = state.buddies === true
    const face = chat === 'buddy' && buddies ? sideFaceOf(conversations, projectId, found.lead, focus, this.me, this.sideOf(tabId, state))
      : faceOf(conversations, projectId, found.lead, focus, this.me, buddies)
    if (!face) return null
    const id = face.conversation.id as string
    // The thread open beside the window's conversation, while that conversation is the one on the face: any agent's reply
    // there is its recap (a worker answering in the Lead's thread, the Buddy's thread session).
    const thread = this.threadOn(tabId, id, leadId)
    const voices = thread === undefined ? voicesOf(face, leadId, list(state.agents), this.me)
      : new Set(list(state.agents).map(a => a.id).filter((a): a is string => typeof a === 'string'))
    return { id, sequence: sequenceOf(face.conversation), voices, chatId: id,
      ...(face.kind === 'buddy' ? { buddy: true as const } : {}), ...(thread === undefined ? {} : { thread }) }
  }

  /** What the Lead last said: the newest page of its conversation, then one page back; `none` when neither holds a row of its own.
   *  With `chat`, what the chat on its face last heard from its agents, naming that chat. The dial's own read: never refused,
   *  and answered at once from the recap held for that chat or the Buddy's notice from it, read again after when the chat moved on. */
  async recap(tabId: string, leadId: string, chat: CardChat = false): Promise<LeadRecap> {
    if (!cardId(tabId) || !cardId(leadId)) return { tabId, leadId, text: '', at: 0, none: true }
    const quick = this.held(tabId, leadId, chat)
    if (quick) {
      if (quick.stale) this.refresh(tabId, leadId, chat, quick.recap)
      return quick.recap
    }
    return this.asked(() => this.read(tabId, leadId, chat, 'device'))
  }

  /** The dial's reads, one after another; one asked while none runs starts at once, and one never waits on a read that
   *  hangs for longer than ASK_WAIT_MS. */
  private asked<T>(read: () => Promise<T>): Promise<T> {
    const run = this.asking ? within(this.asking, ASK_WAIT_MS).then(read) : read()
    const done: Promise<unknown> = run.catch(() => {}).then(() => { if (this.asking === done) this.asking = null })
    this.asking = done
    return run
  }

  /** What can be answered for the chat on the face with no read: the recap held for it, or on a Buddy face the newer quiet
   *  notice from it, with the sequence it was read at (-1 for a notice); `stale` when the chat has moved on since, so it is
   *  read again. A tag is not the chat's recap: whoever tagged may be no voice of it. */
  private held(tabId: string, leadId: string, chat: CardChat): { recap: LeadRecap; sequence: number; stale: boolean } | null {
    const found = this.target(tabId, leadId, chat)
    if (!found) return null
    const kept = this.recaps.get(cachedKey(tabId, leadId, found, chat))
    // A notice is of the chat, never of a thread on the face.
    const notice = found.thread === undefined && found.buddy ? this.buddyNotices.get(recapKey(tabId, leadId)) : undefined
    const heard = notice && notice.chatId === found.id && notice.thread === undefined ? notice : undefined
    if (kept && (!heard || heard.at <= kept.recap.at)) return { recap: kept.recap, sequence: kept.sequence, stale: kept.sequence !== found.sequence }
    if (!heard) return null
    return { recap: { tabId, leadId, text: heard.text, at: heard.at, none: false, ...namedFor(found, chat) }, sequence: -1, stale: true }
  }

  /** The chat moved on since what the dial was answered: read again, on the dial's lane, and pushed when it says otherwise. */
  private refresh(tabId: string, leadId: string, chat: CardChat, shown: LeadRecap): void {
    void this.asked(() => this.read(tabId, leadId, chat, 'device')).then(recap => {
      // Its open sessions are told this one: their next push is for the chat's next move.
      const target = this.target(tabId, leadId, chat), kept = target && this.recaps.get(cachedKey(tabId, leadId, target, chat))
      for (const open of this.opened.values()) {
        if (kept && open.tabId === tabId && open.leadId === leadId && open.chat === chat && open.chatId === (target.chatId ?? null)
          && open.thread === (target.thread ?? null)) open.sequence = kept.sequence
      }
      if (recap.text !== shown.text || recap.at !== shown.at || recap.none !== shown.none || recap.chatId !== shown.chatId) this.onRecap?.(recap)
    }, () => { /* read again at the next push or ask */ })
  }

  /** The backend read of a recap. `background` (a push) takes one of the two background slots or is refused; `device` (the
   *  dial asked) runs on the dial's own lane. */
  private async read(tabId: string, leadId: string, chat: CardChat, lane: 'device' | 'background'): Promise<LeadRecap> {
    // At most two background reads run at once, so a loop of pushes cannot flood the backend; the dial's run one by one.
    const slot = async <T>(run: () => Promise<T>): Promise<T> => {
      if (lane === 'device') return run()
      if (this.recapsRunning >= MAX_RECAPS_IN_FLIGHT) throw new Error('too many recap reads at once')
      this.recapsRunning++
      try { return await run() } finally { this.recapsRunning-- }
    }
    let found = this.target(tabId, leadId, chat)
    if (!found) {
      await slot(async () => { this.tabs.set(tabId, tabOf(await this.reads.read(tabId))) })
      found = this.target(tabId, leadId, chat)
    }
    if (!found) return { tabId, leadId, text: '', at: 0, none: true }
    const target = found, named = namedFor(target, chat)
    const key = cachedKey(tabId, leadId, target, chat), held = this.recaps.get(key)
    if (held && held.sequence === target.sequence) return held.recap
    const reader = this.me
    // A thread on the face is read by its root, as Desktop reads it (super_tabs/controller.dart loadThread).
    const place: MessagePlace = target.thread === undefined ? 'chat' : { thread: target.thread }
    const thread = target.thread === undefined ? '' : `thread=${encodeURIComponent(target.thread)}`
    return slot(async () => {
      const path = `/api/super-tabs/${tabId}/conversations/${target.id}/messages`
      const newest = object(await backend(this.core, 'GET', thread ? `${path}?${thread}` : path))
      let said = lastAgentMessage(list(newest.messages), target.voices, place)
      // The page before, from the page's own (sequence, id) cursor: a page edge inside equal sequences skips nothing (design 4.6).
      const before = object(newest.next)
      if (!said && typeof before.sequence === 'number' && identifier(before.id)) {
        said = lastAgentMessage(list(object(await backend(this.core, 'GET', `${path}?${thread ? `${thread}&` : ''}before=${before.sequence}&beforeId=${before.id}`)).messages), target.voices, place)
      }
      // Access to the Swarm ended, another person signed in, or the face moved on while the read was out: the answer is not
      // this reader's to have now (a Buddy chat is its owner's alone), so it is neither given nor kept.
      const now = this.target(tabId, leadId, chat)
      if (this.me !== reader || now?.id !== target.id || now.thread !== target.thread) return { tabId, leadId, text: '', at: 0, none: true }
      if (target.thread !== undefined) await this.learnThread(tabId, target.id, target.thread, newest)
      const recap: LeadRecap = said ? { tabId, leadId, text: cut(said.text, RECAP_BYTES), at: said.at, none: false, ...named } : { tabId, leadId, text: '', at: 0, none: true, ...named }
      this.recaps.set(key, { sequence: target.sequence, recap, ...(target.thread === undefined ? {} : { thread: target.thread }) })
      return recap
    })
  }

  /** The title (the root's first line) and reply count of a thread read for the face, said again to the dial when they changed.
   *  A page that lacks the root (an app thread's root is further back) has it read once by its id; the last title is kept. A
   *  failed read is logged and tried again after a wait that doubles, at most ROOT_READ_TRIES times (review of #2756). */
  private async learnThread(tabId: string, conversationId: string, root: string, page: Json): Promise<void> {
    const key = `${tabId}/${root}`, was = this.titles.get(key)
    let text = list(page.messages).find(m => m.id === root)?.text
    let looked = was?.looked, failures = was?.failures, retryAt = was?.retryAt
    if (typeof text !== 'string' && !was?.title && !looked && (retryAt === undefined || this.now() >= retryAt)) {
      try {
        const one = await backend(this.core, 'GET', `/api/super-tabs/${tabId}/conversations/${conversationId}/messages?messageId=${encodeURIComponent(root)}`)
        text = list(object(one).messages).find(m => m.id === root)?.text
        looked = true
      } catch (error) {
        failures = (failures ?? 0) + 1
        // Nothing of the thread in the line: its id and title are the reader's.
        const code = String(object(error).code ?? (error instanceof Error ? error.name : 'error'))
        if (failures >= ROOT_READ_TRIES) {
          looked = true
          this.log(`[super-tabs] a dial thread's first message was not read (${code}); its title stays as it is`)
        } else {
          const wait = Math.min(ROOT_READ_WAIT_MS * 2 ** (failures - 1), 5 * 60_000)
          retryAt = this.now() + wait
          this.log(`[super-tabs] a dial thread's first message was not read (${code}); read again in ${Math.round(wait / 1000)} s`)
        }
      }
    }
    const replies = list(page.threads).find(t => t.id === root)?.replies
    const next = { title: (typeof text === 'string' ? titleOf(text) : '') || was?.title || '', ...(typeof replies === 'number' ? { replies } : {}),
      ...(looked ? { looked: true as const } : {}), ...(failures && !looked ? { failures, retryAt } : {}) }
    if (was?.title === next.title && was.replies === next.replies && was.looked === next.looked && was.failures === next.failures && was.retryAt === next.retryAt) return
    this.titles.set(key, next)
    if (this.titles.size > 32) this.titles.delete(this.titles.keys().next().value!)
    if (was?.title !== next.title || was.replies !== next.replies) { if (this.timer && this.live) this.emit() }
  }

  /** Words spoken on a Pro to a Lead that runs here (its harness): posted as the person in that Lead's conversation, as typed in
   *  the Swarm chat; with `chat`, in the chat on its face. Not `said` when that harness leads no project in the Swarms as last
   *  read, so the caller sends the turn as before; `refused` when the backend refused the post (a 4xx: a read-only Chat with
   *  PM, Buddies off, a Buddy chat not the reader's), whose words must never become a terminal turn instead (spec 2026-10-29
   *  Voice). Any other failure (the network, a 5xx) throws as before. `chatId`: the chat on the dial's face when the words
   *  were spoken; they go there or nowhere, so words for the reader's Buddy never land in the project's chat because the
   *  window moved on while they were said (review of #2146). `reviewed`: the person saw that chat named and pressed Send,
   *  so the words go there even if the face moved since, while it is still a chat of the Lead's project this reader may
   *  see (docs/device-voice-swarm-chat.md); the backend checks the post as for typing. `options.thread`: the thread on the
   *  face when the words were spoken (null: none), pinned like `chatId`: another one now refuses the words (CHAT_MOVED), unless
   *  `reviewed`, which posts them where they were spoken. `options.threaded`: the words came from the face, so a top-level post
   *  may start the dial's thread, if nothing moved meanwhile (spec 2026-11-03-dial-thread-face). */
  async say(harnessId: string, text: string, chat: CardChat = false, chatId?: string, reviewed = false, options: SayOptions = {}): Promise<SaidOnCard> {
    const reader = this.me, gen = this.focusGen
    for (const [tabId, { state }] of this.tabs) {
      // A Lead on another machine has no harness here, so the dial names it by its Swarm id (Diego's dial, 2026-10-29).
      const agent = list(state.agents).find(a => (a.machineId === this.machineId && a.harnessId === harnessId) || a.id === harnessId)
      const found = agent && cardId(agent.id) ? this.target(tabId, agent.id, chat) : null
      if (!found) continue
      const to = chatId === undefined || found.id === chatId ? found.id
        : reviewed && this.chatOfLead(state, agent!.id as string, chatId) ? chatId : null
      if (!to) return { said: false, refused: { code: 'CHAT_MOVED', message: 'That chat is no longer on the dial. Say it again.' } }
      // A thread pinned with the words is where they go, or none; with none pinned, the thread on the face as they are sent.
      const pinned = options.thread
      if (pinned !== undefined && !reviewed && (found.thread ?? null) !== pinned) return { said: false, refused: { code: 'CHAT_MOVED', message: 'That chat is no longer on the dial. Say it again.' } }
      const replyTo = pinned !== undefined ? pinned : to === found.id ? found.thread ?? null : null
      let sent: unknown
      try {
        sent = await backend(this.core, 'POST', `/api/super-tabs/${tabId}/commands`, { operationId: `pro-voice-${randomUUID()}`,
          command: { type: 'message.send', conversationId: to, text, replyTo, recipientIds: [] } })
      } catch (error) {
        if (error instanceof SuperTabHostError && error.status >= 400 && error.status < 500) return { said: false, refused: { code: error.code, message: error.message } }
        throw error
      }
      // Words said on the dial at top level, on the face, start the dial's thread, rooted at the message just posted.
      const root = object(object(sent).result).messageId
      if (chat === false || !options.threaded || replyTo !== null || !cardId(root)) return { said: true }
      // Only if the person, the face and the window are where the call began: a post out while any moved starts no thread.
      const now = this.target(tabId, agent!.id as string, chat)
      if (this.me !== reader || gen !== this.focusGen || now?.id !== to || now.thread !== undefined) return { said: true }
      this.threads.set(tabId, { conversationId: to, root, title: titleOf(text), at: this.now(), leadId: agent!.id as string })
      if (this.timer && this.live) { this.emit(); void this.pushOpen() }
      return { said: true, thread: { tabId, conversationId: to, root } }
    }
    return { said: false }
  }

  /** Whether `chatId` is, as last read, a chat that could be on this Lead's face: its Lead conversation, or an open chat of its
   *  project that is not another person's Buddy chat. */
  private chatOfLead(state: Json, leadId: string, chatId: string): boolean {
    const found = leadProjects(state).find(p => p.leadId === leadId)
    if (!found) return false
    if (found.lead.id === chatId) return true
    const c = list(state.conversations).find(c => c.id === chatId)
    return !!c && cardId(c.id) && c.archived !== true && (isSwarmBuddyChat(c) ? isReadersBuddyChat(c, this.me)
      : inProject(c, projectKey(found.project)) && (!isBuddyChat(c) || isReadersBuddyChat(c, this.me)))
  }

  /** Remembered recaps are kept only for Leads that are still in a tab, and a chat's only while it could be on the Lead's
   *  face: a swipe back to the other side, or the window back on a chat, is answered from it at once. */
  private prune(): void {
    for (const [key, held] of this.recaps) {
      const { tabId, leadId, chatId, buddy } = held.recap
      const state = this.tabs.get(tabId)?.state
      if (!state || !leadProjects(state).some(p => p.leadId === leadId) || (chatId !== undefined && !this.chatOfLead(state, leadId, chatId))) this.recaps.delete(key)
      // A thread's only while it is on the face.
      else if (held.thread !== undefined && this.target(tabId, leadId, buddy ? 'buddy' : true)?.thread !== held.thread) this.recaps.delete(key)
    }
  }

  /** Each open Lead that moved on since its Pro last got the recap, or whose face shows another chat: the new one is sent once.
   *  A failed read is tried again next tick. */
  private pushOpen(): Promise<void> {
    const run = this.pushing.then(() => this.pushOpenNow())
    this.pushing = run.catch(() => {})
    return run
  }
  private async pushOpenNow(): Promise<void> {
    for (const open of [...this.opened.values()]) {
      const target = this.target(open.tabId, open.leadId, open.chat)
      if (!target) continue
      const thread = target.thread ?? null
      if (open.sequence === null) { open.sequence = target.sequence; open.chatId = target.chatId ?? null; open.thread = thread; continue }
      if (open.sequence === target.sequence && open.chatId === (target.chatId ?? null) && open.thread === thread) continue
      // Another chat or thread on the face (a swipe, the window's move): what is held for it is pushed at once, and read again after.
      const moved = open.chatId !== (target.chatId ?? null) || open.thread !== thread
      const quick = moved ? this.held(open.tabId, open.leadId, open.chat) : null
      const recap = quick?.recap ?? await this.read(open.tabId, open.leadId, open.chat, 'background').catch(() => null)
      if (!recap) continue
      open.sequence = quick ? quick.sequence : target.sequence
      open.chatId = target.chatId ?? null
      open.thread = thread
      this.onRecap?.(recap)
      if (quick?.stale) this.refresh(open.tabId, open.leadId, open.chat, recap)
    }
  }
}

/** How a chat's recap names it: by its id, and as a swarmBuddy dial's when asked for one. */
function namedFor(target: Target, chat: CardChat): { chatId?: string; buddy?: true; thread?: string } {
  return target.chatId === undefined ? {} : { chatId: target.chatId, ...(chat === 'buddy' ? { buddy: true as const } : {}), ...(target.thread === undefined ? {} : { thread: target.thread }) }
}


/** Each project of a tab whose Lead conversation names its Lead: the project, that conversation and the Lead agent's id. */
function leadProjects(state: Json): Array<{ project: Json; lead: Json; leadId: string }> {
  const conversations = list(state.conversations)
  const projects = Array.isArray(state.projects) ? list(state.projects) : [{ id: 'lead', leadConversationId: 'lead' }]
  const out: Array<{ project: Json; lead: Json; leadId: string }> = []
  for (const project of projects) {
    const lead = conversations.find(c => c.id === project.leadConversationId)
    if (lead && typeof lead.leadId === 'string') out.push({ project, lead, leadId: lead.leadId })
  }
  return out
}

/**
 * The Swarms this account is in, as cards for the Harness Pro (superTabs/cards.ts): for each Swarm, its Leads and what
 * each is doing, and the last thing a Lead said (its recap). The Super Tab service reads them from the backend and tells
 * the core (`core.superTabs.cards`, `.cardRecap`); the core hands them to the devices, which put them on the cable.
 *
 * Only the devices hear these (`swarmCards`, `swarmCardRecap`): never the Wi-Fi device, the backend or a window.
 *
 * The list is the service's to say, whole, each time it changes; the core keeps the last one, so a dial that attaches
 * later is shown it (`replay`). A list is taken whole or not at all: one item that is not one drops the list and the last
 * good one stays, so a device never shows half a Swarm. A recap is one Lead's and is forwarded as it comes.
 *
 * The core also owns whether the cards are wanted at all (like attention.ts owns its waits): the devices say
 * whether a capable Pro is attached and which Swarms the desktop has tabs for (`want`), and the core says it to the Super Tab
 * service, again whenever that service (re)connects (`serviceUp`), and takes it back when the devices go (`devicesGone`).
 */
import type { LeadNotice, LeadRecap, SwarmBuddy, SwarmCard, SwarmChat, SwarmLead } from '../../core/api.js'

export interface SuperTabCardsDeps {
  /** The devices' door for the list (`ports.devices.swarmCards`). */
  swarmCards(items: SwarmCard[]): void
  /** The devices' door for one recap (`ports.devices.swarmCardRecap`). */
  swarmCardRecap(recap: LeadRecap): void
  /** The Super Tab service's `super_tabs` request (cardsWanted); its answer is not needed. */
  request?(payload: Record<string, unknown>): Promise<unknown>
  log?: (line: string) => void
}

const MAX_CARDS = 16, MAX_LEADS = 12, NAME_BYTES = 48, ENGINE_BYTES = 16, RECAP_BYTES = 1500
const STATES: ReadonlySet<string> = new Set(['ask', 'stuck', 'work', 'done'])
const CHATS: ReadonlySet<string> = new Set(['lead', 'pm', 'group', 'buddy'])
/** The Lead's notice comes from its Lead or Buddy chat, the Buddy's quiet one from its chat alone: an older dial reads only
 *  the first, so the Buddy's words never reach it. */
const NOTICE_CHATS: ReadonlySet<string> = new Set(['lead', 'pm'])
const BUDDY_NOTICE_CHATS: ReadonlySet<string> = new Set(['buddy'])
/** Desktop's pattern is the 15 half bits of a 5×5 grid (superTabs/buddyAvatar.ts). */
const MAX_CELLS = 0x7fff
const COLOR = /^#[0-9a-f]{6}$/
/** The Pro keeps an id in 48 bytes with its NUL. */
const ID = /^[A-Za-z0-9_-]{1,47}$/
const id = (value: unknown): value is string => typeof value === 'string' && ID.test(value)
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

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

/** The chat on a Lead's face, checked and cut; null when it is not one, and the Lead goes on without it (today's frames). */
function chatIn(value: unknown): SwarmChat | null {
  const chat = object(value)
  if (typeof chat.kind !== 'string' || !CHATS.has(chat.kind) || !id(chat.id) || typeof chat.name !== 'string' || typeof chat.working !== 'boolean') return null
  if (chat.since !== undefined && !whole(chat.since)) return null
  return { kind: chat.kind as SwarmChat['kind'], id: chat.id, name: cut(chat.name, NAME_BYTES), working: chat.working, ...(chat.since === undefined ? {} : { since: chat.since }) }
}

/** A Lead's notice from one of `chats`, checked and cut; null when it is not one, and the Lead goes on without it. */
function noticeIn(value: unknown, chats: ReadonlySet<string>): LeadNotice | null {
  const notice = object(value)
  if (typeof notice.chat !== 'string' || !chats.has(notice.chat) || !id(notice.chatId) || !id(notice.id) || typeof notice.text !== 'string' || !whole(notice.at)) return null
  return { chat: notice.chat as LeadNotice['chat'], chatId: notice.chatId, id: notice.id, text: cut(notice.text, RECAP_BYTES), at: notice.at }
}

/** The reader's Buddy on a Lead, checked and cut; null when it is not one. */
function buddyIn(value: unknown): SwarmBuddy | null {
  const buddy = object(value)
  if (!id(buddy.chatId) || typeof buddy.name !== 'string' || typeof buddy.engine !== 'string' || typeof buddy.live !== 'boolean') return null
  if (!whole(buddy.cells) || buddy.cells > MAX_CELLS || typeof buddy.color !== 'string' || !COLOR.test(buddy.color)) return null
  return { chatId: buddy.chatId, name: cut(buddy.name, NAME_BYTES), engine: cut(buddy.engine, ENGINE_BYTES), cells: buddy.cells, color: buddy.color, live: buddy.live }
}

/** A Lead the service sent, checked and cut; null when it is not one. */
function leadIn(value: unknown): SwarmLead | null {
  const lead = object(value)
  if (!id(lead.id) || !id(lead.projectId) || typeof lead.state !== 'string' || !STATES.has(lead.state)) return null
  if (typeof lead.project !== 'string' || typeof lead.engine !== 'string' || typeof lead.owner !== 'string') return null
  // `local` is the harness here that runs the Lead, or empty when it runs on another machine.
  if (typeof lead.local !== 'string' || (lead.local !== '' && !id(lead.local))) return null
  if (lead.since !== undefined && !whole(lead.since)) return null
  // The project's index in its Swarm, which the round dial shows the Leads by (the Pro sorts its own and ignores it).
  if (!whole(lead.order)) return null
  // The round dial's chat and alert are additions: one that is not sound is left out, and the Lead is kept as today's.
  const chat = lead.chat === undefined ? null : chatIn(lead.chat)
  const notice = lead.notice === undefined ? null : noticeIn(lead.notice, NOTICE_CHATS)
  // And so are the Buddy screen's (spec 2026-10-29-round-dial-pm-buddy).
  const sideChat = lead.sideChat === undefined ? null : chatIn(lead.sideChat)
  const buddy = lead.buddy === undefined ? null : buddyIn(lead.buddy)
  const buddyNotice = lead.buddyNotice === undefined ? null : noticeIn(lead.buddyNotice, BUDDY_NOTICE_CHATS)
  return {
    id: lead.id, projectId: lead.projectId, project: cut(lead.project, NAME_BYTES), engine: cut(lead.engine, ENGINE_BYTES),
    owner: cut(lead.owner, NAME_BYTES), local: lead.local, state: lead.state as SwarmLead['state'], order: lead.order,
    ...(lead.since === undefined ? {} : { since: lead.since }), ...(chat ? { chat } : {}), ...(notice ? { notice } : {}),
    ...(sideChat ? { sideChat } : {}), ...(lead.buddies === true ? { buddies: true as const } : {}), ...(buddy ? { buddy } : {}),
    ...(buddyNotice ? { buddyNotice } : {}),
  }
}

/** A Swarm the service sent, checked and cut; null when it is not one. */
function cardIn(value: unknown): SwarmCard | null {
  const card = object(value)
  if (!id(card.id) || typeof card.name !== 'string' || !whole(card.count) || !Array.isArray(card.leads)) return null
  const leads: SwarmLead[] = []
  for (const value of card.leads.slice(0, MAX_LEADS)) {
    const lead = leadIn(value)
    if (!lead) return null
    leads.push(lead)
  }
  return { id: card.id, name: cut(card.name, NAME_BYTES), count: card.count, leads, ...(card.side === 'buddy' ? { side: 'buddy' as const } : {}) }
}

/** A recap the service sent, checked and cut; null when it is not one. */
function recapIn(value: unknown): LeadRecap | null {
  const recap = object(value)
  if (!id(recap.tabId) || !id(recap.leadId) || typeof recap.text !== 'string' || !whole(recap.at) || typeof recap.none !== 'boolean') return null
  // A chat's recap names its chat or is not one: a dial must never show it for another chat.
  if (recap.chatId !== undefined && !id(recap.chatId)) return null
  return { tabId: recap.tabId, leadId: recap.leadId, text: cut(recap.text, RECAP_BYTES), at: recap.at, none: recap.none, ...(recap.chatId === undefined ? {} : { chatId: recap.chatId }),
    ...(recap.buddy === true ? { buddy: true as const } : {}) }
}

export function createSuperTabCards({ swarmCards, swarmCardRecap, request, log = (line) => console.log(line) }: SuperTabCardsDeps) {
  /** The last good list, or null before the service has said one. */
  let last: SwarmCard[] | null = null
  /** Whether any capable device wants cards, the Swarms to read first, and the conversation the window has open in a Swarm tab. */
  let wanted = false, include: string[] = []
  let focus: { tabId: string; conversationId: string; fromDevice?: true } | null = null
  const route = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      const answer = await request?.(payload)
      return answer === undefined ? { error: 'SERVICE_UNAVAILABLE' } : object(answer)
    } catch { return { error: 'SERVICE_UNAVAILABLE' } }
  }
  const tell = (): void => { void route({ action: 'cardsWanted', on: wanted, include, ...(focus ? { focus } : {}) }) }
  const api = {
    /** The devices say whether a capable Pro is attached (and which Swarms the desktop has open, and the conversation it has
     *  open in one): the service is told. */
    want(on: boolean, swarms: unknown, open?: unknown): void {
      const next = on && Array.isArray(swarms) ? [...new Set(swarms.filter(id))].slice(0, MAX_CARDS) : []
      const asked = object(open)
      const nextFocus = on && id(asked.tabId) && id(asked.conversationId)
        ? { tabId: asked.tabId, conversationId: asked.conversationId, ...(asked.fromDevice === true ? { fromDevice: true as const } : {}) } : null
      const key = (f: typeof focus) => `${f?.tabId}/${f?.conversationId}/${f?.fromDevice === true}`
      if (on === wanted && next.join(',') === include.join(',') && key(nextFocus) === key(focus)) return
      wanted = on
      include = next
      focus = nextFocus
      tell()
    },
    /** The Super Tab service (re)connected: it has forgotten, so it is told again if a device wants the cards. */
    serviceUp(): void {
      if (wanted) tell()
    },
    /** The devices went (their process or link): nothing reads the Swarms for them, and each wakes with a fresh count. */
    devicesGone(): void {
      if (!wanted) return
      wanted = false
      include = []
      focus = null
      tell()
    },
    /** The account changed or ended: the list shown and kept is of someone else, and the service starts over. */
    reset(): void {
      last = null
      swarmCards([])
      if (wanted) { void route({ action: 'cardsWanted', on: false, include: [] }); tell() }
    },
    /** Every Swarm, replacing the last list: forwarded whole when every item is sound, else dropped and logged. */
    cards(items: unknown): void {
      const next: SwarmCard[] = []
      for (const value of Array.isArray(items) ? items.slice(0, MAX_CARDS) : [null]) {
        const card = cardIn(value)
        if (!card) { log('[super-tabs] a Swarm card list was not sound; the last one stays'); return }
        next.push(card)
      }
      last = next
      swarmCards(next)
    },
    /** One Lead's last message, forwarded as it comes. */
    recap(value: unknown): void {
      const recap = recapIn(value)
      if (!recap) { log('[super-tabs] a Lead recap was not sound; it is dropped'); return }
      swarmCardRecap(recap)
    },
    /** What the devices may ask of the Super Tab service, and nothing else of it: `cardsWanted` is kept here, `cardRecap`,
     *  `cardOpen`, `cardSay`, `cardSide` and `cardWorker` go to the service; any other action is refused. */
    ask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (payload.action === 'cardsWanted') { api.want(payload.on === true, payload.include, payload.focus); return Promise.resolve({ ok: true }) }
      // A round dial that speaks swarmChat asks for the chat on its face, and one that speaks swarmBuddy for the face on its
      // side ('buddy'); without the flag, the request is today's.
      const chat = payload.chat === true || payload.chat === 'buddy' ? { chat: payload.chat } : {}
      // The side a swarmBuddy dial swiped to.
      if (payload.action === 'cardSide') {
        return payload.side === 'pm' || payload.side === 'buddy' ? route({ action: 'cardSide', tabId: payload.tabId, side: payload.side }) : Promise.resolve({ error: 'INVALID_REQUEST' })
      }
      if (payload.action === 'cardRecap') return route({ action: 'cardRecap', tabId: payload.tabId, leadId: payload.leadId, ...chat })
      // The chat on the dial's face when the words were spoken, which they may be posted in and no other.
      // `reviewed`: the person saw that chat named on the dial and pressed Send.
      if (payload.action === 'cardSay') return route({ action: 'cardSay', harnessId: payload.harnessId, text: payload.text, ...chat,
        ...(id(payload.chatId) ? { chatId: payload.chatId, ...(payload.reviewed === true ? { reviewed: true } : {}) } : {}) })
      if (payload.action === 'cardOpen') return route({ action: 'cardOpen', session: payload.session, tabId: payload.tabId, leadId: payload.leadId, ...chat })
      // A card's failure from another computer: whether its agent is a Swarm's worker (services/devices.ts asks; it decides).
      if (payload.action === 'cardWorker') return route({ action: 'cardWorker', machineId: payload.machineId, harnessId: payload.harnessId })
      return Promise.resolve({ error: 'INVALID_REQUEST' })
    },
    /** A dial attached: it has nothing, so it is shown the last list again. */
    replay(): void {
      if (last) swarmCards(last)
    },
  }
  return api
}

/**
 * The Swarms' cards and a Lead's recap, as the Swarm's service hands them to the devices through the core, unread
 * (core/relays.ts): checked and cut here, where the dial is, before the cable carries them. A list is taken whole or not
 * at all: one item that is not one drops the list and the last good one stays, so a dial never shows half a Swarm. A
 * recap is one Lead's and goes on as it comes. Until 2026-11-13 the core checked them (superTabs/inCore/cards.ts).
 */
import type { LeadNotice, LeadRecap, SwarmBuddy, SwarmCard, SwarmChat, SwarmLead } from '../core/api.js'

const MAX_CARDS = 16, MAX_LEADS = 12, NAME_BYTES = 48, ENGINE_BYTES = 16, RECAP_BYTES = 1500
const STATES: ReadonlySet<string> = new Set(['ask', 'stuck', 'work', 'done'])
const CHATS: ReadonlySet<string> = new Set(['lead', 'pm', 'group', 'buddy'])
/** The Lead's notice comes from its Lead or Buddy chat, the Buddy's quiet one from its chat alone: an older dial reads only
 *  the first, so the Buddy's words never reach it. */
const NOTICE_CHATS: ReadonlySet<string> = new Set(['lead', 'pm', 'group'])
const BUDDY_NOTICE_CHATS: ReadonlySet<string> = new Set(['buddy'])
/** Desktop's pattern is the 15 half bits of a 5×5 grid (superTabs/buddyAvatar.ts). */
const MAX_CELLS = 0x7fff
const COLOR = /^#[0-9a-f]{6}$/
/** A notice's thread root, cut to this: kept when longer than the dial holds, so no face matches it and the dial beeps. */
const THREAD_ROOT_BYTES = 128
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
  // A reply inside a thread names its root (#2463): without it the desktop and the dial read it by opening the chat.
  const thread = typeof notice.thread === 'string' && notice.thread ? cut(notice.thread, THREAD_ROOT_BYTES) : undefined
  // A decision asked of the reader is heard by a swarmNeedsYou dial alone, and any other keeps the tag it covers
  // (cableSession): without the mark and the tag the devices sent every dial the decision (Diego's dial, 2026-11-06).
  const decision = notice.decision === true
  const tag = decision && notice.tag !== undefined ? noticeIn({ ...object(notice.tag), decision: undefined, tag: undefined }, chats) : null
  return { chat: notice.chat as LeadNotice['chat'], chatId: notice.chatId, id: notice.id, text: cut(notice.text, RECAP_BYTES), at: notice.at,
    ...(thread ? { thread } : {}), ...(decision ? { decision: true as const } : {}), ...(tag ? { tag } : {}) }
}

/** The reader's Buddy on a Lead, checked and cut; null when it is not one. */
function buddyIn(value: unknown): SwarmBuddy | null {
  const buddy = object(value)
  if (!id(buddy.chatId) || typeof buddy.name !== 'string' || typeof buddy.engine !== 'string' || typeof buddy.live !== 'boolean') return null
  if (!whole(buddy.cells) || buddy.cells > MAX_CELLS || typeof buddy.color !== 'string' || !COLOR.test(buddy.color)) return null
  // Its session here, which tells a tap on its notification from any other agent's (cableSession agent.open). Kept on this
  // computer: the devices service strips it from every frame. An unsound one is left out and the Buddy is kept.
  return { chatId: buddy.chatId, name: cut(buddy.name, NAME_BYTES), engine: cut(buddy.engine, ENGINE_BYTES), cells: buddy.cells, color: buddy.color, live: buddy.live,
    ...(id(buddy.local) ? { local: buddy.local } : {}) }
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
  // `personal`: the reader's own Personal Swarm, for the round dial's Personal | Team picker. The port rebuilt each card without
  // it, so no dial ever showed the picker (Diego's dial, 2026-11-06).
  return { id: card.id, name: cut(card.name, NAME_BYTES), count: card.count, leads,
    ...(card.personal === true ? { personal: true as const } : {}) }
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

/** Every Swarm the service said, checked: null when one item is not sound. */
function cardsIn(items: unknown): SwarmCard[] | null {
  if (!Array.isArray(items)) return null
  const cards: SwarmCard[] = []
  for (const value of items.slice(0, MAX_CARDS)) {
    const card = cardIn(value)
    if (!card) return null
    cards.push(card)
  }
  return cards
}

export interface SwarmCardsInDeps {
  /** A checked list, whole, for the cable. */
  cards(items: SwarmCard[]): void
  /** A checked recap, for the cable. */
  recap(recap: LeadRecap): void
  log: (line: string) => void
}

/** What the devices do with each word the Swarm's service hands them: a sound list replaces the last, an unsound one is
 *  dropped and said (the last good one stays), null clears them (the account ended), and a recap goes on checked. */
export function createSwarmCardsIn({ cards, recap, log }: SwarmCardsInDeps) {
  return {
    cards(items: unknown): void {
      const next = items === null ? [] : cardsIn(items)
      if (!next) { log('[super-tabs] a Swarm card list was not sound; the last one stays'); return }
      cards(next)
    },
    recap(value: unknown): void {
      const checked = recapIn(value)
      if (!checked) { log('[super-tabs] a Lead recap was not sound; it is dropped'); return }
      recap(checked)
    },
  }
}

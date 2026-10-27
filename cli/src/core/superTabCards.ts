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
 * The core also owns whether the cards are wanted at all (like core/superTabAttention.ts owns its waits): the devices say
 * whether a capable Pro is attached and which Swarms the desktop has tabs for (`want`), and the core says it to the Super Tab
 * service, again whenever that service (re)connects (`serviceUp`), and takes it back when the devices go (`devicesGone`).
 */
import type { LeadRecap, SwarmCard, SwarmLead } from '../superTabs/cards.js'

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
  return {
    id: lead.id, projectId: lead.projectId, project: cut(lead.project, NAME_BYTES), engine: cut(lead.engine, ENGINE_BYTES),
    owner: cut(lead.owner, NAME_BYTES), local: lead.local, state: lead.state as SwarmLead['state'], order: lead.order,
    ...(lead.since === undefined ? {} : { since: lead.since }),
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
  // What waits on the person in this Swarm, a count only; nothing waiting, or a service from before it, leaves the field out.
  const needsYou = whole(card.needsYou) && card.needsYou > 0 ? card.needsYou : 0
  return { id: card.id, name: cut(card.name, NAME_BYTES), count: card.count, leads, ...(needsYou ? { needsYou } : {}) }
}

/** A recap the service sent, checked and cut; null when it is not one. */
function recapIn(value: unknown): LeadRecap | null {
  const recap = object(value)
  if (!id(recap.tabId) || !id(recap.leadId) || typeof recap.text !== 'string' || !whole(recap.at) || typeof recap.none !== 'boolean') return null
  return { tabId: recap.tabId, leadId: recap.leadId, text: cut(recap.text, RECAP_BYTES), at: recap.at, none: recap.none }
}

export function createSuperTabCards({ swarmCards, swarmCardRecap, request, log = (line) => console.log(line) }: SuperTabCardsDeps) {
  /** The last good list, or null before the service has said one. */
  let last: SwarmCard[] | null = null
  /** Whether any capable device wants cards, and the Swarms to read first. */
  let wanted = false, include: string[] = []
  const route = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      const answer = await request?.(payload)
      return answer === undefined ? { error: 'SERVICE_UNAVAILABLE' } : object(answer)
    } catch { return { error: 'SERVICE_UNAVAILABLE' } }
  }
  const tell = (): void => { void route({ action: 'cardsWanted', on: wanted, include }) }
  const api = {
    /** The devices say whether a capable Pro is attached (and which Swarms the desktop has open): the service is told. */
    want(on: boolean, swarms: unknown): void {
      const next = on && Array.isArray(swarms) ? [...new Set(swarms.filter(id))].slice(0, MAX_CARDS) : []
      if (on === wanted && next.join(',') === include.join(',')) return
      wanted = on
      include = next
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
     *  `cardOpen`, `cardSay` and `conversationSay` go to the service; any other action is refused. */
    ask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (payload.action === 'cardsWanted') { api.want(payload.on === true, payload.include); return Promise.resolve({ ok: true }) }
      if (payload.action === 'cardRecap') return route({ action: 'cardRecap', tabId: payload.tabId, leadId: payload.leadId })
      if (payload.action === 'cardSay') return route({ action: 'cardSay', harnessId: payload.harnessId, text: payload.text })
      if (payload.action === 'conversationSay') return route({ action: 'conversationSay', tabId: payload.tabId, conversationId: payload.conversationId,
        text: payload.text, operationId: payload.operationId })
      if (payload.action === 'cardOpen') return route({ action: 'cardOpen', session: payload.session, tabId: payload.tabId, leadId: payload.leadId })
      return Promise.resolve({ error: 'INVALID_REQUEST' })
    },
    /** A dial attached: it has nothing, so it is shown the last list again. */
    replay(): void {
      if (last) swarmCards(last)
    },
  }
  return api
}

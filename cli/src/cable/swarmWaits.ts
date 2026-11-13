/**
 * The Swarm's members here that wait on a person (superTabs/attention.ts), shown on the devices cabled to this computer:
 * a question frame with the tab's name and what it needs (`superTab`, `attention`), which the Harness Pro turns into an
 * alert that stays (the round dial reads the words alone). Display only: nobody answers it on a device; the agent's Lead
 * and the people in the tab do, in the tab.
 *
 * The Swarm's service hands the devices the whole set each time it changes, through the core, unread (core/relays.ts):
 * checked here. A device holds one question per agent, so an engine's question comes first: ours is taken down before it
 * shows (`before`) and put back once it is gone (`after`), and one raised while an engine's question is open waits for it
 * to close. Which engine questions are open the core says as the devices connect or start (`asking`), and the cards that pass
 * here keep it current, every one of which the core sends the devices (core/main.ts `onOutboundCommander`). A dial that
 * attaches is shown the waits again (`replay`).
 *
 * Until 2026-11-13 the core did this (superTabs/inCore/attention.ts), reading its own open questions.
 */
import { SUPER_TAB_REQUEST_PREFIX, type SuperTabAttention } from '../core/api.js'

type Frame = Record<string, unknown>

export interface SwarmWaitsDeps {
  /** A question frame for the devices' cable, as the core's cards reach it. */
  send(frame: Frame): void
  log?: (line: string) => void
}

const LIMIT = 64
const fits = (value: unknown, bytes: number): value is string => typeof value === 'string' && !!value && Buffer.byteLength(value) <= bytes

/** An item the service sent, checked: what reaches a device is decided here. */
function itemIn(value: unknown): SuperTabAttention | null {
  const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (!fits(item.agentId, 160) || !/^[A-Za-z0-9_-]+$/.test(item.agentId)) return null
  // The Pro drops a `question.close` whose id is 64 bytes or more: one it could not close is never raised.
  if (!fits(item.requestId, 63) || !item.requestId.startsWith(SUPER_TAB_REQUEST_PREFIX)) return null
  if (!fits(item.superTab, 48) || !fits(item.text, 1200) || (item.attention !== 'decision' && item.attention !== 'stuck')) return null
  return { agentId: item.agentId, requestId: item.requestId, superTab: item.superTab, attention: item.attention, text: item.text }
}

export function createSwarmWaits({ send, log = (line) => console.log(line) }: SwarmWaitsDeps) {
  /** The waits, by agent, and whether the devices were last shown each. */
  const open = new Map<string, { item: SuperTabAttention; shown: boolean }>()
  /** The agents with an engine's question open, as the cards that passed here said. */
  const asked = new Set<string>()
  const ours = (frame: Frame): boolean => {
    const requestId = (frame.payload as { requestId?: unknown } | undefined)?.requestId
    return typeof requestId === 'string' && requestId.startsWith(SUPER_TAB_REQUEST_PREFIX)
  }
  const raise = (entry: { item: SuperTabAttention; shown: boolean }): void => {
    const { agentId, requestId, superTab, attention, text } = entry.item
    entry.shown = true
    send({ type: 'commander_question', agentId, payload: { requestId, questions: [{ q: text }], superTab, attention } })
  }
  const show = (entry: { item: SuperTabAttention; shown: boolean }): void => { if (!asked.has(entry.item.agentId)) raise(entry) }
  const hide = (entry: { item: SuperTabAttention; shown: boolean }): void => {
    if (!entry.shown) return
    entry.shown = false
    send({ type: 'commander_question_close', agentId: entry.item.agentId, payload: { requestId: entry.item.requestId } })
  }

  return {
    /** Every wait, replacing the last set: what is gone or changed is closed, what is new is raised. None, or null (the
     *  service's last word gone), closes them all. */
    attention(items: unknown): void {
      const next = new Map<string, SuperTabAttention>()
      for (const value of Array.isArray(items) ? items.slice(0, LIMIT) : []) {
        const item = itemIn(value)
        if (item && !next.has(item.agentId)) next.set(item.agentId, item)
      }
      for (const [agentId, entry] of open) {
        if (JSON.stringify(next.get(agentId)) === JSON.stringify(entry.item)) { next.delete(agentId); continue }
        hide(entry)
        open.delete(agentId)
        log(`[super-tabs] ${agentId} no longer waits · req=${entry.item.requestId}`)
      }
      for (const [agentId, item] of next) {
        const entry = { item, shown: false }
        open.set(agentId, entry)
        show(entry)
        log(`[super-tabs] ${agentId} waits on a person (${item.attention}) · req=${item.requestId}`)
      }
    },
    /** The agents with an engine's question open, as the core knows them as the devices connect: the cards that pass after
     *  keep it current. One that closed while either process was away is no longer held open. */
    asking(agentIds: readonly string[]): void {
      asked.clear()
      for (const agentId of agentIds) asked.add(agentId)
    },
    /** A dial attached: it has nothing, so every wait is shown again, but where an engine's question is open. */
    replay(): void {
      for (const entry of open.values()) { entry.shown = false; show(entry) }
    },
    /** A card about to reach the devices: an engine's question for an agent showing ours takes its place. */
    before(frame: Frame): void {
      if (frame.type !== 'commander_question' || typeof frame.agentId !== 'string' || ours(frame)) return
      asked.add(frame.agentId)
      const entry = open.get(frame.agentId)
      if (entry) hide(entry)
    },
    /** A card that reached the devices: once an engine's question closes, the agent's wait shows again. */
    after(frame: Frame): void {
      if (frame.type !== 'commander_question_close' || typeof frame.agentId !== 'string' || ours(frame)) return
      asked.delete(frame.agentId)
      const entry = open.get(frame.agentId)
      if (entry && !entry.shown) raise(entry)
    },
  }
}

/**
 * Messages across accounts (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md, "Messages across
 * accounts"): what is checked of a message handed over through a shared tab's relay, what goes on the wire, and the
 * counters of the tab's limits. Pure: service.ts sends and receives, sharedTabs.ts carries the sealed frames.
 *
 * The receiving daemon trusts only its own signed roster and the relay's stamp (`from`, which the relay writes, never
 * the sender): a frame whose sender the roster does not list under the stamped account is refused before anything
 * reaches a pane, and the account, name and engine a header names are the roster's, whatever the sender wrote.
 */
import { SHARED_TAB_FRAME_MAX, sealedFrameBytes } from '../lib/e2ee/tabSession.js'
import type { Message } from './model.js'
import { cleanName, type Roster } from './roster.js'
import { accountsIn } from './sharedDirectory.js'

/** Where a frame came from: the shared tab it came through, and the machine and account the relay stamped on it. */
export interface TabContext { sharedTabId: string; from: { machineId: string; userId: string } }

/** A request's id on the wire, in hex characters (sharedTabs.ts `request`): counted in the frame's size. */
export const REQUEST_ID_LENGTH = 24
/**
 * The longest name a recipient carries in a frame. Names ride along for the recipient's log only, and a 16,000-character
 * message that JSON writes six bytes a character left 1,397 bytes of the 128 KiB frame (measured 2026-10-15,
 * tabSession.spec.ts): eight escaped 200-character names would not fit (review of A7).
 */
export const WIRE_NAME_MAX = 64
/** The longest sender's name, engine and machine a message carries, as the receiver takes them (model.ts `parseMessage`). */
const SENDER_MAX = 200
const ENGINE_MAX = 40

import { cleanText } from '../lib/cleanText.js'
export { cleanText } from '../lib/cleanText.js'
/** A field the receiver requires to be there: cleaned, and `?` where nothing is left of it. */
const shown = (value: string, max: number): string => cleanText(value, max) || '?'

/** A status's code (`NOT_IN_TAB`, `RATE_LIMITED`) as another machine wrote it: only one that looks like a code. */
export function statusCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z][A-Z_]{0,31}$/.test(value) ? value : undefined
}

const same = (a: { machineId: string; agentId: string }, b: { machineId: string; agentId: string }): boolean =>
  a.machineId === b.machineId && a.agentId === b.agentId

/** This machine, as a message handed over through a shared tab is checked against it (`checkHandedOver`). */
export interface HandOverSelf {
  accountId: string
  machineId: string
  /** Whether this machine asked for a harness of its own in the tab (messages/consentStore.ts): the only word that puts
   *  it in a tab another account owns. */
  consented(agentId: string): boolean
  /** A machine's name as this computer knows it (service.ts `machineName`), never as the sender wrote it. */
  machineName(machineId: string): string
}

/**
 * Whether a message handed over through a shared tab may be taken here (`self`: this machine and its account), checked
 * against the tab's roster this machine holds and the relay's stamp. On success the message as it is kept: the sender's
 * account, name, engine and machine overwritten from the stamp, the roster and this computer's own word, never merged
 * with what the sender wrote (review of B1; a sender that called itself `lead` was shown as the tab's lead, final review
 * of 1b), and every name shown cleaned. Refused, nothing of it reaches a pane, and the reason says what did not hold;
 * `code` when the sender should take it as final (NOT_IN_TAB) rather than try again.
 *
 * In a tab another account owns, a recipient here counts only if this machine asked for it (`consented`): the owner
 * signs the roster, and keeps listing a harness the member took out while the owner's computer was away, or lists it
 * again later (final review of 1b). Consent gated only watching (sharing/rosterGrants.ts) before; such a harness still
 * took other accounts' messages. The owner's own tab needs no asking, as there.
 */
export function checkHandedOver(roster: Roster, ctx: TabContext, message: Message, self: HandOverSelf): { ok: true; message: Message } | { refused: string; code?: 'NOT_IN_TAB' } {
  const from = message.from
  if (from.machineId !== ctx.from.machineId) return { refused: 'the sender\'s machine is not the one that sent it' }
  // This account's machines hand messages over through its own paired relay (service.ts `route`), never a tab's.
  if (ctx.from.userId === self.accountId) return { refused: 'it came from this account, whose machines hand messages over through its own relay' }
  if (message.tabId !== ctx.sharedTabId || roster.sharedTabId !== ctx.sharedTabId) return { refused: 'it names another tab than the one it came through' }
  const sender = roster.harnesses.find((h) => same(h, from))
  if (!sender) return { refused: 'the sender is not in the shared tab' }
  if (sender.accountId !== ctx.from.userId) return { refused: 'the sender is listed under another account than the one that sent it' }
  const here = message.to.filter((r) => r.machineId === self.machineId)
  if (!here.length) return { refused: 'it names no harness on this computer' }
  // Listed under this account in this tab, not merely somewhere in it: a foreign owner can list an unshared harness of
  // this account's under another account (review of B1).
  if (here.some((r) => !roster.harnesses.some((h) => same(h, r) && h.accountId === self.accountId))) {
    return { refused: 'a recipient on this computer is not in the shared tab under this account' }
  }
  if (roster.owner.accountId !== self.accountId && here.some((r) => !self.consented(r.agentId))) {
    return { refused: 'a recipient on this computer was not put in the shared tab from here', code: 'NOT_IN_TAB' }
  }
  const { accountId: _forgot, account: _theirs, ...said } = from
  return { ok: true, message: { ...message,
    from: { ...said, name: shown(sender.name, SENDER_MAX), engine: shown(sender.engine, ENGINE_MAX), machine: shown(self.machineName(from.machineId), SENDER_MAX),
      accountId: ctx.from.userId, account: accountsIn([roster]).get(ctx.from.userId)!.name },
    to: message.to.map((r) => ({ ...r, name: shown(r.name, SENDER_MAX) })) } }
}

/** Whether a tab's roster, as the sending machine holds it, carries a message to another account's machine: the sender
 *  listed under this account (`accountId`), and every recipient on that machine under another. */
export function carries(roster: Roster, message: Message, machineId: string, accountId: string): boolean {
  return roster.harnesses.some((h) => h.accountId === accountId && same(h, message.from))
    && message.to.filter((r) => r.machineId === machineId).every((r) => roster.harnesses.some((h) => h.accountId !== accountId && same(h, r)))
}

/** A message as it goes through a shared tab: under the tab's id (the owner logs it under its desk tab), with no account
 *  of the sender's (the receiver takes it from its roster), and names cleaned and cut to fit the frame. */
export function wireMessage(message: Message, sharedTabId: string): Message {
  const { accountId: _id, account: _name, ...from } = message.from
  return { ...message, tabId: sharedTabId,
    from: { ...from, name: shown(from.name, SENDER_MAX), engine: shown(from.engine, ENGINE_MAX), machine: shown(from.machine, SENDER_MAX) },
    to: message.to.map((r) => ({ ...r, name: shown(r.name, WIRE_NAME_MAX) })) }
}

/** Whether a request fits one relay frame once sealed (sharedTabs.ts `request`): one that does not is refused, never
 *  sent and never tried again, since the gateway would refuse it every time. */
export function fitsRequest(payload: Record<string, unknown>): boolean {
  return sealedFrameBytes({ ...payload, kind: 'agent_messages', rid: 'f'.repeat(REQUEST_ID_LENGTH) }) <= SHARED_TAB_FRAME_MAX
}

/** How many things happened per key within a window, for the limits (the spec's "Limits"): kept only while in the
 *  window, so a key that went quiet costs nothing. */
export class RateCounter {
  private readonly times = new Map<string, number[]>()

  private recent(key: string, windowMs: number, now: number): number[] {
    const kept = (this.times.get(key) ?? []).filter((t) => now - t < windowMs)
    if (kept.length) this.times.set(key, kept)
    else this.times.delete(key)
    return kept
  }

  /** Whether one more fits under `limit` within the last `windowMs`, without taking it. */
  room(key: string, limit: number, windowMs: number, now: number): boolean {
    return this.recent(key, windowMs, now).length < limit
  }

  /** Takes one when it fits; a refusal takes nothing. */
  take(key: string, limit: number, windowMs: number, now: number): boolean {
    const kept = this.recent(key, windowMs, now)
    if (kept.length >= limit) return false
    this.times.set(key, [...kept, now])
    return true
  }
}

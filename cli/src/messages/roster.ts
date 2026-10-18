/**
 * A shared tab's roster (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md, "Trust: the
 * signed roster"): who is in the tab, signed by the owner's computer. The backend stores it and reads nothing in it,
 * so what a member believes about the tab is only what the owner's key signed: a backend that served an altered
 * roster, or a stranger's, is caught here.
 *
 * The signature covers the body as the owner sent it, a string, never a re-encoding of it: two encoders that
 * disagree on a key's order or a number's form could otherwise disagree on whether it verifies.
 */
import { b64d, lvCat, verify } from '../lib/e2ee/core.js'
import { ROSTER_BODY_MAX, SHARED_TAB_FRAME_MAX, sealedFrameBytes } from '../lib/e2ee/tabSession.js'
import { datetime, int, list, NO, nullable, object, text, andThen } from './shape.js'

export const ROSTER_LIMITS = { harnesses: 32, members: 8 } as const

/** A harness's name is shown to people and handed to agents in a message's header: control and format characters (an
 *  escape sequence, a bidi override, a zero-width space) could redraw a terminal or pass one name for another. Taken
 *  out where a roster is built (sharedTabsRoster.ts `wireHarness`) and again where one is read, here. */
export const cleanName = (name: string): string => name.replace(/[\p{Cc}\p{Cf}]/gu, '')

const id = text(160, 1)
const pub = text(Infinity, 0, /^[A-Za-z0-9+/]{43}=$/)
export type RosterHarness = { accountId: string; machineId: string; machinePublicKey: string; agentId: string; name: string; engine: string }
export type Roster = {
  sharedTabId: string; version: number; name: string
  owner: { accountId: string; email: string; machineId: string; machinePublicKey: string }
  leader: { machineId: string; agentId: string } | null
  members: Array<{ accountId: string; email: string; name: string; acceptedAt: string }>
  harnesses: RosterHarness[]
  invites: Array<{ email: string; expiresAt: string }>
}
/** Every object strict (an unknown key refuses the roster), with the limits and patterns the zod schema had. */
const harness = object<RosterHarness>({ accountId: id, machineId: id, machinePublicKey: pub, agentId: id,
  name: andThen(text(200), cleanName), engine: text(64) })
const schema = object<Roster>({
  sharedTabId: text(Infinity, 0, /^[a-f0-9]{24}$/),
  version: int(1),
  name: text(200),
  owner: object({ accountId: id, email: text(254), machineId: id, machinePublicKey: pub }),
  leader: nullable(object({ machineId: id, agentId: id })),
  members: list(object({ accountId: id, email: text(254), name: text(200), acceptedAt: datetime() })),
  harnesses: list(harness),
  invites: list(object({ email: text(254), expiresAt: datetime() })),
})

export type KeyChange = { previousPub: string; signature: string }
export type SignedRoster = { body: string; signature: string; keyChange?: KeyChange }
export type RosterError = 'malformed' | 'bad_signature' | 'unpinned_key' | 'too_large'

export const rosterBytes = (sharedTabId: string, version: number, body: string): Uint8Array =>
  lvCat('harness-tab-roster-v1', sharedTabId, String(version), body)
export const keyChangeBytes = (sharedTabId: string, nextPub: string): Uint8Array =>
  lvCat('harness-tab-keychange-v1', sharedTabId, nextPub)

const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted((value as Record<string, unknown>)[k])]))
    : value

export const encodeRoster = (roster: Roster): string => JSON.stringify(sorted(roster))

/** A signature and a key in base64, as long as any: what a signed roster carries besides its body, key change included. */
const SIGNATURE = 'A'.repeat(86) + '==', KEY = 'A'.repeat(43) + '='

/**
 * Whether the owner may sign this roster. Over the members' ceiling (`verifyRoster`) every member would refuse it; and
 * sealed for them it must fit one relay frame, or the gateway refuses to send it and a member's request answered with
 * it never settles. A body under the ceiling can still miss the frame: a member's fields that JSON writes six bytes a
 * character (lone surrogates) seal an 85 KB body to more than 128 KiB (review of A7, 2026-10-15).
 */
export function fitsRoster(roster: Roster): boolean {
  const body = encodeRoster(roster)
  return Buffer.byteLength(body) <= ROSTER_BODY_MAX
    && sealedFrameBytes({ kind: 'roster', signed: { body, signature: SIGNATURE, keyChange: { previousPub: KEY, signature: SIGNATURE } } }) <= SHARED_TAB_FRAME_MAX
}

export function parseRoster(body: string): Roster | null {
  let json: unknown
  try { json = JSON.parse(body) } catch { return null }
  const roster = schema(json)
  return roster === NO ? null : roster
}

/** The signature and keys are wire input, so they may not be strings. `b64d` throws for a non-string on Node and
 *  skips what is not base64 for a string, and `verify` already answers false for a value of the wrong length, so
 *  checking the type is all that is left to do. */
const verifies = (pubKey: unknown, bytes: Uint8Array, signature: unknown): boolean =>
  typeof pubKey === 'string' && typeof signature === 'string' && verify(b64d(pubKey), bytes, b64d(signature))

export function verifyRoster(signed: SignedRoster, pinnedOwnerPub: string): { roster: Roster; ownerPub: string } | { error: RosterError } {
  // Before it is read or its signature checked: a body is wire input, and its size the cheapest thing to refuse it by.
  if (Buffer.byteLength(signed.body) > ROSTER_BODY_MAX) return { error: 'too_large' }
  const roster = parseRoster(signed.body)
  if (!roster) return { error: 'malformed' }
  const ownerPub = roster.owner.machinePublicKey
  if (!verifies(ownerPub, rosterBytes(roster.sharedTabId, roster.version, signed.body), signed.signature)) return { error: 'bad_signature' }
  if (ownerPub !== pinnedOwnerPub) {
    // The owner moved to a new computer or a new key: accepted only when the key the member pinned signed the move.
    const change = signed.keyChange
    if (!change || change.previousPub !== pinnedOwnerPub
      || !verifies(pinnedOwnerPub, keyChangeBytes(roster.sharedTabId, ownerPub), change.signature)) return { error: 'unpinned_key' }
  }
  if (roster.harnesses.length > ROSTER_LIMITS.harnesses || roster.members.length > ROSTER_LIMITS.members) return { error: 'too_large' }
  return { roster, ownerPub }
}

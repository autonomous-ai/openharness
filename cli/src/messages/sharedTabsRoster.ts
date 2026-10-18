/**
 * The pure half of shared tabs (sharedTabs.ts): reading what the backend and the relay hand over, which may be
 * anything, and building the roster the owner signs. Nothing here holds state or does I/O.
 */
import { createHash } from 'node:crypto'
import { cleanName, encodeRoster, fitsRoster, ROSTER_LIMITS, type Roster, type RosterHarness, type SignedRoster } from './roster.js'

/** An identity key as the roster's schema takes it: 32 bytes in base64. */
export const PUB = /^[A-Za-z0-9+/]{43}=$/
export const SHARED_TAB = /^[a-f0-9]{24}$/
/** The tab id the first roster of a share is signed with: the backend names the share only once it is stored. */
export const UNNAMED = '0'.repeat(24)
/** The id the backend names a share by (agentMessageShares.ts `sharedTabId`): from the owner's account and the desk tab,
 *  so the owner can check the one it is answered with. */
export const sharedTabIdOf = (accountId: string, tabId: string): string =>
  createHash('sha256').update(JSON.stringify(['amsg-share', accountId, tabId])).digest('hex').slice(0, 24)

type Wire = Record<string, unknown>
export const record = (v: unknown): Wire | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Wire : null)
const str = (v: unknown, max: number, min = 0): string | null =>
  typeof v === 'string' && v.length >= min && v.length <= max ? v : null
const id = (v: unknown): string | null => str(v, 160, 1)
/** A date the roster's schema takes (`z.string().datetime()`), as `toISOString` writes it; null for anything else. */
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const at = new Date(v)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

export const same = (a: { machineId: string; agentId: string }, b: { machineId: string; agentId: string }): boolean =>
  a.machineId === b.machineId && a.agentId === b.agentId

/** A harness as a member's request names it, checked field by field as the roster's schema would. */
export function wireHarness(v: unknown): RosterHarness | null {
  const h = record(v)
  if (!h) return null
  const accountId = id(h.accountId), machineId = id(h.machineId), agentId = id(h.agentId)
  const name = str(h.name, 200), engine = str(h.engine, 64)
  const machinePublicKey = typeof h.machinePublicKey === 'string' && PUB.test(h.machinePublicKey) ? h.machinePublicKey : null
  return accountId && machineId && agentId && name !== null && engine !== null && machinePublicKey
    ? { accountId, machineId, machinePublicKey, agentId, name: cleanName(name), engine } : null
}

export function harnessRef(v: unknown): { machineId: string; agentId: string } | null {
  const h = record(v)
  const machineId = id(h?.machineId), agentId = id(h?.agentId)
  return machineId && agentId ? { machineId, agentId } : null
}

export function signedOf(v: unknown): SignedRoster | null {
  const s = record(v)
  if (!s || typeof s.body !== 'string' || typeof s.signature !== 'string') return null
  const change = record(s.keyChange)
  return { body: s.body, signature: s.signature,
    ...(change && typeof change.previousPub === 'string' && typeof change.signature === 'string'
      ? { keyChange: { previousPub: change.previousPub, signature: change.signature } } : {}) }
}

export interface ShareView {
  sharedTabId: string; owner: boolean; ownerMachineId: string; version: number; roster: unknown
  /** The owner's account address as the backend knows it, for the person to recognise; empty when it gave none. */
  ownerEmail: string
  /** The owner's desk tab, which only the owner's account is told; empty for a member. */
  tabId: string; members: Roster['members']; invites: Roster['invites']
  /** The owner's pending invitations with the ids that revoke them (the roster lists none); empty for a member. */
  pending: Array<{ id: string; email: string; expiresAt: string }>
}

/** One share of `GET /api/agent-messages/shares`, or null; members and invites as the roster lists them. */
export function shareOf(v: unknown): ShareView | null {
  const s = record(v)
  if (!s || typeof s.sharedTabId !== 'string' || !SHARED_TAB.test(s.sharedTabId) || typeof s.ownerMachineId !== 'string') return null
  const members = (Array.isArray(s.members) ? s.members : []).flatMap((m) => {
    const r = record(m), accountId = id(r?.userId), email = str(r?.email, 254), acceptedAt = iso(r?.acceptedAt)
    return accountId && email && acceptedAt ? [{ accountId, email, name: email.split('@')[0], acceptedAt }] : []
  })
  const invites = (Array.isArray(s.invites) ? s.invites : []).flatMap((i) => {
    const r = record(i), email = str(r?.email, 254), expiresAt = iso(r?.expiresAt)
    return email && expiresAt ? [{ email, expiresAt }] : []
  })
  const pending = (s.owner === true && Array.isArray(s.invites) ? s.invites : []).flatMap((i) => {
    const r = record(i), invite = str(r?.id, 200, 1), email = str(r?.email, 254), expiresAt = iso(r?.expiresAt)
    return invite && email && expiresAt ? [{ id: invite, email: cleanName(email), expiresAt }] : []
  })
  return { sharedTabId: s.sharedTabId, owner: s.owner === true, ownerEmail: str(s.ownerEmail, 254) ?? '', ownerMachineId: s.ownerMachineId,
    version: typeof s.version === 'number' ? s.version : 0, roster: s.roster,
    tabId: typeof s.tabId === 'string' ? s.tabId : '', members, invites, pending }
}

/**
 * The owner's next roster: `prev` with what changed. The owner's own harnesses are its desk's panes; a member's stay
 * only while that member is one. One entry per harness, one member per account, one invitation per address, and the
 * limits the members' daemons check (`verifyRoster`), members by account and invitations by address: the owner's panes first, so a desk with more than a roster holds
 * is cut, never refused, and the owner sees it in the tab.
 */
export function compose(prev: Roster, change: Change): Roster { return composeCut(prev, change).roster }

type Change = { owner?: Roster['owner']; members?: Roster['members']; invites?: Roster['invites'];
  own?: RosterHarness[]; others?: RosterHarness[]; leader?: Roster['leader'] }

/** `compose`, and how many harnesses it cut to keep to the limit: the owner tells the person (sharedTabs.ts `change`). */
export function composeCut(prev: Roster, change: Change): { roster: Roster; cut: number } {
  const owner = change.owner ?? prev.owner
  const members = unique(change.members ?? prev.members, (m) => m.accountId).sort(by((m) => m.accountId)).slice(0, ROSTER_LIMITS.members)
  const own = change.own ?? prev.harnesses.filter((h) => h.accountId === owner.accountId)
  const others = (change.others ?? prev.harnesses.filter((h) => h.accountId !== owner.accountId))
    .filter((h) => h.accountId !== owner.accountId && members.some((m) => m.accountId === h.accountId))
  const all = unique([...own, ...others], (h) => `${h.machineId}/${h.agentId}`)
  const harnesses = all.slice(0, ROSTER_LIMITS.harnesses)
  const wanted = change.leader === undefined ? prev.leader : change.leader
  const leader = wanted && harnesses.some((h) => same(h, wanted)) ? wanted : null
  return { roster: { ...prev, owner, leader, members, harnesses, invites: unique(change.invites ?? prev.invites, (i) => i.email.toLowerCase()).sort(by((i) => i.email)) },
    cut: all.length - harnesses.length }
}

/** Members and invitations in a stable order: the backend lists them in whatever order its database reads them, and a
 *  roster that differed only in that order would be signed and sent again on every refresh. By code point, so that the
 *  order never depends on the computer's locale. */
const by = <T>(key: (item: T) => string) => (a: T, b: T): number => Number(key(a) > key(b)) - Number(key(a) < key(b))

const unique = <T>(list: T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>()
  return list.filter((item) => !seen.has(key(item)) && !!seen.add(key(item)))
}

/** Whether two rosters say the same, whatever their versions. */
export const sameRoster = (a: Roster, b: Roster): boolean => encodeRoster({ ...a, version: 1 }) === encodeRoster({ ...b, version: 1 })

/**
 * The identity key a machine must prove to hold a session with this one in the tab, or null when it may hold none:
 * the key the roster lists for it, under the account the relay says sent it. A member's machine that has no harness
 * in the tab yet is listed nowhere, so its first add could never reach the owner: the owner's computer alone takes
 * the key such a machine claims, when the relay says its account is a member (the backend admits a machine only for
 * an account that owns it). Its request is then held to that key.
 */
export function peerKey(roster: Roster, machineId: string, userId: string, claimed: unknown, authority: boolean): string | null {
  if (machineId === roster.owner.machineId) return roster.owner.accountId === userId ? roster.owner.machinePublicKey : null
  const listed = roster.harnesses.find((h) => h.machineId === machineId)
  if (listed) return listed.accountId === userId ? listed.machinePublicKey : null
  return authority && roster.members.some((m) => m.accountId === userId) && typeof claimed === 'string' && PUB.test(claimed) ? claimed : null
}

/**
 * What the owner makes of a member's request: the change to apply, null for none (already so), or why it is refused.
 * An add must come from the harness's own machine, under the key its session proved, for the sender's own account, on
 * a machine that is not the owner's nor listed under another account. A remove may come from any machine of the
 * harness's account: that is how a member takes out an entry put under its name that is not its own.
 */
export function judge(roster: Roster, from: { machineId: string; userId: string }, sessionPub: string, op: 'add' | 'remove',
  wire: unknown): { others: RosterHarness[] } | null | string {
  if (!roster.members.some((m) => m.accountId === from.userId)) return 'FORBIDDEN'
  const others = roster.harnesses.filter((h) => h.accountId !== roster.owner.accountId)
  if (op === 'remove') {
    const ref = harnessRef(wire)
    if (!ref) return 'INVALID_HARNESS'
    const entry = roster.harnesses.find((h) => same(h, ref))
    if (!entry) return null
    return entry.accountId === from.userId ? { others: others.filter((h) => !same(h, ref)) } : 'FORBIDDEN'
  }
  const harness = wireHarness(wire)
  if (!harness) return 'INVALID_HARNESS'
  const listed = roster.harnesses.find((h) => h.machineId === harness.machineId)
  // An honest backend admits a machine to the relay only for the account that owns it, so requiring the harness's own
  // machine ends one member listing harnesses on another's machine id, which a key "vouched for" by the sender allowed.
  // A dishonest backend that admits a machine for the wrong account is caught by the member's own check (`checkOwn`).
  if (harness.accountId !== from.userId || harness.machineId !== from.machineId
    || harness.machineId === roster.owner.machineId || (listed && listed.accountId !== from.userId)) return 'FORBIDDEN'
  if (harness.machinePublicKey !== sessionPub) return 'KEY_MISMATCH'
  if (roster.harnesses.some((h) => same(h, harness))) return null
  // Full by count, or by bytes: a roster over the members' ceiling would be refused by every one of them (`fitsRoster`).
  const next = { others: [...others, harness] }
  return roster.harnesses.length >= ROSTER_LIMITS.harnesses || !fitsRoster(compose(roster, next)) ? 'TAB_FULL' : next
}

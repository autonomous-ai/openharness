/**
 * The trust group: every machine and viewer app of one account that has linked, directly or through
 * another member, so each can reach every other without typing a remote password again.
 *
 * Deliberately simple, by product decision (UX over strictness): any two devices that already share an
 * E2EE session exchange their whole roster, and whatever an authenticated peer sends is taken as-is —
 * no signed introductions, no confirmation step. So A links B, A links C ⇒ A tells B about C and C
 * about B, and B↔C work. The cost: compromising ANY member lets it add keys the whole group trusts.
 * The backend still cannot, since rosters only cross sealed E2EE sessions between the devices.
 *
 * Removal propagates as a tombstone that beats any entry for that key it is not older than; linking
 * again stamps a newer entry, which beats the tombstone.
 *
 * Persistence mirrors machinePeers.ts: ${ADAPTER_DATA_DIR}/e2e/group.json, 0600, never cached — the
 * daemon and a short-lived `harness link …` process both read and write it.
 */
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { env } from '../../config/env.js'
import { b64d, fingerprint } from './core.js'
import type { PeerKind } from './store.js'

export interface GroupMember {
  pub: string           // base64 Ed25519 identity — the key every member pins/trusts
  machineId?: string    // set for kind 'machine' (a machine can be dialed; a viewer cannot)
  kind: PeerKind
  label: string
  at: number            // when this entry was stamped (link time); the newest entry for a key wins
}

export interface GroupTombstone {
  pub: string
  at: number
}

export interface Roster {
  members: GroupMember[]
  removed: GroupTombstone[]
}

export interface MergeResult {
  roster: Roster
  /** Members new to this roster, or whose entry changed (label/machineId). */
  upserted: GroupMember[]
  /** Members this merge dropped because a tombstone beat them. */
  dropped: GroupMember[]
}

export const MAX_MEMBERS = 256
export const MAX_TOMBSTONES = 256
const MACHINE_ID_RE = /^[a-f0-9]{32}$/
/** An entry stamped further in the future than this is refused — it would outlive every later removal. */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000

const DIR = join(env.ADAPTER_DATA_DIR, 'e2e')
const FILE = join(DIR, 'group.json')
/** Keys this machine's own user unpaired (`harness unpair`): kept out of the trust stores here however
 *  often the group names them. Local only — never sent, so unpairing stays the one-machine act it was;
 *  `harness group remove` is the group-wide one. A new link to the key lifts it. */
const BLOCKED_FILE = join(DIR, 'group-blocked.json')

function isPub(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 64) return false
  try { return b64d(v).length === 32 } catch { return false }
}

function cleanLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const label = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return label || null
}

function isStamp(v: unknown, now: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= now + MAX_CLOCK_SKEW_MS
}

/** One member as received from a peer or read from disk; null when anything about it is off. */
export function parseMember(raw: unknown, now = Date.now()): GroupMember | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isPub(r.pub) || !isStamp(r.at, now)) return null
  if (r.kind !== 'machine' && r.kind !== 'viewer') return null
  const machineId = typeof r.machineId === 'string' && MACHINE_ID_RE.test(r.machineId) ? r.machineId : undefined
  if (r.kind === 'machine' && !machineId) return null
  const label = cleanLabel(r.label) ?? (machineId ?? 'device')
  return { pub: r.pub, kind: r.kind, label, at: r.at, ...(r.kind === 'machine' ? { machineId } : {}) }
}

export function parseTombstone(raw: unknown, now = Date.now()): GroupTombstone | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isPub(r.pub) || !isStamp(r.at, now)) return null
  return { pub: r.pub, at: r.at }
}

/** A roster as received from a peer: malformed entries are dropped, and the lists are capped. */
export function parseRoster(raw: unknown, now = Date.now()): Roster {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const members = Array.isArray(r.members) ? r.members.slice(0, MAX_MEMBERS).map((m) => parseMember(m, now)).filter((m): m is GroupMember => !!m) : []
  const removed = Array.isArray(r.removed) ? r.removed.slice(0, MAX_TOMBSTONES).map((t) => parseTombstone(t, now)).filter((t): t is GroupTombstone => !!t) : []
  return { members, removed }
}

function sameMember(a: GroupMember, b: GroupMember): boolean {
  return a.pub === b.pub && a.kind === b.kind && a.label === b.label && a.machineId === b.machineId && a.at === b.at
}

/**
 * Fold `incoming` into `local`. Pure. `selfPub` is this device's own identity: it is never taken in as
 * a member (a device does not trust itself through the group) and a tombstone for it is ignored — once
 * removed, the other members stop trusting it, which is what removal has to achieve.
 */
export function mergeRoster(local: Roster, incoming: Roster, selfPub: string): MergeResult {
  const tombs = new Map<string, number>()
  for (const t of [...local.removed, ...incoming.removed]) {
    if (t.pub === selfPub) continue
    tombs.set(t.pub, Math.max(tombs.get(t.pub) ?? 0, t.at))
  }
  const members = new Map<string, GroupMember>()
  for (const m of local.members) if (m.pub !== selfPub) members.set(m.pub, m)
  const before = new Map(members)

  for (const m of incoming.members) {
    if (m.pub === selfPub) continue
    const existing = members.get(m.pub)
    if (!existing || m.at > existing.at) members.set(m.pub, m)
  }
  const dropped: GroupMember[] = []
  for (const [pub, m] of [...members]) {
    const tomb = tombs.get(pub)
    if (tomb !== undefined && tomb >= m.at) {
      members.delete(pub)
      if (before.has(pub)) dropped.push(before.get(pub)!)
    }
  }
  // A tombstone only matters while some entry it beats could still be around; keep the newest ones.
  const removed = [...tombs].map(([pub, at]) => ({ pub, at })).sort((a, b) => b.at - a.at).slice(0, MAX_TOMBSTONES)
  const kept = [...members.values()].sort((a, b) => b.at - a.at).slice(0, MAX_MEMBERS)
  const upserted = kept.filter((m) => { const prev = before.get(m.pub); return !prev || !sameMember(prev, m) })
  return { roster: { members: kept, removed }, upserted, dropped }
}

/** Order-independent digest, so two members can tell in one message whether they already agree. */
export function rosterDigest(roster: Roster): string {
  const members = [...roster.members].sort((a, b) => a.pub.localeCompare(b.pub)).map((m) => [m.pub, m.kind, m.machineId ?? '', m.label, m.at])
  const removed = [...roster.removed].sort((a, b) => a.pub.localeCompare(b.pub)).map((t) => [t.pub, t.at])
  return createHash('sha256').update(JSON.stringify({ members, removed })).digest('base64')
}

export class TrustGroupStore {
  read(): Roster {
    try {
      return parseRoster(JSON.parse(readFileSync(FILE, 'utf-8')))
    } catch {
      return { members: [], removed: [] }
    }
  }

  write(roster: Roster): void {
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    writeFileSync(FILE, JSON.stringify(roster, null, 2), { mode: 0o600 })
  }

  /** Merge and persist; returns what changed so the caller can pin/trust or unpin/untrust. */
  merge(incoming: Roster, selfPub: string): MergeResult {
    const result = mergeRoster(this.read(), incoming, selfPub)
    if (result.upserted.length || result.dropped.length || this.digestChanged(result.roster)) this.write(result.roster)
    return result
  }

  /** Stamp a member (a fresh link, or one learned outside a sync) with `at`. */
  add(member: GroupMember, selfPub: string): MergeResult {
    return this.merge({ members: [member], removed: [] }, selfPub)
  }

  /** Remove a member everywhere: a tombstone newer than its current entry. */
  remove(pub: string, selfPub: string, at = Date.now()): MergeResult {
    const current = this.read().members.find((m) => m.pub === pub)
    return this.merge({ members: [], removed: [{ pub, at: Math.max(at, (current?.at ?? 0) + 1) }] }, selfPub)
  }

  blocked(): Set<string> {
    try {
      const raw = JSON.parse(readFileSync(BLOCKED_FILE, 'utf-8')) as unknown
      return new Set(Array.isArray(raw) ? raw.filter(isPub) : [])
    } catch {
      return new Set()
    }
  }

  block(pub: string): void {
    const blocked = this.blocked()
    if (blocked.has(pub)) return
    blocked.add(pub)
    this.writeBlocked(blocked)
  }

  unblock(pub: string): void {
    const blocked = this.blocked()
    if (blocked.delete(pub)) this.writeBlocked(blocked)
  }

  list(): Array<GroupMember & { fingerprint: string }> {
    return this.read().members.map((m) => ({ ...m, fingerprint: fingerprint(b64d(m.pub)) }))
  }

  private writeBlocked(blocked: Set<string>): void {
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    writeFileSync(BLOCKED_FILE, JSON.stringify([...blocked].slice(-MAX_MEMBERS)), { mode: 0o600 })
  }

  private digestChanged(next: Roster): boolean {
    return rosterDigest(this.read()) !== rosterDigest(next)
  }
}

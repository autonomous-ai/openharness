/**
 * The signature of everything a host's rows are built from (read/host.ts), read from version columns only (no part data):
 * the head, members, agents and starts by their data stamps, machines by their settings marker (not their readings), and
 * conversations by their host-fields digest and dormancy (a post leaves both). Null while a conversation has no digest yet:
 * a missing digest counts as changed.
 *
 * The conversations are the long part (1,715 on prod's busiest Swarm), so their digests are a read-cache entry patched from
 * the Swarm's changes (cache.ts, cachePatch.ts) instead of a `$group` over every live conversation on every check
 * (docs/plans/2026-11-02-host-groups-delta-plan.md).
 */
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { CacheView } from '../cache.js'
import type { PatchRule } from '../cachePatch.js'
import { groupsBy, readBy } from '../parts/indexed.js'
import { ms } from '../parts/light.js'

type Transaction = Prisma.TransactionClient
/** The row hash's length at the front of an etag (read/hostEtag.ts); the input signature follows it. */
export const ROW_HASH = 22

/** What the signature reads of a live conversation: the digest of its host fields (null while it has none) and dormancy. */
export interface HostGroupRow { digest: string | null; dormant: boolean }
/** Every live conversation of a Swarm, by key. */
export type HostGroups = Readonly<Record<string, HostGroupRow>>

const byCodeUnit = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

/**
 * The rows' digests and dormancy in key order as one string, about 23 bytes each, and how many rows have no digest. The
 * string the `$group` pipeline built, byte for byte: a pod that still runs it and one that runs this agree on the etag.
 */
export function hostGroupsSignature(groups: HostGroups): { missing: number; all: string } {
  let missing = 0, all = ''
  for (const key of Object.keys(groups).sort(byCodeUnit)) {
    const { digest, dormant } = groups[key]!
    if (digest === null) missing++
    all += (digest ?? '') + (dormant ? '1' : '0')
  }
  return { missing, all }
}

/**
 * The `host:groups` entry: a changed conversation comes as its row is now, so applying one twice does nothing; a tombstone
 * takes its row out. A delta that carries no digest for a changed conversation (a loader that does not read them) cannot be
 * applied: the entry loads again.
 */
export const hostGroupsRule: PatchRule<HostGroups> = {
  kinds: ['group'],
  apply(held, delta) {
    let next: Record<string, HostGroupRow> | null = null
    for (const part of delta.parts) {
      if (part.kind !== 'group') continue
      const current = next ?? held
      if (part.deleted) {
        if (!Object.hasOwn(current, part.key)) continue
        next ??= { ...held }
        delete next[part.key]
        continue
      }
      if (!delta.hostDigests?.has(part.key)) return 'reload'
      const row: HostGroupRow = { digest: delta.hostDigests.get(part.key) ?? null, dormant: !!part.dormant }
      const was = Object.hasOwn(current, part.key) ? current[part.key] : undefined
      if (was && was.digest === row.digest && was.dormant === row.dormant) continue
      next ??= { ...held }
      next[part.key] = row
    }
    return next ?? held
  },
}

/** The kinds whose live rows the signature reads by their data stamp. */
const STAMP_KINDS = ['member', 'agent', 'start'] as const
type StampKind = typeof STAMP_KINDS[number]
/** Every live member, agent and start of a Swarm: its data stamp (`changedAt`, in ms), by kind and key. */
export type HostStamps = Readonly<Record<StampKind, Readonly<Record<string, number>>>>
const STAMP_COLLECTION = { member: 'SwarmMember', agent: 'SwarmAgent', start: 'SwarmStart' } as const

/** The stamps of every live member, agent and start, in one reply each. */
export async function loadHostStamps(tx: Transaction, tabId: string): Promise<HostStamps> {
  const [member, agent, start] = await Promise.all(STAMP_KINDS.map(async kind => Object.fromEntries((await readBy(tx, STAMP_COLLECTION[kind], 'changes',
    [{ $match: { tabId, deleted: false } }, { $project: { _id: 0, key: 1, changedAt: 1 } }])).map(row => [row.key as string, ms(row.changedAt)]))))
  return { member: member!, agent: agent!, start: start! }
}

/**
 * The `host:stamps` entry (#2839): a host's check after any change read every live start's stamp again, and finished starts
 * stay live for 7 days, so the read grew with the Swarm's history (Atlas ops per request up 38% at flat traffic). A changed
 * part comes as its row is now, so applying one twice does nothing; a tombstone takes its key out. A touch moves no
 * `changedAt`, so it is in no delta and changes no stamp, as it changed none of the rows read before.
 */
export const hostStampsRule: PatchRule<HostStamps> = {
  kinds: [...STAMP_KINDS],
  apply(held, delta) {
    let next: Record<StampKind, Record<string, number>> | null = null
    const copied = new Set<StampKind>()
    const writable = (kind: StampKind) => {
      next ??= { ...held } as Record<StampKind, Record<string, number>>
      if (!copied.has(kind)) { next[kind] = { ...held[kind] }; copied.add(kind) }
      return next[kind]
    }
    for (const part of delta.parts) {
      const kind = part.kind as StampKind
      if (!STAMP_KINDS.includes(kind)) continue
      const current = (next ?? held)[kind]
      if (part.deleted) {
        if (Object.hasOwn(current, part.key)) delete writable(kind)[part.key]
        continue
      }
      if (current[part.key] !== part.changedAt) writable(kind)[part.key] = part.changedAt
    }
    return next ?? held
  },
}

/** Every live conversation's row, through the live index alone: it holds the key, digest and dormancy, so no document is read. */
export async function loadHostGroups(tx: Transaction, tabId: string): Promise<HostGroups> {
  const rows = await groupsBy(tx, 'live', [{ $match: { tabId, deleted: false } },
    { $project: { _id: 0, key: 1, hostDigest: 1, dormant: 1 } }]) as Array<{ key: string; hostDigest?: string | null; dormant?: boolean }>
  return Object.fromEntries(rows.map(row => [row.key, { digest: typeof row.hostDigest === 'string' ? row.hostDigest : null, dormant: !!row.dormant }]))
}

export async function hostInputs(tx: Transaction, view: CacheView, tabId: string): Promise<string | null> {
  const live = { tabId, deleted: false }
  const [head, stamps, machines, held] = await Promise.all([
    tx.swarmHead.findUnique({ where: { id: `${tabId}:head` }, select: { changedAt: true } }),
    view.get(tabId, 'host:stamps', 'main', () => loadHostStamps(tx, tabId), hostStampsRule),
    tx.swarmMachine.findMany({ where: live, select: { key: true, hostChangedAt: true } }),
    view.get(tabId, 'host:groups', 'main', () => loadHostGroups(tx, tabId), hostGroupsRule),
  ])
  // As the rows read before gave them: key, then the stamp as a date.
  const rows = (kind: StampKind) => Object.entries(stamps[kind]).map(([key, at]) => ({ key, changedAt: new Date(at) }))
  const [members, agents, starts] = STAMP_KINDS.map(rows)
  const groups = hostGroupsSignature(held)
  if (!head || groups.missing) return null
  const keyed = <T extends { key: string }>(rows: T[]) => rows.sort((a, b) => byCodeUnit(a.key, b.key))
  return createHash('sha256').update(JSON.stringify([head.changedAt, keyed(members!), keyed(agents!), keyed(starts!), keyed(machines), groups.all]))
    .digest('base64url').slice(0, ROW_HASH)
}

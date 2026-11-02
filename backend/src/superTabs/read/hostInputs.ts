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
import { groupsBy } from '../parts/indexed.js'

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

/** Every live conversation's row, through the live index alone: it holds the key, digest and dormancy, so no document is read. */
export async function loadHostGroups(tx: Transaction, tabId: string): Promise<HostGroups> {
  const rows = await groupsBy(tx, 'live', [{ $match: { tabId, deleted: false } },
    { $project: { _id: 0, key: 1, hostDigest: 1, dormant: 1 } }]) as Array<{ key: string; hostDigest?: string | null; dormant?: boolean }>
  return Object.fromEntries(rows.map(row => [row.key, { digest: typeof row.hostDigest === 'string' ? row.hostDigest : null, dormant: !!row.dormant }]))
}

export async function hostInputs(tx: Transaction, view: CacheView, tabId: string): Promise<string | null> {
  const live = { tabId, deleted: false }, stamp = { key: true, changedAt: true } as const
  const [head, members, agents, starts, machines, held] = await Promise.all([
    tx.swarmHead.findUnique({ where: { id: `${tabId}:head` }, select: { changedAt: true } }),
    tx.swarmMember.findMany({ where: live, select: stamp }), tx.swarmAgent.findMany({ where: live, select: stamp }),
    tx.swarmStart.findMany({ where: live, select: stamp }),
    tx.swarmMachine.findMany({ where: live, select: { key: true, hostChangedAt: true } }),
    view.get(tabId, 'host:groups', 'main', () => loadHostGroups(tx, tabId), hostGroupsRule),
  ])
  const groups = hostGroupsSignature(held)
  if (!head || groups.missing) return null
  const keyed = <T extends { key: string }>(rows: T[]) => rows.sort((a, b) => byCodeUnit(a.key, b.key))
  return createHash('sha256').update(JSON.stringify([head.changedAt, keyed(members), keyed(agents), keyed(starts), keyed(machines), groups.all]))
    .digest('base64url').slice(0, ROW_HASH)
}

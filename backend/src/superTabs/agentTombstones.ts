/**
 * Removed agents' tombstones go 7 days after their removal (prod 2026-11-02: about 1,000 kept for good in one Swarm, read by
 * every live-agent read). Members and machines keep theirs, compacted (sweeps.ts compactTombstones). An agent added again
 * after its tombstone went starts above its configuration revisions (parts/write.ts), so its versions never go back.
 */
import type { PrismaClient } from '@prisma/client'
import { groupsBy, readBy } from './parts/indexed.js'

/** How long a tombstone kept because something open names it waits before it is checked again. */
export const AGENT_RECHECK_MS = 86_400_000
const BATCH = 500

const at = (ms: number) => ({ $date: new Date(ms).toISOString() })

/** The agents of `keys` that an open conversation (as its member, Lead or assignee) or a live start of the Swarm names. */
async function namedAgents(db: PrismaClient, tabId: string, keys: string[]): Promise<Set<string>> {
  const [groups, starts] = await Promise.all([
    // The open conversations only, by their index (parts/indexed.ts); the names as light.ts undecidedWork reads them.
    groupsBy(db, 'dormancy', [{ $match: { tabId, deleted: false, dormant: false,
      $or: [{ agentIds: { $in: keys } }, { 'data.leadId': { $in: keys } }, { 'data.assignment.agentId': { $in: keys } }] } },
    { $project: { _id: 0, agentIds: 1, 'data.leadId': 1, 'data.assignment.agentId': 1 } }]),
    readBy(db, 'SwarmStart', 'agents', [{ $match: { tabId, agentId: { $in: keys }, deleted: false } }, { $project: { _id: 0, agentId: 1 } }]),
  ])
  const names = [...groups.flatMap(row => {
    const data = row.data as { leadId?: string | null; assignment?: { agentId?: string } } | undefined
    return [...row.agentIds as string[] ?? [], data?.leadId, data?.assignment?.agentId]
  }), ...starts.map(row => row.agentId as string)]
  return new Set(names.filter((name): name is string => !!name && keys.includes(name)))
}

/**
 * Deletes agent tombstones past their purge time, in batches, by the purge index. One an open conversation or a live start
 * still names is compacted and checked again `AGENT_RECHECK_MS` later. Each write repeats the due match, so a tombstone an
 * agent's return revived since the read stays; a return that read it before the delete fails its guard and runs again.
 */
export async function purgeAgentTombstones(db: PrismaClient, now: number): Promise<{ purged: number; kept: number }> {
  const due = { deleted: true, purgeAt: { $lt: at(now) } }
  let purged = 0, kept = 0
  for (;;) {
    const rows = await readBy(db, 'SwarmAgent', 'purge', [{ $match: due }, { $limit: BATCH }, { $project: { _id: 1, tabId: 1, key: 1 } }]) as
      Array<{ _id: string; tabId: string; key: string }>
    if (!rows.length) break
    const tabs = new Map<string, string[]>()
    for (const row of rows) tabs.set(row.tabId, [...tabs.get(row.tabId) ?? [], row.key])
    const named = new Set<string>()
    for (const [tabId, keys] of tabs) for (const key of await namedAgents(db, tabId, keys)) named.add(`${tabId}\0${key}`)
    const held = rows.filter(row => named.has(`${row.tabId}\0${row.key}`)).map(row => row._id)
    const free = rows.filter(row => !named.has(`${row.tabId}\0${row.key}`)).map(row => row._id)
    if (free.length) {
      const reply = await db.$runCommandRaw({ delete: 'SwarmAgent', deletes: [{ q: { _id: { $in: free }, ...due }, limit: 0 }] }) as unknown as { n?: number }
      purged += Number(reply.n ?? 0)
    }
    if (held.length) {
      const reply = await db.$runCommandRaw({ update: 'SwarmAgent', updates: [{ q: { _id: { $in: held }, ...due },
        u: { $set: { data: {}, purgeAt: at(now + AGENT_RECHECK_MS) } }, multi: true }] }) as unknown as { nModified?: number }
      kept += Number(reply.nModified ?? 0)
    }
    if (rows.length < BATCH) break
  }
  return { purged, kept }
}

/** Tombstones compacted for good before this purge (purge time null) get one now, so the next sweep purges them. Run once
 *  by the worker at startup: one pass over the agents (about 1,300 in prod, 2026-11-02), as no index leads with `deleted`. */
export async function requeueCompactedAgents(db: PrismaClient, now: number): Promise<number> {
  const reply = await db.$runCommandRaw({ update: 'SwarmAgent', updates: [{ q: { deleted: true, purgeAt: null }, u: { $set: { purgeAt: at(now) } },
    multi: true }] }) as unknown as { nModified?: number }
  return Number(reply.nModified ?? 0)
}

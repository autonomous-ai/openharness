import type { Prisma, PrismaClient } from '@prisma/client'
import type { AgentStart, Conversation } from './model.js'
import { clock, guardedWrite, PartConflict, type HeadData, type ProgressData } from './parts/index.js'
import { DORMANT_AFTER_MS, RETENTION_MS } from './parts/types.js'
import { logger } from '../utils/logger.js'
import { ensureIndex } from '../lib/db/indexes.js'
import { swarmTransaction } from './cache.js'
import { listNamedIndexes, readBy } from './parts/indexed.js'
import { autonomousEnvironments } from '../lib/autonomousEnvironment.js'

/** Parts whose key is never used twice (conversations, starts, projects' progress) lose their tombstone at `purgeAt`.
 *  A person, agent or machine can come back under the same key, so its tombstone is kept for good, compacted to its
 *  version (`compactTombstones`): versions never reset (spec ruling 6, review round 1). Run by the singleton worker at
 *  startup, like the terminal and mention expiry indexes. */
export async function ensurePartExpiry(db: PrismaClient): Promise<void> {
  for (const collection of ['SwarmHead', 'SwarmGroup', 'SwarmStart', 'SwarmProgress']) {
    await ensureIndex(db, collection, { key: { purgeAt: 1 }, name: 'part_purge', expireAfterSeconds: 0 })
  }
  // Workspaces (workspaceStore.ts): a removed person's row, a finished removal and a deleted Workspace 30 days on, an invitation when it expires.
  for (const collection of ['SwarmWorkspace', 'SwarmWorkspaceMember', 'SwarmWorkspaceRemoval']) {
    await ensureIndex(db, collection, { key: { purgeAt: 1 }, name: 'workspace_purge', expireAfterSeconds: 0 })
  }
  await ensureIndex(db, 'SwarmWorkspaceInvitation', { key: { expiresAt: 1 }, name: 'workspace_invitation_expiry', expireAfterSeconds: 0 })
}

/** A removed person, agent or machine keeps its tombstone after its 7 days, with its data dropped: the version it holds
 *  is where a part added again under that key continues (parts/write.ts). Readers already passed its removal. */
async function compactTombstones(db: PrismaClient, now: number): Promise<number> {
  // Plain matches on the purge index (parts/indexed.ts). Through Prisma, `purgeAt: { lt }` was $expr, which no index bounds
  // (a collection scan each hour) and where a null purge time is less than any date: every tombstone compacted before was
  // compacted again, each hour (roadmap Phase 3.6).
  const due = { deleted: true, purgeAt: { $lt: { $date: new Date(now).toISOString() } } }
  let compacted = 0
  for (const collection of ['SwarmMember', 'SwarmAgent', 'SwarmMachine'] as const) {
    for (;;) {
      const ids = (await readBy(db, collection, 'purge', [{ $match: due }, { $limit: BATCH }, { $project: { _id: 1 } }])).map(row => row._id as string)
      if (!ids.length) break
      // The same match again: a tombstone revived since the read is left alone.
      const reply = await db.$runCommandRaw({ update: collection, updates: [{ q: { _id: { $in: ids }, ...due }, u: { $set: { data: {}, purgeAt: null } }, multi: true }] }) as
        unknown as { nModified?: number }
      compacted += Number(reply.nModified ?? 0)
      if (ids.length < BATCH) break
    }
  }
  return compacted
}

const BATCH = 500

/** One guarded write in its own transaction. A part that changed since it was read is left for the next sweep. */
async function guarded(db: PrismaClient, write: Parameters<typeof guardedWrite>[2] & { tabId: string }): Promise<boolean> {
  try {
    await swarmTransaction(db, tx => guardedWrite(tx, write.tabId, write, clock.next()))
    return true
  } catch (error) {
    if (error instanceof PartConflict) return false
    throw error
  }
}

/**
 * A conversation leaves the active set (spec, Archive) when its work is done or cancelled and it has had no message for a
 * day, or when it was archived by hand, and in both cases only once its Lead acknowledged its reports: a dormant
 * conversation is never read by ordinary loads, so it must owe its project nothing (design section 3.6). A project's
 * Lead conversation and the Leads conversation never sleep; a message wakes any of them. Candidates are read oldest
 * first with a cursor, so rejected ones never hold later ones back.
 */
async function sleepQuietGroups(db: PrismaClient, now: number): Promise<number> {
  const base = { deleted: false, dormant: false, kind: null, OR: [{ lastActivityAt: { lt: new Date(now - DORMANT_AFTER_MS) } }, { archived: true }] }
  const leads = new Map<string, Set<string>>(), progress = new Map<string, ProgressData | null>()
  const leadsOf = async (tabId: string) => {
    if (!leads.has(tabId)) {
      const head = await db.swarmHead.findUnique({ where: { id: `${tabId}:head` } })
      const projects = (head?.data as unknown as HeadData | undefined)?.projects
      leads.set(tabId, new Set(projects ? projects.map(p => p.leadConversationId) : ['lead']))
    }
    return leads.get(tabId)!
  }
  const progressOf = async (tabId: string, projectId: string) => {
    const id = `${tabId}:${projectId}`
    if (!progress.has(id)) progress.set(id, ((await db.swarmProgress.findUnique({ where: { id } }))?.data as unknown as ProgressData | undefined) ?? null)
    return progress.get(id)!
  }
  let slept = 0, after: { at: Date; id: string } | null = null
  for (;;) {
    const cursor: Prisma.SwarmGroupWhereInput = after ? { AND: [{ OR: [{ lastActivityAt: { gt: after.at } }, { lastActivityAt: after.at, id: { gt: after.id } }] }] } : {}
    const rows: Array<{ id: string; tabId: string; key: string; version: number; lastActivityAt: Date; data: Prisma.JsonValue }> = await db.swarmGroup.findMany({ where: { ...base, ...cursor }, orderBy: [{ lastActivityAt: 'asc' }, { id: 'asc' }], take: BATCH })
    for (const row of rows) {
      const group = row.data as unknown as Conversation
      const quiet = row.lastActivityAt.getTime() < now - DORMANT_AFTER_MS && ['done', 'cancelled'].includes(group.assignment?.status ?? '')
      if (!group.archived && !quiet) continue
      if ((await leadsOf(row.tabId)).has(group.id)) continue
      const reports = group.audience ? null : await progressOf(row.tabId, group.projectId ?? 'lead')
      if (reports && (group.reportSeq ?? 0) > (reports.summarized[group.id] ?? reports.summarizedFloor)) continue
      if (await guarded(db, { tabId: row.tabId, op: 'update', kind: 'group', key: row.key, seen: row.version, data: { ...group, dormant: true } })) slept++
    }
    if (rows.length < BATCH) return slept
    after = { at: rows.at(-1)!.lastActivityAt, id: rows.at(-1)!.id }
  }
}

/** Finished starts are kept 7 days, then removed (spec, Archive); their tombstones go 7 days later (purge index). */
async function expireStarts(db: PrismaClient, now: number): Promise<number> {
  // A plain match on the expiry index: through Prisma, `finishedAt: { lt }` was $expr, where a null finish time is less than
  // any date, so every start still starting was removed too (#2169). Here a start with no finish time never matches.
  const rows = await readBy(db, 'SwarmStart', 'expiry', [
    { $match: { deleted: false, finishedAt: { $lt: { $date: new Date(now - RETENTION_MS).toISOString() } } } }, { $limit: BATCH },
    { $project: { tabId: 1, key: 1, version: 1, data: 1 } }])
  let expired = 0
  for (const row of rows) {
    if (await guarded(db, { tabId: row.tabId as string, op: 'remove', kind: 'start', key: row.key as string, seen: Number(row.version), data: row.data as unknown as AgentStart })) expired++
  }
  return expired
}

/** Expired invitations leave the head and the index the invited person's list is read from (spec, Archive). */
async function expireInvitations(db: PrismaClient, now: number): Promise<number> {
  // Only the Swarms with an invitation: their row's invitation index names each invited address (parts/commit.ts), so the
  // invitation index holds exactly them. Every head was read whole each hour before (roadmap Phase 3.6).
  // Each environment named, so the index bounds the addresses within it; an empty list holds no address.
  const invited = await readBy(db, 'SuperTab', 'invited', [{ $match: { autonomousEnv: { $in: [...autonomousEnvironments] }, invitedEmails: { $gte: '' } } },
    { $group: { _id: '$_id' } }])
  let expired = 0
  for (const { _id: tabId } of invited) {
    const head = await db.swarmHead.findUnique({ where: { id: `${tabId as string}:head` } })
    if (!head || head.deleted) continue
    const data = head.data as unknown as HeadData
    const kept = data.invitations.filter(i => i.expiresAt > now)
    if (kept.length === data.invitations.length) continue
    try {
      await swarmTransaction(db, async tx => {
        await guardedWrite(tx, head.tabId, { op: 'update', kind: 'head', key: 'head', seen: head.version, data: { ...data, invitations: kept },
          head: { groupCounter: head.groupCounter, visibilityEpoch: head.visibilityEpoch, sequenceBase: head.sequenceBase } }, clock.next())
        const row = await tx.superTab.findUniqueOrThrow({ where: { id: head.tabId }, select: { revision: true } })
        const updated = await tx.superTab.updateMany({ where: { id: head.tabId, revision: row.revision },
          data: { revision: row.revision + 1, invitedEmails: kept.map(i => i.email) } })
        if (!updated.count) throw new PartConflict('head', 'index')
      })
      expired += data.invitations.length - kept.length
    } catch (error) { if (!(error instanceof PartConflict)) throw error }
  }
  return expired
}

/** One pass of every sweep (spec, Archive). Each part it changes is a guarded write, so a command in between wins. */
export async function sweepSwarms(db: PrismaClient, now = Date.now()) {
  return { slept: await sleepQuietGroups(db, now), startsExpired: await expireStarts(db, now), invitationsExpired: await expireInvitations(db, now),
    tombstonesCompacted: await compactTombstones(db, now) }
}

/** Runs the sweeps every hour in the singleton worker. `finishWorkspaceRemovals` finishes Workspace removals whose Swarm removals
 *  did not all run (workspaceStore.ts SwarmWorkspaces.finishRemovals); it needs the store, so the worker passes it in. */
export function startSwarmSweeps(db: PrismaClient, everyMs = 3_600_000, finishWorkspaceRemovals?: () => Promise<number>): () => void {
  // The worker names indexes as servers do: listed before each pass, so a pass after the schema push names them.
  const run = () => void listNamedIndexes(db).catch(error => logger.warn('[swarm-sweeps] listing indexes failed', { error: error instanceof Error ? error.message : String(error) }))
    .then(() => sweepSwarms(db)).then(async result => ({ ...result, workspaceRemovalsPending: await finishWorkspaceRemovals?.() }))
    .then(result => logger.info('[swarm-sweeps] done', result))
    .catch(error => logger.warn('[swarm-sweeps] failed', { error: error instanceof Error ? error.message : String(error) }))
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}

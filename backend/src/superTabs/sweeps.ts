import type { PrismaClient } from '@prisma/client'
import type { AgentStart, Conversation } from './model.js'
import { clock, guardedWrite, PartConflict, type HeadData } from './parts/index.js'
import { DORMANT_AFTER_MS, RETENTION_MS } from './parts/types.js'
import { logger } from '../utils/logger.js'

/** Each part collection keeps a tombstone until its `purgeAt` (design section 2.1). Run by the singleton worker at
 *  startup, like the terminal and mention expiry indexes. */
export async function ensurePartExpiry(db: PrismaClient): Promise<void> {
  for (const collection of ['SwarmHead', 'SwarmMember', 'SwarmGroup', 'SwarmAgent', 'SwarmMachine', 'SwarmStart', 'SwarmProgress']) {
    await db.$runCommandRaw({ createIndexes: collection, indexes: [{ key: { purgeAt: 1 }, name: 'part_purge', expireAfterSeconds: 0 }] })
  }
}

const BATCH = 500

/** One guarded write in its own transaction. A part that changed since it was read is left for the next sweep. */
async function guarded(db: PrismaClient, write: Parameters<typeof guardedWrite>[2] & { tabId: string }): Promise<boolean> {
  try {
    await db.$transaction(tx => guardedWrite(tx, write.tabId, write, clock.next()))
    return true
  } catch (error) {
    if (error instanceof PartConflict) return false
    throw error
  }
}

/** A conversation whose work is done or cancelled and that has had no message for a day leaves the active set (spec,
 *  Archive). A project's Lead conversation and the Leads conversation never do; a message wakes any of them. */
async function sleepQuietGroups(db: PrismaClient, now: number): Promise<number> {
  const rows = await db.swarmGroup.findMany({ where: { deleted: false, dormant: false, kind: null, lastActivityAt: { lt: new Date(now - DORMANT_AFTER_MS) } },
    take: BATCH })
  const leads = new Map<string, Set<string>>()
  let slept = 0
  for (const row of rows) {
    const group = row.data as unknown as Conversation
    if (!['done', 'cancelled'].includes(group.assignment?.status ?? '')) continue
    if (!leads.has(row.tabId)) {
      const head = await db.swarmHead.findUnique({ where: { id: `${row.tabId}:head` } })
      const projects = (head?.data as unknown as HeadData | undefined)?.projects
      leads.set(row.tabId, new Set(projects ? projects.map(p => p.leadConversationId) : ['lead']))
    }
    if (leads.get(row.tabId)!.has(group.id)) continue
    if (await guarded(db, { tabId: row.tabId, op: 'update', kind: 'group', key: row.key, seen: row.version, data: { ...group, dormant: true } })) slept++
  }
  return slept
}

/** Finished starts are kept 7 days, then removed (spec, Archive); their tombstones go 7 days later (purge index). */
async function expireStarts(db: PrismaClient, now: number): Promise<number> {
  const rows = await db.swarmStart.findMany({ where: { deleted: false, finishedAt: { lt: new Date(now - RETENTION_MS) } }, take: BATCH })
  let expired = 0
  for (const row of rows) {
    if (await guarded(db, { tabId: row.tabId, op: 'remove', kind: 'start', key: row.key, seen: row.version, data: row.data as unknown as AgentStart })) expired++
  }
  return expired
}

/** Expired invitations leave the head and the index the invited person's list is read from (spec, Archive). */
async function expireInvitations(db: PrismaClient, now: number): Promise<number> {
  const heads = await db.swarmHead.findMany({ where: { deleted: false } })
  let expired = 0
  for (const head of heads) {
    const data = head.data as unknown as HeadData
    const kept = data.invitations.filter(i => i.expiresAt > now)
    if (kept.length === data.invitations.length) continue
    try {
      await db.$transaction(async tx => {
        await guardedWrite(tx, head.tabId, { op: 'update', kind: 'head', key: 'head', seen: head.version, data: { ...data, invitations: kept },
          head: { groupCounter: head.groupCounter, visibilityEpoch: head.visibilityEpoch, sequenceBase: head.sequenceBase } }, clock.next())
        const row = await tx.superTab.findUniqueOrThrow({ where: { id: head.tabId } })
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
  return { slept: await sleepQuietGroups(db, now), startsExpired: await expireStarts(db, now), invitationsExpired: await expireInvitations(db, now) }
}

/** Runs the sweeps every hour in the singleton worker. */
export function startSwarmSweeps(db: PrismaClient, everyMs = 3_600_000): () => void {
  const run = () => void sweepSwarms(db).then(result => logger.info('[swarm-sweeps] done', result))
    .catch(error => logger.warn('[swarm-sweeps] failed', { error: error instanceof Error ? error.message : String(error) }))
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}

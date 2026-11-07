import type { PrismaClient } from '@prisma/client'
import { tasksNamedIn } from '../commands.js'
import type { SuperTabStore } from '../store.js'
import { logger } from '../../utils/logger.js'

const BATCH = 500
const NUMBER = [{ $set: { number: { $ifNull: ['$data.number', null] } } }]
/** A task still in people's Tasks that was closed before #4480 linked closes: cancelled, or archived with nobody assigned. */
const CLOSED_LISTED = { deleted: false, 'feedIds.0': { $exists: true }, 'data.foldedInto': { $exists: false },
  $or: [{ 'data.assignment.status': 'cancelled' }, { archived: true, 'data.assignment': null }] }
const CANCELLED = ' cancelled this task: '

type Row = { _id: string; tabId: string; key: string; data?: { number?: number; assignment?: { result?: string | null } | null } }

/** The reason of a task nobody was assigned: only its newest cancel line keeps it (commands.ts work.cancel). */
async function cancelLine(db: PrismaClient, tabId: string, conversationId: string): Promise<string | null> {
  const [line] = await db.superTabMessage.aggregateRaw({ pipeline: [{ $match: { tabId, conversationId, 'source.status': 'cancelled' } },
    { $sort: { sequence: -1 } }, { $limit: 1 }, { $project: { _id: 0, text: 1 } }] }) as unknown as Array<{ text?: string }>
  const at = line?.text?.indexOf(CANCELLED) ?? -1
  return at < 0 ? null : line!.text!.slice(at + CANCELLED.length)
}

/**
 * Run once by the worker at startup, after markFeedIds: sets the `number` column (schema.prisma) on every part written before
 * it, and links each task closed before then whose reason names the task its work goes on in, as a cancel does now (task
 * #4480): it leaves people's Tasks, with a line saying where its work goes on (store.ts linkFolded). Every other row takes its
 * number first, so a candidate's real task is found; each candidate takes it once read, so a second start reads none. Remove
 * it, and its call in worker.ts, after 2026-12-07: every row then carries the column (its unindexed match reads the whole
 * collection on each start). Returns how many it linked; a link that fails is logged and left for the PM's re-cancel.
 */
export async function linkOlderDuplicates(db: PrismaClient, store: Pick<SuperTabStore, 'linkFolded'>): Promise<number> {
  await db.$runCommandRaw({ update: 'SwarmGroup', updates: [{ q: { number: { $exists: false }, $nor: [CLOSED_LISTED] }, u: NUMBER, multi: true }] })
  let linked = 0
  for (;;) {
    const rows = await db.swarmGroup.aggregateRaw({ pipeline: [{ $match: { number: { $exists: false } } }, { $limit: BATCH },
      { $project: { tabId: 1, key: 1, 'data.number': 1, 'data.assignment.result': 1 } }] }) as unknown as Row[]
    for (const row of rows) {
      const reason = row.data?.assignment ? row.data.assignment.result ?? null : await cancelLine(db, row.tabId, row.key)
      if (!reason || !tasksNamedIn(reason, row.data?.number).length) continue
      try {
        if (await store.linkFolded(row.tabId, row.key, reason)) linked++
      } catch (error) {
        logger.error('[swarm] an older duplicate was not linked: it stays in people\'s Tasks until the PM cancels it again naming its real task',
          { tabId: row.tabId, group: row.key, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (rows.length) await db.$runCommandRaw({ update: 'SwarmGroup', updates: [{ q: { _id: { $in: rows.map(r => r._id) }, number: { $exists: false } }, u: NUMBER, multi: true }] })
    if (rows.length < BATCH) return linked
  }
}

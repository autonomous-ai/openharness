/**
 * Thread summaries for replies no transaction summed up (spec 5 phase D): every thread with a reply when a Swarm has none yet,
 * then, every 15 minutes, the threads with a reply created since an hour before the Swarm's marker. An older release
 * writes replies without summaries, during a rollback or while a release rolls out; they are counted here. A Swarm's pages
 * read its summaries only once its marker exists (pageReads.ts pageThreads).
 */
import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { messagesPast, noteBackfilled, refreshThreads, type MessageEdge } from './pageReads.js'
import { groupsBy } from './parts/indexed.js'
import { transaction } from './store.js'

/** How far before its marker a Swarm's replies are read again: a reply's time is its writer's clock. */
const SLACK_MS = 3_600_000
/** Threads refreshed per transaction. */
const BATCH = 100
/** Messages read per step back through a changed conversation. */
const TAIL = 200
/** How often the backfill runs: replies an older release writes go uncounted at most this long. */
const EVERY_MS = 15 * 60_000

/** Refreshes the summaries of every Swarm's threads with a reply since its marker less an hour (all of them without one), then
 *  moves the marker to `now`. A Swarm that fails keeps its marker, is logged and is done at the next run. */
export async function backfillThreads(db: PrismaClient, now: number): Promise<{ swarms: number; threads: number }> {
  const marks = new Map((await db.superTabThreadBackfill.findMany()).map(mark => [mark.id, mark.through.getTime()]))
  const swarms = await db.superTab.findMany({ select: { id: true, deletedAt: true } })
  let done = 0, threads = 0
  for (const { id: tabId, deletedAt } of swarms) {
    // A deleted Swarm keeps its summaries for its restore; its purge removes them and its marker (deletion.ts).
    if (deletedAt) continue
    try {
      threads += await backfillSwarm(db, tabId, marks.get(tabId), now)
      done++
    } catch (error) {
      logger.error('[swarm-threads] backfilling a Swarm failed; its pages keep their last summaries', error, { tabId })
    }
  }
  return { swarms: done, threads }
}

async function backfillSwarm(db: PrismaClient, tabId: string, through: number | undefined, now: number): Promise<number> {
  const replied = through === undefined ? await everyReply(db, tabId) : await repliesSince(db, tabId, through - SLACK_MS)
  let threads = 0
  for (const [conversationId, roots] of replied) {
    threads += roots.size
    const list = [...roots]
    for (let i = 0; i < list.length; i += BATCH) {
      await transaction(db, tx => refreshThreads(tx, tabId, conversationId, list.slice(i, i + BATCH)))
    }
  }
  await db.superTabThreadBackfill.upsert({ where: { id: tabId }, create: { id: tabId, through: new Date(now) }, update: { through: new Date(now) } })
  noteBackfilled(tabId)
  return threads
}

type Replied = Map<string, Set<string>>
const add = (replied: Replied, conversationId: string, thread: string) =>
  replied.set(conversationId, (replied.get(conversationId) ?? new Set()).add(thread))

/** Every thread of the Swarm with a reply, by conversation: its first backfill, which reads each of its messages once. */
async function everyReply(db: PrismaClient, tabId: string): Promise<Replied> {
  const rows = await db.superTabMessage.aggregateRaw({ pipeline: [
    { $match: { tabId, thread: { $type: 'string' } } },
    { $match: { $expr: { $ne: ['$thread', '$_id'] } } },
    { $group: { _id: { conversationId: '$conversationId', thread: '$thread' } } }] }) as unknown as Array<{ _id: { conversationId: string; thread: string } }>
  const replied: Replied = new Map()
  for (const { _id } of rows) add(replied, _id.conversationId, _id.thread)
  return replied
}

/** The threads with a reply created since `since`, by conversation. Only what changed is read: every message write moves its
 *  conversation's group (its last sequence), so the groups changed since then name the conversations (their changes index),
 *  and each is read newest first by its sequence index until its messages are older. History kept forever is never walked. */
async function repliesSince(db: PrismaClient, tabId: string, since: number): Promise<Replied> {
  const changed = await groupsBy(db, 'changes', [{ $match: { tabId, changedAt: { $gte: { $date: new Date(since).toISOString() } } } },
    { $project: { _id: 0, key: 1 } }])
  const replied: Replied = new Map()
  for (const { key } of changed) {
    const conversationId = key as string
    for (let edge: MessageEdge | undefined; ;) {
      const rows = await messagesPast(db, { tabId, conversationId }, edge, false, TAIL)
      for (const row of rows) if (row.createdAt.getTime() >= since && row.thread && row.thread !== row.id) add(replied, conversationId, row.thread)
      if (rows.length < TAIL || rows.at(-1)!.createdAt.getTime() < since) break
      edge = { sequence: rows.at(-1)!.sequence, id: rows.at(-1)!.id }
    }
  }
  return replied
}

/** Backfills now and then every `everyMs`, one run at a time, beside the worker's other jobs (pages read the $facet until a
 *  Swarm's marker exists, so nothing waits for it). Every run reads only what changed, so replies an older release wrote
 *  (a rollout, or a rollback of the API alone) are summed up within one interval. */
export function startThreadBackfill(db: PrismaClient, everyMs = EVERY_MS): () => void {
  let running = false
  const run = () => {
    if (running) return
    running = true
    const started = Date.now()
    void backfillThreads(db, started).then(({ swarms, threads }) => logger.info('[swarm-threads] backfilled', { swarms, threads, ms: Date.now() - started }))
      .catch(error => logger.error('[swarm-threads] backfill failed; it runs again at the next interval', error))
      .finally(() => { running = false })
  }
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}

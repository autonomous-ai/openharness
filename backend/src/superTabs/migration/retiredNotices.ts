/**
 * Removes the stored notices of kinds nothing writes any more (Swarm v4, slices S7 to S18: model.ts NOTICE_READERS keeps only the
 * kinds still written). A kind no longer listed there reads as one for people, so a notice once meant for its recipients alone, or
 * for its agent alone, would now show in its chat. The wipe took every Swarm from before v4 (wipeJob.ts); these are the ones v1-v3
 * code still wrote into the first v4 Swarms before it went.
 *
 * Runs in the singleton worker: it walks every message by the _id index, PAGE at a time, so each read examines what it returns and
 * no more, and removes the matches with their deliveries (by the [tabId, messageId] index) and their compacted receipts (by _id),
 * the message row last: a pass stopped part-way leaves the message, which the next walk finds again. Counts only in its log.
 * A worker that starts again walks from the start, and finds nothing left to remove. Goes, with its call in worker.ts, on or after
 * 2026-12-12 (30 days after the release that carries it).
 */
import type { PrismaClient } from '@prisma/client'
import { startChunkSweep } from '../../lib/chunkSweep.js'
import { logger } from '../../utils/logger.js'

/** Every notice kind NOTICE_READERS listed before S18 trimmed it to the kinds still written. */
export const RETIRED_NOTICE_KINDS = [
  'auto-archive', 'computer-moved', 'crew-nudge', 'crew-timing', 'decision-answered', 'decision-asked', 'decision-delegated',
  'decision-must-agree', 'digest-request', 'idle', 'idle-stop', 'machine-left', 'native', 'others-work-notice', 'overlap', 'pm-line',
  'pm-switch-notice', 'project-report', 'proposal-answer', 'proposal-card', 'proposal-merged', 'proposal-notice', 'proposal-overdue',
  'release', 'review-capacity', 'review-failed', 'route', 'route-override', 'routing-reflection', 'rule-approved', 'schedule-request',
  'ship', 'task-approval', 'task-line', 'terminal-alert', 'terminal-input', 'tidy-request', 'update-request', 'work-resumed',
  'work-stalled',
] as const

/** Messages read by one find: their ids, Swarm and kind only. */
export const PAGE = 500
/** Pages one pass walks before it lets the worker breathe: 100,000 messages. */
export const PAGES_PER_PASS = 200
export const EVERY_MS = 10 * 60_000

/** Counts only: no id, Swarm or text. */
export interface NoticePass { examined: number; removed: number; deliveries: number; receipts: number; done: boolean }
export interface NoticeOptions { pages?: number; pause?: () => Promise<void>; signal?: AbortSignal }

type Commands = Pick<PrismaClient, '$runCommandRaw'>
type Row = { _id: string; tabId?: string; source?: { kind?: unknown } | null }
const retired = new Set<string>(RETIRED_NOTICE_KINDS)
const isRetired = (row: Row) => typeof row.source?.kind === 'string' && retired.has(row.source.kind)

async function removed(db: Commands, command: Record<string, unknown>): Promise<number> {
  const answer = await db.$runCommandRaw(command as never) as { n?: number; writeErrors?: unknown[] }
  if (answer.writeErrors?.length) throw new Error(`The database refused some removals from ${String(command.delete)}`)
  return answer.n ?? 0
}

/** Walks on from [cursor.after] for up to [pages] pages, removing each retired notice; moves the cursor. Done once a page comes back
 *  short: every message after the walk's start was read. */
export async function removeRetiredNotices(db: Commands, cursor: { after: string }, { pages = PAGES_PER_PASS, pause, signal }: NoticeOptions = {}): Promise<NoticePass> {
  const pass: NoticePass = { examined: 0, removed: 0, deliveries: 0, receipts: 0, done: false }
  for (let page = 0; page < pages && !signal?.aborted; page++) {
    const found = await db.$runCommandRaw({ find: 'SuperTabMessage', filter: { _id: { $gt: cursor.after } }, sort: { _id: 1 }, hint: '_id_',
      projection: { _id: 1, tabId: 1, 'source.kind': 1 }, limit: PAGE, batchSize: PAGE, singleBatch: true } as never) as { cursor: { firstBatch: Row[] } }
    const rows = found.cursor.firstBatch
    pass.examined += rows.length
    const matches = rows.filter(isRetired)
    const byTab = new Map<string, string[]>()
    for (const row of matches) byTab.set(row.tabId ?? '', [...byTab.get(row.tabId ?? '') ?? [], row._id])
    for (const [tabId, ids] of byTab) {
      pass.deliveries += await removed(db, { delete: 'SuperTabDelivery', deletes: [{ q: { tabId, messageId: { $in: ids } }, limit: 0, hint: { tabId: 1, messageId: 1 } }] })
    }
    if (matches.length) {
      const ids = matches.map(row => row._id)
      pass.receipts += await removed(db, { delete: 'SuperTabReceipt', deletes: [{ q: { _id: { $in: ids } }, limit: 0, hint: { _id: 1 } }] })
      // Last, and only while still of a retired kind.
      pass.removed += await removed(db, { delete: 'SuperTabMessage', deletes: [{ q: { _id: { $in: ids }, 'source.kind': { $in: [...RETIRED_NOTICE_KINDS] } }, limit: 0, hint: { _id: 1 } }] })
    }
    if (rows.length) cursor.after = rows.at(-1)!._id
    if (rows.length < PAGE) { pass.done = true; break }
    await pause?.()
  }
  return pass
}

/** Starts the walk in the worker: a pass every EVERY_MS until one reaches the last message; the returned function stops it. */
export function startRetiredNoticeRemoval(db: PrismaClient): () => void {
  const cursor = { after: '' }
  return startChunkSweep({ label: '[retired-notices]', everyMs: EVERY_MS, log: logger, pass: async () => {
    const pass = await removeRetiredNotices(db, cursor)
    if (pass.removed || pass.deliveries || pass.receipts) logger.info('[retired-notices] removed', { ...pass })
    return { removed: pass.removed, done: pass.done }
  } })
}

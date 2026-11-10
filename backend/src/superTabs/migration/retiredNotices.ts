/**
 * Removes the stored notices of kinds nothing writes any more (Swarm v4, slices S7 to S18: model.ts NOTICE_READERS keeps only the
 * kinds still written). A kind no longer listed there reads as one for people, so a notice once meant for its recipients alone, or
 * for its agent alone, would now show in its chat. The wipe took every Swarm from before v4 (wipeJob.ts); these are the ones v1-v3
 * code still wrote into the first v4 Swarms before it went.
 *
 * Runs in the singleton worker. It walks every message by the _id index, PAGE at a time with a pause between pages, so each read
 * examines what it returns and no more, and removes each match through the store's own delete (store.ts removeRetiredNotice), as its
 * author's `message.delete` would: deliveries cancelled, threads and the chat's counters kept right. Where it has walked to is kept
 * in SuperTabSweepCursor (id `retired-notices`), so a worker that starts again carries on, and one that finished does not walk
 * again. Counts only in its log. Goes, with its call in worker.ts, on or after 2026-12-12 (30 days after the release that carries it).
 */
import type { PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import { SuperTabError } from '../model.js'
import type { SuperTabStore } from '../store.js'
import { sleeper } from './dropLegacyJob.js'

/** Every notice kind NOTICE_READERS listed before S18 trimmed it to the kinds still written. */
export const RETIRED_NOTICE_KINDS = [
  'auto-archive', 'computer-moved', 'crew-nudge', 'crew-timing', 'decision-answered', 'decision-asked', 'decision-delegated',
  'decision-must-agree', 'digest-request', 'idle', 'idle-stop', 'machine-left', 'native', 'others-work-notice', 'overlap', 'pm-line',
  'pm-switch-notice', 'project-report', 'proposal-answer', 'proposal-card', 'proposal-merged', 'proposal-notice', 'proposal-overdue',
  'release', 'review-capacity', 'review-failed', 'route', 'route-override', 'routing-reflection', 'rule-approved', 'schedule-request',
  'ship', 'task-approval', 'task-line', 'terminal-alert', 'terminal-input', 'tidy-request', 'update-request', 'work-resumed',
  'work-stalled',
] as const
const retired = new Set<string>(RETIRED_NOTICE_KINDS)
/** Whether a message's stored source is a notice of a retired kind. */
export const isRetiredNotice = (source: unknown): boolean => {
  const kind = (source as { kind?: unknown } | null | undefined)?.kind
  return typeof kind === 'string' && retired.has(kind)
}

/** Messages read by one find: their ids, chat and kind only. */
export const PAGE = 500
/** Pages one pass walks: 100,000 messages. */
export const PAGES_PER_PASS = 200
export const PAUSE_MS = 500
export const EVERY_MS = 10 * 60_000
export const CURSOR_ID = 'retired-notices'
/** The cursor of a walk that reached the last message. */
export const WALKED = '￿'

/** Counts only: no id, Swarm or text. `codes`: refusals by code; such a notice stays. */
export interface NoticePass { examined: number; removed: number; gone: number; failed: number; codes: Record<string, number>; done: boolean }
export interface NoticeOptions { pages?: number; pause?: () => Promise<void>; signal?: AbortSignal }

type Db = Pick<PrismaClient, '$runCommandRaw' | 'superTabSweepCursor'>
type Row = { _id: string; tabId?: string; conversationId?: string; source?: { kind?: unknown } | null }

/** Walks on from the stored cursor for up to [pages] pages, removing each retired notice through [store]; stores the cursor after
 *  each page. Done once a page comes back short: every message was read. A notice the store refuses is counted by its code and
 *  left; the walk goes on. */
export async function removeRetiredNotices(db: Db, store: Pick<SuperTabStore, 'removeRetiredNotice'>,
  { pages = PAGES_PER_PASS, pause, signal }: NoticeOptions = {}): Promise<NoticePass> {
  const pass: NoticePass = { examined: 0, removed: 0, gone: 0, failed: 0, codes: {}, done: false }
  let after = (await db.superTabSweepCursor.findUnique({ where: { id: CURSOR_ID }, select: { after: true } }))?.after ?? ''
  if (after === WALKED) return { ...pass, done: true }
  for (let page = 0; page < pages && !signal?.aborted; page++) {
    if (page) await pause?.()
    const found = await db.$runCommandRaw({ find: 'SuperTabMessage', filter: { _id: { $gt: after } }, sort: { _id: 1 }, hint: '_id_',
      projection: { _id: 1, tabId: 1, conversationId: 1, 'source.kind': 1 }, limit: PAGE, batchSize: PAGE, singleBatch: true } as never) as
      { cursor: { firstBatch: Row[] } }
    const rows = found.cursor.firstBatch
    pass.examined += rows.length
    for (const row of rows.filter(r => isRetiredNotice(r.source))) {
      try {
        if (await store.removeRetiredNotice(String(row.tabId), String(row.conversationId), row._id) === 'removed') pass.removed++
        else pass.gone++
      } catch (error) {
        pass.failed++
        const code = error instanceof SuperTabError ? error.code : error instanceof Error ? error.name : 'unknown'
        pass.codes[code] = (pass.codes[code] ?? 0) + 1
      }
    }
    const done = rows.length < PAGE
    if (rows.length || done) {
      after = done ? WALKED : rows.at(-1)!._id
      const updatedAt = new Date()
      await db.superTabSweepCursor.upsert({ where: { id: CURSOR_ID }, create: { id: CURSOR_ID, after, updatedAt }, update: { after, updatedAt } })
    }
    if (done) { pass.done = true; break }
  }
  return pass
}

/** Starts the walk in the worker: a pass now and every EVERY_MS until one reaches the last message. The returned function stops
 *  it, a pass in flight too, at its next page. */
export function startRetiredNoticeRemoval(db: PrismaClient, store: Pick<SuperTabStore, 'removeRetiredNotice'>): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void (async () => {
    while (!control.signal.aborted) {
      try {
        const pass = await removeRetiredNotices(db, store, { pause: () => wait(PAUSE_MS), signal: control.signal })
        if (pass.failed) logger.error('[retired-notices] some notices of retired kinds could not be removed; the walk goes on', { ...pass })
        else if (pass.removed || pass.gone) logger.info('[retired-notices] pass', { ...pass })
        if (pass.done) { logger.info('[retired-notices] done', { ...pass }); return }
      } catch (error) {
        logger.error('[retired-notices] pass failed; trying again', { error: error instanceof Error ? error.name : 'unknown', retryInMs: EVERY_MS })
      }
      await wait(EVERY_MS)
    }
  })()
  return () => control.abort()
}

import { stat } from 'node:fs/promises'
import type { SessionEvent } from './events.js'
import type { HistoryPage } from '../../lib/transcriptPages.js'
import type { HistoryAsk, HistoryAnswer, TranscriptSession } from '../facets/transcript.js'

/** Bounded paging is shared machinery; each engine supplies its pager and replay rules, and what it adds to the
 *  replayed events from files beside the transcript (Claude Code's background agents' totals). */
export async function pagedHistory(session: TranscriptSession, { limit, before }: HistoryAsk,
  page: (path: string, options: HistoryAsk) => Promise<HistoryPage>, replay: (lines: string[]) => SessionEvent[],
  enrich?: (events: SessionEvent[], transcriptPath: string) => Promise<void>): Promise<HistoryAnswer> {
  if (!session.transcriptPath) return { events: [], timestamp: new Date(session.touchedAt).toISOString(), hasMore: false, oldestCursor: null }
  const found = await page(session.transcriptPath, limit ? { limit, before } : {})
  const st = await stat(session.transcriptPath).catch(() => null)
  const timestamp = new Date(st?.mtimeMs ?? Date.now()).toISOString()
  if (found.staleCursor) return { events: [], timestamp, hasMore: false, oldestCursor: null, staleCursor: true }
  const events = replay(found.lines)
  await enrich?.(events, session.transcriptPath)
  if (limit && before && events[events.length - 1]?.type === 'done') events.pop()
  return { events, timestamp, ...(limit || found.hasMore ? { hasMore: found.hasMore, oldestCursor: found.oldestCursor } : {}) }
}

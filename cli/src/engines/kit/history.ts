import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SubagentStats, type SessionEvent } from '../../lib/normalize.js'
import { streamRecords } from '../../lib/transcriptTail.js'
import type { HistoryPage } from '../../lib/transcriptPages.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { HistoryAsk, HistoryAnswer } from '../facets/transcript.js'

/** Fill in missing sub-agent aggregates on tool_end events by reading the sub-agent's own transcript
 *  (`<session>/subagents/agent-<id>.jsonl`). Async/background launchers only record
 *  `{status:'async_launched', agentId}` in the main transcript — without this join the delegation
 *  card shows "0 tools · worked for 0s" forever. Best-effort per agent; missing files are skipped. */
export async function enrichSubagentStats(events: SessionEvent[], transcriptPath: string): Promise<void> {
  const subagentsDir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
  for (const e of events) {
    if (e.type !== 'tool_end') continue
    const sub = e.payload.subagent
    if (!sub?.agentId || typeof sub.totalToolUseCount === 'number') continue
    try {
      // A line at a time: a long sub-agent's transcript is never held whole to count its calls.
      const file = join(subagentsDir, `agent-${sub.agentId}.jsonl`)
      const totals = new SubagentStats()
      await streamRecords(file, 0, (await stat(file)).size, (line) => { totals.push(line) }, () => true)
      const stats = totals.result()
      sub.totalToolUseCount = stats.totalToolUseCount
      if (sub.totalDurationMs === undefined) sub.totalDurationMs = stats.totalDurationMs
      if (sub.totalTokens === undefined) sub.totalTokens = stats.totalTokens
    } catch { /* subagent transcript absent (still spawning / pruned) — leave as-is */ }
  }
}

/** Bounded paging is shared machinery; each engine supplies its pager and replay rules. */
export async function pagedHistory(session: RegisteredSession, { limit, before }: HistoryAsk,
  page: (path: string, options: HistoryAsk) => Promise<HistoryPage>, replay: (lines: string[]) => SessionEvent[]): Promise<HistoryAnswer> {
  if (!session.transcriptPath) return { events: [], timestamp: new Date(session.touchedAt).toISOString(), hasMore: false, oldestCursor: null }
  const found = await page(session.transcriptPath, limit ? { limit, before } : {})
  const st = await stat(session.transcriptPath).catch(() => null)
  const timestamp = new Date(st?.mtimeMs ?? Date.now()).toISOString()
  if (found.staleCursor) return { events: [], timestamp, hasMore: false, oldestCursor: null, staleCursor: true }
  const events = replay(found.lines)
  await enrichSubagentStats(events, session.transcriptPath)
  if (limit && before && events[events.length - 1]?.type === 'done') events.pop()
  return { events, timestamp, ...(limit || found.hasMore ? { hasMore: found.hasMore, oldestCursor: found.oldestCursor } : {}) }
}

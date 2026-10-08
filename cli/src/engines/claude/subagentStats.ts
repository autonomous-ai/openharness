/**
 * Claude Code's background agents' totals, joined into its history. Moved from engines/kit/history.ts: the
 * layout (`<session>/subagents/agent-<id>.jsonl`) and the counting (`SubagentStats`) are Claude Code's, and only
 * its reader runs it (engines/claude/transcript.ts), in its worker or the inline compatibility path, never core.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionEvent } from '../kit/events.js'
import { streamRecords } from '../../lib/transcriptTail.js'
import { SubagentStats } from './normalize.js'

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

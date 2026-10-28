/**
 * Lent: agent-hours Swarm agents on a person's contributed machine spent working on other people's tasks, added up from that
 * machine's readings and kept on its contribution by week (docs/swarms.md, Leaderboard). An idle or waiting agent lends
 * nothing, nor one on the contributor's own request (Dee, 2026-10-28). Agents of private chats never count, nor Leads: a
 * Lead's session is confidential coordination, not lent build work (Lead's ruling on the review of #1762).
 */
import { MACHINE_FRESH_MS, type ContributedMachine } from '../machines.js'
import type { SuperTabState } from '../model.js'
import { ledProject } from '../projects.js'
import { LEDGER_WEEKS } from './record.js'
import { WEEK_MS, weekStart } from './week.js'

/** `busyMs`: agent time spent on other people's tasks, the only time Lent counts (Dee, 2026-10-28). `agentMs`: online agent
 *  time, recorded before then and no longer counted or written. */
export interface LentWeek { week: number; agentMs?: number; busyMs?: number }

/** Credits the time since the machine's previous reading, at most one fresh reading's worth, to each Swarm agent that
 *  reading showed running and that is working on a task someone else asked for: one nobody named counts as someone else's.
 *  Call it before the new reading replaces the previous one. */
export function accrueLent(state: SuperTabState, pool: ContributedMachine, now: number): void {
  const previous = pool.observation
  if (!previous) return
  const elapsed = Math.min(Math.max(0, now - previous.receivedAt), MACHINE_FRESH_MS)
  const running = new Set(previous.runningHarnessIds)
  const privateChats = state.conversations.filter(c => c.audience)
  const busy = new Set(state.conversations.filter(c => !c.audience && c.assignment?.status === 'working' && c.requesterId !== pool.contributorId)
    .map(c => c.assignment!.agentId))
  const counted = state.agents.filter(a => a.machineId === pool.machineId && running.has(a.harnessId) && busy.has(a.id)
    && !ledProject(state, a.id) && !privateChats.some(c => c.agentIds.includes(a.id)))
  if (!elapsed || !counted.length) return
  const week = weekStart(now)
  const kept = (pool.lent ?? []).filter(l => l.week > week - LEDGER_WEEKS * WEEK_MS)
  const current = kept.find(l => l.week === week) ?? kept[kept.push({ week }) - 1]!
  current.busyMs = (current.busyMs ?? 0) + elapsed * counted.length
  pool.lent = kept
}

/**
 * Lent: agent-hours Swarm agents ran on a person's contributed machine, added up from that machine's readings and kept on
 * its contribution by week (docs/swarms.md, Leaderboard). Agents of private chats never count.
 */
import { MACHINE_FRESH_MS, type ContributedMachine } from '../machines.js'
import type { SuperTabState } from '../model.js'
import { ledProject } from '../projects.js'
import { LEDGER_WEEKS } from './record.js'
import { WEEK_MS, weekStart } from './week.js'

export interface LentWeek { week: number; agentMs: number }

/** Credits the time since the machine's previous reading, at most one fresh reading's worth, to each Swarm agent that
 *  reading showed running. Call it before the new reading replaces the previous one. */
export function accrueLent(state: SuperTabState, pool: ContributedMachine, now: number): void {
  const previous = pool.observation
  if (!previous) return
  const elapsed = Math.min(Math.max(0, now - previous.receivedAt), MACHINE_FRESH_MS)
  const running = new Set(previous.runningHarnessIds)
  const privateChats = state.conversations.filter(c => c.audience)
  const counted = state.agents.filter(a => a.machineId === pool.machineId && running.has(a.harnessId)
    && (!!ledProject(state, a.id) || !privateChats.some(c => c.agentIds.includes(a.id))))
  if (!elapsed || !counted.length) return
  const week = weekStart(now)
  const kept = (pool.lent ?? []).filter(l => l.week > week - LEDGER_WEEKS * WEEK_MS)
  const current = kept.find(l => l.week === week) ?? kept[kept.push({ week, agentMs: 0 }) - 1]!
  current.agentMs += elapsed * counted.length
  pool.lent = kept
}

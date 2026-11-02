/**
 * Lent: agent-hours Swarm agents on a person's contributed machine spent working on other people's tasks, added up from that
 * machine's readings and kept on its contribution by week (docs/swarms.md, Leaderboard). An idle or waiting agent lends
 * nothing, nor one on the contributor's own request (Dee, 2026-10-28). Agents of private chats never count, nor Leads: a
 * Lead's session is confidential coordination, not lent build work (Lead's ruling on the review of #1762).
 */
import { MACHINE_FRESH_MS, type ContributedMachine } from '../machines.js'
import type { Conversation, SuperTabState } from '../model.js'
import { ledProject } from '../projects.js'
import { LEDGER_WEEKS } from './record.js'
import { DAY_MS, WEEK_MS, weekStart } from './week.js'

/** `busyMs`: agent time spent on other people's tasks, the only time Lent counts (Dee, 2026-10-28). `agentMs`: online agent
 *  time, recorded before then and no longer counted or written. */
export interface LentWeek { week: number; agentMs?: number; busyMs?: number }
/** The same busy time by UTC day and the project of the task it went to, for the rolling periods (rolling.ts): a project a
 *  reader may not read adds nothing to what they see (review of #2499). */
export interface LentDay { day: number; projectId: string; busyMs: number }

/** Credits the time since the machine's previous reading, at most one fresh reading's worth, to each Swarm agent that
 *  reading showed running and that is working on a task someone else asked for: one nobody named counts as someone else's.
 *  Call it before the new reading replaces the previous one. */
export function accrueLent(state: SuperTabState, pool: ContributedMachine, now: number): void {
  const running = pool.observation?.runningHarnessIds ?? []
  addLent(pool, now, lentAgents(state, pool, running), lentProjects(state, pool, running))
}

/** How many of the machine's agents among the [running] sessions Lent counts: each working on a task someone else asked
 *  for, never a Lead's or a private chat's. A reading-only report adds time for the count its last full report recorded. */
export function lentAgents(state: SuperTabState, pool: ContributedMachine, running: readonly string[]): number {
  return lentTasks(state, pool, running).length
}

/** The same agents by the project of the task each works on. */
export function lentProjects(state: SuperTabState, pool: ContributedMachine, running: readonly string[]): Record<string, number> {
  const projects: Record<string, number> = {}
  for (const task of lentTasks(state, pool, running)) projects[task.projectId ?? 'lead'] = (projects[task.projectId ?? 'lead'] ?? 0) + 1
  return projects
}

function lentTasks(state: SuperTabState, pool: ContributedMachine, running: readonly string[]): Conversation[] {
  const sessions = new Set(running)
  const privateChats = state.conversations.filter(c => c.audience)
  const busy = new Map(state.conversations.filter(c => !c.audience && c.assignment?.status === 'working' && c.requesterId !== pool.contributorId)
    .map(c => [c.assignment!.agentId, c]))
  return state.agents.filter(a => a.machineId === pool.machineId && sessions.has(a.harnessId) && busy.has(a.id)
    && !ledProject(state, a.id) && !privateChats.some(c => c.agentIds.includes(a.id))).map(a => busy.get(a.id)!)
}

/** Credits [count] agents with the time since the machine's previous reading, at most one fresh reading's worth, in the
 *  current week. Call it before the new reading replaces the previous one. */
export function addLent(pool: ContributedMachine, now: number, count: number, projects: Record<string, number> = {}): void {
  const previous = pool.observation
  if (!previous) return
  const elapsed = Math.min(Math.max(0, now - previous.receivedAt), MACHINE_FRESH_MS)
  if (!elapsed || !count) return
  const week = weekStart(now)
  const kept = (pool.lent ?? []).filter(l => l.week > week - LEDGER_WEEKS * WEEK_MS)
  const current = kept.find(l => l.week === week) ?? kept[kept.push({ week }) - 1]!
  current.busyMs = (current.busyMs ?? 0) + elapsed * count
  pool.lent = kept
  // One row per day and project, for LEDGER_WEEKS: they cover every kept week and Last 30d, and go as they age. Time with no
  // project named (a reading recorded by an older server) stays in the week's row alone.
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const days = (pool.lentDays ?? []).filter(d => now - d.day < LEDGER_WEEKS * WEEK_MS)
  for (const [projectId, agents] of Object.entries(projects)) {
    const day = days.find(d => d.day === today && d.projectId === projectId) ?? days[days.push({ day: today, projectId, busyMs: 0 }) - 1]!
    day.busyMs += elapsed * agents
  }
  pool.lentDays = days
}

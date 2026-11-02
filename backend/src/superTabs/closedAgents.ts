import { isBuddy } from './buddies.js'
import { MACHINE_FRESH_MS, type MachineObservation } from './machines.js'
import { activeWork, type Agent, type SuperTabState } from './model.js'
import { agentProjectId, isConfidential, ledProject, onTeamAccount } from './projects.js'

// Huy, 2026-11-02: four agents closed on their machine sat under Idle for hours, each in the machine's stopped list, because
// only an agent's own host removed it, and only after a stop was asked for. A session closed by hand never asked. Now the
// report that shows a session gone removes its agent (docs/plans/2026-11-02-closed-agents-leave-list-plan.md).

/** How long an agent not listed running stays before its machine, still reporting, removes it without a stopped list. */
export const DOWN_REMOVE_MS = 15 * 60_000
/** How long an agent whose session is listed stopped stays first: a host mid-restart, or an agent changing its session, lists
 *  one stopped for a moment before it is back (security reviews of #2569). */
export const STOPPED_REMOVE_MS = 30_000

/** Whether [target] could ever leave this way: not a coordinator, a Buddy, one kept or being stopped. */
const removable = (state: SuperTabState, target: Agent): boolean =>
  !isBuddy(target) && target.workDecision !== 'keep' && target.workDecision !== 'stop' && !ledProject(state, target.id)

/**
 * The agents of [machineId] that [report], arriving now over the reading in [state], shows closed: not listed running, down
 * for a while, and either proved stopped (the proof the slot count accepts, machines.ts machineSlots; STOPPED_REMOVE_MS) or
 * not listed for DOWN_REMOVE_MS while the machine's other sessions still run. The last reading must be fresh and not list
 * them running either, so one report after a silence never removes anyone, and a report whose running list is empty never
 * removes by time (a fault in the host's listing would empty a whole machine). Never a coordinator (a project's end is the
 * only removal that takes one), a Buddy (its owner stops it), an agent someone chose to keep: it stays, shown as closed, or
 * one being stopped: its host closes it and takes it out (commands.ts agent.remove). Whether a task is still held is judged by
 * removeClosedAgents, after the loss of tasks.
 */
export function closedAgents(state: SuperTabState, machineId: string, report: Pick<MachineObservation, 'runningHarnessIds' | 'stoppedHarnessIds' | 'stoppedReservations'>, now: number): Agent[] {
  const previous = state.machines?.find(m => m.machineId === machineId)?.observation
  const fresh = previous && now - previous.receivedAt <= MACHINE_FRESH_MS ? previous : undefined
  if (!fresh) return []
  return state.agents.filter(target => {
    if (target.machineId !== machineId || report.runningHarnessIds.includes(target.harnessId) || fresh.runningHarnessIds.includes(target.harnessId)) return false
    if (!removable(state, target)) return false
    if (!target.downSince) return false
    const down = now - Date.parse(target.downSince)
    if (report.stoppedHarnessIds.includes(target.harnessId)) {
      const reservation = state.harnessReservations?.find(r => r.machineId === machineId && r.harnessId === target.harnessId)
      // Older hosts can prove a first launch stopped, but cannot tell a resumed runtime from its predecessor.
      return down >= STOPPED_REMOVE_MS
        && (!reservation || !reservation.renewed || !!report.stoppedReservations?.some(r => r.harnessId === target.harnessId && r.generation === reservation.generation))
    }
    return down >= DOWN_REMOVE_MS && report.runningHarnessIds.length > 0 && fresh.runningHarnessIds.length > 0
  })
}

/** The record that its host closes the session of a removed agent: a confidential session in a Team account keeps the account
 *  for its project until the host confirms the close, which it does once the session's data there is deleted (security re-check
 *  2 of #2089). The close also frees the session's slot (commands.ts agent.sessionClosed). Written before the agent leaves its
 *  groups, which decide whether the session is confidential. */
export function recordClosing(state: SuperTabState, target: Agent, now: number): void {
  if (state.closingSessions?.some(c => c.agentId === target.id && c.harnessId === target.harnessId)) return
  const held = onTeamAccount(state, target) && isConfidential(state, target) ? { heldFor: agentProjectId(state, target), since: now } : {}
  // Its machine part outlives the Buddy-only record while this closes: it stays as private as the record (read/changes.ts).
  const hidden = state.machines?.some(m => m.machineId === target.machineId && m.buddyOnly) ? { buddyOnly: true as const } : {}
  ;(state.closingSessions ??= []).push({ agentId: target.id, machineId: target.machineId, harnessId: target.harnessId, machineOwnerId: target.machineOwnerId, ...held, ...hidden })
}

/** Removes those of [closed] that hold no task now: from the agents and from every group's members and leads, as commands.ts
 *  removeAgent does, with the close order its host needs. A task just lost keeps its agent until its Lead hands it on or
 *  cancels it (it is still fenced and told by name, liveness.ts); the next report removes the agent then. The removed agents,
 *  for the caller to cancel what waits for them. */
export function removeClosedAgents(state: SuperTabState, closed: Agent[], now: number): Agent[] {
  const holding = new Set(state.conversations.filter(group => activeWork(group) || group.assignment?.status === 'lost').map(group => group.assignment!.agentId))
  const removed = closed.filter(target => !holding.has(target.id))
  if (!removed.length) return []
  for (const target of removed) recordClosing(state, target, now)
  const gone = new Set(removed.map(target => target.id))
  state.agents = state.agents.filter(target => !gone.has(target.id))
  for (const group of state.conversations) {
    group.agentIds = group.agentIds.filter(id => !gone.has(id))
    if (group.leadId && gone.has(group.leadId)) group.leadId = null
  }
  return removed
}

/** The next time a report of [machineId] could remove an agent, after those it just judged: its reports skip the full load
 *  until then (machineReports.ts), so a stopped list that stays the same still removes its agent when its wait ends. */
export function nextRemovalAt(state: SuperTabState, machineId: string, now: number): number | undefined {
  const stopped = state.machines?.find(m => m.machineId === machineId)?.observation?.stoppedHarnessIds ?? []
  const ends = state.agents.filter(a => a.machineId === machineId && a.downSince && removable(state, a))
    .map(a => Date.parse(a.downSince!) + (stopped.includes(a.harnessId) ? STOPPED_REMOVE_MS : DOWN_REMOVE_MS))
    .filter(end => end > now)
  return ends.length ? Math.min(...ends) : undefined
}

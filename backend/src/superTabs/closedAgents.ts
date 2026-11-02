import { isBuddy } from './buddies.js'
import { MACHINE_FRESH_MS, type MachineObservation } from './machines.js'
import { activeWork, type Agent, type SuperTabState } from './model.js'
import { ledProject } from './projects.js'

// Huy, 2026-11-02: four agents closed on their machine sat under Idle for hours, each in the machine's stopped list, because
// only an agent's own host removed it, and only after a stop was asked for. A session closed by hand never asked. Now the
// report that shows a session gone removes its agent (docs/plans/2026-11-02-closed-agents-leave-list-plan.md).

/** How long an agent not listed running stays before its machine, still reporting, removes it without a stopped list. */
export const DOWN_REMOVE_MS = 15 * 60_000

/**
 * The agents of [machineId] that [report], arriving now over the reading in [state], shows closed: not listed running and
 * either proved stopped (the proof the slot count accepts, machines.ts machineSlots) or down DOWN_REMOVE_MS while the last
 * reading, fresh, did not list them either, so one report after a silence never removes anyone. Never a coordinator (a
 * project's end is the only removal that takes one), a Buddy (its owner stops it), or an agent someone chose to keep: it
 * stays, shown as closed. Whether a task is still held is judged by removeClosedAgents, after the loss of tasks.
 */
export function closedAgents(state: SuperTabState, machineId: string, report: Pick<MachineObservation, 'runningHarnessIds' | 'stoppedHarnessIds' | 'stoppedReservations'>, now: number): Agent[] {
  const previous = state.machines?.find(m => m.machineId === machineId)?.observation
  const fresh = previous && now - previous.receivedAt <= MACHINE_FRESH_MS ? previous : undefined
  return state.agents.filter(target => {
    if (target.machineId !== machineId || report.runningHarnessIds.includes(target.harnessId)) return false
    if (isBuddy(target) || target.workDecision === 'keep' || ledProject(state, target.id)) return false
    if (report.stoppedHarnessIds.includes(target.harnessId)) {
      const reservation = state.harnessReservations?.find(r => r.machineId === machineId && r.harnessId === target.harnessId)
      // Older hosts can prove a first launch stopped, but cannot tell a resumed runtime from its predecessor.
      return !reservation || !reservation.renewed || !!report.stoppedReservations?.some(r => r.harnessId === target.harnessId && r.generation === reservation.generation)
    }
    return !!fresh && !fresh.runningHarnessIds.includes(target.harnessId) && !!target.downSince && now - Date.parse(target.downSince) >= DOWN_REMOVE_MS
  })
}

/** Removes those of [closed] that hold no task now: from the agents and from every group's members and leads, as commands.ts
 *  removeAgent does, without a close order, which the host's closing needs no more. A task just lost keeps its agent until its
 *  Lead hands it on or cancels it (it is still fenced and told by name, liveness.ts); the next report removes the agent then.
 *  The removed agents, for the caller to cancel what waits for them. */
export function removeClosedAgents(state: SuperTabState, closed: Agent[]): Agent[] {
  const holding = new Set(state.conversations.filter(group => activeWork(group) || group.assignment?.status === 'lost').map(group => group.assignment!.agentId))
  const removed = closed.filter(target => !holding.has(target.id))
  if (!removed.length) return []
  const gone = new Set(removed.map(target => target.id))
  state.agents = state.agents.filter(target => !gone.has(target.id))
  for (const group of state.conversations) {
    group.agentIds = group.agentIds.filter(id => !gone.has(id))
    if (group.leadId && gone.has(group.leadId)) group.leadId = null
  }
  return removed
}

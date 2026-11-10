/**
 * Work a Swarm from before Swarm v4 still stores: a task's assignment and its agent's last status. v4 no longer assigns work or
 * takes a status (2026-11-10), but the readers, sweeps and Pro dial that still
 * read stored tasks are tested on what those commands left behind.
 */
import { LEASE_MS } from './liveness.js'
import type { Assignment, SuperTabState, WorkStatus } from './model.js'

/** [agentId] working on task [conversationId] in [state], as work.assign stored it: in the task, with its configuration and
 *  machine, its lease from [now]. Returns the assignment, whose id is [id]. */
export function storedAssignment(state: SuperTabState, conversationId: string, agentId: string, now = Date.now(), id = `stored-${conversationId}-${agentId}`): Assignment {
  const group = state.conversations.find(c => c.id === conversationId)!
  const worker = state.agents.find(a => a.id === agentId)!
  if (!group.agentIds.includes(worker.id)) group.agentIds.push(worker.id)
  group.assignment = { id, agentId: worker.id, status: 'working', configuration: structuredClone(worker.configuration),
    execution: { machineId: worker.machineId, harnessId: worker.harnessId, machineOwnerId: worker.machineOwnerId, contributorId: worker.contributorId },
    result: null, leaseUntil: now + LEASE_MS, progressAt: now }
  return group.assignment
}

/** Task [conversationId]'s stored assignment at [status], with [result], as its agent's last work.status left it. */
export function storedStatus(state: SuperTabState, conversationId: string, status: WorkStatus, result: string | null = null): Assignment {
  const assignment = state.conversations.find(c => c.id === conversationId)!.assignment!
  assignment.status = status
  assignment.result = result
  return assignment
}

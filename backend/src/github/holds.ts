import type { SuperTabState, WorkStatus } from '../superTabs/model.js'

/** An agent's task in progress, which a GitHub token may serve. */
export interface WorkHold { agentId: string; assignmentId: string }

/** The statuses of a task still in the agent's hands: working, waiting on a person, stuck, or out for review (a Builder
 *  fixes what its Reviewer finds). Done, stopped, cancelled and reconciling (its agent removed) are not. */
export const HOLDING: ReadonlySet<WorkStatus> = new Set<WorkStatus>(['working', 'needs_human', 'blocked', 'review'])

/** Every task in progress in [state], held by an agent still in it. */
export function workHolds(state: Pick<SuperTabState, 'agents' | 'conversations'>): WorkHold[] {
  return state.conversations.flatMap(group => {
    const work = group.assignment
    return work && HOLDING.has(work.status) && state.agents.some(a => a.id === work.agentId)
      ? [{ agentId: work.agentId, assignmentId: work.id }] : []
  })
}

/** The holds [after] has that [before] did not: a task newly in progress, or one in progress again (resumed after a
 *  usage limit lost it, under the same id). */
export function startedHolds(before: Pick<SuperTabState, 'agents' | 'conversations'>, after: Pick<SuperTabState, 'agents' | 'conversations'>): WorkHold[] {
  const was = new Set(workHolds(before).map(hold => `${hold.agentId}:${hold.assignmentId}`))
  return workHolds(after).filter(hold => !was.has(`${hold.agentId}:${hold.assignmentId}`))
}

/** The holds in [before] that [after] no longer has: the task ended, went to another agent or attempt, or its agent left. */
export function endedHolds(before: Pick<SuperTabState, 'agents' | 'conversations'>, after: Pick<SuperTabState, 'agents' | 'conversations'>): WorkHold[] {
  const still = new Set(workHolds(after).map(hold => `${hold.agentId}:${hold.assignmentId}`))
  return workHolds(before).filter(hold => !still.has(`${hold.agentId}:${hold.assignmentId}`))
}

import { isLeads, occupiesAgent, type Agent, type Conversation, type SuperTabState, type WorkStatus } from '../superTabs/model.js'

/** An agent's task in progress, which a GitHub token may serve. */
export interface WorkHold { agentId: string; assignmentId: string }

/** The statuses of a task a GitHub token may serve: working, waiting on a person, stuck, or out for review. A task in review is
 *  handed over (model.ts handed, task #3399): its Engineer is free for new work but keeps this hold, to push the fixes its
 *  Reviewer or CI asks for. Done, stopped, cancelled and reconciling (its agent removed) are not. */
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

/** The task a GitHub token for [target] is minted for (store.ts githubAssignment): one in progress run by that agent's own
 *  session on its machine, the one in its hands first, then one it handed over (task #3399). A handed task's merge revokes
 *  every token minted for it, so the token its new task pushes with is never the handed one's. */
export function tokenTask(state: Pick<SuperTabState, 'conversations'>, target: Pick<Agent, 'id' | 'machineId' | 'machineOwnerId'>): Conversation | undefined {
  const held = state.conversations.filter(c => !isLeads(c) && c.assignment?.agentId === target.id && HOLDING.has(c.assignment.status)
    && c.assignment.execution.machineId === target.machineId && c.assignment.execution.machineOwnerId === target.machineOwnerId)
  return held.find(occupiesAgent) ?? held[0]
}

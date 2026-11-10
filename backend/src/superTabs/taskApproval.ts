import { author, fail, type Actor, type Conversation, type SuperTabState } from './model.js'
import { mayAcceptAll } from './members.js'
import { groupProject, ledProject, readConversation } from './projects.js'

export type ApprovalMode = 'autoApprove' | 'review'
/** Approval belongs to the requesting membership, never the execution host or PM. */
export interface TaskApproval {
  personId: string
  generation: string
  state: 'proposal' | 'approved' | 'rejected'
  createdAt: number
  decidedAt?: number
  suggestedAgentId?: string
  reason?: string
}
export const personalApprovalCommand = (type: string): boolean =>
  ['member.approvalMode', 'task.suggest', 'task.approve', 'task.reject'].includes(type)

export function stageTaskApproval(state: SuperTabState, group: Conversation, now: number): void {
  if (group.taskApproval || group.kind || group.audience || group.reviewOf) return
  const member = state.people.find(p => p.id === group.requesterId)
  // Ask me stages it; so does an Accept all chosen on a subscription account (task #4697: it stays off there until the vendors
  // confirm in writing, members.ts mayAcceptAll).
  const review = member?.approvalMode === 'review' || (member?.approvalMode === 'autoApprove' && !mayAcceptAll(state, member.id))
  if (!member || !review) return
  group.taskApproval = {
    personId: member.id, generation: member.generation, state: 'proposal', createdAt: now,
  }
}
/** A task whose scope changed goes back to its person: an approval is of the work as it was shown (#4249). */
export function reopenTaskApproval(group: Conversation): void {
  if (group.taskApproval?.state !== 'approved') return
  group.taskApproval.state = 'proposal'
  delete group.taskApproval.decidedAt
}
export function requireTaskApproval(group: Conversation, agentId?: string | null): void {
  if (group.taskApproval && group.taskApproval.state !== 'approved')
    fail('TASK_APPROVAL_REQUIRED', 'The person who requested this task must approve it before work starts.', 409)
  if (!group.assignment && group.taskApproval?.suggestedAgentId && agentId !== undefined && group.taskApproval.suggestedAgentId !== agentId)
    fail('TASK_AGENT_CHANGED', 'Use the agent the requesting person approved for this task.', 409)
}
/** Authority is checked before receipt replay too; a decision's state is checked only when applying it. */
export function authorizeTaskApproval(state: SuperTabState, actor: Actor, type: string, conversationId?: string): Conversation | undefined {
  author(state, actor)
  if (type === 'member.approvalMode') {
    if (actor.kind !== 'person') fail('TASK_APPROVAL_FORBIDDEN', 'Choose your own approval mode as a person.', 403)
    return
  }
  const group = readConversation(state, actor, conversationId!)
  const approval = group.taskApproval
  const own = actor.kind === 'person' && approval?.personId === actor.userId
    && state.people.some(p => p.id === actor.userId && p.generation === approval.generation)
  const pm = type === 'task.suggest' && actor.kind === 'agent' && ledProject(state, actor.agentId)?.id === groupProject(state, group).id
  if (!approval || (!own && !pm)) fail('TASK_APPROVAL_FORBIDDEN', 'Only the requesting person can approve or reject; their PM may suggest an agent.', 403)
  return group
}
/** Why a leaving person's pending approvals are rejected (commands.ts member.remove). */
export const REQUESTER_LEFT = 'Its requester left the Swarm.'
/** Rejects [group]'s approval for [reason]. */
export function rejectTaskApproval(group: Conversation, reason: string, now: number): void {
  const approval = pendingTaskApproval(group)
  approval.state = 'rejected'
  approval.decidedAt = now
  approval.reason = reason
}
export function pendingTaskApproval(group: Conversation): TaskApproval {
  const approval = group.taskApproval
  if (!approval || approval.state !== 'proposal') fail('TASK_APPROVAL_DECIDED', 'This task already has an approval decision.', 409)
  return approval
}

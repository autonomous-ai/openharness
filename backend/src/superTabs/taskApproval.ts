import { author, fail, type Actor, type Conversation, type SuperTabState } from './model.js'
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
  if (member?.approvalMode === 'review') group.taskApproval = {
    personId: member.id, generation: member.generation, state: 'proposal', createdAt: now,
  }
}
export function requireTaskApproval(group: Conversation): void {
  if (group.taskApproval && group.taskApproval.state !== 'approved')
    fail('TASK_APPROVAL_REQUIRED', 'The person who requested this task must approve it before work starts.', 409)
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
export function pendingTaskApproval(group: Conversation): TaskApproval {
  const approval = group.taskApproval
  if (!approval || approval.state !== 'proposal') fail('TASK_APPROVAL_DECIDED', 'This task already has an approval decision.', 409)
  return approval
}

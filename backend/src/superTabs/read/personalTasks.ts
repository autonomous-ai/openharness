import type { Actor, Conversation } from '../model.js'
import type { Part } from '../parts/types.js'
import { canReadGroup, groupProject } from '../projects.js'
import type { ApprovalMode } from '../taskApproval.js'
import type { AgentView } from './contract.js'
import type { ReaderView } from './views.js'

export interface PersonalTask {
  id: string
  version: number
  at: number
  projectId: string
  projectName: string
  title: string
  agent: { id: string; name: string; avatar?: AgentView['avatar'] } | null
  status: import('../model.js').WorkStatus | 'proposal' | 'rejected'
  suggested: boolean
  canApprove: boolean
  reason?: string
}
export interface PersonalTasks {
  approvalMode: ApprovalMode
  reset: boolean
  upserts: PersonalTask[]
  removed: string[]
}

/** First load supplies its active groups; a poll supplies only its changed parts. No history read or second cursor. */
export function personalTasksFor(changed: readonly Part[], view: ReaderView, actor: Actor, reset: boolean): PersonalTasks | undefined {
  if (actor.kind !== 'person') return undefined
  const member = view.state.people.find(p => p.id === actor.userId)
  if (!member) return undefined
  const agents = new Map(view.parts.agents.map(a => [a.key, a.data]))
  const out: PersonalTasks = { approvalMode: member.approvalMode ?? 'autoApprove', reset, upserts: [], removed: [] }
  for (const part of changed) {
    if (part.kind !== 'group' || !part.data) continue
    const group = part.data as Conversation
    // Every id, including a removal's, passes today's read rules; revocation uses the existing visibility epoch reload.
    try { if (!canReadGroup(view.state, actor, group)) continue } catch { continue }
    if (group.kind || group.audience || group.reviewOf) continue
    const project = groupProject(view.state, group)
    if (group.id === project.leadConversationId) continue
    const approval = group.taskApproval
    const own = approval ? approval.personId === member.id && approval.generation === member.generation
      : group.proposal ? group.proposal.senders.some(s => s.personId === member.id && s.generation === member.generation)
      : group.requesterId === member.id
    if (part.deleted || part.dormant || group.archived || group.dormant || group.proposal?.mergedInto || !own) {
      if (!reset) out.removed.push(part.key)
      continue
    }
    const worker = agents.get(group.assignment?.agentId ?? approval?.suggestedAgentId ?? '')
    const status = approval?.state === 'proposal' || approval?.state === 'rejected' ? approval.state
      : group.assignment?.status ?? (group.proposal && !['accept', 'reshape'].includes(group.proposal.decision?.kind ?? '') ? 'proposal' : 'planned')
    out.upserts.push({ id: group.id, version: part.version, at: part.changedAt, projectId: project.id, projectName: project.name,
      title: group.title, status, suggested: !group.assignment && !!approval?.suggestedAgentId, canApprove: approval?.state === 'proposal',
      agent: worker ? { id: worker.id, name: worker.displayName ?? worker.name, ...worker.avatar ? { avatar: worker.avatar } : {} } : null,
      ...approval?.reason ? { reason: approval.reason } : {} })
  }
  out.upserts.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
  return out
}

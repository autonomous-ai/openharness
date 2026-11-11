/**
 * Work a Swarm from before Swarm v4 still stores: a task, its assignment and its agent's last status. v4 no longer opens tasks
 * (tasks are GitHub issues), assigns work or takes a status (2026-11-10), but the readers, sweeps and Pro dial that still read
 * stored tasks are tested on what those commands left behind.
 */
import { LEASE_MS } from './liveness.js'
import { nextConversationNumber, type Assignment, type Conversation, type SuperTabState, type WorkStatus, type WorkTask } from './model.js'
import { processOf } from './process.js'
import { projectOf } from './projects.js'

/** What a stored task says. [creatorId]: the agent that opened it, which is in it beside its project's Lead. */
export interface StoredTask {
  projectId?: string
  title?: string
  brief?: string
  task?: WorkTask
  checks?: Array<{ description: string; independent?: boolean }>
  priority?: Conversation['priority']
  requesterId?: string
  creatorId?: string
}

/** A task in [state] as conversation.create stored it before Swarm v4 removed it: numbered, in its project (the first one unless
 *  named) with that project's Lead and its process, its brief, checks and priority (P2 unless named), asked by [requesterId]. Its id. */
export function storedTask(state: SuperTabState, fields: StoredTask = {}): string {
  const project = projectOf(state, fields.projectId ?? state.projects?.[0]?.id ?? 'lead')
  const leadId = state.conversations.find(c => c.id === project.leadConversationId)?.leadId ?? null
  const number = nextConversationNumber(state)
  state.groupCounter = number
  const id = `stored-task-${number}`
  const creator = fields.creatorId && fields.creatorId !== leadId ? [fields.creatorId] : []
  state.conversations.push({ id, ...(state.projects ? { projectId: project.id } : {}), ...processOf(project) === 'simple' ? { process: 'simple' as const } : {},
    number, title: fields.title ?? 'Offline editing', leadId,
    agentIds: [...leadId ? [leadId] : [], ...creator], archived: false, brief: fields.brief ?? 'Save edits while offline.',
    ...(fields.task ? { task: fields.task } : {}), priority: fields.priority ?? 'P2',
    ...(fields.requesterId ? { requesterId: fields.requesterId } : {}), assignment: null, lastMessageSequence: 0,
    checks: (fields.checks ?? []).map((check, i) => ({ id: `${id}-check-${i}`, description: check.description, independent: check.independent ?? false,
      evidence: null, passedBy: null })) })
  return id
}

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

/**
 * What an agent works on, from the Swarm read it already makes (design docs/plans/2026-11-02-agent-context-design.md,
 * section 1): the tasks assigned to it, or for a project's coordinator every open task of the project, which a delivery
 * tells it with each message (deliveryContext.ts). Nothing here decides workflow.
 */

import { effectivePriority, type TaskPriority } from './taskPriority.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : []
const text = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null

/** Statuses of finished work, as the backend's FINISHED (parts/light.ts) and activeWork (model.ts) read them. */
export const FINISHED_STATUSES: readonly string[] = ['done', 'stopped', 'cancelled', 'lost']

export interface TaskLine {
  id: string
  number: number | null
  title: string
  status: string
  agentName: string | null
  updatedAt: number | null
  result: string | null
  pullRequestUrls: string[]
  step: string | null
  taskId: string | null
  /** A task's priority; for a step, its task's, by which it is ordered but not labelled (a step carries none, #3117). */
  priority: TaskPriority
  /** For a step: its task's number and title, by which it is shown (task steps design). */
  taskNumber: number | null
  taskTitle: string | null
}

const isOpen = (group: Json): boolean => {
  const status = text(object(group.assignment).status)
  return !!status && !FINISHED_STATUSES.includes(status)
}
const leadConversations = (state: Json): string[] =>
  Array.isArray(state.projects) ? list(state.projects).map(p => String(p.leadConversationId)) : ['lead']
/** A step of a task (task steps design): a linked group with a name; an older linked group has none. */
export const isStep = (group: Json): boolean => typeof group.reviewOf === 'string'
/** A step's name: the one it was opened with, else its title (a linked task opened without one is a step too, Ken
 *  2026-11-02; backend steps.ts stepName). */
export const stepName = (group: Json): string => text(group.step) ?? String(group.title ?? '')
/** Work an agent may hold: a group of a project that is not its Lead conversation, nor a chat of another kind. */
const isWork = (state: Json, group: Json): boolean => !group.kind && !leadConversations(state).includes(String(group.id))
/** A task: work that is not a step. */
const isTask = (state: Json, group: Json): boolean => isWork(state, group) && !isStep(group)

/** A project's Lead is its Lead conversation's, as the backend reads it; a Swarm from before projects has one, 'lead'. */
export function isCoordinator(state: Json, agentId: string): boolean {
  const leads = leadConversations(state)
  return list(state.conversations).some(c => leads.includes(String(c.id)) && c.leadId === agentId)
}

const agentName = (state: Json, agentId: unknown): string | null =>
  typeof agentId === 'string' ? text(list(state.agents).find(a => a.id === agentId)?.name) ?? agentId : null

function lineOf(state: Json, group: Json): TaskLine {
  const assignment = object(group.assignment)
  const task = isStep(group) ? list(state.conversations).find(c => c.id === group.reviewOf) : undefined
  return {
    taskNumber: task && typeof task.number === 'number' ? task.number : null, taskTitle: task ? String(task.title ?? '') : null,
    id: String(group.id), number: typeof group.number === 'number' ? group.number : null, title: String(group.title ?? ''),
    status: text(assignment.status) ?? 'unassigned', agentName: agentName(state, assignment.agentId),
    updatedAt: null, result: text(assignment.result),
    pullRequestUrls: Array.isArray(group.pullRequestUrls) ? group.pullRequestUrls.filter((u): u is string => typeof u === 'string') : [],
    step: isStep(group) ? stepName(group) : null, taskId: text(group.reviewOf), priority: effectivePriority(task ?? group),
  }
}

/** The tasks assigned to [agentId] that are open work and not archived. A reused agent keeps `assignment.agentId` on an
 *  old finished task until it goes dormant; listing it ("#11 (done)") is the confusion this exists to end. */
export function openWorkOf(state: Json, agentId: string): TaskLine[] {
  return list(state.conversations)
    .filter(g => isWork(state, g) && g.archived !== true && isOpen(g) && object(g.assignment).agentId === agentId)
    .map(g => lineOf(state, g))
}

/** The coordinator's project: every task of it that is not archived and not finished, assigned or not. */
export function projectOpenWork(state: Json, agentId: string): TaskLine[] {
  const leads = new Set(leadConversations(state))
  const lead = list(state.conversations).find(c => leads.has(String(c.id)) && c.leadId === agentId)
  if (!lead) return []
  // A missing projectId is the default project, 'lead', as the backend reads it (groupProject): a new Swarm's Lead
  // conversation has none while its tasks say 'lead' (E2E 2026-11-02: the PM's mine counted none of them).
  const projectOf = (g: Json) => String(g.projectId ?? 'lead')
  const home = String(list(state.projects).find(p => p.leadConversationId === lead.id)?.id ?? projectOf(lead))
  return list(state.conversations)
    .filter(g => isTask(state, g) && g.archived !== true && projectOf(g) === home
      && (!g.assignment || isOpen(g)))
    .map(g => lineOf(state, g))
}

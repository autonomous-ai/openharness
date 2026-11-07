/**
 * Opening a planned review step (task #3401), as conversation.create opens one with `reviewOf` and `step`: a Ready opens its
 * steps here, and so do the time checks for a Linux or Windows step that waited for a machine of its OS (osSteps.ts, tasks #4278, #4410).
 */
import { bindTaskCard } from './cards.js'
import { nextConversationNumber, stableId, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { groupProject } from './projects.js'
import { stepBrief, stepCheck, type PlannedStep } from './reviewTable.js'
import { listStep } from './steps.js'
import { stepMark } from './teamWritten.js'

/** A pull request a step's brief names, at the head and base its files were read at. */
export interface StepPull { url: string; head: string | null; base?: string | null; history?: import('./prHistory.js').HistoryReport }

/** Opens step [planned] of [task] as [id], briefed on [pulls]: the step, and its brief written as [author], which is its card. */
export function openReviewStep(state: SuperTabState, task: Conversation, planned: PlannedStep, pulls: readonly StepPull[], id: string,
  author: Author): { step: Conversation; brief: MessageDraft } {
  const project = groupProject(state, task)
  const leadId = state.conversations.find(c => c.id === project.leadConversationId)?.leadId ?? null
  const number = nextConversationNumber(state)
  state.groupCounter = number
  const text = stepBrief(planned, { number: task.number ?? number, title: task.title, pulls })
  state.conversations.push({ id, ...(state.projects ? { projectId: project.id } : {}), number, title: planned.name, leadId,
    agentIds: leadId ? [leadId] : [], archived: false, brief: text, reviewOf: task.id,
    // A step keeps its task's mark, as conversation.create's does (teamWritten.ts stepMark).
    ...stepMark(state, task), step: planned.name, openedBy: 'server',
    assignment: null, lastMessageSequence: 0, codePullRequestUrls: [],
    checks: [{ description: stepCheck(planned), independent: true, id: stableId(id, '0'), evidence: null, passedBy: null }] })
  const step = state.conversations.at(-1)!
  listStep(task, id)
  const brief: MessageDraft = { id: stableId(id, 'brief'), conversationId: id, author, text, replyTo: null, recipients: [], source: { kind: 'system' } }
  bindTaskCard(step, brief)
  return { step, brief }
}

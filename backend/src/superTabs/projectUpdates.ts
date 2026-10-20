import { author, conversation, stableId, type Agent, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, groupProject, projectOf } from './projects.js'

/** Workgroup reports mark a project dirty. No per-message model or timer is
 * needed; the existing execution host's delivery poll requests consolidation. */
export function noteProjectReports(state: SuperTabState, messages: MessageDraft[], revision: number, now: number) {
  if (!state.projects) return
  for (const message of messages) {
    const group = conversation(state, message.conversationId), project = groupProject(state, group)
    if (group.id === project.leadConversationId) continue
    project.progress ??= { dirtyRevision: revision, summarizedRevision: 0, requestedRevision: 0, since: now }
    if (project.progress.dirtyRevision <= project.progress.summarizedRevision) project.progress.since = now
    project.progress.dirtyRevision = revision
  }
}

export function projectUpdateRequest(state: SuperTabState, target: Agent, now: number): MessageDraft | null {
  if (!state.projects || state.paused) return null
  const project = projectOf(state, agentProjectId(state, target))
  const group = conversation(state, project.leadConversationId), progress = project.progress
  if (group.leadId !== target.id || group.archived || !progress ||
    progress.dirtyRevision <= progress.summarizedRevision ||
    progress.dirtyRevision <= progress.requestedRevision ||
    now < Math.max(progress.requestedAt ?? 0, progress.since) + project.updateMinutes * 60_000) return null
  const id = stableId('project-update', state.id, project.id, String(progress.dirtyRevision))
  const text = `Consolidate new reports for project ${JSON.stringify(project.name)}. ` +
    `Read this project's workgroups with lastMessageSequence after ${progress.summarizedRevision}; inspect their new messages and current work. ` +
    'At your next natural checkpoint, tell the people what changed, what is blocked, and what comes next. Include useful workgroup references and result links. ' +
    'Do not copy the terminal log or repeat unchanged status. This is a scheduled request, not a new task. ' +
    `Use harness super-tab --tab ${state.id} command UNIQUE_OPERATION_ID ` +
    `JSON with {"type":"project.report","projectId":"${project.id}","throughRevision":${progress.dirtyRevision},"text":"your update"}. ` +
    'Use text:null to acknowledge if nothing merits an update. Reuse the same operation ID after a lost reply. ' +
    'Keep reporting human questions, serious blockers, and completion immediately; do not wait for this cadence.'
  return { id, conversationId: group.id,
    author: author(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }),
    text, replyTo: null, recipients: [target.id],
    source: { kind: 'update-request', projectId: project.id, throughRevision: progress.dirtyRevision } }
}

import { activeWork, author, conversation, isLeads, stableId, type Agent, type MessageDraft, type SuperTabState } from './model.js'
import { downSince } from './machines.js'
import { agentProjectId, groupProject, projectOf } from './projects.js'

/** Workgroup reports mark a project dirty. No per-message model or timer is
 * needed; the existing execution host's delivery poll requests consolidation. */
export function noteProjectReports(state: SuperTabState, messages: MessageDraft[], revision: number, now: number) {
  if (!state.projects) return
  for (const message of messages) {
    const group = conversation(state, message.conversationId)
    if (isLeads(group)) continue
    const project = groupProject(state, group)
    if (group.id === project.leadConversationId) continue
    project.progress ??= { dirtyRevision: revision, summarizedRevision: 0, requestedRevision: 0, since: now }
    if (project.progress.dirtyRevision <= project.progress.summarizedRevision) project.progress.since = now
    project.progress.dirtyRevision = revision
  }
}

/** The Lead reassigns a Builder or Reviewer that has been down this long (the owner's rule, 2026-10-23). */
export const DOWN_REASSIGN_MS = 2 * 60 * 60_000

/** Builders and Reviewers of the project down for two hours, each named once per time it went down. A worker that is
 * already stopping was decided on. */
function downWorkers(state: SuperTabState, projectId: string, now: number) {
  return state.agents.flatMap(a => {
    const since = downSince(state, a, now)
    if (!since || a.downNamed === since || now - Date.parse(since) < DOWN_REASSIGN_MS || a.workDecision === 'stop' ||
      agentProjectId(state, a) !== projectId || state.conversations.some(c => c.leadId === a.id)) return []
    const task = state.conversations.find(c => activeWork(c) && c.assignment!.agentId === a.id)
    return [{ agentId: a.id, since, text: `${a.displayName ?? a.name} (down since ${since}${task ? `; task ${JSON.stringify(task.title)}` : ''})` }]
  })
}

export function projectUpdateRequest(state: SuperTabState, target: Agent, now: number): MessageDraft | null {
  // An older Swarm without stored projects is one synthesized project. It keeps no report progress (noteProjectReports),
  // so its Lead is woken only for down workers.
  if (state.paused) return null
  const project = projectOf(state, agentProjectId(state, target))
  const group = conversation(state, project.leadConversationId), progress = project.progress
  if (group.leadId !== target.id || group.archived) return null
  const reports = !!progress && progress.dirtyRevision > progress.summarizedRevision &&
    progress.dirtyRevision > progress.requestedRevision &&
    now >= Math.max(progress.requestedAt ?? 0, progress.since) + project.updateMinutes * 60_000
  const down = downWorkers(state, project.id, now)
  if (!reports && !down.length) return null
  // A wake-up only for down workers is acknowledged through what was already summarized, so reports that are not yet due
  // keep their own request.
  const through = (reports ? progress!.dirtyRevision : progress?.summarizedRevision) ?? 0
  const id = stableId('project-update', state.id, project.id, String(through), ...down.map(d => `${d.agentId}@${d.since}`))
  const text = (reports ? `Consolidate new reports for project ${JSON.stringify(project.name)}. ` +
    `Read this project's workgroups with lastMessageSequence after ${progress!.summarizedRevision}; inspect their new messages and current work. ` +
    'At your next natural checkpoint, tell the people what changed, what is blocked, and what comes next. Include useful workgroup references and result links. ' : '') +
    (down.length ? `Down for 2 hours or more in project ${JSON.stringify(project.name)}: ${down.map(d => d.text).join(', ')}. ` +
      'Their machine is offline or their session ended or stopped. Decide whether to reassign their work to another agent. ' : '') +
    'Do not copy the terminal log or repeat unchanged status. This is a scheduled request, not a new task. ' +
    `Use harness super-tab --tab ${state.id} command UNIQUE_OPERATION_ID ` +
    `JSON with {"type":"project.report","projectId":"${project.id}","throughRevision":${through},"text":"your update"}. ` +
    'Use text:null to acknowledge if nothing merits an update. Reuse the same operation ID after a lost reply. ' +
    'Keep reporting human questions, serious blockers, and completion immediately; do not wait for this cadence.'
  return { id, conversationId: group.id,
    author: author(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }),
    text, replyTo: null, recipients: [target.id],
    source: { kind: 'update-request', projectId: project.id, throughRevision: through,
      ...(down.length ? { down: down.map(({ agentId, since }) => ({ agentId, since })) } : {}) } }
}

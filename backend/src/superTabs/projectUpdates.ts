import { activeWork, author, conversation, isLeads, stableId, type Agent, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { downSince } from './machines.js'
import { agentProjectId, groupProject, projectOf, type SwarmProject } from './projects.js'
import type { ProgressData } from './parts/types.js'

/** A project with no report progress yet starts clean at the start of every conversation's numbering. */
const freshProgress = (now: number): ProgressData => ({ since: now, summarizedFloor: 0, summarized: {}, requestedFloor: 0, requested: {} })

/** The conversations whose posts count toward a project's reports: not its Lead conversation, not the Leads
 *  conversation, not a private conversation (its posts never reach the Lead's summary to everyone). */
export function reportGroups(state: SuperTabState, project: SwarmProject): Conversation[] {
  return state.conversations.filter(c => !isLeads(c) && !c.audience && c.id !== project.leadConversationId && groupProject(state, c).id === project.id)
}

/** A conversation is dirty while its last report is past what its Lead summarized (design section 3.6). */
export function dirtyGroups(state: SuperTabState, project: SwarmProject): Conversation[] {
  const progress = project.progress
  if (!progress) return []
  return reportGroups(state, project).filter(g => (g.reportSeq ?? 0) > (progress.summarized[g.id] ?? progress.summarizedFloor))
}

/** Workgroup reports mark their conversation, and the project's progress changes only when the project goes from clean to
 *  dirty, so posts in different conversations of one project never write the same part (spec ruling 1). */
export function noteProjectReports(state: SuperTabState, messages: MessageDraft[], sequences: ReadonlyMap<string, number>, now: number) {
  if (!state.projects) return
  for (const message of messages) {
    const group = conversation(state, message.conversationId)
    if (isLeads(group) || group.audience) continue
    const project = groupProject(state, group)
    if (group.id === project.leadConversationId) continue
    const clean = !project.progress || !dirtyGroups(state, project).length
    project.progress ??= freshProgress(now)
    group.reportSeq = sequences.get(message.id) ?? group.messageSeq ?? 0
    if (clean) project.progress.since = now
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

/** What each dirty conversation's report reaches, by conversation: what a wake-up asks the Lead to acknowledge. */
const throughOf = (groups: Conversation[]) => Object.fromEntries(groups.map(g => [g.id, g.reportSeq ?? 0]).sort(([a], [b]) => a! < b! ? -1 : 1))

export function projectUpdateRequest(state: SuperTabState, target: Agent, now: number): MessageDraft | null {
  // An older Swarm without stored projects is one synthesized project. It keeps no report progress (noteProjectReports),
  // so its Lead is woken only for down workers.
  if (state.paused) return null
  const project = projectOf(state, agentProjectId(state, target))
  const group = conversation(state, project.leadConversationId), progress = project.progress
  if (group.leadId !== target.id || group.archived) return null
  const dirty = dirtyGroups(state, project)
  const reports = !!progress && dirty.some(g => (g.reportSeq ?? 0) > (progress.requested[g.id] ?? progress.requestedFloor)) &&
    now >= Math.max(progress.requestedAt ?? 0, progress.since) + project.updateMinutes * 60_000
  const down = downWorkers(state, project.id, now)
  if (!reports && !down.length) return null
  // A wake-up only for down workers acknowledges nothing new, so reports that are not yet due keep their own request.
  const through = reports ? throughOf(dirty) : {}
  const id = stableId('project-update', state.id, project.id, JSON.stringify(through), ...down.map(d => `${d.agentId}@${d.since}`))
  const after = (g: Conversation) => `${g.number !== undefined ? `#${g.number}` : JSON.stringify(g.title)} after ${progress!.summarized[g.id] ?? progress!.summarizedFloor}`
  const text = (reports ? `Consolidate new reports for project ${JSON.stringify(project.name)}. ` +
    `Read the new messages of these workgroups: ${dirty.map(after).join(', ')}; inspect their current work. ` +
    'At your next natural checkpoint, tell the people what changed, what is blocked, and what comes next. Include useful workgroup references and result links. ' : '') +
    (down.length ? `Down for 2 hours or more in project ${JSON.stringify(project.name)}: ${down.map(d => d.text).join(', ')}. ` +
      'Their machine is offline or their session ended or stopped. Decide whether to reassign their work to another agent. ' : '') +
    'Do not copy the terminal log or repeat unchanged status. This is a scheduled request, not a new task. ' +
    `Use harness super-tab --tab ${state.id} command UNIQUE_OPERATION_ID ` +
    `JSON with {"type":"project.report","projectId":"${project.id}","through":${JSON.stringify(through)},"text":"your update"}. ` +
    'Use text:null to acknowledge if nothing merits an update. Reuse the same operation ID after a lost reply. ' +
    'Keep reporting human questions, serious blockers, and completion immediately; do not wait for this cadence.'
  return { id, conversationId: group.id,
    author: author(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }),
    text, replyTo: null, recipients: [target.id],
    source: { kind: 'update-request', projectId: project.id, through,
      ...(down.length ? { down: down.map(({ agentId, since }) => ({ agentId, since })) } : {}) } }
}

/** A Lead's report: each conversation it names is summarized through what it read, never past its last report. A legacy
 *  scalar from a wake-up written before the split covers every conversation up to that tab revision. */
export function summarize(state: SuperTabState, project: SwarmProject, through: Record<string, number>): void {
  const progress = project.progress
  if (!progress) return
  for (const group of reportGroups(state, project)) {
    if (!(group.id in through)) continue
    progress.summarized[group.id] = Math.max(progress.summarized[group.id] ?? progress.summarizedFloor, Math.min(through[group.id]!, group.reportSeq ?? 0))
  }
}

/** Whether a report answers the latest wake-up: with it, everything a wake-up asked for is summarized. A wake-up from
 *  before the store by parts asked through a tab revision, which only a legacy scalar can reach. */
export function answersRequest(progress: ProgressData, legacy: number | undefined): boolean {
  // Nothing asked since the split: a pre-split wake-up's tab revision is reached only by a legacy scalar; a map answers any other.
  if (!Object.keys(progress.requested).length) return legacy === undefined || legacy >= progress.requestedFloor
  return Object.entries(progress.requested).every(([id, seq]) => (progress.summarized[id] ?? progress.summarizedFloor) >= seq)
}

export { freshProgress }

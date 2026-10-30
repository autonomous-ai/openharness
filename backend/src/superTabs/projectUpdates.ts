import { author, conversation, isLeads, stableId, type Agent, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
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

/** What each dirty conversation's report reaches, by conversation: what a wake-up asks the Lead to acknowledge. */
const throughOf = (groups: Conversation[]) => Object.fromEntries(groups.map(g => [g.id, g.reportSeq ?? 0]).sort(([a], [b]) => a! < b! ? -1 : 1))

/** How long an update request the Lead's host received holds later ones back while unanswered. On 26 Oct one was never
 *  answered and held its project's every later request: its reports were never summarized, and 372 archived conversations
 *  could not go quiet for two days (prod, 2026-10-28). One not yet received (its host offline) holds them as before. */
export const UNANSWERED_REQUEST_MS = 2 * 60 * 60_000

export function projectUpdateRequest(state: SuperTabState, target: Agent, now: number): MessageDraft | null {
  // An older Swarm without stored projects is one synthesized project. It keeps no report progress (noteProjectReports),
  // so its Lead is woken only for lost work (liveness.ts), which replaced the wake-up for workers down two hours.
  if (state.paused) return null
  const project = projectOf(state, agentProjectId(state, target))
  const group = conversation(state, project.leadConversationId), progress = project.progress
  if (group.leadId !== target.id || group.archived) return null
  const dirty = dirtyGroups(state, project)
  const reports = !!progress && dirty.some(g => (g.reportSeq ?? 0) > (progress.requested[g.id] ?? progress.requestedFloor)) &&
    now >= Math.max(progress.requestedAt ?? 0, progress.since) + project.updateMinutes * 60_000
  if (!reports) return null
  const through = throughOf(dirty)
  const id = stableId('project-update', state.id, project.id, JSON.stringify(through))
  const after = (g: Conversation) => `${g.number !== undefined ? `#${g.number}` : JSON.stringify(g.title)} after ${progress!.summarized[g.id] ?? progress!.summarizedFloor}`
  const text = `Consolidate new reports for project ${JSON.stringify(project.name)}. ` +
    `Read the new messages of these workgroups: ${dirty.map(after).join(', ')}; inspect their current work. ` +
    'At your next natural checkpoint, tell the people what changed, what is blocked, and what comes next. Include useful workgroup references and result links. ' +
    'Do not copy the terminal log or repeat unchanged status. This is a scheduled request, not a new task. ' +
    `Use harness super-tab --tab ${state.id} command UNIQUE_OPERATION_ID ` +
    `JSON with {"type":"project.report","projectId":"${project.id}","through":${JSON.stringify(through)},"text":"your update"}. ` +
    'Use text:null to acknowledge if nothing merits an update. Reuse the same operation ID after a lost reply. ' +
    'Keep reporting human questions, serious blockers, and completion immediately; do not wait for this cadence.'
  return { id, conversationId: group.id,
    author: author(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }),
    text, replyTo: null, recipients: [target.id],
    source: { kind: 'update-request', projectId: project.id, through } }
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

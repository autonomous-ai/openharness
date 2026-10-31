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

/** The least time between two of a project's scheduled wake-ups (Dee, 2026-10-31: "even at 30 min that's 48 updates a day").
 *  A question, a blocker or completion reaches the coordinator at once anyway, as the status line's recipients. */
export const WAKE_GAP_MS = 15 * 60_000

/** What of a work group's state wakes its coordinator: its task (assigned, a new one), the task's status (review, done,
 *  blocked, needs_human, cancelled; a review group's verdict is its own task's status), a review's findings, its merges and
 *  pull requests, and its archiving. Ordinary messages, progress notes and terminal turns change none of it. */
const workState = (group: Conversation): string => JSON.stringify([group.assignment?.id ?? null, group.assignment?.status ?? null,
  group.assignment?.reviewFoundAt ?? null, group.ledger?.mergedAt ?? null, group.pullRequestUrls?.length ?? 0, group.archived])

/** Marks each work group whose state this write changed, or that it created, through its latest message, so the wake-up
 *  asks the coordinator to read it; the project's progress changes only when the project goes from clean to dirty, so
 *  changes in different conversations of one project never write the same part (spec ruling 1). */
export function noteWorkChanges(before: SuperTabState, after: SuperTabState, now: number) {
  if (!after.projects) return
  const prior = new Map(before.conversations.map(g => [g.id, g]))
  for (const group of after.conversations) {
    if (isLeads(group) || group.audience) continue
    const was = prior.get(group.id)
    if (was && workState(was) === workState(group)) continue
    const project = groupProject(after, group)
    if (group.id === project.leadConversationId) continue
    const clean = !project.progress || !dirtyGroups(after, project).length
    project.progress ??= freshProgress(now)
    group.reportSeq = Math.max(group.reportSeq ?? 0, group.messageSeq ?? 0)
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
  // An older Swarm without stored projects is one synthesized project. It keeps no report progress (noteWorkChanges),
  // so its Lead is woken only for lost work (liveness.ts), which replaced the wake-up for workers down two hours.
  if (state.paused) return null
  const project = projectOf(state, agentProjectId(state, target))
  const group = conversation(state, project.leadConversationId), progress = project.progress
  if (group.leadId !== target.id || group.archived) return null
  const dirty = dirtyGroups(state, project)
  // At most once every 15 minutes, whatever cadence an older client set (updateMinutes is still read, never used here).
  const reports = !!progress && dirty.some(g => (g.reportSeq ?? 0) > (progress.requested[g.id] ?? progress.requestedFloor)) &&
    now >= (progress.requestedAt ?? 0) + WAKE_GAP_MS
  if (!reports) return null
  const through = throughOf(dirty)
  const id = stableId('project-update', state.id, project.id, JSON.stringify(through))
  const after = (g: Conversation) => `${g.number !== undefined ? `#${g.number}` : JSON.stringify(g.title)} after ${progress!.summarized[g.id] ?? progress!.summarizedFloor}`
  const text = `Work changed in project ${JSON.stringify(project.name)}. ` +
    `Read the new messages of these workgroups: ${dirty.map(after).join(', ')}; inspect their current work. ` +
    'Then keep the project\'s status card current: one short line per active task saying where it is, what changed, and what it waits on; ' +
    'nothing repeated from the cards in the chat. The card updates in place and posts nothing to the chat. This is a scheduled request, not a new task. ' +
    `Use harness super-tab --tab ${state.id} command UNIQUE_OPERATION_ID ` +
    `JSON with {"type":"project.report","projectId":"${project.id}","through":${JSON.stringify(through)},"text":"the whole card"}. ` +
    'Use text:null to acknowledge when the card is still right. Reuse the same operation ID after a lost reply. ' +
    'Post in the project chat only when work merges or ships, a person must decide something new, or work is badly stuck, in one or two lines with the link.'
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

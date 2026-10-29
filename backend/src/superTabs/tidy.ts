import type { Prisma } from '@prisma/client'
import { isBuddy } from './buddies.js'
import { agentDisplayName } from './agentNames.js'
import { verdictPending } from './autoReview.js'
import { activeWork, agentRole, stableId, type Agent, type Assignment, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, groupProject, projectsOf } from './projects.js'
import { toLead } from './terminal.js'
import { leadNoticeRows } from './liveness.js'

// Nobody has to tidy a Swarm by hand (roadmap, December). A Builder left with nothing to do for 15 minutes is stopped, as
// its Lead's agent.release stop would: its host closes the session and frees the machine slot (host.ts). Whatever the
// owner turns off (tab.tidy), nothing here runs.

/** How long a worker sits without work before it is stopped. */
export const IDLE_STOP_MS = 15 * 60_000
/** A machine report older than this does not vouch for a clean folder: the same 2 minutes after which work is lost. */
const REPORT_FRESH_MS = 2 * 60_000

const FINISHED = ['done', 'cancelled', 'stopped', 'lost']
const time = (value: string | undefined) => value === undefined ? undefined : Date.parse(value)

/** All stopIdleWorkers reads of a group: the Lead's poll reads only this of an asleep one (ASLEEP_FIELDS). */
export type GroupActivity = Pick<Conversation, 'id' | 'lastActivityAt' | 'archived' | 'agentIds' | 'reviewOf'> &
  { assignment?: (Pick<Assignment, 'agentId' | 'status' | 'progressAt'> & { lost?: Pick<NonNullable<Assignment['lost']>, 'at'> }) | null }

/** The fields of an asleep group's part the Lead's poll reads, as GroupActivity: never its brief, checks or task. */
export const ASLEEP_FIELDS = Object.fromEntries(['id', 'lastActivityAt', 'archived', 'agentIds', 'reviewOf', 'assignment.agentId', 'assignment.status',
  'assignment.progressAt', 'assignment.lost.at'].map(field => [`data.${field}`, 1]))

/**
 * The asleep groups of `reviewers` that can still change what stopIdleWorkers decides at `now` (Diego, 10-29: the Lead's poll
 * read every one, whole, ~4 MB a poll): those active after `now - IDLE_STOP_MS` (a message, or the progress or loss of its
 * work, idleSince) and those reviewing work still open (recheckPending). Any other is older than every stop's threshold, so
 * it never keeps a worker. The Reviewers' index serves it (parts/indexed.ts `agents`); the rest is checked on each of their rows.
 */
export function asleepMatch(state: SuperTabState, tabId: string, reviewers: string[], now: number): Record<string, Prisma.InputJsonValue> {
  const since = now - IDLE_STOP_MS
  const open = state.conversations.filter(c => c.assignment && !FINISHED.includes(c.assignment.status)).map(c => c.id)
  return { tabId, deleted: false, dormant: true, agentIds: { $in: reviewers }, $or: [
    { lastActivityAt: { $gt: { $date: new Date(since).toISOString() } } },
    { 'data.assignment.progressAt': { $gt: since } },
    { 'data.assignment.lost.at': { $gt: since } },
    ...open.length ? [{ 'data.reviewOf': { $in: open } }] : [],
  ] }
}

/** The groups a worker belongs to or worked in, with those asleep that the caller read for it (`asleep`). */
const groupsOf = (state: SuperTabState, worker: Agent, asleep: readonly GroupActivity[]): GroupActivity[] =>
  [...state.conversations, ...asleep.filter(g => !state.conversations.some(c => c.id === g.id))]
    .filter(c => c.agentIds.includes(worker.id) || c.assignment?.agentId === worker.id)

/** When the worker last had anything to do: its start, its Lead's keep, its own progress, or a message in one of its groups. */
function idleSince(state: SuperTabState, worker: Agent, groups: GroupActivity[]): number {
  const seen = [time(worker.startedSession?.createdAt), worker.keptAt, ...groups.flatMap(g => [time(g.lastActivityAt),
    ...g.assignment?.agentId === worker.id ? [g.assignment.progressAt, g.assignment.lost?.at] : []])]
  return Math.max(...seen.filter((t): t is number => t !== undefined && Number.isFinite(t)))
}

/** A Reviewer stays while work it reviews may come back to it for a re-check: the reviewed group's task is not finished. */
function recheckPending(state: SuperTabState, reviewer: Agent, groups: GroupActivity[]): boolean {
  if (agentRole(reviewer) !== 'reviewer') return false
  return groups.some(g => {
    const reviewed = g.reviewOf ? state.conversations.find(c => c.id === g.reviewOf) : undefined
    return !!reviewed?.assignment && !FINISHED.includes(reviewed.assignment.status)
  })
}

/** A worker whose task a usage limit took waits to take it back (work.resume) until that task is resumed, handed on or
 *  cancelled, however late the resume comes after the reset (review of #1807). A task not loaded is taken as waiting. */
function waitingToResume(state: SuperTabState, worker: Agent): boolean {
  const lost = worker.lostTask
  if (!lost?.resumeAt) return false
  const group = state.conversations.find(c => c.id === lost.conversationId)
  return !group || (group.assignment?.id === lost.assignmentId && group.assignment.status === 'lost')
}

/** Only a host that said, in a fresh report, that the session runs with nothing uncommitted vouches for stopping it. */
function reportedClean(state: SuperTabState, worker: Agent, now: number): boolean {
  const report = state.machines?.find(m => m.machineId === worker.machineId)?.observation
  return !!report && now - report.receivedAt <= REPORT_FRESH_MS && report.runningHarnessIds.includes(worker.harnessId)
    && report.harnessUncommitted?.[worker.harnessId] === false
}

/**
 * Marks for stopping every worker of the project idle for IDLE_STOP_MS: started by the Swarm (a person's own session is
 * theirs to close), not a Lead, with no active task, no message waiting for it (`busy`), its host reporting nothing
 * uncommitted, not waiting to resume after a usage limit, and, for a Reviewer, no re-check pending. Each gets one quiet
 * line, to nobody, in its most recent loaded group, else the Lead conversation. Run on its Lead's poll, which knows what
 * is waiting. `asleep` are the groups of its Reviewers that ordinary loads leave out: an archived review group still says
 * whose re-check may come (review of #1807).
 */
export function stopIdleWorkers(state: SuperTabState, projectId: string, now: number, busy: ReadonlySet<string>,
  asleep: readonly GroupActivity[] = []): MessageDraft[] {
  if (state.tidy === false) return []
  const project = projectsOf(state).find(p => p.id === projectId)
  const leadId = project && state.conversations.find(c => c.id === project.leadConversationId)?.leadId
  const lead = leadId ? state.agents.find(a => a.id === leadId) : undefined
  if (!project || !lead) return []
  const rows: MessageDraft[] = []
  for (const worker of state.agents) {
    if (!worker.startedSession || worker.workDecision === 'stop' || busy.has(worker.id) || agentProjectId(state, worker) !== projectId) continue
    // A Buddy waits for its owner, however long; only they, or the Swarm's owner turning Buddies off, stop it (buddies.ts).
    if (isBuddy(worker)) continue
    if (state.conversations.some(c => c.leadId === worker.id || (activeWork(c) && c.assignment!.agentId === worker.id))) continue
    if (waitingToResume(state, worker)) continue
    const groups = groupsOf(state, worker, asleep)
    const since = idleSince(state, worker, groups)
    if (!(now - since >= IDLE_STOP_MS) || recheckPending(state, worker, groups) || !reportedClean(state, worker, now)) continue
    worker.idleStop = { previous: worker.workDecision ?? null }
    worker.workDecision = 'stop'
    worker.releaseId = stableId('idle-stop', worker.id, String(since))
    // Only a group the poll loaded takes the line: an asleep one refuses posts, and its refusal would fail the whole poll.
    const last = groups.filter(g => !g.archived && state.conversations.some(c => c.id === g.id)).sort((a, b) => (time(b.lastActivityAt) ?? 0) - (time(a.lastActivityAt) ?? 0))[0]
    // The Lead's to handle (Ken, 2026-10-29): delivered to it, in its own chat when it is not in that group, and read by no
    // one else (model.ts agentOnly).
    rows.push(...leadNoticeRows(toLead(state, worker, { id: stableId('idle-stop', worker.id, String(since), 'line'), conversationId: last?.id ?? project.leadConversationId,
      replyTo: null, recipients: [],
      author: { kind: 'agent', id: lead.id, name: lead.name, displayName: agentDisplayName(state.agents, lead.id), membershipGeneration: lead.membershipGeneration },
      text: `${worker.displayName ?? worker.name} stopped: no work for 15 minutes.`, source: { kind: 'idle-stop', agentId: worker.id } })))
  }
  return rows
}

/** The machines whose reports the stops in `rows` were judged from, which their write touches (as liveness.ts judgedMachines). */
export function stoppedMachines(state: SuperTabState, rows: MessageDraft[]): Array<{ kind: 'machine'; key: string }> {
  const stopped = new Set(rows.map(r => r.source?.agentId))
  return [...new Set(state.agents.filter(a => stopped.has(a.id)).map(a => a.machineId))].map(key => ({ kind: 'machine' as const, key }))
}

/** How long a finished group stays open after its last message: an archived group refuses posts, and the Lead still talks
 *  to its worker for a while after the task ends (ruling in the plan, 2026-10-27). */
export const ARCHIVE_QUIET_MS = 30 * 60_000

/** Whether a group may archive by itself, as far as the Swarm alone can tell: its task done or cancelled, quiet for
 *  ARCHIVE_QUIET_MS, not a review still owing its verdict (autoReview.ts verdictPending), and not a Lead conversation, a
 *  private chat with people or the Leads conversation. Its pull requests and decisions are checked by the caller (archive.ts). */
export function archivable(state: SuperTabState, group: Conversation, now: number): boolean {
  if (state.tidy === false || group.archived || group.kind || group.audience) return false
  if (projectsOf(state).some(p => p.leadConversationId === group.id)) return false
  if (!['done', 'cancelled'].includes(group.assignment?.status ?? '') || verdictPending(state, group)) return false
  const last = time(group.lastActivityAt)
  return last !== undefined && now - last >= ARCHIVE_QUIET_MS
}

/** The one quiet line an archived group gets, to nobody, written as its project's Lead; none when the project has no Lead. */
export function archiveLine(state: SuperTabState, group: Conversation, now: number): MessageDraft | null {
  const leadId = state.conversations.find(c => c.id === groupProject(state, group).leadConversationId)?.leadId
  const lead = leadId ? state.agents.find(a => a.id === leadId) : undefined
  if (!lead) return null
  const prs = group.pullRequestUrls?.length ? ' and its pull requests are merged or closed' : ''
  return { id: stableId('auto-archive', group.id, String(now)), conversationId: group.id, replyTo: null, recipients: [],
    author: { kind: 'agent', id: lead.id, name: lead.name, displayName: agentDisplayName(state.agents, lead.id), membershipGeneration: lead.membershipGeneration },
    text: `Archived: the work is ${group.assignment!.status}${prs}.`, source: { kind: 'auto-archive' } }
}

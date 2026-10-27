import { activeWork, stableId, type Agent, type Assignment, type Author, type Conversation, type MessageDraft,
  type SuperTabState } from './model.js'
import { agentDisplayName } from './agentNames.js'
import { leadOf, toLead } from './terminal.js'
import { MACHINE_FRESH_MS } from './machines.js'

// Work never sits with a dead owner (design: "A Swarm that never stops", 2026-10-26). A worker's active assignment is held
// by a lease that its progress renews. A dead, stalled or limited worker loses it within minutes: the assignment becomes
// lost, its agent is fenced off, and the Lead is woken to hand it on. Leads are not covered here.
//
// The agent's own status, checks and posts renew the lease stored on the assignment. Its machine's reports renew it too,
// but are read from the report its machine part keeps (written on every report anyway), never written into the group: a
// group written once a minute per task would wake every reader of the Swarm.

/** How long an assignment stays its agent's without progress. */
export const LEASE_MS = 5 * 60_000
/** A session its machine still lists as running may go this long without a screen or transcript change before its task is
 *  lost: a long command that prints nothing (a test suite) is still work (Product Manager, 2026-10-26). Hard failures —
 *  offline, stopped, a usage limit — stay immediate. */
export const QUIET_RUNNING_MS = 30 * 60_000
/** A report renews the lease while the session's last progress is this recent, so its lease ends QUIET_RUNNING_MS after it. */
const PROGRESS_FRESH_MS = QUIET_RUNNING_MS - LEASE_MS
/** A machine silent this long has lost its work. */
const OFFLINE_LOST_MS = 2 * 60_000
/** A dispatched start not running this long after has failed. */
const START_RUN_MS = 3 * 60_000
/** A start its machine keeps reporting as preparing may take this long: the worktree checkout's own limit (10 minutes,
 *  cli lib/gitProject.ts WORKTREE_ADD_TIMEOUT) and the fetch before it. 3 minutes failed starts on a busy Mac that was
 *  still fetching and checking out a 470 MB project (2026-10-27). */
const START_PREPARE_MS = 15 * 60_000
/** Any machine's report runs the time checks for its Swarm at most this often. */
export const SWEEP_EVERY_MS = 30_000

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const machineName = (state: SuperTabState, machineId: string) => state.machines?.find(m => m.machineId === machineId)?.name ?? 'its machine'
/** A sweep runs inside a machine's report and the Lead's poll, so it never fails on an agent whose membership changed:
 *  it writes as that agent without checking it, and a delivery to an agent no longer shared is not created. */
const writtenBy = (state: SuperTabState, writer: Agent): Author => ({ kind: 'agent', id: writer.id, name: writer.name,
  displayName: agentDisplayName(state.agents, writer.id), membershipGeneration: writer.membershipGeneration })
const reachable = (state: SuperTabState, row: MessageDraft): MessageDraft => ({ ...row, recipients: row.recipients.filter(id => {
  const target = state.agents.find(a => a.id === id)
  return !!target && state.people.find(p => p.id === target.contributorId)?.generation === target.membershipGeneration
}) })

/** The agent's own progress (an assignment, a status, a check, a post) renews the lease stored on its assignment. */
export function renewLease(assignment: Assignment, now: number): void {
  assignment.leaseUntil = now + LEASE_MS
  assignment.progressAt = now
}

/** The active assignments held by workers, not by a Lead, and not already being reconciled after their agent left. */
function workerTasks(state: SuperTabState): Array<{ group: Conversation; assignment: Assignment; worker: Agent }> {
  return state.conversations.filter(activeWork).flatMap(group => {
    const assignment = group.assignment!
    const worker = state.agents.find(a => a.id === assignment.agentId)
    if (!worker || assignment.status === 'reconciling' || state.conversations.some(c => c.leadId === worker.id)) return []
    return [{ group, assignment, worker }]
  })
}

/** The worker's own status, check or message in its task's group renews its lease. */
export function renewOwnTask(group: Conversation, agentId: string, now: number): void {
  if (activeWork(group) && group.assignment!.agentId === agentId) renewLease(group.assignment!, now)
}

/** The last time its machine's reports renewed a worker's lease: a report listing it running with recent progress renews at
 *  that report, so a lease from the last report with progress P runs from P + PROGRESS_FRESH_MS at the latest.
 *  A host that sends no progress at all (before harnessProgress) renews by running alone; one that stopped listing the
 *  session renewed last when it went down. Undefined when no report ever showed it. */
function reportRenewedAt(state: SuperTabState, worker: Agent): number | undefined {
  const report = state.machines?.find(m => m.machineId === worker.machineId)?.observation
  if (!report) return undefined
  if (!report.runningHarnessIds.includes(worker.harnessId)) return worker.downSince ? Date.parse(worker.downSince) : undefined
  if (!report.harnessProgress) return report.receivedAt
  const progress = report.harnessProgress[worker.harnessId]
  return progress === undefined ? undefined : Math.min(report.receivedAt, progress + PROGRESS_FRESH_MS)
}

/** When a worker's lease ends: from its own last status, check or post (for an assignment from before leases, its group's
 *  last message), or from its machine's reports, whichever is later. Undefined when nothing ever renewed it. */
function leaseEnd(group: Conversation, assignment: Assignment, renewed: number | undefined): number | undefined {
  const own = assignment.leaseUntil ?? (group.lastActivityAt ? Date.parse(group.lastActivityAt) + LEASE_MS : undefined)
  const reported = renewed === undefined ? undefined : renewed + LEASE_MS
  return own === undefined ? reported : reported === undefined ? own : Math.max(own, reported)
}

/** The worker's last progress any renewal saw: its own report, or a screen change its machine reported. */
function lastProgress(state: SuperTabState, worker: Agent, assignment: Assignment): number | undefined {
  const report = state.machines?.find(m => m.machineId === worker.machineId)?.observation
  const reported = report?.harnessProgress?.[worker.harnessId]
  const seen = [assignment.progressAt, reported === undefined ? undefined : Math.min(reported, report!.receivedAt)].filter((t): t is number => t !== undefined)
  return seen.length ? Math.max(...seen) : undefined
}

function limitReason(worker: Agent, now: number): string | null {
  return worker.alerting?.includes('limit') && worker.limitedUntil && Date.parse(worker.limitedUntil) > now
    ? `it hit a usage limit until ${worker.limitedUntil.slice(11, 16)} UTC` : null
}

/** Why a worker has lost its task now, or null while it still holds it. Only a machine that has reported can be offline. */
function lostReason(state: SuperTabState, group: Conversation, worker: Agent, assignment: Assignment, now: number): string | null {
  const pool = state.machines?.find(m => m.machineId === worker.machineId)
  if (pool?.observation?.stoppedHarnessIds.includes(worker.harnessId)) return `its session on ${pool.name} stopped`
  if (pool?.observation && now - pool.observation.receivedAt > OFFLINE_LOST_MS) return `its machine ${pool.name} has been offline for 2 minutes`
  const limited = limitReason(worker, now)
  if (limited) return limited
  // Its host alerts only after ten minutes of retries without an answer (cli superTabs/terminal.ts MODEL_WAIT_MS), so a
  // short burst of failures that recovers never gets here.
  if (worker.alerting?.includes('model')) return 'its model keeps failing'
  const end = leaseEnd(group, assignment, reportRenewedAt(state, worker))
  if (end !== undefined && now > end) {
    const progress = lastProgress(state, worker, assignment)
    return progress === undefined ? 'no progress seen' : `no progress for ${plural(Math.floor((now - progress) / 60_000), 'minute')}`
  }
  return null
}

/** Marks a worker's task lost and fences its agent. The Lead hears who, why, how long since progress and the last result;
 *  the old agent hears that its task moved. Rows are written as the Lead, or as the worker when the project has none. */
function loseTask(state: SuperTabState, group: Conversation, worker: Agent, reason: string, now: number, resumeAt?: string): MessageDraft[] {
  const assignment = group.assignment!
  const resume = resumeAt ? { resumeAt } : {}
  assignment.status = 'lost'
  assignment.lost = { reason, at: now, ...resume }
  group.lostAttempt = { id: assignment.id, agentId: worker.id, machineId: assignment.execution.machineId, engine: assignment.configuration.engine }
  worker.lostTask = { conversationId: group.id, assignmentId: assignment.id, reason, at: now, ...resume }
  const sender = writtenBy(state, leadOf(state, worker) ?? worker)
  const progress = lastProgress(state, worker, assignment)
  const since = progress === undefined ? 'unknown' : `${plural(Math.max(0, Math.floor((now - progress) / 60_000)), 'minute')} ago`
  const result = assignment.result?.replace(/[.\s]+$/, '')
  const pr = group.pullRequestUrls?.at(-1)
  const source = { kind: 'work-lost', agentId: worker.id, assignmentId: assignment.id, reason }
  const wake = `${worker.displayName ?? worker.name} lost its task "${group.title}": ${reason}. Last progress ${since}. `
    + `Last result: ${result || 'none'}.${pr && !result?.includes(pr) ? ` Pull request: ${pr}.` : ''} `
    + (resumeAt ? `It resumes by itself when its limit resets at ${resumeAt.slice(11, 16)} UTC, unless you hand it on first. `
      + 'If another account or engine has allowance now, assign it there now with its branch and last progress note, or cancel it.'
      : 'Assign it to another agent now, or cancel it.')
  return [...toLead(state, worker, { id: stableId('work-lost', assignment.id), conversationId: group.id, author: sender, replyTo: null, recipients: [], text: wake, source }),
    { id: stableId('work-lost', assignment.id, 'agent'), conversationId: group.id, author: sender, replyTo: null, recipients: [worker.id], source,
      text: `Your task "${group.title}" moved: ${reason}. Stop working on it; your status and results for it are no longer accepted.` }]
    .map(row => reachable(state, row))
}

/** Loses at once the tasks of the workers `which` picks that have a reason now: an agent that just reported a usage limit,
 *  the agents of a machine that just reported. A task lost to that limit resumes at `resumeAt` when its screen said when the
 *  limit resets (the host types into the same session then, cli superTabs/limitResume.ts). */
export function loseTasks(state: SuperTabState, now: number, which: (worker: Agent) => boolean = () => true, resumeAt?: string): MessageDraft[] {
  return workerTasks(state).filter(t => which(t.worker)).flatMap(({ group, assignment, worker }) => {
    const reason = lostReason(state, group, worker, assignment, now)
    return reason ? loseTask(state, group, worker, reason, now, resumeAt && reason === limitReason(worker, now) ? resumeAt : undefined) : []
  })
}

/** The machine parts a loss was judged from (offline, stopped, its reports' renewals). The write that records the loss
 *  touches them, so a fresh report committed since the read makes it retry on current data instead of fencing a live worker. */
export function judgedMachines(state: SuperTabState, rows: MessageDraft[]): Array<{ kind: 'machine'; key: string }> {
  const lost = new Set(rows.flatMap(r => r.source?.kind === 'work-lost' ? [r.source.agentId as string] : []))
  const machines = new Set(state.agents.filter(a => lost.has(a.id)).map(a => a.machineId))
  return [...machines].filter(id => state.machines?.some(m => m.machineId === id)).map(key => ({ kind: 'machine' as const, key }))
}

/** The time checks, run on the Lead's poll and on any machine's report: every worker task with a reason is lost, and
 *  every start dispatched over 3 minutes ago that is not running fails, unless its machine is still preparing it. */
export function sweepLiveness(state: SuperTabState, now: number): MessageDraft[] {
  return [...loseTasks(state, now), ...failStalledStarts(state, now)]
}

function failStalledStarts(state: SuperTabState, now: number): MessageDraft[] {
  return (state.starts ?? []).flatMap(start => {
    if (!start.dispatched || start.harnessId || start.error || start.dispatchedAt === undefined || now - start.dispatchedAt <= START_RUN_MS) return []
    // Only its own machine's report can say it is preparing; one before preparingStartIds never does, so its starts get 3 minutes.
    const report = state.machines?.find(m => m.machineId === start.request.machineId)?.observation
    const named = !!report?.preparingStartIds?.includes(start.id)
    const silent = !!report && now - report.receivedAt > MACHINE_FRESH_MS
    if (named && !silent && now - start.dispatchedAt <= START_PREPARE_MS) return []
    const machine = machineName(state, start.request.machineId)
    start.error = !named ? `${machine} did not start it within 3 minutes`
      : silent ? `${machine} stopped reporting while preparing it` : `${machine} was still preparing it after 15 minutes`
    // Never a lookup that throws: these checks run inside every machine's report.
    const group = state.conversations.find(c => c.id === start.request.conversationId)
    const lead = group?.leadId ? state.agents.find(a => a.id === group.leadId) : undefined
    if (!group || !lead) return []
    return [reachable(state, { id: stableId('start-timeout', start.id), conversationId: group.id, replyTo: null,
      recipients: group.agentIds.includes(lead.id) ? [lead.id] : [], author: writtenBy(state, lead),
      text: `Could not start ${start.request.name}: ${start.error}.`, source: { kind: 'start-timeout', startId: start.id } })]
  })
}

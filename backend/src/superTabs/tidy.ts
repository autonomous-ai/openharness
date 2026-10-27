import { agentDisplayName } from './agentNames.js'
import { activeWork, agentRole, stableId, type Agent, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, projectsOf } from './projects.js'

// Nobody has to tidy a Swarm by hand (roadmap, December). A Builder left with nothing to do for 15 minutes is stopped, as
// its Lead's agent.release stop would: its host closes the session and frees the machine slot (host.ts). Whatever the
// owner turns off (tab.tidy), nothing here runs.

/** How long a worker sits without work before it is stopped. */
export const IDLE_STOP_MS = 15 * 60_000
/** A machine report older than this does not vouch for a clean folder: the same 2 minutes after which work is lost. */
const REPORT_FRESH_MS = 2 * 60_000

const FINISHED = ['done', 'cancelled', 'stopped', 'lost']
const time = (value: string | undefined) => value === undefined ? undefined : Date.parse(value)

/** The groups a worker belongs to or worked in. */
const groupsOf = (state: SuperTabState, worker: Agent) =>
  state.conversations.filter(c => c.agentIds.includes(worker.id) || c.assignment?.agentId === worker.id)

/** When the worker last had anything to do: its start, its Lead's keep, its own progress, or a message in one of its groups. */
function idleSince(state: SuperTabState, worker: Agent, groups: Conversation[]): number {
  const seen = [time(worker.startedSession?.createdAt), worker.keptAt, ...groups.flatMap(g => [time(g.lastActivityAt),
    ...g.assignment?.agentId === worker.id ? [g.assignment.progressAt, g.assignment.lost?.at] : []])]
  return Math.max(...seen.filter((t): t is number => t !== undefined && Number.isFinite(t)))
}

/** A Reviewer stays while work it reviews may come back to it for a re-check: the reviewed group's task is not finished. */
function recheckPending(state: SuperTabState, reviewer: Agent, groups: Conversation[]): boolean {
  if (agentRole(reviewer) !== 'reviewer') return false
  return groups.some(g => {
    const reviewed = g.reviewOf ? state.conversations.find(c => c.id === g.reviewOf) : undefined
    return !!reviewed?.assignment && !FINISHED.includes(reviewed.assignment.status)
  })
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
 * line, to nobody, in its most recent group. Run on its Lead's poll, which knows what is waiting.
 */
export function stopIdleWorkers(state: SuperTabState, projectId: string, now: number, busy: ReadonlySet<string>): MessageDraft[] {
  if (state.tidy === false) return []
  const project = projectsOf(state).find(p => p.id === projectId)
  const leadId = project && state.conversations.find(c => c.id === project.leadConversationId)?.leadId
  const lead = leadId ? state.agents.find(a => a.id === leadId) : undefined
  if (!project || !lead) return []
  const rows: MessageDraft[] = []
  for (const worker of state.agents) {
    if (!worker.startedSession || worker.workDecision === 'stop' || busy.has(worker.id) || agentProjectId(state, worker) !== projectId) continue
    if (state.conversations.some(c => c.leadId === worker.id || (activeWork(c) && c.assignment!.agentId === worker.id))) continue
    if (worker.lostTask?.resumeAt && Date.parse(worker.lostTask.resumeAt) > now) continue
    const groups = groupsOf(state, worker)
    const since = idleSince(state, worker, groups)
    if (!(now - since >= IDLE_STOP_MS) || recheckPending(state, worker, groups) || !reportedClean(state, worker, now)) continue
    worker.workDecision = 'stop'
    worker.releaseId = stableId('idle-stop', worker.id, String(since))
    const last = groups.filter(g => !g.archived).sort((a, b) => (time(b.lastActivityAt) ?? 0) - (time(a.lastActivityAt) ?? 0))[0]
    rows.push({ id: stableId('idle-stop', worker.id, String(since), 'line'), conversationId: last?.id ?? project.leadConversationId, replyTo: null, recipients: [],
      author: { kind: 'agent', id: lead.id, name: lead.name, displayName: agentDisplayName(state.agents, lead.id), membershipGeneration: lead.membershipGeneration },
      text: `${worker.displayName ?? worker.name} stopped: no work for 15 minutes.`, source: { kind: 'idle-stop', agentId: worker.id } })
  }
  return rows
}

/** The machines whose reports the stops in `rows` were judged from, which their write touches (as liveness.ts judgedMachines). */
export function stoppedMachines(state: SuperTabState, rows: MessageDraft[]): Array<{ kind: 'machine'; key: string }> {
  const stopped = new Set(rows.map(r => r.source?.agentId))
  return [...new Set(state.agents.filter(a => stopped.has(a.id)).map(a => a.machineId))].map(key => ({ kind: 'machine' as const, key }))
}

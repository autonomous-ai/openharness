import { isBuddy } from './buddies.js'
import { agentDisplayName } from './agentNames.js'
import { activeWork, stableId, type Agent, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, groupProject, projectsOf } from './projects.js'
import { toLead } from './terminal.js'

// Nobody has to tidy a Swarm by hand (roadmap, December). The server stops no agent (project instructions, phase 4): an agent
// with no open task for 15 minutes is told to its project's coordinator once per idle spell, whether tidying is on or off,
// and the instructions say whether the coordinator stops or keeps it. Tidying (tab.tidy) governs only the auto-archive.

/** How long an agent has no open task before its coordinator is told. */
export const IDLE_NOTICE_MS = 15 * 60_000

const time = (value: string | undefined) => value === undefined ? undefined : Date.parse(value)

/** The loaded groups an agent belongs to or worked in. */
const groupsOf = (state: SuperTabState, target: Agent): Conversation[] =>
  state.conversations.filter(c => c.agentIds.includes(target.id) || c.assignment?.agentId === target.id)

/** When the agent last had anything to do: its start, its coordinator's keep, its own progress, or a message in one of its
 *  groups. An agent the Swarm started that never had an assignment (no task of its own, never lost one) only sits in its
 *  groups, whose messages are about others' work: it is idle from its start or keep (Swarm autonomous-harness, 2026-10-29:
 *  one sat idle 18+ minutes, its time renewed by every message in a busy chat). One a person added by hand has no start of
 *  record, so its groups' messages count, from the one it joined in. Undefined when nothing tells when. */
function idleSince(target: Agent, groups: Conversation[]): number | undefined {
  const worked = !!target.lostTask || groups.some(g => g.assignment?.agentId === target.id) || !target.startedSession
  const seen = [time(target.startedSession?.createdAt), target.keptAt, ...(worked ? groups : []).flatMap(g => [time(g.lastActivityAt),
    ...g.assignment?.agentId === target.id ? [g.assignment.progressAt, g.assignment.lost?.at] : []])]
    .filter((t): t is number => t !== undefined && Number.isFinite(t))
  return seen.length ? Math.max(...seen) : undefined
}

/** An agent whose task a usage limit took waits to take it back (work.resume) until that task is resumed, handed on or
 *  cancelled, however late the resume comes after the reset (review of #1807). A task not loaded is taken as waiting. */
function waitingToResume(state: SuperTabState, target: Agent): boolean {
  const lost = target.lostTask
  if (!lost?.resumeAt) return false
  const group = state.conversations.find(c => c.id === lost.conversationId)
  return !group || (group.assignment?.id === lost.assignmentId && group.assignment.status === 'lost')
}

/**
 * Tells the project's coordinator, once per idle spell, of every agent of the project with no open task for IDLE_NOTICE_MS:
 * not a Buddy (it waits for its person) nor the coordinator, not stopping nor kept (a keep answers the notice until the agent
 * is assigned again, which clears it, and finishes that work), with no delivery waiting for it (`busy`), not
 * waiting to resume after a usage limit, and in no loaded group with active work. One row in the coordinator's chat, to it
 * alone (model.ts NOTICE_READERS `idle`); the agent's `idleNoticedAt` records the spell, so the next poll says nothing until
 * new activity starts another. Nothing else about the agent changes. Run on the coordinator's poll, which knows what waits.
 */
export function idleNotices(state: SuperTabState, projectId: string, now: number, busy: ReadonlySet<string>): MessageDraft[] {
  const project = projectsOf(state).find(p => p.id === projectId)
  const coordinatorId = project && state.conversations.find(c => c.id === project.leadConversationId)?.leadId
  const coordinator = coordinatorId ? state.agents.find(a => a.id === coordinatorId) : undefined
  if (!project || !coordinator) return []
  const rows: MessageDraft[] = []
  for (const target of state.agents) {
    if (target.id === coordinator.id || isBuddy(target) || target.workDecision === 'stop' || target.workDecision === 'keep' || busy.has(target.id)
      || agentProjectId(state, target) !== projectId || waitingToResume(state, target)) continue
    const groups = groupsOf(state, target)
    if (groups.some(activeWork)) continue
    const since = idleSince(target, groups)
    if (since === undefined || now - since < IDLE_NOTICE_MS || target.idleNoticedAt === since) continue
    target.idleNoticedAt = since
    rows.push(...toLead(state, target, { id: stableId('idle', target.id, String(since)), conversationId: project.leadConversationId, replyTo: null,
      recipients: [], author: { kind: 'agent', id: coordinator.id, name: coordinator.name, displayName: agentDisplayName(state.agents, coordinator.id),
        membershipGeneration: coordinator.membershipGeneration },
      text: `${target.displayName ?? target.name} has had no open task for 15 minutes.`, source: { kind: 'idle', agentId: target.id } }))
  }
  return rows
}

/** A linked task (`reviewOf`) the Swarm does not archive by itself: none of its checks carries evidence, nobody cancelled it,
 *  and the task it links to is still going. Once that task is done or cancelled the link is moot. By hand any agent of the
 *  project or a person archives it (project instructions, phase 4). */
export const linkPending = (state: SuperTabState, linked: Conversation): boolean => {
  if (!linked.reviewOf || linked.assignment?.status === 'cancelled' || linked.checks.some(c => c.evidence)) return false
  const target = state.conversations.find(c => c.id === linked.reviewOf)
  return !!target && activeWork(target)
}

/** How long a finished group stays open after its last message: an archived group refuses posts, and the Lead still talks
 *  to its worker for a while after the task ends (ruling in the plan, 2026-10-27). */
export const ARCHIVE_QUIET_MS = 30 * 60_000

/** Whether a group may archive by itself, as far as the Swarm alone can tell: its task done or cancelled, quiet for
 *  ARCHIVE_QUIET_MS, not a linked task still owing its verdict (linkPending), and not a Lead conversation, a
 *  private chat with people or the Leads conversation. Its pull requests and decisions are checked by the caller (archive.ts). */
export function archivable(state: SuperTabState, group: Conversation, now: number): boolean {
  if (state.tidy === false || group.archived || group.kind || group.audience) return false
  if (projectsOf(state).some(p => p.leadConversationId === group.id)) return false
  if (!['done', 'cancelled'].includes(group.assignment?.status ?? '') || linkPending(state, group)) return false
  const last = time(group.lastActivityAt)
  return last !== undefined && now - last >= ARCHIVE_QUIET_MS
}

/** The one quiet line an archived group gets, to nobody, written as its project's Lead; none when the project has no Lead. */
export function archiveLine(state: SuperTabState, group: Conversation, now: number): MessageDraft | null {
  const prs = group.pullRequestUrls?.length ? ' and its pull requests are merged or closed' : ''
  return leadLine(state, group, now, `Archived: the work is ${group.assignment!.status}${prs}.`)
}

function leadLine(state: SuperTabState, group: Conversation, now: number, text: string): MessageDraft | null {
  const leadId = state.conversations.find(c => c.id === groupProject(state, group).leadConversationId)?.leadId
  const lead = leadId ? state.agents.find(a => a.id === leadId) : undefined
  if (!lead) return null
  return { id: stableId('auto-archive', group.id, String(now)), conversationId: group.id, replyTo: null, recipients: [],
    author: { kind: 'agent', id: lead.id, name: lead.name, displayName: agentDisplayName(state.agents, lead.id), membershipGeneration: lead.membershipGeneration },
    text, source: { kind: 'auto-archive' } }
}

// A review nobody is reviewing closes once the work it reviews needs no Swarm review (Ken, 2026-10-30): 28 of 31 open
// review groups waited for a Reviewer on pull requests already merged, reviewed outside the Swarm or folded into a batch PR.
// A review with no Reviewer has no task to finish or cancel, so `archivable` never matched it.

/** A review group with no active Reviewer: none was ever free, or its Reviewer's task ended. The archive pass reads these
 *  as it reads finished work (parts/write.ts workFinished). */
export const unattendedReview = (group: Conversation): boolean => !!group.reviewOf && !activeWork(group)

/** The pull requests that decide whether an unattended review still matters: those it links and those of the work it reviews. */
export function reviewPullRequests(state: SuperTabState, review: Conversation): string[] {
  const reviewed = state.conversations.find(c => c.id === review.reviewOf)
  return [...new Set([...review.pullRequestUrls ?? [], ...reviewed?.pullRequestUrls ?? []])]
}

/** Whether an unattended review may close by itself, as far as the Swarm alone can tell: it links, or the work it reviews
 *  links, a pull request, and it has been quiet for ARCHIVE_QUIET_MS. That each of those pull requests is merged or
 *  closed, and that no decision waits there, the caller checks (archive.ts, store.ts archiveFinished). */
export function reviewClosable(state: SuperTabState, review: Conversation, now: number): boolean {
  if (state.tidy === false || review.archived || review.kind || review.audience || !unattendedReview(review)) return false
  if (projectsOf(state).some(p => p.leadConversationId === review.id)) return false
  if (!reviewPullRequests(state, review).length) return false
  const last = time(review.lastActivityAt)
  return last !== undefined && now - last >= ARCHIVE_QUIET_MS
}

const pullNumber = (url: string) => `#${url.slice(url.lastIndexOf('/') + 1)}`

/** The one quiet line a closed review gets, naming each pull request and how it ended. */
export function reviewCloseLine(state: SuperTabState, review: Conversation, settled: Readonly<Record<string, 'merged' | 'closed'>>, now: number): MessageDraft | null {
  const prs = reviewPullRequests(state, review).map(url => `${pullNumber(url)} ${settled[url]}`).join(', ')
  return leadLine(state, review, now, `Closed: ${prs}; no Swarm review is needed now.`)
}

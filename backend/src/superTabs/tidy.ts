import { checksOpenWork, isStep, taskEnded } from './steps.js'
import { isBuddy } from './buddies.js'
import { expiredModelRequests, unservedBuddyModels } from './buddyModel.js'
import { agentDisplayName } from './agentNames.js'
import { githubRepository, type GitHubRepository } from '../github/repository.js'
import { activeWork, occupiesAgent, appendPullRequestUrls, stableId, type Actor, type Agent, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, canReadGroup, groupProject, ledProject, projectsOf } from './projects.js'
import { toLead } from './terminal.js'

// Nobody has to tidy a Swarm by hand (roadmap, December). The server stops no agent (project instructions, phase 4): an agent
// with no open task for 15 minutes is told to its project's coordinator once per idle spell, whether tidying is on or off,
// and the instructions say whether the coordinator stops or keeps it. Tidying (tab.tidy) governs only the auto-archive.

/** How long an agent has no open task before its coordinator is told. */
export const IDLE_NOTICE_MS = 15 * 60_000

/** How long a PM's switch request waits for its machine to claim it (agent.switchClaim) before it is dropped. */
export const SWITCH_UNCLAIMED_MS = 2 * 60_000

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
    // Its own work in its hands, or a member of a task whose work is going (a Reviewer or a Tester linked to it). Its own task
    // handed over (task #3399) leaves it free, so the coordinator hears it is idle.
    if (groups.some(c => c.assignment?.agentId === target.id ? occupiesAgent(c) : activeWork(c))) continue
    // A Reviewer or Tester, by what it worked on: the instructions keep it while the work it checked is open (Ken,
    // 2026-11-02: "Tester has had no open task" twice in 8 minutes, nothing for the PM to do), and no longer.
    if (checksOpenWork(state, groups, target.id)) continue
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

/** Whether a switch request ran out: nobody claimed it in 2 minutes, or its claim's lease lapsed. */
export const switchExpired = (request: NonNullable<Agent['switchRequest']>, now: number): boolean =>
  now >= (request.claimedUntil === undefined ? Date.parse(request.at) + SWITCH_UNCLAIMED_MS : Date.parse(request.claimedUntil))

/** A switch request that ran out is dropped (the PM keeps its engine), and its project chat says so once: the host that never
 *  answered cannot. Run by the liveness sweep, which any machine's report drives, as the PM's own host may be the one down. */
export function staleSwitches(state: SuperTabState, now: number): MessageDraft[] {
  const rows: MessageDraft[] = []
  for (const pm of state.agents) {
    const request = pm.switchRequest, project = request && ledProject(state, pm.id)
    if (!request || !project) continue
    if (!switchExpired(request, now)) continue
    delete pm.switchRequest
    rows.push({ id: stableId('switch-stale', pm.id, request.id), conversationId: project.leadConversationId, replyTo: null, recipients: [],
      author: { kind: 'agent', id: pm.id, name: pm.name, displayName: agentDisplayName(state.agents, pm.id), membershipGeneration: pm.membershipGeneration },
      text: "Couldn't switch the PM: its machine did not answer.", source: { kind: 'switch', agentId: pm.id } })
  }
  return rows
}

export { BUDDY_MODEL_GONE_MS, BUDDY_MODEL_LEASE_MS } from './buddyModel.js'

/** A Buddy's model switch its machine never reported is dropped (the Buddy stays where it was), and its owner's Buddy chat
 *  says so once. Run by the liveness sweep, as staleSwitches is: the Buddy's own machine may be the one down. */
export function staleModelRequests(state: SuperTabState, now: number): MessageDraft[] {
  const drafts = expiredModelRequests(state, now).map(({ buddy, requestId, conversationId, text, machines }): MessageDraft => ({
    id: stableId('buddy-model-stale', buddy.id, requestId), conversationId, replyTo: null, recipients: [], text,
    source: { kind: 'system', ...(machines.length ? { machines } : {}) },
    author: { kind: 'agent', id: buddy.id, name: buddy.name, displayName: agentDisplayName(state.agents, buddy.id), membershipGeneration: buddy.membershipGeneration } }))
  // After the expiry, so a Buddy whose machine never answered one request home is asked again on the next sweep.
  unservedBuddyModels(state, now, buddy => stableId('buddy-model-gone', buddy.id, String(now)))
  return drafts
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
 *  ARCHIVE_QUIET_MS, not a linked task still owing its verdict (linkPending), not a step whose task is still open
 *  (steps.ts taskEnded), and not a Lead conversation, a private chat with people or the Leads conversation. Its pull requests and decisions are checked by the caller (archive.ts). */
export function archivable(state: SuperTabState, group: Conversation, now: number): boolean {
  if (state.tidy === false || group.archived || group.kind || group.audience) return false
  if (projectsOf(state).some(p => p.leadConversationId === group.id)) return false
  if (!['done', 'cancelled'].includes(group.assignment?.status ?? '') || linkPending(state, group)) return false
  if (isStep(group) && !taskEnded(state, group)) return false
  const last = time(group.lastActivityAt)
  return last !== undefined && now - last >= ARCHIVE_QUIET_MS
}

/** Work that ended without finishing: only a cancel with a reason closes it, never an archive alone (#558). */
export const unfinishedWork = (group: Conversation): boolean => ['lost', 'stopped'].includes(group.assignment?.status ?? '')

/** Who hears that a group archives without shipping: the person who asked for its cancelled task, unless they archive it
 *  themselves or can no longer read it (#558). */
export function cancelledTags(state: SuperTabState, group: Conversation, actor?: Actor): string[] {
  if (group.assignment?.status !== 'cancelled' || !group.requesterId) return []
  if (actor?.kind === 'person' && actor.userId === group.requesterId) return []
  const requester = state.people.find(p => p.id === group.requesterId)
  return requester && canReadGroup(state, { kind: 'person', userId: requester.id, email: requester.email }, group) ? [requester.id] : []
}

/** Why a cancelled task ended, as its cancel recorded it, without the final full stop. */
export const cancelReason = (group: Conversation): string => (group.assignment?.result ?? '').replace(/[.\s]+$/, '')

/** "PR #1875", as a Lead's cancel or a builder's result names a pull request without its link. */
const PR_NUMBER = /\bPR #([1-9][0-9]{0,8})\b/gi
/** A repository's name, or owner/name, as a result writes it next to "PR #N": "from autonomous-harness PR #2716", "PR #12 in acme/tool". */
const REPO_NAME = '([A-Za-z0-9](?:[\\w.-]*\\w)?(?:/[A-Za-z0-9](?:[\\w.-]*\\w)?)?)'
const NAME_BEFORE = new RegExp(`(?:^|[\\s(])(from\\s+)?${REPO_NAME}\\s+$`, 'i'), NAME_AFTER = new RegExp(`^\\s+(?:in|of)\\s+${REPO_NAME}`, 'i')
/** English compounds a result writes before "PR", which look like a repository's name and are none. */
const COMPOUND = /^(?:follow-(?:up|on)|(?:re|co|pre|non|one)-\w+)$/i

/** Whether [name] next to a "PR #N" plainly names a repository other than the project's. Dropping one of its own numbers
 *  archives a group while that pull request is open (#558); reading another's as its own waits at most until that number
 *  closes here or is not found. So "Desktop/CLI PR #12", "test-only PR #12" and "PR #12 in docs/plans" stay its own (review
 *  of #2895): a name counts after "from" ("Ported from autonomous-harness PR #2716"), or as owner/name of the project's owner. */
function otherRepository(name: string | undefined, from: boolean, repository: GitHubRepository | null): boolean {
  if (!name) return false
  const [owner, repo] = name.toLowerCase().split('/')
  if (repo === undefined) return from && /^[a-z]/.test(owner!) && /[._-]/.test(owner!) && !COMPOUND.test(owner!) && owner !== repository?.name.toLowerCase()
  if (name.toLowerCase() === repository?.fullName.toLowerCase()) return false
  return from || owner === repository?.owner.toLowerCase()
}

/** How a pull request an archive waits on ended: merged, closed, or missing, a number GitHub knows no pull request by in
 *  that repository (another repository's, #2602). */
export type SettledPullRequest = 'merged' | 'closed' | 'missing'

/** The pull requests a group's archive waits on: those it links, and those its result and check evidence name, a "PR #N"
 *  read in its project's repository. A cancel saying "Handed off as PR #1875" linked nothing, so the group archived while
 *  that PR was open (#558). A number another repository's name sits next to is that repository's, and never waited on
 *  ("Ported from autonomous-harness PR #2716" held a task open forever, #2602). Null when it names a number with no GitHub
 *  repository to read it in: it stays open. */
export function archiveWaitsFor(group: Conversation, repositoryUrl: string | null | undefined): string[] | null {
  const texts = [group.assignment?.result, ...group.checks.map(check => check.evidence)]
  const named = { pullRequestUrls: [...group.pullRequestUrls ?? []] } as Conversation
  appendPullRequestUrls(named, texts)
  const repository = githubRepository(repositoryUrl)
  const numbers = texts.flatMap(text => [...(text ?? '').matchAll(PR_NUMBER)]
    .filter(match => {
      const before = NAME_BEFORE.exec(text!.slice(0, match.index))
      return !otherRepository(before?.[2], !!before?.[1], repository)
        && !otherRepository(NAME_AFTER.exec(text!.slice(match.index + match[0].length))?.[1], false, repository)
    })
    .map(match => match[1]!))
  if (!numbers.length) return named.pullRequestUrls!
  if (!repository) return null
  return [...new Set([...named.pullRequestUrls!, ...numbers.map(n => `https://github.com/${repository.fullName}/pull/${n}`)])]
}

/** The one quiet line an archived group gets, to nobody, written as its project's Lead; none when the project has no Lead.
 *  A cancelled task's requester is tagged in it (cancelledTags). */
export function archiveLine(state: SuperTabState, group: Conversation, now: number): MessageDraft | null {
  const prs = group.pullRequestUrls?.length ? ' and its pull requests are merged or closed' : ''
  const mentions = cancelledTags(state, group), reason = mentions.length && cancelReason(group) ? ` (${cancelReason(group)})` : ''
  const line = leadLine(state, group, now, `Archived: the work is ${group.assignment!.status}${reason}${prs}.`)
  return line && mentions.length ? { ...line, mentions } : line
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

/** Whether an unattended review may close by itself, as far as the Swarm alone can tell: the work it reviews is done or
 *  cancelled, it links, or that work links, a pull request, and it has been quiet for ARCHIVE_QUIET_MS. That each of those pull requests is merged or
 *  closed, and that no decision waits there, the caller checks (archive.ts, store.ts archiveFinished). */
export function reviewClosable(state: SuperTabState, review: Conversation, now: number): boolean {
  if (state.tidy === false || review.archived || review.kind || review.audience || !unattendedReview(review)) return false
  if (!taskEnded(state, review)) return false
  if (projectsOf(state).some(p => p.leadConversationId === review.id)) return false
  if (!reviewPullRequests(state, review).length) return false
  const last = time(review.lastActivityAt)
  return last !== undefined && now - last >= ARCHIVE_QUIET_MS
}

const pullNumber = (url: string) => `#${url.slice(url.lastIndexOf('/') + 1)}`

/** The one quiet line a closed review gets, naming each pull request and how it ended. */
export function reviewCloseLine(state: SuperTabState, review: Conversation, settled: Readonly<Record<string, SettledPullRequest>>, now: number): MessageDraft | null {
  const prs = reviewPullRequests(state, review).map(url => `${pullNumber(url)} ${settled[url] === 'missing' ? 'not found' : settled[url]}`).join(', ')
  return leadLine(state, review, now, `Closed: ${prs}; no Swarm review is needed now.`)
}

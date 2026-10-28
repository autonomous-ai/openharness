import { githubRepository } from '../github/repository.js'
import { activeWork, agentRole, nextConversationNumber, renderWorkTask, stableId, type Agent, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, groupProject, skillSetOf } from './projects.js'
import { recordAsked, recordRun } from './leaderboard/record.js'
import { renewLease } from './liveness.js'

// Reviews start the moment work is ready (Dee, 2026-10-28). The Lead hand-opened about 30 review groups that day, and one
// review request sat unanswered until its group was archived, so a privacy fix waited hours with no verdict. Now an
// Engineer's Ready for review that links a pull request of the project's repository opens the review in the same write,
// with a free Reviewer when there is one. Starting a new Reviewer stays with the Lead: routing reads the Lead machine's
// list and capacity (cli superTabs/routeCommand.ts), which a write here cannot (ruling in #610's plan).

/** The one check every review group carries. */
export const VERDICT_CHECK = 'Verdict with the reviewed revision'
/** Work that touches who can see or reach what is reviewed for that first. */
const PRIVACY = /\b(privacy|private|shar(e|es|ed|ing)|access|permissions?|confidential(ity)?|audiences?|visibility|credentials?|secrets?)\b/i
const PULL = /https:\/\/github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/pull\/[1-9][0-9]*\b/g
/** What of the Engineer's handoff a brief keeps: conversation.create takes briefs up to 8,000 characters. */
const HANDOFF_CHARS = 5000

/** The first pull request [text] links in [group]'s project repository; null when it links none there. */
export function projectPullRequest(state: SuperTabState, group: Conversation, text: string | null): string | null {
  const repository = githubRepository(groupProject(state, group).repository?.repositoryUrl)
  if (!repository || !text) return null
  for (const match of text.matchAll(PULL)) if (`${match[1]}/${match[2]}`.toLowerCase() === repository.fullName.toLowerCase()) return match[0]
  return null
}

/** A review group whose Reviewer has given no verdict (no check carries evidence) and that nobody cancelled. */
const verdictMissing = (group: Conversation): boolean =>
  !!group.reviewOf && group.assignment?.status !== 'cancelled' && !group.checks.some(c => c.evidence)

/** A review of [group] that is still open: not archived, not cancelled and with no verdict yet. */
export const openReviewOf = (state: SuperTabState, group: Conversation): Conversation | undefined =>
  state.conversations.find(c => c.reviewOf === group.id && !c.archived && verdictMissing(c))

/** A review that may not be archived, by hand or by itself: no verdict, not cancelled, and the work it reviews still going.
 *  Once that work is done or cancelled the review is moot. A review with no Reviewer has no assignment to cancel, so that
 *  is its way out (ruling in #610). */
export const verdictPending = (state: SuperTabState, review: Conversation): boolean => {
  const reviewed = review.reviewOf ? state.conversations.find(c => c.id === review.reviewOf) : undefined
  return verdictMissing(review) && !!reviewed && activeWork(reviewed)
}

const free = (state: SuperTabState, agent: Agent) =>
  !state.conversations.some(c => c.leadId === agent.id || (activeWork(c) && c.assignment!.agentId === agent.id))

/**
 * The Reviewer for [group]'s review: the one that reviewed its earlier head while it is still free (a delta review), else
 * a free Reviewer of the project, one on another engine than the Engineer's first. Never one that is stopping, waiting to
 * resume a lost task, or (`mayWork`) not allowed to take this project's work on its machine.
 */
function pickReviewer(state: SuperTabState, group: Conversation, engineer: Agent | undefined, earlier: Conversation | undefined,
  mayWork: (agent: Agent) => boolean): Agent | null {
  const projectId = groupProject(state, group).id
  const candidates = state.agents.filter(a => agentRole(a) === 'reviewer' && agentProjectId(state, a) === projectId &&
    a.workDecision !== 'stop' && !a.lostTask && free(state, a) && mayWork(a))
  const previous = candidates.find(a => a.id === earlier?.assignment?.agentId)
  return previous ?? candidates.find(a => a.configuration.engine !== engineer?.configuration.engine) ?? candidates[0] ?? null
}

function briefOf(group: Conversation, handoff: string, pullRequest: string, earlier: Conversation | undefined): string {
  const task = group.task
  const privacy = PRIVACY.test([task ? renderWorkTask(task) : group.brief, handoff].join('\n'))
  const kept = handoff.length > HANDOFF_CHARS ? `${handoff.slice(0, HANDOFF_CHARS)}… (the rest is in #${group.number})` : handoff
  return [
    ...privacy ? ['Privacy first: this work touches sharing, access or confidentiality. Check who can see or reach what before anything else.'] : [],
    `Give an independent verdict on the Engineer's revision of #${group.number} ${group.title}. Read only; do not change the code.`,
    ...earlier ? [`Delta review: #${earlier.number} reviewed the earlier head. Review only the changes since.`] : [],
    `The reviewed work:\n${task ? renderWorkTask(task) : group.brief}`,
    `Its acceptance checks:\n${group.checks.map(c => `- ${c.description}`).join('\n')}`,
    `The Engineer's handoff:\n${kept}`,
    `Pull request: ${pullRequest}`,
    `Pass #${group.number}'s independent check with your verdict and the revision you reviewed.`,
  ].join('\n\n')
}

export interface OpenedReview { review: Conversation; reviewer: Agent | null; messages: MessageDraft[] }

/**
 * Opens [group]'s review after its Engineer marked it ready with [handoff], which links [pullRequest]: a "Review: <title>"
 * group reviewing it, assigned to a free Reviewer that also joins [group] so it can pass the independent check, and one
 * line to the Lead, who can cancel it. With no free Reviewer the review waits, and the line asks the Lead to start one.
 * Rows are written by [author], the Engineer, as system rows.
 */
export function openReview(state: SuperTabState, group: Conversation, handoff: string, pullRequest: string,
  context: { operationId: string; now: number; author: Author; mayWork: (agent: Agent) => boolean }): OpenedReview | null {
  const project = groupProject(state, group)
  // On Custom skills without a reviewer role there are no review groups (commands.ts requireCustomRole).
  if (state.paused || (skillSetOf(project) === 'custom' && !project.roles?.some(r => r.kind === 'reviewer'))) return null
  const earlier = state.conversations.filter(c => c.reviewOf === group.id && c.assignment).sort((a, b) => (b.number ?? 0) - (a.number ?? 0))[0]
  const engineer = state.agents.find(a => a.id === group.assignment?.agentId)
  const reviewer = pickReviewer(state, group, engineer, earlier, context.mayWork)
  const id = stableId(context.operationId, 'auto-review')
  const number = nextConversationNumber(state)
  state.groupCounter = number
  const brief = briefOf(group, handoff, pullRequest, earlier)
  const leadId = group.leadId
  const review: Conversation = { id, ...(group.projectId ? { projectId: group.projectId } : {}), number, title: `Review: ${group.title}`.slice(0, 160),
    leadId, agentIds: leadId ? [leadId] : [], archived: false, brief, reviewOf: group.id, assignment: null, lastMessageSequence: 0,
    checks: [{ description: VERDICT_CHECK, independent: false, id: stableId(id, '0'), evidence: null, passedBy: null }] }
  state.conversations.push(review)
  recordAsked(review, group.requesterId, context.now)
  const row = (key: string, text: string, recipients: string[]): MessageDraft => ({ id: stableId(context.operationId, 'auto-review', key),
    conversationId: id, author: context.author, text, replyTo: null, recipients, source: { kind: 'auto-review', reviewOf: group.id } })
  const messages = [row('brief', brief, [])]
  if (reviewer) {
    review.agentIds.push(reviewer.id)
    if (!group.agentIds.includes(reviewer.id)) group.agentIds.push(reviewer.id)
    delete reviewer.workDecision
    delete reviewer.releaseId
    review.assignment = { id: stableId(id, 'assignment'), agentId: reviewer.id, status: 'working', configuration: structuredClone(reviewer.configuration),
      execution: { machineId: reviewer.machineId, harnessId: reviewer.harnessId, machineOwnerId: reviewer.machineOwnerId }, result: null }
    renewLease(review.assignment, context.now)
    recordRun(state, review, review.assignment, reviewer, context.now)
    messages.push(row('assign', `${brief}\n\nAcceptance checks:\n- ${VERDICT_CHECK}`, [reviewer.id]))
  }
  const name = reviewer && (reviewer.displayName ?? reviewer.name)
  if (leadId) messages.push(row('lead', reviewer
    ? `Review opened by itself for #${group.number}: ${name} reviews it. Cancel it here if it is not needed.`
    : `Review opened by itself for #${group.number}, but no Reviewer is free. Route it and start one.`, [leadId]))
  return { review, reviewer, messages }
}

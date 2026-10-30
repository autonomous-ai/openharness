import { githubRepository } from '../github/repository.js'
import { agentDisplayName } from './agentNames.js'
import { activeWork, agentRole, finishWorker, forRecipients, nextConversationNumber, renderWorkTask, reviewsWanted, stableId, type Agent, type Author, type Conversation, type MessageDraft, type ReviewStamp, type SuperTabState } from './model.js'
import { agentProjectId, groupProject, skillSetOf } from './projects.js'
import { recordAsked, recordRun } from './leaderboard/record.js'
import { renewLease } from './liveness.js'
import { downSince } from './machines.js'
import { canStart, standing } from './reviewSeats.js'

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

/** Whether a Reviewer gave [group]'s verdict: one of its checks carries evidence. */
const verdictGiven = (group: Conversation): boolean => group.checks.some(c => c.evidence)

/** A review group whose Reviewer has given no verdict and that nobody cancelled. */
const verdictMissing = (group: Conversation): boolean =>
  !!group.reviewOf && group.assignment?.status !== 'cancelled' && !verdictGiven(group)

/** The hand-over of [group]'s work a review opened now reviews: only for a task wanting two reviews, whose done counts
 *  passes per hand-over (model.ts reviewsPassed). */
export function reviewStampOf(group: Conversation): ReviewStamp | undefined {
  return reviewsWanted(group.task) > 1 && group.assignment ? { assignmentId: group.assignment.id, handoff: group.assignment.handoffs ?? 0 } : undefined
}
const sameStamp = (a: ReviewStamp | undefined, b: ReviewStamp | undefined) => !!a && !!b && a.assignmentId === b.assignmentId && a.handoff === b.handoff

/** The review of [build] that [agentId] holds, its newest: the one its verdicts on [build]'s independent checks come through. */
export const reviewHeldBy = (state: SuperTabState, build: Conversation, agentId: string): Conversation | undefined =>
  state.conversations.filter(c => c.reviewOf === build.id && c.assignment?.agentId === agentId).sort((a, b) => (b.number ?? 0) - (a.number ?? 0))[0]

/** A verdict that says it passes. Reviewers often pass their review's own check only to say a verdict was given, whatever it
 *  was, so the words decide: a review passes only when they say so (review 4 of #2382: "Not ready", "Request changes" and
 *  "Blocked" each read as a pass when only Hold words were looked for). */
const PASS = /\b(no findings?|pass(es|ed)?|ready:\s*yes|approved?|approves)\b/i
/** Words that take a pass back even beside a pass word ("Ready: yes with fixes", "did not pass"). */
const NOT_PASS = /\b(hold|holds|held|not ready|ready:\s*(no|with fixes)|with fixes|request(s|ed)? changes|changes (needed|requested)|block(ed|s|ing|er)?|not pass(ed)?|did not|fail(s|ed)?)\b/i
/** Whether [review] gave a pass verdict: its own check passed, and its verdict says it passes; anything else is not yet. */
export const reviewPassed = (review: Conversation): boolean =>
  review.checks.some(c => c.passedBy && c.evidence && PASS.test(c.evidence) && !NOT_PASS.test(c.evidence))

/** The hand-over a pass on [build] through [review] counts for: the review's own, once the review gave a pass verdict, while
 *  it still reviews [build]'s current attempt and was not closed; else -1, never counted. A pass on the work given while
 *  [review] was open counts once that review passes; its Hold clears it (commands.ts work.check). A late pass on head 1 was
 *  carried to head 2 when the Reviewer held head 2 (reviews of #2382). */
export function verdictHandoff(build: Conversation, review: Conversation): number {
  const stamp = review.reviewStamp
  return stamp && stamp.assignmentId === build.assignment?.id && review.assignment?.status !== 'cancelled' && reviewPassed(review) ? stamp.handoff : -1
}

/** The Reviewers whose review of [build]'s last hand-over is open or given but whose pass on the work does not count yet:
 *  who must still pass it, as a refused done says. */
export function reviewersToPass(state: SuperTabState, build: Conversation): string[] {
  const stamp = reviewStampOf(build), verdicts = build.assignment?.verdicts ?? []
  if (!stamp) return []
  return state.conversations.filter(c => c.reviewOf === build.id && sameStamp(c.reviewStamp, stamp) && c.assignment && c.assignment.status !== 'cancelled')
    .map(c => state.agents.find(a => a.id === c.assignment!.agentId))
    .filter((a): a is Agent => !!a && !verdicts.some(v => v.by === `agent:${a.id}` && v.passed && v.handoff === stamp.handoff))
    .map(a => a.displayName ?? a.name)
}

/**
 * Closes [group]'s open reviews left on an earlier hand-over when its Engineer hands over a new head, so each of the two
 * reviews its task wants opens again for this one (review of #2382: a Reviewer still on head 1 passed, and it counted for
 * head 2). One with a Reviewer is cancelled and its Reviewer told; one nobody took yet just moves to this hand-over.
 */
export function supersedeReviews(state: SuperTabState, group: Conversation, operationId: string, author: Author): MessageDraft[] {
  const stamp = reviewStampOf(group)
  if (!stamp) return []
  const messages: MessageDraft[] = []
  for (const review of openReviewsOf(state, group).filter(r => !sameStamp(r.reviewStamp, stamp))) {
    if (!review.assignment) { review.reviewStamp = stamp; continue }
    const reviewer = review.assignment.agentId, ended = !activeWork(review)
    review.assignment.status = 'cancelled'
    review.assignment.result = `#${group.number} handed over a new revision.`
    if (!ended) finishWorker(state, reviewer, review)
    messages.push({ id: stableId(operationId, 'auto-review', 'superseded', review.id), conversationId: review.id, author, replyTo: null,
      recipients: ended ? [] : [reviewer], source: forRecipients({ kind: 'auto-review', reviewOf: group.id }),
      text: `#${group.number} handed over a new revision, so this review is closed and its verdict no longer counts. A new review opens for the new revision. Stop working on this one.` })
  }
  return messages
}

/** Whether the Swarm opens reviews for [group] by itself: not while paused, nor on Custom skills without a reviewer role
 *  (commands.ts requireCustomRole). */
export function opensReviews(state: SuperTabState, group: Conversation): boolean {
  const project = groupProject(state, group)
  return !state.paused && !(skillSetOf(project) === 'custom' && !project.roles?.some(r => r.kind === 'reviewer'))
}

/** The reviews of [group] still open: not archived, not cancelled and with no verdict yet, oldest first. */
export const openReviewsOf = (state: SuperTabState, group: Conversation): Conversation[] =>
  state.conversations.filter(c => c.reviewOf === group.id && !c.archived && verdictMissing(c))

/** A review of [group] that is still open while it has every review its task wants: another one, by itself or by hand, waits
 *  until one closes (commands.ts conversation.create). A task wanting two independent reviews has room for a second one
 *  beside the first, so the Lead needs no holder group for it (nightly reflection 10-30). */
export const fullReviewOf = (state: SuperTabState, group: Conversation): Conversation | undefined => {
  const open = openReviewsOf(state, group)
  return open.length >= reviewsWanted(group.task) ? open[0] : undefined
}

/** A review that may not be archived, by hand or by itself: no verdict, not cancelled, and the work it reviews still going.
 *  Once that work is done or cancelled the review is moot. A review with no Reviewer has no assignment to cancel, so that
 *  is its way out (ruling in #610). */
export const verdictPending = (state: SuperTabState, review: Conversation): boolean => {
  const reviewed = review.reviewOf ? state.conversations.find(c => c.id === review.reviewOf) : undefined
  return verdictMissing(review) && !!reviewed && activeWork(reviewed)
}

const free = (state: SuperTabState, agent: Agent) =>
  !state.conversations.some(c => c.leadId === agent.id || (activeWork(c) && c.assignment!.agentId === agent.id))

/** Whether [agent] cannot work now: a usage limit holds it, or its machine reports readings by which its engine could not start
 *  (reviewSeats.ts standing). A machine with no readings (a host outside the contributions) is judged by the limit alone. */
function unable(state: SuperTabState, agent: Agent, now: number): boolean {
  if (agent.limitedUntil && Date.parse(agent.limitedUntil) > now) return true
  const pool = state.machines?.find(m => m.machineId === agent.machineId)
  return !!pool && !canStart(standing(state, pool, agent.configuration.engine, now))
}

/**
 * The Reviewer for [group]'s review: the one that reviewed its earlier head while it is still free (a delta review), else
 * the strongest free Reviewer of the project ([strength]), of any engine (Ken, 2026-10-30), so one at least as strong as the
 * Engineer goes first, as the CLI's route holds a Reviewer to the Builder's strength (review of #2274). Never one that is
 * stopping, waiting to resume a lost task, down (its session gone or its machine silent), [unable] to work now (held by a usage
 * limit, or its machine reports its engine out of quota, signed out, suspended or paused: review of #2313, as ties at the top
 * tier are common and an idle Codex Reviewer out of quota came first), or (`mayWork`) not allowed to take this work: on its
 * machine, by the owner's rules (#610 review), or as the review rule (rules.ts reviewRefusal) has it.
 */
function pickReviewer(state: SuperTabState, group: Conversation, engineer: Agent | undefined, earlier: readonly string[],
  taken: ReadonlySet<string>, mayWork: (agent: Agent) => boolean, strength: (agent: Agent) => number, now: number): Agent | null {
  const projectId = groupProject(state, group).id
  // `taken`: the Reviewers of its other open reviews, and of one just opened beside this one: two reviews never share one.
  const candidates = state.agents.filter(a => a.id !== engineer?.id && !taken.has(a.id) && agentRole(a) === 'reviewer' && agentProjectId(state, a) === projectId &&
    a.workDecision !== 'stop' && !a.lostTask && !downSince(state, a, now) && !unable(state, a, now) && free(state, a) && mayWork(a))
  const previous = earlier.map(id => candidates.find(a => a.id === id)).find(a => a)
  // Strongest first; at equal strength the roster's order stands (sort is stable).
  return previous ?? [...candidates].sort((a, b) => strength(b) - strength(a))[0] ?? null
}

/** [lane] of [lanes]: which of a task's independent reviews this is, when it wants more than one. */
function briefOf(group: Conversation, handoff: string, pullRequest: string, earlier: Conversation | undefined, lane: { index: number; of: number }): string {
  const task = group.task
  const privacy = PRIVACY.test([task ? renderWorkTask(task) : group.brief, handoff].join('\n'))
  const kept = handoff.length > HANDOFF_CHARS ? `${handoff.slice(0, HANDOFF_CHARS)}… (the rest is in #${group.number})` : handoff
  // The focus leads the brief, so it is not repeated in the task below it.
  const focus = task?.review?.focus
  const work = task ? renderWorkTask({ ...task, review: undefined }) : group.brief
  return [
    ...privacy ? ['Privacy first: this work touches sharing, access or confidentiality. Check who can see or reach what before anything else.'] : [],
    ...focus ? [`Review focus:\n${focus}`] : [],
    `Give an independent verdict on the Engineer's revision of #${group.number} ${group.title}. Read only; do not change the code.`,
    ...lane.of > 1 ? [`Independent review ${lane.index + 1} of ${lane.of}: another Reviewer reviews this work separately. Reach your own verdict without reading theirs.`] : [],
    ...earlier ? [`Delta review: #${earlier.number} reviewed the earlier head. Review only the changes since.`] : [],
    `The reviewed work:\n${work}`,
    `Its acceptance checks:\n${group.checks.map(c => `- ${c.description}`).join('\n')}`,
    `The Engineer's handoff:\n${kept}`,
    `Pull request: ${pullRequest}`,
    `Pass #${group.number}'s independent check with your verdict and the revision you reviewed.`,
  ].join('\n\n')
}

/** Who writes the Swarm's own review rows in [group]: its project's Lead, or [fallback] in a group with no Lead. */
export function swarmAuthor(state: SuperTabState, group: Conversation, fallback: Author): Author {
  const lead = state.agents.find(a => a.id === group.leadId)
  return lead ? { kind: 'agent', id: lead.id, name: lead.name, displayName: agentDisplayName(state.agents, lead.id), membershipGeneration: lead.membershipGeneration } : fallback
}

export interface OpenedReview { reviews: { review: Conversation; reviewer: Agent | null }[]; messages: MessageDraft[] }

/**
 * Opens [group]'s reviews after its Engineer marked it ready with [handoff], which links [pullRequest]: as many as its task
 * wants beyond those still open (one, or two for a task wanting two independent reviews). Each is a "Review: <title>" group
 * (the second "Second review: <title>") reviewing it, assigned to a free Reviewer that also joins [group] so it can pass the
 * independent check, never the Reviewer of another open review of it, and one line to the Lead, who can cancel it. With no
 * free Reviewer a review waits, and the line asks the Lead to start one. Its rows are the Swarm's own: written as the
 * project's Lead with an auto-review source, as its lost-task and failed-start notices are (liveness.ts), never as the
 * Engineer (#610 review); [engineer] writes them only in a group with no Lead.
 */
export function openReview(state: SuperTabState, group: Conversation, handoff: string, pullRequest: string,
  context: { operationId: string; now: number; engineer: Author; mayWork: (agent: Agent) => boolean; strength: (agent: Agent) => number }): OpenedReview | null {
  if (!opensReviews(state, group)) return null
  const open = openReviewsOf(state, group), wanted = reviewsWanted(group.task)
  if (open.length >= wanted) return null
  // Only a review that gave its verdict reviewed an earlier head: one cancelled before it reviewed nothing (#610 review).
  const verdicts = state.conversations.filter(c => c.reviewOf === group.id && c.assignment && verdictGiven(c)).sort((a, b) => (b.number ?? 0) - (a.number ?? 0))
  // The Reviewers of the latest heads, one per review the task wants, newest first: each review goes back to one of them.
  const earlier = [...new Set(verdicts.map(c => c.assignment!.agentId))].slice(0, wanted)
  const taken = new Set(open.flatMap(c => c.assignment ? [c.assignment.agentId] : []))
  const engineer = state.agents.find(a => a.id === group.assignment?.agentId)
  const leadId = group.leadId
  const author = swarmAuthor(state, group, context.engineer)
  const stamp = reviewStampOf(group)
  const opened: OpenedReview = { reviews: [], messages: [] }
  for (let index = open.length; index < wanted; index++) {
    // The first keeps the ids a one-review task always had, so a retried write finds the same rows.
    const lane = index === open.length ? [] : [String(index + 1)]
    const reviewer = pickReviewer(state, group, engineer, earlier, taken, context.mayWork, context.strength, context.now)
    if (reviewer) taken.add(reviewer.id)
    const previous = (reviewer && earlier.includes(reviewer.id) && verdicts.find(c => c.assignment!.agentId === reviewer.id)) || verdicts[0]
    const id = stableId(context.operationId, 'auto-review', ...lane)
    const number = nextConversationNumber(state)
    state.groupCounter = number
    const brief = briefOf(group, handoff, pullRequest, previous, { index, of: wanted })
    const review: Conversation = { id, ...(group.projectId ? { projectId: group.projectId } : {}), number,
      title: `${index ? 'Second review' : 'Review'}: ${group.title}`.slice(0, 160),
      leadId, agentIds: leadId ? [leadId] : [], archived: false, brief, reviewOf: group.id, ...(stamp ? { reviewStamp: stamp } : {}), assignment: null, lastMessageSequence: 0,
      checks: [{ description: VERDICT_CHECK, independent: false, id: stableId(id, '0'), evidence: null, passedBy: null }] }
    state.conversations.push(review)
    recordAsked(review, group.requesterId, context.now)
    const row = (key: string, text: string, recipients: string[], source: Record<string, unknown> = { kind: 'auto-review', reviewOf: group.id }): MessageDraft =>
      ({ id: stableId(context.operationId, 'auto-review', key, ...lane), conversationId: id, author, text, replyTo: null, recipients, source })
    opened.messages.push(row('brief', brief, []))
    if (reviewer) {
      review.agentIds.push(reviewer.id)
      if (!group.agentIds.includes(reviewer.id)) group.agentIds.push(reviewer.id)
      delete reviewer.workDecision
      delete reviewer.releaseId
      review.assignment = { id: stableId(id, 'assignment'), agentId: reviewer.id, status: 'working', configuration: structuredClone(reviewer.configuration),
        execution: { machineId: reviewer.machineId, harnessId: reviewer.harnessId, machineOwnerId: reviewer.machineOwnerId }, result: null }
      renewLease(review.assignment, context.now)
      recordRun(state, review, review.assignment, reviewer, context.now)
      opened.messages.push(row('assign', `${brief}\n\nAcceptance checks:\n- ${VERDICT_CHECK}`, [reviewer.id]))
    }
    const name = reviewer && (reviewer.displayName ?? reviewer.name)
    const which = wanted > 1 ? ` (independent review ${index + 1} of ${wanted})` : ''
    if (leadId) opened.messages.push(row('lead', reviewer
      ? `Review opened by itself for #${group.number}${which}: ${name} reviews it. Cancel it here if it is not needed.`
      : `Review opened by itself for #${group.number}${which}, but no Reviewer is free. Route it and start one.`, [leadId],
      // The Lead's wake, its alone (review of #2225): people read the review's brief and its status.
      forRecipients({ kind: 'auto-review', reviewOf: group.id })))
    opened.reviews.push({ review, reviewer })
  }
  return opened
}

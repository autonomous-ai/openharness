/**
 * A task whose own merge is recorded is finished work (task #4032, Stepos 11-06): the lane dispatch handed out lost tasks
 * already merged (#3819 9 minutes after PR #3384 merged, #3818 52 minutes after PR #3383), each time an agent spent only to set
 * the task done, and their steps were revived the same way. Such a task is never handed out again (dispatch.ts openTasks); a
 * lost one is set done by the sweep (liveness.ts sweepLiveness), as the merge record sets done one whose builder is gone
 * (commands.ts conversation.merged), and its open steps close with it.
 */
import { recordStatus } from './leaderboard/record.js'
import { codePullRequests, stableId, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { endSteps, isStep, stepEndedRows, stepsOf } from './steps.js'

/** What a step of a merged task is told, and keeps as its result. */
export const STEP_MERGED = 'Its task merged, so this step is closed.'

/** The pull request of [group]'s own code whose merge is recorded, or undefined: a card of one of its code pull requests with a
 *  merge on it, never one only a merge record linked (cards.recorded: a merge of another task's pull request, Aster, #3259). */
export function ownMerge(group: Pick<Conversation, 'cards' | 'codePullRequestUrls' | 'pullRequestUrls'>): string | undefined {
  const code = new Set(codePullRequests(group)), recorded = new Set(group.cards?.recorded ?? [])
  return group.cards?.pullRequests?.find(card => card.mergedAt !== undefined && code.has(card.url) && !recorded.has(card.url))?.url
}

/** Ends [task]'s open steps with its merge: a working one as endSteps ends it, and a lost one too, which nobody takes now. The
 *  steps it ended, whose agents the caller tells (stepEndedRows). */
export function endStepsMerged(state: SuperTabState, task: Conversation): Conversation[] {
  const ended = endSteps(state, task, STEP_MERGED, false)
  for (const step of stepsOf(state, task.id)) {
    if (step.archived || step.assignment?.status !== 'lost') continue
    Object.assign(step.assignment, { status: 'cancelled', result: STEP_MERGED })
    ended.push(step)
  }
  return ended
}

/**
 * Sets [task] done with its merge of [url] as its result, its builder being gone, and ends its open steps: the rows that say so,
 * written as [author], one id each from [id]. The caller closes the attempt (effects.closedAssignment, or the store's endRuns).
 */
export function closeMerged(state: SuperTabState, task: Conversation, url: string, now: number, author: Author | null, id: (part: string) => string,
  messageId: string | null = null): MessageDraft[] {
  const assignment = task.assignment!
  const previous = assignment.status
  assignment.status = 'done'
  assignment.result = `Merged ${url}. Its builder is no longer running, so the recorded merge closes the task.`
  delete assignment.hold
  delete assignment.askedOf
  recordStatus(task, assignment, previous, now, messageId)
  const steps = endStepsMerged(state, task)
  const done: MessageDraft[] = author ? [{ id: id('merged-done'), conversationId: task.id, author, text: `Done\n\n${assignment.result}`, replyTo: null,
    recipients: [], source: { kind: 'system', status: 'done' } }] : []
  return [...done, ...stepEndedRows(state, steps, STEP_MERGED, author, step => id(`merged-step-${step.id}`))]
}

/** The lost tasks whose own merge is recorded, set done (closeMerged), each written as [authorOf] it; their rows. */
export function closeMergedLost(state: SuperTabState, now: number, authorOf: (task: Conversation) => Author | null): MessageDraft[] {
  return state.conversations.flatMap(task => {
    if (task.archived || isStep(task) || task.assignment?.status !== 'lost') return []
    const url = ownMerge(task)
    return url ? closeMerged(state, task, url, now, authorOf(task), part => stableId('merged-lost', task.assignment!.id, part)) : []
  })
}

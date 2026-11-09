/**
 * A task whose own merge is recorded is finished work (task #4032, Stepos 11-06): the lane dispatch handed out lost tasks
 * already merged (#3819 9 minutes after PR #3384 merged, #3818 52 minutes after PR #3383), each time an agent spent only to set
 * the task done, and their steps were revived the same way. Such a task is never handed out again (dispatch.ts openTasks); a
 * lost one is set done by the sweep (liveness.ts sweepLiveness), as the merge record sets done one whose builder is gone
 * (commands.ts conversation.merged), and its open steps close with it.
 */
import { recordStatus } from './leaderboard/record.js'
import { codePullRequests, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { endSteps, stepEndedRows, stepsOf } from './steps.js'

/** What a step of a merged task is told, and keeps as its result. */
export const STEP_MERGED = 'Its task merged, so this step is closed.'

/** The last of [group]'s own code pull requests when every one of them has its merge recorded on its card, or undefined. Its own:
 *  never one only a merge record linked (cards.recorded: a merge of another task's pull request, Aster, #3259). Every one: a task
 *  that ships in two pull requests is merged once both are, never while one is still open (security review 1 of #3438). */
export function ownMerge(group: Pick<Conversation, 'cards' | 'codePullRequestUrls' | 'pullRequestUrls'>): string | undefined {
  const recorded = new Set(group.cards?.recorded ?? [])
  const own = codePullRequests(group).filter(url => !recorded.has(url))
  const merged = (url: string) => !!group.cards?.pullRequests?.some(card => card.url === url && card.mergedAt !== undefined)
  return own.length && own.every(merged) ? own.at(-1) : undefined
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

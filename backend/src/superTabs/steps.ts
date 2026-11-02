/**
 * Steps inside a task (design docs/plans/2026-11-02-task-steps-design.md). A step is a linked group (`reviewOf` names its
 * task) with a name the project's instructions give: it keeps its own assignment, lease, attempts and costs, and readers
 * show it inside its task. Nothing here reads a step's name: which steps a task has is the instructions' to say.
 */
import { activeWork, finishWorker, type Conversation, type SuperTabState } from './model.js'

/** Whether [group] is a step of a task: any linked group, named or not. Ken, 2026-11-02: a PM that opened "Test: PR #2514"
 *  the old way, a minute after saving the steps workflow, still heard every Tester post; what reaches the PM must not rest on
 *  an agent remembering the workflow. */
export const isStep = (group: Pick<Conversation, 'reviewOf'>): boolean => !!group.reviewOf

/** A step's name: the one it was opened with, else its title (a linked group opened without one). */
export const stepName = (group: Pick<Conversation, 'step' | 'title'>): string => group.step ?? group.title

/** The steps of task [taskId], in creation order. */
export const stepsOf = (state: SuperTabState, taskId: string): Conversation[] =>
  state.conversations.filter(c => c.reviewOf === taskId)

/** Ends [task]'s steps with it, in the same write. An open one is cancelled with [reason] as its result and its agent
 *  freed; it stays unarchived, as an archived conversation takes no delivery (store.ts deliveryAllowed) and its agent is
 *  told there, and it sleeps with its task. With [archive], a finished one is archived with its task: without that, a
 *  `done` step with no pull request of its own was archived within one archive pass (`settled([])`), and a second round on
 *  it failed ARCHIVED. Returns the cancelled ones, whose agents the caller tells. */
export function endSteps(state: SuperTabState, task: Conversation, reason: string, archive: boolean): Conversation[] {
  const cancelled: Conversation[] = []
  for (const step of stepsOf(state, task.id)) {
    if (step.archived) continue
    if (activeWork(step)) {
      Object.assign(step.assignment!, { status: 'cancelled', result: reason })
      finishWorker(state, step.assignment!.agentId)
      cancelled.push(step)
    } else if (archive) step.archived = true
  }
  return cancelled
}

/** Whether a step may sleep, given its task's row as the sweep read it (null: gone). A step sleeps once its task is
 *  archived, never on its own clock nor with a task that is only dormant: a dormant step drops out of the Swarm read with
 *  its verdict, and one asleep under a done task was not loaded when that task was archived later, so it stayed open in an
 *  archived task (final review, minor 5). */
export const stepSleeps = (task: { archived: boolean; dormant: boolean } | null): boolean => !task || task.archived
/** The task's owner for [step]: the agent assigned its task while that work is open, else null (the coordinator's then). */
export function taskOwner(state: SuperTabState, step: Conversation): string | null {
  const task = isStep(step) ? state.conversations.find(c => c.id === step.reviewOf) : undefined
  return task && activeWork(task) ? task.assignment!.agentId : null
}

/** Whether [agentId] holds an open step of task [taskId]. */
export const holdsStepOf = (state: SuperTabState, taskId: string, agentId: string): boolean =>
  stepsOf(state, taskId).some(s => activeWork(s) && s.assignment!.agentId === agentId)

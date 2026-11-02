/**
 * Steps inside a task (design docs/plans/2026-11-02-task-steps-design.md). A step is a linked group (`reviewOf` names its
 * task) with a name the project's instructions give: it keeps its own assignment, lease, attempts and costs, and readers
 * show it inside its task. Nothing here reads a step's name: which steps a task has is the instructions' to say.
 */
import { activeWork, finishWorker, type Conversation, type SuperTabState } from './model.js'

/** Whether [group] is a step of a task (an older linked group, with no name, is not). */
export const isStep = (group: Pick<Conversation, 'step' | 'reviewOf'>): boolean => !!group.step && !!group.reviewOf

/** The steps of task [taskId], in creation order. */
export const stepsOf = (state: SuperTabState, taskId: string): Conversation[] =>
  state.conversations.filter(c => c.reviewOf === taskId && !!c.step)

/** Archives every step of [task] with it, in the same write. An open one is cancelled first, with [reason] as its result,
 *  and its agent freed; those are returned so the caller tells their agents. Without this a `done` step with no pull
 *  request of its own was archived within one archive pass (`settled([])`), and a second round on it failed ARCHIVED. */
export function closeSteps(state: SuperTabState, task: Conversation, reason: string): Conversation[] {
  const cancelled: Conversation[] = []
  for (const step of stepsOf(state, task.id)) {
    if (step.archived) continue
    if (activeWork(step)) {
      Object.assign(step.assignment!, { status: 'cancelled', result: reason })
      finishWorker(state, step.assignment!.agentId)
      cancelled.push(step)
    }
    step.archived = true
  }
  return cancelled
}

/** Whether a step may sleep, given its task's row as the sweep read it (null: gone). A step sleeps with its task, never on
 *  its own clock: a dormant step drops out of the Swarm read, and its verdict with it. */
export const stepSleeps = (task: { archived: boolean; dormant: boolean } | null): boolean => !task || task.archived || task.dormant

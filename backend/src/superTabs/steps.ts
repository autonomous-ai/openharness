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
/** The agent that owns [task]: its assignee while that agent is in the Swarm, its own work done or not, else null (the
 *  coordinator's then). Ken, 2026-11-02: a Builder set its task done before its Tester's verdict, and the verdict reached
 *  the PM; the verdict is still the Builder's to act on. */
export function ownerOf(state: SuperTabState, task: Conversation): string | null {
  const agentId = task.assignment?.agentId
  return agentId && state.agents.some(a => a.id === agentId) ? agentId : null
}

/** The task's owner for [step] (ownerOf its task), or null. */
export function taskOwner(state: SuperTabState, step: Conversation): string | null {
  const task = isStep(step) ? state.conversations.find(c => c.id === step.reviewOf) : undefined
  return task ? ownerOf(state, task) : null
}

/** Whether [agentId] holds or held a step of task [taskId], open or finished: its posts there are about that step's work
 *  (Ken, 2026-11-02: a Reviewer's "both re-checks pass", after its step was done, reached the PM). */
export const holdsStepOf = (state: SuperTabState, taskId: string, agentId: string): boolean =>
  stepsOf(state, taskId).some(s => s.assignment?.agentId === agentId)

/** Whether [agentId] has held steps only, never a task, in the groups loaded: a Reviewer or Tester the instructions keep,
 *  whatever its role is called, so its idle time is no news for the coordinator. */
export const onlyStepsHeld = (groups: readonly Conversation[], agentId: string): boolean => {
  const held = groups.filter(g => g.assignment?.agentId === agentId)
  return held.length > 0 && held.every(isStep)
}

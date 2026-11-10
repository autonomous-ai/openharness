/**
 * Steps inside a task (design docs/plans/2026-11-02-task-steps-design.md). A step is a linked group (`reviewOf` names its
 * task) with a name the project's instructions gave. Swarm v4 opens none (2026-11-10); a Swarm from before still stores some,
 * which the task readers that remain tell apart, and which end with their task, until they go with the task records (slice S13).
 */
import { agentDisplayName } from './agentNames.js'
import { activeWork, finishWorker, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'

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

/** The row each step endSteps cancelled keeps, in that step, for the agent whose work ended: [reason], as [author], or as that
 *  agent where none is given (a project with no Lead). One whose agent or its contributor has left the Swarm reaches nobody: a delivery to it would
 *  throw. With no author either, there is no row. */
export function stepEndedRows(state: SuperTabState, cancelled: Conversation[], reason: string, author: Author | null, id: (step: Conversation) => string): MessageDraft[] {
  return cancelled.flatMap(step => {
    // agent()'s own rule, without its throw: its contributor still here, at the generation it was shared under.
    const found = state.agents.find(a => a.id === step.assignment!.agentId)
    const agent = found && state.people.find(p => p.id === found.contributorId)?.generation === found.membershipGeneration ? found : undefined
    const by: Author | null = author ?? (agent ? { kind: 'agent', id: agent.id, name: agent.name, displayName: agentDisplayName(state.agents, agent.id), membershipGeneration: agent.membershipGeneration } : null)
    return by ? [{ id: id(step), conversationId: step.id, author: by, text: reason, replyTo: null, recipients: agent ? [agent.id] : [], source: { kind: 'system' } }] : []
  })
}

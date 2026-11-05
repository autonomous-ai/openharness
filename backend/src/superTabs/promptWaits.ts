/** A task's agent waiting at a prompt in its terminal, for the task's own people (task #3029). An agent that needs a person
 *  ("press Connect on the iPhone") often writes it only in its terminal; its host's prompt alert (terminal.ts terminalAlert)
 *  told the PM alone. Each person's read now lists the prompts that wait for them, under Decisions: the task's requester (a
 *  step's, the task it reviews), and its machine's owner when the task needs a device there. Derived from the live state on
 *  every read, never stored: a prompt's row goes when its alert ends, or its work does, and nothing is left to delete. */
import { agentDisplayName } from './agentNames.js'
import { isBuddy } from './buddies.js'
import { activeWork, type Actor, type Agent, type Conversation, type SuperTabState } from './model.js'
import { canReadGroup, groupProject } from './projects.js'

/** One waiting prompt as a person reads it: no screen text (a screen can show secrets); the person's app reads the agent's
 *  last lines through the terminal read, which checks who may (terminal.ts mayDrive). */
export interface PromptWait { agentId: string; agentName: string; conversationId: string; conversationTitle: string; projectId: string; projectName: string }

/** Whether [personId] is the person [group]'s task needs, for [target] working on it. */
function taskPerson(state: SuperTabState, group: Conversation, target: Agent, personId: string): boolean {
  // A step's person is its task's: whoever opened the step only asked for its review.
  const task = group.reviewOf ? state.conversations.find(c => c.id === group.reviewOf) ?? group : group
  if (task.requesterId === personId) return true
  // Someone's hands on a device plugged into this machine: its owner's, when the task names no other machine. A step is
  // opened without its task's requirements, so a Tester's step on a device task reads its task's.
  const requires = group.task?.requires?.devices?.length ? group.task.requires : task.task?.requires
  return target.machineOwnerId === personId && !!requires?.devices?.length && (!requires.machines?.length || requires.machines.includes(target.machineId))
}

/** The prompts that wait for [actor], a person: each agent of theirs at a prompt in the task it works on, in a task they read. */
export function promptWaits(state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>): PromptWait[] {
  if (!state.people.some(p => p.id === actor.userId)) return []
  const waiting = state.agents.filter(a => a.alerting?.includes('prompt') && !isBuddy(a))
  if (!waiting.length) return []
  return waiting.flatMap(target => {
    const group = state.conversations.find(c => activeWork(c) && c.assignment!.agentId === target.id)
    if (!group || !taskPerson(state, group, target, actor.userId) || !canReadGroup(state, actor, group)) return []
    const project = groupProject(state, group)
    return [{ agentId: target.id, agentName: agentDisplayName(state.agents, target.id) ?? target.name, conversationId: group.id,
      conversationTitle: group.title, projectId: project.id, projectName: project.name }]
  })
}

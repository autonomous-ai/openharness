/**
 * A task with its PM and Engineer, as a Swarm from before Swarm v4 stores one: shared by the tests that run commands and
 * sweeps on it (liveness.test.ts), so importing it never runs another file's tests. And the tasks and steps such a Swarm
 * still stores, which v4 no longer opens.
 */
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, nextConversationNumber, type Actor, type AgentConfiguration, type CommandEffects, type SuperTabState } from './model.js'
import { agentProjectId, groupProject } from './projects.js'
import { storedAssignment, storedTask, type StoredTask } from './storedWork.test-support.js'

export const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

/** A task, or a step or linked task naming the task it is on (`reviewOf`), as an agent or person opened it with
 *  conversation.create before Swarm v4 removed that command (slice S18): tasks are GitHub issues now. */
export interface StoredCreate extends Omit<StoredTask, 'requesterId' | 'creatorId'> {
  type: 'conversation.create'
  title: string
  checks: Array<{ description: string; independent?: boolean }>
  requesterId?: string
  reviewOf?: string
  step?: string
}

/** [command], opened before Swarm v4, stored in [state] as conversation.create stored it then. A task is asked by the person
 *  who opened it, unless it names who asked; an agent opens it in its own project, and is in it. A step is in its task's project, its opener in it
 *  and, for a named step, in its task too. Its answer as that command's was: the new conversation's id. */
export function storedCreate(state: SuperTabState, command: StoredCreate, actor: Actor): CommandEffects {
  if (!command.reviewOf) {
    const { type: _type, reviewOf: _reviewOf, step: _step, ...fields } = command
    // An agent's opens in its own project, as the command did when it named none.
    const opener = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId) : undefined
    const id = storedTask(state, { ...fields, projectId: command.projectId ?? (opener ? agentProjectId(state, opener) : undefined),
      requesterId: command.requesterId ?? (actor.kind === 'person' ? actor.userId : undefined), ...(opener ? { creatorId: opener.id } : {}) })
    return { state, result: { conversationId: id, number: state.groupCounter }, messages: [] } as unknown as CommandEffects
  }
  const task = state.conversations.find(c => c.id === command.reviewOf)!
  const project = groupProject(state, task)
  const leadId = state.conversations.find(c => c.id === project.leadConversationId)?.leadId ?? null
  const creator = actor.kind === 'agent' && actor.agentId !== leadId ? [actor.agentId] : []
  const number = nextConversationNumber(state)
  state.groupCounter = number
  const id = `stored-step-${number}`
  state.conversations.push({ id, ...(state.projects ? { projectId: project.id } : {}), number, title: command.title, leadId,
    agentIds: [...leadId ? [leadId] : [], ...creator], archived: false, brief: command.brief ?? '', reviewOf: task.id,
    ...(command.step ? { step: command.step } : {}),
    assignment: null, lastMessageSequence: 0,
    checks: command.checks.map((check, i) => ({ id: `${id}-check-${i}`, description: check.description, independent: check.independent ?? false, evidence: null, passedBy: null })) })
  if (command.step) for (const agentId of creator) if (!task.agentIds.includes(agentId)) task.agentIds.push(agentId)
  return { state, result: { conversationId: id, number }, messages: [] } as unknown as CommandEffects
}

/** Whether [command] opens a task or step, which a test stores as a Swarm from before Swarm v4 did (storedCreate). */
export const opensStored = (command: Command | StoredCreate): command is StoredCreate => command.type === 'conversation.create'

export function stepsFixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0, now = 1000
  const run = (command: Command | StoredCreate, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    if (opensStored(command)) return storedCreate(state, command, actor)
    const effects = applyCommand(state, actor, command, { now, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const add = (harnessId: string, group = 'lead', lead = false) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId,
    name: harnessId, configuration: config, lead }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const lead = add('pm', 'lead', true)
  const task = storedTask(state, { title: 'Fix login', brief: 'Sign in works offline.', checks: [{ description: 'Signs in offline', independent: true }],
    requesterId: 'owner', creatorId: lead })
  const dev = add('dev', task)
  storedAssignment(state, task, dev, now)
  const step = (name: string, actor: Actor = as(dev), on = task, checks: Array<{ description: string; independent: boolean }> = []) =>
    run({ type: 'conversation.create', title: name, brief: `${name} it.`, reviewOf: on, step: name, checks }, actor).result.conversationId as string
  const group = (id: string) => state.conversations.find(c => c.id === id)!
  return { run, add, as, lead, task, dev, step, group, tick: (ms: number) => { now += ms }, get now() { return now }, get state() { return state } }
}

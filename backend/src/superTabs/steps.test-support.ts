/**
 * A task with its PM and Engineer, opened through commands as a Swarm opens one: shared by the tests that run commands and
 * sweeps on it (liveness.test.ts), so importing it never runs another file's tests. And the steps a Swarm from before Swarm v4
 * still stores, which v4 no longer opens (conversation.create with `reviewOf` answers as retired).
 */
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, nextConversationNumber, type Actor, type AgentConfiguration, type CommandEffects, type SuperTabState } from './model.js'
import { groupProject } from './projects.js'

export const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

/** [command], a step or linked task an agent or person opened before Swarm v4, stored in [state] as conversation.create stored it
 *  then: in its task's project, with its task's Team-written mark, its opener in it and, for a named step, in its task too. Its
 *  answer as that command's was: the new step's id. */
export function storedStep(state: SuperTabState, command: Extract<Command, { type: 'conversation.create' }>, actor: Actor): CommandEffects {
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
    ...(task.teamWritten ? { teamWritten: true as const, ...task.teamWrittenBy ? { teamWrittenBy: structuredClone(task.teamWrittenBy) } : {} } : {}),
    assignment: null, lastMessageSequence: 0, codePullRequestUrls: [],
    checks: command.checks.map((check, i) => ({ id: `${id}-check-${i}`, description: check.description, independent: check.independent ?? false, evidence: null, passedBy: null })) })
  if (command.step) for (const agentId of creator) if (!task.agentIds.includes(agentId)) task.agentIds.push(agentId)
  return { state, result: { conversationId: id, number }, messages: [] } as unknown as CommandEffects
}

/** Whether [command] opens a step, which a test stores as a Swarm from before Swarm v4 did (storedStep). */
export const opensStep = (command: Command): command is Extract<Command, { type: 'conversation.create' }> =>
  command.type === 'conversation.create' && !!command.reviewOf

export function stepsFixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0, now = 1000
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    if (opensStep(command)) return storedStep(state, command, actor)
    const effects = applyCommand(state, actor, command, { now, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const add = (harnessId: string, group = 'lead', lead = false) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId,
    name: harnessId, configuration: config, lead }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const lead = add('pm', 'lead', true)
  const task = run({ type: 'conversation.create', title: 'Fix login', brief: 'Sign in works offline.',
    checks: [{ description: 'Signs in offline', independent: true }], priority: 'P2', requesterId: 'owner' }, as(lead)).result.conversationId as string
  const dev = add('dev', task)
  run({ type: 'work.assign', conversationId: task, agentId: dev }, as(lead))
  const step = (name: string, actor: Actor = as(dev), on = task, checks: Array<{ description: string; independent: boolean }> = []) =>
    run({ type: 'conversation.create', title: name, brief: `${name} it.`, reviewOf: on, step: name, checks } as Command, actor).result.conversationId as string
  const group = (id: string) => state.conversations.find(c => c.id === id)!
  return { run, add, as, lead, task, dev, step, group, tick: (ms: number) => { now += ms }, get now() { return now }, get state() { return state } }
}

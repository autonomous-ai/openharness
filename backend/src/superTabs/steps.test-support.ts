/**
 * A task with its PM and Engineer, opened through commands as a Swarm opens one (steps.test.ts): shared by the tests that run
 * commands and sweeps on it (liveness.test.ts), so importing it never runs another file's tests.
 */
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'

export const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

export function stepsFixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0, now = 1000
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const add = (harnessId: string, group = 'lead', lead = false) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId,
    name: harnessId, configuration: config, lead }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const lead = add('pm', 'lead', true)
  const task = run({ type: 'conversation.create', title: 'Fix login', brief: 'Sign in works offline.',
    checks: [{ description: 'Signs in offline', independent: true }] }, as(lead)).result.conversationId as string
  const dev = add('dev', task)
  run({ type: 'work.assign', conversationId: task, agentId: dev }, as(lead))
  const step = (name: string, actor: Actor = as(dev), on = task, checks: Array<{ description: string; independent: boolean }> = []) =>
    run({ type: 'conversation.create', title: name, brief: `${name} it.`, reviewOf: on, step: name, checks } as Command, actor).result.conversationId as string
  const group = (id: string) => state.conversations.find(c => c.id === id)!
  return { run, add, as, lead, task, dev, step, group, tick: (ms: number) => { now += ms }, get now() { return now }, get state() { return state } }
}

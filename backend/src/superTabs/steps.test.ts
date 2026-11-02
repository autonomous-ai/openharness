/**
 * Steps inside a task (design docs/plans/2026-11-02-task-steps-design.md). Ken, 2026-11-02: one pull request showed as three
 * tasks (#1835, its review #1918 and its test #1919). A step is a linked group (`reviewOf`) with a name the instructions give;
 * readers show it inside its task. No step name means anything to the server.
 */
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
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

describe('opening a step', () => {
  it('opens on a task of its project, numbered, its opener in the task', () => {
    const f = stepsFixture()
    const name = 'Thiết kế "v2" 🎨'
    const id = f.step(name)
    expect(f.group(id)).toMatchObject({ step: name, reviewOf: f.task, title: name })
    expect(typeof f.group(id).number).toBe('number')
    expect(f.group(f.task).agentIds).toContain(f.dev)
  })

  it('is refused without a task to belong to', () => {
    const f = stepsFixture()
    expect(() => f.run({ type: 'conversation.create', title: 'Review', brief: 'x', step: 'Review', checks: [] } as Command, f.as(f.dev)))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })

  it('is refused on a step', () => {
    const f = stepsFixture()
    const review = f.step('Review')
    expect(() => f.step('Review of the review', f.as(f.dev), review)).toThrow(expect.objectContaining({ code: 'STEP_OF_STEP' }))
  })

  it('is refused on an archived task', () => {
    const f = stepsFixture()
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'done', result: 'Merged' } as Command, f.as(f.dev))
    f.run({ type: 'conversation.archive', conversationId: f.task, archived: true } as Command)
    expect(() => f.step('Review')).toThrow()
  })

  it('takes a name of at most 40 characters', () => {
    const f = stepsFixture()
    expect(() => f.step('x'.repeat(41))).toThrow()
    expect(() => f.step('   ')).toThrow()
  })
})

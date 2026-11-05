import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const checks = [{ description: 'Works', independent: false }]
const task = { goal: 'Save edits offline.', changes: 'Queue them.', constraints: 'None.', owns: ['backend/'] }

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1_000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  const lead = run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'lead', name: 'lead', configuration: config, lead: true },
    owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const agent: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
  const create = (extra: Record<string, unknown>, actor: Actor = agent) =>
    run(commandSchema.parse({ type: 'conversation.create', title: 'Offline editing', ...extra }), actor)
  return { create, agent, run }
}

const whole = { brief: 'Save edits offline.', checks, priority: 'P2', requesterId: 'peer' }
const refusal = (fields: string[]) => expect.objectContaining({ code: 'TASK_CONTRACT_MISSING', status: 400,
  message: expect.stringContaining(fields.join(', ')) })

describe('the task contract: what an agent says when it opens a task', () => {
  it('opens a task that gives its goal, a check, a priority and who asked', () => {
    const f = fixture()
    expect(f.create(whole).result.conversationId).toEqual(expect.any(String))
    expect(f.create({ task, checks, priority: 'P1', requesterId: 'peer' }).result.conversationId).toEqual(expect.any(String))
  })

  it.each([
    ['goal', { brief: undefined, task: undefined }],
    ['goal', { brief: '   ' }],
    ['checks', { checks: [] }],
    ['priority', { priority: undefined }],
    ['requester', { requesterId: undefined }],
  ])('refuses an agent\'s task with no %s, naming it', (field, change) => {
    const f = fixture()
    expect(() => f.create({ ...whole, ...change })).toThrow(refusal([field!]))
  })

  it('names every missing field at once, with an example of a whole create', () => {
    const f = fixture()
    expect(() => f.create({ checks: [] })).toThrow(refusal(['goal', 'checks', 'priority', 'requester']))
    expect(() => f.create({ checks: [] })).toThrow(expect.objectContaining({ message: expect.stringContaining('"type":"conversation.create"') }))
  })

  it('refuses the PM (the project\'s coordinator) the same way', () => {
    const f = fixture()
    expect(() => f.create({ ...whole, requesterId: undefined })).toThrow(refusal(['requester']))
  })

  it('leaves a person\'s task with today\'s defaults alone: no priority or check needed, the requester is the person', () => {
    const f = fixture()
    const created = f.create({ title: 'Offline editing', brief: 'Save edits.', checks: [] }, owner)
    expect(created.result).toMatchObject({ priority: 'P2' })
    expect(created.state.conversations.at(-1)!.requesterId).toBe('owner')
    expect(f.create({ brief: '', checks: [] }, peer).result.conversationId).toEqual(expect.any(String))
  })

  it('does not ask a step of a task for a contract: it is no task of its own', () => {
    const f = fixture()
    const parent = f.create(whole).result.conversationId as string
    expect(f.create({ title: 'Review', reviewOf: parent, step: 'Review', brief: '', checks: [] }).result.conversationId).toEqual(expect.any(String))
  })
})

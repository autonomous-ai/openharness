import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command } from './commands.js'
import { createSuperTab, type Actor } from './model.js'

const config = { engine: 'codex', model: 'old', effort: 'high', contextWindow: null, engineVersion: null }
const next = { ...config, engine: 'claude', model: 'sonnet' }
const person: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.test' }
function fixture() {
  let state = createSuperTab('tab', 'Work', { id: 'owner', email: 'owner@example.test' }, 'prod')
  state = applyCommand(state, person, { type: 'agent.add', conversationId: 'lead', machineId: 'machine', harnessId: 'old', name: 'Lead', lead: true, configuration: config },
    { now: 1, operationId: 'add', contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).state
  const member = state.agents[0]!
  member.workDecision = 'keep'
  state.conversations[0]!.assignment = { id: 'work', agentId: member.id, status: 'working', configuration: config,
    execution: { machineId: 'machine', machineOwnerId: 'owner', harnessId: 'old' }, result: null }
  const actor: Actor = { kind: 'agent', agentId: member.id, machineOwnerId: 'owner' }
  const command = { type: 'agent.rebind', agentId: member.id, machineId: 'machine', projectId: 'lead', previousHarnessId: 'old', harnessId: 'new', configuration: next }
  const run = (input = command, who = actor) => applyCommand(state, who, commandSchema.parse(input), { now: 2, operationId: 'replace' })
  return { state, member, actor, command, run }
}

describe('Change agent keeps the Swarm member', () => {
  it('moves only terminal and current configuration, preserving the Lead and active assignment', () => {
    const f = fixture(), changed = f.run()
    expect(changed.state.agents[0]).toMatchObject({ ...f.member, harnessId: 'new', configuration: next, configurationVersion: expect.any(String) })
    expect(changed.state.conversations[0]).toMatchObject({ leadId: f.member.id, agentIds: [f.member.id], assignment: {
      id: 'work', agentId: f.member.id, status: 'working', configuration: next, execution: { harnessId: 'new' } } })
    expect(changed.cancelledAgents).toEqual([])
    expect(f.state.agents[0]!.harnessId).toBe('old')
  })
  it('repeating the same replacement is a no-op and cannot roll back newer configuration', () => {
    const f = fixture(), changed = f.run().state
    changed.agents[0]!.configuration.model = 'opus'
    expect(applyCommand(changed, f.actor, commandSchema.parse(f.command), { now: 3, operationId: 'retry' }).state).toEqual(changed)
  })
  it.each(['person', 'account', 'machine', 'project', 'old', 'occupied', 'self', 'stopping'])('refuses %s without changing state', kind => {
    const f = fixture(), before = structuredClone(f.state)
    let who = f.actor
    const command = { ...f.command }
    if (kind === 'person') who = person
    if (kind === 'account') who = { ...f.actor, machineOwnerId: 'other' } as Actor
    if (kind === 'machine') command.machineId = 'other'
    if (kind === 'project') command.projectId = 'other'
    if (kind === 'old') command.previousHarnessId = 'other'
    if (kind === 'self') command.harnessId = 'old'
    if (kind === 'stopping') f.member.workDecision = 'stop'
    if (kind === 'occupied') f.state.agents.push({ ...f.member, id: 'another', harnessId: 'new' })
    expect(() => f.run(command, who)).toThrow()
    expect(f.state.agents[0]!.harnessId).toBe(before.agents[0]!.harnessId)
  })
})

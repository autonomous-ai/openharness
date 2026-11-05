import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type AgentConfiguration } from './model.js'
import { isCrew } from './crew.js'
import { projectsOf } from './projects.js'

// Task #3397: a project's crew, the agents the Swarm keeps alive and never closes for being idle.

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, commandSchema.parse(command), { now: 5000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const add = (harnessId: string, lead = false, roleName?: string) => {
    const agentId = run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId, name: harnessId, configuration: config, lead },
      owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
    if (roleName) state.agents.find(a => a.id === agentId)!.roleName = roleName
    return agentId
  }
  const invite = (role: 'viewer' | 'collaborator') => {
    const invited = run({ type: 'invite.create', email: peer.email, role, conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  }
  const pm = add('pm', true), worker = add('worker', false, 'Engineer')
  const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const target = (id = worker) => state.agents.find(a => a.id === id)!
  return { run, add, invite, pm, worker, agentActor, target, get state() { return state } }
}

describe('crew.add and crew.remove', () => {
  it('lets the project\'s PM mark an agent as crew, with its role, and take it off again', () => {
    const f = fixture()
    f.run({ type: 'crew.add', agentId: f.worker, role: 'Reviewer' }, f.agentActor(f.pm))
    expect(f.target().crew).toEqual({ role: 'Reviewer', at: 5000, by: f.pm })
    expect(isCrew(f.target())).toBe(true)
    f.run({ type: 'crew.remove', agentId: f.worker }, f.agentActor(f.pm))
    expect(f.target().crew).toBeUndefined()
    expect(isCrew(f.target())).toBe(false)
  })

  it('names the role the agent goes by when none is given, and lets a person of the project add one', () => {
    const f = fixture()
    f.run({ type: 'crew.add', agentId: f.worker })
    expect(f.target().crew).toEqual({ role: 'Engineer', at: 5000, by: 'owner' })
  })

  it('refuses a viewer, another agent that is not the PM, the PM itself and a Buddy', () => {
    const f = fixture()
    f.invite('viewer')
    // The Swarm's own guard refuses a viewer's every write first.
    expect(() => f.run({ type: 'crew.add', agentId: f.worker }, peer)).toThrow(/read-only/)
    const other = f.add('other')
    expect(() => f.run({ type: 'crew.add', agentId: f.worker }, f.agentActor(other))).toThrow(/PM or the person who runs/)
    expect(() => f.run({ type: 'crew.remove', agentId: f.worker }, f.agentActor(other))).toThrow(/PM or the person who runs/)
    expect(() => f.run({ type: 'crew.add', agentId: f.pm })).toThrow(/already kept/)
    f.target(other).buddyOf = { personId: 'owner', generation: f.state.people[0]!.generation }
    expect(() => f.run({ type: 'crew.add', agentId: other })).toThrow(/Buddy/)
    expect(f.state.agents.some(a => a.crew)).toBe(false)
  })

  // Budget's automatic assignment (River, 11-05): a member gets its lane's top task; one with no lane, the project's.
  it('keeps an optional lane, one of the project\'s five, and none when not given', () => {
    const f = fixture()
    f.run({ type: 'crew.add', agentId: f.worker, role: 'Engineer', lane: 'desktop' }, f.agentActor(f.pm))
    expect(f.target().crew).toEqual({ role: 'Engineer', lane: 'desktop', at: 5000, by: f.pm })
    f.run({ type: 'crew.add', agentId: f.worker, role: 'Engineer' }, f.agentActor(f.pm))
    expect(f.target().crew).toEqual({ role: 'Engineer', at: 5000, by: f.pm })
    for (const lane of ['backend', 'cli', 'desktop', 'mobile', 'docs']) expect(commandSchema.safeParse({ type: 'crew.add', agentId: 'a1', lane }).success).toBe(true)
    for (const lane of ['', 'web', 'Backend']) expect([lane, commandSchema.safeParse({ type: 'crew.add', agentId: 'a1', lane }).success]).toEqual([lane, false])
  })

  // River for security review 1 of #3222 (the Swarm goes public): of the people, only the Swarm's or the project's owner,
  // or the person who runs the agent or whose machine it runs on, as agent.release takes.
  it('refuses a collaborator who neither owns the Swarm or project nor runs the agent', () => {
    const f = fixture()
    f.invite('collaborator')
    expect(() => f.run({ type: 'crew.add', agentId: f.worker }, peer)).toThrow(/PM or the person who runs/)
    expect(f.target().crew).toBeUndefined()
    f.target().machineOwnerId = 'peer'
    f.run({ type: 'crew.add', agentId: f.worker }, peer)
    expect(f.target().crew).toMatchObject({ by: 'peer' })
  })

  it('refuses the person who runs the agent once they cannot read its private project', () => {
    const f = fixture()
    f.invite('collaborator')
    f.target().machineOwnerId = 'peer'
    f.state.projects = projectsOf(f.state).map(p => ({ ...p, visibility: 'private' as const, members: [] }))
    expect(() => f.run({ type: 'crew.add', agentId: f.worker }, peer)).toThrow()
    expect(f.target().crew).toBeUndefined()
  })

  it('refuses a role that is empty, too long or holds control characters', () => {
    for (const role of ['', ' ', 'x'.repeat(41), 'Rev\u0007iewer']) {
      expect([role, commandSchema.safeParse({ type: 'crew.add', agentId: 'a1', role }).success]).toEqual([role, false])
    }
    expect(commandSchema.safeParse({ type: 'crew.add', agentId: 'a1', role: 'x'.repeat(40) }).success).toBe(true)
  })

  it('shows crew in what every reader of the Swarm reads (status)', () => {
    const f = fixture()
    f.run({ type: 'crew.add', agentId: f.worker, role: 'Tester' })
    const seen = visibleState(f.state, f.agentActor(f.pm)).agents.find(a => a.id === f.worker)
    expect(seen?.crew).toEqual({ role: 'Tester', at: 5000, by: 'owner' })
  })
})

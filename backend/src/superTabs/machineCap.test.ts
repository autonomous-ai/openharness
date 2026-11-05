// A new collaborator could not add their Mac to a Swarm holding 32 machines, 15 of them Team accounts' (Ken, 2026-11-04).
// Since each machine is its own part, the Swarm-wide 32 went: each person adds at most 20 machines to one Swarm (#2637).
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor } from './model.js'
import { MACHINE_LIMIT_MESSAGE } from './machines.js'
import { hostTab } from './read/hostRows.js'

const actorOf = (userId: string): Extract<Actor, { kind: 'person' }> => ({ kind: 'person', userId, email: `${userId}@example.com` })
const own = (userId: string) => ({ machineOwnerId: userId, contributorId: userId, hostGrant: null })
const LIMIT = 'You have 20 machines in this Swarm, the most one person can add. Remove one before adding another.'

/** A Swarm where each person in [counts] contributed that many real machines and [team] Team accounts' entries. */
function swarm(counts: Record<string, { real: number; team?: number }>) {
  const state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  for (const id of Object.keys(counts)) if (id !== 'owner') state.people.push({ id, email: `${id}@example.com`, role: 'collaborator', generation: 'g' })
  state.machines = Object.entries(counts).flatMap(([id, { real, team = 0 }]) => [
    ...Array.from({ length: real }, (_, i) => ({ machineId: `${id}-m${i}`, name: `Mac ${i}`, contributorId: id, membershipGeneration: 'g', generation: 'g0',
      cwd: '/swarm', scope: 'swarm' as const, engines: ['claude' as const], maxAgents: 2, paused: false })),
    ...Array.from({ length: team }, (_, i) => ({ machineId: `${id}-t${i}`, name: `Mac ${i}`, contributorId: id, membershipGeneration: 'g', generation: 'g0',
      cwd: '/team', scope: 'swarm' as const, engines: ['claude' as const], maxAgents: 2, paused: false, hostMachineId: `${id}-m${i}` }))])
  return state
}
const contribute = (state: ReturnType<typeof swarm>, userId: string, machineId: string, context: Partial<CommandContext> = {}) =>
  applyCommand(state, actorOf(userId), { type: 'machine.contribute', machineId, name: 'New', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2 } as Command,
    { operationId: 'op', now: 1000, contribution: own(userId), ...context }).state

describe('how many machines one person adds to a Swarm', () => {
  it('refuses a person\'s 21st machine with its own code, in words a person can act on', () => {
    expect(MACHINE_LIMIT_MESSAGE).toBe(LIMIT)
    const state = swarm({ owner: { real: 20 } })
    expect(() => contribute(state, 'owner', 'new')).toThrow(LIMIT)
    expect(() => contribute(state, 'owner', 'new')).toThrow(expect.objectContaining({ code: 'MACHINE_LIMIT_PER_PERSON' }))
  })

  it('lets another person in that Swarm still add theirs', () => {
    expect(contribute(swarm({ owner: { real: 20 }, peer: { real: 3 } }), 'peer', 'new').machines).toHaveLength(24)
  })

  it('has no Swarm-wide limit: 33 real machines across people take another', () => {
    const state = swarm({ owner: { real: 19 }, peer: { real: 14 } })
    expect(contribute(state, 'owner', 'new').machines).toHaveLength(34)
    expect(contribute(swarm({ owner: { real: 10, team: 10 }, a: { real: 20, team: 20 }, b: { real: 20, team: 20 } }), 'owner', 'new').machines).toHaveLength(101)
  })

  it('leaves Team accounts\' entries out of their owner\'s 20: a Mac\'s Team account is that same Mac', () => {
    expect(contribute(swarm({ owner: { real: 19, team: 19 } }), 'owner', 'new').machines).toHaveLength(39)
    expect(contribute(swarm({ owner: { real: 20, team: 0 } }), 'owner', 'team', { contribution: { ...own('owner'), hostMachineId: 'owner-m0' } }).machines).toHaveLength(21)
  })

  it('holds a person\'s Team accounts\' entries at 20 too, so they stay bounded', () => {
    const team = { contribution: { ...own('owner'), hostMachineId: 'owner-m0' } }
    expect(() => contribute(swarm({ owner: { real: 20, team: 20 } }), 'owner', 'team', team)).toThrow(expect.objectContaining({ code: 'MACHINE_LIMIT_PER_PERSON' }))
    expect(contribute(swarm({ owner: { real: 20, team: 20 }, peer: { real: 0, team: 20 } }), 'owner', 'peer-t0', team).machines).toHaveLength(60)
  })

  it('still saves the settings of a machine already in it at the limit', () => {
    expect(contribute(swarm({ owner: { real: 20 } }), 'owner', 'owner-m5').machines).toHaveLength(20)
  })
})

// Old CLIs know only MACHINES_FULL as final and would retry the new code for good; their host stops once its roster row stops
// asking (cli host.spec "stops after %s until the roster stops asking"), so the server asks no host to join when it would refuse.
describe('which hosts are asked to join', () => {
  const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
  const hostUser = (sub: string) => ({ sub, email: `${sub}@example.com`, role: 'user', autonomousEnv: 'test' }) as never
  const lookups = (teams: string[]) => ({ people: [], confidential: new Set<string>(), agentGrant: async () => {}, teams: teams.map(machineId => ({ machineId })), githubApp: false })
  /** [state] with the owner's Lead on [machineId], which is not one of the Swarm's machines. */
  function leadOn(start: ReturnType<typeof swarm>, machineId: string) {
    let state = start
    const run = (command: Command, operationId: string) => {
      const effects = applyCommand(state, actorOf('owner'), command, { operationId, now: 1000, contribution: own('owner') })
      state = effects.state
      return effects.result
    }
    const project = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }, 'p') as { conversationId: string }
    const lead = run({ type: 'agent.add', conversationId: project.conversationId, harnessId: 'pm', machineId, name: 'Lead', configuration, lead: true }, 'a').agentId as string
    return { state, lead }
  }
  const joinSwarm = async ({ state, lead }: ReturnType<typeof leadOn>, machineId: string) =>
    (await hostTab('swarm', state, machineId, hostUser('owner'), null, lookups([]))).roster.find(r => 'agent' in r && r.agent.id === lead)
  const joinTeam = async (state: ReturnType<typeof swarm>, teams: string[]) =>
    (await hostTab('swarm', state, 'owner-m0', hostUser('owner'), null, lookups(teams))).roster.flatMap(r => 'joinTeam' in r ? [r.joinTeam.machineId] : [])

  it('asks the owner\'s Lead machine to join below 20, and not at 20', async () => {
    expect(await joinSwarm(leadOn(swarm({ owner: { real: 19 }, peer: { real: 20 } }), 'laptop'), 'laptop')).toMatchObject({ joinSwarm: true })
    expect(await joinSwarm(leadOn(swarm({ owner: { real: 20 } }), 'laptop'), 'laptop')).toMatchObject({ joinSwarm: false })
  })

  it('asks again once a machine of theirs is gone', async () => {
    const f = leadOn(swarm({ owner: { real: 20 } }), 'laptop')
    f.state.machines = f.state.machines!.filter(m => m.machineId !== 'owner-m3')
    expect(await joinSwarm(f, 'laptop')).toMatchObject({ joinSwarm: true })
  })

  it('still asks the Lead on its owner\'s Buddy-only record at 20: that record is counted already', async () => {
    const state = swarm({ owner: { real: 20 } })
    state.machines!.find(m => m.machineId === 'owner-m19')!.buddyOnly = true
    expect(await joinSwarm(leadOn(state, 'owner-m19'), 'owner-m19')).toMatchObject({ joinSwarm: true })
  })

  it('asks a Mac\'s Team accounts to join only while their person has room for them', async () => {
    expect(await joinTeam(swarm({ owner: { real: 20, team: 18 } }), ['team-a', 'team-b', 'team-c'])).toEqual(['team-a', 'team-b'])
    expect(await joinTeam(swarm({ owner: { real: 20, team: 20 } }), ['team-a'])).toEqual([])
    expect(await joinTeam(swarm({ owner: { real: 20, team: 0 } }), ['team-a'])).toEqual(['team-a'])
  })
})

// A new collaborator could not add their Mac to a Swarm holding 32 machines, 15 of them Team accounts' (Ken, 2026-11-04).
// Since each machine is its own part, the Swarm-wide 32 went: each person adds at most 20 machines to one Swarm (#2637).
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor } from './model.js'
import { MACHINE_LIMIT_MESSAGE } from './machines.js'

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

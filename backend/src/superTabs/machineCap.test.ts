// A new collaborator could not add their Mac to a Swarm holding 32 machines, 15 of them Team accounts' (Ken, 2026-11-04).
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor } from './model.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const own = { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null }
const FULL = 'This Swarm is at its limit of 128 machines. One has to be removed before another can be added.'

/** A Swarm of [entries] machines, [team] of them Harness Team accounts' entries. */
function swarm(entries: number, team = 0) {
  const state = createSuperTab('swarm', 'Team', { id: 'owner', email: owner.email }, 'test')
  state.machines = Array.from({ length: entries }, (_, i) => ({ machineId: `m${i}`, name: `Mac ${i}`, contributorId: 'owner', membershipGeneration: 'g', generation: 'g0',
    cwd: '/swarm', scope: 'swarm' as const, engines: ['claude'], maxAgents: 2, paused: false, ...i < team ? { hostMachineId: `m${i + team}` } : {} }))
  return state
}
const contribute = (state: ReturnType<typeof swarm>, machineId: string, context: Partial<CommandContext> = {}) =>
  applyCommand(state, owner, { type: 'machine.contribute', machineId, name: 'New', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2 } as Command,
    { operationId: 'op', now: 1000, contribution: own, ...context }).state

describe('how many machines a Swarm holds', () => {
  it('takes a new machine with 127, 15 of them Team accounts\', past the old limit of 32', () => {
    expect(contribute(swarm(32, 15), 'new').machines).toHaveLength(33)
    expect(contribute(swarm(127, 15), 'new').machines).toHaveLength(128)
  })

  it('refuses the next at 128, and says so in words a person can act on', () => {
    expect(() => contribute(swarm(128), 'new')).toThrow(FULL)
    expect(() => contribute(swarm(128, 15), 'new')).toThrow(expect.objectContaining({ code: 'MACHINES_FULL' }))
  })

  it('counts a Team account\'s entry too', () => {
    const team = { contribution: { ...own, hostMachineId: 'm0' } }
    expect(contribute(swarm(127), 'team', team).machines).toHaveLength(128)
    expect(() => contribute(swarm(128), 'team', team)).toThrow(FULL)
  })

  it('still saves the settings of a machine already in it at 128', () => {
    expect(contribute(swarm(128), 'm5').machines).toHaveLength(128)
  })
})

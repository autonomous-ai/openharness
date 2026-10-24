import { describe, expect, it } from 'vitest'
import { foldTeamMachines } from './oneMachine.js'

// One machine (docs/plans/2026-10-24-swarm-team-account.md): a Mac's Harness Team account is listed as that Mac.
describe('foldTeamMachines', () => {
  const row = (machineId: string, hostMachineId: string | null = null, agentCount = 0) => ({ machineId, hostMachineId, agentCount })

  it('folds a team machine into the Mac it lives on, keeping the order of the rest', () => {
    const rows = [row('mini'), row('laptop-team', 'laptop', 2), row('laptop', null, 1)]
    expect(foldTeamMachines(rows)).toEqual([
      { ...row('mini'), team: [] },
      { ...row('laptop', null, 1), team: [row('laptop-team', 'laptop', 2)] },
    ])
  })

  it('lists a team machine on its own when its Mac is not in the list, and a dedicated machine as itself', () => {
    const rows = [row('laptop-team', 'deleted-laptop'), row('dedicated'), { machineId: 'older' }]
    expect(foldTeamMachines(rows).map(r => r.machineId)).toEqual(['laptop-team', 'dedicated', 'older'])
  })

  it('never folds a machine into itself or into another team machine', () => {
    const rows = [row('a', 'a'), row('b', 'a')]
    expect(foldTeamMachines(rows).map(r => [r.machineId, r.team.map(t => t.machineId)])).toEqual([['a', []], ['b', []]])
  })
})

import { describe, expect, it } from 'vitest'
import { pmAccounts, visibleState, type Actor } from './model.js'
import { fullSwarm, NOW, owner } from './read/fixture.test-support.js'

const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: `${owner.userId}-machine` })

/** fullSwarm with a PM for the private project "Secret" too, on [machineId]. */
function twoPms(machineId = 'host') {
  const s = fullSwarm()
  s.edit(draft => {
    const lead = draft.agents.find(a => a.id === s.lead)!
    draft.agents.push({ ...structuredClone(lead), id: 'secret-pm', harnessId: 'secret-pm-harness', name: 'Lead', displayName: 'Sage', machineId })
    const chat = draft.projects!.find(p => p.id === s.secret)!.leadConversationId
    draft.conversations.find(c => c.id === chat)!.leadId = 'secret-pm'
  })
  return s
}

// Ken, 11-05: a PM could drain the account another project's PM ran on, and the route, reading as that PM, saw only its own
// project. The read now carries every project's PM account, naming only projects the reader may read.
describe('pmAccounts', () => {
  it('lists every project\'s PM account for an agent\'s read, naming a project it cannot read only as another project', () => {
    const s = twoPms()
    const lead = s.state.agents.find(a => a.id === s.lead)!
    const engine = lead.configuration!.engine
    const first = s.state.projects!.find(p => p.leadConversationId === 'lead')!.name
    expect(visibleState(s.state, agentActor(s.lead), NOW).pmAccounts).toEqual([
      { machineId: 'host', engine, project: first, pm: lead.displayName ?? lead.name },
      { machineId: 'host', engine, project: 'another project', pm: 'its PM' },
    ])
  })

  it('names the private project to a reader who may read it', () => {
    const s = twoPms()
    expect(pmAccounts(s.state, owner).map(a => a.project)).toContain('Secret')
    expect(pmAccounts(s.state, owner).find(a => a.project === 'Secret')!.pm).toBe('Sage')
  })

  it('gives a person\'s read and a Buddy\'s none', () => {
    const s = twoPms()
    expect(visibleState(s.state, owner, NOW)).not.toHaveProperty('pmAccounts')
    expect(visibleState(s.state, agentActor(s.buddy), NOW)).not.toHaveProperty('pmAccounts')
  })

  it('names the Mac of a PM on a Harness Team account, and leaves out a PM on a machine the reader cannot see', () => {
    const s = twoPms('host-team')
    s.edit(draft => { draft.machines!.push({ ...structuredClone(draft.machines!.find(m => m.machineId === 'host')!), machineId: 'host-team', name: 'host', hostMachineId: 'host' }) })
    expect(pmAccounts(s.state, owner).find(a => a.pm === 'Sage')).toMatchObject({ machineId: 'host-team', hostMachineId: 'host' })
    const hidden = twoPms('nowhere')
    expect(visibleState(hidden.state, agentActor(hidden.lead), NOW).pmAccounts!.map(a => a.pm)).not.toContain('its PM')
  })

  it('skips a project whose PM is gone or has no engine', () => {
    const s = twoPms()
    s.edit(draft => {
      draft.agents = draft.agents.filter(a => a.id !== 'secret-pm')
      draft.agents.find(a => a.id === s.lead)!.configuration = undefined as never
    })
    expect(pmAccounts(s.state, owner)).toEqual([])
  })
})

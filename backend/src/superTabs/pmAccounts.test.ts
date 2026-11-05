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

  // Review of #3134: an agent reads only its own project, so a public project was "another project" too.
  it('names a public project to every project agent, as otherProjectsWork does', () => {
    const s = twoPms()
    s.edit(draft => { draft.projects!.find(p => p.id === s.secret)!.visibility = 'public' })
    expect(visibleState(s.state, agentActor(s.lead), NOW).pmAccounts!.map(a => a.project)).toContain('Secret')
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

  // Task #3222: what the PM spends of its account's week a day, from its machines' spend ledgers (pmSpend.ts), and when that
  // week resets: the route keeps days to the reset × that share for it, in place of a fixed 20%.
  it('carries the PM\'s daily share of its account\'s week and the reset, over the Mac and its Team account, once 3 days are measured', () => {
    const s = twoPms()
    const lead = s.state.agents.find(a => a.id === s.lead)!
    const engine = lead.configuration!.engine
    const today = Math.floor(NOW / 86_400_000) * 86_400_000
    const reset = today + 2.5 * 86_400_000
    const day = (back: number, used: number, sessions: Record<string, number>) => ({ day: today - back * 86_400_000, engine, weekly: { seen: 50, used },
      resetsAt: reset, sessions: Object.fromEntries(Object.entries(sessions).map(([id, spent]) => [id, { seen: 0, spent }])) })
    s.edit(draft => {
      const host = draft.machines!.find(m => m.machineId === 'host')!
      host.spendDays = [day(3, 10, { [lead.harnessId]: 1, other: 1 }), day(2, 10, { [lead.harnessId]: 1, other: 1 }), day(1, 10, { [lead.harnessId]: 1 })]
      draft.machines!.push({ ...structuredClone(host), machineId: 'host-team', hostMachineId: 'host', spendDays: [day(1, 10, { teamWorker: 1 })] })
    })
    // 10 × 1/2, 10 × 1/2, 10 × 1/2 (the Team account's worker spent the other half of the last day).
    expect(pmAccounts(s.state, owner).find(a => a.pm === (lead.displayName ?? lead.name))).toMatchObject({ daily: { share: 5, days: 3 }, resetsAt: reset })
    s.edit(draft => { draft.machines!.find(m => m.machineId === 'host')!.spendDays = [day(1, 10, { [lead.harnessId]: 1 })] })
    const fewer = pmAccounts(s.state, owner).find(a => a.pm === (lead.displayName ?? lead.name))!
    expect(fewer).not.toHaveProperty('daily')
    expect(fewer.resetsAt).toBe(reset)
  })
})

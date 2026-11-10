import { describe, expect, it } from 'vitest'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { storedAssignment } from '../storedWork.test-support.js'
import { hostTab } from './hostRows.js'
import { agentView } from './views.js'
import { owner, swarm } from './fixture.test-support.js'

const user = { sub: owner.userId, email: owner.email } as AuthUser
const lookups = { people: [{ id: owner.userId, email: owner.email }], confidential: new Set<string>(), agentGrant: async () => {} }

// No task resumes after a usage limit since Swarm v4 (work.resume answers as retired, 2026-11-10). An older host still reads the
// row's `resume` and, when it names a task, asks for it back and types a continue into the session (cli superTabs/limitResume.ts, gone from the CLI since #3864):
// the field stays, always null, until 2026-12-09.
describe('a host row\'s resume', () => {
  it('is null even for a task its agent lost to a usage limit with a reset time, as a Swarm from before stores one', async () => {
    const s = swarm()
    const task = s.group('Fix login')
    const worker = s.add('dev', task, false, owner, 'host', owner.userId)
    s.edit(state => {
      const assignment = storedAssignment(state, task, worker)
      assignment.status = 'lost'
      assignment.lost = { at: 1000, reason: 'usage limit', resumeAt: '2026-11-10T09:00:00.000Z' }
      state.agents.find(a => a.id === worker)!.lostTask = { conversationId: task, assignmentId: assignment.id, reason: 'usage limit', at: 1000,
        resumeAt: '2026-11-10T09:00:00.000Z' }
    })
    const { roster } = await hostTab('tab', s.state, 'host', user, null, lookups)
    const row = roster.find(r => 'agent' in r && r.agent.id === worker) as { resume: unknown } | undefined
    expect(row).toBeDefined()
    expect(row!.resume).toBeNull()
  })
})

// Swarm v4 has no crew (2026-11-10). An older host keeps an agent whose row carries a crew mark alive, reopening its session
// (cli superTabs/crew.ts isCrewRow): a mark a Swarm from before stores is never sent, nor shown to readers.
describe('a crew mark from before', () => {
  it('is neither in its host\'s row nor in a reader\'s view', async () => {
    const s = swarm()
    const task = s.group('Fix login')
    const worker = s.add('dev', task, false, owner, 'host', owner.userId)
    s.edit(state => { Object.assign(state.agents.find(a => a.id === worker)!, { crew: { role: 'Engineer', at: 1, by: owner.userId } }) })
    const { roster } = await hostTab('tab', s.state, 'host', user, null, lookups)
    const row = roster.find(r => 'agent' in r && r.agent.id === worker) as { agent: object } | undefined
    expect(row!.agent).not.toHaveProperty('crew')
    expect(agentView(s.state.agents.find(a => a.id === worker)!)).not.toHaveProperty('crew')
  })
})

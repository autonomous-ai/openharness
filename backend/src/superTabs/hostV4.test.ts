import { describe, expect, it } from 'vitest'
import type { AuthUser } from '../lib/ssoAuth.js'
import { hostTab, type HostLookups } from './read/hostRows.js'
import { readerView } from './read/views.js'
import * as store from './parts/index.js'
import { config, owner, swarm } from './read/fixture.test-support.js'
import { machineContribution, projectsOnMachine } from './machines.js'
import type { AgentStart } from './model.js'

// 2026-11-09: anh Dee's Mac 3 showed offline for hours, its agents' chats undelivered: every read of its host failed with "This
// project is unavailable." A Swarm of Swarm v4 has agents in chats that belong to no project, and no project called 'lead'.
const user = { sub: owner.userId, email: owner.email } as AuthUser
const lookups = (): HostLookups => ({ people: [{ id: owner.userId, email: owner.email }], confidential: new Set(), agentGrant: async () => {}, teams: [], githubApp: false })

/** A Swarm whose first project is gone (all its projects have ids of their own), with a Regular agent's chat and its start,
 *  still waiting on `mac3`: what a server-started New agent leaves until its host launches it. */
function v4Swarm() {
  const s = swarm()
  s.contribute('mac3', 'swarm')
  s.run({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' })
  s.run({ type: 'project.delete', projectId: 'lead' })
  const chat = s.run({ type: 'agent.new', kind: 'regular', engine: 'claude', name: 'Ada', machineId: 'mac3', local: true } as never, owner,
    { contribution: { machineOwnerId: owner.userId, contributorId: owner.userId } }).conversationId as string
  s.edit(state => {
    const request: AgentStart['request'] = { conversationId: chat, machineId: 'mac3', engine: 'claude', name: 'Ada', cwd: '/home', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }, regular: true }
    const generation = machineContribution(state, 'mac3')!.generation
    state.starts = [{ poolGeneration: generation, id: 'start', creationId: 'super-start', actorKey: `person:${owner.userId}`, contributorId: owner.userId,
      membershipGeneration: state.people[0]!.generation, machineOwnerId: owner.userId, hostGrant: null, request, harnessId: null, dispatched: false,
      error: null, requestedAt: 1 } as AgentStart]
  })
  return { s, chat }
}

describe('a host read in a Swarm of Swarm v4 agents', () => {
  it('lists what a Regular agent\'s start waits for, though its chat belongs to no project', async () => {
    const { s } = v4Swarm()
    const rows = await hostTab('tab', s.state, 'mac3', user, null, lookups())
    expect(rows.pool?.regularStarts?.map(start => start.id)).toEqual(['start'])
  })

  it('lists the agents of a Swarm whose chats belong to no project, a joined Regular agent and a PM among them', async () => {
    const { s } = v4Swarm()
    s.edit(state => { state.starts = [] })
    const chat = s.state.conversations.find(c => c.kind === 'agent-chat')!.id
    s.run({ type: 'agent.add', conversationId: chat, machineId: 'mac3', harnessId: 'ada', name: 'Ada', lead: false,
      configuration: { ...config, engine: 'claude' } } as never, owner, { contribution: { machineOwnerId: owner.userId, contributorId: owner.userId } })
    const web = s.state.projects![0]!
    s.add('pm-harness', web.leadConversationId, true, owner, 'mac3', owner.userId)
    const rows = await hostTab('tab', s.state, 'mac3', user, null, lookups())
    expect(rows.roster.flatMap(r => 'agent' in r ? [r.agent.harnessId] : []).sort()).toEqual(['ada', 'pm-harness'])
    // Every reader of the Swarm reads it too.
    expect(() => readerView(store.split(s.state, { tabId: 'tab', version: 1, now: 1 }), owner, 1, { teamMachines: [] })).not.toThrow()
  })

  it('places no project on a machine for a start in an agent\'s own chat', () => {
    const { s } = v4Swarm()
    expect([...projectsOnMachine(s.state, 'mac3')]).toEqual([])
  })
})

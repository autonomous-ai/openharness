import { describe, expect, it } from 'vitest'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { storedAssignment } from '../storedWork.test-support.js'
import { hostTab } from './hostRows.js'
import { owner, peer, swarm } from './fixture.test-support.js'

const user = { sub: owner.userId, email: owner.email } as AuthUser
const lookups = { people: [{ id: owner.userId, email: owner.email }], confidential: new Set<string>(), agentGrant: async () => {} }

// No task resumes after a usage limit since Swarm v4 (work.resume is gone, 2026-11-10). An older host still reads the
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

// The CLI installs no Swarm skills since #3912, but a CLI or Desktop from before reads a missing skillMode as Harness orchestration
// and would launch a v4 agent with its skills: every project, host row and start read says 'default' until 2026-12-11.
describe('a host row\'s skillMode', () => {
  it('is always Default, as is every project\'s', async () => {
    const s = swarm()
    const task = s.group('Fix login')
    const worker = s.add('dev', task, false, owner, 'host', owner.userId)
    const { roster } = await hostTab('tab', s.state, 'host', user, null, lookups)
    expect((roster.find(r => 'agent' in r && r.agent.id === worker) as { skillMode?: unknown }).skillMode).toBe('default')
    expect(s.state.projects!.map(p => (p as { skillMode?: unknown }).skillMode)).toEqual(s.state.projects!.map(() => 'default'))
  })
})

// PSW-B review (2026-11-11): each roster row read the Swarm's conversations in several passes of its own, and each observer's
// check another, so a host's read cost about (its agents) x (the Swarm's conversations) x (its people). It reads them in passes
// that do not grow with its agents (read/hostRows.ts whereabouts).
describe('a host\'s roster read', () => {
  /** How many times a roster read of [agents] agents on the host walks the Swarm's conversations. */
  const walks = async (agents: number) => {
    const s = swarm()
    s.join(peer)
    for (let i = 0; i < agents; i++) s.add(`h${i}`, s.group(`Task ${i}`), false, owner, 'host', owner.userId)
    let count = 0
    const conversations = s.state.conversations
    const counted = new Proxy(conversations, { get(target, key, receiver) {
      if (key === Symbol.iterator || ['find', 'some', 'filter', 'every', 'map', 'forEach', 'findIndex', 'flatMap', 'reduce'].includes(key as string)) count++
      return Reflect.get(target, key, receiver)
    } })
    const state = { ...s.state, conversations: counted }
    const people = [{ id: owner.userId, email: owner.email }, { id: peer.userId, email: peer.email }]
    const { roster } = await hostTab('tab', state, 'host', user, null, { ...lookups, people })
    expect(roster.filter(r => 'agent' in r && !('closeSession' in r))).toHaveLength(agents)
    return count
  }

  it('walks the conversations as often for twenty agents as for two', async () => {
    expect(await walks(20)).toBe(await walks(2))
  })
})

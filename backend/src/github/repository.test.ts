import { describe, expect, it } from 'vitest'
import { attribution } from './attribution.js'
import { endedHolds, workHolds } from './holds.js'
import { githubRepository } from './repository.js'
import type { Conversation, SuperTabState, WorkStatus } from '../superTabs/model.js'

describe('github repository addresses', () => {
  it('reads https, ssh and scp-like github.com addresses', () => {
    for (const url of ['https://github.com/acme/app', 'https://github.com/acme/app.git', 'https://github.com/acme/app/', 'http://github.com/acme/app',
      'https://GitHub.com/acme/app', 'ssh://git@github.com/acme/app.git', 'git@github.com:acme/app.git', 'git@github.com:acme/app']) {
      expect(githubRepository(url), url).toEqual({ owner: 'acme', name: 'app', fullName: 'acme/app' })
    }
    expect(githubRepository('https://github.com/a-b/my.repo_1')).toEqual({ owner: 'a-b', name: 'my.repo_1', fullName: 'a-b/my.repo_1' })
  })

  it('refuses other hosts, credentials, extra path parts and impossible names', () => {
    for (const url of [null, undefined, '', 'not a url', 'https://gitlab.com/acme/app', 'https://github.com.evil.test/acme/app',
      'https://user@github.com/acme/app', 'https://github.com:8443/acme/app', 'ssh://root@github.com/acme/app', 'git://github.com/acme/app',
      'https://github.com/acme', 'https://github.com/acme/app/tree/main', 'https://github.com/acme/app?x=1', 'https://github.com/-acme/app',
      'https://github.com/ac--me/app', 'https://github.com/acme/..', 'https://github.com/acme/a%20b', 'git@gitlab.com:acme/app.git']) {
      expect(githubRepository(url), String(url)).toBeNull()
    }
  })
})

const group = (id: string, agentId: string, status: WorkStatus, assignmentId = `${id}-attempt`): Conversation => ({
  id, title: id, leadId: null, agentIds: [agentId], archived: false, brief: '', checks: [], lastMessageSequence: 0,
  assignment: { id: assignmentId, agentId, status, result: null, configuration: { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null },
    execution: { machineId: 'm', harnessId: 'h', machineOwnerId: 'u' } },
})
const state = (conversations: Conversation[], agents = ['a1', 'a2', 'a3']) =>
  ({ agents: agents.map(id => ({ id })), conversations } as unknown as Pick<SuperTabState, 'agents' | 'conversations'>)

describe('tasks in an agent\'s hands', () => {
  it('counts working, waiting, stuck and in-review tasks of agents still present', () => {
    const before = state([group('g1', 'a1', 'working'), group('g2', 'a2', 'review'), group('g3', 'a3', 'needs_human'), group('g4', 'a1', 'blocked'),
      group('g5', 'a2', 'done'), group('g6', 'a3', 'reconciling'), group('g7', 'gone', 'working'), { ...group('g8', 'a1', 'working'), assignment: null }])
    expect(workHolds(before).map(h => h.assignmentId)).toEqual(['g1-attempt', 'g2-attempt', 'g3-attempt', 'g4-attempt'])
  })

  it('ends a hold when the task is done, cancelled, stopped, reconciling, reassigned or its agent leaves', () => {
    const before = state([group('g1', 'a1', 'working'), group('g2', 'a2', 'working'), group('g3', 'a3', 'review'), group('g4', 'a1', 'blocked')])
    const after = state([group('g1', 'a1', 'done'), group('g2', 'a2', 'working', 'new-attempt'), group('g3', 'a3', 'working'), group('g4', 'a1', 'cancelled')], ['a1', 'a2'])
    expect(endedHolds(before, after)).toEqual([{ agentId: 'a1', assignmentId: 'g1-attempt' }, { agentId: 'a2', assignmentId: 'g2-attempt' },
      { agentId: 'a3', assignmentId: 'g3-attempt' }, { agentId: 'a1', assignmentId: 'g4-attempt' }])
    expect(endedHolds(before, before)).toEqual([])
    expect(endedHolds(state([group('g1', 'a1', 'working')]), state([group('g1', 'a1', 'review')]))).toEqual([])
    expect(endedHolds(state([group('g1', 'a1', 'working')]), state([group('g1', 'a1', 'stopped')]))).toHaveLength(1)
  })
})

describe('attribution', () => {
  it('names the requester, the agent and the machine in trailers and the pull request line', () => {
    expect(attribution({ requester: { name: 'Ada Lovelace', email: 'ada@example.com' }, agentName: 'Atlas', machineName: 'Studio Mac' })).toEqual({
      requestedBy: { name: 'Ada Lovelace', email: 'ada@example.com' }, agent: 'Atlas', machine: 'Studio Mac',
      trailers: ['Co-authored-by: Ada Lovelace <ada@example.com>', 'Harness-Agent: Atlas', 'Harness-Machine: Studio Mac'],
      pullRequestLine: 'Requested by Ada Lovelace (ada@example.com) through Harness.',
    })
  })

  it('falls back to the address for a missing name and keeps every value on one line', () => {
    const made = attribution({ requester: { name: '  ', email: 'grace@example.com' }, agentName: 'Builder\nHarness-Agent: forged', machineName: null })
    expect(made.trailers).toEqual(['Co-authored-by: grace <grace@example.com>', 'Harness-Agent: Builder Harness-Agent: forged'])
    expect(attribution({ requester: { name: 'Eve <evil@example.com>', email: 'eve@example.com' }, agentName: '', machineName: '\n' }).trailers)
      .toEqual(['Co-authored-by: Eve evil@example.com <eve@example.com>', 'Harness-Agent: Agent'])
  })
})

import { describe, expect, it } from 'vitest'
import { createSuperTab, type Agent, type Conversation } from '../model.js'
import { leaderboard } from './stats.js'
import { DAY_MS, WEEK_MS } from './week.js'

const WEEK = Date.UTC(2026, 10, 2), NOW = WEEK + 3 * DAY_MS
function fixture() {
  const state = createSuperTab('tab', 'Org', { id: 'owner', email: 'owner@example.com' }, 'prod')
  state.people.push({ id: 'peer', email: 'peer@example.com', role: 'collaborator', generation: 'g' })
  state.projects!.push({ ...state.projects![0]!, id: 'other', leadConversationId: 'other-lead' })
  const request = (id: string, person = 'owner', projectId = 'lead', extra: Partial<Conversation> = {}): Conversation => ({
    id, projectId, title: id, leadId: null, agentIds: [], archived: false, brief: '', checks: [], assignment: null,
    lastMessageSequence: 0, requesterId: person, pullRequestUrls: ['https://github.com/o/r/pull/1'],
    ledger: { firstAssignedAt: WEEK + 1, shippedAt: WEEK + 2, mergedAt: WEEK + 2 }, ...extra,
  })
  const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
    id, projectId: 'lead', name: id, machineId: 'mac', harnessId: id, machineOwnerId: 'owner', contributorId: 'owner',
    membershipGeneration: 'tab', configuration: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', contextWindow: null, engineVersion: null }, ...extra,
  })
  const read = (groups: Conversation[], projects = ['lead', 'other']) => leaderboard({ state, groups, machines: state.machines ?? [],
    projectId: 'lead', week: WEEK, now: NOW, allProjects: projects })
  return { state, request, agent, read }
}

describe('org-wide weekly team play', () => {
  it('ranks shipped work first across readable projects, then points, and shares ties', () => {
    const { request, read } = fixture()
    const view = read([request('one'), request('two', 'owner', 'other'), request('peer', 'peer'),
      request('help', 'peer', 'lead', { ledger: { unblocks: Array.from({ length: 10 }, (_, i) => ({ personId: 'peer', at: WEEK + i, waitedMs: 0 })) } })])
    expect(view.people.map(p => [p.personId, p.rank, p.points, p.shipped.count])).toEqual([
      ['owner', 1, 8, 2], ['peer', 2, 14, 1],
    ])
    const tied = read([request('a'), request('b', 'peer')])
    expect(tied.people.map(p => p.rank)).toEqual([1, 1])
  })

  it('credits one acceptance at the first assignment, not on retries or review/private/hidden work', () => {
    const { request, read } = fixture()
    const view = read([
      request('accepted', 'owner', 'lead', { pullRequestUrls: [], ledger: { firstAssignedAt: WEEK } }),
      request('old', 'owner', 'lead', { pullRequestUrls: [], ledger: { firstAssignedAt: WEEK - 1, runs: [] } }),
      request('next', 'owner', 'lead', { pullRequestUrls: [], ledger: { firstAssignedAt: WEEK + WEEK_MS } }),
      request('review', 'owner', 'lead', { reviewOf: 'accepted' }),
      request('private', 'owner', 'lead', { audience: { people: [{ id: 'owner', generation: 'tab' }] } }),
      request('hidden', 'owner', 'other'),
    ], ['lead'])
    expect(view.people[0]).toMatchObject({ accepted: 1, points: 1, shipped: { count: 0 }, agentsBrought: 0 })
  })

  it('counts visible own-account agents once, with no agent or lending points', () => {
    const { state, agent, read } = fixture()
    state.agents = [agent('regular'), agent('other', { projectId: 'other' }), agent('old', { membershipGeneration: 'former' })]
    state.machines = [{ machineId: 'mac', name: 'Mac', contributorId: 'owner', membershipGeneration: 'tab', generation: 'g',
      cwd: '/repo', scope: 'swarm', engines: ['codex'], maxAgents: 8, paused: false, lent: [{ week: WEEK, busyMs: 100 * 3_600_000 }] }]
    const view = read([], ['lead'])
    expect(view.people.find(p => p.personId === 'owner')).toMatchObject({ agentsBrought: 1, points: 0, rank: 1 })
    expect(view.goal.thisWeek.points).toBe(0)
  })

  it('counts a visible agent with no project before its first task, without points', () => {
    const { state, agent } = fixture()
    const idle = agent('idle', { projectId: '' })
    state.agents = [idle, agent('hidden', { projectId: 'other' })]
    const view = leaderboard({ state, groups: [], machines: [], projectId: 'lead', week: WEEK, now: NOW,
      allProjects: ['lead'], visibleAgents: [idle] })
    expect(view.people.find(p => p.personId === 'owner')).toMatchObject({ agentsBrought: 1, points: 0 })
  })

  it('preserves rolling and per-project scoring for existing clients', () => {
    const { state, request } = fixture()
    const args = { state, groups: [request('one')], machines: [], projectId: 'lead', week: WEEK, now: NOW }
    expect(leaderboard(args).people[0]).toMatchObject({ points: 3 })
    expect(leaderboard({ ...args, period: '7d', allProjects: ['lead'] }).people[0]).toMatchObject({ points: 3 })
  })
})

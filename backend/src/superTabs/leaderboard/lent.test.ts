import { describe, expect, it } from 'vitest'
import { MACHINE_FRESH_MS, type ContributedMachine } from '../machines.js'
import { createSuperTab, type Agent, type Conversation, type SuperTabState, type WorkStatus } from '../model.js'
import { accrueLent } from './lent.js'
import { weekStart } from './week.js'

// Monday 2026-10-26 00:00 UTC.
const MONDAY = Date.UTC(2026, 9, 26)

function machine(running: string[], receivedAt: number): ContributedMachine {
  return { machineId: 'mac', name: 'Studio', contributorId: 'owner', membershipGeneration: 'tab', generation: 'g1', cwd: '/repo', engines: ['claude'],
    maxAgents: 4, paused: false, observation: { generation: 'g1', receivedAt, resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null,
      diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null, deviceType: null, chip: null, os: null, gpuPercent: null },
    tools: {}, quotas: [], runningHarnessIds: running, stoppedHarnessIds: [] } }
}
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, machineId: 'mac', harnessId: `h-${id}`, machineOwnerId: 'owner', contributorId: 'owner',
  membershipGeneration: 'tab', name: id, configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }, ...extra })
/** A task [agentId] works on, asked for by [requesterId]: someone else than the machine's contributor unless named. */
const task = (agentId: string, status: WorkStatus = 'working', requesterId: string | undefined = 'dee'): Conversation => ({ id: `task-${agentId}`,
  title: 'Task', leadId: null, agentIds: [agentId], archived: false, brief: '', checks: [], lastMessageSequence: 0, requesterId,
  assignment: { id: `a-${agentId}`, agentId, status, result: null, configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null,
    engineVersion: null }, execution: { machineId: 'mac', harnessId: `h-${agentId}`, machineOwnerId: 'owner' } } })
/** A Swarm whose agents each work on another person's task, unless [conversations] says otherwise. */
function swarm(pool: ContributedMachine, agents: Agent[], conversations: Conversation[] = agents.map(a => task(a.id))): SuperTabState {
  const state = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
  return { ...state, agents, machines: [pool], conversations: [...state.conversations, ...conversations] }
}

describe('the week a moment belongs to', () => {
  it('starts each week on Monday 00:00 UTC', () => {
    expect(weekStart(MONDAY)).toBe(MONDAY)
    expect(weekStart(MONDAY + 6 * 86_400_000 + 86_399_999)).toBe(MONDAY)
    expect(weekStart(MONDAY - 1)).toBe(MONDAY - 7 * 86_400_000)
  })
})

describe('lent agent-hours from machine readings', () => {
  it('counts only agents working on a task someone other than the machine\'s contributor asked for', () => {
    const pool = machine(['h-busy', 'h-idle', 'h-own', 'h-waiting', 'h-team'], MONDAY)
    const state = swarm(pool, ['busy', 'idle', 'own', 'waiting', 'team'].map(id => agent(id)),
      [task('busy'), task('own', 'working', 'owner'), task('waiting', 'needs_human'), task('team', 'working', undefined)])
    accrueLent(state, pool, MONDAY + 10_000)
    // busy and team (a task nobody named asked for) worked; idle has no task, own is the contributor's, waiting waits on a person.
    expect(pool.lent).toEqual([{ week: MONDAY, busyMs: 20_000 }])
  })

  it('stops writing online hours: a week that has them gains busy hours beside them', () => {
    const pool = machine(['h-a'], MONDAY), state = swarm(pool, [agent('a')])
    pool.lent = [{ week: MONDAY, agentMs: 50_000 }]
    accrueLent(state, pool, MONDAY + 10_000)
    expect(pool.lent).toEqual([{ week: MONDAY, agentMs: 50_000, busyMs: 10_000 }])
  })

  it('adds the time since the last reading for each Swarm agent the machine was running', () => {
    const pool = machine(['h-a', 'h-b'], MONDAY + 1_000), state = swarm(pool, [agent('a'), agent('b')])
    accrueLent(state, pool, MONDAY + 31_000)
    expect(pool.lent).toEqual([{ week: MONDAY, busyMs: 60_000 }])
  })

  it('counts at most one fresh reading\'s worth across a gap, so a machine back from sleep earns no phantom hours', () => {
    const pool = machine(['h-a'], MONDAY), state = swarm(pool, [agent('a')])
    accrueLent(state, pool, MONDAY + 3_600_000)
    expect(pool.lent).toEqual([{ week: MONDAY, busyMs: MACHINE_FRESH_MS }])
  })

  it('ignores sessions that are not Swarm agents on this machine', () => {
    const pool = machine(['h-a', 'someone-else'], MONDAY), state = swarm(pool, [agent('a'), agent('b', { machineId: 'other' })])
    accrueLent(state, pool, MONDAY + 10_000)
    expect(pool.lent).toEqual([{ week: MONDAY, busyMs: 10_000 }])
  })

  it('leaves out an agent of a private conversation: private chats never count', () => {
    const chat: Conversation = { ...task('pm'), id: 'chat', audience: { people: [{ id: 'owner', generation: 'tab' }] } }
    const pool = machine(['h-pm'], MONDAY), state = swarm(pool, [agent('pm')], [chat])
    accrueLent(state, pool, MONDAY + 10_000)
    expect(pool.lent).toBeUndefined()
  })

  it('leaves out a project\'s Lead: its session is confidential coordination, not lent build work (review of #1762)', () => {
    const pool = machine(['h-lead-agent', 'h-builder'], MONDAY), state = swarm(pool, [agent('lead-agent'), agent('builder')])
    state.conversations.find(c => c.id === 'lead')!.leadId = 'lead-agent'
    accrueLent(state, pool, MONDAY + 10_000)
    expect(pool.lent).toEqual([{ week: MONDAY, busyMs: 10_000 }])
  })

  it('adds nothing on the first reading', () => {
    const pool = machine([], 0), state = swarm(pool, [agent('a')])
    delete pool.observation
    accrueLent(state, pool, MONDAY)
    expect(pool.lent).toBeUndefined()
  })

  it('starts a new week on Monday and keeps only the last five weeks', () => {
    const pool = machine(['h-a'], 0), state = swarm(pool, [agent('a')])
    for (let week = 0; week < 7; week++) {
      pool.observation!.receivedAt = MONDAY + week * 7 * 86_400_000
      accrueLent(state, pool, pool.observation!.receivedAt + 5_000)
    }
    expect(pool.lent?.map(l => (l.week - MONDAY) / (7 * 86_400_000))).toEqual([2, 3, 4, 5, 6])
    expect(pool.lent?.every(l => l.busyMs === 5_000)).toBe(true)
  })
})

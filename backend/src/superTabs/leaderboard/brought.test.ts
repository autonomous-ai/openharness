import { describe, expect, it } from 'vitest'
import type { ContributedMachine } from '../machines.js'
import { createSuperTab, type Agent, type Conversation, type SuperTabState } from '../model.js'
import type { GroupLedger, Run } from './record.js'
import { leaderboard } from './stats.js'
import { DAY_MS, WEEK_MS } from './week.js'

// Contributor view (#2444): what each person's machines shipped and did for others, and their subscriptions' week.
// Monday 2026-10-26 00:00 UTC; "now" is Thursday noon of that week.
const WEEK = Date.UTC(2026, 9, 26), LAST = WEEK - WEEK_MS, NOW = WEEK + 3 * DAY_MS + 12 * 3_600_000
const HOUR = 3_600_000

function swarm(): SuperTabState {
  const state = createSuperTab('tab', 'Pilot', { id: 'ken', email: 'ken@example.com' }, 'prod')
  state.people.push(...['dee', 'diego'].map(id => ({ id, email: `${id}@example.com`, role: 'collaborator' as const, generation: 'g' })))
  return state
}
function machine(machineId: string, contributorId: string, extra: Partial<ContributedMachine> = {}): ContributedMachine {
  return { machineId, name: machineId, contributorId, membershipGeneration: 'g', generation: 'g1', cwd: '/repo', scope: 'swarm',
    engines: ['claude'], maxAgents: 2, paused: false, ...extra }
}
const run = (machineId: string | undefined, at: number, extra: Partial<Run> = {}): Run =>
  ({ assignmentId: `a-${at}-${machineId}`, engine: 'claude', model: 'opus', at, ...(machineId ? { machineId } : {}), ...extra })
let n = 0
function group(ledger: GroupLedger, extra: Partial<Conversation> = {}): Conversation {
  const id = `g${++n}`
  return { id, projectId: 'lead', title: `Group ${id}`, leadId: null, agentIds: [], archived: false, brief: 'Do it', checks: [], assignment: null,
    lastMessageSequence: 0, requesterId: 'dee', pullRequestUrls: ['https://github.com/o/r/pull/1'], ledger, ...extra }
}
/** A request someone asked for that shipped at [at] on an attempt that ran on [machineId]. */
const shippedOn = (machineId: string | undefined, at: number, ledger: GroupLedger = {}, extra: Partial<Conversation> = {}) =>
  group({ askedAt: at - HOUR, shippedAt: at, runs: [run(machineId, at - HOUR)], ...ledger }, extra)
const board = (state: SuperTabState, groups: Conversation[], machines = state.machines ?? []) =>
  leaderboard({ state, groups, machines, projectId: 'lead', week: WEEK, now: NOW })
const brought = (view: ReturnType<typeof board>, id: string) => view.people.find(p => p.personId === id)!.details.brought

describe('Brought: the machines a person brought, what shipped on each, and their subscriptions\' week', () => {
  it('lists each machine a person brought with the verified requests that shipped on it, anyone\'s, most first', () => {
    const state = swarm()
    state.machines = [machine('studio', 'ken', { name: 'Mac Studio', lent: [{ week: WEEK, busyMs: 31 * HOUR }] }), machine('mbp', 'ken', { name: 'MacBook Pro' })]
    const view = board(state, [shippedOn('studio', WEEK + HOUR), shippedOn('studio', WEEK + 2 * HOUR, {}, { requesterId: 'ken' }),
      shippedOn('studio', WEEK + 3 * HOUR, {}, { requesterId: 'diego' }),
      // Needed a fix after merge: not verified.
      shippedOn('mbp', WEEK + HOUR, { fixedAfterMergeAt: WEEK + DAY_MS }),
      // Shipped last week: not this week's.
      shippedOn('mbp', LAST + HOUR)])
    expect(brought(view, 'ken')).toEqual([
      { machineId: 'studio', machineName: 'Mac Studio', shipped: 3, busyHours: 31, subscriptions: [{ engine: 'claude', usedPercent: null, resetsAt: null }] },
      { machineId: 'mbp', machineName: 'MacBook Pro', shipped: 0, busyHours: 0, subscriptions: [{ engine: 'claude', usedPercent: null, resetsAt: null }] },
    ])
    expect(brought(view, 'dee')).toEqual([])
  })

  it('credits the attempt the request shipped on, not a later or earlier one', () => {
    const state = swarm()
    state.machines = [machine('studio', 'ken'), machine('box', 'diego')]
    const g = group({ askedAt: WEEK, shippedAt: WEEK + 2 * HOUR, runs: [run('box', WEEK), run('studio', WEEK + HOUR), run('box', WEEK + 3 * HOUR)],
      shippedBy: { assignmentId: 'x', engine: 'claude', model: 'opus', at: WEEK + HOUR, machineId: 'studio' } })
    const view = board(state, [g])
    expect(brought(view, 'ken')[0]!.shipped).toBe(1)
    expect(brought(view, 'diego')[0]!.shipped).toBe(0)
  })

  it('folds a Mac\'s Harness Team account into its Mac: one row, its time and ships added, the Mac\'s subscriptions', () => {
    const state = swarm()
    state.machines = [machine('studio', 'ken', { name: 'Mac Studio', lent: [{ week: WEEK, busyMs: 2 * HOUR }] }),
      machine('studio-team', 'ken', { name: 'Mac Studio · Team', hostMachineId: 'studio', lent: [{ week: WEEK, busyMs: 3 * HOUR }] })]
    const view = board(state, [shippedOn('studio-team', WEEK + HOUR), shippedOn('studio', WEEK + 2 * HOUR)])
    expect(brought(view, 'ken')).toEqual([expect.objectContaining({ machineId: 'studio', machineName: 'Mac Studio', shipped: 2, busyHours: 5 })])
  })

  it('finds an older attempt\'s machine by its agent while that agent exists, and counts one it cannot place nowhere', () => {
    const state = swarm()
    state.machines = [machine('studio', 'ken')]
    state.agents.push({ id: 'worker-1', name: 'Nico', machineId: 'studio', harnessId: 'h1' } as Agent)
    const view = board(state, [shippedOn(undefined, WEEK + HOUR, { runs: [run(undefined, WEEK, { agentId: 'worker-1' })] }),
      shippedOn(undefined, WEEK + 2 * HOUR, { runs: [run(undefined, WEEK, { agentId: 'gone' })] })])
    expect(brought(view, 'ken')[0]!.shipped).toBe(1)
  })

  it('shows each contributed engine\'s weekly window: percent used and when it resets, or unknown', () => {
    const state = swarm(), resets = WEEK + 6 * DAY_MS
    state.machines = [machine('studio', 'ken', { engines: ['claude', 'codex'], observation: { receivedAt: NOW, quotas: [
      { engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 90, resetsAt: NOW + HOUR }, { name: 'weekly', usedPercent: 38, resetsAt: new Date(resets).toISOString() }] },
      { engine: 'codex', known: false, windows: [] }] } as unknown as ContributedMachine['observation'] })]
    expect(brought(board(state, []), 'ken')[0]!.subscriptions).toEqual([
      { engine: 'claude', usedPercent: 38, resetsAt: resets }, { engine: 'codex', usedPercent: null, resetsAt: null }])
  })

  it('reads a reset given in epoch seconds as well as milliseconds or a date', () => {
    const state = swarm(), resets = WEEK + 6 * DAY_MS
    state.machines = [machine('studio', 'ken', { observation: { receivedAt: NOW, quotas: [
      { engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 10, resetsAt: resets / 1000 }] }] } as unknown as ContributedMachine['observation'] })]
    expect(brought(board(state, []), 'ken')[0]!.subscriptions).toEqual([{ engine: 'claude', usedPercent: 10, resetsAt: resets }])
  })

  it('never lists a machine the reader cannot see, nor counts a group the reader was not handed', () => {
    const state = swarm()
    state.machines = [machine('studio', 'ken'), machine('hidden', 'ken')]
    const view = board(state, [shippedOn('studio', WEEK + HOUR)], [state.machines[0]!])
    expect(brought(view, 'ken').map(m => m.machineId)).toEqual(['studio'])
    expect(brought(board(state, [], [state.machines[0]!]), 'ken')[0]!.shipped).toBe(0)
  })

  it('never counts a private chat\'s work, even one carrying a ship record', () => {
    const state = swarm()
    state.machines = [machine('studio', 'ken')]
    const view = board(state, [shippedOn('studio', WEEK + HOUR, {}, { audience: { people: [{ id: 'ken', generation: 'g' }] } })])
    expect(brought(view, 'ken')[0]!.shipped).toBe(0)
  })
})

describe('Contributors: people whose machine ran work this period, last period, and how many kept going', () => {
  it('counts each person once whose machine ran an attempt, requests and review steps alike', () => {
    const state = swarm()
    state.machines = [machine('studio', 'ken'), machine('mbp', 'ken'), machine('box', 'diego'), machine('dee-mac', 'dee')]
    const view = board(state, [
      group({ runs: [run('studio', WEEK + HOUR), run('mbp', WEEK + 2 * HOUR), run('studio', LAST + HOUR)] }),
      group({ runs: [run('box', LAST + HOUR)] }),
      group({ runs: [run('dee-mac', WEEK + HOUR)] }, { reviewOf: 'g0' }),
    ])
    expect(view.contributors).toEqual({ thisWeek: 2, lastWeek: 2, kept: 1 })
  })

  it('counts nothing for a private chat\'s work or a machine the reader cannot see', () => {
    const state = swarm()
    state.machines = [machine('studio', 'ken'), machine('box', 'diego')]
    const view = board(state, [group({ runs: [run('studio', WEEK + HOUR)] }, { audience: { people: [{ id: 'ken', generation: 'g' }] } }),
      group({ runs: [run('box', WEEK + HOUR)] })], [state.machines[0]!])
    expect(view.contributors).toEqual({ thisWeek: 0, lastWeek: 0, kept: 0 })
  })
})

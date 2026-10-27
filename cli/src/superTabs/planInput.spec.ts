import { describe, expect, it } from 'vitest'
import { parsePlanRequest, planSetup } from './planInput.js'
import { group, machine, NOW, policy, state, type Json } from './fixtures/planState.js'

const setup = (s: Json, request = {}) => planSetup({ state: s, policy, leadId: 'lead1', request, githubApp: false, now: NOW })
const taskOf = (s: ReturnType<typeof setup>, id: string) => (s.instance.tasks as Json[]).find(t => t.id === id)!

describe('parsePlanRequest', () => {
  it('takes no input as no assessments', () => expect(parsePlanRequest(undefined)).toEqual({}))
  it('reads each group\'s assessment, kind and the groups it waits for', () => {
    expect(parsePlanRequest({ groups: { g1: { difficulty: 'high', risk: 'low', size: 'large', kind: 'ui', after: ['g2'] } } }))
      .toEqual({ g1: { difficulty: 'high', risk: 'low', size: 'large', kind: 'ui', after: ['g2'] } })
  })
  it('refuses a bad level, size, kind or group id', () => {
    expect(parsePlanRequest({ groups: { g1: { difficulty: 'hard', risk: 'low', size: 'small' } } })).toMatch(/difficulty/)
    expect(parsePlanRequest({ groups: { g1: { difficulty: 'low', risk: 'low', size: 'huge' } } })).toMatch(/size/)
    expect(parsePlanRequest({ groups: { g1: { difficulty: 'low', risk: 'low', size: 'small', kind: 'Two Words' } } })).toMatch(/kind/)
    expect(parsePlanRequest({ groups: { 'not an id': { difficulty: 'low', risk: 'low', size: 'small' } } })).toMatch(/group/)
    expect(parsePlanRequest({ groups: { g1: { difficulty: 'low', risk: 'low', size: 'small', after: ['bad id'] } } })).toMatch(/after/)
    expect(parsePlanRequest([])).toMatch(/groups/)
  })
})

describe('planSetup', () => {
  it('plans the Lead\'s open groups: defined and not archived, never assigned or with their agent lost', () => {
    const work = (status: string) => ({ assignment: { id: status, agentId: 'x', status } })
    const s = setup(state({ conversations: [{ id: 'lead', leadId: 'lead1', title: 'Lead' }, group('g1'),
      group('g2', work('working')), group('g3', { archived: true }), group('g4', { task: null }), group('g5', { leadId: 'someone else' }),
      group('g6', work('done')), group('g7', work('lost')), group('g8', work('cancelled')), group('g9', work('review'))] }))
    expect((s.instance.tasks as Json[]).map(t => t.id)).toEqual(['g1', 'g7'])
  })

  it('takes the Lead\'s assessment, and marks a group without one as an estimate at medium', () => {
    const s = setup(state(), { g1: { difficulty: 'high', risk: 'high', size: 'large', kind: 'backend' } })
    expect(taskOf(s, 'g1')).toMatchObject({ minutes: 180, floor: 3, kind: 'backend', difficulty: 'high', spend: { '5-hour': 50, weekly: 8 } })
    expect(taskOf(s, 'g2')).toMatchObject({ minutes: 60, floor: 2, kind: 'default', difficulty: 'medium' })
    expect(s.estimates).toEqual(['g2'])
  })

  it('keeps each task to the machines the owner\'s machines rule leaves for its project', () => {
    const rules = [{ projectId: 'p1', rule: { kind: 'machines', machineIds: ['m2'] }, text: 'Only m2.' },
      { projectId: 'p2', rule: { kind: 'machines', machineIds: ['m1'] }, text: 'Other project.' }]
    expect(taskOf(setup(state({ rules })), 'g1').machines).toEqual(['m2'])
  })

  it('lets a machines rule naming a Mac allow its Harness Team account too, as the route does', () => {
    const rules = [{ projectId: 'p1', rule: { kind: 'machines', machineIds: ['m1'] }, text: 'Only m1.' }]
    const s = setup(state({ rules, machines: [machine('m1'), machine('m1-team', { hostMachineId: 'm1' }), machine('m2')] }))
    expect(taskOf(s, 'g1').machines).toEqual(['m1', 'm1-team'])
  })

  it('leaves out a forbidden model and a row below the minimum effort, lifting a row that leaves the effort to the engine', () => {
    const rules = [{ projectId: 'p1', rule: { kind: 'forbidModel', model: 'opus' }, text: 'No Opus.' },
      { projectId: 'p1', rule: { kind: 'minEffort', effort: 'high' }, text: 'At least high.' }]
    const s = setup(state({ rules }))
    // Opus is forbidden and Sonnet medium is below high; Codex default is lifted to high and stays.
    expect(taskOf(s, 'g1').models).toEqual(['codex-default-default'])
    expect(s.effortFor('g1', 'codex-default-default')).toBe('high')
  })

  it('puts a review after its open build on another family, and keeps a review of finished work off its build\'s family', () => {
    const s = setup(state({ conversations: [group('b1'), group('r1', { reviewOf: 'b1' }),
      group('b2', { assignment: { id: 'a', agentId: 'x', status: 'done', configuration: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'auto' } } }),
      group('r2', { reviewOf: 'b2' })].map((g, i) => i === 2 ? { ...g, assignment: { ...(g.assignment as Json), status: 'working' } } : g) }))
    expect(taskOf(s, 'r1')).toMatchObject({ kind: 'review', deps: ['b1'], independent_of: ['b1'], avoid_families: [] })
    expect(taskOf(s, 'r2')).toMatchObject({ kind: 'review', deps: [], independent_of: [], avoid_families: ['codex'] })
  })

  it('adds the groups the Lead says a group waits for, and lists one that is not open', () => {
    const s = setup(state(), { g2: { difficulty: 'low', risk: 'low', size: 'small', after: ['g1', 'gone'] } })
    expect(taskOf(s, 'g2').deps).toEqual(['g1'])
    expect(s.ignored).toEqual(['gone'])
  })

  it('leaves out machines that cannot take a new agent now, saying why', () => {
    const s = setup(state({ machines: [machine('m1'), machine('old', {}, { receivedAt: NOW - 60_000 }), machine('paused', { paused: true }),
      machine('full', { availableSlots: 0 }), machine('win', {}, { resources: { memoryTotalBytes: 68_719_476_736, memoryUsedBytes: 1, projectDiskFreeBytes: 132_155_797_504, os: 'Windows' } }),
      machine('tight', {}, { resources: { memoryTotalBytes: 8_000_000_000, memoryUsedBytes: 7_500_000_000, projectDiskFreeBytes: 132_155_797_504, os: 'macOS' } })] }))
    expect((s.instance.machines as Json[]).map(m => m.id)).toEqual(['m1'])
    expect(Object.fromEntries(s.leftOut.map(l => [l.machine, l.reason]))).toEqual({
      'old.local': 'Machine is offline or unreachable.', 'paused.local': 'New work is paused on this machine.',
      'full.local': 'This machine has no available agent slots.', 'win.local': 'Swarm agents do not run on Windows yet.',
      'tight.local': 'Insufficient measured free memory.' })
  })

  it('gives each machine its free slots and only the engines that can start work', () => {
    const s = setup(state({ machines: [machine('m1', { availableSlots: 3 }, {
      readiness: { engines: [{ engine: 'codex', installed: true, signedIn: false }] } }), machine('m2', {}, {
      quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 100, resetsAt: '2026-11-01T19:00:00+00:00' }] }] })] }))
    expect(s.instance.machines).toEqual([{ id: 'm1', name: 'm1.local', slots: 3, engines: ['claude'] }, { id: 'm2', name: 'm2.local', slots: 2, engines: ['codex'] }])
  })

  it('reads each account\'s windows with minutes to their reset, sharing an account two machines report', () => {
    const shared = { engine: 'codex', known: true, account: 'acct-x', windows: [{ name: 'weekly', usedPercent: 40, resetsAt: 1793592000 }] }
    const s = setup(state({ machines: [machine('m1', {}, { quotas: [shared] }), machine('m2', {}, { quotas: [shared,
      { engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 20, resetsAt: '2026-10-27T00:30:00+00:00' }, { name: 'weekly', usedPercent: 30, resetsAt: '2026-11-01T19:00:00+00:00' }] }] })] }))
    // 1793592000 s is 2026-11-02T04:00Z, 8820 minutes on; 2026-11-01T19:00Z is 8280. The claude 5-hour reset has passed, so it is full again.
    expect(s.instance.accounts).toEqual([
      { id: 'acct-x', members: [['m1', 'codex'], ['m2', 'codex']], reserve: 10, windows: [{ name: 'weekly', left: 60, resets_in: 8820 }] },
      { id: 'm2:claude', members: [['m2', 'claude']], reserve: 10, windows: [{ name: '5-hour', left: 100, resets_in: null }, { name: 'weekly', left: 70, resets_in: 8280 }] },
    ])
  })

  it('offers a model served on the grid with the Builders it still takes, but never for a review', () => {
    const served = { localModels: [{ grid: 'swarm-g', model: 'deepseek/flash', name: 'DeepSeek · OpenRouter', kind: 'api' }] }
    const s = setup(state({ machines: [machine('m1', {}, served), machine('m2')],
      starts: [{ request: { gridModel: 'deepseek/flash', gridName: 'swarm-g' }, harnessId: null, error: null }],
      conversations: [group('g1'), group('r1', { reviewOf: 'g1' })] }))
    expect((s.instance.models as Json[]).find(m => m.id === 'grid:deepseek/flash')).toEqual({ id: 'grid:deepseek/flash', engine: 'claude', cost: 1,
      quality: { default: 1 }, concurrency: 3, subscription: false, remote: true, family: 'deepseek/flash', label: 'Claude on DeepSeek · OpenRouter (API)' })
    expect(taskOf(s, 'g1').models).toContain('grid:deepseek/flash')
    expect(taskOf(s, 'r1').models).not.toContain('grid:deepseek/flash')
    expect(s.rows['grid:deepseek/flash']).toEqual({ engine: 'claude', model: 'default', effort: 'default', gridModel: 'deepseek/flash', gridName: 'swarm-g' })
  })

  it('offers a model shared from another grid only on the machines it was shared with', () => {
    const shared = { localModels: [{ grid: 'other-grid', model: 'qwen/coder', name: 'Qwen' }] }
    const s = setup(state({ machines: [machine('m1', {}, shared), machine('m2')] }))
    expect((s.instance.models as Json[]).find(m => m.id === 'grid:qwen/coder')).toMatchObject({ machines: ['m1'], concurrency: 1, remote: true, label: 'Claude on Qwen (shared)' })
  })
})

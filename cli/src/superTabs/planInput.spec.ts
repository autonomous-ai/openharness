import { describe, expect, it } from 'vitest'
import { parsePlanRequest, planSetup } from './planInput.js'
import { catalog, group, machine, NOW, state, type Json } from './fixtures/planState.js'

const setup = (s: Json, request = {}) => planSetup({ state: s, catalog, leadId: 'lead1', request, githubApp: false, now: NOW })
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

  it('takes the agent\'s assessment, and marks a group without one as an estimate at medium', () => {
    const s = setup(state(), { g1: { difficulty: 'high', risk: 'high', size: 'large', kind: 'backend' } })
    expect(taskOf(s, 'g1')).toMatchObject({ minutes: 180, floor: 3, kind: 'backend', difficulty: 'high', spend: { '5-hour': 50, weekly: 8 } })
    expect(taskOf(s, 'g2')).toMatchObject({ minutes: 60, floor: 2, kind: 'default', difficulty: 'medium' })
    expect(s.estimates).toEqual(['g2'])
  })

  // A Mac (m1, its owner's) and its Harness Team account (m1-team) are one machine (docs/plans/2026-10-24-swarm-team-account.md).
  const mac = () => [machine('m1'), machine('m1-team', { hostMachineId: 'm1' }), machine('m2')]
  const projects = [{ id: 'p1', ownerId: 'owner', repository: { machineId: 'm1', cwd: '/repo', repositoryUrl: 'https://github.com/o/r' } },
    { id: 'p2', ownerId: 'mate', repository: { machineId: 'm2', cwd: '/repo', repositoryUrl: 'https://github.com/o/r2' } }]

  it('keeps a task that requires a machine to that machine, or its Mac\'s team account, as the route does', () => {
    // 2026-10-27: a task to check a device plugged into one person's Mac went to another machine by policy order.
    const requires = (r: Json) => ({ task: { goal: 'g', changes: 'c', constraints: 'k', owns: ['o'], requires: r } })
    const s = setup(state({ projects, machines: mac(), conversations: [group('r1', requires({ machines: ['m2'] })),
      group('r2', { projectId: 'p2', ...requires({ machines: ['m1'] }) }), group('r3', requires({ machines: [], unseenMachines: 1 })), group('free')] }))
    expect(taskOf(s, 'r1').machines).toEqual(['m2'])
    expect(taskOf(s, 'r2').machines).toEqual(['m1-team'])
    expect(taskOf(s, 'r3').machines).toEqual([])
    expect(taskOf(s, 'free').machines).toEqual(['m1', 'm2'])
  })

  it('offers no machine to a task that requires a device, since no machine reports its devices to the plan', () => {
    const s = setup(state({ conversations: [group('d1', { task: { goal: 'g', changes: 'c', constraints: 'k', owns: ['o'], requires: { devices: ['/dev/cu.usbmodem1'] } } })] }))
    expect(taskOf(s, 'd1').machines).toEqual([])
  })

  it('offers a Mac\'s own projects on the Mac and a teammate\'s in its team account, never both', () => {
    const s = setup(state({ projects, machines: mac(), conversations: [group('o1', { projectId: 'p1' }), group('t1', { projectId: 'p2' })] }))
    expect(taskOf(s, 'o1').machines).toEqual(['m1', 'm2'])
    expect(taskOf(s, 't1').machines).toEqual(['m1-team', 'm2'])
  })

  it('has a Mac and its team account share the Mac\'s slots', () => {
    const s = setup(state({ projects, machines: mac() }))
    expect((s.instance.machines as Json[]).find(m => m.id === 'm1-team')).toMatchObject({ pool: 'm1' })
    expect((s.instance.machines as Json[]).find(m => m.id === 'm1')).not.toHaveProperty('pool')
  })

  it('puts a linked task after the open work it links to, and on any model family', () => {
    const s = setup(state({ conversations: [group('b1'), group('r1', { reviewOf: 'b1' }),
      group('b2', { assignment: { id: 'a', agentId: 'x', status: 'done', configuration: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'auto' } } }),
      group('r2', { reviewOf: 'b2' })].map((g, i) => i === 2 ? { ...g, assignment: { ...(g.assignment as Json), status: 'working' } } : g) }))
    expect(taskOf(s, 'r1')).toMatchObject({ kind: 'default', deps: ['b1'], independent_of: [], avoid_families: [] })
    expect(taskOf(s, 'r2')).toMatchObject({ kind: 'default', deps: [], independent_of: [], avoid_families: [] })
  })

  it('adds the groups the Lead says a group waits for, and lists one that is not open', () => {
    const s = setup(state(), { g2: { difficulty: 'low', risk: 'low', size: 'small', after: ['g1', 'gone'] } })
    expect(taskOf(s, 'g2').deps).toEqual(['g1'])
    expect(s.ignored).toEqual(['gone'])
  })

  // Diego's issue, 2026-10-27: an assessment of a group that is not open (a typo, a finished group) was dropped without a word,
  // and the group meant was planned at the default.
  it('lists an assessed group that is not open', () => {
    const s = setup(state(), { typo: { difficulty: 'high', risk: 'high', size: 'large' } })
    expect(s.ignored).toEqual(['typo'])
    expect(s.estimates).toEqual(['g1', 'g2'])
  })

  it('lists a group that is not open once, however many name it', () => {
    const low = { difficulty: 'low', risk: 'low', size: 'small' } as const
    const s = setup(state(), { g1: { ...low, after: ['gone'] }, g2: { ...low, after: ['gone'] }, gone: low })
    expect(s.ignored).toEqual(['gone'])
  })

  it('leaves out machines that cannot take a new agent now, saying why', () => {
    const s = setup(state({ machines: [machine('m1'), machine('old', {}, { receivedAt: NOW - 60_000 }), machine('paused', { paused: true }),
      machine('full', { availableSlots: 0 }), machine('win', {}, { resources: { memoryTotalBytes: 68_719_476_736, memoryUsedBytes: 1, projectDiskFreeBytes: 132_155_797_504, os: 'Windows' } }),
      machine('tight', {}, { resources: { memoryTotalBytes: 8_000_000_000, memoryUsedBytes: 7_500_000_000, projectDiskFreeBytes: 132_155_797_504, os: 'macOS' } })] }))
    // A Windows machine is planned like any other (Swarm agents run there since grid 0.3.61 and CLI 0.4.95).
    expect((s.instance.machines as Json[]).map(m => m.id)).toEqual(['m1', 'win'])
    expect(Object.fromEntries(s.leftOut.map(l => [l.machine, l.reason]))).toEqual({
      'old.local': 'Machine is offline or unreachable.', 'paused.local': 'New work is paused on this machine.',
      'full.local': 'This machine has no available agent slots.',
      'tight.local': 'Insufficient measured free memory.' })
  })

  it('gives each machine its free slots and the engines that can start work, one on a used-up account among them', () => {
    const s = setup(state({ machines: [machine('m1', { availableSlots: 3 }, {
      readiness: { engines: [{ engine: 'codex', installed: true, signedIn: false }] } }), machine('m2', {}, {
      quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 100, resetsAt: '2026-11-01T19:00:00+00:00' }] }] })] }))
    expect(s.instance.machines).toEqual([{ id: 'm1', name: 'm1.local', slots: 3, engines: ['claude'] }, { id: 'm2', name: 'm2.local', slots: 2, engines: ['claude', 'codex'] }])
  })

  // The route notes a machine whose last two starts started nothing, and offers it (routeCommand.ts STALLED): so does the plan.
  it('plans on a machine whose last starts failed', () => {
    const failed = (id: string) => ({ id, request: { machineId: 'm2' }, harnessId: null, dispatched: true, error: 'The engine did not start.', dispatchedAt: NOW - 60_000 })
    const s = setup(state({ starts: [failed('s1'), failed('s2')] }))
    expect((s.instance.machines as Json[]).map(m => m.id)).toEqual(['m1', 'm2'])
    expect(s.leftOut).toEqual([])
  })

  it('reads each account\'s windows with minutes to their reset, sharing an account two machines report', () => {
    const shared = { engine: 'codex', known: true, account: 'acct-x', windows: [{ name: 'weekly', usedPercent: 40, resetsAt: 1793592000 }] }
    const s = setup(state({ machines: [machine('m1', {}, { quotas: [shared] }), machine('m2', {}, { quotas: [shared,
      { engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 20, resetsAt: '2026-10-27T00:30:00+00:00' }, { name: 'weekly', usedPercent: 30, resetsAt: '2026-11-01T19:00:00+00:00' }] }] })] }))
    // 1793592000 s is 2026-11-02T04:00Z, 8820 minutes on; 2026-11-01T19:00Z is 8280. The claude 5-hour reset has passed, so it is full again.
    expect(s.instance.accounts).toEqual([
      { id: 'acct-x', members: [['m1', 'codex'], ['m2', 'codex']], reserve: 0, windows: [{ name: 'weekly', left: 60, resets_in: 8820 }] },
      { id: 'm2:claude', members: [['m2', 'claude']], reserve: 0, windows: [{ name: '5-hour', left: 100, resets_in: null }, { name: 'weekly', left: 70, resets_in: 8280 }] },
    ])
  })

  it('offers a model served on the grid with the agents it still takes, to a linked task too', () => {
    const served = { localModels: [{ grid: 'swarm-g', model: 'deepseek/flash', name: 'DeepSeek · OpenRouter', kind: 'api' }] }
    const s = setup(state({ machines: [machine('m1', {}, served), machine('m2')],
      starts: [{ request: { gridModel: 'deepseek/flash', gridName: 'swarm-g' }, harnessId: null, error: null }],
      conversations: [group('g1'), group('r1', { reviewOf: 'g1' })] }))
    expect((s.instance.models as Json[]).find(m => m.id === 'grid:deepseek/flash')).toEqual({ id: 'grid:deepseek/flash', engine: 'claude', cost: 1,
      quality: { default: 1 }, concurrency: 3, subscription: false, remote: true, family: 'deepseek/flash', label: 'Claude on DeepSeek · OpenRouter (API)' })
    expect(taskOf(s, 'g1').models).toContain('grid:deepseek/flash')
    expect(taskOf(s, 'r1').models).toContain('grid:deepseek/flash')
    expect(s.rows['grid:deepseek/flash']).toEqual({ engine: 'claude', model: 'default', effort: 'default', gridModel: 'deepseek/flash', gridName: 'swarm-g' })
  })

  // Project instructions, phase 4: the plan, like the route, leaves out only what cannot run. No owner rule leaves out a
  // machine or a model, no account has a reserve, a linked task may take a grid model, and a used-up engine still runs. A
  // task's floor is its difficulty's strength (final review, below), not the owner's.
  it('plans every open group with no rule or reserve', () => {
    const rules = [{ projectId: 'p1', rule: { kind: 'machines', machineIds: ['m2'] }, text: 'Only m2.' },
      { projectId: 'p1', rule: { kind: 'forbidModel', model: 'opus' }, text: 'No Opus.' },
      { projectId: 'p1', rule: { kind: 'minEffort', effort: 'high' }, text: 'At least high.' }]
    const served = { localModels: [{ grid: 'swarm-g', model: 'deepseek/flash', name: 'DeepSeek', kind: 'api' }] }
    const usedUp = { quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 100, resetsAt: '2026-11-01T19:00:00+00:00' }] }] }
    const s = setup(state({ rules, machines: [machine('m1', {}, { ...served, ...usedUp }), machine('m2')],
      conversations: [group('b1'), group('r1', { reviewOf: 'b1' })] }), { b1: { difficulty: 'high', risk: 'high', size: 'large' } })
    expect((s.instance.tasks as Json[]).map(t => [t.id, t.floor])).toEqual([['b1', 3], ['r1', 2]])
    for (const task of s.instance.tasks as Json[]) {
      expect(task).toMatchObject({ independent_of: [], machines: ['m1', 'm2'],
        models: ['claude-opus-high', 'codex-default-default', 'claude-sonnet-medium', 'grid:deepseek/flash'] })
    }
    // A review still waits for the work it reviews.
    expect(taskOf(s, 'r1').deps).toEqual(['b1'])
    expect((s.instance.machines as Json[]).find(m => m.id === 'm1')).toMatchObject({ engines: ['claude', 'codex'] })
    expect((s.instance.accounts as Json[]).map(a => a.reserve)).toEqual([0, 0, 0])
    // A row starts at its own effort: no minimum lifts it.
    expect(s.rows['codex-default-default']).toMatchObject({ effort: 'default' })
  })

  // Final review: every task had floor 1 and the solver minimizes finish time then cost, so the plan picked the cheapest
  // models, strength-1 grid models too small to drive a coding agent among them, while the route ranks by strength first.
  describe('strength', () => {
    it('gives each task the strength its difficulty asks: low 1, medium 2, high 3', () => {
      const s = setup(state({ conversations: [group('l'), group('m'), group('h')] }), { l: { difficulty: 'low', risk: 'low', size: 'small' },
        m: { difficulty: 'medium', risk: 'low', size: 'small' }, h: { difficulty: 'high', risk: 'low', size: 'small' } })
      expect((s.instance.tasks as Json[]).map(t => [t.id, t.floor])).toEqual([['l', 1], ['m', 2], ['h', 3]])
      expect(s.understrength).toEqual([])
    })
    it('asks no more than the strongest model that can run the task, and lists the task', () => {
      // Only Sonnet (2) offered: a high task asks 2.
      const weak = { ...catalog, models: catalog.models.filter(m => m.model === 'sonnet') }
      const s = planSetup({ state: state(), catalog: weak, leadId: 'lead1', request: { g1: { difficulty: 'high', risk: 'low', size: 'small' } }, githubApp: false, now: NOW })
      expect(taskOf(s, 'g1').floor).toBe(2)
      expect(s.understrength).toEqual(['g1'])
      // Machines with Claude alone still run Opus (3).
      const claudeOnly = setup(state({ machines: [machine('m1', { engines: ['claude'] }), machine('m2', { engines: ['claude'] })] }), { g1: { difficulty: 'high', risk: 'low', size: 'small' } })
      expect(taskOf(claudeOnly, 'g1').floor).toBe(3)
      // A task no machine may run keeps its difficulty's floor: the scheduler says it has no machine.
      const nowhere = setup(state({ conversations: [group('d1', { task: { goal: 'g', changes: 'c', constraints: 'k', owns: ['o'], requires: { devices: ['/dev/x'] } } })] }))
      expect(taskOf(nowhere, 'd1').floor).toBe(2)
      expect(nowhere.understrength).toEqual([])
    })
    it('leaves out a grid model too small or slow to drive a coding agent, as the route notes it', () => {
      const why = 'llama3.2:3b is too small for a coding agent (about 3B parameters; a coding agent needs 7B or more).'
      const s = setup(state({ machines: [machine('m1', {}, { localModels: [{ grid: 'swarm-g', model: 'qwen3-coder:30b', name: 'Qwen3 Coder' }],
        refusedModels: [{ grid: 'swarm-g', model: 'llama3.2:3b', why }] }), machine('m2')] }))
      const ids = (s.instance.models as Json[]).map(m => m.id)
      expect(ids).toContain('grid:qwen3-coder:30b')
      expect(ids).not.toContain('grid:llama3.2:3b')
      expect(Object.keys(s.rows)).not.toContain('grid:llama3.2:3b')
    })
  })

  it('offers a model shared from another grid only on the machines it was shared with', () => {
    const shared = { localModels: [{ grid: 'other-grid', model: 'qwen/coder', name: 'Qwen' }] }
    const s = setup(state({ machines: [machine('m1', {}, shared), machine('m2')] }))
    expect((s.instance.models as Json[]).find(m => m.id === 'grid:qwen/coder')).toMatchObject({ machines: ['m1'], concurrency: 1, remote: true, label: 'Claude on Qwen (shared)' })
  })
})

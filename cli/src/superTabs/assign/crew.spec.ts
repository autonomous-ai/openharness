import { describe, expect, it } from 'vitest'
import { crewOf, CORES, DEEP, dependsOn, labelOf, machineHas, MEMORY_SHARE, nextPicks, readProblem, reasonOf, RESERVE, SIZES, type Crew } from './crew.js'
import { solve } from './search.js'

type Json = Record<string, unknown>
const GiB = 1024 ** 3
const NOW = Date.parse('2026-11-09T15:00:00Z')
const issue = (number: number, labels: string[], extra: Json = {}): Json => ({ number, labels: labels.map(name => ({ name })), ...extra })
const machine = (machineId: string, observation: Json = {}) => ({ machineId, observation: {
  resources: { memoryTotalBytes: 32 * GiB, projectDiskFreeBytes: 200 * GiB, os: 'macOS 26' },
  quotas: [{ engine: 'claude', known: true, windows: [{ name: 'five_hour', usedPercent: 30, resetsAt: new Date(NOW + 120 * 60_000).toISOString() },
    { name: 'seven_day', usedPercent: 50, resetsAt: NOW + 3 * 24 * 60 * 60_000 }] }],
  ...observation } })
/** Pip and Juno on one Mac, Atlas on a Linux box. */
const crew = (): Crew => ({
  builders: [
    { id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' },
    { id: 'juno', name: 'Juno', label: 'builder:juno', machineId: 'mac', engine: 'claude' },
    { id: 'atlas', name: 'Atlas', label: 'builder:atlas', machineId: 'box', engine: 'codex', model: 'gpt-5.5' },
  ],
  machines: [machine('mac', { tools: { xcode: true } }), machine('box', { resources: { memoryTotalBytes: 16 * GiB, diskFreeBytes: 40 * GiB, os: 'Ubuntu 24.04' }, quotas: [] })],
})

describe('a team\'s tasks as GitHub and the Swarm say them (readProblem)', () => {
  it('makes a task of each issue the PM sized that nobody holds, with its size, part, priority and what it needs', () => {
    const read = readProblem({ now: NOW, crew: crew(), closed: [], issues: [
      issue(1, ['size:s', 'part:api', 'p0']), issue(2, ['size:l', 'needs:xcode']), issue(3, ['part:api']),
      issue(4, ['size:m'], { pull_request: {} }), issue(5, ['size:m'], { body: 'Comes after #1, and depends on #99.' }),
    ] })
    expect(read.problem.tasks.map(t => t.id)).toEqual(['#1', '#2', '#5'])
    const [first, second, fifth] = read.problem.tasks
    expect(first).toMatchObject({ minutes: SIZES.s.minutes, needs: { cpu: SIZES.s.cpu, ram: SIZES.s.ram, disk: SIZES.s.disk }, part: 'api', weight: 8,
      spend: { five_hour: SIZES.s.spend, seven_day: SIZES.s.spend / 5 }, notBuilders: [] })
    // Only a machine that reports Xcode builds what needs it.
    expect(second).toMatchObject({ minutes: SIZES.l.minutes, weight: 1, notBuilders: ['atlas'] })
    // A dependency on an issue that is not open is not waited for.
    expect(fifth!.deps).toEqual(['#1'])
    expect([...read.free]).toEqual(['#1', '#2', '#5'])
  })

  it('queues what a builder holds on it, keeps it busy for half the one it took, and leaves another team\'s alone', () => {
    const read = readProblem({ now: NOW, crew: crew(), closed: [], issues: [
      issue(1, ['size:l', 'builder:pip', 'status:taken']), issue(2, ['size:m', 'builder:pip']), issue(3, ['builder:juno']),
      issue(4, ['size:s', 'builder:someone-else']), issue(5, ['size:s']),
    ] })
    expect(read.problem.tasks.map(t => [t.id, t.pinned ?? null])).toEqual([['#2', 'pip'], ['#3', 'juno'], ['#5', null]])
    expect(read.problem.builders.find(b => b.id === 'pip')!.busyUntil).toBe(SIZES.l.minutes / 2)
    expect(Object.fromEntries(read.open)).toEqual({ pip: 2, juno: 1, atlas: 0 })
    expect([...read.free]).toEqual(['#5'])
  })

  it('reads each machine\'s room and each subscription\'s windows, its person\'s reserve kept', () => {
    const { problem } = readProblem({ now: NOW, crew: crew(), closed: [], issues: [issue(1, ['size:s'])] })
    expect(problem.machines).toEqual([
      { id: 'mac', capacity: { cpu: CORES, ram: 32 * GiB * MEMORY_SHARE, disk: 190 * GiB } },
      { id: 'box', capacity: { cpu: CORES, ram: 16 * GiB * MEMORY_SHARE, disk: 30 * GiB } },
    ])
    expect(problem.accounts).toEqual([
      { id: 'mac:claude', reserve: RESERVE, windows: [{ name: 'five_hour', left: 70, resetsAt: 120, every: 300 },
        { name: 'seven_day', left: 50, resetsAt: 3 * 24 * 60, every: 7 * 24 * 60 }] },
      // A subscription whose windows its machine could not read is not held to any.
      { id: 'box:codex', reserve: RESERVE, windows: [] },
    ])
  })

  it('makes a builder quicker in a part where it finished tasks', () => {
    const closed = [issue(10, ['builder:pip', 'part:api']), issue(11, ['builder:pip', 'part:api']), issue(12, ['builder:juno', 'part:ui']),
      issue(13, ['builder:pip', 'part:api'], { pull_request: {} })]
    const read = readProblem({ now: NOW, crew: crew(), closed, issues: [issue(1, ['size:s', 'part:api'])] })
    expect(read.problem.builders.find(b => b.id === 'pip')!.context).toEqual({ api: 0.7 })
    expect(read.problem.builders.find(b => b.id === 'juno')!.context).toEqual({ ui: 0.85 })
    expect(read.done.get('pip')?.get('api')).toBe(2)
  })
})

describe('what each builder starts next (nextPicks)', () => {
  it('gives the free tasks in the plan\'s order, each builder\'s list kept two deep', () => {
    const issues = [issue(1, ['size:m', 'p0']), issue(2, ['size:m', 'p1']), issue(3, ['size:m']), issue(4, ['size:m']), issue(5, ['size:m']),
      issue(6, ['size:m']), issue(7, ['size:m']), issue(8, ['size:m', 'builder:atlas'])]
    const read = readProblem({ now: NOW, crew: crew(), closed: [], issues })
    const { plan } = solve(read.problem, { seed: 1, budgetMs: 2_000 })
    const picks = nextPicks(plan, read)
    const count = (builder: string) => picks.filter(p => p.builder === builder).length + (read.open.get(builder) ?? 0)
    for (const builder of ['pip', 'juno', 'atlas']) expect(count(builder)).toBeLessThanOrEqual(DEEP)
    expect(picks.map(p => p.task)).toEqual(expect.arrayContaining(['#1', '#2']))
    // The p0 starts at once.
    expect(picks.find(p => p.task === '#1')!.start).toBe(0)
    expect(picks.some(p => p.task === '#8')).toBe(false)
  })

  it('says when the builder can start it and what it finished in its part', () => {
    const closed = [issue(10, ['builder:pip', 'part:api'])]
    const read = readProblem({ now: NOW, crew: crew(), closed, issues: [issue(1, ['size:s', 'part:api'])] })
    expect(reasonOf({ task: '#1', builder: 'pip', start: 0 }, read)).toBe('it can start now, and it finished 1 part:api task')
    expect(reasonOf({ task: '#1', builder: 'juno', start: 45 }, read)).toBe('it can start in 45 min')
    expect(reasonOf({ task: '#1', builder: 'juno', start: 150 }, read)).toBe('it can start in 3 h')
  })
})

describe('the crew a project\'s PM reads (crewOf)', () => {
  it('takes the regular Claude Code and Codex agents that may work in the project, never the PM, a Buddy, one stopping or down', () => {
    const agent = (id: string, extra: Json = {}) => ({ id, regular: true, name: id, machineId: 'mac', configuration: { engine: 'claude' }, ...extra })
    const state = { agents: [agent('pm'), agent('pip', { displayName: 'Pip' }), agent('juno', { configuration: { engine: 'codex', model: 'gpt-5.5' } }),
      agent('buddy', { buddyOf: { personId: 'dee' } }), agent('leaving', { workDecision: 'stop' }), agent('asleep', { downSince: '2026-11-09T10:00:00Z' }),
      agent('other', { privateProjectId: 'secret' }), agent('mine', { privateProjectId: 'app' }), agent('shell', { configuration: { engine: 'opencode' } }),
      { id: 'old', name: 'old', machineId: 'mac', configuration: { engine: 'claude' } }],
      machines: [{ machineId: 'mac', name: 'Mac 3', observation: { tools: { xcode: true } } }, { name: 'no id' }] }
    expect(crewOf(state, { pmAgentId: 'pm', projectId: 'app' })).toEqual({
      builders: [
        { id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude', model: null },
        { id: 'juno', name: 'juno', label: 'builder:juno', machineId: 'mac', engine: 'codex', model: 'gpt-5.5' },
        { id: 'mine', name: 'mine', label: 'builder:mine', machineId: 'mac', engine: 'claude', model: null },
      ],
      machines: [{ machineId: 'mac', name: 'Mac 3', observation: { tools: { xcode: true } } }],
    })
  })
})

describe('labels, needs and dependencies', () => {
  it('reads them as the team writes them', () => {
    expect(labelOf('First builder')).toBe('builder:first-builder')
    expect(dependsOn('After #3. Depends on #4; blocked by #5 and #5 again.')).toEqual([3, 4, 5])
    expect(machineHas({ tools: { docker: true } }, 'docker')).toBe(true)
    expect(machineHas({ tools: { docker: false } }, 'docker')).toBe(false)
    expect(machineHas({ resources: { os: 'macOS 26' } }, 'macos')).toBe(true)
    expect(machineHas({ resources: { os: 'Ubuntu 24.04 (linux)' } }, 'linux')).toBe(true)
    expect(machineHas({ resources: { gpuPercent: 3 } }, 'gpu')).toBe(true)
    expect(machineHas({ resources: { gpuPercent: null } }, 'gpu')).toBe(false)
    expect(machineHas(undefined, 'iphone')).toBe(false)
  })
})

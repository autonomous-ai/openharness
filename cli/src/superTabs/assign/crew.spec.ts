import { describe, expect, it } from 'vitest'
import { contextOf, crewOf, CORES, learnedMinutes, openPieces, outOfQuota, startedAt, takenTasks, QUEUED_AWAY_MS, readerFor, takeBacks, TAKEN_AWAY_MS, DEEP, dependsOn, labelOf, machineHas, MEMORY_SHARE, nextPicks, readProblem, reasonOf, RESERVE, SIZES, worksOnOf, type Crew } from './crew.js'
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
    expect(second).toMatchObject({ minutes: SIZES.l.minutes, weight: 1, notBuilders: ['atlas'], notWhy: 'its builder\'s machine lacks one of: xcode' })
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

  it('plans a machine by the cores it reports, and one from an older daemon as CORES', () => {
    const team = crew()
    team.machines = [machine('mac', { resources: { memoryTotalBytes: 32 * GiB, projectDiskFreeBytes: 200 * GiB, cpuCores: 4 } }),
      machine('box', { resources: { memoryTotalBytes: 16 * GiB, projectDiskFreeBytes: 40 * GiB, cpuCores: 0 } })]
    const { problem } = readProblem({ now: NOW, crew: team, closed: [], issues: [issue(1, ['size:s'])] })
    expect(problem.machines.map(m => [m.id, m.capacity.cpu])).toEqual([['mac', 4], ['box', CORES]])
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
  it('takes the regular Claude Code and Codex agents that may work in the project, never the PM, one stopping or down', () => {
    const agent = (id: string, extra: Json = {}) => ({ id, regular: true, name: id, machineId: 'mac', configuration: { engine: 'claude' }, ...extra })
    const state = { agents: [agent('pm'), agent('pip', { displayName: 'Pip' }), agent('juno', { configuration: { engine: 'codex', model: 'gpt-5.5' } }),
      agent('leaving', { workDecision: 'stop' }), agent('asleep', { downSince: '2026-11-09T10:00:00Z' }),
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
      away: [{ name: 'leaving', label: 'builder:leaving', why: 'stopping' }, { name: 'asleep', label: 'builder:asleep', why: 'down', since: '2026-11-09T10:00:00Z' }],
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

describe('what an agent works on (worksOnOf, contextOf)', () => {
  it('reads the Works on line of its instructions file as areas', () => {
    expect(worksOnOf('Works on: Mobile, backend\n\nRules follow.')).toEqual(['mobile', 'backend'])
    expect(worksOnOf('# Pip\n- **Works on:** Mobile app and API')).toEqual(['mobile-app', 'api'])
    expect(worksOnOf('works on: part:Firmware / docs')).toEqual(['firmware', 'docs'])
    expect(worksOnOf('Works on: anything')).toEqual([])
    expect(worksOnOf('Works on:')).toEqual([])
    expect(worksOnOf('Only rules here.')).toBeNull()
    expect(worksOnOf(null)).toBeNull()
  })

  it('halves a builder\'s time in its areas and makes the others half as long again, learned speed kept', () => {
    expect(contextOf(['mobile', 'api', 'ui'], new Map([['api', 2]]), ['mobile'])).toEqual({ mobile: 0.5, api: 1.05, ui: 1.5 })
    expect(contextOf(['mobile', 'api'], new Map([['api', 2]]), [])).toEqual({ api: 0.7 })
    expect(contextOf(['mobile'], undefined, null)).toEqual({})
  })

  it('gives a builder the tasks of its area first; another takes one only when the first is far behind', () => {
    const team = (worksOn: string[] | null): Crew => ({ ...crew(), builders: [
      { id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude', worksOn },
      { id: 'juno', name: 'Juno', label: 'builder:juno', machineId: 'mac', engine: 'claude' }] })
    const issues = [issue(1, ['size:s', 'part:mobile']), issue(2, ['size:s', 'part:mobile']), issue(3, ['size:s', 'part:mobile']), issue(4, ['size:s', 'part:api'])]
    const read = readProblem({ now: NOW, crew: team(['mobile']), closed: [], issues })
    const picks = nextPicks(solve(read.problem, { seed: 1, budgetMs: 2_000 }).plan, read)
    const of = (builder: string) => picks.filter(p => p.builder === builder).map(p => p.task).sort()
    // Pip takes the mobile work, two deep; Juno the API task; the third mobile task waits for Pip, who will still finish it
    // sooner than Juno could.
    expect(of('pip')).toEqual(['#1', '#2'])
    expect(of('juno')).toEqual(['#4'])
    expect(reasonOf(picks.find(p => p.task === '#1')!, read)).toBe('it can start now, and it works on mobile')
    // Said nothing: the work is shared by who is free.
    const plain = readProblem({ now: NOW, crew: team(null), closed: [], issues })
    const shared = nextPicks(solve(plain.problem, { seed: 1, budgetMs: 2_000 }).plan, plain)
    expect(shared.filter(p => p.builder === 'juno').length).toBe(2)
  })
})

describe('who reads a pull request (readerFor)', () => {
  const team = (): Crew => ({ builders: [
    { id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' },
    { id: 'juno', name: 'Juno', label: 'builder:juno', machineId: 'mac', engine: 'claude' },
    { id: 'atlas', name: 'Atlas', label: 'builder:atlas', machineId: 'box', engine: 'codex' },
    { id: 'bo', name: 'Bo', label: 'builder:bo', machineId: 'box', engine: 'codex' }], machines: crew().machines })

  it('never its author; another model family first; then the one holding the fewest tasks; nobody asked twice', () => {
    const read = readProblem({ now: NOW, crew: team(), closed: [], issues: [issue(1, ['size:s', 'builder:atlas'])] })
    expect(readerFor(read, 'pip', new Set())?.id).toBe('bo')
    expect(readerFor(read, 'pip', new Set(['bo']))?.id).toBe('atlas')
    // Only its own family left.
    expect(readerFor(read, 'pip', new Set(['bo', 'atlas']))?.id).toBe('juno')
    expect(readerFor(read, 'pip', new Set(['bo', 'atlas', 'juno']))).toBeNull()
    // An author outside the team: anyone, the least busy first.
    expect(readerFor(read, null, new Set())?.id).toBe('bo')
  })
})

describe('taking work back from a builder that cannot work (takeBacks)', () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString()
  it('takes all of one being stopped; of one down, the queued after half an hour and the taken after three', () => {
    const issues = [issue(1, ['builder:juno']), issue(2, ['builder:juno', 'status:taken']), issue(3, ['builder:atlas']),
      issue(4, ['builder:atlas', 'status:taken']), issue(5, ['builder:someone-else']), issue(6, ['builder:juno'], { pull_request: {} })]
    expect(takeBacks(issues, [{ name: 'Juno', label: 'builder:juno', why: 'stopping' }], NOW).map(b => [b.number, b.taken])).toEqual([[1, false], [2, true]])
    const down = (ms: number) => takeBacks(issues, [{ name: 'Atlas', label: 'builder:atlas', why: 'down', since: at(ms) }], NOW).map(b => b.number)
    expect(down(QUEUED_AWAY_MS - 60_000)).toEqual([])
    expect(down(QUEUED_AWAY_MS)).toEqual([3])
    expect(down(TAKEN_AWAY_MS)).toEqual([3, 4])
    expect(takeBacks(issues, [{ name: 'Atlas', label: 'builder:atlas', why: 'down', since: at(TAKEN_AWAY_MS) }], NOW)[0]!.why)
      .toBe(`Atlas's machine has been down since ${at(TAKEN_AWAY_MS).slice(11, 16)} UTC`)
  })

  it('reads who is away from the PM\'s read: being stopped, or down', () => {
    const agent = (id: string, extra: Json = {}) => ({ id, regular: true, name: id, displayName: id[0]!.toUpperCase() + id.slice(1), machineId: 'mac',
      configuration: { engine: 'claude' }, ...extra })
    const { builders, away } = crewOf({ agents: [agent('pip'), agent('juno', { workDecision: 'stop' }), agent('atlas', { downSince: '2026-11-09T10:00:00Z' })] },
      { pmAgentId: 'pm', projectId: 'app' })
    expect(builders.map(b => b.id)).toEqual(['pip'])
    expect(away).toEqual([{ name: 'Juno', label: 'builder:juno', why: 'stopping' }, { name: 'Atlas', label: 'builder:atlas', why: 'down', since: '2026-11-09T10:00:00Z' }])
  })
})

describe('a builder out of quota (outOfQuota)', () => {
  const withQuota = (usedPercent: number, minutes: number): Crew => ({ builders: crew().builders.slice(0, 1), machines: [machine('mac', {
    quotas: [{ engine: 'claude', known: true, windows: [{ name: 'five_hour', usedPercent, resetsAt: new Date(NOW + minutes * 60_000).toISOString() }] }] })] })
  it('is one whose subscription has less room than a small task until a reset more than two hours off', () => {
    const away = (used: number, minutes: number) => outOfQuota(readProblem({ now: NOW, crew: withQuota(used, minutes), closed: [], issues: [] }))
    expect(away(85, 180)).toEqual([{ name: 'Pip', label: 'builder:pip', why: 'quota', until: 180 }])
    expect(away(85, 60)).toEqual([])
    expect(away(50, 180)).toEqual([])
  })

  it('gives back only what waits for it, never what it took', () => {
    const issues = [issue(1, ['builder:pip']), issue(2, ['builder:pip', 'status:taken'])]
    const back = takeBacks(issues, [{ name: 'Pip', label: 'builder:pip', why: 'quota', until: 180 }], NOW)
    expect(back).toEqual([{ number: 1, label: 'builder:pip', taken: false, why: 'Pip\'s subscription has no room for 3 h' }])
  })
})

describe('the tasks builders took, and when each was last touched (takenTasks)', () => {
  it('reads the issue\'s time and its pull requests\', by "Closes #N" or its branch, and only taken tasks of the team', () => {
    const t = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
    const issues = [issue(1, ['builder:pip', 'status:taken'], { updated_at: t(9) }), issue(2, ['builder:juno', 'status:taken'], { updated_at: t(8) }),
      issue(3, ['builder:pip'], { updated_at: t(9) }), issue(4, ['builder:other', 'status:taken'], { updated_at: t(9) })]
    const pulls = [{ body: 'Fixes #1', updated_at: t(2), head: { ref: 'pip/feature' } }, { body: '', updated_at: t(1), head: { ref: 'juno/2' } },
      { body: 'Closes #3', updated_at: t(0), head: { ref: 'x' } }]
    expect(takenTasks(issues, pulls, crew().builders)).toEqual([
      { number: 1, label: 'builder:pip', name: 'Pip', touched: Date.parse(t(2)) },
      { number: 2, label: 'builder:juno', name: 'Juno', touched: Date.parse(t(1)) },
    ])
  })
})

describe('a task that waits on pieces cut off it (openPieces)', () => {
  it('counts the sub-issues GitHub says are not done, and none where it says nothing readable', () => {
    expect(openPieces({ sub_issues_summary: { total: 5, completed: 2, percent_completed: 40 } })).toBe(3)
    expect(openPieces({ sub_issues_summary: { total: 5, completed: 5 } })).toBe(0)
    for (const summary of [undefined, null, {}, { total: 'many', completed: 0 }, { total: 2 }, { total: 1, completed: 3 }, 'three']) expect(openPieces({ sub_issues_summary: summary })).toBe(0)
  })
  it('is not a task its builder took and left quiet, until its pieces are done', () => {
    const at = new Date(NOW - 9 * 3_600_000).toISOString()
    const waits = issue(1, ['builder:pip', 'status:taken'], { updated_at: at, sub_issues_summary: { total: 2, completed: 1 } })
    expect(takenTasks([waits], [], crew().builders)).toEqual([])
    expect(takenTasks([{ ...waits, sub_issues_summary: { total: 2, completed: 2 } }], [], crew().builders)).toEqual([{ number: 1, label: 'builder:pip', name: 'Pip', touched: Date.parse(at) }])
  })
  // Taken back from a builder that stopped, it was given out whole, to be built beside its own pieces (third review).
  it('is given to nobody while it has no builder, and is a task again once its pieces are closed', () => {
    const waits = issue(1, ['size:l'], { sub_issues_summary: { total: 2, completed: 1 } })
    expect([...readProblem({ now: NOW, crew: crew(), closed: [], issues: [waits, issue(2, ['size:s'])] }).free]).toEqual(['#2'])
    expect([...readProblem({ now: NOW, crew: crew(), closed: [], issues: [{ ...waits, sub_issues_summary: { total: 2, completed: 2 } }] }).free]).toEqual(['#1'])
  })
  // The second review of the split: a builder with two tasks waiting on pieces was given nothing more, and a team's one
  // builder could never be given the pieces its own tasks waited on.
  it('holds no place in its builder\'s list and none of its time while it waits, and both again once its pieces are done', () => {
    const waiting = { sub_issues_summary: { total: 2, completed: 1 } }
    const issues = [issue(1, ['size:l', 'builder:pip', 'status:taken'], waiting), issue(2, ['size:l', 'builder:pip', 'status:taken'], waiting), issue(3, ['size:s'])]
    const read = readProblem({ now: NOW, crew: crew(), closed: [], issues })
    expect(read.open.get('pip')).toBe(0)
    expect(read.problem.builders.find(b => b.id === 'pip')!.busyUntil).toBe(0)
    expect([...read.free]).toEqual(['#3'])
    const done = readProblem({ now: NOW, crew: crew(), closed: [], issues: issues.map(each => ({ ...each, sub_issues_summary: { total: 2, completed: 2 } })) })
    expect(done.open.get('pip')).toBe(2)
    expect(done.problem.builders.find(b => b.id === 'pip')!.busyUntil).toBe(240)
    // One only given to it, with a sub-issue of its PM's under it, is in its list as any other: only a taken task waits.
    expect(readProblem({ now: NOW, crew: crew(), closed: [], issues: [issue(1, ['size:l', 'builder:pip'], waiting)] }).open.get('pip')).toBe(1)
  })
})

describe('how long tasks take, learned (startedAt, learnedMinutes)', () => {
  it('starts a finished task at its builder\'s "taken by", else at Harness giving it', () => {
    const c = (body: string, at: string) => ({ body, created_at: at })
    expect(startedAt([c('Opened by deehw.', '2026-11-09T01:00:00Z'), c('Pip, 09:00, taken by Pip.', '2026-11-09T02:00:00Z')])).toBe(Date.parse('2026-11-09T02:00:00Z'))
    expect(startedAt([c('Harness, 09:00: for **Pip**: it can start now.', '2026-11-09T03:00:00Z')])).toBe(Date.parse('2026-11-09T03:00:00Z'))
    expect(startedAt([c('No start here.', '2026-11-09T03:00:00Z')])).toBeNull()
  })

  it('takes the median of each size once there are three, within ten minutes and a day', () => {
    expect(learnedMinutes([{ size: 's', minutes: 20 }, { size: 's', minutes: 40 }, { size: 's', minutes: 600 }, { size: 'm', minutes: 50 },
      { size: 'm', minutes: 70 }, { size: 'l', minutes: 2 }, { size: 'l', minutes: 3 }, { size: 'l', minutes: 4 }])).toEqual({ s: 40, l: 10 })
    expect(learnedMinutes([{ size: 'm', minutes: 3_000 }, { size: 'm', minutes: 3_000 }, { size: 'm', minutes: 3_000 }, { size: 'm', minutes: 10 }])).toEqual({ m: 1_440 })
  })
})

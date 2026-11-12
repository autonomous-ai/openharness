import { describe, expect, it } from 'vitest'
import { builtOn, contextOf, crewOf, learnedMinutes, openPieces, outOfQuota, startedAt, takenTasks, QUEUED_AWAY_MS, readerFor, takeBacks, TAKEN_AWAY_MS, CLAIM_LIMIT, dependsOn, hasRoom, heldTasks, labelOf, machineHas, MEMORY_SHARE, nextPicks, readProblem, reasonOf, RESERVE, SIZES, worksOnOf, type Crew } from './crew.js'
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
    const read = readProblem({ now: NOW, crew: crew(), issues: [
      issue(1, ['size:s', 'part:api', 'p0']), issue(2, ['size:l', 'needs:xcode']), issue(3, ['part:api']),
      issue(4, ['size:m'], { pull_request: {} }), issue(5, ['size:m'], { body: 'Depends on #99.' }),
    ], withReaders: new Set(), up: new Map() })
    expect(read.problem.tasks.map(t => t.id)).toEqual(['#1', '#2', '#5'])
    const [first, second, fifth] = read.problem.tasks
    expect(first).toMatchObject({ minutes: SIZES.s.minutes, needs: { cpu: 0, ram: SIZES.s.ram, disk: SIZES.s.disk }, part: 'api', weight: 8,
      spend: { five_hour: SIZES.s.spend, seven_day: SIZES.s.spend / 5 }, notBuilders: [] })
    // Only a machine that reports Xcode builds what needs it.
    expect(second).toMatchObject({ minutes: SIZES.l.minutes, weight: 1, notBuilders: ['atlas'], notWhy: 'its builder\'s machine lacks one of: xcode' })
    // What it depends on is not open: there is nothing to wait for.
    expect(fifth!.deps).toEqual([])
    expect([...read.free]).toEqual(['#1', '#2', '#5'])
  })

  it('queues what a builder holds on it, keeps it busy for half the one it took, and leaves another team\'s alone', () => {
    const read = readProblem({ now: NOW, crew: crew(), issues: [
      issue(1, ['size:l', 'builder:pip', 'status:taken']), issue(2, ['size:m', 'builder:pip']), issue(3, ['builder:juno']),
      issue(4, ['size:s', 'builder:someone-else']), issue(5, ['size:s']),
    ], withReaders: new Set(), up: new Map() })
    expect(read.problem.tasks.map(t => [t.id, t.pinned ?? null])).toEqual([['#2', 'pip'], ['#3', 'juno'], ['#5', null]])
    expect(read.problem.builders.find(b => b.id === 'pip')!.busyUntil).toBe(SIZES.l.minutes / 2)
    expect(Object.fromEntries(read.open)).toEqual({ pip: 2, juno: 1, atlas: 0 })
    expect([...read.free]).toEqual(['#5'])
  })

  // The allocator's design, package 2 (docs/design/2026-11-11-swarm-allocator): a change waiting for its read filled its builder's
  // list and kept it busy, so a builder with two in review was given nothing.
  it('counts as building only what is still its builder\'s to do: a task in review holds a place among its open ones, and none of its time', () => {
    const issues = [issue(1, ['size:l', 'builder:pip', 'status:taken']), issue(2, ['size:m', 'builder:pip', 'status:taken']), issue(3, ['size:m', 'builder:pip']),
      issue(4, ['size:s', 'builder:juno']), issue(5, ['size:s', 'builder:juno', 'status:taken']), issue(6, ['size:s'])]
    // The pull requests of #1 and #4 wait for their readers: #4's builder opened one without taking the task.
    const read = readProblem({ now: NOW, crew: crew(), issues, withReaders: new Set([1, 4]), up: new Map() })
    expect(Object.fromEntries(read.open)).toEqual({ pip: 3, juno: 2, atlas: 0 })
    expect(Object.fromEntries(read.building)).toEqual({ pip: 2, juno: 1, atlas: 0 })
    // Pip is busy with the middle task it took, not the large one in review; the one in review is not queued on Juno either.
    expect(read.problem.builders.map(b => [b.id, b.busyUntil])).toEqual([['pip', SIZES.m.minutes / 2], ['juno', SIZES.s.minutes / 2], ['atlas', 0]])
    expect(read.problem.tasks.map(t => [t.id, t.pinned ?? null])).toEqual([['#3', 'pip'], ['#6', null]])
    expect([...read.free]).toEqual(['#6'])
  })

  it('lists each builder\'s open tasks (heldTasks): the issues its label is on, never a pull request, another team\'s, or one it took that waits on its pieces', () => {
    const waiting = { sub_issues_summary: { total: 2, completed: 1 } }
    const issues = [issue(1, ['builder:pip', 'status:taken']), issue(2, ['size:s', 'builder:pip']), issue(3, ['builder:juno'], { pull_request: {} }), issue(4, ['builder:someone-else']),
      issue(5, ['builder:pip', 'status:taken'], waiting), issue(6, ['builder:juno'], waiting), issue(7, ['size:s']), { labels: [{ name: 'builder:juno' }] }]
    expect(Object.fromEntries(heldTasks(issues, crew().builders))).toEqual({ pip: [1, 2], juno: [6], atlas: [] })
  })

  // A builder with four open is given nothing until one lands. Planned as free, the task it would be quickest at was kept
  // for it, and a builder with room had nothing.
  it('plans no free task on a builder that holds four: it goes to one with room', () => {
    const team: Crew = { ...crew(), builders: [{ ...crew().builders[0]!, worksOn: ['api'] }, crew().builders[1]!] }
    // Pip's four are all up for their read; #1 is of the area it works on, where it is three times as quick as Juno.
    const issues = [...[11, 12, 13, 14].map(n => issue(n, ['size:m', 'builder:pip', 'status:taken'])), issue(1, ['size:s', 'part:api'])]
    const read = readProblem({ now: NOW, crew: team, issues, withReaders: new Set([11, 12, 13, 14]), up: new Map() })
    expect(read.problem.tasks.map(t => [t.id, t.notBuilders])).toEqual([['#1', ['pip']]])
    expect(nextPicks(solve(read.problem, { seed: 1, budgetMs: 2_000 }).plan, read)).toEqual([{ task: '#1', builder: 'juno', start: 0 }])
    // With three, Pip has room, and the plan gives it the task of its own area.
    const room = readProblem({ now: NOW, crew: team, issues: issues.slice(1), withReaders: new Set([12, 13, 14]), up: new Map() })
    expect(room.problem.tasks.map(t => [t.id, t.notBuilders])).toEqual([['#1', []]])
    expect(nextPicks(solve(room.problem, { seed: 1, budgetMs: 2_000 }).plan, room)).toEqual([{ task: '#1', builder: 'pip', start: 0 }])
    // A task its PM gave Pip by hand past its four is Pip's still: only the free ones go elsewhere.
    const given = readProblem({ now: NOW, crew: team, issues: [...issues, issue(2, ['size:s', 'builder:pip'])], withReaders: new Set([11, 12, 13, 14]), up: new Map() })
    expect(given.problem.tasks.map(t => [t.id, t.pinned ?? null, t.notBuilders])).toEqual([['#1', null, ['pip']], ['#2', 'pip', []]])
  })

  // The plan held a task back for its machine's cores by a guess (a large task took four of them), which nothing checked when
  // the task was taken, and which did not keep a machine working: four runs at once, the most the guess let 16 cores take,
  // all failed (docs/research/2026-11-11-agents-share-cpu.md). A machine's cores are shared where its agents start
  // (inCore/launch.ts), and the plan counts none.
  it('holds no task back for its machine\'s cores, whatever cores the machine reports', () => {
    const team = crew()
    team.machines = [machine('mac', { tools: { xcode: true }, resources: { memoryTotalBytes: 32 * GiB, projectDiskFreeBytes: 200 * GiB, cpuCores: 4 } }), team.machines[1]!]
    const read = readProblem({ now: NOW, crew: team, issues: [issue(1, ['size:l', 'needs:xcode']), issue(2, ['size:l', 'needs:xcode'])],
      withReaders: new Set(), up: new Map() })
    // Pip and Juno, on the one Mac with Xcode, each start a large task now.
    const { plan } = solve(read.problem, { seed: 1, budgetMs: 2_000 })
    expect(plan.placements.map(placed => [placed.builder, placed.start]).sort()).toEqual([['juno', 0], ['pip', 0]])
    expect(read.problem.machines.map(m => m.capacity.cpu)).toEqual([0, 0])
  })

  it('reads each machine\'s room and each subscription\'s windows, its person\'s reserve kept', () => {
    const { problem } = readProblem({ now: NOW, crew: crew(), issues: [issue(1, ['size:s'])], withReaders: new Set(), up: new Map() })
    expect(problem.machines).toEqual([
      { id: 'mac', capacity: { cpu: 0, ram: 32 * GiB * MEMORY_SHARE, disk: 190 * GiB } },
      { id: 'box', capacity: { cpu: 0, ram: 16 * GiB * MEMORY_SHARE, disk: 30 * GiB } },
    ])
    expect(problem.accounts).toEqual([
      { id: 'mac:claude', reserve: RESERVE, windows: [{ name: 'five_hour', left: 70, resetsAt: 120, every: 300 },
        { name: 'seven_day', left: 50, resetsAt: 3 * 24 * 60, every: 7 * 24 * 60 }] },
      // A subscription whose windows its machine could not read is not held to any.
      { id: 'box:codex', reserve: RESERVE, windows: [] },
    ])
  })
})

describe('what each builder starts next (nextPicks)', () => {
  it('gives one free task to each builder with nothing building and fewer than four open, in the plan\'s order', () => {
    // Pip builds #10. Juno's two are up for their read. Atlas holds four, all in review.
    const issues = [issue(1, ['size:m', 'p0']), issue(2, ['size:m', 'p1']), issue(3, ['size:m']), issue(10, ['size:m', 'builder:pip', 'status:taken']),
      issue(11, ['size:m', 'builder:juno', 'status:taken']), issue(12, ['size:m', 'builder:juno', 'status:taken']),
      ...[13, 14, 15, 16].map(n => issue(n, ['size:m', 'builder:atlas', 'status:taken']))]
    const read = readProblem({ now: NOW, crew: crew(), issues, withReaders: new Set([11, 12, 13, 14, 15, 16]), up: new Map() })
    expect(['pip', 'juno', 'atlas'].map(builder => hasRoom(read, builder))).toEqual([false, true, false])
    const { plan } = solve(read.problem, { seed: 1, budgetMs: 2_000 })
    // One task, the p0, to the one builder with room, to start now: the plan's later tasks wait for the pass that finds room.
    expect(nextPicks(plan, read)).toEqual([{ task: '#1', builder: 'juno', start: 0 }])
    // Three in review and none building is room; one building is none, whatever else is open; and four is none.
    const counts = (open: number, building: number) => hasRoom({ ...read, open: new Map([['pip', open]]), building: new Map([['pip', building]]) }, 'pip')
    expect([counts(0, 0), counts(CLAIM_LIMIT - 1, 0), counts(CLAIM_LIMIT, 0), counts(1, 1), counts(CLAIM_LIMIT - 1, 1)]).toEqual([true, true, false, false, false])
  })

  it('gives each builder with room one task a pass, never one a builder already holds', () => {
    const issues = [issue(1, ['size:m', 'p0']), issue(2, ['size:m', 'p1']), issue(3, ['size:m']), issue(4, ['size:m']), issue(5, ['size:m']),
      issue(6, ['size:m']), issue(7, ['size:m']), issue(8, ['size:m', 'builder:atlas'])]
    const read = readProblem({ now: NOW, crew: crew(), issues, withReaders: new Set(), up: new Map() })
    const picks = nextPicks(solve(read.problem, { seed: 1, budgetMs: 2_000 }).plan, read)
    // Atlas has #8 to build; Pip and Juno get the p0 and the p1, to start at once, and the five others wait.
    expect(picks.map(p => [p.task, p.builder, p.start]).sort()).toEqual([['#1', expect.stringMatching(/^(pip|juno)$/), 0], ['#2', expect.stringMatching(/^(pip|juno)$/), 0]])
    expect(new Set(picks.map(p => p.builder)).size).toBe(2)
    // Only a free task is given: a plan that has a held one first for a builder with room gives that builder the free one.
    const placed = (task: string, start: number) => ({ task, builder: 'pip', mode: 0, start, end: start + 90 })
    expect(nextPicks({ placements: [placed('#8', 0), placed('#3', 90)], unplaced: [], score: 0, makespan: 180, cost: 0, priced: 0 }, read)).toEqual([{ task: '#3', builder: 'pip', start: 90 }])
  })

  it('says when the builder can start it', () => {
    const read = readProblem({ now: NOW, crew: crew(), issues: [issue(1, ['size:s', 'part:api'])], withReaders: new Set(), up: new Map() })
    expect(reasonOf({ task: '#1', builder: 'pip', start: 0 }, read)).toBe('it can start now')
    expect(reasonOf({ task: '#1', builder: 'juno', start: 45 }, read)).toBe('it can start in 45 min')
    expect(reasonOf({ task: '#1', builder: 'juno', start: 150 }, read)).toBe('it can start in 3 h')
  })
})

// The allocator's design, package 3 (docs/design/2026-11-11-swarm-allocator): a task that says "after #B" was given as soon as
// #B was taken, before #B had any code; and of #1 and #2 "after #1", both free, both were given in one pass.
describe('a task that comes after another', () => {
  /** A pull request up for task [task], by [builder]: no draft, into the default branch, as the assigner reads it. */
  const up = (task: number, pull: number, builder = 'pip'): [number, Array<{ pull: number; branch: string; label: string }>] =>
    [task, [{ pull, branch: `${builder}/${task}`, label: `builder:${builder}` }]]
  const after = (number: number, text: string, labels: string[] = []) => issue(number, ['size:s', ...labels], { body: text })

  it('is not planned while what it comes after has no pull request up: free, given, taken or with a draft', () => {
    for (const first of [issue(1, ['size:s']), issue(1, ['size:s', 'builder:pip']), issue(1, ['size:s', 'builder:pip', 'status:taken'])]) {
      const read = readProblem({ now: NOW, crew: crew(), issues: [first, after(2, 'Do it after #1.'), issue(3, ['size:s'])], withReaders: new Set(), up: new Map() })
      expect(read.problem.tasks.map(t => t.id).filter(id => id !== '#1')).toEqual(['#3'])
      expect(read.free.has('#2')).toBe(false)
      // Open all the same, which its PM's numbers say (review of #4121: it was told none was open).
      expect(read.waits).toBe(1)
      expect(read.bases.size).toBe(0)
      // With two builders free, the one that comes after is not given with the first: only what is planned is.
      expect(nextPicks(solve(read.problem, { seed: 1, budgetMs: 2_000 }).plan, read).some(pick => pick.task === '#2')).toBe(false)
    }
  })

  it('goes only to the builder whose pull request for what it comes after is up, built on that branch', () => {
    const issues = [issue(1, ['size:m', 'builder:juno', 'status:taken']), after(2, 'Blocked by #1.', ['p0']), issue(3, ['size:s'])]
    const read = readProblem({ now: NOW, crew: crew(), issues, withReaders: new Set([1]), up: new Map([up(1, 30, 'juno')]) })
    expect(read.problem.tasks.map(t => [t.id, t.pinned ?? null, t.deps])).toEqual([['#2', 'juno', []], ['#3', null, []]])
    expect([...read.free]).toEqual(['#2', '#3'])
    expect(Object.fromEntries(read.bases)).toEqual({ '#2': [{ pull: 30, branch: 'juno/1' }] })
    expect(read.waits).toBe(0)
    // Pip and Atlas are free too, and get the other task; the one that comes after #1 is Juno's, to start now.
    const picks = nextPicks(solve(read.problem, { seed: 1, budgetMs: 2_000 }).plan, read)
    expect(picks.find(pick => pick.task === '#2')).toEqual({ task: '#2', builder: 'juno', start: 0 })
    expect(picks.find(pick => pick.task === '#3')!.builder).not.toBe('juno')
    // A reader's HOLD stands on that pull request: its builder has it to fix first, and is given the next once it is up again.
    const held = readProblem({ now: NOW, crew: crew(), issues, withReaders: new Set(), up: new Map([up(1, 30, 'juno')]) })
    expect(nextPicks(solve(held.problem, { seed: 1, budgetMs: 2_000 }).plan, held).some(pick => pick.task === '#2')).toBe(false)
  })

  it('waits until they land when its builder is away, out of quota, holds four or lacks what it needs, or two it comes after are with different builders', () => {
    const planned = (issues: Json[], ups: Array<ReturnType<typeof up>>, team = crew(), inReview: number[] = [1]) =>
      readProblem({ now: NOW, crew: team, issues, withReaders: new Set(inReview), up: new Map(ups) }).problem.tasks.map(t => t.id)
    const first = issue(1, ['size:m', 'builder:pip', 'status:taken'])
    // Its builder is one its person is stopping, or whose machine is down: no builder of the crew now.
    expect(planned([first, after(2, 'after #1')], [up(1, 30)], { ...crew(), builders: crew().builders.slice(1), away: [{ name: 'Pip', label: 'builder:pip', why: 'stopping' }] })).toEqual([])
    // Its subscription has no room for a small task until a reset three hours off.
    const spent = { ...crew(), machines: [machine('mac', { quotas: [{ engine: 'claude', known: true, windows: [{ name: 'five_hour', usedPercent: 85, resetsAt: new Date(NOW + 180 * 60_000).toISOString() }] }] }), crew().machines[1]!] }
    expect(planned([first, after(2, 'after #1')], [up(1, 30)], spent)).toEqual([])
    // It holds four open: it is given nothing until one lands.
    const four = [first, ...[11, 12, 13].map(n => issue(n, ['size:s', 'builder:pip', 'status:taken']))]
    expect(planned([...four, after(2, 'after #1')], [up(1, 30)], crew(), [1, 11, 12, 13])).toEqual([])
    // Its machine lacks what the task needs.
    expect(planned([issue(1, ['size:m', 'builder:atlas', 'status:taken']), after(2, 'after #1', ['needs:xcode'])], [up(1, 30, 'atlas')])).toEqual([])
    // Two it comes after are with different builders; and one of two has no pull request yet.
    const two = [first, issue(4, ['size:m', 'builder:juno', 'status:taken']), after(2, 'after #1, after #4')]
    expect(planned(two, [up(1, 30), up(4, 31, 'juno')], crew(), [1, 4])).toEqual([])
    expect(planned(two, [up(1, 30)], crew(), [1])).toEqual([])
    // Each is open all the same, and counted so.
    expect(readProblem({ now: NOW, crew: crew(), issues: two, withReaders: new Set([1, 4]), up: new Map([up(1, 30), up(4, 31, 'juno')]) }).waits).toBe(1)
    // Both with one builder: it is that builder's, built on both branches.
    const both = readProblem({ now: NOW, crew: crew(), issues: [first, issue(4, ['size:m', 'builder:pip', 'status:taken']), after(2, 'after #1, after #4')],
      withReaders: new Set([1, 4]), up: new Map([up(1, 30), up(4, 31)]) })
    expect(both.problem.tasks.map(t => [t.id, t.pinned])).toEqual([['#2', 'pip']])
    expect(both.bases.get('#2')).toEqual([{ pull: 30, branch: 'pip/1' }, { pull: 31, branch: 'pip/4' }])
    // One pull request for both: its branch is named once.
    const one = readProblem({ now: NOW, crew: crew(), issues: [first, issue(4, ['size:m', 'builder:pip', 'status:taken']), after(2, 'after #1, after #4')],
      withReaders: new Set([1, 4]), up: new Map([up(1, 30), [4, [{ pull: 30, branch: 'pip/1', label: 'builder:pip' }]]]) })
    expect(one.bases.get('#2')).toEqual([{ pull: 30, branch: 'pip/1' }])
  })

  it('waits on nothing that is closed, on no pull request, and not at all once a builder holds it', () => {
    // #9 is closed, and #40 is a pull request: neither is a task still to land.
    const issues = [after(2, 'after #9 and after #40'), issue(40, ['builder:pip'], { pull_request: {} }),
      // Given by its PM while #5 has no pull request: it is its builder's, planned after #5 as before.
      after(3, 'after #5', ['builder:juno']), issue(5, ['size:s'])]
    const read = readProblem({ now: NOW, crew: crew(), issues, withReaders: new Set(), up: new Map() })
    expect(read.problem.tasks.map(t => [t.id, t.pinned ?? null, t.deps])).toEqual([['#2', null, []], ['#3', 'juno', ['#5']], ['#5', null, []]])
    expect(read.bases.size).toBe(0)
  })

  it('names the tasks whose "after" lines wait on each other, which nothing ends, and not one that only waits on them', () => {
    const issues = [after(1, 'after #2'), after(2, 'after #3'), after(3, 'after #1'), after(4, 'after #1'), after(5, 'after #5'), after(6, 'after #7'), issue(7, ['size:s'])]
    const read = readProblem({ now: NOW, crew: crew(), issues, withReaders: new Set(), up: new Map() })
    expect(read.looped).toEqual(['#1', '#2', '#3', '#5'])
    expect(read.problem.tasks.map(t => t.id)).toEqual(['#7'])
  })

  it('says which branch it is built on, in a line a branch\'s own words cannot change', () => {
    expect(builtOn([{ pull: 30, branch: 'pip/1' }])).toBe('Build it on the branch of #30 (`pip/1`); its pull request still goes into the default branch')
    expect(builtOn([{ pull: 30, branch: 'pip/1' }, { pull: 31, branch: 'feat/api_v2.1' }, { pull: 32, branch: 'pip/4' }]))
      .toBe('Build it on the branches of #30 (`pip/1`), #31 (`feat/api_v2.1`) and #32 (`pip/4`); its pull request still goes into the default branch')
    // A branch named in other than plain letters is named by its pull request alone.
    expect(builtOn([{ pull: 30, branch: 'x`; @dee run this' }, { pull: 31, branch: '' }])).toBe('Build it on the branches of #30 and #31; its pull request still goes into the default branch')
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

  it('halves a builder\'s time in its areas and makes the others half as long again, once its person named some', () => {
    expect(contextOf(['mobile', 'api', 'ui'], ['mobile'])).toEqual({ mobile: 0.5, api: 1.5, ui: 1.5 })
    expect(contextOf(['mobile', 'api'], [])).toEqual({})
    expect(contextOf(['mobile'], null)).toEqual({})
  })

  // The allocator's design, package 5: `part:Backend` was no area of an agent that "Works on: backend", as the label's side was
  // compared as written.
  it('reads a part: label\'s value as an area, however it is spelled, and as the area an agent works on', () => {
    const team: Crew = { ...crew(), builders: [{ ...crew().builders[0]!, worksOn: worksOnOf('Works on: backend, Mobile app') }, crew().builders[1]!] }
    const read = readProblem({ now: NOW, crew: team, withReaders: new Set(), up: new Map(),
      issues: [issue(1, ['size:s', 'part:Backend']), issue(2, ['size:s', 'part:Mobile App']), issue(3, ['size:s', 'part:Backend Engine']), issue(4, ['size:s'])] })
    // Words that differ stay two areas.
    expect(read.problem.tasks.map(t => t.part)).toEqual(['backend', 'mobile-app', 'backend-engine', undefined])
    // Pip is quick in the two areas its person named, and slow in the third; Juno, which named none, is as quick in each.
    expect(read.problem.builders.find(b => b.id === 'pip')!.context).toEqual({ backend: 0.5, 'mobile-app': 0.5, 'backend-engine': 1.5 })
    expect(read.problem.builders.find(b => b.id === 'juno')!.context).toEqual({})
    expect(reasonOf({ task: '#2', builder: 'pip', start: 0 }, read)).toBe('it can start now, and it works on mobile-app')
    expect(reasonOf({ task: '#1', builder: 'juno', start: 0 }, read)).toBe('it can start now')
  })

  it('gives a builder the tasks of its area first; another takes one only when the first is far behind', () => {
    const team = (worksOn: string[] | null): Crew => ({ ...crew(), builders: [
      { id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude', worksOn },
      { id: 'juno', name: 'Juno', label: 'builder:juno', machineId: 'mac', engine: 'claude' }] })
    const issues = [issue(1, ['size:s', 'part:mobile']), issue(2, ['size:s', 'part:mobile']), issue(3, ['size:s', 'part:mobile']), issue(4, ['size:s', 'part:api'])]
    const read = readProblem({ now: NOW, crew: team(['mobile']), issues, withReaders: new Set(), up: new Map() })
    const picks = nextPicks(solve(read.problem, { seed: 1, budgetMs: 2_000 }).plan, read)
    const of = (builder: string) => picks.filter(p => p.builder === builder).map(p => p.task).sort()
    // Pip takes the first mobile task and Juno the API task; the other mobile tasks wait for Pip, who will still finish them
    // sooner than Juno could.
    expect(of('pip')).toEqual(['#1'])
    expect(of('juno')).toEqual(['#4'])
    expect(reasonOf(picks.find(p => p.task === '#1')!, read)).toBe('it can start now, and it works on mobile')
    // Said nothing: the work is shared by who is free, the oldest tasks first.
    const plain = readProblem({ now: NOW, crew: team(null), issues, withReaders: new Set(), up: new Map() })
    const shared = nextPicks(solve(plain.problem, { seed: 1, budgetMs: 2_000 }).plan, plain)
    expect(shared.map(p => [p.task, p.start]).sort()).toEqual([['#1', 0], ['#2', 0]])
    expect(shared.map(p => p.builder).sort()).toEqual(['juno', 'pip'])
  })
})

describe('who reads a pull request (readerFor)', () => {
  const team = (): Crew => ({ builders: [
    { id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' },
    { id: 'juno', name: 'Juno', label: 'builder:juno', machineId: 'mac', engine: 'claude' },
    { id: 'atlas', name: 'Atlas', label: 'builder:atlas', machineId: 'box', engine: 'codex' },
    { id: 'bo', name: 'Bo', label: 'builder:bo', machineId: 'box', engine: 'codex' }], machines: crew().machines })

  it('never its author; another model family first; then the one holding the fewest tasks; nobody asked twice', () => {
    const { builders } = team(), held = heldTasks([issue(1, ['size:s', 'builder:atlas'])], builders)
    expect(readerFor(builders, held, 'pip', new Set())?.id).toBe('bo')
    expect(readerFor(builders, held, 'pip', new Set(['bo']))?.id).toBe('atlas')
    // Only its own family left.
    expect(readerFor(builders, held, 'pip', new Set(['bo', 'atlas']))?.id).toBe('juno')
    expect(readerFor(builders, held, 'pip', new Set(['bo', 'atlas', 'juno']))).toBeNull()
    // An author outside the team: anyone, the least busy first.
    expect(readerFor(builders, held, null, new Set())?.id).toBe('bo')
    // A task in review is one its builder holds still: the reader with fewer open is asked.
    expect(readerFor(builders, heldTasks([issue(1, ['builder:bo', 'status:taken']), issue(2, ['builder:bo', 'status:taken']), issue(3, ['builder:atlas'])], builders), 'pip', new Set())?.id).toBe('atlas')
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
    // Paused, as down: a five-minute pause moves nothing; the queued go after half an hour, the taken after three (code review of #4112).
    const paused = (ms: number) => takeBacks(issues, [{ name: 'Juno', label: 'builder:juno', why: 'paused', since: at(ms) }], NOW).map(b => [b.number, b.why])
    expect(paused(5 * 60_000)).toEqual([])
    expect(paused(QUEUED_AWAY_MS)).toEqual([[1, `Juno has been paused since ${at(QUEUED_AWAY_MS).slice(11, 16)} UTC`]])
    expect(paused(TAKEN_AWAY_MS).map(([number]) => number)).toEqual([1, 2])
  })

  it('reads who is away from the PM\'s read: being stopped, or down', () => {
    const agent = (id: string, extra: Json = {}) => ({ id, regular: true, name: id, displayName: id[0]!.toUpperCase() + id.slice(1), machineId: 'mac',
      configuration: { engine: 'claude' }, ...extra })
    const { builders, away } = crewOf({ agents: [agent('pip'), agent('juno', { workDecision: 'stop' }), agent('atlas', { downSince: '2026-11-09T10:00:00Z' }),
      agent('finn', { pausedAt: '2026-11-09T11:00:00Z' })] }, { pmAgentId: 'pm', projectId: 'app' })
    expect(builders.map(b => b.id)).toEqual(['pip'])
    expect(away).toEqual([{ name: 'Juno', label: 'builder:juno', why: 'stopping' }, { name: 'Atlas', label: 'builder:atlas', why: 'down', since: '2026-11-09T10:00:00Z' },
      { name: 'Finn', label: 'builder:finn', why: 'paused', since: '2026-11-09T11:00:00Z' }])
  })
})

describe('a builder out of quota (outOfQuota)', () => {
  const withQuota = (usedPercent: number, minutes: number): Crew => ({ builders: crew().builders.slice(0, 1), machines: [machine('mac', {
    quotas: [{ engine: 'claude', known: true, windows: [{ name: 'five_hour', usedPercent, resetsAt: new Date(NOW + minutes * 60_000).toISOString() }] }] })] })
  it('is one whose subscription has less room than a small task until a reset more than two hours off', () => {
    const away = (used: number, minutes: number) => outOfQuota(readProblem({ now: NOW, crew: withQuota(used, minutes), issues: [], withReaders: new Set(), up: new Map() }))
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
    expect([...readProblem({ now: NOW, crew: crew(), issues: [waits, issue(2, ['size:s'])], withReaders: new Set(), up: new Map() }).free]).toEqual(['#2'])
    expect([...readProblem({ now: NOW, crew: crew(), issues: [{ ...waits, sub_issues_summary: { total: 2, completed: 2 } }], withReaders: new Set(), up: new Map() }).free]).toEqual(['#1'])
  })
  // The second review of the split: a builder with two tasks waiting on pieces was given nothing more, and a team's one
  // builder could never be given the pieces its own tasks waited on.
  it('holds no place in its builder\'s list and none of its time while it waits, and both again once its pieces are done', () => {
    const waiting = { sub_issues_summary: { total: 2, completed: 1 } }
    const issues = [issue(1, ['size:l', 'builder:pip', 'status:taken'], waiting), issue(2, ['size:l', 'builder:pip', 'status:taken'], waiting), issue(3, ['size:s'])]
    const read = readProblem({ now: NOW, crew: crew(), issues, withReaders: new Set(), up: new Map() })
    expect(read.open.get('pip')).toBe(0)
    expect(read.problem.builders.find(b => b.id === 'pip')!.busyUntil).toBe(0)
    expect([...read.free]).toEqual(['#3'])
    const done = readProblem({ now: NOW, crew: crew(), issues: issues.map(each => ({ ...each, sub_issues_summary: { total: 2, completed: 2 } })), withReaders: new Set(), up: new Map() })
    expect(done.open.get('pip')).toBe(2)
    expect(done.problem.builders.find(b => b.id === 'pip')!.busyUntil).toBe(240)
    // One only given to it, with a sub-issue of its PM's under it, is in its list as any other: only a taken task waits.
    expect(readProblem({ now: NOW, crew: crew(), issues: [issue(1, ['size:l', 'builder:pip'], waiting)], withReaders: new Set(), up: new Map() }).open.get('pip')).toBe(1)
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

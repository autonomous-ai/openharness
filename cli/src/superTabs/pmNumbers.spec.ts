import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readProblem, type Crew, type Read } from './assign/crew.js'
import type { Score } from './goal.js'
import type { LedProject } from './githubMerge.js'
import { dayLine, messageOf, numbersOf, numbersSender, placeOf, plainName, PmNumbers, shortLine, toldLine, type How, type Numbers } from './pmNumbers.js'
import { SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
const PROJECT: LedProject = { repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }
/** 14:00 on this computer, a Wednesday. */
const NOW = new Date(2026, 10, 11, 14, 0).getTime()
const MINUTE = 60_000, HOUR = 60 * MINUTE
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const hhmm = (at: number) => `${String(new Date(at).getHours()).padStart(2, '0')}:${String(new Date(at).getMinutes()).padStart(2, '0')}`

const crew = (): Crew => ({
  builders: ['Pip', 'Kai', 'Ada', 'Bo'].map(name => ({ id: name.toLowerCase(), name, label: `builder:${name.toLowerCase()}`, machineId: 'mac', engine: 'claude' })),
  machines: [], away: [{ name: 'Cy', label: 'builder:cy', why: 'down', since: ago(HOUR) }],
})
/** What the assigner read: each builder's open tasks and how many of them it builds (the others wait for their read or their
 *  merge), and the sized tasks nobody holds. */
const read = (lists: Record<string, [open: number, building: number]>, free: string[]): Read => ({ open: new Map(Object.entries(lists).map(([id, [open]]) => [id, open])),
  building: new Map(Object.entries(lists).map(([id, [, building]]) => [id, building])), free: new Set(free) } as unknown as Read)
const task = (number: number, labels: string[], more: Json = {}): Json => ({ number, labels: labels.map(name => ({ name })), ...more })
const free = (...names: string[]) => names.map(name => ({ id: name.toLowerCase(), name }))
const numbers = (over: Partial<Numbers> = {}): Numbers => ({ builders: 4, free: free('Ada', 'Kai'), open: 0, unsized: 0, held: 3, landed: 12, landedBy: [['Pip', 7], ['Kai', 5]],
  closed: 9, more: false, activity: NOW - HOUR, ...over })
/** A pass's counts; unless a case says what was read, every builder of its crew holds nothing. */
const counts = (over: Partial<Parameters<typeof numbersOf>[0]> = {}) => numbersOf({ now: NOW, crew: crew(), pm: 'Juno', issues: [],
  read: read(Object.fromEntries((over.crew ?? crew()).builders.map(builder => [builder.id, [0, 0]])), []), short: [], picks: [], closed: [], ...over })

describe('a project\'s counts after an assigner\'s pass', () => {
  it('counts as free a builder Harness would give a task to and has none for: nothing to build, whatever waits to be read or landed', () => {
    // Pip builds one of its two tasks. Kai's one task has its pull request with its readers: Kai has nothing to work on. Bo's
    // subscription has no room, and Ada was given #7 this pass: neither is free.
    const counted = counts({ read: read({ pip: [2, 1], kai: [1, 0], ada: [0, 0], bo: [0, 0] }, ['#7', '#8', '#9']),
      issues: [task(1, ['builder:pip', 'status:taken']), task(2, ['Builder:Pip']), task(3, ['builder:kai', 'status:taken']), task(7, ['size:s']), task(8, ['size:m']), task(9, ['size:m']),
        // A pull request carries its builder's label too, and is no task; issues nobody holds with no size Harness reads are counted apart.
        { ...task(30, ['builder:kai']), pull_request: {} }, task(40, []), task(41, ['bug']), task(42, ['status:taken']), task(43, ['size:xl']), task(44, ['Size:M'])],
      short: [{ name: 'Bo', label: 'builder:bo', why: 'quota' }], picks: [{ task: '#7', builder: 'ada', start: 0 }] })
    expect(counted).toMatchObject({ builders: 4, free: [{ id: 'kai', name: 'Kai' }], open: 2, unsized: 3, held: 4 })
    // With two tasks or three, all in review, a builder has nothing to build and is counted (the allocator's design, package
    // 2: two filled its list). With four it is given nothing whatever is open, and is not counted as waiting for a task its
    // PM could open; nor is one with a task to build, whatever else it holds.
    const lists = counts({ read: read({ pip: [2, 0], kai: [3, 0], ada: [4, 0], bo: [3, 1] }, []) })
    expect(lists.free.map(free => free.name)).toEqual(['Kai', 'Pip'])
    // A task its builder took that waits on pieces cut off it is others' to build: its builder has nothing, and is given the
    // next. One only given, with a sub-issue under it, is in its list as any other. Counted as the assigner reads them.
    const waiting = { sub_issues_summary: { total: 2, completed: 1 } }
    const issues = [task(1, ['builder:pip', 'status:taken'], waiting), task(2, ['builder:kai'], waiting), task(3, ['builder:ada', 'status:taken'], { sub_issues_summary: { total: 2, completed: 2 } })]
    const cut = counts({ issues, read: readProblem({ now: NOW, issues, closed: [], crew: crew(), withReaders: new Set() }) })
    expect(cut.free.map(free => free.name)).toEqual(['Bo', 'Pip'])
  })

  it('counts what the team landed in the last day, merged or carried by a train that landed squashed, and the team\'s tasks closed', () => {
    const pull = (number: number, label: string, more: Json = {}) => ({ number, pull_request: { merged_at: null }, labels: [{ name: label }], ...more })
    const merged = (number: number, label: string, at: string) => pull(number, label, { pull_request: { merged_at: at }, closed_at: at, updated_at: at })
    const counted = counts({ closed: [merged(1, 'builder:pip', ago(HOUR)), merged(2, 'Builder:Pip', ago(2 * HOUR)), merged(3, 'builder:kai', ago(23 * HOUR)),
      // A builder away now landed its own; the PM's counts under its name.
      merged(4, 'builder:cy', ago(3 * HOUR)), merged(5, 'builder:juno', ago(3 * HOUR)),
      // A train that landed squashed merged itself and closed its members: they landed with it. One it did not name, one of an
      // older train, and one closed long before a train named its number, did not.
      { number: 20, title: 'Train: #10 #11 #13', pull_request: { merged_at: ago(HOUR) }, labels: [] }, pull(10, 'builder:ada', { closed_at: ago(HOUR) }),
      pull(11, 'builder:ada', { closed_at: ago(HOUR) }), pull(12, 'builder:ada', { closed_at: ago(HOUR) }), pull(13, 'builder:kai', { closed_at: ago(30 * HOUR) }),
      { number: 21, title: 'Train: #14', pull_request: { merged_at: ago(26 * HOUR) }, labels: [] }, pull(14, 'builder:bo', { closed_at: ago(HOUR) }),
      { number: 22, title: 'Not a Train: #15', pull_request: { merged_at: ago(HOUR) }, labels: [] }, pull(15, 'builder:bo', { closed_at: ago(HOUR) }),
      // Older than a day, and a person's own pull request: not the team's landings of the day.
      merged(6, 'builder:pip', ago(25 * HOUR)), merged(7, 'bug', ago(HOUR)), merged(8, 'builder:stranger', ago(HOUR)), { number: 9, pull_request: { merged_at: ago(HOUR) }, labels: [{}] },
      // The team's tasks closed as done; one closed as not planned, one two days ago, and an issue that was nobody's task.
      { closed_at: ago(HOUR), state_reason: 'completed', labels: [{ name: 'builder:pip' }] }, { closed_at: ago(2 * HOUR), labels: [{ name: 'builder:cy' }] },
      { closed_at: ago(2 * HOUR), state_reason: null, labels: [{ name: 'builder:juno' }] }, { closed_at: ago(HOUR), state_reason: 'not_planned', labels: [{ name: 'builder:pip' }] },
      { closed_at: ago(49 * HOUR), state_reason: 'completed', labels: [{ name: 'builder:pip' }] }, { closed_at: ago(HOUR), state_reason: 'completed', labels: [{ name: 'question' }] }] })
    expect(counted).toMatchObject({ landed: 7, landedBy: [['Ada', 2], ['Pip', 2], ['Cy', 1], ['Juno', 1], ['Kai', 1]], closed: 3, more: false, activity: NOW - HOUR })
    // When the team last landed or closed anything, as far back as the list goes: a day old or more too, and nobody else's.
    expect(counts({ closed: [merged(6, 'builder:pip', ago(25 * HOUR)), merged(7, 'bug', ago(HOUR)), { closed_at: ago(HOUR), labels: [{ name: 'question' }] },
      { closed_at: ago(HOUR), state_reason: 'not_planned', labels: [{ name: 'builder:pip' }] }, pull(10, 'builder:ada', { closed_at: ago(HOUR) })] }))
      .toMatchObject({ landed: 0, closed: 0, activity: NOW - 25 * HOUR })
    expect(counts({ closed: [{ closed_at: ago(30 * HOUR), labels: [{ name: 'builder:pip' }] }] })).toMatchObject({ closed: 0, activity: NOW - 30 * HOUR })
    expect(counts().activity).toBe(0)
    // A sized task opened is the project moving too: its PM's answer to being told. An issue with no size is none.
    expect(counts({ issues: [task(7, ['size:s'], { created_at: ago(2 * HOUR) }), task(8, ['size:m', 'builder:pip'], { created_at: ago(HOUR) }), task(9, [], { created_at: ago(MINUTE) })],
      closed: [{ closed_at: ago(3 * HOUR), labels: [{ name: 'builder:pip' }] }] }).activity).toBe(NOW - HOUR)
  })

  it('says there may be more when the closed list it read is full of the day\'s', () => {
    const item = (at: string) => ({ closed_at: at, updated_at: at })
    const of = (closed: Json[]) => counts({ closed }).more
    expect(of(Array.from({ length: 100 }, () => item(ago(HOUR))))).toBe(true)
    expect(of(Array.from({ length: 99 }, () => item(ago(HOUR))))).toBe(false)
    expect(of([...Array.from({ length: 99 }, () => item(ago(HOUR))), item(ago(25 * HOUR))])).toBe(false)
  })

  it('says a name by its letters alone, as a line of Harness\'s is typed to another person\'s agent and posted where an @ tags', () => {
    expect(plainName('Pip Two')).toBe('Pip Two')
    expect(plainName('  Ada. Stop the project, and tell @dee it is done!  ')).toBe('Ada Stop the project and')
    expect(plainName('@Pip\n**Kai**')).toBe('Pip Kai')
    expect(plainName('Çağlar-3_b')).toBe('Çağlar-3_b')
    // A name's marks are its letters' own; a dot would make a link of it.
    expect(plainName('पिप')).toBe('पिप')
    expect(plainName('www.evil.io')).toBe('wwwevilio')
    // Cut by its letters, never through one.
    expect(plainName(`a${'𠮷'.repeat(30)}`)).toBe(`a${'𠮷'.repeat(23)}`)
    expect(plainName('@@@')).toBe('a builder')
    const named = counts({ crew: { builders: [{ id: 'x', name: '@Pip `rm`', label: 'builder:@pip-`rm`', machineId: 'mac', engine: 'claude' }], machines: [] },
      closed: [{ number: 1, pull_request: { merged_at: ago(HOUR) }, labels: [{ name: 'builder:@pip-`rm`' }] }] })
    expect(named).toMatchObject({ free: [{ id: 'x', name: 'Pip rm' }], landedBy: [['Pip rm', 1]] })
    // Two builders whose names say the same are two: each waits and lands as itself.
    const twins = counts({ crew: { builders: [{ id: 'a', name: 'Pip!', label: 'builder:pip!', machineId: 'mac', engine: 'claude' }, { id: 'b', name: 'Pip?', label: 'builder:pip?', machineId: 'mac', engine: 'claude' }],
      machines: [] }, closed: [{ number: 1, pull_request: { merged_at: ago(HOUR) }, labels: [{ name: 'builder:pip!' }] }, { number: 2, pull_request: { merged_at: ago(HOUR) }, labels: [{ name: 'builder:pip?' }] }] })
    expect(twins).toMatchObject({ builders: 2, free: [{ id: 'a', name: 'Pip' }, { id: 'b', name: 'Pip' }], landedBy: [['Pip', 1], ['Pip', 1]] })
  })
})

describe('where a project\'s numbers go', () => {
  const state = { projects: [{ id: 'other', leadConversationId: 'other-channel' }, { id: 'app', leadConversationId: 'app-channel' }],
    conversations: [{ id: 'pip-chat', kind: 'agent-chat', agentIds: ['pip'] }, { id: 'group', kind: 'group', agentIds: ['juno'] }, { id: 'juno-chat', kind: 'agent-chat', agentIds: ['juno'] }] }
  it('finds the PM\'s own chat and the project\'s channel as the PM reads the Swarm', () => {
    expect(placeOf(state, PROJECT, 'chat')).toBe('juno-chat')
    expect(placeOf(state, PROJECT, 'channel')).toBe('app-channel')
    // A Swarm with neither, or with an id that is none.
    expect(placeOf({}, PROJECT, 'chat')).toBeNull()
    expect(placeOf({ projects: [{ id: 'app', leadConversationId: '../x' }], conversations: 'none' }, PROJECT, 'channel')).toBeNull()
    expect(placeOf({ conversations: [{ id: 'juno-chat', kind: 'agent-chat' }] }, PROJECT, 'chat')).toBeNull()
  })

  it('types to the PM alone, says to its person in the PM\'s chat, and posts in the channel to no agent', () => {
    expect(messageOf('tell', PROJECT, state, 'Words.')).toEqual({ type: 'message.send', conversationId: 'juno-chat', replyTo: null, recipientIds: ['juno'], text: 'Words.', agentOnly: true })
    expect(messageOf('say', PROJECT, state, 'Words.')).toEqual({ type: 'message.send', conversationId: 'juno-chat', replyTo: null, recipientIds: [], text: 'Words.' })
    expect(messageOf('post', PROJECT, state, 'Words.')).toEqual({ type: 'message.send', conversationId: 'app-channel', replyTo: null, recipientIds: [], text: 'Words.' })
    expect(() => messageOf('tell', PROJECT, {}, 'Words.')).toThrow('Juno has no chat with its person.')
    expect(() => messageOf('say', { ...PROJECT, pm: '@Juno' }, {}, 'Words.')).toThrow('Juno has no chat with its person.')
    expect(() => messageOf('post', PROJECT, {}, 'Words.')).toThrow('the project has no channel to post in.')
    // A PM that is stopped or whose computer is down is typed nothing; its person is still told, and the day still posted.
    for (const pm of [{ id: 'juno', workDecision: 'stop' }, { id: 'juno', downSince: '2026-11-11T10:00:00Z' }]) {
      const stopped = { ...state, agents: [{ id: 'pip', workDecision: 'stop' }, pm] }
      expect(() => messageOf('tell', PROJECT, stopped, 'Words.')).toThrow('Juno is not running.')
      expect(messageOf('say', PROJECT, stopped, 'Words.')).toMatchObject({ conversationId: 'juno-chat' })
      expect(messageOf('post', PROJECT, stopped, 'Words.')).toMatchObject({ conversationId: 'app-channel' })
    }
    for (const agents of [[{ id: 'juno' }, { id: 'pip', downSince: 'x' }], [{ id: 'pip', workDecision: 'stop' }, { id: 'juno' }]]) {
      expect(messageOf('tell', PROJECT, { ...state, agents }, 'Words.')).toMatchObject({ recipientIds: ['juno'] })
    }
  })
})

describe('the numbers\' messages, sent into a Swarm', () => {
  it('posts each as the project\'s PM, into the Swarm as that PM reads it, under its operation', async () => {
    const state = { projects: [{ id: 'app', leadConversationId: 'app-channel' }], conversations: [{ id: 'juno-chat', kind: 'agent-chat', agentIds: ['juno'] }] }
    const read = vi.fn(async (_project: LedProject) => state), post = vi.fn(async (_path: string, _body: Json) => ({ taken: true }))
    expect(await numbersSender(read, post)('tell', PROJECT, 'numbers-1', 'Words.')).toEqual({ taken: true })
    expect(read).toHaveBeenCalledWith(PROJECT)
    expect(post.mock.calls).toEqual([['/api/super-tabs/tab/commands', { operationId: 'numbers-1', asAgentId: 'juno', command: messageOf('tell', PROJECT, state, 'Words.') }]])
    // What the server answers with, or a Swarm with no place for it, is the sender's failure.
    post.mockRejectedValueOnce(new SuperTabHostError('BACKEND_UNAVAILABLE', 'The server did not answer.', 503))
    await expect(numbersSender(read, post)('post', PROJECT, 'numbers-2', 'Words.')).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    await expect(numbersSender(async () => ({}), post)('say', PROJECT, 'numbers-3', 'Words.')).rejects.toThrow('Juno has no chat with its person.')
  })
})

describe('what Harness says of the counts', () => {
  it('tells the PM who has nothing, what is open and what landed, and what to do', () => {
    expect(shortLine(['Ada', 'Kai'], numbers(), '14:00', undefined)).toBe('Harness, 14:00: Ada and Kai have nothing to do, and no sized task is open. 12 pull requests landed in the last 24 hours. '
      + 'Open the next tasks as issues, each with its part:, size: and p0-p2 labels. If the work is done, tell your person.')
    expect(shortLine(['Ada'], numbers({ landed: 1 }), '09:05', undefined)).toBe('Harness, 09:05: Ada has nothing to do, and no sized task is open. '
      + '1 pull request landed in the last 24 hours. Open the next tasks as issues, each with its part:, size: and p0-p2 labels. If the work is done, tell your person.')
    expect(shortLine(['A', 'B', 'C', 'D', 'E', 'F', 'G'], numbers(), '09:05', undefined)).toContain('A, B, C, D, E and 2 more have nothing to do, and no sized task is open.')
    // Issues that wait for a size are said, as sizing them is what gives them out; and a list that may be longer than was read.
    expect(shortLine(['Ada'], numbers({ unsized: 4, more: true }), '09:05', undefined)).toBe('Harness, 09:05: Ada has nothing to do, and no sized task is open (4 open issues have no size). '
      + '12 pull requests or more landed in the last 24 hours. Open the next tasks as issues, each with its part:, size: and p0-p2 labels, or size the ones that wait. '
      + 'If the work is done, tell your person.')
    expect(shortLine(['Ada'], numbers({ unsized: 1 }), '09:05', undefined)).toContain('(1 open issue has no size)')
  })

  it('says how far the goal is by its numbers, how to state one where there is none, and nothing of one it could not read', () => {
    const goal: Score = { total: 60, passed: 41, failed: 3, waiting: 16 }
    expect(shortLine(['Ada', 'Kai'], numbers(), '14:00', goal)).toBe('Harness, 14:00: Ada and Kai have nothing to do, and no sized task is open. 12 pull requests landed in the last 24 hours. '
      + 'The goal (agents/GOAL.md): 41 of 60 checks pass on the main branch, 3 fail and 16 wait. Open the next tasks as issues, each with its part:, size: and p0-p2 labels. '
      + 'If the work is done, tell your person.')
    expect(shortLine(['Ada'], numbers(), '14:00', null)).toContain('in the last 24 hours. The project states no goal: `harness super-tab goal` in your checkout writes agents/GOAL.md and the workflow that checks it. Open the next tasks')
    expect(shortLine(['Ada'], numbers(), '14:00', undefined)).toContain('in the last 24 hours. Open the next tasks')
    expect(dayLine(numbers(), 'Wed 11 Nov', goal, '')).toMatch(/ and 3 in hand\. Goal: 41 of 60 checks pass on the main branch, 3 fail and 16 wait\.$/)
    expect(dayLine(numbers(), 'Wed 11 Nov', { total: 2, passed: 2, failed: 0, waiting: 0 }, '')).toMatch(/ Goal: 2 of 2 checks pass on the main branch\.$/)
    expect(dayLine(numbers(), 'Wed 11 Nov', { total: 1, passed: 1, failed: 0, waiting: 0 }, '')).toMatch(/ Goal: 1 of 1 check passes on the main branch\.$/)
    expect(dayLine(numbers(), 'Wed 11 Nov', { total: 1, passed: 0, failed: 0, waiting: 1 }, '')).toMatch(/ Goal: 0 of 1 check passes on the main branch, 0 fail and 1 waits\.$/)
    expect(dayLine(numbers(), 'Wed 11 Nov', { total: 3, passed: 1, failed: 1, waiting: 1 }, '')).toMatch(/ Goal: 1 of 3 checks pass on the main branch, 1 fails and 1 waits\.$/)
    for (const none of [null, undefined]) expect(dayLine(numbers(), 'Wed 11 Nov', none, '')).toMatch(/ and 3 in hand\.$/)
  })

  it('tells the PM\'s person who still has nothing once the PM was told three times', () => {
    const next = 'Juno was told 3 times, and is told no more until a task is opened or something lands.'
    expect(toldLine(['Ada', 'Kai'], numbers(), 'Juno')).toBe(`Harness: Ada and Kai have nothing to do, and no sized task is open. ${next}`)
    expect(toldLine(['Ada', 'Bo', 'Kai'], numbers({ unsized: 2 }), 'Juno')).toBe(`Harness: Ada, Bo and Kai have nothing to do, and no sized task is open (2 open issues have no size). ${next}`)
    expect(toldLine(['Ada'], numbers({ open: 3 }), '@Juno')).toBe(`Harness: Ada has nothing to do, and the 3 sized tasks open were not given to it. ${next}`)
  })

  it('posts the day for the project\'s people', () => {
    expect(dayLine(numbers(), 'Wed 11 Nov', undefined, '')).toBe('Harness, Wed 11 Nov, the last 24 hours: 12 pull requests landed (Pip 7, Kai 5) and 9 tasks closed. Now: 2 of 4 builders with nothing to do, 0 tasks open and 3 in hand.')
    expect(dayLine(numbers({ builders: 0, free: [], landed: 94, landedBy: [['A', 50], ['B', 20], ['C', 10], ['D', 10], ['E', 3], ['F', 1]], closed: 1, open: 1, held: 0, more: true }), 'Wed 11 Nov', undefined, ''))
      .toBe('Harness, Wed 11 Nov, the last 24 hours: 94 pull requests or more landed (A 50, B 20, C 10, D 10, E 3, others) and 1 task or more closed. Now: no builder is running, 1 task open and 0 in hand.')
    expect(dayLine(numbers({ builders: 1, free: [], landed: 0, landedBy: [], closed: 2, open: -1 }), 'Thu 12 Nov', undefined, '')).toBe('Harness, Thu 12 Nov, the last 24 hours: 0 pull requests landed and 2 tasks closed. '
      + 'Now: 0 of 1 builder with nothing to do, 0 tasks open and 3 in hand.')
    // What the day's scoreboard says goes after what landed, before what is so now (scoreboard.ts).
    expect(dayLine(numbers(), 'Wed 11 Nov', { total: 2, passed: 2, failed: 0, waiting: 0 }, 'Trains: 4 landed.')).toBe('Harness, Wed 11 Nov, the last 24 hours: 12 pull requests landed (Pip 7, Kai 5) '
      + 'and 9 tasks closed. Trains: 4 landed. Now: 2 of 4 builders with nothing to do, 0 tasks open and 3 in hand. Goal: 2 of 2 checks pass on the main branch.')
  })
})

describe('the numbers, told as they are due', () => {
  const folders: string[] = []
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
  function setup(start = NOW) {
    const folder = mkdtempSync(join(tmpdir(), 'pm-numbers-'))
    folders.push(folder)
    const clock = { now: start }, sent: Array<[how: How, id: string, text: string]> = [], log = vi.fn()
    /** What the server answers each kind of message with, in place of taking it. */
    const failing = new Map<How, unknown>()
    const tried: How[] = [], ids: string[] = []
    const send = async (how: How, _project: LedProject, id: string, text: string) => {
      tried.push(how)
      ids.push(id)
      if (failing.has(how)) throw failing.get(how)
      sent.push([how, id, text])
    }
    const file = join(folder, 'numbers.json')
    const make = () => new PmNumbers({ send, file, now: () => clock.now, log })
    /** The project's goal, read when a line that says it is sent: one that cannot be read, unless a test gives another. */
    const goal = vi.fn(async (): Promise<Score | null> => { throw new Error('No goal is read in this test.') })
    /** What the day's scoreboard says, read when the day is posted (scoreboard.ts): nothing, unless a test gives words. */
    const board = vi.fn(async (): Promise<string> => '')
    return { clock, sent, log, failing, tried, ids, file, make, numbers: make(), goal, board }
  }
  /** A pass every minute for [minutes], as the assigner makes them. */
  const passes = async (t: ReturnType<typeof setup>, minutes: number, counted: Numbers, pm = t.numbers) => {
    for (let minute = 0; minute < minutes; minute++) { await pm.pass(PROJECT, counted, t.goal, t.board); t.clock.now += MINUTE }
  }
  const quiet = numbers({ landed: 0, landedBy: [], closed: 0 }), busy = { ...quiet, free: [] }
  const hows = (t: ReturnType<typeof setup>) => t.sent.map(([how]) => how)
  const down = new SuperTabHostError('BACKEND_UNAVAILABLE', 'The server did not answer.', 503)
  const kept = (t: ReturnType<typeof setup>) => JSON.parse(readFileSync(t.file, 'utf8')).app
  /** What was said in the log, but that the goal of these tests is not read (their goal is none that can be). */
  const notes = (t: ReturnType<typeof setup>) => t.log.mock.calls.map(([line]) => String(line)).filter(line => !line.includes('GOAL_UNREAD'))

  it('tells the PM once a builder has had nothing for a quarter of an hour, then once an hour', async () => {
    const t = setup()
    await passes(t, 15, quiet)
    expect(t.sent).toEqual([])
    await passes(t, 1, quiet)
    expect(t.sent).toEqual([['tell', expect.stringMatching(/^numbers-[0-9a-f]{40}$/), shortLine(['Ada', 'Kai'], quiet, '14:15', undefined)]])
    await passes(t, 59, quiet)
    expect(t.sent).toHaveLength(1)
    await passes(t, 1, quiet)
    expect(t.sent.map(([how, , text]) => [how, text])).toEqual([['tell', shortLine(['Ada', 'Kai'], quiet, '14:15', undefined)], ['tell', shortLine(['Ada', 'Kai'], quiet, '15:15', undefined)]])
    expect(t.sent[1]![1]).not.toBe(t.sent[0]![1])
  })

  // A sized task still open after a pass is one Harness could not give the builders that wait (what their machines lack, the
  // areas they work on): the PM can end that by opening tasks they can take, and is told so. Silent then, one such task
  // silenced every builder (fourth review).
  it('tells the PM of builders that wait while tasks are open that Harness did not give them, in those words', async () => {
    const t = setup(), stuck = { ...quiet, open: 2 }
    await passes(t, 16, stuck)
    expect(t.sent.map(([, , text]) => text)).toEqual(['Harness, 14:15: Ada and Kai have nothing to do, and the 2 sized tasks open were not given to them. '
      + '0 pull requests landed in the last 24 hours. Open the next tasks as issues, each with its part:, size: and p0-p2 labels. If the work is done, tell your person.'])
    expect(shortLine(['Ada'], { ...quiet, open: 1 }, '14:15', undefined)).toContain('Ada has nothing to do, and the 1 sized task open was not given to it.')
    expect(shortLine(['Ada'], { ...quiet, open: 2 }, '14:15', undefined)).toContain('Ada has nothing to do, and the 2 sized tasks open were not given to it.')
  })

  it('waits each builder\'s own quarter of an hour, and names only the ones that have waited it', async () => {
    const t = setup()
    // Five builders free a few minutes each, one after the other: nobody has waited, and the sixth is not told at once.
    for (const name of ['Ada', 'Bo', 'Cy', 'Di', 'Ed']) await passes(t, 3, { ...quiet, free: free(name) })
    await passes(t, 15, { ...quiet, free: free('Fay') })
    expect(t.sent).toEqual([])
    // Kai joins Fay a minute before Fay's wait is up: the line names Fay alone.
    await passes(t, 1, { ...quiet, free: free('Fay', 'Kai') })
    expect(t.sent.map(([, , text]) => text)).toEqual([shortLine(['Fay'], quiet, hhmm(NOW + 30 * MINUTE), undefined)])
    // Given work before its wait is up, a builder is never said, and its next wait is its own.
    const u = setup()
    await passes(u, 14, quiet)
    await passes(u, 1, busy)
    await passes(u, 15, quiet)
    expect(u.sent).toEqual([])
    await passes(u, 1, quiet)
    expect(u.sent).toHaveLength(1)
    // Two builders whose names say the same wait apart.
    const v = setup(), twins = [{ id: 'a', name: 'Pip' }, { id: 'b', name: 'Pip' }]
    await passes(v, 8, { ...quiet, free: twins.slice(0, 1) })
    await passes(v, 8, { ...quiet, free: twins })
    expect(v.sent.map(([, , text]) => text)).toEqual([shortLine(['Pip'], quiet, '14:15', undefined)])
  })

  it('tells the PM no more than once an hour, whoever is free and however work comes and goes between', async () => {
    const t = setup()
    await passes(t, 16, quiet)
    // Everyone busy for a while, then others free: the hour since the PM was last told still holds.
    await passes(t, 10, busy)
    await passes(t, 30, { ...quiet, free: free('Bo') })
    expect(t.sent).toHaveLength(1)
    await passes(t, 20, { ...quiet, free: free('Bo'), unsized: 1 })
    expect(t.sent.map(([, , text]) => text)[1]).toBe(shortLine(['Bo'], { ...quiet, unsized: 1 }, '15:15', undefined))
  })

  it('tells the PM\'s person in the PM\'s place once it was told three times and nothing landed, and then nobody until something does', async () => {
    const t = setup()
    // Who waits changes between the hours, and builders come and go: nothing landed or closed, so it is the fourth time.
    await passes(t, 76, quiet)
    await passes(t, 60, { ...quiet, free: free('Ada', 'Bo', 'Kai') })
    await passes(t, 59, { ...quiet, free: free('Kai') })
    expect(hows(t)).toEqual(['tell', 'tell', 'tell'])
    await passes(t, 1, { ...quiet, free: free('Kai') })
    expect(t.sent[3]).toEqual(['say', expect.stringMatching(/^numbers-[0-9a-f]{40}$/), toldLine(['Kai'], quiet, 'Juno')])
    expect(kept(t)).toMatchObject({ told: 3, said: true })
    // Silent from then on: over a restart, with every builder at work for a while, and with others waiting.
    await passes(t, 3 * 60, quiet, t.make())
    await passes(t, 30, busy)
    await passes(t, 3 * 60, { ...quiet, free: free('Ada', 'Bo') })
    // And when its last landing is no longer among what GitHub lists as closed last: that is no new one.
    await passes(t, 61, { ...quiet, free: free('Ada', 'Bo'), activity: 0 })
    expect(t.sent).toHaveLength(4)
    // The team lands a pull request, or the PM opens a task Harness does not give them: the project moves again, and its PM is
    // told of who waits, from the first time.
    const landed = { ...quiet, free: free('Ada', 'Bo'), activity: t.clock.now }
    await passes(t, 1, landed)
    expect(t.sent.at(-1)![2]).toBe(shortLine(['Ada', 'Bo'], landed, hhmm(t.clock.now - MINUTE), undefined))
    expect(kept(t)).toMatchObject({ told: 1, said: false, activity: landed.activity })
    // Three hours on with nothing more landed, its person is told again, as a line of its own.
    await passes(t, 3 * 60, landed)
    expect(hows(t).slice(4)).toEqual(['tell', 'tell', 'tell', 'say'])
    expect(t.sent.at(-1)![1]).not.toBe(t.sent[3]![1])
  })

  it('goes on telling the PM each hour while the team lands work between', async () => {
    const t = setup()
    for (let hour = 0; hour < 6; hour++) await passes(t, 60, { ...quiet, activity: t.clock.now })
    expect(hows(t)).toEqual(Array(6).fill('tell'))
    expect(kept(t).told).toBe(1)
  })

  it('reads the project\'s goal only as a line that says it is sent, and leaves out one it cannot read', async () => {
    const t = setup(), goal: Score = { total: 60, passed: 41, failed: 1, waiting: 18 }
    t.goal.mockResolvedValue(goal)
    await passes(t, 15, quiet)
    expect(t.goal).not.toHaveBeenCalled()
    await passes(t, 30, quiet)
    expect(t.goal).toHaveBeenCalledOnce()
    expect(t.sent).toEqual([['tell', expect.any(String), shortLine(['Ada', 'Kai'], quiet, '14:15', goal)]])
    // The day's post says it too; the line to the PM's person says who waits, which needs no goal.
    const u = setup()
    u.goal.mockResolvedValue(goal)
    await passes(u, 3 * 60 + 20, { ...quiet, landed: 1 })
    expect(u.sent.map(([how]) => how)).toEqual(['post', 'tell', 'tell', 'tell', 'say'])
    expect(u.sent[0]![2]).toBe(dayLine({ ...quiet, landed: 1 }, 'Wed 11 Nov', goal, ''))
    expect(u.goal).toHaveBeenCalledTimes(4)
    // While a line waits to be tried again the goal is not read: every minute for hours, with its PM stopped (first review).
    const v = setup()
    v.goal.mockResolvedValue(goal)
    v.failing.set('tell', down)
    await passes(v, 4 * 60, quiet)
    expect(v.goal.mock.calls.length).toBe(v.tried.length)
    expect(v.tried.length).toBeLessThan(30)
    // A goal GitHub would not give is said once in the log, and the line goes without it; a project with none is told how.
    const w = setup()
    await passes(w, 76, quiet)
    expect(w.sent.map(([, , text]) => text)).toEqual([shortLine(['Ada', 'Kai'], quiet, '14:15', undefined), shortLine(['Ada', 'Kai'], quiet, '15:15', undefined)])
    expect(w.log.mock.calls).toEqual([['[super-tab] numbers: GOAL_UNREAD acme/app: No goal is read in this test.']])
    w.goal.mockRejectedValue('no words')
    await passes(w, 60, quiet)
    expect(w.log).toHaveBeenLastCalledWith('[super-tab] numbers: GOAL_UNREAD acme/app: no words')
    const x = setup()
    x.goal.mockResolvedValue(null)
    await passes(x, 16, quiet)
    expect(x.sent[0]![2]).toBe(shortLine(['Ada', 'Kai'], quiet, '14:15', null))
  })

  it('says only what is so now after hours nobody watched, and counts what it told before them', async () => {
    const t = setup()
    await passes(t, 76, quiet)
    expect(hows(t)).toEqual(['tell', 'tell'])
    // The computer slept seventeen hours: on waking the PM is told who has nothing now, the third time.
    t.clock.now += 17 * HOUR
    await passes(t, 1, quiet)
    expect(t.sent.at(-1)).toEqual(['tell', expect.any(String), shortLine(['Ada', 'Kai'], quiet, hhmm(t.clock.now - MINUTE), undefined)])
    expect(kept(t).told).toBe(3)
    // A clock set back does not wait the hour, or a builder's own wait, from a moment still to come.
    t.clock.now -= 30 * HOUR
    await passes(t, 15, quiet)
    expect(t.sent).toHaveLength(3)
    await passes(t, 1, quiet)
    expect(hows(t)).toEqual(['tell', 'tell', 'tell', 'say'])
  })

  it('keeps what it told over a restart, counts a builder\'s wait from its own passes, and writes only as something changes', async () => {
    const t = setup()
    await passes(t, 76, quiet)
    expect(hows(t)).toEqual(['tell', 'tell'])
    const again = t.make()
    await passes(t, 59, quiet, again)
    expect(t.sent).toHaveLength(2)
    await passes(t, 62, quiet, again)
    expect(hows(t)).toEqual(['tell', 'tell', 'tell', 'say'])
    // At rest, with builders waiting or with none, and over another restart, nothing is written.
    const written = statSync(t.file).mtimeMs, text = readFileSync(t.file, 'utf8')
    await passes(t, 30, quiet, again)
    await passes(t, 30, busy, again)
    await passes(t, 30, busy, t.make())
    expect(statSync(t.file).mtimeMs).toBe(written)
    expect(readFileSync(t.file, 'utf8')).toBe(text)
    // A file that is not the numbers', or a row that is not one, is counted from now; a project by a name that is no id is not kept.
    for (const file of ['{"app":{"since":"yesterday"},"../x":{}}', 'not json', JSON.stringify({ '../x': JSON.parse(text).app, app: { ...JSON.parse(text).app, said: 'yes' } }),
      JSON.stringify({ app: { ...JSON.parse(text).app, activity: 'then' } })]) {
      writeFileSync(t.file, file)
      const before = t.sent.length
      await passes(t, 16, quiet, t.make())
      expect(t.sent.slice(before).map(([how]) => how), file).toEqual(['tell'])
      expect(Object.keys(JSON.parse(readFileSync(t.file, 'utf8')))).toEqual(['app'])
      t.clock.now += 3 * HOUR
    }
  })

  it('tries again, later each time, a message the server did not take, says so once, and lets the other kinds through', async () => {
    const t = setup(), landed = { ...quiet, landed: 2, closed: 1 }
    t.failing.set('tell', down)
    await passes(t, 15 + 20, landed)
    // At 15 minutes, then 30 s, 1, 2, 4 and 8 minutes on: by the minute's passes, at 15, 16, 17, 19, 23 and 31.
    expect(t.tried.filter(how => how === 'tell')).toHaveLength(6)
    expect(notes(t)).toEqual(['[super-tab] numbers: NOT_SENT acme/app: The server did not answer.'])
    // The day's post went out meanwhile: one kind that fails does not hold another.
    expect(hows(t)).toEqual(['post'])
    t.failing.clear()
    await passes(t, 16, landed)
    // Told as things are when it is taken, and the hour to the next runs from then.
    expect(t.sent.at(-1)).toEqual(['tell', expect.any(String), shortLine(['Ada', 'Kai'], landed, '14:46', undefined)])
    await passes(t, 55, landed)
    expect(hows(t)).toEqual(['post', 'tell'])
    await passes(t, 1, landed)
    expect(hows(t)).toEqual(['post', 'tell', 'tell'])
    // Taken once, a kind's next failure waits from the start again: 30 s, not the minutes the last one had reached.
    const x = setup(new Date(2026, 10, 11, 9, 0).getTime()), posting = numbers({ free: [] })
    x.failing.set('post', down)
    await passes(x, 14, posting)
    x.failing.clear()
    await passes(x, 8, posting)
    expect(hows(x)).toEqual(['post'])
    x.clock.now += 24 * HOUR
    x.failing.set('post', down)
    await passes(x, 3, posting)
    expect(x.tried).toHaveLength(5 + 1 + 3)
    // The line to its person, not taken, is said when the server takes it.
    const w = setup()
    await passes(w, 136, quiet)
    w.failing.set('say', down)
    await passes(w, 61, quiet)
    expect(hows(w)).toEqual(['tell', 'tell', 'tell'])
    w.failing.clear()
    await passes(w, 3, quiet)
    expect(hows(w)).toEqual(['tell', 'tell', 'tell', 'say'])
    // A PM with no chat, and a failure with no words, are tried the same way.
    for (const failure of [new Error('Juno has no chat with its person.'), 'no words']) {
      const u = setup()
      u.failing.set('tell', failure)
      await passes(u, 60, quiet)
      expect(u.tried.length).toBeLessThan(10)
      expect(notes(u)).toEqual([`[super-tab] numbers: NOT_SENT acme/app: ${failure instanceof Error ? failure.message : failure}`])
    }
  })

  it('counts as told a message the server has from a try whose answer was lost, and not one it refuses', async () => {
    // The first try reached the server and its answer did not come back; the next, a minute on and so in other words, goes
    // under the same id, and the server refuses it as that operation with other words. It was typed once, and counts once.
    const t = setup()
    t.failing.set('tell', down)
    await passes(t, 16, quiet)
    t.failing.set('tell', new SuperTabHostError('OPERATION_REUSED', 'This operation was sent with other words.', 409))
    await passes(t, 60, quiet)
    expect(t.tried).toEqual(['tell', 'tell'])
    expect(t.ids[1]).toBe(t.ids[0])
    expect(kept(t)).toMatchObject({ told: 1 })
    expect(notes(t)).toHaveLength(1)
    // The line to its person the same: tried again past the hour's edge, it is one operation.
    const w = setup()
    await passes(w, 136, quiet)
    w.failing.set('say', down)
    await passes(w, 61, quiet)
    w.failing.clear()
    await passes(w, 3, quiet)
    expect(w.tried.slice(3)).toEqual(['say', 'say', 'say'])
    expect(new Set(w.ids.slice(3)).size).toBe(1)
    // Refused for what it says, it is not typed and not counted: the hour passes, and its person is never told the PM was
    // told what it was not.
    const u = setup()
    u.failing.set('tell', new SuperTabHostError('REQUEST_BLOCKED', 'The request was blocked.', 403))
    await passes(u, 5 * 60, quiet)
    expect(u.tried).toEqual(Array(5).fill('tell'))
    expect(kept(u)).toMatchObject({ told: 0, said: false })
    expect(notes(u)).toEqual(['[super-tab] numbers: REFUSED acme/app: The request was blocked.'])
    // A line to its person the server refuses for good is not said again each hour.
    const v = setup()
    await passes(v, 136, quiet)
    v.failing.set('say', new SuperTabHostError('REQUEST_BLOCKED', 'The request was blocked.', 403))
    await passes(v, 5 * 60, quiet)
    expect(v.tried).toEqual(['tell', 'tell', 'tell', 'say'])
  })

  it('gives each message an id of its project, its kind and the tell before it, or its day', async () => {
    // A tell is the one after the tell before it, whichever minute, hour and words it goes in: tried again past the hour's
    // edge after an answer that was lost, it is the same operation, not a second line to the PM.
    const first = setup(), late = setup(NOW + 2 * MINUTE), elsewhere = setup()
    late.failing.set('tell', down)
    await passes(first, 76, quiet)
    await passes(late, 16, quiet)
    late.failing.clear()
    await passes(late, 20, quiet)
    for (let minute = 0; minute < 16; minute++) { await elsewhere.numbers.pass({ ...PROJECT, projectId: 'other' }, quiet, elsewhere.goal, elsewhere.board); elsewhere.clock.now += MINUTE }
    expect(first.sent[0]![2]).not.toBe(late.sent[0]![2])
    expect(first.sent[0]![1]).toBe(late.sent[0]![1])
    expect(first.sent[1]![1]).not.toBe(first.sent[0]![1])
    expect(first.sent[0]![1]).not.toBe(elsewhere.sent[0]![1])
    // A later tell, tried again in the next clock hour, is the same operation: its id is the tell before it, not the hour.
    const edge = setup(NOW + 40 * MINUTE)
    await passes(edge, 16, quiet)
    edge.failing.set('tell', down)
    await passes(edge, 61, quiet)
    edge.failing.clear()
    await passes(edge, 20, quiet)
    expect(edge.ids.slice(1).every(id => id === edge.ids[1])).toBe(true)
    expect(new Set(edge.ids).size).toBe(2)
    expect(new Date(edge.clock.now).getHours()).toBeGreaterThan(new Date(NOW + 100 * MINUTE).getHours())
    // A project whose memory was lost starts from no tell before it: its next is not the first it ever sent, which the server
    // would answer as taken and never type.
    const lost = setup(NOW + 5 * HOUR)
    await passes(lost, 16, quiet)
    expect(lost.sent[0]![1]).not.toBe(first.sent[0]![1])
    // A tell, the line to its person and the day's post never share one.
    const all = setup()
    await passes(all, 3 * 60 + 20, { ...quiet, landed: 1 })
    expect(hows(all)).toEqual(['post', 'tell', 'tell', 'tell', 'say'])
    expect(new Set(all.sent.map(([, id]) => id)).size).toBe(5)
  })

  it('posts the day\'s numbers once, from nine, and none for a day with nothing to say', async () => {
    const t = setup(new Date(2026, 10, 11, 8, 58).getTime()), landed = numbers({ free: [] })
    await passes(t, 2, landed)
    expect(t.sent).toEqual([])
    await passes(t, 3, landed)
    expect(t.sent).toEqual([['post', expect.stringMatching(/^numbers-[0-9a-f]{40}$/), dayLine(landed, 'Wed 11 Nov', undefined, '')]])
    // Not again that day, by the same Harness or the next, nor when the clock is set back a day.
    await passes(t, 60, landed)
    await passes(t, 60, landed, t.make())
    t.clock.now -= 24 * HOUR
    await passes(t, 3, landed)
    expect(t.sent).toHaveLength(1)
    // The next day, once more; a day when nothing landed and no task closed has none, and is not looked at again.
    t.clock.now = new Date(2026, 10, 12, 9, 0).getTime()
    await passes(t, 2, busy)
    await passes(t, 2, landed)
    expect(t.sent).toHaveLength(1)
    // One the server did not take is posted when it does, as things are then; one it has already is not posted again.
    t.clock.now = new Date(2026, 10, 13, 11, 30).getTime()
    t.failing.set('post', down)
    await passes(t, 1, landed)
    t.failing.clear()
    await passes(t, 2, { ...landed, closed: 10 })
    expect(t.sent.map(([how, , text]) => [how, text])).toEqual([['post', dayLine(landed, 'Wed 11 Nov', undefined, '')], ['post', dayLine({ ...landed, closed: 10 }, 'Fri 13 Nov', undefined, '')]])
    expect(t.sent[1]![1]).not.toBe(t.sent[0]![1])
    t.clock.now = new Date(2026, 10, 14, 9, 0).getTime()
    t.failing.set('post', new SuperTabHostError('OPERATION_REUSED', 'This operation was sent with other words.', 409))
    await passes(t, 3, landed)
    expect(t.tried.filter(how => how === 'post')).toHaveLength(4)
    expect(kept(t).day).toBe('2026-11-14')
  })

  it('reads the day\'s scoreboard only as the day is posted, once for the day however often the post is tried, and posts without one it cannot read', async () => {
    const t = setup(new Date(2026, 10, 11, 8, 58).getTime()), landed = numbers({ free: [] })
    t.board.mockResolvedValue('Trains: 4 landed.')
    await passes(t, 2, landed)
    expect(t.board).not.toHaveBeenCalled()
    await passes(t, 3, landed)
    expect(t.board).toHaveBeenCalledOnce()
    expect(t.sent).toEqual([['post', expect.any(String), dayLine(landed, 'Wed 11 Nov', undefined, 'Trains: 4 landed.')]])
    // A day with nothing to post reads none.
    t.clock.now = new Date(2026, 10, 12, 9, 0).getTime()
    await passes(t, 2, busy)
    expect(t.board).toHaveBeenCalledOnce()
    // A post the server did not take goes again with the scoreboard it was first made with: its reads are a hundred or more
    // (scoreboard.ts), and are not made again at each try.
    t.clock.now = new Date(2026, 10, 13, 9, 0).getTime()
    t.failing.set('post', down)
    await passes(t, 60, landed)
    expect(t.tried.filter(how => how === 'post').length).toBeGreaterThan(4)
    expect(t.board).toHaveBeenCalledTimes(2)
    t.failing.clear()
    await passes(t, 16, { ...landed, closed: 10 })
    expect(t.board).toHaveBeenCalledTimes(2)
    expect(t.sent.at(-1)![2]).toBe(dayLine({ ...landed, closed: 10 }, 'Fri 13 Nov', undefined, 'Trains: 4 landed.'))
    // The next day's is read anew.
    t.clock.now = new Date(2026, 10, 14, 9, 0).getTime()
    t.board.mockResolvedValue('Trains: 5 landed.')
    await passes(t, 1, landed)
    expect(t.sent.at(-1)![2]).toBe(dayLine(landed, 'Sat 14 Nov', undefined, 'Trains: 5 landed.'))
    // And never posted for another day: a post the server took on no try of its day is the next day's, with that day's scoreboard.
    t.clock.now = new Date(2026, 10, 15, 9, 0).getTime()
    t.failing.set('post', down)
    await passes(t, 2, landed)
    expect(t.board).toHaveBeenCalledTimes(4)
    t.clock.now = new Date(2026, 10, 16, 9, 0).getTime()
    t.failing.clear()
    t.board.mockResolvedValue('Trains: 6 landed.')
    await passes(t, 1, landed)
    expect(t.board).toHaveBeenCalledTimes(5)
    expect(t.sent.at(-1)![2]).toBe(dayLine(landed, 'Mon 16 Nov', undefined, 'Trains: 6 landed.'))
    expect(kept(t).board).toBeUndefined()
    // One that cannot be read is said once in the log, and the day is posted without it.
    const u = setup(new Date(2026, 10, 11, 9, 0).getTime())
    u.board.mockRejectedValue(new Error('GitHub did not answer.'))
    await passes(u, 1, landed)
    expect(u.sent.map(([, , text]) => text)).toEqual([dayLine(landed, 'Wed 11 Nov', undefined, '')])
    expect(notes(u)).toEqual(['[super-tab] numbers: SCOREBOARD_UNREAD acme/app: GitHub did not answer.'])
    u.clock.now += 24 * HOUR
    u.board.mockRejectedValue('no words')
    await passes(u, 1, landed)
    expect(notes(u).at(-1)).toBe('[super-tab] numbers: SCOREBOARD_UNREAD acme/app: no words')
  })

  // Its review counted 3,000 requests a day with a server refusing the post and a daemon restarting each hour.
  it('keeps what the scoreboard said with the project\'s record, so a daemon that restarts before the post is taken does not read it again', async () => {
    const t = setup(new Date(2026, 10, 11, 9, 0).getTime()), landed = numbers({ free: [] })
    t.failing.set('post', down)
    // That it is being read is written before the read: a daemon that stops in the middle of it finds that on its next start.
    t.board.mockImplementation(async () => { expect(kept(t).board).toEqual({ day: '2026-11-11', words: '' }); return 'Trains: 4 landed.' })
    await passes(t, 1, landed)
    expect(t.board).toHaveBeenCalledOnce()
    expect(kept(t).board).toEqual({ day: '2026-11-11', words: 'Trains: 4 landed.' })
    // The next daemon, the same day: the post goes with those words, and nothing is read again.
    t.failing.clear()
    await passes(t, 1, landed, t.make())
    expect(t.board).toHaveBeenCalledOnce()
    expect(t.sent.map(([, , text]) => text)).toEqual([dayLine(landed, 'Wed 11 Nov', undefined, 'Trains: 4 landed.')])
    expect(kept(t).board).toBeUndefined()
    // One that stopped in the middle of the read posts the day without it.
    const u = setup(new Date(2026, 10, 11, 9, 0).getTime())
    writeFileSync(u.file, JSON.stringify({ app: { typedAt: 0, told: 0, said: false, activity: 0, day: '', board: { day: '2026-11-11', words: '' } } }))
    await passes(u, 1, landed)
    expect(u.board).not.toHaveBeenCalled()
    expect(u.sent.map(([, , text]) => text)).toEqual([dayLine(landed, 'Wed 11 Nov', undefined, '')])
    // What is kept of it that is not a day and its words is not kept; the rest of the record is.
    for (const board of ['x', { day: 1, words: 'w' }, { day: '2026-11-11' }, null]) {
      const v = setup(new Date(2026, 10, 11, 9, 0).getTime())
      writeFileSync(v.file, JSON.stringify({ app: { typedAt: 5, told: 0, said: false, activity: 0, day: '', board } }))
      v.failing.set('post', down)
      await passes(v, 1, landed)
      expect(v.board).toHaveBeenCalledOnce()
      expect(kept(v)).toMatchObject({ typedAt: 5, board: { day: '2026-11-11', words: '' } })
    }
  })

  it('says each failure once among the last two hundred, and a memory it could not write', async () => {
    const t = setup(), landed = numbers({ free: [] })
    t.goal.mockResolvedValue(null)
    for (let n = 0; n <= 200; n++) {
      t.failing.set('post', new Error(`Failure ${n}.`))
      await t.numbers.pass({ ...PROJECT, projectId: `project-${n}` }, landed, t.goal, t.board)
    }
    expect(t.log).toHaveBeenCalledTimes(201)
    // The newest is still remembered; the first was forgotten, and is said again.
    t.clock.now += MINUTE
    await t.numbers.pass({ ...PROJECT, projectId: 'project-200' }, landed, t.goal, t.board)
    expect(t.log).toHaveBeenCalledTimes(201)
    t.failing.set('post', new Error('Failure 0.'))
    await t.numbers.pass({ ...PROJECT, projectId: 'project-0' }, landed, t.goal, t.board)
    expect(t.log).toHaveBeenCalledTimes(202)
    const u = setup()
    mkdirSync(u.file)
    await passes(u, 16, quiet)
    expect(u.log).toHaveBeenCalledWith(expect.stringMatching(/^\[super-tab\] could not save the numbers: /))
    expect(hows(u)).toEqual(['tell'])
  })

  it('reads this computer\'s clock and writes to its log when given neither', async () => {
    const t = setup(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    try {
      const sent: string[] = []
      const ofNow = new PmNumbers({ file: t.file, send: async (_how, _project, _id, text) => { if (!sent.length) { sent.push(text); throw new Error('Not yet.') } sent.push(text) } })
      await ofNow.pass(PROJECT, numbers({ free: [] }), t.goal, t.board)
      expect(warn).toHaveBeenCalledWith('[super-tab] numbers: NOT_SENT acme/app: Not yet.')
      vi.setSystemTime(NOW + MINUTE)
      await ofNow.pass(PROJECT, numbers({ free: [] }), t.goal, t.board)
      expect(sent).toEqual(Array(2).fill(dayLine(numbers({ free: [] }), 'Wed 11 Nov', undefined, '')))
    } finally { vi.useRealTimers(); warn.mockRestore() }
  })

  it('keeps no more projects than it may, on disk and of the builders that wait, the ones longest untouched going first', async () => {
    const t = setup(), landed = numbers({ free: [] })
    for (let n = 0; n < 205; n++) await t.numbers.pass({ ...PROJECT, projectId: `project-${n}` }, landed, t.goal, t.board)
    expect(Object.keys(JSON.parse(readFileSync(t.file, 'utf8')))).toHaveLength(200)
    // The first is written again the next day, and so is no longer the oldest.
    t.clock.now += 24 * HOUR
    for (const n of [5, 300]) await t.numbers.pass({ ...PROJECT, projectId: `project-${n}` }, landed, t.goal, t.board)
    const names = Object.keys(JSON.parse(readFileSync(t.file, 'utf8')))
    expect(names).toHaveLength(200)
    expect(names.slice(0, 1).concat(names.slice(-2))).toEqual(['project-7', 'project-5', 'project-300'])
    // Builders that wait are kept for the two hundred projects passed last: the one passed longest ago starts its wait again.
    const u = setup()
    for (const n of [...Array.from({ length: 200 }, (_, n) => n), 0, 200]) await u.numbers.pass({ ...PROJECT, projectId: `project-${n}` }, quiet, u.goal, u.board)
    u.clock.now += 15 * MINUTE
    await u.numbers.pass({ ...PROJECT, projectId: 'project-0' }, quiet, u.goal, u.board)
    expect(u.sent).toHaveLength(1)
    await u.numbers.pass({ ...PROJECT, projectId: 'project-1' }, quiet, u.goal, u.board)
    expect(u.sent).toHaveLength(1)
    // A day's scoreboard is kept while its post is tried again, for the two hundred projects whose post failed last: the one
    // before them reads its own again.
    const v = setup(new Date(2026, 10, 11, 9, 0).getTime())
    v.failing.set('post', down)
    for (let n = 0; n <= 200; n++) await v.numbers.pass({ ...PROJECT, projectId: `project-${n}` }, landed, v.goal, v.board)
    expect(v.board).toHaveBeenCalledTimes(201)
    v.clock.now += MINUTE
    await v.numbers.pass({ ...PROJECT, projectId: 'project-200' }, landed, v.goal, v.board)
    expect(v.board).toHaveBeenCalledTimes(201)
    await v.numbers.pass({ ...PROJECT, projectId: 'project-0' }, landed, v.goal, v.board)
    expect(v.board).toHaveBeenCalledTimes(202)
  })
})

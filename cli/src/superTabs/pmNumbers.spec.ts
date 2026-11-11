import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Crew, Read } from './assign/crew.js'
import type { LedProject } from './githubMerge.js'
import { dayLine, numbersOf, placeOf, PmNumbers, shortLine, toldLine, type Numbers } from './pmNumbers.js'

type Json = Record<string, unknown>
const PROJECT: LedProject = { repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }
/** 14:00 on this computer, a Wednesday. */
const NOW = new Date(2026, 10, 11, 14, 0).getTime()
const MINUTE = 60_000, HOUR = 60 * MINUTE
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const crew = (): Crew => ({
  builders: ['Pip', 'Kai', 'Ada', 'Bo'].map(name => ({ id: name.toLowerCase(), name, label: `builder:${name.toLowerCase()}`, machineId: 'mac', engine: 'claude' })),
  machines: [], away: [{ name: 'Cy', label: 'builder:cy', why: 'down', since: ago(HOUR) }],
})
/** What the assigner read: each builder's open tasks, and the sized tasks nobody holds. */
const read = (open: Record<string, number>, free: string[]): Read => ({ open: new Map(Object.entries(open)), free: new Set(free) } as unknown as Read)
const numbers = (over: Partial<Numbers> = {}): Numbers => ({ builders: 4, free: ['Ada', 'Kai'], open: 0, held: 3, landed: 12, landedBy: [['Pip', 7], ['Kai', 5]], closed: 9, more: false, ...over })

describe('a project\'s counts after an assigner\'s pass', () => {
  it('counts the builders with nothing, the tasks nobody holds, and what the team landed in the last day', () => {
    const merged = (label: string, at: string, more: Json = {}) => ({ pull_request: { merged_at: at }, labels: [{ name: label }], updated_at: at, ...more })
    const counted = numbersOf({ now: NOW, crew: crew(), read: read({ pip: 2, kai: 0, ada: 0, bo: 0 }, ['#7', '#8', '#9']),
      // Bo's subscription has no room, and Ada was given #7 this pass: neither is free.
      short: [{ name: 'Bo', label: 'builder:bo', why: 'quota' }], picks: [{ task: '#7', builder: 'ada', start: 0 }],
      team: new Set(['builder:pip', 'builder:kai', 'builder:ada', 'builder:bo', 'builder:cy', 'builder:juno']),
      closed: [merged('builder:pip', ago(HOUR)), merged('Builder:Pip', ago(2 * HOUR)), merged('builder:kai', ago(23 * HOUR)),
        // A builder away now landed its own; the PM's counts under its label.
        merged('builder:cy', ago(3 * HOUR)), merged('builder:juno', ago(3 * HOUR)),
        // Older than a day, closed without merging, and a person's own pull request: not the team's landings of the day.
        merged('builder:pip', ago(25 * HOUR)), { pull_request: { merged_at: null }, labels: [{ name: 'builder:pip' }] }, merged('bug', ago(HOUR)),
        { closed_at: ago(HOUR), state_reason: 'completed' }, { closed_at: ago(2 * HOUR) }, { closed_at: ago(2 * HOUR), state_reason: null },
        // Closed as not planned, and closed two days ago.
        { closed_at: ago(HOUR), state_reason: 'not_planned' }, { closed_at: ago(49 * HOUR), state_reason: 'completed' }] })
    expect(counted).toEqual({ builders: 4, free: ['Kai'], open: 2, held: 3, landed: 5, landedBy: [['Pip', 2], ['Cy', 1], ['juno', 1], ['Kai', 1]], closed: 3, more: false })
  })

  it('says there may be more when the closed list it read is full of the day\'s', () => {
    const item = (at: string) => ({ closed_at: at, updated_at: at })
    const of = (closed: Json[]) => numbersOf({ now: NOW, crew: crew(), read: read({}, []), short: [], picks: [], team: new Set(), closed }).more
    expect(of(Array.from({ length: 100 }, () => item(ago(HOUR))))).toBe(true)
    expect(of(Array.from({ length: 99 }, () => item(ago(HOUR))))).toBe(false)
    expect(of([...Array.from({ length: 99 }, () => item(ago(HOUR))), item(ago(25 * HOUR))])).toBe(false)
  })
})

describe('where a project\'s numbers go', () => {
  it('finds the PM\'s own chat and the project\'s channel as the PM reads the Swarm', () => {
    const state = { projects: [{ id: 'other', leadConversationId: 'other-channel' }, { id: 'app', leadConversationId: 'app-channel' }],
      conversations: [{ id: 'pip-chat', kind: 'agent-chat', agentIds: ['pip'] }, { id: 'group', kind: 'group', agentIds: ['juno'] }, { id: 'juno-chat', kind: 'agent-chat', agentIds: ['juno'] }] }
    expect(placeOf(state, PROJECT, 'chat')).toBe('juno-chat')
    expect(placeOf(state, PROJECT, 'channel')).toBe('app-channel')
    // A Swarm with neither, or with an id that is none.
    expect(placeOf({}, PROJECT, 'chat')).toBeNull()
    expect(placeOf({ projects: [{ id: 'app', leadConversationId: '../x' }], conversations: 'none' }, PROJECT, 'channel')).toBeNull()
    expect(placeOf({ conversations: [{ id: 'juno-chat', kind: 'agent-chat' }] }, PROJECT, 'chat')).toBeNull()
  })
})

describe('what Harness says of the counts', () => {
  it('tells the PM who has nothing, what is open and what landed, and what to do', () => {
    expect(shortLine(numbers(), '14:00')).toBe('Harness, 14:00: Ada and Kai have nothing to do, and no sized task is open. 12 pull requests landed in the last 24 hours. '
      + 'Open the next tasks as issues, each with its part:, size: and p0-p2 labels. If the work is done, tell your person.')
    expect(shortLine(numbers({ free: ['Ada'], open: 1, landed: 1 }), '09:05')).toBe('Harness, 09:05: Ada has nothing to do, and the 1 sized task open cannot start yet. '
      + '1 pull request landed in the last 24 hours. Open the next tasks as issues, each with its part:, size: and p0-p2 labels. If the work is done, tell your person.')
    expect(shortLine(numbers({ free: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], open: 2 }), '09:05')).toContain('A, B, C, D, E and 2 more have nothing to do, and the 2 sized tasks open cannot start yet.')
  })

  it('tells the PM\'s person once the PM was told three times', () => {
    expect(toldLine(numbers(), 'Juno', '13:05')).toBe('Ada and Kai have had nothing to do since 13:05. Juno was told 3 times, and nothing changed.')
    expect(toldLine(numbers({ free: ['Ada', 'Bo', 'Kai'] }), 'Juno', '13:05')).toContain('Ada, Bo and Kai have had nothing')
    expect(toldLine(numbers({ free: ['Ada'] }), 'Juno', '13:05')).toContain('Ada has had nothing')
  })

  it('posts the day for the project\'s people', () => {
    expect(dayLine(numbers())).toBe('Harness, the last 24 hours: 12 pull requests landed (Pip 7, Kai 5) and 9 tasks closed. Now: 2 of 4 builders with nothing to do, 0 tasks open and 3 in hand.')
    expect(dayLine(numbers({ builders: 0, free: [], landed: 100, landedBy: [['A', 50], ['B', 20], ['C', 10], ['D', 10], ['E', 6], ['F', 4]], closed: 1, open: 1, held: 0, more: true })))
      .toBe('Harness, the last 24 hours: 100 pull requests or more landed (A 50, B 20, C 10, D 10, E 6, others) and 1 task closed. Now: no builder is running, 1 task open and 0 in hand.')
    expect(dayLine(numbers({ builders: 1, free: [], landed: 0, landedBy: [], closed: 2 }))).toBe('Harness, the last 24 hours: 0 pull requests landed and 2 tasks closed. '
      + 'Now: 0 of 1 builder with nothing to do, 0 tasks open and 3 in hand.')
  })
})

describe('the numbers, told as they are due', () => {
  const folders: string[] = []
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
  function setup() {
    const folder = mkdtempSync(join(tmpdir(), 'pm-numbers-'))
    folders.push(folder)
    const clock = { now: NOW }, sent: Array<[how: string, id: string, text: string]> = [], log = vi.fn()
    const failing = new Set<string>()
    const how = (name: string) => async (_project: LedProject, id: string, text: string) => {
      if (failing.has(name)) throw new Error('The server did not answer.')
      sent.push([name, id, text])
    }
    const file = join(folder, 'numbers.json')
    const make = () => new PmNumbers({ tell: how('tell'), say: how('say'), post: how('post'), file, now: () => clock.now, log })
    return { clock, sent, log, failing, file, make, numbers: make() }
  }
  /** A pass every minute for [minutes], as the assigner makes them. */
  const passes = async (t: ReturnType<typeof setup>, minutes: number, counted: Numbers, pm = t.numbers) => {
    for (let minute = 0; minute < minutes; minute++) { await pm.pass(PROJECT, counted); t.clock.now += MINUTE }
  }
  const quiet = numbers({ landed: 0, landedBy: [], closed: 0 })

  it('tells the PM once its builders have had nothing for five minutes, then once an hour', async () => {
    const t = setup()
    await passes(t, 5, quiet)
    expect(t.sent).toEqual([])
    await t.numbers.pass(PROJECT, quiet)
    expect(t.sent).toEqual([['tell', expect.stringMatching(/^numbers-[0-9a-f]{40}$/), shortLine(quiet, '14:05')]])
    await passes(t, 60, quiet)
    expect(t.sent).toHaveLength(1)
    await t.numbers.pass(PROJECT, quiet)
    expect(t.sent.map(([how, , text]) => [how, text])).toEqual([['tell', shortLine(quiet, '14:05')], ['tell', shortLine(quiet, '15:05')]])
    expect(t.sent[1]![1]).not.toBe(t.sent[0]![1])
  })

  it('tells nothing while every builder has work, and starts over once they have', async () => {
    const t = setup(), busy = { ...quiet, free: [] }
    await passes(t, 30, busy)
    await passes(t, 4, quiet)
    // Given work before the five minutes are up: nothing was said, and the next time waits its own five minutes.
    await passes(t, 1, busy)
    await passes(t, 5, quiet)
    expect(t.sent).toEqual([])
    await t.numbers.pass(PROJECT, quiet)
    expect(t.sent).toHaveLength(1)
  })

  it('tells the PM\'s person in the PM\'s place the fourth time, once, and the PM again when something changed', async () => {
    const t = setup()
    await passes(t, 3 * 60 + 6, quiet)
    expect(t.sent.map(([how]) => how)).toEqual(['tell', 'tell', 'tell', 'say'])
    expect(t.sent[3]![2]).toBe(toldLine(quiet, 'Juno', '14:00'))
    await passes(t, 5 * 60, quiet)
    expect(t.sent).toHaveLength(4)
    // Another builder has nothing now: its PM is told that, with the count started again.
    const more = numbers({ ...quiet, free: ['Ada', 'Bo', 'Kai'] })
    await passes(t, 1, more)
    expect(t.sent.at(-1)).toEqual(['tell', expect.any(String), shortLine(more, hhmm(t.clock.now - MINUTE))])
    // And a task opened that cannot start is a change too, told no sooner than an hour after the last.
    await passes(t, 59, numbers({ ...more, open: 1 }))
    expect(t.sent).toHaveLength(5)
    await passes(t, 2, numbers({ ...more, open: 1 }))
    expect(t.sent).toHaveLength(6)
  })

  it('keeps its counts over a restart', async () => {
    const t = setup()
    await passes(t, 66, quiet)
    expect(t.sent.map(([how]) => how)).toEqual(['tell', 'tell'])
    const again = t.make()
    await passes(t, 59, quiet, again)
    expect(t.sent).toHaveLength(2)
    await passes(t, 62, quiet, again)
    expect(t.sent.map(([how]) => how)).toEqual(['tell', 'tell', 'tell', 'say'])
    // A file that is not the numbers' is counted from now.
    writeFileSync(t.file, '{"app":{"since":"yesterday"},"../x":{}}')
    const fresh = t.make()
    await passes(t, 6, quiet, fresh)
    expect(t.sent.map(([how]) => how)).toEqual(['tell', 'tell', 'tell', 'say', 'tell'])
  })

  it('says a message the server did not take, and sends it under the same id the next pass', async () => {
    const t = setup()
    t.failing.add('tell')
    await passes(t, 7, quiet)
    expect(t.sent).toEqual([])
    expect(t.log).toHaveBeenCalledWith('[super-tab] numbers: NOT_SENT acme/app: The server did not answer.')
    t.failing.delete('tell')
    await passes(t, 1, quiet)
    expect(t.sent).toHaveLength(1)
    // The same hour's message has one id, whichever pass sends it and whatever minute it is: one sent again is posted once.
    const first = setup(), second = setup()
    second.clock.now += 2 * MINUTE
    for (const each of [first, second]) await passes(each, 6, quiet)
    expect(first.sent[0]![2]).not.toBe(second.sent[0]![2])
    expect(first.sent[0]![1]).toBe(second.sent[0]![1])
  })

  it('posts the day\'s numbers once, from nine, and none for a day with nothing to say', async () => {
    const t = setup()
    const busy = numbers({ free: [] })
    t.clock.now = new Date(2026, 10, 11, 8, 58).getTime()
    await passes(t, 2, busy)
    expect(t.sent).toEqual([])
    await passes(t, 3, busy)
    expect(t.sent).toEqual([['post', expect.stringMatching(/^numbers-[0-9a-f]{40}$/), dayLine(busy)]])
    // Not again that day, by the same Harness or the next.
    await passes(t, 60, busy)
    await passes(t, 60, busy, t.make())
    expect(t.sent).toHaveLength(1)
    // The next day, once more; a day when nothing landed and no task closed has none, and is not looked at again.
    t.clock.now = new Date(2026, 10, 12, 9, 0).getTime()
    await passes(t, 2, numbers({ free: [], landed: 0, landedBy: [], closed: 0 }))
    await passes(t, 2, busy)
    expect(t.sent).toHaveLength(1)
    t.clock.now = new Date(2026, 10, 13, 11, 30).getTime()
    t.failing.add('post')
    await passes(t, 1, busy)
    t.failing.delete('post')
    await passes(t, 2, busy)
    expect(t.sent.map(([how]) => how)).toEqual(['post', 'post'])
    expect(t.sent[1]![1]).not.toBe(t.sent[0]![1])
  })
})

const hhmm = (at: number) => `${String(new Date(at).getHours()).padStart(2, '0')}:${String(new Date(at).getMinutes()).padStart(2, '0')}`

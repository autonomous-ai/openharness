import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { costLine, readTaskTokens, TaskTokens, type Counts, type Hand, type ReadRow, type TaskRow } from './taskTokens.js'
import { SuperTabHostError } from './wire.js'

const root = mkdtempSync(join(tmpdir(), 'super-tab-task-tokens-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let files = 0

const PIP = { tabId: 'tab', agentId: 'pip', harnessId: 'h-pip' }
const JUNO = { tabId: 'tab', agentId: 'juno', harnessId: 'h-juno' }
const T0 = Date.parse('2026-11-11T09:00:00Z'), MIN = 60_000
const SONNET = 'claude-sonnet-5-5'
/** [n] tokens of one model, as uncached input. */
const of = (n: number, model = SONNET): Counts => ({ [model]: { input: n, output: 0, cacheRead: 0, cacheWrite: 0 } })
const tokens = (n: number, model = SONNET) => [{ model, input: n, output: 0, cacheRead: 0, cacheWrite: 0 }]
/** What a look found an agent with in acme/app: the task it holds, and its open pull requests, each with the head read ('' for one
 *  the look did not read; a head ending in `-draft` is a draft's). */
const hand = (held: number | null, pulls: Record<number, string> = {}, repo = 'acme/app'): Hand => ({ repo, held, pulls: Object.keys(pulls).map(Number),
  heads: Object.entries(pulls).filter(([, head]) => head).map(([number, head]) => ({ number: Number(number), head, draft: head.endsWith('-draft') })) })

/** Pip and Juno, two of this computer's person's agents, whose conversations' counts the core reads; the server takes their rows. */
function setup(options: { file?: string } = {}) {
  // Each agent's conversation has a count the core knows, nothing used yet, unless a test says the core knows none (null).
  const state = { now: T0, counts: { 'h-pip': of(0), 'h-juno': of(0) } as Record<string, Counts | null>, down: null as Error | null, slow: null as Promise<void> | null }
  const sent: Array<{ agent: string; row: TaskRow }> = []
  const send = vi.fn(async (agent: { tabId: string; agentId: string }, row: TaskRow) => {
    if (state.down) throw state.down
    sent.push({ agent: `${agent.tabId}/${agent.agentId}`, row: structuredClone(row) })
  })
  const count = vi.fn(async (harnessId: string) => { await state.slow; return state.counts[harnessId] ?? null })
  const log = vi.fn()
  const listeners = new Set<(end: { agentId: string }) => void>()
  const file = options.file ?? join(root, `tokens-${files++}.json`)
  const make = () => new TaskTokens({ onEnd: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, count, send, file,
    now: () => state.now, log })
  const ledger = make()
  /** A turn of [agent] that used [n] more tokens, ended [minutes] later. */
  const turn = async (n: number, agent = PIP, minutes = 1) => {
    const before = state.counts[agent.harnessId]?.[SONNET]?.input ?? 0
    state.counts[agent.harnessId] = of(before + n)
    state.now += minutes * MIN
    await ledger.ended(agent.harnessId)
  }
  const rows = () => sent.map(({ agent, row }) => `${agent} ${row.repository}#${row.number} ${row.kind} ${row.tokens.map(t => `${t.model}:${t.input + t.output + t.cacheRead + t.cacheWrite}`).join('+')} rounds=${row.rounds}`)
  return { state, sent, send, count, log, listeners, file, make, ledger, turn, rows }
}

describe('tokens for a task, counted on its builder\'s own computer (taskTokens.ts)', () => {
  it('counts nothing, reads no count and writes no file for a terminal that is no agent of a project', async () => {
    const f = setup()
    f.state.counts['h-other'] = of(500)
    await f.ledger.ended('h-other')
    expect(f.count).not.toHaveBeenCalled()
    expect(existsSync(f.file)).toBe(false)
  })

  it('hears each turn\'s end from when it starts until it stops', async () => {
    const f = setup()
    f.ledger.start()
    f.ledger.start()
    expect(f.listeners.size).toBe(1)
    await f.ledger.looked(PIP, [hand(14)])
    f.state.counts['h-pip'] = of(700)
    for (const listener of f.listeners) listener({ agentId: 'h-pip' })
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    expect(f.rows()).toEqual([`tab/pip acme/app#30 build ${SONNET}:700 rounds=0`])
    f.ledger.stop()
    expect(f.listeners.size).toBe(0)
    f.ledger.stop()
  })

  // The package's boundaries: taken, its pull request up, each fix. Nothing is written while it still holds the task; its row
  // goes once its pull request is up.
  it('gives what each turn used to the task its agent holds, then to its pull request as it opens and at each push, and writes each row when its work stops', async () => {
    const f = setup()
    // The first look is the first mark: what the conversation used before it is no task's.
    f.state.counts['h-pip'] = of(9_000)
    await f.ledger.looked(PIP, [hand(null)])
    // It takes #14 by command, and builds it over two turns.
    f.state.now += 5 * MIN
    await f.ledger.took(PIP)
    const took = f.state.now
    await f.turn(1_000)
    await f.ledger.looked(PIP, [hand(14)])
    await f.turn(2_000)
    await f.ledger.looked(PIP, [hand(14)])
    expect(f.send).not.toHaveBeenCalled()
    // The turn that opens its pull request: the task is held no more, and the pull request is new.
    await f.turn(4_000)
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    expect(f.rows()).toEqual([`tab/pip acme/app#14 build ${SONNET}:3000 rounds=0`, `tab/pip acme/app#30 build ${SONNET}:4000 rounds=0`])
    expect(f.sent.map(({ row }) => [row.startedAt, row.endedAt])).toEqual([[took, took + 2 * MIN], [took, took + 3 * MIN]])
    // A turn with nothing to show for it (it waits for its read) is carried, and goes to the fix it pushes next: a round.
    await f.turn(100)
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    expect(f.send).toHaveBeenCalledTimes(2)
    await f.turn(500)
    await f.ledger.looked(PIP, [hand(null, { 30: 'bbb' })])
    await f.turn(50)
    await f.ledger.looked(PIP, [hand(null, { 30: 'ccc' })])
    expect(f.rows().slice(2)).toEqual([`tab/pip acme/app#30 fix ${SONNET}:600 rounds=1`, `tab/pip acme/app#30 fix ${SONNET}:650 rounds=2`])
    expect(f.sent[3]!.row.startedAt).toBe(f.sent[2]!.row.endedAt)
    // Every token since its first mark was counted once.
    expect(3_000 + 4_000 + 650).toBe(f.state.counts['h-pip']![SONNET]!.input - 9_000)
    // A take begins one building: a pull request opened later with no take of its own does not start at that one.
    await f.turn(20, PIP, 30)
    await f.ledger.looked(PIP, [hand(null, { 30: 'ccc', 31: 'aaa' })])
    expect(f.rows().at(-1)).toBe(`tab/pip acme/app#31 build ${SONNET}:20 rounds=0`)
    expect(f.sent.at(-1)!.row.startedAt).toBe(f.state.now)
  })

  it('counts each model\'s growth between two marks, part by part, and nothing for a model that did not move', async () => {
    const f = setup()
    f.state.counts['h-pip'] = { [SONNET]: { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 }, idle: { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 } }
    await f.ledger.looked(PIP, [hand(null)])
    f.state.counts['h-pip'] = { [SONNET]: { input: 15, output: 20, cacheRead: 900, cacheWrite: 41 }, idle: { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 },
      'gpt-5.5': { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 } }
    await f.ledger.ended('h-pip')
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    expect(f.sent[0]!.row.tokens).toEqual([{ model: SONNET, input: 5, output: 0, cacheRead: 600, cacheWrite: 1 }, { model: 'gpt-5.5', input: 1, output: 2, cacheRead: 3, cacheWrite: 0 }])
  })

  // A new conversation's count begins again: the difference would be below zero, and what it used is all of it.
  it('counts all of a count that fell', async () => {
    const f = setup()
    f.state.counts['h-pip'] = { [SONNET]: { input: 5_000, output: 900, cacheRead: 80_000, cacheWrite: 10 } }
    await f.ledger.looked(PIP, [hand(null)])
    f.state.counts['h-pip'] = { [SONNET]: { input: 300, output: 950, cacheRead: 2_000, cacheWrite: 10 } }
    await f.ledger.ended('h-pip')
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    expect(f.sent[0]!.row.tokens).toEqual([{ model: SONNET, input: 300, output: 50, cacheRead: 2_000, cacheWrite: 0 }])
  })

  it('counts a push to a draft as building still, and a push after it was up for reading as a fix round', async () => {
    const f = setup()
    await f.ledger.looked(PIP, [hand(null)])
    await f.turn(1_000)
    await f.ledger.looked(PIP, [hand(null, { 30: 'a-draft' })])
    await f.turn(2_000)
    await f.ledger.looked(PIP, [hand(null, { 30: 'b-draft' })])
    await f.turn(300)
    await f.ledger.looked(PIP, [hand(null, { 30: 'ccc' })])
    await f.turn(40)
    await f.ledger.looked(PIP, [hand(null, { 30: 'ddd' })])
    expect(f.rows()).toEqual([`tab/pip acme/app#30 build ${SONNET}:1000 rounds=0`, `tab/pip acme/app#30 build ${SONNET}:3000 rounds=0`,
      `tab/pip acme/app#30 build ${SONNET}:3300 rounds=0`, `tab/pip acme/app#30 fix ${SONNET}:40 rounds=1`])
  })

  it('takes no pull request for new the first time a repository is listed, nor a head for moved the first time it is read', async () => {
    const f = setup()
    await f.ledger.looked(PIP, [hand(null)])
    await f.turn(1_000)
    // Its other project's repository, listed for the first time, with a pull request open for days, its head not read.
    await f.ledger.looked(PIP, [hand(null), hand(null, { 7: '' }, 'acme/docs')])
    await f.turn(10)
    // Its head read for the first time, and unread again a look later: no push in either.
    await f.ledger.looked(PIP, [hand(null), hand(null, { 7: 'aaa' }, 'acme/docs')])
    await f.ledger.looked(PIP, [hand(null), hand(null, { 7: '' }, 'acme/docs')])
    expect(f.send).not.toHaveBeenCalled()
    // What was carried goes to the push seen next, in whichever repository.
    await f.ledger.looked(PIP, [hand(null), hand(null, { 7: 'bbb' }, 'acme/docs')])
    expect(f.rows()).toEqual([`tab/pip acme/docs#7 fix ${SONNET}:1010 rounds=1`])
  })

  it('gives a look\'s tokens to the first pull request that moved, before a new one and before the task held', async () => {
    const f = setup()
    await f.ledger.looked(PIP, [hand(14, { 30: 'aaa' })])
    await f.turn(800)
    await f.ledger.looked(PIP, [hand(14, { 30: 'bbb', 31: 'new', 32: 'new' })])
    expect(f.rows()).toEqual([`tab/pip acme/app#30 fix ${SONNET}:800 rounds=1`])
    await f.turn(70)
    await f.ledger.looked(PIP, [hand(14, { 30: 'bbb', 31: 'new', 32: 'new', 33: 'new' })])
    expect(f.rows().slice(1)).toEqual([`tab/pip acme/app#33 build ${SONNET}:70 rounds=0`])
    // Two that moved in one look: the first, by its number, takes it all.
    await f.turn(9)
    await f.ledger.looked(PIP, [hand(14, { 30: 'ccc', 31: 'moved', 32: 'new', 33: 'new' })])
    expect(f.rows().slice(2)).toEqual([`tab/pip acme/app#30 fix ${SONNET}:809 rounds=2`])
  })

  // "A read from its ask to its verdict": an ask is typed to its reader as a turn of its own.
  it('gives a verdict made by command what its turn used so far, as a read, written at once; the task its reader holds is not', async () => {
    const f = setup()
    await f.ledger.took(JUNO)
    await f.ledger.looked(JUNO, [hand(21)])
    await f.turn(5_000, JUNO)
    // The ask is typed the moment its building turn ends: no look comes between. Then it reads #30 and makes its verdict.
    // A read begins at its own boundary, not at the take of the task its reader builds.
    f.state.counts['h-juno'] = of(5_900)
    f.state.now += 4 * MIN
    await f.ledger.read(JUNO, 'acme/app', 30)
    expect(f.rows()).toEqual([`tab/juno acme/app#30 read ${SONNET}:900 rounds=1`])
    expect([f.sent[0]!.row.startedAt, f.sent[0]!.row.endedAt]).toEqual([f.state.now, f.state.now])
    // The rest of that turn, and the turn before, are its own task's, which it still holds: not written yet.
    await f.turn(30, JUNO)
    await f.ledger.looked(JUNO, [hand(21)])
    expect(f.send).toHaveBeenCalledTimes(1)
    // A second read of the same pull request, on its next head, is one more round of the same row.
    f.state.counts['h-juno'] = of(6_330)
    await f.ledger.read(JUNO, 'acme/app', 30)
    expect(f.rows().slice(1)).toEqual([`tab/juno acme/app#30 read ${SONNET}:1300 rounds=2`])
    await f.ledger.looked(JUNO, [hand(null, { 40: 'aaa' })])
    expect(f.rows().slice(2)).toEqual([`tab/juno acme/app#21 build ${SONNET}:5030 rounds=0`])
  })

  it('makes a reader\'s first verdict its first mark: nothing is known of what it used before', async () => {
    const f = setup()
    f.state.counts['h-juno'] = of(2_000)
    await f.ledger.read(JUNO, 'acme/app', 30)
    expect(f.send).not.toHaveBeenCalled()
    f.state.counts['h-juno'] = of(2_400)
    await f.ledger.read(JUNO, 'acme/app', 31)
    expect(f.rows()).toEqual([`tab/juno acme/app#31 read ${SONNET}:400 rounds=1`])
  })

  it('makes no mark while the core knows no count: its first known count is its first mark, and an unknown one is never read as nothing used', async () => {
    const f = setup()
    f.state.counts['h-pip'] = null
    await f.ledger.looked(PIP, [hand(14)])
    // The first count the core knows: what the conversation used before it is not known to be this task's.
    f.state.counts['h-pip'] = of(1_000)
    await f.ledger.ended('h-pip')
    // Unknown again, then a core that cannot be asked: no mark, and the count before stands.
    f.state.counts['h-pip'] = null
    await f.ledger.ended('h-pip')
    f.count.mockRejectedValueOnce(new Error('the core is restarting'))
    await f.ledger.ended('h-pip')
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    expect(f.send).not.toHaveBeenCalled()
    f.state.counts['h-pip'] = of(1_250)
    await f.ledger.ended('h-pip')
    await f.ledger.looked(PIP, [hand(null, { 30: 'bbb' })])
    expect(f.rows()).toEqual([`tab/pip acme/app#30 fix ${SONNET}:250 rounds=1`])
    // A count that could not be read stopped nothing, and is no failure to say.
    expect(f.log).not.toHaveBeenCalled()
  })

  it('counts a seventeenth model with the others, so a row stays one the server takes', async () => {
    const f = setup()
    await f.ledger.looked(PIP, [hand(14)])
    f.state.counts['h-pip'] = Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`m${String(i).padStart(2, '0')}`, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }]))
    await f.ledger.ended('h-pip')
    await f.ledger.looked(PIP, [hand(null, { 30: 'a-draft' })])
    const models = f.sent[0]!.row.tokens
    expect(models).toHaveLength(16)
    expect(models.at(-1)).toEqual({ model: 'other', input: 3, output: 0, cacheRead: 0, cacheWrite: 0 })
    // More of the same work: a model counted apart before stays apart, and more of the rest joins the others.
    f.state.counts['h-pip'] = { ...f.state.counts['h-pip'], m00: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }, m17: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 } }
    await f.ledger.ended('h-pip')
    await f.ledger.looked(PIP, [hand(null, { 30: 'b-draft' })])
    const more = f.sent[1]!.row.tokens
    expect(more).toHaveLength(16)
    expect([more[0], more.at(-1)]).toEqual([{ model: 'm00', input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }, { model: 'other', input: 11, output: 0, cacheRead: 0, cacheWrite: 0 }])
  })

  it('counts a turn\'s end before the look that follows it, however slowly the count is read', async () => {
    const f = setup()
    await f.ledger.looked(PIP, [hand(14)])
    let release!: () => void
    f.state.slow = new Promise<void>(resolve => { release = resolve })
    f.state.counts['h-pip'] = of(600)
    const ended = f.ledger.ended('h-pip'), looked = f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    release()
    await Promise.all([ended, looked])
    expect(f.rows()).toEqual([`tab/pip acme/app#30 build ${SONNET}:600 rounds=0`])
  })

  // Failures are seen, a retry is bounded, and nothing is lost: the totals wait in the file.
  it('keeps a row the server did not take, says so once, and writes it at a later look, no sooner than a wait that doubles', async () => {
    const f = setup()
    await f.ledger.looked(PIP, [hand(null)])
    f.state.down = new SuperTabHostError('NOT_FOUND', 'Route not found.', 404)
    await f.turn(1_000)
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    await f.turn(200, PIP, 0)
    await f.ledger.looked(PIP, [hand(null, { 30: 'bbb' })])
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.log.mock.calls).toEqual([['[super-tab] tasks\' tokens are not kept by the server: they wait here · TOKENS_UNSENT NOT_FOUND']])
    // 30 seconds on it is tried again, with the row whose write did not go yet (the other waits out its minute), and fails
    // again: the next try is a minute on. Nothing more is said.
    f.state.now += 30_000
    f.state.down = new Error('socket hang up')
    await f.ledger.looked(PIP, [hand(null, { 30: 'bbb' })])
    f.state.now += 59_000
    await f.ledger.looked(PIP, [hand(null, { 30: 'bbb' })])
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.log).toHaveBeenCalledTimes(1)
    f.state.now += 1_000
    f.state.down = null
    await f.ledger.looked(PIP, [hand(null, { 30: 'bbb' })])
    expect(f.rows()).toEqual([`tab/pip acme/app#30 build ${SONNET}:1000 rounds=0`, `tab/pip acme/app#30 fix ${SONNET}:200 rounds=1`])
    expect(f.log.mock.calls.at(-1)).toEqual(['[super-tab] tasks\' tokens are kept by the server again'])
    // Written, a row is not written again until it changes.
    await f.ledger.looked(PIP, [hand(null, { 30: 'bbb' })])
    expect(f.send).toHaveBeenCalledTimes(4)
    expect(f.log).toHaveBeenCalledTimes(2)
  })

  // The server keeps the last write of a row to arrive (anh Dee's call, 12 November: the daemon keeps them in order). A write that
  // did not come back may still be on its way: its row is written again only once that one can no longer arrive.
  it('writes a row one write at a time: one not answered keeps its row a minute, from a later look and from a daemon started meanwhile', async () => {
    const f = setup()
    await f.ledger.looked(PIP, [hand(null)])
    await f.turn(1_000)
    // Its draft is up and the row's write goes; the daemon restarts before the server answers.
    let going!: () => void
    const gone = new Promise<void>(resolve => { going = resolve })
    f.send.mockImplementationOnce(() => { going(); return new Promise<void>(() => {}) })
    void f.ledger.looked(PIP, [hand(null, { 30: 'a-draft' })])
    await gone
    const again = f.make()
    await again.looked(PIP, [hand(null, { 30: 'a-draft' })])
    expect(f.send).toHaveBeenCalledTimes(1)
    // A minute after it went, it is written, and a row answered is written again at its next change at once.
    f.state.now += MIN
    await again.looked(PIP, [hand(null, { 30: 'a-draft' })])
    f.state.counts['h-pip'] = of(1_300)
    await again.ended('h-pip')
    await again.looked(PIP, [hand(null, { 30: 'b-draft' })])
    expect(f.rows()).toEqual([`tab/pip acme/app#30 build ${SONNET}:1000 rounds=0`, `tab/pip acme/app#30 build ${SONNET}:1300 rounds=0`])
    // In one daemon too: a write that failed with no word from the server keeps its row the minute, though the others go at 30 seconds.
    const g = setup()
    await g.ledger.looked(PIP, [hand(null)])
    await g.turn(1_000)
    g.state.down = new SuperTabHostError('BACKEND_TIMEOUT', 'The Harness backend did not answer within 20s.', 504)
    await g.ledger.looked(PIP, [hand(null, { 30: 'a-draft' })])
    g.state.down = null
    g.state.now += 30_000
    // More building on that draft goes to its row, which still waits; a new pull request's row goes at once.
    await g.turn(10, PIP, 0)
    await g.ledger.looked(PIP, [hand(null, { 30: 'b-draft' })])
    await g.turn(5, PIP, 0)
    await g.ledger.looked(PIP, [hand(null, { 30: 'b-draft', 31: 'new' })])
    expect(g.rows()).toEqual([`tab/pip acme/app#31 build ${SONNET}:5 rounds=0`])
    // Its minute over, it goes, and fails with no word again: the next minute counts from that write, whatever the wait says.
    g.state.now += 30_000
    g.state.down = new SuperTabHostError('BACKEND_TIMEOUT', 'The Harness backend did not answer within 20s.', 504)
    await g.ledger.looked(PIP, [hand(null, { 30: 'b-draft', 31: 'new' })])
    g.state.down = null
    g.state.now += 30_000
    await g.ledger.looked(PIP, [hand(null, { 30: 'b-draft', 31: 'new' })])
    expect(g.send).toHaveBeenCalledTimes(3)
    g.state.now += 30_000
    await g.ledger.looked(PIP, [hand(null, { 30: 'b-draft', 31: 'new' })])
    expect(g.rows().slice(1)).toEqual([`tab/pip acme/app#30 build ${SONNET}:1010 rounds=0`])
  })

  // Change agent (replacements.ts, the backend's agent.rebind): the same Swarm agent goes on in a new terminal. Kept by its old
  // terminal alone, its rows were left there, and its next write took the server's totals down (review of #4143).
  it('goes on with an agent\'s rows when it moves to a new terminal, counted from that terminal\'s first reading', async () => {
    const f = setup()
    const MOVED = { ...PIP, harnessId: 'h-pip-2' }, AGAIN = { ...PIP, harnessId: 'h-pip-3' }
    await f.ledger.looked(PIP, [hand(null)])
    await f.ledger.took(PIP)
    await f.turn(3_000)
    await f.ledger.looked(PIP, [hand(14)])
    // Changed while it builds #14: what the new terminal's conversation counted before its first look there is no work of its.
    f.state.counts['h-pip-2'] = of(70_000)
    await f.ledger.looked(MOVED, [hand(14)])
    await f.turn(500, MOVED)
    await f.ledger.looked(MOVED, [hand(null, { 30: 'aaa' })])
    expect(f.rows()).toEqual([`tab/pip acme/app#14 build ${SONNET}:3000 rounds=0`, `tab/pip acme/app#30 build ${SONNET}:500 rounds=0`])
    await f.turn(400, MOVED)
    await f.ledger.looked(MOVED, [hand(null, { 30: 'bbb' })])
    // Changed again once its fix is written: the next fix adds to that row.
    f.state.counts['h-pip-3'] = of(5)
    await f.ledger.looked(AGAIN, [hand(null, { 30: 'bbb' })])
    await f.turn(50, AGAIN)
    await f.ledger.looked(AGAIN, [hand(null, { 30: 'ccc' })])
    expect(f.rows().slice(2)).toEqual([`tab/pip acme/app#30 fix ${SONNET}:400 rounds=1`, `tab/pip acme/app#30 fix ${SONNET}:450 rounds=2`])
    // A terminal it left is no agent's: a late turn's end there counts nothing, and the agent is kept once, by its terminal now.
    f.state.counts['h-pip'] = of(9_999_999)
    await f.ledger.ended('h-pip')
    await f.ledger.looked(AGAIN, [hand(null, { 30: 'ddd' })])
    expect(f.send).toHaveBeenCalledTimes(4)
    expect(Object.keys(JSON.parse(readFileSync(f.file, 'utf8')))).toEqual(['h-pip-3'])
  })

  // A terminal another agent takes over: what it kept is the first agent's, and goes on with it where it is seen next, never as
  // the new one's (review of #4143).
  it('never writes one agent\'s rows as another\'s that took its terminal over, and writes them as its own where it is seen again', async () => {
    const f = setup()
    const OAK = { tabId: 'tab2', agentId: 'oak', harnessId: 'h-pip' }, BACK = { ...PIP, harnessId: 'h-pip-2' }
    await f.ledger.looked(PIP, [hand(null)])
    await f.turn(1_000)
    f.state.down = new SuperTabHostError('BACKEND_UNAVAILABLE', 'Could not reach this Super Tab.', 503)
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    f.state.down = null
    f.state.now += 2 * MIN
    await f.turn(7)
    // The same terminal, now another Swarm's agent, with a pull request of its own in another repository: what it uses from
    // the first agent's last mark is its own.
    f.state.counts['h-pip'] = of(1_020)
    await f.ledger.looked(OAK, [hand(null, { 5: 'zzz' }, 'oak/site')])
    await f.turn(20, OAK)
    await f.ledger.looked(OAK, [hand(null, { 5: 'yyy' }, 'oak/site')])
    expect(f.rows()).toEqual([`tab2/oak oak/site#5 fix ${SONNET}:33 rounds=1`])
    f.state.counts['h-pip-2'] = of(0)
    await f.ledger.looked(BACK, [hand(null, { 30: 'aaa' })])
    expect(f.rows().slice(1)).toEqual([`tab/pip acme/app#30 build ${SONNET}:1000 rounds=0`])
  })

  // A turn's end is the most frequent mark, and the file holds every agent's rows (up to 100 each): it is not written then.
  it('writes no file as a turn ends: a daemon that stops before the next look counts that turn there', async () => {
    const f = setup()
    await f.ledger.looked(PIP, [hand(14)])
    const kept = readFileSync(f.file, 'utf8')
    await f.turn(500)
    expect(readFileSync(f.file, 'utf8')).toBe(kept)
    await f.make().looked(PIP, [hand(null, { 30: 'aaa' })])
    expect(f.rows()).toEqual([`tab/pip acme/app#30 build ${SONNET}:500 rounds=0`])
  })

  it('lets go of a row the server refuses for good, says which, and writes the others', async () => {
    const f = setup()
    await f.ledger.looked(PIP, [hand(14)])
    await f.turn(1_000)
    await f.ledger.looked(PIP, [hand(14)])
    await f.turn(300)
    f.send.mockRejectedValueOnce(new SuperTabHostError('REPOSITORY_NOT_PROJECT', 'This agent works on no project of that repository.', 422))
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    expect(f.log.mock.calls).toEqual([['[super-tab] a task\'s tokens were refused by the server, and are let go · REPOSITORY_NOT_PROJECT acme/app#14']])
    expect(f.rows()).toEqual([`tab/pip acme/app#30 build ${SONNET}:300 rounds=0`])
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    expect(f.send).toHaveBeenCalledTimes(2)
  })

  it('goes on after a restart from what it kept: the count at its last mark, what it carries, its last take, the heads it saw and the rows not written', async () => {
    const f = setup()
    await f.ledger.looked(PIP, [hand(null)])
    await f.ledger.took(PIP)
    const took = f.state.now
    f.state.down = new SuperTabHostError('BACKEND_UNAVAILABLE', 'Could not reach this Super Tab.', 503)
    await f.turn(1_000)
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    // Its next task taken, and a turn of it ended with no look yet, as the daemon stops.
    await f.ledger.took(PIP)
    const tookNext = f.state.now
    await f.turn(40)
    f.state.down = null
    const again = f.make()
    await again.looked(PIP, [hand(null, { 30: 'aaa', 31: 'new' })])
    expect(f.rows()).toEqual([`tab/pip acme/app#30 build ${SONNET}:1000 rounds=0`, `tab/pip acme/app#31 build ${SONNET}:40 rounds=0`])
    expect(f.sent.map(({ row }) => row.startedAt)).toEqual([took, tookNext])
    f.state.counts['h-pip'] = of(1_140)
    await again.ended('h-pip')
    await again.looked(PIP, [hand(null, { 30: 'bbb', 31: 'new' })])
    expect(f.rows().slice(2)).toEqual([`tab/pip acme/app#30 fix ${SONNET}:100 rounds=1`])
    expect(JSON.parse(readFileSync(f.file, 'utf8'))['h-pip']).toMatchObject({ tabId: 'tab', agentId: 'pip', from: of(1_140), carried: {}, began: null,
      pulls: { 'acme/app': { 30: { head: 'bbb', draft: false }, 31: { head: 'new', draft: false } } } })
  })

  // One terminal can be an agent of two Swarms (service.ts SWARM_AMBIGUOUS): its looks are its first Swarm's agent, its verdicts
  // by command its second's. Moving back into a terminal it used, an entry starts from that terminal's last count: from none,
  // the second verdict's tokens were never written (review of #4143).
  it('counts each verdict of a terminal that is an agent of two Swarms, as the terminal\'s entry goes back and forth', async () => {
    const f = setup()
    const A = { tabId: 'T1', agentId: 'a', harnessId: 'h1' }, B = { tabId: 'T2', agentId: 'b', harnessId: 'h1' }
    f.state.counts.h1 = of(0)
    const use = (n: number) => { f.state.counts.h1 = of((f.state.counts.h1?.[SONNET]?.input ?? 0) + n) }
    await f.ledger.looked(A, [hand(14)])
    use(1_000); f.state.now += MIN; await f.ledger.ended('h1')
    await f.ledger.looked(A, [hand(14)])
    use(300); f.state.now += MIN
    await f.ledger.read(B, 'other/repo', 50)
    use(200); await f.ledger.ended('h1')
    await f.ledger.looked(A, [hand(14)])
    use(700); f.state.now += MIN; await f.ledger.ended('h1')
    await f.ledger.looked(A, [hand(14)])
    use(400); f.state.now += MIN
    await f.ledger.read(B, 'other/repo', 51)
    expect(f.rows()).toContain(`T2/b other/repo#51 read ${SONNET}:400 rounds=1`)
  })

  it('reads nothing it cannot trust from its file: an agent or a row that is not one is counted from now', async () => {
    const f = setup()
    const row = { repository: 'acme/app', number: 30, kind: 'build', tokens: tokens(700), rounds: 0, startedAt: T0, endedAt: T0 }
    writeFileSync(f.file, JSON.stringify({
      'h-pip': { tabId: 'tab', agentId: 'pip', at: T0, from: of(1_000), carried: of(50), began: 'yesterday',
        pulls: { 'acme/app': { 30: { head: 'aaa', draft: false }, 31: { head: 7 } } },
        // A write said to be on its way at a time that is no number holds nothing.
        rows: { 'acme/app#30 build': { row, sent: false, sending: String(T0) }, 'acme/app#31 build': { row: { ...row, tokens: [{ model: SONNET, input: -1 }] }, sent: false },
          'acme/app#32 build': { row: { ...row, tokens: 'many' } }, 'acme/app#33 build': { row: { ...row, tokens: [{ ...tokens(1)[0], model: '' }] } },
          'acme/app#34 build': { row: { ...row, repository: 7 } }, 'acme/app#35 build': { row: { ...row, kind: 'review' } } } },
      'h-bad-id': { tabId: 'not an id', agentId: 'x', at: T0, from: null, carried: {} },
      'h-bad-count': { tabId: 'tab', agentId: 'x', at: T0, from: { [SONNET]: { input: 'many' } }, carried: {} },
      'h-bad-carry': { tabId: 'tab', agentId: 'x', at: T0, from: null, carried: { [SONNET]: { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 } } },
      'h-bad-time': { tabId: 'tab', agentId: 'x', at: 'now', from: null, carried: {} },
      'h-fresh': { tabId: 'tab', agentId: 'fresh', at: T0, from: null, carried: {} },
    }))
    f.state.counts['h-pip'] = of(1_200)
    // The kept row is written. #31's head was never read as one, so read now it did not move: what is carried waits.
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa', 31: 'ccc' })])
    expect(f.rows()).toEqual([`tab/pip acme/app#30 build ${SONNET}:700 rounds=0`])
    await f.ledger.looked(PIP, [hand(null, { 30: 'bbb', 31: 'ccc' })])
    expect(f.rows().slice(1)).toEqual([`tab/pip acme/app#30 fix ${SONNET}:250 rounds=1`])
    expect(Object.keys(JSON.parse(readFileSync(f.file, 'utf8'))).sort()).toEqual(['h-fresh', 'h-pip'])
    // Nothing readable at all: it starts from nothing.
    writeFileSync(f.file, '{ not json')
    const again = f.make()
    await again.ended('h-pip')
    expect(existsSync(f.file) && readFileSync(f.file, 'utf8')).toBe('{ not json')
  })

  it('keeps the hundred rows of an agent touched last, and the two hundred agents marked last', async () => {
    const f = setup()
    await f.ledger.looked(PIP, [hand(null)])
    f.state.down = new SuperTabHostError('BACKEND_UNAVAILABLE', 'Could not reach this Super Tab.', 503)
    for (let number = 1; number <= 101; number++) {
      f.state.counts['h-pip'] = of(number)
      await f.ledger.read(PIP, 'acme/app', number)
    }
    const kept = Object.keys(JSON.parse(readFileSync(f.file, 'utf8'))['h-pip'].rows)
    expect(kept).toHaveLength(100)
    expect(kept[0]).toBe('acme/app#2 read')
    for (let n = 1; n <= 200; n++) {
      f.state.now += 1_000
      await f.ledger.took({ tabId: 'tab', agentId: `a${n}`, harnessId: `h-${n}` })
    }
    const agents = Object.keys(JSON.parse(readFileSync(f.file, 'utf8')))
    expect(agents).toHaveLength(200)
    expect(agents).not.toContain('h-pip')
  })

  it('says what stopped a mark and makes the next one, and says a file it could not write', async () => {
    const f = setup({ file: join(root, 'a-file-not-a-folder', 'tokens.json') })
    writeFileSync(join(root, 'a-file-not-a-folder'), '')
    await f.ledger.looked(PIP, [hand(14)])
    expect(f.log.mock.calls.at(-1)![0]).toMatch(/^\[super-tab\] could not save the tasks' tokens: /)
    const clock = vi.spyOn(f.state, 'now', 'get').mockImplementationOnce(() => { throw new Error('no clock') })
    await f.ledger.took(PIP)
    expect(f.log.mock.calls.at(-1)).toEqual(['[super-tab] tasks\' tokens: no clock'])
    clock.mockImplementationOnce(() => { throw 'no clock at all' })
    await f.ledger.took(PIP)
    expect(f.log.mock.calls.at(-1)).toEqual(['[super-tab] tasks\' tokens: no clock at all'])
    clock.mockRestore()
    await f.turn(10)
    await f.ledger.looked(PIP, [hand(null, { 30: 'aaa' })])
    expect(f.rows()).toEqual([`tab/pip acme/app#30 build ${SONNET}:10 rounds=0`])
  })

  it('logs to the console and reads the clock when given neither', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ledger = new TaskTokens({ onEnd: () => () => {}, count: async () => of(1), send: async () => {}, file: join(root, 'another-file-not-a-folder', 'tokens.json') })
    writeFileSync(join(root, 'another-file-not-a-folder'), '')
    const before = Date.now()
    await ledger.took(PIP)
    expect(warn.mock.calls[0]![0]).toMatch(/^\[super-tab\] could not save the tasks' tokens: /)
    expect(Date.now()).toBeGreaterThanOrEqual(before)
    warn.mockRestore()
  })
})

describe('the sentence a landed change\'s comment gains', () => {
  const NOW = T0 + 42 * MIN
  const row = (over: Partial<ReadRow>): ReadRow => ({ number: 14, kind: 'build', name: 'Pip', tokens: tokens(1_000), rounds: 0, startedAt: T0, endedAt: T0 + MIN, ...over })

  it('names its builder, the model that used the most, the minutes since it was taken, every token it used and its fix rounds', () => {
    const rows = [row({ tokens: [{ model: SONNET, input: 100_000, output: 40_000, cacheRead: 900_000, cacheWrite: 60_000 }] }),
      row({ number: 30, startedAt: T0 + 10 * MIN, tokens: [...tokens(50_000), ...tokens(60_000, 'claude-haiku-5-5')] }),
      row({ number: 30, kind: 'fix', rounds: 1, startedAt: T0 + 30 * MIN, tokens: tokens(50_000) })]
    expect(costLine(rows, 'pip', NOW)).toBe(' Built by pip on `claude-sonnet-5-5`: 42 min, 1.3M tokens, 1 fix round.')
  })

  it('counts only the rows of the pull request\'s own builder, by the server\'s name for each row\'s agent, and never a read', () => {
    const rows = [row({ tokens: tokens(340_400) }), row({ name: 'Oak', tokens: tokens(9_000_000) }), row({ name: null, tokens: tokens(9_000_000) }),
      row({ number: 30, kind: 'read', name: 'Pip', tokens: tokens(9_000_000) }), row({ number: 30, kind: 'fix', name: 'Oak', rounds: 5 })]
    expect(costLine(rows, 'pip', NOW)).toBe(' Built by pip on `claude-sonnet-5-5`: 42 min, 340k tokens, 0 fix rounds.')
    // "Pip Two" is builder:pip-two, as its label and its branch name it.
    expect(costLine([row({ name: 'Pip Two', tokens: tokens(840) })], 'pip-two', NOW)).toBe(' Built by pip-two on `claude-sonnet-5-5`: 42 min, 840 tokens, 0 fix rounds.')
    expect(costLine(rows, 'juno', NOW)).toBe('')
    expect(costLine([], 'pip', NOW)).toBe('')
    expect(costLine([row({ tokens: tokens(0) })], 'pip', NOW)).toBe('')
  })

  it('says a round number of tokens as a person reads one, and at least a minute', () => {
    const said = (n: number) => / (\S+) tokens/.exec(costLine([row({ tokens: tokens(n) })], 'pip', T0))?.[1]
    expect([999, 1_000, 1_499, 1_500, 999_499, 999_500, 1_250_000, 12_340_000].map(said)).toEqual(['999', '1k', '1k', '2k', '999k', '1.0M', '1.3M', '12.3M'])
    expect(costLine([row({})], 'pip', T0 - 5 * MIN)).toContain(': 1 min, ')
  })

  it('counts the minutes from the earliest of its rows, and two rounds as rounds', () => {
    const rows = [row({ number: 30, kind: 'fix', rounds: 2, startedAt: T0 + 30 * MIN }), row({ number: 30, kind: 'fix', rounds: 0, startedAt: T0 + 35 * MIN })]
    expect(costLine(rows, 'pip', NOW)).toBe(' Built by pip on `claude-sonnet-5-5`: 12 min, 2k tokens, 2 fix rounds.')
  })

  // The name is its engine's own text, written by another daemon and posted under this person's login: as code, nothing in it
  // links or tags (anh Dee's call, 12 November).
  it('names the model as its engine names it, as code, and the first of two that used the same', () => {
    for (const model of ['https://example.com/x', 'owner/model', '@someone', 'claude-sonnet-4-5@20250929', 'x'.repeat(120)]) {
      expect(costLine([row({ tokens: tokens(1_000, model) })], 'pip', NOW), model).toBe(` Built by pip on \`${model}\`: 42 min, 1k tokens, 0 fix rounds.`)
    }
    expect(costLine([row({ tokens: [...tokens(500, 'gpt-5.5'), ...tokens(500, 'claude-opus-5-5')] })], 'pip', NOW)).toContain(' on `claude-opus-5-5`: ')
  })
})

describe('the server\'s rows for a landed change', () => {
  it('asks for a pull request and its tasks as the project\'s PM, and reads each row that is counts and ids', async () => {
    const good = { number: 14, kind: 'build', agentId: 'pip', name: 'Pip', tokens: tokens(700), rounds: 0, startedAt: T0, endedAt: T0 + MIN }
    const ask = vi.fn(async (_path: string): Promise<unknown> => ({ rows: [good, { ...good, number: 30, kind: 'fix', name: 7, rounds: 2 },
      { ...good, number: '14' }, { ...good, kind: 'review' }, { ...good, rounds: 1.5 }, { ...good, startedAt: 'today' }, { ...good, endedAt: null },
      { ...good, tokens: [{ model: SONNET, input: 1 }] }, { ...good, tokens: {} }, 'words', null,
      // A model's name no engine gives: one that could end its code in the comment, or one past the server's length.
      ...['a`b @team `c', 'a model', 'x'.repeat(121), ''].map(model => ({ ...good, tokens: tokens(700, model) }))] }))
    const read = readTaskTokens(ask)
    expect(await read({ tabId: 'tab', repo: 'acme/app', pmAgentId: 'juno' }, [30, 14])).toEqual([
      { number: 14, kind: 'build', name: 'Pip', tokens: tokens(700), rounds: 0, startedAt: T0, endedAt: T0 + MIN },
      { number: 30, kind: 'fix', name: null, tokens: tokens(700), rounds: 2, startedAt: T0, endedAt: T0 + MIN }])
    expect(ask.mock.calls).toEqual([['/api/super-tabs/tab/task-tokens?repository=acme%2Fapp&numbers=30,14&asAgentId=juno']])
    ask.mockResolvedValueOnce({ rows: 'none' })
    expect(await read({ tabId: 'tab', repo: 'acme/app', pmAgentId: 'juno' }, [30])).toEqual([])
    ask.mockResolvedValueOnce(null)
    expect(await read({ tabId: 'tab', repo: 'acme/app', pmAgentId: 'juno' }, [30])).toEqual([])
  })
})

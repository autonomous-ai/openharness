import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAppSource, type CodexAppSourceDeps } from './codexAppSource.js'
import type { CodexAppRead, CodexAppThread } from './codexAppThreads.js'
import { observedAgentId } from './observed.js'
import type { RingRank } from './select.js'
import { capsLetters, type HostAgent, type PaneSwitch } from './types.js'

const T = 1_763_000_000_000
const LOG =
  /^\[codex-app\] (watch · (on|none)|listed · \d+ threads · \d+ in projects|read · (\d+ ms · \d+ rows · \d+ skipped|failed))$/
const pad = (n: number) => String(n).padStart(12, '0')
/** The n-th thread: a Codex id, a folder and a name of its own, older as n grows. */
const thread = (n: number, over: Partial<CodexAppThread> = {}): CodexAppThread => ({
  id: `019a0000-0000-7000-8000-${pad(n)}`, cwd: `/work/p${n}`, name: `Task ${n}`, at: T - n * 1000, inProject: false,
  ...over,
})
const agentOf = (one: CodexAppThread) => observedAgentId('codex', one.id)
/** A good read listing `listed` in that order; the sidebar's order is theirs unless given. */
const ok = (listed: CodexAppThread[], over: { order?: CodexAppThread[]; rows?: number; skipped?: number } = {}): CodexAppRead => ({
  ok: true,
  order: (over.order ?? listed).map(({ id }) => id),
  listed,
  rows: over.rows ?? (over.order ?? listed).length,
  skipped: over.skipped ?? 0,
})
const FAILED: CodexAppRead = { ok: false }
/** The rank the sidebar's order gives: each thread's agent at its place. */
const rankOf = (order: CodexAppThread[]): RingRank => new Map(order.map((one, at) => [agentOf(one), at]))
/** Lets what the source was answered be taken in. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

/** Every line any source said, and each read started while another was under way: checked after each test. */
const lines: string[] = []
let overlaps = 0

describe("the ChatGPT app's source (docs/plans/2026-11-19-dial-chatgpt-ring-and-follow-design.md)", () => {
  afterEach(() => {
    const said = lines.splice(0)
    for (const line of said) {
      expect(line).toMatch(LOG)
      for (const word of ['Task', 'Fix the tests', '/work', 'p1', '019a0000']) expect(line).not.toContain(word)
    }
    expect(overlaps).toBe(0)
    overlaps = 0
  })

  /** A source on a reader whose reads the test answers by hand, a watch the test fires, and one fake clock for its
   *  timers and its measures. */
  function setup() {
    const clock = { now: 0 }
    const timers: Array<{ due: number; run: () => void; done: boolean }> = []
    const pending: Array<(read: CodexAppRead) => void> = []
    const calls: string[] = []
    const home = { there: true }
    const watches: Array<{ changed: (file?: string) => void; stopped: boolean }> = []
    const log: string[] = []
    const ranks: Array<RingRank | undefined> = []
    let changes = 0
    const focus = vi.fn(async (_threadId: string, _agentId: string) => true)
    const canShow = vi.fn((_threadId: string) => true)
    const show = vi.fn(async (_threadId: string, _agentId: string): Promise<PaneSwitch> => 'ok')
    /** What a read answers when the test does not say. */
    const answers = { read: ok([thread(1)]) }
    const deps: CodexAppSourceDeps = {
      threads: {
        there: () => {
          calls.push('there')
          return home.there
        },
        read: () => {
          calls.push('read')
          if (pending.length > 0) overlaps++
          return new Promise<CodexAppRead>((resolve) => pending.push(resolve))
        },
        forget: () => { calls.push('forget') },
      },
      watch: (changed) => {
        const one = { changed, stopped: false }
        watches.push(one)
        return () => { one.stopped = true }
      },
      after: (ms, run) => {
        const one = { due: clock.now + ms, run, done: false }
        timers.push(one)
        return () => { one.done = true }
      },
      focus,
      canShow,
      show,
      rank: (rank) => { ranks.push(rank) },
      monotonic: () => clock.now,
      log: (line) => {
        log.push(line)
        lines.push(line)
      },
    }
    const source = new CodexAppSource(deps)
    source.onChange(() => { changes++ })
    return {
      source, home, answers, watches, log, ranks, focus, canShow, show,
      get changes() { return changes },
      /** The reader's calls, in order. */
      calls: () => [...calls],
      reads: () => calls.filter((name) => name === 'read').length,
      /** Answers the read under way. */
      land: async (read: CodexAppRead = answers.read) => {
        pending.shift()!(read)
        await turn()
      },
      /** Moves the clock, firing each timer then due. */
      advance: (ms: number) => {
        clock.now += ms
        for (const one of timers) {
          if (one.done || one.due > clock.now) continue
          one.done = true
          one.run()
        }
      },
      /** The timers neither fired nor cancelled. */
      timing: () => timers.filter(({ done }) => !done).length,
      /** An event of the watch not stopped. */
      fire: (file?: string) => watches.filter(({ stopped }) => !stopped).at(-1)!.changed(file),
    }
  }
  type Setup = ReturnType<typeof setup>

  /** Started, its first read landed and its second passed. */
  async function started(read?: CodexAppRead): Promise<Setup> {
    const s = setup()
    if (read) s.answers.read = read
    s.source.start()
    await s.land()
    s.advance(1_000)
    return s
  }

  /** An event's read, landed with `read`, and its second passed. */
  async function after(s: Setup, read: CodexAppRead, file?: string): Promise<void> {
    s.fire(file)
    await s.land(read)
    s.advance(1_000)
  }

  const ids = (s: Setup) => s.source.list().map(({ id }) => id)

  describe('the row', () => {
    it('each listed thread is an idle resting row under the observed id, with no voice and no send', async () => {
      const one = thread(1, { inProject: true })
      const s = await started(ok([one]))
      expect(s.source.list()).toStrictEqual([{
        id: agentOf(one), engine: 'codex', sessionId: one.id, name: 'Task 1', cwd: '/work/p1', host: 'codex',
        app: 'codex', state: 'idle', unseenDone: false, resting: true, lastActivityAt: T - 1000,
      }])
      expect(s.source.capabilities()).toEqual({ status: true, voice: false, focus: true, answer: false })
      expect(capsLetters(s.source.capabilities())).toBe('sf')
      expect('send' in s.source).toBe(false)
    })

    it('a tap opens the thread through focus; a swipe asks canShow and shows it', async () => {
      const one = thread(1)
      const s = await started(ok([one]))
      const [agent] = s.source.list()
      expect(await s.source.focus(agent!)).toBe(true)
      expect(s.source.hasPane(agent!)).toBe(true)
      expect(await s.source.showPane(agent!)).toBe('ok')
      expect(s.focus.mock.calls).toEqual([[one.id, agentOf(one)]])
      expect(s.canShow.mock.calls).toEqual([[one.id]])
      expect(s.show.mock.calls).toEqual([[one.id, agentOf(one)]])
      const stranger: HostAgent = { ...agent!, id: agentOf(thread(2)) }
      expect(await s.source.focus(stranger)).toBe(false)
      expect(s.source.hasPane(stranger)).toBe(false)
      expect(await s.source.showPane(stranger)).toBe('failed')
      expect(s.focus).toHaveBeenCalledTimes(1)
      expect(s.canShow).toHaveBeenCalledTimes(1)
      expect(s.show).toHaveBeenCalledTimes(1)
    })

    it('paneNames() names each listed thread, renamed false', async () => {
      const s = await started(ok([thread(1), thread(2)], { order: [thread(1), thread(2), thread(3)] }))
      expect(s.source.paneNames()).toEqual(new Map([
        [thread(1).id, { title: 'Task 1', renamed: false }],
        [thread(2).id, { title: 'Task 2', renamed: false }],
      ]))
    })
  })

  describe('an event naming the store, its WAL, the global state, the session index or nothing reads; any other name does nothing', () => {
    it.each(['state_5.sqlite', 'state_5.sqlite-wal', '.codex-global-state.json', 'session_index.jsonl', undefined])(
      'reads: %s',
      async (file) => {
        const s = await started()
        s.fire(file)
        expect(s.reads()).toBe(2)
        await s.land()
      },
    )

    it.each(['state_5.sqlite-shm', 'logs_2.sqlite', 'sessions'])('does nothing: %s', async (file) => {
      const s = await started()
      s.fire(file)
      await turn()
      expect(s.reads()).toBe(1)
      expect(s.timing()).toBe(0)
    })
  })

  it('one read at a time, and changes during it give one more, at least 1 s after its start', async () => {
    const s = setup()
    s.source.start()
    expect(s.reads()).toBe(1)
    s.fire('state_5.sqlite-wal')
    s.fire('state_5.sqlite')
    s.fire(undefined)
    await turn()
    expect(s.reads()).toBe(1)
    await s.land()
    expect(s.reads()).toBe(1)
    s.advance(999)
    expect(s.reads()).toBe(1)
    s.advance(1)
    expect(s.reads()).toBe(2)
    await s.land()
    s.advance(1_000)
    await turn()
    expect(s.reads()).toBe(2)
  })

  it('onChange and the rank only when the list or the order changes; a new time alone changes neither', async () => {
    const [a, b, c] = [thread(1), thread(2), thread(3)]
    const s = await started(ok([a, b], { order: [a, b, c] }))
    expect(s.changes).toBe(1)
    expect(s.ranks).toEqual([rankOf([a, b, c])])
    await after(s, ok([{ ...a, at: T + 5000 }, { ...b, at: T + 6000 }], { order: [a, b, c] }))
    expect(s.changes).toBe(1)
    expect(s.ranks).toHaveLength(1)
    expect(s.source.list().map(({ lastActivityAt }) => lastActivityAt)).toEqual([T + 5000, T + 6000])
    const renamed = { ...a, name: 'Fix the tests' }
    await after(s, ok([renamed, b], { order: [a, b, c] }))
    expect(s.changes).toBe(2)
    expect(s.ranks).toHaveLength(1)
    // A thread outside the 16 moves: the listed rows hold still, the page's order does not.
    await after(s, ok([renamed, b], { order: [a, c, b] }))
    expect(s.changes).toBe(2)
    expect(s.ranks).toEqual([rankOf([a, b, c]), rankOf([a, c, b])])
    expect(s.ranks[1]).not.toBe(s.ranks[0])
  })

  it('a new rank is set before the change is told, so the dial\'s next list has it', async () => {
    const [a, b] = [thread(1), thread(2)]
    const s = setup()
    const ranked: number[] = []
    s.source.onChange(() => { ranked.push(s.ranks.length) })
    s.answers.read = ok([a, b])
    s.source.start()
    await s.land()
    s.advance(1_000)
    await after(s, ok([b, a]))
    expect(ranked).toEqual([1, 2])
  })

  describe('failed reads', () => {
    it('a failed read keeps the last good list and rank, and says read · failed once a run', async () => {
      const [a, b, c] = [thread(1), thread(2), thread(3)]
      const failed = (s: Setup) => s.log.filter((line) => line === '[codex-app] read · failed')
      const s = await started(ok([a, b]))
      await after(s, FAILED)
      // The JSON file the app wrote mid-read: the reader gives it as any other failed read.
      await after(s, FAILED, '.codex-global-state.json')
      expect(failed(s)).toHaveLength(1)
      expect(ids(s)).toEqual([agentOf(a), agentOf(b)])
      expect(s.ranks).toEqual([rankOf([a, b])])
      await after(s, ok([c]))
      await after(s, FAILED)
      expect(failed(s)).toHaveLength(2)
      expect(ids(s)).toEqual([agentOf(c)])
      expect(s.ranks).toEqual([rankOf([a, b]), rankOf([c])])
      expect(s.changes).toBe(2)
    })

    it('read · failed is said again for the first failure after a stop and a start', async () => {
      const s = await started(FAILED)
      s.source.stop()
      s.source.start()
      await s.land(FAILED)
      expect(s.log.filter((line) => line === '[codex-app] read · failed')).toHaveLength(2)
    })

    it('a good read with no projects is taken: its order replaces the last', async () => {
      const p1 = thread(1, { inProject: true })
      const r1 = thread(2)
      const s = await started(ok([p1, r1]))
      await after(s, ok([r1, { ...p1, inProject: false }]))
      expect(s.ranks).toEqual([rankOf([p1, r1]), rankOf([r1, p1])])
      expect(ids(s)).toEqual([agentOf(r1), agentOf(p1)])
      expect(s.log).toContain('[codex-app] listed · 2 threads · 0 in projects')
    })

    it('with no good read yet, nothing is listed and no rank is set', async () => {
      const s = await started(FAILED)
      expect(s.source.list()).toEqual([])
      expect(s.source.paneNames().size).toBe(0)
      expect(s.ranks).toEqual([])
      expect(s.changes).toBe(0)
      expect(s.log).toEqual(['[codex-app] watch · on', '[codex-app] read · failed'])
    })

    it('a listener that throws costs the listeners after it nothing, is no failed read, and throws nothing', async () => {
      const s = setup()
      let heard = 0
      s.source.onChange(() => { throw new Error('broken') })
      s.source.onChange(() => { heard++ })
      s.source.start()
      await s.land()
      expect(heard).toBe(1)
      expect(s.changes).toBe(1)
      expect(s.log).not.toContain('[codex-app] read · failed')
      expect(() => s.source.stop()).not.toThrow()
      expect(heard).toBe(2)
    })
  })

  describe('start and stop', () => {
    it('stop drops the rows (told once), the rank, the watch and the reader\'s memory', async () => {
      const s = await started(ok([thread(1), thread(2)]))
      expect(s.changes).toBe(1)
      s.source.stop()
      expect(s.ranks).toEqual([rankOf([thread(1), thread(2)]), undefined])
      expect(s.watches.map(({ stopped }) => stopped)).toEqual([true])
      expect(s.calls().filter((name) => name === 'forget')).toHaveLength(1)
      expect(s.source.list()).toEqual([])
      expect(s.source.paneNames().size).toBe(0)
      expect(s.changes).toBe(2)
      s.source.stop()
      expect(s.changes).toBe(2)
      expect(s.ranks).toHaveLength(2)
      expect(s.calls().filter((name) => name === 'forget')).toHaveLength(1)
    })

    it('the home\'s wait', async () => {
      const s = setup()
      s.home.there = false
      s.source.start()
      await turn()
      expect(s.log).toEqual(['[codex-app] watch · none'])
      expect(s.watches).toHaveLength(0)
      expect(s.reads()).toBe(0)
      expect(s.timing()).toBe(0)
      s.source.stop()
      s.home.there = true
      s.source.start()
      expect(s.log).toEqual(['[codex-app] watch · none', '[codex-app] watch · on'])
      expect(s.watches).toHaveLength(1)
      expect(s.reads()).toBe(1)
      s.source.start()
      expect(s.watches).toHaveLength(1)
      await s.land()
      s.source.stop()
      s.source.start()
      expect(s.log.filter((line) => line.includes('watch'))).toEqual(['[codex-app] watch · none', '[codex-app] watch · on'])
      expect(s.watches.map(({ stopped }) => stopped)).toEqual([true, false])
      expect(s.reads()).toBe(2)
      await s.land()
    })

    // Review Focus 2: two dials, or a loose cable, while a read is under way.
    it('a read started before a stop takes nothing, and a start meanwhile waits for it', async () => {
      const s = setup()
      s.source.start()
      s.source.stop()
      s.source.start()
      expect(s.reads()).toBe(1)
      await s.land(ok([thread(2)]))
      expect(s.source.list()).toEqual([])
      expect(s.changes).toBe(0)
      expect(s.ranks).toEqual([])
      expect(s.reads()).toBe(2)
      await s.land(ok([thread(1)]))
      expect(ids(s)).toEqual([agentOf(thread(1))])
      expect(s.changes).toBe(1)
      expect(s.ranks).toEqual([rankOf([thread(1)])])
    })
  })

  it('its lines are counts and fixed words', async () => {
    const s = setup()
    s.answers.read = ok([thread(1, { inProject: true }), thread(2), thread(3)], { rows: 5, skipped: 2 })
    s.source.start()
    s.advance(12)
    await s.land()
    s.advance(988)
    // A faster read says nothing, and nor do the same counts.
    s.fire()
    s.advance(5)
    await s.land()
    s.advance(995)
    s.fire()
    s.advance(20)
    await s.land(ok([thread(1, { inProject: true }), thread(2, { inProject: true }), thread(3)]))
    s.source.stop()
    s.source.start()
    await s.land(ok([thread(1, { inProject: true }), thread(2, { inProject: true }), thread(3)]))
    expect(s.log).toEqual([
      '[codex-app] watch · on',
      '[codex-app] read · 12 ms · 5 rows · 2 skipped',
      '[codex-app] listed · 3 threads · 1 in projects',
      '[codex-app] read · 20 ms · 3 rows · 0 skipped',
      '[codex-app] listed · 3 threads · 2 in projects',
      '[codex-app] read · 0 ms · 3 rows · 0 skipped',
      '[codex-app] listed · 3 threads · 2 in projects',
    ])
  })
})

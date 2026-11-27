import { afterEach, describe, expect, it } from 'vitest'
import { AppWake, type WakeTarget } from './appWake.js'
import { claudePaneKey } from './claudeApp.js'
import type { CodexQueueResult } from './codexQueue.js'
import { observedAgentId } from './observed.js'
import { MAX_TEXT } from './orca.js'
import type { HostAgent, PaneSwitch, SendResult } from './types.js'

/** The row spoken to: the app's LOCAL, Claude Code's SESSION. */
const LOCAL = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
const SESSION = '0b7c2f4e-8a1d-4c3b-9e5f-6a7b8c9d0e1f'
const ID = observedAgentId('claude', SESSION)
const TARGET: WakeTarget = { app: 'claude', localId: LOCAL, sessionId: SESSION, agentId: ID, name: 'Fix the build' }
/** Another row of the app's store. */
const LOCAL_SECOND = 'local_aaaaaaaa-0000-4000-8000-000000000002'
const SECOND = 'cccccccc-0000-4000-8000-000000000002'
const SECOND_TARGET: WakeTarget = {
  app: 'claude', localId: LOCAL_SECOND, sessionId: SECOND, agentId: observedAgentId('claude', SECOND), name: 'Ship it',
}
/** A session of another row, and one the app started for LOCAL under another Claude Code id. */
const OTHER = 'cccccccc-0000-4000-8000-000000000003'
const THIRD = 'cccccccc-0000-4000-8000-000000000004'
const WORDS = 'run the tests'
/** The Codex home the ChatGPT wake queues under: the daemon's CODEX_HOME, as devices.ts gives it. */
const CODEX_HOME = '/daemon/codex-home'
const NONE = { change: 0, poll: 0, timers: 0 }
const LOG = /^\[claude-app\] wake · (too long|open failed|timeout|ended|busy|stopped|refused|sent · \d+ ms)$/
const COUNT = /^wake-(too-long|open-failed|timeout|ended|busy|stopped|sent|refused)$/

/** An observed copy of a Claude Code session, under the id the observed source gives it. */
const copy = (sessionId: string, over: Partial<HostAgent> = {}): HostAgent => ({
  id: observedAgentId('claude', sessionId), engine: 'claude', sessionId, name: 'api', host: 'claude', app: 'claude',
  state: 'idle', lastActivityAt: 0, unseenDone: false, ...over,
})
/** Lets what the wake was answered be taken in. */
const turn = () => new Promise((resolve) => setImmediate(resolve))
/** A promise's answer, read without awaiting it. */
function track<T>(promise: Promise<T>): { done: boolean; value?: T } {
  const seen: { done: boolean; value?: T } = { done: false }
  void promise.then((value) => Object.assign(seen, { done: true, value }))
  return seen
}

/** Every line and count any wake said: checked after each test. */
const lines: string[] = []
const counts: string[] = []

interface Timer { ms: number; at: number; run: () => void; cancelled: boolean; fired: boolean }
interface Open { args: [string, string]; resolve(ok: boolean): void; reject(error: Error): void }
/** What the fake mod was handed: the session it went to, and whether a poll was opening as it was. */
interface Delivered { sessionId: string | undefined; text: string; inPoll: boolean }
/** A ChatGPT thread's link, answered by hand. */
interface Link { args: [string, string]; resolve(answer: PaneSwitch): void; reject(error: Error): void }
/** What the fake `codex queue` was handed, answered by hand. */
interface Queued {
  threadId: string; text: string; isApp: boolean; home: string; resolve(result: CodexQueueResult): void; reject(error: Error): void
}

/** A wake on fakes: links the test answers by hand, an observed source listing the test's copies, a mod whose polls
 *  the test opens and which records every delivery, a ChatGPT link and a `codex queue` the test answers by hand, and
 *  one clock for the timers and `monotonic`. */
function setup() {
  let now = 1_000
  let inPoll = false
  let listened = 0
  const timers: Timer[] = []
  const opens: Open[] = []
  const delivered: Delivered[] = []
  const links: Link[] = []
  const queued: Queued[] = []
  const changes = new Set<() => void>()
  const polls = new Set<(sessionId: string) => void>()
  const t = {
    copies: [] as HostAgent[],
    answer: async (): Promise<SendResult> => ({ ok: true }),
    timers,
    opens,
    delivered,
    links,
    queued,
  }
  const wake = new AppWake({
    open: (localId, agentId) => new Promise<boolean>((resolve, reject) => opens.push({ args: [localId, agentId], resolve, reject })),
    observed: {
      list: () => t.copies,
      onChange: (listener) => {
        listened++
        changes.add(listener)
        return () => changes.delete(listener)
      },
      send: (agent, text) => {
        delivered.push({ sessionId: agent.sessionId, text, inPoll })
        return t.answer()
      },
    },
    onPoll: (listener) => {
      listened++
      polls.add(listener)
      return () => polls.delete(listener)
    },
    after: (ms, run) => {
      const timer: Timer = { ms, at: now + ms, run, cancelled: false, fired: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    openThread: (threadId, agentId) =>
      new Promise<PaneSwitch>((resolve, reject) => links.push({ args: [threadId, agentId], resolve, reject })),
    queue: {
      send: (threadId, text, isApp, home) =>
        new Promise<CodexQueueResult>((resolve, reject) => queued.push({ threadId, text, isApp, home, resolve, reject })),
    },
    codexHome: CODEX_HOME,
    monotonic: () => now,
    log: (line) => lines.push(line),
    count: (what) => counts.push(what),
  })
  return Object.assign(t, {
    wake,
    /** The observed source lists these copies now, and tells its listeners. */
    list(...copies: HostAgent[]) {
      t.copies = copies
      for (const listener of [...changes]) listener()
    },
    /** Another listener of the observed source's changes, called before the wake's. */
    hear(listener: () => void) {
      changes.add(listener)
    },
    /** That session's mod opens a poll: the inbox tells its listeners as it holds it. */
    poll(sessionId: string) {
      inPoll = true
      try {
        for (const listener of [...polls]) listener(sessionId)
      } finally {
        inPoll = false
      }
    },
    /** Moves the clock, running each timer whose time came. */
    advance(ms: number) {
      now += ms
      for (const timer of timers) {
        if (!timer.cancelled && !timer.fired && timer.at <= now) {
          timer.fired = true
          timer.run()
        }
      }
    },
    /** The sessions that received words, in order: the eval's hard gate. */
    sessions: () => delivered.map(({ sessionId }) => sessionId),
    /** The ChatGPT threads whose queue received words, in order: the same gate. */
    threads: () => queued.map(({ threadId }) => threadId),
    /** What each `codex queue` was handed. */
    words: () => queued.map(({ threadId, text, isApp, home }) => ({ threadId, text, isApp, home })),
    /** The listeners and timers still held. */
    left: () => ({ change: changes.size, poll: polls.size, timers: timers.filter((x) => !x.cancelled && !x.fired).length }),
    everListened: () => listened > 0,
  })
}

/** What the wakes said, taken from the record the after-each check reads. */
const said = () => ({ lines: [...lines], counts: [...counts] })

describe("the Claude app's wake (docs/plans/2026-11-21-dial-claude-app-wake-send-design.md, § 3)", () => {
  afterEach(() => {
    for (const line of lines.splice(0)) {
      expect(line).toMatch(LOG)
      for (const word of ['Fix the build', 'Ship it', 'api', LOCAL, SESSION, ID, LOCAL_SECOND, SECOND, OTHER, THIRD, WORDS, 'first', 'second']) {
        expect(line).not.toContain(word)
      }
    }
    for (const what of counts.splice(0)) expect(what).toMatch(COUNT)
  })

  it('words over MAX_TEXT are refused before anything opens: no link, no listener, no timer', async () => {
    const t = setup()
    expect(await t.wake.send(TARGET, 'x'.repeat(MAX_TEXT + 1))).toEqual({ ok: false, reason: 'Too long. Say it shorter.' })
    expect(t.opens).toEqual([])
    expect(t.timers).toEqual([])
    expect(t.everListened()).toBe(false)
    expect(t.sessions()).toEqual([])
    expect(said()).toEqual({ lines: ['[claude-app] wake · too long'], counts: ['wake-too-long'] })
    // No wake was marked running: the words at the limit are not refused busy.
    void t.wake.send(TARGET, 'x'.repeat(MAX_TEXT))
    expect(t.opens.map(({ args }) => args)).toEqual([[LOCAL, ID]])
    expect(said().lines).toEqual(['[claude-app] wake · too long'])
  })

  it.each(['the copy, then the poll', 'the poll, then the copy'] as const)(
    'opens once, then delivers to the bound session alone once its copy is live and a poll opened after the open (%s)',
    async (order) => {
      const t = setup()
      const sent = track(t.wake.send(TARGET, WORDS))
      // The bound is set as the words arrive, before the link answered.
      expect(t.timers.map(({ ms }) => ms)).toEqual([30_000])
      expect(t.opens.map(({ args }) => args)).toEqual([[LOCAL, ID]])
      t.opens[0].resolve(true)
      await turn()
      t.advance(1_234)
      if (order === 'the copy, then the poll') {
        t.list(copy(SESSION))
        expect(t.sessions()).toEqual([])
        t.poll(SESSION)
      } else {
        t.poll(SESSION)
        expect(t.sessions()).toEqual([])
        t.list(copy(SESSION))
      }
      // Handed to the very poll that opened when it came last: the inbox's first poll takes them.
      expect(t.delivered).toEqual([{ sessionId: SESSION, text: WORDS, inPoll: order === 'the copy, then the poll' }])
      await turn()
      expect(sent).toEqual({ done: true, value: { ok: true } })
      expect(said()).toEqual({ lines: ['[claude-app] wake · sent · 1234 ms'], counts: ['wake-sent'] })
      expect(t.left()).toEqual(NONE)
      expect(t.opens).toHaveLength(1)
    },
  )

  it('a poll heard while the link still runs counts; the words go once the link answered', async () => {
    const t = setup()
    const sent = track(t.wake.send(TARGET, WORDS))
    t.list(copy(SESSION))
    t.poll(SESSION)
    await turn()
    expect(t.sessions()).toEqual([])
    t.opens[0].resolve(true)
    await turn()
    expect(t.sessions()).toEqual([SESSION])
    expect(sent.value).toEqual({ ok: true })
    t.poll(SESSION)
    t.list(copy(SESSION))
    expect(t.sessions()).toEqual([SESSION])
  })

  describe('stale state is not ready', () => {
    it('a poll of the session from before the open', async () => {
      const t = setup()
      t.poll(SESSION)
      const sent = track(t.wake.send(TARGET, WORDS))
      t.opens[0].resolve(true)
      await turn()
      t.list(copy(SESSION))
      await turn()
      expect(t.sessions()).toEqual([])
      expect(sent.done).toBe(false)
      t.poll(SESSION)
      expect(t.sessions()).toEqual([SESSION])
    })

    it('the ended copy of its last run: not ready, and no `ended` when it is still ended', async () => {
      const t = setup()
      t.list(copy(SESSION, { ended: true }))
      const sent = track(t.wake.send(TARGET, WORDS))
      t.opens[0].resolve(true)
      await turn()
      t.list(copy(SESSION, { ended: true }))
      t.poll(SESSION)
      await turn()
      expect(t.sessions()).toEqual([])
      expect(sent.done).toBe(false)
      t.list(copy(SESSION))
      expect(t.sessions()).toEqual([SESSION])
      await turn()
      expect(sent.value).toEqual({ ok: true })
    })

    it('the ended copy of its last run leaving the list is no `ended`: the bound runs out', async () => {
      const t = setup()
      t.list(copy(SESSION, { ended: true }))
      const sent = track(t.wake.send(TARGET, WORDS))
      t.opens[0].resolve(true)
      await turn()
      t.list()
      await turn()
      expect(sent.done).toBe(false)
      t.advance(30_000)
      await turn()
      expect(sent.value).toEqual({ ok: false, reason: 'Fix the build did not open in Claude. Try again.' })
      expect(said().lines).toEqual(['[claude-app] wake · timeout'])
      expect(t.sessions()).toEqual([])
    })
  })

  it('two quick prompts to one row: the second is refused busy, the first delivered once', async () => {
    const t = setup()
    const first = track(t.wake.send(TARGET, 'first'))
    expect(await t.wake.send(TARGET, 'second')).toEqual({ ok: false, reason: 'Still opening Fix the build. Try again in a moment.' })
    expect(first.done).toBe(false)
    expect(t.opens).toHaveLength(1)
    t.opens[0].resolve(true)
    await turn()
    t.list(copy(SESSION))
    t.poll(SESSION)
    t.poll(SESSION)
    expect(t.delivered).toEqual([{ sessionId: SESSION, text: 'first', inPoll: true }])
    await turn()
    expect(first.value).toEqual({ ok: true })
    expect(said()).toEqual({
      lines: ['[claude-app] wake · busy', '[claude-app] wake · sent · 0 ms'], counts: ['wake-busy', 'wake-sent'],
    })
  })

  it('two prompts to two rows: the second is refused naming the one opening; nothing reaches the second session', async () => {
    const t = setup()
    const first = track(t.wake.send(TARGET, 'first'))
    expect(await t.wake.send(SECOND_TARGET, 'second')).toEqual({
      ok: false, reason: 'Still opening Fix the build. Try again in a moment.',
    })
    expect(t.opens.map(({ args }) => args)).toEqual([[LOCAL, ID]])
    t.opens[0].resolve(true)
    await turn()
    t.list(copy(SECOND))
    t.poll(SECOND)
    expect(t.sessions()).toEqual([])
    t.list(copy(SECOND), copy(SESSION))
    t.poll(SESSION)
    expect(t.delivered).toEqual([{ sessionId: SESSION, text: 'first', inPoll: true }])
    await turn()
    expect(first.value).toEqual({ ok: true })
  })

  it('the person switches rows while it opens: no other session gets the words', async () => {
    const t = setup()
    const sent = track(t.wake.send(TARGET, WORDS))
    t.opens[0].resolve(true)
    await turn()
    // Another row's session comes up and polls.
    t.list(copy(OTHER))
    t.poll(OTHER)
    // The app starts this very row under another Claude Code id: its copy carries the row's pane key.
    const reopened = copy(THIRD, { paneKeys: [claudePaneKey(LOCAL)] })
    t.list(copy(OTHER), reopened)
    t.poll(THIRD)
    // A copy under the row's id that names another session: the id alone does not bind.
    t.list(copy(OTHER), reopened, copy(THIRD, { id: ID }))
    t.poll(THIRD)
    t.poll(SESSION)
    await turn()
    expect(t.sessions()).toEqual([])
    expect(sent.done).toBe(false)
    // The target comes up: its poll was heard above.
    t.list(copy(OTHER), reopened, copy(SESSION))
    expect(t.delivered).toEqual([{ sessionId: SESSION, text: WORDS, inPoll: false }])
    await turn()
    expect(sent.value).toEqual({ ok: true })
  })

  describe('the app quits mid-open', () => {
    it.each(['listed ended', 'gone from the list'] as const)('%s → ended, nothing delivered', async (how) => {
      const t = setup()
      const sent = track(t.wake.send(TARGET, WORDS))
      t.opens[0].resolve(true)
      await turn()
      t.list(copy(SESSION))
      if (how === 'listed ended') t.list(copy(SESSION, { ended: true }))
      else t.list()
      await turn()
      expect(sent.value).toEqual({ ok: false, reason: 'Fix the build closed before it took your words.' })
      expect(said()).toEqual({ lines: ['[claude-app] wake · ended'], counts: ['wake-ended'] })
      expect(t.left()).toEqual(NONE)
      t.list(copy(SESSION))
      t.poll(SESSION)
      expect(t.sessions()).toEqual([])
    })

    it('live as the words came, then ended while the link runs: ended', async () => {
      const t = setup()
      t.list(copy(SESSION))
      const sent = track(t.wake.send(TARGET, WORDS))
      t.list(copy(SESSION, { ended: true }))
      await turn()
      expect(sent.value).toEqual({ ok: false, reason: 'Fix the build closed before it took your words.' })
      expect(t.sessions()).toEqual([])
    })

    it('while the link still runs: ended, and the link\'s late answer does nothing', async () => {
      const t = setup()
      const sent = track(t.wake.send(TARGET, WORDS))
      t.list(copy(SESSION))
      t.poll(SESSION)
      t.list(copy(SESSION, { ended: true }))
      await turn()
      expect(sent.value).toEqual({ ok: false, reason: 'Fix the build closed before it took your words.' })
      t.opens[0].resolve(true)
      await turn()
      t.list(copy(SESSION))
      t.poll(SESSION)
      expect(t.sessions()).toEqual([])
      expect(said().lines).toEqual(['[claude-app] wake · ended'])
      expect(t.left()).toEqual(NONE)
    })
  })

  it('no copy ever (a link that answered true and opened nothing): timeout at 30 s from the words, nothing delivered', async () => {
    const t = setup()
    const sent = track(t.wake.send(TARGET, WORDS))
    // A slow link: the bound runs from the words' arrival, not the link's answer.
    t.advance(10_000)
    t.opens[0].resolve(true)
    await turn()
    t.advance(19_999)
    await turn()
    expect(sent.done).toBe(false)
    t.advance(1)
    await turn()
    expect(sent.value).toEqual({ ok: false, reason: 'Fix the build did not open in Claude. Try again.' })
    expect(said()).toEqual({ lines: ['[claude-app] wake · timeout'], counts: ['wake-timeout'] })
    expect(t.left()).toEqual(NONE)
    t.list(copy(SESSION))
    t.poll(SESSION)
    expect(t.sessions()).toEqual([])
  })

  it('its copy is live but its mod never polls: timeout, nothing delivered', async () => {
    const t = setup()
    const sent = track(t.wake.send(TARGET, WORDS))
    t.opens[0].resolve(true)
    await turn()
    t.list(copy(SESSION))
    t.advance(29_999)
    await turn()
    expect(sent.done).toBe(false)
    t.advance(1)
    await turn()
    expect(sent.value).toEqual({ ok: false, reason: 'Fix the build did not open in Claude. Try again.' })
    expect(t.sessions()).toEqual([])
    expect(t.left()).toEqual(NONE)
  })

  it.each(['answers false', 'rejects'] as const)('the link %s: open failed at once, no wait, no timer left', async (how) => {
    const t = setup()
    const sent = track(t.wake.send(TARGET, WORDS))
    if (how === 'answers false') t.opens[0].resolve(false)
    else t.opens[0].reject(new Error('spawn open ENOENT'))
    await turn()
    expect(sent.value).toEqual({ ok: false, reason: 'Fix the build did not open in Claude.' })
    expect(said()).toEqual({ lines: ['[claude-app] wake · open failed'], counts: ['wake-open-failed'] })
    expect(t.left()).toEqual(NONE)
    t.list(copy(SESSION))
    t.poll(SESSION)
    t.advance(30_000)
    expect(t.sessions()).toEqual([])
    expect(said().lines).toHaveLength(1)
  })

  it('stopped mid-wait: stopped, listeners and timer released; the next words open again', async () => {
    const t = setup()
    t.wake.stop('claude')
    expect(said().lines).toEqual([])
    const first = track(t.wake.send(TARGET, 'first'))
    t.opens[0].resolve(true)
    await turn()
    t.list(copy(SESSION))
    t.wake.stop('claude')
    await turn()
    expect(first.value).toEqual({ ok: false, reason: 'Fix the build did not answer.' })
    expect(said()).toEqual({ lines: ['[claude-app] wake · stopped'], counts: ['wake-stopped'] })
    expect(t.left()).toEqual(NONE)
    t.poll(SESSION)
    expect(t.sessions()).toEqual([])
    // Plugged in again: the next words open the session again, not refused busy.
    const again = track(t.wake.send(TARGET, 'second'))
    expect(t.opens.map(({ args }) => args)).toEqual([[LOCAL, ID], [LOCAL, ID]])
    // Stopped while its link still runs: the link's late failure says nothing more.
    t.wake.stop('claude')
    await turn()
    expect(again.value).toEqual({ ok: false, reason: 'Fix the build did not answer.' })
    t.opens[1].resolve(false)
    await turn()
    t.list(copy(SESSION))
    t.poll(SESSION)
    expect(t.sessions()).toEqual([])
    expect(said().counts).toEqual(['wake-stopped', 'wake-stopped'])
    expect(t.left()).toEqual(NONE)
  })

  it('a listener the observed source still calls after the wake ended delivers nothing', async () => {
    const t = setup()
    // The observed source calls the listeners it had as its change began: here the dial detaches on that change,
    // before the wake's own listener is called.
    t.hear(() => t.wake.stop('claude'))
    const sent = track(t.wake.send(TARGET, WORDS))
    t.opens[0].resolve(true)
    await turn()
    t.poll(SESSION)
    t.list(copy(SESSION))
    await turn()
    expect(sent.value).toEqual({ ok: false, reason: 'Fix the build did not answer.' })
    expect(t.sessions()).toEqual([])
    expect(said().lines).toEqual(['[claude-app] wake · stopped'])
  })

  it('observed.send refused: its own reason', async () => {
    const t = setup()
    t.answer = async () => ({ ok: false, reason: 'api has not taken your last words yet.' })
    const sent = track(t.wake.send(TARGET, WORDS))
    t.opens[0].resolve(true)
    await turn()
    t.list(copy(SESSION))
    t.poll(SESSION)
    await turn()
    expect(sent.value).toEqual({ ok: false, reason: 'api has not taken your last words yet.' })
    expect(said()).toEqual({ lines: ['[claude-app] wake · refused'], counts: ['wake-refused'] })
    expect(t.sessions()).toEqual([SESSION])
  })

  it('observed.send rejected: did not answer', async () => {
    const t = setup()
    t.answer = async () => { throw new Error('socket closed') }
    const sent = track(t.wake.send(TARGET, WORDS))
    t.opens[0].resolve(true)
    await turn()
    t.list(copy(SESSION))
    t.poll(SESSION)
    await turn()
    expect(sent.value).toEqual({ ok: false, reason: 'Fix the build did not answer.' })
    expect(said()).toEqual({ lines: ['[claude-app] wake · refused'], counts: ['wake-refused'] })
    // Over: the next words open again.
    void t.wake.send(TARGET, 'second')
    expect(t.opens).toHaveLength(2)
  })

  it('waitsFor: the session it opens, while the link runs and while it waits; never once its words are handed on, or it ended', async () => {
    const t = setup()
    expect(t.wake.waitsFor(SESSION)).toBe(false)
    const sent = track(t.wake.send(TARGET, WORDS))
    expect(t.wake.waitsFor(SESSION)).toBe(true)
    expect(t.wake.waitsFor(SECOND)).toBe(false)
    t.opens[0].resolve(true)
    await turn()
    t.list(copy(SESSION))
    expect(t.wake.waitsFor(SESSION)).toBe(true)
    // Its own words go through the observed source, which asks as they go: by then it no longer waits.
    let asked: boolean | undefined
    t.answer = async () => { asked = t.wake.waitsFor(SESSION); return { ok: true } }
    t.poll(SESSION)
    expect(asked).toBe(false)
    await turn()
    expect(sent.value).toEqual({ ok: true })
    expect(t.wake.waitsFor(SESSION)).toBe(false)
    const again = track(t.wake.send(TARGET, WORDS))
    t.wake.stop('claude')
    await turn()
    expect(again.value).toEqual({ ok: false, reason: 'Fix the build did not answer.' })
    expect(t.wake.waitsFor(SESSION)).toBe(false)
  })

  it('a prompt while the words are being delivered is still refused busy; a stop then keeps the send\'s answer', async () => {
    const t = setup()
    let answer!: (result: SendResult) => void
    t.answer = () => new Promise((resolve) => { answer = resolve })
    const first = track(t.wake.send(TARGET, 'first'))
    t.opens[0].resolve(true)
    await turn()
    t.list(copy(SESSION))
    t.poll(SESSION)
    expect(t.sessions()).toEqual([SESSION])
    expect(t.left()).toEqual(NONE)
    expect(await t.wake.send(SECOND_TARGET, 'second')).toEqual({
      ok: false, reason: 'Still opening Fix the build. Try again in a moment.',
    })
    t.wake.stop('claude')
    await turn()
    expect(first.done).toBe(false)
    answer({ ok: true })
    await turn()
    expect(first.value).toEqual({ ok: true })
    expect(said().counts).toEqual(['wake-busy', 'wake-sent'])
    expect(t.sessions()).toEqual([SESSION])
    expect(t.opens).toHaveLength(1)
  })
})

/** A ChatGPT app thread spoken to, and another. */
const THREAD = '7d3e9a10-2b4c-4d5e-8f60-1a2b3c4d5e6f'
const CODEX: WakeTarget = { app: 'codex', threadId: THREAD, agentId: observedAgentId('codex', THREAD), name: 'Fix the tests' }
const THREAD_SECOND = 'dddddddd-0000-4000-8000-000000000002'
const CODEX_SECOND: WakeTarget = {
  app: 'codex', threadId: THREAD_SECOND, agentId: observedAgentId('codex', THREAD_SECOND), name: 'Ship the docs',
}
const CODEX_LOG =
  /^\[codex-app\] wake · (too long|open failed|timeout|busy|stopped|refused|pending|queue timeout|queue failed|sent · \d+ ms)$/
const CODEX_COUNT = /^codex-wake-(too-long|open-failed|timeout|busy|stopped|refused|pending|queue-timeout|queue-failed|sent)$/
const BUSY_TESTS = { ok: false, reason: 'Still opening Fix the tests. Try again in a moment.' }

describe("the ChatGPT app's wake (docs/plans/2026-11-23-dial-chatgpt-voice-resting-design.md, § 3)", () => {
  afterEach(() => {
    for (const line of lines.splice(0)) {
      expect([LOG, CODEX_LOG].some((form) => form.test(line)), line).toBe(true)
      for (const word of ['Fix the tests', 'Ship the docs', 'Fix the build', THREAD, CODEX.agentId, THREAD_SECOND,
        CODEX_SECOND.agentId, LOCAL, SESSION, ID, WORDS, 'first', 'second', 'third']) {
        expect(line).not.toContain(word)
      }
    }
    for (const what of counts.splice(0)) expect([COUNT, CODEX_COUNT].some((form) => form.test(what)), what).toBe(true)
  })

  it("the link, then one queue call to the target's thread with the exact words, under the wake's Codex home; its answer is the wake's", async () => {
    const t = setup()
    const sent = track(t.wake.send(CODEX, WORDS))
    expect(t.links.map(({ args }) => args)).toEqual([[THREAD, CODEX.agentId]])
    expect(t.timers.map(({ ms }) => ms)).toEqual([30_000])
    await turn()
    expect(t.threads()).toEqual([])
    t.links[0].resolve('ok')
    await turn()
    expect(t.words()).toEqual([{ threadId: THREAD, text: WORDS, isApp: true, home: CODEX_HOME }])
    t.advance(250)
    t.queued[0].resolve({ outcome: 'queued' })
    await turn()
    expect(sent).toEqual({ done: true, value: { ok: true } })
    expect(said()).toEqual({ lines: ['[codex-app] wake · sent · 250 ms'], counts: ['codex-wake-sent'] })
    expect(t.left()).toEqual(NONE)
    // It waits for no copy and no poll: a thread the app loads fires no hook until a turn runs.
    expect(t.everListened()).toBe(false)
    expect(t.links).toHaveLength(1)
    expect(t.opens).toEqual([])
  })

  it.each(['answers failed', 'rejects'] as const)('a failed link (%s) queues nothing: did not open in ChatGPT', async (how) => {
    const t = setup()
    const sent = track(t.wake.send(CODEX, WORDS))
    if (how === 'answers failed') t.links[0].resolve('failed')
    else t.links[0].reject(new Error('spawn open ENOENT'))
    await turn()
    expect(sent.value).toEqual({ ok: false, reason: 'Fix the tests did not open in ChatGPT.' })
    expect(said()).toEqual({ lines: ['[codex-app] wake · open failed'], counts: ['codex-wake-open-failed'] })
    expect(t.threads()).toEqual([])
    expect(t.wake.waitsFor(THREAD)).toBe(false)
    expect(t.left()).toEqual(NONE)
    t.advance(30_000)
    expect(said().lines).toHaveLength(1)
    // Over: the next words open again.
    void t.wake.send(CODEX, WORDS)
    expect(t.links).toHaveLength(2)
  })

  it('its rest still opening the link (busy) queues nothing', async () => {
    const t = setup()
    const sent = track(t.wake.send(CODEX, WORDS))
    t.links[0].resolve('busy')
    await turn()
    expect(sent.value).toEqual(BUSY_TESTS)
    expect(said()).toEqual({ lines: ['[codex-app] wake · busy'], counts: ['codex-wake-busy'] })
    expect(t.threads()).toEqual([])
    expect(t.wake.waitsFor(THREAD)).toBe(false)
    expect(t.left()).toEqual(NONE)
    void t.wake.send(CODEX, WORDS)
    expect(t.links).toHaveLength(2)
  })

  it('words over MAX_TEXT open nothing', async () => {
    const t = setup()
    expect(await t.wake.send(CODEX, 'x'.repeat(MAX_TEXT + 1))).toEqual({ ok: false, reason: 'Too long. Say it shorter.' })
    expect(t.links).toEqual([])
    expect(t.timers).toEqual([])
    expect(t.threads()).toEqual([])
    expect(said()).toEqual({ lines: ['[codex-app] wake · too long'], counts: ['codex-wake-too-long'] })
  })

  it('one wake at a time across both apps', async () => {
    const t = setup()
    const first = track(t.wake.send(CODEX, 'first'))
    expect(await t.wake.send(CODEX, 'second')).toEqual(BUSY_TESTS)
    expect(await t.wake.send(CODEX_SECOND, 'second')).toEqual(BUSY_TESTS)
    expect(await t.wake.send(TARGET, 'second')).toEqual(BUSY_TESTS)
    expect(said()).toEqual({
      lines: ['[codex-app] wake · busy', '[codex-app] wake · busy', '[claude-app] wake · busy'],
      counts: ['codex-wake-busy', 'codex-wake-busy', 'wake-busy'],
    })
    expect(t.opens).toEqual([])
    t.links[0].resolve('ok')
    await turn()
    // Still under way while its words are being queued.
    expect(await t.wake.send(CODEX_SECOND, 'second')).toEqual(BUSY_TESTS)
    t.queued[0].resolve({ outcome: 'queued' })
    await turn()
    expect(first.value).toEqual({ ok: true })
    // A Claude wake waits: words for a ChatGPT thread are refused naming it.
    const claude = track(t.wake.send(TARGET, 'third'))
    expect(await t.wake.send(CODEX_SECOND, 'second')).toEqual({
      ok: false, reason: 'Still opening Fix the build. Try again in a moment.',
    })
    expect(said().lines.at(-1)).toBe('[codex-app] wake · busy')
    expect(t.links).toHaveLength(1)
    expect(t.threads()).toEqual([THREAD])
    t.wake.stop('claude')
    await turn()
    expect(claude.value).toEqual({ ok: false, reason: 'Fix the build did not answer.' })
  })

  it.each([
    { how: 'stopped', reason: 'Fix the tests did not answer.', word: 'stopped' },
    { how: '30 s', reason: 'Fix the tests did not open in ChatGPT. Try again.', word: 'timeout' },
  ] as const)("$how while the link runs: nothing is queued, the link's late answer neither", async ({ how, reason, word }) => {
    const t = setup()
    const sent = track(t.wake.send(CODEX, WORDS))
    if (how === 'stopped') t.wake.stop('codex')
    else {
      t.advance(29_999)
      await turn()
      expect(sent.done).toBe(false)
      t.advance(1)
    }
    await turn()
    expect(sent.value).toEqual({ ok: false, reason })
    expect(said()).toEqual({ lines: [`[codex-app] wake · ${word}`], counts: [`codex-wake-${word}`] })
    expect(t.left()).toEqual(NONE)
    expect(t.wake.waitsFor(THREAD)).toBe(false)
    t.links[0].resolve('ok')
    await turn()
    expect(t.threads()).toEqual([])
    expect(said().lines).toHaveLength(1)
    void t.wake.send(CODEX, WORDS)
    expect(t.links).toHaveLength(2)
  })

  it('once queueing, stop and the 30 s timer change nothing', async () => {
    const t = setup()
    const sent = track(t.wake.send(CODEX, WORDS))
    t.links[0].resolve('ok')
    await turn()
    expect(t.threads()).toEqual([THREAD])
    // The bound is the link's: cancelled as queueing began, under the queue's own timeout.
    expect(t.left()).toEqual(NONE)
    t.wake.stop('codex')
    t.advance(30_000)
    await turn()
    expect(sent.done).toBe(false)
    t.queued[0].resolve({ outcome: 'queued' })
    await turn()
    expect(sent.value).toEqual({ ok: true })
    expect(said()).toEqual({ lines: ['[codex-app] wake · sent · 30000 ms'], counts: ['codex-wake-sent'] })
  })

  it.each([
    [{ outcome: 'busy' }, 'Fix the tests has not taken your last words yet.', 'pending'],
    [{ outcome: 'timeout' }, 'Fix the tests did not answer.', 'queue timeout'],
    [{ outcome: 'failed', reason: 'refused' }, 'Fix the tests did not answer.', 'refused'],
    [{ outcome: 'failed', reason: 'exit 1', ran: 'app' }, 'Update ChatGPT, then try again.', 'queue failed'],
    [{ outcome: 'failed', reason: 'no binary', ran: 'path' }, 'Update ChatGPT, then try again.', 'queue failed'],
  ] as Array<[CodexQueueResult, string, string]>)('the queue answers %j: %s', async (answer, reason, word) => {
    const t = setup()
    const sent = track(t.wake.send(CODEX, WORDS))
    t.links[0].resolve('ok')
    await turn()
    t.queued[0].resolve(answer)
    await turn()
    expect(sent.value).toEqual({ ok: false, reason })
    expect(said()).toEqual({ lines: [`[codex-app] wake · ${word}`], counts: [`codex-wake-${word.replace(' ', '-')}`] })
    expect(t.left()).toEqual(NONE)
    expect(t.threads()).toEqual([THREAD])
    void t.wake.send(CODEX, WORDS)
    expect(t.links).toHaveLength(2)
  })

  it('a queue send that rejects ends the wake, and the next words open again', async () => {
    const t = setup()
    const sent = track(t.wake.send(CODEX, 'first'))
    t.links[0].resolve('ok')
    await turn()
    t.queued[0].reject(new Error('spawn codex EACCES'))
    await turn()
    expect(sent.value).toEqual({ ok: false, reason: 'Fix the tests did not answer.' })
    expect(said()).toEqual({ lines: ['[codex-app] wake · refused'], counts: ['codex-wake-refused'] })
    const again = track(t.wake.send(CODEX, 'second'))
    expect(t.links).toHaveLength(2)
    t.links[1].resolve('ok')
    await turn()
    t.queued[1].resolve({ outcome: 'queued' })
    await turn()
    expect(again.value).toEqual({ ok: true })
  })

  // A live copy listed while the link runs takes the dial's next words through its own `codex queue`: asked first, they
  // would be queued ahead of these. Once queueing, `codex queue` refuses them itself.
  it('waitsFor is true for its thread alone, and only while the link runs', async () => {
    const t = setup()
    const sent = track(t.wake.send(CODEX, WORDS))
    expect(t.wake.waitsFor(THREAD)).toBe(true)
    expect(t.wake.waitsFor(THREAD_SECOND)).toBe(false)
    expect(t.wake.waitsFor(SESSION)).toBe(false)
    t.links[0].resolve('ok')
    await turn()
    expect(t.threads()).toEqual([THREAD])
    expect(t.wake.waitsFor(THREAD)).toBe(false)
    t.queued[0].resolve({ outcome: 'queued' })
    await turn()
    expect(sent.value).toEqual({ ok: true })
    // Stopped while it links: over, it waits for nothing.
    void t.wake.send(CODEX, WORDS)
    t.wake.stop('codex')
    expect(t.wake.waitsFor(THREAD)).toBe(false)
  })

  it('stop("codex") leaves a Claude wake running, and stop("claude") a ChatGPT one', async () => {
    const t = setup()
    const claude = track(t.wake.send(TARGET, WORDS))
    // The dial reattaches with the ChatGPT app gone, while the link runs and while it waits.
    t.wake.stop('codex')
    t.opens[0].resolve(true)
    await turn()
    t.wake.stop('codex')
    t.list(copy(SESSION))
    t.poll(SESSION)
    await turn()
    expect(claude.value).toEqual({ ok: true })
    expect(t.sessions()).toEqual([SESSION])
    const codex = track(t.wake.send(CODEX, WORDS))
    t.wake.stop('claude')
    t.links[0].resolve('ok')
    await turn()
    expect(t.threads()).toEqual([THREAD])
    t.queued[0].resolve({ outcome: 'queued' })
    await turn()
    expect(codex.value).toEqual({ ok: true })
    expect(said().counts).toEqual(['wake-sent', 'codex-wake-sent'])
  })

  it('words again once the first answered: a second wake links again and queues behind', async () => {
    const t = setup()
    const first = track(t.wake.send(CODEX, 'first'))
    t.links[0].resolve('ok')
    await turn()
    t.queued[0].resolve({ outcome: 'queued' })
    await turn()
    expect(first.value).toEqual({ ok: true })
    const second = track(t.wake.send(CODEX, 'second'))
    expect(t.links.map(({ args }) => args)).toEqual([[THREAD, CODEX.agentId], [THREAD, CODEX.agentId]])
    t.links[1].resolve('ok')
    await turn()
    t.queued[1].resolve({ outcome: 'queued' })
    await turn()
    expect(second.value).toEqual({ ok: true })
    expect(t.threads()).toEqual([THREAD, THREAD])
    expect(t.queued.map(({ text }) => text)).toEqual(['first', 'second'])
    expect(said().counts).toEqual(['codex-wake-sent', 'codex-wake-sent'])
  })
})

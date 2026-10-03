/**
 * The daemons switch (lib/daemonsSwitch.ts, daemons/README.md "Off switches"): every daemon deploy ships
 * dark, and harnessd stays idle — no timers, no journals, no requests beyond one probe — until the
 * account's zoo answers. Driven with fake timers and a fake backend, over simulated hours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DAEMONS_OFF, DAEMONS_PROBE_JITTER_MS, DAEMONS_PROBE_MS, DAEMONS_RETRY_MS, DaemonsSwitch, localKillSwitch, zooPassthrough, type ZooRead,
} from './daemonsSwitch.js'
import { ZooTurnReporter, ZOO_TURN_FLUSH_MS } from './zooTurns.js'
import { ZooLessonReporter } from './zooLessons.js'
import { PairJournal } from '../pair/journal.js'
import { PairSensor } from '../pair/sensor.js'

const HOUR = 60 * 60_000
const zoo = (pair: string | null = 'tim'): ZooRead => ({ status: 200, body: { success: true, data: { revision: 3, zoo: { pair, autonomy: 'watch', consent: { watching: true, at: 1 } } } } })
const NOT_FOUND: ZooRead = { status: 404, body: { message: 'Route GET:/api/zoo not found', error: 'Not Found', statusCode: 404 } }
const DOWN: ZooRead = { status: 502, body: { success: false, error: { code: 'BACKEND_UNREACHABLE' } } }

/** A switch over a fake backend whose answers are queued; the last one repeats. */
function world(opts: { answers?: Array<ZooRead | Error>; signedIn?: boolean; killed?: string | null; random?: number } = {}) {
  const answers = [...(opts.answers ?? [NOT_FOUND])]
  let signedIn = opts.signedIn ?? true
  let killed = opts.killed ?? null
  const read = vi.fn(async (): Promise<ZooRead> => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]!
    if (next instanceof Error) throw next
    return next
  })
  const changes: boolean[] = []
  const reads: number[] = []
  const order: string[] = []
  const log = vi.fn()
  const sw = new DaemonsSwitch({
    read,
    signedIn: () => signedIn,
    killed: () => killed,
    onChange: (on) => { changes.push(on); order.push(`change:${on}`) },
    onRead: (r) => { reads.push(r.status); order.push(`read:${r.status}`) },
    random: () => opts.random ?? 0,
    log,
  })
  return {
    sw, read, changes, reads, order, log,
    answer: (...next: Array<ZooRead | Error>) => { answers.splice(0, answers.length, ...next) },
    signIn: (v: boolean) => { signedIn = v },
    kill: (why: string | null) => { killed = why },
  }
}

beforeEach(() => { vi.useFakeTimers({ now: new Date(2026, 8, 26, 12, 0, 0) }) })
afterEach(() => { vi.useRealTimers() })

describe('off: the server answers 404', () => {
  it('stays completely idle over simulated hours: one probe, no zoo.turn, no lesson credit, no timer but the next probe', async () => {
    const w = world({ answers: [NOT_FOUND] })
    const post = vi.fn(async () => ({ status: 200, body: {} }))
    const turns = new ZooTurnReporter({ post, signedIn: () => true, enabled: () => w.sw.on(), machineId: () => 'm1', log: () => {} })
    const lessons = new ZooLessonReporter({ post, signedIn: () => true, enabled: () => w.sw.on(), log: () => {} })
    w.sw.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.read).toHaveBeenCalledOnce()
    expect(w.sw.on()).toBe(false)
    expect(w.changes).toEqual([])                          // it never came on, so nothing was switched
    // A busy afternoon: a turn every minute, a lesson approved every hour, the link dropping and coming back.
    for (let minute = 0; minute < 5 * 60; minute++) {
      turns.count({ minutes: 3, away: false })
      if (minute % 60 === 0) expect(lessons.credit(`lesson-${minute}`, 'tim')).toBe(false)
      if (minute % 45 === 0) w.sw.connected()
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(post).not.toHaveBeenCalled()                    // not one zoo.turn, not one zoo.lesson
    expect(turns.waiting).toEqual({ counted: 0, pending: 0 })
    expect(lessons.waiting).toBe(0)
    expect(w.read).toHaveBeenCalledOnce()                  // reconnects ask nothing while off
    expect(vi.getTimerCount()).toBe(1)                     // the one timer: the probe six hours out
    await turns.flush()                                    // shutdown's flush sends nothing either
    expect(post).not.toHaveBeenCalled()
  })

  it('asks again at most every six hours, with jitter, and caches every 404', async () => {
    const w = world({ answers: [NOT_FOUND], random: 0.5 })
    w.sw.start()
    await vi.advanceTimersByTimeAsync(0)
    const jitter = Math.floor(0.5 * DAEMONS_PROBE_JITTER_MS)
    await vi.advanceTimersByTimeAsync(DAEMONS_PROBE_MS + jitter - 1)
    expect(w.read).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(w.read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    // A day: at most one probe per 6 h + jitter.
    expect(w.read.mock.calls.length).toBeLessThanOrEqual(2 + Math.floor(24 * HOUR / DAEMONS_PROBE_MS))
    expect(w.sw.on()).toBe(false)
    expect(w.sw.state()).toMatchObject({ on: false, server: 'off', waiting: true })
  })

  it('jitter spreads a fleet: the same 404 at the same moment schedules different probes', async () => {
    const at: number[] = []
    for (const random of [0, 0.5, 0.99]) {
      const setTimer = vi.fn((fn: () => void, ms: number) => { at.push(ms); return 1 })
      const sw = new DaemonsSwitch({ read: async () => NOT_FOUND, signedIn: () => true, killed: () => null, onChange: () => {}, setTimer, clearTimer: () => {}, random: () => random, log: () => {} })
      sw.start()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(new Set(at).size).toBe(3)
    for (const ms of at) {
      expect(ms).toBeGreaterThanOrEqual(DAEMONS_PROBE_MS)
      expect(ms).toBeLessThan(DAEMONS_PROBE_MS + DAEMONS_PROBE_JITTER_MS)
    }
  })

  it('asks at once on zoo_changed, which only a server with the zoo on sends', async () => {
    const w = world({ answers: [NOT_FOUND] })
    w.sw.start()
    await vi.advanceTimersByTimeAsync(0)
    w.answer(zoo())
    w.sw.zooChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.read).toHaveBeenCalledTimes(2)
    expect(w.sw.on()).toBe(true)
    expect(w.changes).toEqual([true])
    expect(vi.getTimerCount()).toBe(0)                     // on: no probe timer; zoo_changed and reconnects keep it fresh
  })

  it('learns from a window\'s own read through the proxy, with no request of its own', async () => {
    const w = world({ answers: [NOT_FOUND] })
    w.sw.start()
    await vi.advanceTimersByTimeAsync(0)
    w.sw.observe({ status: 502, body: {} })                // no news
    expect(w.sw.on()).toBe(false)
    w.sw.observe(zoo())                                    // the flag was turned on since
    expect(w.sw.on()).toBe(true)
    expect(w.reads).toEqual([404, 200])
    w.sw.observe(NOT_FOUND)                                // and off again
    expect(w.sw.on()).toBe(false)
    expect(w.changes).toEqual([true, false])
    expect(w.read).toHaveBeenCalledOnce()
  })

  it('observes nothing before it starts: what it would switch on is not wired yet', () => {
    const w = world()
    w.sw.observe(zoo())
    w.sw.guestConsent(true)
    expect(w.sw.on()).toBe(false)
    expect(w.changes).toEqual([])
  })
})

describe('unknown: the server could not be asked', () => {
  it('stays idle on a 5xx or no answer and asks again later, backing off, until one answers', async () => {
    const w = world({ answers: [DOWN, new Error('socket hang up'), { status: 504, body: {} }, zoo()] })
    w.sw.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.sw.on()).toBe(false)
    expect(w.sw.state().server).toBe('unknown')
    await vi.advanceTimersByTimeAsync(DAEMONS_RETRY_MS - 1)
    expect(w.read).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(w.read).toHaveBeenCalledTimes(2)                // 5 min
    await vi.advanceTimersByTimeAsync(2 * DAEMONS_RETRY_MS)
    expect(w.read).toHaveBeenCalledTimes(3)                // then 10
    expect(w.sw.on()).toBe(false)
    await vi.advanceTimersByTimeAsync(4 * DAEMONS_RETRY_MS)
    expect(w.read).toHaveBeenCalledTimes(4)                // then 20: answered
    expect(w.sw.on()).toBe(true)
    expect(w.changes).toEqual([true])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never backs off past six hours, and a reconnect after a failure asks at once', async () => {
    const w = world({ answers: [DOWN] })
    w.sw.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(48 * HOUR)
    const calls = w.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(DAEMONS_PROBE_MS)
    expect(w.read.mock.calls.length).toBe(calls + 1)       // capped at one every six hours
    w.answer(zoo())
    w.sw.connected()                                       // the backend is reachable again
    await vi.advanceTimersByTimeAsync(0)
    expect(w.sw.on()).toBe(true)
  })

  it('a 5xx after a cached 404 keeps it off and the six-hour cadence', async () => {
    const w = world({ answers: [NOT_FOUND, DOWN] })
    w.sw.start()
    await vi.advanceTimersByTimeAsync(DAEMONS_PROBE_MS)
    expect(w.read).toHaveBeenCalledTimes(2)
    expect(w.sw.state().server).toBe('off')
    await vi.advanceTimersByTimeAsync(DAEMONS_PROBE_MS - 1)
    expect(w.read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(w.read).toHaveBeenCalledTimes(3)
  })

  it('a 401 or 403 waits six hours (a sign-in restarts harnessd anyway)', async () => {
    const w = world({ answers: [{ status: 401, body: {} }] })
    w.sw.start()
    await vi.advanceTimersByTimeAsync(DAEMONS_PROBE_MS - 1)
    expect(w.read).toHaveBeenCalledOnce()
    expect(w.reads).toEqual([401])                         // pairing still hears it: no account zoo
    await vi.advanceTimersByTimeAsync(1)
    expect(w.read).toHaveBeenCalledTimes(2)
  })
})

describe('on: the zoo answers 200 — today\'s behaviour', () => {
  it('hands the zoo over before switching on, so what starts reads the fresh zoo', async () => {
    const w = world({ answers: [zoo()] })
    w.sw.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.order).toEqual(['read:200', 'change:true'])
    expect(w.sw.state()).toMatchObject({ on: true, server: 'on', probes: 1, waiting: false })
  })

  it('re-reads on every reconnect and every zoo_changed, and rides out a blip', async () => {
    const w = world({ answers: [zoo()] })
    w.sw.start()
    await vi.advanceTimersByTimeAsync(0)
    w.sw.connected()
    await vi.advanceTimersByTimeAsync(0)
    w.sw.zooChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.read).toHaveBeenCalledTimes(3)
    w.answer(DOWN)
    w.sw.connected()
    await vi.advanceTimersByTimeAsync(10 * HOUR)
    expect(w.sw.on()).toBe(true)                           // a backend that cannot be reached keeps the last answer
    expect(w.read).toHaveBeenCalledTimes(4)                // and nothing polls it
    expect(w.changes).toEqual([true])
  })

  it('a burst of zoo_changed while a read is out makes one more read, not one each', async () => {
    let release!: (r: ZooRead) => void
    const read = vi.fn(() => new Promise<ZooRead>((resolve) => { release = resolve }))
    const sw = new DaemonsSwitch({ read, signedIn: () => true, killed: () => null, onChange: () => {}, log: () => {} })
    sw.start()
    for (let i = 0; i < 5; i++) sw.zooChanged()
    release(zoo())
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
    release(zoo())
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('goes off when the server says so later: a reconnect\'s 404, or a zoo.turn report\'s', async () => {
    const w = world({ answers: [zoo()] })
    w.sw.start()
    await vi.advanceTimersByTimeAsync(0)
    const post = vi.fn(async () => { const answer = NOT_FOUND; w.sw.observe(answer); return answer })
    const turns = new ZooTurnReporter({ post, signedIn: () => true, enabled: () => w.sw.on(), machineId: () => 'm1', log: () => {} })
    turns.count()
    await vi.advanceTimersByTimeAsync(ZOO_TURN_FLUSH_MS)
    expect(post).toHaveBeenCalledOnce()                    // on: reported as today
    expect(w.sw.on()).toBe(false)                          // and the 404 it got is off
    expect(turns.waiting).toEqual({ counted: 0, pending: 0 })   // dropped, never retried
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(post).toHaveBeenCalledOnce()
    expect(w.changes).toEqual([true, false])
  })
})

describe('signed out', () => {
  it('asks the backend nothing, and is on only while a window says its guest zoo has consent', async () => {
    const w = world({ signedIn: false })
    w.sw.start()
    w.sw.connected()
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(w.read).not.toHaveBeenCalled()
    expect(w.sw.on()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    w.sw.guestConsent(true)
    expect(w.sw.on()).toBe(true)
    w.sw.guestConsent(false)
    expect(w.sw.on()).toBe(false)
    expect(w.changes).toEqual([true, false])
  })

  it('signed in after it started (no restart): the next connect asks once', async () => {
    const w = world({ signedIn: false, answers: [zoo()] })
    w.sw.start()
    w.signIn(true)
    w.sw.connected()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.read).toHaveBeenCalledOnce()
    expect(w.sw.on()).toBe(true)
  })
})

describe('the local kill switch wins', () => {
  it('asks nothing at all and never comes on: not for the server, a window, or a guest', async () => {
    const w = world({ killed: 'HARNESS_DAEMONS=0', answers: [zoo()] })
    w.sw.start()
    w.sw.connected()
    w.sw.zooChanged()
    w.sw.observe(zoo())
    w.sw.guestConsent(true)
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(w.read).not.toHaveBeenCalled()
    expect(w.sw.on()).toBe(false)
    expect(w.changes).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(w.sw.state().killed).toBe('HARNESS_DAEMONS=0')
  })

  it('switches a running daemon off at the next recheck, and back on only when cleared and asked', async () => {
    const w = world({ answers: [zoo()] })
    w.sw.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.sw.on()).toBe(true)
    w.kill('pair.jsonc "daemons": false')
    w.sw.recheck()
    expect(w.sw.on()).toBe(false)
    expect(w.log).toHaveBeenCalledWith('[daemons] off · pair.jsonc "daemons": false')
    w.kill(null)
    w.sw.zooChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.sw.on()).toBe(true)
    expect(w.changes).toEqual([true, false, true])
  })

  it('reads HARNESS_DAEMONS=0 (false, off, no) from the environment', () => {
    const file = join(tmpdir(), 'no-such-pair.jsonc')
    for (const value of ['0', 'false', 'OFF', ' no ']) expect(localKillSwitch({ env: { HARNESS_DAEMONS: value }, file })()).toBe('HARNESS_DAEMONS=0')
    for (const value of [undefined, '', '1', 'true', 'on']) expect(localKillSwitch({ env: { HARNESS_DAEMONS: value }, file })()).toBeNull()
  })

  describe('"daemons": false in pair.jsonc', () => {
    let dir: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'daemons-kill-')) })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('kills with comments and trailing commas, and follows the file as it changes', () => {
      const file = join(dir, 'pair.jsonc')
      const killed = localKillSwitch({ env: {}, file })
      expect(killed()).toBeNull()                          // no file
      writeFileSync(file, '// off for now\n{\n  "daemons": false, // until the launch\n  "model": false,\n}\n')
      expect(killed()).toBe('pair.jsonc "daemons": false')
      writeFileSync(file, '{ "daemons": true }')
      utimesSync(file, new Date(), new Date(Date.now() + 5_000))
      expect(killed()).toBeNull()
      writeFileSync(file, '{ "model": true }   ')
      utimesSync(file, new Date(), new Date(Date.now() + 10_000))
      expect(killed()).toBeNull()                          // absent is not false
      writeFileSync(file, '{ "daemons": false,, oops')
      utimesSync(file, new Date(), new Date(Date.now() + 15_000))
      expect(killed()).toBeNull()                          // unreadable holds no false
    })

    it('the environment wins over the file', () => {
      const file = join(dir, 'pair.jsonc')
      writeFileSync(file, '{ "daemons": true }')
      expect(localKillSwitch({ env: { HARNESS_DAEMONS: '0' }, file })()).toBe('HARNESS_DAEMONS=0')
    })
  })
})

describe('the /api/zoo passthrough for windows', () => {
  it('killed: a 404 DAEMONS_OFF without asking the backend, for reads and ops alike', async () => {
    const proxy = vi.fn(async () => zoo())
    const observe = vi.fn()
    const pass = zooPassthrough({ proxy, killed: () => 'HARNESS_DAEMONS=0', observe })
    for (const answer of [await pass.read(), await pass.ops({ ops: [] })]) {
      expect(answer.status).toBe(404)
      expect((answer.body.error as { code: string }).code).toBe(DAEMONS_OFF)
    }
    expect(proxy).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
  })

  it('otherwise the backend\'s answer verbatim, which the switch observes', async () => {
    const proxy = vi.fn(async (method: string) => method === 'GET' ? NOT_FOUND : zoo())
    const observe = vi.fn()
    const pass = zooPassthrough({ proxy, killed: () => null, observe })
    expect(await pass.read()).toBe(NOT_FOUND)
    const body = { ops: [{ op: 'zoo.habit', key: 'turn' }] }
    expect((await pass.ops(body)).status).toBe(200)
    expect(proxy.mock.calls).toEqual([['GET', '/api/zoo', undefined], ['POST', '/api/zoo/ops', body]])
    expect(observe.mock.calls.map(([r]) => (r as ZooRead).status)).toEqual([404, 200])
  })
})

describe('what stays untouched while off', () => {
  it('the pair journal: no folder and no read until pairing first comes on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemons-journal-'))
    try {
      const journalDir = join(dir, 'pair')
      const journal = new PairJournal({ dir: journalDir })
      const sensor = new PairSensor({ machineId: () => 'm1', journal, describe: () => ({ name: 'api', engine: 'claude' }), home: null })
      sensor.turnStarted('a1')
      sensor.turnEnded('a1')
      sensor.setPair(null)
      expect(existsSync(journalDir)).toBe(false)
      sensor.setPair('tim')
      expect(existsSync(journalDir)).toBe(true)
      sensor.turnStarted('a1')
      expect(journal.since().entries.map((e) => e.kind)).toEqual(['start'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The switch only keeps harnessd idle if cli.ts routes everything daemon-related through it. runForeground is
 * one very long function no unit test drives, so its wiring is asserted on the source, the way
 * startupOrder.spec.ts asserts its declaration order.
 */
describe('cli.ts routes everything daemon-related through the switch', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'cli.ts'), 'utf-8')
  const at = (needle: string): number => {
    const index = source.indexOf(needle)
    expect(index, needle).toBeGreaterThan(-1)
    return index
  }
  /** The body of `onDaemonsChanged = (on) => { … }`, by brace balance. */
  const onChanged = (() => {
    const from = at('onDaemonsChanged = (on) => {')
    let depth = 0
    for (let i = source.indexOf('{', from); i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}' && --depth === 0) return source.slice(from, i + 1)
    }
    return ''
  })()

  it('asks the backend for the zoo in exactly two places: the probe and the reporters\' POST, which it observes', () => {
    expect(source.match(/'\/api\/zoo'/g)).toHaveLength(1)
    expect(source.match(/'\/api\/zoo\/ops'/g)).toHaveLength(1)
    expect(source).toContain("read: () => proxyBackend('GET', '/api/zoo')")
    expect(source).toMatch(/const answer = await proxyBackend\('POST', '\/api\/zoo\/ops', body\)\s+daemons\.observe\(answer\)/)
    expect(source).not.toContain('refreshPairFromZoo')
    // A window's own read goes through the passthrough, killed here or observed.
    expect(source).toContain('onZooRead: () => zooProxy.read()')
    expect(source).toContain('onZooOps: (body) => zooProxy.ops(body)')
  })

  it('arms the pair\'s timers only inside onDaemonsChanged, and starts the switch once all of it is wired', () => {
    // Track the owned registrations, independent of the optional feature guards in their callbacks.
    const timers = [...source.matchAll(/(?:learnTick|pairConfigTick)\s*\?\?=\s*setInterval\([^\n]+/g)]
    expect(timers).toHaveLength(2)
    for (const timer of timers) expect(onChanged).toContain(timer[0])
    expect(onChanged).toContain('clearInterval(learnTick)')
    expect(onChanged).toContain('clearInterval(pairConfigTick)')
    expect(onChanged).toContain('zooTurnReporter.clear()')
    expect(onChanged).toContain('pairHarness.off()')
    expect(onChanged).toContain('if (daemons.on() && codingMemoryPreview()) codingMemory?.start()')
    expect(onChanged).toContain('if (!codingMemoryPreview()) void pairLearner?.tick()')
    expect(onChanged).toContain('codingMemory?.pause()')
    expect(at('daemons.start()')).toBeGreaterThan(at('pairBrain = new PairBrain({'))
    expect(at('daemons.start()')).toBeGreaterThan(at('onDaemonsChanged = (on) => {'))
  })

  it('tells the windows already attached: the switch, pairing and the zoo\'s pair and dial all refresh the brain', () => {
    expect(onChanged).toMatch(/applyPair\(\)\s+pairBrain\?\.refresh\(\)\s+\}$/)
    const pairToggled = source.match(/onPairToggled = \(on\) => \{([\s\S]*?)\n  \}/)?.[1] ?? ''
    expect(pairToggled).toMatch(/if \(on\) questionWatcher\.reset\(\)[\s;]+pairBrain\?\.refresh\(\)/)
    const applyPair = source.match(/const applyPair = \(\)(?:: void)? => \{([\s\S]*?)\n  \}/)?.[1] ?? ''
    expect(applyPair).toMatch(/pairSensor\.setPair\(pairing\.pair, [^\n]+\)[\s\S]*pairBrain\?\.refresh\(\)/)
    expect(applyPair).toContain('refreshPairPackage()')
  })

  it('gates the reporters, turns, lessons, the pair harness, the pair request and every daemon_* frame', () => {
    expect(source.match(/enabled: \(\) => daemons\.on\(\)/g)).toHaveLength(3)
    expect(source).toContain('if (daemons.on()) zooTurnCounter.started(')
    expect(source).toContain('if (learnFrom && daemons.on() && !isTerminalEngine(learnFrom.engine)) {')
    expect(source).toContain('if (!daemons.on()) return null')                                  // lessons in launches
    expect(source).toContain('pairHarnessActivity = (agentId) => { if (daemons.on()) pairHarness.activity(agentId) }')
    expect(source).toContain('backend.daemonsOn = () => daemons.on()')
    expect(source).toContain("if (!daemons.on()) { pairSensor.setPair(null); return }")        // applyPair
    for (const frame of ['daemon_act_result', 'daemon_confirm_result', 'daemon_talk_result']) {
      expect(source).toMatch(new RegExp(`const off = !daemons\\.on\\(\\) \\? DAEMONS_OFF[^\\n]*\\n\\s+if \\(off\\) \\{ reply\\(\\{ type: '${frame}'`))
    }
    expect(source).toContain('onDaemonShown: (connId, payload) => { if (daemons.on()) pairBrain?.onShown(connId, payload) }')
    expect(source).toContain('if (daemons.on()) pairBrain?.onPresence(connId, payload, meta)')
    expect(source).toContain('onBackendConnected = () => { daemons.connected() }')
    expect(source).toContain('backend.onZooChanged = () => daemons.zooChanged()')
  })
})

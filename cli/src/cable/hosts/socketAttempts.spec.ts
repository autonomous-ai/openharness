import { describe, expect, it } from 'vitest'
import { bornAt, SocketAttempts, type SocketAttemptsDeps } from './socketAttempts.js'

/** The wall clock the test starts at. */
const WALL = 1_700_000_000_000
/** The stamp (`<inode>:<ctime in ns>`) of a socket made at that wall clock time. */
const stampAt = (ms: number) => `7:${BigInt(ms) * 1_000_000n}`
/** A socket made an hour before the test: never young. */
const OLD = stampAt(WALL - 3_600_000)
const ANOTHER = stampAt(WALL - 60_000)

/** Attempts on fake deps and no socket: a stamp the test sets, a watch it fires, a timer queue it runs, and two clocks
 *  it sets. What the attempts asked of their source is in `calls`, in order. */
function setup(stamp: string | undefined, over: Partial<SocketAttemptsDeps> = {}) {
  const state = { stamp, wall: WALL, mono: 0 }
  const timers: Array<{ ms: number; run: () => void }> = []
  const watchers = new Set<() => void>()
  const log: string[] = []
  const calls: Array<'open' | 'close' | 'clear'> = []
  const deps: SocketAttemptsDeps = {
    name: 'herdr-app',
    socketStamp: () => state.stamp,
    watch: (changed) => {
      watchers.add(changed)
      return () => { watchers.delete(changed) }
    },
    after: (ms, run) => {
      const timer = { ms, run }
      timers.push(timer)
      return () => {
        const at = timers.indexOf(timer)
        if (at >= 0) timers.splice(at, 1)
      }
    },
    now: () => state.wall,
    monotonic: () => state.mono,
    log: (line) => { log.push(line) },
    open: () => { calls.push('open') },
    close: () => { calls.push('close') },
    clear: () => { calls.push('clear') },
    ...over,
  }
  return {
    attempts: new SocketAttempts(deps), state, timers, watchers, log, calls,
    opens: () => calls.filter((call) => call === 'open').length,
    /** Runs the one timer there is, and gives its wait. */
    run: () => {
      expect(timers).toHaveLength(1)
      const [timer] = timers.splice(0, 1)
      timer.run()
      return timer.ms
    },
    /** A change where the socket lives. */
    fire: () => { for (const changed of [...watchers]) changed() },
  }
}

describe('the attempts on another program\'s socket (docs/plans/2026-11-16-herdr-app-design.md, Q6, Q8)', () => {
  it('its lines start with the name it was given', () => {
    for (const name of ['herdr-app', 'herdr']) {
      const s = setup(undefined, { name })
      s.attempts.start()
      expect(s.log).toEqual([`[${name}] socket · none`])
    }
  })

  it('with no socket it says none once, watches, and opens when a socket appears', () => {
    const s = setup(undefined)
    s.attempts.start()
    expect(s.log).toEqual(['[herdr-app] socket · none'])
    expect(s.watchers.size).toBe(1)
    s.fire()
    expect(s.opens()).toBe(0)
    s.state.stamp = OLD
    s.fire()
    expect(s.opens()).toBe(1)
    expect(s.watchers.size).toBe(0)
    expect(s.timers).toEqual([])
    // Gone before the client looked: the watch again, with no retry and no second none.
    s.state.stamp = undefined
    s.attempts.failed('closed', 'no_socket')
    expect(s.log).toEqual(['[herdr-app] socket · none', '[herdr-app] closed · no_socket'])
    expect(s.timers).toEqual([])
    expect(s.watchers.size).toBe(1)
    s.state.stamp = OLD
    s.fire()
    expect(s.opens()).toBe(2)
  })

  it('a socket made after its look, before its watch started, opens', () => {
    const s = setup(undefined, {
      watch: () => {
        s.state.stamp = OLD
        return () => {}
      },
    })
    s.attempts.start()
    expect(s.opens()).toBe(1)
  })

  it('a refusal with nothing started on that stamp says stale once and no closed line, starts no timer, and opens only for another stamp', () => {
    const s = setup(OLD)
    s.attempts.start()
    expect(s.opens()).toBe(1)
    s.calls.length = 0
    s.attempts.failed('closed', 'refused')
    expect(s.log).toEqual(['[herdr-app] socket · stale'])
    expect(s.calls).toEqual(['close', 'clear'])
    expect(s.timers).toEqual([])
    // A program writing beside its stale socket changes the folder: the same stamp opens nothing.
    s.fire()
    expect(s.opens()).toBe(0)
    s.state.stamp = ANOTHER
    s.fire()
    expect(s.opens()).toBe(1)
    s.attempts.failed('closed', 'refused')
    expect(s.log).toEqual(['[herdr-app] socket · stale'])
    expect(s.timers).toEqual([])
  })

  it('a failure after a start says its line and retries after 1, 2, 4, 8, 16, 32 and 60 s', () => {
    const s = setup(OLD)
    s.attempts.start()
    s.attempts.started()
    expect(s.log).toEqual(['[herdr-app] socket · live'])
    for (const seconds of [1, 2, 4, 8, 16, 32, 60]) {
      s.log.length = 0
      s.attempts.failed('closed', 'ended')
      expect(s.log).toEqual(['[herdr-app] closed · ended', `[herdr-app] retry · ${seconds}`])
      expect(s.run()).toBe(seconds * 1000)
    }
    expect(s.opens()).toBe(8)
    s.log.length = 0
    s.attempts.failed('closed', 'refused')
    expect(s.log).toEqual(['[herdr-app] closed · refused', '[herdr-app] socket · stale'])
    expect(s.timers).toEqual([])
    expect(s.watchers.size).toBe(1)
  })

  it('failed(\'list\', \'bad_answer\') says list · bad_answer; given up on after the last retry, it says no word', () => {
    const s = setup(OLD)
    s.attempts.start()
    s.attempts.started()
    for (const seconds of [1, 2, 4, 8, 16, 32, 60]) {
      s.log.length = 0
      s.attempts.failed('list', 'bad_answer')
      expect(s.log).toEqual(['[herdr-app] list · bad_answer', `[herdr-app] retry · ${seconds}`])
      s.run()
      s.attempts.started()
    }
    s.log.length = 0
    s.attempts.failed('list', 'bad_answer')
    expect(s.log).toEqual(['[herdr-app] list · bad_answer'])
    expect(s.timers).toEqual([])
    expect(s.watchers.size).toBe(1)
  })

  it('the wait goes back to 1 s only after it was listed for 60 s', () => {
    const s = setup(OLD)
    s.attempts.start()
    s.attempts.started()
    s.attempts.failed('closed', 'ended')
    s.run()
    s.attempts.started()
    s.attempts.listed()
    s.state.mono += 59_999
    s.log.length = 0
    s.attempts.failed('closed', 'ended')
    expect(s.log).toEqual(['[herdr-app] closed · ended', '[herdr-app] retry · 2'])
    s.run()
    s.attempts.started()
    s.attempts.listed()
    s.state.mono += 30_000
    // A later list of the same attempt keeps since when it was followed.
    s.attempts.listed()
    s.state.mono += 30_000
    s.log.length = 0
    s.attempts.failed('closed', 'ended')
    expect(s.log).toEqual(['[herdr-app] closed · ended', '[herdr-app] retry · 1'])
  })

  it('a drop keeps what was listed for the first retry; a retry that fails clears it; another stamp clears it before it opens', () => {
    const s = setup(OLD)
    s.attempts.start()
    s.attempts.started()
    s.attempts.listed()
    s.calls.length = 0
    s.attempts.failed('closed', 'ended')
    expect(s.calls).toEqual(['close'])
    s.run()
    expect(s.calls).toEqual(['close', 'open'])
    s.calls.length = 0
    s.attempts.failed('closed', 'ended')
    expect(s.calls).toEqual(['close', 'clear'])
    s.state.stamp = ANOTHER
    s.calls.length = 0
    s.run()
    expect(s.calls).toEqual(['clear', 'open'])
  })

  it('stop cancels its timer and its watch; started again it says no word it said last', () => {
    const s = setup(OLD)
    s.attempts.start()
    s.attempts.started()
    s.attempts.failed('closed', 'ended')
    s.run()
    s.attempts.failed('closed', 'ended')
    expect(s.timers).toHaveLength(1)
    s.attempts.stop()
    expect(s.timers).toEqual([])
    // Its retries are forgotten: the next failure waits 1 s.
    s.attempts.start()
    s.attempts.started()
    s.log.length = 0
    s.attempts.failed('closed', 'ended')
    expect(s.log).toEqual(['[herdr-app] closed · ended', '[herdr-app] retry · 1'])
    s.attempts.stop()
    s.state.stamp = undefined
    s.attempts.start()
    expect(s.watchers.size).toBe(1)
    s.attempts.stop()
    expect(s.watchers.size).toBe(0)
    s.log.length = 0
    s.attempts.start()
    expect(s.log).toEqual([])
    s.attempts.stop()
  })

  it('bornAt reads a stamp\'s ctime in ms, and none of another form', () => {
    expect(bornAt('7:1700000000123456789')).toBe(1_700_000_000_123)
    // As a Number this ctime rounds up to the next ms.
    expect(bornAt('7:1700000000123999999')).toBe(1_700_000_000_123)
    for (const stamp of ['one', '', '7:', ':5', '7:5:5', undefined]) expect(bornAt(stamp)).toBeUndefined()
  })

  it('a refusal on a socket younger than 2 s by now() is tried once after 1 s, then stale', () => {
    const s = setup(stampAt(WALL - 500))
    s.attempts.start()
    s.calls.length = 0
    s.attempts.failed('closed', 'refused')
    expect(s.log).toEqual(['[herdr-app] retry · 1'])
    expect(s.calls).toEqual(['close'])
    expect(s.timers.map(({ ms }) => ms)).toEqual([1000])
    s.run()
    expect(s.calls).toEqual(['close', 'open'])
    s.attempts.failed('closed', 'refused')
    expect(s.log).toEqual(['[herdr-app] retry · 1', '[herdr-app] socket · stale'])
    expect(s.timers).toEqual([])
  })

  it('2 s old, a ctime ahead of now(), or a stamp of no ctime is stale at once', () => {
    for (const stamp of [stampAt(WALL - 2_000), stampAt(WALL + 5_000), 'one']) {
      const s = setup(stamp)
      s.attempts.start()
      s.attempts.failed('closed', 'refused')
      expect(s.log).toEqual(['[herdr-app] socket · stale'])
      expect(s.timers).toEqual([])
    }
  })

  it('a young socket\'s one retry is not one of the 1 … 60 s, and is not given again after stop', () => {
    const s = setup(stampAt(WALL - 500))
    s.attempts.start()
    s.attempts.failed('closed', 'refused')
    s.run()
    s.attempts.started()
    s.attempts.failed('closed', 'ended')
    expect(s.log).toEqual([
      '[herdr-app] retry · 1', '[herdr-app] socket · live', '[herdr-app] closed · ended', '[herdr-app] retry · 1',
    ])
    s.attempts.stop()
    s.attempts.start()
    s.log.length = 0
    s.attempts.failed('closed', 'refused')
    expect(s.log).toEqual(['[herdr-app] socket · stale'])
    expect(s.timers).toEqual([])
  })
})

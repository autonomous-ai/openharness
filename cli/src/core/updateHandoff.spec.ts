import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEARDOWN_DEADLINE_MS, createUpdateHandoff, type HandoffChild, type TeardownStep, type UpdateHandoffDeps } from './updateHandoff.js'

describe('the update handoff', () => {
  afterEach(() => { vi.useRealTimers() })

  const make = (over: Partial<UpdateHandoffDeps> = {}) => {
    const calls: string[] = []
    const tracked: Array<HandoffChild | null> = []
    const handoff = createUpdateHandoff({
      version: '1.0.0', supervised: true,
      exitForUpdate: () => calls.push('exit 75'),
      handOff: async (version, track) => {
        calls.push(`hand off ${version}`)
        track({ pid: 42 })
        tracked.push(handoff.child())
        track(null)
        tracked.push(handoff.child())
      },
      log: (line) => calls.push(line),
      error: (line) => calls.push(line),
      ...over,
    })
    return { handoff, calls, tracked }
  }
  const step = (calls: string[], name: string, release: () => unknown = () => {}): TeardownStep => [name, () => { calls.push(`release ${name}`); return release() }]

  it('under harnessd, releases everything in order and exits for the update, once', async () => {
    const { handoff, calls } = make()
    expect(handoff.restarting()).toBe(false)
    const teardown = [step(calls, 'the registry'), step(calls, 'the backend', () => Promise.resolve())]
    const first = handoff.restartForUpdate('2.0.0', teardown)
    expect(handoff.restarting()).toBe(true)
    await handoff.restartForUpdate('2.0.0', teardown)
    await first
    expect(calls).toEqual([
      '[update] applying 1.0.0 → 2.0.0 — restarting daemon', 'release the registry', 'release the backend',
      '[update] handing 2.0.0 to harnessd', 'exit 75',
    ])
  })

  it('under harnessd, tries every step when one throws, and exits for the update all the same (round 40)', async () => {
    const { handoff, calls } = make()
    await handoff.restartForUpdate('2.0.0', [
      step(calls, 'the timers', () => { throw new Error('a teardown step that throws') }),
      step(calls, 'the hook server', () => Promise.reject('odd')),
      step(calls, 'the backend'),
    ])
    expect(calls).toEqual([
      '[update] applying 1.0.0 → 2.0.0 — restarting daemon',
      'release the timers', '[update] the timers did not let go (a teardown step that throws) — handing over all the same',
      'release the hook server', '[update] the hook server did not let go (odd) — handing over all the same',
      'release the backend', '[update] handing 2.0.0 to harnessd', 'exit 75',
    ])
  })

  it('under harnessd, hands over all the same when a step hangs past the deadline', async () => {
    vi.useFakeTimers()
    const { handoff, calls } = make({ teardownDeadlineMs: 5_000 })
    const done = handoff.restartForUpdate('2.0.0', [step(calls, 'the registry'), step(calls, 'the backend', () => new Promise(() => {}))])
    await vi.advanceTimersByTimeAsync(4_999)
    expect(calls).not.toContain('exit 75')
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(calls.slice(-3)).toEqual([
      '[update] the teardown did not finish within 5000 ms (at the backend) — handing over all the same', '[update] handing 2.0.0 to harnessd', 'exit 75',
    ])
    expect(TEARDOWN_DEADLINE_MS).toBe(15_000)
    const plain = make()
    vi.useRealTimers()
    await plain.handoff.restartForUpdate('2.0.0', [])
    expect(plain.calls.at(-1)).toBe('exit 75')
  })

  it('without a master, releases in order, hands off, and tracks the successor until it is the daemon', async () => {
    const { handoff, calls, tracked } = make({ supervised: false })
    expect(handoff.child()).toBeNull()
    await handoff.restartForUpdate('2.0.0', [step(calls, 'the registry'), step(calls, 'the backend')])
    expect(calls).toEqual(['[update] applying 1.0.0 → 2.0.0 — restarting daemon', 'release the registry', 'release the backend', 'hand off 2.0.0'])
    expect(tracked).toEqual([{ pid: 42 }, null])
  })

  it('without a master, stops at a step that fails, hands nothing over, and lets this core carry on once abandoned', async () => {
    const { handoff, calls } = make({ supervised: false })
    await expect(handoff.restartForUpdate('2.0.0', [step(calls, 'the timers', () => { throw new Error('no') }), step(calls, 'the backend')])).rejects.toThrow('no')
    expect(calls).toEqual(['[update] applying 1.0.0 → 2.0.0 — restarting daemon', 'release the timers'])
    expect(handoff.restarting()).toBe(true)
    handoff.abandon()
    expect(handoff.restarting()).toBe(false)
    expect(handoff.child()).toBeNull()
  })
})

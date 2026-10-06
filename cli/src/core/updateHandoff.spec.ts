import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROBE_ANSWER } from '../harnessd/protocol.js'
import { TEARDOWN_DEADLINE_MS, createUpdateHandoff, probeStagedMaster, probeVerdict, type TeardownStep, type UpdateHandoffDeps } from './updateHandoff.js'

describe('the update handoff', () => {
  afterEach(() => { vi.useRealTimers() })

  const make = (over: Partial<UpdateHandoffDeps> = {}) => {
    const calls: string[] = []
    const handoff = createUpdateHandoff({
      version: '1.0.0', supervised: true,
      exitForUpdate: () => calls.push('exit 75'),
      probeMaster: async () => { calls.push('probe the master'); return null },
      rollBack: () => calls.push('roll back'),
      handOff: () => calls.push('start a master, exit'),
      log: (line) => calls.push(line),
      error: (line) => calls.push(line),
      ...over,
    })
    return { handoff, calls }
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

  it('without a master, gives the machine to a master on the staged build once its master answers, after the same teardown', async () => {
    const { handoff, calls } = make({ supervised: false })
    const done = handoff.restartForUpdate('2.0.0', [step(calls, 'the registry'), step(calls, 'the backend', () => { throw new Error('no') })])
    // Asked before anything is let go: the core serves on meanwhile.
    expect(handoff.restarting()).toBe(false)
    await handoff.restartForUpdate('2.0.0', [])
    await done
    expect(handoff.restarting()).toBe(true)
    expect(calls).toEqual([
      '[update] applying 1.0.0 → 2.0.0 — restarting daemon', 'probe the master', 'release the registry', 'release the backend',
      '[update] the backend did not let go (no) — handing over all the same',
      '[update] handing 2.0.0 to a harnessd master, which judges it — this core is leaving', 'start a master, exit',
    ])
  })

  it('without a master, rolls a build whose master does not answer back, and hands this build to a master of its own', async () => {
    const { handoff, calls } = make({ supervised: false, probeMaster: async () => 'harnessd-probe failed: a bad build' })
    await handoff.restartForUpdate('2.0.0', [step(calls, 'the registry')])
    expect(calls).toEqual([
      '[update] applying 1.0.0 → 2.0.0 — restarting daemon',
      '[update] 2.0.0\'s master did not answer its probe (harnessd-probe failed: a bad build) — rolled back; this build goes on under a master of its own',
      'roll back', 'release the registry',
      '[update] handing 1.0.0 to a harnessd master, which judges it — this core is leaving', 'start a master, exit',
    ])
  })

  it('under harnessd, asks no probe: the master asks its own before it re-executes', async () => {
    const { handoff, calls } = make()
    await handoff.restartForUpdate('2.0.0', [])
    expect(calls).not.toContain('probe the master')
  })
})

describe('the probe of a staged bundle\'s master', () => {
  /** A probe that ends as told, and the deadline it is given. */
  const run = (error: Error | null, stdout: string) => {
    const killed: string[] = []
    return { killed, probe: (done: (error: Error | null, stdout: string) => void) => { queueMicrotask(() => done(error, stdout)); return { kill: () => killed.push('kill') } } }
  }

  it('passes a master that answers, and says why one did not', async () => {
    expect(await probeStagedMaster(run(null, `starting\n${PROBE_ANSWER} · protocol 2 · v2.0.0\n`).probe)).toBeNull()
    expect(await probeStagedMaster(run(new Error('exit 1'), 'harnessd-probe failed: no supervisor\n').probe)).toBe('harnessd-probe failed: no supervisor')
    expect(await probeStagedMaster(run(new Error('Command failed: exit 1'), '').probe)).toBe('Command failed: exit 1')
    // An exit 0 that never says it is a master is no answer: a bundle from before probes prints its usage.
    expect(await probeStagedMaster(run(null, '').probe)).toBe('no answer')
  })

  it('judges a probe\'s end alike, however it was run', () => {
    expect(probeVerdict(null, `${PROBE_ANSWER} · protocol 2`)).toBeNull()
    expect(probeVerdict(undefined, `${PROBE_ANSWER}`)).toBeNull()
    expect(probeVerdict(new Error('exit 1'), `${PROBE_ANSWER}`)).toBe(PROBE_ANSWER)
    expect(probeVerdict(new Error('signal SIGKILL'), '')).toBe('signal SIGKILL')
  })

  it('kills a probe that does not answer within its deadline, counted in running time', async () => {
    let expire = (): void => {}
    const deadline = vi.fn((_ms: number, fire: () => void) => { expire = fire; return () => {} })
    const killed: string[] = []
    const answer = probeStagedMaster(() => ({ kill: () => killed.push('kill') }), 1_000, deadline)
    expect(deadline.mock.calls[0][0]).toBe(1_000)
    expire()
    expect(await answer).toBe('no answer within 1000 ms')
    expect(killed).toEqual(['kill'])
  })
})

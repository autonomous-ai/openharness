import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HELD_MS, MAX_WINDOWS, patientDeadline, patientExec } from './patientExec.js'

const hold = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
const run = patientExec(execFile)
const answer = (file: string, args: string[], timeout: number) =>
  new Promise<{ error: (Error & { killed?: boolean; code?: unknown; signal?: unknown }) | null; stdout: string }>((resolve) => {
    run(file, args, { timeout }, (error, stdout) => resolve({ error, stdout }))
  })

describe('execFile whose timeout a held event loop cannot fool', () => {
  afterEach(() => { vi.useRealTimers() })

  it('reads the answer a child gave while the loop was held, where Node\'s own timeout loses it', async () => {
    // Node's own: held in the check phase past the deadline, the answer is thrown away and the exit
    // reported as a success with nothing in it.
    const lost = new Promise<{ error: Error | null; stdout: string }>((resolve) => {
      execFile('echo', ['still here'], { timeout: 100 }, (error, stdout) => resolve({ error, stdout }))
    })
    setImmediate(() => hold(400))
    expect(await lost).toEqual({ error: null, stdout: '' })

    const kept = answer('echo', ['still here'], 100)
    setImmediate(() => hold(400))
    expect(await kept).toEqual({ error: null, stdout: 'still here\n' })
  })

  it('still times out a child that does not answer, and says so the way Node does', async () => {
    const { error } = await answer('sleep', ['5'], 100)
    expect(error).toMatchObject({ killed: true, code: 'ETIMEDOUT', signal: 'SIGTERM' })
    expect(error!.message).toBe('sleep did not answer within 100 ms')
  })

  it('passes a failure through as it is', async () => {
    const { error } = await answer('false', [], 1_000)
    expect(error).toMatchObject({ code: 1 })
    expect(error).not.toMatchObject({ code: 'ETIMEDOUT' })
  })

  it('arms nothing for a call that answered before it returned, or with no timeout', () => {
    vi.useFakeTimers()
    const done = vi.fn()
    // A test's stand-in that answers at once, and returns no child.
    patientExec((_file: string, _args: string[], _options: object, callback: (...a: unknown[]) => void) => callback(null, 'at once', ''))('x', [], { timeout: 50 }, done)
    expect(done).toHaveBeenCalledWith(null, 'at once', '')
    expect(vi.getTimerCount()).toBe(0)
    patientExec(() => undefined)('x', [], {}, done)
    expect(vi.getTimerCount()).toBe(0)
    // One that calls back with nothing but its error, as some stand-ins do.
    patientExec((_file: string, _args: string[], _options: object, callback: (...a: unknown[]) => void) => callback(null))('x', [], {}, done)
    expect(done).toHaveBeenLastCalledWith(null, '', '')
  })

  it('a stand-in with no child to kill times out without throwing', async () => {
    let callback: ((error: Error | null, stdout: string, stderr: string) => void) | null = null
    const done = vi.fn()
    patientExec((_file: string, _args: string[], _options: object, given: typeof callback) => { callback = given })('x', [], { timeout: 10 }, done)
    await new Promise((resolve) => setTimeout(resolve, 50))
    callback!(new Error('killed'), undefined as never, undefined as never)
    expect(done.mock.calls[0][0]).toMatchObject({ code: 'ETIMEDOUT' })
    expect(done.mock.calls[0].slice(1)).toEqual(['', ''])
  })
})

describe('a deadline that counts only running time', () => {
  afterEach(() => { vi.useRealTimers() })

  it('expires after its time, in the check phase that follows, unless cancelled first', async () => {
    vi.useFakeTimers()
    const expire = vi.fn()
    patientDeadline(100, expire, () => 0)
    vi.advanceTimersByTime(100)
    expect(expire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expire).toHaveBeenCalledTimes(1)

    const cancelled = vi.fn()
    const cancel = patientDeadline(100, cancelled, () => 0)
    vi.advanceTimersByTime(100)
    cancel()
    vi.advanceTimersByTime(1)
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('gives the window again from now when the loop was held past it, a few times at most', () => {
    vi.useFakeTimers()
    const expire = vi.fn()
    // Every timer fires a full hold late by this clock.
    let now = 0
    const clock = () => now
    patientDeadline(100, expire, clock)
    for (let window = 1; window < MAX_WINDOWS; window++) {
      now += 100 + HELD_MS + 1
      vi.advanceTimersByTime(100)
      vi.advanceTimersByTime(1)
      expect(expire).not.toHaveBeenCalled()
    }
    now += 100 + HELD_MS + 1
    vi.advanceTimersByTime(100)
    vi.advanceTimersByTime(1)
    expect(expire).toHaveBeenCalledTimes(1)
  })

  it('reads the monotonic clock by default', () => {
    vi.useFakeTimers()
    const expire = vi.fn()
    patientDeadline(10, expire)
    vi.advanceTimersByTime(11)
    vi.advanceTimersByTime(1)
    expect(expire).toHaveBeenCalledTimes(1)
  })
})

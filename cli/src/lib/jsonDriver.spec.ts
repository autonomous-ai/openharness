import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { watchJsonDriver } from './jsonDriver.js'

describe('watchJsonDriver', () => {
  it('hands over the client\'s lines in order, whether they came before or after the ask', async () => {
    const input = new PassThrough()
    const driver = watchJsonDriver(input, () => true)!
    input.write('early\n')
    await new Promise((r) => setTimeout(r, 5))
    expect(await driver.nextLine()).toBe('early')
    const next = driver.nextLine()
    input.write('yes\n')
    expect(await next).toBe('yes')
  })

  it('knows when the client has gone, and answers nothing after', async () => {
    const input = new PassThrough()
    const driver = watchJsonDriver(input, () => true)!
    const waiting = driver.nextLine()
    let gone = false
    void driver.gone.then(() => { gone = true })
    input.end()
    expect(await waiting).toBeNull()
    await new Promise((r) => setTimeout(r, 5))
    expect(gone).toBe(true)
    expect(await driver.nextLine()).toBeNull()
  })

  it('keeps the process alive only while it waits for an answer', async () => {
    // A finished sign-in must exit on its own with the app's pipe still open; one waiting for "yes"
    // must not exit under the app. So stdin is unref'd from the start, ref'd for the wait, and
    // unref'd again once the answer is in.
    const input = Object.assign(new PassThrough(), { ref: vi.fn(), unref: vi.fn() })
    const driver = watchJsonDriver(input, () => true)!
    expect(input.unref).toHaveBeenCalledTimes(1)
    expect(input.ref).not.toHaveBeenCalled()
    const answer = driver.nextLine()
    expect(input.ref).toHaveBeenCalledTimes(1)
    input.write('yes\n')
    expect(await answer).toBe('yes')
    expect(input.unref).toHaveBeenCalledTimes(2)
  })

  it('does not hold the process for an answer that is already in', async () => {
    const input = Object.assign(new PassThrough(), { ref: vi.fn(), unref: vi.fn() })
    const driver = watchJsonDriver(input, () => true)!
    input.write('yes\n')
    await new Promise((r) => setTimeout(r, 5))
    expect(await driver.nextLine()).toBe('yes')
    expect(input.ref).not.toHaveBeenCalled()
    expect(input.unref).toHaveBeenCalledTimes(1)
  })

  it('watches nothing when stdin is not a pipe (a script with < /dev/null)', () => {
    expect(watchJsonDriver(new PassThrough(), () => false)).toBeNull()
  })
})

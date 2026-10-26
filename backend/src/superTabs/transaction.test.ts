import { describe, expect, it, vi } from 'vitest'
import { transaction } from './store.js'
import { SuperTabError } from './model.js'

const conflict = () => Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' })

/** A database whose transaction fails with each of `failures` in turn, then runs the body. */
function flaky(...failures: unknown[]) {
  const $transaction = vi.fn(async (body: (tx: never) => Promise<unknown>, _options?: unknown) => {
    const failure = failures.shift()
    if (failure) throw failure
    return body({} as never)
  })
  return { $transaction } as never as { $transaction: typeof $transaction }
}

describe('Swarm transactions', () => {
  it('waits and retries a write conflict until the body gets in, with the longer timeout', async () => {
    const db = flaky(conflict(), conflict(), conflict())
    const waits: number[] = []
    expect(await transaction(db as never, async () => 'done', async ms => { waits.push(ms) })).toBe('done')
    expect(db.$transaction).toHaveBeenCalledTimes(4)
    expect(db.$transaction.mock.calls[0][1]).toEqual({ maxWait: 5_000, timeout: 15_000 })
    // Jittered under a cap that doubles: 50, 100, 200 ms.
    waits.forEach((ms, i) => { expect(ms).toBeGreaterThanOrEqual(0); expect(ms).toBeLessThanOrEqual(50 * 2 ** i) })
  })

  it('retries Mongo transient errors such as a lock wait', async () => {
    const lock = new Error('Error code 24 (LockTimeout): Unable to acquire IX lock, labels: {"TransientTransactionError"}')
    const db = flaky(lock)
    expect(await transaction(db as never, async () => 1, async () => {})).toBe(1)
  })

  it('never waits longer than the cap, and says the Swarm is busy once the attempts run out', async () => {
    const db = flaky(...Array.from({ length: 8 }, conflict))
    const waits: number[] = []
    const failure = await transaction(db as never, async () => 1, async ms => { waits.push(ms) }).catch(error => error)
    expect(failure).toBeInstanceOf(SuperTabError)
    expect(failure).toMatchObject({ code: 'SWARM_BUSY', status: 503 })
    expect(db.$transaction).toHaveBeenCalledTimes(8)
    expect(waits).toHaveLength(7)
    expect(Math.max(...waits)).toBeLessThanOrEqual(1_500)
  })

  it('rethrows a unique key still taken after every attempt, and anything else at once', async () => {
    const taken = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    const duplicate = flaky(...Array.from({ length: 8 }, taken))
    await expect(transaction(duplicate as never, async () => 1, async () => {})).rejects.toMatchObject({ code: 'P2002' })
    const other = flaky(new Error('boom'))
    await expect(transaction(other as never, async () => 1, async () => {})).rejects.toThrow('boom')
    expect(other.$transaction).toHaveBeenCalledTimes(1)
  })
})

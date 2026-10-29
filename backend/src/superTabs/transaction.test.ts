import { describe, expect, it, vi } from 'vitest'
import { afterCommit, transaction } from './store.js'
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

  it('tries an expired or unstartable transaction once more, then says the Swarm is busy', async () => {
    // 2026-10-28 prod: host changes reads expired after 15.4 s. Running a body that slow eight times would hold a
    // request for two minutes and add the load that made it slow; one more try, then the client retries later.
    const expired = () => Object.assign(new Error('Transaction API error: Transaction already closed'), { code: 'P2028' })
    const once = flaky(expired())
    expect(await transaction(once as never, async () => 'done', async () => {})).toBe('done')
    expect(once.$transaction).toHaveBeenCalledTimes(2)
    const twice = flaky(expired(), expired(), expired())
    await expect(transaction(twice as never, async () => 1, async () => {})).rejects.toMatchObject({ code: 'SWARM_BUSY', status: 503 })
    expect(twice.$transaction).toHaveBeenCalledTimes(2)
  })

  it('rethrows a unique key still taken after every attempt, and anything else at once', async () => {
    const taken = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    const duplicate = flaky(...Array.from({ length: 8 }, taken))
    await expect(transaction(duplicate as never, async () => 1, async () => {})).rejects.toMatchObject({ code: 'P2002' })
    const other = flaky(new Error('boom'))
    await expect(transaction(other as never, async () => 1, async () => {})).rejects.toThrow('boom')
    expect(other.$transaction).toHaveBeenCalledTimes(1)
  })

  it('retries a transient unique key conflict and returns the successful attempt', async () => {
    const db = flaky(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))
    expect(await transaction(db as never, async () => 'committed', async () => {})).toBe('committed')
    expect(db.$transaction).toHaveBeenCalledTimes(2)
  })
})

/** A database whose commit fails with each of `failures` in turn, after the body has run, as a write conflict at commit does. */
function failingCommit(...failures: unknown[]) {
  const $transaction = vi.fn(async (body: (tx: never) => Promise<unknown>) => {
    const result = await body({} as never)
    const failure = failures.shift()
    if (failure) throw failure
    return result
  })
  return { $transaction } as never as { $transaction: typeof $transaction }
}

// Shared by the Swarm cache's stamp (Stability 2.2) and the delivery push (Stability 2.4): what others hear of a write must
// follow its commit, or a reader could be told of a change it cannot see yet, or of one that was rolled back.
describe('work after a Swarm transaction commits', () => {
  it('runs the committed attempt\'s callbacks once, in order, only after the body is done', async () => {
    const db = failingCommit()
    const ran: string[] = []
    await transaction(db as never, async tx => {
      afterCommit(tx, () => ran.push('first'))
      afterCommit(tx, () => ran.push('second'))
      ran.push('body')
    })
    expect(ran).toEqual(['body', 'first', 'second'])
  })

  it('drops the callbacks of an attempt whose commit failed, and runs only the one that committed', async () => {
    const db = failingCommit(conflict(), conflict())
    let attempt = 0
    const ran: number[] = []
    await transaction(db as never, async tx => { const mine = ++attempt; afterCommit(tx, () => ran.push(mine)) }, async () => {})
    expect(db.$transaction).toHaveBeenCalledTimes(3)
    expect(ran).toEqual([3])
  })

  it('runs nothing when the transaction fails for good', async () => {
    const ran = vi.fn()
    const rolledBack = failingCommit(new Error('boom'))
    await expect(transaction(rolledBack as never, async tx => { afterCommit(tx, ran) })).rejects.toThrow('boom')
    const refused = failingCommit()
    await expect(transaction(refused as never, async tx => { afterCommit(tx, ran); throw new SuperTabError('FORBIDDEN', 'No.', 403) }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(ran).not.toHaveBeenCalled()
  })

  it('never fails a committed write for a callback that throws, and still runs the rest', async () => {
    const db = failingCommit()
    const later = vi.fn()
    expect(await transaction(db as never, async tx => {
      afterCommit(tx, () => { throw new Error('Redis is down') })
      afterCommit(tx, later)
      return 'saved'
    })).toBe('saved')
    expect(later).toHaveBeenCalledTimes(1)
  })

  it('refuses a callback for a client no Swarm transaction opened, so it is never silently lost', () => {
    expect(() => afterCommit({} as never, () => {})).toThrow(/Swarm transaction/)
  })
})

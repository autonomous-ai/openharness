import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { transaction } from '../../src/superTabs/store.js'
import { AttemptCounter } from './attempts.js'

const conflict = () => Object.assign(new Error('Transaction failed due to a write conflict'), { code: 'P2034' })
const transient = () => new Error('Error code 251 TransientTransactionError: lock wait')

/** A client whose transactions fail with [failures] in turn, then run the body. Stands in for Mongo's conflicts. */
function flaky(failures: Array<() => Error>) {
  let call = 0
  return {
    calls: () => call,
    db: {
      superTab: { label: 'delegate' },
      async $transaction<T>(body: (tx: unknown) => Promise<T>) {
        const failure = failures[call++]
        if (failure) throw failure()
        return body({})
      },
    },
  }
}
const instant = async () => {}

describe('AttemptCounter', () => {
  it('records each retried attempt of the store transaction, by error code, for the call that made it', async () => {
    const counter = new AttemptCounter(), source = flaky([conflict, transient, conflict])
    const db = counter.wrap(source.db)
    const tracked = await counter.track(() => transaction(db as unknown as PrismaClient, async () => 'written', instant))
    expect(tracked).toMatchObject({ value: 'written', failedAttempts: ['P2034', 'TRANSIENT', 'P2034'] })
    expect(source.calls()).toBe(4)
    expect(tracked.ms).toBeGreaterThanOrEqual(0)
  })

  it('records every attempt when the store gives up and says the Swarm is busy', async () => {
    const counter = new AttemptCounter(), db = counter.wrap(flaky(Array(8).fill(conflict)).db)
    const tracked = await counter.track(() => transaction(db as unknown as PrismaClient, async () => 'never', instant))
    expect(tracked.value).toBeUndefined()
    expect((tracked.error as { code?: string }).code).toBe('SWARM_BUSY')
    expect(tracked.failedAttempts).toEqual(Array(8).fill('P2034'))
  })

  it('does not count a refusal from inside the transaction as a conflict', async () => {
    const counter = new AttemptCounter(), db = counter.wrap(flaky([]).db)
    const refusal = Object.assign(new Error('Not yours'), { code: 'FORBIDDEN' })
    const tracked = await counter.track(() => transaction(db as unknown as PrismaClient, async () => { throw refusal }, instant))
    expect(tracked).toMatchObject({ error: refusal, failedAttempts: [] })
  })

  it('keeps concurrent calls apart', async () => {
    const counter = new AttemptCounter(), db = counter.wrap(flaky([conflict]).db)
    const [first, second] = await Promise.all([
      counter.track(() => transaction(db as unknown as PrismaClient, async () => 1, instant)),
      counter.track(async () => { await new Promise(resolve => setTimeout(resolve, 5)); return transaction(db as unknown as PrismaClient, async () => 2, instant) }),
    ])
    expect(first.failedAttempts).toEqual(['P2034'])
    expect(second.failedAttempts).toEqual([])
  })

  it('passes every other client property through', () => {
    const counter = new AttemptCounter(), db = counter.wrap(flaky([]).db)
    expect(db.superTab).toEqual({ label: 'delegate' })
  })
})

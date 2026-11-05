import { describe, expect, it, vi } from 'vitest'
import { RECEIPT_SWEEP, sweepOldReceipts } from './productUsageReceiptSweep.js'

/** A database holding [left] old receipts: a find answers up to its limit of them, a delete removes the ids it names. Every
 *  delete is recorded with when it was sent. */
function receipts(left: number) {
  const deletes: Array<{ ids: number; at: number }> = []
  let next = 0
  const db = { $runCommandRaw: vi.fn(async (command: Record<string, unknown>) => {
    if ('find' in command) {
      const take = Math.min(Number(command.limit), left)
      return { cursor: { firstBatch: Array.from({ length: take }, () => ({ _id: `r${next++}`, expiresAt: { $date: '2026-12-01T00:00:00.000Z' } })) } }
    }
    const ids = ((command.deletes as Array<{ q: { _id: { $in: string[] } } }>)[0]).q._id.$in
    deletes.push({ ids: ids.length, at: performance.now() })
    left -= ids.length
    return { n: ids.length }
  }) }
  return { db: db as never, deletes }
}

describe('the receipt sweep\'s pass (#3146: 112 deletes of 500 took 94 s of the primary in an hour, the longest 5.8 s)', () => {
  it('deletes at most 50 receipts at a time', async () => {
    const { db, deletes } = receipts(10_000)
    await sweepOldReceipts(db, new Date('2026-11-05T00:00:00Z'), { ...RECEIPT_SWEEP, pauseMs: 0, withoutRule: true })
    expect(deletes.length).toBeGreaterThan(1)
    expect(Math.max(...deletes.map(d => d.ids))).toBeLessThanOrEqual(50)
  })

  it('still removes 500 a pass, about 1,000 a minute, so the old receipts are gone as soon as before', async () => {
    const { db } = receipts(10_000)
    const pass = await sweepOldReceipts(db, new Date('2026-11-05T00:00:00Z'), { ...RECEIPT_SWEEP, pauseMs: 0, withoutRule: true })
    expect(pass.removed).toBe(500)
    expect(RECEIPT_SWEEP.chunk * RECEIPT_SWEEP.chunks * 60_000 / RECEIPT_SWEEP.everyMs).toBe(1_000)
  })

  it('waits between its deletes, and its waits end well inside the 30 s until the next pass', async () => {
    expect(RECEIPT_SWEEP.pauseMs).toBeGreaterThan(0)
    expect((RECEIPT_SWEEP.chunks - 1) * RECEIPT_SWEEP.pauseMs).toBeLessThanOrEqual(RECEIPT_SWEEP.everyMs * 0.6)
    const { db, deletes } = receipts(10_000)
    await sweepOldReceipts(db, new Date('2026-11-05T00:00:00Z'), { ...RECEIPT_SWEEP, pauseMs: 20, withoutRule: true })
    const gaps = deletes.slice(1).map((d, i) => d.at - deletes[i]!.at)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(19)
  })
})

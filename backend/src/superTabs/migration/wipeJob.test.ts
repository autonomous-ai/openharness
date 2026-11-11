import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { SuperTabError } from '../model.js'

const purged: string[] = []
const purgeRecords = vi.fn(async (_db: unknown, tabId: string) => { purged.push(tabId); return 'purged' as 'purged' | 'waiting' })
vi.mock('../purge.js', () => ({ purgeRecords: (...args: [unknown, string]) => purgeRecords(...args), purgeFiles: () => null }))
const { beforeCutoff, MAX_RETRY_MS, PAGE, PASS_MS, PAUSE_MS, retryIn, startSwarmWipe, WIPE_CUTOFF, wipeOnce } = await import('./wipeJob.js')

type Row = { _id: string; createdAt?: { $date: string }; deletedAt?: { $date: string } | null; purgeAt?: { $date: string } | null; machineIds?: string[]; format?: number }
const at = (time: number) => ({ $date: new Date(time).toISOString() })
const DAY = 24 * 60 * 60 * 1000
const NOW = WIPE_CUTOFF + DAY

type Update = { q: { _id: string; format: { $ne: number }; deletedAt: null }; u: { $set: { deletedAt: { $date: string }; purgeAt: { $date: string }; memberIds: []; invitedEmails: [] } } }
/** Swarm rows by id, as the job pages them: those after the cursor, in order, at most `$limit`. A single-row Swarm's retirement
 *  ([updates]) sets its deletion on the row it still matches. */
function database(rows: Row[]) {
  const reads: number[] = [], updates: Update[] = []
  const db = { superTab: { aggregateRaw: async ({ pipeline }: { pipeline: Array<{ $match?: { _id: { $gt: string } }; $limit?: number }> }) => {
    const after = pipeline.find(s => s.$match)?.$match?._id.$gt
    const page = rows.filter(r => !after || r._id > after).slice(0, pipeline.find(s => s.$limit)!.$limit!)
    reads.push(page.length)
    return page
  } }, $runCommandRaw: async ({ update, updates: [one] }: { update: string; updates: [Update] }) => {
    expect(update).toBe('SuperTab')
    updates.push(one)
    const index = rows.findIndex(r => r._id === one.q._id && r.format !== one.q.format.$ne && !r.deletedAt)
    if (index >= 0) rows[index] = { ...rows[index]!, ...one.u.$set }
    return { ok: 1, n: index >= 0 ? 1 : 0, nModified: index >= 0 ? 1 : 0 }
  } } as unknown as PrismaClient
  return { db, reads, updates }
}
const old = (id: string, more: Partial<Row> = {}): Row => ({ _id: id, createdAt: at(WIPE_CUTOFF - DAY), deletedAt: null, purgeAt: null, machineIds: [], format: 2, ...more })
const deleted = (id: string, more: Partial<Row> = {}) => old(id, { deletedAt: at(NOW - DAY), purgeAt: at(NOW + 6 * DAY), ...more })

afterEach(() => {
  purged.length = 0
  purgeRecords.mockClear()
  vi.useRealTimers()
})

describe('which Swarms the wipe removes', () => {
  it('is every one created before the cut-off, and one whose row never had the field', () => {
    expect(beforeCutoff(WIPE_CUTOFF - 1)).toBe(true)
    expect(beforeCutoff(null)).toBe(true)
    expect(beforeCutoff(Number.NaN)).toBe(true)
    expect(beforeCutoff(WIPE_CUTOFF)).toBe(false)
    expect(beforeCutoff(WIPE_CUTOFF + DAY)).toBe(false)
  })
})

describe('one pass of the wipe', () => {
  it('walks every Swarm a page at a time: deletes the live old ones, purges the deleted old ones no host waits on, keeps the new ones', async () => {
    const live = Array.from({ length: PAGE + 1 }, (_, i) => old(`a-${String(i).padStart(4, '0')}`))
    const rows = [...live,
      deleted('b-done'),
      // A host has not closed its sessions yet, within its 7 days.
      deleted('b-hosts', { machineIds: ['m'] }),
      // Its 7 days are over: it goes whatever its hosts did.
      deleted('b-late', { machineIds: ['m'], purgeAt: at(NOW - 1) }),
      // No date, and still in a single row: due for the purge at once, never split.
      { _id: 'c-no-date', deletedAt: null, machineIds: ['m'] },
      { _id: 'd-new', createdAt: at(WIPE_CUTOFF), deletedAt: null, machineIds: ['m'] },
      { _id: 'd-new-deleted', createdAt: at(WIPE_CUTOFF + 1), deletedAt: at(NOW), purgeAt: at(NOW - 1), machineIds: [] },
    ].sort((x, y) => x._id < y._id ? -1 : 1)
    const { db, reads, updates } = database(rows)
    const wiped: string[] = []
    let pauses = 0
    const pass = await wipeOnce(db, { wipeSwarm: async id => { wiped.push(id); return id === 'a-0001' ? 'gone' : 'deleted' } }, null,
      { now: () => NOW, pause: async () => { pauses++ } })
    expect(wiped).toEqual(live.map(r => r._id))
    expect(updates).toEqual([{ q: { _id: 'c-no-date', format: { $ne: 2 }, deletedAt: null }, u: { $set: { deletedAt: at(NOW), purgeAt: at(NOW), memberIds: [], invitedEmails: [] } } }])
    expect(purged).toEqual(['b-done', 'b-late'])
    // The purge keeps the row only while it is still the deletion this pass read.
    expect(purgeRecords.mock.calls.map(c => (c as unknown[])[2])).toEqual([new Date(NOW + 6 * DAY), new Date(NOW - 1)])
    expect(pass).toEqual({ deleted: PAGE + 1, purged: 2, left: PAGE + 3, hosts: 1, files: 0, failed: 0, codes: {} })
    expect(pauses).toBe(PAGE + 4)
    expect(reads).toEqual([PAGE, rows.length - PAGE])
  })

  it('counts a Swarm that failed by its code, goes on with the rest, and is not done', async () => {
    const { db } = database([old('a'), old('b'), deleted('c')])
    purgeRecords.mockImplementationOnce(async () => { throw Object.assign(new Error('down'), { name: 'MongoNetworkError' }) })
    const wiped: string[] = []
    const pass = await wipeOnce(db, { wipeSwarm: async id => {
      wiped.push(id)
      if (id === 'a') throw new SuperTabError('STARTS_PENDING', 'An agent is starting in this Swarm.')
      return 'deleted'
    } }, null, { now: () => NOW })
    expect(pass).toEqual({ deleted: 1, purged: 0, left: 3, hosts: 0, files: 0, failed: 2, codes: { STARTS_PENDING: 1, MongoNetworkError: 1 } })
    expect(wiped).toEqual(['a', 'b'])
  })

  it('purges a Swarm still in a single row on the next pass, never split nor its hosts asked, and two runners delete it once', async () => {
    const { db, updates } = database([old('a', { format: 1, machineIds: ['m'] })])
    const store = { wipeSwarm: vi.fn(async () => 'deleted' as const) }
    // Both read it live; the second's write matches nothing any more.
    const runs = await Promise.all([wipeOnce(db, store, null, { now: () => NOW }), wipeOnce(db, store, null, { now: () => NOW })])
    expect(runs.map(run => run.deleted)).toEqual([1, 0])
    expect(updates).toHaveLength(2)
    expect(purged).toEqual([])
    expect(await wipeOnce(db, store, null, { now: () => NOW + 1 })).toMatchObject({ deleted: 0, purged: 1, left: 0, hosts: 0 })
    expect(purgeRecords.mock.calls.map(c => (c as unknown[])[2])).toEqual([new Date(NOW)])
    expect(store.wipeSwarm).not.toHaveBeenCalled()
  })

  it('leaves a deleted Swarm for a later pass when a stored file could not go, or the attachment settings are invalid', async () => {
    const { db } = database([deleted('a'), deleted('b')])
    purgeRecords.mockImplementationOnce(async () => 'waiting')
    expect(await wipeOnce(db, { wipeSwarm: async () => 'deleted' }, null, { now: () => NOW })).toMatchObject({ purged: 1, left: 1, files: 1 })
    purged.length = 0
    expect(await wipeOnce(db, { wipeSwarm: async () => 'deleted' }, undefined, { now: () => NOW })).toMatchObject({ purged: 0, left: 2, files: 2 })
    expect(purged).toEqual([])
  })

  it('is done when nothing from before the cut-off is left, and a pass again changes nothing', async () => {
    const { db } = database([{ _id: 'new', createdAt: at(WIPE_CUTOFF + 1), deletedAt: null, format: 2 }])
    const store = { wipeSwarm: vi.fn(async () => 'deleted' as const) }
    for (let i = 0; i < 2; i++) expect(await wipeOnce(db, store, null, { now: () => NOW })).toEqual({ deleted: 0, purged: 0, left: 0, hosts: 0, files: 0, failed: 0, codes: {} })
    expect(store.wipeSwarm).not.toHaveBeenCalled()
  })

  it('stopped part-way is not done', async () => {
    const { db } = database([old('a'), old('b')])
    const control = new AbortController()
    const pass = await wipeOnce(db, { wipeSwarm: async () => { control.abort(); return 'deleted' } }, null, { now: () => NOW, signal: control.signal })
    expect(pass).toMatchObject({ deleted: 1, left: 2 })
  })
})

describe('the wipe in the worker', () => {
  it('waits longer after each pass that failed, up to an hour', () => {
    expect([0, 1, 2, 3, 4, 10].map(retryIn)).toEqual([PASS_MS, 2 * PASS_MS, 4 * PASS_MS, 8 * PASS_MS, MAX_RETRY_MS, MAX_RETRY_MS])
  })

  it('passes again until one leaves nothing, and then stops', async () => {
    vi.useFakeTimers()
    const rows = [old('a')]
    const { db, reads } = database(rows)
    let calls = 0
    const store = { wipeSwarm: async () => {
      // The first try fails; the second deletes it, and the third pass purges it.
      if (++calls === 1) throw new SuperTabError('STARTS_PENDING', 'An agent is starting in this Swarm.')
      rows[0] = deleted('a')
      return 'deleted' as const
    } }
    purgeRecords.mockImplementation(async (_db, tabId) => { purged.push(tabId); rows.length = 0; return 'purged' })
    const stop = startSwarmWipe(db, store, { NODE_ENV: 'test', SUPER_TAB_ATTACHMENTS_BUCKET: '', SUPER_TAB_ATTACHMENTS_CREDENTIALS: '',
      SUPER_TAB_ATTACHMENTS_PREFIX: '', SUPER_TAB_ATTACHMENTS_PUBLIC_BASE: '', SUPER_TAB_AVATARS_BUCKET: '' }, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    // Failed: the next pass waits twice as long.
    await vi.advanceTimersByTimeAsync(2 * PASS_MS)
    expect(calls).toBe(2)
    // That pass paused after its deletion, as every write does.
    await vi.advanceTimersByTimeAsync(PAUSE_MS + PASS_MS)
    expect(purged).toEqual(['a'])
    // That pass left nothing, so it was the last: no more reads.
    const read = reads.length
    await vi.advanceTimersByTimeAsync(10 * MAX_RETRY_MS)
    expect(reads.length).toBe(read)
    stop()
  })
})

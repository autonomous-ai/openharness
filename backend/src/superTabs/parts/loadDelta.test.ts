import { describe, expect, it } from 'vitest'
import { loadDelta, type DeltaRows } from './load.js'

/** Part collections as rows, read through aggregateRaw: a `$match` on `_id`, or on `tabId` and a time, then `$project`. Counts
 *  each read, and each whole row (one with `data`) it sends. */
function fakeDb(rows: Record<string, Array<Record<string, unknown>>>) {
  const reads: Array<{ collection: string; ids: boolean; whole: number }> = []
  const time = (value: unknown) => Date.parse((value as { $date: string }).$date)
  const db = new Proxy({}, { get: (_t, name) => ({ aggregateRaw: async ({ pipeline }: { pipeline: Array<Record<string, Record<string, unknown>>> }) => {
    const collection = String(name)[0]!.toUpperCase() + String(name).slice(1)
    const match = pipeline.find(stage => '$match' in stage)!.$match!, project = pipeline.find(stage => '$project' in stage)?.$project
    const found = (rows[collection] ?? []).filter(row => {
      if (match._id) return (match._id as { $in: string[] }).$in.includes(row._id as string)
      const [field, bound] = 'readAt' in match ? ['readAt', match.readAt] : ['changedAt', match.changedAt]
      return row[field] !== undefined && time(row[field]) > time((bound as { $gt: unknown }).$gt)
    }).map(row => project ? Object.fromEntries(Object.entries(row).filter(([key]) => key === '_id' || project[key] === 1)) : row)
    reads.push({ collection, ids: !!match._id, whole: found.filter(row => 'data' in row).length })
    return found
  } }) }) as never
  return { db, reads }
}

const at = (ms: number) => ({ $date: new Date(ms).toISOString() })
const group = (key: string, version: number, changed: number) =>
  ({ _id: `t:${key}`, tabId: 't', key, version, changedAt: at(changed), deleted: false, ordinal: 1, data: { id: key, text: 'x'.repeat(100) }, hostDigest: `d${version}` })

describe('a delta reads whole rows only for versions it has not read (#2783)', () => {
  it('a second delta over the same window reads keys and versions only, and answers the same', async () => {
    const stored = { SwarmGroup: [group('g1', 1, 2_000), group('g2', 3, 3_000)] }
    const { db, reads } = fakeDb(stored)
    const memo: DeltaRows = new Map()
    const first = await loadDelta(db, 't', 1_000, ['group'], memo)
    const before = reads.reduce((sum, r) => sum + r.whole, 0)
    const second = await loadDelta(db, 't', 1_000, ['group'], memo)
    expect(reads.reduce((sum, r) => sum + r.whole, 0)).toBe(before)
    expect(second).toEqual(first)
    expect(second).toEqual(await loadDelta(fakeDb(stored).db, 't', 1_000, ['group']))
    expect(second.hostDigests!.get('g2')).toBe('d3')
  })

  it('the first delta of a kind, with nothing held, reads its rows whole in one read, as before (CI shard 2 of #2976)', async () => {
    const stored = { SwarmGroup: [group('g1', 1, 2_000)] }
    const { db, reads } = fakeDb(stored)
    const memo: DeltaRows = new Map()
    const delta = await loadDelta(db, 't', 1_000, ['group'], memo)
    expect(reads.map(r => [r.collection, r.ids, r.whole])).toEqual([['SwarmGroup', false, 1]])
    expect(delta).toEqual(await loadDelta(fakeDb(stored).db, 't', 1_000, ['group']))
    reads.length = 0
    await loadDelta(db, 't', 1_000, ['group'], memo)
    expect(reads.map(r => [r.collection, r.ids, r.whole])).toEqual([['SwarmGroup', false, 0]])
  })

  it('reads whole only the part whose version moved', async () => {
    const stored = { SwarmGroup: [group('g1', 1, 2_000), group('g2', 3, 3_000)] }
    const { db, reads } = fakeDb(stored)
    const memo: DeltaRows = new Map()
    await loadDelta(db, 't', 1_000, ['group'], memo)
    stored.SwarmGroup[1] = { ...group('g2', 4, 4_000), data: { id: 'g2', text: 'moved' } }
    reads.length = 0
    const delta = await loadDelta(db, 't', 1_000, ['group'], memo)
    expect(reads.filter(r => r.ids).map(r => r.whole)).toEqual([1])
    expect(delta.parts.find(p => p.key === 'g2')!.data).toEqual({ id: 'g2', text: 'moved' })
    expect(delta).toEqual(await loadDelta(fakeDb(stored).db, 't', 1_000, ['group']))
  })

  it('a machine read again only for its reading time is read whole again', async () => {
    const machine = (readAt: number) => ({ _id: 't:m1', tabId: 't', key: 'm1', version: 2, changedAt: at(500), readAt: at(readAt), deleted: false, ordinal: 1,
      data: { machineId: 'm1', reading: readAt } })
    const stored = { SwarmMachine: [machine(2_000)] }
    const { db } = fakeDb(stored)
    const memo: DeltaRows = new Map()
    await loadDelta(db, 't', 1_000, ['machine'], memo)
    stored.SwarmMachine[0] = machine(3_000)
    const delta = await loadDelta(db, 't', 1_000, ['machine'], memo)
    expect(delta.parts[0]!.readAt).toBe(3_000)
    expect(delta.parts[0]!.data).toEqual({ machineId: 'm1', reading: 3_000 })
  })
})

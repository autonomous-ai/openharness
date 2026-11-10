import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { followAccountNamesOnce, PAGE } from './accountNamesJob.js'

type Stage = { $match?: { format: number; deletedAt: null; _id?: { $gt: string } }; $limit?: number }
/** Swarms by id, as the job pages them: those after `_id.$gt`, in id order, at most `$limit`; the match it asks with is kept. */
function swarms(ids: string[]) {
  const asked: Array<Stage['$match']> = []
  const db = { superTab: { aggregateRaw: async ({ pipeline }: { pipeline: Stage[] }) => {
    const match = pipeline[0]!.$match!, limit = pipeline.find(stage => stage.$limit)!.$limit!
    asked.push(match)
    return ids.filter(id => !match._id || id > match._id.$gt).slice(0, limit).map(id => ({ _id: id }))
  } } } as unknown as PrismaClient
  return { db, asked }
}

describe('the one-time pass that makes every Swarm follow its people\'s account names', () => {
  it('visits every Swarm once, a page at a time, and counts what changed, what was gone and what failed, pausing only after a write', async () => {
    const ids = Array.from({ length: PAGE + 3 }, (_, i) => `tab-${String(i).padStart(4, '0')}`)
    const { db, asked } = swarms(ids)
    const seen: string[] = []
    const store = { followAccountNames: async (id: string) => {
      seen.push(id)
      if (id === ids[1]) throw new Error('busy')
      if (id === ids[2]) return 'gone' as const
      return id === ids[0] ? 2 : 0
    } }
    let pauses = 0
    expect(await followAccountNamesOnce(db, store, { pause: async () => { pauses++ } })).toEqual({ swarms: PAGE + 2, changed: 2, failed: 1 })
    expect(pauses).toBe(1)
    expect(seen).toEqual(ids)
    // Live Swarms in parts, a row that never had `deletedAt` too.
    expect(asked).toEqual([{ format: 2, deletedAt: null }, { format: 2, deletedAt: null, _id: { $gt: ids[PAGE - 1] } }])
  })

  it('stops at once when asked to', async () => {
    const control = new AbortController()
    const { db } = swarms(['a', 'b', 'c'])
    const seen: string[] = []
    const store = { followAccountNames: async (id: string) => { seen.push(id); control.abort(); return 0 } }
    await followAccountNamesOnce(db, store, { signal: control.signal })
    expect(seen).toEqual(['a'])
  })
})

import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { convertBuddiesOnce } from './buddiesJob.js'
import { PAGE } from './teamMachinesJob.js'

type Stage = { $match?: { _id?: { $gt: string } }; $limit?: number }
/** Swarms by id, as the job pages them: those after the cursor, in order, at most `$limit`. */
const database = (swarmIds: string[]) => ({ superTab: { aggregateRaw: async ({ pipeline }: { pipeline: Stage[] }) => {
  const after = pipeline[0]!.$match!._id?.$gt, limit = pipeline.find(s => s.$limit)!.$limit!
  return swarmIds.filter(id => !after || id > after).slice(0, limit).map(id => ({ _id: id }))
} } }) as unknown as PrismaClient

describe('the one-time pass that makes every Buddy an ordinary agent', () => {
  it('visits every Swarm once, a page at a time, counting what it converted and where it failed', async () => {
    const swarms = Array.from({ length: PAGE + 2 }, (_, i) => `tab-${String(i).padStart(4, '0')}`)
    const seen: string[] = []
    const store = { convertBuddies: async (id: string) => {
      seen.push(id)
      if (id === swarms[1]) throw new Error('busy')
      return id === swarms[0] ? 3 : 0
    } }
    let pauses = 0
    expect(await convertBuddiesOnce(database(swarms), store, { pause: async () => { pauses++ } })).toEqual({ swarms: PAGE + 1, converted: 3, failed: 1 })
    expect(pauses).toBe(1)
    expect(seen).toEqual(swarms)
    // Again: nothing left, so the job stops.
    expect(await convertBuddiesOnce(database(swarms), { convertBuddies: async () => 0 })).toEqual({ swarms: PAGE + 2, converted: 0, failed: 0 })
  })

  it('stops at once when asked to', async () => {
    const control = new AbortController()
    const seen: string[] = []
    await convertBuddiesOnce(database(['a', 'b', 'c']), { convertBuddies: async (id: string) => { seen.push(id); control.abort(); return 0 } }, { signal: control.signal })
    expect(seen).toEqual(['a'])
  })
})

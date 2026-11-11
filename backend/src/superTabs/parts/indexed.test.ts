import { describe, expect, it } from 'vitest'
import { READ_BATCH, readBy } from './indexed.js'

describe('a named read (#2839)', () => {
  it('asks for every row in one batch: past 101 rows Mongo otherwise answers in getMores, more as a Swarm grows', async () => {
    const calls: Array<{ options?: { batchSize?: number } }> = []
    const tx = { swarmGroup: { aggregateRaw: async (args: { options?: { batchSize?: number } }) => { calls.push(args); return [] } } } as never
    await readBy(tx, 'SwarmGroup', 'agents', [{ $match: { tabId: 't', agentIds: 'a1' } }])
    expect(calls[0]!.options?.batchSize).toBe(READ_BATCH)
    expect(READ_BATCH).toBeGreaterThanOrEqual(10_000)
  })
})

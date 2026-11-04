import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { REPUSH_AFTER_MS, repushQueuedDeliveries } from './deliveryRepush.js'

const NOW = 10_000_000

/** SuperTabDelivery's aggregate, in memory: the pipeline's match on status, its page after an id, its sort and limit. */
function fakeDb(rows: Array<{ id: string; status: string; tabId: string; agentId: string; machineId: string; updatedAt: number }>) {
  const pipelines: unknown[][] = []
  const aggregateRaw = vi.fn(async ({ pipeline }: { pipeline: Array<Record<string, any>> }) => {
    pipelines.push(pipeline)
    const match = pipeline.find(stage => stage.$match)!.$match
    const limit = pipeline.find(stage => stage.$limit)!.$limit as number
    return rows.filter(row => row.status === match.status && (!match._id || row.id > match._id.$gt))
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit)
      .map(row => ({ _id: row.id, tabId: row.tabId, agentId: row.agentId, machineId: row.machineId, updatedAt: { $date: new Date(row.updatedAt).toISOString() } }))
  })
  return { db: { superTabDelivery: { aggregateRaw } } as unknown as PrismaClient, pipelines }
}

describe('the server repeats the push of a delivery still queued (task #2800)', () => {
  it('tells each machine once per agent with a delivery queued 10 s or more', async () => {
    const { db } = fakeDb([
      { id: 'd1', status: 'queued', tabId: 't', agentId: 'a1', machineId: 'm1', updatedAt: NOW - REPUSH_AFTER_MS },
      { id: 'd2', status: 'queued', tabId: 't', agentId: 'a1', machineId: 'm1', updatedAt: NOW - 60_000 },
      { id: 'd3', status: 'queued', tabId: 't', agentId: 'a2', machineId: 'm2', updatedAt: NOW - 3_600_000 },
    ])
    const tell = vi.fn()
    expect(await repushQueuedDeliveries(db, tell, NOW)).toBe(2)
    expect(tell.mock.calls).toEqual([[{ machineId: 'm1', tabId: 't', agentId: 'a1' }], [{ machineId: 'm2', tabId: 't', agentId: 'a2' }]])
  })

  // Its own push went out a moment ago and is almost always heard: a repeat would only cost the host a read.
  it('leaves a delivery queued under 10 s to its own push', async () => {
    const { db } = fakeDb([{ id: 'd1', status: 'queued', tabId: 't', agentId: 'a1', machineId: 'm1', updatedAt: NOW - REPUSH_AFTER_MS + 1 }])
    const tell = vi.fn()
    expect(await repushQueuedDeliveries(db, tell, NOW)).toBe(0)
    expect(tell).not.toHaveBeenCalled()
  })

  // A claimed delivery is the host's already; uncertain and held ones wait on a person or the pane, and the host reads them.
  it('reads only queued deliveries, through the status index, never a whole collection', async () => {
    const { db, pipelines } = fakeDb([
      { id: 'd1', status: 'claimed', tabId: 't', agentId: 'a1', machineId: 'm1', updatedAt: NOW - 60_000 },
      { id: 'd2', status: 'uncertain', tabId: 't', agentId: 'a1', machineId: 'm1', updatedAt: NOW - 60_000 },
    ])
    const tell = vi.fn()
    expect(await repushQueuedDeliveries(db, tell, NOW)).toBe(0)
    expect(pipelines[0]).toContainEqual({ $match: { status: 'queued' } })
    expect(pipelines[0]).toContainEqual({ $sort: { _id: 1 } })
  })

  // Ids are hashes, not times: a first page of old rows on machines that are away must not hide a newer one behind it.
  it('reads every page, so a delivery after 500 old ones is told too', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: `d${String(i).padStart(4, '0')}`, status: 'queued', tabId: 't',
      agentId: i === 500 ? 'late' : 'away', machineId: i === 500 ? 'm2' : 'm1', updatedAt: NOW - 60_000 }))
    const { db, pipelines } = fakeDb(rows)
    const tell = vi.fn()
    expect(await repushQueuedDeliveries(db, tell, NOW)).toBe(2)
    expect(pipelines).toHaveLength(2)
    expect(tell).toHaveBeenCalledWith({ machineId: 'm2', tabId: 't', agentId: 'late' })
  })
})

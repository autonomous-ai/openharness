import { describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { recentDormantGroups } from './read.js'

// Diego's issue file (2026-10-27): the board loaded every dormant group of the last 5 weeks whole, once a minute per open
// column. It reads only what the board and its read check use (stats.ts, projects.ts canReadGroup).
describe('the dormant groups the leaderboard sums', () => {
  const since = Date.UTC(2026, 9, 1)
  const reading = (rows: unknown[]) => {
    const asked: unknown[] = []
    const tx = { swarmGroup: {
      aggregateRaw: async (args: unknown) => { asked.push(args); return rows },
      findMany: async () => { throw new Error('the whole group was loaded') },
    } } as unknown as Prisma.TransactionClient
    return { tx, asked }
  }

  it('reads only the fields the board uses, never a group whole', async () => {
    const { tx, asked } = reading([{ data: { id: 'g1', requesterId: 'peer', ledger: { shippedAt: since + 1 }, assignment: { id: 'a1', status: 'done' } } }])
    expect(await recentDormantGroups(tx, 'tab', 'web', since)).toEqual([{ id: 'g1', requesterId: 'peer', ledger: { shippedAt: since + 1 }, assignment: { id: 'a1', status: 'done' } }])
    const [{ pipeline }] = asked as [{ pipeline: Array<Record<string, Record<string, unknown>>> }]
    expect(pipeline[0]!.$match).toEqual({ tabId: 'tab', deleted: false, dormant: true, lastActivityAt: { $gte: { $date: new Date(since).toISOString() } }, projectId: 'web' })
    expect(Object.keys(pipeline[1]!.$project!).sort()).toEqual(['_id', ...['archived', 'assignment.id', 'assignment.status', 'audience', 'id', 'kind', 'ledger',
      'projectId', 'pullRequestUrls', 'requesterId', 'reviewOf'].map(field => `data.${field}`)].sort())
  })

  it('reads the default project\'s groups stored with no project too', async () => {
    const { tx, asked } = reading([])
    await recentDormantGroups(tx, 'tab', 'lead', since)
    expect((asked[0] as { pipeline: Array<Record<string, Record<string, unknown>>> }).pipeline[0]!.$match).toMatchObject({ $or: [{ projectId: 'lead' }, { projectId: null }] })
  })
})

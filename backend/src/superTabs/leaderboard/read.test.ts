import { describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { profileNames, recentDormantGroups } from './read.js'
import { DIRECT } from '../cachedReads.js'
import { weekStart } from './week.js'

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

  const row = (id: string, lastActivityAt: number) => ({ key: id, version: 1, changedAt: { $date: new Date(since).toISOString() }, ordinal: 0, dormant: true,
    lastActivityAt: { $date: new Date(lastActivityAt).toISOString() },
    data: { id, requesterId: 'peer', ledger: { shippedAt: since + 1 }, assignment: { id: 'a1', status: 'done' } } })

  it('reads only the fields the board uses, never a group whole, from the Monday its window starts in', async () => {
    const { tx, asked } = reading([row('g1', since + 1), row('g0', since - 1)])
    // Held from the week's Monday (cachePatch.ts boardRule); answered for the window alone, without the activity it was kept by.
    expect(await recentDormantGroups(tx, DIRECT, 'tab', 'web', since)).toEqual([{ id: 'g1', requesterId: 'peer', ledger: { shippedAt: since + 1 }, assignment: { id: 'a1', status: 'done' } }])
    const [{ pipeline }] = asked as [{ pipeline: Array<Record<string, Record<string, unknown>>> }]
    expect(pipeline[0]!.$match).toEqual({ tabId: 'tab', deleted: false, dormant: true, lastActivityAt: { $gte: { $date: new Date(weekStart(since)).toISOString() } }, projectId: { $in: ['web'] } })
    expect(Object.keys(pipeline[1]!.$project!).sort()).toEqual(['_id', 'key', 'version', 'changedAt', 'ordinal', 'dormant', 'lastActivityAt', ...['archived', 'assignment.id', 'assignment.status', 'audience', 'id', 'kind', 'leadId', 'ledger',
      'projectId', 'pullRequestUrls', 'requesterId', 'reviewOf', 'step', 'title'].map(field => `data.${field}`)].sort())
  })

  it('reads the default project\'s groups stored with no project too', async () => {
    const { tx, asked } = reading([])
    await recentDormantGroups(tx, DIRECT, 'tab', 'lead', since)
    expect((asked[0] as { pipeline: Array<Record<string, Record<string, unknown>>> }).pipeline[0]!.$match).toMatchObject({ projectId: { $in: ['lead', null] } })
  })
})

describe('the names the board shows', () => {
  it('reads only the name of account ids, and leaves people without one to their email', async () => {
    const asked: unknown[] = []
    const tx = { user: { findMany: async (args: unknown) => { asked.push(args); return [{ id: 'a'.repeat(24), name: 'Dee Tran' }, { id: 'b'.repeat(24), name: null }] } } } as unknown as Prisma.TransactionClient
    expect(await profileNames(tx, ['a'.repeat(24), 'b'.repeat(24), 'owner'])).toEqual(new Map([['a'.repeat(24), 'Dee Tran']]))
    // A member id that is no account id would make the database refuse the whole read.
    expect(asked).toEqual([{ where: { id: { in: ['a'.repeat(24), 'b'.repeat(24)] } }, select: { id: true, name: true } }])
  })

  it('reads nothing when no member is an account', async () => {
    const tx = { user: { findMany: async () => { throw new Error('read') } } } as unknown as Prisma.TransactionClient
    expect(await profileNames(tx, ['owner'])).toEqual(new Map())
  })
})

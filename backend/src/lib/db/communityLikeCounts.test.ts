import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ runCommandRaw: vi.fn() }))

vi.mock('../../config/env.js', () => ({ env: { DATABASE_URL: 'mongodb://test' } }))
vi.mock('../prisma.js', () => ({ prisma: { $runCommandRaw: db.runCommandRaw } }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { reconcileCommunityLikeCounts } from './communityLikeCounts.js'

const batch = (rows: unknown[]) => ({ cursor: { id: 0, firstBatch: rows } })
function database(posts: unknown[], likes: unknown[]): void {
  db.runCommandRaw.mockImplementation(async (cmd: Record<string, unknown>) =>
    'find' in cmd ? batch(posts) : 'aggregate' in cmd ? batch(likes) : { ok: 1, nModified: 1 })
}
const updates = () => db.runCommandRaw.mock.calls.map(call => call[0] as { update?: string; updates?: unknown[] }).find(cmd => cmd.update)?.updates

describe('reconcileCommunityLikeCounts', () => {
  beforeEach(() => { db.runCommandRaw.mockReset() })

  it('sets each publication’s count only where it differs, and only if no like moved it meanwhile', async () => {
    database([{ _id: 'never-counted' }, { _id: 'drifted', likeCount: 5 }, { _id: 'right', likeCount: 2 }, { _id: 'unliked', likeCount: 0 }],
      [{ _id: 'never-counted', likes: 3 }, { _id: 'drifted', likes: 4 }, { _id: 'right', likes: 2 }, { _id: 'starter-orbit', likes: 9 }])
    await reconcileCommunityLikeCounts()
    expect(updates()).toEqual([
      { q: { _id: 'never-counted', likeCount: null }, u: { $set: { likeCount: 3 } } },
      { q: { _id: 'drifted', likeCount: 5 }, u: { $set: { likeCount: 4 } } },
    ])
  })

  it('writes nothing when every count is right, and never throws', async () => {
    database([{ _id: 'right', likeCount: 1 }], [{ _id: 'right', likes: 1 }])
    await reconcileCommunityLikeCounts()
    expect(updates()).toBeUndefined()
    db.runCommandRaw.mockRejectedValue(new Error('down'))
    await expect(reconcileCommunityLikeCounts()).resolves.toBeUndefined()
  })
})

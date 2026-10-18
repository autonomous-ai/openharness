import { communityStarters } from './communityAccess.js'
import { prisma } from './prisma.js'

type LikeKey = { autonomousEnv: string; harnessId: string; userId: string }

/** 1 when this like is new, 0 when the reader already liked it (a repeat, or a second request at once). */
async function addLike(key: LikeKey): Promise<number> {
  try {
    await prisma.communityLike.create({ data: key })
    return 1
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return 0
    throw error
  }
}

/**
 * Saves one reader's like and returns the harness's likes. A publication's `likeCount` moves only by a
 * like really made or removed, so two requests at once never both count. A starter is the website's,
 * not stored here: its likes are only counted.
 */
export async function saveLike(key: LikeKey, liked: boolean): Promise<number> {
  const change = liked ? await addLike(key) : -(await prisma.communityLike.deleteMany({ where: key })).count
  if (change && !communityStarters.has(key.harnessId)) {
    await prisma.communityHarness.updateMany({ where: { id: key.harnessId, autonomousEnv: key.autonomousEnv }, data: { likeCount: { increment: change } } })
  }
  return prisma.communityLike.count({ where: { autonomousEnv: key.autonomousEnv, harnessId: key.harnessId } })
}

/** Each harness's likes, for those of [ids] with any. */
export async function likeCounts(ids: readonly string[], autonomousEnv: string): Promise<Map<string, number>> {
  const rows = await prisma.communityLike.groupBy({ by: ['harnessId'], where: { autonomousEnv, harnessId: { in: [...ids] } }, _count: { _all: true } })
  return new Map(rows.map(row => [row.harnessId, row._count._all]))
}

/** The likes each harness got since [since]: only those are read, so a week of them stays small. */
export async function likesSince(autonomousEnv: string, since: Date): Promise<Map<string, number>> {
  const rows = await prisma.communityLike.groupBy({ by: ['harnessId'], where: { autonomousEnv, createdAt: { gte: since } }, _count: { _all: true } })
  return new Map(rows.map(row => [row.harnessId, row._count._all]))
}

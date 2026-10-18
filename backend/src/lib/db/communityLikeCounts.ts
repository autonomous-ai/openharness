import { logger } from '../../utils/logger.js'
import { prisma } from '../prisma.js'
import { RAW_SINGLE_BATCH, readSingleBatchRaw } from './migrate.js'

/**
 * Sets every publication's `likeCount` to its likes: the first time (rows from before the count), and
 * after anything that let one drift. Compare-and-set: a like saved meanwhile has moved the count from
 * what was read here, and wins. Idempotent; a failure is retried on the next boot.
 */
export async function reconcileCommunityLikeCounts(): Promise<void> {
  try {
    const [posts, likes] = await Promise.all([
      readSingleBatchRaw<{ _id: string; likeCount?: number | null }>({
        find: 'community_harnesses', filter: {}, projection: { _id: 1, likeCount: 1 }, batchSize: RAW_SINGLE_BATCH, singleBatch: true,
      }),
      readSingleBatchRaw<{ _id: string; likes: number }>({
        aggregate: 'community_likes', pipeline: [{ $group: { _id: '$harnessId', likes: { $sum: 1 } } }], cursor: { batchSize: RAW_SINGLE_BATCH },
      }),
    ])
    const count = new Map(likes.map(row => [row._id, row.likes]))
    const updates = posts
      .filter(post => post.likeCount !== (count.get(post._id) ?? 0))
      .map(post => ({ q: { _id: post._id, likeCount: post.likeCount ?? null }, u: { $set: { likeCount: count.get(post._id) ?? 0 } } }))
    if (!updates.length) return
    const result = (await prisma.$runCommandRaw({ update: 'community_harnesses', updates } as never)) as { nModified?: number }
    logger.info('community_harnesses.likeCount reconciled', { rows: updates.length, modified: result.nModified ?? 0 })
  } catch (err) {
    logger.error('community_harnesses.likeCount reconcile failed — continuing (retried next boot)', err)
  }
}

import { prisma } from './prisma.js'

export const feedSorts = ['newest', 'popular'] as const
export type FeedSort = typeof feedSorts[number]

/** What a feed card reads: never the files or the cover's bytes. */
const feedSelect = { id: true, title: true, description: true, category: true, engine: true, harnessId: true, authorId: true, authorName: true, forkedFrom: true, createdAt: true } as const
const feedPageSize = 30

type FeedWhere = NonNullable<Parameters<typeof prisma.communityHarness.findMany>[0]>['where']
type FeedRow = Awaited<ReturnType<typeof newestPage>>[number]
const newest = [{ createdAt: 'desc' as const }, { id: 'desc' as const }]

/** One page newest first, the indexed order, after the last id read. One row more tells whether there is another page. */
function newestPage(where: FeedWhere, cursor?: string) {
  return prisma.communityHarness.findMany({
    where, select: feedSelect, orderBy: newest, take: feedPageSize + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })
}

/**
 * One page most liked first, newest first among equals, after the last id read. A page whose last
 * harness has since gone ends the feed rather than starting it over.
 * TODO(BE): this ranks every matching publication for each page; keep a like count on the
 * publication (and index it) once the feed outgrows that.
 */
async function popularPage(where: FeedWhere, autonomousEnv: string, cursor?: string): Promise<FeedRow[]> {
  const ids = (await prisma.communityHarness.findMany({ where, select: { id: true }, orderBy: newest })).map(row => row.id)
  const likes = await prisma.communityLike.groupBy({ by: ['harnessId'], where: { autonomousEnv, harnessId: { in: ids } }, _count: { _all: true } })
  const count = new Map(likes.map(row => [row.harnessId, row._count._all]))
  // Array sort is stable, so equals keep the newest-first order they were read in.
  const ranked = [...ids].sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0))
  const start = cursor ? ranked.indexOf(cursor) + 1 : 0
  if (cursor && !start) return []
  const pageIds = ranked.slice(start, start + feedPageSize + 1)
  const rows = new Map((await prisma.communityHarness.findMany({ where: { id: { in: pageIds } }, select: feedSelect })).map(row => [row.id, row]))
  return pageIds.flatMap(id => rows.get(id) ?? [])
}

/** A feed page in the reader's order, and the cursor for the next one (null on the last). */
export async function feedPage(where: FeedWhere, autonomousEnv: string, sort: FeedSort, cursor?: string) {
  const rows = sort === 'popular' ? await popularPage(where, autonomousEnv, cursor) : await newestPage(where, cursor)
  const page = rows.slice(0, feedPageSize)
  return { page, nextCursor: rows.length > feedPageSize ? page[page.length - 1].id : null }
}

/** Likes, comments and public forks of each harness, and which of them the reader likes. */
export async function feedStats(ids: string[], autonomousEnv: string, userId?: string) {
  const [likes, comments, forks, liked] = await Promise.all([
    prisma.communityLike.groupBy({ by: ['harnessId'], where: { autonomousEnv, harnessId: { in: ids } }, _count: { _all: true } }),
    prisma.communityComment.groupBy({ by: ['harnessId'], where: { autonomousEnv, harnessId: { in: ids } }, _count: { _all: true } }),
    prisma.communityHarness.groupBy({ by: ['forkedFrom'], where: { autonomousEnv, deletedAt: null, forkedFrom: { in: ids } }, _count: { _all: true } }),
    userId ? prisma.communityLike.findMany({ where: { autonomousEnv, userId, harnessId: { in: ids } }, select: { harnessId: true } }) : [],
  ])
  const likeCount = new Map(likes.map(row => [row.harnessId, row._count._all]))
  const commentCount = new Map(comments.map(row => [row.harnessId, row._count._all]))
  const forkCount = new Map(forks.map(row => [row.forkedFrom, row._count._all]))
  const likedIds = new Set(liked.map(row => row.harnessId))
  return Object.fromEntries(ids.map(id => [id, { likes: likeCount.get(id) ?? 0, comments: commentCount.get(id) ?? 0, forks: forkCount.get(id) ?? 0, liked: likedIds.has(id) }]))
}

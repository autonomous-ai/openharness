import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { parseAutonomousEnvironment } from '../lib/autonomousEnvironment.js'
import { communityStarterAuthor, communityStarters } from '../lib/communityAccess.js'
import { feedPage, feedSorts, feedStats } from '../lib/communityFeed.js'
import { saveLike } from '../lib/communityLikes.js'
import { resolvePublicationId } from '../lib/communitySlug.js'
import { notify } from '../lib/communityNotifications.js'
import { hiddenFrom, isHiddenFrom } from '../lib/communityReports.js'
import { communityCategories, communityEngines, communityHarnessIds, communityHarnessMarkers, communityLimits, communityPathPattern, communityReservedName } from '../lib/communityContract.js'
import { validateBody, validateParams, validateQuery } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { ValidationError } from '../errors/index.js'
import { acceptGzipJson } from '../lib/gzipJson.js'

const identifier = z.string().regex(/^[a-z0-9-]{1,80}$/)

/** A stored cover's bytes and type, or null unless its data URL holds the image it claims. */
export function coverImage(value: string): { type: string; bytes: Buffer } | null {
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/)
  if (!match) return null
  const bytes = Buffer.from(match[2], 'base64')
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  return valid ? { type: `image/${match[1]}`, bytes } : null
}

/**
 * Readers get a cover's address, never its bytes: a feed page would otherwise carry every image inline.
 * The address names the version, since the website caches a cover for a day and an edit can change it.
 */
function withCoverPath<T extends { id: string; cover: string | null; updatedAt?: Date | null }>(row: T): Omit<T, 'cover'> & { cover?: string } {
  const { cover, ...rest } = row
  const version = row.updatedAt ? `?v=${row.updatedAt.getTime()}` : ''
  return { ...rest, ...(cover ? { cover: `/api/community/harnesses/${row.id}/cover${version}` } : {}) }
}
const searchMaxChars = 80
/** The fields a reader searches by. TODO(BE): an unanchored match scans the environment's publications; move to an Atlas Search index once the feed outgrows that. */
const searchFields = ['title', 'description', 'authorName', 'category', 'engine', 'harnessId'] as const
function searchWhere(q?: string) {
  if (!q) return {}
  return { OR: searchFields.map(field => ({ [field]: { contains: q, mode: 'insensitive' as const } })) }
}
/** A publication with only the page readers see: what a harness page draws, without megabytes of source. */
function withViewerOnly<T extends { files: unknown; viewerPath: string }>(post: T): T {
  const files = Array.isArray(post.files) ? post.files.filter(file => (file as { path?: unknown } | null)?.path === post.viewerPath) : []
  return { ...post, files }
}
const params = z.object({ id: identifier })
const file = z.object({
  path: z.string().regex(communityPathPattern).refine(path =>
    !path.split('/').some(part => !part || part.startsWith('.') || communityReservedName.test(part)), 'Use a relative project path, not a reserved bundle file.'),
  content: z.string().max(communityLimits.fileChars),
  encoding: z.literal('base64').optional(),
}).strict()

const publicationFields = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(300),
  category: z.enum(communityCategories),
  engine: z.enum(communityEngines),
  harnessId: z.enum(communityHarnessIds).optional(),
  files: z.array(file).min(1).max(communityLimits.files),
  viewerPath: z.string().max(180),
  conversation: z.array(z.object({ role: z.enum(['user', 'assistant', 'tool']), text: z.string().min(1).max(communityLimits.turnChars) }).strict()).min(1).max(communityLimits.turns),
  cover: z.string().max(communityLimits.coverChars).optional().refine(value => !value || !!coverImage(value), 'Use a PNG, JPEG, or WebP cover.'),
  forkedFrom: identifier.optional(),
  clientId: z.string().uuid().optional(),
  license: z.literal('MIT'),
  confirmed: z.literal(true),
})
type Snapshot = Pick<z.infer<typeof publicationFields>, 'files' | 'viewerPath' | 'harnessId'>

/** What every published snapshot must hold, new or edited. */
function checkSnapshot(value: Snapshot, ctx: z.RefinementCtx): void {
  for (const file of value.files) {
    if (file.encoding && (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.content) || file.content.length % 4 !== 0)) ctx.addIssue({ code: 'custom', message: 'Invalid binary file encoding.' })
    const lower = file.path.toLowerCase();
    if (value.files.some(other => other.path.toLowerCase().startsWith(`${lower}/`))) ctx.addIssue({ code: 'custom', message: 'A file cannot also be a directory.' })
  }
  if (new Set(value.files.map(f => f.path.toLowerCase())).size !== value.files.length)
    ctx.addIssue({ code: 'custom', message: 'Project paths must be unique.' })
  if (!value.viewerPath.endsWith('.html') || !value.files.some(f => f.path === value.viewerPath && !f.encoding))
    ctx.addIssue({ code: 'custom', message: 'Choose an included HTML file as the viewer.' })
  const marker = value.harnessId ? communityHarnessMarkers[value.harnessId] : undefined
  if (marker && !value.files.some(file => file.path === marker && !file.encoding)) ctx.addIssue({ code: 'custom', message: 'Include the harness project source.' })
  if (Buffer.byteLength(JSON.stringify(value)) > communityLimits.snapshotBytes)
    ctx.addIssue({ code: 'custom', message: 'Keep the published snapshot under 6 MB.' })
}

export const publicationSchema = publicationFields.strict().superRefine(checkSnapshot)

/**
 * An edit replaces what a publication shows; where it came from (`forkedFrom`, its credits) stays
 * as it was published. A cover left out keeps the one it has.
 */
export const publicationEditSchema = publicationFields.omit({ forkedFrom: true, clientId: true }).strict().superRefine(checkSnapshot)

export function environment(req: FastifyRequest): string {
  try { return req.user?.autonomousEnv ?? parseAutonomousEnvironment(req.headers['x-autonomous-env']) }
  catch { throw new ValidationError('Invalid Autonomous environment') }
}

async function authorName(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
  return user?.name?.trim().slice(0, 80) || 'Harness user'
}

type Publication = NonNullable<Awaited<ReturnType<typeof publication>>>

/** Comments a read sends at once: the latest with a harness's social state, and each earlier page. */
export const commentPageSize = 100

type CommentRow = { id: string; body: string; authorName: string; createdAt: Date; parentId: string | null; parentAuthorName: string | null; userId: string }

/** One comment as a reader sees it: whether its harness's creator wrote it, and whether this reader may delete it. */
export function commentView(row: CommentRow, authorId: string, userId?: string) {
  return { id: row.id, body: row.body, authorName: row.authorName, createdAt: row.createdAt, parentId: row.parentId, parentAuthorName: row.parentAuthorName, creator: row.userId === authorId, mine: row.userId === userId || authorId === userId }
}

async function socialState(post: Publication, autonomousEnv: string, userId: string | undefined) {
  const harnessId = post.id
  // Comments reports have hidden from this reader are neither shown nor counted.
  const hidden = await hiddenFrom(autonomousEnv, 'comment', userId, harnessId)
  const visible = hidden.length ? { id: { notIn: hidden } } : {}
  const [likes, liked, comments, follow, commentCount, forks] = await Promise.all([
    prisma.communityLike.count({ where: { autonomousEnv, harnessId } }),
    userId ? prisma.communityLike.findUnique({ where: { autonomousEnv_harnessId_userId: { autonomousEnv, harnessId, userId } } }) : null,
    prisma.communityComment.findMany({ where: { autonomousEnv, harnessId, ...visible }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: commentPageSize }),
    userId ? prisma.communityFollow.findUnique({ where: { autonomousEnv_authorId_userId: { autonomousEnv, authorId: post.authorId, userId } } }) : null,
    // The comments above are the latest page (routes/communityComments.ts reads earlier ones); these say how many there are in all, and how many public forks.
    prisma.communityComment.count({ where: { autonomousEnv, harnessId, ...visible } }),
    prisma.communityHarness.count({ where: { autonomousEnv, deletedAt: null, forkedFrom: harnessId } }),
  ])
  return {
    likes, liked: !!liked, following: !!follow, signedIn: !!userId, mine: post.authorId === userId, commentCount, forks,
    // When its author last edited it: a page drawn before then reads the publication again.
    updatedAt: 'updatedAt' in post ? post.updatedAt : null,
    comments: comments.reverse().map(row => commentView(row, post.authorId, userId)),
  }
}

export async function publication(id: string, autonomousEnv: string) {
  if (communityStarters.has(id)) return { id, authorId: communityStarterAuthor, authorName: 'Harness', credits: [] }
  return prisma.communityHarness.findFirst({ where: { id, autonomousEnv, deletedAt: null } })
}

/** A publication as this reader may see it: none once reports hide it from them, except from its author. */
export async function visiblePublication(id: string, autonomousEnv: string, userId?: string) {
  const post = await publication(id, autonomousEnv)
  if (!post || post.authorId === userId || communityStarters.has(id)) return post
  return await isHiddenFrom(autonomousEnv, 'harness', id, userId) ? null : post
}

/**
 * The publication a fork was made from, named on its page: `origin` is null once that one is no
 * longer published. A starter's name is the website's, so a fork of one carries none.
 */
async function origin(forkedFrom: string | null, autonomousEnv: string) {
  if (!forkedFrom || communityStarters.has(forkedFrom)) return {}
  const source = await prisma.communityHarness.findFirst({ where: { id: forkedFrom, autonomousEnv, deletedAt: null }, select: { title: true, authorName: true } })
  return { origin: source }
}

export async function communityRoutes(app: FastifyInstance): Promise<void> {
  // Synchronous, as every header-only hook (middlewares/securityHeaders.ts).
  app.addHook('onSend', (_req, reply, payload, done) => { reply.header('Cache-Control', 'no-store'); done(null, payload) })
  // A gzipped body unpacks to at most what a raw one may carry (the snapshot and its envelope).
  acceptGzipJson(app, 6_100_000)

  const feedQuery = z.object({
    cursor: z.string().uuid().or(z.enum([...communityStarters] as [string, ...string[]])).optional(),
    following: z.enum(['true', 'false']).optional(), mine: z.enum(['true', 'false']).optional(),
    q: z.string().trim().min(1).max(searchMaxChars).optional(), category: z.enum(communityCategories).optional(),
    sort: z.enum(feedSorts).optional(), forkedFrom: identifier.optional(), author: identifier.optional(),
  }).strict().refine(query => query.sort === 'popular' || query.sort === 'trending' || !communityStarters.has(query.cursor ?? ''), 'Only a popular or trending feed pages past a starter.')
    .refine(query => !query.author || (query.mine !== 'true' && query.following !== 'true'), 'A creator’s feed is neither yours nor Following.')
  app.get<{ Querystring: z.infer<typeof feedQuery> }>('/api/community/harnesses', { preHandler: validateQuery(feedQuery) }, async (req, reply) => {
    const autonomousEnv = environment(req)
    if ((req.query.following === 'true' || req.query.mine === 'true') && !req.user) return sendError(reply, 'Sign in to see your harnesses and creators you follow.', 'UNAUTHORIZED', 401)
    const { following, mine, q, category, forkedFrom, author, sort = 'newest', cursor } = req.query
    const [follows, hidden] = await Promise.all([
      req.user ? prisma.communityFollow.findMany({ where: { autonomousEnv, userId: req.user.sub }, select: { authorId: true } }) : [],
      // Your own list shows your own work, hidden or not.
      mine === 'true' ? [] : hiddenFrom(autonomousEnv, 'harness', req.user?.sub),
    ])
    const where = {
      autonomousEnv, deletedAt: null, ...searchWhere(q), ...(hidden.length ? { id: { notIn: hidden } } : {}),
      ...(following === 'true' ? { authorId: { in: follows.map(row => row.authorId) } } : {}), ...(mine === 'true' ? { authorId: req.user!.sub } : {}),
      ...(category ? { category } : {}), ...(forkedFrom ? { forkedFrom } : {}), ...(author ? { authorId: author } : {}),
    }
    // Starters are the website's: it matches their search and category, so a popular page ranks all of
    // them there is a place for — none among your own or a harness's forks, in Following only when
    // the reader follows Harness, and on a creator's page only on Harness's.
    const followed = new Set(follows.map(row => row.authorId))
    const starters = mine === 'true' || forkedFrom || (following === 'true' && !followed.has(communityStarterAuthor)) || (author && author !== communityStarterAuthor) ? [] : [...communityStarters]
    const { page, order, nextCursor } = await feedPage(where, autonomousEnv, sort, starters, cursor)
    const ids = [...page.map(row => row.id), ...communityStarters]
    const [stats, covered] = await Promise.all([
      feedStats(ids, autonomousEnv, req.user?.sub),
      // Which have a cover, without reading one: a page of them is megabytes of base64.
      prisma.communityHarness.findMany({ where: { id: { in: page.map(row => row.id) }, cover: { isSet: true, not: null } }, select: { id: true } }),
    ])
    const withCover = new Set(covered.map(row => row.id))
    sendSuccess(reply, { harnesses: page.map(row => withCoverPath({ ...row, cover: withCover.has(row.id) ? 'set' : null })), ...(order ? { order } : {}), stats, signedIn: !!req.user, nextCursor, following: [...followed] })
  })

  // `files=viewer` sends only the output page: a harness page draws nothing else. The website's
  // address for it (its slug) finds it too; every other route takes the id this one answers with.
  const harnessQuery = z.object({ files: z.enum(['viewer']).optional() })
  app.get<{ Params: z.infer<typeof params>; Querystring: z.infer<typeof harnessQuery> }>('/api/community/harnesses/:id', { preHandler: [validateParams(params), validateQuery(harnessQuery)] }, async (req, reply) => {
    const autonomousEnv = environment(req), harnessId = await resolvePublicationId(req.params.id, autonomousEnv)
    const post = await visiblePublication(harnessId, autonomousEnv, req.user?.sub)
    if (!post) return sendError(reply, 'This harness is unavailable.', 'NOT_FOUND', 404)
    const stored = 'title' in post ? post : null
    const [source, social] = await Promise.all([origin(stored?.forkedFrom ?? null, autonomousEnv), socialState(post, autonomousEnv, req.user?.sub)])
    sendSuccess(reply, {
      // A starter's files are the website's own; only a publication is stored here.
      harness: stored ? { ...withCoverPath(req.query.files === 'viewer' ? withViewerOnly(stored) : stored), ...source } : null,
      social,
    })
  })

  // What a reader's page refreshes: the publication itself changes only when its author edits it, which `updatedAt` says.
  app.get<{ Params: z.infer<typeof params> }>('/api/community/harnesses/:id/social', { preHandler: validateParams(params) }, async (req, reply) => {
    const autonomousEnv = environment(req)
    const post = await visiblePublication(req.params.id, autonomousEnv, req.user?.sub)
    if (!post) return sendError(reply, 'This harness is unavailable.', 'NOT_FOUND', 404)
    sendSuccess(reply, { social: await socialState(post, autonomousEnv, req.user?.sub) })
  })

  // Read by an <img>, which sends no environment header: a publication id is a UUID, unique across both.
  app.get<{ Params: z.infer<typeof params> }>('/api/community/harnesses/:id/cover', { preHandler: validateParams(params) }, async (req, reply) => {
    const post = await prisma.communityHarness.findFirst({ where: { id: req.params.id, deletedAt: null }, select: { cover: true, autonomousEnv: true, authorId: true } })
    // A harness reports hid is hidden here too, as on its page (#1026: a hidden cover was still served); its author still
    // has it. The hidden row is the publication's own environment's, since an <img> names none.
    const hidden = post && post.authorId !== req.user?.sub && await isHiddenFrom(post.autonomousEnv, 'harness', req.params.id)
    const image = post?.cover && !hidden ? coverImage(post.cover) : null
    if (!image) return sendError(reply, 'This cover is unavailable.', 'NOT_FOUND', 404)
    reply.header('Content-Type', image.type).header('X-Content-Type-Options', 'nosniff').send(image.bytes)
  })

  app.post<{ Body: z.infer<typeof publicationSchema> }>('/api/community/harnesses', { bodyLimit: 6_100_000, preHandler: validateBody(publicationSchema) }, async (req, reply) => {
    const autonomousEnv = environment(req), userId = req.user!.sub
    if (req.body.clientId) {
      const previous = await prisma.communityHarness.findFirst({ where: { id: req.body.clientId, autonomousEnv, authorId: userId, deletedAt: null } })
      if (previous) return sendSuccess(reply, { id: previous.id }, 201)
    }
    const original = req.body.forkedFrom ? await publication(req.body.forkedFrom, autonomousEnv) : null
    if (req.body.forkedFrom && !original)
      return sendError(reply, 'The original harness is unavailable.', 'SOURCE_UNAVAILABLE', 400)
    if (await prisma.communityHarness.count({ where: { autonomousEnv, authorId: userId, createdAt: { gt: new Date(Date.now() - 60_000) } } }) >= 5)
      return sendError(reply, 'Please wait before publishing another harness.', 'RATE_LIMITED', 429)
    const { confirmed: _confirmed, license: _license, clientId, ...snapshot } = req.body
    const credits = original ? [...(Array.isArray(original.credits) ? original.credits : []), { id: original.id, authorName: original.authorName }] : []
    const data = { ...snapshot, credits, autonomousEnv, authorId: userId, authorName: await authorName(userId), deletedAt: null }
    let post
    try { post = await prisma.communityHarness.create({ data: { ...data, ...(clientId ? { id: clientId } : {}) } }) }
    catch (error) {
      if (!clientId || (error as { code?: string }).code !== 'P2002') throw error
      post = await prisma.communityHarness.findFirst({ where: { id: clientId, autonomousEnv, authorId: userId, deletedAt: null } })
      if (!post) return sendError(reply, 'This publication request is no longer available. Start a new draft.', 'CONFLICT', 409)
      return sendSuccess(reply, { id: post.id }, 201)
    }
    if (original && 'title' in original) {
      await notify(autonomousEnv, userId, [{ userId: original.authorId, kind: 'fork', harnessId: original.id, harnessTitle: original.title, actorName: data.authorName, targetId: post.id }])
    }
    sendSuccess(reply, { id: post.id }, 201)
  })

  app.delete<{ Params: z.infer<typeof params> }>('/api/community/harnesses/:id', { preHandler: validateParams(params) }, async (req, reply) => {
    const result = await prisma.communityHarness.updateMany({ where: { id: req.params.id, autonomousEnv: environment(req), authorId: req.user!.sub, deletedAt: null }, data: { deletedAt: new Date() } })
    if (!result.count) return sendError(reply, 'Publication not found.', 'NOT_FOUND', 404)
    sendSuccess(reply, { removed: true })
  })

  const likeBody = z.object({ liked: z.boolean() }).strict()
  app.put<{ Params: z.infer<typeof params>; Body: z.infer<typeof likeBody> }>('/api/community/harnesses/:id/like', { preHandler: [validateParams(params), validateBody(likeBody)] }, async (req, reply) => {
    const autonomousEnv = environment(req), harnessId = req.params.id, userId = req.user!.sub
    if (!await visiblePublication(harnessId, autonomousEnv, userId)) return sendError(reply, 'Harness not found.', 'NOT_FOUND', 404)
    sendSuccess(reply, { liked: req.body.liked, likes: await saveLike({ autonomousEnv, harnessId, userId }, req.body.liked) })
  })

  const commentBody = z.object({ body: z.string().trim().min(1).max(2000), clientId: z.string().uuid(), parentId: z.string().uuid().optional() }).strict()
  app.post<{ Params: z.infer<typeof params>; Body: z.infer<typeof commentBody> }>('/api/community/harnesses/:id/comments', { preHandler: [validateParams(params), validateBody(commentBody)] }, async (req, reply) => {
    const autonomousEnv = environment(req), harnessId = req.params.id, userId = req.user!.sub, clientId = req.body.clientId
    const post = await visiblePublication(harnessId, autonomousEnv, userId)
    if (!post) return sendError(reply, 'Harness not found.', 'NOT_FOUND', 404)
    const parent = req.body.parentId ? await prisma.communityComment.findFirst({ where: { id: req.body.parentId, harnessId, autonomousEnv } }) : null
    if (req.body.parentId && !parent) return sendError(reply, 'That comment is no longer available.', 'NOT_FOUND', 404)
    const key = { autonomousEnv, harnessId, userId, clientId }
    const existing = await prisma.communityComment.findUnique({ where: { autonomousEnv_harnessId_userId_clientId: key } })
    if (!existing && await prisma.communityComment.count({ where: { autonomousEnv, userId, createdAt: { gt: new Date(Date.now() - 60_000) } } }) >= 10)
      return sendError(reply, 'Please wait before adding another comment.', 'RATE_LIMITED', 429)
    const row = existing ?? await prisma.communityComment.upsert({ where: { autonomousEnv_harnessId_userId_clientId: key }, create: { ...key, body: req.body.body, authorName: await authorName(userId), parentId: parent?.id, parentAuthorName: parent?.authorName }, update: {} })
    // A retried post was told about the first time. A reply's comment writer hears of it as a reply, even when they made the harness.
    if (!existing && 'title' in post) {
      const where = { harnessId, harnessTitle: post.title, actorName: row.authorName, targetId: row.id }
      await notify(autonomousEnv, userId, [...(parent ? [{ ...where, userId: parent.userId, kind: 'reply' as const }] : []), { ...where, userId: post.authorId, kind: 'comment' }])
    }
    sendSuccess(reply, { comment: commentView(row, post.authorId, userId) })
  })

  const commentParams = params.extend({ commentId: z.string().uuid() })
  app.delete<{ Params: z.infer<typeof commentParams> }>('/api/community/harnesses/:id/comments/:commentId', { preHandler: validateParams(commentParams) }, async (req, reply) => {
    const autonomousEnv = environment(req), harnessId = req.params.id, userId = req.user!.sub
    const post = await publication(harnessId, autonomousEnv)
    if (!post) return sendError(reply, 'Harness not found.', 'NOT_FOUND', 404)
    const result = await prisma.communityComment.deleteMany({ where: { autonomousEnv, harnessId, id: req.params.commentId, ...(post.authorId === userId ? {} : { userId }) } })
    if (!result.count) return sendError(reply, 'Comment not found.', 'NOT_FOUND', 404)
    sendSuccess(reply, { removed: true })
  })

  const followBody = z.object({ following: z.boolean() }).strict()
  app.put<{ Params: z.infer<typeof params>; Body: z.infer<typeof followBody> }>('/api/community/creators/:id/follow', { preHandler: [validateParams(params), validateBody(followBody)] }, async (req, reply) => {
    const autonomousEnv = environment(req), authorId = req.params.id, userId = req.user!.sub
    if (authorId === userId) return sendError(reply, 'You cannot follow yourself.', 'INVALID_FOLLOW', 400)
    if (authorId !== 'harness' && !await prisma.communityHarness.findFirst({ where: { autonomousEnv, authorId, deletedAt: null } }))
      return sendError(reply, 'Creator not found.', 'NOT_FOUND', 404)
    const key = { autonomousEnv, authorId, userId }
    if (req.body.following) await prisma.communityFollow.upsert({ where: { autonomousEnv_authorId_userId: key }, create: key, update: {} })
    else await prisma.communityFollow.deleteMany({ where: key })
    sendSuccess(reply, { following: req.body.following })
  })
}

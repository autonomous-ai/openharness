import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { parseAutonomousEnvironment } from '../lib/autonomousEnvironment.js'
import { communityStarters } from '../lib/communityAccess.js'
import { validateBody, validateParams, validateQuery } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { ValidationError } from '../errors/index.js'

const identifier = z.string().regex(/^[a-z0-9-]{1,80}$/)
const params = z.object({ id: identifier })
const file = z.object({
  path: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,179}$/).refine(path =>
    !path.split('/').some(part => !part || part.startsWith('.') ||
      /^(?:harness\.json|AGENTS\.md|CLAUDE\.md|SESSION\.md|LICENSE|OPEN-HARNESS\.json|README\.md|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(part)), 'Use a relative project path, not a reserved bundle file.'),
  content: z.string().max(3_000_000),
  encoding: z.literal('base64').optional(),
}).strict()

export const publicationSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(300),
  category: z.enum(['Apps', 'Games', 'Motion', 'Music', 'Design', 'Data', 'Documents', 'Experiments']),
  engine: z.enum(['Codex', 'Claude Code', 'OpenCode', 'pi']),
  harnessId: z.enum(["autonomous/blender", "autonomous/marp", "autonomous/typst", "autonomous/circuitjs", "autonomous/godogen", "autonomous/jev-sheets", "autonomous/mujoco", "autonomous/rdkit", "autonomous/strudel"]).optional(),
  files: z.array(file).min(1).max(30),
  viewerPath: z.string().max(180),
  conversation: z.array(z.object({ role: z.enum(['user', 'assistant', 'tool']), text: z.string().min(1).max(12_000) }).strict()).min(1).max(80),
  cover: z.string().max(350_000).optional().refine(value => {
    if (!value) return true
    const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/)
    if (!match) return false
    const bytes = Buffer.from(match[2], 'base64')
    return match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  }, 'Use a PNG, JPEG, or WebP cover.'),
  forkedFrom: identifier.optional(),
  clientId: z.string().uuid().optional(),
  license: z.literal('MIT'),
  confirmed: z.literal(true),
}).strict().superRefine((value, ctx) => {
  for (const file of value.files) {
    if (file.encoding && (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.content) || file.content.length % 4 !== 0)) ctx.addIssue({ code: 'custom', message: 'Invalid binary file encoding.' })
    const lower = file.path.toLowerCase();
    if (value.files.some(other => other.path.toLowerCase().startsWith(`${lower}/`))) ctx.addIssue({ code: 'custom', message: 'A file cannot also be a directory.' })
  }
  if (new Set(value.files.map(f => f.path.toLowerCase())).size !== value.files.length)
    ctx.addIssue({ code: 'custom', message: 'Project paths must be unique.' })
  if (!value.viewerPath.endsWith('.html') || !value.files.some(f => f.path === value.viewerPath && !f.encoding))
    ctx.addIssue({ code: 'custom', message: 'Choose an included HTML file as the viewer.' })
  const marker = value.harnessId ? {"autonomous/blender": "scenes/hello.py", "autonomous/marp": "deck.md", "autonomous/typst": "main.typ", "autonomous/circuitjs": "circuit.txt", "autonomous/godogen": "studio.json", "autonomous/jev-sheets": "sheet.json", "autonomous/mujoco": "sim/hello.py", "autonomous/rdkit": "molecules/hello.py", "autonomous/strudel": "track.strudel"}[value.harnessId] : undefined
  if (marker && !value.files.some(file => file.path === marker && !file.encoding)) ctx.addIssue({ code: 'custom', message: 'Include the harness project source.' })
  if (Buffer.byteLength(JSON.stringify(value)) > 6_000_000)
    ctx.addIssue({ code: 'custom', message: 'Keep the published snapshot under 6 MB.' })
})

function environment(req: FastifyRequest): string {
  try { return req.user?.autonomousEnv ?? parseAutonomousEnvironment(req.headers['x-autonomous-env']) }
  catch { throw new ValidationError('Invalid Autonomous environment') }
}

async function authorName(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
  return user?.name?.trim().slice(0, 80) || 'Harness user'
}

async function publication(id: string, autonomousEnv: string) {
  if (communityStarters.has(id)) return { id, authorId: 'harness', authorName: 'Harness', credits: [] }
  return prisma.communityHarness.findFirst({ where: { id, autonomousEnv, deletedAt: null } })
}

export async function communityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_req, reply) => { reply.header('Cache-Control', 'no-store') })

  const feedQuery = z.object({ cursor: z.string().uuid().optional(), following: z.enum(['true', 'false']).optional(), mine: z.enum(['true', 'false']).optional() }).strict()
  app.get<{ Querystring: z.infer<typeof feedQuery> }>('/api/community/harnesses', { preHandler: validateQuery(feedQuery) }, async (req, reply) => {
    const autonomousEnv = environment(req)
    if ((req.query.following === 'true' || req.query.mine === 'true') && !req.user) return sendError(reply, 'Sign in to see your harnesses and creators you follow.', 'UNAUTHORIZED', 401)
    const follows = req.user ? await prisma.communityFollow.findMany({ where: { autonomousEnv, userId: req.user.sub }, select: { authorId: true } }) : []
    const rows = await prisma.communityHarness.findMany({
      where: { autonomousEnv, deletedAt: null, ...(req.query.following === 'true' ? { authorId: { in: follows.map(row => row.authorId) } } : {}), ...(req.query.mine === 'true' ? { authorId: req.user!.sub } : {}) },
      select: { id: true, title: true, description: true, category: true, engine: true, harnessId: true, authorId: true, authorName: true, cover: true, forkedFrom: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 31,
      ...(req.query.cursor ? { cursor: { id: req.query.cursor }, skip: 1 } : {}),
    })
    const ids = [...rows.slice(0, 30).map(row => row.id), ...communityStarters]
    const [likes, comments, liked] = await Promise.all([
      prisma.communityLike.groupBy({ by: ['harnessId'], where: { autonomousEnv, harnessId: { in: ids } }, _count: { _all: true } }),
      prisma.communityComment.groupBy({ by: ['harnessId'], where: { autonomousEnv, harnessId: { in: ids } }, _count: { _all: true } }),
      req.user ? prisma.communityLike.findMany({ where: { autonomousEnv, userId: req.user.sub, harnessId: { in: ids } }, select: { harnessId: true } }) : [],
    ])
    const stats = Object.fromEntries(ids.map(id => [id, { likes: likes.find(row => row.harnessId === id)?._count._all ?? 0, comments: comments.find(row => row.harnessId === id)?._count._all ?? 0, liked: liked.some(row => row.harnessId === id) }]))
    sendSuccess(reply, { harnesses: rows.slice(0, 30), stats, signedIn: !!req.user, nextCursor: rows.length > 30 ? rows[29].id : null, following: follows.map(row => row.authorId) })
  })

  app.get<{ Params: z.infer<typeof params> }>('/api/community/harnesses/:id', { preHandler: validateParams(params) }, async (req, reply) => {
    const autonomousEnv = environment(req), harnessId = req.params.id
    const post = await publication(harnessId, autonomousEnv)
    if (!post) return sendError(reply, 'This harness is unavailable.', 'NOT_FOUND', 404)
    const userId = req.user?.sub
    const [likes, liked, comments, follow] = await Promise.all([
      prisma.communityLike.count({ where: { autonomousEnv, harnessId } }),
      userId ? prisma.communityLike.findUnique({ where: { autonomousEnv_harnessId_userId: { autonomousEnv, harnessId, userId } } }) : null,
      prisma.communityComment.findMany({ where: { autonomousEnv, harnessId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 }),
      userId ? prisma.communityFollow.findUnique({ where: { autonomousEnv_authorId_userId: { autonomousEnv, authorId: post.authorId, userId } } }) : null,
    ])
    sendSuccess(reply, {
      harness: communityStarters.has(harnessId) ? null : post,
      social: { likes, liked: !!liked, following: !!follow, signedIn: !!userId, mine: post.authorId === userId,
        comments: comments.reverse().map(row => ({ id: row.id, body: row.body, authorName: row.authorName, createdAt: row.createdAt, parentId: row.parentId, parentAuthorName: row.parentAuthorName, creator: row.userId === post.authorId, mine: row.userId === userId || post.authorId === userId })) },
    })
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
    if (!await publication(harnessId, autonomousEnv)) return sendError(reply, 'Harness not found.', 'NOT_FOUND', 404)
    const key = { autonomousEnv, harnessId, userId }
    if (req.body.liked) await prisma.communityLike.upsert({ where: { autonomousEnv_harnessId_userId: key }, create: key, update: {} })
    else await prisma.communityLike.deleteMany({ where: key })
    sendSuccess(reply, { liked: req.body.liked, likes: await prisma.communityLike.count({ where: { autonomousEnv, harnessId } }) })
  })

  const commentBody = z.object({ body: z.string().trim().min(1).max(2000), clientId: z.string().uuid(), parentId: z.string().uuid().optional() }).strict()
  app.post<{ Params: z.infer<typeof params>; Body: z.infer<typeof commentBody> }>('/api/community/harnesses/:id/comments', { preHandler: [validateParams(params), validateBody(commentBody)] }, async (req, reply) => {
    const autonomousEnv = environment(req), harnessId = req.params.id, userId = req.user!.sub, clientId = req.body.clientId
    const post = await publication(harnessId, autonomousEnv)
    if (!post) return sendError(reply, 'Harness not found.', 'NOT_FOUND', 404)
    const parent = req.body.parentId ? await prisma.communityComment.findFirst({ where: { id: req.body.parentId, harnessId, autonomousEnv } }) : null
    if (req.body.parentId && !parent) return sendError(reply, 'That comment is no longer available.', 'NOT_FOUND', 404)
    const key = { autonomousEnv, harnessId, userId, clientId }
    const existing = await prisma.communityComment.findUnique({ where: { autonomousEnv_harnessId_userId_clientId: key } })
    if (!existing && await prisma.communityComment.count({ where: { autonomousEnv, userId, createdAt: { gt: new Date(Date.now() - 60_000) } } }) >= 10)
      return sendError(reply, 'Please wait before adding another comment.', 'RATE_LIMITED', 429)
    const row = existing ?? await prisma.communityComment.upsert({ where: { autonomousEnv_harnessId_userId_clientId: key }, create: { ...key, body: req.body.body, authorName: await authorName(userId), parentId: parent?.id, parentAuthorName: parent?.authorName }, update: {} })
    sendSuccess(reply, { comment: { id: row.id, body: row.body, authorName: row.authorName, createdAt: row.createdAt, parentId: row.parentId, parentAuthorName: row.parentAuthorName, creator: row.userId === post.authorId, mine: true } })
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

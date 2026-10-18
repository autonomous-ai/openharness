/**
 *   GET /api/community/harnesses/:id/comments?before=<commentId>   public → { comments, more }
 *
 * The comments before one a reader already has, the latest page of them, oldest first: a harness page
 * reads the latest page with its social state, and asks for these to read further back. `more` says
 * whether there are older ones still. A comment that has since been deleted anchors nothing.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { validateParams, validateQuery } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { hiddenFrom } from '../lib/communityReports.js'
import { commentPageSize, commentView, environment, visiblePublication } from './community.js'

const params = z.object({ id: z.string().regex(/^[a-z0-9-]{1,80}$/) })
const query = z.object({ before: z.string().uuid() }).strict()

export async function communityCommentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: z.infer<typeof params>; Querystring: z.infer<typeof query> }>('/api/community/harnesses/:id/comments', { preHandler: [validateParams(params), validateQuery(query)] }, async (req, reply) => {
    const autonomousEnv = environment(req), harnessId = req.params.id, before = req.query.before
    const post = await visiblePublication(harnessId, autonomousEnv, req.user?.sub)
    if (!post) return sendError(reply, 'This harness is unavailable.', 'NOT_FOUND', 404)
    const anchor = await prisma.communityComment.findFirst({ where: { id: before, harnessId, autonomousEnv }, select: { createdAt: true } })
    if (!anchor) return sendSuccess(reply, { comments: [], more: false })
    const { createdAt } = anchor
    const hidden = await hiddenFrom(autonomousEnv, 'comment', req.user?.sub, harnessId)
    const rows = await prisma.communityComment.findMany({
      where: { autonomousEnv, harnessId, ...(hidden.length ? { id: { notIn: hidden } } : {}), OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: before } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: commentPageSize + 1,
    })
    const page = rows.slice(0, commentPageSize).reverse()
    reply.header('Cache-Control', 'no-store')
    sendSuccess(reply, { comments: page.map(row => commentView(row, post.authorId, req.user?.sub)), more: rows.length > commentPageSize })
  })
}

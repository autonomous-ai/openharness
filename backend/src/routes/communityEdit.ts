/**
 *   PUT /api/community/harnesses/:id   SSO access token, the publication's author → { id }
 *
 * An author replaces what their publication shows (its output, source, conversation and details) in
 * place: the same address, likes, comments and forks. Forks already made keep their own copy. Where it
 * came from (`forkedFrom`, credits) stays as published, and a cover left out keeps the one it has.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { acceptGzipJson } from '../lib/gzipJson.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { validateBody, validateParams } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { environment, publicationEditSchema } from './community.js'

const params = z.object({ id: z.string().uuid() })
const limiter = createRateLimiter('community-edit', 10 * 60_000, 20)
export const resetEditRateLimits = (): void => limiter.reset()

export async function communityEditRoutes(app: FastifyInstance): Promise<void> {
  acceptGzipJson(app, 6_100_000)
  app.put<{ Params: z.infer<typeof params>; Body: z.infer<typeof publicationEditSchema> }>('/api/community/harnesses/:id', { bodyLimit: 6_100_000, preHandler: [validateParams(params), validateBody(publicationEditSchema)] }, async (req, reply) => {
    const autonomousEnv = environment(req), userId = req.user!.sub
    const post = await prisma.communityHarness.findFirst({ where: { id: req.params.id, autonomousEnv, deletedAt: null }, select: { authorId: true } })
    if (!post) return sendError(reply, 'This harness is unavailable.', 'NOT_FOUND', 404)
    if (post.authorId !== userId) return sendError(reply, 'Only its author can edit this harness.', 'FORBIDDEN', 403)
    if (!(await limiter.allows(userId))) return sendError(reply, 'Please wait before saving again.', 'RATE_LIMITED', 429)
    const { confirmed: _confirmed, license: _license, cover, harnessId, ...snapshot } = req.body
    await prisma.communityHarness.updateMany({
      where: { id: req.params.id, autonomousEnv, authorId: userId, deletedAt: null },
      data: { ...snapshot, harnessId: harnessId ?? null, ...(cover ? { cover } : {}), updatedAt: new Date() },
    })
    sendSuccess(reply, { id: req.params.id })
  })
}

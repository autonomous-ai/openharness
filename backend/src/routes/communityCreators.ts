/**
 *   GET /api/community/creators/:id   public → { creator: { id, name, followers, following } }
 *
 * A creator's page: the name their publications carry, how many follow them, and whether the reader
 * does. Their harnesses are the feed's (`?author=<id>`). Someone with nothing published is not a
 * creator here: an account's id names no one who has not chosen to publish. Harness, the starters'
 * creator, always is.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { communityStarterAuthor } from '../lib/communityAccess.js'
import { prisma } from '../lib/prisma.js'
import { validateParams } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { environment } from './community.js'

const params = z.object({ id: z.string().regex(/^[a-z0-9-]{1,80}$/) })

async function creatorName(authorId: string, autonomousEnv: string): Promise<string | null> {
  if (authorId === communityStarterAuthor) return 'Harness'
  const latest = await prisma.communityHarness.findFirst({ where: { autonomousEnv, authorId, deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { authorName: true } })
  return latest?.authorName ?? null
}

export async function communityCreatorRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: z.infer<typeof params> }>('/api/community/creators/:id', { preHandler: validateParams(params) }, async (req, reply) => {
    const autonomousEnv = environment(req), authorId = req.params.id, userId = req.user?.sub
    const [name, followers, follow] = await Promise.all([
      creatorName(authorId, autonomousEnv),
      prisma.communityFollow.count({ where: { autonomousEnv, authorId } }),
      userId ? prisma.communityFollow.findUnique({ where: { autonomousEnv_authorId_userId: { autonomousEnv, authorId, userId } } }) : null,
    ])
    if (!name) return sendError(reply, 'This creator is unavailable.', 'NOT_FOUND', 404)
    reply.header('Cache-Control', 'no-store')
    sendSuccess(reply, { creator: { id: authorId, name, followers, following: !!follow, mine: authorId === userId, signedIn: !!userId } })
  })
}

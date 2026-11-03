/**
 *   POST /api/community/reports          signed in → { reported: true }
 *   GET  /api/community/reports          admin → { reports }
 *   POST /api/community/reports/review   admin → { reviewed: true }
 *
 * A reader reports a publication or a comment with one fixed reason: it is hidden from them at once,
 * and from everyone once three readers have (lib/communityReports.ts). A reviewer sees what was
 * reported, and restores it (only later reports count again) or removes it (unpublished, or deleted).
 * Nobody reports their own work, or a starter, which is the Hub's own.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { communityStarters } from '../lib/communityAccess.js'
import { communityReportReasons, communityReportTargets, fileReport, type ReportTarget } from '../lib/communityReports.js'
import { prisma } from '../lib/prisma.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { requireAdmin } from '../middlewares/authMiddleware.js'
import { validateBody } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { environment, publication } from './community.js'

const target = { targetType: z.enum(communityReportTargets), targetId: z.string().regex(/^[a-z0-9-]{1,80}$/) }
const reportBody = z.object({ ...target, reason: z.enum(communityReportReasons) }).strict()
const reviewBody = z.object({ ...target, decision: z.enum(['restore', 'remove']) }).strict()
const limiter = createRateLimiter('community-report', 10 * 60_000, 20)
export const resetReportRateLimits = (): void => limiter.reset()

/** What a report is about: the publication it is on, and who made it (who may not report it). */
async function reported(targetType: ReportTarget, targetId: string, autonomousEnv: string) {
  if (targetType === 'comment') {
    const comment = await prisma.communityComment.findFirst({ where: { id: targetId, autonomousEnv }, select: { harnessId: true, userId: true } })
    return comment && { harnessId: comment.harnessId, authorId: comment.userId }
  }
  const post = communityStarters.has(targetId) ? null : await publication(targetId, autonomousEnv)
  return post && { harnessId: post.id, authorId: post.authorId }
}

/** The latest reported publications and comments, with their reasons and whether they are hidden. */
async function reviewQueue(autonomousEnv: string) {
  const groups = await prisma.communityReport.groupBy({
    by: ['targetType', 'targetId', 'harnessId'], where: { autonomousEnv }, _count: { _all: true }, _max: { createdAt: true },
    orderBy: { _max: { createdAt: 'desc' } }, take: 100,
  })
  const ids = groups.map(group => group.targetId)
  const [reasons, hidden, harnesses, comments] = await Promise.all([
    prisma.communityReport.groupBy({ by: ['targetId', 'reason'], where: { autonomousEnv, targetId: { in: ids } }, _count: { _all: true } }),
    prisma.communityHidden.findMany({ where: { autonomousEnv, targetId: { in: ids } }, select: { targetId: true, restoredAt: true } }),
    prisma.communityHarness.findMany({ where: { autonomousEnv, id: { in: ids } }, select: { id: true, title: true, authorName: true, deletedAt: true } }),
    prisma.communityComment.findMany({ where: { autonomousEnv, id: { in: ids } }, select: { id: true, body: true, authorName: true } }),
  ])
  const state = new Map(hidden.map(row => [row.targetId, row.restoredAt ? 'restored' : 'hidden']))
  const harnessById = new Map(harnesses.map(row => [row.id, row])), commentById = new Map(comments.map(row => [row.id, row]))
  return groups.map(group => {
    const harness = harnessById.get(group.targetId), comment = commentById.get(group.targetId)
    return {
      targetType: group.targetType, targetId: group.targetId, harnessId: group.harnessId, reports: group._count._all, lastReportedAt: group._max.createdAt,
      reasons: Object.fromEntries(reasons.filter(row => row.targetId === group.targetId).map(row => [row.reason, row._count._all])),
      state: harness?.deletedAt || (group.targetType === 'comment' && !comment) ? 'removed' : state.get(group.targetId) ?? 'visible',
      text: group.targetType === 'harness' ? harness?.title ?? null : comment?.body ?? null,
      authorName: harness?.authorName ?? comment?.authorName ?? null,
    }
  })
}

export async function communityReportRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: z.infer<typeof reportBody> }>('/api/community/reports', { preHandler: validateBody(reportBody) }, async (req, reply) => {
    const autonomousEnv = environment(req), userId = req.user!.sub, { targetType, targetId, reason } = req.body
    const about = await reported(targetType, targetId, autonomousEnv)
    if (!about) return sendError(reply, 'This is no longer available.', 'NOT_FOUND', 404)
    if (about.authorId === userId) return sendError(reply, 'You cannot report your own work.', 'INVALID_REPORT', 400)
    if (!(await limiter.allows(userId))) return sendError(reply, 'Please wait before reporting again.', 'RATE_LIMITED', 429)
    await fileReport({ autonomousEnv, targetType, targetId, harnessId: about.harnessId, userId, reason })
    sendSuccess(reply, { reported: true })
  })

  app.get('/api/community/reports', async (req, reply) => {
    requireAdmin(req)
    reply.header('Cache-Control', 'no-store')
    sendSuccess(reply, { reports: await reviewQueue(environment(req)) })
  })

  app.post<{ Body: z.infer<typeof reviewBody> }>('/api/community/reports/review', { preHandler: validateBody(reviewBody) }, async (req, reply) => {
    requireAdmin(req)
    const autonomousEnv = environment(req), { targetType, targetId, decision } = req.body
    const about = await reported(targetType, targetId, autonomousEnv)
    if (!about) return sendError(reply, 'This is no longer available.', 'NOT_FOUND', 404)
    if (decision === 'remove') {
      if (targetType === 'harness') await prisma.communityHarness.updateMany({ where: { id: targetId, autonomousEnv, deletedAt: null }, data: { deletedAt: new Date() } })
      else await prisma.communityComment.deleteMany({ where: { id: targetId, autonomousEnv } })
    } else {
      const key = { autonomousEnv, targetType, targetId }
      await prisma.communityHidden.upsert({ where: { autonomousEnv_targetType_targetId: key }, create: { ...key, harnessId: about.harnessId, restoredAt: new Date() }, update: { restoredAt: new Date() } })
    }
    sendSuccess(reply, { reviewed: true })
  })
}

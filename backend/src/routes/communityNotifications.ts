/**
 *   GET  /api/community/notifications          signed in → { notifications, unread }
 *   GET  /api/community/notifications/unread   signed in → { unread }
 *   POST /api/community/notifications/read     signed in → { read }
 *
 * A creator's bell: comments on their harnesses, replies to their comments and forks of their
 * harnesses (lib/communityNotifications.ts), the latest first. Opening them marks them read.
 */
import type { FastifyInstance } from 'fastify'
import { notificationPageSize } from '../lib/communityNotifications.js'
import { prisma } from '../lib/prisma.js'
import { sendSuccess } from '../utils/response.js'
import { environment } from './community.js'

export async function communityNotificationRoutes(app: FastifyInstance): Promise<void> {
  // Synchronous, as every header-only hook (middlewares/securityHeaders.ts).
  app.addHook('onSend', (_req, reply, payload, done) => { reply.header('Cache-Control', 'no-store'); done(null, payload) })
  const unread = (autonomousEnv: string, userId: string) => prisma.communityNotification.count({ where: { autonomousEnv, userId, readAt: null } })

  app.get('/api/community/notifications', async (req, reply) => {
    const autonomousEnv = environment(req), userId = req.user!.sub
    const [rows, count] = await Promise.all([
      prisma.communityNotification.findMany({ where: { autonomousEnv, userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: notificationPageSize }),
      unread(autonomousEnv, userId),
    ])
    const notifications = rows.map(({ id, kind, harnessId, harnessTitle, actorName, targetId, createdAt, readAt }) => ({ id, kind, harnessId, harnessTitle, actorName, targetId, createdAt, read: !!readAt }))
    sendSuccess(reply, { notifications, unread: count })
  })

  app.get('/api/community/notifications/unread', async (req, reply) => {
    sendSuccess(reply, { unread: await unread(environment(req), req.user!.sub) })
  })

  app.post('/api/community/notifications/read', async (req, reply) => {
    const result = await prisma.communityNotification.updateMany({ where: { autonomousEnv: environment(req), userId: req.user!.sub, readAt: null }, data: { readAt: new Date() } })
    sendSuccess(reply, { read: result.count })
  })
}

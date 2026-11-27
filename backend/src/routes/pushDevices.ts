import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { dropPushDevice } from '../push/devices.js'
import { validateBody } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { createRateLimiter } from '../lib/rateLimit.js'

/** Legacy phones unregister at sign-out; a loop meets this bound, nothing else. */
const CHANGES_PER_MINUTE = 20
const allowChange = createRateLimiter('push-devices', 60_000, CHANGES_PER_MINUTE)

/** An APNs token is hex; an FCM token is base64url with a colon. Either fits in 4096 characters. */
const body = z.object({
  platform: z.enum(['ios', 'android']),
  token: z.string().min(1).max(4096).regex(/^[A-Za-z0-9:_-]+$/),
}).strict()

/**
 * Swarm push is gone. Keep this exact POST contract so older mobile clients can unregister their own token.
 * Remove only after supported callers are gone and at least 30 days after the last push-enabled supported client
 * (2026-12-16 at the earliest). Token registration is refused by gone.ts; the existing TTL expires records left behind.
 */
export async function pushDeviceRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: z.infer<typeof body> }>('/api/push-devices/drop', { preHandler: validateBody(body) }, async (req, reply) => {
    const user = req.user!
    if (!(await allowChange.allows(user.sub))) return sendError(reply, 'Too many changes to this phone\'s notifications. Try again in a minute.', 'RATE_LIMITED', 429)
    sendSuccess(reply, { dropped: await dropPushDevice(prisma, user.sub, req.body) })
  })
}

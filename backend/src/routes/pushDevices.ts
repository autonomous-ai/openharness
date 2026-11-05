import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { dropPushDevice, registerPushDevice } from '../push/devices.js'
import { validateBody } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { isTeamSession, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE } from '../lib/teamSession.js'
import { createRateLimiter } from '../lib/rateLimit.js'

/** A phone registers at each signed-in launch and when its token changes, and drops it at sign-out: a loop meets this, nothing else. */
const CHANGES_PER_MINUTE = 20
const allowChange = createRateLimiter('push-devices', 60_000, CHANGES_PER_MINUTE)

/** An APNs token is hex; an FCM token is base64url with a colon. Either fits in 4096 characters. */
const body = z.object({
  platform: z.enum(['ios', 'android']),
  token: z.string().min(1).max(4096).regex(/^[A-Za-z0-9:_-]+$/),
}).strict()

/**
 * A phone's push token for the signed-in person (push/devices.ts, task #2905): kept at sign-in, so a thread reply or a tag
 * reaches the phone while the app is closed, and dropped at sign-out, while the sign-in still works to say so. Never a team
 * session's (lib/teamSession.ts): a teammate's work on the person's Mac never gets the person's notices.
 */
export async function pushDeviceRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: z.infer<typeof body> }>('/api/push-devices', { preHandler: validateBody(body) }, async (req, reply) => {
    const user = req.user!
    if (isTeamSession(user)) return sendError(reply, TEAM_SESSION_MESSAGE, TEAM_SESSION_LIMITED, 403)
    if (!(await allowChange.allows(user.sub))) return sendError(reply, 'Too many changes to this phone\'s notifications. Try again in a minute.', 'RATE_LIMITED', 429)
    await registerPushDevice(prisma, user.sub, req.body, Date.now())
    sendSuccess(reply, { ok: true })
  })

  app.post<{ Body: z.infer<typeof body> }>('/api/push-devices/drop', { preHandler: validateBody(body) }, async (req, reply) => {
    const user = req.user!
    if (!(await allowChange.allows(user.sub))) return sendError(reply, 'Too many changes to this phone\'s notifications. Try again in a minute.', 'RATE_LIMITED', 429)
    sendSuccess(reply, { dropped: await dropPushDevice(prisma, user.sub, req.body) })
  })
}

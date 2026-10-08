import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { appendDeviceKey, deviceKeysSeen, readDeviceKeyLog, touchDeviceKey } from '../lib/deviceKeyLog.js'
import { validateBody, validateQuery } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'

const query = z.object({
  since: z.coerce.number().int().min(0).default(0),
  // The reading device's own key: reading the log counts as the key being in use, so an app that is
  // opened but never opens a session is not offered for removal. Anything else is ignored, not
  // refused — the read must work the same with or without it.
  self: z.string().optional().catch(undefined),
})

/** Appends per account per minute, per process — a viewer appends its key once per sign-in and a
 *  removal when someone asks. Generous for that; a loop cannot rebuild the log on every request. */
const APPENDS_PER_MINUTE = 20
const appendWindows = new Map<string, { start: number; count: number }>()
function allowAppend(userId: string, now = Date.now()): boolean {
  const w = appendWindows.get(userId)
  if (!w || now - w.start >= 60_000) {
    if (appendWindows.size >= 10_000) appendWindows.clear()
    appendWindows.set(userId, { start: now, count: 1 })
    return true
  }
  return ++w.count <= APPENDS_PER_MINUTE
}
const body = z.object({ entry: z.record(z.string(), z.unknown()) }).strict()

/**
 * The account's device key log (lib/deviceKeyLog.ts), for the viewer apps: read it from a head, append a
 * viewer's own key or a viewer-signed removal. Machines append over their adapter socket instead
 * (`devlog_append`), which is what ties an entry to the machine that sent it.
 *
 * A Harness session (a phone signed in by a QR) may append: that phone is one of the account's devices.
 */
export async function deviceKeyRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: z.infer<typeof query> }>('/api/device-keys', { preHandler: validateQuery(query) }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (req.query.self !== undefined) touchDeviceKey(req.user!.sub, req.query.self)
    sendSuccess(reply, await readDeviceKeyLog(req.user!.sub, req.query.since))
  })

  // When each key last opened a session — a hint for the Devices list, which offers to remove apps not
  // seen in a long while (a browser whose data was cleared never signs its own removal) — and `since`,
  // when that record began. A Redis that cannot be read is an error, never `{seen: {}}`: a machine's
  // sweep read that empty answer as "no app used in months" and would remove every old app key.
  app.get('/api/device-keys/seen', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      sendSuccess(reply, await deviceKeysSeen(req.user!.sub))
    } catch {
      sendError(reply, 'When your devices were last used cannot be read right now.', 'SEEN_UNAVAILABLE', 503)
    }
  })

  app.post<{ Body: z.infer<typeof body> }>('/api/device-keys', { preHandler: validateBody(body) }, async (req, reply) => {
    const user = req.user!
    if (!allowAppend(user.sub)) return sendError(reply, 'Too many changes to your devices. Try again in a minute.', 'RATE_LIMITED', 429)
    const result = await appendDeviceKey(user.sub, req.body.entry, { kind: 'viewer', harnessSessionId: user.harnessSessionId })
    if (result.ok) return sendSuccess(reply, { head: result.head })
    if (result.status === 409) {
      return reply.code(409).send({ success: false, error: { code: result.code, message: 'The log moved on; read it again.' }, data: { head: result.head } })
    }
    sendError(reply, 'This entry was refused.', result.code, result.status)
  })
}

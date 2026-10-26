import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { appendDeviceAck, appendDeviceKey, deviceKeysSeen, readDeviceAcks, readDeviceKeyLog, touchDeviceKey } from '../lib/deviceKeyLog.js'
import { validateBody, validateQuery } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { isTeamSession, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE } from '../lib/teamSession.js'

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
/** At most [perMinute] calls per account per minute, per process. */
function limiter(perMinute: number): (userId: string, now?: number) => boolean {
  const windows = new Map<string, { start: number; count: number }>()
  return (userId, now = Date.now()) => {
    const w = windows.get(userId)
    if (!w || now - w.start >= 60_000) {
      if (windows.size >= 10_000) windows.clear()
      windows.set(userId, { start: now, count: 1 })
      return true
    }
    return ++w.count <= perMinute
  }
}
const allowAppend = limiter(APPENDS_PER_MINUTE)
// An acknowledgement is one "It's mine" a person pressed, on one device: the same budget, kept apart so
// confirming devices never costs the log its appends. Each one replays the log to check it.
const allowAck = limiter(APPENDS_PER_MINUTE)
const body = z.object({ entry: z.record(z.string(), z.unknown()) }).strict()
const acksQuery = z.object({ since: z.coerce.number().int().min(0).default(0) })
const ackBody = z.object({ ack: z.record(z.string(), z.unknown()) }).strict()

/**
 * The account's device key log (lib/deviceKeyLog.ts), for the viewer apps: read it from a head, append a
 * viewer's own key or a viewer-signed removal. Machines append over their adapter socket instead
 * (`devlog_append`), which is what ties an entry to the machine that sent it. Beside the log, for every
 * device: the acknowledgements ("It's mine") of keys on it.
 *
 * A Harness session (a phone signed in by a QR) may append: that phone is one of the account's devices.
 */
export async function deviceKeyRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: z.infer<typeof query> }>('/api/device-keys', { preHandler: validateQuery(query) }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    // Not for a team account (lib/teamSession.ts): it would keep any key of the person's looking in use, out of the sweeps.
    if (req.query.self !== undefined && !isTeamSession(req.user)) touchDeviceKey(req.user!.sub, req.query.self)
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
    // A key added here is one the account's machines let in as an app: never a team account's (lib/teamSession.ts),
    // whichever gate it came through. Its machine key goes over its own socket, which keeps it to that machine.
    if (isTeamSession(user)) return sendError(reply, TEAM_SESSION_MESSAGE, TEAM_SESSION_LIMITED, 403)
    if (!allowAppend(user.sub)) return sendError(reply, 'Too many changes to your devices. Try again in a minute.', 'RATE_LIMITED', 429)
    const result = await appendDeviceKey(user.sub, req.body.entry, { kind: 'viewer', harnessSessionId: user.harnessSessionId })
    if (result.ok) return sendSuccess(reply, { head: result.head })
    if (result.status === 409) {
      return reply.code(409).send({ success: false, error: { code: result.code, message: 'The log moved on; read it again.' }, data: { head: result.head } })
    }
    sendError(reply, 'This entry was refused.', result.code, result.status)
  })

  // "It's mine", once for the account (lib/deviceAckCore.ts): a device's signed acknowledgement that a key
  // on the log is the person's own, so the other devices stop showing it as New. Its own route beside the
  // log, never an entry in it: a client that predates it never asks, never sees one, and keeps working
  // as before. A device asks from just below the oldest key it still shows as New (`since`, an entry seq).
  app.get<{ Querystring: z.infer<typeof acksQuery> }>('/api/device-keys/acks', { preHandler: validateQuery(acksQuery) }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    sendSuccess(reply, await readDeviceAcks(req.user!.sub, req.query.since))
  })

  // Machines and apps alike: an acknowledgement's authority is its signature by a key active on the log,
  // which every device checks itself, so the channel it came over adds nothing.
  app.post<{ Body: z.infer<typeof ackBody> }>('/api/device-keys/acks', { preHandler: validateBody(ackBody) }, async (req, reply) => {
    const user = req.user!
    // "It's mine" is the person's word: a team account never vouches for a key on the person's devices.
    if (isTeamSession(user)) return sendError(reply, TEAM_SESSION_MESSAGE, TEAM_SESSION_LIMITED, 403)
    if (!allowAck(user.sub)) return sendError(reply, 'Too many changes to your devices. Try again in a minute.', 'RATE_LIMITED', 429)
    const result = await appendDeviceAck(user.sub, req.body.ack)
    if (result.ok) return sendSuccess(reply, { created: result.created })
    sendError(reply, 'This acknowledgement was refused.', result.code, result.status)
  })
}

import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  answerQrSignIn, cancelQrSignIn, claimQrSignIn, extendQrSignIn, isSpokenCode, issueBoxTicket, lookupQrSignIn, pollQrSignIn,
  recordSpokenCodeMiss, spokenCodeGuessesLeft, startQrSignIn,
} from '../lib/harnessSession.js'
import { clientIpFromHeaders, countryCodeFromHeaders } from '../lib/clientGeo.js'
import { validateBody } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { logger } from '../utils/logger.js'
import { createHash } from 'node:crypto'
import { createRateLimiter } from '../lib/rateLimit.js'

/**
 * Sign a computer in by scanning its QR with a signed-in phone (lib/harnessSession.ts has the flow).
 * The computer's half — start, poll, extend, claim, cancel — carries no sign-in, only its poll token;
 * the phone's half — lookup, approve, deny — carries the phone's, whatever kind it is.
 */

const start = z.object({
  label: z.string().trim().min(1).max(80),
  kind: z.enum(['computer', 'viewer']),
  // A computer names the computer it is, so the session it gets is one; an app does not.
  computerId: z.string().regex(/^[0-9a-fA-F-]{16,64}$/).optional(),
  // A device with no screen asks for a code it can say aloud (lib/harnessSession.ts).
  spokenCode: z.boolean().optional(),
}).strict()
const byCode = z.object({ code: z.string().min(1).max(128) }).strict()
const byPoll = z.object({ pollToken: z.string().min(1).max(128) }).strict()
const noBody = z.object({}).strict()

/** Fixed windows every pod counts together (lib/rateLimit.ts): generous for a person, a wall for a loop. */
const startLimit = createRateLimiter('qr-start', 60_000, 10)
const pollLimit = createRateLimiter('qr-poll', 60_000, 90)
const answerLimit = createRateLimiter('qr-answer', 60_000, 20)
const ticketLimit = createRateLimiter('qr-ticket', 60_000, 10)
/** A poll token is a credential: it is counted by its digest, never written into a shared key. */
const pollKey = (pollToken: string): string => createHash('sha256').update(pollToken).digest('hex').slice(0, 32)

const unavailable = (reply: FastifyReply, e: unknown, what: string) => {
  logger.error(`qr sign-in ${what} failed`, e)
  return sendError(reply, 'Authentication service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
}
const tooMany = (reply: FastifyReply) => sendError(reply, 'Too many tries. Wait a minute.', 'RATE_LIMITED', 429)
const tooManyWrongCodes = (reply: FastifyReply) =>
  sendError(reply, 'Too many wrong codes. Try again in an hour.', 'SPOKEN_CODE_LIMITED', 429)
/** A spoken code that matches nothing: said as a typo, never "scan again", and counted against the account. */
const noSuchCode = async (reply: FastifyReply, userId: string, code: string) => {
  if (!isSpokenCode(code)) return sendError(reply, 'That code has expired. Scan the new one.', 'QR_INVALID', 404)
  await recordSpokenCodeMiss(userId)
  return sendError(reply, 'No device is waiting with that code. Check the digits, or ask the device for a new one.', 'QR_INVALID', 404)
}

export async function qrSignInRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: z.infer<typeof start> }>('/api/auth/qr/start', { preHandler: validateBody(start) }, async (req, reply) => {
    const ip = clientIpFromHeaders(req.headers, req.socket.remoteAddress)
    if (!(await startLimit.allows(ip ?? 'unknown'))) return tooMany(reply)
    if (req.body.kind === 'computer' && !req.body.computerId) {
      return sendError(reply, 'A computer names itself to sign in.', 'COMPUTER_ID_REQUIRED', 400)
    }
    // A spoken code is for a device with no screen signing itself in; an app always has a screen for a QR.
    if (req.body.spokenCode && req.body.kind !== 'computer') {
      return sendError(reply, 'Only a device signing itself in can ask for a spoken code.', 'SPOKEN_CODE_COMPUTER_ONLY', 400)
    }
    try {
      return sendSuccess(reply, await startQrSignIn(req.body, { ...(ip ? { ip } : {}), ...(countryCodeFromHeaders(req.headers) ? { country: countryCodeFromHeaders(req.headers) } : {}) }))
    } catch (e) { return unavailable(reply, e, 'start') }
  })

  app.post<{ Body: z.infer<typeof byPoll> }>('/api/auth/qr/poll', { preHandler: validateBody(byPoll) }, async (req, reply) => {
    if (!(await pollLimit.allows(pollKey(req.body.pollToken)))) return tooMany(reply)
    try { return sendSuccess(reply, await pollQrSignIn(req.body.pollToken)) } catch (e) { return unavailable(reply, e, 'poll') }
  })

  app.post<{ Body: z.infer<typeof byPoll> }>('/api/auth/qr/extend', { preHandler: validateBody(byPoll) }, async (req, reply) => {
    if (!(await pollLimit.allows(pollKey(req.body.pollToken)))) return tooMany(reply)
    try {
      const expiresIn = await extendQrSignIn(req.body.pollToken)
      if (expiresIn === null) return sendError(reply, 'This code has expired.', 'QR_EXPIRED', 410)
      return sendSuccess(reply, { expiresIn })
    } catch (e) { return unavailable(reply, e, 'extend') }
  })

  app.post<{ Body: z.infer<typeof byPoll> }>('/api/auth/qr/claim', { preHandler: validateBody(byPoll) }, async (req, reply) => {
    if (!(await pollLimit.allows(pollKey(req.body.pollToken)))) return tooMany(reply)
    try {
      const tokens = await claimQrSignIn(req.body.pollToken)
      if (!tokens) return sendError(reply, 'Nothing to claim: scan again.', 'QR_INVALID', 401)
      logger.info('qr sign-in claimed', { kind: tokens.kind })
      return sendSuccess(reply, tokens)
    } catch (e) { return unavailable(reply, e, 'claim') }
  })

  app.post<{ Body: z.infer<typeof byPoll> }>('/api/auth/qr/cancel', { preHandler: validateBody(byPoll) }, async (req, reply) => {
    try { await cancelQrSignIn(req.body.pollToken); return sendSuccess(reply, { cancelled: true }) } catch (e) { return unavailable(reply, e, 'cancel') }
  })

  // The phone's half.
  app.post<{ Body: z.infer<typeof byCode> }>('/api/auth/qr/lookup', { preHandler: validateBody(byCode) }, async (req, reply) => {
    const userId = req.user!.sub
    if (!(await answerLimit.allows(userId))) return tooMany(reply)
    try {
      if (isSpokenCode(req.body.code) && !(await spokenCodeGuessesLeft(userId))) return tooManyWrongCodes(reply)
      const ip = clientIpFromHeaders(req.headers, req.socket.remoteAddress)
      const found = await lookupQrSignIn(req.body.code, ip ? { ip } : {})
      if (!found) return await noSuchCode(reply, userId, req.body.code)
      return sendSuccess(reply, found)
    } catch (e) { return unavailable(reply, e, 'lookup') }
  })

  const answer = (approve: boolean) => async (req: { body: z.infer<typeof byCode>; user?: { sub: string; email: string } }, reply: FastifyReply) => {
    const user = req.user!
    if (!(await answerLimit.allows(user.sub))) return tooMany(reply)
    try {
      if (isSpokenCode(req.body.code) && !(await spokenCodeGuessesLeft(user.sub))) return tooManyWrongCodes(reply)
      const out = await answerQrSignIn(req.body.code, approve ? { approve: true, userId: user.sub, email: user.email } : { approve: false })
      if (out === 'gone') return await noSuchCode(reply, user.sub, req.body.code)
      if (out === 'answered') return sendError(reply, 'This code was already answered.', 'QR_ANSWERED', 409)
      logger.info(`qr sign-in ${approve ? 'approved' : 'denied'}`, { userId: user.sub })
      return sendSuccess(reply, { ok: true })
    } catch (e) { return unavailable(reply, e, approve ? 'approve' : 'deny') }
  }
  app.post<{ Body: z.infer<typeof byCode> }>('/api/auth/qr/approve', { preHandler: validateBody(byCode) }, answer(true))
  app.post<{ Body: z.infer<typeof byCode> }>('/api/auth/qr/deny', { preHandler: validateBody(byCode) }, answer(false))

  // A headless box: the phone approves before there is a code to scan, and hands the box the ticket.
  app.post('/api/auth/box/ticket', { preHandler: validateBody(noBody) }, async (req, reply) => {
    const user = req.user!
    if (!(await ticketLimit.allows(user.sub))) return tooMany(reply)
    try {
      const out = await issueBoxTicket(user.sub, user.email)
      logger.info('box ticket issued', { userId: user.sub })
      return sendSuccess(reply, out)
    } catch (e) { return unavailable(reply, e, 'ticket') }
  })
}

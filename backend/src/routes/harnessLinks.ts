import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma, machineAlive } from '../lib/prisma.js'
import { getAgentPresenceMany, publishShareChanged } from '../lib/bus.js'
import { machineBillingAllowsDataPlane } from '../lib/billingState.js'
import { parseAutonomousEnvironment, type AutonomousEnvironment } from '../lib/autonomousEnvironment.js'
import { validateBody, validateParams } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import type { AuthUser } from '../lib/ssoAuth.js'

const params = z.object({ id: z.string().uuid() })
const body = z.object({
  machineId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), agentId: z.string().min(1).max(160),
  name: z.string().trim().min(1).max(160), engine: z.string().max(64).nullable(),
  ownerPublicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/), visibility: z.enum(['public', 'private']),
}).strict()

/** Both HTTP discovery and live observer admission apply this policy. No email list is exposed. */
export async function recipientLink(id: string, user: AuthUser | null, autonomousEnv: AutonomousEnvironment) {
  const link = await prisma.harnessLink.findFirst({ where: { id, autonomousEnv, revokedAt: null } })
  if (!link || user && user.autonomousEnv !== autonomousEnv) return null
  if (link.visibility !== 'public') {
    if (!user) return null
    if (user.sub !== link.ownerId && !await prisma.harnessShare.findFirst({ where: {
      machineId: link.machineId, agentId: link.agentId, ownerId: link.ownerId, autonomousEnv,
      recipientEmail: user.email.trim().toLowerCase(), revokedAt: null, expiresAt: { gt: new Date() },
    } })) return null
  }
  const machine = await prisma.machine.findFirst({ where: {
    machineId: link.machineId, userId: link.ownerId, autonomousEnv, ...machineAlive,
  } })
  return machine && machineBillingAllowsDataPlane(machine) ? link : null
}

export async function harnessLinkRoutes(app: FastifyInstance): Promise<void> {
  // This one GET is optionally authenticated; mutations below retain the global SSO gate.
  app.get<{ Params: z.infer<typeof params> }>('/api/shared-agents/:id',
    { preHandler: validateParams(params) }, async (req, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
      let autonomousEnv: AutonomousEnvironment
      try { autonomousEnv = parseAutonomousEnvironment(req.headers['x-autonomous-env']) }
      catch { return sendError(reply, 'Invalid Autonomous environment.', 'INVALID_AUTONOMOUS_ENV', 400) }
      const link = await recipientLink(req.params.id, req.user ?? null, autonomousEnv)
      if (!link) return sendError(reply, req.user ? 'This link is unavailable or your email has not been invited.'
        : 'Sign in with an invited email to open a private link.', req.user ? 'FORBIDDEN' : 'SIGN_IN_REQUIRED', req.user ? 403 : 401)
      const presence = await getAgentPresenceMany([link.machineId])
      sendSuccess(reply, { id: link.id, machineId: link.machineId, agentId: link.agentId, name: link.name,
        engine: link.engine, ownerPublicKey: link.ownerPublicKey, visibility: link.visibility,
        online: !!presence.get(link.machineId), canComment: !!req.user })
    })

  app.put<{ Params: z.infer<typeof params>; Body: z.infer<typeof body> }>('/api/harness-links/:id',
    { preHandler: [validateParams(params), validateBody(body)] }, async (req, reply) => {
      const user = req.user!, input = req.body
      const machine = await prisma.machine.findFirst({ where: {
        machineId: input.machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive,
      } })
      if (!machine || !machineBillingAllowsDataPlane(machine)) return sendError(reply, 'This machine is not available to share.', 'FORBIDDEN', 403)
      const old = await prisma.harnessLink.findUnique({ where: { id: req.params.id } })
      if (old && (old.ownerId !== user.sub || old.machineId !== input.machineId || old.agentId !== input.agentId
        || old.autonomousEnv !== user.autonomousEnv)) return sendError(reply, 'This link cannot be changed.', 'FORBIDDEN', 403)
      const data = { ...input, ownerId: user.sub, autonomousEnv: user.autonomousEnv, revokedAt: null }
      await prisma.harnessLink.upsert({ where: { id: req.params.id }, create: { id: req.params.id, ...data }, update: data })
      await publishShareChanged(req.params.id)
      sendSuccess(reply, { id: req.params.id })
    })

  app.delete<{ Params: z.infer<typeof params> }>('/api/harness-links/:id',
    { preHandler: validateParams(params) }, async (req, reply) => {
      const changed = await prisma.harnessLink.updateMany({ where: {
        id: req.params.id, ownerId: req.user!.sub, autonomousEnv: req.user!.autonomousEnv,
      }, data: { revokedAt: new Date() } })
      if (!changed.count) return sendError(reply, 'Link not found.', 'NOT_FOUND', 404)
      await publishShareChanged(req.params.id)
      sendSuccess(reply, { removed: true })
    })
}

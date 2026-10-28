import type { FastifyInstance } from 'fastify'
import { Prisma, type PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { SuperTabStore } from '../superTabs/store.js'
import { prisma, machineAlive } from '../lib/prisma.js'
import { getAgentPresenceMany, publishDeviceMachineListChanged, publishShareChanged } from '../lib/bus.js'
import { machineBillingAllowsDataPlane } from '../lib/billingState.js'
import { validateBody, validateParams } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import type { AuthUser } from '../lib/ssoAuth.js'
import { TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, teamMachineScope } from '../lib/teamSession.js'

const params = z.object({ id: z.string().uuid() })
const body = z.object({
  superTabId: z.string().regex(/^[a-f0-9]{24}$/).nullable().optional(),
  machineId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  agentId: z.string().min(1).max(160),
  recipientEmail: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(160),
  engine: z.string().max(64).nullable(),
  ownerPublicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  expiresAt: z.string().datetime().refine(value => {
    const delta = Date.parse(value) - Date.now()
    return delta > 0 && delta <= 91 * 24 * 60 * 60_000
  }, 'Choose an expiry within 90 days.'),
}).strict()

/** Used again at socket admission and throughout a live connection. Never disclose another grant. */
/**
 * Shared harnesses arrive in the invited account's machine list, so an invitation given or taken back
 * is a list change for THAT account: poke its open apps (web tabs, and each computer's daemon → app)
 * to re-read. This is what lets the app stop polling `/api/harness-shares` to discover invitations.
 * Best effort — the invitation is already persisted, and an address with no account has nobody to tell.
 */
async function tellRecipient(shareId: string): Promise<void> {
  try {
    const share = await prisma.harnessShare.findUnique({ where: { id: shareId } })
    if (!share) return
    const recipient = await prisma.user.findUnique({ where: { email: share.recipientEmail }, select: { id: true } })
    if (recipient) await publishDeviceMachineListChanged(recipient.id, { reason: 'updated' })
  } catch { /* best effort */ }
}

export async function recipientShare(id: string, user: AuthUser, db: PrismaClient = prisma) {
  const share = await db.harnessShare.findFirst({ where: {
    id, recipientEmail: user.email.trim().toLowerCase(), autonomousEnv: user.autonomousEnv,
    revokedAt: null, expiresAt: { gt: new Date() },
  } })
  if (!share) return null
  const machine = await db.machine.findFirst({ where: {
    machineId: share.machineId, userId: share.ownerId, autonomousEnv: user.autonomousEnv, ...machineAlive,
  } })
  if (!machine || !machineBillingAllowsDataPlane(machine)) return null
  if (!await new SuperTabStore(db).mayOpenShare(user, share)) return null
  return share
}

export async function harnessShareRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/harness-shares', async (req, reply) => {
    const shares = await prisma.harnessShare.findMany({ where: {
      recipientEmail: req.user!.email.trim().toLowerCase(), autonomousEnv: req.user!.autonomousEnv,
      revokedAt: null, expiresAt: { gt: new Date() },
    }, orderBy: { createdAt: 'asc' }, take: 1000 })
    const visible: typeof shares = []
    for (const share of shares) {
      if (await new SuperTabStore(prisma).mayOpenShare(req.user!, share)) visible.push(share)
    }
    const machines = await prisma.machine.findMany({ where: {
      machineId: { in: [...new Set(visible.map(s => s.machineId))] },
      autonomousEnv: req.user!.autonomousEnv, ...machineAlive,
    } })
    const allowed = machines.filter(machineBillingAllowsDataPlane)
    const owners = await prisma.user.findMany({ where: { id: { in: [...new Set(allowed.map(m => m.userId))] } },
      select: { id: true, name: true, email: true } })
    const presence = await getAgentPresenceMany(allowed.map(m => m.machineId))
    sendSuccess(reply, { machines: allowed.flatMap(machine => {
      const grants = visible.filter(s => s.machineId === machine.machineId && s.ownerId === machine.userId)
      if (grants.length === 0) return []
      const owner = owners.find(o => o.id === machine.userId)
      return [{ machineId: machine.machineId, name: machine.name, authMode: 'remote',
        status: presence.get(machine.machineId) ? 'running' : 'offline',
        shared: true, ownerName: owner?.name || owner?.email || 'Harness user',
        shares: grants.map(s => ({ id: s.id, agentId: s.agentId, name: s.name, engine: s.engine,
          ownerPublicKey: s.ownerPublicKey, expiresAt: s.expiresAt.toISOString() })) }]
    }) })
  })

  app.put<{ Params: z.infer<typeof params>; Body: z.infer<typeof body> }>(
    '/api/harness-shares/:id', { preHandler: [validateParams(params), validateBody(body)] },
    async (req, reply) => {
      const input = req.body
      // A Mac's team account (lib/teamSession.ts) shares only its own machine's harnesses, and only with a Swarm's
      // members, whom the observer socket checks again on every connection.
      const team = await teamMachineScope(req.user!)
      if (team !== null && (input.machineId !== team || !input.superTabId)) {
        return sendError(reply, TEAM_SESSION_MESSAGE, TEAM_SESSION_LIMITED, 403)
      }
      const machine = await prisma.machine.findFirst({ where: {
        machineId: input.machineId, userId: req.user!.sub, autonomousEnv: req.user!.autonomousEnv, ...machineAlive,
      } })
      if (!machine || !machineBillingAllowsDataPlane(machine)) {
        return sendError(reply, 'This machine is not available to share.', 'FORBIDDEN', 403)
      }
      if (input.recipientEmail === req.user!.email.trim().toLowerCase()) {
        return sendError(reply, 'You already own this harness.', 'SELF_INVITE', 400)
      }
      const existing = await prisma.harnessShare.findUnique({ where: { id: req.params.id } })
      if (existing && (existing.ownerId !== req.user!.sub || existing.machineId !== input.machineId
        || existing.agentId !== input.agentId || existing.recipientEmail !== input.recipientEmail)) {
        return sendError(reply, 'This invitation cannot be changed.', 'FORBIDDEN', 403)
      }
      const data = { ...input, superTabId: input.superTabId ?? null, expiresAt: new Date(input.expiresAt), revokedAt: null,
        ownerId: req.user!.sub, autonomousEnv: req.user!.autonomousEnv }
      try {
        await prisma.harnessShare.upsert({ where: { id: req.params.id },
          create: { id: req.params.id, ...data }, update: data })
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
        // This machine, agent and recipient already have an invitation under another id: a daemon that lost its grants
        // file sends a new one, and a 500 had it retry forever (Diego's issue file, 2026-10-27). It is named only to its owner.
        const taken = await prisma.harnessShare.findFirst({ where: { machineId: input.machineId, agentId: input.agentId,
          recipientEmail: input.recipientEmail }, select: { id: true, ownerId: true } })
        return sendError(reply, 'This harness is already shared with that person.', 'SHARE_EXISTS', 409,
          taken?.ownerId === req.user!.sub ? { id: taken.id } : undefined)
      }
      // Told only when what the recipient sees changes. A renewal moves only the expiry, and an owner daemon that
      // renewed every few seconds (diego@'s 0.4.55 dev build, 2026-10-26) poked every member's every app to re-read
      // its machines and shares three times a second, with the backend pinned at its CPU limit.
      if (!existing || existing.revokedAt != null || existing.name !== data.name || existing.engine !== data.engine
        || (existing.superTabId ?? null) !== data.superTabId || existing.ownerPublicKey !== data.ownerPublicKey) {
        await publishShareChanged(req.params.id)
        await tellRecipient(req.params.id)
      }
      sendSuccess(reply, { id: req.params.id })
    },
  )

  app.delete<{ Params: z.infer<typeof params> }>('/api/harness-shares/:id',
    { preHandler: [validateParams(params)] }, async (req, reply) => {
      // A team session takes back only its own machine's shares.
      const team = await teamMachineScope(req.user!)
      const mine = { id: req.params.id, ownerId: req.user!.sub, autonomousEnv: req.user!.autonomousEnv, ...(team === null ? {} : { machineId: team }) }
      // Only a live invitation is taken back and told: taking one back again changes nothing, and is answered so.
      const changed = await prisma.harnessShare.updateMany({ where: { ...mine, OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }] },
        data: { revokedAt: new Date() } })
      if (!changed.count) {
        if (await prisma.harnessShare.findFirst({ where: mine, select: { id: true } })) return sendSuccess(reply, { removed: true })
        return sendError(reply, 'Invitation not found.', 'NOT_FOUND', 404)
      }
      await publishShareChanged(req.params.id)
      await tellRecipient(req.params.id)
      sendSuccess(reply, { removed: true })
    })
}

/**
 * Sharing a whole machine with other accounts (docs/plans/2026-10-15-share-machine-plan.md).
 *
 * - `GET|PUT /api/machines/:machineId/share`: the owner's policy, the addresses and whether everyone at
 *   the owner's domain is in, and who uses the machine now with their machines' keys. Written by the
 *   machine's own daemon from the policy it keeps (cli services/sharedMachines.ts), which reads the members
 *   back to know whose keys to trust.
 * - `GET /api/machine-shares`: the machines shared with the person asking (also in `GET /api/machines`).
 * - `POST|DELETE /api/machine-shares/:machineId/add`: what an older app calls to add a machine shared with
 *   its domain, or take it back out. Nothing needs adding any more: a domain share is used as one by email
 *   is (lib/machineAccess.ts), so these change no one's access.
 */
import type { FastifyInstance } from 'fastify'
import { nextMachineShareGrants } from '../lib/machineSharePolicy.js'
import type { MachineShare } from '@prisma/client'
import { z } from 'zod'
import { prisma, machineAlive } from '../lib/prisma.js'
import { upsertRacing } from '../lib/upsertRace.js'
import { publishDeviceMachineListChanged, publishMachineShareChanged } from '../lib/bus.js'
import { machinesSharedWith, shareMembers, sharedVia } from '../lib/machineAccess.js'
import { emailDomain, isPublicEmailDomain } from '../lib/publicEmailDomains.js'
import { validateBody, validateParams } from '../middlewares/validation.js'
import { isMachineId } from '../utils/slug.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { logger } from '../utils/logger.js'
import type { AuthUser } from '../lib/ssoAuth.js'

/** The most addresses one machine is shared with. */
export const SHARE_EMAILS_MAX = 100
/** The most accounts told at once that a machine's sharing changed. */
const TELL_MAX = 2000

const params = z.object({ machineId: z.string().refine(isMachineId, 'Invalid machineId') })
const policyBody = z.object({
  emails: z.array(z.string().trim().toLowerCase().email().max(254)).max(SHARE_EMAILS_MAX),
  sameDomain: z.boolean(),
}).strict()

const normalized = (email: string): string => email.trim().toLowerCase()

function ownedMachine(machineId: string, user: AuthUser) {
  return prisma.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
}

/** The policy as the owner's apps show it: `domain` is the owner's own, or null at a public domain, where
 *  "everyone at" is never offered. */
async function policyView(share: MachineShare | null, user: AuthUser) {
  const domain = emailDomain(user.email)
  return {
    emails: share?.emails ?? [], sameDomain: !!share?.domain,
    domain: isPublicEmailDomain(domain) ? null : domain,
    members: share ? await shareMembers(share) : [],
  }
}

/** A concurrent share edit must reread the current grant versions. Reusing a
 * stale policy after a revocation could otherwise revive an old contribution. */
async function writePolicy(machineId: string, user: AuthUser, emails: string[], domain: string | null) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        const before = await tx.machineShare.findUnique({ where: { machineId } })
        let after: MachineShare | null = null
        if (!emails.length && !domain) {
          await tx.machineShare.deleteMany({ where: { machineId } })
          await tx.machineShareAdd.deleteMany({ where: { machineId } })
        } else {
          const data = { ownerId: user.sub, autonomousEnv: user.autonomousEnv, emails, domain,
            grantVersions: nextMachineShareGrants(before, emails, domain) }
          after = await tx.machineShare.upsert({ where: { machineId }, create: { machineId, ...data }, update: data })
        }
        return { before, after }
      })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (attempt >= 4 || (code !== 'P2034' && code !== 'P2002')) throw error
    }
  }
}

/**
 * Everyone a change of the policy may add the machine to or take it from, their apps and daemons told to
 * read their Machines again: the addresses before and after, everyone at the domain before and after, and
 * whoever had added it. Best effort, like Share's `tellRecipient`: the policy is written already.
 */
async function tellAffected(machineId: string, ownerId: string, before: MachineShare | null, after: MachineShare | null): Promise<void> {
  try {
    const emails = [...new Set([...before?.emails ?? [], ...after?.emails ?? []])]
    const domains = [...new Set([before?.domain, after?.domain].filter((d): d is string => !!d))]
    const where = [...emails.length ? [{ email: { in: emails } }] : [], ...domains.map(d => ({ email: { endsWith: `@${d}` } }))]
    const [users, adds] = await Promise.all([
      where.length ? prisma.user.findMany({ where: { OR: where }, select: { id: true }, take: TELL_MAX }) : [],
      prisma.machineShareAdd.findMany({ where: { machineId }, select: { userId: true }, take: TELL_MAX }),
    ])
    const ids = new Set([...users.map(u => u.id), ...adds.map(a => a.userId)])
    ids.delete(ownerId)
    await Promise.all([...ids].map(id => publishDeviceMachineListChanged(id, { reason: 'updated' })))
  } catch (err) {
    logger.warn('machine share: could not tell everyone it changed', { machineId, error: String(err) })
  }
}

export async function machineShareRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: z.infer<typeof params> }>('/api/machines/:machineId/share',
    { preHandler: [validateParams(params)] }, async (req, reply) => {
      const user = req.user!
      if (!await ownedMachine(req.params.machineId, user)) return sendError(reply, 'Machine not found.', 'NOT_FOUND', 404)
      const share = await prisma.machineShare.findUnique({ where: { machineId: req.params.machineId } })
      sendSuccess(reply, await policyView(share && share.ownerId === user.sub ? share : null, user))
    })

  app.put<{ Params: z.infer<typeof params>; Body: z.infer<typeof policyBody> }>('/api/machines/:machineId/share',
    { preHandler: [validateParams(params), validateBody(policyBody)] }, async (req, reply) => {
      const user = req.user!
      const { machineId } = req.params
      if (!await ownedMachine(machineId, user)) return sendError(reply, 'Machine not found.', 'NOT_FOUND', 404)
      const own = normalized(user.email)
      // Any address may be named, at a public domain too: it names one person. Never the owner's own, and
      // never a placeholder no one signs in with.
      const emails = [...new Set(req.body.emails)].filter(email => email !== own && !email.endsWith('.invalid'))
      let domain: string | null = null
      if (req.body.sameDomain) {
        domain = emailDomain(own)
        if (isPublicEmailDomain(domain)) {
          return sendError(reply, `Everyone at @${domain ?? 'your domain'} is not offered: it is a public email domain.`, 'PUBLIC_DOMAIN', 400)
        }
      }
      const { before, after } = await writePolicy(machineId, user, emails, domain)
      await publishMachineShareChanged(machineId).catch(() => 0)
      await tellAffected(machineId, user.sub, before, after)
      sendSuccess(reply, await policyView(after, user))
    })

  app.get('/api/machine-shares', async (req, reply) => {
    sendSuccess(reply, { machines: await machinesSharedWith(req.user!) })
  })

  app.post<{ Params: z.infer<typeof params> }>('/api/machine-shares/:machineId/add',
    { preHandler: [validateParams(params)] }, async (req, reply) => {
      const user = req.user!
      const { machineId } = req.params
      const share = await prisma.machineShare.findUnique({ where: { machineId } })
      const machine = share && share.ownerId !== user.sub && share.autonomousEnv === user.autonomousEnv
        ? await prisma.machine.findFirst({ where: { machineId, userId: share.ownerId, autonomousEnv: user.autonomousEnv, ...machineAlive } })
        : null
      const via = share && machine ? sharedVia(share, user.email) : null
      if (!share || !via) return sendError(reply, 'This machine is not shared with you.', 'NOT_SHARED', 404)
      if (via === 'domain') {
        await upsertRacing(() => prisma.machineShareAdd.upsert({ where: { machineId_userId: { machineId, userId: user.sub } },
          create: { machineId, userId: user.sub }, update: {} }))
      }
      // The owner's daemon reads who uses the machine again and trusts this account's machines.
      await Promise.all([share.ownerId, user.sub].map(id => publishDeviceMachineListChanged(id, { reason: 'updated' }))).catch(() => [])
      sendSuccess(reply, { added: true })
    })

  app.delete<{ Params: z.infer<typeof params> }>('/api/machine-shares/:machineId/add',
    { preHandler: [validateParams(params)] }, async (req, reply) => {
      const user = req.user!
      const { machineId } = req.params
      const removed = await prisma.machineShareAdd.deleteMany({ where: { machineId, userId: user.sub } })
      if (removed.count) {
        const share = await prisma.machineShare.findUnique({ where: { machineId } })
        await publishMachineShareChanged(machineId).catch(() => 0)
        await Promise.all([...share ? [share.ownerId] : [], user.sub].map(id => publishDeviceMachineListChanged(id, { reason: 'updated' }))).catch(() => [])
      }
      sendSuccess(reply, { removed: removed.count > 0 })
    })
}

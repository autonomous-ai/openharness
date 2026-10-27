import type { Prisma, PrismaClient, SwarmOrgMember } from '@prisma/client'
import type { AuthUser } from '../lib/ssoAuth.js'
import { fail, stableId, type SuperTabState } from './model.js'
import { ORG_LABEL, orgCan, type OrgAction, type OrgRole } from './orgs.js'

type Transaction = Prisma.TransactionClient

export const ORG_ACCESS_REVOKED = 'ORG_ACCESS_REVOKED'

/** After the migration has given every Swarm a Team, a Swarm without one is refused rather than served by its own
 *  membership alone (design, Migration step 3). */
export const orgsRequired = (): boolean => process.env.SWARM_TEAMS_REQUIRED === '1'

/** A person's own Team, made the first time they create a Swarm without naming one. The migration derives the same id. */
export const personalOrgId = (environment: string, userId: string): string => stableId('swarm-org', environment, userId)
export const memberId = (orgId: string, userId: string): string => `${orgId}:${userId}`

/** The person's current membership, or null when they are not in the Team or were removed from it. */
export async function activeMember(tx: Transaction | PrismaClient, orgId: string, userId: string): Promise<SwarmOrgMember | null> {
  const row = await tx.swarmOrgMember.findUnique({ where: { id: memberId(orgId, userId) } })
  return row && !row.removedAt ? row : null
}

/** The one Team check of every Swarm read and command (design, Audience): the person must still be in the Swarm's Team.
 *  Reading the Swarm needs its own membership as well, which the caller checks as before. */
export async function requireOrgAccess(tx: Transaction, state: Pick<SuperTabState, 'orgId'>, userId: string): Promise<void> {
  if (!state.orgId) {
    if (orgsRequired()) fail(ORG_ACCESS_REVOKED, `This Swarm has no ${ORG_LABEL} yet.`, 403)
    return
  }
  if (!await activeMember(tx, state.orgId, userId)) fail(ORG_ACCESS_REVOKED, `You are no longer in this Swarm's ${ORG_LABEL}.`, 403)
}

/** The member, who must be allowed `action`. Not being in the Team at all reads as the Team being unavailable. */
export async function requireOrgRole(tx: Transaction, orgId: string, userId: string, action: OrgAction): Promise<SwarmOrgMember & { role: OrgRole }> {
  const member = await activeMember(tx, orgId, userId)
  if (!member) fail('NOT_FOUND', `This ${ORG_LABEL} is unavailable.`, 404)
  if (!orgCan(member.role as OrgRole, action)) fail('ORG_ROLE_REQUIRED', `Your role in this ${ORG_LABEL} cannot do that.`, 403)
  return member as SwarmOrgMember & { role: OrgRole }
}

/** Adds a person to a Team with `role`, or brings a removed one back with a new generation (old receipts stay refused).
 *  Someone already in it keeps their role. */
export async function addMember(tx: Transaction, orgId: string, person: { id: string; email: string }, role: OrgRole, addedBy: string,
  generation: string): Promise<SwarmOrgMember> {
  const id = memberId(orgId, person.id)
  const prior = await tx.swarmOrgMember.findUnique({ where: { id } })
  if (prior && !prior.removedAt) return prior
  const data = { email: person.email.trim().toLowerCase(), role, generation, addedBy, addedAt: new Date(), removedAt: null, removedBy: null, purgeAt: null }
  return prior
    ? tx.swarmOrgMember.update({ where: { id }, data: { ...data, version: { increment: 1 } } })
    : tx.swarmOrgMember.create({ data: { id, orgId, userId: person.id, ...data } })
}

/** The Team a Swarm is created in: the one named, where the person may create Swarms, or else their own, made now. */
export async function orgForNewSwarm(tx: Transaction, user: AuthUser, swarmName: string, generation: string, orgId?: string): Promise<string> {
  if (orgId) {
    await requireOrgRole(tx, orgId, user.sub, 'swarm.create')
    return orgId
  }
  const id = personalOrgId(user.autonomousEnv, user.sub)
  const org = await tx.swarmOrg.findUnique({ where: { id } })
  if (!org) {
    await tx.swarmOrg.create({ data: { id, autonomousEnv: user.autonomousEnv, name: swarmName, ownerId: user.sub, deletedAt: null, purgeAt: null } })
    await addMember(tx, id, { id: user.sub, email: user.email }, 'owner', user.sub, generation)
    return id
  }
  if (org.deletedAt) fail('ORG_REQUIRED', `Choose a ${ORG_LABEL} for this Swarm.`, 409)
  await requireOrgRole(tx, id, user.sub, 'swarm.create')
  return id
}

export interface OrgSummary {
  id: string; name: string; role: OrgRole; revision: number
  swarms: Array<{ id: string; name: string; orgVisibility: 'invite-only' | 'org' }>
}

/** The person's Teams, each with the Swarms they may see there: their own, those open to the Team (members and up), and
 *  every one for owners and admins (names only: reading still needs the Swarm's own membership). */
export async function listOrgs(db: PrismaClient, user: AuthUser): Promise<OrgSummary[]> {
  const memberships = await db.swarmOrgMember.findMany({ where: { userId: user.sub, removedAt: null }, take: 100 })
  // Filtered here, not in the query: Prisma's `null` on Mongo misses a field that was never written.
  const orgs = (await db.swarmOrg.findMany({ where: { id: { in: memberships.map(m => m.orgId) }, autonomousEnv: user.autonomousEnv } })).filter(o => !o.deletedAt)
  const rows = await db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, orgId: { in: orgs.map(o => o.id) } },
    select: { id: true, orgId: true, memberIds: true, format: true } })
  const heads = await db.swarmHead.findMany({ where: { id: { in: rows.filter(r => r.format === 2).map(r => `${r.id}:head`) } }, select: { tabId: true, data: true } })
  const headOf = new Map(heads.map(h => [h.tabId, h.data as { name?: string; orgVisibility?: 'invite-only' | 'org' }]))
  return orgs.map(org => {
    const role = memberships.find(m => m.orgId === org.id)!.role as OrgRole
    const swarms = rows.filter(r => r.orgId === org.id).flatMap(row => {
      const head = headOf.get(row.id)
      if (!head) return []
      const orgVisibility = head.orgVisibility ?? 'invite-only'
      const visible = row.memberIds.includes(user.sub) || orgCan(role, 'swarms.listAll') || (orgVisibility === 'org' && orgCan(role, 'swarm.joinOpen'))
      return visible ? [{ id: row.id, name: head.name ?? '', orgVisibility }] : []
    })
    return { id: org.id, name: org.name, role, revision: org.revision, swarms }
  })
}

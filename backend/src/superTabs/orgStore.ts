import type { Prisma, PrismaClient, SwarmOrgMember, SwarmOrgRemoval } from '@prisma/client'
import type { AuthUser } from '../lib/ssoAuth.js'
import { fail, stableId, type SuperTabState } from './model.js'
import { mayAssignRole, mayManageMember, ORG_LABEL, orgCan, type OrgAction, type OrgRole } from './orgs.js'
import { logger } from '../utils/logger.js'

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

/** Answers already read in a transaction: a host read checks every agent's contributor, mostly the same few people. */
const checked = new WeakMap<object, Map<string, boolean>>()

/** Whether the person is still in the Swarm's Team; a Swarm from before Teams passes until the switch is on. Read once
 *  per person per transaction, which reads one snapshot. */
export async function hasOrgAccess(tx: Transaction, state: Pick<SuperTabState, 'orgId'>, userId: string): Promise<boolean> {
  if (!state.orgId) return !orgsRequired()
  const answers = checked.get(tx) ?? new Map<string, boolean>()
  checked.set(tx, answers)
  const key = memberId(state.orgId, userId)
  const known = answers.get(key)
  if (known !== undefined) return known
  const answer = !!await activeMember(tx, state.orgId, userId)
  answers.set(key, answer)
  return answer
}

/** The one Team check of every Swarm read and command (design, Audience): the person must still be in the Swarm's Team.
 *  Reading the Swarm needs its own membership as well, which the caller checks as before. */
export async function requireOrgAccess(tx: Transaction, state: Pick<SuperTabState, 'orgId'>, userId: string): Promise<void> {
  if (await hasOrgAccess(tx, state, userId)) return
  fail(ORG_ACCESS_REVOKED, state.orgId ? `You are no longer in this Swarm's ${ORG_LABEL}.` : `This Swarm has no ${ORG_LABEL} yet.`, 403)
}

/** The member, who must be allowed `action`. Not being in the Team at all reads as the Team being unavailable. */
export async function requireOrgRole(tx: Transaction, orgId: string, userId: string, action: OrgAction): Promise<SwarmOrgMember & { role: OrgRole }> {
  const member = await activeMember(tx, orgId, userId)
  if (!member) fail('NOT_FOUND', `This ${ORG_LABEL} is unavailable.`, 404)
  if (!orgCan(member.role as OrgRole, action)) fail('ORG_ROLE_REQUIRED', `Your role in this ${ORG_LABEL} cannot do that.`, 403)
  return member as SwarmOrgMember & { role: OrgRole }
}

/** Adds a person to a Team with `role`, or brings a removed one back with a new generation (old receipts stay refused).
 *  Someone already in it keeps their role. Nobody comes back while a removal of theirs is still open: they could still
 *  be in a Swarm of the Team that the removal has not left yet (SwarmOrgs.finishPending finishes it first). */
export async function addMember(tx: Transaction, orgId: string, person: { id: string; email: string }, role: OrgRole, addedBy: string,
  generation: string): Promise<SwarmOrgMember> {
  const id = memberId(orgId, person.id)
  checked.get(tx)?.delete(id)
  const prior = await tx.swarmOrgMember.findUnique({ where: { id } })
  if (prior && !prior.removedAt) return prior
  if (await tx.swarmOrgRemoval.count({ where: { orgId, userId: person.id, finishedAt: null } })) {
    fail('REMOVAL_PENDING', `An earlier removal from this ${ORG_LABEL} is still taking them out of its Swarms. Try again in a few minutes.`, 409)
  }
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
  /** `member`: the person is in it; otherwise it is open to the Team, or listed for its owners and admins. */
  swarms: Array<{ id: string; name: string; orgVisibility: 'invite-only' | 'org'; member: boolean }>
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
      const member = row.memberIds.includes(user.sub)
      const visible = member || orgCan(role, 'swarms.listAll') || (orgVisibility === 'org' && orgCan(role, 'swarm.joinOpen'))
      return visible ? [{ id: row.id, name: head.name ?? '', orgVisibility, member }] : []
    })
    return { id: org.id, name: org.name, role, revision: org.revision, swarms }
  })
}

/** How long a removed person's row and a deleted Team stay before they are purged (design, Growth). */
export const ORG_PURGE_MS = 30 * 24 * 60 * 60 * 1000
const INVITATION_MS = 14 * 24 * 60 * 60 * 1000

interface OrgDeps {
  transaction<T>(body: (tx: Transaction) => Promise<T>): Promise<T>
  /** The person leaves one Swarm, as a leave of their own does (`member.remove` of themselves), past the Team check. */
  leave(person: AuthUser, tabId: string, operationId: string): Promise<unknown>
  now(): number
}

const personOf = (row: Pick<SwarmOrgMember, 'userId' | 'email'>, environment: string): AuthUser =>
  ({ sub: row.userId, email: row.email, autonomousEnv: environment as AuthUser['autonomousEnv'], role: 'user' })

/** Team actions: people, roles, invitations, ownership. Every one is the signed-in person's own (design, Identity). */
export class SwarmOrgs {
  constructor(private readonly db: PrismaClient, private readonly deps: OrgDeps) {}

  private async org(tx: Transaction, user: AuthUser, orgId: string) {
    const org = await tx.swarmOrg.findUnique({ where: { id: orgId } })
    if (!org || org.deletedAt || org.autonomousEnv !== user.autonomousEnv) fail('NOT_FOUND', `This ${ORG_LABEL} is unavailable.`, 404)
    return org
  }

  async create(user: AuthUser, operationId: string, name: string) {
    const id = stableId('swarm-org', user.autonomousEnv, user.sub, operationId)
    return this.deps.transaction(async tx => {
      const prior = await tx.swarmOrg.findUnique({ where: { id } })
      if (prior) {
        if (prior.ownerId !== user.sub || prior.name !== name) fail('OPERATION_REUSED', 'Use a new operation ID for a different request.')
        return { id }
      }
      await tx.swarmOrg.create({ data: { id, autonomousEnv: user.autonomousEnv, name, ownerId: user.sub, deletedAt: null, purgeAt: null } })
      await addMember(tx, id, { id: user.sub, email: user.email }, 'owner', user.sub, id)
      return { id }
    })
  }

  async rename(user: AuthUser, orgId: string, name: string) {
    return this.deps.transaction(async tx => {
      await this.org(tx, user, orgId)
      await requireOrgRole(tx, orgId, user.sub, 'org.rename')
      const org = await tx.swarmOrg.update({ where: { id: orgId }, data: { name, revision: { increment: 1 } } })
      return { id: org.id, name: org.name, revision: org.revision }
    })
  }

  /** The Team's people for members and up; owners and admins also see open invitations. */
  async members(user: AuthUser, orgId: string) {
    return this.deps.transaction(async tx => {
      await this.org(tx, user, orgId)
      const me = await requireOrgRole(tx, orgId, user.sub, 'people.list')
      const rows = await tx.swarmOrgMember.findMany({ where: { orgId, removedAt: null }, orderBy: { addedAt: 'asc' }, take: 1000 })
      const invitations = orgCan(me.role, 'org.invite')
        ? (await tx.swarmOrgInvitation.findMany({ where: { orgId }, take: 1000 })).filter(i => i.expiresAt.getTime() > this.deps.now())
          .map(i => ({ email: i.email, role: i.role, expiresAt: i.expiresAt.getTime() }))
        : []
      return { members: rows.map(m => ({ userId: m.userId, email: m.email, role: m.role })), invitations }
    })
  }

  async invite(user: AuthUser, orgId: string, email: string, role: OrgRole) {
    const address = email.trim().toLowerCase()
    return this.deps.transaction(async tx => {
      await this.org(tx, user, orgId)
      const me = await requireOrgRole(tx, orgId, user.sub, 'org.invite')
      if (!mayAssignRole(me.role, role)) fail('ORG_ROLE_REQUIRED', `Your role in this ${ORG_LABEL} cannot invite as ${role}.`, 403)
      const id = `${orgId}:${address}`, expiresAt = new Date(this.deps.now() + INVITATION_MS)
      await tx.swarmOrgInvitation.upsert({ where: { id }, create: { id, orgId, email: address, role, invitedBy: user.sub, expiresAt },
        update: { role, invitedBy: user.sub, expiresAt } })
      return { email: address, role, expiresAt: expiresAt.getTime() }
    })
  }

  /** Invitations waiting for the signed-in person. */
  async invitationsFor(user: AuthUser) {
    const rows = await this.db.swarmOrgInvitation.findMany({ where: { email: user.email.trim().toLowerCase(), expiresAt: { gt: new Date(this.deps.now()) } }, take: 100 })
    const orgs = await this.db.swarmOrg.findMany({ where: { id: { in: rows.map(r => r.orgId) }, autonomousEnv: user.autonomousEnv } })
    return { invitations: rows.flatMap(row => {
      const org = orgs.find(o => o.id === row.orgId && !o.deletedAt)
      return org ? [{ orgId: org.id, name: org.name, role: row.role, expiresAt: row.expiresAt.getTime() }] : []
    }) }
  }

  /** Accepting brings a person in with the invited role, or raises a guest to it; it never lowers a role. */
  async accept(user: AuthUser, orgId: string) {
    const address = user.email.trim().toLowerCase()
    // An earlier removal still open is finished first; if it cannot be, addMember refuses below.
    await this.finishPending(orgId, user.sub)
    return this.deps.transaction(async tx => {
      await this.org(tx, user, orgId)
      const invitation = await tx.swarmOrgInvitation.findUnique({ where: { id: `${orgId}:${address}` } })
      if (!invitation || invitation.expiresAt.getTime() <= this.deps.now()) fail('NOT_FOUND', 'This invitation is unavailable.', 404)
      await tx.swarmOrgInvitation.delete({ where: { id: invitation.id } })
      const role = invitation.role as OrgRole
      const current = await activeMember(tx, orgId, user.sub)
      if (current && current.role === 'guest' && role !== 'guest') {
        await tx.swarmOrgMember.update({ where: { id: current.id }, data: { role, version: { increment: 1 } } })
        return { orgId, role }
      }
      const added = await addMember(tx, orgId, { id: user.sub, email: address }, role, invitation.invitedBy, stableId('org-accept', invitation.id, String(invitation.expiresAt.getTime())))
      return { orgId, role: added.role }
    })
  }

  /** Someone who owns one of the Team's Swarms stays at least a member, and cannot be removed until it moves. */
  private async ownsTeamSwarm(tx: Transaction, orgId: string, userId: string): Promise<boolean> {
    return !!await tx.superTab.findFirst({ where: { orgId, ownerId: userId }, select: { id: true } })
  }

  async setRole(user: AuthUser, orgId: string, userId: string, role: OrgRole) {
    return this.deps.transaction(async tx => {
      await this.org(tx, user, orgId)
      const me = await requireOrgRole(tx, orgId, user.sub, 'people.list')
      const target = await activeMember(tx, orgId, userId) ?? fail('NOT_FOUND', 'This person is not in the Team.', 404)
      if (userId === user.sub || !mayManageMember(me.role, target.role as OrgRole) || !mayAssignRole(me.role, role)) {
        fail('ORG_ROLE_REQUIRED', `Your role in this ${ORG_LABEL} cannot give that role.`, 403)
      }
      if (role === 'guest' && await this.ownsTeamSwarm(tx, orgId, userId)) {
        fail('SWARM_OWNER', 'This person owns a Swarm of this Team, so they stay a member or above.', 409)
      }
      await tx.swarmOrgMember.update({ where: { id: target.id }, data: { role, version: { increment: 1 } } })
      return { userId, role }
    })
  }

  /** Ownership moves to an admin at once; the old owner stays as an admin. */
  async transfer(user: AuthUser, orgId: string, userId: string) {
    return this.deps.transaction(async tx => {
      await this.org(tx, user, orgId)
      const me = await requireOrgRole(tx, orgId, user.sub, 'org.transfer')
      const target = await activeMember(tx, orgId, userId)
      if (!target || target.role !== 'admin') fail('ADMIN_REQUIRED', `Ownership moves only to an admin of the ${ORG_LABEL}.`, 409)
      await tx.swarmOrgMember.update({ where: { id: target.id }, data: { role: 'owner', version: { increment: 1 } } })
      await tx.swarmOrgMember.update({ where: { id: me.id }, data: { role: 'admin', version: { increment: 1 } } })
      await tx.swarmOrg.update({ where: { id: orgId }, data: { ownerId: userId, revision: { increment: 1 } } })
      return { ownerId: userId }
    })
  }

  /** Removes a person (or lets them leave), then from every Swarm of the Team. The Team check refuses them everywhere
   *  from the moment the first transaction commits; the Swarm removals follow, and `finishRemovals` retries any that
   *  failed (design, Concurrency). */
  async remove(user: AuthUser, orgId: string, userId: string) {
    const removed = await this.deps.transaction(async tx => {
      const org = await this.org(tx, user, orgId)
      const target = await activeMember(tx, orgId, userId) ?? fail('NOT_FOUND', 'This person is not in the Team.', 404)
      if (target.role === 'owner') fail('OWNER_REQUIRED', `The ${ORG_LABEL}'s owner cannot leave it; transfer it first.`, 409)
      if (userId !== user.sub) {
        const me = await requireOrgRole(tx, orgId, user.sub, 'people.list')
        if (!mayManageMember(me.role, target.role as OrgRole)) fail('ORG_ROLE_REQUIRED', `Your role in this ${ORG_LABEL} cannot remove them.`, 403)
      }
      if (await this.ownsTeamSwarm(tx, orgId, userId)) fail('SWARM_OWNER', 'This person owns a Swarm of this Team. Move or delete it first.', 409)
      const now = new Date(this.deps.now())
      await tx.swarmOrgMember.update({ where: { id: target.id }, data: { removedAt: now, removedBy: user.sub,
        purgeAt: new Date(now.getTime() + ORG_PURGE_MS), version: { increment: 1 } } })
      // The removal stays open until the person has left every Swarm of the Team, whatever happens to their row after.
      return tx.swarmOrgRemoval.create({ data: { id: `${target.id}:${target.generation}`, orgId, userId, email: target.email,
        generation: target.generation, autonomousEnv: org.autonomousEnv, removedAt: now, removedBy: user.sub, finishedAt: null, purgeAt: null } })
    })
    return { userId, pending: await this.finish(removed) }
  }

  /** The removed person leaves each Swarm of the Team they are still in; the removal closes once none is left. Returns how
   *  many Swarms could not be left now. */
  private async finish(removal: SwarmOrgRemoval): Promise<number> {
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: removal.autonomousEnv, orgId: removal.orgId, memberIds: { has: removal.userId } },
      select: { id: true } })
    let pending = 0
    for (const row of rows) {
      try { await this.deps.leave(personOf(removal, removal.autonomousEnv), row.id, stableId('org-removal', removal.id)) } catch (error) {
        pending++
        logger.warn('[swarm-orgs] a removal could not leave a Swarm yet', { orgId: removal.orgId, tabId: row.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (!pending) {
      const now = this.deps.now()
      await this.db.swarmOrgRemoval.update({ where: { id: removal.id }, data: { finishedAt: new Date(now), purgeAt: new Date(now + ORG_PURGE_MS) } })
    }
    return pending
  }

  /** Finishes the person's open removals from this Team, if it can. */
  async finishPending(orgId: string, userId: string): Promise<number> {
    let pending = 0
    for (const removal of await this.db.swarmOrgRemoval.findMany({ where: { orgId, userId, finishedAt: null } })) pending += await this.finish(removal)
    return pending
  }

  /** The sweep: every open removal, oldest id first, a page at a time, so none is starved by the ones before it. */
  async finishRemovals(): Promise<number> {
    let pending = 0, after: string | undefined
    for (;;) {
      const page = await this.db.swarmOrgRemoval.findMany({ where: { finishedAt: null, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 200 })
      for (const removal of page) pending += await this.finish(removal)
      if (page.length < 200) return pending
      after = page.at(-1)!.id
    }
  }
}

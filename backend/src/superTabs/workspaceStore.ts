import type { Prisma, PrismaClient, SwarmWorkspaceMember, SwarmWorkspaceRemoval } from '@prisma/client'
import type { AuthUser } from '../lib/ssoAuth.js'
import { fail, stableId, type SuperTabState } from './model.js'
import { mayAssignRole, mayManageMember, WORKSPACE_LABEL, workspaceCan, type WorkspaceAction, type WorkspaceRole } from './workspaces.js'
import { logger } from '../utils/logger.js'

type Transaction = Prisma.TransactionClient

export const WORKSPACE_ACCESS_REVOKED = 'WORKSPACE_ACCESS_REVOKED'

/** After the migration has given every Swarm a Workspace, a Swarm without one is refused rather than served by its own
 *  membership alone (design, Migration step 3). */
export const workspacesRequired = (): boolean => process.env.SWARM_WORKSPACES_REQUIRED === '1'

/** A person's own Workspace, made the first time they create a Swarm without naming one. The migration derives the same id. */
export const personalWorkspaceId = (environment: string, userId: string): string => stableId('swarm-workspace', environment, userId)
export const memberId = (workspaceId: string, userId: string): string => `${workspaceId}:${userId}`

/** The person's current membership, or null when they are not in the Workspace or were removed from it. */
export async function activeMember(tx: Transaction | PrismaClient, workspaceId: string, userId: string): Promise<SwarmWorkspaceMember | null> {
  const row = await tx.swarmWorkspaceMember.findUnique({ where: { id: memberId(workspaceId, userId) } })
  return row && !row.removedAt ? row : null
}

/** Answers already read in a transaction: a host read checks every agent's contributor, mostly the same few people. */
const checked = new WeakMap<object, Map<string, boolean>>()

/** Whether the person is still in the Swarm's Workspace; a Swarm from before Workspaces passes until the switch is on. Read once
 *  per person per transaction, which reads one snapshot. */
export async function hasWorkspaceAccess(tx: Transaction, state: Pick<SuperTabState, 'workspaceId'>, userId: string): Promise<boolean> {
  if (!state.workspaceId) return !workspacesRequired()
  // Remembered only within a transaction. A read outside one (the read cache's, cache.ts) runs on the process's own client,
  // which lives as long as the process: an answer kept on it would outlive the person's removal.
  if (typeof (tx as { $transaction?: unknown }).$transaction === 'function') return !!await activeMember(tx, state.workspaceId, userId)
  const answers = checked.get(tx) ?? new Map<string, boolean>()
  checked.set(tx, answers)
  const key = memberId(state.workspaceId, userId)
  const known = answers.get(key)
  if (known !== undefined) return known
  const answer = !!await activeMember(tx, state.workspaceId, userId)
  answers.set(key, answer)
  return answer
}

/** The one Workspace check of every Swarm read and command (design, Audience): the person must still be in the Swarm's Workspace.
 *  Reading the Swarm needs its own membership as well, which the caller checks as before. */
export async function requireWorkspaceAccess(tx: Transaction, state: Pick<SuperTabState, 'workspaceId'>, userId: string): Promise<void> {
  if (await hasWorkspaceAccess(tx, state, userId)) return
  fail(WORKSPACE_ACCESS_REVOKED, state.workspaceId ? `You are no longer in this Swarm's ${WORKSPACE_LABEL}.` : `This Swarm has no ${WORKSPACE_LABEL} yet.`, 403)
}

/** The member, who must be allowed `action`. Not being in the Workspace at all reads as the Workspace being unavailable. */
export async function requireWorkspaceRole(tx: Transaction, workspaceId: string, userId: string, action: WorkspaceAction): Promise<SwarmWorkspaceMember & { role: WorkspaceRole }> {
  const member = await activeMember(tx, workspaceId, userId)
  if (!member) fail('NOT_FOUND', `This ${WORKSPACE_LABEL} is unavailable.`, 404)
  if (!workspaceCan(member.role as WorkspaceRole, action)) fail('WORKSPACE_ROLE_REQUIRED', `Your role in this ${WORKSPACE_LABEL} cannot do that.`, 403)
  return member as SwarmWorkspaceMember & { role: WorkspaceRole }
}

/** Adds a person to a Workspace with `role`, or brings a removed one back with a new generation (old receipts stay refused).
 *  Someone already in it keeps their role. Nobody comes back while a removal of theirs is still open: they could still
 *  be in a Swarm of the Workspace that the removal has not left yet (SwarmWorkspaces.finishPending finishes it first). */
export async function addMember(tx: Transaction, workspaceId: string, person: { id: string; email: string }, role: WorkspaceRole, addedBy: string,
  generation: string): Promise<SwarmWorkspaceMember> {
  const id = memberId(workspaceId, person.id)
  checked.get(tx)?.delete(id)
  const prior = await tx.swarmWorkspaceMember.findUnique({ where: { id } })
  if (prior && !prior.removedAt) return prior
  if (await tx.swarmWorkspaceRemoval.count({ where: { workspaceId, userId: person.id, finishedAt: null } })) {
    fail('REMOVAL_PENDING', `An earlier removal from this ${WORKSPACE_LABEL} is still taking them out of its Swarms. Try again in a few minutes.`, 409)
  }
  const data = { email: person.email.trim().toLowerCase(), role, generation, addedBy, addedAt: new Date(), removedAt: null, removedBy: null, purgeAt: null }
  return prior
    ? tx.swarmWorkspaceMember.update({ where: { id }, data: { ...data, version: { increment: 1 } } })
    : tx.swarmWorkspaceMember.create({ data: { id, workspaceId, userId: person.id, ...data } })
}

/** The Workspace a Swarm is created in: the one named, where the person may create Swarms, or else their own, made now. */
export async function workspaceForNewSwarm(tx: Transaction, user: AuthUser, swarmName: string, generation: string, workspaceId?: string): Promise<string> {
  if (workspaceId) {
    await requireWorkspaceRole(tx, workspaceId, user.sub, 'swarm.create')
    return workspaceId
  }
  const id = personalWorkspaceId(user.autonomousEnv, user.sub)
  const workspace = await tx.swarmWorkspace.findUnique({ where: { id } })
  if (!workspace) {
    await tx.swarmWorkspace.create({ data: { id, autonomousEnv: user.autonomousEnv, name: swarmName, ownerId: user.sub, deletedAt: null, purgeAt: null } })
    await addMember(tx, id, { id: user.sub, email: user.email }, 'owner', user.sub, generation)
    return id
  }
  if (workspace.deletedAt) fail('WORKSPACE_REQUIRED', `Choose a ${WORKSPACE_LABEL} for this Swarm.`, 409)
  await requireWorkspaceRole(tx, id, user.sub, 'swarm.create')
  return id
}

export interface WorkspaceSummary {
  id: string; name: string; role: WorkspaceRole; revision: number
  /** `member`: the person is in it; otherwise it is open to the Workspace, or listed for its owners and admins. */
  swarms: Array<{ id: string; name: string; workspaceVisibility: 'invite-only' | 'workspace'; member: boolean }>
}

/** The person's Workspaces, each with the Swarms they may see there: their own, those open to the Workspace (members and up), and
 *  every one for owners and admins (names only: reading still needs the Swarm's own membership). */
export async function listWorkspaces(db: PrismaClient, user: AuthUser): Promise<WorkspaceSummary[]> {
  const memberships = await db.swarmWorkspaceMember.findMany({ where: { userId: user.sub, removedAt: null }, take: 100 })
  // Filtered here, not in the query: Prisma's `null` on Mongo misses a field that was never written.
  const workspaces = (await db.swarmWorkspace.findMany({ where: { id: { in: memberships.map(m => m.workspaceId) }, autonomousEnv: user.autonomousEnv } })).filter(o => !o.deletedAt)
  const rows = await db.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, workspaceId: { in: workspaces.map(o => o.id) } },
    select: { id: true, workspaceId: true, memberIds: true, format: true } })
  const heads = await db.swarmHead.findMany({ where: { id: { in: rows.filter(r => r.format === 2).map(r => `${r.id}:head`) } }, select: { tabId: true, data: true } })
  const headOf = new Map(heads.map(h => [h.tabId, h.data as { name?: string; workspaceVisibility?: 'invite-only' | 'workspace' }]))
  return workspaces.map(workspace => {
    const role = memberships.find(m => m.workspaceId === workspace.id)!.role as WorkspaceRole
    const swarms = rows.filter(r => r.workspaceId === workspace.id).flatMap(row => {
      const head = headOf.get(row.id)
      if (!head) return []
      const workspaceVisibility = head.workspaceVisibility ?? 'invite-only'
      const member = row.memberIds.includes(user.sub)
      const visible = member || workspaceCan(role, 'swarms.listAll') || (workspaceVisibility === 'workspace' && workspaceCan(role, 'swarm.joinOpen'))
      return visible ? [{ id: row.id, name: head.name ?? '', workspaceVisibility, member }] : []
    })
    return { id: workspace.id, name: workspace.name, role, revision: workspace.revision, swarms }
  })
}

/** How long a removed person's row and a deleted Workspace stay before they are purged (design, Growth). */
export const WORKSPACE_PURGE_MS = 30 * 24 * 60 * 60 * 1000
const INVITATION_MS = 14 * 24 * 60 * 60 * 1000

interface WorkspaceDeps {
  transaction<T>(body: (tx: Transaction) => Promise<T>): Promise<T>
  /** The person leaves one Swarm, as a leave of their own does (`member.remove` of themselves), past the Workspace check. */
  leave(person: AuthUser, tabId: string, operationId: string): Promise<unknown>
  now(): number
}

const personOf = (row: Pick<SwarmWorkspaceMember, 'userId' | 'email'>, environment: string): AuthUser =>
  ({ sub: row.userId, email: row.email, autonomousEnv: environment as AuthUser['autonomousEnv'], role: 'user' })

/** Workspace actions: people, roles, invitations, ownership. Every one is the signed-in person's own (design, Identity). */
export class SwarmWorkspaces {
  constructor(private readonly db: PrismaClient, private readonly deps: WorkspaceDeps) {}

  private async workspace(tx: Transaction, user: AuthUser, workspaceId: string) {
    const workspace = await tx.swarmWorkspace.findUnique({ where: { id: workspaceId } })
    if (!workspace || workspace.deletedAt || workspace.autonomousEnv !== user.autonomousEnv) fail('NOT_FOUND', `This ${WORKSPACE_LABEL} is unavailable.`, 404)
    return workspace
  }

  async create(user: AuthUser, operationId: string, name: string) {
    const id = stableId('swarm-workspace', user.autonomousEnv, user.sub, operationId)
    return this.deps.transaction(async tx => {
      const prior = await tx.swarmWorkspace.findUnique({ where: { id } })
      if (prior) {
        if (prior.ownerId !== user.sub || prior.name !== name) fail('OPERATION_REUSED', 'Use a new operation ID for a different request.')
        return { id }
      }
      await tx.swarmWorkspace.create({ data: { id, autonomousEnv: user.autonomousEnv, name, ownerId: user.sub, deletedAt: null, purgeAt: null } })
      await addMember(tx, id, { id: user.sub, email: user.email }, 'owner', user.sub, id)
      return { id }
    })
  }

  async rename(user: AuthUser, workspaceId: string, name: string) {
    return this.deps.transaction(async tx => {
      await this.workspace(tx, user, workspaceId)
      await requireWorkspaceRole(tx, workspaceId, user.sub, 'workspace.rename')
      const workspace = await tx.swarmWorkspace.update({ where: { id: workspaceId }, data: { name, revision: { increment: 1 } } })
      return { id: workspace.id, name: workspace.name, revision: workspace.revision }
    })
  }

  /** The Workspace's people for members and up; owners and admins also see open invitations. */
  async members(user: AuthUser, workspaceId: string) {
    return this.deps.transaction(async tx => {
      await this.workspace(tx, user, workspaceId)
      const me = await requireWorkspaceRole(tx, workspaceId, user.sub, 'people.list')
      const rows = await tx.swarmWorkspaceMember.findMany({ where: { workspaceId, removedAt: null }, orderBy: { addedAt: 'asc' }, take: 1000 })
      const invitations = workspaceCan(me.role, 'workspace.invite')
        ? (await tx.swarmWorkspaceInvitation.findMany({ where: { workspaceId }, take: 1000 })).filter(i => i.expiresAt.getTime() > this.deps.now())
          .map(i => ({ email: i.email, role: i.role, expiresAt: i.expiresAt.getTime() }))
        : []
      return { members: rows.map(m => ({ userId: m.userId, email: m.email, role: m.role })), invitations }
    })
  }

  async invite(user: AuthUser, workspaceId: string, email: string, role: WorkspaceRole) {
    const address = email.trim().toLowerCase()
    return this.deps.transaction(async tx => {
      await this.workspace(tx, user, workspaceId)
      const me = await requireWorkspaceRole(tx, workspaceId, user.sub, 'workspace.invite')
      if (!mayAssignRole(me.role, role)) fail('WORKSPACE_ROLE_REQUIRED', `Your role in this ${WORKSPACE_LABEL} cannot invite as ${role}.`, 403)
      const id = `${workspaceId}:${address}`, expiresAt = new Date(this.deps.now() + INVITATION_MS)
      await tx.swarmWorkspaceInvitation.upsert({ where: { id }, create: { id, workspaceId, email: address, role, invitedBy: user.sub, expiresAt },
        update: { role, invitedBy: user.sub, expiresAt } })
      return { email: address, role, expiresAt: expiresAt.getTime() }
    })
  }

  /** Invitations waiting for the signed-in person. */
  async invitationsFor(user: AuthUser) {
    const rows = await this.db.swarmWorkspaceInvitation.findMany({ where: { email: user.email.trim().toLowerCase(), expiresAt: { gt: new Date(this.deps.now()) } }, take: 100 })
    const workspaces = await this.db.swarmWorkspace.findMany({ where: { id: { in: rows.map(r => r.workspaceId) }, autonomousEnv: user.autonomousEnv } })
    return { invitations: rows.flatMap(row => {
      const workspace = workspaces.find(o => o.id === row.workspaceId && !o.deletedAt)
      return workspace ? [{ workspaceId: workspace.id, name: workspace.name, role: row.role, expiresAt: row.expiresAt.getTime() }] : []
    }) }
  }

  /** Accepting brings a person in with the invited role, or raises a guest to it; it never lowers a role. */
  async accept(user: AuthUser, workspaceId: string) {
    const address = user.email.trim().toLowerCase()
    // An earlier removal still open is finished first; if it cannot be, addMember refuses below.
    await this.finishPending(workspaceId, user.sub)
    return this.deps.transaction(async tx => {
      await this.workspace(tx, user, workspaceId)
      const invitation = await tx.swarmWorkspaceInvitation.findUnique({ where: { id: `${workspaceId}:${address}` } })
      if (!invitation || invitation.expiresAt.getTime() <= this.deps.now()) fail('NOT_FOUND', 'This invitation is unavailable.', 404)
      await tx.swarmWorkspaceInvitation.delete({ where: { id: invitation.id } })
      const role = invitation.role as WorkspaceRole
      const current = await activeMember(tx, workspaceId, user.sub)
      if (current && current.role === 'guest' && role !== 'guest') {
        await tx.swarmWorkspaceMember.update({ where: { id: current.id }, data: { role, version: { increment: 1 } } })
        return { workspaceId, role }
      }
      const added = await addMember(tx, workspaceId, { id: user.sub, email: address }, role, invitation.invitedBy, stableId('workspace-accept', invitation.id, String(invitation.expiresAt.getTime())))
      return { workspaceId, role: added.role }
    })
  }

  /** Someone who owns one of the Workspace's Swarms stays at least a member, and cannot be removed until it moves. */
  private async ownsWorkspaceSwarm(tx: Transaction, workspaceId: string, userId: string): Promise<boolean> {
    return !!await tx.superTab.findFirst({ where: { workspaceId, ownerId: userId }, select: { id: true } })
  }

  async setRole(user: AuthUser, workspaceId: string, userId: string, role: WorkspaceRole) {
    return this.deps.transaction(async tx => {
      await this.workspace(tx, user, workspaceId)
      const me = await requireWorkspaceRole(tx, workspaceId, user.sub, 'people.list')
      const target = await activeMember(tx, workspaceId, userId) ?? fail('NOT_FOUND', 'This person is not in the Workspace.', 404)
      if (userId === user.sub || !mayManageMember(me.role, target.role as WorkspaceRole) || !mayAssignRole(me.role, role)) {
        fail('WORKSPACE_ROLE_REQUIRED', `Your role in this ${WORKSPACE_LABEL} cannot give that role.`, 403)
      }
      if (role === 'guest' && await this.ownsWorkspaceSwarm(tx, workspaceId, userId)) {
        fail('SWARM_OWNER', 'This person owns a Swarm of this Workspace, so they stay a member or above.', 409)
      }
      await tx.swarmWorkspaceMember.update({ where: { id: target.id }, data: { role, version: { increment: 1 } } })
      return { userId, role }
    })
  }

  /** Ownership moves to an admin at once; the old owner stays as an admin. */
  async transfer(user: AuthUser, workspaceId: string, userId: string) {
    return this.deps.transaction(async tx => {
      await this.workspace(tx, user, workspaceId)
      const me = await requireWorkspaceRole(tx, workspaceId, user.sub, 'workspace.transfer')
      const target = await activeMember(tx, workspaceId, userId)
      if (!target || target.role !== 'admin') fail('ADMIN_REQUIRED', `Ownership moves only to an admin of the ${WORKSPACE_LABEL}.`, 409)
      await tx.swarmWorkspaceMember.update({ where: { id: target.id }, data: { role: 'owner', version: { increment: 1 } } })
      await tx.swarmWorkspaceMember.update({ where: { id: me.id }, data: { role: 'admin', version: { increment: 1 } } })
      await tx.swarmWorkspace.update({ where: { id: workspaceId }, data: { ownerId: userId, revision: { increment: 1 } } })
      return { ownerId: userId }
    })
  }

  /** Removes a person (or lets them leave), then from every Swarm of the Workspace. The Workspace check refuses them everywhere
   *  from the moment the first transaction commits; the Swarm removals follow, and `finishRemovals` retries any that
   *  failed (design, Concurrency). */
  async remove(user: AuthUser, workspaceId: string, userId: string) {
    const removed = await this.deps.transaction(async tx => {
      const workspace = await this.workspace(tx, user, workspaceId)
      const target = await activeMember(tx, workspaceId, userId) ?? fail('NOT_FOUND', 'This person is not in the Workspace.', 404)
      if (target.role === 'owner') fail('OWNER_REQUIRED', `The ${WORKSPACE_LABEL}'s owner cannot leave it; transfer it first.`, 409)
      if (userId !== user.sub) {
        const me = await requireWorkspaceRole(tx, workspaceId, user.sub, 'people.list')
        if (!mayManageMember(me.role, target.role as WorkspaceRole)) fail('WORKSPACE_ROLE_REQUIRED', `Your role in this ${WORKSPACE_LABEL} cannot remove them.`, 403)
      }
      if (await this.ownsWorkspaceSwarm(tx, workspaceId, userId)) fail('SWARM_OWNER', 'This person owns a Swarm of this Workspace. Move or delete it first.', 409)
      const now = new Date(this.deps.now())
      await tx.swarmWorkspaceMember.update({ where: { id: target.id }, data: { removedAt: now, removedBy: user.sub,
        purgeAt: new Date(now.getTime() + WORKSPACE_PURGE_MS), version: { increment: 1 } } })
      // The removal stays open until the person has left every Swarm of the Workspace, whatever happens to their row after.
      return tx.swarmWorkspaceRemoval.create({ data: { id: `${target.id}:${target.generation}`, workspaceId, userId, email: target.email,
        generation: target.generation, autonomousEnv: workspace.autonomousEnv, removedAt: now, removedBy: user.sub, finishedAt: null, purgeAt: null } })
    })
    return { userId, pending: await this.finish(removed) }
  }

  /** The removed person leaves each Swarm of the Workspace they are still in; the removal closes once none is left. Returns how
   *  many Swarms could not be left now. */
  private async finish(removal: SwarmWorkspaceRemoval): Promise<number> {
    const rows = await this.db.superTab.findMany({ where: { autonomousEnv: removal.autonomousEnv, workspaceId: removal.workspaceId, memberIds: { has: removal.userId } },
      select: { id: true } })
    let pending = 0
    for (const row of rows) {
      try { await this.deps.leave(personOf(removal, removal.autonomousEnv), row.id, stableId('workspace-removal', removal.id)) } catch (error) {
        pending++
        logger.warn('[swarm-workspaces] a removal could not leave a Swarm yet', { workspaceId: removal.workspaceId, tabId: row.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (!pending) {
      const now = this.deps.now()
      await this.db.swarmWorkspaceRemoval.update({ where: { id: removal.id }, data: { finishedAt: new Date(now), purgeAt: new Date(now + WORKSPACE_PURGE_MS) } })
    }
    return pending
  }

  /** Finishes the person's open removals from this Workspace, if it can. */
  async finishPending(workspaceId: string, userId: string): Promise<number> {
    let pending = 0
    for (const removal of await this.db.swarmWorkspaceRemoval.findMany({ where: { workspaceId, userId, finishedAt: null } })) pending += await this.finish(removal)
    return pending
  }

  /** The sweep: every open removal, oldest id first, a page at a time, so none is starved by the ones before it. */
  async finishRemovals(): Promise<number> {
    let pending = 0, after: string | undefined
    for (;;) {
      const page = await this.db.swarmWorkspaceRemoval.findMany({ where: { finishedAt: null, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 200 })
      for (const removal of page) pending += await this.finish(removal)
      if (page.length < 200) return pending
      after = page.at(-1)!.id
    }
  }
}

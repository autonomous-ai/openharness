import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma, machineAlive } from './prisma.js'
import { upsertRacing } from './upsertRace.js'

/**
 * Shared tabs across accounts: the owner's signed roster, stored and never read; invitations by email; and who
 * accepted. A desk tab's id is unique only within its account, so a shared tab is named everywhere else by an id
 * derived from the owner and the tab, which two accounts' `tab-1` never share.
 */
const hash = (...parts: string[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
export const sharedTabId = (ownerUserId: string, tabId: string): string => hash('amsg-share', ownerUserId, tabId)
const memberId = (shareId: string, userId: string): string => hash('amsg-member', shareId, userId)

/** The signed roster as stored, body plus signature: the daemons refuse a body over 96 KiB (cli lib/e2ee/tabSession.ts
 *  `ROSTER_BODY_MAX`), which escaped as a JSON string and signed stays below this. */
export const ROSTER_MAX_BYTES = 128 * 1024
export const MAX_MEMBERS = 8

export type ShareView = { sharedTabId: string; tabId?: string; owner: boolean; ownerEmail: string; ownerMachineId: string;
  version: number; roster: unknown; members?: { userId: string; email: string; acceptedAt: string }[];
  invites?: { id: string; email: string; expiresAt: string }[] }
export type InviteView = { id: string; sharedTabId: string; ownerEmail: string; ownerMachineId: string; expiresAt: string;
  /** The tab's name from the roster the backend holds, for the invitee to read before accepting; '' when it cannot be read. */
  tabName: string }

/*
 * Optional fields are written as explicit nulls at create: on MongoDB Prisma's `field: null` filter does not match an
 * ABSENT field (see machineAlive in prisma.ts, notRevoked in harnessSession.ts, routes/grid.ts), so a row created
 * without them would be invisible to every filter below.
 */
const owned = (userId: string, machineId: string, autonomousEnv: string) =>
  prisma.machine.findFirst({ where: { machineId, userId, autonomousEnv, ...machineAlive }, select: { machineId: true } })

/** A roster that is not newer than the held one, with the version held, so the owner signs its next one past it. */
const stale = (version: number) => ({ error: 'STALE_ROSTER' as const, version })
const versionOf = async (id: string): Promise<number> =>
  (await prisma.agentMessageShare.findUnique({ where: { id }, select: { rosterVersion: true } }))?.rosterVersion ?? 0

export async function putRoster(input: { ownerUserId: string; tabId: string; machineId: string; version: number;
  roster: unknown; autonomousEnv: string }): Promise<{ sharedTabId: string; version: number } | { error: 'FORBIDDEN' | 'ROSTER_TOO_LARGE' }
  | { error: 'STALE_ROSTER'; version: number }> {
  if (Buffer.byteLength(JSON.stringify(input.roster)) > ROSTER_MAX_BYTES) return { error: 'ROSTER_TOO_LARGE' as const }
  if (!await owned(input.ownerUserId, input.machineId, input.autonomousEnv)) return { error: 'FORBIDDEN' as const }
  const id = sharedTabId(input.ownerUserId, input.tabId)
  const held = await prisma.agentMessageShare.findUnique({ where: { id }, select: { ownerMachineId: true, rosterVersion: true, stoppedAt: true } })
  const data = { roster: input.roster as Prisma.InputJsonValue, rosterVersion: input.version, stoppedAt: null }
  // A stopped share starts again from any live machine of the owner, as a new share: its computer is the new put's.
  // Stopping removed its members and revoked its invitations, so nothing of the old one comes back. Its version still
  // only grows (the spec's "Authority"): a member that held the old roster takes a lower version for a replay, so a
  // restart below the held one is stale, and the owner signs past the version this answers with.
  // stoppedAt is always written (null at create), so `not: null` sees every stopped share.
  if (held?.stoppedAt) {
    if (input.version <= held.rosterVersion) return stale(held.rosterVersion)
    // One write: the computer, the version and the restart change together or not at all.
    const { count } = await prisma.agentMessageShare.updateMany({ where: { id, ownerUserId: input.ownerUserId, stoppedAt: { not: null },
      rosterVersion: { lt: input.version } }, data: { ...data, ownerMachineId: input.machineId } })
    // Lost to another put that started it again first: that one holds it now, and this one tries again as stale.
    return count ? { sharedTabId: id, version: input.version } : stale(await versionOf(id))
  }
  // The roster names the machine that signs it; another machine of the owner putting one would be a second
  // authority, which members could not tell apart from a forgery.
  if (held && held.ownerMachineId !== input.machineId) return { error: 'FORBIDDEN' as const }
  let raced = false
  if (!held) {
    try {
      await prisma.agentMessageShare.create({ data: { id, ownerUserId: input.ownerUserId, ownerMachineId: input.machineId,
        tabId: input.tabId, autonomousEnv: input.autonomousEnv, ...data } })
      return { sharedTabId: id, version: input.version }
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
      raced = true
    }
  }
  // Only a live share: a stop that raced this put is not undone by it (the restart above is the only way back).
  const { count } = await prisma.agentMessageShare.updateMany({ where: { id, ownerMachineId: input.machineId, stoppedAt: null,
    rosterVersion: { lt: input.version } }, data })
  if (count) return { sharedTabId: id, version: input.version }
  const now = await prisma.agentMessageShare.findUnique({ where: { id }, select: { ownerMachineId: true, rosterVersion: true } })
  // Lost a first-write race: the winner may be another machine of the owner, which stays the one authority.
  if (raced && now?.ownerMachineId !== input.machineId) return { error: 'FORBIDDEN' as const }
  return stale(now?.rosterVersion ?? 0)
}

export async function invite(input: { ownerUserId: string; ownerEmail: string; sharedTabId: string; email: string;
  expiresAt: Date; autonomousEnv: string }): Promise<{ id: string } | { error: 'FORBIDDEN' | 'SELF_INVITE' | 'TAB_FULL' | 'ALREADY_MEMBER' }> {
  const email = input.email.trim().toLowerCase()
  if (email === input.ownerEmail.trim().toLowerCase()) return { error: 'SELF_INVITE' as const }
  const share = await prisma.agentMessageShare.findFirst({ where: { id: input.sharedTabId, ownerUserId: input.ownerUserId, stoppedAt: null } })
  if (!share) return { error: 'FORBIDDEN' as const }
  // Inviting a member again would reset their accepted invitation to waiting, which outlived their removal and counted
  // toward the 8 twice (#1376).
  if (await prisma.agentMessageMember.findFirst({ where: { shareId: share.id, email, removedAt: null }, select: { id: true } })) return { error: 'ALREADY_MEMBER' as const }
  const [members, pending] = await Promise.all([
    prisma.agentMessageMember.count({ where: { shareId: share.id, removedAt: null } }),
    prisma.agentMessageInvite.count({ where: { shareId: share.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
  ])
  if (members + pending >= MAX_MEMBERS) return { error: 'TAB_FULL' as const }
  const row = await upsertRacing(() => prisma.agentMessageInvite.upsert({
    where: { shareId_email: { shareId: share.id, email } },
    create: { id: randomUUID(), shareId: share.id, ownerUserId: input.ownerUserId, ownerMachineId: share.ownerMachineId,
      email, autonomousEnv: input.autonomousEnv, expiresAt: input.expiresAt, acceptedAt: null, acceptedBy: null, revokedAt: null },
    update: { expiresAt: input.expiresAt, revokedAt: null, acceptedAt: null, acceptedBy: null },
  }))
  return { id: row.id }
}

export async function revokeInvite(ownerUserId: string, inviteId: string): Promise<{ shareId: string; email: string } | null> {
  const where = { id: inviteId, ownerUserId, revokedAt: null }
  const row = await prisma.agentMessageInvite.findFirst({ where, select: { shareId: true, email: true } })
  if (!row) return null
  const { count } = await prisma.agentMessageInvite.updateMany({ where, data: { revokedAt: new Date() } })
  return count > 0 ? { shareId: row.shareId, email: row.email } : null
}

/** The name in a stored roster ({ body, signature }; the body is the owner's signed JSON), without control and format
 *  characters (a bidi override in another account's text must not reach a person), cut to 200. The backend does not
 *  verify the roster, so this is shown only before Accept. */
function rosterName(roster: unknown): string {
  const body = (roster as { body?: unknown } | null)?.body
  if (typeof body !== 'string') return ''
  try {
    const name = (JSON.parse(body) as { name?: unknown } | null)?.name
    return typeof name === 'string' ? name.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 200) : ''
  } catch { return '' }
}

export async function pendingInvites(email: string, autonomousEnv: string): Promise<InviteView[]> {
  const found = await prisma.agentMessageInvite.findMany({ where: { email: email.trim().toLowerCase(), autonomousEnv,
    acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } })
  // One read for every listed invitation's share: the liveness and the name come from the same rows.
  const shares = found.length ? await prisma.agentMessageShare.findMany({ where: { id: { in: found.map(r => r.shareId) }, stoppedAt: null }, select: { id: true, roster: true } }) : []
  const live = new Map(shares.map(s => [s.id, s.roster]))
  const rows = found.filter(r => live.has(r.shareId))
  const owners = rows.length ? await prisma.user.findMany({ where: { id: { in: rows.map(r => r.ownerUserId) } }, select: { id: true, email: true } }) : []
  const emailOf = new Map(owners.map(o => [o.id, o.email]))
  return rows.map(r => ({ id: r.id, sharedTabId: r.shareId, ownerEmail: emailOf.get(r.ownerUserId) ?? '',
    ownerMachineId: r.ownerMachineId, expiresAt: r.expiresAt.toISOString(), tabName: rosterName(live.get(r.shareId)) }))
}

const liveShare = (id: string) => prisma.agentMessageShare.findFirst({ where: { id, stoppedAt: null }, select: { id: true } })

export async function accept(user: { sub: string; email: string; autonomousEnv: string }, inviteId: string, now = new Date()): Promise<{ sharedTabId: string } | { error: 'NOT_FOUND' | 'EXPIRED' }> {
  // Only an invitation of the environment the person is signed in to, as every other lookup here.
  const row = await prisma.agentMessageInvite.findFirst({ where: { id: inviteId, email: user.email.trim().toLowerCase(), autonomousEnv: user.autonomousEnv,
    acceptedAt: null, revokedAt: null } })
  if (!row || !await liveShare(row.shareId)) return { error: 'NOT_FOUND' as const }
  if (row.expiresAt <= now) return { error: 'EXPIRED' as const }
  await prisma.agentMessageInvite.update({ where: { id: row.id }, data: { acceptedBy: user.sub, acceptedAt: now } })
  const id = memberId(row.shareId, user.sub)
  await upsertRacing(() => prisma.agentMessageMember.upsert({ where: { id },
    create: { id, shareId: row.shareId, userId: user.sub, email: row.email, inviteId: row.id, acceptedAt: now, removedAt: null },
    update: { removedAt: null, inviteId: row.id, acceptedAt: now } }))
  return { sharedTabId: row.shareId }
}

export async function removeMember(actorUserId: string, shareId: string, userId: string): Promise<boolean> {
  const share = await prisma.agentMessageShare.findUnique({ where: { id: shareId }, select: { ownerUserId: true } })
  if (!share || (actorUserId !== share.ownerUserId && actorUserId !== userId)) return false
  const member = await prisma.agentMessageMember.findFirst({ where: { shareId, userId, removedAt: null }, select: { email: true } })
  const { count } = await prisma.agentMessageMember.updateMany({ where: { shareId, userId, removedAt: null }, data: { removedAt: new Date() } })
  // The accepted invitation goes with the member, and so does one still waiting for their address (#1376): only the
  // owner's next invitation brings them back.
  await prisma.agentMessageInvite.updateMany({ where: { shareId, revokedAt: null,
    OR: [{ acceptedBy: userId }, ...member ? [{ email: member.email, acceptedAt: null }] : []] }, data: { revokedAt: new Date() } })
  return count > 0
}

export async function stopSharing(ownerUserId: string, shareId: string): Promise<boolean> {
  const { count } = await prisma.agentMessageShare.updateMany({ where: { id: shareId, ownerUserId, stoppedAt: null }, data: { stoppedAt: new Date() } })
  if (count) {
    const at = new Date()
    await prisma.agentMessageMember.updateMany({ where: { shareId, removedAt: null }, data: { removedAt: at } })
    await prisma.agentMessageInvite.updateMany({ where: { shareId, revokedAt: null }, data: { revokedAt: at } })
  }
  return count > 0
}

/**
 * The owner moves a share's authority to another of its computers (the spec's "Authority": one computer at a time). The
 * roster is not touched here: the new computer signs the next one, with a key change the old computer signed when it
 * could be reached, and members judge that roster themselves. From now on only the new computer's roster is stored
 * (`putRoster` refuses any other machine). Only a live share: a stopped one starts again by a put from any machine.
 * stoppedAt, acceptedAt and revokedAt are always written (null at create), so the null filters see every row.
 */
export async function moveShare(ownerUserId: string, shareId: string, machineId: string, autonomousEnv: string): Promise<{ sharedTabId: string } | { error: 'FORBIDDEN' | 'NOT_FOUND' }> {
  if (!await owned(ownerUserId, machineId, autonomousEnv)) return { error: 'FORBIDDEN' as const }
  const { count } = await prisma.agentMessageShare.updateMany({ where: { id: shareId, ownerUserId, autonomousEnv, stoppedAt: null }, data: { ownerMachineId: machineId } })
  if (!count) return { error: 'NOT_FOUND' as const }
  // A waiting invitation names the computer the invitee is to expect the roster from.
  await prisma.agentMessageInvite.updateMany({ where: { shareId, acceptedAt: null, revokedAt: null }, data: { ownerMachineId: machineId } })
  return { sharedTabId: shareId }
}

export async function listShares(userId: string, autonomousEnv: string): Promise<ShareView[]> {
  const memberships = await prisma.agentMessageMember.findMany({ where: { userId, removedAt: null }, select: { shareId: true } })
  const shares = await prisma.agentMessageShare.findMany({ where: { autonomousEnv, stoppedAt: null,
    OR: [{ ownerUserId: userId }, ...memberships.length ? [{ id: { in: memberships.map(m => m.shareId) } }] : []] } })
  const owners = shares.length ? await prisma.user.findMany({ where: { id: { in: shares.map(s => s.ownerUserId) } }, select: { id: true, email: true } }) : []
  const emailOf = new Map(owners.map(o => [o.id, o.email]))
  return Promise.all(shares.map(async (s): Promise<ShareView> => {
    const view = { sharedTabId: s.id, owner: s.ownerUserId === userId, ownerEmail: emailOf.get(s.ownerUserId) ?? '',
      ownerMachineId: s.ownerMachineId, version: s.rosterVersion, roster: s.roster }
    if (!view.owner) return view
    const [members, invites] = await Promise.all([
      prisma.agentMessageMember.findMany({ where: { shareId: s.id, removedAt: null }, select: { userId: true, email: true, acceptedAt: true } }),
      prisma.agentMessageInvite.findMany({ where: { shareId: s.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, email: true, expiresAt: true } }),
    ])
    return { ...view, tabId: s.tabId,
      members: members.map(m => ({ userId: m.userId, email: m.email, acceptedAt: m.acceptedAt.toISOString() })),
      invites: invites.map(i => ({ id: i.id, email: i.email, expiresAt: i.expiresAt.toISOString() })) }
  }))
}

export async function admits(userId: string, machineId: string, shareId: string, autonomousEnv: string): Promise<boolean> {
  if (!await owned(userId, machineId, autonomousEnv)) return false
  const share = await prisma.agentMessageShare.findFirst({ where: { id: shareId, autonomousEnv, stoppedAt: null }, select: { ownerUserId: true } })
  if (!share) return false
  if (share.ownerUserId === userId) return true
  return !!await prisma.agentMessageMember.findFirst({ where: { shareId, userId, removedAt: null }, select: { id: true } })
}

/** Who to tell when a share changes: its owner, its current members, and the account behind an invited address. */
export async function shareOwner(shareId: string): Promise<string | null> {
  return (await prisma.agentMessageShare.findUnique({ where: { id: shareId }, select: { ownerUserId: true } }))?.ownerUserId ?? null
}
export async function shareMemberIds(shareId: string): Promise<string[]> {
  return (await prisma.agentMessageMember.findMany({ where: { shareId, removedAt: null }, select: { userId: true } })).map(m => m.userId)
}
export async function accountIdByEmail(email: string): Promise<string | null> {
  return (await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true } }))?.id ?? null
}

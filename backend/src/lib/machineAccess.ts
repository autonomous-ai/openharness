/**
 * Who may use a machine another account owns (docs/plans/2026-10-15-share-machine-plan.md). Its owner
 * shares it with addresses, and with everyone at the owner's own domain. Either way it is theirs to use at
 * once: a domain share once had to be added first (`MachineShareAdd`, kept only for older apps), and the
 * owner asked for it to work as one by email does (2026-10-16). A shared machine is used with the owner's
 * own rights: `machine_select` (lib/webWs.ts) asks `sharedMachineAccess` where it once compared
 * owners, and `machinesSharedWith` is the "Shared with you" half of the Machines list.
 *
 * Only the listing and the relay are decided here. The machine's daemon keeps the policy it published and
 * trusts the keys of the accounts it names and no others (cli services/sharedMachines.ts), so this
 * backend's word alone never opens a machine to anyone.
 */
import type { Machine, MachineShare } from '@prisma/client'
import { prisma, machineAlive } from './prisma.js'
import { getAgentPresenceMany } from './bus.js'
import { machineBillingAllowsDataPlane } from './billingState.js'
import { activeMachineKeys, activeMachineKeysOf } from './deviceKeyLog.js'
import { emailDomain, isPublicEmailDomain } from './publicEmailDomains.js'
import { storedAutonomousEnvironment } from './autonomousEnvironment.js'
import type { AuthUser } from './ssoAuth.js'
import { sharedVia, type ShareVia } from './machineSharePolicy.js'

export { sharedVia, type ShareVia } from './machineSharePolicy.js'

/** The most machines one account is shown as shared with it, and the most a machine lists as using it. */
export const SHARED_LIST_MAX = 200

const normalized = (email: string): string => email.trim().toLowerCase()

/** Whether `user` may use `machine`, which another account owns: how it was shared with them, or null. */
export async function sharedMachineAccess(user: AuthUser, machine: Pick<Machine, 'machineId' | 'userId' | 'autonomousEnv'>): Promise<ShareVia | null> {
  if (machine.userId === user.sub) return null
  const share = await prisma.machineShare.findUnique({ where: { machineId: machine.machineId } })
  if (!share || share.ownerId !== machine.userId || share.autonomousEnv !== user.autonomousEnv
    || storedAutonomousEnvironment(machine.autonomousEnv) !== user.autonomousEnv) return null
  return sharedVia(share, user.email)
}

/** A machine shared with the person asking, as their Machines list shows it. `pub` is the machine's own
 *  E2EE identity as its account's device key log names it: what their daemon pins to reach it. */
export interface SharedMachineRow {
  machineId: string
  name: string | null
  hostname: string | null
  authMode: 'remote'
  status: 'running' | 'offline'
  pub: string | null
  share: { ownerName: string; ownerEmail: string; via: ShareVia; added: boolean }
}

/** The machines other accounts share with `user`: named ones, and those at their domain. */
export async function machinesSharedWith(user: AuthUser): Promise<SharedMachineRow[]> {
  const email = normalized(user.email)
  const domain = emailDomain(email)
  const shares = await prisma.machineShare.findMany({
    where: {
      autonomousEnv: user.autonomousEnv, ownerId: { not: user.sub },
      OR: [{ emails: { has: email } }, ...(isPublicEmailDomain(domain) ? [] : [{ domain }])],
    },
    orderBy: { createdAt: 'asc' }, take: SHARED_LIST_MAX,
  })
  const reaching = shares.flatMap(share => {
    const via = sharedVia(share, email)
    return via ? [{ share, via }] : []
  })
  if (!reaching.length) return []
  const machines = (await prisma.machine.findMany({ where: {
    machineId: { in: reaching.map(r => r.share.machineId) }, autonomousEnv: user.autonomousEnv, ...machineAlive,
  } })).filter(machineBillingAllowsDataPlane)
  const usable = reaching.flatMap(r => {
    const machine = machines.find(m => m.machineId === r.share.machineId && m.userId === r.share.ownerId)
    return machine ? [{ ...r, machine }] : []
  })
  if (!usable.length) return []
  const ids = usable.map(u => u.machine.machineId)
  const ownerIds = [...new Set(usable.map(u => u.machine.userId))]
  const [owners, presence, keys] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, email: true } }),
    getAgentPresenceMany(ids),
    Promise.all(ownerIds.map(async id => [id, await activeMachineKeys(id)] as const)),
  ])
  const keyOf = (ownerId: string, machineId: string): string | null =>
    keys.find(([id]) => id === ownerId)?.[1].find(k => k.machineId === machineId)?.pub ?? null
  return usable.map(({ machine, via }) => {
    const owner = owners.find(o => o.id === machine.userId)
    return {
      machineId: machine.machineId, name: machine.name ?? null, hostname: machine.hostname ?? null, authMode: 'remote',
      status: presence.get(machine.machineId) ? 'running' : 'offline',
      pub: keyOf(machine.userId, machine.machineId),
      // `added` is always true now: an app that still reads it lists the machine as one it uses.
      share: { ownerName: owner?.name || owner?.email || 'Harness user', ownerEmail: owner?.email ?? '', via, added: true },
    }
  })
}

/** Someone who may use a machine, and their machines' keys: what the machine's daemon trusts. */
export interface ShareMember {
  email: string
  name: string | null
  via: ShareVia
  machines: Array<{ machineId: string; name: string; pub: string }>
}

/** The accounts `share` lets use its machine right now: those named, and everyone at the domain when it is
 *  shared with the domain. Named ones come first, so the cap never drops someone the owner named. */
export async function shareMembers(share: MachineShare): Promise<ShareMember[]> {
  const domain = share.domain && !isPublicEmailDomain(share.domain) ? share.domain : null
  const select = { id: true, email: true, name: true } as const
  const where = { autonomousEnv: share.autonomousEnv, id: { not: share.ownerId } }
  const named = share.emails.length
    ? await prisma.user.findMany({ where: { ...where, email: { in: share.emails } }, select, take: SHARED_LIST_MAX })
    : []
  const atDomain = domain && named.length < SHARED_LIST_MAX
    ? await prisma.user.findMany({
      where: { ...where, email: { endsWith: `@${domain}`, mode: 'insensitive' }, id: { notIn: [share.ownerId, ...named.map(u => u.id)] } },
      select, orderBy: { createdAt: 'asc' }, take: SHARED_LIST_MAX - named.length,
    })
    : []
  const members = [...named, ...atDomain].flatMap(user => {
    const via = sharedVia(share, user.email)
    return via ? [{ user, via }] : []
  })
  // Every member's keys in one read (deviceKeyLog.ts activeMachineKeysOf), not one log replay each.
  const keys = await activeMachineKeysOf(members.map(({ user }) => user.id))
  return members.map(({ user, via }) => ({
    email: normalized(user.email), name: user.name ?? null, via,
    machines: (keys.get(user.id) ?? []).map(k => ({ machineId: k.machineId, name: k.label, pub: k.pub })),
  }))
}

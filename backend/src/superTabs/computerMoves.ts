/**
 * A computer is signed in as one account at a time (Scholes, #3122): when another account signs in there, the computer's
 * entry in each Swarm moves to it. Account rows are per account and computer (MachineService.resolveOrCreateForComputer),
 * joined only by `Machine.computerId`, the id minted once in the computer's own `~/.harness/computer-id`.
 */
import type { Prisma } from '@prisma/client'

type Reader = Pick<Prisma.TransactionClient, 'machine'>

/**
 * The live rows of other accounts signed in on [computerId] before, never [ownerId]'s own or a Harness Team sign-in's.
 * A plain `$match` on the (computerId, userId) index: Prisma sends `not` and the deletedAt OR as $expr, which no index bounds.
 */
export async function otherAccountsOnComputer(db: Reader, { computerId, ownerId, autonomousEnv }: { computerId: string; ownerId: string; autonomousEnv: string }):
  Promise<Array<{ machineId: string; userId: string }>> {
  const rows = await db.machine.aggregateRaw({ pipeline: [
    { $match: { computerId, userId: { $ne: ownerId }, autonomousEnv, authMode: 'remote', sessionKind: { $ne: 'team' }, deletedAt: null } },
    { $sort: { userId: 1 } }, { $limit: 16 }, { $project: { _id: 0, machineId: 1, userId: 1 } }],
  options: { hint: { computerId: 1, userId: 1 } } }) as unknown as Array<{ machineId: string; userId: string }>
  return rows.map(row => ({ machineId: row.machineId, userId: row.userId }))
}

/** Each account's active device keys (lib/deviceKeyLog.ts activeMachineKeysOf): only `machine` keys are read here. */
export type MachineKeys = (userIds: string[]) => Promise<Map<string, ReadonlyArray<{ pub: string; kind: string; machineId: string }>>>

/**
 * Whether [from] and [to] are machines of one computer: each account's log holds the same machine key for its machine. The
 * key is the computer's (cli e2ee/store.ts identity.json, never touched by a sign-in), and every add is signed by the key
 * itself for that one account (deviceLogCore.ts), so only a holder of its private key can list it under a second account.
 * The computer id alone is self-declared (security review 1 of #3100). A machine with no key proves nothing.
 */
export async function sameComputerKey(keys: MachineKeys, from: { userId: string; machineId: string }, to: { userId: string; machineId: string }):
  Promise<boolean> {
  const held = await keys([from.userId, to.userId])
  const of = (side: { userId: string; machineId: string }) => held.get(side.userId)?.find(k => k.kind === 'machine' && k.machineId === side.machineId)?.pub
  const pub = of(from)
  return !!pub && pub === of(to)
}

/** An account's ordinary sign-in connecting from a computer (lib/adapterWs.ts): never a Harness Team session's. */
export interface ComputerSignIn { machineId: string; ownerId: string; computerId: string; autonomousEnv: string }

type Listener = (signIn: ComputerSignIn) => Promise<unknown>
let listener: Listener | null = null

/** The Swarm routes' store takes sign-ins from here (routes/superTabs.ts), so the adapter socket loads no Swarm code. */
export function onComputerSignedIn(next: Listener | null): void {
  listener = next
}

/** Tells the Swarms an entry of this computer's previous account is in. Never fails the connect: a Swarm missed is logged, and
 *  the next connect tries again. Nothing to do when no Swarm routes run here. */
export async function computerSignedIn(signIn: ComputerSignIn): Promise<void> {
  await listener?.(signIn)
}

/** What the one-time cleanup found: each computer with live rows of two or more accounts, the one seen last, and the others. */
export interface CleanUp { computers: Array<{ signedIn: { machineId: string; ownerId: string }; others: string[] }>; moved: number }

/**
 * The one-time cleanup of computers listed under two accounts before moves existed (Scholes, 11-05: MacBooks-MacBook-Pro-7 three
 * times): the account seen last on each is the one signed in there, and its sign-in moves the others' entries as a connect does
 * (store.ts computerSignedIn). A computer whose last two accounts were seen at the same moment, or never, is left. With [write]
 * false it only lists them. Safe to run again: an entry moved is gone, and nothing else is written.
 */
export async function cleanUpComputers(db: Reader, store: { computerSignedIn(signIn: ComputerSignIn): Promise<number> }, autonomousEnv: string,
  { write }: { write: boolean }): Promise<CleanUp> {
  const groups = await db.machine.aggregateRaw({ pipeline: [
    { $match: { computerId: { $type: 'string' }, autonomousEnv, authMode: 'remote', sessionKind: { $ne: 'team' }, deletedAt: null } },
    { $group: { _id: '$computerId', accounts: { $addToSet: '$userId' }, rows: { $push: { machineId: '$machineId', userId: '$userId', seen: '$lastSeenAt' } } } },
    { $match: { 'accounts.1': { $exists: true } } }],
  options: { hint: { computerId: 1, userId: 1 } } }) as unknown as Array<{ _id: string; rows: Array<{ machineId: string; userId: string; seen?: { $date: string } | null }> }>
  const result: CleanUp = { computers: [], moved: 0 }
  for (const group of groups) {
    const seen = (row: (typeof group.rows)[number]) => row.seen ? Date.parse(row.seen.$date) : 0
    const [last, next] = [...group.rows].sort((a, b) => seen(b) - seen(a))
    if (!last || !seen(last) || (next && seen(next) === seen(last))) continue
    result.computers.push({ signedIn: { machineId: last.machineId, ownerId: last.userId },
      others: group.rows.filter(row => row.userId !== last.userId).map(row => row.machineId) })
    if (write) result.moved += await store.computerSignedIn({ machineId: last.machineId, ownerId: last.userId, computerId: group._id, autonomousEnv })
  }
  return result
}

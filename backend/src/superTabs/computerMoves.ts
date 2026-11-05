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

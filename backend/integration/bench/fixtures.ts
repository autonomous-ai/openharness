import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../src/lib/ssoAuth.js'

/** Person [n]: 0 is the Swarm's owner, n ≥ 1 owns machine n. Ids are Mongo ObjectIds, as the User model needs. */
export function person(n: number): AuthUser {
  return { sub: (0x100000000000000000000001n + BigInt(n)).toString(16).padStart(24, '0'), email: `bench-${n}@example.com`,
    autonomousEnv: 'prod', role: 'user' }
}

export const machineId = (n: number) => `bench-machine-${n}`

/** The accounts and machine rows behind a Swarm: synthetic, local, one person per machine. Not part of any Swarm's state,
 *  so every driver shares them. */
export async function seedAccounts(db: PrismaClient, machines: number): Promise<AuthUser[]> {
  const people = Array.from({ length: machines }, (_, n) => person(n))
  for (const user of people) {
    await db.user.create({ data: { id: user.sub, externalId: `bench-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  }
  for (let n = 0; n < machines; n++) {
    await db.machine.create({ data: { machineId: machineId(n), userId: people[n]!.sub, apiKey: 'bench-only', managerId: 'bench',
      autonomousEnv: 'prod', authMode: 'remote', name: `Bench machine ${n}` } })
  }
  return people
}

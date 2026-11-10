import type { AuthUser } from '../lib/ssoAuth.js'

type Listener = (user: AuthUser) => Promise<unknown>
let listener: Listener | null = null

/** The Swarm routes' store takes account renames from here (routes/superTabs.ts), so the auth routes load no Swarm code. */
export function onAccountRenamed(next: Listener | null): void {
  listener = next
}

/** The person's name in each of their Swarms follows their account's (personNames.ts nameFromAccount; anh Dee, 2026-11-10).
 *  Nothing to do when no Swarm routes run here. A Swarm that fails is logged by the store and the rest go on. */
export async function accountRenamed(user: AuthUser): Promise<void> {
  await listener?.(user)
}

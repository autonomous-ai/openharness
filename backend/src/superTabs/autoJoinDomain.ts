import { isPublicEmailDomain } from '../lib/publicEmailDomains.js'
import type { SuperTabState } from './model.js'

// Kept apart from sharing.ts, whose link tokens load the server's settings: the Swarm model and every commit read this, and
// importing them must not load the environment (integration/workerIndexPlans.test.ts points the app's database first).

/** The domain whose people join this Swarm by themselves, while its owner has that on; null otherwise. A saved domain anyone
 *  can have an address at never counts, whatever an older release saved. */
export function autoJoinOn(state: Pick<SuperTabState, 'sharing' | 'deletion'>): string | null {
  const access = state.sharing?.access
  return !state.deletion && access?.mode === 'domain' && access.autoJoin === true && !isPublicEmailDomain(access.domain) ? access.domain : null
}

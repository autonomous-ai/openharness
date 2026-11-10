import { logger } from '../utils/logger.js'

/** An account whose name changed (services/UserService.ts): by the person, an admin, or a first sign-in filling an empty one. */
export interface AccountRename { userId: string; autonomousEnv: string }

type Listener = (rename: AccountRename) => Promise<unknown>
let listener: Listener | null = null

/** The Swarm routes' store takes account renames from here (routes/superTabs.ts), so UserService loads no Swarm code. */
export function onAccountRenamed(next: Listener | null): void {
  listener = next
}

/** How long a rename waits for its Swarms to follow before it answers; they go on after that. */
export const FOLLOW_WAIT_MS = 5_000

/** The person's name in each of their Swarms follows their account's (personNames.ts nameFromAccount; anh Dee, 2026-11-10), awaited
 *  up to [FOLLOW_WAIT_MS] so their apps' next read shows it. Never throws: the rename stands, and a failure is logged. Nothing to do
 *  when no Swarm routes run here. */
export async function accountRenamed(rename: AccountRename): Promise<void> {
  if (!listener) return
  const following = listener(rename).catch(error => {
    logger.warn('[account] a rename did not reach its Swarms', { userId: rename.userId, error: error instanceof Error ? error.name : 'unknown' })
  })
  let timer: NodeJS.Timeout | undefined
  await Promise.race([following, new Promise<void>(resolve => { timer = setTimeout(resolve, FOLLOW_WAIT_MS); timer.unref() })])
  clearTimeout(timer)
}

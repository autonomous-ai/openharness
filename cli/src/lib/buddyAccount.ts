import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'

/**
 * The account signed in on this machine, as every Buddy's guard holds a wide grant for it (lib/buddyGuard.ts, delta reviews
 * of #2310). The host writes it at its start, none until it knows, and every sign-out and the host's stop remove it, so a
 * running Buddy loses its grant at once. Apart from the guard so the sign-out path (lib/signOut.ts), loaded by every
 * command, loads nothing more.
 */

/** Beside the lists; not a list, so no sweep removes it. */
export const buddyAccountFile = (dataDir: string = env.ADAPTER_DATA_DIR): string => join(dataDir, 'buddy-reads', 'signed-in.account')

/** Records the account signed in on this machine, or that none is ([accountId] null), as one rename, mode 600. */
export function writeBuddyAccount(accountId: string | null, dataDir: string = env.ADAPTER_DATA_DIR): void {
  const file = buddyAccountFile(dataDir)
  if (!accountId) { rmSync(file, { force: true }); return }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify({ accountId })}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

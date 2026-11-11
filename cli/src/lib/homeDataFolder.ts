import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** `path` with symlinks resolved as far as it exists; the part that does not exist yet is kept as written. */
function realOrResolved(path: string): string {
  let existing = resolve(path)
  const rest: string[] = []
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing))
    existing = dirname(existing)
  }
  try { return join(realpathSync(existing), ...rest) } catch { return resolve(path) }
}

/**
 * Whether an ADAPTER_DATA_DIR in the environment is the account's own Harness folder reached through a
 * HOME that is no longer the account's.
 *
 * An agent's environment carries the daemon's ADAPTER_DATA_DIR. A run that points HOME at a throwaway
 * folder to be isolated (a tester running a branch from source) still inherited that variable, so its
 * "isolated" `harness start` read and replaced the real account's running Harness. The data folder is
 * meant to follow HOME: a variable that names a folder inside the account's real `~/.harness` while HOME is
 * somewhere else is that inheritance, not a choice. A folder anywhere else is a choice (a test rig, a
 * custom install) and stays. Paths are compared by their real location, so a HOME that is a link to the
 * account's home is the account's home, and a folder under `.harness` is not the default one's twin.
 *
 * `accountHome` is the account's home from the system, never from HOME.
 */
export function inheritedAccountDataFolder(
  environ: { HOME?: string; ADAPTER_DATA_DIR?: string },
  accountHome: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return false // homedir() follows USERPROFILE there, not HOME
  const home = environ.HOME?.trim()
  const dataDir = environ.ADAPTER_DATA_DIR?.trim()
  if (!home || !dataDir || !accountHome) return false
  const account = realOrResolved(accountHome)
  if (realOrResolved(home) === account) return false
  const inside = relative(realOrResolved(join(account, '.harness')), realOrResolved(dataDir))
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) && !inside.startsWith(sep)
}

import { join, relative, resolve, isAbsolute, sep } from 'node:path'

/**
 * Whether an ADAPTER_DATA_DIR in the environment is the account's own Harness folder reached through a
 * HOME that is no longer the account's.
 *
 * An agent's environment carries the daemon's ADAPTER_DATA_DIR. A run that points HOME at a throwaway
 * folder to be isolated (a tester running a branch from source) still inherited that variable, so its
 * "isolated" `harness start` read and replaced the real account's running Harness. The data folder is
 * meant to follow HOME: a variable that names a folder inside the account's real `~/.harness` while HOME
 * is somewhere else is that inheritance, not a choice. A folder anywhere else is a choice (a test rig, a
 * custom install) and stays.
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
  if (resolve(home) === resolve(accountHome)) return false
  const inside = relative(join(resolve(accountHome), '.harness'), resolve(dataDir))
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) && !inside.startsWith(sep)
}

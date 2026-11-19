import { userInfo } from 'node:os'
import { inheritedAccountDataFolder } from '../lib/homeDataFolder.js'
import { harnessPathText, legacyHarnessHome, xdgRoots } from './harnessHome.js'

/** The commands that start, stop or wipe a daemon or its folder: under a HOME that is not the account's they act
 *  on that HOME's data folder, never the account's. The ones an agent uses to reach its own daemon (send, new, ...) keep
 *  the variable. */
export const HOME_FOLLOWING_COMMANDS = ['start', 'stop', 'login', 'logout', 'update', 'reset', 'uninstall', 'service', 'status', 'logs']

/** Every place the account's Harness folders can be, its home written `~`: on Linux ~/.harness before the move, and the XDG roots. */
function harnessFolders(account: string): string {
  const folders = [legacyHarnessHome(account), ...(process.platform === 'linux' ? Object.values(xdgRoots(account, process.env)) : [])]
    .map((folder) => folder.startsWith(`${account}/`) ? `~${folder.slice(account.length)}` : folder)
  return folders.length > 1 ? `${folders.slice(0, -1).join(', ')} and ${folders.at(-1)}` : folders[0]!
}

/**
 * A daemon command under a HOME that is not the account's gets that HOME's data folder, never the account's
 * through an inherited ADAPTER_DATA_DIR (lib/homeDataFolder.ts). Imported first by cli.ts, before env.ts reads
 * the variable; the daemon `start` spawns inherits the corrected environment. Said on stderr, never silent.
 */
if (HOME_FOLLOWING_COMMANDS.includes(process.argv[2] ?? '')) {
  try {
    const account = userInfo().homedir
    if (inheritedAccountDataFolder(process.env, account)) {
      console.error(`harness: HOME is ${process.env.HOME}, not this account's home, so ignoring ADAPTER_DATA_DIR=${process.env.ADAPTER_DATA_DIR}; using ${harnessPathText('cli', process.env.HOME)}/data. Set ADAPTER_DATA_DIR to a folder outside ${harnessFolders(account)} to choose one.`)
      delete process.env.ADAPTER_DATA_DIR
    }
  } catch { /* no passwd entry: nothing to compare with */ }
}

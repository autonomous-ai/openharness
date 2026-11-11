import { userInfo } from 'node:os'
import { inheritedAccountDataFolder } from '../lib/homeDataFolder.js'

/** The commands that start, stop or wipe a daemon or its folder: under a HOME that is not the account's they act
 *  on that HOME's data folder, never the account's. The ones an agent uses to reach its own daemon (send, new,
 *  super-tab ...) keep the variable. */
export const HOME_FOLLOWING_COMMANDS = ['start', 'stop', 'login', 'logout', 'update', 'reset', 'uninstall', 'service', 'status', 'logs']

/**
 * A daemon command under a HOME that is not the account's gets that HOME's data folder, never the account's
 * through an inherited ADAPTER_DATA_DIR (lib/homeDataFolder.ts). Imported first by cli.ts, before env.ts reads
 * the variable; the daemon `start` spawns inherits the corrected environment. Said on stderr, never silent.
 */
if (HOME_FOLLOWING_COMMANDS.includes(process.argv[2] ?? '')) {
  try {
    if (inheritedAccountDataFolder(process.env, userInfo().homedir)) {
      console.error(`harness: HOME is ${process.env.HOME}, not this account's home, so ignoring ADAPTER_DATA_DIR=${process.env.ADAPTER_DATA_DIR}; using ${process.env.HOME}/.harness/cli/data. Set ADAPTER_DATA_DIR to a folder outside ~/.harness to choose one.`)
      delete process.env.ADAPTER_DATA_DIR
    }
  } catch { /* no passwd entry: nothing to compare with */ }
}

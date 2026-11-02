import { userInfo } from 'node:os'
import { inheritedAccountDataFolder } from '../lib/homeDataFolder.js'

/**
 * `harness start` under a HOME that is not the account's gets that HOME's data folder, never the
 * account's through an inherited ADAPTER_DATA_DIR (lib/homeDataFolder.ts). Imported first by cli.ts,
 * before env.ts reads the variable; the daemon `start` spawns inherits the corrected environment.
 */
if (process.argv[2] === 'start') {
  try {
    if (inheritedAccountDataFolder(process.env, userInfo().homedir)) delete process.env.ADAPTER_DATA_DIR
  } catch { /* no passwd entry: nothing to compare with */ }
}

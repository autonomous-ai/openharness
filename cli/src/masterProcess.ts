/**
 * harnessd's master as a process: what `harness start` runs (`__harnessd`), and the probe a master about
 * to re-execute on a new bundle asks first (`__harnessd-probe`, harnessd/reexec.ts).
 *
 * Its own module, so the bundle's entry (entry.ts) can start a master that evaluates only what a master
 * runs: harnessd/, the paths it is given and the update backups it restores. The master holds no feature
 * code (harnessd/AGENTS.md), and still weighed what the whole CLI weighs, because every process
 * evaluated the whole bundle: 160 MiB resident at idle, measured from the bundle (2026-10-05).
 */
import { join } from 'node:path'
import { env } from './config/env.js'
import { probeMaster, runMaster } from './harnessd/master.js'
import { ensureUtf8Locale } from './lib/childLocale.js'
import { DAEMON_LOG_FILE, HARNESSD_STATUS_FILE, PID_FILE } from './lib/daemonState.js'
import { confirm as confirmUpdate, restore as restoreUpdate, unjudgedUpdate } from './lib/selfUpdate.js'
import { VERSION } from './version.js'

/** Where a master re-executing on a new bundle leaves word of it, until that master's core is up. */
export const HARNESSD_REEXEC_FILE = join(env.ADAPTER_DATA_DIR, 'harnessd-reexec.json')

export interface MasterStart {
  /** What the core and the services run, and an update replaces: cli.js, or src/cli.ts from the sources. */
  scriptPath: string
}

/** Run the master. */
export function startMaster(start: MasterStart): ReturnType<typeof runMaster> {
  // Before it starts anything: on Linux an absent locale makes tmux and ps mangle their output, and the
  // core and the services inherit this environment (lib/childLocale.ts). launchd and systemd start the
  // master with no `harness start` before it to have set it.
  ensureUtf8Locale()
  return runMaster({
    nodePath: process.execPath,
    execArgv: process.execArgv,
    ...start,
    pidFile: PID_FILE,
    statusFile: HARNESSD_STATUS_FILE,
    logFile: DAEMON_LOG_FILE,
    restoreUpdate: () => restoreUpdate(env.ADAPTER_CLI_DIR),
    confirmUpdate: () => confirmUpdate(env.ADAPTER_CLI_DIR),
    version: VERSION,
    reexecMarkerFile: HARNESSD_REEXEC_FILE,
    unjudgedUpdate: (bundle) => unjudgedUpdate(env.ADAPTER_CLI_DIR, bundle),
  })
}

/** Whether this bundle can run a master that takes over from the running one; the exit code. */
export function probeThisMaster(): number {
  return probeMaster({ env: process.env, execArgv: process.execArgv, version: VERSION })
}

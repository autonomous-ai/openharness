/**
 * What names the managed Node besides current-node. The updater moves current-node (to Node 24, or back on a
 * rollback: lib/selfUpdate.ts) and the master runs on what it names (masterProcess.ts), but two files were written
 * with a Node in them and never read current-node: the `harness` launcher in the bin folder, and the launchd agent
 * or systemd unit `harness service install` wrote. The master repoints both each time its core comes up
 * (masterProcess.ts `coreUp`), so a terminal's `harness` and the platform's next start of the master run the Node the
 * daemon runs. The core did it until 13 November 2026, and loaded the platform's code for it; a core with no master
 * leaves them, since nothing moves its Node.
 *
 * Windows has neither: harness.exe, harness-launch.exe and the scheduled task that runs it read current-node at
 * every start (pty/src/launcher.rs).
 */
import { sep } from 'node:path'
import { env } from '../config/env.js'
import { baseNode } from '../harnessd/baseNode.js'
import { PlatformService, defaultPlatformDeps, platformFor } from '../harnessd/platform.js'
import { DAEMON_LOG_FILE } from './daemonState.js'
import { ensureLauncher } from './launchers.js'

/** Which reference was rewritten. */
export interface NodeReferences { launcher: boolean; service: boolean }

/** harnessd's definition on this computer, and the daemon log that tells this data folder's from another's. */
export interface ServiceReference { service: PlatformService | null; logFile: string }

function thisComputer(): ServiceReference {
  const platform = platformFor(process.platform)
  return { service: platform ? new PlatformService(platform, defaultPlatformDeps({ dataDir: env.ADAPTER_DATA_DIR })) : null, logFile: DAEMON_LOG_FILE }
}

/**
 * Point the launcher and the service definition at [node], where they name another: the Node the master started its
 * core on, which that core's coming up just proved (masterProcess.ts `coreUp`; by default the Node this process runs
 * on). Not current-node, which can name a Node no probation judged (a master that could not put it back:
 * masterProcess.ts, lib/selfUpdate.ts `putNodeBack`), and not the master's own, which after a rollback it could not
 * re-execute for is the Node the rollback rejected.
 */
export function refreshNodeReferences(log: (line: string) => void, reference: ServiceReference = thisComputer(), node: string = baseNode(process.execPath)): NodeReferences {
  // Only a Node of ours: nothing is pointed at a Node somebody else installed and may remove.
  if (!node.startsWith(env.ADAPTER_RUNTIME_DIR + sep)) return { launcher: false, service: false }
  const launcher = ensureLauncher(node, log)
  const { service } = reference
  const repointed = service?.repointNode(node, reference.logFile) ?? null
  if (repointed?.ok) log(`  ✓ repointed ${service!.file} at ${node}`)
  else if (repointed) log(`  ✗ ${service!.file} was left on its Node: ${repointed.detail}`)
  return { launcher, service: repointed?.ok === true }
}

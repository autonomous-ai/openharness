import { env } from '../config/env.js'
import { onHarnessOs } from './harnessDefaults.js'
import { within } from './pathContainment.js'
import { nodeMigration, type NodeMigration } from './nodeMigration.js'
import { MINIMUM_NODE_MAJOR } from './nodeRuntime.js'

/** The daemon's Node as `/api/status` reports it: `migration` is why it is below the minimum, null when nothing held it back. */
export type NodeStatus = { version: string; managed: boolean; migration: NodeMigration | null }

const WHY: Record<NodeMigration, string> = {
  'no-manifest-entry': 'no Node 24 for this computer yet',
  'manifest-unreachable': 'could not reach the update server',
  'download-failed': 'the download failed',
  'does-not-run': 'Node 24 did not start here',
  unmanaged: 'this Harness runs on a Node it does not manage; install Node 24',
  'rolled-back': 'Node 24 did not come up; back on 22',
}

export function nodeStatus(of: { version: string; execPath: string; runtimeDir: string; cliDir: string } = {
  version: process.version, execPath: process.execPath, runtimeDir: env.ADAPTER_RUNTIME_DIR, cliDir: env.ADAPTER_CLI_DIR,
}): NodeStatus {
  // A record outlives its cause (install.sh can move the Node to 24 after an update recorded why it did not): it is
  // a reason only while the daemon is still below the minimum.
  const below = Number(of.version.replace(/^v/, '').split('.')[0]) < MINIMUM_NODE_MAJOR
  return { version: of.version, managed: within(of.runtimeDir, of.execPath), migration: below ? nodeMigration(of.cliDir) : null }
}

/** The `node` of a status body; null from a daemon too old to send it, so nothing is shown for it. */
export function readNodeStatus(body: Record<string, unknown>): NodeStatus | null {
  const node = body.node as { version?: unknown; managed?: unknown; migration?: unknown } | undefined
  if (typeof node?.version !== 'string') return null
  const migration = typeof node.migration === 'string' && node.migration in WHY ? node.migration as NodeMigration : null
  return { version: node.version, managed: node.managed === true, migration }
}

/** The `node` row of `harness status`. On Harness OS the daemon runs on the system's Node, which comes with an OS update. */
export function nodeRow(node: NodeStatus, harnessOs: boolean = onHarnessOs()): string {
  if (!node.migration) return node.version
  const why = node.migration === 'unmanaged' && harnessOs ? 'this Harness runs on the Node of Harness OS; update Harness OS' : WHY[node.migration]
  return `${node.version} (stays on ${node.version.replace(/^v/, '').split('.')[0]}: ${why})`
}

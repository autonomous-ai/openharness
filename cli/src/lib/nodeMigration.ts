import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { NodeMigrationReason } from './runtimeInstall.js'

// Read by the daemon's core for `/api/status`, so this file loads nothing the core may not (architecture.spec.ts);
// selfUpdate.ts writes it.
export const NODE_MIGRATION_FILE = 'node-migration.json'

/** Why the daemon is not on the minimum Node: what lib/runtimeInstall.ts `ensureNodeMeetsMinimum` said, or that the
 *  update that moved it there was rolled back. */
export type NodeMigration = NodeMigrationReason | 'rolled-back'
const NODE_MIGRATIONS: readonly NodeMigration[] = ['no-manifest-entry', 'manifest-unreachable', 'download-failed', 'does-not-run', 'unmanaged', 'rolled-back']

/** Why the daemon is not on the minimum Node, as last recorded; null when nothing held it back. What `harness status`
 *  says of the daemon's Node while that Node is below the minimum. */
export function nodeMigration(dir: string): NodeMigration | null {
  let reason: unknown
  try { reason = (JSON.parse(readFileSync(join(dir, NODE_MIGRATION_FILE), 'utf8')) as { reason?: unknown } | null)?.reason } catch { return null }
  return NODE_MIGRATIONS.includes(reason as NodeMigration) ? reason as NodeMigration : null
}

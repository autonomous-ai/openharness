import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { MINIMUM_NODE_MAJOR } from './nodeRuntime.js'
import type { NodeMigrationReason } from './runtimeInstall.js'

// Read and cleared by the daemon's core (`/api/status`, its start), so this file loads nothing the core may not
// (architecture.spec.ts); selfUpdate.ts and the master write it.
export const NODE_MIGRATION_FILE = 'node-migration.json'

/** Why the daemon is not on the minimum Node: what lib/runtimeInstall.ts `ensureNodeMeetsMinimum` said, or that the
 *  update that moved it there was rolled back. */
export type NodeMigration = NodeMigrationReason | 'rolled-back'
const NODE_MIGRATIONS: readonly NodeMigration[] = ['no-manifest-entry', 'manifest-unreachable', 'download-failed', 'does-not-run', 'unmanaged', 'rolled-back']

type Recorded = { reason?: unknown; node?: unknown }

function readRecord(dir: string): Recorded | null {
  try { return JSON.parse(readFileSync(join(dir, NODE_MIGRATION_FILE), 'utf8')) as Recorded | null } catch { return null }
}

/** Why the daemon is not on the minimum Node, as last recorded; null when nothing held it back. What `harness status`
 *  says of the daemon's Node while that Node is below the minimum. */
export function nodeMigration(dir: string): NodeMigration | null {
  const reason = readRecord(dir)?.reason
  return NODE_MIGRATIONS.includes(reason as NodeMigration) ? reason as NodeMigration : null
}

/** The managed Node that did not hold up here (a rollback moved the daemon off it, or the build or the master did not
 *  run on it); the updater does not move to it again (lib/selfUpdate.ts `startSelfUpdater`). Null when none did. */
export function failedNode(dir: string): string | null {
  const node = readRecord(dir)?.node
  return typeof node === 'string' ? node : null
}

/**
 * Record why the daemon is not on the minimum Node, or, with null, that nothing holds it back. [failed] names the Node
 * that caused it; left out, the one recorded before stays: a later update that could not even read the manifest must
 * not forget that the Node it offers already failed here.
 */
export function recordNodeMigration(dir: string, reason: NodeMigration | null, failed: string | null = failedNode(dir)): void {
  const file = join(dir, NODE_MIGRATION_FILE)
  try {
    if (reason === null) { rmSync(file, { force: true }); return }
    // Whole or not at all: a half-written record would read as nothing recorded.
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ reason, at: Date.now(), ...(failed ? { node: failed } : {}) })}\n`)
    renameSync(`${file}.tmp`, file)
  } catch (error) {
    // A full disk costs `harness status` the reason, never the update.
    console.error(`[update] could not record why the daemon's Node stays as it is (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** A core that runs on the minimum Node has nothing held back: what an earlier update recorded no longer applies. */
export function settleNodeMigration(dir: string, running: string = process.versions.node): void {
  if (Number(running.split('.')[0]) >= MINIMUM_NODE_MAJOR) recordNodeMigration(dir, null)
}

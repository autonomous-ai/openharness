import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshRootDir, installedDsh, upsertInstalledRecord } from './installed.js'
import { lockDsh } from './lock.js'
import { readDshManifest } from './manifest.js'

declare const __MODEL_MANAGER_BUNDLE__: string
export const MODEL_MANAGER_ID = 'autonomous/autonomous-grid'
export type BundledFiles = Record<string, { content: string; executable: boolean }>

/** Install the trusted, release-bundled harness. Runtime provisioning remains
 * owned by the existing managed Grid installer. Versioned package directories
 * keep running managers intact while a newer CLI installs its own resources. */
export function ensureBundledModelManager(files?: BundledFiles): boolean {
  files ??= typeof __MODEL_MANAGER_BUNDLE__ === 'string' ? JSON.parse(__MODEL_MANAGER_BUNDLE__) as BundledFiles : undefined
  if (!files || !files['harness.json']) return false
  return installBuiltin({ id: MODEL_MANAGER_ID, source: 'builtin:model-manager', folder: 'model-manager', files, what: 'Model Manager' })
}

/** The pair harness (pair/pairHarness.ts): generated on this machine, never listed in the Store or the picker. */
export const PAIR_BUILTIN_SOURCE = 'builtin:pair'

/** Install the pair harness's generated package. True once it is installed at this revision. */
export function ensureBuiltinPair(id: string, files: BundledFiles): boolean {
  if (!files['harness.json']) return false
  return installBuiltin({ id, source: PAIR_BUILTIN_SOURCE, folder: 'pair', files, what: 'pair harness' })
}

/** A built-in that is the daemon's own and no person's to pick: the pair harness. */
export function isHiddenBuiltin(record: { source?: string | null }): boolean {
  return record.source === PAIR_BUILTIN_SOURCE
}

/** Materialize `files` under `.bundled/<folder>/<revision>` and point the index at it. Idempotent per revision. */
function installBuiltin(opts: { id: string; source: string; folder: string; files: BundledFiles; what: string }): boolean {
  const { id, source, folder, files } = opts
  const current = installedDsh(id)
  // A developer's linked checkout is theirs. Never replace it with release files.
  if (current?.linked) return true
  const revision = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  if (current?.source === source && current.revision === revision) return true
  const unlock = lockDsh(id)
  if (!unlock) return false
  const dir = join(dshRootDir(), '.bundled', folder, revision)
  const staging = `${dir}.${randomUUID()}.tmp`
  try {
    if (!existsSync(dir)) {
      for (const [path, file] of Object.entries(files)) {
        if (!path || path.startsWith('/') || path.split(/[\\/]/).includes('..')) throw new Error('Invalid built-in package path')
        const destination = join(staging, path)
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
        writeFileSync(destination, file.content, { mode: file.executable ? 0o700 : 0o600 })
      }
      const manifest = readDshManifest(staging)
      if (!manifest.ok || manifest.manifest.id !== id) throw new Error(`Invalid bundled ${opts.what}`)
      renameSync(staging, dir)
    }
    upsertInstalledRecord({ id, dir, source, ref: null,
      commit: null, revision, linked: false, installedAt: current?.installedAt ?? Date.now(), updatedAt: Date.now() })
    return true
  } finally {
    rmSync(staging, { recursive: true, force: true })
    unlock()
  }
}

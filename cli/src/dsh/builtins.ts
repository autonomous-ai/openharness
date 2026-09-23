import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshRootDir, installedDsh, upsertInstalledRecord } from './installed.js'
import { lockDsh } from './lock.js'
import { readDshManifest } from './manifest.js'

declare const __MODEL_MANAGER_BUNDLE__: string
export const MODEL_MANAGER_ID = 'autonomous/autonomous-grid'
type BundledFiles = Record<string, { content: string; executable: boolean }>

/** Install the trusted, release-bundled harness. Runtime provisioning remains
 * owned by the existing managed Grid installer. Versioned package directories
 * keep running managers intact while a newer CLI installs its own resources. */
export function ensureBundledModelManager(files?: BundledFiles): boolean {
  files ??= typeof __MODEL_MANAGER_BUNDLE__ === 'string' ? JSON.parse(__MODEL_MANAGER_BUNDLE__) as BundledFiles : undefined
  if (!files || !files['harness.json']) return false
  const current = installedDsh(MODEL_MANAGER_ID)
  // A developer's linked checkout is theirs. Never replace it with release files.
  if (current?.linked) return true
  const revision = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  if (current?.source === 'builtin:model-manager' && current.revision === revision) return true
  const unlock = lockDsh(MODEL_MANAGER_ID)
  if (!unlock) return false
  const dir = join(dshRootDir(), '.bundled', 'model-manager', revision)
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
      if (!manifest.ok || manifest.manifest.id !== MODEL_MANAGER_ID) throw new Error('Invalid bundled Model Manager')
      renameSync(staging, dir)
    }
    upsertInstalledRecord({ id: MODEL_MANAGER_ID, dir, source: 'builtin:model-manager', ref: null,
      commit: null, revision, linked: false, installedAt: current?.installedAt ?? Date.now(), updatedAt: Date.now() })
    return true
  } finally {
    rmSync(staging, { recursive: true, force: true })
    unlock()
  }
}

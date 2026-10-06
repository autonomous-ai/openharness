import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEVICES_BUILTIN_SOURCE, DEVICES_HARNESS_ID, HARNESS_MONITOR_BUILTIN_SOURCE, HARNESS_MONITOR_ID, MODEL_MANAGER_ID } from './builtinIds.js'
import { dshRootDir, isBrokenDsh, readInstalledIndex, resolveInstalled, upsertInstalledRecord } from './installed.js'
import { lockDsh } from './lock.js'
import { readDshManifest } from './manifest.js'
import { HARNESS_MONOREPO } from './registry.js'
import { samePackageSource } from './updates.js'

declare const __MODEL_MANAGER_BUNDLE__: string
declare const __DEVICES_BUNDLE__: string
declare const __HARNESS_MONITOR_BUNDLE__: string
export {
  DEVICES_BUILTIN_SOURCE, DEVICES_HARNESS_ID, HARNESS_MONITOR_BUILTIN_SOURCE, HARNESS_MONITOR_ID, isHiddenBuiltin, MODEL_MANAGER_ID,
} from './builtinIds.js'
export type BundledFiles = Record<string, { content: string; executable: boolean; encoding?: 'base64' }>

/** Install the trusted, release-bundled harness. Runtime provisioning remains
 * owned by the existing managed Grid installer. Versioned package directories
 * keep running managers intact while a newer CLI installs its own resources. */
export function ensureBundledModelManager(files?: BundledFiles): boolean {
  files ??= typeof __MODEL_MANAGER_BUNDLE__ === 'string' ? JSON.parse(__MODEL_MANAGER_BUNDLE__) as BundledFiles : undefined
  if (!files || !files['harness.json']) return false
  return installBuiltin({ id: MODEL_MANAGER_ID, source: 'builtin:model-manager', folder: 'model-manager', files, what: 'Model Manager', legacyPath: 'store/agents/autonomous-grid' })
}

/** An unlisted first-party DSH. Its viewer is native; its agent uses the same daemon API. */
export function ensureBundledDevices(files?: BundledFiles): boolean {
  files ??= typeof __DEVICES_BUNDLE__ === 'string' ? JSON.parse(__DEVICES_BUNDLE__) as BundledFiles : undefined
  if (!files?.['harness.json']) return false
  return installBuiltin({ id: DEVICES_HARNESS_ID, source: DEVICES_BUILTIN_SOURCE, folder: 'devices', files, what: 'Devices', legacyPath: 'store/agents/devices' })
}

/** The footer's monitor follows the CLI release, including existing official Store installations. */
export function ensureBundledHarnessMonitor(files?: BundledFiles): boolean {
  files ??= typeof __HARNESS_MONITOR_BUNDLE__ === 'string' ? JSON.parse(__HARNESS_MONITOR_BUNDLE__) as BundledFiles : undefined
  if (!files?.['harness.json']) return false
  return installBuiltin({ id: HARNESS_MONITOR_ID, source: HARNESS_MONITOR_BUILTIN_SOURCE, folder: 'harness-monitor', files,
    what: 'Harness Monitor', legacyPath: 'store/agents/harness-monitor' })
}

/** Core app DSHs ship with the release. Store applications keep their explicit Update action. */
export function ensureBundledCoreHarnesses(log: (line: string) => void = console.warn): boolean {
  let ready = true
  for (const [name, install] of [
    ['Model Manager', ensureBundledModelManager], ['Devices', ensureBundledDevices], ['Harness Monitor', ensureBundledHarnessMonitor],
  ] as const) {
    try { if (!install()) ready = false }
    catch (error) {
      ready = false
      log(`[core-harnesses] Could not prepare ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return ready
}

/** Materialize `files` under `.bundled/<folder>/<revision>` and point the index at it. Idempotent per revision. */
function installBuiltin(opts: { id: string; source: string; folder: string; files: BundledFiles; what: string; legacyPath?: string }): boolean {
  const { id, source, folder, files } = opts
  const current = readInstalledIndex().find(record => record.id === id)
  // A developer's linked checkout is theirs. Never replace it with release files.
  if (current?.linked) return true
  // Adopt only our own old Store package. A matching id does not make a fork or local copy ours.
  if (current && current.source !== source && (!opts.legacyPath || !samePackageSource(current, { repo: HARNESS_MONOREPO, path: opts.legacyPath }))) return true
  const revision = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  if (current?.source === source && current.revision === revision && !isBrokenDsh(resolveInstalled(current))) return true
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
        writeFileSync(destination, file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content,
          { mode: file.executable ? 0o700 : 0o600 })
      }
      const manifest = readDshManifest(staging)
      if (!manifest.ok || manifest.manifest.id !== id) throw new Error(`Invalid bundled ${opts.what}`)
      renameSync(staging, dir)
    }
    const manifest = readDshManifest(dir)
    if (!manifest.ok || manifest.manifest.id !== id) throw new Error(`Invalid bundled ${opts.what}`)
    upsertInstalledRecord({ id, dir, source, ref: null,
      commit: null, revision, linked: false, installedAt: current?.installedAt ?? Date.now(), updatedAt: Date.now() })
    return true
  } finally {
    rmSync(staging, { recursive: true, force: true })
    unlock()
  }
}

/**
 * The release-bundled harnesses' ids and sources, and which of them the public picker leaves out: what
 * the core, the models service and the Store's list read of them. A module of their own, so that the
 * Store's process, which lists them (./wire.ts), does not load their installing (./builtins.ts) and the
 * bundled files it carries: about 1 MB of code in a lean process
 * (docs/design/2026-10-06-core-boundary-next.md, step 6).
 */
export const MODEL_MANAGER_ID = 'autonomous/autonomous-grid'
export const MODEL_MANAGER_BUILTIN_SOURCE = 'builtin:model-manager'
export const DEVICES_HARNESS_ID = 'autonomous/devices'
export const DEVICES_BUILTIN_SOURCE = 'builtin:devices'
export const HARNESS_MONITOR_ID = 'autonomous/harness-monitor'
export const HARNESS_MONITOR_BUILTIN_SOURCE = 'builtin:harness-monitor'
export const MEMORIES_ID = 'autonomous/memories'
export const MEMORIES_BUILTIN_SOURCE = 'builtin:memories'
/** Hachi, the person's own harness that starts and follows their others (docs/design/2026-11-12-hachi.md): the one
 *  caller `harness goal` answers (services/goals.ts). */
export const HACHI_ID = 'autonomous/hachi'

/** Built-ins opened through their own product entry points, absent from the public picker. */
export function isHiddenBuiltin(record: { source?: string | null }): boolean {
  return record.source === 'builtin:pair' || record.source === DEVICES_BUILTIN_SOURCE
}

/** The harnesses a release bundles, under the names its build gives their files (./bundledFiles.ts), and what the
 *  installed index records of each once the Store has put it in place (./builtins.ts `installBuiltin`). */
export const BUNDLED_HARNESSES = [
  { name: 'models', id: MODEL_MANAGER_ID, source: MODEL_MANAGER_BUILTIN_SOURCE, what: 'Model Manager' },
  { name: 'devices', id: DEVICES_HARNESS_ID, source: DEVICES_BUILTIN_SOURCE, what: 'Devices' },
  { name: 'monitor', id: HARNESS_MONITOR_ID, source: HARNESS_MONITOR_BUILTIN_SOURCE, what: 'Harness Monitor' },
  { name: 'memories', id: MEMORIES_ID, source: MEMORIES_BUILTIN_SOURCE, what: 'Memories' },
] as const

declare const __BUILTIN_REVISIONS__: string | undefined

/**
 * The revision of each harness this build bundles, by its name: what ./builtins.ts records in the installed index
 * once it is in place (the sha256 of its files' JSON), worked out by the release build (build-bundle.mjs). The core
 * checks the index against it as it starts, without loading the files (core/viewersWake.ts). None in a build from the
 * sources, which bundles no files and so has none to put in place.
 */
export function bundledRevisions(): Readonly<Record<string, string>> {
  if (typeof __BUILTIN_REVISIONS__ !== 'string') return {}
  try {
    const revisions: unknown = JSON.parse(__BUILTIN_REVISIONS__)
    return revisions && typeof revisions === 'object' && !Array.isArray(revisions) ? revisions as Record<string, string> : {}
  } catch {
    return {}
  }
}

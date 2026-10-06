/**
 * The release-bundled harnesses' ids and sources, and which of them the public picker leaves out: what
 * the core, the models service and the Store's list read of them. A module of their own, so that the
 * Store's process, which lists them (./wire.ts), does not load their installing (./builtins.ts) and the
 * bundled files it carries: about 1 MB of code in a lean process
 * (docs/design/2026-10-06-core-boundary-next.md, step 6).
 */
export const MODEL_MANAGER_ID = 'autonomous/autonomous-grid'
export const DEVICES_HARNESS_ID = 'autonomous/devices'
export const DEVICES_BUILTIN_SOURCE = 'builtin:devices'
export const HARNESS_MONITOR_ID = 'autonomous/harness-monitor'
export const HARNESS_MONITOR_BUILTIN_SOURCE = 'builtin:harness-monitor'

/** Built-ins opened through their own product entry points, absent from the public picker. */
export function isHiddenBuiltin(record: { source?: string | null }): boolean {
  return record.source === 'builtin:pair' || record.source === DEVICES_BUILTIN_SOURCE
}

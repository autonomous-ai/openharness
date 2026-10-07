import type { BundledFiles } from './builtins.js'

declare const __MODEL_MANAGER_BUNDLE__: string
declare const __DEVICES_BUNDLE__: string
declare const __HARNESS_MONITOR_BUNDLE__: string

/** Kept in one shared asset module by the lean build; the self-contained CLI embeds the same bytes. */
export function builtinFiles(name: 'models' | 'devices' | 'monitor'): BundledFiles | undefined {
  const source = name === 'models' ? (typeof __MODEL_MANAGER_BUNDLE__ === 'string' ? __MODEL_MANAGER_BUNDLE__ : undefined)
    : name === 'devices' ? (typeof __DEVICES_BUNDLE__ === 'string' ? __DEVICES_BUNDLE__ : undefined)
      : (typeof __HARNESS_MONITOR_BUNDLE__ === 'string' ? __HARNESS_MONITOR_BUNDLE__ : undefined)
  return source === undefined ? undefined : JSON.parse(source) as BundledFiles
}

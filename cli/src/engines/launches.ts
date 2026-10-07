import type { EngineLaunch } from './facets/launch.js'
import { launch as claude } from './claude/launch.js'
import { launch as codex } from './codex/launch.js'
export { codexEnvArgs } from './codex/launch.js'

/** Launch metadata has no transcript imports: preparing argv must not load transcript readers. */
export const engineLaunches = { claude, codex }
type MigratedEngine = keyof typeof engineLaunches

/** Compatibility tables take their migrated entries from the same launch contract. */
export function launchField<K extends keyof EngineLaunch>(key: K): Record<MigratedEngine, EngineLaunch[K]> {
  return Object.fromEntries(Object.entries(engineLaunches).map(([name, launch]) => [name, launch[key]])) as Record<MigratedEngine, EngineLaunch[K]>
}
export const harnessAdapters = Object.fromEntries(Object.entries(engineLaunches).map(([name, launch]) => [name, {
  instructionFiles: launch.instructionFiles, ...(launch.contextArgs ? { contextArgs: launch.contextArgs } : {}),
  ...(launch.envArgs ? { envArgs: launch.envArgs } : {}),
}])) as Record<MigratedEngine, Pick<EngineLaunch, 'instructionFiles' | 'contextArgs' | 'envArgs'>>

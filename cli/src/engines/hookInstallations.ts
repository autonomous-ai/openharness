/** Native file installation for CLI callers and explicit inline compatibility, outside core's closure. */
import { hooks as claude } from './claude/hookContract.js'
import { hooks as codex } from './codex/hookContract.js'
import { installHookSettings, type HookEngine } from './kit/hookSettings.js'
import type { NativeHookOptions } from './kit/nativeLocations.js'
import type { HookContract } from './facets/hooks.js'

export const hookContracts = { claude, codex } satisfies Record<string, HookContract>
const installer = (engine: HookEngine, contract: HookContract) => ({
  install: (port: number, options?: NativeHookOptions) => installHookSettings(engine, contract.settings, port, undefined, options),
  installIn: (port: number, home: string, options?: NativeHookOptions) => installHookSettings(engine, contract.settings, port, home, options),
})
export const engineHookInstallations = { claude: installer('claude', claude), codex: installer('codex', codex) }

/** Core selects native destinations and retains launch authority; engineSetup renders their contents. */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { LAUNCH_LOCATION_VARIABLES, nativeHookLocations, type NativeHookOptions } from './kit/nativeLocations.js'
import { publishNativeHookFiles, type NativeHookDestination } from './kit/nativeHookPublication.js'
import { nativeHookHomes } from './kit/nativeHookHomes.js'
import { isRecordHome, rememberRecordHome } from './kit/hermesRecordHomes.js'
import { HERMES_CONFIG_HOMES } from './hermes/contract.js'
import { prepareOpencodeHooks } from './kit/opencodeHookPreparation.js'
import type { OpencodeLaunchSnapshot } from './launchControl.js'
import type { AgentEngine } from './types.js'

function environment(options: NativeHookOptions, engine: AgentEngine, home?: string): Record<string, string> {
  const configured = env as unknown as Record<string, unknown>
  const captured = options.environment ? { ...options.environment } : Object.fromEntries(LAUNCH_LOCATION_VARIABLES.flatMap(key => {
    const value = process.env[key] ?? configured[key]
    return typeof value === 'string' ? [[key, value]] : []
  }))
  captured.HOME ||= homedir()
  if (home) captured[engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : engine === 'codex' ? 'CODEX_HOME' : 'HERMES_HOME'] = home
  // Environment is a record: equivalent snapshots must not conflict because their keys arrived in another order.
  return Object.fromEntries(Object.entries(captured).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}

function destinations(engine: AgentEngine, locations: ReturnType<typeof nativeHookLocations>): NativeHookDestination[] {
  const target = (file: string, mode?: number): NativeHookDestination => ({ file, ...(mode === undefined ? {} : { mode }) })
  if (engine === 'claude' || engine === 'codex') {
    const home = engine === 'claude' ? locations.CLAUDE_HOME : locations.CODEX_HOME
    return [target(join(home, engine === 'claude' ? 'settings.json' : 'hooks.json')),
      ...(engine === 'codex' ? [target(join(home, 'config.toml'), 0o600)] : []),
      ...(process.platform === 'win32' ? [] : [
        ...(engine === 'codex' ? [{ ...target(join(home, 'rules', 'harness.rules'), 0o600), parentMode: 0o700 }] : []),
        { ...target(join(env.HARNESS_AGENT_MESSAGES_DIR, 'hook.mjs'), 0o700), parentMode: 0o700, shared: true as const },
      ])]
  }
  const files: Partial<Record<AgentEngine, string>> = {
    grok: join(locations.GROK_HOME, 'hooks', 'harness.json'), agy: join(locations.AGY_CONFIG_DIR, 'hooks.json'),
    copilot: join(locations.COPILOT_HOME, 'hooks', 'harness.json'), cursor: join(locations.CURSOR_CONFIG_DIR, 'hooks.json'),
    commandcode: join(locations.COMMANDCODE_HOME, 'settings.json'), devin: locations.DEVIN_CONFIG_PATH,
    amp: join(locations.AMP_PLUGIN_DIR, 'launcher-register.ts'), kilo: join(locations.KILO_PLUGIN_DIR, 'launcher-register.js'),
    pi: join(locations.PI_AGENT_DIR, 'extensions', 'launcher-register.ts'),
  }
  if (files[engine]) return [target(files[engine])]
  if (engine === 'hermes') return [target(join(locations.HERMES_HOME, 'config.yaml')), target(join(locations.HERMES_HOME, 'shell-hooks-allowlist.json'))]
  if (engine === 'opencode') return [target(join(locations.OPENCODE_PLUGIN_DIR, 'launcher-register.js')),
    target(join(dirname(locations.OPENCODE_PLUGIN_DIR), 'plugins', 'launcher-register', 'tui.js'))]
  return []
}

async function install(engine: AgentEngine, port: number, options: NativeHookOptions = {}, home?: string,
  extra: { major?: number | null; keepsRecord?: boolean | null; remove?: boolean } = {}): Promise<boolean> {
  const captured = environment(options, engine, home), locations = nativeHookLocations(captured)
  const targets = destinations(engine, locations)
  const input = { engine, port, environment: captured, ...extra,
    ...(engine === 'amp' ? { directories: [{ path: env.AMP_SESSIONS_DIR, mode: 0o700 }] } : {}),
    ...(engine === 'hermes' ? { createMissing: !!home && !!options.environment } : {}),
  }
  return publishNativeHookFiles(input, targets, options.setup ?? {}, { ...options, identity: JSON.stringify([options.identity ?? null, input]) })
}

export const installClaudeHooks = (port: number, home?: string, options: NativeHookOptions = {}): Promise<boolean> => install('claude', port, options, home ?? join(homedir(), '.claude'))
export const installCodexHooks = (port: number, home?: string, options: NativeHookOptions = {}): Promise<boolean> => install('codex', port, options, home)
export const engineHookInstallations = {
  claude: { install: (port: number, options?: NativeHookOptions) => installClaudeHooks(port, undefined, options), installIn: installClaudeHooks },
  codex: { install: (port: number, options?: NativeHookOptions) => installCodexHooks(port, undefined, options), installIn: installCodexHooks },
}
export const installGrokHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => install('grok', port, options)
export const installAgyHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => install('agy', port, options)
export const installCopilotHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => install('copilot', port, options)
export const installCursorHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => install('cursor', port, options)
export const installCommandCodeHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => install('commandcode', port, options)
export const installDevinHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => install('devin', port, options)
export const installKiloPlugin = (port: number, options?: NativeHookOptions): Promise<boolean> => install('kilo', port, options)
export const installPiExtension = (port: number, options?: NativeHookOptions): Promise<boolean> => install('pi', port, options)
export const installAmpPlugin = (port: number, options?: NativeHookOptions): Promise<boolean> => install('amp', port, options)

export async function installHermesHooks(port: number, home?: string, options: NativeHookOptions = {}): Promise<boolean> {
  const homes = home ? [home] : nativeHookHomes(HERMES_CONFIG_HOMES, nativeHookLocations(environment(options, 'hermes')).HERMES_HOME)
  let installed = true
  for (const selected of homes) {
    const keepsRecord = await options.setup?.hermesKeepsRecord(options.executable, options.environment) ?? isRecordHome(selected)
    if (!await install('hermes', port, options, selected, { keepsRecord })) installed = false
  }
  return installed
}

export async function hermesRecordSeen(home: string, port: number, options: NativeHookOptions): Promise<void> {
  if (rememberRecordHome(home) && options.setup?.prepareFiles) await install('hermes', port, options, home, { keepsRecord: true, remove: true })
}

/** The same bounded coordinator as explicit CLI installation; only publication differs. */
export async function installOpencodePlugin(port: number, snapshot?: OpencodeLaunchSnapshot, options: NativeHookOptions = {}): Promise<boolean> {
  const captured = environment(options, 'opencode'), targets = destinations('opencode', nativeHookLocations(captured))
  return prepareOpencodeHooks(targets.map(file => file.file), port, snapshot, options, (major, authority) =>
    publishNativeHookFiles({ engine: 'opencode', port, environment: captured, major }, targets, options.setup ?? {}, authority))
}

/**
 * Every hook, plugin and rule Harness installed into an engine's files (engines/hooks.ts, nativeHooks.ts,
 * core/engines/hooks.ts OTHER_INSTALLERS), for `harness uninstall`: the homes core installs into (each engine's own,
 * the homes the person moved and Harness adopted, the profiles a harness was started with), each file on its own, so
 * one that cannot be read or written is reported and the rest still go.
 */
import { readFileSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { env } from '../config/env.js'
import { durableEngineHomes } from '../lib/engineHomes.js'
import type { HomeCatalog } from './kit/homeCatalog.js'
import { homeIsNetworkOrDevice } from './kit/homeAdoption.js'
import { hookContracts } from './hooks.js'
import { inspectHookFile } from './kit/nativeHookFiles.js'
import { removeJsonHooks, removeOwnedFile, removeReviewedHooks, type HookFileRemoval } from './kit/hookRemoval.js'
import { defaultHookHome, harnessRules, RULES_HEADER } from './kit/hookSettings.js'
import { nativeHookHomes } from './kit/nativeHookHomes.js'
import type { NativeHookSettings } from './kit/nativeHookSettings.js'
import { removeNativeYamlHooks, type NativeYamlHooks } from './kit/nativeHookYaml.js'
import { nativePluginSource, type NativePlugin } from './kit/nativePlugin.js'
import type { Settings } from './kit/notifyHooks.js'
import { hostPlatform } from './kit/windowsFiles.js'
import { WINDOWS_ENGINE_HOMES } from './windowsHomes.js'
import { AGY_HOOK_SETTINGS } from './agy/contract.js'
import { AMP_PLUGIN } from './amp/contract.js'
import { COMMANDCODE_HOOK_SETTINGS } from './commandcode/contract.js'
import { COPILOT_HOOK_SETTINGS } from './copilot/contract.js'
import { CURSOR_HOOK_SETTINGS } from './cursor/contract.js'
import { DEVIN_HOOK_SETTINGS } from './devin/contract.js'
import { GROK_HOOK_SETTINGS } from './grok/contract.js'
import { HERMES_HOOK_SETTINGS } from './hermes/contract.js'
import { KILO_PLUGIN } from './kilo/contract.js'
import { OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN } from './opencode/contract.js'
import { PI_EXTENSION } from './pi/contract.js'

export interface HookTargets {
  claude: { homes: string[]; allowRules: string[] }
  codex: { homes: string[] }
  native: readonly NativeHookSettings[]
  plugins: readonly NativePlugin[]
  hermes: { rule: NativeYamlHooks; homes: string[] }
  /** Why the adopted homes could not be read: only each engine's own home is cleaned then. */
  unread?: string
}

const unique = (paths: string[]): string[] => [...new Set(paths)]

/** The CODEX_HOME and Hermes profiles harnesses were started with (registry rows' `codexHome`, `hermesHome`). */
function profileHomes(dataDir: string): { codex: string[]; hermes: string[] } {
  try {
    const rows = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8')) as unknown
    if (!Array.isArray(rows)) return { codex: [], hermes: [] }
    const pick = (key: 'codexHome' | 'hermesHome') => rows.flatMap((row) => {
      const value = row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : undefined
      return typeof value === 'string' && isAbsolute(value) ? [value] : []
    })
    return { codex: unique(pick('codexHome')), hermes: unique(pick('hermesHome')) }
  } catch {
    return { codex: [], hermes: [] }
  }
}

/** This computer's, as the daemon would install them now. */
export function defaultHookTargets(dataDir: string = env.ADAPTER_DATA_DIR, adopted: () => HomeCatalog = durableEngineHomes): HookTargets {
  let moved: HomeCatalog = { claude: [], codex: [] }
  let unread: string | undefined
  try { moved = adopted() } catch (error) { unread = error instanceof Error ? error.message : String(error) }
  const profiles = profileHomes(dataDir)
  const claude = hookContracts.claude.settings
  const allowRules = claude.allow && 'list' in claude.allow ? harnessRules(claude.allow.rules).flat() : []
  return {
    claude: { homes: unique([defaultHookHome(claude), ...moved.claude]), allowRules },
    codex: { homes: unique([defaultHookHome(hookContracts.codex.settings), ...moved.codex, ...profiles.codex]) },
    native: [GROK_HOOK_SETTINGS, AGY_HOOK_SETTINGS, COPILOT_HOOK_SETTINGS, CURSOR_HOOK_SETTINGS, COMMANDCODE_HOOK_SETTINGS, ...commandCodeProfile(), DEVIN_HOOK_SETTINGS],
    plugins: [KILO_PLUGIN, PI_EXTENSION, AMP_PLUGIN, OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN],
    // A Hermes home on a share is not listed for its profiles: listing it opens it (removeEngineHooks reports it).
    hermes: { rule: HERMES_HOOK_SETTINGS, homes: unique([...(homeIsNetworkOrDevice(HERMES_HOOK_SETTINGS.home) ? [HERMES_HOOK_SETTINGS.home]
      : nativeHookHomes(HERMES_HOOK_SETTINGS.homes, HERMES_HOOK_SETTINGS.home)), ...profiles.hermes]) },
    ...(unread ? { unread } : {}),
  }
}

/**
 * Command Code reads its settings from the profile's `.commandcode` whatever COMMANDCODE_HOME says (measured on the
 * Windows VM, B4.13): Harness installed where COMMANDCODE_HOME points, and an engine that ran there may have been
 * given the same hooks by hand or by an older release. That folder is looked in too, with the same recognizers.
 */
function commandCodeProfile(): NativeHookSettings[] {
  const file = join(homedir(), ...WINDOWS_ENGINE_HOMES.commandcode.folder, basename(COMMANDCODE_HOOK_SETTINGS.file))
  return file === COMMANDCODE_HOOK_SETTINGS.file ? [] : [{ ...COMMANDCODE_HOOK_SETTINGS, file }]
}

/** Why a home on a network share or a device path is left: opening one can start a connection to another computer. */
const NETWORK = 'the path is a network share or a device path, which Harness does not open on Windows'

/** The settings file's hooks before they are taken out, for the review records they are kept under; null unread. */
function settingsBefore(file: string): Settings | null {
  try {
    const content = inspectHookFile(file).content
    const settings: unknown = content === null ? null : JSON.parse(content)
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings as Settings : null
  } catch { return null }
}

/** A plugin is Harness's when it starts with the generated first line (nativePlugin.ts `prepareNativePlugin`). */
export function pluginOwned(rule: NativePlugin): (content: string) => boolean {
  const source = nativePluginSource(rule, { port: '0', credential: '""', version: '""' })
  const first = source.slice(0, source.indexOf('\n') + 1)
  return (content) => first.length > 1 && content.startsWith(first)
}

/**
 * [platform] decides which paths are a network share or a device path: on Windows each is reported and never opened
 * (homeAdoption.ts `homeIsNetworkOrDevice`), as the daemon refuses to adopt one.
 */
export async function removeEngineHooks(targets: HookTargets, platform: NodeJS.Platform = hostPlatform()): Promise<HookFileRemoval[]> {
  const out: HookFileRemoval[] = []
  const claude = hookContracts.claude.settings
  const codex = hookContracts.codex.settings
  const remote = (path: string, file = path): boolean => {
    if (!homeIsNetworkOrDevice(path, platform)) return false
    out.push({ file, removed: 0, failed: NETWORK })
    return true
  }
  for (const home of targets.claude.homes) {
    if (remote(home, join(home, claude.file))) continue
    out.push(await removeJsonHooks(join(home, claude.file), {
      schema: 'nested', messages: true,
      ...(claude.allow && 'list' in claude.allow ? { allowList: claude.allow.list, allowRules: targets.claude.allowRules } : {}),
    }))
  }
  for (const home of targets.codex.homes) {
    const settingsFile = join(home, codex.file)
    if (remote(home, settingsFile)) continue
    // Read before the hooks go: the review records are keyed by the hooks' places in it.
    const before = codex.reviewed ? settingsBefore(settingsFile) : null
    const hooks = await removeJsonHooks(settingsFile, { schema: 'nested', messages: true })
    out.push(hooks)
    // Only once the hooks are out: a record taken away from a hook still there makes Codex ask about it again.
    if (codex.reviewed && before && hooks.removed && !hooks.failed) out.push(await removeReviewedHooks(codex.reviewed, home, settingsFile, before))
    if (codex.allow && 'file' in codex.allow) out.push(await removeOwnedFile(join(home, codex.allow.file), (content) => content.startsWith(RULES_HEADER)))
  }
  for (const rule of targets.native) {
    if (remote(rule.file)) continue
    out.push(await removeJsonHooks(rule.file, { schema: rule.schema, ...(rule.block ? { block: rule.block } : {}), ownedFile: basename(rule.file) === 'harness.json' }))
  }
  for (const rule of targets.plugins) {
    if (remote(rule.file)) continue
    const removed = await removeOwnedFile(rule.file, pluginOwned(rule))
    out.push(removed)
    // OpenCode 2's plugin is a folder of Harness's own (plugins/launcher-register/): it goes once empty.
    if (removed.removed && basename(dirname(rule.file)) === 'launcher-register') { try { rmdirSync(dirname(rule.file)) } catch { /* not empty */ } }
  }
  const hermes = targets.hermes.homes.filter((home) => !remote(home, join(home, targets.hermes.rule.homes.file)))
  out.push(...await removeNativeYamlHooks(targets.hermes.rule, hermes))
  if (targets.unread) out.push({ file: 'the homes Harness adopted', removed: 0, failed: targets.unread })
  return out.filter((o) => o.removed || o.failed || o.kept)
}

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
import { BUDDY_RULES_HEADER, buddyCodexRulesFiles } from '../lib/buddyCodexRules.js'
import { defaultHookHome, harnessRules, notifyHookEntry, RULES_HEADER } from './kit/hookSettings.js'
import { messagesCommand } from './kit/messagesHook.js'
import { nativeHookHomes } from './kit/nativeHookHomes.js'
import type { NativeHookSettings } from './kit/nativeHookSettings.js'
import { removeNativeYamlHooks, type NativeYamlHooks } from './kit/nativeHookYaml.js'
import { nativePluginSource, type NativePlugin } from './kit/nativePlugin.js'
import { hookArgv, type HookBlock, type Settings } from './kit/notifyHooks.js'
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

/** This computer's, as the daemon would install them now. [platform]: whose engines' homes (`commandCodeProfile`). */
export function defaultHookTargets(dataDir: string = env.ADAPTER_DATA_DIR, adopted: () => HomeCatalog = durableEngineHomes,
  platform: NodeJS.Platform = hostPlatform()): HookTargets {
  let moved: HomeCatalog = { claude: [], codex: [] }
  let unread: string | undefined
  try { moved = adopted() } catch (error) { unread = error instanceof Error ? error.message : String(error) }
  const profiles = profileHomes(dataDir)
  const claude = hookContracts.claude.settings
  const allowRules = claude.allow && 'list' in claude.allow ? harnessRules(claude.allow.rules).flat() : []
  return {
    claude: { homes: unique([defaultHookHome(claude), ...moved.claude]), allowRules },
    codex: { homes: unique([defaultHookHome(hookContracts.codex.settings), ...moved.codex, ...profiles.codex]) },
    native: [GROK_HOOK_SETTINGS, AGY_HOOK_SETTINGS, COPILOT_HOOK_SETTINGS, CURSOR_HOOK_SETTINGS, COMMANDCODE_HOOK_SETTINGS, ...commandCodeProfile(platform), DEVIN_HOOK_SETTINGS],
    plugins: [KILO_PLUGIN, PI_EXTENSION, AMP_PLUGIN, OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN],
    // A Hermes home on a share is not listed for its profiles: listing it opens it (removeEngineHooks reports it).
    hermes: { rule: HERMES_HOOK_SETTINGS, homes: unique([...(homeIsNetworkOrDevice(HERMES_HOOK_SETTINGS.home) ? [HERMES_HOOK_SETTINGS.home]
      : nativeHookHomes(HERMES_HOOK_SETTINGS.homes, HERMES_HOOK_SETTINGS.home)), ...profiles.hermes]) },
    ...(unread ? { unread } : {}),
  }
}

/**
 * On Windows, Command Code reads its settings from the profile's `.commandcode` whatever COMMANDCODE_HOME says
 * (measured on the Windows VM, B4.13 and B4.15; not measured elsewhere, so a Mac or Linux looks only where
 * COMMANDCODE_HOME points). Harness installed where COMMANDCODE_HOME points; the profile's folder is looked in too, with
 * the same recognizers, for hooks of Harness's that reached it another way.
 */
function commandCodeProfile(platform: NodeJS.Platform): NativeHookSettings[] {
  if (platform !== 'win32') return []
  const file = join(homedir(), ...WINDOWS_ENGINE_HOMES.commandcode.folder, basename(COMMANDCODE_HOOK_SETTINGS.file))
  return file === COMMANDCODE_HOOK_SETTINGS.file ? [] : [{ ...COMMANDCODE_HOOK_SETTINGS, file }]
}

/** The report's name for the homes Harness adopted, when they could not be read (`HookTargets.unread`). */
export const ADOPTED_HOMES = 'the homes Harness adopted'

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

/**
 * The hooks Harness writes into a Codex home now (hookSettings.ts `installNotifyHooks`, `installMessagesBlock`): what
 * their review records hold the hashes of, for a record whose hook is no longer in the file.
 */
function codexHooksNow(home: string): Settings {
  const settings = hookContracts.codex.settings
  const entry = notifyHookEntry(settings, hookArgv(env.PORT, 'codex', settings.commandNamesHome ? home : undefined))
  const hooks: Record<string, HookBlock[]> = {}
  if (entry) for (const { event, matcher } of settings.events) {
    hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: entry.command, ...(entry.args ? { args: entry.args } : {}), timeout: settings.timeout }] }]
  }
  if (settings.inbox) (hooks[settings.inbox.event] ??= []).push({ hooks: [{ type: 'command', command: messagesCommand(env.HARNESS_AGENT_MESSAGES_DIR), timeout: settings.timeout }] })
  return { hooks }
}

/** Why a plugin of Harness's is kept: its first line is Harness's, the rest is not what Harness writes. */
export const PLUGIN_CHANGED = "Harness's plugin, changed since Harness wrote it; delete it yourself if you no longer need it."
/** What a value of a plugin's template can be: a port, or one JSON string (nativePlugin.ts `NativePluginValues`). */
const SLOTS = {
  port: String.raw`\d{1,5}`,
  credential: String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`,
  version: String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`,
} as const
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A plugin is Harness's when it is exactly the current template (nativePlugin.ts `nativePluginSource`): every literal
 * part, and each value a port or a JSON string, the same one wherever the template uses it again. A file with
 * Harness's generated first line (`prepareNativePlugin`'s mark) and anything else is Harness's plugin changed since,
 * kept with [PLUGIN_CHANGED]; any other file is another author's (false).
 */
export function pluginOwned(rule: NativePlugin): (content: string) => boolean | string {
  const source = nativePluginSource(rule, { port: '0', credential: '""', version: '""' })
  const first = source.slice(0, source.indexOf('\n') + 1)
  const seen = new Set<string>()
  const exact = new RegExp(`^${rule.template.map((part) => {
    if (typeof part === 'string') return literal(part)
    if (seen.has(part.argument)) return `\\k<${part.argument}>`
    seen.add(part.argument)
    return `(?<${part.argument}>${SLOTS[part.argument]})`
  }).join('')}$`)
  return (content) => !(first.length > 1 && content.startsWith(first)) ? false : exact.test(content) || PLUGIN_CHANGED
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
    // Only once the hooks are out (or were already, on a second uninstall): a record taken away from a hook still there makes Codex ask about it again.
    if (codex.reviewed && !hooks.failed) out.push(await removeReviewedHooks(codex.reviewed, home, settingsFile, { before, now: () => codexHooksNow(home) }))
    if (codex.allow && 'file' in codex.allow) out.push(await removeOwnedFile(join(home, codex.allow.file), (content) => content.startsWith(RULES_HEADER)))
    // Each Codex Buddy's rule for its Swarm (lib/buddyCodexRules.ts).
    for (const file of buddyCodexRulesFiles(home)) out.push(await removeOwnedFile(file, (content) => content.startsWith(BUDDY_RULES_HEADER)))
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
  if (targets.unread) out.push({ file: ADOPTED_HOMES, removed: 0, failed: targets.unread })
  return out.filter((o) => o.removed || o.failed || o.kept)
}

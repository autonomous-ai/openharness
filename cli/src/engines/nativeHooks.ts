/** Explicit CLI/legacy native installation. Default core uses nativeHookSetup and the setup worker. */
import { existsSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runHookPreparation } from './kit/nativeHookFiles.js'
import { nativeHookLocations, type NativeHookOptions } from './kit/nativeLocations.js'
import { env } from '../config/env.js'
import { hookTokenPath } from '../lib/hookAuth.js'
import { VERSION } from '../version.js'
import { prepareOpencodeHooks } from './kit/opencodeHookPreparation.js'
import { OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN, OPENCODE_LEGACY_REMOVAL } from './opencode/setup.js'
import { KILO_PLUGIN } from './kilo/setup.js'
import { PI_EXTENSION } from './pi/setup.js'
import { AMP_PLUGIN } from './amp/setup.js'
import { HERMES_HOOK_SETTINGS, HERMES_HOOKS_SAID } from './hermes/setup.js'
import { isRecordHome, rememberRecordHome } from './kit/hermesRecordHomes.js'
import { hermesHomeIsTui } from './kit/hermesRecordSettings.js'
import type { OpencodeLaunchSnapshot } from './launchControl.js'
import { installNativePlugin, prepareNativePlugin, prepareNativePluginRemoval } from './kit/nativePlugin.js'
import { installNativeYamlHooks, removeNativeYamlHooks } from './kit/nativeHookYaml.js'
import { nativeHookHomes } from './kit/nativeHookHomes.js'
import { command, hooksNotInstalled, requireHookScript } from './kit/notifyHooks.js'
import { hostPlatform } from './kit/windowsFiles.js'
import { GROK_HOOK_SETTINGS } from './grok/setup.js'
import { AGY_HOOK_SETTINGS } from './agy/setup.js'
import { COPILOT_HOOK_SETTINGS } from './copilot/setup.js'
import { CURSOR_HOOK_SETTINGS } from './cursor/setup.js'
import { COMMANDCODE_HOOK_SETTINGS } from './commandcode/setup.js'
import { DEVIN_HOOK_SETTINGS } from './devin/setup.js'
import { installNativeHookSettings } from './kit/nativeHookSettings.js'
import { unixSocketPath } from '../lib/localSocket.js'

export const installGrokHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativeHookSettings(options?.environment ? { ...GROK_HOOK_SETTINGS, file: join(nativeHookLocations(options.environment).GROK_HOME, 'hooks', 'harness.json') } : GROK_HOOK_SETTINGS, port, options)
export const installAgyHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativeHookSettings(options?.environment ? { ...AGY_HOOK_SETTINGS, file: join(nativeHookLocations(options.environment).AGY_CONFIG_DIR, 'hooks.json') } : AGY_HOOK_SETTINGS, port, options)
export const installCopilotHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativeHookSettings(options?.environment ? { ...COPILOT_HOOK_SETTINGS, file: join(nativeHookLocations(options.environment).COPILOT_HOME, 'hooks', 'harness.json') } : COPILOT_HOOK_SETTINGS, port, options)
export const installCursorHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativeHookSettings(options?.environment ? { ...CURSOR_HOOK_SETTINGS, file: join(nativeHookLocations(options.environment).CURSOR_CONFIG_DIR, 'hooks.json') } : CURSOR_HOOK_SETTINGS, port, options)
export const installCommandCodeHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativeHookSettings(options?.environment ? { ...COMMANDCODE_HOOK_SETTINGS, file: join(nativeHookLocations(options.environment).COMMANDCODE_HOME, 'settings.json') } : COMMANDCODE_HOOK_SETTINGS, port, options)
export const installDevinHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativeHookSettings(options?.environment ? { ...DEVIN_HOOK_SETTINGS, file: nativeHookLocations(options.environment).DEVIN_CONFIG_PATH } : DEVIN_HOOK_SETTINGS, port, options)

const pluginValues = (port: number) => ({
  port: String(port), credential: JSON.stringify(hookTokenPath(env.ADAPTER_DATA_DIR)), version: JSON.stringify(VERSION),
  // Named for the configured port, as the daemon's socket is, whichever port it was given.
  socket: JSON.stringify(unixSocketPath(env.ADAPTER_DATA_DIR, env.PORT)),
})
export const installKiloPlugin = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativePlugin(options?.environment ? { ...KILO_PLUGIN, file: join(nativeHookLocations(options.environment).KILO_PLUGIN_DIR, 'launcher-register.js') } : KILO_PLUGIN, pluginValues(port), options)
export const installPiExtension = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativePlugin(options?.environment ? { ...PI_EXTENSION, file: join(nativeHookLocations(options.environment).PI_AGENT_DIR, 'extensions', 'launcher-register.ts') } : PI_EXTENSION, pluginValues(port), options)
export const installAmpPlugin = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativePlugin(options?.environment ? { ...AMP_PLUGIN, file: join(nativeHookLocations(options.environment).AMP_PLUGIN_DIR, 'launcher-register.ts') } : AMP_PLUGIN, pluginValues(port), options)
/**
 * Hermes's hooks, decided home by home. Off Windows a Hermes v0.21.6+ is followed from its terminal record and needs
 * none: Harness's come out of its homes. An older Hermes, one whose version cannot be read, and a home set to the TUI,
 * which writes no record, keep today's hook. A computer with no Hermes config is asked no version.
 */
export async function installHermesHooks(port: number, selectedHome?: string, options?: NativeHookOptions, platform: NodeJS.Platform = hostPlatform()): Promise<boolean> {
  if (platform !== 'win32') {
    const homes = selectedHome ? [selectedHome] : nativeHookHomes(HERMES_HOOK_SETTINGS.homes, HERMES_HOOK_SETTINGS.home)
    const creates = !!selectedHome && !!options?.environment
    if (creates || homes.some(home => existsSync(join(home, HERMES_HOOK_SETTINGS.homes.file)))) {
      // Unknown: a home a record was read in keeps records, whatever its version reads as.
      const keeps = await options?.setup?.hermesKeepsRecord(options?.executable, options?.environment) ?? (!!selectedHome && isRecordHome(selectedHome))
      if (keeps) {
        const tui: string[] = [], cli: string[] = []
        for (const home of homes) (await hermesHomeIsTui(home) ? tui : cli).push(home)
        await removeHermesHooks(cli)
        // With no TUI home a launch needs no hook, and one that could not be removed does not hold it.
        let installed = true
        for (const home of tui) if (!await hermesHooksAsToday(port, home, options, platform)) installed = false
        return installed
      }
    }
  }
  return hermesHooksAsToday(port, selectedHome, options, platform)
}

// Compatibility for a Hermes that keeps no terminal record: one older than v0.21.6, or a home set to its TUI.
// #4207, remove on or after 2026-12-07 (60 days after v0.21.6), with what only it reaches.
// Windows: Hermes splits the line itself and starts the program with no shell (agent/shell_hooks.py `_spawn`, Hermes 0.22.7). It
// keeps double quotes as one word and backslashes as they are, which is the line `cmd` takes (`shlex.split(posix=False)`).
function hermesHooksAsToday(port: number, selectedHome: string | undefined, options: NativeHookOptions | undefined, platform: NodeJS.Platform): Promise<boolean> {
  // Once for every home, before the pool: a missing notify.mjs is a failed install said in one line, never a rejection.
  try { requireHookScript('hermes') } catch (error) {
    const line = hooksNotInstalled('hermes', error, platform)
    if (line) console.error(line)
    else console.error(HERMES_HOOK_SETTINGS.messages.failed, error)
    return Promise.resolve(false)
  }
  return installNativeYamlHooks(HERMES_HOOK_SETTINGS, home => command(port, 'hermes', env.CODEX_HOME, home, options?.environment, platform === 'win32' ? 'cmd' : 'bash'), selectedHome,
    { ...options, createMissing: !!selectedHome && !!options?.environment })
}

// The removal lines said, each once per file in the daemon's life; at the limit the set starts again.
const MAX_SAID = 256
const said = new Set<string>()
function sayOnce(stream: 'log' | 'warn', template: string, file: string, reason = ''): void {
  const key = `${template}\0${file}`
  if (said.has(key)) return
  if (said.size >= MAX_SAID) said.clear()
  said.add(key)
  console[stream](template.replace(/\{(file|reason)\}/g, (_, name: string) => name === 'file' ? file : reason))
}

/**
 * Harness's Hermes hooks out of [homes], as `harness uninstall` takes them: the managed block, a bare one an older
 * release left, Harness's approvals and the pane names it listed. It never throws.
 */
async function removeHermesHooks(homes: readonly string[]): Promise<void> {
  const editable: string[] = []
  for (const home of homes) {
    // A sandbox controls its home: a link there would aim this edit at another file, the host's own Hermes config among
    // them, whose Hermes may still need the hook. Such a home is left as it is.
    let link: string | undefined
    for (const name of [HERMES_HOOK_SETTINGS.homes.file, HERMES_HOOK_SETTINGS.allowlist]) {
      const file = join(home, name)
      if (await lstat(file).then(info => info.isSymbolicLink(), () => false)) { link = file; break }
    }
    if (link) sayOnce('warn', HERMES_HOOKS_SAID.kept, link, 'the file is a symbolic link')
    else editable.push(home)
  }
  for (const { file, removed, failed, kept } of await removeNativeYamlHooks(HERMES_HOOK_SETTINGS, editable)) {
    if (removed > 0) sayOnce('log', HERMES_HOOKS_SAID.removed, file)
    const reason = failed ?? kept
    if (reason) sayOnce('warn', HERMES_HOOKS_SAID.kept, file, reason)
  }
}

/** A terminal record was read in [home]: its Hermes keeps one, so the first time, its hooks go unless it is set to the TUI. */
export async function hermesRecordSeen(home: string): Promise<void> {
  if (rememberRecordHome(home) && !await hermesHomeIsTui(home)) await removeHermesHooks([home])
}

/** Install both discovery surfaces under the shared current-executable coordinator. */
export async function installOpencodePlugin(port: number, snapshot?: OpencodeLaunchSnapshot, options: NativeHookOptions = {}): Promise<boolean> {
  const root = options.environment ? nativeHookLocations(options.environment).OPENCODE_PLUGIN_DIR : dirname(OPENCODE_LEGACY_PLUGIN.file)
  const legacyRule = { ...OPENCODE_LEGACY_PLUGIN, file: join(root, 'launcher-register.js') }
  const tuiRule = { ...OPENCODE_TUI_PLUGIN, file: join(dirname(root), 'plugins', 'launcher-register', 'tui.js') }
  const removalRule = { ...OPENCODE_LEGACY_REMOVAL, file: legacyRule.file }
  const paths = [legacyRule.file, tuiRule.file]
  return prepareOpencodeHooks(paths, port, snapshot, options, (major, authority) => runHookPreparation(paths, async attempt => {
    const values = pluginValues(port)
    const legacy = major === 1 ? prepareNativePlugin(legacyRule, values) : prepareNativePluginRemoval(removalRule)
    const tui = prepareNativePlugin(tuiRule, values)
    legacy.verify(); tui.verify()
    const first = await legacy.commit(attempt), second = await tui.commit(attempt)
    first.verify(); second.verify(); return snapshot?.current() !== false
  }, authority))
}

/** Native hook installation is eager. Optional transcript and screen readers own no hook files. */
import { join } from 'node:path'
import { env } from '../config/env.js'
import { VERSION } from '../version.js'
import { OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN, OPENCODE_LEGACY_REMOVAL, OPENCODE_VERSION } from './opencode/contract.js'
import { KILO_PLUGIN } from './kilo/contract.js'
import { PI_EXTENSION } from './pi/contract.js'
import { AMP_PLUGIN } from './amp/contract.js'
import { HERMES_HOOK_SETTINGS } from './hermes/contract.js'
import { opencodeMajorVersion } from './launchControl.js'
import { installNativePlugin, removeNativePlugin } from './kit/nativePlugin.js'
import { installNativeYamlHooks } from './kit/nativeHookYaml.js'
import { command } from './kit/notifyHooks.js'
import { GROK_HOOK_SETTINGS } from './grok/contract.js'
import { AGY_HOOK_SETTINGS } from './agy/contract.js'
import { COPILOT_HOOK_SETTINGS } from './copilot/contract.js'
import { CURSOR_HOOK_SETTINGS } from './cursor/contract.js'
import { COMMANDCODE_HOOK_SETTINGS } from './commandcode/contract.js'
import { DEVIN_HOOK_SETTINGS } from './devin/contract.js'
import { installNativeHookSettings } from './kit/nativeHookSettings.js'

export const installGrokHooks = (port: number): void => installNativeHookSettings(GROK_HOOK_SETTINGS, port)
export const installAgyHooks = (port: number): void => installNativeHookSettings(AGY_HOOK_SETTINGS, port)
export const installCopilotHooks = (port: number): void => installNativeHookSettings(COPILOT_HOOK_SETTINGS, port)
export const installCursorHooks = (port: number): void => installNativeHookSettings(CURSOR_HOOK_SETTINGS, port)
export const installCommandCodeHooks = (port: number): void => installNativeHookSettings(COMMANDCODE_HOOK_SETTINGS, port)
export const installDevinHooks = (port: number): void => installNativeHookSettings(DEVIN_HOOK_SETTINGS, port)

const pluginValues = (port: number) => ({
  port: String(port), credential: JSON.stringify(join(env.ADAPTER_DATA_DIR, 'hook-credential')), version: JSON.stringify(VERSION),
})
export const installKiloPlugin = (port: number): void => installNativePlugin(KILO_PLUGIN, pluginValues(port))
export const installPiExtension = (port: number): void => installNativePlugin(PI_EXTENSION, pluginValues(port))
export const installAmpPlugin = (port: number): void => installNativePlugin(AMP_PLUGIN, pluginValues(port))
export const installHermesHooks = (port: number): void =>
  installNativeYamlHooks(HERMES_HOOK_SETTINGS, home => command(port, 'hermes', env.CODEX_HOME, home))

/** Install both discovery surfaces for v1; v2 must not load our incompatible v1 export. */
interface OpencodeInstallation { port: number; done: Promise<boolean> }
let opencodeInstallation: OpencodeInstallation | undefined
export async function installOpencodePlugin(port: number): Promise<boolean> {
  const installation: OpencodeInstallation = { port, done: Promise.resolve(false) }
  opencodeInstallation = installation
  installation.done = (async () => {
    const values = pluginValues(port)
    const major = await opencodeMajorVersion()
    // A newer request may have installed an upgraded/downgraded engine's hooks
    // while this probe waited. Only the latest request can change those files.
    if (installation !== opencodeInstallation) return false
    if (major === 1) installNativePlugin(OPENCODE_LEGACY_PLUGIN, values)
    else removeNativePlugin(OPENCODE_LEGACY_REMOVAL)
    installNativePlugin(OPENCODE_TUI_PLUGIN, values)
    return true
  })()
  let current = installation, installed = await current.done
  const deadline = performance.now() + OPENCODE_VERSION.timeoutMs
  while (current !== opencodeInstallation) {
    current = opencodeInstallation!
    // Two healthy creates must not fail merely because they overlap. Follow the
    // current installation without restoring an obsolete request's write rights.
    // A port change or continuing churn cannot make this caller wait forever.
    const remaining = deadline - performance.now()
    if (current.port !== port || remaining <= 0) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([current.done, new Promise<'timeout'>(done => {
        timer = setTimeout(() => done('timeout'), remaining)
      })])
      if (result === 'timeout') return false
      installed = result
    } finally { clearTimeout(timer) }
  }
  return installed
}

/** Vendor parsing and generated hook source live only in engineSetup or explicit inline compatibility. */
import { env } from '../config/env.js'
import { VERSION } from '../version.js'
import { hookTokenPath } from '../lib/hookAuth.js'
import { unixSocketPath } from '../lib/localSocket.js'
import { hooks as claude } from '../engines/claude/hookContract.js'
import { hooks as codex } from '../engines/codex/hookContract.js'
import { AGY_HOOK_SETTINGS } from '../engines/agy/setup.js'
import { AMP_PLUGIN } from '../engines/amp/setup.js'
import { COMMANDCODE_HOOK_SETTINGS } from '../engines/commandcode/setup.js'
import { COPILOT_HOOK_SETTINGS } from '../engines/copilot/setup.js'
import { CURSOR_HOOK_SETTINGS } from '../engines/cursor/setup.js'
import { DEVIN_HOOK_SETTINGS } from '../engines/devin/setup.js'
import { GROK_HOOK_SETTINGS } from '../engines/grok/setup.js'
import { HERMES_HOOK_SETTINGS } from '../engines/hermes/setup.js'
import { HERMES_INTERFACE } from '../engines/hermes/contract.js'
import { KILO_PLUGIN } from '../engines/kilo/setup.js'
import { OPENCODE_LEGACY_PLUGIN, OPENCODE_LEGACY_REMOVAL, OPENCODE_TUI_PLUGIN } from '../engines/opencode/setup.js'
import { PI_EXTENSION } from '../engines/pi/setup.js'
import { installHookSettings } from '../engines/kit/hookSettings.js'
import { installNativeHookSettings } from '../engines/kit/nativeHookSettings.js'
import { installNativeYamlHooks, removeNativeYamlHooks } from '../engines/kit/nativeHookYaml.js'
import { installNativePlugin, prepareNativePlugin, prepareNativePluginRemoval } from '../engines/kit/nativePlugin.js'
import { nativeHookLocations } from '../engines/kit/nativeLocations.js'
import { command } from '../engines/kit/notifyHooks.js'
import { missingHookScript, requireHookScript } from '../engines/kit/hookScript.js'
import { HookScriptMissing } from '../engines/kit/hookHeld.js'
import { yamlStringSetting } from '../engines/kit/yamlSetting.js'
import { hostPlatform } from '../engines/kit/windowsFiles.js'
import type { NativeHookCandidate, NativeHookInput } from '../engines/kit/nativeHookWire.js'
import { createHookCandidates } from './hookCandidates.js'

const settings = { agy: AGY_HOOK_SETTINGS, commandcode: COMMANDCODE_HOOK_SETTINGS, copilot: COPILOT_HOOK_SETTINGS,
  cursor: CURSOR_HOOK_SETTINGS, devin: DEVIN_HOOK_SETTINGS, grok: GROK_HOOK_SETTINGS }
const plugins = { amp: AMP_PLUGIN, kilo: KILO_PLUGIN, pi: PI_EXTENSION }

export async function prepareNativeHookFiles(input: NativeHookInput, current: () => boolean): Promise<NativeHookCandidate | null> {
  try {
    const candidate = createHookCandidates(input, current), files = candidate.files
    const homes = nativeHookLocations(input.environment), engine = input.engine, port = input.port
    const options = { files, current, environment: input.environment }
    const values = { port: String(port), credential: JSON.stringify(hookTokenPath(env.ADAPTER_DATA_DIR)),
      version: JSON.stringify(VERSION), socket: JSON.stringify(unixSocketPath(env.ADAPTER_DATA_DIR, env.PORT)) }
    let prepared = false
    if (engine === 'claude' || engine === 'codex') {
      prepared = await installHookSettings(engine, engine === 'claude' ? claude.settings : codex.settings, port,
        engine === 'claude' ? homes.CLAUDE_HOME : homes.CODEX_HOME, options)
    } else if (Object.hasOwn(settings, engine)) {
      prepared = await installNativeHookSettings({ ...settings[engine as keyof typeof settings], file: input.files[0].file }, port, options)
    } else if (Object.hasOwn(plugins, engine)) {
      prepared = await installNativePlugin({ ...plugins[engine as keyof typeof plugins], file: input.files[0].file }, values, options)
    } else if (engine === 'opencode') {
      prepared = await files.run(input.files.map(file => file.file), async attempt => {
        const legacy = input.major === 1
          ? prepareNativePlugin({ ...OPENCODE_LEGACY_PLUGIN, file: input.files[0].file }, values, files)
          : prepareNativePluginRemoval({ ...OPENCODE_LEGACY_REMOVAL, file: input.files[0].file }, files)
        const tui = prepareNativePlugin({ ...OPENCODE_TUI_PLUGIN, file: input.files[1].file }, values, files)
        legacy.verify(); tui.verify()
        const first = await legacy.commit(attempt), second = await tui.commit(attempt)
        first.verify(); second.verify(); return true
      }, options)
    } else if (engine === 'hermes') {
      const home = homes.HERMES_HOME
      const tui = yamlStringSetting(input.files[0].content ?? '', HERMES_INTERFACE.section, HERMES_INTERFACE.key)?.trim().toLowerCase() === HERMES_INTERFACE.tui
      if (input.remove || input.keepsRecord && hostPlatform() !== 'win32' && !tui) {
        // A sandbox alias must never give cleanup authority over another profile's target.
        if (!tui && !input.files.some(file => file.alias)) await removeNativeYamlHooks(HERMES_HOOK_SETTINGS, [home], options)
        prepared = true
      } else {
        requireHookScript('hermes')
        prepared = await installNativeYamlHooks(HERMES_HOOK_SETTINGS,
          () => command(port, 'hermes', env.CODEX_HOME, home, input.environment, hostPlatform() === 'win32' ? 'cmd' : 'bash'), home,
          { ...options, createMissing: input.createMissing === true })
      }
    }
    if (prepared && current()) return candidate.candidate()
  } catch { /* The caller receives no publication candidate from incomplete preparation. */ }
  const missing = missingHookScript(input.engine)
  if (missing) throw new HookScriptMissing(missing)
  console.warn('[engine-setup] HOOK_PREPARATION_HELD')
  return null
}

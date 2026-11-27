/**
 * Whether Claude Code's harness-device plugin is on, as its own hook (`harness device claude asked`) and mod (`link`)
 * ask before they act, and where Claude Code's user settings are. The calls that change the plugin are in
 * devices/claudePlugin.ts. This runs only in the `harness` command's own process, never in the daemon.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudePluginState } from '../devices/dialSkill.js'

/** Claude Code's user settings: in CLAUDE_CONFIG_DIR, which a Claude Code session hands its hooks, else in ~/.claude. */
export function claudeSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
}

/**
 * Whether the plugin is on, by its entry in Claude Code's user settings: true once installed or enabled, false once
 * disabled, gone once uninstalled. A session started before `disable` keeps the plugin's hook and mod loaded, so both
 * ask this before they act. It is Claude Code's own record, not a file of Harness's: the /plugin menu turns the plugin
 * off there too, and `status` reads the same entry through `claude plugin list`. A file that is missing, unreadable or
 * not an object says nothing of the person turning the plugin off: it stays on, as it was before this check, rather
 * than the dial going quiet for no reason anyone can see. A plugin loaded with --plugin-dir or installed at project
 * scope is on only while that file is missing: once it exists without the entry, it reads as off.
 */
export function claudePluginOn(settingsPath: string): boolean {
  return claudePluginState(settingsPath) !== 'off'
}

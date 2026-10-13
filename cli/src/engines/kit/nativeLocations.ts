/** Paths observed in the launch shell, used without changing daemon globals. */
import { isAbsolute, join } from 'node:path'
import type { HookPreparationOptions } from './nativeHookFiles.js'

// Capture only launch locations, never vendor credentials. Pin these locations
// again after rc files run in the pane, so preparation and execution agree.
export const LAUNCH_LOCATION_VARIABLES = [
  'HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DATA_DIR', 'OPENCODE_DB', 'PI_CODING_AGENT_DIR',
  'HERMES_HOME', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'GROK_HOME', 'AGY_HOME', 'COPILOT_HOME',
  'SHELL', 'ZDOTDIR', 'CLAUDE_PROJECTS_DIR', 'CURSOR_HOME', 'AGY_CONFIG_DIR', 'COMMANDCODE_HOME',
  'DEVIN_HOME', 'DEVIN_CONFIG_PATH', 'OPENCODE_PLUGIN_DIR', 'KILO_PLUGIN_DIR', 'PI_HOME',
  'PI_CODING_AGENT_SESSION_DIR', 'AMP_PLUGIN_DIR',
] as const

/** The shell can unset an inherited location. Absence is part of its snapshot. */
export function nativeProcessEnvironment(locations: Readonly<NodeJS.ProcessEnv>, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...ambient }
  for (const key of LAUNCH_LOCATION_VARIABLES) delete result[key]
  return { ...result, ...locations }
}

/** OpenCode uses OPENCODE_DB, otherwise its XDG data root; OPENCODE_DATA_DIR is ignored. */
export function nativeOpencodeStore(vars: Readonly<Record<string, string>>): string {
  const store = vars.OPENCODE_DB || join(vars.XDG_DATA_HOME || join(vars.HOME, '.local', 'share'), 'opencode', 'opencode.db')
  if (!isAbsolute(store) || store.includes('\0') || store.length > 4096) throw Error('Unconfirmed OpenCode store')
  return store
}

export interface NativeHookOptions extends HookPreparationOptions {
  environment?: Readonly<Record<string, string>>
}

export function nativeHookLocations(vars: Readonly<Record<string, string>>) {
  const home = vars.HOME
  if (!home || !isAbsolute(home)) throw Error('Unconfirmed native home')
  const config = vars.XDG_CONFIG_HOME || join(home, '.config')
  const data = vars.XDG_DATA_HOME || join(home, '.local', 'share')
  const locations = {
    CLAUDE_HOME: vars.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    CLAUDE_PROJECTS_DIR: vars.CLAUDE_CONFIG_DIR ? join(vars.CLAUDE_CONFIG_DIR, 'projects') : vars.CLAUDE_PROJECTS_DIR || join(home, '.claude', 'projects'),
    CODEX_HOME: vars.CODEX_HOME || join(home, '.codex'),
    GROK_HOME: vars.GROK_HOME || join(home, '.grok'),
    AGY_HOME: vars.AGY_HOME || join(home, '.gemini', 'antigravity-cli'),
    AGY_CONFIG_DIR: vars.AGY_CONFIG_DIR || join(home, '.gemini', 'config'),
    COPILOT_HOME: vars.COPILOT_HOME || join(home, '.copilot'),
    CURSOR_HOME: vars.CURSOR_DATA_DIR || vars.CURSOR_HOME || join(home, '.cursor'),
    CURSOR_CONFIG_DIR: vars.CURSOR_CONFIG_DIR || (vars.XDG_CONFIG_HOME ? join(config, 'cursor') : vars.CURSOR_HOME || join(home, '.cursor')),
    OPENCODE_PLUGIN_DIR: vars.OPENCODE_PLUGIN_DIR || join(vars.OPENCODE_CONFIG_DIR || join(config, 'opencode'), 'plugin'),
    KILO_PLUGIN_DIR: vars.KILO_PLUGIN_DIR || join(config, 'kilo', 'plugin'),
    PI_AGENT_DIR: vars.PI_CODING_AGENT_DIR || join(vars.PI_HOME || join(home, '.pi'), 'agent'),
    HERMES_HOME: vars.HERMES_HOME || join(home, '.hermes'),
    COMMANDCODE_HOME: vars.COMMANDCODE_HOME || join(home, '.commandcode'),
    DEVIN_HOME: vars.DEVIN_HOME || join(data, 'devin', 'cli'),
    DEVIN_CONFIG_PATH: vars.DEVIN_CONFIG_PATH || join(config, 'devin', 'config.json'),
    AMP_PLUGIN_DIR: vars.AMP_PLUGIN_DIR || join(config, 'amp', 'plugins'),
  }
  if (Object.values(locations).some(path => !isAbsolute(path) || path.includes('\0') || path.length > 4096)) {
    throw Error('Unconfirmed native location')
  }
  return locations
}

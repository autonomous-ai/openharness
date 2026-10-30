/**
 * Where each engine Harness reaches on Windows keeps the folder its hooks or plugin go in, relative to the profile
 * (`%USERPROFILE%`, what os.homedir() returns there), as measured on the Windows VM. env.ts's defaults already name each one:
 * these engines read their homes from the profile on Windows as on a Mac, none from %APPDATA%. A new entry, or an
 * engine release that moves its home, is measured on the VM first (Task B4.15's check), then written here.
 */
import type { Env } from '../config/env.js'

export interface WindowsEngineHome {
  /** The daemon setting that names it (config/env.ts). */
  setting: keyof Env & ('CLAUDE_PROJECTS_DIR' | 'CODEX_HOME' | 'OPENCODE_PLUGIN_DIR' | 'KILO_PLUGIN_DIR' | 'PI_HOME' | 'COPILOT_HOME' | 'COMMANDCODE_HOME')
  /** Below the profile. */
  folder: readonly string[]
  /** What was measured, and when. */
  verified: string
}

export const WINDOWS_ENGINE_HOMES = {
  claude: { setting: 'CLAUDE_PROJECTS_DIR', folder: ['.claude', 'projects'], verified: 'Claude Code 2.1.300: ~\\.claude\\settings.json (VM, 2026-10-15)' },
  codex: { setting: 'CODEX_HOME', folder: ['.codex'], verified: 'Codex 0.162.1: ~\\.codex (VM, 2026-10-15)' },
  opencode: { setting: 'OPENCODE_PLUGIN_DIR', folder: ['.config', 'opencode', 'plugin'], verified: 'OpenCode 1.19.0: ~\\.config\\opencode, ~\\.local\\share\\opencode, none in %APPDATA% (VM, 2026-10-16)' },
  kilo: { setting: 'KILO_PLUGIN_DIR', folder: ['.config', 'kilo', 'plugin'], verified: 'Kilo 7.8.12: ~\\.config\\kilo, ~\\.local\\share\\kilo (VM, 2026-10-15)' },
  pi: { setting: 'PI_HOME', folder: ['.pi'], verified: 'Pi 1.2.0: ~\\.pi (VM, 2026-10-15)' },
  copilot: { setting: 'COPILOT_HOME', folder: ['.copilot'], verified: 'Copilot CLI 1.0.98: ~\\.copilot, logs in %LOCALAPPDATA%\\copilot (VM, 2026-10-15)' },
  commandcode: { setting: 'COMMANDCODE_HOME', folder: ['.commandcode'], verified: 'Command Code 1.82.3: ~\\.commandcode (VM, 2026-10-15)' },
} as const satisfies Record<string, WindowsEngineHome>

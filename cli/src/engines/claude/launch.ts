import type { EngineLaunch } from '../facets/launch.js'

// The existing CLI contracts: auto still runs Claude Code's safety checks; full is explicit.
const permissionModes = {
  auto: ['--permission-mode', 'auto'],
  acceptEdits: ['--permission-mode', 'acceptEdits'],
  plan: ['--permission-mode', 'plan'],
  ask: [],
  full: ['--dangerously-skip-permissions'],
}
export const launch: EngineLaunch = {
  permissionModes, bypassPermission: permissionModes.auto,
  firstPromptArgs: [], resumeArgs: ['--resume'], forkArgs: { lead: ['--resume'], after: ['--fork-session'] },
  instructionFiles: ['CLAUDE.md'],
  contextArgs: { args: ['--append-system-prompt', 'Read the harness context at {file} before working.'], quote: 'json' },
  // Claude Code reads CLAUDE.md, and AGENTS.md only through an import line in it.
  instructionFile: 'CLAUDE.md',
  instructionImport: { file: 'AGENTS.md', line: '@AGENTS.md' },
  /**
   * Claude Code asks "do you trust this folder?" the first time it opens a project, and keeps the answer as
   * `projects[<path>].hasTrustDialogAccepted` in `.claude.json`: in CLAUDE_CONFIG_DIR, else the home folder
   * itself (its own rule, 2.1.290). A yes covers the folders below. Copied from the former lib/claudeTrust.ts.
   */
  trust: {
    home: { variable: 'CLAUDE_CONFIG_DIR', otherwise: 'home' }, file: '.claude.json',
    format: 'json', projects: 'projects', accepted: 'hasTrustDialogAccepted', entry: { allowedTools: [] },
  },
}

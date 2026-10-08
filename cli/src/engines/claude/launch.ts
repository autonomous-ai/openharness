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
}

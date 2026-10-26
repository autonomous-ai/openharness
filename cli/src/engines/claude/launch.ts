import type { EngineLaunch } from '../facets/launch.js'

// The existing CLI contracts: auto still runs Claude Code's safety checks; full is explicit. Ask names its mode:
// Claude Code 2.1.296 started a session given no flag in auto mode, so an Ask harness never asked (a fresh Mac,
// 2026-10-12). `default` is the asking mode's name in every version with the flag; 2.1.296 calls it manual, still
// takes `default`, and shows "manual mode on".
const permissionModes = {
  auto: ['--permission-mode', 'auto'],
  acceptEdits: ['--permission-mode', 'acceptEdits'],
  plan: ['--permission-mode', 'plan'],
  ask: ['--permission-mode', 'default'],
  full: ['--dangerously-skip-permissions'],
}
export const launch: EngineLaunch = {
  permissionModes, bypassPermission: permissionModes.auto,
  firstPromptArgs: [], resumeArgs: ['--resume'], forkArgs: { lead: ['--resume'], after: ['--fork-session'] },
  // `claude --help` (2.1.303): `--model` and `--effort` are "for the current session". `/model` and `/effort` typed into the
  // pane are saved as the person's default instead, which a routed start must not do.
  modelArgs: { model: ['--model', '{value}'], effort: ['--effort', '{value}'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  instructionFiles: ['CLAUDE.md'],
  contextArgs: { args: ['--append-system-prompt', 'Read the harness context at {file} before working.'], quote: 'json' },
  // Claude Code reads CLAUDE.md, and AGENTS.md only through an import line in it.
  instructionFile: 'CLAUDE.md',
  instructionImport: { file: 'AGENTS.md', line: '@AGENTS.md' },
  /**
   * Claude Code asks "do you trust this folder?" the first time it opens a project, and keeps the answer as
   * `projects[<path>].hasTrustDialogAccepted` in `.claude.json`: in CLAUDE_CONFIG_DIR, else the home folder
   * itself (its own rule, 2.1.290). A yes covers the folders below. Copied from the former lib/claudeTrust.ts.
   *
   * A Git worktree (2.1.310, tried with the binary in a throwaway CLAUDE_CONFIG_DIR, 2026-10-26): it starts without
   * asking when its own path, a folder above it within the worktree, or its MAIN repository says yes (`.git` →
   * gitdir → commondir, backlink checked). Its own Yes is recorded under the main repository's key, never the
   * worktree's. So the worktree's own path, which Harness records, is read; the main repository's key is not
   * written, as it would answer for every worktree of that repository.
   */
  trust: {
    home: { variable: 'CLAUDE_CONFIG_DIR', otherwise: 'home' }, file: '.claude.json',
    format: 'json', projects: 'projects', accepted: 'hasTrustDialogAccepted', entry: { allowedTools: [] },
  },
  /**
   * "WARNING: Claude Code running in Bypass Permissions mode … Yes, I accept", the first time `--dangerously-skip-permissions`
   * runs: a Swarm Lead on the Mac Studio sat there before its first turn (2026-10-26). Accepting writes
   * `skipDangerousModePermissionPrompt: true` to the user settings, "Whether the user has accepted the bypass permissions
   * mode dialog" in its settings schema, and the key its own message tells people to add (2.1.310; with it set the
   * dialog is not shown, tried with the binary).
   */
  bypassAcceptance: { home: { variable: 'CLAUDE_CONFIG_DIR', otherwise: { folder: '.claude' } }, file: 'settings.json', key: 'skipDangerousModePermissionPrompt' },
  /**
   * `.mcp.json` in a folder above, such as the home's, is asked about as "New MCP server found in this project". Its
   * default, "Continue without using this MCP server", adds the name to `disabledMcpjsonServers` in the folder's
   * `.claude/settings.local.json` (localSettings); a name there is `rejected` and never asked again, whatever else
   * approves it. A user settings `enabledMcpjsonServers`, `disabledMcpjsonServers` or `enableAllProjectMcpServers`
   * decides it without asking (2.1.310 `Yft`, `EFn`).
   */
  inheritedMcp: {
    file: '.mcp.json', servers: 'mcpServers', settings: '.claude/settings.local.json', rejected: 'disabledMcpjsonServers',
    user: { home: { variable: 'CLAUDE_CONFIG_DIR', otherwise: { folder: '.claude' } }, file: 'settings.json',
      approved: 'enabledMcpjsonServers', rejected: 'disabledMcpjsonServers', approveAll: 'enableAllProjectMcpServers' },
  },
  /**
   * Claude Code's `attribution.pr`: the text it adds to a pull request it opens. Set, it replaces Claude Code's own
   * line, so the value keeps that line first (2.1.296 `rro`: `pr: h.pr ?? <own line>`). `--settings` overrides the
   * person's user, project and local settings key by key (lodash `mergeWith`), so their `attribution.commit` stays.
   * `attribution: false`, a `pr` of "" and the older `includeCoAuthoredBy: false` each hide the line: nothing is added
   * then, and the last would otherwise bring the commit trailer back (setting `pr` ends it).
   */
  attribution: {
    kind: 'setting',
    home: { variable: 'CLAUDE_CONFIG_DIR', otherwise: { folder: '.claude' } }, file: 'settings.json',
    folder: ['.claude/settings.json', '.claude/settings.local.json'],
    key: 'attribution', field: 'pr', legacy: { key: 'includeCoAuthoredBy', until: ['commit', 'pr'] },
    own: '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    args: ['--settings', '{settings}'],
    // Told as well: Claude Code 2.1.296, started by another agent and asked for "a short body saying it fixes a typo",
    // opened the pull request with that body and neither line (2026-10-11, in a clean VM). Codex, told in these words,
    // kept ours.
    instruction: 'When you create or update a pull request, its body must include this exact line once, near the end and '
      + 'after any other attribution line: `{line}` It says another agent started this session in Harness. Do not add it '
      + 'to commit messages.',
  },
  // Recorded with the rest of the system prompt on the conversation's first request and kept on every resume
  // (`--system-prompt-snapshot`, on by default), so it is given at each launch and read once.
  harnessInstructions: { kind: 'append', args: ['--append-system-prompt', '{text}'] },
}

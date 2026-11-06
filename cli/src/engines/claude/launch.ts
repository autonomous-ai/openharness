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
  // Code a Harness Team agent wrote (backend superTabs/teamWritten.ts, audit H2): nothing the branch carries. Since v3 it runs as
  // the project owner on their own computer, not in a Team account's own OS user, so it skips no permission check: the
  // owner's own mode from their user settings (review of #3485). `user` and not `local`: a branch can commit
  // `.claude/settings.local.json`. Harness's hooks are in the user
  // settings. Claude Code 2.1.316, tried: planted settings.json, settings.local.json and .mcp.json each ran in a trusted
  // folder without these flags, and none with them. With no trust record the session stops at the trust question, so the record
  // stays and the flags are the barrier; a Yes on the main repository answers for its worktrees anyway.
  teamWritten: ['--setting-sources', 'user', '--strict-mcp-config'],
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
   * "Welcome to Claude Code … Choose the text style", then its notes, the first time it runs on a machine: finishing them
   * writes `hasCompletedOnboarding: true` to `.claude.json`, beside the folder trust (the Harness Team relay records the same
   * key, team/relay.ts). The theme left unpicked is Claude Code's default; picked on the phone setting up the computer, it is
   * kept as `theme` in the same file, one of its text styles (2.1.318's screen: Dark mode, Light mode, …).
   */
  onboarding: {
    home: { variable: 'CLAUDE_CONFIG_DIR', otherwise: 'home' }, file: '.claude.json', key: 'hasCompletedOnboarding',
    theme: { key: 'theme', values: ['dark', 'light'] },
  },
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
  /**
   * Harness's status line, which records the rate limits Claude Code reports to it and then shows the person's own
   * (kit/statusLine.ts). Theirs is read from the files Claude Code reads it from, a later one over an earlier.
   */
  statusLine: {
    home: { variable: 'CLAUDE_CONFIG_DIR', otherwise: { folder: '.claude' } }, file: 'settings.json',
    folder: ['.claude/settings.json', '.claude/settings.local.json'],
    key: 'statusLine', type: 'command', args: ['--settings', '{settings}'],
  },
  // Recorded with the rest of the system prompt on the conversation's first request and kept on every resume
  // (`--system-prompt-snapshot`, on by default), so it is given at each launch and read once.
  harnessInstructions: { kind: 'append', args: ['--append-system-prompt', '{text}'] },
}

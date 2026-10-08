import type { EngineLaunch } from '../facets/launch.js'

const permissionModes = {
  auto: ['--approve-for-me'],
  readOnly: ['--sandbox', 'read-only'],
  ask: [],
  full: ['--dangerously-bypass-approvals-and-sandbox'],
}

/**
 * Codex's launch, declared: data only, which core applies with the kit (engines/launches.ts,
 * lib/engineLaunch.ts). The pane script's startup probe and retry were lib/engineLaunch.ts's and
 * lib/codexStartupRetry.ts's, the own-login provider was engines/codex/ownLoginProvider.ts, and the
 * environment flags were `codexEnvArgs` in this file (docs/design/2026-10-08-engine-launch.md).
 */
export const launch: EngineLaunch = {
  permissionModes, bypassPermission: permissionModes.auto,
  firstPromptArgs: [], resumeArgs: ['resume'], forkArgs: { lead: ['fork'] },
  instructionFiles: ['AGENTS.override.md', 'AGENTS.md'],
  /**
   * Codex runs a session's commands in a shared app server (`codex app-server --managed-daemon`, codex-cli
   * 0.159.3), not under the process Harness launched, so they never see that process's environment.
   * Measured: HARNESS_CONTEXT_FILE and every manifest variable were unset in the agent's shell, and the
   * Model Manager ran without its instructions. `shell_environment_policy.set` is what Codex itself gives
   * every command, and `-c` carries it to whichever process runs them. The value is a JSON string, which
   * TOML reads as the same string. `-c a.b.NAME=…` splits the key on dots, so a name must be a bare key.
   */
  envArgs: { flag: '-c', setting: 'shell_environment_policy.set.{name}={value}', name: /^[A-Za-z_][A-Za-z0-9_]*$/ },
  // Older Codex shares one app-server per CODEX_HOME, which owns work independently of its terminal client.
  // New Harness launches opt out with --no-daemon (`startup.ownedFlag` below), as the first option.
  sharedServer: {
    ownedFlag: '--no-daemon', remoteFlag: '--remote', scripts: ['codex', 'codex.js'], pidFile: 'app-server-daemon/daemon.pid',
    messages: {
      unverified: 'Could not verify the Codex server before stopping',
      remote: 'Stop this conversation on its remote Codex server before closing its terminal',
      unidentified: 'Could not identify the conversation on the Codex server; the session is still open',
    },
  },
  /**
   * Undoing the provider a grid launch left behind in Codex's own state. From 0.155 Codex records one PER
   * THREAD in `<CODEX_HOME>/state_5.sqlite` (`threads.model_provider`), written at launch from whatever
   * `-c model_provider=` said. The grid contract says `grid` there (lib/gridLaunch.ts) and defines it in the
   * same argv, so the name is persisted while its definition is not: moved back to its own login, `codex
   * resume` failed before the TUI was up ("thread/resume failed: … Model provider grid not found") and the
   * restart gave up on the conversation. Measured against codex-cli 0.155.1, argv outranks the stored row, so
   * naming a provider again repairs a thread already poisoned; no database is read or written.
   *
   * The person's own top-level `model_provider` is their standing choice and is asked first: TOP-LEVEL only,
   * since in TOML every key after a `[header]` is that table's (a `[profiles.work]` provider is the profile's).
   * `openai` is what Codex itself would pick. Claude Code and Hermes read theirs from the environment or argv
   * every launch, and OpenCode's is a file this daemon writes, so only Codex declares this.
   */
  ownProvider: { home: 'CODEX_HOME', file: 'config.toml', key: 'model_provider', fallback: 'openai', args: ['-c', 'model_provider="{value}"'] },
  startup: {
    /**
     * Codex 0.157+ otherwise puts the writer outside tmux in a shared server. Keep Harness-owned launches
     * process-owned so Close, hook attribution, provider env and RAM accounting describe the same lifetime.
     * Probed after any install, in the exact pane shell; older versions simply omit the flag. The probe is
     * bounded and never changes the person's Codex configuration.
     */
    ownedFlag: { unverified: 'could not verify Codex startup options. Please try opening this session again.' },
    retry: {
      // A successful startup update ends with Codex's explicit restart request (observed in codex-cli 0.160.0).
      // A tagged template, as the probe was: the bundle escapes its emoji in the raw text, where the escape and
      // the character match alike (scripts/lib/asciiOnly.mjs).
      updated: { status: 0, line: String.raw`^(?:🎉\s*)?Update ran successfully! Please restart Codex\.$`, message: 'Codex updated. Continuing startup…' },
      // Codex 0.159.3 exits 1 when account/read's workspace-routing discovery times out, before thread/start or
      // the first prompt. Retrying that exact bootstrap failure is safe; retrying an arbitrary exit could replay
      // work.
      transient: {
        status: 1,
        line: 'Error: account/read failed during TUI bootstrap: account/read failed: workspace routing discovery timed out (code -32603)',
        withinMs: 30_000, attempts: 3, backoffSeconds: 2,
        message: 'Codex account lookup timed out. Retrying startup ({attempt}/{attempts}) in {delay}s; Ctrl-C cancels.',
      },
    },
  },
}

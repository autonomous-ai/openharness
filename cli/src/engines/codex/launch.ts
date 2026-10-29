import type { EngineLaunch } from '../facets/launch.js'

const permissionModes = {
  auto: ['--approve-for-me'],
  // A Buddy's (superTabs/start.ts): it reads in the sandbox, and an approval to go outside it goes to the person at its
  // terminal, never to Codex's own reviewer, whatever their config.toml says. Their rules files still apply: a command an
  // `allow` rule names runs outside the sandbox unasked, which is why the backend refuses Codex Buddies for now (security
  // review 1 of #2087). Ahead of readOnly, whose flags it contains: a process's argv is read back as the first mode it
  // matches (lib/processTable.ts), so a relaunched Buddy keeps this mode. A Codex without its flag is never relaunched
  // without it (lib/engineLaunch.ts KEPT_PERMISSION_MODES).
  readOnlyAsk: ['--ask-for-approval', 'on-request', '--sandbox', 'read-only', '-c', 'approvals_reviewer="user"'],
  readOnly: ['--sandbox', 'read-only'],
  ask: [],
  full: ['--dangerously-bypass-approvals-and-sandbox'],
}

/**
 * Codex's launch, declared: data only, which core applies with the kit (engines/launches.ts,
 * engines/launchPrep.ts, lib/engineLaunch.ts). The pane script's startup probe and retry were
 * lib/engineLaunch.ts's and lib/codexStartupRetry.ts's, the own-login provider was
 * engines/codex/ownLoginProvider.ts, the environment flags were `codexEnvArgs` in this file, the folder trust
 * was lib/claudeTrust.ts's and the resume repair was engines/codex/portableHistory.ts
 * (docs/design/2026-10-08-engine-launch.md).
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
  /**
   * Codex keeps its folder trust in `<CODEX_HOME>/config.toml` as a `[projects."<path>"]` table with
   * `trust_level = "trusted"`, read from the agent's own profile or a CODEX_HOME the person moved, exact
   * folders only. Copied from the former lib/claudeTrust.ts.
   */
  trust: { home: { setting: 'CODEX_HOME' }, file: 'config.toml', format: 'toml', table: 'projects', key: 'trust_level', value: 'trusted' },
  /**
   * A rollout written on a grid relay keeps reasoning items the relay's portable_reasoning_item contract
   * forbids (a vendor-style id on plaintext reasoning, text in `content`). Back on Codex's own provider,
   * `codex resume` replays them and fails. Retargeting to the native subscription bypasses the grid, so
   * response-side relay cleanup cannot repair items already persisted: they are repaired before the resume.
   * `response_item` records are replayed as they are, and `compacted` ones replay their `replacement_history`.
   * Copied from the former engines/codex/portableHistory.ts and the rollout lookup of engines/codex/rollout.ts.
   */
  resumeRepair: {
    sessions: { home: { setting: 'CODEX_HOME' }, folder: 'sessions', suffix: '.jsonl', id: /^[a-zA-Z0-9-]{8,128}$/, walk: 5_000 },
    first: { type: 'session_meta', id: ['payload', 'id'] },
    items: [{ type: 'response_item', at: ['payload'] }, { type: 'compacted', at: ['payload', 'replacement_history'], list: true }],
    repair: 'portable-reasoning',
    backup: '.reasoning-backup-', temporary: '.reasoning-tmp-',
    names: { file: 'Codex rollout', history: 'Codex history', items: 'Codex reasoning items' },
  },
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
  /**
   * Codex 0.157 made its full-screen transcript the default (`tui.fullscreen_transcript`, 0.156 added it), which
   * pins the composer to the foot of a phone's pane (facets/launch.ts `ScreenContract`). `-c` outranks the person's
   * config.toml and a profile's: measured against 0.162.1, `=true` there with `=false` here leaves the alternate
   * screen off. 0.155.1 and 0.146.0, which have no such key, start with it as they would without (2026-10-13).
   * `--no-alt-screen` would also do, but it turns every overlay inline too, the transcript pager among them.
   */
  screen: {
    args: ['-c', 'tui.fullscreen_transcript=false'],
    // In its scrollback 0.162.1 answers every resize, a phone's keyboard going up or down among them, by printing
    // its transcript again: `ESC[2J ESC[3J` outside its synchronized update about 80 ms after the resize, then the
    // whole transcript in one synchronized update (`ESC[?2026h` … `ESC[?2026l`), done by 155-186 ms (measured in a
    // 50x40 pane, 2026-10-13). A keyframe taken at 10-40 ms let the phone draw the cleared screen, a flash at every
    // raise and lower of the keyboard. Waiting instead for the output to pause held a phone's typing 1.5 s: Codex at
    // work redraws its `Working (…)` line without one. Read off its end, the wait was 100-112 ms. The clear came at
    // 78-82 ms idle; at work, past 150 ms (the flash came back at that, 2026-10-13), and one later still than this is
    // caught as live output (lib/terminalStreamManager.ts `REPAINT_GUARD_MS`). A Codex with no transcript to print
    // sends none, and costs the whole `withinMs`.
    resizeRepaint: { clears: '\u001b[3J', ends: '\u001b[?2026l', withinMs: 250 },
  },
  /**
   * Codex 0.162.1 has no setting for its attribution's text: its own line ("Generated with [Codex](…)") is an
   * instruction in its developer message (`<git_attribution>`), on or off by workspace. `developer_instructions` is
   * the config key that adds to that message, so ours is worded as Codex words its own, and stays beside it.
   */
  attribution: {
    kind: 'instruction',
    home: { setting: 'CODEX_HOME' }, file: 'config.toml', folder: '.codex/config.toml', key: 'developer_instructions',
    instruction: 'When you create or update a pull request, its body must include this exact line once, near the end and '
      + 'after any other attribution line: `{line}` It says another agent started this session in Harness. Do not add it '
      + 'to commit messages.',
    args: ['-c', 'developer_instructions={value}'],
  },
  // Beside the attribution's instruction, in the one `developer_instructions` value (facets/launch.ts).
  // Its sandbox keeps a command from Harness's socket and port: told only that Harness was not running, an agent ran
  // `harness start` and asked the person to let it start Harness (a fresh Mac, 2026-10-12; lib/unreachable.ts).
  harnessInstructions: { kind: 'attribution', also: 'Codex\'s sandbox cannot reach Harness: run each harness command outside it, with escalated permissions.' },
}

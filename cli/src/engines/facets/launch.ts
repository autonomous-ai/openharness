import type { FolderSetting } from './hooks.js'

/**
 * An engine whose CLI can leave work on a server of its own, shared per store (Codex's app-server). Declared
 * data: core decides from it, with no worker, whether a client's conversation lives on that server at all,
 * and the server's protocol is the engine worker's (facets/nativeControl.ts). Copied from the former
 * lib/codexSessionLifecycle.ts, which read these facts in core before the move.
 */
export interface SharedServerContract {
  /** Harness puts this first among the options of a client that owns its conversation in its own process. */
  ownedFlag: string
  /** A client given this option (or `<flag>=…`) works on a remote server, which no local stop reaches. */
  remoteFlag: string
  /** The script's basenames when an interpreter (node) runs the CLI: its options start after the script. */
  scripts: readonly string[]
  /** Where, in the store, the server records its process, as JSON `{ pid, processStartTime }`. */
  pidFile: string
  /** What the person is told when the stop cannot go on, in the engine's own words. */
  messages: { unverified: string; remote: string; unidentified: string }
}

/**
 * The flag that hands the engine its harness context file (a DSH's CONTEXT.md). `{file}` in an argument is
 * the file's path, as a JSON string where `quote` is `json`. Applied by kit/launchArgs.ts.
 */
export interface ContextArgsTemplate {
  args: readonly string[]
  quote: 'json'
}

/**
 * The session's variables as argv, for an engine whose commands do not inherit its process's environment.
 * Each variable whose name `name` accepts becomes `flag` followed by `setting`, in which `{name}` is its name
 * and `{value}` its value as a JSON string. Applied by kit/launchArgs.ts.
 */
export interface EnvArgsTemplate {
  flag: string
  setting: string
  name: RegExp
}

/**
 * The provider an engine goes back to when it leaves a grid, for an engine that keeps the provider it was
 * launched with in state of its own. The person's choice is the top-level `key` of `file` in the launch's
 * home (the agent's profile, else the home `home` names, as the person's shell may move it), else `fallback`.
 * `{value}` in `args` is that provider. Applied by kit/launchArgs.ts; the composition is engines/launches.ts.
 */
export interface OwnProviderContract {
  home: FolderSetting
  file: string
  key: string
  fallback: string
  args: readonly string[]
}

/**
 * Run again, in the same pane and with the same arguments, after a startup that ended before the
 * conversation opened. Told by the pane's last line, read through the daemon's tmux after the engine exits
 * (so its terminal stays real throughout), and only a line printed since that run began.
 */
export interface StartupRetry {
  /**
   * A startup update that ended the run with `status` and asks to be started again: `line` is a regular
   * expression's source for that last line. One more run follows, with no time limit, since the person may
   * leave the update's prompt open first.
   */
  updated: { status: number; line: string; message: string }
  /**
   * A transient failure: the run ended with `status`, and the last line is exactly `line`, within `withinMs`
   * of the run starting. Up to `attempts` runs in all, the n-th retry after `backoffSeconds` × n; Ctrl-C
   * cancels the wait. `message` may name `{attempt}`, `{attempts}` and `{delay}`.
   */
  transient: { status: number; line: string; withinMs: number; attempts: number; backoffSeconds: number; message: string }
}

/**
 * What the pane's script does around the engine's run, beyond the wrapper every engine gets
 * (lib/engineLaunch.ts). Declared data, written into the script by kit/launchStartup.ts. A launch is session
 * control, so no worker is involved: the script runs in the pane, under the daemon's own Node.
 */
export interface StartupContract {
  /**
   * Before every run, ask the binary's own `--help` whether it takes `sharedServer.ownedFlag`, and pass it
   * first when it does: an older build lacks it. A probe that cannot answer ends the launch, saying
   * `unverified`. It also gives the engine a POSIX shell to run in where the daemon has no login shell.
   */
  ownedFlag?: { unverified: string }
  retry?: StartupRetry
}

/**
 * Where an engine keeps its own settings for a launch made now. `setting`: the folder a daemon setting names,
 * unless the person's shell moves it, unless the agent has a profile of its own (Codex's CODEX_HOME).
 * `variable`: the folder a variable the person's shell sets names, else their home folder (Claude Code's
 * CLAUDE_CONFIG_DIR). Resolved by lib/engineHomes.ts `launchHomeOf`.
 */
export type LaunchHome = { setting: FolderSetting } | { variable: string; otherwise: 'home' }

/**
 * An engine's answer to "do you trust this folder?", which it asks the first time it opens one, kept in `file`
 * in its home. Harness records it only for a folder it made empty itself (the callers decide), never removes
 * anything, and leaves a file it cannot safely extend as it is. Applied by kit/folderTrust.ts.
 */
export type TrustContract = { home: LaunchHome; file: string } & (
  /**
   * A JSON object whose `projects` map a folder to its entry, trusted where `accepted` is true. A trusted
   * folder's trust covers every folder below it. A new entry starts as `entry`.
   */
  | { format: 'json'; projects: string; accepted: string; entry: Readonly<Record<string, unknown>> }
  /** A TOML table per folder, `[<table>."<folder>"]`, trusted where its `key` is `value`. Exact folders only. */
  | { format: 'toml'; table: string; key: string; value: string }
)

/**
 * Making a stopped conversation's history resumable before the engine is launched on it again. Applied by
 * kit/resumeRepair.ts, after the engine has stopped and before the tail moves and the engine starts.
 */
export interface ResumeRepairContract {
  /**
   * Where histories are: `folder` in the engine's home (the agent's profile, else every home the person moved
   * and the daemon's). One is a file ending in `suffix` whose name holds the session's id, at any depth; only
   * names with no `.` are folders worth entering, and at most `walk` entries are looked at. An id `id` refuses
   * is never looked for.
   */
  sessions: { home: { setting: FolderSetting }; folder: string; suffix: string; id: RegExp; walk: number }
  /** The first record names the session: its `type`, and the field that holds the id. */
  first: { type: string; id: readonly string[] }
  /** The records whose items the engine replays: the item at `at`, or each item of the list there. */
  items: ReadonlyArray<{ type: string; at: readonly string[]; list?: boolean }>
  /**
   * What is repaired in each item. `portable-reasoning`: the relay's portable_reasoning_item contract (a
   * plaintext reasoning item keeps no vendor id, and its text is its summary).
   */
  repair: 'portable-reasoning'
  /** The private files beside the history, by suffix: the backup of what it was, and the one being written. */
  backup: string
  temporary: string
  /** How the person, and the daemon's log, name the history file, the history and what was repaired. */
  names: { file: string; history: string; items: string }
}

/** Literal argv contracts copied from the existing launch paths. No engine version behavior changes. */
export interface EngineLaunch {
  permissionModes: Readonly<Record<string, readonly string[]>>
  bypassPermission: string[]
  firstPromptArgs: readonly string[]
  resumeArgs: string[]
  forkArgs: { lead: string[]; after?: string[] }
  instructionFiles: readonly string[]
  contextArgs?: ContextArgsTemplate
  envArgs?: EnvArgsTemplate
  sharedServer?: SharedServerContract
  ownProvider?: OwnProviderContract
  startup?: StartupContract
  /** The instruction file Harness writes its own notes into (a harness's bootstrap, the saved APIs); else AGENTS.md. */
  instructionFile?: string
  /** The line, in that file, that has the engine read `file` too (Claude Code's `@AGENTS.md` import). */
  instructionImport?: { file: string; line: string }
  trust?: TrustContract
  resumeRepair?: ResumeRepairContract
}

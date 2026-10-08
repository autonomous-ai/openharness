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
}

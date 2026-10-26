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
   * `unverified`. It also gives the engine a POSIX shell to run in where the daemon has no login shell. Windows has
   * none: there the daemon reads the help as it inspects the launch, and the flag goes in the argv
   * (lib/windows/engineStart.ts).
   */
  ownedFlag?: { unverified: string }
  retry?: StartupRetry
}

/**
 * The screen Harness runs an engine's TUI on: the terminal's own scrollback, or a full-screen alternate screen of
 * the engine's. Every launch Harness makes applies it (kit/launchScreen.ts), whatever the person's own settings say,
 * so one engine looks the same on every computer. An engine that declares none runs as the person set it up.
 *
 * Why: one pane is driven by a desktop window and a phone in turn, and each takeover resizes it. In the scrollback
 * the history is the viewer's own and scrolls natively, and Find, selection and the phone's long-press reach all of
 * it; full screen, the engine pins its prompt to the foot of the pane and owns scrolling. The scrollback serves an
 * engine that lays its history out again cleanly when the pane narrows: Codex does, so Harness runs it there
 * (codex/launch.ts). Claude Code does not (it printed part of its conversation twice), and Harness leaves its screen
 * to the person's own setting. The keyframe re-wraps a history kept in the scrollback by word (lib/historyRewrap.ts).
 */
export interface ScreenContract {
  /** Argv given to every launch, ahead of the launch's own extra arguments. */
  args?: readonly string[]
  /** Variables exported after the person's rc files, so neither their shell nor their profile can undo them. */
  environment?: Readonly<Record<string, string>>
  /** Variables removed after the person's rc files: those that would choose the other screen. */
  clearEnvironment?: readonly string[]
  /**
   * How the engine answers a resize in the scrollback, where it does so by printing its transcript again: within
   * `withinMs` of the resize it writes `clears` (it has cleared the screen and the scrollback), then the transcript,
   * which the first `ends` after the clear closes. A keyframe taken right after a resize waits for that print to end,
   * so a viewer never draws the cleared screen in between (lib/tmuxStream.ts `snapshot`). The end is read off the
   * output, not inferred from a pause in it: an engine at work animates its status line without one.
   */
  resizeRepaint?: { clears: string; ends: string; withinMs: number }
}

/**
 * Where an engine keeps its own settings for a launch made now. `setting`: the folder a daemon setting names,
 * unless the person's shell moves it, unless the agent has a profile of its own (Codex's CODEX_HOME).
 * `variable`: the folder a variable the person's shell sets names, else their home folder, or `folder` in it
 * (Claude Code's CLAUDE_CONFIG_DIR: `.claude.json` is in the home folder itself, `settings.json` in `~/.claude`).
 * Resolved by lib/engineHomes.ts `launchHomeOf`.
 */
export type LaunchHome = { setting: FolderSetting } | { variable: string; otherwise: 'home' | { folder: string } }

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
 * The engine's question about MCP servers a folder inherits: a project file of servers (`file`, `servers` its map) in a
 * folder ABOVE the one it opens, which it asks to use or not as it starts there. Its own "no", the question's default, is
 * kept as `rejected` in `settings` in the folder. Harness records that same "no" for a folder it made empty itself,
 * where it records the folder's trust, so its agent starts at once instead of waiting on the person: a Claude Code
 * harness in a new project under the home sat at "New MCP server found in this project: argent" with its first message
 * never typed, while `harness wait` read it as working (2026-10-26). A server the person decided in their user
 * settings (`user`: `approved`, `rejected`, or `approveAll` on) is theirs and left alone; so is a file in the folder.
 * Applied by kit/inheritedMcp.ts.
 */
export interface InheritedMcpContract {
  file: string
  servers: string
  settings: string
  rejected: string
  user: { home: LaunchHome; file: string; approved: string; rejected: string; approveAll: string }
}

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

/**
 * How an engine is told to add a line to the pull requests it opens: a harness another agent started says so
 * (lib/agentAttribution.ts). Applied by kit/attribution.ts on each launch of one, its relaunches included. The
 * person's choices stay theirs: the engine's own line is kept beside it, an instruction of theirs is never
 * replaced, and where they hid the engine's attribution nothing is added.
 */
export type AttributionContract = SettingAttribution | InstructionAttribution

/**
 * An engine with a setting for the text it adds to a pull request, in JSON settings files that a settings object
 * on its command line overrides key by key (Claude Code's `attribution.pr` and `--settings`, 2.1.296). The
 * setting's text replaces the engine's own line, so it is given the line the engine would have added, then ours.
 */
export interface SettingAttribution {
  kind: 'setting'
  /** The person's settings files, lowest precedence first: `file` in `home`, then each of `folder` in the harness's folder. */
  home: LaunchHome
  file: string
  folder: readonly string[]
  /** The setting: an object at `key` whose `field` is the pull request's text. `false` at `key` hides every line. */
  key: string
  field: string
  /**
   * An older setting that, `false`, hides every line while `key` sets none of `until` (Claude Code's
   * `includeCoAuthoredBy`). Setting `field` would end that and bring back the engine's commit line, so a person
   * who set it gets nothing added.
   */
  legacy?: { key: string; until: readonly string[] }
  /** The engine's own line, where the person set no text. */
  own: string
  /** The argv; `{settings}` is the settings object, as JSON. */
  args: readonly string[]
  /**
   * The same line as an instruction (`{line}`), told with Harness's instructions (`harnessInstructions` `append`)
   * whenever the setting is given: a setting is only a default, which the agent drops once its task spells out the
   * pull request's body.
   */
  instruction?: string
}

/**
 * An engine with no setting for its attribution's text, which it gives its model as an instruction (Codex 0.162.1:
 * `<git_attribution>` in the developer message), and which takes more instructions in a config key `-c` sets
 * (`developer_instructions`). `-c` replaces the person's own value, so theirs comes first and ours after it; one
 * that cannot be read exactly, or one a folder's own config sets, is left alone and nothing is added.
 */
export interface InstructionAttribution {
  kind: 'instruction'
  /** The person's config: `file` in the agent's profile, else the home `home` names. */
  home: LaunchHome
  file: string
  /** A folder's own config, looked for in the harness's folder and each folder above it, up to the home folder. */
  folder: string
  /** The top-level key the instructions are in. */
  key: string
  /** What the model is told; `{line}` is the line. */
  instruction: string
  /** The argv; `{value}` is the instructions, as a JSON string, which TOML reads as the same string. */
  args: readonly string[]
}

/**
 * The flags that give ONE session its model and effort, so that nothing is written to the person's own engine
 * settings (Claude Code's `/model` and `/effort` commands are saved there as the new default). `{value}` in an
 * argument is the model or the effort. `efforts` are the levels the effort flag takes; any other is refused.
 * Applied by lib/launchModel.ts.
 */
export interface ModelArgsContract {
  model: readonly string[]
  effort: readonly string[]
  efforts: readonly string[]
}

/** Literal argv contracts copied from the existing launch paths. No engine version behavior changes. */
export interface EngineLaunch {
  permissionModes: Readonly<Record<string, readonly string[]>>
  bypassPermission: string[]
  firstPromptArgs: readonly string[]
  resumeArgs: string[]
  /** How a new session is launched with a model and effort of its own, for this session only. */
  modelArgs?: ModelArgsContract
  forkArgs: { lead: string[]; after?: string[] }
  instructionFiles: readonly string[]
  contextArgs?: ContextArgsTemplate
  envArgs?: EnvArgsTemplate
  sharedServer?: SharedServerContract
  ownProvider?: OwnProviderContract
  startup?: StartupContract
  /** The screen the engine's TUI runs on, where Harness chooses it; applied to every launch (kit/launchScreen.ts). */
  screen?: ScreenContract
  /** The instruction file Harness writes its own notes into (a harness's bootstrap, the saved APIs); else AGENTS.md. */
  instructionFile?: string
  /** The line, in that file, that has the engine read `file` too (Claude Code's `@AGENTS.md` import). */
  instructionImport?: { file: string; line: string }
  trust?: TrustContract
  /** Recorded with `trust`, for the same folders (kit/inheritedMcp.ts). */
  inheritedMcp?: InheritedMcpContract
  resumeRepair?: ResumeRepairContract
  attribution?: AttributionContract
  /** How the engine is told, as it starts, that it runs in Harness and how to use it (lib/agentAttribution.ts). */
  harnessInstructions?: HarnessInstructionsContract
}

/**
 * Where an engine takes a few lines of instructions on its command line: appended to its system prompt (`append`,
 * Claude Code's `--append-system-prompt`; `{text}` is the text), or beside its attribution instruction, in the one
 * config value both live in (`attribution`, Codex's `developer_instructions`: a second `-c` of the same key would
 * replace the first, and the person's own value).
 */
export type HarnessInstructionsContract = ({ kind: 'append'; args: readonly string[] } | { kind: 'attribution' }) & {
  /** Said after Harness's instructions to this engine's agents alone: what about the engine changes how they use them. */
  also?: string
}

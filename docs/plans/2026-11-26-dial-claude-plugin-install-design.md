# Dial: Claude Code's plugin installs without git, and voice says how to reach Claude Code

Status: approved by the PM (2026-11-26), design points 1–4 and questions 1–3 as recommended.

## Problem

On one of the owner's Macs, voice to a Claude Code session in Terminal always shows `See it in Terminal`.

- `harness device claude status --json` says `installed: false` with Claude Code 2.1.332.
- Every devices start logs `[device] dial setup · claude · failed · marketplace`, with no reason.
- The `harness-device` plugin's mod is the only way voice reaches a Claude Code session in a terminal Harness cannot
  type into, such as Terminal. Without it the session has no `v` cap. The firmware then shows `See it in <host>` on
  its own, and the daemon never hears about it.

The marketplace step runs `claude plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins`.
That clones from GitHub with git. The likely cause is macOS without the Command Line Tools. There `/usr/bin/git` is a
shim that fails, but `findGit` (#4635) finds it and takes it as git. Other possible causes are no route to GitHub, or
Claude Code not answering within 60 s. The log cannot tell these apart.

## Goals

1. The plugin installs with no git and no GitHub. Harness carries the plugin's files and adds them to Claude Code as a
   local-directory marketplace.
2. A failed marketplace or install step logs why, as a fixed word. It never logs Claude Code's own line.
3. Voice at a Claude Code session the dial cannot reach shows the fix on the dial, not `See it in Terminal`.
4. macOS, Linux and Windows alike.

## Out of scope

- Firmware changes. The dial's own `See it in <host>` stays as it is for every other host.
- Moving computers that already have the `openharness` marketplace from GitHub onto the local folder. Removing a
  marketplace uninstalls every plugin from it, including the person's own `harness` plugin. Their updates still run
  through Claude Code's `marketplace update`, which uses git for that source.
- The data folder moving after the install (Linux's one-time XDG move). Today it already leaves Claude Code's
  default-home records naming the old path. That is a separate follow-up.
- `harness uninstall` and the plugin. Today it leaves the GitHub-sourced plugin installed. With the local folder, it
  also leaves Claude Code a marketplace whose folder is gone. Follow-up: uninstall runs `claude plugin uninstall`, and
  `marketplace remove` for a marketplace sourced from our folder.
- `dial skill: claude held (agents not known)`. It is a different step (the dial skill waits for the core's agent
  list), and the same log shows it unrelated to the plugin.

## Facts from Claude Code's docs

From code.claude.com/docs/en/plugins: install, loading, cli-reference and troubleshooting.

- `claude plugin marketplace add <path>` takes a directory holding `.claude-plugin/marketplace.json`. The path must
  start with `/`, `./`, `../` or `~/`. A local source is read in place and not cloned, so no git is involved.
- A relative-path plugin in a local-directory marketplace loads in place from that directory. Changed files take
  effect at the next session start, or at `/reload-plugins`.
- A plugin's version comes from `plugin.json`'s `version` first. A non-git local directory with no version is
  `unknown`.
- Adding a marketplace whose name is already registered from another source is refused. `marketplace remove`
  uninstalls its plugins.

## Design

### 1. The plugin travels with the CLI (goal 1)

- **Build.** `cli/build.mjs` and `cli/build-bundle.mjs` define `__CLAUDE_PLUGIN__`, as they do `__ORCA_PLUGIN__`.
  `cli/scripts/lib/claudePluginBundle.mjs` reads two plugin folders:
  - `plugins/harness-device/`: `.claude-plugin/plugin.json`, `hooks/*` and `README.md`, leaving out `test/`.
  - `plugins/harness/`: `.claude-plugin/`, `.mcp.json` (Claude Code's; `mcp.json` is Cursor's), `skills/`, `assets/`
    and `README.md`.

  It produces:
  - `.claude-plugin/marketplace.json`: the repository's own (name `openharness`, both plugins, each with its
    `./plugins/<name>` source).
    - Both plugins, because the name is shared. The README and the website tell people to add
      `autonomous-ai/openharness` and install `harness@openharness`. Once our local `openharness` exists, that add is
      refused, so `harness@openharness` has to install from ours.
    - The name cannot change: the mod names `harness-device@openharness` (`plugins/harness-device/hooks/device.js:41`).
  - `plugins/<name>/...`: each plugin's files.
    - Each `plugin.json` gets `version` = `<CLI version>+<first 8 hex of the SHA-256 of that plugin's files>`. A dev
      version goes through `extensionVersion` first, as the VS Code extension's does (`0.6.66-dev.g0123456+<hash>`).
    - So a release, and every dev build whose plugin files changed, shows `claudeUpdate` a new version. That holds
      whether Claude Code loads the plugin in place (the docs) or copies it into its cache by version (what this
      Mac's records show for GitHub-sourced plugins).
  - Which files are executable (`hooks/asked`), so the writer can give them 0700.
- **Run from the sources** (`tsx`, vitest: no define). As with Orca's plugin, `files()` is null, and the setup skips
  the install and the update, counting nothing (`devices/orcaPlugin.ts:193`). Every daemon people run is a built
  `cli.js`.
- **CI.**
  - `scripts/ci-plan.py` maps `plugins/harness-device/` and `plugins/harness/` to `cli`, as it maps the Orca plugin.
  - A spec asserts both builds define `__CLAUDE_PLUGIN__`, as `orcaPluginBundle.spec.ts` does for `__ORCA_PLUGIN__`.
- **Folder.** Each run writes the folder to `harnessPath('claude-marketplace')`, a `data` entry in
  `config/harnessHome.ts`, before any `claude plugin` call that adds, updates or installs.
  - It uses the Orca plugin's crash-safe writer (`devices/orcaPluginFolder.ts`), generalised and renamed
    `devices/pluginFolder.ts` with one export `ensurePluginFolder(folder, files, executable)`. Folders are 0700,
    files 0600, and listed executables 0700.
  - A folder with the same bytes and modes is not written.
  - Windows has no mode bits, so modes are neither set nor compared there, and the folder is not rewritten at every
    run.
  - A write that fails is the step `folder`, counted with its error's code.
    - It stops an install: there is nothing to add.
    - On an update it is counted and the update goes on, since a marketplace from GitHub never reads the folder.
- **The path Claude Code is given.** The docs take a local source only when it starts with `/`, `./`, `../` or `~/`,
  and Windows' `C:\...` starts with none.
  - So on every OS the add runs in the folder's parent (`claudeRunner` gains a `cwd`), with the argument
    `./claude-marketplace`. Claude Code records the absolute path.
  - It is proven on the Windows VM (Platforms).
- **Install.**
  - When `marketplace list --json` has no `openharness`, run `claude plugin marketplace add ./claude-marketplace`, then
    `claude plugin install harness-device@openharness --scope user`.
  - When `openharness` is there (from GitHub, or our folder), keep today's flow: install, and when that fails, run
    `marketplace update openharness` once and install again.
  - `--sparse` and the GitHub add go away. So do the git lookup on this path (`ClaudeInstallDeps.git`, `NO_GIT`, the
    step `git`, `noGit` in `cable/dialPluginSetup.ts`), its `git` deps in `services/devices.ts` and in
    `deviceClaude/command.ts`, and the `failed · no git` count and its docs line in `cli/AGENTS.md`.
  - The removal also covers `cable/dialSetup.ts` (its `git` dep), `cli.ts` (where it passes `findGit`),
    `services/devices.ts` (the dep and its wiring) and their specs.
  - It also drops the stale "Its manifest carries no version" comment in `claudeUpdate`.
  - Nothing on this path needs git now, so (c), the Command Line Tools check, is not built.
- **Update** (`claudeUpdate`, after each CLI update): write the folder first, then today's
  `marketplace update openharness` and `plugin update`. For our folder the update re-reads it, and the new `version`
  shows as `updated`.
- `harness device claude enable` writes the folder too, so it works on a computer where the devices never ran.
  - In a build that carries no plugin it runs no `claude`, prints `This Harness build carries no Claude Code plugin.`
    and exits 1.
  - When it cannot write the folder it prints `Harness could not write Claude Code's plugin folder. (<code>)`, e.g.
    `(EACCES)`, and exits 1.

### 2. The reason a step failed (goal 2)

- `ClaudeAnswer` gains `timedOut?: true`, set only by the runner's deadline.
- `ClaudeFailure` gains an optional `reason`: a fixed word that `failure()` sets from the call's exit and stderr.
- `unsupported`, `launcher` and the other failures that made no call keep none.

The reason is read in this order:

| Reason | When |
|---|---|
| `timeout` | `code === null` and the call ran out its time (the runner's deadline) |
| `no answer` | `code === null` otherwise (failed to start, output past its bound) |
| `no xcode tools` | stderr has `xcrun: error` or `invalid active developer path` or `CommandLineTools` |
| `no git` | stderr has the word `git` (`(?<!\.)\bgit\b`, so not `github` nor `openharness.git`) with `not found`, `ENOENT`, `unsafe location` or `is not recognized` |
| `network` | stderr has `Could not resolve host`, `Failed to connect`, `Connection timed out`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, `SSL`, `TLS` (case-insensitive) |
| `exists` | stderr has `already added from a different source` / `already exists` |
| `exit <n>` | anything else, with the exit code |

- The devices count it as `[device] dial setup · claude · failed · <step> · <reason>`.
  - The reason handed to `count('failed', …)` becomes `<step> · <reason>`, or `<step>` alone when there is none.
  - The tally's day counts stay keyed by `failed` (`cable/engineTally.ts:15`). Only the log line carries the words.
  - The Orca homes' failures (`homeFailed`, `dialPluginSetup.ts`) are counted the same way.
- `harness device claude enable` prints the error line as today, plus `(<reason>)`.
- Claude Code's stderr is never logged.

### 3. Voice to a Claude Code session the dial cannot reach (goal 3)

The daemon cannot change the firmware's own line, so it takes the voice start and refuses it with words. That is the
path `cableSession` already has for refusals.

- **Caps** (`cable/hosts/observed.ts` `capabilities`). A live Claude Code agent (`engine === 'claude'`) has `voice`
  true even when it has no typing route, no ready mod and no queue. Other engines are unchanged. Caps are computed
  often, so nothing is read here.
- **Refusal** (`observed.ts` `voiceRefusal`). It now runs for a live agent with no real route: words, mod ready or
  queue. Before, it checked `capabilities().voice`.
  - It returns undefined for an agent that has a route, because the session now asks every agent with `v`.
  - Adapters' sentences come first, as today. Then, for Claude Code, two cases below.
  - **The plugin is not on in the session's own home** (`claudePluginState(<home>/settings.json) !== 'on'`):
    `Voice needs Harness in Claude Code. Run: harness device claude enable`
    - The home comes from the transcript path, through `claudeRenderer.ts`'s `homeOf`, now exported.
    - With no transcript path, it is the default home, `dirname(CLAUDE_PROJECTS_DIR)`.
    - Both reach `observed.ts` through `ObservedActions`, as `claudeHome` and a plugin-state reader, wired in
      `services/devices.ts`.
  - **The plugin is on, but this session's mod does not poll** (the session started before the install):
    `Restart Claude Code for voice.`
    - The person also sees "Restart" when the mod is only slow to poll: the devices just restarted, or the mod is in
      its 60 s or 10 min retry (`device.js:18,21`).
    - That is accepted: a restart always fixes it. Telling a session older than the plugin apart would need a start
      time the devices do not have.
  - **Settings reads.** They happen only here, at a voice start, synchronously (`voiceRefusal` is sync), at most
    1 MiB, as `claudePluginState` bounds them.
    - Its reader now checks that the path is a regular file before opening it, as the renderer's does, so a FIFO or a
      tty at a hook-given path is never opened.
- **Session** (`cable/cableSession.ts`, voice start). It refuses when the agent lacks `v`, as today. It also refuses
  when the agent has `v` and `host.voiceRefusal(agentId)` returns a sentence. No audio is kept, nothing goes to the
  transcriber, and `voice.error` carries the sentence, as with any refusal today.
- **Routing** with no agent named is unchanged: `routable` already leaves out agents outside Harness.
- **When the person sees it.** The refusal is decided at the voice start and sent at `voice.end` (`cableSession.ts`
  ~2574), because the round firmware shows `voice.error` only then. So the person speaks, then reads the sentence.
  No audio is kept.
- **What else reads `v`.**
  - Round firmware: the agent's resting face invites talking, and Stop and Models are enabled
    (`ui_habitat.c:1238,2033,2713`), as for a routed Claude agent today. The daemon already answers those for agents
    outside Harness (`cableSession.ts` ~1678, ~1902).
  - Pro firmware: it no longer shows `See it in` for these agents (`pod_glue.c:325`, `pro_app.c:642`), and takes the
    refusal the same way.
  - Tests that assert these agents' caps change with them: `observed.spec.ts`, `cableHost.spec.ts`,
    `registry.spec.ts`, `devices.spec.ts` and `cableSession.spec.ts`.
- **Copy** follows `docs/naming-system.md`: vendor name **Claude Code** intact, command in plain text, short.

## Measures

- The `failed · <step> · <reason>` count above, with fixed words only.
- The existing `refused` voice outcome (`decide({ outcome: 'failed', code: 'refused' })`) counts these refusals.
  No new identifier.

## Tests (red first, at the layer of the behaviour)

- `devices/claudePlugin.spec.ts`
  - The first install, with no `openharness`, writes the folder and runs `marketplace add ./claude-marketplace` in its
    parent folder. It never uses a GitHub source or `--sparse`, and asks for no git.
  - A failed add reports `reason` (`no xcode tools`, `network`, `timeout`, `exit 1`).
  - The update writes the folder before `marketplace update`.
- `scripts/lib/claudePluginBundle` spec (beside `orcaPluginBundle.spec.ts`): the marketplace and plugin manifests,
  the version, no `test/`, `hooks/asked` executable.
- `devices/pluginFolder.spec.ts`, from `orcaPluginFolder.spec.ts`: executable modes written, and a mode change
  rewrites.
- `cable/dialPluginSetup.spec.ts`
  - The count carries the reason.
  - The `noGit` cases are replaced: no git lookup at all.
- `cable/hosts/observed.spec.ts`
  - A live Claude Code agent with no route has `voice`.
  - `voiceRefusal` gives the enable sentence with the plugin off in its home, and the restart sentence with it on and
    no mod.
  - An agent with a route gives none.
- `cable/cableSession.spec.ts`: a voice start at an agent with `v` whose host returns a refusal sends
  `voice.error` with it and keeps no audio.
- `deviceClaude/command.spec.ts`: `enable` writes the folder and adds it, with no git.

## Platforms

- Unchanged on all three: `claude plugin` runs with no shell through `claudeRunner` (Windows: `windowsProgram`).
- The folder path comes from `harnessPath`.
- Windows has no mode bits, so the writer's modes are neither set nor compared there. Under Git Bash the hook execs
  `hooks/asked`, which needs no mode bit. Under PowerShell it runs `harness.exe`.
- The folder path is `harnessPath`'s, which ignores `ADAPTER_DATA_DIR`, as the Orca plugin's does. So a dev CLI
  writes the same folder the person's Claude Code reads.
- Tested by the unit specs on each OS's CI.
- Tested once on the Windows VM: `marketplace add ./claude-marketplace` run from the parent folder, then the plugin
  installs and its hook runs. This check is held for the PM's machine slot.

## Diagnostics for the affected Mac (read-only)

```
xcode-select -p; echo "clt_exit=$?"; /usr/bin/git --version 2>&1 | head -1
GIT_TERMINAL_PROMPT=0 git ls-remote --heads https://github.com/autonomous-ai/openharness main 2>&1 | head -2
claude plugin marketplace list --json | head -40
```

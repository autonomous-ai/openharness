# Harness follows the XDG Base Directory paths on Linux

PR 2 of 2. PR 1 (`docs/plans/2026-11-18-harness-paths-design.md`) put every path under `~/.harness` behind one module
per language, with a table of named entries tagged `data` or `state`, both roots `~/.harness`. This PR gives the two
roots their XDG places on Linux and moves existing users there once.

## Why

A Linux user from the ads campaign reported that Harness "doesn't respect XDG paths". Linux developers expect a
program's data in `$XDG_DATA_HOME`, its logs and state in `$XDG_STATE_HOME`, their home kept clean, and a backup able
to skip state. Today Harness writes everything to `~/.harness`.

## Goals

- On Linux, a fresh install puts the data root at `$XDG_DATA_HOME/harness` (default `~/.local/share/harness`) and the
  state root at `$XDG_STATE_HOME/harness` (default `~/.local/state/harness`). Each entry of PR 1's table goes to the root
  its label names. Nothing is written to `~/.harness`.
- An existing Linux user's `~/.harness` moves to the two roots at the next daemon start, before the daemon serves.
  They stay signed in, keep their computer id, Claude profiles, DSH harnesses, connections and history, and no agent
  shows "Hooks need review".
- Agents, panes and apps started before the move keep working: their hooks still reach the daemon, the daemon adopts
  their panes again, and what they write lands in the new roots. A small bridge left at `~/.harness` serves them, and
  goes once the last of them has ended.
- Every reader of these folders (the CLI and daemon, Desktop, `hn`, the PTY host, the Device app, the hook script, the
  shell integration, the installers, Harness OS's setup, the companions, the store agents) finds the same roots by one
  rule. Nothing keeps a `~/.harness` of its own.

## Non-goals

- macOS and Windows. `~/.harness` and `%USERPROFILE%\.harness` stay byte for byte as they are, on every path, hook
  command, launcher, golden file and installer.
- A config root. No entry is a config file a person edits. A cache root: no entry is purely re-downloadable on its
  own (`runtime` and `flasher` stay in state, as PR 1 placed them).
- A downgrade path. A CLI older than this PR, started after the move, finds no `~/.harness` it can use and starts as a
  new, signed-out machine. The release note says so.
- The `.harness` folder inside a project or workspace, and `.harness-<name>` file names (as PR 1).
- A release. Ken's go covers the merge only.

## Anti-goals (a failure even if it works)

- Running half on each side: two places that each hold part of the data, or the same data written in two places.
  The bridge holds links only, never a file of its own that something writes.
- A running agent losing its daemon, its hooks, its inbox or its account because of the move.
- A move that loses the sign-in (`auth`) or the computer id (`computer-id`), even after a crash in the middle of it.
- "Hooks need review" in Codex, or a Claude Code hook that stops reporting, after the move.
- A move that repeats its work, or a log that repeats a line at every check.
- A bridge that stays after the last process that could use it has ended, or one removed while such a process runs.
- Any change on macOS or Windows.
- Migration logic in the daemon core or in the master.

## Constraints

- **The daemon core** (root `AGENTS.md`, `cli/AGENTS.md#protect-the-core`). The move is not a session feature. It
  runs in a module of its own, outside the core's import graph and outside `cli/src/harnessd/`, loaded only by the
  start commands; the bridge's upkeep is a service in a process of its own (Design). The core grows no rule, list or
  record for either. `cli/src/config/harnessHome.ts`, already a core file from PR 1, gains only the Linux root rule
  (`node:os`, `node:path`, one existence check from `node:fs`), no feature logic.
- **The master** imports only Node and its own folder; `harnessd/platform.ts:507`'s fallback follows the rule inline
  (a few lines, no import) or takes the data folder its caller passes. The builder picks; `architecture.spec.ts` stays
  green.
- **Standalone scripts stay self-contained.** `cli/hook/notify.mjs` and `tui/src/shell_integration.sh` carry the rule
  inline. A changed `notify.mjs` is fine: Codex's `trusted_hash` covers the hook command's text, not the script's
  bytes (`engines/kit/hookReview.ts:49-56`), and is re-recorded at each hook install.
- **Environment overrides still win** (`ADAPTER_DATA_DIR`, `ADAPTER_CLI_DIR`, `ADAPTER_RUNTIME_DIR`,
  `HARNESS_AUTH_DIR`, `HARNESS_CONNECTIONS_DIR`, `HARNESS_HOOK_ROUTES_DIR`, `HARNESS_LOGS_DIR`, `HARNESS_PTY_DIR`,
  `HARNESS_DEVICES_DIR`, `HARNESS_AGENT_MESSAGES_DIR`, `HARNESS_FLASHER_CACHE`, `DSH_DIR`, `ADAPTER_COMPUTER_ID_FILE`
  and the rest): only the default behind each changes.
- **XDG variables:** a variable that is unset, empty or not an absolute path is ignored and its default used (XDG Base
  Directory spec). `XDG_` variables already pass the daemon's environment allowlist (`lib/startEnvironment.ts:58`).
- **No process reads another's environment** (`cli/AGENTS.md`, rule 4). The bridge's check reads only a process's
  owner and start time.
- **Every platform:** Linux changes; macOS and Windows unchanged and tested unchanged.

## Approaches

Recon found that a running session holds the old paths:

- each tmux pane is tagged with `sha256(realpath(cli/data))` (`lib/harnessSessionLabel.ts`), and the daemon adopts only
  panes with its own tag; the hook script checks the same tag (`notify.mjs` `paneFacts`);
- a hook command names the managed Node under `runtime/`, `cli/notify.mjs` and `--data-dir` absolutely
  (`engines/kit/notifyHooks.ts:169-191`), and Claude Code keeps the hook command its session started with;
- a pane's `PATH` holds the managed Node, its `CLAUDE_CONFIG_DIR` a folder under `claude-profiles`, its
  `HARNESS_DSH_DIR` a folder under `dsh`, its `BROWSER` a shim under `cli/data/bin`, its Claude status line a script
  under `cli/data/statusline`; its re-run prelude writes `$HOME/.harness/run` and `.../logs`; the Agent Messages hook
  reads `agent-messages/inbox`; `hn` and the shell integration use `tui` and `shell-requests`; a PTY host records its
  socket's absolute path.

- **A. Wait for a quiet start** (nothing of Harness running), then move. No bridge, but a machine whose agents always
  run moves only at a reboot.
- **D. Move at once, bridge the old paths (chosen by Ken, 2026-11-18).** The next daemon start moves everything and
  leaves at `~/.harness` one link per moved entry, so every old path resolves to its new place, until no process that
  started before the move is left.
- **B. Data now, state later; C. move and patch live sessions.** Rejected earlier: both roots are in use by running
  agents, and patching a running session's environment is impossible.

## Design

### The roots on Linux

One rule, the same in every language, decides where both roots are. On Linux:

1. `data = $XDG_DATA_HOME/harness` and `state = $XDG_STATE_HOME/harness`, each from its variable when that is an
   absolute path, else `~/.local/share/harness` and `~/.local/state/harness`.
2. If the data root exists, Harness uses the XDG roots (moved, or installed fresh).
3. Else, if `~/.harness` exists, both roots are `~/.harness`, exactly as today (not moved yet).
4. Else, the XDG roots (a fresh install).

The data root's existence is the one switch: it appears only at the move's commit (below) or on a fresh install, so
the bridge at `~/.harness`, or a `~/.harness` something old recreates later, never flips a machine back. New code
never writes through the bridge: it resolves the roots by this rule.

The rule is checked when a process resolves its paths (the CLI and daemon at start, `env.ts`), and by Desktop, `hn`
and the Device app each time they look for the daemon or a file, so a move during their life is followed at their
next look (one `stat`). What such an app opened before the move (Desktop's store, its log file) it keeps using through
the bridge until it relaunches.

On macOS and Windows the rule is not run: both roots are `~/.harness` (`%USERPROFILE%\.harness`) as in PR 1.

`harnessRoots()` (PR 1) returns both roots once they differ, so `harness uninstall`, the connectors' read fence and
`homeDataFolder.ts`'s check cover both. Uninstall also removes the bridge (its links, never what they point to), the
move's lock and record.

### When the move runs

At each start command, before anything else of the daemon loads: `harness start` (before the spawn lock's pid check
spawns a master), `harness start -f`, `harness start --if-down`, and `__harnessd` (systemd's `ExecStart`). It runs
when every one of these holds; otherwise nothing moves and the start goes on, whole on `~/.harness`:

- the platform is Linux, `~/.harness` exists as a folder that is not a bridge, and the data root does not exist;
- no daemon serves this data folder (no live pid in `adapter.pid`, its socket does not answer, no held spawn lock):
  a start that finds one running starts nothing anyway;
- no update waits for its verdict (`update-pending.json` in the CLI folder): a rollback then would run the previous
  build against moved folders;
- no other move holds the move lock (it waits for it, below);
- no override names a folder inside `~/.harness` (an `ADAPTER_DATA_DIR=~/.harness/cli/data` set by hand): the person
  chose that place. `harness tui` today passes `ADAPTER_DATA_DIR` to the daemon it starts even when nobody set it
  (`cli/src/tui/index.ts` `runSelf`); it stops doing so, so `hn` does not pin a machine to `~/.harness`;
- tmux is 3.0 or later, or no pane carries this data folder's tag: tmux before 3.0 has no pane options, keeps the tag
  in the pane's start command, and cannot be retagged (below), so there the move waits for a start with no such pane;
- no PTY host runs for this data folder (opt-in on Linux): its panes' tag lives inside the host and cannot be retagged;
- `~/.harness` is a folder, not itself a link: a person who linked it chose its place (`skipped-override`).

When it waits, the start logs one line, once per start, saying why and what to do (for an update: it moves at the
start after the update settles; for an override: unset it; for old tmux: close the agents and start again). The same
reason goes in the move record (Failures and state).

### Where the move runs

A new module, `cli/src/lib/homeMove.ts` (name the builder's), imported dynamically from `cli/src/entry.ts` for the
start commands only, before `cli.ts`, `masterProcess.ts` or `env.ts` load, as `team/bootGuard.ts` is today. It imports
Node and the path module only, never `env.ts`. It is not in the core's import graph and not in `harnessd/`.

After a move, the process that did it is still running the Node and `cli.js` it was started from under `~/.harness`,
and derives paths from them (`HOOK_SCRIPT` from its own location, the master's `scriptPath`, `process.execPath`). So it
starts itself again from the new paths with the same arguments and environment (`process.execve`, same pid, which
systemd follows; Node 22.15 or later, the CLI's floor). A process not started from inside `~/.harness` (sources,
Harness OS's `/usr/lib/harness`) does not.

### The move

Each top-level entry of `~/.harness` goes to the root PR 1's table names. An entry not in the table goes to the data
root (nothing is lost) and its name is logged.

1. **Lock.** `mkdir` a lock beside the state root (`$XDG_STATE_HOME/harness.move-lock`, holding the owner's pid),
   outside both trees. A start that finds it held and live waits for it (bounded, 30 s), then resolves the roots
   again; a stale one (dead pid) is taken over.
2. **Recover.** If a journal from an earlier move is there, finish it (below) before anything else.
3. **Check** the conditions above, under the lock.
4. **Journal.** Write `~/.harness/.move.json`: the roots, the move's time, the old data folder's tag, each step to do,
   and each done step as it completes.
5. **Stage and link, one entry at a time.** Rename `~/.harness/<entry>` into `<root>.moving/<entry>`, and at once put a
   symbolic link at `~/.harness/<entry>` pointing to `<root>/<entry>`, its place after the commit. Between the two the
   old path is missing for microseconds; until the commit, the link does not resolve (milliseconds). A hook that runs
   in that window fails once and writes its event offline, which can create a real folder at the old path: before
   linking, and again at the end, the move merges any such folder into the moved entry and links over it. Where a
   rename crosses filesystems (a custom `XDG_*_HOME` on another disk), the entry is copied first (modes, owner-only
   permissions and symlinks kept), then swapped for its link, then the files changed during the copy are copied again,
   so no write is lost; the original goes at the finish.
6. **Rewrite what names the old tree, inside the staged trees:** `runtime/current-node` (and `current-grid`, any
   `current-*` pointer); the absolute paths in the data folder's JSON records (`claude-profiles.json`,
   `codex-profiles.json`, `engine-homes.json`, DSH's `installed.json`, and any other record the inventory finds that
   stores an absolute path under the home root); and the files Claude Code and Codex keep with absolute paths inside a
   moved profile under `claude-profiles` (Claude Code's `plugins/installed_plugins.json` `installPath` and
   `plugins/known_marketplaces.json` `installLocation`, and any other the inventory finds), so plugins keep loading
   once the bridge is gone. Only a string that starts with an old entry's path changes, to that entry's new path. The
   journal keeps each file's previous bytes.
7. **Rewrite what names the old tree, outside it,** with each file's previous bytes kept in the journal: the `harness`
   launcher in `HARNESS_BIN_DIR` (`~/.local/bin/harness`; `hn` names only the launcher), and the systemd user unit
   when it is this install's (`ExecStart`'s Node and `cli.js`, `StandardOutput` and `StandardError`'s log path), then
   `systemctl --user daemon-reload`. The unit also carries `XDG_DATA_HOME` and `XDG_STATE_HOME` when they are set
   (added to `CARRIED_ENV`), so a daemon systemd starts finds the same roots as the person's shell.
8. **Retag Harness's panes.** Every pane on the default tmux server whose `@harness_daemon` is the old data folder's
   tag gets the new folder's tag (`tmux set-option -p`), so the daemon adopts it at its start and its hooks pass the
   tag check, with nothing added to the core. The old tag and the panes retagged go in the journal. Any other place
   the inventory finds where a live pane holds the tag is treated the same way.
9. **Commit.** Rename `<state root>.moving` to the state root, then `<data root>.moving` to the data root. The data
   root's rename is the commit: before it, rule 3 reads `~/.harness`; after it, rule 2 reads the XDG roots, and every
   bridge link resolves.
10. **Bridge.** Write the bridge record, `<state root>/bridge.json`: the move's time (to the second, from the same
   clock `/proc` start times use), the old data folder's path and tag. Give the bridge a real `hook-routes` folder
   (below).
11. **Finish.** Remove the copied originals and the journal (last), release the lock, write the move record, log one
   line, and start again from the new paths.

**Rollback.** A failure before the commit undoes what the journal says was done, in reverse: links removed, entries
renamed back, staged copies deleted, rewritten files restored to their saved bytes, panes retagged back,
`daemon-reload` again. `~/.harness` is then as it was, the start goes on whole on it, and the record says why. A
failed move is tried again at most once an hour, and at once when the person runs `harness start`.

**Recovery after a crash.** A start that finds a journal: data root committed → finish from step 10 (roll forward);
not committed → roll back. Each step checks its result before acting, so the move or its recovery run twice does the
work once.

### The bridge

After the move `~/.harness` holds only links, one per moved entry, each to its new place, plus a real, empty-but-for-
one-record `hook-routes` folder. Old paths resolve through the links, so everything an old session reads or writes
lands in the one new place; nothing is copied, and nothing is written into the bridge itself.

Why links are enough (checked in `notify.mjs`): it opens its data and routes folders with `O_NOFOLLOW`, which refuses
a link only as the last part of the path. `~/.harness/cli/data` resolves through the `cli` link to the real `data`
folder, so the check passes. The routes folder is a top-level entry, so the bridge keeps a real `hook-routes` folder
instead of a link, holding the daemon's route record (its new data folder, port, under its tag) while the bridge
lasts. With panes retagged, an old hook finds the record, or falls back to its own `--data-dir`, which now resolves to
the new folder and hashes to the new tag; both reach the daemon. For a home long enough that the socket lives in the
short folder (`s/`, a path over 96 bytes), the old hook names that folder by the hash of the old data path; the
bridge service keeps a short folder under that hash, holding a hard link to the daemon's socket, while the bridge
lasts. `connections` is a real folder in the bridge too, holding hard links to `bridge.sock` and `mcp-shim.mjs`: an
old agent's MCP shim refuses a linked folder (`mcpShimSource.ts:48-56`). The builder's inventory checks every other reader that might refuse a link (an `O_NOFOLLOW` on a top-level
entry, a real-path prefix check, an `lstat` check) and adds what it needs the same way, each with a test.

What old sessions get through it: the managed Node and `cli/notify.mjs` at their old paths (the current files: an
update already swaps them under running sessions), `--data-dir` and the hook's credential, its offline writes and its
registry, the Agent Messages inbox, `CLAUDE_CONFIG_DIR` and Codex homes under `claude-profiles`, `HARNESS_DSH_DIR`
and workspace skill links into `dsh`, the `BROWSER` shim and the status line under `cli/data`, the prelude's `run` and
`logs`, `hn`'s `tui` and `shell-requests`, and a PTY host's socket path under `pty`.

**The bridge service.** A small service in a process of its own (the edge host, or alone if the builder finds a reason),
started only while `bridge.json` exists. It reads only the bridge record, `/proc`, and what any service gets. It:

- writes the route record into the bridge's `hook-routes` and the short-folder socket link, at its start and after
  each core start (the daemon's port and data folder come from the service's own environment);
- checks, at its start and every 10 minutes (one timer, no hot path), whether an **old user** is still running: a
  process of this account (`/proc/<pid>/status` owner) that started before the move's time (`/proc/<pid>/stat` start
  time against the boot time in `/proc/stat`) and can still use an old path, which is one of:
  - an engine process Harness installs hooks for, by its name (`comm`, or the executable's base name): `claude`,
    `codex` and the rest of the engine list the hook installers cover;
  - a process whose executable (`/proc/<pid>/exe`) is in the old tree: under `~/.harness`, or under the roots its
    entries moved to (the kernel reports a renamed executable at its new path): the managed Node (old CLI processes,
    hooks), the PTY host, `hn`;
  - Harness's own apps, by executable name: Desktop (including its AppImage) and the Device app, which opened their
    stores and logs through the old paths at launch;
  - a pane process of the panes the move retagged (`tmux list-panes -a -F '#{pane_pid} #{@harness_daemon}'`), and its
    descendants (by `/proc/<pid>/stat` parent).
  It reads only owner, start time, name, executable and parent: never a process's environment or command line. The
  desktop session, `systemd --user` and ordinary shells outside Harness's panes do not count;
- when no old user is left and every DSH package's setup has run again (or failed and is marked `needs-setup`, After
  the move), removes the bridge (each link without following it, the routes folder, the short-folder
  link, then `~/.harness`), deletes `bridge.json`, logs one line, and stops.

So the bridge usually goes within 10 minutes of the last old agent's end, not at the next logout. If this narrow rule
misses a process that still uses an old path after the bridge is gone, that session loses its reporting to Harness
(a hook that cannot reach the daemon), never data: every file is already in the new roots, and a write to an old path
then creates a stray `~/.harness` that nothing reads (rule 2).

### After the move

- **Hooks.** The core installs every engine's hooks at each start (`core/main.ts:3397`) and per agent home, and
  re-records Codex's `trusted_hash` (`kit/hookReview.ts:220-235`). Hook commands written by the old tree are recognised
  as Harness's by their Node and `notify.mjs` names and flags, and replaced with the new paths; the Agent Messages hook
  and the Claude status line too. New sessions get the new commands; old ones keep theirs, served by the bridge.
  `LEGACY_SCRIPT` keeps recognising the old `/.harness/cli/notify.mjs` form.
- **Ids that hash a path follow the new path.** A Claude or Codex profile's id hashes its real path
  (`claudeHomes.ts:profileId`), and Desktop computes the same id from the folder the daemon reports
  (`desktop/lib/usage/usage_account_key.dart:29`), so the id follows the moved folder, and the move converts every id
  it finds stored from the old value to the new one (harness-pm, 2026-11-18, replacing "ids stay"). Any other id the
  inventory finds that hashes or embeds a moved path gets the same treatment, but the agent browser's container labels
  (below). The pane tag changes, and the panes are retagged (step 8).
- **DSH packages set up again.** A harness package's setup builds things that embed its folder and are not JSON
  (virtual environments, launchers, uv and micromamba runtimes, `cli/src/dsh/install.ts`). After the move, the Store
  runs each installed package's setup again, one or two at a time, so the machine is not choked; the bridge waits for
  it. A package whose setup fails is marked `needs-setup`, with one log line and a state shown on its Store page and in
  `harness dsh list`, and counts as done for the bridge, so it never holds the bridge for good. The person acts on it
  through the existing update path: `harness dsh update` and the Store's Update button run the setup again for a marked
  package (no new button or request).
- **Links that outlive the bridge.** A forked community project's `node_modules` link into a moved package (Godogen)
  is replaced by Desktop's `prepareRuntime` with one to the new place. The agent browser's container labels keep their
  old spelling (a Podman label cannot change in place). The orchestrator's prompt files name the Node and `cli.js` by
  path: new agents get the new paths at launch, and a running one is an engine process, so it holds the bridge.
- **`engine-homes.json` is sealed** (each entry chained by a digest of its bytes, `engines/kit/homeAdoption.ts`): the
  move rewrites it and seals it again through `homeAdoption.ts`'s own export, one import beyond Node for the move.
- **DSH links in workspaces** (`<workspace>/.harness/runtime/<hash>/skills/<name>`, `dsh/runtime.ts:183-194`) that
  point into the old `dsh` still resolve through the bridge; the next launch in that workspace replaces such a link
  with one to the new folder instead of failing with "already occupied". A link pointing anywhere else still fails.
- **A PTY host** started before the move records its socket under the old path; the daemon reaches it through the
  bridge, and the host is an old process, so the bridge stays while it runs.

### Every reader follows the rule

From PR 1's "PR 2 also has to change", its plan's "For PR 2" and its review:

- **CLI module** `config/harnessHome.ts`: the rule, for Linux. `harnessPathText` (the launch prelude's shell text)
  writes the resolved root (`$HOME`-relative when it is under the home) instead of `$HOME/.harness`.
- **CLI literals left by PR 1:** `harnessd/platform.ts:507`; the joins onto `dirname(ADAPTER_CLI_DIR)` or a `rootDir`
  that read the Windows layout stay (Windows is unchanged); `lib/launchers.ts:142`'s `<root>/runtime` follows the state
  root on Linux; `prepareShortFolder` (`lib/localSocket.ts`) accepts a short folder under the state root's `s` as it
  accepts `/.harness/s/<hex>` now.
- **Uninstall** (from PR 1's review): `uninstall/removal.ts` refuses a root whose folder is not named `.harness`
  (`ROOT_NAME`). With XDG roots the folder is named `harness`, so the safety check accepts exactly the two roots the
  rule resolves (each named `harness`, directly under its XDG base) and still refuses anything else; `PROGRAM` (`bin`,
  `runtime`, `pty`), `cli` and the marker are found per root; `command.ts`'s copy names both folders.
- **Desktop** `core/harness_home.dart`: the rule. From PR 1's review: Desktop keeps one folder for the runtime and the
  CLI (`HarnessCliRunner.harnessHome`, `EnvironmentProvisioner.harnessHome`, one `Directory`), but on Linux `cli` is in
  the data root and `runtime` in the state root; both take the two roots, and the provisioner's Linux checks
  (`runtime/current-node` under `runtime/`, `cli/cli.js`) follow them. `environment_provisioner.dart:1213`
  (`harnessHome.parent`, the Windows profile) stays Windows-only. `app_state.dart:14889` builds a Claude profile folder
  for another machine's home, whose layout Desktop cannot see: it uses the path that machine's daemon reports, or
  `~/.harness/...` when there is none (the builder confirms which today and changes nothing else).
- **Rust:** `tui/src/harness_home.rs` (with `daemon.rs:50`'s `".harness/cli/data"` moved through it on Linux only,
  Windows bytes unchanged), `pty/src/harness_home.rs`, `device-app/src-tauri/src/harness_home.rs`: the rule.
- **Standalone:** `cli/hook/notify.mjs`'s `~/.harness` fallbacks (`cli`, `hook-routes`, `s`, `runtime/pty`) and
  `tui/src/shell_integration.sh`'s literal.
- **Installers:** `cli/scripts/install.sh` and `install-cli.sh` resolve the roots by the rule and lay `cli` and `bin`
  in the data root, `runtime` in the state root, `tui/first-run` in the data root. On a machine still on `~/.harness`
  they install there, and the daemon moves it at its next start. `install.ps1` is Windows: unchanged.
- **Harness OS:** `os/setup.py` reads `auth/session.json` and `computer-id` from the data root by the rule; Harness OS
  runs `harness start -f`, so its daemon moves an existing `~/.harness` at boot like any Linux machine.
- **Companions** (`companions/src/...`, `companions/scripts/memory-extraction-eval.ts`) and **store agents**
  (`store/agents/autonomous-grid`, `machine-monitor`, `harness-monitor`, `memories`, `vllm`, `ollama`, `mlx-lm`): the
  rule, inline, for the entries they read (data folder, `s/`, `lessons`, `grid-fleet`). An old one on a moved machine
  keeps working through the bridge while it runs; once the bridge is gone it finds nothing until it updates, so they
  ship with or before the CLI's release (Compatibility).
  `store/tools/runtimes.sh`, which 57 packages carry a copy of to find Harness's Node, gets the rule at its source and
  every copy is regenerated in this PR, so no package recreates `~/.harness/runtime` once the bridge is gone.
- **Developer and test tools** under `cli/scripts/`: the rule where they read the installed tree on Linux.

### Different XDG values in different processes

Each process reads `XDG_DATA_HOME` and `XDG_STATE_HOME` as it sees them. A person who sets them only in an
interactive shell's rc file gives Desktop (started from the desktop session) other roots than their shell. Harness
does not record the roots anywhere else: the release note and `docs/` say to set them for the whole session
(`~/.config/environment.d/`, `~/.profile`), and the systemd unit carries them when set (step 7). The move's log line
names both roots, so a mismatch is visible.

### Failures and state

The move writes a record, `home-move.json` in the state root (in `~/.harness` while not moved): `state` (`moved`,
`bridged`, `waiting`, `failed`, `skipped-override`), the reason's code (`update-pending`, `old-tmux`, `pty-host`, `target-exists`,
`no-space`, `permission`, `io`), counts (entries moved, bytes copied, panes retagged, old processes left), and times.
No path beyond the two roots, no names. It is written when the state or reason changes, not at each check.
`harness status` prints one line while it says `waiting` or `failed`, with what to do. Each outcome is one line in
`harness.log` (`home move: moved|waiting|failed <reason>`, `home bridge: removed`), at most once per start or change.

If both the data root and a `~/.harness` that is not the bridge exist (a person copied folders by hand, or an old build
recreated `~/.harness` after the bridge went), Harness uses the data root (rule 2) and logs once that `~/.harness` is no
longer read; it deletes nothing.

### Measures

The move record is the measure: its `state`, reason code and counts (no path, no names) are read from
`home-move.json` by the fleet scan tools. `harness status` has no JSON form and gets none. Nothing new is sent to the
backend.

### Accepted limits (release note)

- An `hn` started before the move refuses the linked `shell-requests` folder (`tui/src/shell_context.rs:507-510`): its
  shell context requests stop until it is opened again.
- A session whose working folder is inside the tree (a forked community project, `community/<k>/project`) loses its
  engine's resume and trust, which engines key by folder.

## Design (docs/feature-design-rules.md)

1. **Growth:** the move record is one small file, rewritten on change; the journal and the lock exist only during a
   move; the bridge (about 25 links, one route record, one socket link) exists until the last old process ends; staged
   copies go at finish or rollback.
2. **Concurrency:** the move lock, outside both trees, serialises moves; the spawn lock and the checks under the move
   lock keep a daemon from starting during it; a reader sees `~/.harness` whole until the commit (rule 3), then the XDG
   roots (rule 2); an old session's write goes through a link to the one real file, under that file's own lock (the
   hook's registry lock, the store's lock).
3. **Read cost:** one `stat` of the data root per resolution; the bridge check reads `/proc/<pid>/status` and `stat`
   for this account's processes every 10 minutes while a bridge exists, nothing after.
4. **Scale:** a move renames about 25 entries on one filesystem (milliseconds); a cross-filesystem copy is bounded by
   the tree's size, measured on the end-to-end box and reported in bytes and seconds.
5. **Compatibility:** an older CLI on a moved machine starts as a new, signed-out machine (release note). An older
   Desktop on Linux looks in `~/.harness`; while the bridge lasts it works through it; after, it finds no CLI and
   installs one into `~/.harness`; the new CLI it starts still resolves the XDG roots (rule 2), so it works, with a
   stray `~/.harness`. Order: Desktop, the companions and the store agents ship with or before the CLI that moves; the
   CLI's release is the switch.
6. **Migration and rollback:** the move is this design; its rollback is per step from the journal. A CLI rollback by
   the updater cannot follow a move (the move waits while an update awaits its verdict). No production data is
   involved.
7. **Audience:** nothing new is exposed; files keep their owner-only modes through rename and copy; the bridge's links
   and folders are the account's own, mode 700 where they are folders.
8. **Identity:** the move and the bridge run as the account that owns `~/.harness`, on its own home and its own
   processes only.
9. **Failure:** a failed move rolls back to a whole `~/.harness`, logs one line, and shows in `harness status`; a
   crash mid-way is finished or rolled back at the next start; a bridge service that dies is started again with the
   daemon, and the bridge stays until it can check.
10. **Platforms:** Linux only (including Harness OS). macOS and Windows: unchanged, tested unchanged.

## Tests

Test-first, at the layer where each behaviour lives:

- **The rule**, in each module (TypeScript, Dart, each Rust crate, `notify.mjs`, the shell integration, the
  installers, `os/setup.py`): fresh (neither exists) → XDG; legacy only → `~/.harness`; data root exists → XDG even
  with a `~/.harness` (the bridge or a stray one); `XDG_*` unset, empty or relative → default; custom absolute → used;
  macOS and Windows → `~/.harness` whatever exists.
- **The move:** fresh install (nothing to move); upgrade with data (every entry in its root, `auth` and `computer-id`
  byte for byte, modes kept, the bridge's links); each rewrite with its own assertion (launcher, systemd unit and
  reload, `current-node`, each JSON record, Claude plugin paths); panes retagged; each condition that holds it
  (update pending, override, old tmux) keeps it waiting with its reason and one log line; a failure injected at each
  step rolls back to the exact tree, outside files and pane tags; a crash at each step (journal left) is finished or
  rolled back by the next start; a rerun after success does nothing; cross-filesystem copy, with a write during the
  copy kept; custom `XDG_*_HOME`; overrides elsewhere still win after the move; an entry not in the table lands in data;
  a folder recreated at an old path mid-move is merged.
- **Old sessions after the move:** a hook command from before the move, run in a retagged pane and outside any pane,
  reaches the daemon (including a long home's short-folder socket); an old pane is adopted by the restarted daemon; an
  old session's writes (offline event, registry, Claude profile, inbox) land in the new place and nothing is written
  inside the bridge.
- **The bridge:** it stays while an old user runs (one case per kind: an engine by name, an executable in the old
  tree, Desktop, a retagged pane's descendant), not for an old process of another kind (a plain shell, the session
  manager) or a new one, and goes (links only, targets untouched) once none is left; its service reads no environment
  or command line; uninstall removes it without following a link.
- **After the move:** hooks rewritten to the new paths with Codex trusted (no "Hooks need review"); profile ids
  unchanged; a DSH workspace link into the old tree replaced; `harness tui` passes `ADAPTER_DATA_DIR` only when the
  person set it; uninstall's root check accepts the two XDG roots and refuses anything else; Desktop's runner and
  provisioner use the two roots on Linux.
- **The re-exec** from the old tree's paths to the new ones.
- **macOS and Windows unchanged:** PR 1's goldens and pins stay byte-identical with no fixture edits.

## Verification (end to end, before merge)

On Linux, isolated: a GitHub Linux runner or the docker boxes `machine-remote-1`/`-2`, a throwaway account home,
never production, never Ken's real apps or accounts.

- Install the release before this PR with `install.sh` into a throwaway home, start it against an isolated local or
  disposable backend with a test sign-in, note `computer-id`, start a Claude Code and a Codex agent in panes (the real
  engines or the e2e fake engines) and one outside any pane.
- Install this branch's build and start it with the agents running: `~/.harness` holds only the bridge, the roots hold
  the entries by label, still signed in, same computer id, the old agents' hooks still reach the daemon and their panes
  are adopted, `harness` and `hn` on `PATH` work, the systemd unit (when installed) starts the daemon from the new
  paths, a new Claude Code and Codex agent reports its hooks with no review prompt.
- End the old agents: the bridge goes at the service's next check, `~/.harness` is gone, while the shell the test runs
  in (started before the move) does not hold it.
- A fresh install on a clean home writes nothing to `~/.harness`.
- macOS and Windows: PR CI and the Windows workflows pass unchanged.

## Release note (Linux)

Harness now keeps its files in `~/.local/share/harness` and `~/.local/state/harness` (or `$XDG_DATA_HOME` and
`$XDG_STATE_HOME`). An existing `~/.harness` moves there the next time Harness starts; agents already running keep
working, and the few links left in `~/.harness` for them go within minutes of the last one ending. After the move, a Harness version older than this one starts as a new, signed-out computer. If you set
`XDG_DATA_HOME` or `XDG_STATE_HOME`, set them for your whole session (`~/.config/environment.d/` or `~/.profile`), not
only in your shell's rc file, so the app and the terminal find the same folders. An `hn` left open across the move
needs opening again for shell context, and agents in a forked community project start fresh sessions there.

## Left to the builder

- Names: the move module, the bridge service, the records' fields, the lock's exact name.
- The full inventory of files outside `~/.harness` and records inside it that name the old tree, of readers that might
  refuse a link, of places a live pane holds the tag, and of ids that hash a moved path.
- How each app re-checks the rule at each look without a hot-path cost.
- Whether `harnessd/platform.ts`'s fallback carries the rule inline or takes the data folder from its caller.
- Whether the bridge service runs in the edge host or alone.

## Changes after the final review (harness-pm, 2026-11-18)

These replace the text above where they differ.

- **The switch is a marker, not a folder.** The rule's step 2 reads "if the data root holds Harness's marker". The
  marker is written at the move's commit (into the staged data root, so it appears with the rename), by the installers
  on a fresh install, and by a start that resolves the XDG roots on a fresh machine. A `~/.local/share/harness` made by
  anything else, or by Desktop before the CLI is installed, switches nothing: with a `~/.harness` beside it the machine
  stays on `~/.harness`, and the move refuses with `target-exists` and a clear record, never losing `~/.harness`.
- **Sockets.** When the socket beside the data folder would be over 96 bytes, it goes to `$XDG_RUNTIME_DIR/harness/<hash>/`
  when that variable names an absolute folder owned by the account with mode 0700, else to `<state root>/s/<hash>/`.
  No home is left with TCP only.
- **The move lock** is `~/.harness.move-lock`, whatever the XDG variables say. A start waits while the holder (pid and
  start time) is alive and the data root has not appeared, logging one line; it never starts on a half-moved tree. A
  dead holder's lock is taken over, its journal finished or rolled back, and the start goes on. A rollback that cannot
  finish exits the start without starting a daemon.
- **The journal** appends one line per step; previous file bytes live in `~/.harness/.move-before/`. Copies across
  filesystems are flushed to disk before the originals and the journal go.
- **Overrides that hold the move** include `HARNESS_ENV_FILE` and `DOTENV_CONFIG_PATH`; the systemd unit's carried
  `Environment=` values inside the old tree are respelled to their new places. `XDG_DATA_HOME`/`XDG_STATE_HOME` are
  carried into the service definition on Linux only.
- **The Store is woken by the bridge service**, not the core: while harnesses wait to be set up again, the service asks
  for the Store through what the core offers every service. The core grows nothing.
- **A failed move is retried at once only for a person's `harness start` on a terminal**; Desktop's and systemd's
  starts wait an hour from the latest try.
- **A harness launched in the home folder** keeps its workspace runtime under `<state root>/runtime/<hash>` on a moved
  Linux machine.
- **Release order:** Desktop with or before the CLI; Desktop writes nothing that switches the rule before the CLI is
  installed.
- **Accepted, in the pull request:** Harness OS keeps the default folders (its daemon does not read the person's
  `XDG_*`); a linked DSH package whose venv uses uv's managed Python breaks once the bridge goes (developers only).

# Skill runs: an OpenClaw run whose tools die with it, and a harness that leaves nothing behind

Two asks from the lamp device (`lampos`), which runs short, private, bounded tasks for one script (a "skill run")
through `harness new`. Each run is held to its own namespace: no network but a model relay, a one-run credential, a
kill at its deadline, and a tmpfs engine home dropped on exit.

- **#4173.** OpenClaw's tools run inside the long-lived Gateway, not in the TUI Harness starts, so a run's tool calls
  happen outside the run's namespace, keep the Gateway's network, and can outlive the run's kill. Until fixed, the
  device refuses skill runs on OpenClaw.
- **#4174.** A run's words can name the owner's mail or calendar items. After the run, Harness keeps its saved screen,
  a copy of its conversation, its search-index rows, its recaps and its archived row on disk.

Platforms: macOS, Linux (the device), Windows. CLI and daemon only; no client, backend or wire change beyond the
daemon's own request fields.

## What the code does today (2026-11-12, main `c91d303249`)

- OpenClaw starts as `openclaw tui --session harness-<agentId>` (`OPENCLAW_LAUNCH`, `engines/openclaw/contract.ts`);
  a relaunch passes the full `agent:<id>:<key>` as a bare positional. The TUI gets the daemon's `OPENCLAW_STATE_DIR`
  and `OPENCLAW_HOME` (`engineLaunchEnv`), exported in the pane script after the rc files.
- `harness new` has no per-launch engine argument or environment.
- OpenClaw 2026.11.2 `tui --local` runs the whole agent runtime, tools included, inside the TUI process
  (`EmbeddedTuiBackend`). It takes a no-wait lock on its state folder and refuses to start if a Gateway owns that
  folder ("A Gateway is running for this state directory…") or another local TUI does. It refuses a positional session
  target; `--session <key>` is accepted. Its status line reads `starting local runtime`, `local ready | idle`,
  `⠏ running • 6s | local ready`, and `local runtime stopped: <reason>`. It writes sessions to the same layout,
  `<stateDir>/agents/<id>/agent/openclaw-agent.sqlite`. OpenClaw spawns tool children `detached: true` on POSIX (own
  session and process group).
- Harness's screen reading (`readOpenclawScreen`) knows `connected`/`reconnected` as ready; `local ready` reads as no
  state, so a first task would never be typed and a dead local runtime would say nothing.
- Stop (`lib/stopAgentService.ts`) signals the engine's pid, not its group, then `tmux kill-pane` (SIGHUP to the pane's
  processes). A child in its own session survives both.
- `harness close` checkpoints (saved screen, last 2000 lines; a copy of the native conversation), archives the row
  (`stopped-agents/<id>.json`, with `firstTask`), and keeps recaps (`summaries*.json`) and search rows
  (`session-search.db`, FTS5 with ask/answer text). The search service indexes live and stopped agents.
- The only removal is `agent_purge` (Desktop and phone "Delete Harness"; owner-only; inspect then delete). It stops
  the agent, erases the native conversation, the checkpoints, recaps, search rows, saved names, browser profile and the
  archived row. It leaves the agent-client ledger (`agent-client/started.jsonl`, which keeps the opening words of each
  `tell`) and the creation receipts (`agent-creations/`, which can hold the full request, task included). For OpenClaw
  it refuses everything ("This engine does not support verified history deletion yet."), so an OpenClaw harness cannot
  be deleted at all. A search row deleted while its native conversation is still on disk can be indexed again as an
  outside conversation; the guard against that is in memory and lost on a daemon restart. SQLite keeps deleted rows'
  bytes in free pages until they are reused.

## Goals

1. `harness new openclaw --local <folder>` starts OpenClaw with its runtime and tools in the process Harness started,
   on that state folder, and closing or deleting the harness ends that process and every process it started.
2. `harness delete <name>` erases everything Harness and the engine keep of a harness, running or closed, and says
   what it kept and why. The same deletion behind Desktop's "Delete Harness" stops leaving words behind and works for
   OpenClaw.

## Non-goals

- Seeding or removing the local folder. The device makes it (tmpfs), puts its config and one-run credential in it,
  and drops it. Harness never creates, copies a login into, or deletes it.
- A per-launch argument or environment passthrough for any engine, or `--local` for any other engine.
- A "don't save" mode on `new`. Deletion is one action, done when the caller asks (see "Why not `--no-save`").
- Desktop or phone UI for either. CLI and daemon only.
- Erasing OpenClaw's own store. It is OpenClaw's, possibly written by a live Gateway; Harness keeps it and says so. A
  local run's store lives in the device's folder and goes with it.

## Anti-goals

- A `--local` launch that silently runs on the shared Gateway (an older daemon, a missing folder, a restore after the
  folder was dropped). Fail out loud instead.
- A tool process of a closed or deleted harness still running.
- `delete` reporting success while words of the run remain in a Harness file.
- A second way to delete. `harness delete` is the CLI door to the existing purge, not a new eraser.

## Design

### `harness new openclaw --local <folder>` (#4173)

- **The option.** `--local <folder>` on `harness new`, OpenClaw only; any other engine is refused
  (`--local is for OpenClaw only.`). The CLI resolves the folder against its own working directory and refuses one that
  is not an existing directory (`<folder> is not a folder.`). Sent on `agent_create` as a new optional field and kept
  on the agent's registry row (carried through `openPendingAgent`, `load()`, `strictPersistedRow`, `register` and
  `resumePendingAgent`, so relaunch, restore and resume keep it; the archive copies the row).
- **Old daemons.** The CLI sends `--local` only to a daemon that says it understands it; otherwise it refuses
  (`This Harness daemon is too old for --local. Restart Harness.`). How the daemon says so is the builder's call (a
  version or capability the CLI already reads is preferred over a new round trip).
- **Launch.** `openclaw tui --local --session harness-<agentId>`; a relaunch, restore, fork or resume of a local row
  passes `--local --session <full key>` instead of the positional key. `OPENCLAW_STATE_DIR=<folder>` wins over the
  daemon's and the login shell's value (tmux `-e` and the pane script's export both carry it). The other OpenClaw path
  variables (`OPENCLAW_CONFIG_PATH`, `OPENCLAW_AGENT_DIR`, `OPENCLAW_OAUTH_DIR`, `OPENCLAW_WORKSPACE_DIR`) are unset in
  a local pane, so config, login and sessions all come from the folder and never from the owner's own setup (my call).
- **Fork.** A local row is not forked: `This run cannot be forked.` OpenClaw has no native fork (Harness forks it as a
  handoff into a new session while the source runs), and OpenClaw's lock refuses a second local TUI on the folder (my
  call). `firstPrompt` stays
  `typed`: the first task goes through the same session input, typed once the pane reads ready.
- **Store.** A local row's state folder is its `--local` folder from the start: the store reader uses it without the
  open-file lookup, on every platform (Windows included), and the bind pass never replaces it. The "cannot find this
  OpenClaw's sessions" hold therefore never fires on a local row before the folder is known.
- **Screen.** `local ready` (alone or after `|`) reads `ready`; `starting local runtime` reads `connecting`; a
  `running`/`streaming` line with `local ready` keeps reading as running. `local runtime stopped: <reason>` is a new
  hold: `OpenClaw's local run stopped: <reason>` (reason as OpenClaw printed it, trimmed to one line). OpenClaw shows
  that line for 5 s and then reads `local stopped | idle`; that footer keeps the same hold, with the last reason Harness
  saw, or `OpenClaw's local run stopped.` when it saw none. The hold does not close the harness; the caller or person
  does (my call). The Gateway holds (`no-gateway`, `no-token`, `remote`) never apply to a local row.
- **Folder already in use.** When the TUI exits because a Gateway or another local TUI holds the folder, the agent
  says `Another OpenClaw is using this folder. Give each run its own --local folder.`, not a bare exit. The builder picks
  the mechanism (the exit path reading the pane's last lines, or a launch failure), provided it is not silent.
- **Folder gone.** A relaunch or restore of a local row whose folder no longer exists does not start OpenClaw and
  never falls back to the shared state folder: it fails with `This run's OpenClaw folder is gone.`
- **Whole process tree ends on stop.** Stop (close, Stop Harness, delete, a parent's close) ends the engine's process
  and every descendant, including those that left its process group or session: before signalling, Harness lists the
  engine's descendants (bounded walk of the process table, one read), signals the engine and each distinct process
  group among them with SIGTERM, and SIGKILLs whatever is left after the existing grace. Every engine, not only
  OpenClaw: a tool left running after its harness closed is the same fault everywhere. On Windows the existing tree
  kill (`ptyHostBackend` process group, or the hidden-run tree kill) covers it; no window is ever opened. A descendant
  that already re-parented away before the list is out of reach; OpenClaw's own supervisor ends its children on a
  clean SIGTERM, which comes first.
- **Measures.** The launch measure carries whether it was local (no path). No new counters.

### `harness delete <name>` (#4174)

- **The command.** `harness delete <name> [--json]`: the CLI door to `agent_purge`. It runs inspect then delete with
  session data chosen and the worktree kept, stopping the harness first when it runs, and works on a closed (archived)
  harness too. No prompt: the command is the confirmation, as for `close`. Output lists what was erased and what was
  kept with its reason (`OpenClaw's store is kept: delete its session with OpenClaw.`). Errors are purge's own
  (Lead-protected, in progress, changed). There is no MCP tool for it. Called from inside an agent's pane, it deletes
  only a harness that agent started, as `close` allows (my call); the device's script is not an agent.
- **OpenClaw.** Purge of an OpenClaw harness erases everything Harness keeps and keeps OpenClaw's store, reporting it
  in a new response field (`kept: [{ what: 'engine-store', reason }]`; `historyKept` keeps its meaning, "session data
  not chosen"), instead of refusing. Desktop's "Delete Harness" then succeeds for OpenClaw too; showing the kept store
  there is a client follow-up, out of this change (my call).
- **Every session key.** Recaps and search rows are erased for every conversation the harness had (by its agent id),
  not only its current session id: a run that used `/new` leaves nothing under its earlier keys.
- **Words left behind.** Purge also erases:
  - its `Told` lines in the agent-client ledger (`started.jsonl`, `probe` holds the opening words of a `tell`).
    `Started` lines stay: they hold no words and keep `ps` "started by" and the parent's limits right. The ledger is
    append-only across processes, and an in-place rewrite once lost a line, so every ledger writer (append and this
    rewrite) takes one lock file with a bounded wait (no new dependency; works on Windows);
  - the stored request (task text) of the creation receipts whose outcome names the harness. The receipt itself stays,
    marked scrubbed, so a retried create still never launches twice (standard 6); its checksum covers the scrubbed form.
    Receipts of creates that never made this harness are not its records;
  - any other per-agent Harness file that holds its words or task. Counts that hold no words (token usage) may stay.
- **Search index.** The search database runs with `secure_delete` on, so erased turns do not stay in free pages, and
  a delete checkpoints its WAL. A deleted harness's conversation never re-enters the index while its native
  conversation is still on disk (OpenClaw's kept store), including after a daemon restart: the exclusion is persisted,
  keyed by the conversation, and dropped when that conversation is gone from disk (bounded by the existing sweep).
- **Why not `--no-save`.** A flag on `new` would be a second mode with its own paths in close, exit, index and
  recaps, and the device would still need deletion when it kills a run. `harness delete` at the end of every run,
  killed or not, covers both with the deletion Harness already has. While a run is live its words are on disk as for
  any harness; `delete` removes them. The device calls `harness delete` in its run teardown.

## Tests (red first)

- `parseNewArgs`: `--local <folder>` with openclaw sets the field; with another engine it is refused; a missing folder
  is refused; an old daemon is refused.
- Launch argv: a local row starts `openclaw tui --local --session harness-<id>`; a relaunch passes
  `--local --session <full key>`, no positional. The pane env and pane script carry the folder over a daemon and rc
  value.
- Row: the field survives `load()`, archive, restore and resume.
- Screen: `local ready | idle` → ready (first task typed); `starting local runtime` → connecting;
  `⠏ running • 6s | local ready` → running; `local runtime stopped: boom` → the new hold.
- Store: a local row reads its folder's database with no open-file read; no "cannot find sessions" hold.
- Folder gone on restore: fails with the copy above; nothing launched.
- Local fork refused; a local pane has the other OpenClaw path variables unset.
- Screen: `local stopped | idle` after `local runtime stopped: boom` keeps the hold with `boom`.
- Stop: an engine with a child in its own session (setsid) — after close the child is gone (real processes, macOS and
  Linux).
- `harness delete`: a running harness and a closed one are erased (checkpoint files, archive, recaps, search rows,
  `Told` ledger lines, receipt task text, recaps and search rows under an earlier session key); a concurrent ledger
  append during the rewrite is not lost; a retried create of a scrubbed receipt does not launch; an OpenClaw harness erases Harness's records and reports the kept store; a Lead is refused.
- Search: after delete, the erased text is absent from the database files (secure delete); after a daemon restart a
  kept OpenClaw conversation is not indexed again.
- End to end on this Mac with OpenClaw 2026.11.2 (isolated daemon, a scratch folder seeded by copying only a model
  config, never the real `~/.openclaw`): `harness new openclaw --local <folder> -- "<task that runs a sleep tool>"`,
  the task is typed and answered with no Gateway running; `harness close` kills the tool's process; `harness delete`
  leaves none of the task's words under the daemon's data folder.

## Data and design

- Growth: one optional folder path per OpenClaw row. Deletion removes records; the persisted index exclusion is one
  row per deleted conversation still on disk, dropped by the sweep once it is gone.
- Concurrency: the core owns the registry; purge keeps its job lock and archive reservation. The ledger is rewritten
  under its existing write path.
- Read cost: no new poll. The descendant walk runs once per stop.
- Scale: N/A, per agent on one machine.
- Compatibility: daemon and CLI ship together; the CLI refuses `--local` against an older daemon. `agent_purge` keeps
  its shape; OpenClaw moves from refused to erased-with-kept-store. Desktop and phone already show `historyKept`.
- Migration and rollback: none. Rolling back makes OpenClaw purge refuse again and `--local` rows relaunch on the shared
  Gateway, which the old CLI cannot ask for.
- Audience: purge stays owner-only, enforced by the daemon (a local CLI connection is the owner).
- Identity: unchanged; a local run uses the credential the device put in its folder.
- Failure: each fault above has a named state or error and a log line; no task text or path in telemetry.
- Platforms: macOS, Linux, Windows.

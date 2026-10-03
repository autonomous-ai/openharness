# Handoff: external sessions for every engine

**Completed in the continuation:** see [the commit audit and completion report](2026-09-27-external-engines-completion.md). The sections below preserve the state at the original handoff.

Continued from `external-engines` at `40f12db0` on branch `codex/external-engines`.
Rebased onto `93f148d6` (`origin/main`, including #391 and #392) without conflicts.
The original branch and worktree are preserved.

## What it is

⌘P and the welcome page already found Claude Code and Codex conversations that Harness did not start,
and could take one over from a terminal (#380, #385). This branch does the same for every engine that
keeps its conversations on this computer: Cursor, OpenCode, Kilo, Hermes, Devin, Pi, Command Code,
Muse, Grok, Antigravity and Copilot. Amp is left out: its threads are on its server.

The design, each engine's store and evidence, the edge cases and the test results are in
[the session search note](2026-09-26-session-search.md#every-engine). Read that first.

## Where the code is

- `cli/src/lib/sessionSearch/externals/`: one provider per engine (`scan`, `owners`, `busy`), with
  `types.ts`, `support.ts` (file, process and memo helpers) and `index.ts` (paths and the provider
  list). Every file has a spec beside it.
- `cli/src/lib/sessionSearch/external.ts`: `ExternalSessions` (one list), `OpenSessions` (who has a
  session open, as `terminal`, `app`, `harness` or `maybe`), `stopSessionOwner`.
- `cli/src/cli.ts`: `adoptableSession`, `heldBy`, `takeOverWhenIdle`, and the `onCreateAgent` resume
  path.
- `cli/src/lib/sqliteRead.ts`: an idle WAL store is opened `immutable=1`, so reading never creates
  `-wal`/`-shm` files in an engine's folder. Its cached handle is invalidated when the main file's
  size, modification time or change time moves, including a writer that opens and closes between scans.
- Index: `transcript.ts` (`lineTime`, `copilotOwnLine`, `museOwnStream`), `indexer.ts`
  (`historyPass` for database engines).
- Desktop: `swarm_search.dart` (`sessionUnavailable`), `take_over.dart`
  (`engineResumesWithMessage`), `take_over_dialog.dart`, `swarm_navigation.dart`
  (`externalEngineName`).

## Rules this code keeps

- Never write to an engine's store. Never log a scanned process's arguments (they can carry keys).
- Never stop a process on a guess. Only a record, a live lock, or a file held open counts. A process's
  arguments alone make the session `maybe`: refused, never stopped.
- `continue` is sent on *Take Over Now* only to engines that take a first message (Claude, Codex,
  OpenCode).

## State after continuation

Checked on macOS with Node 22.23.1, Flutter 3.47.2 and Dart 3.13.2:

- CLI: `npm run typecheck`, `npm run build`, and the full `npx vitest run` pass: **5,168 passed,
  63 skipped**, 304 passing files. Both `hookNotify` and `backendSocket.gridReads` passed this run;
  #390 remains a separate open PR.
- Focused CLI run: **556 tests in 29 files** pass, covering session search, SQLite reads, launch,
  resume, tmux, and the changed Hermes/Devin helpers. `external.ts` and all `externals/*.ts` have
  **100% statements, branches, functions and lines**, with no coverage ignores.
- Desktop: **3,682 passed, 12 skipped, 33 failed** in the complete suite. All 33 failures reproduced
  when their 13 files were run at clean `93f148d6`; the baseline also had one extra test-file load
  error. `flutter analyze` reports the same 18 diagnostics on both branches (one error, one warning,
  16 informational diagnostics), including the missing `WorkspaceBarControl.selection` getter in
  `grid_model_picker_test.dart`.
- The original timer question is resolved: `environment_recheck_timer_test.dart` loads on both
  `40f12db0` and `244cfe71` and fails the same assertion at line 163: expected `unauthenticated`,
  observed `bootstrapping`. The same failure occurs on current main. It is not introduced here.
- The five affected desktop search/take-over files pass all **31 tests**. A separate synthetic
  Grok dialog fixture also passed and supplied
  [the PR screenshot](../../.github/assets/external-engines/take-over-grok.png).
- Real tmux 3.5a checks, with a temporary home and an explicit isolated socket: **9 passed,
  9 skipped**. Discovery and process-only deletion passed for Claude, Codex, OpenCode, Pi, Hermes
  and Grok, including the installed Grok `agent` alias. Other engine binaries were unavailable.
- Real Herdr checks were attempted in a private isolated home: installed Herdr 0.9.1 speaks
  protocol 22, but Harness expects protocol 19. Setup rejects the connection, so none of its
  26 cases ran. The fixture servers were stopped; this is not a passing Herdr result.
- Earlier end-to-end evidence from the original handoff, through a sandboxed daemon: real stores
  read-only (229 sessions indexed, 210 of them
  external), then take-over with made-up stores and stand-in engines (Grok *Now* and *Wait*, OpenCode
  `maybe` refused, stale lock ignored). Results are in the session search note; this continuation
  did not rerun that live-store scan.

The 33 desktop failures shared with main are in these files:

| File under `desktop/test/` | Failures |
| --- | ---: |
| `workspace_account_lifecycle_test.dart` | 8 |
| `boot_flow_widget_test.dart` | 4 |
| `workspace_expiry_screen_test.dart` | 4 |
| `machines_manager_test.dart` | 4 |
| `terminal_panel_presentation_test.dart` | 4 |
| `signout_recovery_test.dart` | 2 |
| `orchestrator_test.dart` | 1 |
| `local_cli_discovery_test.dart` | 1 |
| `environment_setup_screen_test.dart` | 1 |
| `grid_model_picker_test.dart` | 1 (load error) |
| `open_picker_rendering_test.dart` | 1 |
| `first_workspace_test.dart` | 1 |
| `environment_recheck_timer_test.dart` | 1 |

## Fixes from the continuation

- **Refresh an idle SQLite snapshot after a complete write cycle.** A cached immutable reader
  previously kept returning old rows if the engine wrote, checkpointed and closed between scans.
  A real SQLite regression fails before the fix and passes for both the built-in reader and CLI
  fallback afterward; neither leaves WAL/SHM files beside the idle store.
- **Rebuild existing search content with schema 10.** The new Muse/Copilot filters and transcript
  timestamps must apply to conversations indexed before this branch. Reader and rebuild tests
  cover schemas 8 and 9 as well as an older schema.

## Handoff checklist — resolved

1. Rebased and merged the tested feature in #396; the six original patches are unchanged.
2. Reconciled #388 with schema 11 and merged it; merged the separate Hermes timeout fix #390.
3. Resolved the baseline desktop failures and all four engine bugs listed below.
4. The owner authorized merging and releasing in the continuation. See the completion report
   and the corresponding CLI/desktop GitHub releases for the final verification.

## Sandbox end-to-end recipe

Never run a test daemon or tmux against the person's real ones:

- `mkdir -p` the `TMUX_TMPDIR` folder first. tmux falls back to the real default server when it does
  not exist.
- Run with `env -u TMUX -u TMUX_PANE -u XDG_DATA_HOME -u XDG_CONFIG_HOME` and set `HOME=<sandbox>`,
  `PORT=<free port>`, `TMUX_TMPDIR=<folder>`, `ADAPTER_UPDATE_DISABLE=true`,
  `DISABLE_HOOK_INSTALL=true` and `DISABLE_GRID_INSTALL=true`.
- Point each engine's home at its store (read-only), or at a made-up one for take-over tests.
- Set `<ENGINE>_PATH` to a stand-in script that records its argv and forwards `--help`/`--version` to
  the real binary.
- Hold a session with a stand-in owner process in its own `tmux -S <socket>`.
- Afterwards, stop the sandbox daemon and kill both tmux servers. Check that no pane on the real
  server sits in the sandbox folder, and that no new `-wal`/`-shm` appeared in the engines' folders.

## Existing bugs recorded at handoff — fixed in the follow-up

- Cursor's config and data folders are one `CURSOR_HOME` in `discovery.ts`, `subagent.ts` and
  `oneshot.ts`.
- `OPENCODE_DATA_DIR` does not keep a recap out of the person's OpenCode store.
- The hook server and notifier treat a Hermes `tui` session as a sub-agent.
- Command Code's slug in Harness does not match the one Command Code writes.

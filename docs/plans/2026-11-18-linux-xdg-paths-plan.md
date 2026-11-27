# Harness follows the XDG Base Directory paths on Linux — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit. No task pushes or merges; every task ends green on the platform it can run on, and says in its report what only the Linux run can show.

**Goal:** On Linux, Harness keeps its data in `$XDG_DATA_HOME/harness` and its state in `$XDG_STATE_HOME/harness`; an existing `~/.harness` moves there once, at the next daemon start, and what started before the move keeps working through a bridge that removes itself.

**Architecture:**
- **One rule, in every language.** The path module of each language (PR 1) resolves two roots on Linux: XDG when the data root exists, else `~/.harness` when that exists, else XDG. macOS and Windows never run the rule.
- **The move is a module of its own** (`cli/src/homeMove/`), loaded by `entry.ts` for the start commands only, before `env.ts`. It stages each entry beside its root, leaves a link at the old path, rewrites what names the old tree, retags Harness's panes, commits with one rename and starts itself again from the new paths. A journal makes every step undoable and a crash recoverable.
- **The bridge is kept by a service** (`homeBridge`, in the edge host): it serves the few old paths a link cannot, looks every 10 minutes for a process that could still use an old path, and removes the bridge when none is left. The core and the master gain no rule for either.

**Tech Stack:** TypeScript (Node 22.15 or later, vitest) in `cli/`; Dart and Flutter test in `desktop/`; Rust (`cargo test`, std only) in `tui/` and `device-app/src-tauri/`; POSIX sh in the installers and the shell integration; Python in `os/`; plain Node modules in `store/`.

**Spec:** `docs/plans/2026-11-18-linux-xdg-paths-design.md`. Read it with this plan, PR 1's spec and plan (`docs/plans/2026-11-18-harness-paths-design.md`, `-plan.md`), the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core), `cli/src/harnessd/AGENTS.md`, `cli/src/services/AGENTS.md`, `desktop/CLAUDE.md`, `device-app/AGENTS.md`, `docs/validation-and-release.md` and `docs/feature-design-rules.md`.

**Open questions:** none. The draft's nine and the three that followed are answered (harness-pm, 2026-11-18) and are in Decided.

## Base

- This pull request builds on PR 1 (`chore/harness-paths`, not merged when this plan was written). The draft read its head `3879a5fd15`; this update read `36c304a3e7`, ten commits on (the Rust home guards, uninstall's `ROOT_NAME`, the guard spec). Work starts only after PR 1 is on `main` and `feat/linux-xdg-paths` is rebased onto it.
- File paths are as they are after PR 1 merges. Line numbers are PR 1's head. A task follows the expression it names when a line has moved, and says so in its report.
- Since `36c304a3e7`, `tui/src/harness_home.rs`, `pty/src/harness_home.rs` and `device-app/src-tauri/src/harness_home.rs` hold the same guard text from the test comment that begins "The guard: no home `.harness` path built by hand" on (only `ALLOWED` differs). `pty` is not changed here, so Tasks 9 and 11 put their code and tests above that comment and leave the guard text byte for byte.
- PR 1's temporary workflow (`.github/workflows/tmp-harness-paths.yml`) is gone by then. This plan adds its own.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 CLI: the root rule | `cli/src/config/harnessHome.ts`, `harnessHome.spec.ts`, `harnessHome.defaults.spec.ts`, `harnessHome.guard.spec.ts`; `cli/src/engines/launchArgv.golden.spec.ts`, `launchShapes.golden.spec.ts`, `dshLaunchShapes.golden.spec.ts`; `cli/src/lib/engineLaunch.spec.ts` | none | xhigh | `harnessHome.spec.ts` |
| 2 The temporary workflow | `.github/workflows/tmp-linux-xdg-paths.yml` (new) | none | medium | none: a temporary workflow, one commit |
| 3 CLI: the two literals PR 1 left | `cli/src/harnessd/platform.ts`, `platform.spec.ts`; `cli/src/lib/localSocket.ts`, `localSocket.spec.ts`; `cli/src/config/harnessHome.guard.spec.ts` | 1 | xhigh | `platform.spec.ts`, `localSocket.spec.ts` |
| 4 CLI: `harness tui` passes no data folder of its own | `cli/src/tui/index.ts`, `index.spec.ts` | none | high | `index.spec.ts` |
| 5 CLI: the systemd unit carries the XDG variables | `cli/src/lib/platformDaemon.ts`, `platformDaemon.spec.ts` | none | high | `platformDaemon.spec.ts` |
| 6 CLI: profile ids follow the folder | `cli/src/lib/claudeProfiles.test.ts` | 1 | medium | none: it pins what the code does once the folder moved, one commit |
| 7 CLI: a harness's workspace follows the move | `cli/src/dsh/runtime.ts`, `runtime.spec.ts` | 1 | xhigh | `runtime.spec.ts` |
| 8 The hook script follows the rule | `cli/hook/notify.mjs`, `cli/src/hookNotify.spec.ts` | none | xhigh | `hookNotify.spec.ts` |
| 9 hn follows the rule | `tui/src/harness_home.rs`, `daemon.rs`, `shell_integration.sh` | none | high | `harness_home.rs`'s tests |
| 10 hn's native fixtures | `tui/tests/harness_home.py` (new), `e2e.sh`, `mock-daemon.mjs`, `workspace-mock.mjs`, `fresh-user.py`, `welcome.py`, `local-first.py`, `workspace-controls.py`, `shell-integration.py`, `composer-machine.py` | 2, 9 | high | none: these are the tests; the workflow's `tui-native` job, red before |
| 11 Harness Device follows the rule | `device-app/src-tauri/src/harness_home.rs`, `cli.rs` | none | high | `harness_home.rs`'s tests |
| 12 Desktop: the module | `desktop/lib/core/harness_home.dart`, `harness_home_look_io.dart`, `harness_home_look_stub.dart` (new), `desktop/test/harness_home_test.dart` | none | high | `harness_home_test.dart` |
| 13 Desktop: the runner and the provisioner take two roots | `desktop/lib/core/harness_cli_runner.dart`, `lib/bootstrap/environment_provisioner.dart`, `lib/bootstrap/agent_prefetch.dart`, `lib/community/fork_project.dart`; `desktop/test/harness_cli_runner_test.dart`, `environment_provisioner_test.dart`, `agent_prefetch_test.dart`, `community_fork_test.dart` | 12 | xhigh | `harness_cli_runner_test.dart`, `environment_provisioner_test.dart`, `community_fork_test.dart` |
| 14 Desktop: lookups that kept a path | `desktop/lib/ws/local_cli_discovery.dart`, `local_daemon_transport.dart`, `lib/logging/log_file.dart`, `lib/state/app_state.dart`; `desktop/test/local_cli_discovery_test.dart`, `local_daemon_transport_test.dart`, `claude_account_folder_test.dart` (new) | 12 | high | `local_cli_discovery_test.dart`, `claude_account_folder_test.dart` |
| 15 Installers | `cli/scripts/install.sh`, `install-cli.sh`, `cli/src/scripts/install.spec.ts` | none | xhigh | `install.spec.ts` |
| 16 Harness OS setup | `os/setup.py`, `os/tests/test_setup.py` | none | high | `test_setup.py` |
| 17 Companions | `companions/scripts/memory-extraction-eval.ts`, `companions/src/companion/client.ts`, `companions/src/shared/harnessRoots.ts` (new), `harnessRoots.spec.ts` (new) | none | medium | `harnessRoots.spec.ts` |
| 18 Store: the shared daemon lookup | `store/tools/local-daemon.mjs`, `local-daemon.test.mjs`, `local-credential.mjs`, `local-credential.test.mjs`; `store/agents/autonomous-grid/lib/localDaemon.mjs`, `machine-monitor/lib/localDaemon.mjs`, `harness-monitor/lib/localDaemon.mjs`, `memories/lib/localDaemon.mjs` | none | high | `local-daemon.test.mjs` |
| 19 Store: autonomous-grid | `store/agents/autonomous-grid/lib/connect.mjs`, `harness.mjs`, `fleet.mjs`, `toolchain/grid.sh`, its `test/*.test.mjs` | 18 | high | its tests |
| 20 Store: the monitors | `store/agents/machine-monitor/lib/daemon.mjs`, `snapshot.mjs`; `store/agents/harness-monitor/lib/bridge.mjs`, `config.mjs`, `registry.mjs`; their `test/` | 18 | high | their tests |
| 21 Store: memories | `store/agents/memories/lib/agents.mjs`, `bridge.mjs`, its tests | 18 | high | its tests |
| 22 Store: local AI's Node lookup | `store/tools/local-ai/toolchain/node.sh`, `store/tools/local-ai/test/packaging.test.mjs`; `store/agents/vllm/toolchain/node.sh`, `ollama/toolchain/node.sh`, `mlx-lm/toolchain/node.sh` | none | medium | `packaging.test.mjs` |
| 23 CLI developer tools | `cli/scripts/benchmark-route.ts`, `orchestrator-e2e-peer.ts`, `remote-viewer-peer.ts` | 1 | medium | none: tools with no test, one commit |
| 24 Move: the plan and the conditions | `cli/src/homeMove/plan.ts`, `plan.spec.ts`, `conditions.ts`, `conditions.spec.ts` (new) | 1 | xhigh | both specs |
| 25 Move: lock, journal, records | `cli/src/homeMove/lock.ts`, `journal.ts`, `record.ts` and their specs (new) | 24 | xhigh | the three specs |
| 26 Move: stage, link, commit | `cli/src/homeMove/stage.ts`, `stage.spec.ts` (new) | 25 | xhigh | `stage.spec.ts` |
| 27 Move: what names the old tree, inside | `cli/src/homeMove/rewriteInside.ts`, `rewriteInside.spec.ts` (new) | 25 | xhigh | `rewriteInside.spec.ts` |
| 28 Move: what names the old tree, outside | `cli/src/homeMove/rewriteOutside.ts`, `rewriteOutside.spec.ts` (new) | 25 | xhigh | `rewriteOutside.spec.ts` |
| 29 Move: the panes | `cli/src/homeMove/panes.ts`, `panes.spec.ts`, `panes.real.spec.ts` (new) | 25 | xhigh | `panes.spec.ts` |
| 30 The bridge's layout | `cli/src/homeMove/bridge.ts`, `bridge.spec.ts` (new) | 24 | xhigh | `bridge.spec.ts` |
| 31 Move: the run | `cli/src/homeMove/move.ts`, `move.spec.ts` (new) | 26, 27, 28, 29, 30 | xhigh | `move.spec.ts` |
| 32 Move: the start commands and the re-exec | `cli/src/homeMove/start.ts`, `start.spec.ts`, `closure.spec.ts` (new); `cli/src/entry.ts` | 31 | xhigh | `start.spec.ts`, `closure.spec.ts` |
| 33 `harness status` says a held or failed move | `cli/src/homeMove/statusLine.ts`, `statusLine.spec.ts` (new); `cli/src/cli.ts` | 25 | high | `statusLine.spec.ts` |
| 34 Bridge: who still uses it | `cli/src/homeMove/oldUsers.ts`, `oldUsers.spec.ts` (new) | 30 | xhigh | `oldUsers.spec.ts` |
| 35 Bridge: the service | `cli/src/services/homeBridge.ts`, `homeBridge.spec.ts`, `homeBridgeProcess.ts`, `homeBridgeProcess.spec.ts` (new); `cli/src/services/inline.ts`, `inline.spec.ts`; `cli/src/serviceProcess.ts`; `cli/src/harnessd/services.ts`, `services.spec.ts`; `cli/src/core/main.ts`; `cli/AGENTS.md`, `cli/src/services/AGENTS.md` | 34, 43 | xhigh | `homeBridge.spec.ts`, `services.spec.ts` |
| 36 CLI: uninstall on two roots, and the bridge | `cli/src/lib/uninstall/removal.ts`, `command.ts`, `deps.ts`, `removal.spec.ts`, `command.spec.ts`; `cli/src/config/harnessHome.guard.spec.ts` | 3, 25, 30 | xhigh | `removal.spec.ts`, `command.spec.ts` |
| 37 After the move: the hooks | `cli/src/engines/hookInstallers.afterMove.spec.ts` (new) | 1 | high | none: it pins what the installers already do, one commit |
| 38 End to end: the move | `cli/e2e/homeMove.e2e.ts` (new), `cli/scripts/e2e/home-move-upgrade.sh` (new), `.github/workflows/tmp-linux-xdg-paths.yml` | 2, 8, 32, 35, 44 | xhigh | `homeMove.e2e.ts` |
| 39 CLI: existing specs on Linux | the candidates under Task 39 | 1, 2 | high | none: the workflow's `units` job names them, red before |
| 40 Desktop: existing tests on Linux | the candidates under Task 40 | 2, 12, 13, 14 | high | none: the workflow's `units` job names them, red before |
| 41 Docs and the release note | `docs/cli.md`, `docs/app.md`, `docs/development.md`, `cli/README.md`, `desktop/README.md`, `CHANGELOG.md` | none | medium | none: docs, one commit |
| 42 CLI: the agent browser's containers stay this daemon's | `cli/src/services/agentBrowser.ts`, `agentBrowser.spec.ts` | 1 | high | `agentBrowser.spec.ts` |
| 43 Store: harnesses set up again after the move | `cli/src/dsh/installed.ts`, `installed.spec.ts`, `cli/src/dsh/setupAgain.ts`, `setupAgain.spec.ts` (new); `cli/src/services/store.ts`, `store.spec.ts` | none | xhigh | `setupAgain.spec.ts`, `store.spec.ts` |
| 44 Store: a harness that needs setup says so, and an update sets it up again | `cli/src/dsh/wire.ts`, `wire.spec.ts`, `cli/src/dsh/command.ts`, `command.spec.ts`, `cli/src/dsh/update.ts`, `update.spec.ts` | 43 | high | `wire.spec.ts`, `command.spec.ts`, `update.spec.ts` |
| 45 Desktop: the Store shows Needs setup, with its Update button | `desktop/lib/core/dsh_catalog.dart`, `desktop/lib/store/store_screen.dart`, `desktop/test/store_page_test.dart` | none | high | `store_page_test.dart` |
| 46 Store: `runtimes.sh` follows the rule, every copy | `store/tools/runtimes.sh`, `store/tools/test_runtimes.py`; every copy `sync-runtimes.mjs` writes (`store/agents/*/toolchain/runtimes.sh`, `store/viewers/*/runtimes.sh`) | none | high | `test_runtimes.py` |
| 47 Store: Score's runtime and the hands-on tool | `store/agents/score/skills/score/scripts/lilypond.mjs`, `store/agents/score/test/installer.test.mjs`, `store/tools/try-hands-on.mjs` | 18 | medium | `installer.test.mjs` |
| 48 Remove the temporary workflow | `.github/workflows/tmp-linux-xdg-paths.yml` (deleted) | 1 to 47, and Verification 1 with its evidence recorded | medium | none: one commit |

Longest chain: eight tasks (1 → 24 → 25 → 26 → 31 → 32 → 38 → 48; 27 or 28 in place of 26 is as long).

- Tasks 1, 2, 4, 5, 8, 9, 11, 12, 15, 16, 17, 18, 22, 41, 43, 45 and 46 share no file and start at once.
- Tasks 35, 42 and 43 each end with `npm run test:core`, and share no file.
- Files shared by two tasks are shared only along a dependency: the CLI guard spec (1 → 3 → 36), the workflow file (2 → 38 → 48), the four `localDaemon.mjs` copies (18, then 19 to 21 import them without editing them), `store/tools/local-daemon.mjs` (18, then 47 imports it), `dsh/installed.ts` (43, then 35 imports it without editing it).
- Task 46 regenerates every `runtimes.sh` copy and no other task names one; Tasks 19 to 22 edit other files in the same packages.
- Tasks 39 and 40 edit only spec files no other task names. A spec another task owns gets its Linux expectations in that task.
- Tasks 10, 39 and 40 need the branch pushed once after the tasks they depend on: the main session pushes, the workflow runs, and the task reads its job. Task 48 is started by the main session.

## Layers

| Files | Process | Gate |
|---|---|---|
| `config/harnessHome.ts`, `lib/localSocket.ts` | **The core's process**, and every other CLI process | `src/architecture.spec.ts` (no new line in `architecture.coreFiles.txt`), their specs, the goldens; locally `npm run test:core` |
| `core/main.ts` (one wiring line), `services/homeBridge*.ts`, `services/inline.ts` | The core's wiring; the edge host | `npm run test:core` (100% per file) |
| `harnessd/platform.ts`, `harnessd/services.ts` | **The master** | `npm run test:harnessd` (100% per file); `src/architecture.spec.ts` |
| `homeMove/**`, `entry.ts` | The start commands, before `env.ts` loads; the service and uninstall import `bridge.ts`, `oldUsers.ts`, `record.ts`, `lock.ts`. The move imports the core file `engines/kit/homeAdoption.ts` (it does not edit it) | `homeMove/closure.spec.ts` (Task 32); never imported by the core, never by `harnessd/` |
| `dsh/runtime.ts` | CLI and the viewers' process | `npm run test:portability` |
| `dsh/installed.ts`, `dsh/setupAgain.ts`, `dsh/wire.ts`, `dsh/command.ts`, `dsh/update.ts`, `services/store.ts` | The Store's process (the core's when there is no master); the CLI | their specs; locally `npm run test:core` (it selects `services/`) and `npm run test:portability` |
| `store/**` | Each package's own scripts, alone on a machine | each package's tests; `node store/tools/sync-runtimes.mjs --check` and `cli/src/dsh/store.spec.ts` |
| `hook/notify.mjs` | Every engine's hook, standalone | `hookNotify.spec.ts`, `hookAdmission.golden.spec.ts`, the end-to-end suite |
| `desktop/lib/**` | The desktop app | `desktop-tests` in PR CI; `make desktop-test` on a Mac; the Windows desktop workflow |
| `tui/src/**`, `device-app/src-tauri/src/**` | `hn`, the menu-bar app | `cargo test` in PR CI (Linux); the Windows workflow for `tui`; `cargo test` for the Device app on a Mac |

## Before starting

- CLI: `cd cli && npm ci` once. Desktop: Flutter 3.47 or later, `flutter config --enable-swift-package-manager` once, `cd desktop && flutter pub get`. Device app: `cd device-app/ui && npm ci && npm run build` before `cargo test` there.
- Every command below runs from the folder it names. A shell keeps nothing between an agent's commands.
- **A Mac cannot run the Linux rule for real.** Each module takes its platform, its environment and its existence check as parameters, so every new test names `linux` and runs anywhere. What only a Linux run shows (an existing spec that read a default path, the fixtures, the end-to-end move) is the temporary workflow's (Task 2).

## Global Constraints

- **Linux only.** On macOS and Windows no rule runs and nothing changes: every path, hook command, launcher, golden file and installer byte is today's. `cli/src/engines/__fixtures__/`, `cli/src/lib/__fixtures__/`, `cli/scripts/install.ps1` and every Windows-only file are not edited: `git diff --stat "$(git merge-base HEAD origin/main)" -- cli/src/engines/__fixtures__ cli/src/lib/__fixtures__ cli/scripts/install.ps1 cli/src/lib/windows pty` prints nothing.
- **The roots.** `data = $XDG_DATA_HOME/harness`, default `~/.local/share/harness`; `state = $XDG_STATE_HOME/harness`, default `~/.local/state/harness`. A variable that is unset, empty or not an absolute path is ignored. No config root, no cache root.
- **The rule**, the same everywhere: the data root exists → the XDG roots; else `~/.harness` exists → both roots are `~/.harness`; else the XDG roots.
- **Overrides still win** (`ADAPTER_DATA_DIR`, `ADAPTER_CLI_DIR`, `ADAPTER_RUNTIME_DIR`, `HARNESS_AUTH_DIR`, `HARNESS_CONNECTIONS_DIR`, `HARNESS_HOOK_ROUTES_DIR`, `HARNESS_LOGS_DIR`, `HARNESS_PTY_DIR`, `HARNESS_DEVICES_DIR`, `HARNESS_AGENT_MESSAGES_DIR`, `HARNESS_FLASHER_CACHE`, `DSH_DIR`, `ADAPTER_COMPUTER_ID_FILE`, and each package's own): only the default behind each changes.
- **The core and the master gain no rule, list or record** for the move or the bridge. `config/harnessHome.ts` gains the root rule and nothing else, importing `node:os`, `node:path` and `existsSync` from `node:fs`. `core/main.ts` gains the one line every service has for the no-master run.
- **The move's code loads nothing that resolved a path.** `cli/src/homeMove/` imports Node, `config/harnessHome.ts`, `lib/harnessSessionLabel.ts` (itself Node only: the pane tag has one definition), `engines/kit/homeAdoption.ts` (its exports `readAdoptedHomes` and `createHomeAdopter`, to reseal `engine-homes.json`) and its own folder. Never `config/env.ts`. At PR 1's head `36c304a3e7`, `homeAdoption.ts` reaches only Node and seven modules that import Node or each other and resolve no path when they load: `engines/kit/homeCatalog.ts`, `identityScan.ts`, `nativeEvidence.ts`, `windowsFiles.ts`, `hookHeld.ts`, `lib/childLocale.ts`, `lib/secureState.ts` (`homedir()` only inside functions). Task 32's closure spec holds the move to that list.
- **No process reads another's environment or command line.** The bridge's check reads a process's owner, start time, name, executable and parent, nothing else.
- **Nothing is written into the bridge** but what the bridge service puts in its two real folders. Removing the bridge removes links and those folders, never what a link points to.
- **No secret, path of the person's or name in a record or a log line** beyond the two roots and the name of an entry the table does not know.
- **No quoted path of another component** (`scripts/ci-plan.py` reads one as a dependency): join segments one at a time, name other components in comments only.
- **No new dependency**, no lockfile change.
- **Platforms the pull request names:** Linux changes (Harness OS included); macOS and Windows unchanged, tested unchanged.

## Review Focus

1. **An XDG folder with a space, a `$`, a quote or a backtick in it.** The launch prelude writes the state root into shell text between double quotes. It must come out as that one folder. Task 1 (`the prelude's text is one folder for any state root`).
2. **A crash between the two commit renames** (the state root in place, the data root not). The next start must roll forward or back to a whole tree, never run on half. Task 31 (`a crash after the state root's rename`).
3. **A hook that fires mid-move** and recreates a real folder at an old path. Its write must end in the moved entry, and the link must still go in. Task 26 (`a folder recreated at an old path is merged`).
4. **Two starts at once** (the desktop app and a shell, or systemd and a person). One moves, the other waits for the lock and then finds the roots moved. Task 25 (`a second start waits, then sees the lock gone`), Task 32 (`a start that waited resolves the roots again`).
5. **An XDG base that cannot be written** (`~/.local/state` owned by root, a full disk). The move fails before it changes anything it cannot undo, `~/.harness` is whole, and `harness status` says so. Task 31 (`an unwritable base fails with permission and leaves the tree as it was`).

## Decided

Decided before this plan (not reopened):

- Linux only; two roots; the root rule; approach D (move at the next daemon start, bridge the old paths).
- The move runs in `entry.ts` for `start`, `start -f`, `start --if-down` and `__harnessd`, before `env.ts`, then re-executes from the new paths (`process.execve`). It waits only for: an update awaiting its verdict, the move lock, an override that names a folder inside `~/.harness`, and tmux before 3.0 with a pane that carries the old tag.
- The bridge: one symlink per moved entry; a real `hook-routes` folder with the daemon's route record; a hard link to the daemon's socket in a short folder for long homes.
- The move retags Harness's panes (`tmux set-option -p @harness_daemon <new tag>`). The core gains no alias rule.
- The bridge service runs in a process of its own, only while `bridge.json` exists, checks at its start and every 10 minutes, and reads only owner, start time, name, executable and parent.
- `harness tui` passes `ADAPTER_DATA_DIR` only when the person set it. Claude Code's plugin paths inside moved profiles are rewritten. Desktop does not move its own store. XDG values that differ between processes are accepted and documented; the systemd unit carries them.
- Uninstall accepts exactly the two XDG roots and refuses anything else. Desktop's runner and provisioner take the two roots.
- A downgrade after the move is a signed-out new machine: release note only.

Answered by harness-pm, 2026-11-18 (the draft's open questions):

1. **`engine-homes.json`:** the move rewrites it and seals it again through `homeAdoption.ts`'s own exports, one import beyond Node. That file's imports load nothing the move must not (Global Constraints). Task 27.
2. **Harness packages:** after the move the Store runs each installed package's setup again, two at a time. A package whose setup fails is marked `needs-setup`, with one log line and a state where the Store lists it, and counts as done. The bridge waits until every package is done or `needs-setup`. Tasks 43 to 45, 35 and 27 (the mark).
3. **`store/tools/runtimes.sh`:** the rule goes in the shared source and every copy is regenerated in this pull request. Task 46. The two other store readers the draft found (Score's LilyPond runtime, the hands-on tool) follow the spec's goal that nothing keeps a `~/.harness` of its own. Task 47.
4. **Profile ids follow the new folder** (replacing "ids stay"). The move converts every id it finds stored. The inventory below finds no stored profile id: every reader computes it from a folder, and the move rewrites the folders. Desktop computes the id from the folder the daemon reports (`usage_account_key.dart:29`), so Desktop does not change. Task 6 pins it.
5. **An `hn` from before the move** refuses the linked `shell-requests`: accepted, release note (Task 41).
6. **Sessions in `community/<k>/project`** lose their engine's resume and trust: accepted, release note (Task 41).
7. **No `harness status --json`.** The fleet scan reads `home-move.json`. `harness status` prints one line only (Task 33).
8. **A `~/.harness` that is itself a link** is not moved: `skipped-override`, logged (Tasks 24, 32).
9. **`pty/src/harness_home.rs`** is not changed.

The planner's own calls below were approved with the answers.

Decided here, where the spec left it to the builder:

- **Names.** The move: `cli/src/homeMove/`. The service: `homeBridge`. The lock: `<state root>.move-lock` (a folder holding `owner`, the pid). The journal: `~/.harness/.move.json`. The move record: `home-move.json`. The bridge record: `<state root>/bridge.json`. Staged trees: `<data root>.moving`, `<state root>.moving`.
- **The table gains `memory` (data) and `monitor` (state).** The store's Memories and harness-monitor agents build them under the home (`store/agents/memories/lib/agents.mjs:54`, `store/agents/harness-monitor/lib/config.mjs:28`); PR 1's spec names both as candidates and its inventory did not read `store/`.
- **The master's fallback takes the caller's folder.** `harnessd/platform.ts:507` is read only by the Task Scheduler paths (`:510-516`, `:545`), and both callers pass the data folder (`lib/platformDaemon.ts:95`, `lib/nodeReferences.ts:28`). The literal goes; a Task Scheduler service built without a data folder throws.
- **The bridge service runs in the edge host**, as a service the apps ask nothing (`hachi` is the one to copy). Where the core runs with no master (Harness OS, `HARNESSD_SERVICES=none`) it starts through `services/inline.ts` like every service.
- **How each app re-checks the rule.** The CLI and the daemon resolve once at start: a move never runs under a daemon, and the process that moved starts again. Desktop, `hn` and the Device app resolve at each look, one `stat` of the data root (and one of `~/.harness` when it is absent); nothing is cached.
- **Overrides in the environment file count.** `config/loadEnv.ts` reads `HARNESS_ENV_FILE` (or `DOTENV_CONFIG_PATH`) after the move would have run, so the override check reads that file too, with `node:util`'s `parseEnv`; a variable already in the environment wins, as in `loadEnv.ts`.
- **Every start of this build passes the move lock first**, so two moves never run together. The move checks that the spawn lock is free and no daemon answers; it does not take the spawn lock.
- **A live PTY host holds the move.** A Linux machine that set `TERMINAL_BACKENDS=ptyhost` has panes whose tag lives in the running host (`lib/ptyHostBackend.ts:611`, `:652-660`) and cannot be changed. The move waits while such a host runs, reason `pty-host`, as it does for tmux before 3.0.
- **`connections` is the bridge's second real folder.** An MCP shim that an old agent runs checks that the folder holding the bridge socket is a real folder (`lib/connectors/mcpShimSource.ts:48-56`), and that folder is the entry itself. The bridge keeps a real `~/.harness/connections` holding hard links to `bridge.sock` and `mcp-shim.mjs`.
- **One rule for every socket an old client looks for.** Where an old client computes a socket's place from the old folder and that is not where the socket is now, the bridge service keeps a hard link there. This covers the spec's long home, a home where the old path fitted beside the data folder and the new one does not, and the connections bridge's socket. A link across filesystems is impossible: logged once, no link.
- **The bridge check leaves out the service's own ancestors.** A master that systemd started moves and re-executes in place: it keeps its start time, and its executable is in the new roots. It runs from the new paths.
- **The outcome line** is appended to the data folder's `harness.log`, in its place after the outcome; a start on a terminal also prints it.
- **A failed move is tried again** at once by `harness start` typed by a person (no `--if-down`, not `__harnessd`), and by the others once an hour has passed since `failedAt`.
- **Golden files keep their bytes on Linux CI.** The three launch golden specs make their throwaway home a legacy one (`<home>/.harness` exists), so the prelude's text is `$HOME/.harness/…` on every platform. The XDG text is asserted in `engineLaunch.spec.ts`.
- **The agent browser's containers keep their label.** The default data folder is labelled by its old spelling, so a browser from before the move stays this daemon's (Task 42; answer 11 below).
- **USER_HZ is 100.** `/proc/<pid>/stat`'s start time is in clock ticks, 100 a second on every Linux ABI.
- **`engine-homes.json` is sealed again by setting its pool aside.** Its sealed pool (`.adoptions/`, `.adopted`, `.confirmations/`) is append-only, chained by digests, and its records only add homes. The move rewrites the plain catalog `engine-homes.json` like any record, renames the three pool names aside (`<name>.before-move`), and lets `createHomeAdopter(file).adopt(<every home, moved>)` write a new pool of one sealed record. Rollback removes the new pool and renames the old one back; the finish deletes it. A home outside the tree keeps its path. With no pool on disk, only the catalog is rewritten.
- **Which packages are set up again.** The move marks every `dsh/installed.json` record that is not `linked` with `setup: 'pending'` (a linked package's files are in a checkout outside the tree). The Store clears the mark when the setup ran, even if the doctor then complains (the doctor's answer is shown as today), and writes `needs-setup` when the setup failed or the package no longer loads. A package another process holds (`lockDsh`) stays pending for the Store's next start. Two at a time: `SETUP_AGAIN_AT_ONCE = 2`.
- **What a setup run again rebuilds.** `harness_venv` keeps a venv only when its Python runs (`runtimes.sh:137-145`), and through the bridge it does. After Task 46, a venv whose `pyvenv.cfg` or `bin/pip` first line names `$HOME/.harness/` while the runtime is elsewhere is made again. A package's own skip checks are its own and are not changed.
- **The state the Store shows** is the status line's copy `Needs setup`, in place of `Installed`, on the package's page, for an installed package whose row says `needsSetup: true`; the page's `Update` button shows for it. `harness dsh list` ends that row with `· needs setup`. The tile grid says nothing new. No new UI element, no new request (answer 10 below).

Answered by harness-pm, 2026-11-18 (the three questions this plan's first update raised):

10. **A harness that says Needs setup is set up again through the existing update path** (option c). `harness dsh update <pkg>` does not return early for a package marked `needs-setup`, even when it is up to date, so its setup runs again; an update that commits writes the record without its mark. The Store's existing `Update` button shows on the package's page for a marked package and sends the existing `dsh_update`. No new button, no new request. The state shows on the package's page and in `harness dsh list`, not in the tile grid. Tasks 44 and 45.
11. **The agent browser's container label keeps its old spelling** (option a). Task 42 as drafted.
12. **A forked community project's `node_modules` link** into the old `dsh` folder is replaced by Desktop's `prepareRuntime` with one to the new place (Task 13). **The orchestrator's prompt files** (`ORCHESTRATOR.md`, `ORCHESTRATOR_TASK.md`) naming Node and `cli.js` by path are accepted, with no task: new agents get the new paths at launch, and a running one is an engine process, so it holds the bridge.

Not changed, and why:

- `pty/src/harness_home.rs`: answer 9. On Linux the host is handed its folder by the daemon (`--home`); its module's callers are Windows only.
- `cli/scripts/install.ps1`, `lib/windows/*`, `lib/platformDaemon.ts:122,218`, `masterProcess.ts:248`, `services/updaterProcess.ts:76-79`: the Windows layout.
- `lib/launchers.ts:142`: `ownedBinEntries` already takes the runtime's root from its caller (`lib/uninstall/deps.ts:107`). The managed tmux and its link are macOS only (`cli/scripts/install.sh:433-449`).
- `LEGACY_SCRIPT` (`engines/kit/notifyHooks.ts:271`): it names what old installs wrote.
- `desktop/lib/bootstrap/environment_provisioner.dart:1216` (`harnessHome.parent`): Windows only.
- `cli/docker/remote-machine/Dockerfile:87-88`: its `ADAPTER_DATA_DIR` is inside `~/.harness`, so those boxes never move. Nothing to change; the end-to-end checks do not use them.

## The inventory

What the spec left to the builder. Line numbers are PR 1's head.

**Files outside `~/.harness` that name the old tree**

| Where | What it holds | Who puts it right |
|---|---|---|
| `~/.local/bin/harness` (`cli/scripts/install.sh:730`, `install-cli.sh:176-188`) | `exec '<node>' '<cli.js>' "$@"` | The move (Task 28). `ensureLauncher` (`lib/launchers.ts:32-40`) only rewrites a launcher that already names the current `cli.js`. |
| `~/.local/bin/hn`, forms of releases #365 to #500 (`lib/launchers.ts:128-131`, `tui/launcher.ts:41-55`) | `exec <node> <cli.js> tui "$@"`, or a link to `bin/harness-tui` | The move (Task 28). Today's form names only the launcher. |
| `harnessd.service` (`harnessd/platform.ts:196-198`, `:217-218`) | `ExecStart`, `StandardOutput`, `StandardError` | The move, then `daemon-reload` (Task 28). `write` and `repointNode` need `ownedBy` to match the new log path (`:583-593`, `:626`, `:647`). |
| Hook commands in each engine's settings (`engines/kit/notifyHooks.ts:169-202`), Codex's `trusted_hash` and `rules/harness.rules`, the Agent Messages hook (`messagesHook.ts:105-108`), the OpenCode, Kilo, Pi and Amp plugins (`nativeHooks.ts:38-41`) | The managed Node, `notify.mjs`, `--data-dir` | The core, at each start (`core/main.ts:3398`); a profile's home at each launch on it (`nativeLaunch.ts:274`). Pinned by Task 37. |
| MCP entries (`lib/connectors/agents.ts:353-354`) | Node, `connections/mcp-shim.mjs`, the bridge socket | The connectors service, at its start; a running shim is served by the bridge (Task 30). |
| `<workspace>/.harness/runtime/<hash>/skills/<name>` and `runtime.json` (`dsh/runtime.ts:187-194`, `:219`) | Links and paths into `dsh` | The next launch in that workspace (Task 7). |
| `<project>/node_modules` link of a forked community project (`desktop/lib/community/fork_project.dart:432-451`) | A link into `dsh/autonomous/godogen` | Desktop's `prepareRuntime`, at the project's next open, replaces a link into the old `dsh` with one to the new place (Task 13; answer 12). |
| `ORCHESTRATOR.md`, `ORCHESTRATOR_TASK.md` in a project (`orchestrator/service.ts:206`, `:269`) | Node and `cli.js` | Nobody: accepted (answer 12). Written once per run (`wx`); new agents get the new paths at launch, and a running one is an engine process, so it holds the bridge. |
| A pane's environment, start command and shell (`PATH`, `ZDOTDIR`, `BROWSER`, `CLAUDE_CONFIG_DIR`, `HARNESS_DSH_DIR`, `_HN_CLI`) | Old paths, for the pane's life | The bridge. |

No `~/.harness` path is written to a shell rc file (`install.sh:177-205` adds `~/.local/bin` only), git config, an autostart file or the `.desktop` file.

**Records inside the tree that name it**

| Record | Writer | Who puts it right |
|---|---|---|
| `runtime/current-node`, `current-grid` (files holding a path) | `install.sh:698`, `:319`; `lib/runtimeInstall.ts:275` | The move (Task 27). |
| `cli/data/registry.json`, `stopped-agents/*.json` (`claudeHome`, `transcriptPath`, `cwd`) | `lib/registry.ts:486`, `lib/stoppedAgents.ts:29` | The move (Task 27). |
| `cli/data/claude-profiles.json`, `codex-profiles.json` | `lib/claudeProfiles.ts:24` | The move (Task 27). |
| `dsh/installed.json` (`dir`) | `dsh/installed.ts:84-88` | The move rewrites `dir` and marks each package that is not linked `setup: 'pending'` (Task 27). What its setup built (venvs, launchers, uv and micromamba environments) is built again by the Store (Task 43). |
| `cli/data/dial-setup.json`, `dial-skill.json` (`homes`), `node-migration.json` (`node`) | `dialSkillFiles.ts:178`, `:224`; `nodeMigration.ts:47` | The move (Task 27). |
| `pty/run/pty-host-*.json` (`endpoint`) | `pty/src/cli.rs:331` | None: a live host holds the move. |
| `cli/data/engine-homes.json` and its `.adoptions/`, `.adopted`, `.confirmations/` | `engines/kit/homeAdoption.ts:168-342` | The move: the catalog rewritten, the sealed pool set aside and sealed again through `createHomeAdopter` (Task 27). |
| `hook-routes/<tag>.json` | `lib/hookRoutes.ts:18-25` | The daemon publishes under its new tag at each start; the old record is stale and harmless. |
| `connections/projections.json` (keys) | `lib/connectors/agents.ts:377` | The connectors service, at its start. |
| `cli/data/bin/harness-browser` | `browserShim.ts:44` | The core, at each start (`core/main.ts:1239`). |
| Inside a moved Claude profile: `plugins/installed_plugins.json` (`installPath`), `plugins/known_marketplaces.json` (`installLocation`) | Claude Code | The move (Task 27). `settings.json`'s hook command and `.claude.json`'s MCP entries are rewritten at the next launch on the profile. |

**Readers that refuse a link**

| Reader | What it refuses | What the bridge does |
|---|---|---|
| `hook/notify.mjs:1036-1037` (`secureStateDirectory`, `:726-744`) | `hook-routes` opened with `O_NOFOLLOW` | A real folder with the route record (decided). |
| `lib/connectors/mcpShimSource.ts:48-56`, `lib/localTransport.ts:111-118`, `lib/connectors/store.ts:80-87` | `connections` must be a real folder | A real folder with hard links (Task 30). The store's own readers are new processes on the new path. |
| `lib/shellContextReply.ts:16-20`, `tui/src/shell_context.rs:507-510`, `shell_picker.rs:138-147` | `shell-requests` must be a real folder | Nothing: the entry is a link like the others. An `hn` from before the move has no shell context until it is opened again (accepted, release note). |
| `lib/localSocket.ts:122-132` (`prepareShortFolder`) | `s` must be a real folder, under a folder named `.harness` | The daemon makes its short folder under the state root (Task 3); old clients reach a hard link through the `s` link. |
| `dsh/runtime.ts:34-45` | A link in `<workspace>/.harness/runtime`, which is the `runtime` entry when the workspace is the home | None: only a launch whose workspace is `$HOME`, from an old process. |
| Lexical checks: `lib/nodeRuntime.ts:29`, `lib/selfUpdate.ts:538`, `harnessd/processName.ts:72-82`, `harnessd/platform.ts:583-592`, `lib/claudeHomes.ts:151-153`, `desktop/lib/bootstrap/environment_provisioner.dart:1473-1475`, `desktop/lib/core/harness_cli_runner.dart:272-274` | A stored path that does not start with the folder as now spelled | The move rewrites the stored side (Tasks 27, 28). |
| Everything under `cli/data` opened with `O_NOFOLLOW` (`lib/secureState.ts:102-139`, `notify.mjs:791`, `:1628`), every socket check (`notify.mjs:304-310`, `store/tools/local-daemon.mjs`, `desktop/lib/ws/local_daemon_transport.dart:202-206`) | A link as the last part | Nothing: the link is a middle part. |

**Where a live pane holds the tag**

| Place | Writer | What the move does |
|---|---|---|
| The pane option `@harness_daemon`, tmux 3.0 or later (`lib/tmuxBackend.ts:286-316`) | at `new-session` | Retags (Task 29). A format reads the window's value too, and setting the pane's own wins. |
| The pane's start command `/usr/bin/env HARNESS_DAEMON=<tag>`, tmux before 3.0 (`lib/harnessSessionLabel.ts:46-54`, `tmuxBackend.ts:293`) | at create | Cannot change: the move waits (`old-tmux`). |
| A held pane's respawn command (`lib/nativePaneHold.ts:20-38`) | at hold | Nothing: from tmux 3.0 the tag is read from the option alone. |
| A PTY host's panes (`lib/ptyHostBackend.ts:611`, `pty/src/panes.rs:121`) | at create | Cannot change: the move waits (`pty-host`). |

**Ids that hash or embed a moved path**

| Id | Input | What happens |
|---|---|---|
| The pane tag (`lib/harnessSessionLabel.ts:93-95`, `notify.mjs:943-948`) | the data folder's real path | Changes; panes are retagged. |
| The short socket folder (`lib/localSocket.ts:59-61`, `notify.mjs:319`, `store/tools/local-daemon.mjs:37`, `desktop/lib/ws/local_daemon_transport.dart:62-65`) | the folder as given; used when the socket's path is over 96 bytes | Changes; the bridge links the old place (Task 30). |
| A profile's id (`lib/claudeHomes.ts:41-57`, `services/models.ts:433`, `lib/claudeProfiles.ts:54-69`) | machine, engine, the folder's real path (Codex: the path as linked) | Follows the folder: the move rewrites every stored folder (Task 27), and Desktop computes the same id from the folder the daemon reports (`desktop/lib/usage/usage_account_key.dart:29`). No store holds an id: the CLI's records (`registry.json`, `stopped-agents`, `claude-profiles.json`, `codex-profiles.json`) keep folders; Desktop's saved launch setup keeps a Codex profile's folder (`desktop/lib/core/launch_setup.dart:44-49`) and `machine_profile_v1` a machine id; the mobile app and the backend's schema hold none. Pinned by Task 6. |
| The quota cache's file (`quotaReports.ts:39-43`, `hook/statusline.mjs:84-89`) | the real path of `CLAUDE_CONFIG_DIR` | Changes; a cache, written again. |
| An engine's own project folder for a workspace inside the tree (`community/<k>/project`) | the workspace's path | Not converted: the engine's files, not Harness's. Accepted, release note. |
| A browser container's label (`services/agentBrowser.ts:103-106`, used by `agentBrowser/containers.ts:64`, `:209-216` and `events.ts:26`, `:36`) | the data folder as given | Kept: the default folder is labelled by its old spelling (Task 42; answer 11). A Podman label cannot be rewritten in place. |

---

### Task 1: CLI: the root rule

**Files:**
- Modify: `cli/src/config/harnessHome.ts`
- Test: `cli/src/config/harnessHome.spec.ts`, `harnessHome.defaults.spec.ts`, `harnessHome.guard.spec.ts`; `cli/src/engines/launchArgv.golden.spec.ts`, `launchShapes.golden.spec.ts`, `dshLaunchShapes.golden.spec.ts`; `cli/src/lib/engineLaunch.spec.ts`

**Depends on:** none. **Effort:** xhigh (a core file; every default path on Linux follows it).

**Interfaces:**
- Produces:
  ```ts
  /** What the rule reads of this computer: the XDG variables and one existence check. */
  export interface HomeLook { env: Readonly<Record<string, string | undefined>>; exists(path: string): boolean }
  /** The two XDG places for [home], whether or not Harness uses them. */
  export function xdgRoots(home: string, env: HomeLook['env']): { data: string; state: string }
  /** `<home>/.harness`, whatever the rule says: where Harness kept everything before. */
  export function legacyHarnessHome(home?: string, platform?: NodeJS.Platform): string
  export function legacyHarnessPath(entry: HarnessEntry, home?: string, platform?: NodeJS.Platform): string
  export function harnessRoot(kind: HarnessRootKind, home?: string, platform?: NodeJS.Platform, look?: HomeLook): string
  export function harnessRoots(home?: string, platform?: NodeJS.Platform, look?: HomeLook): string[]
  export function harnessPath(entry: HarnessEntry, home?: string, platform?: NodeJS.Platform, look?: HomeLook): string
  /** [home] is the text to write for the home (`$HOME`); [realHome] the folder the rule is run for. */
  export function harnessPathText(entry: HarnessEntry, home?: string, platform?: NodeJS.Platform, look?: HomeLook, realHome?: string): string
  ```
  `look` defaults to `{ env: process.env, exists: existsSync }`, `realHome` to `homedir()`. Every existing call keeps its arguments. `HARNESS_ENTRIES` gains `memory: 'data'` and `monitor: 'state'`.

- [ ] **Step 1: Write the failing tests** in `harnessHome.spec.ts`, each with `platform` and `look` passed, so they run on any computer:
  - `fresh: neither folder exists → the XDG roots`: `harnessRoot('data', '/h', 'linux', look())` is `/h/.local/share/harness`, state `/h/.local/state/harness`, `harnessRoots` both, data first.
  - `legacy only → both roots are ~/.harness`: with `/h/.harness` existing, both are `/h/.harness`, `harnessRoots` one.
  - `the data root exists → XDG, whatever is at ~/.harness`: with both existing, the XDG roots.
  - `an XDG variable that is unset, empty or relative is ignored`: `''`, `'share'`, `undefined` each give the default; `XDG_DATA_HOME=/d`, `XDG_STATE_HOME=/s` give `/d/harness`, `/s/harness`.
  - `every entry goes to the root its label names`: on a fresh Linux look, each of the 26 entries is `<its root>/<entry>`.
  - `macOS and Windows never run the rule`: with a look whose `exists` throws, `'darwin'` and `'win32'` give `<home>/.harness` (`C:\Users\me\.harness`), for every entry.
  - `the legacy helpers ignore the rule`: `legacyHarnessPath('dsh', '/h', 'linux')` is `/h/.harness/dsh`.
  - `the prelude's text`: with a look for the process's home, legacy → `$HOME/.harness/run`; moved, default XDG → `$HOME/.local/state/harness/run`; on `darwin` → `$HOME/.harness/run`.
  - `the prelude's text is one folder for any state root`: an `XDG_STATE_HOME` whose name holds a space, `$x`, a double quote, a backslash and a backtick gives text that, between double quotes in `sh`, is that folder (the test runs `sh -c 'printf %s "<text>"'` and compares).
  - `the table is the spec's` gains `memory` and `monitor`; `loads nothing but node:os, node:path and node:fs`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/config/harnessHome.spec.ts`. Expected: FAIL (`xdgRoots is not a function`, and the Linux cases give `/h/.harness`).
- [ ] **Step 3: Implement the rule.** `ROOTS` becomes one function of `(kind, home, platform, look)`: off Linux, `homeFolder`; on Linux, `xdgRoots(home, look.env)` and the three-line rule. `harnessPathText` resolves the root for the process's home (`homedir()`), writes `${home}` in place of that home when the root is under it, and otherwise the absolute root with `\`, `"`, `$` and `` ` `` escaped for double quotes. Nothing is cached.
- [ ] **Step 4: Keep the pins and the goldens.** `harnessHome.defaults.spec.ts` pins macOS and Windows as it does, by naming the platform, and gains the same defaults for a fresh and a legacy Linux home. The three launch golden specs create `<HOME>/.harness` in the throwaway home before they build a launch (one `beforeAll` each), so their bytes are the same on every platform; no fixture is edited. `engineLaunch.spec.ts` gains `the prelude names the state root on a moved Linux home`. The guard's allowlist reasons that say "listed for PR 2" are reworded; no entry is added.
- [ ] **Step 5: Run** `npx vitest run src/config src/engines/launchArgv.golden.spec.ts src/engines/launchShapes.golden.spec.ts src/engines/dshLaunchShapes.golden.spec.ts src/lib/engineLaunch.spec.ts src/architecture.spec.ts` and `npm run typecheck`. Expected: PASS, with `git diff --stat -- src/engines/__fixtures__` empty.
- [ ] **Step 6: Commit** `CLI: on Linux the home module resolves the XDG roots`.

### Task 2: The temporary workflow

**Files:** Create `.github/workflows/tmp-linux-xdg-paths.yml`.

**Depends on:** none. **Effort:** medium. **No red test:** a temporary workflow, one commit. Task 48 removes it before the merge.

- [ ] **Step 1: Write the workflow.** `name: tmp linux-xdg-paths`; a first comment `# TEMPORARY: removed before the merge (docs/plans/2026-11-18-linux-xdg-paths-plan.md, Task 48).`; `on: push: branches: [feat/linux-xdg-paths]`; `permissions: contents: read`; `concurrency: { group: tmp-linux-xdg-paths, cancel-in-progress: true }`. No secret, no cache write, nothing published or written outside the run. Two jobs, both `ubuntu-latest`, Node `24.22.2` (the pin of `release-tui.yml` and `windows.yml`):
  - `units`: a matrix of four CLI shards (`npm ci`, then `npx vitest run --config vitest.ci.config.ts --shard=${{ matrix.shard }}/4` in `cli/`) and one leg each for `desktop` (the release's Flutter pin, `python3 scripts/test-desktop.py` as `desktop-tests` runs it), `tui` and `device-app/src-tauri` (`cargo test --locked`, the Device app after `npm ci && npm run build` in `device-app/ui` and Tauri's Linux packages as `ci.yml` installs them). `fail-fast: false`; each leg uploads its report for seven days.
  - `tui-native`: as PR 1's job was (build `hn` with `cargo build --locked --release`, the `reference-tmux` action, `python3 scripts/validate-tui-native.py tui/target/release/harness-tui`), uploading `.harness/validation/`.
- [ ] **Step 2: Check it** with `actionlint .github/workflows/tmp-linux-xdg-paths.yml`. Expected: no output.
- [ ] **Step 3: Commit** `ci: a temporary workflow for the Linux paths (removed before the merge)`.

### Task 3: CLI: the two literals PR 1 left

**Files:**
- Modify: `cli/src/harnessd/platform.ts:494-508`, `cli/src/lib/localSocket.ts:122-132`
- Test: `cli/src/harnessd/platform.spec.ts`, `cli/src/lib/localSocket.spec.ts`, `cli/src/config/harnessHome.guard.spec.ts`

**Depends on:** 1 (the guard spec). **Effort:** xhigh (the master; the daemon's socket).

- [ ] **Step 1: Write the failing tests.**
  - `platform.spec.ts`: `a Task Scheduler service needs its data folder`: `new PlatformService('taskscheduler', depsWithoutDataDir)` throws `Task Scheduler needs the daemon's data folder`; every existing Task Scheduler case passes one.
  - `localSocket.spec.ts`: `a short folder under the state root is made private`: `listenLocalSocket` on `<tmp>/harness/s/<16 hex>/daemon-1.sock` creates the folder with mode 700 and listens; `a short folder whose parent is a link is refused` for both `.harness/s` and `harness/s`.
- [ ] **Step 2: Run** `npx vitest run src/harnessd/platform.spec.ts src/lib/localSocket.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `PlatformService`'s constructor throws for `taskscheduler` with no `deps.dataDir`, and the getter returns it: the `.harness` literal and its `join` go. `prepareShortFolder`'s shape becomes a folder named `<16 hex>` in `s` in a folder named `.harness` or `harness`. In the guard spec, the `harnessd/platform.ts` entry is deleted and the `lib/localSocket.ts` entry names the new line.
- [ ] **Step 4: Run** the two specs, `src/config/harnessHome.guard.spec.ts`, `src/architecture.spec.ts` and `npm run test:harnessd`. Expected: PASS, 100% per file.
- [ ] **Step 5: Commit** `CLI: the master takes its data folder, and a short socket folder may sit in the state root`.

### Task 4: CLI: `harness tui` passes no data folder of its own

**Files:** Modify `cli/src/tui/index.ts:85-141`. Test: `cli/src/tui/index.spec.ts`.

**Depends on:** none. **Effort:** high.

- [ ] **Step 1: Write the failing tests:** `the daemon hn starts gets no ADAPTER_DATA_DIR the person did not set` (with the variable unset, the environment `runSelf` passes has none, and neither has `hn`'s own); `a data folder the person set is passed on` (set, both carry it); `hn still finds the daemon in the default folder` (`daemonUp` is asked with `<harnessPath('cli')>/data`).
- [ ] **Step 2: Run** `npx vitest run src/tui/index.spec.ts`. Expected: FAIL on the first.
- [ ] **Step 3: Implement.** `runSelf` and the `hn` spawn spread `ADAPTER_DATA_DIR` only when `opts.dataDir` or the environment gave one; the folder used to look for the daemon is computed as today.
- [ ] **Step 4: Run** the spec. Expected: PASS. Its Linux expectations are this task's (the `units` job).
- [ ] **Step 5: Commit** `hn starts the daemon without naming its data folder`.

### Task 5: CLI: the systemd unit carries the XDG variables

**Files:** Modify `cli/src/lib/platformDaemon.ts:42`. Test: `cli/src/lib/platformDaemon.spec.ts`.

**Depends on:** none. **Effort:** high.

- [ ] **Step 1: Write the failing test:** `the definition carries XDG_DATA_HOME and XDG_STATE_HOME when they are set`: `serviceDefinition({ logFile, source: { XDG_DATA_HOME: '/d', XDG_STATE_HOME: '/s' } }).env` holds both; unset or empty, neither.
- [ ] **Step 2: Run** `npx vitest run src/lib/platformDaemon.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement:** add the two names to `CARRIED_ENV`, with one comment line on why (a daemon systemd starts must find the roots the person's shell finds).
- [ ] **Step 4: Run** the spec and `src/harnessd/platform.spec.ts`. Expected: PASS. The launchd plist carries them too when set; on a Mac they change no path.
- [ ] **Step 5: Commit** `The service definition carries the XDG data and state folders`.

### Task 6: CLI: profile ids follow the folder

**Files:** Test: `cli/src/lib/claudeProfiles.test.ts` (the file that tests `claudeHomes.ts`). No production file: `profileFor` already hashes the folder's real path.

**Depends on:** 1 (a moved Linux look). **Effort:** medium. **No red test:** it pins what the code does once the folder has moved; one commit. A stored profile id the search in Step 1 finds is a finding for the report: its conversion goes into Task 27, and the main session amends that task before it starts.

- [ ] **Step 1: Search again** at the rebased head for a profile id kept anywhere: `git grep -n "profileId\|swarmProfileId\|profile.*\.id\b" -- cli/src desktop/lib mobile/lib backend/src store ':!*.spec.ts' ':!*_test.dart' ':!*.test.*'`, reading each hit that writes to a file, a preference or the backend. The plan's inventory found none (Ids that hash or embed a moved path); the report says whether that still holds.
- [ ] **Step 2: Write the tests:** `a profile in the moved folder takes the id of its new folder`: for home `/h` on a moved Linux look, a profile at `/h/.local/share/harness/claude-profiles/2` has `profileId(m, 'claude', '/h/.local/share/harness/claude-profiles/2')`, and that is the vector `swarmProfileId` gives for the same machine, engine and folder (written out in the test, as `desktop/test/usage_account_key_test.dart` pins its own); `the default profile's id does not change`; `macOS hashes the real path as before`.
- [ ] **Step 3: Run** `npx vitest run src/lib/claudeProfiles.test.ts`. Expected: PASS.
- [ ] **Step 4: Commit** `test(cli): a Claude profile's id follows Harness's folder`.

### Task 7: CLI: a harness's workspace follows the move

**Files:** Modify `cli/src/dsh/runtime.ts:160-200`. Test: `cli/src/dsh/runtime.spec.ts`.

**Depends on:** 1. **Effort:** xhigh (it rewrites a workspace's saved runtime).

- [ ] **Step 1: Write the failing tests**, on a moved Linux look with `DSH_DIR` at its default:
  - `a skill link into the old dsh folder is replaced`: a link `<ws>/.harness/runtime/<key>/skills/x` → `/h/.harness/dsh/a/skills/x` becomes a link to `<data root>/dsh/a/skills/x`, and the launch succeeds.
  - `a link to anywhere else is still refused` with `Harness skill path is already occupied`.
  - `a saved runtime that names the old dsh folder is read at its new place`: a `runtime.json` whose `skills[].dir` and environment values start with `/h/.harness/dsh/` launches with the old folder absent, and is saved with the new paths.
  - `nothing changes where the folder never moved` (macOS, a legacy Linux home, a custom `DSH_DIR`).
- [ ] **Step 2: Run** `npx vitest run src/dsh/runtime.spec.ts`. Expected: FAIL on the first and third.
- [ ] **Step 3: Implement** one helper `movedDshPath(path)`: a string that starts with `legacyHarnessPath('dsh') + sep` becomes the same tail under `env.DSH_DIR`, when `DSH_DIR` is the module's default and differs from the legacy path; any other string is itself. It is applied to a loaded snapshot's `skills[].dir`, environment values and arguments, and to a link's target before the "already occupied" comparison; a link that pointed into the old folder is replaced.
- [ ] **Step 4: Run** the spec and `npm run test:portability`. Expected: PASS at its thresholds.
- [ ] **Step 5: Commit** `A harness's workspace follows Harness's folder to its new place`.

### Task 8: The hook script follows the rule

**Files:** Modify `cli/hook/notify.mjs:145-147`, `:316-320`, `:1012-1014`. Test: `cli/src/hookNotify.spec.ts`.

**Depends on:** none. **Effort:** xhigh (every engine's hook; it carries the daemon's credential).

- [ ] **Step 1: Write the failing tests**, each running the script in a throwaway home under the spec's own preload that sets `process.platform` (as its `nativeProcess` and Windows cases do, `hookNotify.spec.ts:188-189`), so the Linux cases run on any computer:
  - `on a moved Linux home the fallbacks are under the XDG roots`: no `--data-dir` → `<data>/cli/data`; routes → `<state>/hook-routes`; a long data folder's socket → `<state>/s/<hash>/…`.
  - `on a legacy Linux home, on macOS and on Windows they are under ~/.harness`, byte for byte as before.
  - `XDG variables unset, empty or relative give the defaults; absolute ones are used`.
  - `an old command reaches a moved daemon`: with `--data-dir <home>/.harness/cli/data` resolving through a `cli` link, the credential is read, the pane tag is the new folder's, and the event is posted on the socket beside the new data folder.
  - `HARNESS_HOOK_ROUTES_DIR and ADAPTER_DATA_DIR still win`.
- [ ] **Step 2: Run** `npx vitest run src/hookNotify.spec.ts`. Expected: FAIL on the first.
- [ ] **Step 3: Implement** one inline function `harnessRoots()` (the rule, read from `process.platform`, `process.env` and `existsSync`; no import beyond Node) used by the three fallbacks. `ADAPTER_RUNTIME_DIR`'s fallback (`:1251`) is read on Windows only and keeps its text.
- [ ] **Step 4: Run** `npx vitest run src/hookNotify.spec.ts src/engines/hookAdmission.golden.spec.ts src/architecture.environment.spec.ts`. Expected: PASS. The script's bytes change; Codex's `trusted_hash` covers the hook command's text, which does not (`engines/kit/hookReview.ts:49-56`).
- [ ] **Step 5: Commit** `The hook script finds Harness's folders by the rule`.

### Task 9: hn follows the rule

**Files:** Modify `tui/src/harness_home.rs`, `tui/src/daemon.rs:47-52`, `tui/src/shell_integration.sh:69`.

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces: `pub struct Look<'a> { pub linux: bool, pub env: &'a dyn Fn(&str) -> Option<OsString>, pub exists: &'a dyn Fn(&Path) -> bool }`; `pub fn harness_root_with(home: &Path, root: Root, look: &Look) -> PathBuf`; `harness_root` and `harness_path` keep their signatures and use the process's look (`cfg!(target_os = "linux")`, `std::env::var_os`, `Path::exists`). `Entry` gains `Cli` (data).

- [ ] **Step 1: Write the failing tests** in `harness_home.rs`: `fresh_linux_is_xdg`, `legacy_linux_is_dot_harness`, `the_data_root_wins_over_a_bridge`, `an_unset_empty_or_relative_variable_is_ignored`, `a_custom_absolute_variable_is_used`, `off_linux_the_rule_is_not_run` (a look whose `exists` panics, `linux: false`), and, on Unix, `the_shell_function_gives_the_same_folder`: the lines of `shell_integration.sh` between `# >>> harness state root` and `# <<< harness state root` define `_hn_state_root`; the test runs them with `sh` under each home above and compares with `harness_root_with`.
- [ ] **Step 2: Run** `cd tui && cargo test --locked harness_home`. Expected: FAIL (no `Look`).
- [ ] **Step 3: Implement.** The rule in `harness_root_with`. `daemon.rs`'s `socket_path` takes `harness_path(home, Entry::Cli)` and joins `data` on Linux (`#[cfg(target_os = "linux")]`); every other platform keeps its line byte for byte. `shell_integration.sh` gains the POSIX function between its two markers and `_hn_dir` uses it; off Linux (`uname -s`) it gives `$HOME/.harness`. The guard keeps the script and the `daemon.rs` literal on its allowlist, each with its new reason. The new code and tests go above the guard's comment ("The guard: no home…"); from there on the text stays byte for byte `pty`'s (`diff <(sed -n '/The guard: no home/,$p' tui/src/harness_home.rs) <(sed -n '/The guard: no home/,$p' pty/src/harness_home.rs)` prints nothing).
- [ ] **Step 4: Run** `cargo test --locked` in `tui/`. Expected: PASS.
- [ ] **Step 5: Commit** `hn finds Harness's folders by the rule on Linux`.

### Task 10: hn's native fixtures

**Files:** Create `tui/tests/harness_home.py`. Modify `tui/tests/e2e.sh`, `mock-daemon.mjs`, `workspace-mock.mjs`, `fresh-user.py`, `welcome.py`, `local-first.py`, `workspace-controls.py`, `shell-integration.py`, `composer-machine.py`.

**Depends on:** 2, 9. **Effort:** high. **No red test:** these are the tests. Their red run is the `tui-native` job on the first push after Task 9.

- [ ] **Step 1: Read the job's failures** (the run of the push that holds Task 9). A fixture not red there is not edited.
- [ ] **Step 2: Add `tui/tests/harness_home.py`**: `roots(home, env) -> (data, state)`, the rule in Python, and `path(home, env, entry)`. Each failing fixture builds and reads its home through it, so it lays out what a fresh Linux install has; the mocks keep taking their data folder from `ADAPTER_DATA_DIR`.
- [ ] **Step 3: Add one case** to `fresh-user.py`: a home that holds only `.harness` is still read there.
- [ ] **Step 4: Run** `python3 scripts/validate-tui-native.py <hn>` on a Mac (the `.harness` layout). The Linux run is the job on the next push: every fixture passes.
- [ ] **Step 5: Commit** `test(tui): the native fixtures lay out the folders the rule gives`.

### Task 11: Harness Device follows the rule

**Files:** Modify `device-app/src-tauri/src/harness_home.rs`, `cli.rs:80-90` (only if a call needs the look).

**Depends on:** none. **Effort:** high.

- [ ] **Step 1: Write the failing tests** in `harness_home.rs`, as Task 9's first six, plus `the_cli_is_in_data_and_the_runtime_in_state` (`harness_path_with(home, Entry::Cli, look)` is `<data>/cli`, `Entry::Runtime` is `<state>/runtime`).
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --locked --lib harness_home`. Expected: FAIL.
- [ ] **Step 3: Implement** `Look`, `harness_root_with`, `harness_path_with` as in Task 9; `harness_root` and `harness_path` use the process's look. `find_cli` runs at each command (`cli.rs:215`), so a move is followed at the app's next look with no cache to clear. As in Task 9, everything new sits above the guard's comment, and the guard text from there on stays byte for byte `pty`'s.
- [ ] **Step 4: Run** `cargo test --locked --lib`. Expected: PASS, the guard with it.
- [ ] **Step 5: Commit** `Harness Device finds the CLI by the rule on Linux`.

### Task 12: Desktop: the module

**Files:** Modify `desktop/lib/core/harness_home.dart`. Create `desktop/lib/core/harness_home_look_io.dart`, `harness_home_look_stub.dart`. Test: `desktop/test/harness_home_test.dart`.

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces:
  ```dart
  final class HomeLook { const HomeLook({required this.linux, required this.environment, required this.exists}); … }
  HarnessHome.of(String home, {HarnessJoin join, HomeLook? look})   // the rule; `look` defaults to this platform's
  const HarnessHome.at(String root, {HarnessJoin join})             // both roots at one folder
  const HarnessHome.roots({required String data, required String state, HarnessJoin join})
  String root(HarnessRootKind kind);  String path(HarnessEntry entry);  String legacyPath(HarnessEntry entry)
  ```
  `HarnessEntry` gains `memory` (data) and `monitor` (state). The default look comes through a conditional import: the `io` file reads `Platform.isLinux`, `Platform.environment` and `FileSystemEntity.typeSync`; the stub (the web build) is never Linux.

- [ ] **Step 1: Write the failing tests**: the six cases of Task 1's rule with an explicit `HomeLook`; `every entry goes to the root its label names`; `off Linux the look is not asked`; `at() and roots() ignore the rule`; `the table is the CLI's` (26 entries, compared name by name with the list written out in the test).
- [ ] **Step 2: Run** `cd desktop && flutter test test/harness_home_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.** `of` resolves at construction; nothing is cached beyond the object. The module still imports only `package:path` and the look.
- [ ] **Step 4: Run** `flutter test test/harness_home_test.dart test/harness_home_guard_test.dart` and `flutter analyze lib/core`. Expected: PASS, no issue.
- [ ] **Step 5: Commit** `Desktop: on Linux the home module resolves the XDG roots`.

### Task 13: Desktop: the runner and the provisioner take two roots

**Files:** Modify `desktop/lib/core/harness_cli_runner.dart:82-126`, `:179`, `:272-290`; `desktop/lib/bootstrap/environment_provisioner.dart:503-555`, `:1465-1501`, `:1548`, `:1679`, `:1749`; `desktop/lib/bootstrap/agent_prefetch.dart:69-72`, `:434-481`; `desktop/lib/community/fork_project.dart:54`, `:432-451` (`prepareRuntime`). Test: `desktop/test/harness_cli_runner_test.dart`, `environment_provisioner_test.dart`, `agent_prefetch_test.dart`, `community_fork_test.dart`.

**Depends on:** 12. **Effort:** xhigh (first-run setup decides whether Harness is installed).

- [ ] **Step 1: Write the failing tests**, on a Linux look: `the runner finds cli.js in the data root and the node in the state root`; `current-node must name a file under the state root's runtime`; `the provisioner reports Harness installed from the two roots`; `on a legacy home both come from ~/.harness`; `a home handed in by a test is both roots` (`HarnessHome.at`); `a fork's project is under the data root's community folder`. In `community_fork_test.dart`, beside `godogen links the modules its store entry installed`: `a node_modules link into the old dsh folder is replaced with one to the new place` (a runner on `HarnessHome.of(<tmp home>, look: <Linux, data root exists>)`; the project's `node_modules` is a link to `<tmp home>/.harness/dsh/autonomous/godogen/node_modules`; after `prepareRuntime` it targets `<data root>/dsh/autonomous/godogen/node_modules`); `a link elsewhere, or a real folder, is kept` (target and bytes as before); `on a legacy home the link is kept`.
- [ ] **Step 2: Run** the four test files. Expected: FAIL on the split cases and the replaced link.
- [ ] **Step 3: Implement.** `HarnessCliRunner` and `EnvironmentProvisioner` hold a `HarnessHome` in place of one `Directory`, resolved at each use for the default and fixed when a test hands one in; `cli`, `bin`, `dsh` and `community` come from the data root, `runtime`, `run` and `logs` from the state root. The Windows branches (`windows_layout.dart`, `harnessHome.parent`) take the data root, which on Windows is the one folder. `prepareRuntime`: when `node_modules` is a link whose target starts with the runner's `legacyPath(HarnessEntry.dsh)` plus a separator, and that differs from `path(HarnessEntry.dsh)`, the link is deleted and made again to the same tail under `path(HarnessEntry.dsh)` (the existence check on the new target as today); anything else there is left, as today. It runs at each open of a stopped or new fork (`community/fork_controller.dart:85`), so a moved project heals at its next open.
- [ ] **Step 4: Run** the four files and `test/harness_cli_runner_windows_test.dart`. Expected: PASS, the Windows file with no edit.
- [ ] **Step 5: Commit** `Desktop: the CLI runner and first-run setup read two roots on Linux, and a fork's tools follow the move`.

### Task 14: Desktop: lookups that kept a path

**Files:** Modify `desktop/lib/ws/local_cli_discovery.dart:90-101`, `desktop/lib/ws/local_daemon_transport.dart:55-67`, `desktop/lib/logging/log_file.dart:52`, `desktop/lib/state/app_state.dart:14880-14894`. Test: `desktop/test/local_cli_discovery_test.dart`, `local_daemon_transport_test.dart`; create `desktop/test/claude_account_folder_test.dart`.

**Depends on:** 12. **Effort:** high.

- [ ] **Step 1: Write the failing tests**, on a Linux look: `the computer id is read again after the folder moves` (a discovery built on a legacy home reads `<data>/computer-id` once the data root exists); `the short socket folder is under the state root`; `a new Claude account's folder is under the data root's claude-profiles` (the folder `addClaudeAccount` asks the daemon for); `on macOS each is under ~/.harness`.
- [ ] **Step 2: Run** the three files. Expected: FAIL on the first and third.
- [ ] **Step 3: Implement.** `local_cli_discovery.dart` resolves the path at each read in place of the field. The others already build through `HarnessHome.of` and follow Task 12; where one holds the result in a static, it becomes a getter. `addClaudeAccount` runs for this computer only (`:14863`), so Desktop's own look is the right one. Desktop's open store and log file stay as opened until it relaunches.
- [ ] **Step 4: Run** the three files and `flutter analyze lib/ws lib/logging`. Expected: PASS.
- [ ] **Step 5: Commit** `Desktop: the daemon, the computer id and a new Claude account are found by the rule`.

### Task 15: Installers

**Files:** Modify `cli/scripts/install.sh:83-104`, `:285-286`, `:567-576`, `:698-785`; `cli/scripts/install-cli.sh:37-41`, `:67`. Test: `cli/src/scripts/install.spec.ts`.

**Depends on:** none. **Effort:** xhigh (it lays down the program).

- [ ] **Step 1: Write the failing tests** in `install.spec.ts`, each running the script's `harness_roots` function with `sh` under a throwaway home and a stubbed `uname`: `Linux, fresh → the XDG roots`; `Linux, ~/.harness only → ~/.harness`; `Linux, the data root exists → XDG`; `XDG variables unset, empty, relative, absolute`; `Darwin → ~/.harness whatever exists`. And of the script's text: `cli, bin and tui/first-run are laid in the data root; runtime and its current-* files in the state root`; `the launcher names the node and cli.js the roots give`; `install-cli.sh keeps ADAPTER_CLI_DIR, ADAPTER_DATA_DIR, HARNESS_RUNTIME_NODE and HARNESS_BIN_DIR first`.
- [ ] **Step 2: Run** `npx vitest run src/scripts/install.spec.ts`. Expected: FAIL (no `harness_roots`).
- [ ] **Step 3: Implement** one POSIX function `harness_roots` in each script that sets `HARNESS_DATA_ROOT` and `HARNESS_STATE_ROOT`; every `$HOME/.harness/…` in the script comes from them, the Node heredoc (`install.sh:709`) through the environment. On a machine still on `~/.harness` the script installs there; the daemon moves it at its next start. `install.ps1` is not edited.
- [ ] **Step 4: Run** the spec, `sh -n` on both scripts and `shellcheck` where the repository already runs it. Expected: PASS. On a Mac, `diff` of the launcher the script writes before and after: none.
- [ ] **Step 5: Commit** `The installers lay Harness in the folders the rule gives`.

### Task 16: Harness OS setup

**Files:** Modify `os/setup.py:65-67`. Test: `os/tests/test_setup.py`.

**Depends on:** none. **Effort:** high.

- [ ] **Step 1: Write the failing tests:** `the session and the computer id are read from the data root once it exists`; `from ~/.harness while only that exists`; `from the data root on a fresh image`; `XDG_DATA_HOME is used when absolute`.
- [ ] **Step 2: Run** `make -C os check` (what `os-checks` runs). Expected: FAIL in `test_setup.py`.
- [ ] **Step 3: Implement** `harness_data_root(home, environ)`, the rule; `SESSION` and `COMPUTER_ID` become functions of it, read at each use.
- [ ] **Step 4: Run** the tests. Expected: PASS. The image's unit runs `harness start --foreground` with `HARNESS_NO_MASTER=1` and no `ADAPTER_DATA_DIR` (`os/root/usr/lib/systemd/user/harness-daemon.service`), so its daemon moves an existing `~/.harness` at boot like any Linux machine.
- [ ] **Step 5: Commit** `Harness OS setup reads the sign-in and the computer id by the rule`.

### Task 17: Companions

**Files:** Create `companions/src/shared/harnessRoots.ts`, `harnessRoots.spec.ts`. Modify `companions/scripts/memory-extraction-eval.ts:77`, `companions/src/companion/client.ts:138`.

**Depends on:** none. **Effort:** medium.

- [ ] **Step 1: Write the failing test** `harnessRoots.spec.ts`: the rule's six cases for `harnessRoots(home, env, platform, exists)`.
- [ ] **Step 2: Run** `cd companions && npx vitest run src/shared/harnessRoots.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the rule inline (no import from `cli/src`: the package ships alone). The eval script's data folder and the help text's lessons folder come from it. `LessonStore` is handed its root (`memory/lessons/store.ts:61`); no caller in this repository builds `<home>/.harness/lessons`, and the report confirms that with a search of `companions/` and `daemons/`.
- [ ] **Step 4: Run** `npx vitest run src/shared src/application/lessons` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Companions find Harness's folders by the rule`.

### Task 18: Store: the shared daemon lookup

**Files:** Modify `store/tools/local-daemon.mjs:25-39`, `local-credential.mjs:44`. Test: `store/tools/local-daemon.test.mjs`, `local-credential.test.mjs`. Copy to `store/agents/autonomous-grid/lib/localDaemon.mjs`, `machine-monitor/lib/localDaemon.mjs`, `harness-monitor/lib/localDaemon.mjs`, `memories/lib/localDaemon.mjs`.

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces, from `local-daemon.mjs` and each copy: `export function harnessRoots(env = process.env, platform = process.platform, exists = existsSync): { data: string; state: string }`; `daemonDataDir(env)` and `daemonSocketPath(port, env, platform)` keep their signatures.

- [ ] **Step 1: Write the failing tests:** the rule's six cases for `harnessRoots`; `the data folder is <data>/cli/data, and ADAPTER_DATA_DIR still wins`; `a long folder's socket is under <state>/s`; `on macOS both are under ~/.harness`.
- [ ] **Step 2: Run** `node --test store/tools/local-daemon.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the rule in `local-daemon.mjs`, use it in `local-credential.mjs`, and copy the file to the four packages byte for byte.
- [ ] **Step 4: Run** `node --test store/tools/*.test.mjs` (`port-holder.test.mjs:156` checks the copies). Expected: PASS.
- [ ] **Step 5: Commit** `Store: packages find the daemon by the rule`.

### Task 19: Store: autonomous-grid

**Files:** Modify `store/agents/autonomous-grid/lib/connect.mjs:35`, `harness.mjs:42`, `fleet.mjs:146`, `toolchain/grid.sh:7`; its `test/*.test.mjs`.

**Depends on:** 18. **Effort:** high.

- [ ] **Step 1: Write the failing tests:** `the fleet's defaults are in <data>/grid-fleet, and GRID_FLEET_DEFAULTS still wins`; `the credential's folder is the daemon's data folder`; `the remote line finds current-grid by the rule` (the shell text `fleet.mjs` sends runs on the other machine: the test runs it with `sh` under a fresh, a legacy and a moved home); `grid.sh does the same, HARNESS_GRID_BIN and ADAPTER_RUNTIME_DIR first`.
- [ ] **Step 2: Run** `cd store/agents/autonomous-grid && node --test test/*.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** The JavaScript files import `harnessRoots` from the package's own `lib/localDaemon.mjs`; the two shell texts carry the rule as one function.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `Store: Grid finds Harness's folders by the rule`.

### Task 20: Store: the monitors

**Files:** Modify `store/agents/machine-monitor/lib/daemon.mjs:40`, `snapshot.mjs:90`; `store/agents/harness-monitor/lib/bridge.mjs:42`, `config.mjs:28`, `registry.mjs:19`; their `test/`.

**Depends on:** 18. **Effort:** high.

- [ ] **Step 1: Write the failing tests:** machine-monitor: `the app's stats are read from <data>/desktop-app-v2, HARNESS_APP_DIR first`. harness-monitor: `its state is in <state>/monitor, HARNESS_MONITOR_STATE first`; `the registry is read from the daemon's data folder, HPS_REGISTRY and HARNESS_HOME first`. Each also on macOS and on a legacy Linux home.
- [ ] **Step 2: Run** each package's test command (`node --test test/*.test.mjs`; harness-monitor with `--import ./test/setup.mjs`). Expected: FAIL.
- [ ] **Step 3: Implement** through each package's `lib/localDaemon.mjs`. harness-monitor's `test/setup.mjs:20` guards the real folder: it guards the folder the rule gives.
- [ ] **Step 4: Run** both. Expected: PASS.
- [ ] **Step 5: Commit** `Store: the monitors find Harness's folders by the rule`.

### Task 21: Store: memories

**Files:** Modify `store/agents/memories/lib/agents.mjs:51-54`, `bridge.mjs:43`; its tests.

**Depends on:** 18. **Effort:** high.

- [ ] **Step 1: Write the failing tests:** `About You is in <data>/memory, MEMORIES_HOME first`; `the session index is read from the daemon's data folder`; macOS and a legacy Linux home unchanged.
- [ ] **Step 2: Run** `cd store/agents/memories && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** through `lib/localDaemon.mjs`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Store: Memories finds Harness's folders by the rule`.

### Task 22: Store: local AI's Node lookup

**Files:** Modify `store/tools/local-ai/toolchain/node.sh:6`, `store/tools/local-ai/test/packaging.test.mjs`; regenerate `store/agents/vllm/toolchain/node.sh`, `ollama/toolchain/node.sh`, `mlx-lm/toolchain/node.sh`.

**Depends on:** none. **Effort:** medium.

- [ ] **Step 1: Write the failing test** in `packaging.test.mjs`: `node.sh finds current-node by the rule`: run with `sh` under a fresh, a legacy and a moved home, and with `ADAPTER_RUNTIME_DIR` set.
- [ ] **Step 2: Run** `cd store/tools/local-ai && node --test test/*.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the rule as one shell function in the source file, and regenerate the three copies with the package's own build scripts (`scripts/build-*.mjs`).
- [ ] **Step 4: Run** the tests. Expected: PASS, the copies equal to the source.
- [ ] **Step 5: Commit** `Store: local AI finds the managed Node by the rule`.

### Task 23: CLI developer tools

**Files:** Modify `cli/scripts/benchmark-route.ts:71-72`, `orchestrator-e2e-peer.ts:14`, `remote-viewer-peer.ts:19`, `:61`.

**Depends on:** 1. **Effort:** medium. **No red test:** tools run by hand with no test; one commit.

- [ ] **Step 1: Replace** each hand-built `homedir()` + `.harness` path with `harnessPath(…)` imported from `../src/config/harnessHome.js`, keeping each override that precedes it.
- [ ] **Step 2: Run** `npm run typecheck` and `npx tsx scripts/benchmark-route.ts --help` (or the tool's own no-op form). Expected: no error.
- [ ] **Step 3: Commit** `CLI tools read the installed tree through the home module`.

### Task 24: Move: the plan and the conditions

**Files:** Create `cli/src/homeMove/plan.ts`, `plan.spec.ts`, `conditions.ts`, `conditions.spec.ts`.

**Depends on:** 1. **Effort:** xhigh (it decides whether a person's folder moves).

**Interfaces:**
- Consumes: `xdgRoots`, `legacyHarnessHome`, `HARNESS_ENTRIES` (Task 1); `harnessPaneOwner`, `paneOwnerFormat`, `paneOwnerOf` (`lib/harnessSessionLabel.ts`).
- Produces:
  ```ts
  // plan.ts
  export interface MoveEntry { name: string; kind: HarnessRootKind; known: boolean; from: string; staged: string; to: string }
  export interface MovePlan { home: string; legacy: string; data: string; state: string; entries: MoveEntry[] }
  /** Every top-level name of ~/.harness but the move's own files (.move.json, home-move.json). An unknown name goes to data. */
  export function planMove(home: string, env: NodeJS.ProcessEnv, names: readonly string[]): MovePlan
  /** An old-tree path's place after the move; any other path as it is. */
  export function movedPath(plan: Pick<MovePlan, 'legacy' | 'data' | 'state'>, path: string): string
  // conditions.ts
  export type Reason = 'update-pending' | 'old-tmux' | 'pty-host' | 'target-exists' | 'no-space' | 'permission' | 'io'
  export type Hold = { state: 'waiting'; reason: 'update-pending' | 'old-tmux' | 'pty-host' } | { state: 'skipped-override'; name: string }
  export type MoveCheck = { move: true; plan: MovePlan; oldTag: string; newTag: string } | { move: false; hold: Hold | null }
  export interface ConditionDeps { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv; hasExecve: boolean
    fs: Pick<typeof import('node:fs'), 'lstatSync' | 'readdirSync' | 'readFileSync' | 'existsSync' | 'realpathSync'>
    alive(pid: number): boolean; answers(socket: string): Promise<boolean>
    tmux: { version(): string | null; tags(paneOptions: boolean): string[] }; ptyHostRuns(ptyDir: string): boolean }
  export const OVERRIDE_NAMES: readonly string[]
  export async function checkMove(deps: ConditionDeps): Promise<MoveCheck>
  ```

- [ ] **Step 1: Write the failing tests.**
  - `plan.spec.ts`: `each entry goes to the root its label names` (all 26); `an entry the table does not know goes to data`; `the move's own files are not entries`; `movedPath maps <legacy>/runtime/x to <state>/runtime/x, <legacy>/cli/data to <data>/cli/data, and leaves /usr/bin/node alone`; `custom XDG folders`.
  - `conditions.spec.ts`, one case each, in this order, the first that holds decides: not Linux → no hold; the data root exists → no hold; no `~/.harness` → no hold; `~/.harness` is itself a link (to a folder on another disk) → `skipped-override` with the name `~/.harness`, and nothing under it is read; `~/.harness` holds only links, `hook-routes` and `connections` (a bridge) → no hold; no `process.execve` → no hold; a live pid in `adapter.pid`, a socket that answers, or a spawn lock whose owner lives → no hold (a start that finds a daemon starts nothing); `update-pending.json` in the CLI folder → `waiting update-pending`; an override inside `~/.harness`, lexically or through a link, in the environment or in the file `HARNESS_ENV_FILE` names → `skipped-override` with its name; tmux before 3.0 with a pane that carries the tag → `waiting old-tmux`; tmux before 3.0 with no such pane → move; a live PTY host → `waiting pty-host`; else → move, with the old and the new tag.
  - `the list holds every setting whose default is under the home`: every field of `config/env.ts` whose default is built from `harnessPath(`, `adapterCliDir`, `adapterDataDir`, `adapterRuntimeDir` or `computerIdFile`, plus `HARNESS_AUTH_DIR`, `HARNESS_CONNECTIONS_DIR` and `HARNESS_FLASHER_CACHE`, is in `OVERRIDE_NAMES` (the test reads the source's text).
  - `the new tag is the data folder's after the move`: a default data folder gives `harnessPaneOwner(<data>/cli/data)`; an `ADAPTER_DATA_DIR` outside the tree, or a `cli` that is a link out of the tree, gives the old tag again.
- [ ] **Step 2: Run** `npx vitest run src/homeMove/plan.spec.ts src/homeMove/conditions.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.** A daemon's socket is looked for as `daemon-*.sock` in the data folder and in `<legacy>/s/<sha256 of the data folder, 16 hex>/`, each asked once with a one-second limit. The environment file is parsed with `node:util`'s `parseEnv`; a name already in the environment wins. A `~/.harness` that is itself a link is found with `lstatSync` and never moved (answer 8).
- [ ] **Step 4: Run** the two specs. Expected: PASS.
- [ ] **Step 5: Commit** `The move: what goes where, and when it may run`.

### Task 25: Move: lock, journal, records

**Files:** Create `cli/src/homeMove/lock.ts`, `journal.ts`, `record.ts`, and `lock.spec.ts`, `journal.spec.ts`, `record.spec.ts`.

**Depends on:** 24. **Effort:** xhigh (concurrency; what a crash leaves).

**Interfaces:**
- Produces:
  ```ts
  // lock.ts: a folder <state root>.move-lock holding `owner` (pid and its start time)
  export const LOCK_WAIT_MS = 30_000
  export async function withMoveLock<T>(stateRoot: string, run: () => Promise<T>, deps?: LockDeps): Promise<{ held: true; value: T } | { held: false }>
  export function moveLockPath(stateRoot: string): string
  // journal.ts: ~/.harness/.move.json, written whole and synced at each step
  export type Done =
    | { did: 'stage'; entry: string; copied: boolean } | { did: 'file'; path: string; before: string | null }
    | { did: 'aside'; path: string; aside: string }
    | { did: 'link'; path: string; before: string } | { did: 'reload' } | { did: 'pane'; id: string }
    | { did: 'commit'; root: 'state' | 'data' } | { did: 'bridge' }
  export interface Journal { version: 1; startedAt: number; plan: MovePlan; oldTag: string; newTag: string; done: Done[] }
  export function openJournal(journal: Journal, io?: JournalIo): { add(done: Done): void; close(): void }
  export function readJournal(legacy: string): Journal | null
  // record.ts: home-move.json, in the state root once moved, in ~/.harness before
  export interface MoveRecord { version: 1; state: 'moved' | 'bridged' | 'waiting' | 'failed' | 'skipped-override'; reason?: Reason
    entries: number; bytesCopied: number; panes: number; oldProcesses: number; at: number; failedAt?: number
    /** A ~/.harness that is not the bridge sits beside the data root: said once, when this is first written. */
    stray?: true }
  export function readMoveRecord(home: string, env: NodeJS.ProcessEnv): MoveRecord | null
  /** False, with nothing written, when the state and the reason are the ones on disk. */
  export function writeMoveRecord(folder: string, next: MoveRecord): boolean
  ```
  `before` is the file's previous bytes in base64, null when there was no file. `aside` is a name the move renamed out of the way (`path` → `aside`) to put a new one in its place (Task 27).

- [ ] **Step 1: Write the failing tests.**
  - `lock.spec.ts`: `the first start holds it`; `a second start waits, then sees the lock gone` (the holder releases; the waiter is told by `fs.watch`, with fake timers for the limit, no sleep); `a lock whose owner is gone is taken over`; `a pid reused by another process is gone too` (the start time differs); `after 30 s it gives up and says so`; `the lock is beside the state root, never in a tree`; `the XDG base is made owner-only when it is missing`.
  - `journal.spec.ts`: `each step is on disk before the next begins`; `a journal cut off mid-write reads as the last whole one` (written to a temporary file and renamed); `no journal reads as none`.
  - `record.spec.ts`: `written when the state or the reason changes, not again` (the second identical write returns false and leaves the file's mtime); `it holds no path and no name` (the keys are exactly the interface's); `read from the state root once moved, from ~/.harness before`; mode 600.
- [ ] **Step 2: Run** `npx vitest run src/homeMove/lock.spec.ts src/homeMove/journal.spec.ts src/homeMove/record.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The lock is `mkdirSync` (it fails when the folder is there); the owner's start time is field 22 of `/proc/<pid>/stat`.
- [ ] **Step 4: Run** the three specs. Expected: PASS.
- [ ] **Step 5: Commit** `The move: its lock, its journal and its record`.

### Task 26: Move: stage, link, commit

**Files:** Create `cli/src/homeMove/stage.ts`, `stage.spec.ts`.

**Depends on:** 25. **Effort:** xhigh (it moves every file a person has in Harness).

**Interfaces:**
- Produces:
  ```ts
  export interface StageIo extends Pick<typeof import('node:fs'), 'renameSync' | 'symlinkSync' | 'mkdirSync' | 'rmSync' | 'lstatSync' | 'readdirSync' | 'cpSync' | 'utimesSync'> {}
  /** Stage one entry and leave its link; returns the bytes copied (0 on one filesystem). */
  export function stageEntry(entry: MoveEntry, plan: MovePlan, io: StageIo, startedAt: number): { copied: boolean; bytes: number }
  export function mergeRecreated(entry: MoveEntry, io: StageIo): number
  export function unstageEntry(entry: MoveEntry, copied: boolean, io: StageIo): void
  export function commitRoot(plan: MovePlan, root: 'state' | 'data', io: StageIo): void
  export function uncommitRoot(plan: MovePlan, root: 'state' | 'data', io: StageIo): void
  export function dropOriginals(plan: MovePlan, io: StageIo): void
  ```

- [ ] **Step 1: Write the failing tests**, on real temporary folders:
  - `an entry is renamed into <root>.moving and a link to its final place is left`: the link's text is `<root>/<entry>`; bytes, modes (a 600 file, a 700 folder), times and links inside the entry are as they were.
  - `a file entry (computer-id) moves the same way`.
  - `a folder recreated at an old path is merged`: a real folder with one file put at `from` after the rename ends inside the staged entry, and the link goes in; a file both sides hold keeps the newer.
  - `across filesystems the entry is copied, then swapped, then what changed during the copy is copied again` (the io's `renameSync` throws `EXDEV` once; a file written after the copy began is in the staged entry; the original is kept beside until `dropOriginals`).
  - `commit renames the state root, then the data root`; `uncommit puts each back`.
  - `unstage restores the exact entry`, for a renamed and for a copied one.
- [ ] **Step 2: Run** `npx vitest run src/homeMove/stage.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** A copy uses `cpSync` with `recursive`, `preserveTimestamps` and `verbatimSymlinks`; the kept original sits at `<legacy>/.move-old/<entry>`. The staging folders are made owner-only.
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** `The move: stage an entry, link its old path, commit`.

### Task 27: Move: what names the old tree, inside

**Files:** Create `cli/src/homeMove/rewriteInside.ts`, `rewriteInside.spec.ts`.

**Depends on:** 25. **Effort:** xhigh (it edits the agents' registry, the profiles' records and the sealed engine-home journal).

**Interfaces:**
- Consumes: `readAdoptedHomes(file): HomeCatalogRead` and `createHomeAdopter(file).adopt(additions: HomeCatalog): HomeCatalog` (`engines/kit/homeAdoption.ts`, unchanged; `HomeCatalog` is `{ claude: string[]; codex: string[] }`).
- Produces: `export function rewriteInside(plan: MovePlan, dataDir: string, journal: { add(done: Done): void }, io?: RewriteIo): { files: number; left: string[] }`, where `dataDir` is the daemon's data folder as staged (or where an override keeps it), and `left` names the files it could not read as JSON (or the engine-home journal, when `readAdoptedHomes` refuses it); `export function restoreFile(done: Extract<Done, { did: 'file' }>): void`; `export function restoreAside(done: Extract<Done, { did: 'aside' }>): void` (when `aside` exists: whatever is at `path` goes, and `aside` is renamed back; when it does not, nothing); `export function dropAside(done: Extract<Done, { did: 'aside' }>): void` (the finish deletes `aside`).

- [ ] **Step 1: Write the failing tests**, one per record, each asserting the new value and that the journal holds the previous bytes:
  - `runtime/current-node` and `current-grid`, and any other `current-*` file there whose text is a path in the old tree.
  - `registry.json` (`claudeHome`, `transcriptPath`, `cwd`) and `stopped-agents/*.json`.
  - `claude-profiles.json`, `codex-profiles.json`; `dial-setup.json`, `dial-skill.json`; `node-migration.json`.
  - `dsh/installed.json`: `dir` moves, and every record whose `linked` is not true gains `setup: 'pending'`; a linked one is left as it was.
  - `engine-homes.json is sealed again`, on a journal built in the test with `createHomeAdopter` (two adoptions, so the pool has `000.json`, `001.json`, `.adopted` and `.confirmations/001.committed`): after the rewrite `readAdoptedHomes(file).homes` holds, as sets, every home of before with an old-tree prefix replaced and the others as they were; the journal holds a `file` entry for the catalog and an `aside` entry for each of the three pool names, each written before its rename; `<name>.before-move` holds the old pool.
  - `with no pool on disk only the catalog is rewritten`, and no pool name is created.
  - `restoreAside undoes the new pool`: after the rewrite, `restoreFile` and `restoreAside` in reverse give the exact bytes and names of before, and `readAdoptedHomes` reads the old homes; `restoreAside with no aside on disk leaves the path` (a crash between the journal line and the rename).
  - `an engine-home journal readAdoptedHomes refuses is left and named`, and nothing of it is renamed.
  - In each moved profile, `plugins/installed_plugins.json` (`installPath`) and `plugins/known_marketplaces.json` (`installLocation`).
  - `only a string that starts with an old entry's path changes`: `/h/.harness-other/x`, a key, a number and a path elsewhere are as they were; `/h/.harness/dsh` itself and `/h/.harness/dsh/a` change.
  - `a file nothing in changed is not written` (its mtime and bytes stay); `a file that is not JSON is left and named`; `modes are kept`; `a data folder kept elsewhere by ADAPTER_DATA_DIR is rewritten where it is`.
  - `restoreFile puts back the exact bytes, or removes a file that was not there`.
- [ ] **Step 2: Run** `npx vitest run src/homeMove/rewriteInside.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `movedPath` over every string value of the parsed record; each file is written to a temporary name and renamed, after its previous bytes are in the journal. The engine-home journal, in this order: `readAdoptedHomes(file)` (a refusal leaves it and names it); the catalog rewritten as a record; for each of `.adoptions`, `.adopted`, `.confirmations` that exists, its `aside` journal line, then its rename to `<name>.before-move`; then `createHomeAdopter(file).adopt(<the homes read, moved>)`; then `readAdoptedHomes(file)` again, which must give the same homes as sets, or the step fails with `io`.
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** `The move: the records that named the old tree name the new one`.

### Task 28: Move: what names the old tree, outside

**Files:** Create `cli/src/homeMove/rewriteOutside.ts`, `rewriteOutside.spec.ts`.

**Depends on:** 25. **Effort:** xhigh (the launcher on `PATH` and the systemd unit).

**Interfaces:**
- Produces: `export function rewriteOutside(plan: MovePlan, where: { binDir: string; unitFile: string; oldLogFile: string; env: NodeJS.ProcessEnv }, journal: { add(done: Done): void }, run: (command: string, args: string[]) => { status: number | null }): { launcher: boolean; hn: boolean; unit: boolean }`; `export function restoreOutside(done: Done, run: …): void`.

- [ ] **Step 1: Write the failing tests.**
  - `the harness launcher's exec line names the new node and cli.js`, for each shipped shape (the installer's two-liner, `install-cli.sh`'s, its `--no-updates` variant with its preamble kept); `a launcher that runs another bundle is not touched`; `no launcher, nothing written`.
  - `an hn of releases #365 to #500 is rewritten` (`exec <node> <cli.js> tui "$@"`); `an hn that is a link into bin/ is linked again`; `today's hn, which names only the launcher, is not touched`.
  - `this install's unit gets its ExecStart, StandardOutput and StandardError rewritten, and daemon-reload runs once`; `XDG_DATA_HOME and XDG_STATE_HOME are added as Environment= lines when set, once`; `a unit whose log is another data folder's is not touched`; `a home with a space and a % in it is rewritten as the unit spells it`.
  - `daemon-reload that fails fails the step`.
  - `restoreOutside puts each file's bytes back and reloads again`.
- [ ] **Step 2: Run** `npx vitest run src/homeMove/rewriteOutside.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The unit is `<XDG_CONFIG_HOME or ~/.config>/systemd/user/harnessd.service`, and is this install's when it holds `StandardOutput=append:<old log file>` (`harnessd/platform.ts:583-593`). A path is replaced as the file spells it: the unit's three spellings (`platform.ts:169-177`) and the launcher's quoting each escape character by character, so an entry's old path, escaped the same way, is the prefix to replace. Each file is written through a temporary name; a launcher keeps mode 755.
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** `The move: the launcher and the systemd unit run from the new folders`.

### Task 29: Move: the panes

**Files:** Create `cli/src/homeMove/panes.ts`, `panes.spec.ts`, `panes.real.spec.ts`.

**Depends on:** 25. **Effort:** xhigh (every running agent's pane).

**Interfaces:**
- Produces: `export interface Tmux { version(): string | null; tags(paneOptions: boolean): string[]; retag(from: string, to: string): string[]; tag(ids: readonly string[], to: string): void }`; `export function defaultTmux(run?: (args: string[]) => { status: number | null; stdout: string }): Tmux`; `export function hasPaneOptions(version: string | null): boolean`.

- [ ] **Step 1: Write the failing tests.**
  - `panes.spec.ts`, with a fake `run`: `every pane whose tag is the old one gets the new one, and their ids come back`; `a pane tagged by another daemon, or by nobody, is not touched`; `a tag set on the window is overridden on the pane`; `tmux that is missing, or has no server, has no panes`; `tmux 2.9 has no pane options; 3.0, 3.4 and a version it cannot read have` (as `lib/tmuxVersion.ts` reads it); `tag() sets a list of panes back`; `each call has a five-second limit`.
  - `panes.real.spec.ts`, under `RUN_REAL_TMUX_DISCOVERY=1` on a private server (`src/testing/isolatedTmux.ts`): a pane created as the daemon creates it is retagged, and a listing with `paneOwnerFormat(true)` reads the new tag.
- [ ] **Step 2: Run** `npx vitest run src/homeMove/panes.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `tmux list-panes -a -F '#{pane_id}|<paneOwnerFormat>'` and `tmux set-option -p -t <id> @harness_daemon <tag>`, on the default server.
- [ ] **Step 4: Run** the spec, and the real one with the variable set. Expected: PASS.
- [ ] **Step 5: Commit** `The move: Harness's panes take the new folder's tag`.

### Task 30: The bridge's layout

**Files:** Create `cli/src/homeMove/bridge.ts`, `bridge.spec.ts`.

**Depends on:** 24. **Effort:** xhigh (private folders and the daemon's sockets).

**Interfaces:**
- Produces:
  ```ts
  export const BRIDGE_FILE = 'bridge.json'
  /** The entries the bridge keeps as real folders, because an old reader refuses a link there. */
  export const REAL_ENTRIES = ['hook-routes', 'connections'] as const
  export interface BridgeRecord { version: 1; movedAt: number; oldHome: string; oldDataDir: string; oldTag: string; newTag: string; panes: string[] }
  export function readBridge(stateRoot: string): BridgeRecord | null
  export function writeBridge(stateRoot: string, record: BridgeRecord): void
  /** The move's time in seconds, on the clock /proc start times use: btime of /proc/stat plus /proc/uptime. */
  export function procNow(read?: (path: string) => string): number
  export function makeRealFolders(legacy: string): void
  export interface Served { routes: { dataDir: string; port: number }; sockets: { oldFolder: string; folder: string; name: string }[]; files: { from: string; name: string }[] }
  /** Put in the bridge what a link cannot give; returns what it could not link. */
  export function serveOldPaths(bridge: BridgeRecord, served: Served, publish: (dataDir: string, port: number, folder: string) => void): string[]
  /** Links, the real folders, the socket links, then ~/.harness. 'left' when something else is in it. */
  export function removeBridge(bridge: BridgeRecord, stateRoot: string): 'removed' | 'left'
  export function isBridge(legacy: string): boolean
  ```

- [ ] **Step 1: Write the failing tests.**
  - `the two real folders replace their links, owner-only`.
  - `the route record is the daemon's, under its new tag`, and the hook script accepts it: `notify.mjs` run in a pane tagged with the new tag, with `HARNESS_HOOK_ROUTES_DIR` at the bridge's folder, routes to the new data folder.
  - `an old client's socket path gets a hard link when it is not where the socket is`: both paths beside the data folder → nothing to do; the old one in a short folder → a link in `<state>/s/<hash of the old folder>/`, in a 700 folder; the old one beside and the new one short → a link beside the data folder; the link passes `privateSocket` (`notify.mjs:303-310`) and `socketIsPrivate` (`store/tools/local-daemon.mjs`).
  - `connections holds hard links to bridge.sock and mcp-shim.mjs`, and the shim's `socketState()` says `private` for `~/.harness/connections/bridge.sock`.
  - `a link is made again when the socket is a new one` (another inode); `a link across filesystems is not made, and is named in what comes back`.
  - `removing the bridge removes links without following them`: every target's bytes are as they were; the real folders, the socket links and `~/.harness` are gone.
  - `something that is not the bridge's stays, and the answer is left` (a real file a person put in `~/.harness`).
  - `isBridge`: only links and the real folders → true; one real entry more → false; an empty folder → false.
- [ ] **Step 2: Run** `npx vitest run src/homeMove/bridge.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Where an old client looks: `<oldFolder>/<name>` when that is 96 bytes or fewer, else `<oldHome>/s/<sha256 of oldFolder, 16 hex>/<name>` (`lib/localSocket.ts:59-68`). `publish` is `lib/hookRoutes.ts`'s `publishHookRoute`, handed in by the caller, so this file imports nothing that resolved a path.
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** `The bridge: what it holds, and how it goes`.

### Task 31: Move: the run

**Files:** Create `cli/src/homeMove/move.ts`, `move.spec.ts`.

**Depends on:** 26, 27, 28, 29, 30. **Effort:** xhigh (the migration, its rollback and its recovery).

**Interfaces:**
- Produces:
  ```ts
  export interface MoveDeps { io: StageIo & RewriteIo; tmux: Tmux; run(command: string, args: string[]): { status: number | null }; now(): number; procNow(): number; log(line: string): void }
  export type MoveOutcome = { state: 'bridged'; entries: number; bytesCopied: number; panes: number } | { state: 'failed'; reason: Reason }
  export async function runMove(check: Extract<MoveCheck, { move: true }>, env: NodeJS.ProcessEnv, deps: MoveDeps): Promise<MoveOutcome>
  /** A journal an earlier move left: finished when the data root is committed, rolled back when not. Null with no journal. */
  export async function recoverMove(home: string, env: NodeJS.ProcessEnv, deps: MoveDeps): Promise<MoveOutcome | { state: 'rolled-back' } | null>
  ```

- [ ] **Step 1: Write the failing tests**, on a home built by one helper (`legacyHome()`: every table entry, an unknown one, `auth/session.json` and `computer-id` with known bytes, 600 and 700 modes, a launcher, a unit, a fake tmux with two tagged panes). A second helper, `snapshot(home)`, reads every path, byte, mode and link target under the home, and the pane tags.
  - `an upgrade with data`: every entry is in its root; `auth/session.json` and `computer-id` are byte for byte; modes are kept; `~/.harness` holds one link per entry and the two real folders; `bridge.json` holds the move's time, the old data folder and both tags; the record says `bridged` with its counts; the journal and the staging folders are gone.
  - `an entry the table does not know lands in data and is named in one log line`.
  - `a failure at each step rolls back to the exact tree`: for each of stage (first, middle, last entry), inside (a record, and the engine-home reseal after its pool is set aside), outside, reload, panes, commit of the state root, commit of the data root: the io fails there, the outcome is `failed`, and `snapshot` equals the one taken before, outside files and pane tags included.
  - `a crash at each step is finished or rolled back by the next start`: the run stops after each step with the journal left; `recoverMove` gives the before-snapshot when the data root was not committed, and a whole bridged home when it was. `a crash after the state root's rename` rolls back.
  - `a run after success does nothing`; `recovery run twice does its work once`.
  - `across filesystems`: `EXDEV` on rename, a write during the copy is kept, `bytesCopied` counts, the originals go at the finish.
  - `custom XDG folders`; `an override elsewhere still wins` (an `ADAPTER_DATA_DIR` outside the tree: its folder stays, its records are rewritten there, no pane is retagged).
  - `an unwritable base fails with permission and leaves the tree as it was`; `a state root that is already there fails with target-exists`; `a full disk fails with no-space`.
- [ ] **Step 2: Run** `npx vitest run src/homeMove/move.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the spec's eleven steps in order: preflight (the bases, the staging folders), journal, stage and link each entry with a merge before the link and again at the end, inside, outside, panes, commit, the bridge record and the real folders, finish (the copied originals, each `aside` through `dropAside`, the old record, the journal last). Rollback undoes a `file` with `restoreFile` and an `aside` with `restoreAside`. A failure before the data root's rename undoes the journal in reverse. After it, nothing is undone and the journal stays for the next start. Every step looks at what is there before it acts. Error codes map as `ENOSPC` → `no-space`, `EACCES` and `EPERM` → `permission`, anything else → `io`.
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** `The move: every step, its rollback and its recovery`.

### Task 32: Move: the start commands and the re-exec

**Files:** Create `cli/src/homeMove/start.ts`, `start.spec.ts`, `closure.spec.ts`. Modify `cli/src/entry.ts:19-46`.

**Depends on:** 31. **Effort:** xhigh (it runs before every daemon start).

**Interfaces:**
- Produces: `export async function moveHomeAtStart(argv: readonly string[], env: NodeJS.ProcessEnv, deps?: StartDeps): Promise<void>`; `export function reexecTarget(plan: Pick<MovePlan, 'legacy' | 'data' | 'state'>, execPath: string, argv: readonly string[], execArgv: readonly string[]): { file: string; args: string[] } | null`.

- [ ] **Step 1: Write the failing tests.**
  - `start.spec.ts`: `only start and __harnessd run it` (`status`, `stop`, `__run`, `__service` load nothing); `a held move writes its record once and logs one line` for each hold, with these lines:
    - `home move: waiting update-pending · it moves at the start after this update settles`
    - `home move: skipped-override · <NAME> names a folder inside ~/.harness; unset it to move`
    - `home move: skipped-override · ~/.harness is a link; it stays where it points`
    - `home move: waiting old-tmux · close the agents, then harness start`
    - `home move: waiting pty-host · close the agents, then harness start`
  - `a moved home logs "home move: moved · data <root> · state <root>"`, appended to the data folder's `harness.log` in its new place, and printed too when stdout is a terminal.
  - `a failed move logs "home move: failed <reason> · ~/.harness is as it was"`, and the start goes on.
  - `a failed move is tried again at once by harness start, and by __harnessd and --if-down only an hour after`.
  - `a journal is recovered before anything else`; `a start that waited resolves the roots again`; `a lock still held after 30 s lets the start go on, unmoved`.
  - `the process starts again from the new paths`: `reexecTarget` maps `<legacy>/runtime/node-x/bin/node` and `<legacy>/cli/cli.js`, keeps `execArgv` and the arguments, and is null for `/usr/bin/node` with `/usr/lib/harness/cli.mjs`; after a move `execve` is called once with the same environment; with no target the start goes on in this process.
  - `a ~/.harness beside the data root that is not the bridge is said once`: `home move: ~/.harness is no longer read` at the first start that finds it, the record's `stray` set, nothing deleted, no line at the next start.
  - `anything the move throws is caught`: one `failed io` line, and the start goes on.
  - `closure.spec.ts`: every file under `src/homeMove/` that is not a spec imports only `node:*`, `../config/harnessHome.js`, `../lib/harnessSessionLabel.js`, `../engines/kit/homeAdoption.js` and its own folder; following every import from there, the files reached are exactly those, their own `node:*` imports and the seven of the Global Constraints (`config/env.ts` never among them); no line of `src/architecture.coreFiles.txt` names `homeMove/`; no file under `src/harnessd/` imports it.
- [ ] **Step 2: Run** `npx vitest run src/homeMove/start.spec.ts src/homeMove/closure.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `entry.ts`, after the Team guard and before any branch: `if (command === 'start' || command === '__harnessd') await (await import('./homeMove/start.js')).moveHomeAtStart(process.argv, process.env)`. `moveHomeAtStart` returns at once off Linux; when the data root exists it only looks for a stray `~/.harness`.
- [ ] **Step 4: Run** the two specs, `src/architecture.spec.ts`, `src/leanEntry.spec.ts` and `node build-bundle.mjs && node scripts/check-lean-bundle.mjs`. Expected: PASS; the move is in `cli.js` and in no lean bundle.
- [ ] **Step 5: Commit** `A start moves ~/.harness to the XDG folders, then runs from them`.

### Task 33: `harness status` says a held or failed move

`harness status` gets one line and no JSON form (answer 7): the fleet scan reads `home-move.json` itself (Task 25's record, in the state root once moved, in `~/.harness` before).

**Files:** Create `cli/src/homeMove/statusLine.ts`, `statusLine.spec.ts`. Modify `cli/src/cli.ts:2679-2760` (`status`).

**Depends on:** 25. **Effort:** high.

- [ ] **Step 1: Write the failing test:** `moveStatusLine(record)` is null for no record, `moved` and `bridged`, and one line with what to do for `waiting` (each reason), `failed` (each reason) and `skipped-override`; no line holds a path.
- [ ] **Step 2: Run** `npx vitest run src/homeMove/statusLine.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the function, and one call in `status()` that prints the line under the info block.
- [ ] **Step 4: Run** the spec and `src/cliCommand.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `harness status says why Harness's folder has not moved`.

### Task 34: Bridge: who still uses it

**Files:** Create `cli/src/homeMove/oldUsers.ts`, `oldUsers.spec.ts`.

**Depends on:** 30. **Effort:** xhigh (it decides when old agents lose their paths; it reads other processes).

**Interfaces:**
- Produces:
  ```ts
  export interface ProcRow { pid: number; uid: number; startedAt: number; name: string; exe: string | null; parent: number }
  /** Every process's row, from /proc/<pid>/status (Uid), /proc/<pid>/stat (comm, ppid, starttime), the exe link, and btime of /proc/stat. */
  export function procRows(fs?: Pick<typeof import('node:fs'), 'readdirSync' | 'readFileSync' | 'readlinkSync'>): ProcRow[]
  export interface OldUserFacts { uid: number; self: number; roots: readonly string[]; engines: ReadonlySet<string>; apps: ReadonlySet<string>; panePids: readonly number[] }
  export function oldUsers(bridge: BridgeRecord, rows: readonly ProcRow[], facts: OldUserFacts): number
  ```

- [ ] **Step 1: Write the failing tests**, one per kind, on rows written out in the test:
  - Counts: `an engine by its name` (`claude`, by `comm` and by the executable's base name); `an executable in the old tree` (`<oldHome>/runtime/…/node`), `or in a root its entries moved to` (`<state>/runtime/…/node`, `<data>/bin/harness-tui`); `Desktop` (`harness`, an AppImage's mount included) and `the Device app` (`harness-device`); `a retagged pane's process, and its descendants`.
  - Does not count: `a plain shell outside Harness's panes`; `the session manager and systemd --user`; `a process that started after the move, of any kind`; `another account's process`; `the service's own process and its ancestors` (a master that moved and re-executed in place).
  - `a process that started in the move's own second counts`.
  - `procRows reads nothing but status, stat and the exe link`: the fake file system records every path asked; none ends in `environ` or `cmdline`. `a process that ends mid-read is skipped`; `a comm with spaces and brackets is read whole`.
- [ ] **Step 2: Run** `npx vitest run src/homeMove/oldUsers.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** A start time is `btime + starttime / 100`. A descendant is found by walking `parent`.
- [ ] **Step 4: Run** the spec and `src/architecture.environment.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `The bridge: which processes can still use an old path`.

### Task 35: Bridge: the service

**Files:** Create `cli/src/services/homeBridge.ts`, `homeBridge.spec.ts`, `homeBridgeProcess.ts`, `homeBridgeProcess.spec.ts`. Modify `cli/src/services/inline.ts`, `inline.spec.ts`; `cli/src/serviceProcess.ts:33-62`; `cli/src/harnessd/services.ts:98`, `services.spec.ts`; `cli/src/core/main.ts` (one line beside `:1858`); `cli/AGENTS.md` (the processes table), `cli/src/services/AGENTS.md` (the edge host's row).

**Depends on:** 34, 43 (`setupsPending`). **Effort:** xhigh (a new service; it removes the bridge).

**Interfaces:**
- Consumes: `readBridge`, `serveOldPaths`, `removeBridge` (Task 30); `procRows`, `oldUsers` (Task 34); `readMoveRecord`, `writeMoveRecord` (Task 25); `setupsPending` (`dsh/installed.ts`, Task 43); `publishHookRoute` (`lib/hookRoutes.ts`); `savedDaemonPort` (`lib/daemonRecord.ts`); `ENGINE_CLI_COMMANDS`, `ENGINE_CLI_ALIASES` (`lib/engineBin.ts`).
- Produces: `export const CHECK_MS = 600_000`; `export function startHomeBridge(core: CoreApi, deps?: HomeBridgeDeps): { stop(): void; connected(): void }`; `export function runHomeBridgeService(options: HomeBridgeServiceOptions): ServiceProcess`. The service's name is `homeBridge`; the apps ask it nothing.

- [ ] **Step 1: Write the failing tests** with `fakeCore()` and fake timers.
  - `with no bridge.json it starts nothing`: no timer, no read of `/proc`, no file written; the same off Linux.
  - `at its start, and each time the core connects, it serves the old paths`: the route record, the socket links, the two files in `connections`; what could not be linked is logged once, not at each pass.
  - `it checks at its start and every 10 minutes`: one timer, unreferenced.
  - `it stays while an old user runs`, one case per kind through `oldUsers`; the record's `oldProcesses` is written when the count changes, not at each check.
  - `once none is left it removes the bridge, deletes bridge.json, sets the record to moved, logs "home bridge: removed" once, and stops its timer`.
  - `the bridge waits while a harness's setup is pending`: no old user, `setupsPending()` 1 → the bridge stays; at the next check, 0 → it goes. `a harness marked needs-setup does not hold it` (the count is of `pending` only).
  - `a ~/.harness that holds something else is left, and that is logged once`.
  - `a check that throws is logged and tried again at the next one`; `stop() clears the timer`.
  - `homeBridgeProcess.spec.ts`: the runner starts the service with the process's data folder and socket, and calls `connected()` at each connection.
  - `services.spec.ts`: the edge host lists `homeBridge`; `inline.spec.ts`: `startHomeBridge` is exported.
- [ ] **Step 2: Run** `npx vitest run src/services/homeBridge.spec.ts src/services/homeBridgeProcess.spec.ts src/services/inline.spec.ts src/harnessd/services.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, copying `services/hachi.ts` and `hachiProcess.ts` for the shape. `HomeBridgeDeps.setupsPending` defaults to `setupsPending` over `readInstalledIndex()`, read at each check. The pane processes come from `tmux list-panes -a -F '#{pane_pid} #{@harness_daemon}'`, read only. In `core/main.ts`: `if (!outOfProcess.has('homeBridge')) serviceHost.serve('homeBridge', inline!.startHomeBridge, coreApi, [])`, with one comment line. `harnessd/services.ts` gains the name in the edge host's list and one sentence in its comment (one timer every 10 minutes while a bridge exists, nothing after).
- [ ] **Step 4: Run** the four specs, `src/architecture.spec.ts`, `src/leanEntry.spec.ts`, `npm run test:core` and `npm run test:harnessd`. Expected: PASS, 100% per file.
- [ ] **Step 5: Commit** `The home bridge: a service that keeps the old paths, then removes them`.

### Task 36: CLI: uninstall on two roots, and the bridge

**Files:** Modify `cli/src/lib/uninstall/removal.ts:33-37`, `:98-112`, `:128-200`; `command.ts`; `deps.ts:33-45`. Test: `removal.spec.ts`, `command.spec.ts`; `cli/src/config/harnessHome.guard.spec.ts`.

**Depends on:** 3 (the guard spec), 25, 30. **Effort:** xhigh (it deletes a person's files).

- [ ] **Step 1: Write the failing tests.**
  - `removal.spec.ts`: `on Linux a root is one of the two XDG roots, exactly`: `/h/.local/share/harness` and `/h/.local/state/harness` pass with home `/h`; `/h/.local/share`, `/h/.local/share/harness2`, `/h/.local/share/harness/cli`, `/tmp/harness`, `/h/harness` and a custom `XDG_DATA_HOME`'s parent are refused; a custom absolute `XDG_DATA_HOME=/d` makes `/d/harness` pass. `a root named .harness passes as before`, on every platform. `the program is found per root`: `bin` and `cli`'s bundles in the data root, `runtime` and `pty` in the state root, the marker in the state root; `--keep-data keeps the data root's data and removes both roots' program`.
  - `command.spec.ts`: `it removes the bridge without following a link` (with `--keep-data` the data the links pointed to is whole, and `~/.harness` is gone); `it removes the move lock and both records`; `its lines name both folders`; `with one root every line is today's` (macOS, Windows, a legacy Linux home).
- [ ] **Step 2: Run** `npx vitest run src/lib/uninstall`. Expected: FAIL.
- [ ] **Step 3: Implement.** `checkRoot` takes the roots it may accept beside the name `.harness`: on Linux, `xdgRoots(home, env)`. The plan is built per root from the entries the table gives that root. `deps.ts` hands `command.ts` `removeBridge` and `moveLockPath`. The guard's `removal.ts` entry names the new lines.
- [ ] **Step 4: Run** `npx vitest run src/lib/uninstall src/config/harnessHome.guard.spec.ts`. Expected: PASS. `removal.real.spec.ts` and the Windows specs are the Windows workflow's, unchanged.
- [ ] **Step 5: Commit** `harness uninstall removes both roots and the bridge`.

### Task 37: After the move: the hooks

**Files:** Create `cli/src/engines/hookInstallers.afterMove.spec.ts`.

**Depends on:** 1. **Effort:** high. **No red test:** it pins what the installers already do (they know Harness's hooks by their shape, `engines/kit/notifyHooks.ts:279-305`). One commit. A case that fails is a finding for the report, fixed in the installer it names.

- [ ] **Step 1: Write the spec**, on throwaway engine homes whose files were written with the old tree's commands: `Claude Code's settings name the new node, notify.mjs and data folder, one managed block an event`; `Codex's hooks.json is rewritten and its trusted_hash is the new command's, so nothing needs review`; `Codex's harness.rules names the new cli.js`; `the Agent Messages hook names the new folder`; `the OpenCode, Kilo, Pi and Amp plugins name the new credential and socket`; `a command of the first positional form is still known as Harness's` (`LEGACY_SCRIPT`); `a person's own hook beside ours is kept`.
- [ ] **Step 2: Run** `npx vitest run src/engines/hookInstallers.afterMove.spec.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `test(cli): the hook installers replace the old tree's commands`.

### Task 38: End to end: the move

**Files:** Create `cli/e2e/homeMove.e2e.ts`, `cli/scripts/e2e/home-move-upgrade.sh`. Modify `.github/workflows/tmp-linux-xdg-paths.yml`.

**Depends on:** 2, 8, 32, 35, 44. **Effort:** xhigh.

- [ ] **Step 1: Write the end-to-end spec** (`describe.runIf(process.platform === 'linux')`), the real daemon from the bundle (`E2E_BUNDLE=1`), a throwaway home, a private tmux server, the fake engines and the fake backend (`e2e/harness/`). No override but the first daemon's. The bundle and a copy of the test's Node are laid in `<home>/.harness/cli` and `<home>/.harness/runtime/node-e2e/bin`, so the daemon starts from inside the old tree.
  - `a fresh home writes nothing to ~/.harness`.
  - `an upgrade with agents at work`: a first daemon runs whole on `~/.harness`, held by `ADAPTER_DATA_DIR=<home>/.harness/cli/data` (the folder, and so the tag, a default install has), signed in to the fake backend, with a Claude Code and a Codex agent in panes and one outside any pane. It is stopped; the panes stay. A start without the override moves. Then: each entry is in its root; `~/.harness` holds links and the two real folders only; `computer-id` and `auth/session.json` are byte for byte and the daemon is signed in; the daemon's process runs from the state root's Node (`/proc/<pid>/exe`); both panes are adopted under their old ids; each old agent's next turn reports through its old hook command, from the pane and from outside any pane; an event written while the daemon is down lands in the new data folder; nothing is in `~/.harness` that the bridge service did not put there; a new Claude Code and a new Codex agent report, and Codex asks for no review.
  - `the bridge goes when the old agents end`: with the old agents ended and the daemon started again, `~/.harness` is gone, `bridge.json` too, the record says `moved`; the test's own shell, older than the move, does not hold it. With one old agent left, it stays.
  - `a connection's shim from before the move still answers` (an MCP shim started with the old socket path).
  - `harnesses are set up again, and the bridge waits for them`: two packages installed before the move with `harness dsh install <path>` from git repositories the test makes in its temporary folder (not linked), one whose setup writes `$HARNESS_DSH_DIR` into a file, one whose setup fails after the move (it fails when that folder is not under `~/.harness`). After the move, with no old agent left: the first package's file names its new folder; `harness dsh list` shows the second `· needs setup`; the bridge goes once the first has run, and not before (its setup waits on a file the test writes; each check is made by starting the daemon again, as in the case above). Then `harness dsh update` on the second, with its setup made to pass (it also passes when a file the test writes exists), runs its setup again and its row loses `· needs setup`.
  - `a home too long for a socket beside the data folder`: the old hook reaches the daemon through the short folder's link.
  - `with no master` (`HARNESS_NO_MASTER=1`, as Harness OS runs): the same move, the bridge kept by the service in the core's process.
  - `a unit harness service install wrote is rewritten and reloaded` (the suite's fake `systemctl`, `e2e/harness/fakePlatform.mjs`).
  - `a move that fails rolls back and the daemon serves ~/.harness` (the state base made read-only).
  - `from a released build` (only with `MIGRATION_FROM`, as `e2e/migration.e2e.ts`): the first daemon is the release's.
- [ ] **Step 2: Run** on Linux: `E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/homeMove.e2e.ts`. On a Mac the file is skipped whole; its run is the workflow's.
- [ ] **Step 3: Write `home-move-upgrade.sh`**: in `$1` (a throwaway home) with `ADAPTER_UPDATE_DISABLE=true` and `BACKEND_WS_URL=ws://127.0.0.1:9`: install the published release with its own `install.sh`; `harness start`; record `computer-id` and a list of every file with its mode and sha256; `harness stop`; install this checkout's build over it (`install-cli.sh --no-updates`); `harness start`; check the list against the two roots, `computer-id`, that `harness --version` and `hn --where` run from `PATH`, and that `~/.harness` holds links and the two real folders only; `harness stop && harness start`; check `~/.harness` is gone. Then, in a second empty home: install this build, start, check there is no `~/.harness`. It prints the tree's size and the move's time from the record. It never signs in and names no account.
- [ ] **Step 4: Add two jobs** to the workflow: `home-move-e2e` (tmux, zsh, the bundle; Step 2's command, then once more with `MIGRATION_FROM` set to the published `cli.js` and `notify.mjs`, downloaded from the public manifest and checked against its sha256) and `upgrade` (`bash cli/scripts/e2e/home-move-upgrade.sh "$RUNNER_TEMP/home"`). Both upload their logs for seven days. `actionlint` prints nothing.
- [ ] **Step 5: Commit** `test(cli): the move, end to end` (the spec red on Linux before Tasks 32 and 35 are in the bundle: the first push's job is the evidence).

### Task 39: CLI: existing specs on Linux

**Files:** only spec files the `units` job names as failing, from this list: `cli/src/lib/runtimeInstall.spec.ts`, `launchers.spec.ts`, `harnessRuntimeIgnore.spec.ts`, `homeDataFolder.spec.ts`, `nodeReferences.spec.ts`, `engineAccount.spec.ts`, `shellContextReply.spec.ts`, `localCredential.port.spec.ts`, `computerIdentity.spec.ts`, `callerPane.spec.ts`, `startIfDown.spec.ts`, `signOut.spec.ts`, `connectors/call.spec.ts`, `connectors/connectors.spec.ts`; `cli/src/engines/kit/downloadMarker.spec.ts`, `nativeInstallProcess.spec.ts`, `cli/src/engines/prepareNativeLaunch.spec.ts`; `cli/src/tui/launcher.spec.ts`, `install.spec.ts`, `update.integration.spec.ts`; `cli/src/config/envIsolation.spec.ts`, `cli/src/cliCommand.spec.ts`, `cli/src/coreProcess.spec.ts`; and, after Verification 3's run, `cli/e2e/cli.e2e.ts`, `cloudAgents.e2e.ts`, `developerState.e2e.ts`, `enginehomes.e2e.ts`, `freshMachineEngines.e2e.ts`, `cli/e2e/harness/daemon.ts`; `daemons/e2e/sandbox.mjs`, `daemons/e2e/daemons.e2e.test.mjs`.

**Depends on:** 1, 2. **Effort:** high. **No red test:** the specs are the tests. PR CI and every developer's Mac ran them on `~/.harness`; on a Linux runner their throwaway home is empty, so a default path is now under the XDG roots. Their red run is the `units` job of the first push after Task 1.

- [ ] **Step 1: Read the job's CLI legs.** A spec not red there is not edited. A red spec that is not on the list and not another task's is reported, not edited.
- [ ] **Step 2: Fix each expectation** by the rule it tests: a spec about where a default lives takes the path from the module with the home it passes; a spec that pins the layout before the move makes its home a legacy one first (`<home>/.harness` exists). No assertion is weakened, and no production file is edited. `connectors/call.spec.ts` and `homeDataFolder.spec.ts` each gain one case with two roots: a file under the state root is refused by the read fence, and a data folder under the data root counts as the account's.
- [ ] **Step 3: Run** each edited spec on the Mac (still green), then read the next push's `units` job. Expected: every CLI leg green.
- [ ] **Step 4: Commit** `test(cli): the specs that read a default path say which layout they mean`.

### Task 40: Desktop: existing tests on Linux

**Files:** only `desktop/test/*_test.dart` files the `units` job's Desktop leg names as failing that Tasks 12 to 14 and 45 do not own (the store's, the lease's, the marker's, the log's and the setup's tests are the likely ones); a `mobile/test` file only if `mobile-checks` reads a changed Desktop file and fails.

**Depends on:** 2, 12, 13, 14. **Effort:** high. **No red test:** as Task 39.

- [ ] **Step 1: Read the job's Desktop leg.** A test not red there is not edited; a red one outside `desktop/test` is reported.
- [ ] **Step 2: Fix each expectation** as in Task 39: a test hands its home to `HarnessHome.of` with a look, or makes a legacy home. `test/windows_known_failures.txt` is not edited.
- [ ] **Step 3: Run** the edited files on the Mac, then read the next push's job. Expected: the Desktop leg green.
- [ ] **Step 4: Commit** `test(desktop): the tests that read a default path say which layout they mean`.

### Task 41: Docs and the release note

**Files:** Modify `docs/cli.md`, `docs/app.md`, `docs/development.md`, `cli/README.md`, `desktop/README.md`, `CHANGELOG.md`.

**Depends on:** none. **Effort:** medium. **No red test:** docs, one commit.

- [ ] **Step 1: Write.** Where a doc says a file is in `~/.harness`, it says the folder for each platform: on Linux the data root (`$XDG_DATA_HOME/harness`, by default `~/.local/share/harness`) or the state root (`$XDG_STATE_HOME/harness`, by default `~/.local/state/harness`), and which entries are in each (the table); on macOS and Windows `~/.harness` as before. `docs/cli.md` gains: the root rule in three lines; that a move happens at the next start and what holds it (`harness status` says which); that `XDG_DATA_HOME` and `XDG_STATE_HOME` must be set for the whole session (`~/.config/environment.d/` or `~/.profile`), since each process reads them itself, and that `harness service install` carries them into the unit. The spec's release note goes in `CHANGELOG.md` word for word; its last sentence carries the two accepted limits (answers 5 and 6): an `hn` left open across the move needs opening again for shell context, and agents in a forked community project start fresh sessions there. `docs/cli.md` also says, in one line each, that after a move the Store sets each harness up again, that a harness whose setup fails says `Needs setup` on its Store page (`needs setup` in `harness dsh list`), and that `harness dsh update <id>` or the page's `Update` button sets it up again.
- [ ] **Step 2: Check** every link in the edited files resolves. Docs name no person and direct no agent.
- [ ] **Step 3: Commit** `docs: where Harness keeps its files on Linux`.

### Task 42: CLI: the agent browser's containers stay this daemon's

**Files:** Modify `cli/src/services/agentBrowser.ts:103-106`. Test: `cli/src/services/agentBrowser.spec.ts`.

**Depends on:** 1. **Effort:** high.

- [ ] **Step 1: Write the failing tests:** `the label is the folder's old spelling when the data folder is the default one under the XDG roots` (`/h/.harness/cli/data` for `/h/.local/share/harness/cli/data`), so a browser started before the move is found after it; `a data folder set by ADAPTER_DATA_DIR labels as given`; `macOS and a legacy home label as before`.
- [ ] **Step 2: Run** `npx vitest run src/services/agentBrowser.spec.ts`. Expected: FAIL on the first.
- [ ] **Step 3: Implement** in the one place the label is built: a data folder equal to `join(harnessPath('cli'), 'data')` is labelled `join(legacyHarnessPath('cli'), 'data')`.
- [ ] **Step 4: Run** the spec and `npm run test:core`. Expected: PASS, 100% per file.
- [ ] **Step 5: Commit** `An agent's browser stays its daemon's when Harness's folder moves`.

### Task 43: Store: harnesses set up again after the move

**Files:** Modify `cli/src/dsh/installed.ts`, `cli/src/services/store.ts`. Create `cli/src/dsh/setupAgain.ts`. Test: `cli/src/dsh/installed.spec.ts`, `cli/src/dsh/setupAgain.spec.ts` (new), `cli/src/services/store.spec.ts`.

**Depends on:** none (the mark's text, `setup: 'pending'`, is fixed here and in Task 27). **Effort:** xhigh (it runs every package's setup on a person's machine, concurrently).

**Interfaces:**
- Produces:
  ```ts
  // dsh/installed.ts
  export type SetupMark = 'pending' | 'needs-setup'
  // InstalledDshRecord gains: setup?: SetupMark   (set to 'pending' by the move of Harness's folder, Task 27)
  /** Packages whose setup has yet to run again after the move. 'needs-setup' does not count. */
  export function setupsPending(records?: readonly InstalledDshRecord[]): number   // default: readInstalledIndex()
  /** Sets or (null) removes one record's mark, through writeInstalledIndex. */
  export function markSetup(id: string, setup: SetupMark | null): void
  // dsh/setupAgain.ts
  export const SETUP_AGAIN_AT_ONCE = 2
  export interface SetupAgainDeps { records(): InstalledDshRecord[]; resolve: typeof resolveInstalled; lock: typeof lockDsh
    finish: typeof finishInstall; mark: typeof markSetup; log(line: string): void }
  export async function setupAgain(deps?: SetupAgainDeps): Promise<{ done: number; needsSetup: number; busy: number }>
  ```
  `StoreDeps` gains `setupAgain: typeof setupAgain`.

- [ ] **Step 1: Write the failing tests.**
  - `setupAgain.spec.ts`: `at most two setups run at once`: five pending records, a `finish` whose promises the test resolves one by one; the most in flight is 2, and all five end with no mark. `a setup that fails marks needs-setup and logs one line`: `finish` answers `SETUP_FAILED`; the record is `needs-setup`; the log holds exactly `[dsh] a/b needs setup · SETUP_FAILED` (no path, no detail). `a setup that ran clears the mark even when the doctor then complains` (`DOCTOR_FAILED`). `a package that no longer loads is needs-setup` (`resolve` gives a broken one). `a linked package, or one with no mark or needs-setup, is not touched`. `a package another process holds stays pending, with no line` (`lock` gives null; `busy` counts it). `nothing pending runs nothing`.
  - `installed.spec.ts`: `a record keeps its setup mark through a read and a write`; `setupsPending counts pending only`; `markSetup with null removes the field`.
  - `store.spec.ts`: `the Store sets up again what the move left, after it puts the built-ins in place` (call order `prepare`, then `setupAgain`); `its requests do not wait for it` (`dsh_list` answers while `setupAgain` has not settled).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/dsh/setupAgain.spec.ts src/dsh/installed.spec.ts src/services/store.spec.ts`. Expected: FAIL (no module, no field).
- [ ] **Step 3: Implement.** `setupAgain` takes the records marked `pending` that are not linked, and runs at most `SETUP_AGAIN_AT_ONCE` at once. For each: `lock(id)` (null: leave it); `resolve(record)` (broken: `needs-setup`); `finish(resolved, { source: record.source }, true)`, which runs the setup at the package's new folder, then its viewer and its doctor; then `mark(id, null)` when the setup ran (ok, or `DOCTOR_FAILED`, `VIEWER_UNAVAILABLE`), else `mark(id, 'needs-setup')` and the one log line; then unlock. `finishInstall` writes the record it was given back, mark included, so the mark is set after it. `startStore` calls `void deps.setupAgain().catch(log)` after `deps.prepare`, in the Store's process (the core's only when there is no master, as every service).
- [ ] **Step 4: Run** the three specs, `npm run test:portability` and `npm run test:core`. Expected: PASS, 100% per file where the gate asks it.
- [ ] **Step 5: Commit** `The Store sets each harness up again after Harness's folder moves`.

### Task 44: Store: a harness that needs setup says so, and an update sets it up again

**Files:** Modify `cli/src/dsh/wire.ts` (`dshListRows`), `cli/src/dsh/command.ts` (`list`), `cli/src/dsh/update.ts:26-80` (`updatePackage`). Test: `cli/src/dsh/wire.spec.ts`, `cli/src/dsh/command.spec.ts`, `cli/src/dsh/update.spec.ts`.

**Depends on:** 43 (the record's `setup`). **Effort:** high.

- [ ] **Step 1: Write the failing tests:**
  - `wire.spec.ts`: `an installed row says needsSetup when its record is needs-setup`, and has no `needsSetup` key when the record is `pending` or unmarked.
  - `command.spec.ts`: `harness dsh list ends a needs-setup row with "· needs setup"`, and the other rows are as before.
  - `update.spec.ts`: `an update runs the setup again for a needs-setup package that is up to date` (the record is `setup: 'needs-setup'` and the clone's commit and revision are the record's: no `already up to date` line, the setup runs at the package's folder, the result is ok, and the record written has no `setup` key); `an up-to-date package with no mark still returns at once` (as today); `an update that commits clears any mark` (a `pending` record with a new revision); `an update whose setup fails leaves the mark and the previous folder` (the record still `needs-setup`, the folder's bytes as before).
- [ ] **Step 2: Run** `npx vitest run src/dsh/wire.spec.ts src/dsh/command.spec.ts src/dsh/update.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement:** the installed row spreads `needsSetup: true` when `entry.setup === 'needs-setup'`; the list line appends ` · needs setup` in the same case. In `updatePackage`, the `already up to date` return is skipped when `record.setup === 'needs-setup'`, and `installed` is built from the record without its `setup` field, so the record `finishInstall` writes on commit has no mark; a failed update restores the previous folder and leaves the index as it was (today's rollback). The Store's `dsh_update` already calls this path (`services/store.ts:62-67`): no new request.
- [ ] **Step 4: Run** the three specs and `npm run test:portability`. Expected: PASS.
- [ ] **Step 5: Commit** `A harness whose setup failed after the move says Needs setup, and an update sets it up again`.

### Task 45: Desktop: the Store shows Needs setup, with its Update button

**Files:** Modify `desktop/lib/core/dsh_catalog.dart` (`DshEntry`, `:151`), `desktop/lib/store/store_screen.dart:1181-1189` (`_update`'s guard), `:1317-1319` (the page's `hasUpdate`), `:1766-1771` (the status line). Test: `desktop/test/store_page_test.dart`.

**Depends on:** none (the wire key `needsSetup` is fixed by Task 44's plan). **Effort:** high.

- [ ] **Step 1: Write the failing tests** in `store_page_test.dart`, clicking as a person does:
  - `a harness that needs setup says so on its page`: the machine's `dsh_list` has the package installed with `needsSetup: true` and no update available; the test opens the Store, taps the package's tile and finds `Needs setup` and no `Installed`; with `needsSetup` false the page says `Installed` as before.
  - `the Update button sets up again a harness that needs setup`: on that page `store-primary-action` reads `Update`; a tap sends one update (`app.updates` is `[('machine-1', id)]`, `app.installs` empty); in the Store's grid the tile shows neither `Needs setup` nor `Update available`.
- [ ] **Step 2: Run** `cd desktop && flutter test test/store_page_test.dart`. Expected: FAIL on both.
- [ ] **Step 3: Implement.** `DshEntry` gains `final bool needsSetup` read as `raw['needsSetup'] == true`, and `bool get canUpdate => installed && !linked && (updateAvailable || needsSetup)`. The package page's `hasUpdate` and `_update`'s guard read `canUpdate`; `store_listing.dart` keeps `hasUpdate`, so the grid is unchanged. In the status line, an installed row that needs setup reads `Needs setup`, before the linked and update cases. No new element and no new request: the button, its copy and `updateDsh` are today's.
- [ ] **Step 4: Run** the test file and `flutter analyze lib/core lib/store`. Expected: PASS, no issue.
- [ ] **Step 5: Commit** `Desktop: the Store says when a harness needs setup, and Update sets it up again`.

### Task 46: Store: `runtimes.sh` follows the rule, every copy

**Files:** Modify `store/tools/runtimes.sh`. Test: `store/tools/test_runtimes.py`. Regenerate every copy `node store/tools/sync-runtimes.mjs` writes (`store/agents/*/toolchain/runtimes.sh`, `store/viewers/*/runtimes.sh`; 56 copies beside the source at PR 1's head); no copy is edited by hand.

**Depends on:** none. **Effort:** high (every package's setup sources it).

- [ ] **Step 1: Write the failing tests** in `test_runtimes.py`, with the `Box`'s `uname` stub and its home: `test_linux_fresh_home_puts_the_runtime_in_the_state_root` (`HARNESS_RUNTIME` is `$HOME/.local/state/harness/runtime`); `test_linux_home_still_on_dot_harness_keeps_it`; `test_linux_moved_home_uses_the_state_root_with_a_bridge_there` (the data root and `~/.harness` both exist); `test_xdg_unset_empty_or_relative_is_ignored_absolute_is_used`; `test_darwin_keeps_dot_harness_whatever_exists`; `test_adapter_runtime_dir_still_wins`; `test_harness_node_reads_current_node_from_the_state_root`; `test_a_venv_on_the_old_trees_python_is_made_again` (a venv whose `pyvenv.cfg` `home` is under `$HOME/.harness/` while the runtime is in the state root: `uv venv` is called; the same venv on a home still on `~/.harness` is kept).
- [ ] **Step 2: Run** `python3 -m unittest store/tools/test_runtimes.py`. Expected: FAIL on the Linux cases.
- [ ] **Step 3: Implement** one function `_harness_state_root` before `HARNESS_RUNTIME` is set: off Linux (`uname -s`) `$HOME/.harness`; on Linux the rule (`XDG_DATA_HOME` and `XDG_STATE_HOME` used only when they start with `/`). `HARNESS_RUNTIME="${ADAPTER_RUNTIME_DIR:-$(_harness_state_root)/runtime}"`. `harness_venv` keeps a venv only when, beyond its version check, neither its `pyvenv.cfg` nor the first line of its `bin/pip` names `$HOME/.harness/` while `HARNESS_RUNTIME` is not under it. The header's `~/.harness/runtime` becomes "Harness's runtime folder". Then `node store/tools/sync-runtimes.mjs`.
- [ ] **Step 4: Run** `python3 -m unittest store/tools/test_runtimes.py`, `node store/tools/sync-runtimes.mjs --check` (prints nothing), `cd cli && npx vitest run src/dsh/store.spec.ts`, and the package tests that compare their copy (`git grep -l "runtimes.sh" -- 'store/agents/*/toolchain/test_*.py'`, each with `python3 -m unittest`). Expected: PASS.
- [ ] **Step 5: Commit** `Store: runtimes.sh finds Harness's runtime by the rule, in every package`.

### Task 47: Store: Score's runtime and the hands-on tool

**Files:** Modify `store/agents/score/skills/score/scripts/lilypond.mjs:22` (`runtimeRoot`), `store/tools/try-hands-on.mjs:106`. Test: `store/agents/score/test/installer.test.mjs`.

**Depends on:** 18 (`harnessRoots` in `store/tools/local-daemon.mjs`, for the hands-on tool). **Effort:** medium.

- [ ] **Step 1: Write the failing test** in `installer.test.mjs`: `runtimeRoot follows the rule`: `runtimeRoot(env, platform, exists)` is `<state root>/runtime/score` on a fresh and a moved Linux home, `<home>/.harness/runtime/score` on a legacy one and on macOS; `SCORE_RUNTIME_DIR`, then `ADAPTER_RUNTIME_DIR`, still win.
- [ ] **Step 2: Run** `cd store/agents/score && npm test`. Expected: FAIL on the Linux cases.
- [ ] **Step 3: Implement.** `runtimeRoot(env = process.env, platform = process.platform, exists = existsSync)` carries the rule inline (the package installs alone). `try-hands-on.mjs`'s default `runtimeRoot` is `<data root>/dsh/autonomous`, from `harnessRoots()` imported from `./local-daemon.mjs`; it is a developer tool with no test, and its help text names "Harness's dsh folder" in place of `~/.harness/dsh/autonomous`.
- [ ] **Step 4: Run** `npm test` in `store/agents/score` and `node store/tools/try-hands-on.mjs --help`. Expected: PASS, and the help printed.
- [ ] **Step 5: Commit** `Store: Score and the hands-on tool find Harness's folders by the rule`.

### Task 48: Remove the temporary workflow

**Files:** Delete `.github/workflows/tmp-linux-xdg-paths.yml`.

**Depends on:** 1 to 47, and Verification 1 with its evidence recorded in the pull request. **Effort:** medium. **No red test:** one commit.

- [ ] **Step 1: Check** the pull request's body holds the link of the workflow's run on the final head before this commit, every job green.
- [ ] **Step 2: Delete** the file. `git grep -n tmp-linux-xdg-paths -- .github` prints nothing.
- [ ] **Step 3: Commit** `ci: remove the temporary workflow for the Linux paths`.

---

## The pull request's body

Written by the main session, not a task. It carries:

- **What and why:** PR 2 of 2. On Linux, Harness follows the XDG Base Directory paths; an existing `~/.harness` moves once.
- **Platforms:** Linux changes, Harness OS included. macOS and Windows: no path, hook command, launcher, golden file or installer byte changes; the unchanged-bytes `git diff --stat` and the Windows workflows' links.
- **The core and the master:** no new line in `architecture.coreFiles.txt`. `config/harnessHome.ts` gains the root rule (`node:fs` `existsSync`). `engines/kit/homeAdoption.ts` is imported by the move, not changed. `core/main.ts` gains the one wiring line of the `homeBridge` service; `harnessd/services.ts` its name in the edge host; `harnessd/platform.ts` loses its fallback. The move is outside both (`homeMove/closure.spec.ts`).
- **The Design section's numbers** (`docs/feature-design-rules.md`): the move's time and the tree's size from the `upgrade` job; the bridge check's cost (one read of `/proc` every 10 minutes while a bridge exists).
- **Evidence:** each task's red commit; the temporary workflow's run on the final head; the hand-started runs' links; the `harness-local-checks` fence.
- **Known and accepted:** a harness launched from an old process with the home as its workspace; a socket link that cannot be made across filesystems; an `hn` left open across the move has no shell context until opened again; sessions in a forked community project lose their engine's resume and trust; a package's own setup that skips work it finds in place through the bridge (only `runtimes.sh`'s venv check is taught to tell); the agent browser's containers keep their old label; the orchestrator's prompt files of a run that spans the move name the old Node and `cli.js` (its agent holds the bridge).
- **Profile ids:** they follow the moved folder; no store holds one (the inventory), so none is converted.
- **Release order:** Desktop, the companions and the store packages ship with or before the CLI that moves.

## Verification

**Never touched:** the developer's real `~/.harness`, `~/.local/share/harness`, `~/.local/state/harness`, `~/.claude`, `~/.codex`, everyday daemon (port 18473), tmux server, any real account, any backend but the suites' fake one, production. Every check uses a throwaway home on a GitHub runner or the suites' own isolation. The docker boxes (`machine-remote-1`, `-2`) are not used: their image sets `ADAPTER_DATA_DIR` inside `~/.harness`, so they never move.

**Turns.** The tester runs the hand-started GitHub runs (checks 3, 4, 5) one after another, each started once the previous has finished (the account runs at most 20 jobs at once).

**1. The temporary workflow** (`.github/workflows/tmp-linux-xdg-paths.yml`, by itself at each push to `feat/linux-xdg-paths`)
- `units`: the CLI's unit suite in four shards, Desktop's VM suite, `cargo test` for `tui` and the Device app, all on Linux, where a throwaway home is a fresh XDG one. A person sees every leg green.
- `tui-native`: `hn` built from the branch against its native fixtures, each in its own home. A person sees every fixture pass; `welcome` and `fresh-user` read and write under `<home>/.local/share/harness/tui`, `shell-integration` finds its requests under `<home>/.local/state/harness/shell-requests`.
- `home-move-e2e`: `cli/e2e/homeMove.e2e.ts` on a real daemon, tmux and the fake engines, in a throwaway home with a fake backend and a test sign-in, then once more from the published release's bundle. A person sees each case of Task 38 pass: the old agents' turns still arrive, their panes are adopted, harnesses are set up again (one says `needs setup` until `harness dsh update` sets it up), the bridge goes once the agents end and the setups have run.
- `upgrade`: `home-move-upgrade.sh`. A person reads, in the job's log: the published release installed and started; this build installed over it; `home move: moved · data … · state …`; the file list matching; `harness` and `hn` running from `PATH`; `~/.harness` holding links only, then gone after the next start; a fresh install with no `~/.harness`; the tree's size and the move's time.
- Evidence: the run of the final head before Task 48 removes the file. Its link goes in the pull request.
- Proposal, not built here: none. `e2e/homeMove.e2e.ts` runs with the nightly CLI end to end from then on.

**2. In PR CI, by itself**, once the pull request is ready: `cli-typecheck` and `cli-tests`, `companions`, `pty-checks`, `desktop-tests` (and `mobile-checks` if a file the phone's tests read changed), `tui-test`, `device-app-checks`, `os-checks`, `process-checks` (a `store/` change runs the CLI's and Desktop's suites, which read it). A person sees `ci/required` green. Nothing is started by hand.

**3. CLI end to end** (every user-facing flow on a Linux home that is now an XDG one)
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `feat/linux-xdg-paths` (`.github/workflows/cli-e2e.yml`). Eight Linux shards and the macOS disk-full job; isolation is the suite's own (`cli/e2e/harness/daemon.ts`).
- A person sees every shard pass, `e2e-summary` green, `homeMove.e2e.ts` among the files. The link goes in the pull request.

**4. Windows** (nothing changes there)
- On GitHub, by hand, once on the final head, after check 3: Actions → Windows → Run workflow, branch `feat/linux-xdg-paths`, inputs as they are (`.github/workflows/windows.yml`).
- A person sees both architectures pass as on `main`: `cargo test` for `pty` and `tui`, the Windows CLI specs, "Check the install" and "Uninstall, and check nothing is left".

**5. Windows desktop**
- On GitHub, by hand, once on the final head, after check 4: Actions → Windows desktop → Run workflow, branch `feat/linux-xdg-paths`, `release` off (`.github/workflows/windows-desktop.yml`).
- A person sees the suite pass on x64 and arm64 against `desktop/test/windows_known_failures.txt`, with no new failure.

**6. Local gates on this Mac**, at the final head, recorded in the pull request (PR CI does not run them):
- `python3 scripts/local-checks.py --run` from a clean tree. These paths select `cli-core` (`src/core/main.ts`, `src/services/`), `cli-harnessd` (`src/harnessd/`) and `cli-portability` (`src/dsh/`). Its fence goes in the pull request's body before the tested commit is pushed.
- `make desktop-test`: not selected by the paths, run because Desktop reads these folders on a Mac and must read them as before.
- `cd device-app/ui && npm run build && cd ../src-tauri && cargo test --locked`: PR CI compiles the Device app's Linux code only.
- `cd cli && RUN_REAL_TMUX_DISCOVERY=1 npx vitest run src/homeMove/panes.real.spec.ts`: the retag against a real tmux, on a private server.
- The store packages' own tests, which no PR check names: `node --test store/tools/*.test.mjs`, `node --test test/*.test.mjs` in `store/tools/local-ai`, `store/agents/autonomous-grid` and `store/agents/machine-monitor`, `node --import ./test/setup.mjs --test test/*.test.mjs` in `store/agents/harness-monitor`, `npm test` in `store/agents/memories` and `store/agents/score`, `python3 -m unittest store/tools/test_runtimes.py`, `node store/tools/sync-runtimes.mjs --check` (no output).
- The unchanged-bytes check of the first Global Constraint: no output.
- `cd cli && npx vitest run src/config src/homeMove --reporter=verbose`: the rule in both layouts and every step of the move, on throwaway folders. Nothing is installed.
- Not needed: `test:resume`, `test:orchestrator`, `test:sharing`, `test:remote-viewers`, `test:local-models`, the serial specs, a firmware build, an OS image. Harness OS's setup is covered by `os-checks`, and its no-master start by check 1's `with no master` case.

**7. Needs the user themselves:** none. **Against production:** none, and never.

## Open questions

Open questions: none. The draft's nine and the three that followed are answered (Decided).

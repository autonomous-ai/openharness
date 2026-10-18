# Sub-project C plan: reconciliation report

Stitched plan: `docs/superpowers/plans/2026-10-18-windows-desktop.md` (amber-heron). 27 tasks: C1.1–C1.6, C2.1–C2.4,
C3.1–C3.7, C4.1–C4.7, C5.1–C5.3. Each phase's "notes for reconciliation" section was replaced by a "Phase C<N> rulings"
list. Files edited: the five phase files and `00-header.md` in this folder, the stitched plan, and the spec
`docs/superpowers/specs/2026-10-18-windows-desktop-design.md`. Nothing was committed.

## Seams and fixes

| # | Seam | What was wrong | Fix |
|---|---|---|---|
| 1 | Install command | The header and spec had B's bare line. C1.3 builds a different one. | The header (Global Constraints, CLI install) and spec §1.4 now give C1.3's line: full `SystemRoot` PowerShell path, UTF-8 output, `irm '<url>' -ErrorAction Stop`, `; exit $LASTEXITCODE`. C5.2's evidence check quotes it. C1.3's text no longer calls it "the header's line plus…". |
| 2 | Daemon port | The app dialled `127.0.0.1:18473` for everything but the trusted routes. On a shared PC, `hookServer.ts` (`allowPortFallback`) puts the second user's daemon on a random port and records it in `daemon-18473.json` (`daemonRecord.ts`; the CLI's clients read it through `savedDaemonPort`). The second user's app would then probe the first user's daemon. It would read "a daemon for a different computer" (`computer-id` is per user), never spawn its own, and hang. | **Real issue.** New C2.3 Steps 7–9, with full code: `readDaemonTcpPort` in `daemon_pipe_record.dart`; `LocalDaemonTransport.recordedPort`, `tcpBase` and `refreshTcpBase`; discovery probes the recorded port and reports `down` while there is no record; `LocalDaemonHttpAdapter` rewrites the daemon's address to the recorded port; `shared_harness_panel.dart` builds its local WS address from `tcpBase`. New test `test/daemon_tcp_port_test.dart` (5 cases). Steps 7–9 of C2.3 were renumbered 10–12, and the neighbours, analyzer list and `git add` were extended. The CLAUDE.md bullet (C2.4) says it, the header's "Trusted routes" says it, and spec §1.6 has a "loopback port" paragraph. |
| 3 | Clipboard and other channel names | The header said `readImage`. | The real Dart names (checked in `native_clipboard.dart`, `installed_fonts.dart`, `fork_inbox.dart`, `system_notifications.dart`) are `readImagePng`, `writeImagePng`, `readFilePaths`, `listFonts`, `ready`/`open`, `authorize`/`show`/`withdraw`. The header's Method channels section now lists them all. Spec §2.5 says `readImagePng` and adds `writeImagePng`, and §2.1 mentions `tag`/`launch`. C3.5 no longer calls it a refinement. |
| 4 | Launcher bin name | The header's file map said bin `Harness`. | `harness-desktop-launcher`, renamed to `Harness.exe` by `package-windows.ps1`. The header (Names, file map) and spec §3.1 say it. C1, C3 and C5 never named the bin, so they needed no change. |
| 5 | C4's layout additions | They were missing from the header and spec §3. | The header's Install layout has `Harness.ico` and `launch-state.json`, the zip shape has `Harness.ico`, and there is a new "Launcher command line" block (`--wait-pid`, `--install`, `--uninstall`, `--version`, exit codes) and a new Uninstall block (every `.harness\desktop-app*`). Spec §3.2 layout and launcher bullets, §3.3 (zip shape, `--install --wait-pid`, icon, install over a running version), §3.4 (`--wait-pid` on relaunch, rollback through `launch-state.json`) and §3.5 (every `desktop-app*`) were updated. C5.2's uninstall check expects every `desktop-app*` folder gone. |
| 6 | WM_HARNESS_QUIT | C3.1 had `WM_APP + 0x51`, posted to a message-only window found by SID name. C4 had `RegisterWindowMessageW(L"Autonomous.Harness.Quit")`, posted to `FLUTTER_RUNNER_WIN32_WINDOW` windows of processes from the install. | **One definition, the registered message.** C3.1 now defines `kHarnessQuitMessageName`, `HarnessQuitMessage()` and `IsHarnessQuitMessage()` (0 is never matched). The main window (`FlutterWindow::MessageHandler`, above C3.4's anchors so later replacements still apply) and the single-instance window both quit on it. `--quit` posts the registered message. The contract test pins the name. A "quit contract" block is word for word the same in C3.1 and C4.3, and the header has it too. C4's Rust code was already right. |
| 7 | Windows CI workflow | Five tasks edited `windows-desktop.yml` with "if C1 has…" hedges. C2.4 added a second `setup-node`. C4.1 might add Rust twice. C4.7 used `subosito/flutter-action` (which C1 had ruled out), `inputs.release` in job `if:` (empty on push), artifact names colliding with build-test's, two URL dart-defines and no staging flag. Dispatch was impossible before merge. | Every edit is now definite, and the final order is in the header's "Shared files". C2.4 drops its `setup-node` (C1.4 has one) and appends `npm ci` plus the pipe test at the end of the job. C3.7 comes after C2.4. C4.1 adds `dtolnay/rust-toolchain@stable` once, after checkout. C4.7 adds a `mode` job that every job `needs`. Its release jobs install Flutter as C1.4 does, its artifacts are `harness-desktop-zip-windows-<arch>`, it passes only `--dart-define=HARNESS_STAGING=true`, its concurrency gives release runs their own group (never cancelled, never cancelling), and its spec test was rewritten. **Pre-merge release path:** the TEMPORARY subject path, so a push whose head commit's subject is `ci(windows): desktop staging release <v>` (or `… dry run <v>`) runs the release mode. C4.7 Step 6 does a dry run that way. C5.2 Steps 1 and 6 publish N and N1 that way. C5.3 removes the trigger, the six `# TEMPORARY` lines and the concurrency term, with asserts, and its spec test checks that `head_commit` is gone. |
| 8 | homeDir | C2.2 assumed `homeDir` returns `''`. C1.1's `homeDir` throws, and `maybeHomeDir` returns null. | C2.2 consumes `maybeHomeDir` and checks for null. The header's interface states both behaviours. |
| 9 | Updater guard | C1.6 adds `_isWindows`, the `isWindows` parameter, a default and a `!_isWindows` term in `canCheck`. C4.5 added the field and parameter again (a duplicate, so a compile error) with a different default. It did not remove C1.6's test "Windows offers no update until its own branch exists", which would fail, and its `sed` would have doubled that test's `isWindows:`. | C4.5 now keeps C1.6's parameter, field and default, adds only `windowsInstallRoot`/`startDetached`, replaces `canCheck` with the guard-free form, uses the same default rule for the architecture, deletes C1.6's test before the `sed`, and updates the CLAUDE.md self-update sentence. Its Step 2 expectations were fixed. |
| 10 | Staging flag | C1.3 defined `kHarnessStagingBuild`. C4.7 passed URL overrides instead, and C4.5 had no staging manifest. | `kHarnessStagingBuild` moved to a new `lib/core/staging_build.dart` (C1.3), so the updater need not import the provisioner. C4.5 adds `desktopUpdateMetadataUrl({override, staging})` with the staging manifest, plus a test. C4.7 builds with `--dart-define=HARNESS_STAGING=true` only, and its spec test refuses the two URL defines. RELEASE.md text, the header and spec §3.4/§3.6 follow. |
| 11 | Shared files | C2.4's `app_state.dart` diff carried C2.3's `_conn` hunk again (double application). | That hunk was removed from C2.4. The header lists the edit order for `app_state.dart`, `swarm_screen.dart`, `desktop_updater.dart`, `desktop/CLAUDE.md`, the workflow and `windowsWorkflows.spec.ts`. Checked: C1.6's and C2.4's CLAUDE.md hunks do not overlap. `api_client.dart` and `scripts/ci-plan.py` have one editor each (C2). C3.4/C3.6 on `swarm_screen.dart` are sequenced by C3. |
| 12 | Windows test baseline | `MUST_PASS` held only C1's files. C3.6's move of `linux_menu_bar_test.dart` would orphan its baseline entries. | `MUST_PASS` (C1.4) lists every Windows test file of C1–C4 from the start, including the new `daemon_tcp_port_test.dart`. Rule: the baseline is written once and only shrinks. C3.6 Step 3 renames `test/linux_menu_bar_test.dart::` entries to `test/in_window_menu_bar_test.dart::` (that shared test is deliberately not in `MUST_PASS`). |
| 13 | `windowsWorkflows.spec.ts` count | C5.3 said "three existing cases". | C4.7 adds one before it, so it is four now, and C4.7 says "B's three and this one". |
| 14 | C1.6 gate table | It said self-install was C4.4's. | It is C4.6's. |
| 15 | Stale header refinements | Several tasks said "the header says X, refined to Y". | Now that the header matches, the wording was removed (C1.3, C1.5, C3.4, C3.5, C3.6, C4.2, C4.3, C5.1). |
| 16 | 18473 on the VM (C5) | The reason given was "the app is fixed to 18473". | The STOP rule is kept with the new reason: the daemon there is not this run's, and B's PTY driver and the checks assume 18473. |

## Rulings (reconciliation)

1. **Daemon port: real issue.** The fix is C2.3 Steps 7–9. The trusted routes still use the pipe, and TCP follows the recorded port. Without a record, discovery asks nothing on 18473, so it never takes another user's daemon for this one. A daemon writes its record right after binding.
2. **WM_HARNESS_QUIT is the registered message `Autonomous.Harness.Quit`**, answered on the main window and the single-instance window. It is registered so that it means the same in every process and cannot collide with `WM_APP` traffic. It is the main window because C4's launcher already finds that window by class plus image path, without computing the SID instance name (which carries test and debug suffixes).
3. **The pre-merge release runs through a commit-subject path on the TEMPORARY push trigger**, decided by a `mode` job. Dispatch needs the file on `main`, and C5's E2E needs two staging releases before merge. The empty commits are pushed while the PR is a draft, so PR CI runs its process checks only. C5.3 removes the path.
4. **One staging flag.** `HARNESS_STAGING` picks both the staging `install.ps1` and the staging desktop manifest. The URL defines stay test overrides.
5. **`kHarnessStagingBuild` lives in `lib/core/staging_build.dart`**, because both bootstrap and update read it.
6. **Workflow structure.** Node is set up once (C1.4), Rust once (C4.1), and Flutter the same way in every job (git clone of the pin). Release artifacts have their own name, and release runs have their own concurrency group.
7. **The baseline only shrinks.** `MUST_PASS` names every Windows test file of C1–C4 up front.
8. **The bin name, layout files, `--wait-pid` and the uninstall of every `desktop-app*`** are C4's rulings, adopted in the header and spec.
9. **C1.6's updater default survives C4.5.** A caller that passes `isLinux` is describing macOS or Linux.

The phase writers' own rulings are kept in each phase's "rulings" list in the plan.

## Spec coverage map

| Spec | Tasks |
|---|---|
| Decisions 1, 7 (no forced viewer, viewer build stays a viewer; macOS/Linux unchanged) | C1.6; C3.6 (Linux bar pin); C5.3 Steps 6–8 |
| Decision 2 (same shape: services, C++ per feature) | C1.2, C1.3, C3.1–C3.6, C4.5 |
| Decision 3 (FFI pipe client) | C2.2, C2.3 |
| Decision 4 (zip, per-user self-install, version folders) | C4.1–C4.7 |
| Decision 5 (`install.ps1 -Desktop`) | C1.3 |
| Decision 6 (x64 and arm64, x64 fallback) | C1.4 Step 6, C4.5 (architecture), C4.7, C5.2 Step 8 |
| §1.1 Mode | C1.6 |
| §1.2 `homeDir`, HOME readers, chmod, `test -w`, shells | C1.1, C1.3 |
| §1.3 CLI resolution, no console flash | C1.2, C1.5, C5.2 Step 3 |
| §1.4 Readiness, recipe, staging, override, minimum, failure copy | C1.3, C1.6 |
| §1.5 Supervision | C1.5, C1.6 (gate table) |
| §1.6 Connection, pipe, proving, client, fallback, proof vectors, loopback port | C2.1–C2.4 (port: C2.3 Steps 7–9) |
| §2.1 Notifications | C3.2 (link), C3.3 |
| §2.2 Single instance and quit | C3.1, C3.7 |
| §2.3 `harness://` links, key and heal | C3.2, C4.2 |
| §2.4 Tray, hide to tray, Quit | C3.4, C3.6 |
| §2.5 Image paste | C3.5 |
| §2.6 Fonts | C3.5 |
| §2.7 In-window menu bar | C3.6 |
| §2.8 Keys | C3.6 |
| §2.9 Window chrome | C3.6 (unchanged caption bar) |
| §3.1 Names | C1.6, C4.1, C4.7 |
| §3.2 Layout, launcher, AUMID | C4.1, C3.3 (process AUMID) |
| §3.3 First install | C4.2, C4.6 |
| §3.4 Self-update, manifest, staging, swap, cleanup, rollback, `.started`, off switches | C4.4, C4.5, C4.6 (cleanup at start) |
| §3.5 Uninstall | C4.3, C3.1 (quit) |
| §3.6 Staging release | C4.7, C5.2 Steps 1, 6 |
| §4.1 Workflow | C1.4, C1.6, C2.4, C3.7, C4.1, C4.7, C5.3 |
| §4.2 Unit tests | C1.1–C1.3, C2.1–C2.3, C3.4, C3.6, C4.4–C4.6 |
| §4.3 Real Windows CI | C2.4, C3.7, C4.1–C4.4 |
| §4.4 E2E scenarios 1–6, the Mac half | C5.1, C5.2 |
| §4.5 macOS and Linux | C5.3 |
| Known limits (SmartScreen, toast AUMID, TCP credential, `%` in profile) | C5.2 Step 3, C3.3, C4.2 |
| Risks (plugins on arm64, WinRT toasts, FFI client, tray notice) | C1.4 Step 6, C3.3, C2.1–C2.4, C3.4 |
| Out of scope | not planned (D, webview, sqlite3, launch at login, WSL, `hn`) |

Self-review results:
- No `TBD`, `TODO`, "similar to", "fill in" or "add error handling" in the stitched plan. The only grep hit is `toDouble`.
- Cross-phase symbols were checked against the repo: `RuntimePlatform.*`, `runtimeArchitecture`, `revealWindow`, `statusMenu*`, `OnOffPreference`, `hmacSha256`, `kUnderTest`, `GuestTestApp`, `activityInk` (local to `_flushNative`), `flushAppLog`/`appLog`, the Dio 5.8 `RequestOptions.copyWith`/`uri`, `kWindowClassName = FLUTTER_RUNNER_WIN32_WINDOW`, `app_icon.ico`, B's `single_segment`/`read_pointer`/`quote_arg`/`start`/`files::rename`, the CLI's `pipeAuth.ts` exports, `listenLocalSocket`, `attachLocalWsServer`, `gcs.sh` and `runtimeManifest.mjs` functions, `scripts/test-desktop.py` and `make desktop-test`, and the pub dependencies `archive`, `cryptography` and `ffi`.
- **The workflow was assembled from every task's snippet, in task order** (C1.4, C1.6, C4.1 + C4.2, C2.4, C3.7, C4.7), then checked.
  - `actionlint` is clean.
  - C4.7's `windowsWorkflows.spec.ts` case passes.
  - C5.3's case fails before its removal script and passes after it.
  - C5.3's script asserts (three trigger lines, six `# TEMPORARY` lines, the concurrency term twice) hold, and actionlint is clean afterwards.
  - The `mode` script gives the right outputs for a release subject, a dry-run subject, an ordinary push and dispatch inputs, and fails on a bad version.
  - The check found one bug, now fixed: the concurrency values must be YAML-quoted, because the subject prefix holds ": ".
- The other cross-phase names are defined by earlier tasks: C1.3→C4.5 `kHarnessStagingBuild`; C2.2→C2.3 `defaultDaemonDataDir`; C3.4→C3.6 `quitHarness`; C4.5→C4.6 `WindowsUpdateSwap.appExe`/`launcherExe`/`cleanUp`.

## Left for a human

- **Authorize the two staging publishes.** C5.2 Steps 1 and 6 publish to the staging CDN by pushing `ci(windows): desktop staging release <v>` commits. The spec allows staging publishing, but C4's writer had made the real publish "the owner's". Confirm before the first one. A published version is immutable.
- **`kMinimumWindowsHarnessCliVersion = '0.4.20'`** assumes B ships as 0.4.20. Raise it if B's first release is later. No task does this automatically.
- **arm64.** If C1.4 Step 6 records a plugin with no arm64 build, follow C4's fallback ruling: publish x64 only, and make the publish script's third argument optional. That code is not written in advance.
- **The quoted `cancel-in-progress: "${{ … }}"`** depends on GitHub keeping a whole-scalar expression's boolean type, which is common practice and passes actionlint. Watch C4.7 Step 6's run: a release run must not be cancelled.
- **Optional, not planned:** C2 suggested timing a busy terminal over the pipe against TCP (`cli/scripts/benchmark-terminal-latency.mts`). No task does it. Today only this computer's window connection rides the pipe.
- **Known gaps from C3:** `daemon_slot.dart`'s chord tooltip and `box_chrome.dart`'s lower-case chord form still show Linux text on Windows.
- **B's own TEMPORARY trigger** in `windows.yml` (`feat/windows-native-cli`) belongs to B's PR. C5.3 records it and does not touch it.
- **The spec file** is untracked on `feat/windows-desktop` (`??`). It was edited in place and not committed.

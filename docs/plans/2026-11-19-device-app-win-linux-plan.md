# Harness Device on Windows and Linux — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(device-app): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit. No task merges. Commits reach only `origin/feat/device-app-win-linux`, and only so the temporary workflow can run them (see "How a Windows task proves itself").

**Goal:** The Harness Device menu-bar app runs on Windows (x64, arm64) and Linux (x64, arm64) with macOS's menu, copy, states, consents, sign-in and updater, every difference a named one; nothing is released.

**Architecture:**
- **One codebase, OS code behind the doors that exist** (`FrontSource`, `LoginItem`, `AppUpdater`, `DesktopApp`, `Shell`) and three new seams: a child-process seam under `cli.rs` (`child_unix.rs` / `child_windows.rs`), an `Opener` door (`open.rs`) and a per-OS install plan (`install::runs`). Each OS's code is a file of its own, declared once in `lib.rs` by Task 2, so tasks do not meet in `lib.rs` or `Cargo.toml`.
- **The menu model takes no OS.** `model.rs` and `app.rs` stay free of `cfg` and `consts::OS`; the one timing difference (Windows' held install) enters `App::new` as `install_exits_app`, and a parity test (Task 25) holds that line.
- **Pure rule, thin OS call.** Every rule is a function over plain values that `cargo test --lib` runs on this Mac; the Win32, socket and file calls around it are a few lines, proven on a `windows-latest` runner or a Linux runner.

**Tech Stack:** Rust 1.95+ and Tauri 2.12 (`device-app/src-tauri`), `windows-sys` 0.61 (already in Tauri's tree) on Windows, std and `libc` on Linux; plain TypeScript for the window (`device-app/ui`); Python `unittest` and Bash for the release rules (`device-app/scripts`); GitHub Actions.

**Spec:** `docs/plans/2026-11-19-device-app-win-linux-design.md`. Read it with this plan, the root `AGENTS.md`, `device-app/AGENTS.md`, `device-app/RELEASE.md`, `docs/validation-and-release.md` and `docs/windows-code-signing.md`.

Path shorthand below: `ST/` is `device-app/src-tauri/`, `DA/` is `device-app/`.

## Base

- `feat/device-app-win-linux` at `6dcb285e7d`. The spec and this plan are untracked; the main session commits them, no task does.
- **Coordination:** `feat/dial-linux` (install.sh's `harnessd.desktop`) and `feat/dial-windows` (the devices pipe, which makes `harness hardware watch` work on Windows). The main session rebases on whichever merges first. After `feat/dial-linux` merges, Task 13's entry format is checked against `cli/scripts/install.sh` on `main`. This branch never edits `cli/scripts/install.sh` or `install.ps1`.
- Nothing is installed in this worktree: `npm ci` in `DA/ui` before the window's tests, `npm ci` in `cli/` before Task 18. The Tauri CLI is not on this Mac: `cargo install tauri-cli --version 2.12.4 --locked` (Tasks 2, 26, 32 to 34). Use one `CARGO_TARGET_DIR` outside the repository (`device-app/AGENTS.md`).
- Line numbers are the base's. A task follows the expression it names when a line has moved.

## How a Windows task proves itself

Checked on this Mac, 2026-11-19: `cargo check --locked --lib --target x86_64-pc-windows-msvc` **fails** in `ring`'s build script (`assert.h` not found: no MSVC headers). The `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc` targets are installed in rustup; `cargo-xwin` and Homebrew LLVM (`clang-cl`, `lld-link`, `llvm-rc`) are not. Installing them (`brew install llvm`, `cargo install --locked cargo-xwin`, then `cargo xwin check --lib --tests --target x86_64-pc-windows-msvc`) is an optional faster loop, unproven here. It is never the proof.

- **Pure rules** (most of each task) are red, then green, with `cd device-app/src-tauri && cargo test --locked --lib <filter>` on this Mac.
- **Code and tests under `#[cfg(windows)]`** are red, then green, on the `windows-unit` job of the temporary workflow (Task 1): the red commit reaches `origin/feat/device-app-win-linux`, the job fails on the named test (a compile error that names the missing item counts), the green commit follows, the job passes. The task's report carries both run links. The implementer pushes when it works on that branch; otherwise the main session pushes when it lands the commits.
- **Linux-only code** (`#[cfg(target_os = "linux")]`) runs in a local container (Docker/OrbStack: `rust:1-bookworm` plus `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`, the repo mounted, `CARGO_TARGET_DIR` on a volume) or on the `linux-unit` job. Most Linux rules compile under `cfg(all(test, unix))`, so this Mac runs them too.

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | Temporary workflow | `.github/workflows/tmp-device-app-win-linux.yml` | none | medium | none: temporary, one commit, removed before the merge |
| 2 | Build inputs and the module map | `ST/Cargo.toml`, `ST/Cargo.lock`, `ST/src/lib.rs`, 17 new doc-only files in `ST/src/`, `ST/icons/icon.ico`, `ST/tauri.windows.conf.json`, `ST/tauri.linux.conf.json` | none | high | none: no behavior change, one commit |
| 3 | Unix child code behind a seam | `ST/src/cli.rs`, `ST/src/child_unix.rs` | 2 | xhigh | none: a move, the unix tests stay green, one commit |
| 4 | Windows children; the lib's tests run on Windows | `ST/src/child_windows.rs`, `ST/src/stdin_queue.rs`, `ST/src/cli.rs`, `ST/src/testing.rs`, test modules of `account.rs`, `watch.rs`, `runner.rs`, `logs.rs`, `install.rs`, `update.rs`; `ST/build.rs` and `ST/windows/tests.manifest` if the hazard shows | 1, 2, 3 | xhigh | `stdin_queue` tests (Mac); `windows_children` tests and the job itself (`windows-unit`) |
| 5 | Find the CLI on Windows; PATH per OS | `ST/src/cli.rs`, `ST/src/harness_home.rs` | 4 | xhigh | `cli.rs` new cases |
| 6 | The log hides the Windows profile folder | `ST/src/log.rs` | none | xhigh | `log.rs` new case |
| 7 | A stopped front source names itself | `ST/src/front.rs`, `ST/src/front_x11.rs` | none | medium | `front.rs` new case |
| 8 | sway front source | `ST/src/front_sway.rs` | 2, 7 | high | `front_sway.rs` |
| 9 | Hyprland front source | `ST/src/front_hyprland.rs` | 2, 7 | high | `front_hyprland.rs` |
| 10 | Windows front source | `ST/src/front_windows.rs` | 4, 7 | high | `front_windows.rs` (Mac, then `windows-unit`) |
| 11 | Which source a session gets | `ST/src/front.rs` | 8, 9, 10 | medium | `front.rs` new case |
| 12 | Windows login item | `ST/src/loginitem_windows.rs`, `ST/src/loginitem.rs` | 4 | high | `loginitem_windows.rs` (Mac, then `windows-unit`) |
| 13 | Linux login item: the shared entry | `ST/src/loginitem_linux.rs`, `ST/src/loginitem.rs`, `ST/src/runner.rs` | 2 | high | `loginitem_linux.rs`, `runner.rs` new case |
| 14 | The updater downloads, then installs; a held install | `ST/src/update.rs`, `ST/src/types.rs`, `ST/src/app.rs`, `ST/src/runner.rs`, `ST/src/main.rs` | none | xhigh | `app.rs`, `runner.rs` new cases |
| 15 | Where an update lands on each OS | `ST/src/update.rs` | 4, 14 | xhigh | `update.rs` new cases (Mac, then `windows-unit`) |
| 16 | Linux: one command in a visible terminal | `ST/src/terminal.rs` | 2 | xhigh | `terminal.rs` |
| 17 | Install on each OS | `ST/src/install.rs`, `ST/src/runner.rs`, `ST/src/main.rs` | 4, 16 | xhigh | `install.rs`, `runner.rs` new cases |
| 18 | The CLI pins install.ps1's step lines | `cli/src/scripts/installPs1.spec.ts` | none | medium | none: a pin that passes at once, one commit |
| 19 | The desktop app, installed, on Windows and Linux | `ST/src/desktop.rs` | 4 | high | `desktop.rs` new cases |
| 20 | The opener door | `ST/src/open.rs`, `ST/src/desktop.rs`, `ST/src/logs.rs`, `ST/src/runner.rs`, `ST/src/main.rs` | 4, 19 | xhigh | `open.rs`, `logs.rs`, `runner.rs` new cases |
| 21 | One instance | `ST/src/instance.rs`, `ST/src/main.rs` | 4 | xhigh | `instance.rs` |
| 22 | The tray icon for the panel's colour | `ST/src/tray.rs`, `ST/src/theme_windows.rs`, `ST/icons/tray-light.png`, `ST/src/main.rs` | 4 | high | `tray.rs`, `theme_windows.rs` |
| 23 | Linux: `tray: no host` | `ST/src/tray_host.rs`, `ST/src/main.rs` | 2 | high | `tray_host.rs` |
| 24 | About on Windows and Linux | `ST/src/types.rs`, `ST/src/app.rs`, `ST/src/runner.rs`, `ST/src/main.rs` | 4 | high | `app.rs`, `runner.rs` new cases |
| 25 | Linux refreshes from the tick; the parity test | `ST/src/tick.rs`, `ST/src/parity.rs`, `ST/src/main.rs` | 14 | high | `tick.rs`, `parity.rs` |
| 26 | Packaging details | `ST/tauri.conf.json`, `ST/tauri.windows.conf.json`, `ST/tauri.linux.conf.json`, `ST/windows/hooks.nsh`, `ST/icons/32x32.png`, `ST/icons/128x128.png`, `ST/icons/128x128@2x.png`, `ST/src/packaging.rs`, `ST/src/main.rs` | 2, 12 | high | `packaging.rs` |
| 27 | The manifest carries every platform | `DA/scripts/device-manifest.py`, `DA/scripts/test_device_manifest.py` | none | xhigh | `test_device_manifest.py` new cases |
| 28 | `make release-device` chooses the platforms | `DA/scripts/release-device.sh`, `DA/scripts/test_release_device.py`, `Makefile` | none | high | `test_release_device.py` new cases |
| 29 | Build, bundle and check on each OS | `DA/scripts/release-setup.sh`, `DA/scripts/release-build.sh`, `DA/scripts/release-check.sh`, `DA/scripts/test_release_build.py` (new) | 26 | xhigh | `test_release_build.py` |
| 30 | `release-device.yml`: Windows and Linux | `.github/workflows/release-device.yml`, `DA/scripts/test_release_workflow.py` (new) | 27, 28, 29 | xhigh | `test_release_workflow.py` |
| 31 | PR CI gains a Windows leg | `.github/workflows/ci.yml`, `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md` | 4 | medium | `scripts/tests/test_ci_plan.py` |
| 32 | End to end on Windows | `ST/tests/fake-harness.cmd`, `ST/tests/fake-harness.ps1`, `DA/scripts/e2e/windows.ps1`, the temporary workflow | 5, 10, 11, 12, 17, 20, 21, 22, 24, 26 | high | none: test tooling, one commit; its job is the evidence |
| 33 | End to end on Linux | `DA/scripts/e2e/linux.sh`, `DA/scripts/e2e/sni-watcher.py`, `DA/scripts/e2e/hypr-fake.py`, the temporary workflow | 11, 13, 17, 20, 21, 23, 25, 26 | high | none: test tooling, one commit |
| 34 | The updater end to end | `DA/scripts/e2e/update-pair.sh`, `DA/scripts/e2e/macos.sh`, `DA/scripts/e2e/windows.ps1`, `DA/scripts/e2e/linux.sh`, the temporary workflow | 15, 29, 32, 33 | high | none: test tooling, one commit |
| 35 | The gallery and the design doc show the terminal step | `DA/ui/src/gallery.ts`, `DA/ui/src/gallery.test.ts`, `desktop/design/desktop-design-system.md` | 17 | medium | `gallery.test.ts` |
| 36 | The docs describe Windows and Linux | `DA/AGENTS.md`, `DA/RELEASE.md`, `desktop/design/desktop-design-system.md`, `docs/validation-and-release.md`, `docs/windows-code-signing.md`, `docs/naming-system.md` | every task above | medium | none: docs, one commit |

**Longest chain:** 2 → 3 → 4 → 12 → 26 → 32 → 34 → 36 (eight tasks). Tasks 1, 2, 6, 7, 14, 18, 27 and 28 start at once. `ST/src/main.rs` is in nine tasks (14, 17, 20 to 26) and `ST/src/runner.rs` in five; those run one after another because they share the file, in any order their own dependencies allow.

## Global Constraints

- **macOS is the reference.** Same rows, order, copy, states and transitions. A difference exists only where the spec's "Named differences" table has a row; a new one is a stop question, not a choice.
- **No release is run.** No task starts `release-device.yml`, tags, or publishes.
- **No new dependency.** Only `windows-sys` 0.61 (Task 2; in `Cargo.lock` at 0.61.2 already) and, on Linux, `dbus` 0.9 (Task 23; in `Cargo.lock` at 0.9.12 already) as direct dependencies. No new Tauri plugin; `tauri-plugin-updater` stays the one plugin, called from Rust only. Linux OS calls are std and `libc`. `Cargo.lock` gains exactly one line (`"windows-sys 0.61.2"` under `harness-device`).
- **`device-app/AGENTS.md` rules hold on every OS:** thin over the CLI; every command the app runs is fixed text in Rust and is added to "Fixed arguments" (Task 36); the app in front goes to the watch's stdin and nowhere else, never the log; one log, every line through `log::redact`; `HARNESS_DEVICE_CLI` is read by debug builds only; no other component's path in a string literal (join segments one by one; name other components only in comments).
- **Nothing from the webview, the manifest or an OS window title reaches a command line or the log.** A socket path, an X or sway error's text, an exe path and a zip path are never logged.
- **Push, not poll**, for the app in front and the Windows theme. No fixed sleep in a test: a wait is bounded and ends on the event.
- **Not touched:** the CLI's behavior, the devices service, the watch protocol, the devices pipe, `cli/scripts/install.sh`, `cli/scripts/install.ps1`, the website, Desktop's offer of the Device app.
- **Exact names and copy** (byte for byte):
  - Windows installed name, everywhere: `Harness Device` (folder `%LOCALAPPDATA%\Harness Device`, Start Menu shortcut, Apps-list entry, Run value). Tray tooltip and window title stay `Harness`.
  - Release files: `Harness-Device-windows-x64-setup.exe`, `Harness-Device-windows-arm64-setup.exe`, `Harness-Device-linux-x64.AppImage`, `Harness-Device-linux-arm64.AppImage`, each with a `.sig`.
  - Manifest keys: `platforms.windows-x86_64`, `platforms.windows-aarch64`, `platforms.linux-x86_64`, `platforms.linux-aarch64` (`{url, signature}`); `device-windows-x64`, `device-windows-arm64`, `device-linux-x64`, `device-linux-arm64` (`{version, url, sha256, size}`).
  - Windows install line, Desktop's `windowsInstallCommand` word for word: `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); iex "& { $(irm 'https://cdn.autonomous.ai/harness/cli/install.ps1' -ErrorAction Stop) } -Desktop"; exit $LASTEXITCODE`, run by `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <the line>`.
  - Linux login entry: `<config>/autostart/harnessd.desktop`, name `Harness`, `NoDisplay=true`, `X-GNOME-Autostart-enabled=true`.
  - Log lines: `front: sway not followed`, `front: sway ended`, `front: Hyprland not followed`, `front: Hyprland ended`, `front: Windows not followed`, `front: Windows ended`, `tray: no host`, `instance: already running`.
  - Install step on Linux while the terminal runs: `Finish in the terminal…` (answer 1).
- **Windows release signing is always on** for the Device app: no `WINDOWS_SIGNING` switch, no unsigned fallback.

## Decided here, where the spec was silent

- **The child seam** has one shape on both OSes: `spawn(&mut Command) -> io::Result<(std::process::Child, Group)>`, `Group::{exited, kill, stop, code}`, `Stdin::{new, line}`. `cli.rs` keeps `run_until`, `Child`, `Killer`, `StdinCloser`, `StdinWriter` and their signatures.
- **A child the app killed has no exit code on Windows** (`Group::code` answers `None`), as a signal does on unix. Without this a killed watch would read as exit 1, which the keep-alive takes for an old CLI (`Updating Harness` for a minute).
- **A job's handle closes when its child is reaped or the app exits**, and what is still in the job then ends. The daemon is never in it (it breaks away). On unix a finished run's leftovers live on; nothing the app runs leaves one on purpose.
- **Windows stdin queue:** 16 lines (`STDIN_QUEUED`), as `LINES_QUEUED`.
- **Sign-in cancel on Windows** ends the job at once; the grace is unused. Checked for the spec: the CLI's spawn lock reclaims a dead holder's lock (`cli/src/lib/daemonSpawnLock.ts` `reclaimIfStale`, by `lockOwnerAlive`), so no stop question arises.
- **The updater door is two steps on every OS:** `download()` (the writable check, the download, the signature) and `install()` (put it in place). macOS and Linux install the moment the download answers, so their behavior is today's; Windows holds the install. One way to do it, and macOS's rules stay pinned by `app.rs`'s tests.
- **Windows cannot log `update: installed X`** (the plugin exits the app inside the install). It logs `update: installing X` when the install starts. The watch is not stopped first: its job ends with the app.
- **About on Windows and Linux** is muda's predefined About item (its dialog cannot be opened from code), fed by a new `Effect::AboutCredits` so the dialog has the credits line when the menu is drawn. The credits go in `comments`. macOS ignores the effect and keeps its panel.
- **Opening things is a door of three verbs** (`Opener`: `url`, `reveal`, `desktop`), since Windows and Linux have no single `open` program.
- **The Linux terminal run** follows Desktop: a script file (mode 0700, in `<app data>/setup/`, a 0700 folder) handed to the first of `x-terminal-emulator -e`, `gnome-terminal --`, `xterm -e`; the script writes its exit code to `host.exit` beside itself (a temp file, then a rename), also on HUP, INT and TERM; the app reads that file once a second until `INSTALL_DEADLINE`. Desktop reads the same file every 5 s. On a failure the terminal waits for Enter so the error can be read. Its output is not logged (it is the terminal's); only `install: --host exit N`.
- **`LoginItem` gains `refresh()`** (default: nothing), which the runner calls at every launch and after each install it ran: Linux's take-over of an entry that is on. `register()` stays the once-only first registration.
- **The Linux entry's `Exec=`** is one fixed line (Task 13 has its bytes). "The app's own" means equal to that line for this AppImage and launcher.
- **Windows login item:** the Run value names `current_exe()` of whatever build runs. A `StartupApproved` value whose first byte is not `02` reads `RequiresApproval` whether or not the Run value exists.
- **Tray glyphs:** the dark one is today's `tray.png`; only `tray-light.png` is new. A missing `SystemUsesLightTheme` reads as a dark panel (Windows 10's taskbar without the value is dark).
- **One instance:** `instance.lock` in the app's data folder; the lock is dropped before a relaunch, so the new process never loses to the old one's lock. A lock that cannot be made is logged and the app runs.
- **Every Windows build is a GUI program** (`windows_subsystem = "windows"`, debug builds too): with a console of its own the app would hide a missing `CREATE_NO_WINDOW`, and a release would show a console.
- **Per-OS bundle settings live in `tauri.windows.conf.json` and `tauri.linux.conf.json`** (Tauri merges them over the base), so `tauri.conf.json` changes one line.
- **Desktop app on Windows:** `%LOCALAPPDATA%\Programs\Harness\Harness.exe` (the launcher `harness-install.exe` leaves; `desktop/scripts/windows-e2e/install-state.ps1`). The builder confirms it against the installer's code.
- **Hyprland:** the first value and every `activewindowv2>>` ask `j/activewindow`; the event's own text is never used (the v1 event carries a window title).
- **Release, Windows:** three jobs. `build-windows` compiles with no secret and no identity and hands on the exe and the Tauri CLI it built. `sign-windows` (`environment: release`, `id-token: write`) compiles and installs nothing: it signs the exe, bundles with that Tauri CLI, signs the installer, then makes the `.sig` with `cargo tauri signer sign --app-version`, the only step that holds `TAURI_SIGNING_PRIVATE_KEY`. `check-windows` checks and hashes the result with no identity.
- **`platforms=macos` keeps live Windows and Linux keys byte for byte**, as the spec says. Hazard for the first-release pull request, not handled here: a macOS-only release after those keys are live would send Windows and Linux apps to an installer whose signed version does not match.
- **Long end-to-end checks run on the temporary workflow**, on GitHub's Linux and Windows runners (disposable machines, the same isolation as the spec's containers). Proposals, not built here: a `sway` live step in `device-app-checks`, and an on-demand `device-app-e2e.yml`.

## Answers (harness-pm, 2026-11-19)

1. **Copy for Linux's terminal step** (Tasks 16, 17, 35): kept as written: `Finish in the terminal…`, `No terminal found.`, `Setup failed. Press Enter to close.`
2. **What else Windows signs** (Task 30): as the spec says (the exe before NSIS packs it, the installer after); `uninstall.exe` and the NSIS plugin DLLs are settled together with the Azure check before the first signed release.
3. **How `tray: no host` asks the session bus** (Task 23): the `dbus` crate (0.9.12, already in `Cargo.lock` through Tauri's Linux tree), a direct `[target.'cfg(target_os = "linux")'.dependencies]` dependency added by Task 23. No hand-written D-Bus.
4. **The two checks that run the app's real install lines** (Verification 7): run them (public CDN files, a throwaway signed-out daemon, no account, no backend).
5. **macOS updater behavior stays exactly the same:** the macOS local-manifest updater check (Task 34, `macos.sh --update`) must be green before the merge.

## Review Focus

1. **A Windows update must not remove the login item.** NSIS runs the old uninstaller on every update (`/UPDATE`), and Tauri's hooks run there too. Tests: Task 26 `the_uninstaller_removes_the_run_value_only_on_a_real_uninstall`; Task 34 checks the Run value after 0.0.1 → 0.0.2.
2. **A killed Windows child must read as "no code".** Tests: Task 4 `a_killed_child_has_no_code`, `a_run_past_its_deadline_has_no_code`.
3. **A path with a space or a non-ASCII letter** (`C:\Users\Nguyễn Văn A`, `~/My Apps/Harness-Device-linux-x64.AppImage`): the CLI is found, Explorer selects the zip, the entry's `Exec=` starts the AppImage, the log says `~`. Tests: Task 5 `the_layout_is_found_under_a_home_with_a_space_and_an_accent`; Task 6; Task 13 `a_path_with_a_space_a_percent_a_dollar_a_quote_and_a_backslash_is_quoted`; Task 20 `explorer_selects_a_zip_whose_path_has_a_space`.
4. **A Linux relaunch after an update must not lose to its own lock.** Tests: Task 21 `a_second_acquire_is_refused_until_the_first_is_dropped`; Task 34 finds the app running after the update.
5. **The terminal window closed before `install.sh --host` ends** fails the Install screen at once, not after ten minutes. Tests: Task 16 `a_hangup_writes_129`; Task 17 `a_terminal_run_that_failed_stops_there`.

---

### Task 1: Temporary workflow

**Files:** Create `.github/workflows/tmp-device-app-win-linux.yml`.

Temporary: removed before the merge (devcrew removes it). No secrets, no artifact that is signed, nothing published.

- [ ] **Step 1: Write it.** `name: tmp device-app win-linux (temporary)`; `on: push: branches: [feat/device-app-win-linux]`, `paths: ['device-app/**', '.github/workflows/tmp-device-app-win-linux.yml']`; top-level `permissions: contents: read`; `concurrency: group: tmp-device-app-win-linux-${{ github.sha }}`. Every checkout has `persist-credentials: false`. Two jobs:
  - `windows-unit` (`windows-latest`, 45 min): `dtolnay/rust-toolchain@stable`; `Swatinem/rust-cache` at the SHA `ci.yml` pins, `workspaces: device-app/src-tauri`, `shared-key: device-app-tmp`; `cargo test --locked --lib --manifest-path device-app/src-tauri/Cargo.toml`; then `actions/setup-node@v7` with `ci.yml`'s `CLI_NODE_VERSION` (24.22.2), `npm ci --no-audit --no-fund && npm run build` in `device-app/ui`, and `cargo build --locked --manifest-path device-app/src-tauri/Cargo.toml` (the binary: `main.rs` on Windows).
  - `linux-unit` (`ubuntu-latest`, 30 min): `ci.yml`'s `device-app-checks` steps from the apt install to `Rust unit tests` (`cargo test --locked`), unchanged.
- [ ] **Step 2:** `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/tmp-device-app-win-linux.yml` prints nothing. Expected on GitHub once pushed: `linux-unit` green, `windows-unit` red (it does not compile) until Task 4.
- [ ] **Step 3: Commit** `Temporary workflow: Harness Device's tests on Windows and Linux for this branch`.

### Task 2: Build inputs and the module map

**Files:**
- Modify: `ST/Cargo.toml`, `ST/Cargo.lock`, `ST/src/lib.rs`
- Create, each holding only its `//!` line: `ST/src/child_unix.rs`, `child_windows.rs`, `stdin_queue.rs`, `front_sway.rs`, `front_hyprland.rs`, `front_windows.rs`, `instance.rs`, `loginitem_linux.rs`, `loginitem_windows.rs`, `open.rs`, `terminal.rs`, `theme_windows.rs`, `tick.rs`, `tray.rs`, `tray_host.rs`, `parity.rs`, `packaging.rs`
- Create: `ST/icons/icon.ico`, `ST/tauri.windows.conf.json`, `ST/tauri.linux.conf.json`

No behavior changes on macOS or Linux. Later tasks fill the files and never edit `lib.rs` or `Cargo.toml`; a task that needs a `windows-sys` feature not listed here stops and reports.

- [ ] **Step 1: `Cargo.toml`.** Add, with a comment that it is Tauri's own copy:
  ```toml
  [target.'cfg(windows)'.dependencies]
  windows-sys = { version = "0.61", features = ["Wdk_System_Threading", "Win32_Foundation", "Win32_Security", "Win32_Storage_FileSystem", "Win32_System_Diagnostics_ToolHelp", "Win32_System_IO", "Win32_System_JobObjects", "Win32_System_Registry", "Win32_System_Threading", "Win32_UI_Accessibility", "Win32_UI_Shell", "Win32_UI_WindowsAndMessaging"] }
  ```
  Run `cargo metadata --format-version 1 >/dev/null` in `ST/`; `git diff ST/Cargo.lock` adds exactly `"windows-sys 0.61.2",` under `harness-device`.
- [ ] **Step 2: `lib.rs`.** `front_x11` becomes `#[cfg(any(target_os = "linux", all(test, unix)))]` (its tests use unix links) and `testing` becomes `#[cfg(all(test, unix))]`. Add, in alphabetical place:
  ```rust
  #[cfg(unix)]
  mod child_unix;
  #[cfg(windows)]
  mod child_windows;
  #[cfg(any(target_os = "linux", all(test, unix)))]
  pub mod front_hyprland;
  #[cfg(any(target_os = "linux", all(test, unix)))]
  pub mod front_sway;
  #[cfg(any(windows, test))]
  pub mod front_windows;
  pub mod instance;
  #[cfg(any(target_os = "linux", all(test, unix)))]
  pub mod loginitem_linux;
  #[cfg(any(windows, test))]
  pub mod loginitem_windows;
  pub mod open;
  #[cfg(test)]
  mod packaging;
  #[cfg(test)]
  mod parity;
  #[cfg(any(windows, test))]
  mod stdin_queue;
  #[cfg(any(target_os = "linux", all(test, unix)))]
  pub mod terminal;
  #[cfg(any(windows, test))]
  pub mod theme_windows;
  pub mod tick;
  pub mod tray;
  #[cfg(any(target_os = "linux", all(test, unix)))]
  pub mod tray_host;
  ```
- [ ] **Step 3: icon and configs.** `cargo tauri icon ST/icons/icon.png --output <scratchpad>/icons`, copy only `icon.ico` to `ST/icons/` (tauri-build refuses a Windows build without one). `tauri.windows.conf.json`: `{ "bundle": { "targets": ["nsis"], "icon": ["icons/icon.ico", "icons/icon.png"] } }`. `tauri.linux.conf.json`: `{ "bundle": { "targets": ["appimage"] } }`.
- [ ] **Step 4:** on this Mac `cargo test --locked --lib` in `ST/` passes with the same test count as before; `cargo build --locked` after `npm run build` in `DA/ui` passes.
- [ ] **Step 5: Commit** `Harness Device: the modules, the Windows API crate and the icon a Windows and a Linux build need`.

### Task 3: Unix child code behind a seam

**Files:** Modify `ST/src/cli.rs`; fill `ST/src/child_unix.rs`.

**Interfaces — Produces** (`child_unix.rs`, all `pub(crate)`; Task 4 gives `child_windows.rs` the same):
- `struct Group` — `Clone + Send + Sync`: a started child and what it starts.
- `fn spawn(command: &mut Command) -> io::Result<(std::process::Child, Group)>` — its own process group (`process_group(0)`), under `cli::spawn_lock()`.
- `Group::exited(&self)` (today's `exited`: blocks, leaves it unreaped), `Group::kill(&self)` (today's `kill_group`), `Group::stop(&self)` (SIGTERM to the child alone), `Group::code(&self, status: ExitStatus) -> Option<i32>` (`status.code()`).
- `struct Stdin`; `Stdin::new(pipe: ChildStdin) -> Stdin` (sets `O_NONBLOCK`, today's `fcntl`), `Stdin::line(&mut self, text: &str) -> Result<(), cli::Unwritten>` (today's write: `WouldBlock` is `Full`).

`cli.rs` imports it as `#[cfg(unix)] use crate::child_unix as child;` and holds no `libc`, `std::os::unix` or `std::os::fd` outside tests. `Unreaped` holds `group: Mutex<Option<child::Group>>`; `Child.stdin` is `Arc<Mutex<Option<child::Stdin>>>`. Every public signature of `cli.rs` is unchanged.

- [ ] **Step 1: Move the code**; delete `exited` and `kill_group` from `cli.rs`.
- [ ] **Step 2:** `cargo test --locked --lib cli::` and the whole `cargo test --locked --lib` pass on this Mac, unchanged in count; `grep -n "libc::\|os::unix\|os::fd" ST/src/cli.rs` finds lines only inside `mod tests`.
- [ ] **Step 3: Commit** `Harness Device: a child's process group and its stdin are one seam under cli.rs`.

### Task 4: Windows children; the lib's tests run on Windows

**Files:** fill `ST/src/child_windows.rs`, `ST/src/stdin_queue.rs`; modify `ST/src/cli.rs` (the `cfg(windows)` import; `#[cfg(windows)] mod windows_children` in its tests), `ST/src/testing.rs`, and the test modules of `account.rs`, `watch.rs`, `runner.rs`, `logs.rs`, `install.rs`, `update.rs`; `ST/build.rs` and `ST/windows/tests.manifest` only for the hazard below.

**Interfaces:**
- Consumes: the seam of Task 3.
- Produces, `stdin_queue.rs`: `pub(crate) const STDIN_QUEUED: usize = 16;` `pub(crate) struct Queue;` `Queue::new(pipe: impl Write + Send + 'static) -> Queue` (one writer thread); `Queue::line(&self, text: &str) -> Result<(), Unwritten>` — never waits: `Full` when 16 lines wait, `Closed` once a write failed. Dropping it ends the thread after the write under way and closes the pipe.
- Produces, `child_windows.rs`: the seam. `pub(crate) const CREATION_FLAGS: u32` holds `CREATE_NO_WINDOW` and never `DETACHED_PROCESS`. `spawn` puts the child in a job of its own with `JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` **before it runs** (started suspended and resumed after `AssignProcessToJobObject`, or attached at creation). `kill` and `stop` are `TerminateJobObject`; `exited` waits on the process handle; `code` is `None` once this group was killed. `Stdin` wraps `Queue`.

- [ ] **Step 1: Failing tests, any OS** (`stdin_queue.rs`): `a_full_queue_answers_full_and_never_waits` (a pipe whose write blocks: 1 + 16 lines are taken, the next is `Err(Unwritten::Full)`, each call returns without waiting); `lines_arrive_in_order_each_with_a_newline`; `a_failed_write_closes_it` (`Err(Unwritten::Closed)` from then on); `dropping_it_closes_the_pipe`.
- [ ] **Step 2: Failing tests, Windows** (`cli.rs`, `mod windows_children`, children are `cmd.exe` and `powershell.exe` by their System32 paths):
  - `the_flags_hide_the_console`: `CREATION_FLAGS & 0x0800_0000 != 0` and `CREATION_FLAGS & 0x0000_0008 == 0`.
  - `a_run_gives_its_code_and_its_lines_in_order`: `cmd /C "echo a& echo b& exit 3"` gives lines `["a", "b"]`, `code == Some(3)`, not timed out.
  - `a_run_past_its_deadline_has_no_code`: a child that waits 60 s, deadline 2 s: `timed_out`, `code == None`, back within 10 s.
  - `a_kill_ends_the_child_and_what_it_started`: the child prints the pid of a process it started and waits; after `killer().kill()` both are gone within 5 s. `stop` does the same.
  - `a_killed_child_has_no_code`: `child.exit(..) == Ok(None)` after a kill.
  - `a_process_that_broke_away_outlives_the_kill`: a process the child starts with `CREATE_BREAKAWAY_FROM_JOB` is alive after the kill; the test ends it.
  - `a_writer_never_waits_on_a_child_that_reads_nothing`: lines written to a child that never reads end in `Err(Unwritten::Full)` within 10 000 lines, the whole loop within 10 s.
  - `closing_stdin_ends_a_child_that_reads_it`.
- [ ] **Step 3:** on this Mac `cargo test --locked --lib stdin_queue` FAILS (no `Queue`). Commit red; `windows-unit` is red too.
- [ ] **Step 4: Implement** the two files. Then make the lib's test target compile on Windows: `#[cfg(unix)]` on each import of `crate::testing` and on each helper that uses `Fake`, a unix link or `libc`. In `update.rs`, `writable` is `#[cfg(unix)]`, and until Task 15 `#[cfg(windows)] fn writable(_: &Path) -> bool { false }` with a comment naming Task 15.
- [ ] **Step 5: Run `windows-unit` until `cargo test --lib` passes.** A test that fails on Windows only because it names a unix path or program gets `#[cfg(unix)]`; list each in the report with the task that owns its Windows twin (5, 6, 15, 17, 20). Never change a rule to pass a test.
  - **Hazard:** if the test exe ends with `0xc0000139` (STATUS_ENTRYPOINT_NOT_FOUND) before any test runs, it lacks the Common Controls v6 manifest that tauri-build gives only the binary. Then `build.rs` uses `tauri_build::WindowsAttributes::new_without_app_manifest()` and, for the Windows MSVC target, prints `cargo:rustc-link-arg=/MANIFEST:EMBED` and `cargo:rustc-link-arg=/MANIFESTINPUT:<ST/windows/tests.manifest>` (a copy of tauri-build's `windows-app-manifest.xml`), as Tauri's own `build.rs` does (`embed_manifest_for_tests`). No new crate.
- [ ] **Step 6:** this Mac: `cargo test --locked --lib` passes. `windows-unit`: both steps are green. If `main.rs` or a non-test item needs a `cfg` to compile on Windows, add the smallest one and name it in the report.
- [ ] **Step 7: Commit** `Windows: the app's children run with no console, in a job the daemon leaves, behind a stdin that never waits`.

### Task 5: Find the CLI on Windows; PATH per OS

**Files:** Modify `ST/src/cli.rs` (`find_cli_with`, `installed_with`, `child_env`), `ST/src/harness_home.rs` (`Entry`).

**Interfaces — Produces:**
- `harness_home::Entry::Bin` (`name()` `bin`, `root()` `Root::Data`).
- `cli.rs`: `fn installed_windows(home: &Path, path_var: Option<&OsStr>, look: &Look) -> Option<(PathBuf, Vec<OsString>)>`, in this order: (1) the managed runtime: `runtime/current-node`, its first line trimmed with a leading byte order mark dropped, names an absolute file that resolves inside `runtime` (both sides canonicalized), and `cli/current`, read the same way, names one folder (not empty, not `.`, no `..`, none of `\`, `/`, `:`, NUL) whose `cli.js` is a file resolving inside `cli` → `(node, [cli_js])`; (2) `<root>/bin/harness.exe`; (3) the first `harness.exe` in PATH's absolute folders. These are `pty/src/launcher.rs` `resolve`'s rules, so the app accepts exactly the installs `harness.exe` accepts. `find_cli_with` uses it when `cfg!(windows)`.
- `cli.rs`: `fn child_env_for(windows: bool, home: &Path, path_var: Option<&OsStr>, locale: Option<&OsStr>) -> Vec<(OsString, OsString)>`: on Windows `PATH` is `<root>\bin`, then `;`, then the rest, and no `LC_ALL`; unix is today's. `child_env` keeps its signature and calls it with `cfg!(windows)`.

- [ ] **Step 1: Failing tests** (any OS; temp folders): `the_windows_layout_names_node_and_the_version_folders_cli_js`; `a_pointer_with_a_byte_order_mark_and_a_crlf_reads`; `a_pointer_that_leads_out_is_refused` (a node outside `runtime`, `..`, a version of `a/b`, `a\b`, `c:`, a link that leads out); `then_bin_harness_exe_then_a_harness_exe_on_path`; `the_layout_is_found_under_a_home_with_a_space_and_an_accent`; `a_windows_child_has_bin_first_a_semicolon_and_no_lc_all` (`child_env_for(true, …)`); the unix `child_env` tests unchanged.
- [ ] **Step 2:** `cargo test --locked --lib cli::` FAILS (no `installed_windows`). Commit red.
- [ ] **Step 3: Implement.** `harness_home.rs`'s guard stays green: the `bin` folder comes from `roots.path(Entry::Bin)`.
- [ ] **Step 4:** green on this Mac and on `windows-unit`.
- [ ] **Step 5: Commit** `Windows: the app finds the CLI install.ps1 lays down, and its children's PATH is Windows's`.

### Task 6: The log hides the Windows profile folder

**Files:** Modify `ST/src/log.rs`.

**Interfaces — Produces:** `fn home_rule(home: &str, windows: bool) -> Option<Regex>`; the `HOME` static reads `USERPROFILE` when `cfg!(windows)`. With `windows`: letters match in either case, `\` and `/` are one separator, and the folder ends at a character no user name holds or at the text's end.

- [ ] **Step 1: Failing test** `the_windows_profile_folder_is_written_as_a_tilde`, rule built from `C:\Users\Kim`: `Installing into C:\Users\Kim\.harness` → `Installing into ~\.harness`; `c:/users/kim/x` → `~/x`; `C:\Users\Kimberly\x` and `C:\Users\Kim.b` unchanged; rule from `C:\Users\Nguyễn Văn A`: `C:\Users\Nguyễn Văn A\Desktop` → `~\Desktop`. The existing unix cases call `home_rule(home, false)` and stay as they are.
- [ ] **Step 2:** `cargo test --locked --lib log::` FAILS. Commit red.
- [ ] **Step 3: Implement.** **Step 4:** green. **Step 5: Commit** `The log writes the Windows profile folder as ~`.

### Task 7: A stopped front source names itself

**Files:** Modify `ST/src/front.rs`, `ST/src/front_x11.rs`.

**Interfaces — Produces** (`front.rs`; `Stop`, `on_thread` and `session_is_x11` move here from `front_x11.rs`, with their tests, since `front.rs` compiles on every OS and `front_x11.rs` does not):
- `pub enum Source { X11, Sway, Hyprland, Windows }`
- `pub enum Stop { NotFollowed, Ended }`; `Stop::line(&self, source: Source) -> &'static str`: the eight fixed lines `front: X11 not followed`, `front: X11 ended`, `front: sway …`, `front: Hyprland …`, `front: Windows …`.
- `pub fn on_thread(log: Arc<dyn Log>, source: Source, follow: impl FnOnce() -> Stop + Send + 'static)`: thread name `front-x11`, `front-sway`, `front-hyprland`, `front-windows`.

- [ ] **Step 1: Failing test** `why_following_stopped_is_one_fixed_line_per_source` (the eight lines, through `on_thread` and a `MemoryLog`), replacing `front_x11.rs`'s `why_following_stopped_is_one_fixed_line`.
- [ ] **Step 2:** FAILS (no `Source`). Commit red. **Step 3: Implement**; `X11Front` passes `Source::X11`. **Step 4:** `cargo test --locked --lib front` passes. **Step 5: Commit** `A front source that stops says which one, in one fixed line`.

### Task 8: sway front source

**Files:** Fill `ST/src/front_sway.rs`.

**Interfaces:**
- Consumes: `front::{FrontSource, Source, Stop, on_thread}`; `front_x11::exe_name(proc_root, pid)`.
- Produces: `pub struct SwayFront { pub log: Arc<dyn Log> }` (`FrontSource` on Linux: connects to `$SWAYSOCK` on its thread; a socket it cannot reach is `Stop::NotFollowed`); `pub const PAYLOAD_MAX: usize = 16 * 1024 * 1024;` `pub fn message(kind: u32, payload: &[u8]) -> Vec<u8>` (`i3-ipc`, length, kind, native byte order); `pub fn read_message(stream: &mut impl Read) -> io::Result<(u32, Vec<u8>)>` (refuses another magic or a payload over `PAYLOAD_MAX`); `pub fn focused_pid(tree: &[u8]) -> Option<u32>` (the node with `"focused": true`, through `nodes` and `floating_nodes`); `pub fn focus_pid(event: &[u8]) -> Option<Option<u32>>` (`None` unless `change` is `focus`; `Some(None)` for a container with no `pid`); `pub fn follow(stream: impl Read + Write, proc_root: &Path, changed: &dyn Fn(String)) -> Stop`.
- Protocol: SUBSCRIBE (type 2) `["window"]` first and its `{"success":true}`, then GET_TREE (type 4), so no change between them is missed; a window event is type `0x80000003`. A pid with no exe, or no pid, tells the empty string.

- [ ] **Step 1: Failing tests** (unix; a scripted peer on the other end of `UnixStream::pair()`, a temp folder as `proc_root` with `<pid>/exe` links as `front_x11.rs`'s tests make): `the_first_value_is_the_trees_focused_node`; `a_focus_event_tells_the_new_app_and_a_title_change_tells_nothing`; `an_event_that_arrives_before_the_tree_is_not_lost`; `a_focus_with_no_pid_is_the_empty_value`; `a_refused_subscribe_is_not_followed`; `a_payload_over_the_cap_or_another_magic_ends_it` (`Stop::Ended`, nothing told); `the_tree_is_walked_through_floating_nodes`. Event and tree bytes are inline fixtures in sway's own shape.
- [ ] **Step 2:** `cargo test --locked --lib front_sway` FAILS. Commit red. **Step 3: Implement** (no `swaymsg`; no path or error text in the log). **Step 4:** green. **Step 5: Commit** `Linux: the app in front on sway, over its socket`.

### Task 9: Hyprland front source

**Files:** Fill `ST/src/front_hyprland.rs`.

**Interfaces:**
- Consumes: as Task 8.
- Produces: `pub struct HyprlandFront { pub log: Arc<dyn Log> }`; `pub const LINE_MAX: usize = 4096;` `pub const ANSWER_MAX: usize = 64 * 1024;` `pub fn sockets(runtime_dir: &Path, signature: &str) -> Option<(PathBuf, PathBuf)>` (events `hypr/<signature>/.socket2.sock`, requests `hypr/<signature>/.socket.sock`; `None` unless the signature is one folder name: not empty, not `.` or `..`, no `/`, no NUL); `pub fn is_active_window(line: &str) -> bool` (starts with `activewindowv2>>`); `pub fn active_pid(answer: &[u8]) -> Option<u32>` (`j/activewindow`'s `pid` when above 0; `None` for `{}`); `pub fn follow(events: impl Read, ask: &dyn Fn() -> io::Result<Vec<u8>>, proc_root: &Path, changed: &dyn Fn(String)) -> Stop`.

- [ ] **Step 1: Failing tests** (unix): `the_first_value_asks_the_active_window`; `each_activewindowv2_asks_again_and_no_other_event_does` (an `activewindow>>class,title` line and a `workspace>>2` line ask nothing, and no part of them is told); `no_window_is_the_empty_value`; `a_line_over_4096_bytes_is_skipped_and_the_next_one_read`; `an_answer_over_64_kib_is_no_app`; `a_signature_that_is_not_one_folder_names_no_socket`; `the_events_end_is_ended_and_a_first_ask_that_fails_is_not_followed`.
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** green. **Step 5: Commit** `Linux: the app in front on Hyprland, over its sockets`.

### Task 10: Windows front source

**Files:** Fill `ST/src/front_windows.rs`.

**Interfaces:**
- Consumes: `front::{FrontSource, Source, Stop, on_thread}`.
- Produces: `pub fn file_name(image: &str) -> String` (the text after the last `\` or `/`); `#[cfg(windows)] pub struct WinFront { pub log: Arc<dyn Log> }` — a thread with its own message loop, `SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, …, WINEVENT_OUTOFCONTEXT)`; window → `GetWindowThreadProcessId` → `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` → `QueryFullProcessImageNameW` → `file_name`; `GetForegroundWindow` once at start. A process it may not open tells the empty string. A hook that cannot be set is `Stop::NotFollowed`.

- [ ] **Step 1: Failing tests:** any OS: `the_value_is_the_exe_file_name` (`C:\Program Files\Microsoft VS Code\Code.exe` → `Code.exe`; `C:/x/wezterm-gui.exe`; a bare name; empty → empty). Windows: `the_source_tells_the_app_in_front_once_at_start` (a value arrives within 5 s; it is empty or passes `front_line` unchanged).
- [ ] **Step 2:** `cargo test --locked --lib front_windows` FAILS on this Mac. Commit red. **Step 3: Implement.** **Step 4:** green on this Mac and `windows-unit`. **Step 5: Commit** `Windows: the app in front, pushed by a WinEvent hook`.

### Task 11: Which source a session gets

**Files:** Modify `ST/src/front.rs`.

**Interfaces — Produces:** `pub enum LinuxFront { X11, Sway, Hyprland, None }`; `pub fn linux_front(var: &dyn Fn(&str) -> Option<String>) -> LinuxFront`: `session_is_x11(XDG_SESSION_TYPE, WAYLAND_DISPLAY, DISPLAY)` (in `front.rs` since Task 7) → `X11`; else `SWAYSOCK` set and not empty → `Sway`; else `HYPRLAND_INSTANCE_SIGNATURE` set and not empty → `Hyprland`; else `None`. `front::system(log)` gives `MacFront`, `WinFront`, or Linux's by `linux_front` (`NoFront` for `None`).

- [ ] **Step 1: Failing test** `the_linux_source_is_x11_then_sway_then_hyprland_then_none`: an X11 session with `SWAYSOCK` set is `X11`; Wayland with both set is `Sway`; Wayland with only the signature is `Hyprland`; GNOME Wayland (neither) is `None`; an empty value counts as unset.
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement**; drop `NoFront`'s "Windows, until its wave" words. **Step 4:** green on this Mac, `linux-unit` and `windows-unit`. **Step 5: Commit** `The app in front comes from X11, sway, Hyprland or Windows, whichever the session is`.

### Task 12: Windows login item

**Files:** Fill `ST/src/loginitem_windows.rs`; modify `ST/src/loginitem.rs` (the "not supported" impl no longer covers Windows; whichever of Tasks 12 and 13 lands second deletes that impl and its test `there_is_none_off_a_mac`).

**Interfaces — Produces:**
- `pub const RUN_VALUE: &str = "Harness Device";`
- `pub fn status(run: Option<&str>, approved: Option<&[u8]>) -> loginitem::Status`: `approved` with a first byte other than `0x02` → `RequiresApproval`; else `run` present → `Enabled`; else `NotRegistered`.
- `pub fn run_data(exe: &Path) -> String`: the path in double quotes.
- `#[cfg(windows)] pub struct Keys { pub run: &'static str, pub approved: &'static str }`, `pub const SYSTEM: Keys` (`Software\Microsoft\Windows\CurrentVersion\Run`, `Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`, under HKCU) and `pub fn register_in(keys: &Keys, exe: &Path) -> Result<(), String>` through `loginitem::register_from`. An error is `Login item not added (error <code>).`, the code only.
- `#[cfg(windows)] impl LoginItem for SystemLoginItem` calling `register_in(&SYSTEM, &current_exe)`.

- [ ] **Step 1: Failing tests:** any OS: `only_a_missing_value_is_written_and_a_turned_off_one_stays_off` (the `status` table: none/none → `NotRegistered`; value/none → `Enabled`; value/`[2, 0, …]` → `Enabled`; value/`[3, 0, …]` → `RequiresApproval`; none/`[3, …]` → `RequiresApproval`; value/empty → `Enabled`); `the_value_is_the_quoted_exe`. Windows, against scratch keys `Software\HarnessDeviceTest-<pid>\…` removed afterwards: `register_writes_the_value_once_and_never_turns_one_back_on`.
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** green on this Mac and `windows-unit`. **Step 5: Commit** `Windows: the app starts at sign-in, once, and stays off when Startup Apps turned it off`.

### Task 13: Linux login item: the shared entry

**Files:** Fill `ST/src/loginitem_linux.rs`; modify `ST/src/loginitem.rs` (the trait gains `refresh`; the "not supported" impl no longer covers Linux, and goes with its test once Task 12 has landed too), `ST/src/runner.rs`.

**Interfaces — Produces:**
- `loginitem.rs`: `fn refresh(&self) -> Result<bool, String> { Ok(false) }` on `LoginItem` (`Ok(true)`: it changed the entry).
- `loginitem_linux.rs`: `pub const ENTRY: &str = "harnessd.desktop";` `pub fn entry_path(config_home: Option<&OsStr>, home: &Path) -> PathBuf` (`<config>/autostart/harnessd.desktop`; `$XDG_CONFIG_HOME` only when it starts with `/`, else `<home>/.config`); `pub fn appimage(var: Option<&OsStr>) -> Option<PathBuf>` (absolute and a file); `pub fn exec_line(appimage: &Path, launcher: &Path) -> Option<String>` (`None` for a path that is not UTF-8 or holds a control character); `pub fn fresh(exec: &str) -> String`; `pub enum Change { Write(String), Leave }`; `pub fn change(existing: Option<&str>, exec: &str, first: bool) -> Change`.
- The `Exec` value, as the file's bytes, for `/a/H.AppImage` and `/h/.local/bin/harness`:
  ```text
  /bin/sh -c "[ -x \\"\\$0\\" ] && exec \\"\\$0\\"; exec \\"\\$1\\" start" "/a/H.AppImage" "/h/.local/bin/harness"
  ```
  Each path is in double quotes; inside them `"`, `` ` `` and `$` are written `\\` then the character, a backslash is `\\\\`, and `%` is `%%` (the Desktop Entry spec's two layers: GLib refuses a value with any other escape).
- `fresh(exec)` is exactly: `[Desktop Entry]`, `Type=Application`, `Name=Harness`, `Exec=<exec>`, `NoDisplay=true`, `X-GNOME-Autostart-enabled=true`, one per line, a newline after the last.
- `change`: no entry and `first` → `Write(fresh)`; no entry and not `first` → `Leave`; an entry with a `Hidden=true` line (spaces around `=` allowed) → `Leave`; an entry whose `Exec=` line is this one → `Leave`; any other entry → `Write` of it with its `Exec=` line replaced (`fresh` when it has none).
- `SystemLoginItem` on Linux: `register()` is `change(…, first: true)` and `refresh()` is `change(…, first: false)`, each written through a temp file in the same folder and a rename. Not an AppImage run: `register()` is `Err("Login item not added (not an AppImage).")` and `refresh()` is `Ok(false)`. The launcher is `<home>/.local/bin/harness`.
- `runner.rs`: `refresh()` is called once in `Runner::polling_every` and after each install that ended `Ok`; `Ok(true)` logs `login item: updated`, `Err` logs `login item: not updated: <error>`.

- [ ] **Step 1: Failing tests** (unix): `the_entry_is_under_xdg_config_home_only_when_it_is_absolute`; `the_exec_line_is_one_fixed_text` (the bytes above); `a_path_with_a_space_a_percent_a_dollar_a_quote_and_a_backslash_is_quoted`; `the_exec_line_starts_the_appimage_and_falls_back_to_the_launcher` (the line's command, unescaped by the two layers, run with `/bin/sh` against two temp scripts: the first runs when it is there, else the second gets `start`); `a_fresh_entry_is_dial_linuxs_format`; `an_absent_entry_is_written_once_and_a_deleted_one_stays_deleted`; `a_hidden_entry_is_left_alone`; `an_entry_that_is_on_is_taken_over_and_keeps_its_other_lines`; `the_apps_own_entry_is_not_rewritten`; `only_an_appimage_run_registers`. `runner.rs`: `the_login_item_is_refreshed_at_start_and_after_an_install` (a double that counts).
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** green on this Mac and `linux-unit`. **Step 5: Commit** `Linux: the app shares the CLI's one login entry, takes over one that is on and leaves one that is off`.

### Task 14: The updater downloads, then installs; a held install

**Files:** Modify `ST/src/update.rs`, `ST/src/types.rs`, `ST/src/app.rs`, `ST/src/runner.rs`, `ST/src/main.rs`.

**Interfaces — Produces:**
- `update.rs`: `AppUpdater` is `check()`, `download() -> Result<(), UpdateFailure>` (the writable check first, then the download and its signature; keeps the bytes) and `install() -> Result<(), UpdateFailure>` (puts the kept bytes in place; `Check` when there are none). `pub fn install_exits_app() -> bool { cfg!(windows) }`.
- `types.rs`: `Effect::DownloadUpdate`, `Event::UpdateDownloaded`.
- `app.rs`: `App::new(saved, cli_found, desktop_installed, now, install_exits_app: bool)`. `UpdateChecked(Some(v))` pushes `DownloadUpdate`; the `Updating Harness…` row is set there only when `!install_exits_app`. `UpdateDownloaded`: without the property, `InstallUpdate` at once; with it, the install is held. A held install starts on the first `Tick` where `relaunch_waits()` is false: the row is set, then `Effect::Log("update: installing <v>")`, then `Effect::InstallUpdate`; no `StopWatch`, no `Relaunch`. While it is held no check starts (`updating` stays set).
- `runner.rs`: `DownloadUpdate` runs `download()` on a thread and answers `UpdateDownloaded` or `UpdateFailed`.
- `main.rs`: `App::new(…, update::install_exits_app())`.

- [ ] **Step 1: Failing tests** (`app.rs`): `a_found_update_downloads_then_installs_then_relaunches` (property false: `DownloadUpdate` and the row at once; `UpdateDownloaded` → `InstallUpdate`; `UpdateInstalled` → `update: installed 0.1.3` and the relaunch waits exactly as today); `where_the_install_exits_the_app_it_waits_for_what_a_relaunch_waits_for` (property true: no row after the check; with the window open, a start running, the CLI installing, or a sign-in running, ticks push no `InstallUpdate`; once none holds, one tick pushes the row, `update: installing 0.1.3` and `InstallUpdate`, and never `StopWatch` or `Relaunch`); `a_held_install_starts_no_second_check`; `an_install_that_fails_where_it_exits_the_app_is_tried_again_after_the_wait` (`UpdateFailed(Install)` clears the row and backs off as today); `a_blocked_or_failed_download_reads_as_before` on both values. Every existing update test passes with the extra `UpdateDownloaded` step. `runner.rs`: `a_download_then_an_install_reach_the_door_in_order`.
- [ ] **Step 2:** `cargo test --locked --lib app:: runner::` FAILS. Commit red. **Step 3: Implement**; `SystemUpdater` keeps `(Update, Vec<u8>)` between the two calls. **Step 4:** `cargo test --locked` (lib and binary) passes on this Mac.
- [ ] **Step 5: Commit** `The app's update is downloaded, then installed; where installing ends the app, it waits as a relaunch does`.

### Task 15: Where an update lands on each OS

**Files:** Modify `ST/src/update.rs`.

**Interfaces — Produces:**
- `pub fn enabled(debug: bool, os: &str, version: &str, appimage: bool) -> bool`: never in a debug build or at `0.0.0`; `macos` and `windows` yes; `linux` only with `appimage`; any other OS no.
- `pub fn target(os: &str, exe: &Path, appimage: Option<&Path>) -> Option<PathBuf>`: macOS `bundle_of(exe)`; Windows the exe's folder; Linux the AppImage.
- `pub fn replaceable(os: &str, target: &Path) -> bool`: macOS and Linux today's rule (the target and its folder pass `access(2)` `W_OK`); Windows: a file can be made and removed in the folder.
- `system(handle)` passes `APPIMAGE` (set and absolute); `download()` checks `replaceable(OS, target(…))` before any byte is fetched. The `false` Windows `writable` of Task 4 goes.

- [ ] **Step 1: Failing tests:** `a_release_build_updates_itself_on_macos_windows_and_as_an_appimage` (the table, with `enabled(false, "linux", "0.0.1", false) == false`; it replaces `only_a_release_build_on_a_mac_updates_itself`); `what_an_update_replaces_on_each_os`; unix: `an_appimage_is_replaceable_only_when_it_and_its_folder_are_writable`; Windows: `an_install_folder_is_replaceable_only_when_a_file_can_be_made_in_it` (a temp folder yes; one with a deny-write ACL set by `icacls`, put back before any assert, no; a missing one no).
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** green on this Mac, `linux-unit`, `windows-unit`. **Step 5: Commit** `The app updates itself on Windows and as an AppImage, and never asks for a password`.

### Task 16: Linux: one command in a visible terminal

**Files:** Fill `ST/src/terminal.rs`.

**Interfaces — Produces:**
- `pub const CANDIDATES: [(&str, &str); 3] = [("x-terminal-emulator", "-e"), ("gnome-terminal", "--"), ("xterm", "-e")];` (Desktop's order; each gets the script's path as its last argument).
- `pub const NO_TERMINAL: &str = "No terminal found.";` (answer 1).
- `pub fn script(line: &str) -> String`, exactly:
  ```sh
  #!/bin/sh
  # Harness: setup's host half, in a terminal so sudo can ask for a password.
  result="$(dirname "$0")/host.exit"
  finish() { printf '%s\n' "$1" > "$result.tmp" && mv "$result.tmp" "$result"; }
  trap 'finish 129; exit 129' HUP INT TERM
  <line>
  status=$?
  finish "$status"
  if [ "$status" -ne 0 ]; then
    printf '\nSetup failed. Press Enter to close. '
    read -r _
  fi
  exit "$status"
  ```
- `pub fn wait_result(result: &Path, deadline: Duration, now: &dyn Fn() -> Instant, pause: &dyn Fn(Duration)) -> Option<i32>`: reads once a second; a missing file or one that is not a whole number is still pending; `None` at the deadline.
- `pub fn run(folder: &Path, line: &str, deadline: Duration, start: &dyn Fn(&str, &str, &Path) -> io::Result<()>) -> io::Result<Output>`: makes `folder` (0700), writes `host.sh` (0700), removes an old `host.exit`, starts the first candidate that is found (`NotFound` moves on; none is `io::Error::new(NotFound, NO_TERMINAL)`), then waits: `Output { code: Some(n), .. }` or `Output { timed_out: true, .. }`.
- `pub fn start(program: &str, flag: &str, script: &Path) -> io::Result<()>`: started in its own process group, reaped on a thread.

- [ ] **Step 1: Failing tests** (unix): `the_script_writes_its_lines_exit_code` (`/bin/sh host.sh` with line `(exit 3)` and stdin at `/dev/null` leaves `3` in `host.exit`; with `true`, `0`; with `HOST` as the line, the script holds `HOST` word for word); `a_hangup_writes_129` (line `sleep 30`; SIGHUP to its group; `host.exit` reads `129` within 5 s, waited for, not slept); `the_first_terminal_found_is_used_in_desktops_order`; `no_terminal_is_one_fixed_error`; `an_old_result_is_removed_first`; `a_result_is_waited_for_and_a_half_written_one_is_still_pending` (a fake clock and `pause`); `no_result_by_the_deadline_is_a_timeout`; `the_folder_and_the_script_are_the_persons_alone` (modes 0700).
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** green on this Mac and `linux-unit`. **Step 5: Commit** `Linux: one fixed command runs in a terminal the person sees, and the app reads how it ended`.

### Task 17: Install on each OS

**Files:** Modify `ST/src/install.rs`, `ST/src/runner.rs`, `ST/src/main.rs`.

**Interfaces:**
- Consumes: `terminal::{run, start}` (Task 16).
- Produces (`install.rs`): `pub const WINDOWS: &str` (Global Constraints); `pub const POWERSHELL_ARGS: [&str; 5] = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];` `pub fn powershell(system_root: Option<&OsStr>) -> PathBuf` (`C:\Windows` when unset or empty); `pub const FINISH_IN_TERMINAL: &str = "Finish in the terminal…";` `pub enum Place { Background, Terminal }`; `pub struct Run { pub line: &'static str, pub flag: &'static str, pub place: Place }`; `pub fn runs(os: &str) -> &'static [Run]` — `macos`: `HOST` `--host` background, `DESKTOP` `--desktop` background; `linux`: `HOST` `--host` terminal, `DESKTOP` `--desktop` background; `windows`: `WINDOWS` `-Desktop` background. `pub fn step_of(os: &str, clean: &str) -> Option<&'static str>`; `Shell::run(&self, run: &Run, deadline: Duration, sink: &mut dyn FnMut(&str)) -> io::Result<Output>`; `pub struct SystemShell { pub folder: PathBuf }`; `pub fn system_shell(data: PathBuf) -> SystemShell`; `pub fn install(os: &str, shell, log, cli_there, on_step)`.
- Windows steps: a clean line that begins `Downloading Node `, `Downloading Harness ` or `Downloading the terminal host ` is `DOWNLOADING_HARNESS`. The Windows step lines the log keeps begin with one of those three, `OK ` or `Harness could not be installed. The step that failed: `; the 200-line cap, the redaction and the 512-character cut are today's.
- A terminal run tells `FINISH_IN_TERMINAL` when it starts; when it ends well the step is `GETTING_READY` again until the next run names one.
- `NOT_SUPPORTED` is deleted; `Doors.shell` is `Arc<dyn Shell>`; the runner passes `std::env::consts::OS`; `main.rs` passes `system_shell(paths.app_data_dir()?)`.

- [ ] **Step 1: Failing tests** (`install.rs`): `the_runs_of_each_os`; `the_windows_line_is_the_desktop_apps` (the exact text); `powershell_is_named_by_its_full_path`; `a_windows_run_shows_downloading_harness_and_logs_only_its_step_lines` (stdout `  Downloading Node 24.22.2 (win32-x64)...`, `  OK Node 24.22.2 -> C:\x`, a noise line, `Harness could not be installed. The step that failed: Node.`: steps are `[DOWNLOADING_HARNESS]`, the log holds those three lines and `install: -Desktop exit 1`, never the noise); `a_unix_step_line_is_no_windows_step_and_the_reverse`; `a_terminal_run_shows_finish_in_the_terminal_then_getting_ready`; `a_terminal_run_that_failed_stops_there` (code 129: `Err([NOT_INSTALLED])`, `install: --host exit 129`, `--desktop` never runs); `no_terminal_is_what_the_screen_shows` (`Err(["No terminal found."])`). Windows only: `powershell_takes_a_command_with_quotes_inside_whole` (a `Run` whose line is `iex "& { 'hi' }"; exit 7` gives the line `hi` and code 7). Existing tests take `install("macos", …)` and the new `Shell::run`. `runner.rs`: the install test runs on each OS's runs; the `NOT_SUPPORTED` test goes.
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** green on this Mac, `linux-unit`, `windows-unit`; `grep -rn NOT_SUPPORTED ST/src` finds nothing. **Step 5: Commit** `The app installs the CLI on Windows and Linux: install.ps1 in one hidden run, install.sh's host half in a terminal`.

### Task 18: The CLI pins install.ps1's step lines

**Files:** Modify `cli/src/scripts/installPs1.spec.ts`.

- [ ] **Step 1:** `cd cli && npm ci`. In `describe('install.ps1, as written')` add `it('keeps the step lines Harness Device names')`: the source contains `Write-Host "  Downloading Node `, `Write-Host "  Downloading Harness `, `Write-Host "  Downloading the terminal host `, `Write-Host "  OK ` and `Write-Host "Harness could not be installed. The step that failed: `. Comment as `install.spec.ts`'s twin does: the app's fixed table reads these beginnings. install.ps1 does not change.
- [ ] **Step 2:** `npx vitest run src/scripts/installPs1.spec.ts` passes. **Step 3: Commit** `CLI test: install.ps1 keeps the lines Harness Device reads its steps from`.

### Task 19: The desktop app, installed, on Windows and Linux

**Files:** Modify `ST/src/desktop.rs`.

**Interfaces — Produces:** `pub fn exec_target(entry: &str) -> Option<String>` (what an entry's `Exec=` starts: a quoted first word unescaped, else the text up to the first space; Desktop's `_execTarget`); `pub fn linux_desktop_app(data_home: Option<&OsStr>, home: &Path, read: &dyn Fn(&Path) -> Option<String>, is_file: &dyn Fn(&Path) -> bool) -> Option<PathBuf>` (`<data>/applications/harness.desktop`, `<data>` being `$XDG_DATA_HOME` when absolute, else `<home>/.local/share`; its target, when absolute and a file); `pub fn windows_desktop_app(local_app_data: Option<&OsStr>, is_file: &dyn Fn(&Path) -> bool) -> Option<PathBuf>` (`<LOCALAPPDATA>\Programs\Harness\Harness.exe`, joined segment by segment); `pub fn desktop_app() -> Option<PathBuf>` (this OS's; `None` on macOS). Off macOS `SystemDesktopApp::installed()` is `desktop_app().is_some()`. `running()` is unchanged.

- [ ] **Step 1: Failing tests:** `an_entrys_exec_names_its_program` (`"/a b/H.AppImage" %u`, `/a/H.AppImage %u`, an escaped quote, no `Exec=`); `the_linux_desktop_app_is_its_entrys_appimage_while_it_is_on_disk` (found; no entry; the AppImage gone; a relative target; `XDG_DATA_HOME` relative is ignored); `the_windows_desktop_app_is_its_launcher`. `no_desktop_app_is_installed_off_a_mac` goes.
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** green on this Mac, `linux-unit`, `windows-unit`. **Step 5: Commit** `Open Harness is offered on Windows and Linux when the desktop app is installed`.

### Task 20: The opener door

**Files:** Fill `ST/src/open.rs`; modify `ST/src/desktop.rs` (`run_open`, `OPEN`, `open_desktop_args` move out), `ST/src/logs.rs` (`reveal_args` moves out; `bundle_path`), `ST/src/runner.rs`, `ST/src/main.rs`.

**Interfaces:**
- Consumes: `desktop::desktop_app()` (Task 19).
- Produces (`open.rs`): `pub trait Opener: Send + Sync { fn url(&self, url: &str) -> io::Result<()>; fn reveal(&self, zip: &Path) -> io::Result<()>; fn desktop(&self) -> io::Result<()>; }`; `pub fn system(log: Arc<dyn Log>) -> Arc<dyn Opener>`; the pure halves: `pub fn url_args(os: &str, url: &str) -> Option<(&'static str, Vec<String>)>` (`macos`: `/usr/bin/open`, `[url]`; `linux`: `xdg-open`, `[url]`; `windows`: `None`, the shell opens it); `pub fn shell_url(url: &str) -> Option<&str>` (only a text that starts `https://`); `pub fn reveal_args(os: &str, zip: &Path) -> (&'static str, Vec<String>)` (`macos`: `/usr/bin/open`, `["-R", zip]`; `linux`: `xdg-open`, `[the zip's folder]`; `windows`: `explorer.exe`, `[explorer_select(zip)]`); `pub fn explorer_select(zip: &Path) -> String` (`/select,"<zip>"`, passed to Explorer as written, with `raw_arg`); `pub fn desktop_args(os: &str) -> Option<(&'static str, Vec<String>)>` (`macos`: `/usr/bin/open`, `["-b", "ai.autonomous.harness"]`; elsewhere `None`: `desktop_app()` is run with no argument, in its own process group, reaped on a thread).
- Windows `url`: `ShellExecuteW` verb `open` on `shell_url(url)`, else `InvalidInput`. Explorer is run by its full path under `<SystemRoot>` (the OS half joins it; `reveal_args` names the file only), and its exit code is not logged (it is 1 on success); elsewhere `open: exit <n>` stays.
- `logs.rs`: `fn bundle_path(path: &str, windows: bool) -> bool` — the file name is the text after the last `/`, and after the last `\` too when `windows`; `parse` passes `cfg!(windows)`.
- `runner.rs`: `Doors.open: Arc<dyn Opener>`; `OpenUrl`, `OpenDesktop` and `Reveal` call it; the log lines `browser: could not open: …`, `desktop app: could not open: …`, `logs: could not open: …` are unchanged. `main.rs`: `open: open::system(log.clone())`.

- [ ] **Step 1: Failing tests:** `open.rs`: `what_opens_a_url_on_each_os`; `only_an_https_url_goes_to_the_windows_shell`; `what_shows_the_zip_on_each_os`; `explorer_selects_a_zip_whose_path_has_a_space` (`C:\Users\Nguyễn Văn A\Desktop\harness-logs-20261118-1030.zip` → `/select,"C:\Users\Nguyễn Văn A\Desktop\harness-logs-20261118-1030.zip"`); `open_harness_is_one_fixed_command_on_a_mac_and_the_apps_own_file_elsewhere`. `logs.rs`: `a_windows_zip_is_named_after_its_last_backslash` (`bundle_path` with `windows: true` takes `C:\Users\p\Desktop\harness-logs-20261118-1030.zip`'s name; with `false` it does not); under `#[cfg(windows)]`, `parse` accepts that path. `runner.rs`: its opener double records `url <u>`, `reveal <zip>`, `desktop`; the existing open tests assert those.
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** green on this Mac, `linux-unit`, `windows-unit`. **Step 5: Commit** `The app opens a page, shows the logs' zip and opens Harness the way each OS does`.

### Task 21: One instance

**Files:** Fill `ST/src/instance.rs`; modify `ST/src/main.rs`.

**Interfaces — Produces:** `pub struct Instance(std::fs::File);` `pub fn acquire(folder: &Path) -> io::Result<Option<Instance>>` — makes `folder`, opens `instance.lock` in it, takes it without waiting (`flock(LOCK_EX | LOCK_NB)` on unix, `LockFileEx` with `LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY` on Windows); `Ok(None)` when another process holds it. Dropping the `Instance` frees it.

`main.rs`, off macOS, before the tray: `Ok(None)` → log `instance: already running`, `exit(0)`; `Err(e)` → log `instance: no lock (<e.kind()>)` and go on. The `Instance` is kept in `Shared` and dropped before `handle.restart()`.

- [ ] **Step 1: Failing tests** (unix on this Mac, Windows on the job): `a_second_acquire_is_refused_until_the_first_is_dropped`; `the_folder_is_made`.
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** green on this Mac, `linux-unit`, `windows-unit`; `cargo test --locked` (the binary's tests) passes here. **Step 5: Commit** `Windows and Linux: a second launch of the app exits with one log line`.

### Task 22: The tray icon for the panel's colour

**Files:** Fill `ST/src/tray.rs`, `ST/src/theme_windows.rs`; create `ST/icons/tray-light.png`; modify `ST/src/main.rs`.

**Interfaces — Produces:**
- `tray.rs`: `pub enum TrayIcon { Template, Dark, Light }`; `pub fn tray_icon(os: &str, light_panel: bool) -> TrayIcon` (`macos`: `Template`; `windows`: `Dark` on a light panel, `Light` on a dark one; elsewhere `Light`).
- `theme_windows.rs`: `pub fn light_panel(value: Option<u32>) -> bool` (only `Some(1)`); `#[cfg(windows)] pub const PERSONALIZE: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";` `#[cfg(windows)] pub fn read(key: &str) -> bool` (its `SystemUsesLightTheme`); `#[cfg(windows)] pub fn watch(key: &'static str, changed: impl Fn(bool) + Send + 'static)` (a thread on `RegNotifyChangeKeyValue`; tells a value only when it changed).
- `tray-light.png`: `tray.png`'s glyph in white, 36 × 36, the same alpha.
- `main.rs`: the tray is built with `tray.png` (`Template`, `Dark`) or `tray-light.png` (`Light`); `icon_as_template(true)` only for `Template`; on Windows `watch` sets the icon on the main thread.

- [ ] **Step 1: Failing tests:** `each_os_has_its_tray_icon`; `only_a_value_of_one_is_a_light_panel`. Windows, on a scratch key: `the_watch_tells_a_change_once` (the value goes 0 → 1: `true` arrives once; writing 1 again tells nothing).
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** green on this Mac and `windows-unit`; both of that job's steps pass. **Step 5: Commit** `Windows: the tray icon follows the taskbar's light or dark; Linux shows the light one`.

### Task 23: Linux: `tray: no host`

**Files:** Fill `ST/src/tray_host.rs`; modify `ST/src/main.rs`, `ST/Cargo.toml`, `ST/Cargo.lock`.

**Answer 3 replaces the hand-written bus below:** `host_there()` asks `NameHasOwner("org.kde.StatusNotifierWatcher")` through the `dbus` crate's blocking session connection (2 s timeout). Keep `WATCHER` and `host_there() -> Option<bool>` and the `main.rs` log rule; drop `Bus`, `bus_address`, `REPLY_MAX` and `has_owner`. Red test: the pure rule from the answer to the log line (`Some(false)` logs `tray: no host` once; `Some(true)`/`None` log nothing), plus `host_there` on the `linux-unit` job against `dbus-run-session` with and without a watcher. `Cargo.lock` gains only `"dbus",` under `harness-device`.

**Interfaces — Produces:** `pub const WATCHER: &str = "org.kde.StatusNotifierWatcher";` `pub enum Bus { Path(PathBuf), Abstract(Vec<u8>) }`; `pub fn bus_address(var: Option<&str>, runtime_dir: Option<&Path>) -> Option<Bus>` (the first `unix:path=` or `unix:abstract=` entry of `DBUS_SESSION_BUS_ADDRESS`, else `<XDG_RUNTIME_DIR>/bus`); `pub const REPLY_MAX: usize = 64 * 1024;` `pub fn has_owner(stream: impl Read + Write, uid: u32, name: &str) -> io::Result<bool>` (`AUTH EXTERNAL`, `BEGIN`, `Hello`, then `NameHasOwner`); `#[cfg(target_os = "linux")] pub fn host_there() -> Option<bool>` (reads and writes time out after 2 s; `None` when the bus cannot be asked).

`main.rs`, on Linux, once the tray is built, on a thread: `Some(false)` → log `tray: no host`, once.

- [ ] **Step 1: Failing tests** (unix; a scripted peer on `UnixStream::pair()`): `a_watcher_on_the_bus_is_a_host` and `none_is_no_host` (the peer answers `OK <guid>`, takes `BEGIN` and a `Hello`, and replies `true` or `false` to `NameHasOwner`); `a_bus_that_refuses_the_sign_in_is_an_error`; `a_reply_over_64_kib_is_an_error`; `the_bus_is_found_from_its_address_or_the_runtime_folder` (`unix:path=/run/user/1000/bus`; `unix:abstract=/tmp/dbus-x,guid=1`; `tcp:host=x` then the runtime folder; two entries split by `;`).
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** green on this Mac and `linux-unit`. **Step 5: Commit** `Linux: a desktop with no tray host is one log line`.

### Task 24: About on Windows and Linux

**Files:** Modify `ST/src/types.rs`, `ST/src/app.rs`, `ST/src/runner.rs`, `ST/src/main.rs`.

**Interfaces — Produces:**
- `types.rs`: `Effect::AboutCredits(Option<String>)`, one of the binary's effects.
- `app.rs`: `send_menu` pushes `AboutCredits(about_credits(&state))` whenever it differs from the last one sent, before any `Menu` of the same event. `MenuAction::About` → `ShowAbout` is unchanged.
- `runner.rs`: `AboutCredits` comes back from `run` for the binary.
- `main.rs`: `Shared` keeps the last credits and the last menu items. Off macOS, `MenuItem::Action(MenuAction::About, text)` is drawn as `PredefinedMenuItem::about(handle, Some(text), Some(AboutMetadata { name: "Harness", version: the package version, comments: the credits, .. }))`, and `AboutCredits` draws the tray menu again. The no-op `show_about` goes; macOS is untouched.

- [ ] **Step 1: Failing tests:** `app.rs`: `the_about_credits_are_told_when_they_change_and_only_then` (a status line with firmware and a CLI version → `AboutCredits(Some("Device 0.0.95 · Harness 0.6.58"))` once; the same state again → none; the CLI gone → `AboutCredits(None)`; it comes before `Menu` when both are sent). `runner.rs`: `the_about_credits_are_the_binarys`.
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** `cargo test --locked` passes here; `linux-unit` and both `windows-unit` steps are green. **Step 5: Commit** `Windows and Linux: About shows the name, the version and the credits line`.

### Task 25: Linux refreshes from the tick; the parity test

**Files:** Fill `ST/src/tick.rs`, `ST/src/parity.rs`; modify `ST/src/main.rs`.

**Interfaces:**
- Consumes: `App::new(…, install_exits_app)` (Task 14).
- Produces (`tick.rs`): `pub fn menu_opened(now: u64, desktop_installed: bool) -> Event`; `pub fn tick(os: &str, now: u64, desktop_running: bool, desktop_installed: &dyn Fn() -> bool) -> Vec<Event>` — `[Event::Tick { .. }]`, and on `linux` then `menu_opened(now, desktop_installed())` (not called elsewhere).
- `main.rs`: the tray click sends `tick::menu_opened(…)`; the timer sends each event of `tick::tick(std::env::consts::OS, …)`.

- [ ] **Step 1: Failing tests:**
  - `tick.rs`: `linux_refreshes_from_the_tick_and_no_other_os_does`.
  - `parity.rs`: `the_menu_and_the_rules_read_no_os` — `include_str!` of `model.rs` and `app.rs`, cut at their `#[cfg(test)]`, hold none of `cfg(target_os`, `cfg(windows)`, `cfg(unix)`, `cfg!(`, `cfg_attr(`, `consts::OS`.
  - `parity.rs`: `linuxs_tick_feeds_the_menu_opened_a_click_does` — `tick("linux", 7, true, &|| true)[1] == menu_opened(7, true) == Event::MenuOpened { now: 7, desktop_installed: true }`.
  - `parity.rs`: `the_one_os_property_of_the_rules_is_install_exits_app` — two `App`s, the property true and false, given one script of events with no update in it (a found CLI, status lines, a sign-in, an export, ticks) yield equal effects at every step; with an update in the script they differ only as Task 14 names (the row's moment, `update: installing`, no `Relaunch`).
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** `cargo test --locked` passes here; `linux-unit` green. **Step 5: Commit** `Linux reads the account from the tick, as a click does elsewhere; a test holds the menu the same on every OS`.

### Task 26: Packaging details

**Files:** Modify `ST/tauri.conf.json`, `ST/tauri.windows.conf.json`, `ST/tauri.linux.conf.json`, `ST/src/main.rs`; create `ST/windows/hooks.nsh`, `ST/icons/32x32.png`, `ST/icons/128x128.png`, `ST/icons/128x128@2x.png`; fill `ST/src/packaging.rs`.

**Interfaces — Consumes:** `loginitem_windows::RUN_VALUE` (Task 12).

- `tauri.conf.json`: the window gains `"skipTaskbar": true`.
- `tauri.windows.conf.json`: `bundle.windows.nsis`: `"installMode": "currentUser"`, `"installerHooks": "windows/hooks.nsh"`. WebView2 stays the download bootstrapper (Tauri's default).
- `hooks.nsh`: `!macro NSIS_HOOK_POSTUNINSTALL` holding, inside `${If} $UpdateMode <> 1` … `${EndIf}`, `DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Harness Device"`.
- `tauri.linux.conf.json`: `bundle.icon` lists the three PNGs (from Task 2's `cargo tauri icon` output) and `icons/icon.png`.
- `main.rs`, first line: `#![cfg_attr(windows, windows_subsystem = "windows")]`.

- [ ] **Step 1: Failing tests** (`packaging.rs`; the files read with `include_str!`, the JSON with `serde_json`): `the_uninstaller_removes_the_run_value_only_on_a_real_uninstall` (the macro, the `$UpdateMode <> 1` guard around the `DeleteRegValue` line, and its value name equals `RUN_VALUE`); `windows_installs_per_user_as_harness_device` (`productName` is `Harness Device`, targets `["nsis"]`, `installMode` `currentUser`, the hooks path); `linux_is_an_appimage`; `the_window_is_harness_at_420_by_320_with_no_taskbar_button`; `every_windows_build_is_a_gui_program`.
- [ ] **Step 2:** `cargo test --locked --lib packaging` FAILS. Commit red. **Step 3: Implement.** **Step 4:** green here and on both `windows-unit` steps. **Step 5: Commit** `Windows installs per user as Harness Device and Linux as an AppImage; no taskbar button, no console`.

### Task 27: The manifest carries every platform

**Files:** Modify `DA/scripts/device-manifest.py`, `DA/scripts/test_device_manifest.py`.

**Interfaces — Produces:** `--platforms {macos,all}` (default `macos`) on `build`, `publish` and `verify`; the functions take `platforms="macos"`. `sums` gains `--part {macos,windows,linux-x64,linux-arm64}` (default `macos`, so the macOS job's two calls are unchanged): each build job hashes its own files, and `publish` checks each part before it puts them together. Files: `macos` is today's three; `windows` the two installers and their `.sig`; `linux-x64` and `linux-arm64` an AppImage and its `.sig` each. `macos` is the `macos` part; `all` is the four. With `all`, `file_entries` adds the eight keys, every one at this version. With `macos`, `publish` copies the live manifest's `platforms.windows-*`, `platforms.linux-*`, `device-windows-*` and `device-linux-*` into the new one byte for byte and uploads no Windows or Linux file. `verify` downloads each update file and the dmg that this run's mode names. A rerun's "same files" check compares only this mode's keys.

- [ ] **Step 1: Failing tests:** `test_all_names_every_platform_at_one_version` (the keys, their shapes, the URLs under `<base>/<version>/`, each signature its `.sig`'s text); `test_macos_names_no_windows_or_linux_file` (the uploads); `test_sums_cover_one_part_each` (round trip per part; a file of another part in the folder is neither hashed nor missed); `test_macos_keeps_live_windows_and_linux_keys_untouched`; `test_all_replaces_them`; `test_verify_downloads_each_file_it_names`; `test_a_rerun_compares_only_its_own_platforms`; `test_an_unknown_platforms_value_is_one_error_line`.
- [ ] **Step 2:** `python3 -m unittest discover -s device-app/scripts -p 'test_*.py'` FAILS. Commit red. **Step 3: Implement.** **Step 4:** it passes. **Step 5: Commit** `Device manifest: a release can carry Windows and Linux beside macOS, and a macOS one leaves their keys alone`.

### Task 28: `make release-device` chooses the platforms

**Files:** Modify `DA/scripts/release-device.sh`, `DA/scripts/test_release_device.py`, `Makefile` (the target's comment).

**Interfaces — Produces:** `--platforms macos|all` (default `macos`); every dispatch carries `-f platforms=<value>`; the summary prints `  platforms  <value>`; any other value stops before anything is tagged. A comment says the input is temporary: the first Windows and Linux release makes `all` the only behavior and removes it.

- [ ] **Step 1: Failing tests:** `test_a_release_is_macos_only_unless_asked` (the fake `gh` got `-f platforms=macos`); `test_platforms_all_reaches_the_run`; `test_another_platforms_value_stops_before_the_tag`.
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** passes. **Step 5: Commit** `make release-device: macOS only unless --platforms all`.

### Task 29: Build, bundle and check on each OS

**Files:** Modify `DA/scripts/release-setup.sh`, `DA/scripts/release-build.sh`, `DA/scripts/release-check.sh`; create `DA/scripts/test_release_build.py`.

**Interfaces — Produces:**
- `release-build.sh compile VERSION [CONFIG_JSON]`, `bundle VERSION OUT_DIR [CONFIG_JSON]`, and on Windows `sign-update VERSION OUT_DIR`. The OS is `uname -s`'s. `DEVICE_TARGET` is `universal-apple-darwin` on macOS, the host's `x86_64-unknown-linux-gnu` or `aarch64-unknown-linux-gnu` on Linux, and one of `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` on Windows, where it must be set. `compile` still refuses any signing secret in its environment.
- Linux `bundle`: `--bundles appimage` with `createUpdaterArtifacts`; moves the AppImage and its `.sig` to `Harness-Device-linux-<x64|arm64>.AppImage(.sig)`.
- Windows `bundle`: `--bundles nsis`, no updater artifact, no secret; moves the installer to `Harness-Device-windows-<x64|arm64>-setup.exe`. `sign-update` runs `cargo tauri signer sign --app-version VERSION` on each `*-setup.exe` in `OUT_DIR` (after Authenticode), so the `.sig` covers the shipped bytes.
- `release-setup.sh`: the tools of this runner's OS (Rust targets, the Tauri CLI 2.12.4, `minisign`; on Linux Tauri's packages and what its AppImage bundler needs).
- `release-check.sh DIR VERSION PUBKEY [--notarized|--signed]`: macOS as today. Linux: both files; the AppImage's ELF machine is this arch's; the update signature verifies and carries `version:VERSION`. Windows, for each installer in `DIR`: the update signature and its version; with `--signed`, `Get-AuthenticodeSignature` says `Valid`. Each prints `ok: <check>` or `FAILED: <check>`.

- [ ] **Step 1: Failing tests** (`test_release_build.py`: the script run in a temp tree with a fake `uname` and a fake `cargo` on `PATH`; the fake `cargo` records its arguments, answers `metadata` with a temp target folder and writes the files a bundle would): `test_compile_refuses_a_signing_secret_on_every_os`; `test_linux_bundles_an_appimage_under_its_fixed_name`; `test_windows_bundles_an_installer_and_no_signature`; `test_windows_needs_its_target_named`; `test_sign_update_binds_the_version` (the fake `cargo` got `tauri signer sign --app-version 0.1.3 …-setup.exe`); `test_an_unknown_os_or_target_stops`.
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** the device app's Python tests pass; `shellcheck DA/scripts/*.sh` is clean. (`release-check.sh`'s new checks run for real in Task 34.) **Step 5: Commit** `Release scripts: Harness Device builds, bundles and is checked on Windows and Linux`.

### Task 30: `release-device.yml`: Windows and Linux

**Files:** Modify `.github/workflows/release-device.yml`; create `DA/scripts/test_release_workflow.py`.

**Interfaces — Produces:**
- Input `platforms` (`type: choice`, `macos` or `all`, default `macos`), with the comment that it is temporary.
- `build` (macOS) is unchanged.
- `build-windows` (`if: inputs.platforms == 'all'`, `windows-latest`, matrix `x64` → `x86_64-pc-windows-msvc`, `arm64` → `aarch64-pc-windows-msvc`): setup, `release-build.sh compile`; uploads the unsigned `harness-device.exe` and the Tauri CLI it built (`cargo-tauri.exe`) as `device-windows-<arch>-unsigned` (1 day). No `id-token`, no secret, no `environment`.
- `sign-windows` (`needs: [version, build-windows]`, `windows-latest`, `environment: release`, `permissions: contents: read, id-token: write`). **It compiles nothing and installs nothing:** an identity is the whole job's, so no build script may run in it. The sparse checkout includes `/.github/actions/windows-signing/`; it takes both artifacts, puts `cargo-tauri.exe` on `PATH` and each exe in a folder of its own; `./.github/actions/windows-signing` with `release-desktop.yml`'s inputs (`vars.AZURE_CLIENT_ID`, `vars.AZURE_TENANT_ID`, `vars.AZURE_SUBSCRIPTION_ID`, `vars.SIGNING_ENDPOINT`, `vars.SIGNING_ACCOUNT`, `vars.SIGNING_PROFILE`, publisher `vars.WINDOWS_SIGNING_PUBLISHER || 'AUTONOMOUS INC.'`); moves each exe back under its target folder; `release-build.sh bundle` per arch (the Tauri CLI only, no secret in that step); the action again over the installers; `release-build.sh sign-update`, the only step with `TAURI_SIGNING_PRIVATE_KEY` and its password; uploads the four files as `device-windows-signed` (1 day). No `vars.WINDOWS_SIGNING` test anywhere.
- `check-windows` (`needs: sign-windows`, `windows-latest`, no identity, no secret): `release-setup.sh`, `release-check.sh … --signed`, `sums --part windows`; uploads `harness-device-<version>-windows` (7 days).
- `build-linux` (`if: inputs.platforms == 'all'`, matrix `ubuntu-22.04` x64, `ubuntu-22.04-arm` arm64, `release-desktop.yml`'s runners): setup, `compile` with no secret, `bundle` with the updater key, `release-check.sh`, `sums --part linux-<arch>`, upload as `harness-device-<version>-linux-<arch>`.
- `publish`: `needs` `version`, `build`, `check-windows` and `build-linux`; it runs with `publish` when `build` succeeded and, for `all`, `check-windows` and `build-linux` did too (`!cancelled()` with each `needs.<job>.result` named); downloads each artifact into a folder of its own, runs `sums --part <part> --check` on each, then moves the files into `out`; passes `--platforms "$PLATFORMS"` to `publish` and `verify`.

- [ ] **Step 1: Failing tests** (`test_release_workflow.py`, over the workflow's text as `scripts/tests/test_ci_plan.py` reads `ci.yml`): `test_platforms_is_macos_unless_asked`; `test_windows_and_linux_build_only_for_all`; `test_the_job_that_compiles_windows_holds_no_identity_and_no_secret`; `test_only_the_signing_job_is_in_the_release_environment_with_an_id_token`; `test_the_signing_job_compiles_and_installs_nothing` (its text holds no `cargo install`, `npm ci`, `release-setup.sh` or `compile`); `test_only_sign_update_holds_the_updater_key_on_windows`; `test_the_installer_is_signed_after_the_exe_and_before_the_update_signature` (the order of the steps); `test_windows_signing_has_no_switch`; `test_linux_builds_on_ubuntu_22_04_for_both_archs`; `test_publish_checks_each_part_then_passes_the_platforms`.
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** the tests pass; `actionlint` on the file prints nothing. The workflow is not started. **Step 5: Commit** `release-device.yml builds, signs and publishes Windows and Linux when a release asks for all platforms`.

### Task 31: PR CI gains a Windows leg

**Files:** Modify `.github/workflows/ci.yml` (`device-app-checks`), `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md` (the `device-app/` row of the PR CI table, and the "not run" row for Harness Device on macOS, which stays).

**Interfaces — Produces:** `device-app-checks` has `strategy: fail-fast: false, matrix: os: [ubuntu-latest, windows-latest]`, `name: device-app-checks (${{ matrix.os }})`, `runs-on: ${{ matrix.os }}`, and `-${{ strategy.job-index }}` at the end of its concurrency group. Today's steps run `if: runner.os == 'Linux'`. The Windows leg is: checkout, `dtolnay/rust-toolchain@stable`, the cache (`shared-key: device-app-pr-windows`), `cargo test --locked --lib --manifest-path device-app/src-tauri/Cargo.toml`. `required`'s `needs` is unchanged. No new workflow.

- [ ] **Step 1: Failing test:** in `test_the_workflow_carries_every_suite`, the job also holds `windows-latest`, `cargo test --locked --lib --manifest-path device-app/src-tauri/Cargo.toml`, `strategy.job-index` and `runner.os == 'Linux'`; `assertNotIn("macos", job)` stays.
- [ ] **Step 2:** `python3 -m unittest scripts/tests/test_ci_plan.py` FAILS. Commit red. **Step 3: Implement.** **Step 4:** it passes; `actionlint` prints nothing. **Step 5: Commit** `PR CI: Harness Device's rules are tested on Windows too`.

### Task 32: End to end on Windows

**Files:** Create `ST/tests/fake-harness.cmd`, `ST/tests/fake-harness.ps1`, `DA/scripts/e2e/windows.ps1`; modify the temporary workflow.

Test tooling: one commit, no red test. It runs no real CLI and no backend.

- `fake-harness.cmd` starts `fake-harness.ps1` with its arguments (Windows PowerShell by its full path, `-NoProfile -ExecutionPolicy Bypass -File`). The `.ps1` keeps `tests/fake-harness`'s contract for the lines the script needs: its folder is `FAKE_HARNESS` or `fake` beside it; it appends its arguments to `calls.log`; it plays the file named by its arguments joined with `_`; `@record` appends stdin to `stdin.log` until it closes; `@wait NAME`; `@exit N`.
- `windows.ps1 -Installer <setup.exe> [-Out <folder>]` prints `ok: <check>` or `FAILED: <check>` and exits 1 at the first failure. It makes and removes only what it installed. Its checks:
  1. `/S` installs per user: `%LOCALAPPDATA%\Harness Device\harness-device.exe`, the Start Menu `Harness Device.lnk` and the uninstall entry `Harness Device` are there; `%LOCALAPPDATA%\Programs\Harness`, `Harness.lnk` and the `Harness` uninstall entry are as before.
  2. With `state.json` saying `cliSeen` and no CLI, the log has `menu: Harness removed | Install | About | Quit`.
  3. With `HARNESS_DEVICE_CLI` at the fake (`hardware watch --json` prints `{"attached":false}` then `@record`; `auth status --json` prints `{"loggedIn":false}`), the log has `menu: Plug in your device | Sign in… | Export logs | About | Quit`.
  4. The Run value `Harness Device` is the quoted exe; a second launch exits, the log has `instance: already running`, one `harness-device.exe` runs, the value is unchanged.
  5. Two apps brought to the front in turn (`AppActivate`): `stdin.log` gains a `{"front":"…"}` line for each exe name, compared without case.
  6. No window of class `ConsoleWindowClass` owned by the app or its children was seen from launch to here.
  7. `uninstall.exe /S`: the folder, the shortcut, the entry and the Run value are gone.
- Temporary workflow, two jobs: `windows-e2e` (`windows-latest`): `cargo tauri build --debug --bundles nsis`, then `pwsh DA/scripts/e2e/windows.ps1 -Installer …`. `windows-arm64-build`: `cargo tauri build --debug --bundles nsis --target aarch64-pc-windows-msvc`, the installer uploaded as `device-app-windows-arm64-debug` for 3 days (unsigned, for the VM).

- [ ] **Step 1: Write the three files and the jobs.** **Step 2:** `windows-e2e` is green; its log is the evidence. **Step 3: Commit** `End to end on Windows: the installed app against a fake CLI`.

### Task 33: End to end on Linux

**Files:** Create `DA/scripts/e2e/linux.sh`, `DA/scripts/e2e/sni-watcher.py`, `DA/scripts/e2e/hypr-fake.py`; modify the temporary workflow.

Test tooling: one commit. It uses `ST/tests/fake-harness`, a scratch `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_RUNTIME_DIR`, its own D-Bus session (`dbus-run-session`) and its own Xvfb display; a fake `xdg-open` on `PATH` records its arguments.

- `sni-watcher.py` owns `org.kde.StatusNotifierWatcher` on the session bus and writes each `RegisterStatusNotifierItem` to a file (`python3-dbus`, `python3-gi`). `hypr-fake.py` serves `.socket2.sock` and `.socket.sock` under `$XDG_RUNTIME_DIR/hypr/<signature>/`: it sends the `activewindowv2>>` lines it is told to and answers `j/activewindow` with the pid it is given.
- `linux.sh <AppImage>` prints `ok:`/`FAILED:` lines. Its checks:
  1. With the watcher running, the tray registers (one item in the watcher's file); the log has `menu: Plug in your device | Sign in… | Export logs | About | Quit`.
  2. Without the watcher, the log has `tray: no host` once.
  3. X11: `xdotool` brings two xterms to the front, one copied as `code`; the fake's `stdin.log` gains `{"front":"xterm"}` and `{"front":"code"}`.
  4. sway: headless sway (`WLR_BACKENDS=headless`, `WLR_LIBINPUT_NO_DEVICES=1`) with two `foot` windows, one copied as `kitty`; the app runs with `XDG_SESSION_TYPE=wayland`, `SWAYSOCK` set and `GDK_BACKEND=x11`; `swaymsg focus` moves between them; `stdin.log` gains both names.
  5. Hyprland: the same with `HYPRLAND_INSTANCE_SIGNATURE` set and `hypr-fake.py`; `stdin.log` gains the exe name of each pid it answers.
  6. GNOME-like Wayland (neither variable): no `{"front":` line, and no `front:` line in the log.
  7. The login entry: the first run writes `autostart/harnessd.desktop` with the app's `Exec=`; a second run leaves its bytes; with `Hidden=true` and another `Exec=` it is left; with another `Exec=` alone it is taken over and the log has `login item: updated`; deleted, it stays deleted.
  8. A second launch exits with `instance: already running`.
  9. Export logs: the fake `xdg-open` got the zip's folder.
- Temporary workflow: `linux-e2e`, matrix `ubuntu-22.04` and `ubuntu-22.04-arm`: Tauri's packages plus `xvfb openbox xdotool xterm sway foot dbus-x11 python3-dbus python3-gi libfuse2`, `cargo tauri build --debug --bundles appimage`, then `bash DA/scripts/e2e/linux.sh <AppImage>`.

- [ ] **Step 1: Write them and the job.** **Step 2:** `linux-e2e` is green on both runners. **Step 3: Commit** `End to end on Linux: the AppImage against a fake CLI, a fake tray host, X11, sway and a scripted Hyprland`.

### Task 34: The updater end to end

**Files:** Create `DA/scripts/e2e/update-pair.sh`, `DA/scripts/e2e/macos.sh`; modify `DA/scripts/e2e/windows.ps1`, `DA/scripts/e2e/linux.sh`, the temporary workflow.

Test tooling: one commit. A throwaway key made in the run, a manifest served from `127.0.0.1:8765`; never the production bucket, never a production key.

- `update-pair.sh OUT`: makes a key pair (`cargo tauri signer generate --ci -w <temp>` with an empty password), then for `0.0.1` and `0.0.2` runs `release-build.sh compile` and `bundle` (and `sign-update` on Windows) with a `CONFIG_JSON` that sets `plugins.updater.pubkey` to the throwaway key, `endpoints` to `["http://127.0.0.1:8765/metadata.json"]` and `dangerousInsecureTransportProtocol` to `true`; runs `release-check.sh` on each; writes `OUT/0.0.1/`, `OUT/0.0.2/` and `OUT/metadata.json` (version `0.0.2`, this platform's `platforms` key, its URL under `http://127.0.0.1:8765/0.0.2/`, its `.sig`'s text).
- Each driver gains an update mode (`linux.sh --update OUT`, `windows.ps1 -Update OUT`, `macos.sh --update OUT`): it serves `OUT` on `127.0.0.1:8765`, seeds `state.json` with `cliSeen`, `askedSignIn` and `loginItem` true (so nothing is installed and no window opens), runs `0.0.1` with no CLI in reach, and waits, bounded at 5 minutes, on the log and the files:
  - Linux and macOS: the log has `update: found 0.0.2` then `update: installed 0.0.2`; the AppImage's sha256 (the bundle's version on macOS) is `0.0.2`'s; the app runs again; no second `update: found`.
  - Windows: the log has `update: found 0.0.2` then `update: installing 0.0.2`; the installed exe's product version is `0.0.2`; the app runs again; the Run value is still there.
- `macos.sh` without a flag is the reference's smoke: a debug build run from a scratch `HOME` (state seeded with `loginItem` true, so this Mac gets no login item) against `ST/tests/fake-harness`; the log has `menu: Plug in your device | Sign in… | Export logs | About | Quit`; then it ends that process. It never touches the installed Harness Device or its folders.
- Temporary workflow: `update-e2e` on `ubuntu-22.04`, `ubuntu-22.04-arm` and `windows-latest` (x64): `update-pair.sh`, then the driver's update mode. A second Windows step builds the arm64 pair and uploads it as `device-app-windows-arm64-update` for 3 days.

- [ ] **Step 1: Write them and the job.** **Step 2:** `update-e2e` is green on its three runners; on this Mac, after `rustup target add aarch64-apple-darwin` (the release build is universal; only `x86_64-apple-darwin` is installed), `bash DA/scripts/e2e/update-pair.sh <scratchpad>/pair && bash DA/scripts/e2e/macos.sh --update <scratchpad>/pair` and `bash DA/scripts/e2e/macos.sh` pass. **Step 3: Commit** `End to end: the app updates itself from a local manifest on macOS, Windows and Linux`.

### Task 35: The gallery and the design doc show the terminal step

**Files:** Modify `DA/ui/src/gallery.ts`, `DA/ui/src/gallery.test.ts`, `desktop/design/desktop-design-system.md` (Harness Device, "Install, working").

- [ ] **Step 1: Failing test:** `STATES` has 15 states; one named `Install · working, terminal` has `lines` `['Finish in the terminal…']`.
- [ ] **Step 2:** `cd device-app/ui && npm test` FAILS. Commit red.
- [ ] **Step 3:** add the state after `Install · working`. The design doc's step list reads: `Getting ready…`, `Installing tmux…`, `Downloading Harness…`, and on Linux `Finish in the terminal…` while a terminal runs the step that may ask for a password.
- [ ] **Step 4:** `npm test`, `npm run typecheck` and `npm run gallery` pass. **Step 5: Commit** `The gallery and the design doc show the Install screen while a terminal runs`.

### Task 36: The docs describe Windows and Linux

**Files:** Modify `DA/AGENTS.md`, `DA/RELEASE.md`, `desktop/design/desktop-design-system.md` (Harness Device), `docs/validation-and-release.md`, `docs/windows-code-signing.md`, `docs/naming-system.md`.

One commit, no test. Describe what the code does; no person's name, no direction to agents.

- [ ] **Step 1: `DA/AGENTS.md`.** The first paragraph and "Toolchain": Windows 11 and Linux beside macOS 13. "Commands": the Windows leg, the container line for Linux, the three e2e drivers. "Fixed arguments" gains, each as fixed text: the PowerShell install line and its five arguments; the terminal candidates with the script's path, and the script; `xdg-open` with a URL or the zip's folder; `explorer.exe /select,"<zip>"`; the Windows shell's `open` on an `https:` URL; the desktop app's own file, run with no argument; and the `Exec=` line the app writes into `harnessd.desktop` (written, never run by the app). The last line becomes: PR CI compiles and tests the app on Linux and Windows; macOS is built and tested by hand.
- [ ] **Step 2: `DA/RELEASE.md`.** The files and manifest keys per platform; the `platforms` input and `--platforms`, and that it is temporary; the jobs table with `build-windows`, `sign-windows`, `build-linux`; the Windows order (exe signed, bundled, installer signed, update signature); how an installed app updates on Windows (downloads at once, installs when nothing runs, the log's `update: installing X`) and as an AppImage; the log's folder on each OS.
- [ ] **Step 3: the design doc's Harness Device section.** The named differences a person sees: About's dialog on Windows and Linux; the tray icon's two glyphs and Linux's light one; Export logs selects the zip in Explorer and opens its folder on Linux; the window has no taskbar button; a GNOME desktop without the AppIndicator extension shows no tray.
- [ ] **Step 4: the other three.** `docs/validation-and-release.md`: Harness Device's end-to-end drivers under what PR CI does not run. `docs/windows-code-signing.md`: a Device row in "What is signed" (`sign-windows` of `release-device.yml`: `harness-device.exe`, then each installer; always on). `docs/naming-system.md`: on Windows the installed name is `Harness Device`.
- [ ] **Step 5: Commit** `Docs: Harness Device on Windows and Linux`.

## Verification

Every check uses a fake CLI or a test profile. None signs in, none uses a real person's account, none reaches a production backend. The two checks that read production's public CDN (Verification 7) run by answer 4.

**1. On this Mac, per task** (nothing outside the worktree and the scratchpad): `cd device-app/src-tauri && cargo test --locked --lib`; `cd device-app/ui && npm test && npm run typecheck`; `python3 -m unittest discover -s device-app/scripts -p 'test_*.py'`; `python3 -m unittest scripts/tests/test_ci_plan.py`; `cd cli && npx vitest run src/scripts/installPs1.spec.ts`.

**2. Local gate PR CI does not run** (`docs/validation-and-release.md`, "Harness Device on macOS"): `cd device-app/src-tauri && cargo test --locked` on this Mac at the final commit, recorded in the pull request. Then the reference's own two checks, both from a scratch `HOME`, neither touching the installed app: `bash device-app/scripts/e2e/macos.sh` (a person sees `ok:` lines, the last naming the menu row line) and `bash device-app/scripts/e2e/update-pair.sh <scratchpad>/pair && bash device-app/scripts/e2e/macos.sh --update <scratchpad>/pair` (0.0.1 becomes 0.0.2 from `127.0.0.1:8765`).

**3. On GitHub, the temporary workflow** `tmp-device-app-win-linux.yml`, started by a push to `feat/device-app-win-linux` (by hand: push the branch; there is no dispatch). Runners are disposable; no secret exists in it.
- `windows-unit` (x64): the lib's tests and the binary's build.
- `linux-unit`: `cargo test --locked`.
- `windows-e2e` (x64): Task 32's seven checks. A person reads `ok:` for each and `0 FAILED`.
- `linux-e2e` (x64 on `ubuntu-22.04`, arm64 on `ubuntu-22.04-arm`): Task 33's nine checks.
- `update-e2e` (Linux x64 and arm64, Windows x64): 0.0.1 → 0.0.2 from a local manifest with a throwaway key.
- `windows-arm64-build`: the two arm64 artifacts the VM needs.
The workflow is removed before the merge. From then on PR CI runs the rules: `device-app-checks (ubuntu-latest)` and `device-app-checks (windows-latest)` in `ci.yml`.

**4. Windows ARM VM** (`admin@192.168.64.5`, a shared device: harness-pm gives the turn). Use the repo's kit, `desktop/scripts/windows-e2e/README.md`: `VM_HOST=192.168.64.5 VM_ADMIN=admin`, an owned test user (`user-add`), its own desktop session (`session-on`), files in with `put`, scripts with `run` and `ps`, pictures with `shot`, and `cleanup` by this run's receipt. Never the admin's desktop or profile. The installers are the artifacts of `windows-arm64-build` (`gh run download`).
- `windows.ps1 -Installer <arm64 debug installer>` in the test user's session: the seven checks pass on arm64.
- By eye, from `shot` pictures (a person looks): the tray shows the dark glyph on a light taskbar and the light one after the taskbar is set dark, without a restart; the menu's rows read as macOS's for no CLI, a daemon up and no dial; About shows `Harness`, the version and the credits line, in front; the Sign in screen, driven by the fake CLI's `login --json`, reads as macOS's; Export logs opens Explorer with the zip selected.
- The updater: `windows.ps1 -Update <arm64 pair>`: 0.0.1 becomes 0.0.2, the app runs again, the Run value stays.
- The daemon outlives the app (needs a real Windows CLI in the test profile, installed with the kit's `install-build.ps1` from a build harness-pm names, updates off): with the daemon up, end the app's process, then start the app and Quit from the menu; after each, `harness status` still shows the daemon running and the same pid. Until `feat/dial-windows` merges, the real `hardware watch` does not run on Windows; the app in front is proven with the fake CLI.
- If Windows refuses the unsigned test installer (Smart App Control), stop and report; do not change the VM's settings.

**5. Only a person with a Linux desktop** (for harness-pm; the AppImage is `linux-e2e`'s debug build or a `--prepare` run's):
- Ubuntu GNOME: the tray icon shows (AppIndicator), the rows read as macOS's, About opens in front, and after signing out and in again the app is running (the login entry).
- Fedora, stock GNOME: no tray; the log has `tray: no host`.
- KDE Plasma: the tray shows; on X11 the dial follows the app in front; on Wayland it does not, and the log has no `front:` line.

**6. For Ken, before the first signed release** (not in this pull request): whether Azure's federated credential accepts a run of `release-device.yml` in the `release` environment. `make release-device ARGS="--prepare --platforms all"` on `main` shows it without publishing.

**7. Run (answer 4)** (they read production's public CDN, sign in nowhere): the app's own install lines on a fresh profile. Linux, in `linux-e2e`: with no CLI and no state, the app opens xterm under Xvfb, `install.sh --host` and `--desktop` run, and the log reaches `menu: Plug in your device | Sign in… | Export logs | About | Quit`. Windows, on the VM's test user: the same with `install.ps1`, and no console window is seen.

**In PR CI, by itself,** once the pull request is ready: `device-app-checks` (both legs), `cli-tests` (Task 18), `desktop-tests` (the design doc is under `desktop/`), `process-checks` (actionlint, the planner's test). Nothing is started by hand. Platforms the pull request names: macOS (reference, re-tested), Windows x64 and arm64, Linux x64 and arm64.

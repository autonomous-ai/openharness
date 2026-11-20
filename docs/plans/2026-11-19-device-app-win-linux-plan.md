# Harness Device on Windows and Linux — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(device-app): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit. No task merges. Commits reach only `origin/feat/device-app-win-linux`, and only so the temporary workflow can run them (see "How a Windows task proves itself").

**Goal:** The Harness Device menu-bar app runs on Windows (x64, arm64) and Linux (x64, arm64) with macOS's menu, copy, states, consents, sign-in and updater, every difference a named one, and a Windows or Linux person gets it from `/device` and from Desktop as a Mac person does; on Linux both apps' AppImages start with no `libfuse2`, the Device app lists itself in the app list, and one line installs it; nothing is released.

**Architecture:**
- **One codebase, OS code behind the doors that exist** (`FrontSource`, `LoginItem`, `AppUpdater`, `DesktopApp`, `Shell`) and three new seams: a child-process seam under `cli.rs` (`child_unix.rs` / `child_windows.rs`), an `Opener` door (`open.rs`) and a per-OS install plan (`install::runs`). Each OS's code is a file of its own, declared once in `lib.rs` by Task 2, so tasks do not meet in `lib.rs` or `Cargo.toml`.
- **The menu model takes no OS.** `model.rs` and `app.rs` stay free of `cfg` and `consts::OS`; the one timing difference (Windows' held install) enters `App::new` as `install_exits_app`, and a parity test (Task 25) holds that line.
- **Getting the app (spec section 10, Tasks 37 to 46).** The website gains one route per OS beside `/device/download-macos`, the arch read from the request; Desktop's offer keeps its one model (`DeviceAppOffer`) and screens, and only its manifest keys, installer, probe, opener, words (tray app off macOS) and, on Linux, an app-list entry learn Windows and Linux, each in its own file so they are built side by side.
- **Installing on Linux (spec section 11, Tasks 47 to 57).** A probe on clean Ubuntu 24.04 and 22.04 runners with `libfuse2` removed decides whether each AppImage needs the static type2 runtime; where it does, the build swaps the runtime for a pinned, sha256-checked one after bundling. The app-list entry `harness-device.desktop` has three writers (the Device app at every launch from an AppImage, Desktop's installer, the one-line installer) and one rule, held in one vectors file (`tests/fixtures/app-list-entry-vectors.json`) that the Rust, Dart and website tests all read. The one-line installer is a website script published like Desktop's; `/device` shows its line only when the live manifest has a Linux AppImage, inside Diego's existing `DeviceDownload` with its existing classes.
- **Pure rule, thin OS call.** Every rule is a function over plain values that `cargo test --lib` runs on this Mac; the Win32, socket and file calls around it are a few lines, proven on a `windows-latest` runner or a Linux runner.

**Tech Stack:** Next.js 16 and vitest (`website/`), Flutter and Dart (`desktop/`) for Tasks 37 to 46; Rust 1.95+ and Tauri 2.12 (`device-app/src-tauri`; its AppImage bundler is tauri-bundler 2.10.4's linuxdeploy `07333c6` with the `continuous` linuxdeploy-plugin-appimage), `windows-sys` 0.61 (already in Tauri's tree) on Windows, std and `libc` on Linux; plain TypeScript for the window (`device-app/ui`); Python `unittest` and Bash for the release rules (`device-app/scripts`); GitHub Actions.

**Spec:** `docs/plans/2026-11-19-device-app-win-linux-design.md`. Read it with this plan, the root `AGENTS.md`, `device-app/AGENTS.md`, `device-app/RELEASE.md`, `docs/validation-and-release.md` and `docs/windows-code-signing.md`.

Path shorthand below: `ST/` is `device-app/src-tauri/`, `DA/` is `device-app/`, `WS/` is `website/`, `DT/` is `desktop/`.

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
| 26 | Packaging details | `ST/tauri.conf.json`, `ST/tauri.windows.conf.json`, `ST/tauri.linux.conf.json`, `ST/icons/32x32.png`, `ST/icons/128x128.png`, `ST/icons/128x128@2x.png`, `ST/src/packaging.rs`, `ST/src/main.rs` | 2, 12 | high | `packaging.rs` |
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
| 37 | Website: the Windows and Linux download routes | `WS/src/lib/deviceManifest.ts` (new), `WS/src/lib/deviceArch.ts` (new), `WS/src/lib/deviceArch.spec.ts` (new), `WS/src/app/device/download-windows/route.ts` and `route.spec.ts` (new), `WS/src/app/device/download-linux/route.ts` and `route.spec.ts` (new), `WS/src/app/device/download-macos/route.ts` | none | high | `deviceArch.spec.ts`, both new `route.spec.ts` |
| 38 | Website: `/device` offers macOS, Windows and Linux | `WS/src/app/device/page.tsx`, `WS/src/app/device/page.spec.tsx`, `WS/next.config.js`, `WS/README.md` | none | high | `page.spec.tsx` new cases |
| 39 | Desktop: what Windows and Linux install, and where | `DT/lib/devices/device_app.dart`, `DT/lib/devices/device_app_manifest.dart`, `DT/lib/devices/device_app_installer.dart` (one call), `DT/test/devices/device_app_manifest_test.dart`, `DT/test/devices/device_app_test.dart` | none | high | `device_app_manifest_test.dart`, `device_app_test.dart` new cases |
| 40 | Desktop installs and starts the app on Windows and Linux | `DT/lib/devices/device_app_installer.dart`, `DT/test/devices/device_app_installer_test.dart`, `DT/integration_test/device_app_install_native_test.dart` (its `_run` takes the timeout) | 39 | xhigh | `device_app_installer_test.dart` new cases |
| 41 | Windows: the installer is signed like Desktop | `DT/lib/update/update_signature.dart`, `DT/test/update_signature_test.dart`, `DT/lib/devices/device_app_setup.dart`, `DT/test/devices/device_app_setup_test.dart` | none | xhigh | `device_app_setup_test.dart`, `update_signature_test.dart` new cases |
| 42 | Desktop finds the app on Windows and Linux | `DT/lib/devices/device_app_probe.dart`, `DT/test/devices/device_app_probe_test.dart` | 39 | high | `device_app_probe_test.dart` new cases |
| 43 | Desktop offers the app on Windows and Linux, in each OS's words | `DT/lib/devices/device_app.dart`, `DT/lib/devices/device_app_setup.dart`, `DT/lib/widgets/device_app_band.dart`, `DT/lib/devices/device_app_row.dart`, `DT/test/devices/device_app_test.dart`, `DT/test/devices/device_app_setup_test.dart`, `DT/test/devices/device_app_flow_test.dart`, `DT/test/devices/device_app_band_test.dart`, `DT/test/devices/device_app_row_test.dart`, `DT/test/elements_gallery_test.dart`, `DT/test/goldens/elements/device-app-light.png`, `DT/test/goldens/elements/device-app-dark.png`, `DT/design/desktop-design-system.md` | 39, 40, 41, 42 | high | `device_app_flow_test.dart`, `device_app_test.dart`, `device_app_setup_test.dart`, `device_app_band_test.dart`, `device_app_row_test.dart` new cases |
| 44 | End to end: Desktop installs the real app on Windows and Linux | `DT/integration_test/device_app_install_windows_linux_native_test.dart` (new), `.github/workflows/tmp-device-app-win-linux.yml` | 43, 46 | high | none: test tooling, one commit; its job is the evidence |
| 45 | Docs: who reads which download key | `DA/RELEASE.md` | 37, 38, 43, 46 | medium | none: docs, one commit |
| 46 | Linux: Desktop puts the app in the app list | `DT/lib/devices/device_app_launcher.dart` (new), `DT/test/devices/device_app_launcher_test.dart` (new), `DT/lib/core/linux_app_image.dart`, `DT/lib/devices/device_app_installer.dart`, `DT/test/devices/device_app_installer_test.dart`, `DT/lib/app_shell.dart` | 40 | high | `device_app_launcher_test.dart`, `device_app_installer_test.dart` new cases |
| 47 | Linux: does each AppImage start without `libfuse2`? (the probe) | `.github/workflows/tmp-device-app-win-linux.yml`, `DA/scripts/e2e/appimage-starts.sh` (new) | none | high | none: a probe on the temporary workflow, one commit; its run is the evidence |
| 48 | The Device app's AppImage on the static runtime | `DA/scripts/appimage-runtime.sh` (new), `DA/scripts/test_appimage_runtime.py` (new), `DA/scripts/release-build.sh`, `DA/scripts/release-check.sh`, `DA/scripts/test_release_build.py`, `.github/workflows/tmp-device-app-win-linux.yml` | 47 | xhigh | `test_appimage_runtime.py`, `test_release_build.py` new cases (none if Task 47 finds it starts already) |
| 49 | Desktop's AppImage on the static runtime | if needed: `DT/scripts/package-desktop-linux.sh` (new), `DT/scripts/upload-desktop-linux.sh`, `.github/workflows/release-desktop.yml`, `DA/scripts/test_appimage_runtime.py`, `DT/RELEASE.md`; always `.github/workflows/tmp-device-app-win-linux.yml` | 47, 48 | high | `test_appimage_runtime.py` new case (none if Task 47 finds it starts already) |
| 50 | One rule for `harness-device.desktop`: the vectors | `tests/fixtures/app-list-entry-vectors.json` (new), `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py` | 47 | high | `test_ci_plan.py` new case |
| 51 | Linux: the Device app lists itself in the app list | `ST/src/app_list.rs` (new), `ST/src/lib.rs`, `ST/src/main.rs`, `DA/scripts/e2e/linux.sh` | 50 | high | `app_list.rs` |
| 52 | Desktop writes the app's entry by the same rule; the flow test | `DT/lib/devices/device_app_launcher.dart`, `DT/test/devices/device_app_launcher_test.dart`, `DT/lib/core/linux_app_image.dart`, `DT/test/linux_app_image_test.dart`, `DT/test/devices/device_app_flow_test.dart`, `DT/test/support/device_app.dart` | 50 | high | `device_app_launcher_test.dart`, `linux_app_image_test.dart`, `device_app_flow_test.dart` new cases |
| 53 | The one-line installer and its route | `WS/scripts/device-install.sh` (new), `WS/scripts/device-install.spec.ts` (new), `WS/next.config.js`, `WS/README.md`, `.github/workflows/release-device.yml`, `DA/scripts/test_release_workflow.py` (the release uploads the script; answer 2) | 50 | xhigh | `device-install.spec.ts` |
| 54 | End to end: the one line on Ubuntu 24.04 with no `libfuse2` | `DA/scripts/e2e/linux-install.sh` (new), `DA/scripts/e2e/https-fake-cdn.py` (new), `.github/workflows/tmp-device-app-win-linux.yml` | 48, 51, 53 | high | none: test tooling, one commit; its job is the evidence |
| 55 | `/device` shows the line to Linux visitors | `WS/src/lib/installCommand.ts`, `WS/src/lib/installCommand.spec.ts`, `WS/src/app/device/DeviceDownload.tsx`, `WS/src/app/device/DeviceDownload.spec.tsx` | 53 | high | `installCommand.spec.ts`, `DeviceDownload.spec.tsx` new cases |
| 56 | End to end: Desktop's entry and the app's are one | `DT/integration_test/device_app_install_windows_linux_native_test.dart` | 51, 52 | medium | none: test tooling, one commit; its job is the evidence |
| 57 | Docs: installing on Linux | `DA/RELEASE.md`, `DA/AGENTS.md`, `docs/validation-and-release.md` | 47 to 56 | medium | none: docs, one commit |

**Longest chain:** 2 → 3 → 4 → 12 → 26 → 32 → 34 → 36 (eight tasks). Tasks 1, 2, 6, 7, 14, 18, 27 and 28 start at once. Tasks 1 to 36 have landed. Of the section 10 tasks, 37, 38, 39 and 41 start at once; 40 and 42 run side by side after 39; 43 and 46 run side by side after 40 (43 also waits for 41 and 42); the longest chain is 39 → 40 → 43 → 44 (four tasks; 39 → 40 → 46 → 44 is as long). The website tasks (37, 38) share no file with the Desktop tasks; 40, 41 and 42 share no file with each other, nor do 43 and 46. `ST/src/main.rs` is in nine tasks (14, 17, 20 to 26) and `ST/src/runner.rs` in five; those run one after another because they share the file, in any order their own dependencies allow.

Section 11 (Tasks 47 to 57): 47 starts at once; its report (the before table and the window's `WM_CLASS`) is what 48, 49 and 50 start from. After 50, Tasks 51 (Rust), 52 (Desktop) and 53 (website) run side by side, sharing no file. The longest chain is 47 → 50 → 51 → 54 → 57 (five tasks; 47 → 50 → 53 → 54 → 57 and 47 → 50 → 53 → 55 → 57 are as long). The temporary workflow is in 47, 48, 49 and 54, so those four run one after another.

## Global Constraints

- **macOS is the reference.** Same rows, order, copy, states and transitions. A difference exists only where the spec's "Named differences" table has a row; a new one is a stop question, not a choice.
- **No release is run.** No task starts `release-device.yml`, tags, or publishes.
- **No new dependency.** Only `windows-sys` 0.61 (Task 2; in `Cargo.lock` at 0.61.2 already) and, on Linux, `dbus` 0.9 (Task 23; in `Cargo.lock` at 0.9.12 already) as direct dependencies. No new Tauri plugin; `tauri-plugin-updater` stays the one plugin, called from Rust only. Linux OS calls are std and `libc`. `Cargo.lock` gains exactly one line (`"windows-sys 0.61.2"` under `harness-device`).
- **`device-app/AGENTS.md` rules hold on every OS:** thin over the CLI; every command the app runs is fixed text in Rust and is added to "Fixed arguments" (Task 36); the app in front goes to the watch's stdin and nowhere else, never the log; one log, every line through `log::redact`; `HARNESS_DEVICE_CLI` is read by debug builds only; no other component's path in a string literal (join segments one by one; name other components only in comments).
- **Nothing from the webview, the manifest or an OS window title reaches a command line or the log.** A socket path, an X or sway error's text, an exe path and a zip path are never logged.
- **Push, not poll**, for the app in front and the Windows theme. No fixed sleep in a test: a wait is bounded and ends on the event.
- **Not touched:** the CLI's behavior, the devices service, the watch protocol, the devices pipe, `cli/scripts/install.sh`, `cli/scripts/install.ps1`, Desktop's offer model (`device_app_offer.dart`), band and row (no new state or screen; only their words change off macOS, Task 43). The website and Desktop change only as section 10 asks (Tasks 37 to 46).
- **Exact names and copy** (byte for byte):
  - Windows installed name, everywhere: `Harness Device` (folder `%LOCALAPPDATA%\Harness Device`, Start Menu shortcut, Apps-list entry, Run value). Tray tooltip and window title stay `Harness`.
  - Release files: `Harness-Device-windows-x64-setup.exe`, `Harness-Device-windows-arm64-setup.exe`, `Harness-Device-linux-x64.AppImage`, `Harness-Device-linux-arm64.AppImage`, each with a `.sig`.
  - Manifest keys: `platforms.windows-x86_64`, `platforms.windows-aarch64`, `platforms.linux-x86_64`, `platforms.linux-aarch64` (`{url, signature}`); `device-windows-x64-exe`, `device-windows-arm64-exe`, `device-linux-x64-appimage`, `device-linux-arm64-appimage` (`{version, url, sha256, size}`).
  - Windows install line, Desktop's `windowsInstallCommand` word for word: `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); iex "& { $(irm 'https://cdn.autonomous.ai/harness/cli/install.ps1' -ErrorAction Stop) } -Desktop"; exit $LASTEXITCODE`, run by `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <the line>`.
  - Linux login entry: `<config>/autostart/harnessd.desktop`, name `Harness`, `NoDisplay=true`, `X-GNOME-Autostart-enabled=true`.
  - Log lines: `front: sway not followed`, `front: sway ended`, `front: Hyprland not followed`, `front: Hyprland ended`, `front: Windows not followed`, `front: Windows ended`, `tray: no host`, `instance: already running`.
  - Install step on Linux while the terminal runs: `Finish in the terminal…` (answer 1).
- **Windows release signing is always on** for the Device app: no `WINDOWS_SIGNING` switch, no unsigned fallback.
- **Getting the app (section 10), exact names:**
  - Routes: `/device/download-windows` (a `.exe` under the device folder, key `device-windows-x64-exe` or `device-windows-arm64-exe`), `/device/download-linux` (an `.AppImage`, key `device-linux-x64-appimage` or `device-linux-arm64-appimage`); the manifest URL and the two allowed prefixes are `/device/download-macos`'s, unchanged. Before a release carries the key the answer is the macOS route's 503: `Harness download is temporarily unavailable (no usable device-windows-x64-exe entry).` (each key its own).
  - `/device` buttons: `macOS`, `Windows`, `Linux`. Its line, the same for every visitor: `The app for your Harness device. macOS 13 or later, Windows 10 or 11, Linux.` `/device` answers with `Accept-CH: Sec-CH-UA-Arch, Sec-CH-UA-Bitness`.
  - Desktop's places: Windows `%LOCALAPPDATA%\Harness Device\harness-device.exe` (the NSIS per-user install), Linux `~/.local/opt/Harness-Device.AppImage`.
  - Desktop's words (spec §10, harness-pm 2026-11-20). macOS, unchanged: the band's `Your dial follows apps and terminal tabs with the Harness menu-bar app.`; the row's `Menu-bar app` and `Follows the app and terminal tab in front.` Windows and Linux: the band's `Your dial follows apps with the Harness tray app.`; the row's `Tray app` and `Follows the app in front.` The failure lines and the buttons are the same on every OS.
  - Linux app-list entry (Task 46): `<data>/applications/harness-device.desktop` and its icon `<data>/icons/harness-device.png`, `<data>` being `XDG_DATA_HOME`, else `~/.local/share` (as Desktop's own `harness.desktop`). The entry, byte for byte: `[Desktop Entry]\nType=Application\nName=Harness Device\nComment=The app for your Harness device.\nExec=<the place, quoted as Desktop quotes its own>\nIcon=<data>/icons/harness-device.png\nTerminal=false\nCategories=Utility;\n` (no `Icon=` line when the icon could not be taken from the AppImage).
- **The manifest stays input on every surface.** The website redirects only into `<prefix><X.Y.Z>/<file>` with the route's extension; Desktop downloads only a URL `_fetchable` passes, saves it under a fixed name, and runs a Windows installer only after its Authenticode signer matches the running Desktop's.
- **Installing on Linux (section 11), exact names:**
  - The app-list entry, every writer: `<data>/applications/harness-device.desktop`, its icon `<data>/icons/harness-device.png`; `<data>` is `XDG_DATA_HOME` when it is absolute, else `$HOME/.local/share` when `HOME` is absolute, else nothing is written. The entry's bytes are the vectors file's (Task 50): Task 46's bytes with one line added last, `StartupWMClass=<the Device app window's WM_CLASS class, as Task 47 reads it>`. This supersedes Task 46's bytes in the line above.
  - The icon is the image's own `usr/share/icons/hicolor/128x128/apps/harness-device.png`: the Device app reads it under its `APPDIR`; Desktop and the one-line installer take it with `--appimage-extract`.
  - Log lines of the Device app: `app list: entry written`, `app list: entry not written (error N)` (the OS error's code) or `app list: entry not written (<io::ErrorKind>)`. No path.
  - The static runtime (only where Task 47 says it is needed): `https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64` and `…/runtime-aarch64`, each pinned by its sha256 in `DA/scripts/appimage-runtime.sh`.
  - The one-line installer: source `website/scripts/device-install.sh`, published to `gs://s3-autonomous-upgrade-3/harness/device/install.sh` (`https://cdn.autonomous.ai/harness/device/install.sh`) by `release-device.yml`'s `publish`, before the manifest, with every release that carries Linux (Answer 2 of section 11); `https://harness.autonomous.ai/device/install.sh` redirects there for good. The line: `curl -fsSL https://harness.autonomous.ai/device/install.sh | bash`. It installs to `~/.local/opt/Harness-Device.AppImage` (Desktop's place, Task 39) from the manifest key `device-linux-x64-appimage` or `device-linux-arm64-appimage`.
  - Its words: `Fetching the latest Harness Device release…`, `Downloading Harness Device ${VERSION}…`, `Harness Device $VERSION installed at $DESTINATION`; each failure `Harness Device installer: <reason>` on stderr, exit 1, the reasons as `desktop-install.sh`'s Linux branch with `Harness Device` for `Harness desktop`/`Harness` and `AppImage` for `archive`; off Linux `Harness Device installer: this installer is for Linux (found: <uname -s>).`
  - `/device`'s line (spec: it names no plan and no package): `Or in a terminal:` then the command in a `code` element.

## Decided here, where the spec was silent

- **The child seam** has one shape on both OSes: `spawn(&mut Command) -> io::Result<(std::process::Child, Group)>`, `Group::{exited, kill, stop, code}`, `Stdin::{new, line}`. `cli.rs` keeps `run_until`, `Child`, `Killer`, `StdinCloser`, `StdinWriter` and their signatures.
- **A child the app killed has no exit code on Windows** (`Group::code` answers `None`), as a signal does on unix. Without this a killed watch would read as exit 1, which the keep-alive takes for an old CLI (`Updating Harness` for a minute).
- **A job's handle closes when its child is reaped or the app exits**, and what is still in the job then ends. The daemon is never in it (it breaks away). On unix a finished run's leftovers live on; nothing the app runs leaves one on purpose.
- **Windows stdin queue:** 16 lines (`STDIN_QUEUED`), as `LINES_QUEUED`.
- **Sign-in cancel**, on every OS, closes `harness login --json`'s stdin and kills its group only if it has not ended within the grace. Checked for the spec: the CLI's spawn lock reclaims a dead holder's lock (`cli/src/lib/daemonSpawnLock.ts` `reclaimIfStale`, by `lockOwnerAlive`), so no stop question arises.
- **The updater door is two steps on every OS:** `download()` (the writable check, the download, the signature) and `install()` (put it in place). macOS and Linux install the moment the download answers, so their behavior is today's; Windows holds the install. One way to do it, and macOS's rules stay pinned by `app.rs`'s tests.
- **Windows cannot log `update: installed X`** (the plugin exits the app inside the install). It logs `update: installing X` when the install starts. The watch is not stopped first: its job ends with the app.
- **About on Windows and Linux** is muda's predefined About item (its dialog cannot be opened from code), fed by a new `Effect::AboutCredits` so the dialog has the credits line when the menu is drawn. The credits go in `comments`. macOS ignores the effect and keeps its panel.
- **Opening things is a door of three verbs** (`Opener`: `url`, `reveal`, `desktop`), since Windows and Linux have no single `open` program.
- **The Linux terminal run** follows Desktop: a script file `host-<n>.sh` (mode 0700, in `<app data>/setup/`, a 0700 folder emptied at each run) handed with `/bin/sh` to the first of `x-terminal-emulator -e`, `gnome-terminal --`, `xterm -e` that is there; the script writes `host-<n>.started` once it runs and its exit code to `host-<n>.exit` beside itself (a temp file, then a rename), also on HUP, INT and TERM. A terminal that has not run it within 30 s fails with `The terminal did not open.`; then the app reads the exit file once a second until `INSTALL_DEADLINE`. With no terminal on the computer the line runs behind the screen, as on macOS. Desktop reads the same file every 5 s. On a failure the terminal waits for Enter so the error can be read. Its output is not logged (it is the terminal's); only `install: --host exit N`.
- **`LoginItem` gains `refresh()`** (default: nothing), which the runner calls at every launch, not after an install: Linux's take-over of an entry that is on. `register()` stays the once-only first registration.
- **The Linux entry's `Exec=`** is one fixed line (Task 13 has its bytes). "The app's own" means equal to that line for this AppImage and launcher.
- **Windows login item:** the Run value names `current_exe()` of whatever build runs. A `StartupApproved` value whose first byte is odd (`03`, `07`) reads `RequiresApproval` whether or not the Run value exists.
- **Tray glyphs:** the dark one is today's `tray.png`; only `tray-light.png` is new. A missing `SystemUsesLightTheme` reads as a dark panel (Windows 10's taskbar without the value is dark).
- **One instance:** `instance.lock` in the app's data folder; the lock is dropped before a relaunch, so the new process never loses to the old one's lock. A lock that cannot be made is logged and the app runs.
- **Every Windows build is a GUI program** (`windows_subsystem = "windows"`, debug builds too): with a console of its own the app would hide a missing `CREATE_NO_WINDOW`, and a release would show a console.
- **Per-OS bundle settings live in `tauri.windows.conf.json` and `tauri.linux.conf.json`** (Tauri merges them over the base), so `tauri.conf.json` changes one line.
- **Desktop app on Windows:** `Harness\Harness.exe` in the shell's user programs folder (`FOLDERID_UserProgramFiles`), else `%LOCALAPPDATA%\Programs\Harness\Harness.exe` (the launcher `harness-install.exe` leaves; `desktop/scripts/windows-e2e/install-state.ps1`). The builder confirms it against the installer's code.
- **Hyprland:** the first value and every `activewindowv2>>` with a new window address ask `j/activewindow` (a first ask that fails tells `""` and following goes on); the event's own text is never used (the v1 event carries a window title).
- **Release, Windows:** three jobs. `build-windows` compiles with no secret and no identity and hands on the exe and the Tauri CLI it built. `sign-windows` (`environment: release`, `id-token: write`) compiles and installs nothing: it signs the exe, bundles with that Tauri CLI, signs the installer, then makes the `.sig` with `cargo tauri signer sign --app-version`, the only step that holds `TAURI_SIGNING_PRIVATE_KEY`. `check-windows` checks and hashes the result with no identity.
- **`platforms=macos` keeps live Windows and Linux keys byte for byte**, as the spec says. Hazard for the first-release pull request, not handled here: a macOS-only release after those keys are live would send Windows and Linux apps to an installer whose signed version does not match.
- **Long end-to-end checks run on the temporary workflow**, on GitHub's Linux and Windows runners (disposable machines, the same isolation as the spec's containers). Proposals, not built here: a `sway` live step in `device-app-checks`, and an on-demand `device-app-e2e.yml`.

## Decided here for section 10 (getting the app)

- **How the website picks the arch.** The route reads the request (`deviceArch`, Task 37): the Client Hints `Sec-CH-UA-Arch` and `Sec-CH-UA-Bitness` first (`"arm"`+`"64"` is arm64, `"x86"`+`"64"` is x64); on Linux only, then the user agent naming `aarch64` or `arm64` (Firefox writes the real CPU there; Chromium freezes `Linux x86_64`); otherwise x64. Windows' user agent says `Win64; x64` on ARM too, so it is never read. Chromium sends those hints only to a site that asked, so `/device` answers with `Accept-CH` (Task 38): a click on its button carries them. A Windows ARM PC that cannot tell gets x64, which Windows 11 runs emulated and Windows 10 cannot run; a Linux ARM computer that cannot tell gets x64, as the spec says. Why the route and not the page (as `/desktop` does): the spec names one route per OS. A pasted link carries the hints only in a Chromium that has visited `/device` before; elsewhere it gets x64.
- **One device-manifest module.** `/device/download-macos`'s fixed manifest URL and prefixes move to `WS/src/lib/deviceManifest.ts` with `resolveDeviceDownload(field, extension)`, so the three routes share one copy (a second copy is a second way).
- **`/device` is three plain links**, server-rendered, no detection: the spec asks for matching buttons; a visitor picks the OS, the route picks the arch.
- **Where Desktop puts the AppImage: `~/.local/opt/Harness-Device.AppImage`** (`deviceAppPlace`, Task 39). Beside Desktop's own `~/.local/opt/Harness.AppImage` (`website/scripts/desktop-install.sh`), one fixed name with no version or arch, so the Device app's updater replaces it in place and its login entry (which follows `APPIMAGE`) keeps naming the same file. No space in the name: the login entry's `Exec=` stays plain.
- **Windows: Desktop runs the installer, NSIS decides the place.** `Harness-Device-setup.exe /S`, per user, no admin (`installMode: currentUser`): the app lands at `%LOCALAPPDATA%\Harness Device\harness-device.exe` with its Start Menu entry, Apps-list entry and uninstaller, exactly as a person's own run of the installer. The installer runs through `startHidden` with a 5-minute bound (`deviceAppSetupTimeout`; NSIS may fetch WebView2 first).
- **Never installed over.** As on macOS, a copy already at the place, whoever put it, is the app: the installer is not run again and the AppImage is not replaced (the Device app updates itself).
- **The signature step.** macOS: as today (Desktop's team, notarized). Windows: the downloaded installer's Authenticode signer must be `Valid` and match the running `harness-desktop.exe`'s subject and Azure identity, the rule Desktop's own Windows updater uses (`WindowsSigner.sameAs`); a running Desktop that is not signed (a local or staging build) keeps the sha256 check alone, as macOS's local build does. Both apps are signed by the same Azure profile (Task 30 reuses `release-desktop.yml`'s inputs). Linux: none, as Desktop's own AppImage update (sha256 and size); an AppImage carries no OS signature, and Desktop has no minisign check to reuse.
- **The probe rule, Windows and Linux** (`PlaceDeviceAppProbe`, Task 42): **installed** when the file at the place exists or the app runs; **running** when a process of this user is the app: on Windows a `tasklist.exe` row (from `System32`, `/FI "IMAGENAME eq harness-device.exe" /FI "USERNAME eq <USERNAME>" /FO CSV /NH`, bounded at 10 s), on Linux a `/proc/<pid>` whose `comm` is `harness-device` and whose real uid is this process's. This mirrors macOS's `NSRunningApplication` by bundle id (any copy of the app, this user's session). Why no native channel as on macOS: Windows and Linux have no LaunchServices to ask, the rule is a file and a process list Dart reads itself, and so PR CI tests it.
- **How Desktop starts the app** (`startDeviceApp`, Task 40): the place's file itself, with no argument, detached (`ProcessStartMode.detached`), so it outlives Desktop and is no child of it; with Desktop's environment minus `APPIMAGE`, `APPDIR`, `ARGV0` and `OWD` (what Desktop's own AppImage runtime set: the Device app must never take Desktop's AppImage for its own). It counts as opened when the start succeeds, as `open`'s exit 0 does on macOS. `Open` on the row with no path starts the place. The Device app's own single instance (Task 21) makes a second start harmless.
- **The arch Desktop installs** (`parseDeviceAppManifest`, Task 39), from `runtimeArchitecture` as on macOS: Windows arm64 takes `device-windows-arm64-exe`, then `device-windows-x64-exe` (Windows 11 on ARM runs x64 emulated; Windows 10 on ARM does not, so it needs the arm64 build, as an Apple silicon Mac falls back to the universal build); Windows x64 takes only `device-windows-x64-exe`; Linux takes only its own arch (an x64 AppImage does not run on arm64).
- **Where Desktop offers it** (`deviceAppSupported`, Task 43): macOS 13 or later (today), every Windows Desktop runs on (Windows 10 or 11, Desktop's own floor), every Linux; never the web or a viewer. Nothing the Device app uses needs Windows 11: WebView2 (the bootstrapper installs it on Windows 10), the WinEvent hook, the per-user NSIS install, the Run and StartupApproved values, and `SystemUsesLightTheme` (Windows 10 1903+; missing reads as dark) all work on Windows 10 (harness-pm, 2026-11-20). Windows 10 on ARM runs no x64 app, so it takes only the arm64 build.
- **Which words the band and row show** (`deviceAppCopy`, Task 43): chosen by `defaultTargetPlatform` (the host OS in the app; `TargetPlatformVariant` in tests). The band and row take an optional `platform` (null: `defaultTargetPlatform`), as the band already takes `leadingClearance`, only so the gallery draws each OS's words on every host. `/device` keeps its floors sentence after the new first sentence: the spec's answer changes only the words before it.
- **The Linux app-list entry** (Task 46). Desktop writes it when its install step ends with the AppImage at the place (also when a copy was already there), before it opens the app; it never fails the install (a failure is logged, as Desktop's own entry). An entry whose `Exec=` names another AppImage still on disk is left alone (a person's own). The icon is the AppImage's own 128-pixel icon, taken with the AppImage runtime's `--appimage-extract usr/share/icons/hicolor/128x128/apps/harness-device.png` in a temp folder of its own, bounded at 10 s (the way `website/scripts/desktop-install.sh` takes Desktop's icon; Tauri names the icon after the binary, `harness-device`, and Task 44's check 7 proves the path on the real AppImage). The log names no path.
- **When the entry goes.** Desktop has no uninstall path for the Device app today (nothing in `desktop/lib/devices/` removes it: a person deletes the AppImage, and the offer comes back once it is gone). So Desktop removes the entry and its icon at each Linux launch when the entry's `Exec=` names a file that is no longer on disk, beside `registerAppImageLauncher()` in `app_shell.dart` (the same check Desktop makes on its own entry). An entry with no `Exec=`, or whose file is there, is left alone.

Named differences of section 10 (Windows / Linux against macOS):

| Step | macOS | Windows | Linux | Why |
|---|---|---|---|---|
| Package | `Harness-Device.app.tar.gz`, unpacked | `Harness-Device-setup.exe`, run `/S` | `Harness-Device.AppImage`, copied | what each release ships |
| Place | `/Applications`, then `~/Applications` | `%LOCALAPPDATA%\Harness Device\` (NSIS) | `~/.local/opt/` | beside Desktop's own install on each OS |
| `unpack` step | `tar` | none | none | nothing to unpack |
| `signature` step | Developer ID team, notarized | Authenticode, Desktop's signer | none | Linux has no OS signature; Desktop's own Linux update checks none |
| Installed | LaunchServices lists a copy outside Trash and `/Volumes` | the place's file, or it runs | the place's file, or it runs | no app registry on Windows or Linux |
| Running | `NSRunningApplication` by bundle id | `tasklist`, this user, `harness-device.exe` | `/proc`, this user, `harness-device` | the same question, the OS's own list |
| Open | `/usr/bin/open` (path or bundle id) | start the place's exe | start the place's AppImage without Desktop's AppImage variables | no `open` |
| Offered on | macOS 13+ | Windows 10 or 11 (Desktop's floor) | every Linux | the Device app's own floor |
| Arch fallback | arm64 → universal | arm64 → x64 | none | x64 runs emulated on Windows 11 ARM, not on Linux arm64 |
| App list entry | `/Applications` shows in Launchpad | Start Menu entry (NSIS) | `harness-device.desktop`, written by Desktop (Task 46) | an AppImage registers nothing itself |
| Words | menu-bar app; apps and terminal tabs | tray app; apps | tray app; apps | a tray, not a menu bar; no terminal tab is followed |

Section 10 answers (harness-pm, 2026-11-20, spec §10): the copy per OS (Global Constraints; Tasks 38, 43), and the Linux app-list entry Desktop writes (Task 46).

## Decided here for section 11 (installing on Linux)

- **The probe runs on GitHub's runners, not Podman.** The static runtime mounts with FUSE through `fusermount3`, which a container gets only with `/dev/fuse` and `SYS_ADMIN`, and a bare `ubuntu` image lacks the desktop libraries an AppImage leans on: neither is the clean Ubuntu a person has. `ubuntu-24.04`, `ubuntu-22.04`, `ubuntu-24.04-arm` and `ubuntu-22.04-arm` are disposable VMs; the job removes `libfuse2` (and `libfuse2t64` on 24.04), proves `ldconfig -p` names no `libfuse.so.2`, and installs `fuse3` when missing (a stock Ubuntu desktop has it since 22.04). Podman stays a local way to read a log, never the evidence.
- **What "starts" means** (`appimage-starts.sh`, Task 47): within 60 s a process of the run has its `/proc/<pid>/exe` under the runtime's FUSE mount (`${TMPDIR:-/tmp}/.mount_*`), with `APPIMAGE_EXTRACT_AND_RUN` unset; the runtime exiting first is a failure, named by the first line it printed (the dynamic runtime's `dlopen(): error loading libfuse.so.2`). It is the step a double-click takes: the runtime mounts the image and runs what is in it. The Device app's debug build is probed: the runtime is the bundler's whichever profile (`release-build.sh` runs the same `cargo tauri bundle --bundles appimage`). Desktop's is the current release's AppImage from the public manifest (Open question 1).
- **How the runtime is replaced** (Task 48, only if needed): after Tauri's bundle, `appimage-runtime.sh` asks the bundled AppImage for `--appimage-offset` (the old runtime answers without FUSE), checks the bytes there are squashfs (`hsqs`), and writes the pinned runtime followed by those bytes, mode 0755, over the same file; it then asks the new file for its offset (the pinned runtime's size) and checks `hsqs` again. Tauri has no setting for the runtime (tauri-bundler 2.10.4 takes linuxdeploy-plugin-appimage's), so this is the one way; it runs inside `release-build.sh bundle`, before the update signature, so `sign-update` signs the shipped bytes. The pinned file is downloaded once into `${XDG_CACHE_HOME:-$HOME/.cache}/harness-device-build/` and its sha256 checked at every use.
- **The app-list entry's one rule**, for every writer (Device app, Desktop, the one-line installer): no entry → write. An entry whose `Exec=` names this AppImage → leave it when its bytes are the ones this writer would write and the icon it names is there, else write. An entry whose `Exec=` names an absolute path that is not on disk → write. Anything else (another AppImage on disk, a relative `Exec=`, no `Exec=`) → leave. Written through a temp file and a rename, the icon first. A path holding a control character, or not UTF-8, writes nothing. The vectors file holds every case; the Rust, Dart and website tests read it, so the writers cannot drift.
- **The one-line installer writes the entry only when none exists**, and leaves every other case to the app it starts, whose first run applies the whole rule (Task 51) a moment later: the end state is the rule's in every case, and the script holds no `Exec=` parser.
- **The Device app writes the entry at every launch from an AppImage**, on a thread of its own beside the tray-host check, so a slow or failing disk never holds or fails the launch. It writes nothing outside an AppImage (`APPIMAGE` unset, relative or not a file) and runs no `update-desktop-database` (the entry has no `MimeType=`, which is all that cache is for). The icon is read from `$APPDIR` (absolute, as `appimage_env.rs` takes it): the image's own file, no FUSE beyond the mount the app already runs from, and byte for byte the file Desktop and the script extract.
- **The installer starts the app with `setsid -f`**, its output to `/dev/null`: piped from `curl`, the script has no job control, so a plain `&` leaves the app in the terminal's process group and closing the terminal would end it.
- **`/device`'s line** shows when the visitor's OS is Linux (`linux`, `linux-x64` or `linux-arm64`, whatever the CPU: the script picks the arch itself) and the release's builds include a Linux AppImage; under the offer when there is one, else above the links. It is a `styles.meta` line with the command in a `styles.kbd` `code` element, the page's own classes; no button, no new style. The command is in `installCommand.ts`, beside the CLI's, the one place install URLs are written.
- **Where Desktop's and the app's entries meet** (Task 56): Desktop writes the entry before it starts the app it installed; the app's first run then finds its own `Exec=` with the same bytes and leaves the file (its bytes and mtime unchanged).

Named differences of section 11: none new. GNOME without the AppIndicator extension stays the spec's §7 row (`tray: no host`).

## Answers (harness-pm, 2026-11-19)

1. **Copy for Linux's terminal step** (Tasks 16, 17, 35): kept as written: `Finish in the terminal…`, `Setup failed. Press Enter to close.`; `No terminal found.` went (with no terminal the line runs behind the screen) and `The terminal did not open.` came, for a terminal that never runs the script.
2. **What else Windows signs** (Task 30): as the spec says (the exe before NSIS packs it, the installer after); `uninstall.exe` and the NSIS plugin DLLs are settled together with the Azure check before the first signed release.
3. **How `tray: no host` asks the session bus** (Task 23): the `dbus` crate (0.9.12, already in `Cargo.lock` through Tauri's Linux tree), a direct `[target.'cfg(target_os = "linux")'.dependencies]` dependency added by Task 23. No hand-written D-Bus.
4. **The two checks that run the app's real install lines** (Verification 7): run them (public CDN files, a throwaway signed-out daemon, no account, no backend).
5. **macOS updater behavior stays exactly the same:** the macOS local-manifest updater check (Task 34, `macos.sh --update`) must be green before the merge.

## Review Focus

1. **A Windows update must not remove the login item.** NSIS runs the old uninstaller on every update (`/UPDATE`); Tauri's uninstaller deletes the Run value named after the product on a real uninstall only. The app also writes the value again at every launch when it is missing. Tests: Task 26 `the_run_value_is_named_after_the_product`; Task 34 checks the Run value after 0.0.1 → 0.0.2.
2. **A killed Windows child must read as "no code".** Tests: Task 4 `a_killed_child_has_no_code`, `a_run_past_its_deadline_has_no_code`.
3. **A path with a space or a non-ASCII letter** (`C:\Users\Nguyễn Văn A`, `~/My Apps/Harness-Device-linux-x64.AppImage`): the CLI is found, Explorer selects the zip, the entry's `Exec=` starts the AppImage, the log says `~`. Tests: Task 5 `the_layout_is_found_under_a_home_with_a_space_and_an_accent`; Task 6; Task 13 `a_path_with_a_space_a_percent_a_dollar_a_quote_and_a_backslash_is_quoted`; Task 20 `what_shows_the_zip_on_each_os`.
4. **A Linux relaunch after an update must not lose to its own lock.** Tests: Task 21 `a_second_acquire_is_refused_until_the_first_is_dropped`; Task 34 finds the app running after the update.
5. **The terminal window closed before `install.sh --host` ends** fails the Install screen at once, not after ten minutes. Tests: Task 16 `a_hangup_writes_129`; Task 17 `a_terminal_run_that_failed_stops_there`.


Section 10 (Tasks 37 to 46):

1. **A tampered manifest must not make Desktop run someone else's program.** On Windows Desktop executes what it downloads. Tests: Task 40 `windows: the signature is checked before the installer runs`; Task 41 `windows: an installer signed by someone else, or not at all, is refused`; Task 39's existing URL refusals hold for the new keys (`a URL outside the prefixes is refused` gains a Windows and a Linux key).
2. **Desktop's AppImage variables must not reach the Device app** (its login entry and updater would take Desktop's AppImage for their own). Tests: Task 40 `the device app starts without Desktop's AppImage variables`; Task 44 reads the started app's `APPIMAGE` from `/proc`.
3. **A profile path with a space and an accent** (`C:\Users\Nguyễn Văn A`, `/home/p q`): the place, the installer's argument, `tasklist`'s user filter and the Linux entry's `Exec=`. Tests: Task 39 `the Windows place is under LOCALAPPDATA` and `the Linux place is beside Desktop's own AppImage` (both with such paths); Task 42 `tasklist asks for harness-device.exe of this user, as CSV with no header`; Task 46 `a place with a space is quoted in Exec=`.
4. **Another user's Device app on the same computer must not hide the offer.** Tests: Task 42 `/proc: a harness-device of this user counts; another user's, another name or a vanished entry does not`; the `USERNAME` filter in the `tasklist` case.
5. **A Linux ARM or Windows ARM visitor whose browser says nothing** gets x64, and one that says gets arm64. Tests: Task 37 `a Chromium on Linux that sends the hints gets arm64 although its user agent says x86_64`, `Windows on ARM without hints gets x64`; Task 38 `asks Chromium for the CPU on /device`.

Section 11 (Tasks 47 to 57):

1. **A copy of the AppImage in Downloads must not take the app list from the installed one, nor the reverse.** Two copies on disk: whichever entry is there stays. Tests: the vectors' `another AppImage on disk` decision, read by Task 51 `who_writes_the_entry_is_one_rule`, Task 52 `the decisions are the vectors'`; Task 51's linux.sh check `an entry naming another AppImage on disk is left alone`.
2. **A home folder with a space, a `%` or a `$`** (`/home/p q`, `~/100%`): every writer's `Exec=` starts the right file. Tests: the vectors' `exec` cases in Tasks 51 and 52; Task 53 `a home with a space, a percent and a dollar is quoted as the app quotes it`; Task 51's linux.sh runs from `My Apps`.
3. **An unwritable or full data folder must not stop the app.** Tests: Task 51 `a_failure_is_a_log_line_not_a_panic`; linux.sh `with a read-only applications folder the tray still registers and the log says app list: entry not written (error 13)`.
4. **A tampered or half-downloaded AppImage must never be placed or run by the one line.** Tests: Task 53 `refuses a URL outside the device release folders`, `refuses a size or a sha256 that does not match, and leaves nothing at the place`; Task 54's first check.
5. **Closing the terminal the line ran in must not end the app.** Tests: Task 53 `starts the app in a session of its own`; Task 54 `the app outlives the shell that ran the line`.
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
- `Group::exited(&self)` (today's `exited`: blocks, leaves it unreaped), `Group::kill(&self)` (today's `kill_group`), `Group::code(&self, status: ExitStatus) -> Option<i32>` (`status.code()`).
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
  - `the_flags_ask_for_no_window_and_never_detach`: `CREATION_FLAGS & 0x0800_0000 != 0` and `CREATION_FLAGS & 0x0000_0008 == 0`.
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
- Protocol: SUBSCRIBE (type 2) `["window","workspace"]` first and its `{"success":true}`, then GET_TREE (type 4), so no change between them is missed; a window event is type `0x80000003`. A pid with no exe, or no pid, tells the empty string.

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
- `pub fn status(run: Option<&str>, approved: Option<&[u8]>) -> loginitem::Status`: `approved` with an odd first byte (`0x03`, `0x07`) → `RequiresApproval`; else `run` present → `Enabled`; else `NotRegistered`.
- `pub fn run_data(exe: &Path) -> String`: the path in double quotes.
- `#[cfg(windows)] pub struct Keys { pub run: &'static str, pub approved: &'static str }`, `pub const SYSTEM: Keys` (`Software\Microsoft\Windows\CurrentVersion\Run`, `Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`, under HKCU) and `pub fn register_in(keys: &Keys, exe: &Path) -> Result<(), String>` through `loginitem::register_from`. An error is `Login item not set (error <code>).`, the code only.
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
- `SystemLoginItem` on Linux: `register()` is `change(…, first: true)` and `refresh()` is `change(…, first: false)`, each written through a temp file in the same folder and a rename. Not an AppImage run: `register()` is `Err("Login item not set (not an AppImage).")` and `refresh()` is `Ok(false)`. The launcher is `<home>/.local/bin/harness`.
- `runner.rs`: `refresh()` is called once in `Runner::polling_every`, at launch only; `Ok(true)` logs `login item: updated`, `Err` logs `login item: <error>`.

- [ ] **Step 1: Failing tests** (unix): `the_entry_is_under_xdg_config_home_only_when_it_is_absolute`; `the_exec_line_is_one_fixed_text` (the bytes above); `a_path_with_a_space_a_percent_a_dollar_a_quote_and_a_backslash_is_quoted`; `the_exec_line_starts_the_appimage_and_falls_back_to_the_launcher` (the line's command, unescaped by the two layers, run with `/bin/sh` against two temp scripts: the first runs when it is there, else the second gets `start`); `a_fresh_entry_is_dial_linuxs_format`; `an_absent_entry_is_written_once_and_a_deleted_one_stays_deleted`; `a_hidden_entry_is_left_alone`; `an_entry_that_is_on_is_taken_over_and_keeps_its_other_lines`; `the_apps_own_entry_is_not_rewritten`; `only_an_appimage_run_registers`. `runner.rs`: `the_login_item_is_refreshed_at_start_and_not_by_an_install` (a double that counts).
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
- `pub const CANDIDATES: [(&str, &str); 3] = [("x-terminal-emulator", "-e"), ("gnome-terminal", "--"), ("xterm", "-e")];` (Desktop's order; each gets `/bin/sh` and the script's path after its flag).
- `pub const DID_NOT_OPEN: &str = "The terminal did not open.";` (answer 1).
- `pub fn script(line: &str) -> String`, exactly:
  ```sh
  #!/bin/sh
  # Harness: setup's host half, in a terminal so sudo can ask for a password.
  result="${0%.sh}.exit"
  finish() { printf '%s\n' "$1" > "$result.tmp" && mv "$result.tmp" "$result"; }
  trap 'finish 129; exit 129' HUP INT TERM
  : > "${0%.sh}.started"
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
- `pub fn run(folder: &Path, line: &str, deadline: Duration, start: &dyn Fn(&str, &str, &Path) -> io::Result<()>, now: &dyn Fn() -> Instant, pause: &dyn Fn(Duration)) -> io::Result<Output>`: empties and makes `folder` (0700), writes `host-<n>.sh` (0700, `<n>` a number no earlier run used), starts the first candidate that is found (`NotFound` moves on; none is `NotFound`, and the install runs the line behind the screen), waits up to 30 s for `host-<n>.started` (past it, `io::Error::new(TimedOut, DID_NOT_OPEN)`), then waits: `Output { code: Some(n), .. }` or `Output { timed_out: true, .. }`.
- `pub fn start(program: &str, flag: &str, script: &Path) -> io::Result<()>`: started in its own process group, reaped on a thread.

- [ ] **Step 1: Failing tests** (unix): `the_script_writes_its_lines_exit_code` (`/bin/sh host.sh` with line `(exit 3)` and stdin at `/dev/null` leaves `3` in `host.exit`; with `true`, `0`; with `HOST` as the line, the script holds `HOST` word for word); `a_hangup_writes_129` (line `sleep 30`; SIGHUP to its group; `host.exit` reads `129` within 5 s, waited for, not slept); `the_first_terminal_found_is_used_in_desktops_order`; `no_terminal_is_not_found`; `a_terminal_that_never_runs_the_script_fails_within_30_seconds`; `an_older_runs_files_are_removed_first`; `a_result_is_waited_for_and_a_half_written_one_is_still_pending` (a fake clock and `pause`); `no_result_by_the_deadline_is_a_timeout`; `the_folder_and_the_script_are_the_persons_alone` (modes 0700).
- [ ] **Step 2:** FAILS. Commit red. **Step 3: Implement.** **Step 4:** green on this Mac and `linux-unit`. **Step 5: Commit** `Linux: one fixed command runs in a terminal the person sees, and the app reads how it ended`.

### Task 17: Install on each OS

**Files:** Modify `ST/src/install.rs`, `ST/src/runner.rs`, `ST/src/main.rs`.

**Interfaces:**
- Consumes: `terminal::{run, start}` (Task 16).
- Produces (`install.rs`): `pub const WINDOWS: &str` (Global Constraints); `pub const POWERSHELL_ARGS: [&str; 5] = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];` `pub fn powershell(system_root: Option<&OsStr>) -> PathBuf` (`C:\Windows` when unset or empty); `pub const FINISH_IN_TERMINAL: &str = "Finish in the terminal…";` `pub enum Place { Background, Terminal }`; `pub struct Run { pub line: &'static str, pub flag: &'static str, pub place: Place }`; `pub fn runs(os: &str) -> &'static [Run]` — `macos`: `HOST` `--host` background, `DESKTOP` `--desktop` background; `linux`: `HOST` `--host` terminal, `DESKTOP` `--desktop` background; `windows`: `WINDOWS` `-Desktop` background. `pub fn step_of(os: &str, clean: &str) -> Option<&'static str>`; `Shell::run(&self, run: &Run, deadline: Duration, sink: &mut dyn FnMut(&str)) -> io::Result<Output>`; `pub struct SystemShell { pub folder: PathBuf }`; `pub fn system_shell(data: PathBuf) -> SystemShell`; `pub fn install(os: &str, shell, log, cli_there, on_step)`.
- Windows steps: a clean line that begins `Downloading Node `, `Downloading Harness ` or `Downloading the terminal host ` is `DOWNLOADING_HARNESS`. The Windows step lines the log keeps begin with one of those three, `OK ` or `Harness could not be installed. The step that failed: `; the 200-line cap, the redaction and the 512-character cut are today's.
- A terminal run tells `FINISH_IN_TERMINAL` when it starts; when it ends well the step is `GETTING_READY` again until the next run names one.
- `NOT_SUPPORTED` is deleted; `Doors.shell` is `Arc<dyn Shell>`; the runner passes `std::env::consts::OS`; `main.rs` passes `system_shell(paths.app_data_dir()?)`.

- [ ] **Step 1: Failing tests** (`install.rs`): `the_runs_of_each_os`; `the_windows_line_is_the_desktop_apps` (the exact text); `powershell_is_named_by_its_full_path`; `a_windows_run_shows_downloading_harness_and_logs_only_its_step_lines` (stdout `  Downloading Node 24.22.2 (win32-x64)...`, `  OK Node 24.22.2 -> C:\x`, a noise line, `Harness could not be installed. The step that failed: Node.`: steps are `[DOWNLOADING_HARNESS]`, the log holds those three lines and `install: -Desktop exit 1`, never the noise); `a_unix_step_line_is_no_windows_step_and_the_reverse`; `a_terminal_run_shows_finish_in_the_terminal_then_getting_ready`; `a_terminal_run_that_failed_stops_there` (code 129: `Err([NOT_INSTALLED])`, `install: --host exit 129`, `--desktop` never runs); `with_no_terminal_the_host_half_runs_behind_the_screen` (the log has `install: --host no terminal; run here`, and the step is `GETTING_READY` again). Windows only: `powershell_takes_a_command_with_quotes_inside_whole` (a `Run` whose line is `iex "& { 'hi' }"; exit 7` gives the line `hi` and code 7). Existing tests take `install("macos", …)` and the new `Shell::run`. `runner.rs`: the install test runs on each OS's runs; the `NOT_SUPPORTED` test goes.
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
- Produces (`open.rs`): `pub trait Opener: Send + Sync { fn url(&self, url: &str) -> io::Result<()>; fn reveal(&self, zip: &Path) -> io::Result<()>; fn desktop(&self) -> io::Result<()>; }`; `pub fn system(log: Arc<dyn Log>) -> Arc<dyn Opener>`; the pure halves: `pub fn url_args(os: &str, url: &str) -> Option<(&'static str, Vec<String>)>` (`macos`: `/usr/bin/open`, `[url]`; `linux`: `xdg-open`, `[url]`; `windows`: `None`, the shell opens it); `pub fn shell_url(url: &str) -> Option<&str>` (only a text that starts `https://`); `pub fn reveal_args(os: &str, zip: &Path) -> Option<(&'static str, Vec<String>)>` (`macos`: `/usr/bin/open`, `["-R", zip]`; `linux`: `xdg-open`, `[the zip's folder]`; `windows`: `None`, the shell selects it); `pub fn desktop_args(os: &str) -> Option<(&'static str, Vec<String>)>` (`macos`: `/usr/bin/open`, `["-b", "ai.autonomous.harness"]`; elsewhere `None`: `desktop_app()` is run with no argument, in its own process group, reaped on a thread).
- Windows `url`: `ShellExecuteW` verb `open` on `shell_url(url)`, else `InvalidInput`. Windows `reveal`: `SHOpenFolderAndSelectItems` on the zip, on a thread of its own with COM set up first; a failure is the log line `logs: could not open: <error>`. Elsewhere `open: exit <n>` stays.
- `logs.rs`: `fn bundle_path(path: &str, windows: bool) -> bool` — the file name is the text after the last `/`, and after the last `\` too when `windows`; `parse` passes `cfg!(windows)`.
- `runner.rs`: `Doors.open: Arc<dyn Opener>`; `OpenUrl`, `OpenDesktop` and `Reveal` call it; the log lines `browser: could not open: …`, `desktop app: could not open: …`, `logs: could not open: …` are unchanged. `main.rs`: `open: open::system(log.clone())`.

- [ ] **Step 1: Failing tests:** `open.rs`: `what_opens_a_url_on_each_os`; `only_an_https_url_goes_to_the_windows_shell`; `what_shows_the_zip_on_each_os`; `open_harness_is_one_fixed_command_on_a_mac_and_the_apps_own_file_elsewhere`. `logs.rs`: `a_windows_zip_is_named_after_its_last_backslash` (`bundle_path` with `windows: true` takes `C:\Users\p\Desktop\harness-logs-20261118-1030.zip`'s name; with `false` it does not); under `#[cfg(windows)]`, `parse` accepts that path. `runner.rs`: its opener double records `url <u>`, `reveal <zip>`, `desktop`; the existing open tests assert those.
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

`main.rs`, on Linux, once the tray is built, on a thread: no watcher within 30 s of start → log `tray: no host`, once.

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

**Files:** Modify `ST/tauri.conf.json`, `ST/tauri.windows.conf.json`, `ST/tauri.linux.conf.json`, `ST/src/main.rs`; create `ST/icons/32x32.png`, `ST/icons/128x128.png`, `ST/icons/128x128@2x.png`; fill `ST/src/packaging.rs`.

**Interfaces — Consumes:** `loginitem_windows::RUN_VALUE` (Task 12).

- `tauri.conf.json`: the window gains `"skipTaskbar": true`.
- `tauri.windows.conf.json`: `bundle.windows.nsis`: `"installMode": "currentUser"`. WebView2 stays the download bootstrapper (Tauri's default).
- No installer hook: Tauri's NSIS uninstaller already deletes the HKCU Run value named after the product (`productName`, `Harness Device`), and keeps it on an update (`$UpdateMode`).
- `tauri.linux.conf.json`: `bundle.icon` lists the three PNGs (icon.icns's per-size drawings: 32 px ic05, 128 px ic07, 256 px ic08) and `icons/icon.png`.
- `main.rs`, first line: `#![cfg_attr(windows, windows_subsystem = "windows")]`.

- [ ] **Step 1: Failing tests** (`packaging.rs`; the files read at run time, the JSON with `serde_json`): `the_run_value_is_named_after_the_product` (`productName` equals `RUN_VALUE`, and `tauri.windows.conf.json` does not override it; a pin that passes at once); `windows_installs_per_user_as_harness_device` (`productName` is `Harness Device`, targets `["nsis"]`, `installMode` `currentUser`); `linux_is_an_appimage`; `the_window_is_harness_at_420_by_320_with_no_taskbar_button`; `every_windows_build_is_a_gui_program`.
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

- [ ] **Step 1: `DA/AGENTS.md`.** The first paragraph and "Toolchain": Windows 10 or 11 and Linux beside macOS 13. "Commands": the Windows leg, the container line for Linux, the three e2e drivers. "Fixed arguments" gains, each as fixed text: the PowerShell install line and its five arguments; the terminal candidates with the script's path, and the script; `xdg-open` with a URL or the zip's folder; the shell's `SHOpenFolderAndSelectItems` on the zip; the Windows shell's `open` on an `https:` URL; the desktop app's own file, run with no argument; and the `Exec=` line the app writes into `harnessd.desktop` (written, never run by the app). The last line becomes: PR CI compiles and tests the app on Linux and Windows; macOS is built and tested by hand.
- [ ] **Step 2: `DA/RELEASE.md`.** The files and manifest keys per platform; the `platforms` input and `--platforms`, and that it is temporary; the jobs table with `build-windows`, `sign-windows`, `build-linux`; the Windows order (exe signed, bundled, installer signed, update signature); how an installed app updates on Windows (downloads at once, installs when nothing runs, the log's `update: installing X`) and as an AppImage; the log's folder on each OS.
- [ ] **Step 3: the design doc's Harness Device section.** The named differences a person sees: About's dialog on Windows and Linux; the tray icon's two glyphs and Linux's light one; Export logs selects the zip in Explorer and opens its folder on Linux; the window has no taskbar button; a GNOME desktop without the AppIndicator extension shows no tray.
- [ ] **Step 4: the other three.** `docs/validation-and-release.md`: Harness Device's end-to-end drivers under what PR CI does not run. `docs/windows-code-signing.md`: a Device row in "What is signed" (`sign-windows` of `release-device.yml`: `harness-device.exe`, then each installer; always on). `docs/naming-system.md`: on Windows the installed name is `Harness Device`.
- [ ] **Step 5: Commit** `Docs: Harness Device on Windows and Linux`.

### Task 37: Website: the Windows and Linux download routes

**Files:** Create `WS/src/lib/deviceManifest.ts`, `WS/src/lib/deviceArch.ts`, `WS/src/lib/deviceArch.spec.ts`, `WS/src/app/device/download-windows/route.ts`, `WS/src/app/device/download-windows/route.spec.ts`, `WS/src/app/device/download-linux/route.ts`, `WS/src/app/device/download-linux/route.spec.ts`; modify `WS/src/app/device/download-macos/route.ts`.

**Interfaces — Produces:**
- `deviceManifest.ts`: `DEVICE_MANIFEST_URL` and `DEVICE_ASSET_PREFIXES` (moved from `download-macos/route.ts`, values and comments unchanged), and `resolveDeviceDownload(field: string, extension: string): Promise<Response>`, which is `resolveManifestDownload` with them and `product: "Harness"`. `download-macos/route.ts` becomes `resolveDeviceDownload("device-macos-dmg", ".dmg")`; its spec stays as it is and green.
- `deviceArch.ts`: `export type DeviceArch = "x64" | "arm64"`; `deviceArch(headers: Headers, os: "windows" | "linux"): DeviceArch`, the rule in "Decided here for section 10". A hint's structured-field quotes are removed before it is compared; any other value of either hint falls through.
- `download-windows/route.ts`: `GET(request: Request)` → `resolveDeviceDownload("device-windows-" + deviceArch(request.headers, "windows"), ".exe")`. `download-linux/route.ts`: the same with `"linux"`, `device-linux-…` and `".AppImage"`. Both `dynamic = "force-dynamic"`, with a head comment as the macOS route's.

- [ ] **Step 1: Failing tests.**
  - `deviceArch.spec.ts`: `the hints name arm64 or x64` (`"arm"`/`"64"` → arm64, `"x86"`/`"64"` → x64, for both OSes); `a 32-bit or unknown hint is x64` (`"arm"`/`"32"`, `"riscv"`/`"64"`, one hint alone); `a Chromium on Linux that sends the hints gets arm64 although its user agent says x86_64`; `Firefox on Linux names its CPU` (`Mozilla/5.0 (X11; Linux aarch64; rv:140.0) Gecko/20100101 Firefox/140.0` → arm64); `Windows on ARM without hints gets x64` (an Edge user agent with `Win64; x64`; and a user agent naming `ARM64` on Windows is still x64: Windows' user agent is never read); `nothing said is x64`.
  - Each `route.spec.ts`, over a mocked `fetch` as `download-macos/route.spec.ts` does: `redirects to x64's file when the request cannot tell` (302, `Location` the CDN URL of `device-windows-x64-exe` / `device-linux-x64-appimage`, `Cache-Control: no-store, max-age=0`, the fixed manifest URL fetched); `redirects to arm64's file when the hints say arm64`; the Linux spec also `redirects Firefox on aarch64 to arm64's file`; `answers as the macOS route did before its first release` (a manifest with only the macOS keys: 503 and the text `Harness download is temporarily unavailable (no usable device-windows-x64-exe entry).\n`, resp. `device-linux-x64-appimage`; a 403: `(manifest HTTP 403).`); `refuses anything outside its own folder or of another kind` (Desktop's `https://cdn.autonomous.ai/harness/desktop/1.2.3/harness-install.exe`, a `..` and `%2e%2e` path, a query, a fragment, the Linux AppImage named under a Windows key and the reverse: each 503, no `Location`); `reads one fixed manifest` (with `HARNESS_DESKTOP_METADATA_URL` set).
- [ ] **Step 2:** `cd website && npx vitest run src/lib/deviceArch.spec.ts src/app/device` FAILS (no such modules). Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm test` and `npm run lint` pass. **Step 5: Commit** `Website: /device/download-windows and /device/download-linux follow the device manifest, the arch read from the request`.

### Task 38: Website: `/device` offers macOS, Windows and Linux

**Files:** Modify `WS/src/app/device/page.tsx`, `WS/src/app/device/page.spec.tsx`, `WS/next.config.js` (`headers()`), `WS/README.md` (the route table).

**Interfaces — Produces:** the card's line `The app for your Harness device. macOS 13 or later, Windows 10 or 11, Linux.` (the same for every visitor); a `styles.downloads` group of three `styles.download` links, each with the `Download` icon (`aria-hidden`): `macOS` → `/device/download-macos`, `Windows` → `/device/download-windows`, `Linux` → `/device/download-linux`. `headers()` gains `{ source: '/device', headers: [{ key: 'Accept-CH', value: 'Sec-CH-UA-Arch, Sec-CH-UA-Bitness' }] }`, its comment saying why (Chromium sends the CPU hints only to a site that asked; the routes read them).

- [ ] **Step 1: Failing tests** in `page.spec.tsx`: `offers one link per OS, each to its route` (three links, accessible names exactly `macOS`, `Windows`, `Linux`, hrefs as above); `says what the app is and each OS's floor` (the line above, exact; no `menu-bar` on the page); `asks Chromium for the CPU on /device` (imports `../../../next.config.js` as `scripts/agents-site.spec.ts` does, awaits `headers()`, the `/device` entry carries that `Accept-CH` value exactly). The old single-`Download` case goes.
- [ ] **Step 2:** `cd website && npx vitest run src/app/device/page.spec.tsx` FAILS. Commit red.
- [ ] **Step 3: Implement.** README: the `/device` row reads `Download page for the dial's app, Harness: a button each for macOS, Windows and Linux`; two rows after `/device/download-macos`: `/device/download-windows` and `/device/download-linux`, `302 to the installer (device-windows-x64-exe or -arm64-exe) / the AppImage (device-linux-x64-appimage or -arm64-appimage) in the device manifest, the arch from the request's Client Hints (and on Linux its user agent), x64 otherwise; 503 until a release carries it`.
- [ ] **Step 4:** `npm test` and `npm run lint` pass. **Step 5: Commit** `Website: /device offers Harness for macOS, Windows and Linux`.

### Task 39: Desktop: what Windows and Linux install, and where

**Files:** Modify `DT/lib/devices/device_app.dart`, `DT/lib/devices/device_app_manifest.dart`, `DT/lib/devices/device_app_installer.dart` (the one `parseDeviceAppManifest` call only), `DT/test/devices/device_app_manifest_test.dart`, `DT/test/devices/device_app_test.dart`.

**Interfaces — Produces:**
- `parseDeviceAppManifest(Object? manifest, {required String architecture, required TargetPlatform platform})`, keys tried in order: macOS as today; Windows arm64 `device-windows-arm64-exe`, `device-windows-x64-exe`; Windows x64 `device-windows-x64-exe`; Linux arm64 `device-linux-arm64-appimage`; Linux x64 `device-linux-x64-appimage`; any other platform none. The entry checks (`_release`, `_fetchable`) are unchanged. The installer's call passes `platform: defaultTargetPlatform` until Task 40 makes it a field.
- In `device_app.dart`: `const deviceAppWindowsExe = 'harness-device.exe'`, `const deviceAppImageName = 'Harness-Device.AppImage'`, and `String? deviceAppPlace({TargetPlatform? platform, Map<String, String>? environment})`: Windows `LOCALAPPDATA` (key in any case, absolute by `p.windows`) joined with `Harness Device` and the exe; Linux `maybeHomeDir(environment:, isWindows: false)` joined with `.local`, `opt` and the AppImage's name; null otherwise (macOS has LaunchServices; nothing names a folder).

- [ ] **Step 1: Failing tests.**
  - `device_app_manifest_test.dart`: `Windows arm64 takes its own entry, then x64's`; `Windows x64 never takes arm64's`; `Linux takes only its own arch` (arm64 with only `device-linux-x64-appimage` present → null, and the reverse); `a Mac never takes a Windows or Linux entry`; `Windows and Linux never take a macOS entry`; `a URL outside the prefixes is refused` gains one Windows and one Linux key. Every existing case passes `platform: TargetPlatform.macOS`.
  - `device_app_test.dart`: `the Windows place is under LOCALAPPDATA` (`{'LocalAppData': r'C:\Users\Nguyễn Văn A\AppData\Local'}` → `C:\Users\Nguyễn Văn A\AppData\Local\Harness Device\harness-device.exe`); `no absolute LOCALAPPDATA, no place` (absent, empty, `AppData\Local`); `the Linux place is beside Desktop's own AppImage` (`HOME=/home/p q` → `/home/p q/.local/opt/Harness-Device.AppImage`); `no home, no place`; `macOS has no place`.
- [ ] **Step 2:** `cd desktop && flutter test test/devices/device_app_manifest_test.dart test/devices/device_app_test.dart` FAILS. Commit red.
- [ ] **Step 3: Implement.** **Step 4:** both files and `test/devices/device_app_installer_test.dart` pass. **Step 5: Commit** `Desktop: the Windows and Linux entries of the device manifest, and where each OS keeps the app`.

### Task 40: Desktop installs and starts the app on Windows and Linux

**Files:** Modify `DT/lib/devices/device_app_installer.dart`, `DT/test/devices/device_app_installer_test.dart`, `DT/integration_test/device_app_install_native_test.dart` (only its `_run` gains the `{Duration timeout}` the typedef now names).

**Interfaces — Consumes:** Task 39's `parseDeviceAppManifest(…, platform:)`, `deviceAppPlace`, `deviceAppImageName`. **Produces:**
- `typedef DeviceAppRun = Future<ProcessResult> Function(String executable, List<String> arguments, {Duration timeout});` (`runDeviceAppTool` already has that shape; macOS calls pass no timeout and keep 60 s).
- `const deviceAppSetupTimeout = Duration(minutes: 5);`
- `DeviceAppInstaller({…, TargetPlatform? platform, String? place})`: `platform` defaults to `defaultTargetPlatform`, `place` to `deviceAppPlace()`. macOS ignores `place`; Windows and Linux ignore `targetFolders`.
- `typedef DeviceAppStart = Future<void> Function(String path, Map<String, String> environment);`, `Future<void> startDeviceAppDetached(String path, Map<String, String> environment)` (`Process.start(path, const [], environment: environment, includeParentEnvironment: false, mode: ProcessStartMode.detached)`), and `Future<bool> startDeviceApp(String path, {DeviceAppStart start = startDeviceAppDetached, Map<String, String>? environment})`: `environment` (default `RuntimePlatform.environment`) without `APPIMAGE`, `APPDIR`, `ARGV0`, `OWD`; true when `start` completes, false when it throws.

The steps per OS (the step names and failure lines are today's):

| Step | macOS | Windows | Linux |
|---|---|---|---|
| download, fixed name in the temp folder | `Harness-Device.app.tar.gz` | `Harness-Device-setup.exe` | `Harness-Device.AppImage` |
| checksum | size and sha256 | the same | the same |
| unpack | `tar` | skipped | skipped |
| signature | `_verifySignature(bundle)` | `_verifySignature(setup.exe)` | skipped |
| install | as today | the place a file already: it. Else `_run(setup.exe, const ['/S'], timeout: deviceAppSetupTimeout)`; exit 0 and the place now a file, else fail | the place there already: it. Else make its folder, copy the download to `.Harness-Device.AppImage.<hex16>.partial` beside the place, `_run('/bin/chmod', ['0755', partial])` exit 0, rename onto the place; the partial removed whatever happened |
| open | `_open(path: installed)` | the same | the same |

A null place on Windows or Linux fails at install.

- [ ] **Step 1: Failing tests** (the file's loopback server, a recording `_run` whose fake installer writes the place, temp folders): `windows: the installer runs silently, then the app opens from its place` (run got the temp `Harness-Device-setup.exe`, `['/S']`, 5 minutes; open got the place; the result is done at the place); `windows: the signature is checked before the installer runs` (a refusing check: failed at `signature`, no `/S` run); `windows: an installer that fails, or leaves no app, fails at install` (exit 2; exit 0 and no file); `windows: an app already in place is opened, not installed again`; `linux: the AppImage lands executable at its place and opens` (POSIX hosts: mode `0755`, the bytes the server sent, no partial left); `linux: no signature step runs` (the check is never called); `linux: a copy already at the place is kept` (its bytes unchanged); `linux: a copy that cannot be made executable is removed and fails at install` (the fake `chmod` exits 1: no partial left, no place); `no place, no install` (Windows and Linux); `the device app starts without Desktop's AppImage variables` (`startDeviceApp` with `APPIMAGE`, `APPDIR`, `ARGV0`, `OWD`, `HOME`, `PATH`: the start got `HOME` and `PATH` only); `a start that throws is a failed open`. The macOS cases are unchanged and stay green.
- [ ] **Step 2:** `cd desktop && flutter test test/devices/device_app_installer_test.dart` FAILS. Commit red.
- [ ] **Step 3: Implement.** **Step 4:** it passes, and `flutter analyze` is clean (the macOS native test compiles). **Step 5: Commit** `Desktop installs Harness Device on Windows by its installer and on Linux as an AppImage, and starts it`.

### Task 41: Windows: the installer is signed like Desktop

**Files:** Modify `DT/lib/update/update_signature.dart`, `DT/test/update_signature_test.dart`, `DT/lib/devices/device_app_setup.dart`, `DT/test/devices/device_app_setup_test.dart`.

**Interfaces — Produces:**
- In `update_signature.dart`: the `Import-Module`, `Signer` and `Read-Signer` lines of `windowsReportScript` become one const prelude both scripts start with; `windowsSignerPairScript` prints `{running, file}`, each a signer, the paths read from `HARNESS_SIGNER_RUNNING` and `HARNESS_SIGNER_FILE`; `Future<({WindowsSigner running, WindowsSigner file})> readWindowsSignerPair({required String file, required String runningExe, Duration timeout = signatureCheckTimeout})` runs it as `readWindowsSignatureReport` runs its script (hidden Windows PowerShell, `-EncodedCommand`, `_run`) and throws `cannotCheckSignature` on any failure.
- In `device_app_setup.dart`: `Future<bool> deviceAppInstallerSignedLikeDesktop(String installer, {String Function()? runningExe, Future<({WindowsSigner running, WindowsSigner file})> Function({required String file, required String runningExe}) read = readWindowsSignerPair})`. `runningExe` defaults to `RuntimePlatform.resolvedExecutable`. Rule: read throws `UpdateRefused` → false; running `NotSigned` → true (sha256 alone, as macOS's local build); running not `Valid` → false; else the file `Valid` and `sameAs(running)`.

- [ ] **Step 1: Failing tests.** `device_app_setup_test.dart`: `windows: a Desktop with no signature keeps the sha256 check alone`; `windows: an installer signed by Desktop's signer passes`; `windows: an installer signed by someone else, or not at all, is refused` (another identity with the same subject; `NotSigned`; `HashMismatch`); `windows: a Desktop whose signature is broken refuses`; `windows: a signature that cannot be read refuses`. `update_signature_test.dart`: `the signer pair script takes its paths from the environment only`; `the report and the pair read signers with one prelude`; Windows only (`skip: !Platform.isWindows`): `readWindowsSignerPair reads powershell.exe as Valid and an empty exe as NotSigned`.
- [ ] **Step 2:** `cd desktop && flutter test test/update_signature_test.dart test/devices/device_app_setup_test.dart` FAILS. Commit red.
- [ ] **Step 3: Implement.** **Step 4:** both pass here; the Windows-only case passes in Verification 9's `windows-desktop.yml` run. **Step 5: Commit** `Desktop installs Harness Device on Windows only when its installer is signed as Desktop is`.

### Task 42: Desktop finds the app on Windows and Linux

**Files:** Modify `DT/lib/devices/device_app_probe.dart`, `DT/test/devices/device_app_probe_test.dart`.

**Interfaces — Consumes:** `deviceAppWindowsExe` (Task 39); `runDeviceAppTool` as it is (this task does not use the `DeviceAppRun` typedef Task 40 changes). **Produces:**
- `class PlaceDeviceAppProbe implements DeviceAppProbe` with `const PlaceDeviceAppProbe({required String? place, required Future<bool> Function() running, Future<bool> Function(String path)? exists})`: `lookup()` asks `running` first, then `installed = running || (place != null && await deviceAppInstalledAt([place], exists: exists))`. What `running` throws, `lookup` throws (the offer logs `device app: lookup failed`).
- `Future<bool> windowsDeviceAppRunning({Future<ProcessResult> Function(String executable, List<String> arguments)? run, Map<String, String>? environment})`: runs `<SystemRoot>\System32\tasklist.exe` (SystemRoot found as `windowsPowerShellPath` finds it) with `['/FI', 'IMAGENAME eq harness-device.exe', '/FI', 'USERNAME eq <USERNAME>', '/FO', 'CSV', '/NH']`, by default through `runDeviceAppTool` with a 10 s timeout; a missing `USERNAME` or an exit other than 0 throws; otherwise `tasklistNamesDeviceApp(stdout)`.
- `bool tasklistNamesDeviceApp(String csv)`: a line whose first CSV field, unquoted, is `harness-device.exe` in any case.
- `Future<bool> linuxDeviceAppRunning({String proc = '/proc'})`: this process's real uid from `<proc>/self/status`'s `Uid:` line (unreadable: throws); true when a numeric entry's `comm` (trimmed) is `harness-device` and its `status` gives the same real uid; an entry that vanishes or cannot be read is skipped.

- [ ] **Step 1: Failing tests:** `installed: the place is there, or the app runs` (the four cases); `no place: installed only while it runs`; `a lookup whose process list fails throws`; `tasklist asks for harness-device.exe of this user, as CSV with no header` (`SystemRoot=C:\Windows`, `USERNAME=Nguyễn Văn A`: the executable and the seven arguments exactly); `tasklist's rows: harness-device.exe in any case counts; a localized no-tasks line does not` (`"HARNESS-DEVICE.EXE","4242","Console","1","52,120 K"` true; `INFO: No tasks are running which match the specified criteria.` false; `Information: Es werden keine Aufgaben mit den angegebenen Kriterien ausgeführt.` false; `"harness-device.exe.old","1","Console","1","1 K"` false); `tasklist that fails, or no USERNAME, throws`; `/proc: a harness-device of this user counts; another user's, another name or a vanished entry does not` (a fake tree in a temp folder: `self/status` uid 1000; `10` named `harness-device`, uid 1000; `11` uid 1001; `12` named `harness-device2`; `13` an empty folder); Linux only (`skip: !Platform.isLinux`): `a copy of sleep named harness-device is found in /proc, and not once it ends` (copies `/bin/sleep`, starts it for 30 s, true; kills it and awaits its exit code, false); Windows only (`skip: !Platform.isWindows`): `a hidden copy of ping named harness-device.exe is found by tasklist` (`ping -n 30 127.0.0.1` through `startHidden`, true; killed and awaited, false).
- [ ] **Step 2:** `cd desktop && flutter test test/devices/device_app_probe_test.dart` FAILS. Commit red.
- [ ] **Step 3: Implement.** **Step 4:** it passes here; the Linux case passes in PR CI's `desktop-tests`, the Windows one in Verification 9's run. **Step 5: Commit** `Desktop finds Harness Device on Windows and Linux: its file, or it running for this user`.

### Task 43: Desktop offers the app on Windows and Linux, in each OS's words

**Files:** Modify `DT/lib/devices/device_app.dart`, `DT/lib/devices/device_app_setup.dart`, `DT/lib/widgets/device_app_band.dart`, `DT/lib/devices/device_app_row.dart`, `DT/test/devices/device_app_test.dart`, `DT/test/devices/device_app_setup_test.dart`, `DT/test/devices/device_app_flow_test.dart`, `DT/test/devices/device_app_band_test.dart`, `DT/test/devices/device_app_row_test.dart`, `DT/test/elements_gallery_test.dart` (its `device-app` section), `DT/test/goldens/elements/device-app-light.png`, `DT/test/goldens/elements/device-app-dark.png`, `DT/design/desktop-design-system.md` (the Menu-bar app offer paragraph and its picture).

**Interfaces — Consumes:** Tasks 39 to 42. **Produces:**
- `deviceAppSupported`: viewer or web never; macOS as today; Windows always (Desktop's own floor, Windows 10, is the app's: WebView2, the WinEvent hook, the per-user NSIS install, the Run and StartupApproved values all work on Windows 10); Linux always.
- In `device_app.dart`: `typedef DeviceAppCopy = ({String band, String title, String detail});` and `DeviceAppCopy deviceAppCopy(TargetPlatform platform)`: macOS the three macOS strings of Global Constraints, every other platform the Windows and Linux ones (exact copy there).
- `DeviceAppBand({…, TargetPlatform? platform})` and `DeviceAppRow({…, TargetPlatform? platform})`: their sentence, title, detail and `controlSemanticLabel` from `deviceAppCopy(platform ?? defaultTargetPlatform)`. Nothing else in either widget changes.
- In `device_app_setup.dart`, used by `deviceAppOfferForThisComputer`: `@visibleForTesting DeviceAppProbe deviceAppProbeFor(TargetPlatform platform, {Map<String, String>? environment})` (macOS `ChannelDeviceAppProbe`; Windows `PlaceDeviceAppProbe(place: deviceAppPlace(…), running: windowsDeviceAppRunning)`; Linux the same with `linuxDeviceAppRunning`) and `@visibleForTesting DeviceAppOpen deviceAppOpenFor(TargetPlatform platform, {DeviceAppStart start = startDeviceAppDetached, Map<String, String>? environment})` (macOS `openDeviceApp(runDeviceAppTool, path:)`; Windows and Linux `startDeviceApp(path ?? place)`, false with neither). The installer gets `platform`, `place` and the signature check of its OS: macOS `deviceAppSignedLikeDesktop`, Windows `deviceAppInstallerSignedLikeDesktop`, Linux none called.

- [ ] **Step 1: Failing tests.**
  - `device_app_test.dart`: `only macOS 13 or later, Windows and Linux, and never a viewer build` replaces today's case: macOS's lines kept; Windows `"Windows 11 Pro" 10.0 (Build 22631)` and `"Windows 10 Pro" 10.0 (Build 19045)` true; Linux `6.8.0-45-generic` true; Linux and Windows viewer false. `each OS's words`: `deviceAppCopy(TargetPlatform.macOS)` is the macOS triple, `windows` and `linux` the tray triple, each string exact.
  - `device_app_setup_test.dart`: `each OS gets its own lookup` (the types; Windows' place under the given `LOCALAPPDATA`, Linux's under `HOME`); `Open on Windows and Linux starts the place when no path is named`; `Open with no place fails`.
  - `device_app_band_test.dart`: today's `the offer: its sentence, Not now, then Install` runs under `TargetPlatformVariant.only(TargetPlatform.macOS)`, its sentence unchanged; new `on Windows and Linux the sentence names the tray app` (`TargetPlatformVariant({TargetPlatform.windows, TargetPlatform.linux})`: `Your dial follows apps with the Harness tray app.`, buttons `Not now`, `Install`).
  - `device_app_row_test.dart`: `_title` and `_detail` stay macOS's, and the cases that read them run under `TargetPlatformVariant.only(TargetPlatform.macOS)`; new `on Windows and Linux the row is the tray app` (both OSes: title and semantic label `Tray app`, detail `Follows the app in front.`).
  - `device_app_flow_test.dart`, the person's walk on every OS: the fixture's `supported` comes from `deviceAppSupported(osVersion: _osVersion())` (`_osVersion()` by `defaultTargetPlatform`: `Version 15.6 (Build 24G84)`, `"Windows 11 Pro" 10.0 (Build 22631)`, `6.8.0-45-generic`); `a dial and no menu-bar app: the band; Install installs and the band goes`, `the Devices row: Install, then Open, then nothing` and `a failed install shows its line and Retry on both` run under `TargetPlatformVariant({TargetPlatform.macOS, TargetPlatform.windows, TargetPlatform.linux})`, each finding its OS's exact sentence and row title (`_sentence` and `'Menu-bar app'` on macOS, the tray ones on Windows and Linux; no `menu-bar` or `terminal tab` text on Windows or Linux); `Linux shows nothing` becomes `Windows 10 shows nothing` (`"Windows 10 Pro" 10.0 (Build 19045)`, no band, no row, no lookup).
- [ ] **Step 2:** `cd desktop && flutter test test/devices` FAILS. Commit red.
- [ ] **Step 3: Implement.**
  - The design doc's offer paragraph reads `shown on macOS 13 or later, Windows and Linux while a dial is plugged in to this computer and the Harness menu-bar app is not installed; the web and macOS 12 show nothing.` Its copy sentence names both sets: macOS as today, then `On Windows and Linux: the band's Your dial follows apps with the Harness tray app.; the row's Tray app and Follows the app in front.` (each string in backticks, as today's); the failure lines unchanged. Its text picture gains one band line and one row box in the Windows and Linux words.
  - The gallery's `device-app` section (`desktop/AGENTS.md` and the design doc's "Elements gallery": a changed element updates the doc and the gallery, with its section's images, in the same pull request): today's bands and rows pass `platform: TargetPlatform.macOS`; after them one band and one row, both `DeviceAppOfferState.offer`, pass `platform: TargetPlatform.linux`. Its title: `The device app: its band offered, installing and failed; its Devices row offered, installing, failed, not opened and not running; on Windows and Linux, its band and row offered`. Regenerate its images: `flutter test --no-pub --update-goldens test/elements_gallery_test.dart`; only `device-app-light.png` and `device-app-dark.png` change.
- [ ] **Step 4:** `flutter test test/devices test/update_signature_test.dart test/elements_gallery_test.dart` and `flutter analyze` pass. **Step 5: Commit** `Desktop offers Harness Device on Windows and Linux, as the tray app there`.

### Task 44: End to end: Desktop installs the real app on Windows and Linux

**Files:** Create `DT/integration_test/device_app_install_windows_linux_native_test.dart`; modify `.github/workflows/tmp-device-app-win-linux.yml`.

Test tooling: one commit, no red test; its job is the evidence. Never production: the manifest is a stand-in on loopback and the package is this run's debug build.

- The test refuses to run without `FLUTTER_TEST=1` and `HARNESS_DEVICE_TEST_PACKAGE` (the debug installer or AppImage), and off Windows and Linux. It serves the package and a manifest naming it, under this runner's key, at `https://cdn.autonomous.ai/harness/device/0.0.0/<the release's file name>`, sent to loopback by the interceptor `device_app_install_native_test.dart` uses. It builds the installer, probe and opener as `deviceAppOfferForThisComputer` does (the real place, `deviceAppProbeFor`, `deviceAppOpenFor`, the real signature check: the debug installer and the test runner are both unsigned, so sha256 alone). Checks, in order:
  1. A manifest whose file has one byte changed fails at `checksum`; the place is still absent.
  2. Before: `installed: false, running: false`.
  3. Install: done, at the place.
  4. The probe, asked until it says so or 60 s pass: `installed: true, running: true`.
  5. Linux: the running app's `/proc/<pid>/environ` holds `APPIMAGE=<the place>` and no other `APPIMAGE`.
  6. A second install is done at the place without running the installer again (Windows: the exe's last-write time unchanged; Linux: the AppImage's bytes unchanged).
  7. Linux: `$XDG_DATA_HOME/applications/harness-device.desktop` is Task 46's entry for the place, its `Icon=` line present and its file a PNG (the icon path inside the real AppImage holds).
  8. Linux: with the app ended and the AppImage removed, `forgetGoneDeviceAppLauncher()` removes the entry and the icon.
  It cleans up what it made: ends the app (`taskkill /IM harness-device.exe /F` or a kill of the pid it found), runs `uninstall.exe /S` on Windows and removes the AppImage on Linux (check 8).
- Temporary workflow, job `desktop-device-app-e2e`, matrix `windows-latest`, `windows-11-arm`, `ubuntu-22.04`, `ubuntu-22.04-arm`, `timeout-minutes: 90`: Flutter at `windows-desktop.yml`'s `FLUTTER_VERSION`; Desktop's Linux build packages as `release-desktop.yml` installs them, plus `xvfb dbus-x11 libfuse2` and Tauri's packages; the Device app's debug package built as `windows-e2e` and `linux-e2e` build it; its state seeded with `cliSeen`, `askedSignIn` and `loginItem` true (`%APPDATA%\ai.autonomous.harness.device\state.json`, `$XDG_DATA_HOME/ai.autonomous.harness.device/state.json`, as `windows.ps1` and `linux.sh` seed it), so it installs nothing and opens no window; on Linux a scratch `HOME` and XDG folders, `xvfb-run` and `dbus-run-session`; then `FLUTTER_TEST=1 HARNESS_DEVICE_TEST_PACKAGE=<package> flutter test -d <windows|linux> --no-pub integration_test/device_app_install_windows_linux_native_test.dart`. On failure it uploads the Device app's log (3 days).

- [ ] **Step 1: Write the test and the job.** **Step 2:** `desktop-device-app-e2e` is green on its four runners. **Step 3: Commit** `End to end: Desktop installs, finds and starts Harness Device on Windows and Linux, and lists it on Linux`.

### Task 45: Docs: who reads which download key

**Files:** Modify `DA/RELEASE.md`.

One commit, no test. Describe what the code does.

- [ ] **Step 1:** The page paragraph: `https://harness.autonomous.ai/device` has a button per OS; its links `/device/download-macos`, `/device/download-windows` and `/device/download-linux` follow the manifest, the last two picking x64 or arm64 from the browser's Client Hints (Linux also its user agent), x64 when it cannot tell, and answering 503 until a release carries their keys. Under the key table, replace the line on who reads what: the app reads `platforms`; the website reads `device-macos-dmg`, `device-windows-*` and `device-linux-*`; Desktop reads `device-macos-arm64`/`device-macos`, `device-windows-*` and `device-linux-*`, and on Windows runs the installer with `/S`, on Linux puts the AppImage at `~/.local/opt/Harness-Device.AppImage` and lists it as `harness-device.desktop` in the app list (removed at Desktop's next launch once the AppImage is gone).
- [ ] **Step 2: Commit** `Docs: the website and Desktop read the Windows and Linux keys of the device manifest`.

### Task 46: Linux: Desktop puts the app in the app list

**Files:** Create `DT/lib/devices/device_app_launcher.dart`, `DT/test/devices/device_app_launcher_test.dart`; modify `DT/lib/core/linux_app_image.dart` (share its helpers; behavior unchanged), `DT/lib/devices/device_app_installer.dart` (the Linux install step), `DT/test/devices/device_app_installer_test.dart`, `DT/lib/app_shell.dart` (one line beside `registerAppImageLauncher()`).

Depends on 40 (it changes the installer's Linux step that Task 40 writes, in the same two files). Shares no file with 41, 42 or 43. The rules are in "Decided here for section 10" (the entry, when it is written, when it goes) and the entry's bytes in Global Constraints.

**Interfaces — Consumes:** Task 40's `DeviceAppInstaller` and its Linux install step. **Produces:**
- In `linux_app_image.dart`, shared with no change in behavior: `String? launcherExecTarget(String entry)` and `String quoteLauncherExec(String path)` (today's `_execTarget` and `_quoteExec`, renamed and made public, bodies unchanged), and `String? launcherDataHome(Map<String, String> environment)` (the `XDG_DATA_HOME`-else-`$HOME/.local/share` line `registerAppImageLauncher` has inline today, moved out; null when both are empty). `registerAppImageLauncher` uses all three; `test/linux_app_image_test.dart` stays green untouched.
- In `device_app_launcher.dart`:
  - `const deviceAppLauncherName = 'harness-device.desktop'`, `const deviceAppIconMember = 'usr/share/icons/hicolor/128x128/apps/harness-device.png'`.
  - `typedef DeviceAppIconExtract = Future<List<int>?> Function(String appImage);` and `Future<List<int>?> extractDeviceAppIcon(String appImage)`: runs `appImage` with `['--appimage-extract', deviceAppIconMember]`, `workingDirectory` a new temp folder, 10 s bound (killed past it), and answers the bytes of `<temp>/squashfs-root/<member>`; null on any failure; the temp folder removed whatever happened.
  - `Future<void> writeDeviceAppLauncher(String appImage, {Map<String, String>? environment, DeviceAppIconExtract extractIcon = extractDeviceAppIcon})`: writes the entry and icon of Global Constraints, unless an entry already names another file still on disk; runs `update-desktop-database <data>/applications` when `environment` is null (a missing program ignored), as Desktop's own; never throws; logs `device app: launcher entry written` or a warn with the error's message only.
  - `Future<void> forgetGoneDeviceAppLauncher({Map<String, String>? environment})`: off Linux with no `environment`, nothing; when the entry's `Exec=` names a file not on disk, deletes the entry and `<data>/icons/harness-device.png`; else nothing; never throws; logs `device app: launcher entry removed`.
- `DeviceAppInstaller({…, Future<void> Function(String appImage) launcher = writeDeviceAppLauncher})`: on Linux, once install has the AppImage at the place (installed now or already there), `await launcher(place)`, then open; a launcher that throws is logged and the install goes on. Windows and macOS never call it.
- `app_shell.dart`: `unawaited(forgetGoneDeviceAppLauncher());` after `unawaited(registerAppImageLauncher());`.

- [ ] **Step 1: Failing tests.**
  - `device_app_launcher_test.dart` (a temp `HOME`; every case `skip: Platform.isWindows`, as the entry is Linux's and its paths POSIX): `the entry starts the place, named Harness Device, with its icon` (place `<home>/.local/opt/Harness-Device.AppImage`, a fake extract answering `[1, 2, 3]`: the entry equals Global Constraints' bytes exactly, the icon file holds `[1, 2, 3]`); `XDG_DATA_HOME is followed`; `a place with a space is quoted in Exec=` (`<root>/p q/.local/opt/Harness-Device.AppImage` → `Exec="<root>/p q/.local/opt/Harness-Device.AppImage"`); `an icon that cannot be taken leaves the entry without one` (extract answers null: no `Icon=` line, no icon file); `an entry naming another AppImage still on disk is left alone`; `an entry whose AppImage is gone is written again`; `no home writes nothing and does not throw`; `the AppImage's runtime is asked for the one icon, in a folder of its own` (a `#!/bin/sh` fake AppImage that records its arguments and working folder and writes `squashfs-root/<member>`: arguments exactly `--appimage-extract usr/share/icons/hicolor/128x128/apps/harness-device.png`, the bytes it wrote come back, the folder is gone afterwards; a fake that exits 1 gives null); `once the AppImage is gone, the entry and its icon go`; `an entry whose AppImage is there stays`; `an entry with no Exec= stays`; `no entry, nothing happens`.
  - `device_app_installer_test.dart`: `linux: the installed app is put in the app list, before it opens` (the recording launcher got the place, after the AppImage was there and before open); `linux: a copy already at the place gets its entry too`; `linux: a launcher that throws does not fail the install` (done at the place); `windows and macOS write no launcher entry`. Every Linux case of the file, Task 40's included, passes a recording `launcher`, so no test writes under the real home.
- [ ] **Step 2:** `cd desktop && flutter test test/devices/device_app_launcher_test.dart test/devices/device_app_installer_test.dart` FAILS (no such library; the installer has no `launcher`). Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** both files and `test/linux_app_image_test.dart` pass, and `flutter analyze` is clean. **Step 5: Commit** `Desktop lists Harness Device in Linux's app list when it installs it, and takes the entry out once the AppImage is gone`.

### Task 47: Linux: does each AppImage start without `libfuse2`? (the probe)

**Files:** Create `DA/scripts/e2e/appimage-starts.sh`; modify `.github/workflows/tmp-device-app-win-linux.yml`.

A probe: one commit, no red test; its run is the evidence, and its report decides Tasks 48, 49 and 50. Never production but one read: Desktop's current AppImage from the public manifest (Open question 1). Rules: "Decided here for section 11".

**Interfaces — Produces:**
- `appimage-starts.sh <AppImage> <name>`: scratch `HOME`, XDG folders and `TMPDIR` under one `mktemp -d`; `APPIMAGE_EXTRACT_AND_RUN` unset; the AppImage started in a process group of its own. Prints `note: <name>: <file -L's description of the AppImage>` (it says `static-pie linked` or `dynamically linked`), then `ok: <name> starts from its FUSE mount`, or `FAILED: <name>: <the runtime's first output line>` (also `FAILED: <name>: nothing ran from a FUSE mount within 60 s`); ends the group and removes the scratch folder whatever happened; exit 0 or 1. Run under `xvfb-run -a dbus-run-session --`. `EXPECT=start` (Tasks 48, 49) makes a `FAILED` fail the step; without it the step stays green and the line is the result.
- The report's table: for each runner, `libfuse2` gone (yes/no), `fusermount3` there before the run (yes/no), the two `file -L` notes, and `ok`/`FAILED` for `Harness Device` and `Harness`; and the line `note: Harness Device window WM_CLASS = "<instance>", "<class>"`.

- [ ] **Step 1: The script**, as above. `bash -n` and `shellcheck` print nothing.
- [ ] **Step 2: Two jobs in the temporary workflow.**
  - `fuse-device-build` (`ubuntu-22.04`, `ubuntu-22.04-arm`, 60 min): `linux-e2e`'s apt line, Node, UI packages, Rust, Tauri CLI and `cargo tauri build --ci --debug --bundles appimage -- --locked`, unchanged; uploads the AppImage as `fuse-device-<arch>` (`retention-days: 1`).
  - `fuse-probe` (needs `fuse-device-build`; `ubuntu-24.04`, `ubuntu-22.04`, `ubuntu-24.04-arm`, `ubuntu-22.04-arm`; 20 min): downloads its arch's artifact; reads `desktop-linux-<x64|arm64>` from `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/metadata.json` and downloads its AppImage only when the URL is `https://cdn.autonomous.ai/harness/desktop/<X.Y.Z>/Harness-linux-<arch>.AppImage` and its size and sha256 match; installs `xvfb xauth dbus-x11 xdotool x11-utils`. First, with `libfuse2` still there or `APPIMAGE_EXTRACT_AND_RUN=1`, starts the Device app with an empty state (its first window opens), waits up to 60 s for it with `xdotool search --sync --onlyvisible --pid`, prints the `WM_CLASS` note from `xprop`, and ends it. Then removes `libfuse2`/`libfuse2t64` (only what `dpkg-query` lists), fails unless `ldconfig -p | grep -c libfuse.so.2` is 0, installs `fuse3` if `fusermount3` is missing (and says so), and runs `appimage-starts.sh` on both, writing the table to `$GITHUB_STEP_SUMMARY`.
  - `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/tmp-device-app-win-linux.yml` prints nothing.
- [ ] **Step 3: Commit** `Temporary workflow: does each AppImage start on Ubuntu 22.04 and 24.04 with no libfuse2`. Once its run is done, the report carries the run's link, the table and the `WM_CLASS` line. If no window opened, say so: Task 50 then reads `WM_CLASS` from linux-e2e's sign-in window.

### Task 48: The Device app's AppImage on the static runtime

**Files:** Create `DA/scripts/appimage-runtime.sh`, `DA/scripts/test_appimage_runtime.py`; modify `DA/scripts/release-build.sh`, `DA/scripts/release-check.sh`, `DA/scripts/test_release_build.py`, `.github/workflows/tmp-device-app-win-linux.yml`.

**Result:** Task 47 found both AppImages (Device and Desktop) already on the static type2 runtime (`file -L`: `static-pie linked`), starting with no `libfuse2` on all four runners. Tasks 48 and 49 took their first branch: evidence only, no runtime switch.

**If Task 47 found `ok: Harness Device starts` on all four runners:** no code changes. Set `EXPECT=start` for the Device app in `fuse-probe`; once green, the report has both runs' links (before and after are the same). One commit: `Temporary workflow: the Device app's AppImage must start with no libfuse2`. Stop here.

**Otherwise — Interfaces — Produces:**
- `appimage-runtime.sh <AppImage>`: picks `runtime-x86_64` or `runtime-aarch64` from the AppImage's ELF machine (62 or 183, as `release-check.sh` reads it), downloads it into the cache folder unless there, refuses (`appimage-runtime: <file> is not the runtime pinned here`, exit 1) when its sha256 is not the pin, and replaces the runtime as "Decided here for section 11" says. Fails, leaving the AppImage untouched, when the offset cannot be read or holds no `hsqs`. Prints `appimage-runtime: <name> now starts with type2-runtime 20251108`.
- `release-build.sh bundle` on Linux calls it on the bundled AppImage before the move. `release-check.sh` on Linux gains `check "the AppImage starts with the pinned runtime"`: its first `<pinned size>` bytes hash to the pin.

- [ ] **Step 1: Failing tests.**
  - `test_appimage_runtime.py` (a fake "AppImage": a `#!/bin/sh` script, padded, that answers `--appimage-offset` with where its `hsqs` payload starts; a fake runtime file in a pre-filled cache folder; a fake `curl` that records and serves): `the runtime is replaced and the payload kept` (the new file is the runtime's bytes then the old payload's, mode 0755); `a runtime whose sha256 is not the pin is refused and the AppImage is untouched`; `an AppImage with no squashfs at its offset is refused and untouched`; `the pinned file is downloaded once from the 20251108 release` (the URL exactly; a second run makes no request); `each arch takes its own runtime` (ELF machine 62 → `runtime-x86_64`, 183 → `runtime-aarch64`, other → refused); `the pins are 64 hex characters, one per arch`.
  - `test_release_build.py`: `linux: bundle puts the pinned runtime in front of the AppImage before it is moved` (the fake cargo's AppImage, as the fakes above); `linux: release-check refuses an AppImage that does not start with the pinned runtime`.
- [ ] **Step 2:** `python3 -m unittest device-app/scripts/test_appimage_runtime.py device-app/scripts/test_release_build.py` FAILS. Commit red.
- [ ] **Step 3: Implement.** Record each pin as the sha256 of the asset downloaded from the 20251108 release (and checked against the release's signature file if it publishes one; say which in the report). In the temporary workflow, every Device AppImage build (`linux-e2e`, `desktop-device-app-e2e`, `fuse-device-build`) runs `bash device-app/scripts/appimage-runtime.sh <AppImage>` right after `cargo tauri build`; `fuse-probe` sets `EXPECT=start` for the Device app.
- [ ] **Step 4:** both test files pass on this Mac; on GitHub `fuse-probe` prints `ok: Harness Device starts from its FUSE mount` on the four runners (the after evidence; Task 47's run is the before) and `linux-e2e` stays green. **Step 5: Commit** `Harness Device's AppImage starts with no libfuse2: the static type2 runtime, pinned`.
- If the runtime cannot be replaced (the app does not start on it either), stop and report both runs: the fallback words are Open question 3.

### Task 49: Desktop's AppImage on the static runtime

**Files (only when needed):** Create `DT/scripts/package-desktop-linux.sh`; modify `DT/scripts/upload-desktop-linux.sh`, `.github/workflows/release-desktop.yml`, `DA/scripts/test_appimage_runtime.py`, `DT/RELEASE.md`. Always: `.github/workflows/tmp-device-app-win-linux.yml`.

Depends on 48: it reuses Task 48's pins (and shares its test file).

**Result:** Desktop's AppImage was already `static-pie linked` and started with no `libfuse2` (Task 48's result): the first branch, no code.

**If Task 47 found `ok: Harness starts` on all four runners** (`appimagetool` 1.9.1 already embeds the static runtime): no code. `fuse-probe` sets `EXPECT=start` for Desktop. One commit: `Temporary workflow: Desktop's AppImage must start with no libfuse2`. Stop here.

**Otherwise:**
- `package-desktop-linux.sh VERSION OUTPUT`: steps 2 and 3 of `upload-desktop-linux.sh` moved out unchanged (build, `version.txt`, AppDir, `appimagetool`), plus `--runtime-file "$APPIMAGE_RUNTIME"`; `upload-desktop-linux.sh` calls it and keeps only the version and upload steps. `release-desktop.yml`'s `build-linux` downloads Task 48's pinned runtime for its arch beside `appimagetool`, checks its sha256 and exports `APPIMAGE_RUNTIME`.
- [ ] **Step 1: Failing test** in `test_appimage_runtime.py`: `release-desktop.yml pins the same runtime as appimage-runtime.sh` (reads the workflow, as `test_release_workflow.py` does: the 20251108 URL and the two sha256s are the script's). **Step 2:** it FAILS. Commit red.
- [ ] **Step 3: Implement.** In the temporary workflow, a job `fuse-desktop-build` (`ubuntu-22.04`, `ubuntu-22.04-arm`) runs `package-desktop-linux.sh 0.0.0` with `release-desktop.yml`'s toolchain steps and hands the AppImage to `fuse-probe` in place of the release's; `EXPECT=start` for Desktop.
- [ ] **Step 4:** the test passes; `fuse-probe` prints `ok: Harness starts from its FUSE mount` on the four runners. **Step 5: Commit** `Harness Desktop's AppImage starts with no libfuse2: the static type2 runtime, pinned`.

### Task 50: One rule for `harness-device.desktop`: the vectors

**Files:** Create `tests/fixtures/app-list-entry-vectors.json`; modify `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`.

**Interfaces — Produces** `tests/fixtures/app-list-entry-vectors.json` (read by Tasks 51, 52, 53), UTF-8, two-space JSON:
- `"startupWMClass"`: the class from Task 47's `WM_CLASS` note (its second string).
- `"dataHome"`: cases `{ "env": {"HOME"?, "XDG_DATA_HOME"?}, "dataHome": string | null }`: absolute XDG wins; a relative or empty XDG falls back to `HOME/.local/share`; no absolute HOME and no absolute XDG → null.
- `"exec"`: cases `{ "path", "exec": string | null }`, each `exec` what Desktop's `quoteLauncherExec` answers today: `/home/p/.local/opt/Harness-Device.AppImage` (plain); `/home/p q/.local/opt/Harness-Device.AppImage` (`"…"`); `/home/p/100%/H.AppImage` (`%%`, no quotes); `/home/p/a"b$c` + "`" + `d\e/H.AppImage` (each of the four backslashed, quoted); `/home/p/naïve/H.AppImage` (plain); a path with a newline (null: nothing is written).
- `"entries"`: `{ "appImage", "dataHome", "icon": bool, "entry" }` for the plain and the spaced path, with and without icon: the bytes of Global Constraints, `StartupWMClass=` last.
- `"decisions"`: `{ "name", "appImage", "existing": string | null, "onDisk": [paths], "write": bool }`: no entry; own `Exec=` and the same bytes with its icon on disk (leave); own `Exec=`, same bytes, icon gone (write); own `Exec=`, Task 46's old bytes without `StartupWMClass` (write); another AppImage on disk (leave); an absolute path not on disk (write); `Exec=harness-device` (leave); no `Exec=` line (leave); a quoted `Exec=` with `%%` naming this AppImage (own).

- [ ] **Step 1: Failing test** in `test_ci_plan.py`: `test_the_app_list_vectors_select_desktop_device_app_and_website` (a change to the fixture alone selects `desktop`, `device-app` and `website`, as `test_a_file_another_suite_reads_selects_that_suite` builds its plan). **Step 2:** `python3 -m unittest scripts/tests/test_ci_plan.py` FAILS. Commit red.
- [ ] **Step 3:** Write the fixture. In `ci-plan.py` add `tests/fixtures/app-list-entry-vectors.json` to both tables (source inputs and selection) for `device-app` and `website`, and to `desktop`'s selection (its checkout already holds `tests/`), each with a one-line comment naming the reader.
- [ ] **Step 4:** `test_ci_plan.py` passes (the existing `test_every_declared_input_selects_the_suite_that_reads_it` too). **Step 5: Commit** `One rule for Harness Device's Linux app-list entry: the vectors every writer's tests read`.

### Task 51: Linux: the Device app lists itself in the app list

**Files:** Create `ST/src/app_list.rs`; modify `ST/src/lib.rs` (one module line: `#[cfg(any(target_os = "linux", all(test, unix)))] pub mod app_list;`), `ST/src/main.rs` (the Linux block beside the tray-host thread), `DA/scripts/e2e/linux.sh`.

**Interfaces — Consumes:** the vectors (Task 50). **Produces** (`app_list.rs`):
- `pub const ENTRY: &str = "harness-device.desktop"`, `pub const ICON_MEMBER: &str = "usr/share/icons/hicolor/128x128/apps/harness-device.png"`, `pub const WM_CLASS: &str` (the vectors' value).
- `pub fn data_home(xdg_data_home: Option<&OsStr>, home: Option<&Path>) -> Option<PathBuf>`.
- `pub fn exec_value(appimage: &Path) -> Option<String>` (Desktop's `quoteLauncherExec`, ported; None for a control character or not UTF-8) and `pub fn exec_target(entry: &str) -> Option<String>` (Desktop's `launcherExecTarget`, ported).
- `pub fn entry(exec: &str, icon: Option<&Path>) -> String`.
- `pub enum Change { Write, Leave }` and `pub fn change(existing: Option<&str>, appimage: &Path, wanted: &str, exists: impl Fn(&Path) -> bool) -> Change` (the rule; "exists" also answers for the icon named in `wanted`).
- `pub fn apply(data_home: Option<&Path>, appimage_var: Option<&OsStr>, appdir_var: Option<&OsStr>) -> Option<Result<Change, String>>`: None when the run is no AppImage; else `Ok(Change::Write)`, `Ok(Change::Leave)` or the error's log line. Icon bytes from `<APPDIR>/<ICON_MEMBER>` (APPDIR absolute) or none; written as `loginitem_linux::write` writes (temp file, rename), icon first. The error is `failed`'s shape: `app list: entry not written (error N)` / `(<kind>)`.
- `pub fn line(outcome: Result<Change, String>) -> String`: `app list: entry written`, `app list: entry kept`, or the error.
- `#[cfg(target_os = "linux")] pub fn system() -> Option<String>`: `line` of `apply`, None only when the run is no AppImage. Every AppImage run logs one `app list:` line, so a check waits for the app's decision, not for any line.
- `main.rs`, the `#[cfg(target_os = "linux")]` block: a second `thread::spawn` that logs `app_list::system()`'s line when there is one.

- [ ] **Step 1: Failing tests** (`app_list.rs`, `cfg(all(test, unix))`, the vectors by `include_str!` from `CARGO_MANIFEST_DIR/../../tests/fixtures/app-list-entry-vectors.json`, parsed with `serde_json`): `the_data_home_is_desktops` (vectors `dataHome`); `the_exec_line_quotes_as_desktop_does` (vectors `exec`); `the_entry_is_desktops_byte_for_byte` (vectors `entries`); `who_writes_the_entry_is_one_rule` (vectors `decisions`); `the_icon_comes_from_inside_the_image` (a temp APPDIR holding the member: the icon file has its bytes and the entry its `Icon=`; APPDIR unset, relative or without the file: no icon file, no `Icon=`); `not_an_appimage_writes_nothing` (APPIMAGE unset, relative, a folder); `a_second_run_leaves_the_entry` (Ok(true), then Ok(false), the entry's mtime unchanged); `a_failure_is_a_log_line_not_a_panic` (the data home is a file: `Err("app list: entry not written (error 20)")`, nothing panics); `the_entry_is_written_whole` (no temp file left; the folders are made).
- [ ] **Step 2:** `cd device-app/src-tauri && cargo test --locked --lib app_list` FAILS (no module). Commit red.
- [ ] **Step 3: Implement**, then linux.sh's checks (they run in `linux-e2e`, whose AppImage runs from `My Apps`): `the first run lists the app: harness-device.desktop is the vectors' entry for this AppImage, its icon a PNG` (the icon's bytes equal `--appimage-extract`'s of the member); `StartupWMClass is the window's WM_CLASS` (`xprop` on the app's window when the sign-in step shows it); `a second run leaves the entry, byte for byte and mtime`; `an entry naming another AppImage on disk is left alone`; `an entry naming a file that is gone is written again`; `with a read-only applications folder the tray still registers and the log says app list: entry not written (error 13)`.
- [ ] **Step 4:** `cargo test --locked --lib` passes on this Mac; `linux-e2e` is green on both arches with the six new `ok:` lines. **Step 5: Commit** `Harness Device lists itself in Linux's app list when it runs from an AppImage, by the rule Desktop follows`.

### Task 52: Desktop writes the app's entry by the same rule; the flow test

**Files:** Modify `DT/lib/devices/device_app_launcher.dart`, `DT/test/devices/device_app_launcher_test.dart`, `DT/lib/core/linux_app_image.dart`, `DT/test/linux_app_image_test.dart`, `DT/test/devices/device_app_flow_test.dart`, `DT/test/support/device_app.dart`.

**Interfaces — Consumes:** the vectors (Task 50). **Produces:**
- `linux_app_image.dart`: `launcherDataHome` follows the vectors (an XDG that is not absolute is skipped; a `HOME` that is not absolute gives null). Desktop's own `harness.desktop` follows it too: the XDG spec's rule, a fix.
- `device_app_launcher.dart`: `const deviceAppWindowClass` (the vectors' value), written last as `StartupWMClass=`; `writeDeviceAppLauncher` decides by the rule (`@visibleForTesting bool deviceAppLauncherChange({String? existing, required String appImage, required String wanted, required bool Function(String path) exists})` → true is write), writes nothing for a path with a control character, and writes through a temp file and a rename, icon first. `forgetGoneDeviceAppLauncher` is unchanged.
- `support/device_app.dart`: `DeviceAppFixture({…, Future<DeviceAppInstallResult> Function()? install})`, the fake's `call` when null.

- [ ] **Step 1: Failing tests.**
  - `device_app_launcher_test.dart` (temp folders; `skip: Platform.isWindows` as today), reading the vectors from `../tests/fixtures/app-list-entry-vectors.json`: `the entry is the vectors' byte for byte` (each `entries` case, through `writeDeviceAppLauncher` with a fake extract); `the decisions are the vectors'` (each `decisions` case through `deviceAppLauncherChange`); `a path with a control character writes nothing`; `the entry is written whole` (no temp file left). Today's `the entry starts the place, named Harness Device, with its icon` now expects the vectors' bytes.
  - `linux_app_image_test.dart`: `launcherDataHome is the vectors'` (each `dataHome` case).
  - `device_app_flow_test.dart`, as a person on Linux: `linux: Install from the band lists Harness Device in the app list with the entry the app writes` (`TargetPlatformVariant.only(TargetPlatform.linux)`, `skip: Platform.isWindows` as its paths are POSIX; the fixture's `install` writes through the real `writeDeviceAppLauncher` into a temp data home with a fake extract, inside `tester.runAsync`, then answers done at the place; tap `device-app-band-install`; the band goes; the entry file equals the vectors' entry for that place).
- [ ] **Step 2:** `cd desktop && flutter test test/devices/device_app_launcher_test.dart test/linux_app_image_test.dart test/devices/device_app_flow_test.dart` FAILS. Commit red.
- [ ] **Step 3: Implement.** **Step 4:** those three files, `test/devices` and `flutter analyze` pass. **Step 5: Commit** `Desktop writes Harness Device's app-list entry by the rule the app follows, with its window class`.

### Task 53: The one-line installer and its route

**Files:** Create `WS/scripts/device-install.sh`, `WS/scripts/device-install.spec.ts`, `WS/scripts/upload-device-install-sh.sh`; modify `WS/next.config.js` (`redirects()`), `WS/README.md`.

**Interfaces — Consumes:** the vectors (Task 50); the device manifest's Linux keys (Task 27). **Produces:**
- `device-install.sh`, POSIX `sh`, Linux only, as `desktop-install.sh`'s Linux branch with these values: `METADATA_URL="${HARNESS_DEVICE_METADATA_URL:-https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json}"`; `OTA_KEY="device-linux-$RELEASE_ARCH-appimage"`; the URL only `https://cdn.autonomous.ai/harness/device/$VERSION/Harness-Device-linux-$RELEASE_ARCH.AppImage` or the same under `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/`; `DESTINATION="$HOME/.local/opt/Harness-Device.AppImage"` (no override); staging in a `mktemp -d` beside it, removed on exit; size, then sha256, then `chmod 755`, then the move with the backup; refuses while `pgrep -f "$DESTINATION"` finds it running. Then the icon (`--appimage-extract usr/share/icons/hicolor/128x128/apps/harness-device.png` in the staging folder) and the entry, only when no `harness-device.desktop` exists (the data home and `Exec=` quoting by the vectors' rules; a path with a control character writes no entry); none of this fails the install. Then `setsid -f "$DESTINATION" >/dev/null 2>&1 </dev/null`.
- `upload-device-install-sh.sh`: `upload-desktop-install-sh.sh` with `harness/device/install.sh` and this script, the same headers.
- `next.config.js`: `{ source: '/device/install.sh', destination: 'https://cdn.autonomous.ai/harness/device/install.sh', permanent: true }` beside `/desktop/install.sh`'s.

- [ ] **Step 1: Failing tests** in `device-install.spec.ts`, run as `desktop-install.spec.ts` runs its script (stub `uname`, `curl`, `pgrep`, `setsid` first on PATH; real `sha256sum`/`sed`; a temp HOME; the "AppImage" a `#!/bin/sh` file that writes `squashfs-root/<member>` for `--appimage-extract <member>` and otherwise records that it ran): `is valid POSIX shell`; `refuses a computer that is not Linux` (Darwin: exit 1, the exact line, nothing downloaded); `takes the AppImage of this arch from the device manifest` (x86_64 and aarch64: the key read and the URL fetched); `refuses a URL outside the device release folders` (Desktop's folder, another version than the manifest's, `..`, `%2e%2e`, a query, a fragment, the other arch's file, `http:`: each exit 1, nothing at the place; the GCS URL is accepted); `refuses a size or a sha256 that does not match, and leaves nothing at the place`; `places the AppImage executable and starts it` (mode 0755, the bytes served, the start through `setsid -f` with no argument); `writes the entry the app writes` (its lines are the vectors' `entries` case with icon, with this HOME's `Exec=` and `Icon=`); `a home with a space, a percent and a dollar is quoted as the app quotes it` (`Exec=` as the vectors' rule gives it for that path); `an entry already there is left for the app` (byte for byte); `starts the app in a session of its own` (the stub `setsid` saw `-f`); `refuses while the app runs from the place`; `redirects /device/install.sh to the CDN for good` (the entry above in `redirects()`); `uploads to harness/device/install.sh` (the upload script's `GCS_PATH` and `sh -n` line).
- [ ] **Step 2:** `cd website && npx vitest run scripts/device-install.spec.ts` FAILS. Commit red.
- [ ] **Step 3: Implement.** README: the installers row gains `/device/install.sh`; under it: `The Harness Device installer's source is scripts/device-install.sh, published with scripts/upload-device-install-sh.sh.`
- [ ] **Step 4:** `npm test` and `npm run lint` pass; `sh -n` and `shellcheck -s sh` print nothing. **Step 5: Commit** `Website: a one-line installer for Harness Device on Linux, served as Desktop's is`.

### Task 54: End to end: the one line on Ubuntu 24.04 with no `libfuse2`

**Files:** Create `DA/scripts/e2e/linux-install.sh`, `DA/scripts/e2e/https-fake-cdn.py`; modify `.github/workflows/tmp-device-app-win-linux.yml`.

Test tooling: one commit, no red test; its job is the evidence. Never production, no account: it runs only on a GitHub-hosted runner (it refuses without `GITHUB_ACTIONS=true` and `RUNNER_TEMP`), because it changes the runner's `/etc/hosts` and trust store.

- `https-fake-cdn.py <folder> <cert> <key>`: serves the folder over HTTPS on 127.0.0.1:443 and logs each request line to `<folder>/../requests.log`.
- `linux-install.sh <AppImage>` (this run's debug build, the runtime already swapped by Task 48 when it swaps it): removes `libfuse2`/`libfuse2t64` and proves it gone, `fuse3` as Task 47; makes a throwaway CA and a `cdn.autonomous.ai` certificate in a scratch folder, trusts the CA (`/usr/local/share/ca-certificates`, `update-ca-certificates`), maps `cdn.autonomous.ai` to 127.0.0.1 in `/etc/hosts`; serves `harness/device/<0.0.0>/Harness-Device-linux-<arch>.AppImage`, a manifest naming it under `e2e/metadata.json`, and the repository's `website/scripts/device-install.sh` as `harness/device/install.sh`; scratch `HOME` and XDG folders, the Device app's state seeded as `linux.sh` seeds it (it installs nothing and opens no window), `xvfb-run -a` and `dbus-run-session`; then runs exactly `curl -fsSL https://cdn.autonomous.ai/harness/device/install.sh | HARNESS_DEVICE_METADATA_URL=https://cdn.autonomous.ai/e2e/metadata.json bash` in a shell that ends when the line does. Checks, each `ok:` or `FAILED:`:
  1. A manifest whose sha256 is one hex digit off: exit 1, `Harness Device installer: downloaded AppImage checksum does not match the release metadata`, no file at the place.
  2. `libfuse2 is not on this computer`.
  3. The line exits 0 and prints `Harness Device 0.0.0 installed at <HOME>/.local/opt/Harness-Device.AppImage`; the file is mode 0755 and the served bytes.
  4. `the app runs from its FUSE mount` (Task 47's rule) within 60 s, its `/proc/<pid>/environ` naming `APPIMAGE=<the place>`.
  5. `the app outlives the shell that ran the line` (the line's shell has ended; the app still runs).
  6. `harness-device.desktop` is the vectors' entry for the place, with its icon (a PNG, the member's bytes).
  7. `the app's first run leaves the installer's entry`: once the app's log has `app list: entry kept`, the entry's bytes and mtime are as after check 6, and the log has no `app list: entry written`.
  8. A second run of the line while the app runs: exit 1, `Harness Device installer: Harness Device is running from <place>. Quit it, then run this installer again.`
  It ends the app, stops the server, and restores `/etc/hosts` (the runner is thrown away after).
- Temporary workflow job `install-sh-e2e` (`ubuntu-24.04`, `ubuntu-24.04-arm`, 90 min): builds the Device AppImage as `linux-e2e` does (with Task 48's runtime step, when Task 48 added one), then `bash device-app/scripts/e2e/linux-install.sh <AppImage>`. The workflow's `paths` gain `website/scripts/device-install.sh`.

- [ ] **Step 1: Write them.** **Step 2:** `install-sh-e2e` is green on both runners with the eight `ok:` lines. **Step 3: Commit** `End to end: the one-line install of Harness Device on Ubuntu 24.04 with no libfuse2`.

### Task 55: `/device` shows the line to Linux visitors

**Files:** Modify `WS/src/lib/installCommand.ts`, `WS/src/lib/installCommand.spec.ts`, `WS/src/app/device/DeviceDownload.tsx`, `WS/src/app/device/DeviceDownload.spec.tsx`.

`/device` is Diego's component: nothing in `page.tsx`, `page.module.css` or `DeviceFiles.tsx` changes; the line uses the page's own `styles.meta` and `styles.kbd`.

**Interfaces — Produces:** in `installCommand.ts`, `DEVICE_INSTALL_URL = "https://harness.autonomous.ai/device/install.sh"` and `DEVICE_INSTALL_COMMAND = \`curl -fsSL ${DEVICE_INSTALL_URL} | bash\``, with a comment naming the script and its redirect. In `DeviceDownload.tsx`, `function InstallLine()` → `<span className={styles.meta}>Or in a terminal: <code className={styles.kbd}>{DEVICE_INSTALL_COMMAND}</code></span>`, rendered when `visitorOs(platform) === "linux"` and `builds.some((b) => b.os === "linux" && b.pkg === "appimage")`: after the `Offer` when there is one, else before `Others`.

- [ ] **Step 1: Failing tests.**
  - `installCommand.spec.ts`: `the Harness Device line is the documented one, verbatim` (the command exactly); `its URL is the one next.config sends to the CDN` (imports `../../next.config.js`, as `scripts/desktop-redirect.spec.ts` does: a permanent redirect from `/device/install.sh` to `https://cdn.autonomous.ai/harness/device/install.sh`).
  - `DeviceDownload.spec.tsx` (the manifest builders the file has; `LINUX_APPIMAGE = { "device-linux-x64-appimage": { url: \`${CDN}Harness-Device-linux-x64.AppImage\`, size: 1 } }`): `gives a Linux visitor the one line beside its AppImage` (`linux-x64`: the Download button's href is the AppImage, and the text `Or in a terminal: curl -fsSL https://harness.autonomous.ai/device/install.sh | bash`, the command in a `code` element); `gives a Linux visitor of unknown CPU the line too` (`linux`: no button, the line, the links); `shows no line while the release has no Linux AppImage` (`LIVE`; `LIVE` with only `LINUX`'s deb); `shows no line to a Mac, a Windows PC or a phone` (with the AppImage key); `the line names no plan and no package` (its text has none of `AppImage`, `libfuse`, `.deb`, `plan`, `Pro`). Every existing case stays as it is and green.
- [ ] **Step 2:** `cd website && npx vitest run src/lib/installCommand.spec.ts src/app/device/DeviceDownload.spec.tsx` FAILS. Commit red.
- [ ] **Step 3: Implement.** **Step 4:** `npm test` and `npm run lint` pass. **Step 5: Commit** `Website: /device gives Linux visitors the one-line install once a release has their app`.

### Task 56: End to end: Desktop's entry and the app's are one

**Files:** Modify `DT/integration_test/device_app_install_windows_linux_native_test.dart`.

Test tooling: one commit, no red test; `desktop-device-app-e2e` (Task 44's job, unchanged) is the evidence.

- Check 7 now expects the vectors' entry (with `StartupWMClass=`), read from `../tests/fixtures/app-list-entry-vectors.json`. A new check after check 7, Linux: `the app's first run leaves Desktop's entry`: with the app running (check 4), once its log (`$XDG_DATA_HOME/ai.autonomous.harness.device/logs/app-*.log`) has `app list: entry kept`, the entry's bytes and mtime are as Desktop wrote them, and the log has no `app list: entry written`.
- [ ] **Step 1: Write it.** **Step 2:** `desktop-device-app-e2e` is green on its four runners (the new check on the two Linux ones). **Step 3: Commit** `End to end: the Device app leaves the app-list entry Desktop wrote for it`.

### Task 57: Docs: installing on Linux

**Files:** Modify `DA/RELEASE.md`, `DA/AGENTS.md`, `docs/validation-and-release.md`.

One commit, no test. Describe what the code does.

- [ ] **Step 1: `DA/RELEASE.md`.** The Linux AppImage: the runtime it starts with (the bundler's, or the pinned type2 runtime and how to move the pin: a new release tag, both sha256s, Task 48's test), and that it needs no `libfuse2`. The one-line installer: its source, its URL and redirect; that `release-device.yml`'s `publish` uploads it with every release that carries Linux, before the manifest, since `/device` shows the line as soon as the manifest has a Linux AppImage (Answer 2 of section 11). The app-list entry: three writers, one rule, the vectors file.
- [ ] **Step 2: `DA/AGENTS.md`.** "Fixed arguments" gains `harness-device.desktop` and its icon, written by the app at every launch from an AppImage (written, never run). "Commands" gains `linux-install.sh` and `appimage-starts.sh`.
- [ ] **Step 3: `docs/validation-and-release.md`.** Under what PR CI does not run: the FUSE probe and the one-line install end to end (temporary workflow jobs here).
- [ ] **Step 4: Commit** `Docs: Harness Device installs on Linux with no libfuse2, by one line, and lists itself`.

## Verification

Every check uses a fake CLI or a test profile. None signs in, none uses a real person's account, none reaches a production backend. The two checks that read production's public CDN (Verification 7) run by answer 4.

**1. On this Mac, per task** (nothing outside the worktree and the scratchpad): `cd device-app/src-tauri && cargo test --locked --lib`; `cd device-app/ui && npm test && npm run typecheck`; `python3 -m unittest discover -s device-app/scripts -p 'test_*.py'`; `python3 -m unittest scripts/tests/test_ci_plan.py`; `cd cli && npx vitest run src/scripts/installPs1.spec.ts`.

**2. Local gate PR CI does not run** (`docs/validation-and-release.md`, "Harness Device on macOS"): `cd device-app/src-tauri && cargo test --locked` on this Mac at the final commit, recorded in the pull request. Then the reference's own two checks, both from a scratch `HOME`, neither touching the installed app: `bash device-app/scripts/e2e/macos.sh` (a person sees `ok:` lines, the last naming the menu row line) and `bash device-app/scripts/e2e/update-pair.sh <scratchpad>/pair && bash device-app/scripts/e2e/macos.sh --update <scratchpad>/pair` (0.0.1 becomes 0.0.2 from `127.0.0.1:8765`).

**3. On GitHub, the temporary workflow** `tmp-device-app-win-linux.yml`, started by a push to `feat/device-app-win-linux` (by hand: push the branch; there is no dispatch). Runners are disposable; no secret exists in it. Section 10 adds `desktop-device-app-e2e` (Verification 10); section 11 adds `fuse-device-build`, `fuse-probe` (and `fuse-desktop-build` if Task 49 changes Desktop) and `install-sh-e2e` (Verification 12, 14).
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

**8. The website routes and page (section 10)**, on this Mac and in PR CI's `website-checks`: `cd website && npm ci && npm test && npm run lint`. A person reads the route specs' cases pass: 302 to each OS's file for each arch, x64 when the request cannot tell, 503 with the macOS route's words before a release carries the key, and every refusal. No end-to-end run: the routes read one fixed manifest with no override, on purpose (`deviceManifest.ts`), so a local server would read production's; the specs, over a mocked `fetch`, are the proof.

**9. Desktop's rules (section 10).** On this Mac: `cd desktop && flutter test test/devices test/update_signature_test.dart test/linux_app_image_test.dart test/elements_gallery_test.dart && flutter analyze` (the launcher cases run here too: they need POSIX paths, not Linux). Linux: PR CI's `desktop-tests` runs them, the real `/proc` case included. Windows: `windows-desktop.yml`, by hand on the branch (`gh workflow run windows-desktop.yml --ref feat/device-app-win-linux`, its default test mode, no release), on x64 and arm64: the real `tasklist` and Authenticode cases pass, the launcher cases are skipped, and no `test/devices/` file or `update_signature_test.dart` is in `test/windows_known_failures.txt`. A person reads both legs green.

**10. Desktop installs the real app** (Task 44): the temporary workflow's `desktop-device-app-e2e`, started by the same push, on `windows-latest`, `windows-11-arm`, `ubuntu-22.04` and `ubuntu-22.04-arm`. Disposable runners, a loopback stand-in manifest, this run's unsigned debug package, a scratch `HOME` and XDG folders on Linux; no account, no backend, no production file. A person reads each of the eight checks pass (six on Windows) on the four runners; checks 7 and 8 prove the Linux app-list entry, its icon taken from the real AppImage, and its removal.

**11. By eye.** In this pull request: a person looks at the `device-app` gallery images Task 43 regenerated (`desktop/test/goldens/elements/device-app-light.png` and `-dark.png`, in the pull request's diff): macOS's band and rows unchanged, then the band and row in the tray app's words, nothing cut off. No live walk: the flow tests click through on all three OSes with their words, and Verification 10 runs the real install, probe, start and app-list entry. Desktop's manifest URL is fixed with no override, so a by-eye walk before a release could only read production's manifest. For harness-pm after the first `platforms=all` release (not this pull request), on the Windows ARM VM's test user and a Linux desktop, with a Desktop of that release and a dial plugged in (after `feat/dial-windows` and `feat/dial-linux`): the band reads `Your dial follows apps with the Harness tray app.`; Install puts it in place and it runs in the tray; on Linux `Harness Device` shows in the app list with its icon and starts from there; Quit it, and the Devices row's `Open` starts it; delete the AppImage and relaunch Desktop, and the app-list entry is gone; `/device` reads `The app for your Harness device.` and its Windows and Linux buttons download that release.

**12. Each AppImage starts with no `libfuse2` (section 11; Tasks 47 to 49):** the temporary workflow's `fuse-probe`, started by a push to the branch, on `ubuntu-24.04`, `ubuntu-22.04`, `ubuntu-24.04-arm` and `ubuntu-22.04-arm` (disposable VMs; `libfuse2` removed and proven gone; scratch `HOME`; no account, no backend; Desktop's AppImage is the current release's public file, by Open question 1). Before: Task 47's run. After: Task 48's and 49's runs, `EXPECT=start`. A person reads, per runner, `libfuse2 gone`, then `ok: Harness Device starts from its FUSE mount` and `ok: Harness starts from its FUSE mount`, and the two `file -L` notes (`static-pie linked` where the static runtime is in front).

**13. The Device app lists itself (Task 51):** `linux-e2e` (Verification 3), its six new `ok:` lines: the entry and icon on the first run, `StartupWMClass` equal to the window's `WM_CLASS`, left alone on the second run and when it names another AppImage, written again when its file is gone, and a read-only folder costing only a log line.

**14. The one line (Tasks 53, 54):** on this Mac and in `website-checks`, `cd website && npx vitest run scripts/device-install.spec.ts`. End to end, the temporary workflow's `install-sh-e2e` on `ubuntu-24.04` and `ubuntu-24.04-arm`: a disposable runner with `libfuse2` removed, `cdn.autonomous.ai` pointed at a local HTTPS server under a throwaway CA, this run's AppImage and a stand-in manifest, a scratch `HOME`, the app's state seeded so it installs nothing; never the real CDN or bucket. A person reads the eight `ok:` lines: a tampered download refused, the place, the app running from its FUSE mount and outliving the shell, the entry and icon, the entry left by the app, the second run refused.

**15. Desktop's entry and the app's are one (Task 56):** `desktop-device-app-e2e` (Verification 10), its new Linux check: the started app leaves Desktop's entry byte for byte.

**16. `/device` (Task 55):** `website-checks` and `cd website && npm test` on this Mac: the line shows only to Linux visitors and only with a Linux AppImage in the release, in the page's own style, naming no plan or package. No live run before a release: the page reads the one fixed manifest, which has no Linux key yet. For harness-pm after the first `platforms=all` release, with `device-install.sh` uploaded (not this pull request): a person on a stock Ubuntu 24.04 desktop with no `libfuse2` (their own Ubuntu, signed in to nothing; a test account if the app is then signed in) opens `/device`, sees the line under the Linux button, pastes it in a terminal, closes the terminal, and finds Harness Device in the tray and in the app list with its icon; the downloaded AppImage, made executable, starts with a double-click.

**In PR CI, by itself,** once the pull request is ready: `device-app-checks` (both legs; Tasks 48 and 51 too), `cli-tests` (Task 18), `desktop-tests` (Tasks 39 to 43, 46 and 52, and the design doc and gallery are under `desktop/`), `website-checks` (Tasks 37, 38, 53 and 55), `process-checks` (actionlint, the planner's test, Task 50's `test_ci_plan.py`). Nothing else is started by hand but Verification 9's `windows-desktop.yml`. Platforms the pull request names: macOS (reference, re-tested), Windows x64 and arm64, Linux x64 and arm64, and the website (every browser).

## Answers (section 11, main session, 2026-11-20)

1. **Desktop's "before" reads its public release:** yes. It is a public file read through the public manifest, with
   no account and nothing written. Task 47 probes it as people download it.
2. **Who uploads the one-line script:** `release-device.yml` uploads it with every release that carries Linux. It goes
   up in `publish`, before the manifest names a Linux AppImage, so `/device` never shows a line whose script is
   missing. There is no hand upload: a step a person can forget is a bug (code over prompts). Task 53 adds this to
   `release-device.yml` and its test (`test_release_workflow.py`), and drops `upload-device-install-sh.sh`.
3. **Only if Task 48 or 49 stops:** that task reports what it found, and the words are decided then.
4. **`Or in a terminal:` on `/device`:** keep it. It is short, names no plan or package, and matches the page's voice.

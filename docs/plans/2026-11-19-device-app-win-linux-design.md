# Harness Device on Windows and Linux: design

Date: 2026-11-19. Branch `feat/device-app-win-linux`, base `6dcb285e7d`. One pull request for both platforms.

## Intent

The Harness Device menu-bar app (`device-app/`, Rust + Tauri 2) runs only on macOS today. People with a dial on Windows
or Linux get no menu, no installer of the CLI, no keep-alive of the daemon and no source of the app in front, which the
dial needs for rests, scroll and the app filter. This work ships the same app on Windows (x64, arm64) and Linux (x64,
arm64).

**The macOS app is the reference** (Ken, 2026-11-19: "lấy behavior + UI UX của macOS làm chuẩn"; "phải giữ UX giống
nhau nhất có thể"). Same menu rows in the same order, same copy, same states and transitions (`Plug in your device`,
`Device ready`, `Updating device…`, `Updating Harness…`), same consents, same sign-in flow, same updater behavior and
cadence, same icons. Every place Windows or Linux must differ is a **named difference** below, with its reason. There
is no silent difference.

## Goals

1. `device-app/src-tauri` compiles, tests and runs on Windows; it already compiles on Linux.
2. On both: installs the CLI when it is missing, keeps the daemon alive (`harness start --if-down`, the same keepalive
   rule), starts at login, updates itself, signs in, Export logs, the sound and Notifications toggles, the
   window's three screens, About, Quit, all with macOS's copy.
3. The app in front feeds the dial on Windows (WinEvent hook), on Linux X11 (existing), sway and Hyprland (new), always
   through `harness hardware watch`'s stdin, as on macOS.
4. Packages: an NSIS per-user installer on Windows, an AppImage on Linux; both built by `release-device.yml`, which
   writes them into the one manifest. No release is run by this work.
5. A test holds the menu model the same on every OS, except the named differences.

## Non-goals

- Running a release (`release-device` for Windows/Linux only on Ken's word).
- Changing the CLI's behavior, the devices service, the watch protocol or the devices pipe. The app talks to the CLI
  only. (A CLI test may pin install-script lines the app reads.)
- A Linux `.deb`/`.rpm`, a Windows MSI, a Microsoft Store or Flathub package.
- Terminal-tab follow outside macOS (see named differences).
- A permanent new workflow (the existing PR CI job gains a Windows leg; see CI).

## Anti-goals (a failure even if it works)

- A second login entry on Linux beside the CLI's `harnessd.desktop` (coordination below).
- A console window flashing on Windows when the app runs the CLI.
- A menu, copy or state that differs from macOS without a named reason.
- Anything from the webview, the manifest or an OS window title reaching a command line or the log.
- Polling where the OS can push (front app, theme).

## Constraints

- The device-app rules in `device-app/AGENTS.md` stay true on every OS: thin over the CLI, fixed arguments, the app in
  front private (watch stdin only, never logged), one plugin (`tauri-plugin-updater`), one redacted log,
  `HARNESS_DEVICE_CLI` read by debug builds only. A new command the app runs is fixed text in Rust and is added to the
  "Fixed arguments" list in that file.
- Rust only in the app (repo AGENTS.md exception for `device-app/`). OS calls through `windows-sys` (already in Tauri's
  tree) on Windows and std/`libc` on Linux; no new plugin.
- Coordinate with `feat/dial-linux` (XDG autostart) and `feat/dial-windows` (devices pipe); rebase on whichever merges
  first.
- Test machines: GitHub `windows-latest`/`ubuntu-*` runners, the UTM Win11 ARM VM (`ssh admin@192.168.64.5`), Docker
  containers. No Linux desktop machine: what only a person with one can check goes to harness-pm. Never Ken's real
  apps, never production backends.

## What changes, by area

### 1. Child processes on Windows (`cli.rs`, `install.rs`, `watch.rs`, `runner.rs`, …)

Today every child runs in its own process group (`process_group(0)`, `cli.rs:175`, `:292`), is killed as a group
(`kill_group`, `:456`), is reaped with unix waits (`exited`, `:447`), and the watch's stdin is set `O_NONBLOCK` so a
stalled watch never blocks the thread that tells the app in front (`:298-305`). On Windows:

- Every child starts with `CREATE_NO_WINDOW` (no console flash) and inside a Job Object of its own with
  `JOB_OBJECT_LIMIT_BREAKAWAY_OK` and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; "kill the group" terminates that job, so the
  CLI's Node, curl, PowerShell and anything else the run started die with it, as `killpg` does on unix.
- **The daemon is never in that job.** On unix `setsid` takes it out of the group; on Windows `harness start` (also as
  run by `harness login` and by install.ps1's restart) starts the master through `harness-launch.exe`
  (`cli/src/lib/platformDaemon.ts:215`), which asks for `CREATE_BREAKAWAY_FROM_JOB` (`pty/src/launcher.rs:124-133`),
  and `BREAKAWAY_OK` lets it leave. So Quit, an update, a crash or a deadline kill of the app never takes the daemon, its
  terminal host or an agent (`main.rs:208`, "the daemon is left running", holds on Windows). An end-to-end check proves
  it on the VM.
- **Cancelling a sign-in** (`account.rs`) closes `harness login --json`'s stdin, on every OS: the CLI reads that as the
  app having gone, hands its code back and exits. Its group (its job on Windows) is killed only if it has not ended
  within the grace; no SIGTERM and no job kill come first. Windows has no SIGTERM, and a console control event cannot
  reach a child with no console of the app's, so one way serves every OS. The plan checks the CLI's spawn lock recovers
  from a holder that died (pid check); if it does not, that is a stop question, not a CLI change made here.
- The non-blocking stdin becomes a bounded writer: a writer thread per child with a small bounded queue; a full queue
  answers `Unwritten::Full` exactly as `O_NONBLOCK`'s `EAGAIN` does now, so `watch: not reading` and the drop rule are
  unchanged.
- The unix code stays as it is; the platform split sits behind the existing functions (`run_until`, `Child::start`,
  `Killer`, `exited`), so callers and their tests do not change. The `#[cfg(unix)]` tests keep running on unix; each
  rule whose behavior must hold on Windows (deadline kill of a tree, stdin full, exit code, lines in order) gets a test
  that also runs on Windows.
- `spawn_lock` stays (Windows inherits handles the same way when another thread spawns between pipe creation and
  marking them non-inheritable).

### 2. Finding the CLI on Windows (`cli.rs`, `harness_home.rs`)

Windows' layout differs: `%USERPROFILE%\.harness\runtime\current-node` names `node.exe`, and the CLI is
`cli\current` → `cli\<version>\cli.js` (`cli/scripts/install.ps1:351-409`; Desktop's reader is
`desktop/lib/core/windows_layout.dart`). Order on Windows: the managed runtime with its `cli.js` (accepting exactly the
installs `harness.exe` accepts), then `%USERPROFILE%\.harness\bin\harness.exe`, then a `harness.exe` on PATH's absolute
folders. `child_env` joins PATH with `;` on Windows (today it always uses `:`) and puts `.harness\bin` first. No
`LC_ALL` on Windows.

### 3. Installing the CLI (`install.rs`)

- **Linux:** the same two lines as macOS (`install.sh --host`, then `--desktop`), the same deadlines, step lines and
  screens. Today `system_shell()` is macOS-only and the runner answers `Not supported here.`; that answer goes away on
  Linux. On a fresh Ubuntu `--host` reaches `sudo apt-get` for tmux and a clipboard helper (`install.sh:369-376`,
  `:506-518`), which needs a terminal for the password. As Desktop does (`environment_provisioner.dart:479-493`, `:954`),
  the app runs the `--host` line in a visible terminal, chosen in Desktop's order, with fixed arguments; the Install
  screen shows one short step line while the terminal runs (copy in the design doc's style, e.g. `Finish in the
  terminal…`), and the run's end is read the way Desktop reads it. A terminal that never runs the script within 30 s
  fails with `The terminal did not open.`; with no terminal at all the line runs behind the screen, as on macOS, and
  where it needs a password install.sh's own lines say what to run. Then `--desktop` runs in the background as on macOS.
  Named difference (harness-pm, 2026-11-19). The terminal command joins the "Fixed arguments" list.
- **Windows:** one line, the Desktop app's Windows command word for word (`windowsInstallCommand` in
  `desktop/lib/bootstrap/environment_provisioner.dart:95-119`: Windows PowerShell by its full path, `install.ps1
  -Desktop`), fixed in Rust. There is no `--host` half on Windows (install.ps1 installs the terminal host itself).
  install.ps1 prints no `▸`/`✓`/`✗`: its step lines are `Downloading Node …`, `Downloading Harness …`,
  `Downloading the terminal host …`, `OK …` and `Harness could not be installed. The step that failed: …`
  (`install.ps1:363,379,396,409,425,451,710`). On Windows those beginnings are the step lines the log keeps (same caps,
  redaction and cut) and map to the same copy (`Getting ready…` until the first, then `Downloading Harness…`; there is
  no tmux step). `cli/src/scripts/installPs1.spec.ts` gains a test pinning those beginnings, as `install.spec.ts` pins
  macOS's (a test only: install.ps1 does not change).
- `NOT_SUPPORTED` is deleted once no OS answers it (the app is not built for any other OS).

### 4. Starting at login (`loginitem.rs`)

- **Windows:** a `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `Harness Device` = the quoted path of the
  installed exe. The same rule as `register_from`, at every launch: written only when absent,
  so a value an uninstall, a manual upgrade or a hand removed comes back; when Windows' Startup Apps has it turned off
  (`...\Explorer\StartupApproved\Run` value whose first byte is odd: `03` and `07` off, `02` and `06` on), it reads
  as `RequiresApproval` and is never turned back on. Tauri's NSIS uninstaller removes the value (it is named after the
  product), on a real uninstall only, not on an update. A failure reads `Login item not set (…).`, as on every OS.
- **Linux:** one entry only, shared with the CLI. `feat/dial-linux` makes `install.sh` write
  `<config>/autostart/harnessd.desktop` (`Exec=<launcher> start`, `NoDisplay=true`, `X-GNOME-Autostart-enabled=true`,
  name `Harness`; `<config>` is `$XDG_CONFIG_HOME` when absolute, else `~/.config`; atomic write; a file with
  `Hidden=true` is left as it is). The Device app uses that **same file**:
  - absent, on the app's first registration (`saved.login_item` false, the macOS once-only rule, `app.rs:130-131`,
    `:278-281`) → the app writes it, in the same format, with `Exec=` starting the app's AppImage and, when that file
    is gone, falling back to `<launcher> start` (one fixed `sh -c` line whose only variable parts are the two absolute
    paths, each in single quotes inside the `sh -c` text: systemd's autostart generator (252 and later) escapes `$`,
    so the line holds no `\`, `$`, backtick or inner `"`; a path holding `'`, `"`, `$`, a backtick, a backslash or a
    control character gets no entry). Absent later (the person deleted it, as KDE does to turn it off) →
    left absent;
  - present, without `Hidden=true`, with an `Exec=` that is not the app's own → the app sets its own `Exec=`, at every
    launch (taking over an entry that is already on turns nothing on; the app then keeps
    the daemon alive at login with `start --if-down`, as on macOS);
  - `Hidden=true` → left alone (the person turned it off), as `RequiresApproval` on macOS.
  `feat/dial-linux` adds the matching rule to `install.sh` (harness-pm, 2026-11-19): it writes the entry only when it is
  missing or its `Exec=` is install.sh's own `<launcher> start` line; a foreign `Exec=` (the Device app's) or
  `Hidden=true` stays. Neither side ever writes a second file. Only an AppImage run (the `APPIMAGE` variable names an
  absolute file) registers; a developer `cargo run` does not. The format and file name are copied from dial-linux's
  spec; whichever branch merges second checks `cli/scripts/install.sh` on `main` when rebasing.

### 5. Self-update (`update.rs`)

`enabled()` becomes true for a stamped release build on macOS, Windows and Linux (the AppImage only: `APPIMAGE` set).
Same cadence (first tick, then every minute, as the CLI), same backoff, same log lines, same `Updating Harness…` row,
same "never while the CLI installs or a sign-in runs" and "relaunch waits while the window is open, `harness start`
runs, …". Per OS:

- **Windows:** Tauri's updater downloads the NSIS installer, checks its minisign signature and the signed version, and
  runs it per user in passive mode; the installer restarts the app. The plugin exits the app the moment it starts the
  installer (`tauri-plugin-updater` 2.x `updater.rs`, `std::process::exit(0)`), so on Windows the **install itself**
  waits for the conditions macOS's relaunch waits for (window closed, no `harness start`, no CLI install, no sign-in;
  `app.rs`); the download and signature check happen as soon as found (named difference: the
  `Updating Harness…` row shows from the install's start, as on macOS, only later). `replaceable()` checks the install
  folder (`%LOCALAPPDATA%\Harness Device`, Tauri's per-user default for the product name) is writable; when it is not
  (an admin-installed copy), `update: skipped not-writable` and the `Update X.Y.Z…` row, as on macOS.
- **Linux:** the updater replaces the AppImage file in place; `replaceable()` checks the AppImage and its folder are
  writable. Not an AppImage run → no updates (like a local macOS build).
- `bundle_of`/`writable` (unix `access(2)`) get Windows counterparts; the `.app` bundle logic stays macOS-only.

### 6. The app in front (`front.rs`, `front_x11.rs`, new sources)

Each source pushes; none polls. The value is the executable's file name, the same `{"front":"…"}` line on the watch's
stdin (`front_line`, `FrontFeed`), never logged. The CLI already maps exe names (`cli/src/cable/hosts/frontApp.ts`:
`code`, `cursor`, `windowsterminal`, `wezterm-gui`, `kitty`, `ghostty`, `harness`, case-folded, `.exe` dropped).

- **Windows** (`front_windows.rs`): `SetWinEventHook(EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT)`, and a second hook
  for `EVENT_SYSTEM_SWITCHEND` to `EVENT_SYSTEM_MINIMIZEEND` (Alt+Tab's end, a restore), on a thread with its own
  message loop. Every event reads `GetForegroundWindow()`, not the window the event names; window → pid
  (`GetWindowThreadProcessId`) → `QueryFullProcessImageNameW` → file name. The current front window once at start. Works
  over the devices pipe through `harness hardware watch`, which `feat/dial-windows` makes work on Windows; the app does
  not depend on the pipe's internals (dial-windows' spec, "The devices pipe's API").
- **Linux X11:** unchanged (`front_x11.rs`).
- **Linux sway** (new): the i3/sway IPC socket (`$SWAYSOCK`), subscribe to `["window","workspace"]`, take `focus`
  events' container `pid` → `/proc/<pid>/exe` file name (the `exe_name` rule `front_x11.rs` already has). The initial
  value from `get_tree`'s focused node, and `get_tree` again on a window's `close` or `move` and a workspace's `focus`,
  which sway tells in no focus event: an empty workspace in front tells "". Spoken directly on the Unix socket (no
  `swaymsg` child: one fixed protocol, no new program on the command-line list).
- **Linux Hyprland** (new): `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock` events,
  `activewindowv2>>` with a window address it did not ask about last → ask `.socket.sock` `j/activewindow` for its `pid`
  → `/proc/<pid>/exe` file name. Initial value from `j/activewindow`; a first ask that fails tells "" and following goes
  on.
- Choice of source at start: X11 session (the existing `session_is_x11`), else `SWAYSOCK` set, else
  `HYPRLAND_INSTANCE_SIGNATURE` set, else none. Each stops with one fixed log line (`front: <source> not followed` /
  `ended`), never the socket path or the error's text, like `Stop` in `front_x11.rs`; for Hyprland `not followed` means
  its event socket could not be reached.

### 7. Tray, icons, window, About, single instance (`main.rs`, `tauri.conf.json`, `icons/`)

- **Icons:** every OS uses the current artwork from main (#4443, the Pixel H): `icon.png` on the Harness green tile,
  and `tray.png`, one 36×36 template image (black, alpha only). macOS keeps the template. Windows and Linux do not tint
  a template image, so they draw the same Pixel H in the colour that reads on the bar (named difference):
  - `tray.png` itself (black) on a light bar;
  - `tray-light.png`, the same alpha in white, on a dark bar. Windows picks by `HKCU\...\Themes\Personalize\SystemUsesLightTheme` and
  follows changes pushed by `RegNotifyChangeKeyValue` (no poll); when the key cannot be followed, the log has
  `tray: theme not followed` and the icon stays the dark taskbar's. Linux uses the light glyph (named difference). The
  bundle gets `icon.ico` (Windows) and the PNG sizes Linux needs, generated from the existing `icon.png`.
- **Linux tray clicks:** Tauri emits no tray click on Linux; the AppIndicator menu opens on click by itself. The
  refresh a click triggers on macOS (`Event::MenuOpened`: re-read sign-in at most every 60 s,
  Desktop installed) runs from the 5 s tick on Linux instead, behind the same throttles (named difference).
- **Window:** the same 420×320 webview and three screens. No taskbar button on Windows/Linux (`skip_taskbar`), as macOS
  shows no Dock icon; it raises and takes focus the same way.
- **About:** macOS's panel shows name, version and the credits line; on Windows and Linux the same three through
  Tauri's native About (muda's About dialog), raised in front. Today `show_about` is a no-op off macOS.
- **One instance:** macOS's LaunchServices runs one copy of a bundle; Windows and Linux do not. A second launch finds
  the first through a lock in the app's data folder (`LockFileEx` / `flock`) and exits with one log line; no second
  tray, no second watch.
- **Desktop app installed** (`desktop.rs`, the `Open Harness` row): Windows looks for the Desktop app's per-user
  install, `Harness\Harness.exe` in the shell's user programs folder (`FOLDERID_UserProgramFiles`, as Desktop's
  installer resolves it), else in `%LOCALAPPDATA%\Programs`, and opens it by that exe;
  Linux reads the Desktop launcher entry `<data>/applications/harness.desktop` that Desktop and its installer write
  (`desktop/lib/core/linux_app_image.dart`) and counts it installed when its AppImage is on disk, opened by running that
  AppImage. Running detection (`sysinfo`, `process_names`) is unchanged.
- **Export logs reveal** (`logs.rs`): Windows `explorer.exe /select,<zip>` (selected, as Finder's `-R`); Linux keeps
  `xdg-open <folder>`. The CLI already bundles the app's log from `%LOCALAPPDATA%` and the XDG data folder
  (`cli/src/lib/logBundleFacts.ts:118-126`).
- **Opening a URL** (the `Update X.Y.Z…` page, sign-in browser is the CLI's): Windows through the shell
  (`ShellExecuteW` "open" on the fixed https URL), Linux `xdg-open`.

### 8. Packaging and release (`tauri.conf.json`, `scripts/`, `release-device.yml`, `RELEASE.md`)

- **Windows:** NSIS, `installMode: currentUser`, WebView2 via the download bootstrapper (Windows 11 has it; on Windows 10 the installer fetches it), one
  installer per arch (`Harness-Device-windows-x64-setup.exe`, `…-arm64-setup.exe`) and its `.sig`. Built on
  `windows-latest`; arm64 cross-compiled there (`aarch64-pc-windows-msvc`). **Names:** Desktop already owns
  `%LOCALAPPDATA%\Programs\Harness`, the Start Menu `Harness.lnk` and the `Harness` uninstall entry
  (`desktop/scripts/windows-e2e/install-state.ps1:8,16,18`), so on Windows the folder, Start Menu shortcut, Apps-list
  entry and Run value are all `Harness Device` (named difference; the tray tooltip and window title stay `Harness`).
  Signing reuses `.github/actions/windows-signing` (OIDC, no secret), always: there is no unsigned Windows build of the
  Device app, since Smart App Control blocks unsigned programs. The app exe is signed before NSIS packs it, the
  installer after, and the updater's minisign signature is made **after** Authenticode signing (`cargo tauri signer
  sign`), so it covers the shipped bytes. Whether the Azure federated credential accepts a run of
  `release-device.yml` (it may be scoped to a workflow, not only the `release` environment) cannot be checked without
  Azure access: it goes to harness-pm for Ken before the first signed release; it does not block this PR.
- **Linux:** AppImage per arch (`Harness-Device-linux-x64.AppImage`, `…-arm64.AppImage`) and its `.sig`, built by
  Tauri's AppImage bundler on `ubuntu-22.04` and `ubuntu-22.04-arm` (oldest glibc Desktop's Linux build uses; the
  builder matches `release-desktop.yml`'s runners). No signing beyond minisign.
- **The same secret discipline as macOS:** compile (build scripts, npm) runs before any secret exists. On macOS the
  bundle step holds `TAURI_SIGNING_PRIVATE_KEY`; on Windows and Linux only a separate `sign-update` step holds it,
  after the bundle, so no bundler or tool it downloads has the key in its environment. On Linux that step shares the
  runner with the bundle, as macOS's steps share theirs, so a tool that leaves something behind for it is not stopped.
  On Windows the signing job runs on a runner of its own, with a Tauri CLI built in a job of its own before any app
  code is checked out, and checked against the sha256 that job gives as its output.
- **Which platforms a release carries:** a temporary `platforms` input on `release-device.yml` and
  `make release-device` (`macos` by default, `all` on Ken's word), so a routine macOS release publishes nothing for
  Windows or Linux and a red Windows/Linux build never blocks it. The pull request of the first Windows/Linux release
  makes `all` the only behavior and removes the input (harness-pm, 2026-11-19). Once Windows/Linux keys are live,
  `publish` refuses `macos`: Tauri's manifest has one version, so keeping them would point their apps at the last
  release's files, signed for another version, and every update would fail its signature check.
- **Manifest** (`device-manifest.py`): a release with `all` carries every platform at one version. `platforms` gains
  `windows-x86_64`, `windows-aarch64`, `linux-x86_64`, `linux-aarch64` (Tauri's keys, each its own file and
  signature). Desktop-style keys beside the macOS ones: `device-windows-x64`, `device-windows-arm64`,
  `device-linux-x64`, `device-linux-arm64`, each `{version, url, sha256, size}`. Publish waits for every build; verify
  downloads each file it names. `test_device_manifest.py` covers the new keys.
- `release-check.sh` gains per-OS checks (Windows: the signature when signing is on, the version in the exe; Linux: the
  AppImage runs `--version`-free checks: its ELF arch and the updater signature's `version:`).
- `RELEASE.md` and `device-app/AGENTS.md` describe Windows and Linux.

### 9. CI

`ci.yml`'s `device-app-checks` gains a `windows-latest` leg running `cargo test --locked --lib` (today Linux only). No
new workflow. The end-to-end checks below that need a long build run in a temporary workflow if the plan needs one.

### 10. Getting the app: the website and Desktop (`website/`, `desktop/lib/devices/`)

Added after the final review (Ken, 2026-11-20): a Windows or Linux person must have a way to get the app, as on
macOS, or the release is a partial ship. The same pull request carries both:

- **Website.** `/device/download-windows` and `/device/download-linux`, made like `/device/download-macos`: the same
  fixed manifest URL, the same allowed prefixes, and a 302 to the manifest's URL for that platform. The arch comes
  from the request when it can be told, and is x64 otherwise. `/device` gets the matching buttons, with 1-2 word copy.
  Until a release carries Windows or Linux, the routes answer as `/device/download-macos` does before its first
  release.
- **Desktop.** On Windows and Linux, Desktop offers and installs Harness Device the way it does on macOS: the same
  trigger (#4426: a dial is plugged in), the same screens and copy. Only these steps change per OS:
  - `device_app_manifest.dart` reads the platform's keys (`device-windows-x64`/`-arm64`, `device-linux-x64`/`-arm64`).
  - `device_app_installer.dart` downloads the file and checks its sha256 and size, then installs it:
    - Windows: runs the NSIS installer silently (`/S`, per user, no admin).
    - Linux: puts the AppImage in place and makes it executable.
  - It then starts the app.
  - Desktop's probe finds an installed and running copy on each OS.

  - On Linux, Desktop writes `~/.local/share/applications/harness-device.desktop` when it installs the app, the
    way it does for itself, and removes it on uninstall. This is the Linux counterpart of Launchpad on macOS and the
    Start Menu entry the NSIS installer makes on Windows.
- **Windows floor:** Windows 10 or 11, Desktop's own floor: nothing the app uses needs Windows 11 (harness-pm, 2026-11-20).
- **Copy (named difference; harness-pm, 2026-11-20):** macOS copy is unchanged. On Windows and Linux:
  - "menu-bar app" reads "tray app";
  - the words about terminal tabs are dropped, because those OSes cannot follow a terminal tab
    ("Follows the app in front.").

  `/device` reads "The app for your Harness device." on every OS.

  The plan names the AppImage's place and the probe's rule. A Flutter test clicks through the flow as a person does.
  The design doc and gallery change only if the UI does.

## Named differences (OS limits)

| Difference | Windows | Linux | Why |
|---|---|---|---|
| Terminal-tab follow (Terminal/iTerm2/Ghostty) | none | none | AppleScript only; Windows Terminal has no list/select API; Ghostty on Linux offers no list/focus |
| App in front | WinEvent hook | X11, sway, Hyprland; **none on GNOME/KDE Wayland** | GNOME and KDE Wayland give no other program the focused window |
| Tray click refresh | as macOS | from the 5 s tick, same throttles | Tauri emits no tray click on Linux (menu only) |
| Tray shown at all | always | needs a StatusNotifier host; **stock GNOME needs the AppIndicator extension** (Ubuntu ships it) | GNOME has no tray of its own; the app logs `tray: no host` once when no watcher has come on the session bus within 30 s of start |
| Tray icon colour | the Pixel H in black on a light taskbar, white on a dark one, following the theme | the Pixel H in white | Windows and Linux do not tint a template image as macOS does; Linux has no common way to read a panel's colour |
| Self-update | NSIS passive install | AppImage only; a dev run does not update | the updater replaces an AppImage, not a distro package |
| Login item | Run key + Startup Apps toggle | the shared `harnessd.desktop` | one entry with the CLI (dial-linux) |
| Install halves | one `install.ps1 -Desktop` run | `--host` in a visible terminal, as Desktop | install.ps1 has no host half; tmux on Linux needs `sudo apt` |
| About | Tauri's About dialog | Tauri's About dialog | macOS's standard panel is AppKit |
| Update install timing | download at once, install waits for the relaunch conditions | as macOS | the updater exits the app when it starts NSIS |
| Installed name | `Harness Device` (folder, Start Menu, Apps list, Run value) | `Harness Device` AppImage | Desktop already owns `Harness` on Windows |

## Testing

- **Menu parity test.** The menu, its copy and every state transition live in `model.rs` and `app.rs`, which take no
  OS input today (`model::menu(state)`, `model.rs:44`); every named difference lives in a door (`main.rs`, a source, a
  login item, the updater). The test holds that line: `model.rs` and `app.rs` contain no `cfg(target_os`, `cfg(windows)`,
  `cfg(unix)` (outside tests) and no `consts::OS`, so a row cannot differ by OS without the test failing; and
  `main.rs`'s Linux tick refresh is shown to feed the same `Event::MenuOpened` macOS's click does. The one difference
  that changes App's timing (Windows' held install) enters as a door property (`install_exits_app`), named in the test.
- Red-then-green unit tests per rule at its layer: Windows child (job kill on deadline, stdin full, CREATE_NO_WINDOW
  flag set), CLI lookup on the Windows layout, PATH join, install line and step table per OS, login item rules
  (Windows Run/StartupApproved; Linux shared entry: absent, present, `Hidden=true`, AppImage gone fallback), update
  `enabled` per OS and `replaceable`, sway and Hyprland event parsing (pure functions over captured event bytes), front
  source choice, single-instance lock, reveal args per OS, manifest keys.
- `cargo test --lib` on Linux and Windows in PR CI.

## Verification (end to end, for the plan to detail)

- **Windows ARM VM** (`admin@192.168.64.5`, a shared device: ask harness-pm for the turn): install the arm64 NSIS build
  per user; the tray shows the right icon for the theme; the menu rows match macOS's for no CLI / installing / daemon
  up / dial absent; Install runs install.ps1 with no console window; the Run value appears once and survives a second
  launch; a second launch exits; Export logs selects the zip in Explorer; the app in front reaches the watch
  (`harness hardware watch` debug line or a fake CLI recording stdin), switching between two apps. No sign-in against
  production: the sign-in screen is checked with a fake CLI.
- **windows-latest runner (x64):** build the x64 installer, install silently, start the app with a fake CLI
  (`HARNESS_DEVICE_CLI`, debug build) and check the watch's stdin gets `{"front":…}` lines when a test window takes the
  foreground.
- **Linux container (x64 and arm64):** build the AppImage; under Xvfb with a minimal StatusNotifier host and a D-Bus
  session, the tray registers; X11 front changes reach a fake CLI's stdin (`xdotool` focuses two windows); headless
  sway (`WLR_BACKENDS=headless`) and a scripted Hyprland-protocol fake socket feed the new sources; the `harnessd.desktop`
  entry is written once and respected with `Hidden=true`; `install.sh --host`/`--desktop` from the app in an Ubuntu
  container reaches `Device ready`-less `Plug in your device` with no dial.
- **Only a person with a Linux desktop** (to harness-pm): Ubuntu GNOME (tray with AppIndicator, rows, About, login at
  next sign-in), Fedora stock GNOME (no tray: the log line), KDE Plasma (tray, front app on X11 and none on Wayland).
- Updater: a local manifest server and a test-signed build 0.0.1 → 0.0.2 on the VM (NSIS) and in the container
  (AppImage); never the production bucket.

## Approaches considered

1. **Port the existing app, platform code behind the existing doors (chosen).** One codebase, one menu model, OS
   specifics in small per-OS files behind traits that already exist (`FrontSource`, `LoginItem`, `AppUpdater`,
   `DesktopApp`, `Shell`). Keeps macOS untouched and the parity test meaningful.
2. **Separate per-OS apps (e.g. a Windows-native tray app).** Fails "same UX": two menus to keep in step, and a second
   language/framework against AGENTS.md.
3. **Fold the tray into Harness Desktop on Windows/Linux.** Desktop already exists there, but the Device app is for
   people who do not use Desktop (device-app/AGENTS.md), and on macOS Desktop installs and opens the Device app
   (`desktop/lib/devices/device_app_setup.dart`) rather than doing its work; folding would make Windows/Linux the one
   place it differs.

## Left to the builder

- Exact Win32 calls and crate features (`windows-sys` features), and how the job handle is shared with `Killer`.
- Whether Hyprland's initial value needs `j/activewindow` or `activewindowv2` alone.
- NSIS template details (shortcut name `Harness`, uninstall entry), icon sizes.
- The exact Desktop install path on Windows, read from Desktop's installer.
- Splitting the work into tasks and the temporary workflow, if any.

## Decisions taken (harness-pm / Ken, 2026-11-19)

- One PR for Windows and Linux; no release.
- macOS behavior and UX are the reference; every difference named; a menu parity test.
- The Device app is the front-app source on Linux too: X11, sway, Hyprland; GNOME/KDE Wayland a named difference.
  (Spoken over the compositors' sockets rather than by running `swaymsg`: same events, no new program on the fixed
  command list. My call.)
- Windows front app by `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`, through `harness hardware watch` (dial-windows).
- The Linux login item is the CLI's single `harnessd.desktop` entry; dial-linux's install.sh keeps a foreign `Exec=`.
- A temporary `platforms` input keeps Windows/Linux out of releases until Ken's word.
- Linux `--host` runs in a visible terminal, as Desktop.
- The download path (website, Desktop offer) is in this pull request (Ken, 2026-11-20; §10).
- Windows: job with breakaway; the update install held until relaunch is allowed; the name `Harness Device`; always
  signed. The Azure credential question goes to Ken before the first release.
- Plan answers: the Linux terminal-step copy as proposed; the `dbus` crate (already in Tauri's tree) for `tray: no host`;
  the real-install-line checks run against the public CDN with a throwaway signed-out daemon; the macOS updater's
  behavior stays exactly the same, proven by a local-manifest check before the merge.

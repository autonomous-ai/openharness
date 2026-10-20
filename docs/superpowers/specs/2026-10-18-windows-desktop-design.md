# Windows native: the desktop app on Windows (sub-project C)

Date: 2026-10-18
Status: draft, for review

## Goal

On a Windows 10/11 PC (x64 or arm64), the Harness desktop app works the way it does on a Mac:

- the PC is "this computer";
- the app installs the Harness CLI itself and keeps the daemon running;
- agents and terminals run on the PC, and the app reaches the owner's other machines as it does now;
- system notifications, a tray icon, `harness://` links, image paste and the font list all work;
- the app updates itself.

Everything is per user, with no administrator rights and no UAC prompt.

Sub-project B (`docs/superpowers/specs/2026-10-16-windows-native-cli-design.md`) made the CLI
installable, supervised, updatable and trusted on Windows. C builds the desktop on top of B.

## Decomposition (unchanged)

| | Sub-project | Depends on |
|---|---|---|
| A | PTY host, terminal backend and Windows process control (done) | — |
| B | CLI on Windows (done; merge pending) | A |
| **C** | Desktop on Windows (this spec) | B |
| D | Code signing; production release of the desktop's Windows artifacts (signed zip, `.exe` installer, winget) | A–C |

C publishes to **staging only**: the CI-built zip, plus a staging manifest entry for the end-to-end run.
Signing and the production release belong to D.

## Current state

- **Forced viewer.** `lib/core/viewer_mode.dart` sets `kViewerMode` on Windows. The app is a remote viewer, like
  the web build. It has no "this computer" row, provisioning, daemon supervision or self-update.
- **Runner.** `desktop/windows/runner` is the stock Flutter template. It has never been built in this repo, and no
  CI job builds it. `desktop/README.md` says Windows is not supported.
- **CLI.**
  - `lib/core/harness_cli_runner.dart` resolves `~/.harness/cli/cli.js`, `~/.local/bin/harness`, then PATH. The
    Windows layout (B) has neither of the first two.
  - `lib/bootstrap/environment_provisioner.dart`:
    - runs `curl … install.sh | /bin/sh`;
    - runs its probes through `zsh` or `bash`;
    - checks `test -w "$HOME"`;
    - requires tmux;
    - has a Windows branch (`_verifyWindows`) that only checks the CLI and says "There is no Windows installer yet".
- **Daemon connection.**
  - `lib/ws/local_daemon_transport.dart` prefers the Unix socket and has none on Windows, so everything goes over
    loopback TCP.
  - Over TCP the daemon refuses the trusted routes, which on Windows need the authenticated pipe (B §2):
    - `POST /api/auth/handoff`, the Add Phone code;
    - the `daemon_*` frames;
    - `product_observe`.
  - `dart:io` cannot open a Windows named pipe.
- **Paths.** Several places read only `HOME`:
  - `agent_prefetch.dart`;
  - `app_state.dart` (`_harnessInstalledBefore`);
  - `new_harness.dart`;
  - `usage_credentials.dart`.

  Some places run `/bin/chmod`.
- **Native.** The macOS runner implements these channels:
  - `harness/notifications`
  - `harness/clipboard_image`
  - `harness/fonts`
  - `harness/community_links`
  - `harness/app_menu`
  - `harness/swarm_tabs`

  It also has the status menu, which is fed from `swarm_screen.dart` (`statusMenuEntries`,
  `statusMenuWorkingEntries`). Linux implements `community_links` and `clipboard_image`, and draws an in-window
  menu bar (`lib/widgets/linux_menu_bar.dart`). Windows has none of them:
  - `platformSystemNotifier` returns `NoSystemNotifier`;
  - `NativeClipboard` returns null;
  - `ForkInbox` swallows the missing plugin;
  - there is no menu.
- **Terminal keys.** xterm gets `TerminalTargetPlatform.macos` on Windows (`terminal_session.dart`).
- **Self-update.** `lib/update/desktop_updater.dart`:
  - knows the macOS `.app` (swapped with `ditto`) and the Linux AppImage;
  - its `currentBundlePath` returns null on Windows;
  - its `_otaKeys` falls through to the macOS keys.
- **Release.** `release-desktop.yml` builds macOS and Linux only.
- **Plugins.** Every plugin supports Windows except `webview_flutter`, which already falls back to showing the URL
  as text. The `sqlite3` FFI needs a `sqlite3.dll` that Windows does not ship, so OpenCode usage reads "unavailable".

## Decisions

1. **Full local desktop, like the Mac.** It is not a viewer-first stage. `kViewerMode` is no longer forced on
   Windows. A viewer build stays a viewer, because the flag comes from the build, not the OS.
2. **Same shape as macOS and Linux.**
   - Dart keeps its existing method channel names and calls them on every OS.
   - The Windows side is C++ in `desktop/windows/runner`, one file per feature, as macOS has Swift and Linux has C.
   - Platform-specific Dart stays inside the existing services: the provisioner, the CLI runner, the updater, the
     notifier and the menu. It is not forked into new screens.
3. **Trusted IPC through a Dart FFI pipe client.** It is written in Dart over `dart:ffi` (kernel32). The runner gets
   no pipe code. It speaks B's protocol unchanged.
4. **Zip, per-user self-install, self-update by version folders.** There is no MSIX, because it needs signing and
   its sandbox virtualises AppData and limits spawning. There is no installer `.exe` in C; D adds a signed one.
   A one-line PowerShell install (§3.7) downloads the same zip.
5. **The app installs the CLI with `install.ps1 -Desktop` from the CDN**, the counterpart of `install.sh --desktop`.
   The app never bundles the CLI.
6. **Builds for x64 and arm64.** Flutter 3.47 builds Windows arm64. If a plugin cannot build for arm64, that is
   recorded, and the x64 zip is served to arm64 PCs, which Windows runs under emulation, until it can.
7. **No change to macOS or Linux behaviour.** Shared Dart changes are behaviour-neutral there, and the macOS and
   Linux runners are not touched. The one shared refactor is the in-window menu bar (§2.7): it moves from
   `linux_menu_bar.dart` to a shared widget, and Linux renders exactly what it renders now.

## 1. "This computer" on Windows

### 1.1 Mode

Windows is no longer in `kViewerMode`'s forced list. It boots like macOS and Linux:
`bootstrapping → preparingEnvironment → unauthenticated → authenticated`.

### 1.2 One home folder

`homeDir()` is a new helper in `lib/core/`:

- it returns `USERPROFILE` on Windows and `HOME` elsewhere;
- if the variable is missing, it falls back to the other one, as `harness_cli_runner.dart` already does.

Every reader of `HOME` uses it (the list in Current state, plus any found while porting). POSIX-only commands get a
Windows counterpart or are skipped:

- `/bin/chmod`: skipped on Windows, because the profile ACL already restricts the files, as in B.
- `test -w`: replaced by a create-and-delete probe.
- `zsh` and `bash` login shells: on Windows, programs are run directly with an explicit environment.

### 1.3 Finding the CLI

On Windows, `HarnessCliRunner.resolve` tries these, in order:

1. `%USERPROFILE%\.harness\runtime\current-node` plus `cli\current`, which names `cli\<ver>\cli.js`. These are the
   same pointers B's launchers read, with the same rule: one line, no BOM, version folder names only.
2. `%USERPROFILE%\.harness\bin\harness.exe`.
3. `harness.exe` on PATH.

The commands the app relies on are unchanged (B's contract): `start`, `stop`, `version`, `auth status --json`,
`login --json`, `link …`. `node.exe` and `harness.exe` are console programs started by a GUI app. No console
window may flash: the first task checks what `Process.start` does on Windows. If a window shows, the runner starts
them through `CreateProcessW` with `CREATE_NO_WINDOW` (FFI, the same isolate helper as §1.6) and hands back the
pipes.

### 1.4 Installing the CLI

`EnvironmentProvisioner` gets a real Windows path:

- **Readiness steps.** The Harness CLI, and the terminal host
  (`%USERPROFILE%\.harness\runtime\pty\<ver>\harness-pty.exe`, the folder `install.ps1` writes). There is no tmux,
  `ps` or clipboard-helper step.
- **Recipe.** Run, hidden, with output to the installer log the setup screen already tails:

  ```
  C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); iex \"& { $(irm '<base>/install.ps1' -ErrorAction Stop) } -Desktop\"; exit $LASTEXITCODE"
  ```

  - This is B's line plus what a hidden run needs:
    - PowerShell by its full path under `SystemRoot`, because a bare `powershell.exe` is looked for in the working
      folder first;
    - UTF-8 output, so install.ps1's sentences about a profile such as `C:\Users\Nguyễn Văn A'` are not garbled;
    - `-ErrorAction Stop`, so a failed download fails instead of running an empty `iex`;
    - `exit $LASTEXITCODE`, because install.ps1 under `iex` sets the code and never exits.
  - `<base>` is the CDN's `harness/cli`, or `harness/staging/cli` when the app is a staging build
    (`--dart-define=HARNESS_STAGING=true`). The URL can be overridden with `--dart-define=HARNESS_INSTALL_PS1_URL=…`
    for tests. Only an `https` address, or `http` to this computer, is accepted.
  - `-Desktop` installs the CLI and the terminal host, and registers no scheduled task. The app supervises the
    daemon itself (§1.5), as on a Mac without `harness service install`.
  - Every step of the recipe installs in-app (no `requiresTerminal`). As on macOS, the app installs straight after
    the probe, with no review screen.
- **Minimum version.** The app reinstalls when the CLI is older than its minimum, as on macOS and Linux. For Windows
  the minimum is `kMinimumWindowsHarnessCliVersion`, the first CLI release with Windows support (B's version).
- **Failure copy.** The "no Windows installer yet" text is replaced. A failed install says which step failed, in
  `install.ps1`'s own sentence, and offers Retry and Copy log.

### 1.5 Keeping the daemon running

`LocalCliDiscovery`'s supervision is unchanged:

- poll `/api/status`;
- run `harness start` in its spawn slot after two quiet ticks.

On Windows, `harness start` goes through `harness-launch.exe` (B), so the daemon leaves the app's job and opens no
window. Quitting the app never stops the daemon. The macOS-only `harness stop`/restart guard
(`app_state.dart`) stays macOS-only.

### 1.6 Connection

Ordinary traffic stays on loopback TCP, as today. The trusted routes go over the pipe:

- REST `POST /api/auth/handoff`;
- the WS frames `daemon_*` and `product_observe`. They ride this computer's window connection, which on Windows dials
  the pipe first. No other WebSocket uses the pipe: a second window connection would count as a second presence.

**The loopback port.** On a PC shared by two people, the first user's daemon holds 18473, and the second user's daemon
binds another port and records it in `daemon-18473.json` (B). macOS and Linux reach their own daemon through the
socket named for 18473, whatever port it bound. Windows has no socket, so the app takes the port from the record, as
the CLI's own clients do. With no record yet, discovery reports the daemon down and asks nothing on 18473.

**The pipe.**

- **Finding the pipe.** Read `daemon-<port>.json` in the daemon's data folder, `%USERPROFILE%\.harness\cli\data`
  or `ADAPTER_DATA_DIR`. It records the pipe's name, which is new on each daemon start. Accept only a name matching
  `\\.\pipe\harness-<32 hex>`. Anything else is not a Harness pipe.
- **Proving.**
  - Read `daemon-token` from the same folder: 64 lowercase hex digits, which decode to the 32-byte token.
  - Each request carries `x-harness-auth: <nonce>.<HMAC-SHA256(token, 0x01‖nonce)>`, where the nonce starts with
    the pipe's id.
  - Accept the answer only if `x-harness-proof` equals `HMAC-SHA256(token, 0x00‖nonce)`.
  - A pipe that cannot prove itself is treated as no pipe, so a squatter on a dead daemon's name learns nothing
    and is told nothing.
  - The token never leaves the process.
- **Client.**
  - `lib/ws/windows_pipe.dart` opens the pipe with `CreateFileW` (`GENERIC_READ | GENERIC_WRITE`, no sharing,
    `OPEN_EXISTING`).
  - It reads and writes with `ReadFile`/`WriteFile` on a background isolate, because blocking calls may not run on
    the UI isolate.
  - It exposes the connection as a byte `Stream`/`StreamSink` pair. `LocalDaemonTransport` uses that pair where it
    uses a Unix `Socket` on macOS: Dio's adapter for REST, and `WebSocket.fromUpgradedSocket` after a hand-written
    HTTP/1.1 upgrade for WS.
  - One pipe connection carries one HTTP exchange or one WebSocket, as the Unix socket does.
- **Fallback.** If the pipe is missing, unproven or broken:
  - the trusted routes report themselves unavailable with a plain sentence (for example, the Add Phone dialog shows
    only its QR, as an older CLI does);
  - TCP keeps everything else working, but a trusted route is never sent there;
  - each new trusted request looks up the pipe again, so a daemon restart does not strand the app.
- **Proof vectors.** Fixed vectors (token, pipe id, nonce, auth, proof) are pinned in a shared fixture. Both
  `desktop/test` and `cli/src/lib/windows/pipeAuth.spec.ts` check them, so the two sides cannot drift.

## 2. Native features on Windows

There is one C++ file per feature in `desktop/windows/runner/`. `flutter_window.cpp` registers each one's
channel. Every handler answers on the platform thread and never blocks it.

1. **Notifications** (`harness/notifications`: `authorize`, `show`, `withdraw`, matching the macOS calls).
   - Shown as Windows toasts through the WinRT `ToastNotificationManager`.
   - An unpackaged app needs an AppUserModelID (AUMID) on a Start Menu shortcut, which the self-install creates
     (§3.3). The AUMID is `Autonomous.Harness`.
   - The toast carries `activationType="protocol"` and `launch="harness://notification/<machineId>/<agentId>"`.
     Clicking it arrives as a deep link (item 3) and opens that agent, as a notification click does on macOS.
     No COM activator is needed.
   - `authorize` reports whether Windows notifications are on for the app.
   - `withdraw` removes a toast by its tag. Windows caps a tag at 64 characters, so Dart sends a short hash of the
     notification id as the tag, and the `launch` link, with `show` and `withdraw`.
2. **Single instance.**
   - `main.cpp` takes a named mutex `Local\Harness-<user SID>`.
   - If the mutex is held, the new process finds the running window, sends its command line (a `harness://` link,
     if any) with `WM_COPYDATA`, brings the window to the front, and exits.
   - The running instance hands the link to Dart (item 3).
   - **Quit.** `WM_HARNESS_QUIT` is the registered window message `Autonomous.Harness.Quit`. The app quits on it as
     the tray's Quit does, hidden or not, on its main window and on its single-instance window. `Harness.exe` posts it
     to the main window of each process that runs from its install (§3.5); `harness-desktop.exe --quit` posts it to
     the single-instance window.
3. **`harness://` links** (`harness/community_links`).
   - The self-install writes `HKCU\Software\Classes\harness`: `URL Protocol`, and
     `shell\open\command = "<install>\Harness.exe" "%1"`, pointing at the stable launcher (§3.2).
   - Every start of the installed `Harness.exe` rewrites the key if it does not match, so a moved install heals
     itself. A copy run from the zip never takes the links.
   - A link that arrives at launch, or through `WM_COPYDATA`, goes to the same channel events that macOS and Linux
     send. The `notification/…` links are handled in Dart beside the community links.
4. **Tray icon** (`harness/status_menu`, a new channel name, used by Windows only).
   - `Shell_NotifyIconW` shows the app's icon. Its menu shows what the macOS status menu shows:
     - the notification rows (`statusMenuEntries`);
     - the working rows (`statusMenuWorkingEntries`);
     - "All caught up", or "Open Harness to get started";
     - Open Harness;
     - Quit.
   - Dart sends those rows where macOS gets them, from `swarm_screen.dart`'s `_native` payload.
   - A chosen row comes back to the existing `_openStatusHarness` handler.
   - Clicking the icon shows the window.
   - **Closing the window hides it to the tray.** Quit in the tray menu, or the app menu's Quit, exits the app. The
     daemon keeps running either way.
5. **Image paste** (`harness/clipboard_image`, the method names macOS and Linux answer).
   - `readImagePng` returns PNG bytes:
     - from the clipboard's registered `PNG` format if present;
     - otherwise from `CF_DIBV5` or `CF_DIB`, encoded to PNG with WIC.
   - `readFilePaths` returns the paths of a `CF_HDROP` (files copied in Explorer), as macOS does with file URLs.
   - `writeImagePng` puts a PNG on the clipboard, for image drag-drop onto a local pane, as on macOS and Linux.
6. **Font list** (`harness/fonts`). Installed font families, via `EnumFontFamiliesExW`, de-duplicated. The
   terminal's font picker reads them as it does on macOS.
   - A fresh Windows terminal uses a real Windows monospaced face matching the standard Windows PowerShell terminal,
     rather than falling through the Linux-only DejaVu Sans Mono default. Its default, Reset action and fallback
     chain keep terminal columns aligned and Vietnamese text readable. An explicitly saved font choice stays in use.
7. **In-window menu bar.**
   - `linux_menu_bar.dart` becomes a shared `in_window_menu_bar.dart`, used on Linux and Windows. Linux output is
     unchanged.
   - `swarm_menu_bus.dart` and `swarm_screen.dart` treat Windows as they treat Linux, so every menu-only command is
     reachable.
   - The `harness/app_menu` and `harness/swarm_tabs` channels stay macOS-only. On Windows the tabs are Flutter's,
     as on Linux.
8. **Keys.**
   - xterm gets `TerminalTargetPlatform.windows`.
   - App shortcuts on Windows use Ctrl, and take Ctrl+Shift where a plain Ctrl chord belongs to the terminal. This
     follows Linux's rule (`app_shortcuts.dart`): a chord a terminal program answers is never taken. On Windows
     readline, PSReadLine and the engines answer every plain Ctrl+letter, so every letter command takes Ctrl+Shift, as
     Windows Terminal's own commands do. Plain Ctrl is left only for the tab digits and Settings' comma. A browser on
     Windows keeps the web build's keys.
   - The terminal keeps Ctrl-C, Ctrl-D, Ctrl-Z, Ctrl-R, Ctrl-W, Ctrl-U, Ctrl-L and Ctrl-A. Copy and paste are
     Ctrl+Shift+C and Ctrl+Shift+V, as in Windows Terminal.
9. **Window chrome.** The native caption bar, through `window_manager`, as today. No custom title bar.

## 3. Install and self-update

### 3.1 Names

- The app's executable is `harness-desktop.exe`, set by `BINARY_NAME` in `desktop/windows/CMakeLists.txt`. The CLI
  already owns `harness.exe`, and Windows matches names case-insensitively.
- Its version resource says **Harness**: `FileDescription`, `ProductName`, and the AUMID's display name. Task
  Manager, the taskbar, toasts and Settings ▸ Apps therefore show "Harness", following the Naming System.
- The launcher is `Harness.exe`. In the `pty/` workspace it is the bin `harness-desktop-launcher`, renamed to
  `Harness.exe` when the zip is packaged: a bin named `Harness` and B's `harness` would be the same file in `target\`
  on a case-insensitive file system.

### 3.2 Layout

```
%LOCALAPPDATA%\Programs\Harness\
  Harness.exe            stable launcher (Rust, GUI subsystem; pty/ workspace)
  Harness.ico            the icon of the shortcut and of the uninstall entry
  current                one line: the version folder in use (no BOM)
  previous               one line: the version to fall back to, if any
  app\<ver>\             the Flutter bundle: harness-desktop.exe, its DLLs, data\
  launch.log             the launcher's last lines
  launch-state.json      the launcher's record of the last two starts, for rollback
```

`Harness.exe`:

- reads `current` and starts `app\<ver>\harness-desktop.exe` with its own arguments passed through
  (`CreateProcessW`, no shell), then exits;
- takes `--wait-pid <pid>` first: it waits for that process to end before it starts the app. The updater and the
  self-install pass the app they replace, which still holds the single-instance mutex; without the wait, the new start
  would hand its link to the exiting window and end;
- applies B's pointer rules: one segment, no `..`, an existing folder. A leading BOM is dropped on read, as B's readers
  do;
- has these other forms: `--install [--wait-pid <pid>]`, `--uninstall` and `--version`.

The Start Menu shortcut, the `harness://` key and the uninstall entry all name `Harness.exe`. An update never
breaks them, and neither does a shortcut the person pinned to the taskbar. The app sets the same AUMID on its own
process (`SetCurrentProcessExplicitAppUserModelID`), so its windows group under the pinned shortcut.

### 3.3 First install

The zip, `harness-desktop-<ver>-windows-<arch>.zip`, has the install layout's shape: `Harness.exe`, `Harness.ico`,
`current` and `app\<ver>\`. The person extracts it anywhere and runs `Harness.exe`, or `app\<ver>\harness-desktop.exe`.

When the app finds it is not running from `%LOCALAPPDATA%\Programs\Harness\` (the counterpart of
`MoveToApplications.swift`), it runs `<its zip folder>\Harness.exe --install --wait-pid <its pid>` and exits. The launcher owns every
install step, so `cargo test` covers them on Windows:

1. Copy `app\<ver>` to `%LOCALAPPDATA%\Programs\Harness\app\<ver>.staging`, then rename it to `app\<ver>`.
   Copy `Harness.exe` and `Harness.ico`, and write `current`.
2. Create `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Harness.lnk` (the `FOLDERID_Programs` known folder). It
   targets the installed `Harness.exe`, has the icon `Harness.ico`, and carries
   `System.AppUserModel.ID = Autonomous.Harness`.
3. Write the `harness://` key (§2.3).
4. Write `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Harness` with these values:
   - `DisplayName` Harness;
   - `DisplayVersion`;
   - `Publisher` Autonomous;
   - `InstallLocation`;
   - `DisplayIcon`;
   - `UninstallString` `"<install>\Harness.exe" --uninstall`;
   - `NoModify` 1 and `NoRepair` 1.
5. Start the installed `Harness.exe`.

Everything is under HKCU and the profile, with no UAC. If the same version is already installed, running a zip
copy just opens the installed app. If the zip holds an older version than the installed one, the app says so and
opens the installed app. An install over a different version that is running first asks it to quit (§2.2).

### 3.4 Self-update

`DesktopUpdater` gets a Windows branch:

- **Manifest key.** It reads the same `metadata.json` with the keys `desktop-windows-x64` and
  `desktop-windows-arm64`. An arm64 PC takes the newer of `desktop-windows-arm64` and `desktop-windows-x64`; arm64
  wins a tie, and x64 runs under emulation. The architecture is the PC's (`IsWow64Process2`), so an x64 build on an
  arm64 PC moves to arm64 once an arm64 build is published.
- **Staging.** A staging build (`--dart-define=HARNESS_STAGING=true`) reads the staging manifest,
  `harness/staging/desktop/metadata.json`.
- **Download.** The zip is checked for sha256 and size, and only a strictly newer version is taken, as on macOS and
  Linux.
- **Swap.**
  1. Extract the zip's `app\<ver>` to `app\<ver>.staging`, then rename it to `app\<ver>`. Replace `Harness.exe`
     with the zip's own by rename. The launcher is not running, because it exits once it has started the app.
  2. Write `previous` (the running version), then `current`. Each is written to a temp file, flushed, and renamed
     into place.
  3. Start `Harness.exe --wait-pid <this app's pid>` and quit.

  The running folder cannot be deleted while it is in use. The next start removes every `app\*` folder except
  `current` and `previous`, plus any leftover `*.staging`.
- **Rollback.**
  - The app writes the marker (`app\<ver>\.started`) once its first frame is drawn, once per version folder.
  - The launcher records each start in `launch-state.json` (version, time, pid and the process's creation time),
    keeping two, and logs each start in `launch.log`. It exits before the app does, so at the next start it looks at
    whether each recorded process still runs.
  - If the `current` folder is missing its executable, or the last two starts were both `current`'s and both ended
    without the marker, the launcher switches `current` back to `previous` and logs why. A start whose process cannot
    be looked at counts as ended once it is 10 s old.
  - A rollback removes `previous` and the recorded starts, so it cannot bounce back. `current` names a broken folder for
    at most two starts.
- **Off switches.** As today: a development build never updates, and `DESKTOP_UPDATE_METADATA_URL` points at a
  scratch manifest for tests.

### 3.5 Uninstall

Settings ▸ Apps ▸ Harness ▸ Uninstall runs `Harness.exe --uninstall`, which:

1. asks the running app to quit with `WM_HARNESS_QUIT` (§2.2), and ends it if it has not quit within 10 s;
2. removes the shortcut, the `harness://` key and the uninstall key;
3. removes the install folder after the launcher exits, with B's "remove after the process has exited" last step
   (`cmd.exe` waiting on the pid);
4. leaves the CLI, its daemon and agents alone, and ends with one line: "Harness's command line and agents stay
   on this PC. To remove them, run `harness uninstall`."

The app's own state is removed too: every `%USERPROFILE%\.harness\desktop-app*` folder (the app writes
`desktop-app-v2`; `desktop-app` is an older name). The rest of `.harness` belongs to the CLI and stays.

### 3.6 Staging release

The `Windows desktop` workflow's release mode builds both zips with the version stamped, as staging builds
(`--dart-define=HARNESS_STAGING=true`). It uploads them under `harness/staging/desktop/<ver>/` and writes the staging
manifest entries, for the end-to-end run. A dry run, the default, checks the zips and keeps the manifest it would write.
Until the workflow is on `main` it cannot be dispatched, so while the branch has its temporary push trigger, a pushed
commit whose subject is `ci(windows): desktop staging release <ver>` runs the release mode; both go before merge.
Production publishing, signing and the installer `.exe` are D's.

### 3.7 Install by one command

Besides the zip, a person can install the app with one line in PowerShell:

```
irm https://cdn.autonomous.ai/harness/desktop/install.ps1 | iex
```

- It is B's `install.ps1` in its `-App` mode. It is published a second time as `desktop/install.ps1`, with the one
  line that turns that mode on changed.
- It reads the desktop manifest and takes this PC's zip as the updater does (§3.4):
  - an x64 PC takes `desktop-windows-x64`;
  - an arm64 PC takes the newer of the two keys, and arm64 wins a tie.
- It downloads the zip into a temp folder and checks its sha256 and size. It unpacks the zip with Windows' `tar.exe`
  and runs the zip's `Harness.exe --install`, which does §3.3's steps and opens the app. The temp folder is then
  removed.
- PowerShell does not mark the files it downloads as coming from the internet (no `Zone.Identifier`), so Windows shows
  no SmartScreen prompt. A browser's download of the zip does get that prompt until D signs the build.
- It installs the app only. The app installs the CLI on its first start (§1.4).
- C publishes it to staging only (`harness/staging/desktop/install.ps1`). The production copy goes up with the
  production manifest, after the merge.

## 4. Build, CI and testing

### 4.1 Workflow

`.github/workflows/windows-desktop.yml` runs on demand only, following the repo's rule for heavy workflows. It runs
on `windows-latest` (x64) and `windows-11-arm` (arm64):

- `flutter build windows --release`;
- `flutter test` (the whole desktop suite, so the Windows branches run on Windows);
- the runner's C++ build;
- `cargo test` for `Harness.exe`;
- zip packaging;
- upload as an artifact.

It also has a `release` input for §3.6. A test that assumes POSIX fails on Windows and is recorded once in a
baseline file; the job fails on any other failure, and on any failure in the files that test the Windows branches. PR
CI is unchanged: Linux unit checks of the changed components.

### 4.2 Unit tests (Dart, platform injected, as existing tests do)

- `homeDir()`.
- CLI resolution: all three tiers, bad pointers refused, `.exe`.
- The provisioner's Windows plan: the steps, the `install.ps1 -Desktop` command line, the minimum version, the
  failure copy.
- The pipe:
  - the record and token readers;
  - proof generation and answer verification against the shared vectors;
  - fallback to TCP;
  - re-lookup after a restart.
- The updater's Windows branch:
  - key choice on x64 and arm64;
  - staging, the pointer writes, cleanup;
  - rollback decisions, with a fake file system and a fake clock.
- Self-install and uninstall plans: the files and registry values, with fakes.
- The status-menu payload on Windows, and the shared in-window menu bar's Linux output, pinned as it is today.

### 4.3 On real Windows (CI)

- The FFI pipe client against a real daemon pipe:
  - REST, and a WS upgrade;
  - refused without a proof, and with a wrong one;
  - a pipe that answers with a bad proof is not trusted.
- The runner channels:
  - fonts lists at least one family;
  - clipboard round-trips a PNG and a `CF_HDROP`;
  - a `WM_COPYDATA` link reaches Dart;
  - the second instance exits.

  These run through an integration test with `FLUTTER_TEST=1`.
- `Harness.exe`'s pointer and rollback rules, as `cargo test`.

### 4.4 End to end on the Windows 11 ARM64 VM

The run uses a dedicated test user and never touches `C:\work\e2e`. Results go in
`docs/testing/windows-desktop-e2e.md`, scenario by scenario, with evidence:

1. **First install.** Download the staging zip, run it: it installs itself, then installs the CLI. Then sign in.
2. **This computer.**
   - Create an agent and type in its terminal.
   - Get an Add Phone code over the pipe.
   - The Mac shows up as a remote machine.
3. **Native.**
   - A toast appears, and clicking it opens that agent.
   - The tray menu lists working agents.
   - A `harness://` link opens from a browser.
   - Pasting a screenshot attaches it.
   - Closing the window hides it to the tray.
4. **Update.** N to N+1 through the staging manifest (or the B5.13 fake CDN). A broken N+1 rolls back to N.
5. **Uninstall** from Settings ▸ Apps: the CLI and agents are untouched, and so is the daemon.
6. **x64 build on arm64**, under emulation, to check the fallback in Decision 6.
7. **Install by one command** (§3.7), from the staging copy. The app installs and opens with no SmartScreen prompt,
   no installed file is marked as downloaded, and no temp folder is left.

The desktop half on the owner's Mac (the Windows PC seen from the Mac) is checked by a person.

### 4.5 macOS and Linux

- The full desktop suite on macOS, compared test by test to the base. Base has known failures: about 26 on
  2026-09-25.
- The Linux job of PR CI.
- No file under `desktop/macos` or `desktop/linux` changes.

## Out of scope for C

- **For D:**
  - code signing;
  - the installer `.exe`;
  - winget;
  - the production manifest;
  - SmartScreen reputation.
- `webview_flutter` on Windows. The web pane keeps showing the URL as text.
- Shipping `sqlite3.dll`. OpenCode usage reads "unavailable" on Windows.
- Launch at login, which no platform has.
- WSL.
- The `hn` TUI on Windows.

## Known limits

- Unsigned zip and executables: SmartScreen and Defender may warn on the first run of a zip downloaded in a browser,
  until D signs them. The E2E doc records the "More info ▸ Run anyway" step. The one-command install (§3.7) shows no
  such prompt.
- Smart App Control, where it is on (some fresh Windows 11 installs), blocks unsigned programs however they were
  installed, and offers no way to run them. Only D's signing lifts that.
- A toast needs the Start Menu shortcut's AUMID. A copy run straight from the zip, before the self-install, shows
  no toasts.
- A profile path with `%` followed by a digit, `*` or `~` breaks the `harness://` command: the shell substitutes those
  in `shell\open\command` and has no escape. Any other `%` works.
- The daemon's loopback TCP port carries agent commands without the pipe's credential (B, Known limits). C does not
  change that.

## Risks

- **Plugins on arm64.** A plugin with no arm64 build: Decision 6's x64 fallback, recorded in the E2E doc.
- **WinRT toasts from an unpackaged C++ runner.** Mitigation: the AUMID shortcut is created before the first
  toast. `authorize` reports "off" honestly when Windows refuses.
- **The FFI pipe client is new I/O code on a background isolate.** Mitigations:
  - the shared proof vectors;
  - the real-pipe CI tests;
  - TCP as the fallback for everything but the trusted routes.
- **Hiding to the tray changes what X means compared with macOS.** The first hide shows a one-time toast: "Harness
  is still running in the tray."

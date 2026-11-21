# The Claude and ChatGPT apps' sessions, and the ChatGPT follow, on Windows and Linux

Branch: `feat/dial-app-sessions-win-linux`. Components: `cli/` (the devices process only) and `device-app/` (Harness
Device). Platforms: Windows and Linux gain what macOS has; macOS does not change.

## Intent

Three dial features work only on macOS today, all built by another team:

1. **#4485**: every Code session the Claude app holds is on the dial's Claude page, idle ones too, read from the app's
   own store (`claudeAppSource.ts`, `claudeAppStore.ts`).
2. **#4494**: the ChatGPT app's Codex threads are on its page in the app's sidebar order, read from `~/.codex`
   metadata (`codexAppSource.ts`, `codexAppThreads.ts`).
3. **#4508**: the dial follows the thread open in the ChatGPT app. Harness Device reads the title of ChatGPT's focused
   window and writes `{"thread":"<title>"}` to `harness hardware watch`. The devices process matches the title to one
   of the threads in (2) (`threadNamed`).

A person with a dial on Windows or Linux should get the same three behaviours, one pull request.

## Decisions (Ken and the PM, 2026-11-20)

1. macOS's behaviour and UX is the reference. Every difference an OS forces is named, with its reason, in
   [Named OS differences](#named-os-differences).
2. **Base.** The branch starts from `feat/dial-windows` at `e7316662ff` (PR #4513, not merged). It needs that branch's
   Windows devices pipe, its app detection on Windows (the hook's parent chain and `CLAUDE_CODE_ENTRYPOINT`), the
   `open-link` opener and the app's own `codex.exe`.
   - `origin/feat/device-app-win-linux` at `84843fcd49` (Harness Device's Windows and Linux port, not merged) is merged
     in at `41645b59a8`. Feature 3's Device-app part builds on its front sources (`front_windows.rs`, `front_x11.rs`,
     `front_sway.rs`, `front_hyprland.rs`) and its `follow.rs` `NoFollow` stub.
   - When #4513 and that branch are both on `main`, the branch is rebased onto `main` and keeps only its own commits.
     Later review fixes to their `front_*.rs` are picked up then.
3. The stores are read **read only**. No test touches a person's real apps or homes.
4. Whether ChatGPT's window title is the thread's name on Windows and Linux can only be checked with a signed-in app.
   That is a person's check after release, as in #4508. It does not hold the merge.
5. **No explanation screen off macOS**, since there is no permission to ask for. The `Follow ChatGPT` menu item stays
   as a switch, so a person can turn following off. On macOS that item is the way to turn it off: checked, it opens
   System Settings, where the person takes the permission back.

## What is there today (read on this branch, 2026-11-20)

**Gates.** `devices.ts` builds both sources only when `apps.platform === 'darwin'` (`claudeAppSource` ~:818,
`codexAppSource` ~:842). At each attach the ChatGPT one also needs `chatGptInstalled()`: `ChatGPT.app` with bundle id
`com.openai.codex` in `/Applications` or `~/Applications`, read with `plutil`, so macOS only. Unit cases pin "no source
off macOS" (`devices.spec.ts`, `platform: 'linux'`), and the three end-to-end files skip off macOS.

**What already works off macOS** (from dial-windows and the Linux dial work):
- A tap opens `claude://code/continue?session=<local id>` and `codex://threads/<id>`.
  - Windows: `harness-pty open-link`, then a raise (`windowsRaise.ts`).
  - Linux: `xdg-open`, once `xdg-mime` names an app for the scheme (`appLink.ts`).
- The stores' `focus` goes through `opener.open` with a bundle, which works on both. Only the `darwin` gate stops it.
- Folder watches are never recursive (`folderWatch.ts`). Paths are built with `join` and `sep`.
- The listener: on Windows it is a named pipe (`devices/listenerPipe.ts`). `harness hardware watch` reaches the
  `thread` handler there, and `threadReported` / `followThread` have no platform gate.
- `frontApp.ts` maps a front report to an app: `chatgpt` → codex and `claude-desktop` → claude on Linux,
  `chatgpt.exe` → codex and `claude.exe` → claude on Windows.
- The hook names the apps on Windows: `ChatGPT.exe` under `\WindowsApps\OpenAI.Codex_` in the parent chain gives
  `com.openai.codex`, and `CLAUDE_CODE_ENTRYPOINT=claude-desktop` gives `com.anthropic.claudefordesktop`.

**The Claude app** ([install doc](https://claude.com/docs/third-party/claude-desktop/installation.md),
[Linux doc](https://code.claude.com/docs/en/desktop-linux.md)):
- Its store is `join(app.getPath("userData"), "claude-code-sessions", <account>, <org>)` on every OS. This was read
  in the Windows build's `app.asar` 6.6395.0, copied off the VM read only.
- The app moves `userData` only for `CLAUDE_USER_DATA_DIR`, for the third-party (`Claude-3p`) build and for UNC
  relocation. macOS does not follow those either.
- **Windows: two kinds of install.**
  - **MSIX**, the main kind now: package family `Claude_pzs8sxrjxfjjc`. Windows virtualizes a packaged app's writes
    to `%APPDATA%\Claude` into `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\`, and the
    app reads that private copy first. A process outside the package sees only the real `%APPDATA%\Claude`.
  - **Squirrel**, the legacy `.exe`: `%LOCALAPPDATA%\AnthropicClaude\app-<v>\claude.exe`, with `userData` at
    `%APPDATA%\Claude`. The VM's test user has this one (4.29.0, which updated itself to 6.6395.0). Its
    `%APPDATA%\Claude` exists, but holds no `claude-code-sessions` without a sign-in.
  - Both kinds register `claude://`.
- **Linux:** the official beta is a `.deb` (`claude-desktop`, `com.anthropic.Claude.desktop`, which handles
  `x-scheme-handler/claude`). Its `userData` is `~/.config/Claude`. Electron takes `$XDG_CONFIG_HOME`, else
  `~/.config`.

**The ChatGPT app** (on macOS `ChatGPT.app`, bundle `com.openai.codex`):
- **Windows.** The Store package `OpenAI.Codex` (family `OpenAI.Codex_2p2nqsd0c76g0`), program `app\ChatGPT.exe`.
  - It registers `codex://`, and its `codex.exe` runs with no `CODEX_HOME`.
  - Its Codex home is `%USERPROFILE%\.codex`. On the VM that home holds `state_5.sqlite` and
    `.codex-global-state.json`, as on macOS.
  - The beta is another package, `OpenAI.CodexBeta_`.
- **Linux preview.** `.deb` or `.rpm` `chatgpt`, installed under `/usr/lib/chatgpt/`. It runs as `ChatGPT`
  (`codex-launcher` execs it), and `chatgpt.desktop` handles `x-scheme-handler/codex`. Its Codex home is `~/.codex`.
- **The window title.** The app's code (Windows `app.asar` 26.1117) sets `document.title` per route. Its primary
  window does not lock its title, so Electron's native title follows `document.title` on every OS, as the macOS
  `AXTitle` #4508 measured does. Some GitHub issues say the Windows title is a fixed "ChatGPT". That is not verified
  either way (decision 4).

**Harness Device on the merged base** (`front.rs`, each pushes and none polls; a front value is the program's file
name):

| Desktop | Front source | The window's title |
|---|---|---|
| Windows | `SetWinEventHook` `EVENT_SYSTEM_FOREGROUND` (+ minimize), out of context, on its own message-loop thread; the front value is the exe's name (`ChatGPT.exe`) | not read; `GetWindowTextW` is in the enabled `windows-sys` features |
| X11 | `PropertyNotify` of `_NET_ACTIVE_WINDOW` on the root; `_NET_WM_PID` → `/proc/<pid>/exe` | not read; `_NET_WM_NAME` on the active window |
| sway | i3-ipc on `$SWAYSOCK`, `["window","workspace"]` | events and the tree carry `name`; title events are dropped today |
| Hyprland | `.socket2.sock` `activewindowv2`, then `j/activewindow` | the answer carries `title`; repeats for the same address are skipped today |
| GNOME / KDE on Wayland | `NoFront`: none | none |

`follow.rs` gives `MacFollow` on macOS and `NoFollow` elsewhere. `ChatgptFollow::front` turns following on only for the
front value `com.openai.codex`, and `chatgpt_installed` looks only for `ChatGPT.app`.

## Goals

- (1) On Windows and Linux the Claude page lists every Code session the Claude app holds that is not archived, newest
  first, at most 16, idle when it has no process, one row per session. A tap opens it. Limits, fields, names, log lines
  and the `ended` / `resting` rules are as on macOS.
- (2) On Windows and Linux, with the ChatGPT app installed, the ChatGPT page lists the 16 newest Codex threads in the
  sidebar's order (projects, then Recent), and a tap opens one. Fields, limits, the 1 s floor, the failure rules and the
  log lines are as on macOS.
- (3) On Windows, X11, sway and Hyprland, while ChatGPT is in front, a watch runs, the dial is attached and the person
  has not turned it off, Harness Device reports ChatGPT's focused window title. The dial moves to the matching thread
  as on macOS, with the same CLI rules: settle, echo, `no match` and `ambiguous`.

## Non-goals

- Anything on macOS.
- The Claude app's third-party build (`Claude-3p`) and a moved `userData`. macOS reads neither.
- The ChatGPT beta package (`OpenAI.CodexBeta`), which the hook does not name either.
- Following on GNOME or KDE on Wayland (named below).
- Making a rest show a session where Harness Device reports no front app (GNOME/KDE on Wayland): that is the
  device-app-win-linux branch's own named difference.

## Anti-goals

- A write to either app's store, its settings, an accessibility switch, or any global setting. One example is turning
  on AT-SPI / Chromium accessibility for every app.
- A poll. Every new read is pushed by a folder watch or a window event, as on macOS.
- A title, folder, name or id in a log line, a saved file or an event other than the `thread` line.
- Anything in `cli/src/core/`.

## Approaches

1. **Chosen: the same sources and the same follow, with per-OS places and per-desktop doors.**
   - The CLI's two sources lose their `darwin` gate. They get each OS's store root and install check; the readers and
     their rules do not change.
   - Harness Device gets one follow door per desktop the merged base already has a front source for. Each reads the
     native window title, the same string Electron gives macOS's `AXTitle`.
   - Smallest change; the macOS code paths stay as they are.
2. **UI Automation on Windows, AT-SPI on Linux, for the title.** Rejected.
   - UI Automation's window `Name` is that same native title. It needs COM bindings the build does not have:
     `windows-sys` has no `IUIAutomation`.
   - AT-SPI sees Chromium's windows only once accessibility is on for the whole session. Every app then builds its
     tree, which costs every app. That is a write to a global setting, and the same reason #4508 left
     `AXManualAccessibility` unset.
3. **The daemon reads the window title itself** (`harness-pty` on Windows, `xprop` on Linux). Rejected. Harness
   Device already owns the front app on each OS and its push sources. A second reader in the devices process would
   duplicate them, and on Linux it would poll.

## Design

### 1. The Claude app's Code sessions

- **Where.** The source and its reader take a list of store roots in place of one, in this order:

  | OS | Roots |
  |---|---|
  | macOS | `~/Library/Application Support/Claude/claude-code-sessions` (unchanged) |
  | Windows | `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code-sessions`, then `%APPDATA%\Claude\claude-code-sessions` |
  | Linux | `$XDG_CONFIG_HOME/Claude/claude-code-sessions`, else `~/.config/Claude/claude-code-sessions` |

  - `%LOCALAPPDATA%`, `%APPDATA%` and `$XDG_CONFIG_HOME` come from the devices process's own environment where it has
    them, else from the profile's defaults (`<profile>\AppData\Local`, `<profile>\AppData\Roaming`, `~/.config`).
    The builder follows how this branch already finds `%APPDATA%\herdr` and `~/.config/herdr` (`herdrClient.ts`);
    it adds no variable to the daemon's start allowlist.
  - Every root that exists is read. The same session file name (`local_<uuid>`) in two roots is one row, the
    first root's copy: the MSIX app reads its private copy first.
  - The bounds of #4485 (the PM, 2026-11-20):
    - Per folder: 8 orgs an account and 1,024 names an org folder; 1 MiB a file.
    - Across the roots together: 8 account folders in all (the first root's first), 256 parses a read and 16 listed.
    - A session name already taken from an earlier root is neither parsed nor counted as skipped.
- **When.** As on macOS: only while a dial is attached, behind the observed agents' switch, with no install check.
  Each root gets the same non-recursive watch of its nearest folder that exists, and one pass at a time, 250 ms apart.
  A root missing at start is watched from its nearest parent: `%LOCALAPPDATA%\Packages` and `%APPDATA%` on Windows,
  `~/.config` on Linux, never the home folder itself.
- **Opening the files.** macOS opens with `O_NOFOLLOW | O_NONBLOCK` after an `lstat`. Node defines neither flag on
  Windows, so the open there is a plain read-only open after the same `lstat` check. That is a named difference.
- **Tap and rest.** Unchanged: `opener.open(agentId, { bundle: APP_BUNDLES.claude, pane: claudePane(localId) })` and
  the noted adapter's `show`. These are `open-link` on Windows and `xdg-open` on Linux. A rest shows a session only
  while the Claude app is in front, which Harness Device reports on Windows, X11, sway and Hyprland.

### 2. The ChatGPT app's Codex threads

- **Where.** `join(homedir(), '.codex')` on every OS (unchanged code). It is `%USERPROFILE%\.codex` on Windows.
- **Installed**, looked for at each attach, as on macOS:
  - Windows: the Store package `OpenAI.Codex` is registered for this user, through `lib/windows/storePackage.ts`.
    One answer is shared with `codexQueue.ts`'s lookup: found is kept for the process, and not found is asked again
    after 10 minutes. That rule is the builder's to share or mirror. Never a second PowerShell at every attach.
  - Linux: the app's program `/usr/lib/chatgpt/ChatGPT` is a file. The `.deb` and the `.rpm` both install there.
  - The end-to-end seam `HARNESS_APPLICATIONS_DIR`, an absolute folder, gives one seam for where the app is:
    - Linux: it takes `/usr/lib`'s place, as it takes `/Applications`' on macOS.
    - Windows: it takes the Store package's place. When it is set, "installed" is the app's program in that folder
      (the builder picks the layout under it), and PowerShell is not asked.

    The VM's end-to-end run is then the same whichever user runs it, and it does not depend on the test user's real
    ChatGPT install (the main session's call after the builder check).
- **Reading `state_5.sqlite`.** The reader already builds its `file:` URI (`immutable=1` or `mode=ro`) with
  `pathToFileURL`, which gives a valid URI for a Windows path (`C:\…`), so the reader does not change. The Windows
  end-to-end run reads a store under a profile whose name needs escaping, and that run is the proof.
- **Watching.** One `fs.watch` on the Codex home alone, never the home above it, at most one read a second (unchanged).
- **Tap, rest, rank, names**: unchanged (`codex://threads/<id>` through the ChatGPT adapter).

### 3. Following the thread open in the ChatGPT app

**CLI.** No new code. Once the source exists off macOS, `threadNamed` answers a `thread` report on Windows (the pipe)
and Linux (the socket). A unit case per platform and the end-to-end check hold it.

**Harness Device.** `follow::system()` picks a door by OS and desktop, in `front.rs`'s order:

| Desktop | Door |
|---|---|
| macOS | `MacFollow` (unchanged) |
| Windows | `WindowsFollow` |
| an X11 session | `X11Follow` |
| `SWAYSOCK` | `SwayFollow` |
| `HYPRLAND_INSTANCE_SIGNATURE` | `HyprlandFollow` |
| anything else | `NoFollow` |

Each door implements `ChatgptWindow` and `AxTrust`:

- **ChatGPT in front.** `ChatgptFollow::front` also takes the front value off macOS:
  - Windows: `ChatGPT.exe`, matched without case.
  - Linux: `ChatGPT`.

  The observer then checks the window's own process, so that another program by that name is not followed:
  - Windows: its image path is under `\WindowsApps\OpenAI.Codex_`, the hook's `CHATGPT_APP` rule.
  - Linux: `/proc/<pid>/exe` is the installed program.
- **`installed()`.**
  - Windows: the package family `OpenAI.Codex_2p2nqsd0c76g0` is registered for the user (`GetPackagesByPackageFamily`,
    no PowerShell).
  - Linux: `/usr/lib/chatgpt/ChatGPT` is a file.
  - It is read when macOS's is.
- **`trusted()`** is the person's switch off macOS: on by default, saved by Harness Device in its state file.
  `prompt()` and `start()` do nothing, since there is no permission and nothing to hear revoked.
- **`observe(heard)`** starts a push observer only while `ChatgptFollow::observes()` holds. It reports the title once,
  then on each change, and gives `NoObserver` once when it cannot start or its window system ends it. Dropping its box
  stops it. The title rules are macOS's: over 256 UTF-16 units or holding a control character, it is sent as the
  empty title.

  | Door | How the title is heard and read |
  |---|---|
  | Windows | `SetWinEventHook` for `EVENT_SYSTEM_FOREGROUND` and `EVENT_OBJECT_NAMECHANGE`, out of context, for ChatGPT's pid only, on the observer's own message-loop thread. It reads `GetWindowTextW` of the foreground window at a foreground change and at a name change whose `hwnd` is that window and whose `idObject` is `OBJID_WINDOW`. For another process's window, `GetWindowTextW` reads the text Windows keeps and sends the app no message, so it cannot hang on a busy app. That is why it needs none of macOS's 1 s element timeouts. The stop posts `WM_QUIT` to that thread. |
  | X11 | `PropertyChangeMask` on the root (`_NET_ACTIVE_WINDOW`) and on the active window. On a change of `_NET_WM_NAME`, or of `WM_NAME` when the window has no `_NET_WM_NAME`, it reads `_NET_WM_NAME` (UTF-8), else `WM_NAME`. The mask moves with the active window. |
  | sway | i3-ipc `subscribe ["window"]`. On `focus` or `title` for a focused container whose pid is ChatGPT's, the container's `name`. |
  | Hyprland | `.socket2.sock` `activewindowv2` and its title-change event, for the active window's address, then `j/activewindow` for `title` and `pid`. |

  Each door is a file of its own (`follow_windows.rs`, `follow_x11.rs`, `follow_sway.rs`, `follow_hyprland.rs`) with
  its own connection or hook. The base's `front_*.rs` files are another branch's work under review, so they are not
  edited. The only exception is opening a helper's visibility (`pub(crate)`) so that a door can reuse its parsing, and
  that keeps the rebase clean (the main session's call after the builder check).
- **The menu off macOS.**
  - `Follow ChatGPT` is a check item, shown when installed and the dial is attached, as on macOS.
  - Checked means the switch is on. A click flips it and saves it, and following stops or starts at once.
  - The Follow screen is never due, since `prompt` has nothing to ask.
  - `Effect::AskAx` and `OpenAxSettings` stay macOS's.
- **Privacy and logs** as on macOS: the title is never logged, saved or shown. The log lines are the same fixed words
  (`chatgpt: follow on|off|no observer`).

### Seams and docs

- `HARNESS_APPLICATIONS_DIR` on Linux (above). The fixtures' store paths come from one per-OS helper, which the
  end-to-end tests and the benchmarks share with `devices.ts`.
- Docs updated in this pull request:
  - `cli/AGENTS.md`'s devices row, for the two sources and the follow on Windows and Linux, and the places they read.
  - `docs/specs/2026-11-15-device-host-adapter.md`'s rows for the two apps.
  - `device-app/AGENTS.md`'s follow section.
  - `docs/plans/2026-11-19-device-app-win-linux-design.md`'s named-differences row "Follow ChatGPT".
  - `desktop/design/desktop-design-system.md`, for the menu item off macOS, and its gallery if the item is in it.

## Named OS differences

| Where | macOS | Windows | Linux | Why |
|---|---|---|---|---|
| Claude store | one root | two roots, MSIX's private copy first | `~/.config/Claude` (or `$XDG_CONFIG_HOME`) | Electron's `userData` per OS. Windows virtualizes a packaged app's `%APPDATA%` writes into the package's folder. |
| Opening a store file | `O_NOFOLLOW` + `O_NONBLOCK` | plain read-only open after `lstat` | as macOS | Node has neither flag on Windows. A FIFO cannot sit in a Windows folder, and a link swapped in after the `lstat` is followed, in the person's own profile. |
| An app's save while the store is read | never blocked | a rename over a file the reader holds open fails with `EPERM` while the read lasts | as macOS | Windows' rename (`MoveFileExW`) refuses a target another process has open, even one opened with `FILE_SHARE_DELETE`, the only sharing Node can ask for. Measured on the VM (Windows 11 ARM64, build 26200): with a reader reading as fast as it could for 60 s, 84,257 of 93,700 renames failed; with no reader, 0 of 57,742; with a read every 250 ms (the source's closest passes), 440 of 60,593. Both apps retry such a failure: the Claude app's atomic writes wait 50 and 100 ms (or 100 to 3,200 ms) on `EPERM`, `EACCES` and `EBUSY`. The ChatGPT app's async save of `.codex-global-state.json` retries on Windows, but one synchronous commit path does not. Any reader blocks it the same way, for example Defender or the search indexer. The reader holds a file open for one read (about 1 to 2 ms), once for each change, so nothing more is done (final review, the PM, 2026-11-20). |
| ChatGPT installed | `ChatGPT.app`, bundle id | Store package `OpenAI.Codex` | `/usr/lib/chatgpt/ChatGPT` | Each OS's install place. |
| Follow: permission | Accessibility, asked on the Follow screen; the menu item mirrors it | none: no screen, the item is Harness Device's own switch | as Windows | Only macOS gates reading another app's window title. |
| Follow: the title | `AXTitle` | the native window text (`GetWindowTextW`) | `_NET_WM_NAME` / `WM_NAME` (X11), the container's `name` (sway), `title` (Hyprland) | Each desktop's own window title. Electron gives each the same string. |
| Follow on GNOME / KDE Wayland | — | — | none | Wayland gives a client no other app's focus or title without a compositor extension, and Harness Device has no front app there. AT-SPI is not used (Approach 2). |
| A rest shows a session | the app in front | as macOS | as macOS where a front source runs; never on GNOME/KDE Wayland | It needs the front app (device-app-win-linux's difference). |
| Title is the thread's name | measured (#4508) | not verified | not verified | Needs a signed-in app (decision 4). If the title is fixed, every report is `no match`. |
| A Claude app session's row `host` | `claude`, whether or not its process runs | as macOS | `claude` while idle, `terminal` while its process runs (it is on the Claude page either way) | Linux's hook has no bundle id. It learns the app from the parent chain, which places the row on the Claude page but keeps the hooked copy's host. The cause predates this branch; the store rows make it visible (final review, the main session's call). |
| The first tap on a row opened by link | opens it | opens it | opens it once `xdg-mime` answers. Until then the tap is taken to open, and a failed link falls back as on macOS. | `xdg-mime` is read once per scheme, in the background. The first tap waits for it (Task 20; this was a bug: the tap was dropped). |

## Design (docs/feature-design-rules.md)

1. **Growth:**
   - The CLI stores nothing new; it holds in RAM what macOS holds.
   - Harness Device saves one boolean in its state file, the switch off macOS. It is written only when the person
     clicks.
2. **Concurrency:**
   - One read at a time per source, as on macOS. The SQLite read is read only or immutable.
   - Each follow observer is one thread or connection, started and stopped by `ChatgptFollow`, at most one at a time.
3. **Read cost:**
   - The reads are macOS's. The plan measures one store read on the Windows VM and on Linux with the existing
     benchmarks (`benchmark-claude-app-store.ts`, `benchmark-codex-app-threads.ts`): before none, after the numbers.
   - The follow reads one title per focus or title change of ChatGPT's window, and nothing at all while ChatGPT is not
     in front.
4. **Scale:** as macOS (16 listed; at most 200 threads read, 2,000 still one `LIMIT 200` query). The two Windows Claude
   roots share one set of bounds.
5. **Compatibility:**
   - An app that moves its store gives an empty read; the dial lists sessions with a process as today.
   - An older Harness Device sends no `thread` line, and an older CLI drops one.
6. **Migration and rollback:** none; reverting removes the rows and the follow.
7. **Audience:**
   - The person's own metadata and window title, read under their own login, shown on their own dial.
   - The title crosses one pipe (Harness Device → the watch) and the local listener (the watch → the devices process),
     as on macOS.
8. **Identity:** the daemon's and Harness Device's own user. No other login.
9. **Failure:**
   - A failed or partial read keeps the last good list, as on macOS.
   - An observer that cannot start, or that its window system ends, logs `no observer` once.
   - Nothing throws into the devices process or Harness Device's runner.
10. **Platforms:** Windows (x64 and arm64) and Linux (X11, sway, Hyprland; GNOME/KDE Wayland without the follow).
    macOS unchanged.
11. **Measures:** the existing `listed` / `read` lines (counts, ms) and `chatgpt: follow on|off|no observer`, with no
    content or ids.

## Tests (red first)

- **CLI unit tests.**
  - Each OS's roots, from the environment and from the profile's defaults.
  - Two Windows roots merged by session name, the first root's copy winning.
  - The source built on `win32` and `linux`.
  - The install checks: the Windows package found, not found, and the 10-minute ask again; the Linux program file
    present or missing; the `HARNESS_APPLICATIONS_DIR` seam.
  - `threadNamed` reached through a `thread` report on `win32` and on `linux`.
  - The cases that pinned "no source off macOS" are replaced, not kept.
- **Harness Device (cargo).** Each door's parsing and state, with fixtures, as the front sources' tests do:
  - Windows' name-change filter (wrong pid, wrong `hwnd`, not `OBJID_WINDOW`);
  - X11's mask moving with the active window and the `_NET_WM_NAME` / `WM_NAME` fallback;
  - sway's `title` and `focus` events;
  - Hyprland's events;
  - the switch: default on, flip, saved, and observation stopping at once;
  - the menu off macOS with the switch on and off;
  - the Follow screen never due off macOS;
  - `ChatgptFollow::front` for `ChatGPT.exe` and `ChatGPT`.
- **End to end (CLI).** The three end-to-end files run on Linux too: `deviceClaudeAppSessions`,
  `deviceCodexAppThreads` and `dialChatgptFollow`.
  - The fixture stores are written at the Linux places in the throwaway home.
  - A fake `xdg-mime` names a `.desktop` file for `claude` and `codex`, and the fake `open` records `xdg-open`'s
    `[url]`.
  - The ChatGPT program comes from `HARNESS_APPLICATIONS_DIR`.

## Verification (the plan details each)

- **Linux and Windows runners.** PR CI never runs `cli-e2e.yml`: it runs nightly and by hand. A temporary workflow,
  `tmp-dial-app-sessions-win-linux.yml`, carries the checks instead (the PM, 2026-11-20).
  - It is push-only on this branch, with `permissions: contents: read` and no secrets.
  - It runs the three end-to-end files on one `ubuntu-24.04` runner, and Harness Device's `cargo test --lib` on
    Windows x64 and arm64 runners.
  - It is removed before the merge. Each push while it is in the branch is a heavy run, so the PM is asked first.
- **Phase 3 stays local.** Each task's red and green is on the Mac, or in the Podman machine for Linux-only Rust. The
  `#[cfg(windows)]` glue compiles and runs in phase 4, on the temporary workflow's Windows jobs and on the VM.
- **Architectures.** The new code depends on no architecture.
  - The ARM64 VM carries the Windows end-to-end checks. The Dell x64 PC is offline until Monday.
  - x64 Windows is covered by the unit tests and Harness Device's `cargo test` on a GitHub `windows` runner, when a
    repo workflow runs them there (ask the PM before a heavy run).
- **The pull request.** It opens in phase 4, on `main`, once #4513 and `feat/device-app-win-linux` are both on `main`
  and the branch is rebased. If they are not by then, the PM decides between a draft stacked on them and holding back.
- **Windows VM** (192.168.64.5; ask the PM for the turn):
  - (1) and (2) end to end with fixture stores in a throwaway profile, through `windowsDaemon.ts` as
    `dialWindows.e2e.ts` does: rows listed, and an archive removing a row.
  - The tap, in the console session of dial-windows's test user `hxdialwin` (`schtasks /it /ru hxdialwin`), where the
    Claude app (winget) and the ChatGPT app (Store) are installed and register `claude://` and `codex://`. Ask the PM
    for the VM, and run it only while dial-windows is not using it.
    - The evidence: the app's process starts with the dial's link for the right session or thread (`claude.exe` with
      `claude://code/continue?session=<local id>`, `ChatGPT.exe --single-argument codex://threads/<id>`), and its
      window comes.
    - Nothing in the apps is signed in to or changed. The apps are not signed in, so they cannot show the session
      itself.
    - Only if a handler is missing: the opener's `[device] open · <adapter> · fallback` line and the unit tests that
      pin the link (the PM, 2026-11-20).
  - (3)'s CLI side: a `{"thread":…}` line through `harness hardware watch` moves the fake dial.
  - Harness Device's `WindowsFollow` against a window the test itself creates and retitles, with the ChatGPT check
    pointed at that test process. Its `installed()` answers true for the VM user's real `OpenAI.Codex` registration
    (read only).
  - The store-read benchmarks.
  - The Windows-only unit cases of `claudeAppStore.spec.ts` and `devices.spec.ts`.
  - A writer that saves a store file the way an Electron app does (write a temp file, then rename it over the old
    one), in a loop, against the reader. The question is whether the reader's open handle ever makes the rename fail
    (EPERM or EACCES). libuv opens with `FILE_SHARE_DELETE`, so it should not. If it does, that is named here and
    fixed (final review).
  - The watch's idle cost with the store folder missing: events a minute and the devices process's CPU, with a dial
    attached (final review).
- **Linux, the Podman machine `devcrew-appsessions`:**
  - `X11Follow` under Xvfb against a test window the test retitles.
  - `SwayFollow` under headless sway, if the image allows; otherwise the fixtures alone, with the reason.
  - The benchmarks.
- **A person, after release.** Not a merge gate. They use their own signed-in apps on Windows (MSIX or Squirrel
  Claude, the Store ChatGPT) and Linux, and check four things:
  - the sessions and threads are listed, idle ones too;
  - a tap opens each;
  - opening a ChatGPT thread moves the dial;
  - the switch stops it.

# Dial on Windows: the app that holds the herdr client

Status: approved by the PM (2026-11-26), with the three decisions below. Investigation only so far: no code changed.
Nothing here was run, because the Mac stays quiet for the tier B eval.

## Goal

An agent in a pane of the person's own herdr on Windows is known to be in the desktop app that holds the herdr client
they attached from (Windows Terminal, VS Code, Cursor, Orca, WezTerm, Alacritty). It stays on herdr's page, as every
agent inside a multiplexer does (`select.ts` `pageOf`, Diego 2026-11-23). A tap focuses the herdr pane, then brings
that app's window forward. That is what macOS and Linux already do (eval IH4, I13).

## How macOS and Linux find it today

`cli/src/cable/hosts/herdrOuter.ts` `createHerdrOuter` (the hook's path) and `createHerdrNested` (the open scan's path).
`services/devices.ts` asks it first, through `firstOuter(herdr, firstOuter(tmux, zellij))`.

1. **The server.** `readPtyMaker(caller)` walks the caller's parents (`ps -axo pid=,ppid=,comm=`) and reads each one's
   tty (`ps -o tty= -p`) until a parent sits on another tty. That parent made the caller's terminal. When it is named
   `herdr`, it is the server, and the agent goes on herdr's page (`nest: 'herdr'`, told early through `made`).
2. **The clients.** Every other `herdr` process in the table, at most 16, the newest pids. A process counts as a client
   when it is connected to the server's `…/herdr-client.sock`. macOS reads that with `lsof -a -U -p … -F pdn`, matching
   peer addresses. Linux reads `ss -xn src '*/herdr-client.sock'` and the `/proc/<pid>/fd` socket inodes. herdr before
   0.9.0 has no client socket, so there the server itself is the one candidate.
3. **Their ttys.** One `ps -o pid=,tty=` for the candidates. A candidate with no tty is detached.
4. **Their app.** `scannedApps` walks each candidate's parents to the nearest listed app: macOS reads `.app` bundle
   ids, Linux reads `comm` through `frontAppId`.
5. **Pick one.** Of the candidates, the client whose tty was typed into last wins (`usedLast`, by the tty's atime).
6. **The answer.**
   - `{ app, tty, pid }`: the app is the agent's page. Its tab is the tab whose tty matches (Terminal, iTerm2, Ghostty,
     WezTerm, kitty). VS Code and Cursor tabs are found by `pid` (`vscode.ts` `createVscodeClientAdapter`).
   - `{ pid }`, for a client in a terminal with no page: Linux's raise brings that process's window.
   - `{}`, for a client inside tmux, Zellij or another herdr.
7. **The tap.** `herdr agent focus <pane>` runs first (`herdr.ts`, `tap: 'before'`). Then the app comes forward:
   - macOS: `open -b <APP_BUNDLES[outer.app]>` (`observed.ts placeApp`, `open.ts`);
   - Linux: `linuxRaise` by the client's pid (`open.ts raiseWindow`).

## What Windows does today, and what is missing

`createHerdrOuter` and `createHerdrNested` stop at their first line on Windows: `clientTtyForm('win32')` is
`undefined`, because Windows has no ttys and no `ps`. So:

- **No outer place.** `observed.ts` keeps the hook's hints. On Windows, `notify.mjs lookUpWindowsApp` builds the hint's
  `__CFBundleIdentifier` from the pane's own environment (`VSCODE_GIT_ASKPASS_NODE`, `VSCODE_PID`, `ALACRITTY_LOG`,
  `WEZTERM_PANE`). A herdr pane inherits that environment from the **server**, and the server got it from the **first
  client**. So the agent lands on one of two pages:
  - the page of the app the herdr server was first started from, which is stale once the person attaches from another
    app;
  - herdr's page, when that environment names no app.

  Not yet confirmed: which of those variables herdr 0.9.5 strips on Windows (VM step 3).
- **A tap raises the wrong window, or none.** `herdr agent focus` works: it switches the pane. Then
  `windowsRaise.app(bundle)` runs:
  - with the stale VS Code bundle, it raises VS Code while the person watches in Windows Terminal;
  - with herdr's own bundle (`dev.herdr.app`), nothing: `WINDOWS_APPS` has no row for it, so the raise answers `none`.
- **Windows Terminal is no bundle at all.** `frontAppId('WindowsTerminal.exe')` is `terminal`, the unknown app.
  `WINDOWS_APPS` has no Windows Terminal row, and `windowsRaise` cannot raise by pid: `harness-pty raise --pid` exists
  in `pty/src/cli.rs`, but no TypeScript calls it.
- **No idle agents.** `nesting()` in `devices.ts` is off on Windows (`scanLearnsApps`), so an idle agent the open scan
  finds is never placed. This design leaves that gap as it is.

What Windows does offer, already in the devices process:

- **The process table.** `listProcesses` (`harness-pty ps --json`) gives pid, ppid, exe name, image path and the start
  marker (`w:<FILETIME>`). `parentChain` ends a walk at a reused pid by comparing start markers. Only those columns are
  read, never `args` or `nativeArgv`.
- **The maker.** `windowsPtyOwner` already finds the first parent past shells and launchers, and names it `herdr`
  (#4566). It returns only the host; it needs the pid too.
- **The server's own pid.** On Windows, `herdrClient.ts` already reads herdr's marker file (`<server pid>:<ns>`) and
  checks that pid against the table (`markerHerdr`).
- **The app.** `frontAppId` maps Windows exe names: `Code.exe` → vscode, `Cursor.exe` → cursor, `Orca.exe` → orca,
  `wezterm-gui.exe` → wezterm, `WindowsTerminal.exe` and `alacritty.exe` → terminal.

What Windows does not offer: who is connected to the client pipe. A named pipe's client pid can only be read with a
handle to the server's end (`GetNamedPipeClientProcessId`), which only herdr holds. The alternative is to enumerate
every handle on the system (`NtQuerySystemInformation`) and duplicate herdr's handles: heavy and fragile, and herdr's
API lists no clients (protocol 19). So on Windows a client is found by the **process tree**, not by the socket.

## Design

All in the devices process (`cli/src/cable/hosts/`), one component. Nothing in the core, nothing stored.

### 1. The server: `scannedApp.ts`

`windowsPtyMaker(pid, rows)` returns `{ pid, host }`, the same walk as `windowsPtyOwner`. `windowsPtyOwner` becomes
`windowsPtyMaker(...)?.host`, so there is still one walk. When the maker is `herdr`, that process is the server.

### 2. The Windows client lookup: `herdrOuter.ts`

`createHerdrOuter` gets a win32 branch (`windowsClientOf`). It reads only `pid`, `ppid`, `executable` and `startMarker`
from one `listProcesses` table.

1. **Server.** Run `windowsPtyMaker` on the caller. If the maker is not `herdr`, answer `{}` and log
   `herdr client · outside`, as today.
2. **Default session only.** If herdr's marker names another server pid (`herdrClient.ts`, a new `server()`), answer
   `{ nest: 'herdr' }` and no client. The hook already sends no pane id for a named session, so this is a second guard.
3. **Candidates.** Every `herdr.exe` row that:
   - is not the server;
   - has a start marker, so it belongs to this account (`pty/src/ps.rs` leaves the marker empty on a process it could
     not open);
   - has no `herdr.exe` among its parents. That leaves out a `herdr …` command run inside a pane, and a herdr client
     nested in a herdr pane;
   - started no other herdr server: no `herdr.exe` child, started after it (by start marker), other than our server.
     The start marker matters because a server keeps its first client's pid as its parent after that client exits
     (Part 1, step 5), and a new process may take that pid. That leaves out a client of a named
     session, which spawned its own server.

   At most `HERDR_CLIENTS_A_LOOKUP` (16), the newest by start marker.
4. **Their app.** Walk each candidate's parents with `parentChain` (start markers end a walk at a reused pid). The
   first exe that `frontAppId` maps to a listed app is the candidate's app, and that candidate keeps its own pid. A walk
   whose first terminal is one with no page (`WindowsTerminal.exe`, `alacritty.exe`) keeps that terminal's pid as its
   *window owner*. A walk that reaches neither (`explorer.exe`, a dead parent, a conhost console started by Windows'
   default-terminal handoff) has no window.
5. **Pick one.** Windows has no tty atime, so the newest client by start marker wins: the window the person attached
   from last. On a tie, the higher pid. If any candidate has a listed app, the newest of those wins, as on macOS
   (`shown` before `left`).
6. **The answer.**
   - `{ app, pid: <client pid>, nest: 'herdr' }`. There is no tty, so no tab is selected, except VS Code's and Cursor's
     tab, which `createVscodeClientAdapter` finds from the client's pid (the shell VS Code started is among its parents).
   - `{ pid: <window owner pid>, nest: 'herdr' }`, for Windows Terminal and Alacritty: herdr's page, as macOS and Linux
     do for a terminal with no page.
   - `{ nest: 'herdr' }`, when no candidate has a window.

   The same log lines as today: `[device] herdr client · found | none | not read · processes`.

`createHerdrNested` stays off on Windows (the scan's gap above).

### 3. The raise by pid: `windowsRaise.ts` and `open.ts`

- `windowsRaise.window(pid)` runs `harness-pty raise --pid <pid>` and is counted as `app()` is.
- In `open.ts` on Windows, when the agent's outer place gave a window owner and no app, the tap raises that pid after
  the herdr pane's focus, instead of the hint's bundle. `observed.ts windowOf` tells the open path whether its pid is
  the outer answer's (`outer: true`); otherwise a tap would raise the caller's `claude.exe`, which owns no window.
- With an outer answer on Windows, `observed.ts placeApp` stops taking the hint's (stale) bundle. The bundle becomes
  `APP_BUNDLES[outer.app]` when there is an app, else none.

  On macOS the same stale hint is used today for a client in a no-page terminal. Changing it there would run
  `open -b dev.herdr.app`, so this design leaves macOS unchanged and raises the question below.

### What stays as it is

- The rest (`canShow`): it needs the app in front, which Windows reports only through Harness Device.
- Words: they go over herdr's pipe, as today.
- The core, `notify.mjs` and the Rust helper: unchanged. `raise --pid` already ships.

## The test that fails first

`cli/src/cable/hosts/herdrOuter.spec.ts`, a new `win32` block with a fake table (pid, ppid, exe name, start marker, no
args). The tree is the one Part 1 recorded on Ken's VM (pids as recorded):

```
explorer.exe 5616
├ WindowsTerminal.exe 7588                     (one process for every WT window)
│ ├ OpenConsole.exe 4008                       (the tab's ConPTY)
│ └ powershell.exe 5512                        (the tab's shell)
│   └ herdr.exe 8412  client #1
│     └ herdr.exe 5992  server (marker 5992)
│       ├ OpenConsole.exe 2264                 (herdr's ConPTY)
│       └ powershell.exe 8928                  (the pane)
│         └ powershell.exe 8976  ← caller (stand-in agent), HERDR_PANE_ID
├ Code.exe 5864                                (VS Code's main)
│ └ Code.exe 6400                              (VS Code's pty host)
│   ├ OpenConsole.exe 6936
│   └ powershell.exe 9264
│     └ herdr.exe 9904  client #2 (newer)
└ powershell.exe 5604                          (Win+R, the default-terminal handoff)
  ├ conhost.exe 4168
  └ herdr.exe <n>  client #3 (newest)
```

- **Red:** `createHerdrOuter({ platform: 'win32', … })(hints, 8976)` returns `undefined` today.
- **Green:**
  - it resolves `{ app: 'vscode', pid: 9904, nest: 'herdr' }`: client #2 is in a listed app and beats the newer
    client #3, which has no window;
  - with client #2 gone, it resolves `{ pid: 7588, nest: 'herdr' }`: Windows Terminal, the window owner, beats the
    newer client #3 (Decision 5);
  - with client #1 gone too (8412 dead, the server's `ppid` still 8412), it resolves `{ nest: 'herdr' }`: client #3
    has no window;
  - with 8412 then reused by a newer unrelated process, nothing changes;
  - `made` is told `herdr`.
- **More cases in the same block:**
  - a `herdr.exe` under the server (a pane's `herdr agent …`) is no client;
  - a `herdr.exe` with its own herdr child server (a named session's client) is no client;
  - a parent whose start marker is later than its child's ends the walk (a reused pid);
  - a row with no start marker is left out;
  - the table not read answers `{}` and logs `not read · processes`;
  - a maker that is not herdr answers `{}` and logs `outside`;
  - a marker naming another server answers `{ nest: 'herdr' }`.

Then, each red first:

- `scannedApp.spec.ts`: `windowsPtyMaker` returns the server's pid.
- `windowsRaise.spec.ts`: `window(4242)` runs `raise --pid 4242` and counts its outcome.
- `open.spec.ts`: on win32, a herdr pane with an outer window owner and no app runs `herdr agent focus`, then
  `raise --pid <owner>`, and never `raise --exe` for the hint's bundle.
- `observed.spec.ts`: on win32, an outer answer replaces the hint's `__CFBundleIdentifier` (stale VS Code) as the
  agent's app and bundle.

Every test is a unit test with fakes, so none needs the Mac's eval slot beyond `vitest` on these files. That run still
waits for the PM's go.

## Size and files

Full, not small: about 5 code files, more than 150 lines, and a VM check that has to come first.

- `herdrOuter.ts`
- `scannedApp.ts`
- `windowsRaise.ts`
- `open.ts`
- `observed.ts`
- `herdrClient.ts` (`server()`)
- `services/devices.ts`: the wiring, `listProcesses` for win32
- their specs
- `cli/AGENTS.md`: the devices row says Windows too

The plan is not "hard": one component, no data. Effort `high`.

## Steps for Ken's Windows VM / Dell

Part 1 runs **before the code**, to confirm the tree the test models. Part 2 runs on the PR head.

They use the VM's test user only, with the stand-in agent or a test-account Claude Code, never a person's account.
Record names, pids and parents only, never command lines.

**Part 1: record (herdr 0.9.5, current release)**

1. Open Windows Terminal (a new window from its Start shortcut). Run `herdr`, then in its pane run the agent.
2. In another WT tab, run:
   `Get-CimInstance Win32_Process | ? { $_.Name -match 'herdr|pwsh|powershell|cmd|claude|node|WindowsTerminal|OpenConsole|conhost|Code|explorer' } | select ProcessId,ParentProcessId,Name | sort ProcessId`.
   Send the rows, with each herdr.exe marked server or client (the server pid is the first number in
   `%APPDATA%\herdr\herdr.sock`).
3. In the herdr pane, run `Get-ChildItem env: | ? Name -match '^(VSCODE_|WT_|TERM_PROGRAM|WEZTERM|ALACRITTY)' | select Name`.
   Send names only: this shows which variables herdr keeps from the first client.
4. Open VS Code with an integrated terminal, run `herdr` there (a second client of the same server), and repeat step 2.
5. Close the first WT window's herdr client (detach or close the tab), and repeat step 2: does the server's parent pid
   now point at nothing?
6. From Win+R, run `pwsh` (Windows' default-terminal handoff), run `herdr` there, and repeat step 2. What is that
   shell's parent?
7. Run `harness-pty raise --pid <WindowsTerminal.exe pid>` while another app is in front. Does the WT window come
   forward (`raised`, `refused` or `none`)?

**Part 2: verify (the PR head, the desk from `cli/scripts/windows-dial-e2e`)**

1. Bundle the branch on the Mac (`node scripts/windows-dial-e2e/bundle.mjs <out>`, on the PM's slot) and copy `<out>`
   to the VM.
2. Start the desk on the stand-in dial (`--own-account` on the test user), with herdr 0.9.5 and an agent in a herdr
   pane attached from Windows Terminal.
3. `list`: the agent's row is on herdr's page. The log has `[device] herdr client · found` or `none`, never
   `not read`.
4. Bring another app forward, then `tap <row>`: herdr switches to the agent's pane, WT comes forward, and the log
   counts `[device] raise · window · raised` (or `refused`, the taskbar flash).
5. Attach a second client from VS Code's integrated terminal, and send a prompt from the agent so its hook runs:
   `list` keeps the agent on herdr's page, and the log says `[device] herdr client · found`.
6. `tap <row>`: VS Code comes forward with the integrated terminal that holds herdr.
7. Detach the VS Code client, and send a prompt again: the agent goes back to herdr's page, and a tap raises WT.
8. In a named session (`herdr --session x`), an agent gets no pane row: as before.
9. Send the desk's log lines for steps 3 to 8. They name no pane, pid or path.

## What Part 1 showed (Ken's VM, 2026-11-26)

Windows 11 ARM64, herdr 0.9.5's x64 build under emulation (herdr ships no ARM64 build), WT opened from Start, a
stand-in agent. Names, pids and parents only.

1. **The server is a child of its first client**, as the tree above shows: client #1 8412 → server 5992. The server
   runs its panes through a ConPTY of its own (OpenConsole 2264). A WT tab's ConPTY (OpenConsole 4008) is a child of
   WindowsTerminal 7588, and so is the tab's shell (5512).
2. **The pane's environment** (names only): `HERDR_BIN_PATH`, `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`,
   `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `TERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `WT_PROFILE_ID`. There is no
   `WT_SESSION`, which a plain WT tab has. VS Code's integrated terminal had `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`,
   `VSCODE_A11Y_MODE`, `VSCODE_INJECTION`, `VSCODE_NONCE`, `VSCODE_STABLE`, and no `WT_*`.
3. **A second client from VS Code:** Code 5864 (main) → Code 6400 (pty host) → powershell 9264 → herdr 9904. Same
   server.
4. **The first client closed:** 8412 and its shell ended. The server and the agent kept running, and the server's
   parent is still 8412, a dead pid that Windows may hand to another process. So the lookup walks **up from the
   clients**, never up from the server, and a child counts only if it started after its parent.
5. **The Win+R default-terminal handoff:** powershell 5604's parent is explorer 5616. Its conhost 4168 is its child,
   and its OpenConsole 1948 is a child of svchost (DcomLaunch). WT shows it in a new window of the **same**
   WindowsTerminal 7588. The shell carries no `WT_*`, `TERM_PROGRAM` or `VSCODE_*`. Nothing in the tree or the
   environment links that client to WT, so it has no window here (`{ nest: 'herdr' }`).
6. **`harness-pty raise --pid 7588`**, with Notepad in front, from a background process: `raised`, exit 0, WT in
   front. But the window that came was the WT window used last (the Win+R one). With two windows in one process,
   `--pid` cannot choose the window.

What this changes:

- **The design holds** (walk up from the clients; a client with a window beats a newer one without). The test's tree
  is now the recorded one, and the "no other server" rule now uses start markers.
- **A known gap, in this branch's results:**
  - With several WT windows, a tap brings WT forward but may bring the wrong window.
  - A client started through the Win+R handoff is placed on herdr's page with no window to raise.
- **Decision 3's condition is met** (step 6 shows the gap). `harness-pty raise --console-of <pid>` goes to the PM as
  its own item. It would attach to the client's console and raise the root owner of its console window, the very WT
  window that holds that tab, and would close both gaps.

## Decisions (PM, 2026-11-26)

1. **Several clients at once:** the newest by start marker wins, the window the person attached from last.
2. **The stale bundle on macOS** for a herdr client in a no-page terminal stays out of this branch, as its own item.
3. **Windows' default-terminal handoff:** `harness-pty raise --console-of <pid>` is proposed as its own item, only if
   Part 1 step 6 shows the shell's parent is `explorer.exe`.

4. **No client in a listed app** (Windows Terminal, Alacritty, or no window): the agent's app is `terminal`, the unknown
   app, on herdr's page; never the hint's app, which may be stale.
5. **A client with a window beats a newer one without** (the Win+R console handoff), as a client in an app beats one in
   none on macOS.
6. **A failed `herdr agent focus`** with a window owner known still raises that window, as Linux's fallback does.

Part 1 went to Ken's VM on 2026-11-26. Code starts once its result is in, or earlier where the fake tree in the test
already matches what herdr's source says. Tests run only once the PM frees the Mac.

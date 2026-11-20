# The dial on Windows: roadmap Phases 0–2

Status: spec for one pull request (`feat/dial-windows`), from one plan (`2026-11-19-dial-windows-plan.md`). Its parts
are A (the devices pipe), B (Claude Code, Codex, herdr, Orca, an end-to-end check), C (a tap raises the window) and D
(a hook's caller on Windows, batched in by Ken), run from a single task queue. It builds on an audit of main `6dcb285e7d` (2026-11-19, code and outside docs), whose
findings are under "How it works today". Linux runs in parallel on `feat/dial-linux`.

The work is in the devices process and its listener, the CLI's `device` verbs, the host adapters, the plugins and the
pty host's helpers. The core's process (cli/AGENTS.md "Protect the core", rule 1: everything `core/main.ts` imports)
runs `lib/windows/pipeAuth.ts`, `lib/localSocket.ts` and `lib/daemonRecord.ts`. This work uses `listenLocalSocket`
and `fetchOverPipe` as they are, and writes the devices record with code of its own. The one change to a file the
core loads is the token below, with no change in what the core does. `npm run test:core` runs once.

## Why

On a Mac the dial does everything: agents ring it (`harness device notify`), the Notifications setting, the follow of
the app and the tab in front, the VS Code/Cursor and Orca extensions, the Claude Code plugin and the Codex skill,
herdr, Orca, and a tap that brings the session's app forward. On Windows only the hardware layer works (serial,
flash, firmware push). The first missing piece blocks most of the rest: the devices listener has no path on
Windows (`devices/listenerPath.ts:13`), so nothing local can reach the devices process.

Windows must look and work as on a Mac (docs/windows-rules.md). Diego's side has no Windows machine, so Ken's side
does Windows.

## Decided (harness-pm, 2026-11-19)

1. **One pull request (Ken, 2026-11-19; this replaces three in order).** Part A: the devices listener over a Windows
   named pipe and every client of it. Part B: the Claude Code plugin and dial skill, the Codex skill, the Codex queue,
   herdr, Orca, and a dial end-to-end check on Windows. Part C: a tap raises the session's window. One final review,
   one tester round, one CI run, one merge.
2. **The devices pipe has its own token, `devices-token`.** It is not the daemon's token, because `link` hands it to
   the VS Code/Cursor and Orca extensions, and they must not get the core's rights.
3. **The pipe reuses the daemon's Windows pipe pieces as they are**: `listenLocalSocket(handler, path, { token })`,
   `lib/windows/pipeAuth.ts` (HMAC auth per request, proof per answer, pipe id in the nonce), `fetchOverPipe`, and a
   record of `{pipe, pid}` checked against the process before a dial. No new auth scheme.
4. **Raising a window (part C) follows Windows' documented rules only**: restore the window if minimized, then
   `SetForegroundWindow`. When Windows refuses, it flashes the taskbar button, and the helper reports `refused`. No
   `AttachThreadInput`, no injected input, nothing system-wide (no change to the foreground lock timeout). The success
   rate measured on the VM goes in the pull request's description.
5. **The Windows Device app is a separate item after this one** (see "Not in this pull request"; `feat/device-app-win-linux` builds it).
6. **The Windows raise lives in its own file**, `cable/hosts/windowsRaise.ts`, beside dial-linux's `linuxRaise.ts`,
   with one platform dispatch in `cable/hosts/open.ts`. `devices/orcaHomes.ts` and `cable/hosts/open.ts` are also
   changed by dial-linux. Whoever merges second rebases and keeps both.
7. **Part C ships whatever its measured rate**: the taskbar flash is Windows' standard answer. The rate goes in the
   pull request, and part C never holds the pull request back.
8. **`ensureDaemonToken` / `readDaemonToken` take a file name**, defaulting to `daemon-token`. This is one way to make
   a token, and the core's behavior is unchanged. The pull request carries the `npm run test:core` receipt.
9. **The devices pipe's API (below) is stable.** `feat/device-app-win-linux` builds the Windows Device app, and its
   front-app feed uses this pipe.
10. **macOS is the reference (Ken, 2026-11-19).** Every interaction of the dial on Windows (notify, ring, list,
    speak, tap, swipe, scroll, the dial's copy and states) behaves as on macOS. Each difference Windows forces is named
    with its reason in "Where Windows differs, and why".
11. **Plan answers (harness-pm, 2026-11-19).**
    - A tap on a Harness agent with no window starts Harness Desktop, as `open -b` does on macOS, through Desktop's
      existing Windows launcher.
    - A pick in the dial's app list brings that app forward, through the same dispatch.
    - A refused raise (the flash) shows no copy on the dial. Only `none` reports, as a failed open does on macOS.
    - App links open through a `harness-pty open-link` helper (`ShellExecuteW`), held to the four schemes. `rundll32`
      is not used.
    - Part D's narrow subcommand is added only if the whole-table read adds more than 50 ms (p50) to a hook on the VM.
    - WezTerm, Warp and Alacritty, which have host ids and run on Windows, are raised too, through the same dispatch.
    - The proof that the recorded process is alive: a cheap check (`process.kill(pid, 0)`) on each call, and the full
      process-table proof when the record changes, after a connection error, or at most every 60 s. Every answer
      still carries the HMAC proof.
    - Until a test key for Claude Code and Codex reaches the VM (Ken), the mod, `claude link` and the permission hook
      are built against Claude Code's documented API with unit tests. They are labeled "not yet checked on a real
      Claude Code/Codex", and Ken checks them once on a real one before the merge.
12. **Plan answers (2026-11-20, after the VM probe).**
    - The Dell: the run stops its owner's Harness daemon to free `COM3` and starts it again as before, in the
      owner's console session; then it checks the daemon runs and holds `COM3`. The checks run in that console session
      under the owner's account, with the run's own data folder. No test user is made there.
    - Ken presses and speaks into the real dial, from one short list for one sitting. The run does everything firmware,
      the serial line or a test hook can do. The dial's settings are written only after being read first; they are
      written back exactly and checked.
    - The panel hint (part C, "What tells the apps apart") stays, its answer kept per editor by the hook.
    - Cursor is found on PATH and in its per-user folder only.
    - The VM's console steps need no person: the agent signs the test user in by autologon and removes it after.

## How it works today (the parts this changes)

- **The daemon's Windows pipe** (lib/localSocket.ts, lib/windows/): Node cannot set a pipe's DACL. Each start serves
  `\\.\pipe\harness-<128 random bits>`, records it with the core's pid in `daemon-<port>.json`, and checks every request
  for `x-harness-auth: <nonce>.<HMAC(token, 0x01‖nonce)>`, where the nonce starts with the pipe's id. Each answer
  carries `x-harness-proof: HMAC(token, 0x00‖nonce)`. A client dials only after checking that the recorded process
  is alive (`daemonPipe`, `recordedProcessDead`), and accepts no answer without the proof. A pipe's default DACL lets
  another account open it only for reading, so it cannot send a request. Pipe names can be listed, so after the
  process dies another account could create the same name. The pid check and the proof prevent that.
- **The devices listener** (services/devicesListener.ts): HTTP `POST /` over a 0600 Unix socket, JSON messages with a
  `type`, rate limits per type and connection, NDJSON streams for `tabs`, `dial` and `vscode`. Clients:
  `devices/listenerClient.ts` (`tellDevices`, `askDevices`, `streamDevices`, used by `harness device notify`, the watch
  for `front`/`tab`/`notify`, the tabs stream); `harness device {orca,vscode} link` (deviceClaude/command.ts
  `devicesLink`), which hands the socket path to the Orca plugin (`plugins/harness-device-orca`) and the VS Code
  extension (`plugins/harness-device-vscode`); and `harness device claude link`, which hands the daemon socket and
  the devices socket to the Claude Code mod (`plugins/harness-device/hooks/device.js`).
- **Windows refusals today:** `listenerPath.ts:13`; the extension and plugin (`wire.ts:11`, `loop.ts:65`,
  `dial.ts:258`); the Claude plugin (`claudePlugin.ts:131-133`); `device codex enable` (`command.ts:159,167`); the
  dial skill setup (`dialHomeSetup.ts:407-428`); the plugin setup (`dialPluginSetup.ts:206-207`); VS Code extension
  setup (`vscodeExtensionSetup.ts:78`); the Orca plugin (`orcaPlugin.ts:114`, `orcaHomes.ts:182`); the skill folder
  owner check (`dialSkill.ts:46-84`, a uid of -1 on Windows); the Codex queue (`codexQueue.ts:146,154`); herdr
  list/send (`herdrClient.ts:104-105`, `herdrSource.ts:126-127`); the Orca lookup (`orcaHomes.ts:38,67-69`).

## Part A: the devices listener over a named pipe

**Server.** On Windows, the devices process:
1. ensures `devices-token` in the data folder, with the daemon token's code: `ensureDaemonToken` and
   `readDaemonToken` take the file's name, which defaults to `daemon-token`, so the core's calls and behavior stay the
   same. That means 32 random bytes, published whole by a hard link, refused when it is a link or outside the profile.
2. serves its handlers with `listenLocalSocket(onRequest, newPipePath(), { token })`, with every existing limit
   (connections, rates, deadlines, streams) unchanged.
3. writes `devices.json` (`{pipe, pid}`, owner only, a temp file renamed into place), and removes it when it closes.
   The writer lives in the devices code, not in `lib/daemonRecord.ts`.

The folder privacy check in `openDevicesListener` (uid and mode) is a Unix check. On Windows it is replaced by the
state-folder check the daemon's token uses (`secureStateDirectory` / `requireWindowsStateFile`: inside the profile,
not a link). One devices process runs per data folder (harnessd starts one). A second one would write a record
naming its own pipe, and clients follow the record. On macOS and Linux nothing changes.

**`devicesListenerPath` becomes a target.** On Windows the answer is `{pipe, token}` read from `devices.json` and
`devices-token`, or null when the record is missing, the token is missing or bad, or the recorded pid is proven gone
(the `daemonPipe` check, with the same `HostLiveness`). The record is read at each call, because each start picks a
new pipe. `tellDevices`, `askDevices` and `streamDevices` send over `fetchOverPipe` on Windows, so an answer without
the proof is refused before its body is read. Their signatures and their "false/null, never a throw" contract stay
as they are.

**`link` on Windows.** `harness device {orca,vscode} link` prints
`{ daemon, devicesPipe, devicesToken, devicesReady, devicesRecord }`:
- `daemon`: the daemon's pipe is found (`daemonPipe`) and answers with its proof, because `localSocketRoute` is null on
  Windows;
- `devicesReady`: the record and token read and the pid is alive;
- `devicesRecord`: the absolute path of `devices.json`, whose folder the plugins watch, as they watched the socket's
  folder.

On macOS and Linux the output is unchanged. `link`'s output carries a token, so the plugins never log it or write it
anywhere. `harness device claude link` gets the same devices fields; its
daemon half is part B.

**The VS Code/Cursor extension and the Orca plugin on Windows.** Each one:
- drops its `win32` refusal;
- finds `harness` at `%USERPROFILE%\.harness\bin\harness.exe`, then on PATH, where on Unix it looks in
  `~/.local/bin` first;
- parses the new `link` fields (a pipe that matches `^\\\\\.\\pipe\\harness-[0-9a-f]{32}$`, 64 hex digits of
  token, and an absolute `devicesRecord`, nothing else);
- signs each request with the same auth, and drops an answer whose proof is wrong before reading it;
- watches the folder of `devicesRecord` for `devices.json` where it watched for the socket file.

The auth code is small (HMAC-SHA256 from `node:crypto`, available on VS Code 1.75's Node 16 and in Orca's worker). Each
plugin keeps its own copy, because plugins cannot import `cli/src`. The vectors in `pipeAuth.spec.ts` are shared as a
test fixture, so the three implementations agree byte for byte.

**`harness device notify`, the Notifications setting, `front`/`tab`, the tabs stream** work through the clients above
with no change of their own. On Windows nothing produces `front`/`tab` lines until the Windows Device app (separate
item). The transport for them is in place and tested.

**The devices pipe's API (stable; other clients such as the Windows Device app build on it).**
- **Find it.** In the daemon's data folder, `devices.json` is `{"pipe": "\\\\.\\pipe\\harness-<32 hex>", "pid": <number>}`.
  Dial only a pipe matching `^\\\\\.\\pipe\\harness-[0-9a-f]{32}$`, and only while that pid runs. No record, a
  bad record or a dead pid means no listener.
- **The token.** `devices-token` in the same folder: 64 lowercase hex digits and an optional newline (32 bytes).
- **Each request** is HTTP/1.1 `POST /` on the pipe. It has the header
  `x-harness-auth: <nonce>.<hex HMAC-SHA256(token, 0x01 ‖ nonce)>`, where the nonce is 64 hex digits: the pipe's
  32-hex id, then 128 random bits. Each nonce is used once. The body is a JSON object with a string `type`, the same
  messages and limits as the Unix socket (`services/devicesListener.ts`).
- **Each answer** carries `x-harness-proof: <hex HMAC-SHA256(token, 0x00 ‖ nonce)>`. Drop an answer without the
  right proof before reading its body. A request without valid auth is answered `401` with
  `{"error":"PIPE_AUTH_REQUIRED"}`.
- **Streams** (`tabs`, `dial`, `vscode`) are NDJSON in the answer's body, exactly as on the socket.
- A client from another language implements the same three steps. The shared test vectors (see "Left to the builder")
  pin them. The Device app today feeds `front`/`tab` through `harness hardware watch`, which this pull request makes
  work over the pipe. Using the watch keeps the Device app off the pipe's details.

**Small fixes found on the way** go into this pull request, as AGENTS.md says.

## Part B: Claude Code, Codex, herdr, Orca, and an end-to-end check

**Programs started on Windows.** Every program this work runs on Windows (`claude`, `code`, `cursor`, `codex`,
`orca`) starts without a shell and without a window (`ownProcessGroup()`), from one resolver:
- an `.exe` runs as it is;
- an npm shim goes through `windowsLaunchCommand` / `parseNpmCmdShim` / `windowsEngineArgv`
  (`lib/windows/launch.ts`) to `node.exe <script>` or the package's `.exe`;
- an Electron app's own launcher (`code.cmd`, `cursor.cmd` in the app's `bin` folder) is read for the app's `.exe`
  and its CLI script, and run as that `.exe` with `ELECTRON_RUN_AS_NODE=1` and the script, read again at every start
  (VS Code's script sits under a folder named by its build's commit);
- any other batch file is refused, `orca.cmd` included.

*Corrected 2026-11-20 after the VM probe (plan Task 1): this listed `orca.cmd` as an Electron launcher. It is not: it
passes `%*` to a native `resources\bin\orca.exe` and refuses `orchestration send|reply`, which `cmd.exe` would
reparse. Orca is run as that `orca.exe` (below).*

The real launchers are read on the VM before this code is written.

**VS Code and Cursor lookup on Windows.** `devices/vscodeExtension.ts` `installed()` (`:70-82`) finds `code` and
`cursor` on Windows: on PATH, then the per-user install folder, then, for VS Code alone, its machine install folder
(`%ProgramFiles%\Microsoft VS Code`). It runs them with the resolver above.

*Corrected 2026-11-20 after the VM probe (plan Task 1): this said per-user and machine folders for both. Only per-user
installs of Cursor were seen, so Cursor is found on PATH and in its per-user folder. A machine-wide Cursor path is
added once a real install shows one.*

**Claude Code plugin and dial skill.**
- `claudePlugin.ts` `supports()` takes `win32`, and `claudeRunner` runs `claude` with the resolver above.
- `dialPluginSetup.ts` and `dialHomeSetup.ts` stop skipping Windows.
- `vscodeExtensionSetup.ts:78` and `orcaPlugin.ts:114` / `orcaHomes.ts:182` stop skipping it too, now that the
  extension and plugin work there (part A).
- The plugin's `PermissionRequest` hook must run on Windows under Claude Code's hook runner, with Git Bash and
  without it (Claude Code falls back to PowerShell, `lib/windows/claudeCodeGitBash.ts`). It must never flash a window,
  and it must find `harness` the way the other Windows hooks do.
- `harness device claude asked` posts over `daemonFetch`, which already goes over the daemon's pipe on Windows,
  instead of skipping when there is no Unix socket (`asked.ts:129-130`).

**The Claude Code mod's daemon half on Windows** (`device.js`, the long poll on `/api/hook/inbox`). On a Mac the mod
gets the core's socket, which is trusted by the filesystem. On Windows, `harness device claude link` prints the
daemon's pipe and token in place of `socketPath`, and the mod signs each poll with the pipe auth and checks the
proof. That gives the mod what it has on a Mac (any process of this account can read the token in the profile), and
nothing more.

This path depends on the mod runtime: `$.http.fetch` must take a pipe in `socketPath`, and HMAC must be available
(`crypto.subtle` or `node:crypto`). The plan's first part B task checks this on the VM. If the runtime cannot do it,
the run stops and asks harness-pm (a stop condition). It never falls back to a weaker credential.

**Skill folder ownership on Windows** (`dialSkill.ts` `ownDirectory`, and its callers that pass a uid:
`services/devices.ts:523`, `orcaHomes.ts:114`, `dialHomeSetup.ts`). On Windows, "this account's own folder" is the
rule the profile's state files already use (`lib/secureState.ts`): a real folder, neither a link nor a junction,
whose real path is inside this account's profile (`insideWindowsRoots`). The profile's ACL is the protection. No uid
is read and no PowerShell runs. On Unix the uid check stays.

**Codex.**
- `harness device codex enable` takes `win32` (`command.ts:159,167`).
- The Codex queue (`codexQueue.ts:146`) runs `codex` with the resolver above. Text never meets a shell.
- The ChatGPT app's bundled Codex (`:154`) is macOS-only and stays so.
- On Windows, PATH is the process's own (there is no login shell).

**herdr on Windows** (0.9.5, generally available). It speaks the same NDJSON protocol over a named pipe:
- On Windows herdr writes a marker file at its socket path. Its pipe's name is that path mapped by the
  `interprocess` crate's `GenericNamespaced` (herdr `src/ipc.rs`: `connect_local_stream`, `bind_local_listener`).
- `herdrClient.ts` dials that pipe with the existing line client (`unixSocket.ts` `connectLines`; `net.connect`
  takes a pipe path).
- The owner check on Windows is the marker file's: a real file inside the profile, not a link (the same rule as the
  skill folder).
- `agent.list`, `agent.prompt` and `events.subscribe` then work as on Unix, and focus stays `herdr agent focus`.
- The exact name mapping, and where herdr's default socket path is on Windows, are read from herdr's source and
  confirmed against a real herdr on the VM before the code is written.

**Orca on Windows.**
- `orcaHomes.ts` `orcaBinary` finds Orca's CLI `orca.exe` in `<Orca>\resources\bin\` (on PATH, or the default
  per-user install folder, since Orca's installer does not put `resources\bin` on PATH). The launcher pattern takes
  `\` and `.exe`. This is a Windows branch beside dial-linux's `orca-ide`.
- Every Orca call (`orca.ts` `send`, `switchTo`, `watch-focus`; `orcaHomes.ts`) runs `orca.exe` through the resolver
  above, which runs an `.exe` as it is.

*Corrected 2026-11-20 after the VM probe (plan Task 1): this named `orca.cmd`, which only forwards to `orca.exe`,
refuses message bodies, and is a batch file the resolver refuses.*
- Stopping `watch-focus` uses `lib/windows/terminate.ts` / `treeKill.ts` in place of signals, with
  `ownProcessGroup()` so no window flashes.

**A dial end-to-end check on Windows.**
- A new `cli/e2e/dialWindows.e2e.ts`. On Windows, the dial is the existing stand-in for `harness-serial.exe`
  (`cable/__fixtures__/fakeHarnessSerial.mjs`, set as `HARNESS_SERIAL_BIN`), with an isolated daemon and data folder.
- It covers: `harness device notify` rings the stand-in dial; the Notifications setting answers; a fake VS Code
  extension client links and holds its stream over the pipe; and a request with a wrong token or no proof is refused.
- `windows.yml` runs it on x64 and arm64, from `workflow_dispatch` on the branch (harness-pm grants the lane).
  windows.yml is an existing workflow, so this adds a step to it and no new permanent workflow.
- The UTM VM runs it locally too.

## Part C: a tap raises the session's window

**The helper.** A new `harness-pty raise` subcommand, in Rust beside `peer-account` (`pty/src/cli.rs`), using the
`windows-sys` features the crate already has.
- It takes a process id or an executable name.
- It picks that process's top-level visible window that is highest in the Z order, and restores it if it is
  minimized.
- It calls `SetForegroundWindow` and prints one word:
  - `raised` when the window is now in front;
  - `refused` when Windows declined (Windows flashes the taskbar button);
  - `none` when there is no such window.
- An older host answers exit 2 for a command it does not know, which the caller reads as `none`. The caller follows
  `runWindowsNative` (`lib/peerAccount.ts`). The window code reuses the patterns in `pty/src/desktop/win.rs`.

**The caller.** `cable/hosts/windowsRaise.ts`, dispatched once from `open.ts` where macOS uses `open -b <bundle>`. It
maps the session's host id (`hostDetect.ts` `APP_IDS`) to the app's executable (`Code.exe`, `Cursor.exe`, `Orca.exe`,
the Claude and ChatGPT/Codex desktop apps), calls the helper with that name, and records the outcome. Adapters that
already show the session inside the app (VS Code extension, Orca, herdr) raise the app first, as on a Mac.

What tells the apps apart on Windows:
- Cursor and VS Code both set `TERM_PROGRAM=vscode`. On Windows the hook (`cli/hook/notify.mjs`) tells them apart
  from what it can read in its own environment (the app folder in `VSCODE_GIT_ASKPASS_NODE` or a like variable), and
  sends the existing host id. It reads no other process's environment.
  *Corrected 2026-11-20 after the VM probe (plan Task 1): `VSCODE_GIT_ASKPASS_NODE` is in the editor's integrated
  terminals only. Claude Code's extension starts `claude` with the extension host's environment, which has
  `VSCODE_PID` and no such variable, so for a session started from the extension's panel the hook reads the image
  name of `VSCODE_PID`'s row in the one process table part D already reads: an image name, never an environment.
  The hook does this only when `VSCODE_PID` is set, within the table read's timeout. A hook is a new process each
  time, so it keeps the answer per editor in a small owner-only file of its own in the data folder
  (`hook-editors.json`: written whole, read through one bounded reader, at most 16 entries). The key is the pid plus a
  hash of the editor's own pipe name from `VSCODE_IPC_HOOK`, so a pid that another editor reuses misses. Only the
  hook reads or writes that file, never the core.
  Alacritty sets no Windows variable of its own but `ALACRITTY_LOG`, which the hook takes as Alacritty's sign.*
- No new host id is added. The firmware holds 16 apps.
- Windows Terminal has no host id. A session there is not raised (none), as a session in an unknown terminal is not
  on a Mac.
- With several windows of one app, the helper raises the one highest in the Z order.

**Measures.** Counts of `raised`, `refused` and `none` go in the devices log's existing summary line, with no app
names or ids. The success rate over at least 30 taps on the VM, in a few situations (Harness idle, typing in another
app, a minimized target), goes in the pull request.

## Part D: a hook names a caller that outlives it, on Windows (batched, Ken 2026-11-19)

#4482 (`91f60b6a7b`) fixed this on Linux: `hookCallerPid()` in `cli/hook/notify.mjs` climbs past the `-c` shells that
die with the hook, so a Stop that reaches a held core is not refused as "caller is not a descendant of that engine
process". Windows has the same gap, named in #4482. Codex and Copilot run hooks through PowerShell, and Command Code
through `cmd.exe`. That shell is the hook's parent and exits with it. Claude Code runs its hook as `argv`, with no
shell, so it is not affected.

**The fix, the Windows way.** On Windows `hookCallerPid()` climbs from `process.ppid` past each command shell in a
row, at most 8 steps, as on Linux:
- A command shell here is `powershell.exe`, `pwsh.exe` or `cmd.exe` started to run a command (`-Command`/`-c`, or
  `cmd /c`/`/s /c`), as the engines' hook runners start them (`quoteHookCommand`, `cli/src/engines/kit/notifyHooks.ts`).
  An interactive shell, or a shell running a script file, stops the climb.
- The hook reads only the parent chain (pid, parent pid, image name, command line), never an environment.
- It reads them from the pty host's process table, the same source the core's check uses (`harness-pty ps --json`,
  `lib/windows/processTable.ts`). The core's check is unchanged.

**Cost.** Starting the pty host costs a process start on a hook's path. The climb runs only for hooks whose runner is
a shell (Codex, Copilot, Command Code; the hook knows its engine from its arguments). The pull request gives the
measured time a hook takes before and after on the VM.

If a whole-table read is too slow, a narrow `harness-pty` subcommand that answers for one pid's chain replaces it. That
choice is made from the numbers. Once the hook names the right caller, the early process-table read that the core
keeps for Windows (`cli/src/core/engines/hooks.ts`, the comment near :149) stays as it is: a core change is not part of
this.

**Tests.** A unit test drives the climb with a faked table: red before, green after. A Windows real-process spec
(`*.windows.real.spec.ts`, in windows.yml) runs a hook through `powershell -Command` and `cmd /c` and checks that the
named pid is the shell's parent.

## macOS is the reference

The dial on Windows does what it does on a Mac, with the same copy and the same states. What the dial shows comes from
the devices process, which is shared code, so there is no Windows copy of its own. Each interaction:

| Interaction | On Windows, as on macOS, through |
|---|---|
| An agent rings the dial (`harness device notify`, the dial skill, the Claude Code plugin's `asked` hook) | part A pipe, part B skill/plugin |
| The Notifications setting (`you` / all) answers and holds | part A (`notify` over the pipe) |
| The list of sessions on the dial (Harness panes, herdr, Orca, VS Code/Cursor terminals, Claude Code, Codex) | existing list, plus part B herdr/Orca and part A extension |
| Speaking at the dial reaches the session (Claude Code mod inbox, Codex queue, herdr `agent.prompt`, Orca `terminal send`, VS Code terminal) | part B |
| Tap: the session's app comes forward and shows that session (app links, Cursor folder, VS Code/Orca/herdr focus) | part C, part A extension, part B herdr/Orca |
| Swipe and scroll while the app is in front | part A extension streams, existing Harness windows |

Part C therefore also covers the two tap paths that open a place in an app on macOS:
- **App links** (`claude://`, `codex://`, `vscode://`, `cursor://`, `appLink.ts`): on Windows the URL goes to the
  registered handler without a shell (the URL never meets `cmd`). `windowsRaise.ts` owns the Windows code, with one
  dispatch line in `appLink.ts`.
- **The Cursor folder window** (`cursorFolder.ts`): `cursor <folder>` through the program resolver (part B), with one
  dispatch line in `cursorFolder.ts`.

dial-linux also edits `appLink.ts` and `cursorFolder.ts`, and whoever merges second rebases and keeps both.

## Where Windows differs, and why

| Difference | Reason |
|---|---|
| A tap may flash the app's taskbar button instead of bringing it forward. | Windows lets only a process with foreground rights take the foreground, and a tap reaches a background process over serial, which Windows does not count as input. The documented answer is the flash. No unofficial workaround (decided 2026-11-19). |
| A session in Windows Terminal is listed and rings, but a tap does not raise it and the dial does not follow its tabs. | Windows Terminal has no API to list or select tabs, and no host id. The firmware holds 16 apps, and no new id is added. |
| Until the Windows Device app ships, the dial does not follow the app or tab in front, and the Notifications setting has no menu (it keeps its last value). | Those come from the Device app (`front`/`tab` lines, its menu). It is a separate item (`feat/device-app-win-linux`). This pull request makes the pipe and the watch they use work. |
| Speaking to Codex in the ChatGPT desktop app uses the `codex` CLI on PATH, not the app's own copy. | The app's bundled CLI path (`codexQueue.ts:154`) is a macOS `.app` path. Its layout on Windows is not known yet. If the VM shows that the app's sessions need the app's own copy, the plan's probe says so and harness-pm decides. |
| No Herdr.app or Herdr Core (`hc`) session, no cmux, iTerm2, Terminal.app or Ghostty tab follow. | Those apps exist only on macOS. |

## Not in this pull request

- **The Windows Device app** (separate item after this one, harness-pm's call):
  - make `device-app/src-tauri` compile on Windows (`cli.rs:10-11` and the `libc` process code behind
    `cfg(unix)`, with Windows equivalents through `ownProcessGroup`-style hidden starts);
  - a `front_windows.rs` front-app source (`GetForegroundWindow` plus a WinEvent hook, which is push, not poll);
  - the tray;
  - an NSIS per-user installer;
  - signing;
  - self-update and a login item;
  - CI on `windows-latest`.

  It is what produces `front`/`tab` lines and shows the Notifications setting on Windows.
- Zellij and kitty adapters (Diego's side), Windows Terminal tab follow (Windows Terminal has no list or send API).

## Design (docs/feature-design-rules.md)

Reviewed revision: this file. Each line: answered / N/A because …

1. **Growth.**
   - `devices-token`: one file per data folder. It lives for good, like `daemon-token`, and `harness reset` deletes
     it with the folder.
   - `devices.json`: one file, rewritten on each devices start and removed when the devices process closes. A crash
     leaves it, and the pid check then reads it as gone.
   - The nonce window: bounded at 4,096 per pipe (existing).
   - `hook-editors.json` (Windows, the hook's alone): at most 16 entries of a pid, a 16-hex hash and a bundle id,
     read up to 4,096 bytes, the newest kept. `harness reset` deletes it with the folder. No other record.
2. **Concurrency.** The token is published by a hard link, so concurrent starts agree. `devices.json` is written to
   a temp file and renamed. Clients read it at each call. There is one listener per devices process. Two devices
   processes each serve their own pipe, and the record names the last writer. Two hooks writing `hook-editors.json`
   at once each write it whole; the last rename wins, and the entry lost is read again from the table next time.
3. **Read cost.** Each client call reads two files of under 200 bytes, plus the pid check:
   - the cheap check is `process.kill(pid, 0)`, on every call;
   - the process table (`recordedProcessDead`) is read when the record changes, after a connection error, or at most
     every 60 s, so the watch's `front`/`tab` tells (up to 10 a second) start no process each.

   The listener's own limits are unchanged.
4. **Scale.** At most 16 connections with existing per-type rates; the pipe adds an HMAC per request (microseconds).
   At 10x there is no change, because the existing limits bound it.
5. **Compatibility.**
   - An older extension or plugin on Windows refuses Windows as today, and the new CLI's `link` adds fields it
     ignores.
   - A newer extension with an older CLI gets no `devicesPipe` and stays `unplugged`.
   - On macOS and Linux nothing changes.
   - A pty host without `raise` answers exit 2, which reads as `none`.
6. **Migration and rollback.** N/A: no data migrates. A rollback leaves `devices-token`, `devices.json` and
   `hook-editors.json` unread.
7. **Audience.**
   - The pipe accepts only requests that prove `devices-token`, a file in this account's profile.
   - The client sends nothing until the recorded process is alive, and takes no answer without the proof.
   - The HMAC proves the token without sending it on the pipe. The token leaves its file only on `link`'s stdout,
     to a process of this account that ran `link`, and is never logged or written elsewhere. The Claude Code mod
     gets the daemon's pipe and token the same way (part B), as it gets the core's socket on a Mac.
   - The listener logs counts only, as today.
8. **Identity.** Everything runs as the signed-in account. Nothing runs under another login or elevated.
9. **Failure.** Each failure is one log line naming its reason, and clients answer false or null as today:
   - the listener not opened (`[devices] listener not opened · <reason>`);
   - an unproven answer;
   - a refused raise, which the person sees as the taskbar flash and which is counted.

   `link` reports `devicesReady: false`, and the extension shows `unplugged`.
10. **Platforms.** Windows 11 x64 and arm64. The UTM VM is arm64, and windows.yml covers x64 and arm64. A real x64
    PC with a real dial (the Dell) runs the real-dial and x64 hand checks. macOS and Linux keep their paths, guarded
    by their existing tests.

## Verification (outline; the plan details it)

- Unit tests for every change, written to fail first, at the layer of the change. The pipe auth runs on the Unix
  socket stand-in on macOS and Linux (as `pipeAuth.spec.ts` does), and on a real pipe on Windows (`*.windows.real.spec.ts`
  in windows.yml).
- Part A: windows.yml with the devices listener and client specs, plus the extension and plugin tests on Windows. On
  the VM: `harness device notify` against an isolated daemon, and the VS Code extension's gate against a downloaded VS
  Code.
- Part B: `dialWindows.e2e.ts` on windows.yml and on the VM; herdr and Orca against real herdr and Orca installed on the
  VM, never Ken's own apps or accounts.
- Part C: the raise measured on the VM, in the person's session (not over SSH, which lands in session 0), with the
  window recording of docs/windows-rules.md §1 to prove nothing flashes.
- Never Ken's real apps or accounts, nor the Dell owner's. Serial on the VM uses the stand-in; the real dial is checked
  on the Dell (x64, `COM3`) by an isolated desk with its own data folder, in the owner's console session, that touches
  only what it installs. The one exception: the owner's Harness daemon is stopped to free `COM3` and started again as
  before afterwards, and the run checks it runs and holds `COM3` again. The dial is left as it was found: the run
  writes its settings only after reading them first, writes them back exactly, and checks them. It does not greet a
  dial that holds a custom pet, which a new desk would remove. Ken presses and speaks into the dial from one short list,
  and the run does every other step.
  *Corrected 2026-11-20: this said the real dial stays on the Mac; a real Windows x64 PC with a real dial became
  available for testing.*

## Left to the builder

- Where exactly the shared HMAC test vectors live (a fixture file the three test suites read).
- The hook form for Claude Code on Windows, inside the rules above (no shell for text, no window, finds `harness`).
- The exact window to pick when an app has several top-level windows (highest in Z order is the default).

# The dial on Windows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit. No task pushes or merges, and every task ends green.

**Goal:** On Windows the dial does what it does on a Mac: agents ring it, the devices' listener answers over a named pipe, the VS Code/Cursor extension, the Orca plugin, Claude Code's plugin, Codex, herdr and Orca reach it, a tap raises the session's window, and a hook names a caller that outlives it.

**Architecture:**
- **Part A.** The devices process serves its existing handlers on a pipe of its own (`listenLocalSocket(handler, pipe, { token })`), with its own token (`devices-token`) and record (`devices.json`). Clients find `{pipe, token}` through the record and send with `fetchOverPipe`. `link` hands the pipe, token and record path to the plugins, which sign with their own small copy of the auth.
- **Part B.** One resolver (`lib/windows/program.ts`) turns every program this work starts on Windows into an `.exe` with arguments, never a shell. With it Claude Code's plugin, the dial skill, Codex's queue, herdr (over its pipe) and Orca stop refusing Windows. Claude Code's mod, whose runtime cannot reach a pipe (Task 2), hears the dial through `harness device claude inbox` and turns it through `attach`, so the CLI holds the tokens. A dial end-to-end check runs on Windows with a stand-in dial.
- **Part C.** A Rust helper (`harness-pty raise`) raises a window by Windows' documented rules; `cable/hosts/windowsRaise.ts` calls it, starts Harness Desktop through its own launcher, and each tap path dispatches to it once.
- **Part D.** On Windows `hookCallerPid()` climbs past the command shells that die with the hook, read from the pty host's process table. The core does not change.
- The core's process loads `lib/windows/pipeAuth.ts`, `lib/localSocket.ts`, `lib/daemonRecord.ts`, `lib/secureState.ts`, `lib/windows/launch.ts`, `lib/peerAccount.ts`. Only `pipeAuth.ts` changes (a file-name parameter that defaults to today's). Everything else is used as it is, from new files the core does not load.

**Tech Stack:** TypeScript (Node, vitest) in `cli/`; the hook script `cli/hook/notify.mjs`; the VS Code extension and the Orca plugin (TypeScript, `plugins/`); the Claude Code plugin (a JavaScript mod and a hook, `plugins/harness-device`); Rust (`pty/`, `windows-sys`); one GitHub workflow (`.github/workflows/windows.yml`). No Dart change.

**Spec:** `docs/plans/2026-11-19-dial-windows-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core; Rules 4-6), `docs/windows-rules.md` and `docs/validation-and-release.md` ("What PR CI does not run").

## Base

- `feat/dial-windows` at `91f60b6a7b` (`main` with #4482). The spec and this plan are untracked; the main session commits them, no task does.
- **Landed by `94e4b5317a`** (2026-11-20): Tasks 1, 3, 4, 5, 7, 8, 9, 11, 14, 22, 31. This revision of the plan follows Task 1's notes; where they contradicted the plan, the tasks below say so ("Since Task 1").
- Line numbers below are the base's. A task follows the expression it names when a line has moved.
- A new worktree has no `cli/node_modules`: its first task runs `cd cli && npm ci`.
- `feat/dial-linux` edits `devices/orcaHomes.ts`, `cable/hosts/open.ts`, `appLink.ts` and `cursorFolder.ts` too. Tasks 20 and 28 change only the lines they name there. Whoever merges second rebases and keeps both.

## Tasks at a glance

Paths are under `cli/src/` unless they start with another folder. "notes" is `docs/plans/2026-11-19-dial-windows-vm-notes.md`: every task that uses the VM or the Dell writes its section there, so devcrew runs them one at a time.

| Task | Files (each with its spec or test) | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 VM probe: launchers, apps, herdr (landed) | `lib/windows/fixtures/{code,cursor,orca}.cmd` (new), notes | none | high | none: findings, one commit |
| 2 VM probe: Claude Code's mod runtime and hook runner | notes | 1 | high | none: findings, one commit |
| 3 A token file by name | `lib/windows/pipeAuth.ts` | none | xhigh | `lib/windows/daemonToken.spec.ts` |
| 4 The devices' record, target and pid proof | `devices/listenerPipe.ts` (new), `devices/listenerPath.ts` | 3 | xhigh | `listenerPipe.spec.ts` (new), `listenerPath.spec.ts` |
| 5 The listener serves the pipe | `services/devicesListener.ts`, `services/devicesProcess.ts` | 3, 4 | xhigh | their two specs |
| 6 Clients send over the pipe | `devices/listenerClient.ts`, `devices/client.ts`, `devices/listenerPipe.windows.real.spec.ts` (new), notes | 4, 5 | xhigh | `listenerClient.spec.ts`, `client.spec.ts` |
| 7 `link` for Orca and VS Code | `deviceClaude/command.ts` | 4 | xhigh | `command.spec.ts` |
| 8 The VS Code extension on Windows | `plugins/harness-device-vscode/src/{pipeAuth.ts (new),inputs.ts,loop.ts,wire.ts}`, its `README.md` | none | xhigh | its `*.test.ts` |
| 9 The Orca plugin on Windows | `plugins/harness-device-orca/src/{pipeAuth.ts (new),inputs.ts,dial.ts,panel.tsx,protocol.ts}`, its `README.md` | none | xhigh | its `*.test.ts(x)` |
| 10 One Windows program resolver: an exe, an npm shim, VS Code's and Cursor's launcher | `lib/windows/program.ts` (new) | 1 | xhigh | `program.spec.ts` (new) |
| 11 This account's own folder, on Windows | `devices/dialSkill.ts` | none | xhigh | `dialSkill.spec.ts` |
| 12 VS Code and Cursor found and run | `devices/vscodeExtension.ts`, `cable/vscodeExtensionSetup.ts` | 1, 10 | high | their two specs |
| 13 Claude Code's plugin and the dial skill; `claude.exe` in `.local\bin` | `devices/claudePlugin.ts`, `cable/dialPluginSetup.ts`, `cable/dialHomeSetup.ts`, `devices/claudePlugin.windows.real.spec.ts` (new), notes | 1, 10, 11 | high | their three specs |
| 14 `asked` over the daemon's pipe | `deviceClaude/asked.ts` | none | high | `asked.spec.ts` |
| 15 `harness device claude inbox`: the session's inbox through the CLI (first a VM check: does `$.process.spawn` stream on Windows) | `deviceClaude/inbox.ts` (new), `deviceClaude/inbox.windows.real.spec.ts` (new), `deviceClaude/command.ts`, `devices/listenerPipe.ts`, `cli.ts`, notes | 2, 4, 14 | xhigh | `inbox.spec.ts` (new), `listenerPipe.spec.ts`, `command.spec.ts` |
| 16 The mod reaches Harness through `harness.exe` on Windows | `plugins/harness-device/hooks/device.js`, `plugins/harness-device/test/device.test.ts`, `plugins/harness-device/README.md` | 15 | xhigh | `device.test.ts` |
| 39 `harness device claude attach` | `deviceClaude/command.ts` | 6 | high | `command.spec.ts` |
| 17 The permission hook on Windows | `plugins/harness-device/hooks/{hooks.json,asked}`, at most `hooks/asked.ps1` (new), `plugins/harness-device/README.md`, `harnessDevicePlugin.spec.ts` | 2 | high | `harnessDevicePlugin.spec.ts` |
| 18 Codex on Windows | `cable/hosts/codexQueue.ts`, `deviceClaude/command.ts` | 1, 10 | high | `codexQueue.spec.ts`, `command.spec.ts` |
| 19 herdr over its pipe | `cable/hosts/{herdrClient,herdrSource,herdr,unixSocket}.ts` | 1, 11 | high | their four specs |
| 20 Orca's `orca.exe` found; its homes and plugin | `devices/orcaHomes.ts`, `devices/orcaPlugin.ts` | 1, 10, 11 | high | their two specs |
| 21 Orca's commands and its focus watch, through `orca.exe` | `cable/hosts/orca.ts` | 10 | high | `orca.spec.ts` |
| 22 The serial stand-in bridges | `cable/__fixtures__/fakeHarnessSerial.mjs`, `cable/fakeSerialBridge.spec.ts` (new) | none | medium | `fakeSerialBridge.spec.ts` |
| 23 The dial end to end on Windows | `cli/e2e/dialWindows.e2e.ts` (new), `cli/e2e/harness/windowsDaemon.ts` (new), `cli/e2e/harness/fakeDial.ts`, `cli/vitest.e2e.windows.config.ts` (new), notes | 5, 6, 7, 22 | high | none on the branch: it pins 5-7; one commit |
| 24 A desk for hand checks, on the stand-in or the real dial, that leaves the dial as it found it | `cli/scripts/windows-dial-e2e/{desk.mts,console.ps1,README.md}` (new), `cli/e2e/harness/windowsDaemon.ts`, `cli/e2e/harness/client.ts` | 23 | xhigh | none: a test tool, one commit |
| 25 The real-VS Code gate on Windows | `plugins/harness-device-vscode/gate/{realVscode.gate.ts,throwawayApp.ts,throwawayApp.test.ts,cleanup.ts,driver/run.cjs}`, notes | 5, 8 | high | none: the gate itself, one commit |
| 26 `harness-pty raise` and `open-link` | `pty/src/{cli.rs,raise.rs (new),lib.rs}`, `pty/tests/raise.rs` (new), notes | none | high | `cli.rs` and `raise.rs` unit tests |
| 27 The Windows raise | `cable/hosts/windowsRaise.ts` (new) | 1 | high | `windowsRaise.spec.ts` (new) |
| 28 One dispatch in each tap path | `cable/hosts/{open,appLink,cursorFolder,vscode,codexApp}.ts` | 27 | high | their five specs |
| 29 The devices wire the raise and count it | `services/devices.ts` | 12, 21, 27, 28 | high | `services/devices.spec.ts` |
| 30 The hook tells Cursor from VS Code, in a terminal and in the extension's panel (its answer kept per editor), and names Alacritty | `cli/hook/notify.mjs`, `hookNotify.spec.ts` | 1, 31 | xhigh | `hookNotify.spec.ts` |
| 31 The hook's caller on Windows (landed) | `cli/hook/notify.mjs`, `hookNotify.spec.ts` | none | xhigh | `hookNotify.spec.ts` |
| 32 The caller, with real processes | `hookCaller.windows.real.spec.ts` (new), notes | 31 | medium | none on the branch: it pins 31; one commit |
| 33 What the climb costs | notes | 31 | medium | none: numbers, one commit |
| 36 (only if Task 33 measures more than 50 ms) One pid's chain from `harness-pty` | `pty/src/{cli.rs,ps.rs}`, `cli/hook/notify.mjs`, `hookNotify.spec.ts`, notes | 30, 31, 33 | xhigh | `cli.rs` and `ps.rs` unit tests, `hookNotify.spec.ts` |
| 37 VM console probe: the Store apps, window owners, the shells' environments (the agent signs the test user in; it restarts the VM, so it runs alone there) | notes | 1 | xhigh | none: findings, one commit |
| 38 (only if Task 37 contradicts a name in Task 27 or Task 30) The names the console showed | `cable/hosts/windowsRaise.ts`, `windowsRaise.spec.ts`, `cli/hook/notify.mjs`, `hookNotify.spec.ts` (only those contradicted) | 27, 30, 37 | high | the contradicted spec's new case |
| 34 windows.yml runs the new checks | `.github/workflows/windows.yml` | 6, 8, 13, 15, 17, 23, 32 | medium | none: a workflow, one commit |
| 35 The guides say Windows | `cli/AGENTS.md`, `docs/cli.md`, `docs/windows-rules.md` | 13, 16, 17, 18, 19, 20, 24, 25, 29, 30, 33, 37, 39, and 36 and 38 when they run | medium | none: docs, one commit |

37 tasks (Task 39 added 2026-11-20, when Task 2's stop moved the mod's voice onto the CLI), and Task 36 only if Task 33's number calls for it, Task 38 only if Task 37's notes contradict Task 27 or Task 30. Longest chain of the whole plan: 3 → 4 → 5 → 6 → 23 → 24 → 35 (seven tasks); of what is left after `94e4b5317a`: 6 → 23 → 24 → 35, 10 → 12 → 29 → 35 and 27 → 28 → 29 → 35 (four each). Ready now (their dependencies landed): 2, 6, 10, 15, 19, 25, 26, 27, 30, 33, 37; after Task 2's stop: 15 → 16 → 35 and 6 → 39 → 35; the VM's tasks among them still go one at a time. Shared files keep these apart, one at a time: the notes (2, 6, 13, 15, 23, 25, 26, 32, 33, 36, 37: the one VM, and the Dell's checks in Verification); `deviceClaude/command.ts` (15, 18, 39); `notify.mjs` (30, 36, 38); `windowsRaise.ts` (27, 38); `e2e/harness/windowsDaemon.ts` (23, 24). Task 37 restarts the VM: nothing else runs on the VM while it runs, which the notes already enforce.

## Global Constraints

- **The pipe's API is stable** (spec, part A), exact values:
  - `devices.json` is `{"pipe":"\\\\.\\pipe\\harness-<32 hex>","pid":<number>}`; the token file is `devices-token`, 64 lowercase hex digits and an optional newline.
  - A pipe is dialled only when it matches `^\\\\\.\\pipe\\harness-[0-9a-f]{32}$` and the recorded pid runs.
  - **The pid proof** (spec, Design "Read cost"): `process.kill(pid, 0)` on every call; the process table's proof (`recordedProcessDead`) when the record changes, after a connection error, and at most every 60 s. Every answer still needs its HMAC proof.
  - Each request is `POST /` with `x-harness-auth: <nonce>.<hex HMAC-SHA256(token, 0x01 ‖ nonce)>`; the nonce is the pipe's 32-hex id, then 128 random bits. Each answer carries `x-harness-proof: <hex HMAC-SHA256(token, 0x00 ‖ nonce)>`. No valid auth: `401` with `{"error":"PIPE_AUTH_REQUIRED"}`.
  - An answer without the right proof is dropped before its body is read.
- **`link` on Windows** prints `{ daemon, devicesPipe, devicesToken, devicesReady, devicesRecord }`. On macOS and Linux every output is byte for byte what it is today.
- **A token is never logged, written or put in an error**: not by the CLI, the extension, the plugin or the mod. It leaves its file only on `orca link`'s and `vscode link`'s stdout. Claude Code's mod never holds one: on Windows it reaches the daemon and the devices through `harness device claude inbox` and `attach` (Tasks 15, 39), which read the tokens in the CLI's own process; `harness device claude link` on Windows still prints nothing and exits 1.
- **The test key** (The VM) is never printed, logged, written elsewhere, put on a command line, in the notes, a commit or the pull request, and is deleted from the VM after the checks.
- **The plugins find `harness`** at `%USERPROFILE%\.harness\bin\harness.exe`, then on PATH. That `harness.exe` is the install's own program (`pty/src/command.rs`: it runs `node.exe <cli.js>` with its arguments, no batch file), never a `.cmd`. The mod checks the first with `$.fs.exists`: `$.process.run` of a missing absolute path resolves with exit 1 on Windows instead of rejecting (Task 2 §3).
- **No shell, no window.** Every program started on Windows goes through Task 10's resolver with `windowsHide: true`. No `detached: true` (`lib/windows/noWindow.spec.ts`), no `cmd.exe`, no PowerShell. A batch file that is neither an npm shim nor VS Code's or Cursor's own launcher (the fixtures' Electron shape) is refused; Orca's `orca.cmd` is such a batch file, so Orca is found and run as its `orca.exe` (Tasks 20, 21).
- **The core.** `src/architecture.coreFiles.txt` gains no line. Of the files it lists, only `lib/windows/pipeAuth.ts` changes. `lib/localSocket.ts`, `lib/daemonRecord.ts`, `lib/secureState.ts`, `lib/windows/launch.ts`, `lib/windows/daemonPipe.ts`, `lib/peerAccount.ts`, `lib/binaryOnPath.ts` and `core/` do not change.
- **Coverage.** `services/devicesListener.ts`, `services/devicesProcess.ts` and `services/devices.ts` stay at 100% per file under `npm run test:core` on the Mac: every Windows branch there is reached by an injected platform or dependency, with the pipe stood in by a Unix socket named `harness-<32 hex>` (as `pipeAuth.spec.ts` does).
- **The listener's limits do not change**: 16 connections, the per-type rates, the 2 s deadlines, the streams.
- **Raising a window**: restore if minimized, then `SetForegroundWindow`. No `AttachThreadInput`, no injected input, nothing system-wide. The helper prints one word: `raised`, `refused` or `none`. Exit 2 or 3, a missing helper or no answer in time reads as `none`. Only `none` is a failed tap; `refused` (the taskbar flash) shows no copy on the dial.
- **Apps raised on Windows**: VS Code, Cursor, Orca, the Claude app, the ChatGPT app, WezTerm, Warp and Alacritty, through the one dispatch. A pick in the dial's app list brings its app forward the same way. A tap on a Harness agent starts Harness Desktop through its own launcher, as `open -b` does on macOS.
- **App links** open through `harness-pty open-link` (`ShellExecuteW`), held to `claude`, `codex`, `vscode` and `cursor`. Never `rundll32`.
- **No new host id.** Windows Terminal is not raised. With several windows of one app, the highest in the Z order.
- **Part D**: at most 8 steps; only `powershell.exe`, `pwsh.exe` and `cmd.exe` started to run a command; the climb only for hooks whose runner is a shell (Codex, Copilot, Command Code); only pid, parent pid, image name and command line are read, never an environment. `core/engines/hooks.ts` does not change. The whole-table read stays unless it adds more than 50 ms (p50) to a hook on the VM; then Task 36 replaces it with one pid's chain.
- **The hook's table, read once a run, has two readers on Windows and no third**: Task 31's climb, and Task 30's panel hint (a paneless hook whose environment has `VSCODE_PID` and no editor in `VSCODE_GIT_ASKPASS_NODE`: one row's image name). The panel hint reads the table only when its kept answer misses (`hook-editors.json`, Task 30), within the read's existing 3000 ms limit inside the hook's budget. Every other hook starts no helper; a hook in a VS Code or Cursor terminal starts none.
- **The hook's kept answers** (`<data folder>\hook-editors.json`, Task 30) are the hook's alone: on Windows only, owner-only, written whole (temp file, then rename), read through one bounded reader (4096 bytes), at most 16 entries, holding a pid, a 16-hex hash and a bundle id and nothing else. The core, the devices and every other process read nothing of it.
- **Copy and states are macOS's.** No new sentence on the dial. The Orca panel's "Not on Windows yet." goes.
- **Stop conditions** (the task ends, writes what it found in the notes, and the main session asks harness-pm):
  - Task 2: the mod runtime cannot send to a pipe, cannot read the answer's proof, or has no HMAC-SHA256. **Hit 2026-11-20** (`$.http.fetch` refuses every pipe path in `socketPath`, inside Claude Code; `crypto.subtle` has `digest` alone). The orchestrator's answer: on Windows the mod goes through the CLI (Tasks 15, 16, 39). No weaker credential, and no loopback TCP port on the core.
  - Task 37 (moved from Task 1, which could not install the app over SSH): sessions of the ChatGPT app answer only to the app's own `codex`. Task 18 still ships the PATH `codex`.
  - The VM does not answer SSH within 5 minutes of a restart (The VM, "Signing the test user in"): the task stops and reports; the VM is restarted for it, never by the task again.
  - The Dell: the dial holds a custom pet (a new desk would drop it, and the run cannot send it back); something holds `COM3` after the owner's daemon is stopped (its Desktop may have started it again); the owner's daemon is not running and holding `COM3` again after the restart; the dial's settings are not restored. Each: the run stops, restores what it can as The Dell says, and reports.
- **Outside text is data**: launcher files, herdr's answers, Orca's answers, `link`'s output and the process table are parsed and bounded, never run.
- **The pull request** names the platforms (Windows 11 x64 and arm64; macOS and Linux unchanged), and carries the raise's measured rate (the VM's and the Dell's), the hook's time before and after, the `tellDevices` time, the CPU and memory of an idle VM with 1 and 3 Claude Code sessions holding the mod's `harness` process (Verification 9), the real dial's checks on the Dell (with the lines saying the owner's daemon was stopped and restored, and the dial's settings unchanged or restored), and the local gates' receipts. No full dial serial is in it, the notes or a commit.

## Decided here, where the spec was silent

- **The shared vectors exist already**: `cli/src/lib/windows/__fixtures__/pipe-auth-vectors.json` (made by `cli/scripts/gen-pipe-auth-vectors.ts`, read by `pipeAuth.spec.ts` and Desktop's test). The extension's, the plugin's and the mod's tests read the same file. No second fixture.
- **`devicesListenerPath` keeps its name and meaning** (the Unix socket's path, null on Windows): the Unix server and four e2e files use it. Clients ask the new `devicesTarget`, which answers a socket or a pipe with its token.
- **The record**: written after the pipe listens; a write that fails closes the pipe and the listener is not open. Close removes `devices.json` only while it still names this pipe, so a second devices process's record survives the first one's close.
- **`link` when not ready** prints `{ daemon, devicesReady: false, devicesRecord }`: no pipe and no token until the recorded process runs. `harness device claude link` is not changed on Windows (it prints nothing and exits 1): the mod goes through `inbox` and `attach` instead (Tasks 15, 39).
- **`daemon` in `link`** is true when the recorded daemon pipe answers `GET /api/status` with its proof within 1 s (`askDataFolderServer`).
- **`windowsHide: true`, not `ownProcessGroup()`, on callers that are not detached today**: `ownProcessGroup()` adds `detached` on macOS and Linux, which would change those paths. On Windows both give the same hidden console.
- **"This account's own" on Windows is the profile alone** (`os.homedir()`, resolved), not the configured data folder that `windowsStateRoots()` also allows: a skill home is the person's engine home, never Harness's data.
- **herdr's marker stamp** is `<inode>:<mtime in ns>`: a file's change time moves when its last handle closes (docs/windows-rules.md §3).
- **The app's identity on Windows is the bundle id the devices already key on.** The hook derives it and sends it in the existing `__CFBundleIdentifier` hint; `windowsRaise.ts` maps a bundle id to a program name. `hostDetect.ts`, `observed.ts` and the core's route do not change.
- **Cursor or VS Code, since Task 1** (Task 30). One mapping, from a program's file name (`Code.exe`, `Cursor.exe`, any case) to the bundle id, fed by the first of:
  1. `VSCODE_GIT_ASKPASS_NODE` in the hook's own environment: the editor's `.exe`, set in its integrated terminals (notes, Task 1 §6). No process is started.
  2. `VSCODE_PID` in the hook's own environment: the image name of that pid's row in the run's one process table. Claude Code's VS Code extension starts `claude` with the extension host's environment, which has `VSCODE_PID` and no `VSCODE_GIT_ASKPASS_NODE`, so a session started from the panel is told apart this way. The row's image name is read, never that process's environment, which keeps Part D's rule. Chosen over the install folder in `VSCODE_NODE_COMPILE_CACHE_ROOT` or `VSCODE_NLS_CONFIG` (a folder an installer names, inside a variable for Node's cache, not one that names the editor) and over a climb to the first `Code.exe` ancestor (a walk through processes that are no command shell, for an answer one row gives). Cost: one pty-host start on such a hook, Task 33's `ps --json` time.
- **The panel hint's kept answer** (Task 30). A hook is a new process each run, so the answer for one editor is kept in `hook-editors.json` in the hook's data folder (`paths().dataDir`), written and read by `notify.mjs` alone. `notify.mjs` runs alone and imports nothing from `src/`, so it cannot call `atomicWriteJson` or `readState` (cli/AGENTS.md rule 9). It uses its own copies of them, which already serve the registry (`writeRegistry`: an `O_EXCL | O_NOFOLLOW` temp file at 0600, fsync, rename; `readPrivateStateFile(file, 4096)`, `hardenPrivateStateFileIfPresent`, `secureStateDirectory`). The key is `VSCODE_PID` plus the first 16 hex digits of SHA-256 of `VSCODE_IPC_HOOK`, both from the hook's own environment. A key of pid plus start time would mean reading the editor process's start time, and on Windows only the pty host can read that, which is the cost the cache saves. `VSCODE_IPC_HOOK` names the editor's main process pipe, which comes from the editor's user-data folder and its version (`\\.\pipe\<hex>-<version>-main-sock`, Task 1 §6; VS Code's `createStaticIPCHandle`). So a pid that another editor or another version reuses misses. A pid that the same editor and version reuses gets the answer the table would give. A pid that is no longer an editor still names the editor the session came from, which is what a tap should raise. With no `VSCODE_IPC_HOOK`, nothing is kept and the table is read each time. Only an answer from a table row is kept. No hint (no row, another name, a failed or late read) keeps nothing, so a failure is never remembered. Two hooks writing at once: the last rename wins, and the lost entry is a miss later.
- **Cursor: PATH and the per-user folder only** (Task 12; answered 2026-11-20). Task 1 saw only per-user installs, so a machine-wide Cursor folder is added once a real install shows one, not before. VS Code keeps its machine folder (`%ProgramFiles%\Microsoft VS Code\bin\code.cmd`, the one Task 1 checked).
- **The Dell's runs** (answered 2026-11-20). The run happens in the owner's console session, through one-shot `schtasks /it` tasks under the owner's account (Task 24's `console.ps1`), with the run's own data folder. No test user is made on the Dell. Before anything else, the run records whether the owner's Harness daemon runs (`harness status`: running or not, and the version; the pid and machine id are not kept). It stops the daemon to free `COM3`. Afterwards it starts the daemon again as before, with `harness start` in the console session (never from SSH's session 0), and then checks that it runs and holds `COM3` again. The evidence says it was stopped and restored. A daemon that was not running is left stopped.
- **The dial is left as it was found** (Task 24). A new desk greets the dial with an empty pet store, and the session then sends `pet.map` and a `pet.drop` for every pack the dial holds (`cableSession.ts` `runPetSync`, `planPetSync`). That would delete a custom pet the run cannot send back. So before any desk starts, a read-only look (`desk.mts --dial-read`) takes the dial's own `hello` (sent unprompted, every few seconds) and writes not one byte to the port. A dial that holds a custom pet stops the run. The daemon does not write the dial's settings when it greets (`welcome`'s `voiceLang` is a proposal the dial may keep or drop, and the dial's own NVS choice stays). Each desk still compares the dial's settings at its `quit` with the first look. When they differ (a press on the dial's menus, say), it writes the first look's values back with one `dial_settings` and checks the dial's answer. The settings are written only that way: read first, written back exactly, checked.
- **Ken presses and speaks; the run does everything else** (answered 2026-11-20). What firmware, the serial line or a test hook can drive, the run drives. notify is proven by `shown` and a cable write with no error (the dial sends no receipt for a notice; what it draws is the firmware's, as on a Mac). The raise is measured on x64 with a sealed stand-in dial. Only the purely physical steps (pressing the dial, speaking into its mic) go into one short list for one sitting (Verification, "Ken's list").
- **Orca is run as its `orca.exe`, since Task 1.** `orca.cmd` is not an Electron launcher: it passes `%*` to `resources\bin\orca.exe` and refuses `orchestration send|reply`, because `cmd.exe` reparses a body (Orca's own comment names `orca.exe` the supported path). So Orca's finder names `orca.exe` itself (Task 20), and the resolver stays with its two batch shapes and refuses `orca.cmd` as any other batch file. Chosen over teaching the resolver a forwarder shape: that shape reaches the `.exe` through `set "LAUNCHER=%SCRIPT_DIR%orca.exe"`, a third grammar to parse for a file whose name is known, and a forwarder the resolver ran directly would skip the launcher's own refusal while still claiming to be it. `resources\bin` is not on PATH, so the default per-user install is where Orca is found.
- **The VS Code and Cursor launchers are read at every start** (Tasks 10, 12): VS Code's `cli.js` sits under a folder named by the build's commit (`8a14f0cc1b\resources\app\out\cli.js`), which an update renames. The finder answers the `.cmd`; the resolver reads it each time and keeps nothing.
- **An app link with no handler opens nothing and shows nothing** (Task 26). VS Code and Cursor register `vscode` and `cursor` in HKCU only at their first start, and `claude` and `codex` come with the Claude and ChatGPT apps (Task 1 §8). `open-link` calls `ShellExecuteExW` with `SEE_MASK_FLAG_NO_UI`, the Ex form of `ShellExecuteW` the spec names, so a scheme with no handler prints `refused` and Windows shows no "pick an app" window; no registry is read first, because a Store app's handler is not a plain HKCU key.
- **The window picked**: visible, unowned, not a tool window, first in the Z order.
- **The measure** is one `createEngineTally` (`cable/engineTally.ts`): `[device] raise · window · <outcome>` and its day line. `window` is a fixed word; no app is named.
- **One notes file for the VM and the Dell** (see the table). It holds no account name, token, full dial serial or personal path: a profile is written `<profile>`.
- **The e2e on Windows has a harness of its own** (`IsolatedDaemon` needs tmux). `HARNESS_SERIAL_BIN` names a program, so the stand-in runs as one: the run's own `node.exe`, with three one-line entry files (`watch.js`, `open.js`, `probe.js`) in the daemon's working folder. Node reads the helper's first word as a script there. No product code changes for it.
- **The gate on Windows uses the real `harness.exe`** (`HARNESS_EXE_BIN`, as `installPs1.spec.ts` takes it) in a throwaway install layout whose `cli.js` prints the link line.
- **Windows real specs** are named `*.windows.real.spec.ts`, live beside their code, and are listed in windows.yml by Task 34 alone.
- **Part D reads the table once per hook run**: the climb and the hook's other readers share one `harness-pty ps --json`.
- **Harness Desktop's launcher** is `%LOCALAPPDATA%\Programs\Harness\Harness.exe` (`pty/src/desktop/mod.rs`: the install root is `FOLDERID_UserProgramFiles`\Harness, the launcher `LAUNCHER_EXE`). A tap on a Harness agent starts it with no argument, and nothing is raised first: a running Desktop, in the tray too, takes a second launch over and restores and raises its own window (`desktop/windows/runner/single_instance.cpp`, `Forward` and the `WM_COPYDATA` handler). No launcher there: the tap fails, as a failed `open -b` does on macOS. The start is not counted in the raise tally, which counts the helper's answers alone.
- **WezTerm, Warp and Alacritty** are found as on macOS: WezTerm by `WEZTERM_PANE`, Warp by `TERM_PROGRAM=WarpTerminal` (both hints the hook already sends), Alacritty by its bundle id alone, which on Windows the hook fills from `ALACRITTY_LOG` being set (Task 30). Since Task 1: on Windows Alacritty sets no `ALACRITTY_WINDOW_ID` or `ALACRITTY_SOCKET` (Unix only); `ALACRITTY_LOG` (its log file's path, set in its own process and inherited by its shell, `alacritty/src/logging.rs`) is the one name only it sets. Chosen over its program in the caller chain, which would start the pty host on every hook in any terminal and walk past the person's own shell. The value is never read. Read from Alacritty 0.17.0's source; Task 37 confirms it in a real Alacritty shell, and Task 38 corrects it if not.
- **The pid proof's state** lives in the client's process (`devices/listenerPipe.ts`, one `DevicesProof` per process): a one-shot `harness device notify` proves by the table each time, and the long-lived watch at most once a minute. A pid reused inside that minute passes the cheap check, and gets nothing from it: an answer without the HMAC proof is dropped unread, and the drop makes the next call prove by the table.
- **Claude Code's mod on Windows goes through the CLI** (orchestrator, 2026-11-20, after Task 2's stop; macOS is the reference, so the standalone Claude Code session keeps voice on Windows; a loopback TCP port on the core is out). The mod starts `harness.exe`, which does the pipe auth in its own process; no token, pipe name or HMAC enters the mod. macOS and Linux keep today's direct socket path, unchanged.
  - **The words** are the mod's, never typed, and left out of `DEVICE_USAGE` as `link` is: `harness device claude inbox <session id>` (Task 15) and `harness device claude attach <session id>` (Task 39). The session id is a positional word, not `--session <id>`: `runDeviceCommand` drops words that start with `-` and would take the id for a third word anyway, so the dispatch reads `words` of length 3. Both take a lower-case UUID only (the listener's `SESSION_ID`). They are clients of the daemon's existing `/api/hook/inbox` (over `daemonFetch`, as `asked` posts) and of the devices' existing `attach` message (over `tellDevices`): nothing new in the core.
  - **One line protocol on stdout**, one JSON object per line, and nothing on stderr, ever: `{"text":"…"}` (what the person said), `{}` (a hold ended with nothing), `{"off":true}` (the plugin is off or removed, the id is refused, or the daemon is older than the inbox; the last line, then exit 0), and for `attach`, `{"sent":true}` or `{"sent":false}`. Meaning rides on lines, not on exit codes, because `harness.exe` already owns 3 and 4 (`EXIT_BROKEN`, `EXIT_SPAWN`) and Node's own crash is 1.
  - **One long-lived process per session** when `$.process.spawn` streams on Windows (the engine's types, 2.1.329, have it: pieces as written, the loop's end kills the child; Task 15's Step 1 confirms it on the VM's 2.1.328). Else one `inbox` run per poll, which prints one line and exits. Streaming is preferred: a Node start costs about 1 s on the VM (Task 2 §4) against a 25 s hold, and the devices hold a transcript for the next poll 5 s only (`cable/hosts/inbox.ts` `WAIT_MS`).
  - **The follower proves the daemon by the held-proof rule** of the devices' pipe (Task 4): the pid on each poll, the process table when the record changes, after a failed or unproven answer, and at most every 60 s. `daemonFetch`'s default `daemonPipe` reads the table on every call, which would start the pty host every 25 s per session. So Task 15 lifts `createDevicesProof`'s rule into `createRecordProof` in `devices/listenerPipe.ts` and builds the daemon's on it; `lib/windows/daemonPipe.ts` (the core's) does not change.
  - **It does not outlive its session.** `harness.exe` starts `node.exe` with no job object, so when Claude Code ends the loop and kills `harness.exe`, `node.exe` may run on. The follower therefore ends itself (exit 0) before its next poll when its parent is gone (`process.kill(process.ppid, 0)`, no process started), and at once when a write to its stdout fails. A newer poll for the session ends the older one in the core (`deviceHookCalls.ts`: "an older one … gives up its place"), so an orphan's held poll returns at once and it exits; at most one held poll's transcript can go to an orphan, as an old copy's in-flight poll can on a reload on a Mac.
  - **A bounded restart.** A follower that ends without `{"off":true}` (killed, crashed, could not start) starts again after 1, 2, 4, 8 and 16 s for five quick ends in a row (each ran under 60 s); the sixth waits 10 minutes (`OLD_HARNESS_MS`) and the count starts over. One that ran 60 s or more resets the count and starts again after 1 s. After `{"off":true}` the mod waits 10 minutes, as it waits after `link` exits non-zero on a Mac. Worst case: six starts in about 10.5 minutes per session.
  - **The attach** is one `attach` run per `session.attach` of the desktop surface, bounded at 5 s (`RELINK_TIMEOUT_MS`). Not sent (`{"sent":false}`, a failed run): the session stays held unless a detach came, and the next attach tries again, at most once in 30 s (`RELINK_MS`), as the Mac's relink does.
  - **Without `$.process.spawn`** (a Claude Code older than it, on Windows, if the follow form is built): the mod starts no follower and has no voice there, as with a Harness older than the inbox. No second path.

## Answered questions (Decided 11 in the spec)

1. A tap on a Harness agent with no window starts Harness Desktop through its launcher: Tasks 27, 28, 29; Verification 7.
2. A pick in the dial's app list brings the app forward on Windows, through the same dispatch: Task 28.
3. A refused raise shows no copy; only `none` fails: Tasks 27, 28.
4. App links open through `harness-pty open-link` (`ShellExecuteW`), four schemes: Tasks 26, 27.
5. A test key (OpenRouter) is on the VM at `%USERPROFILE%\.harness-test\openrouter.key`, owner-only: Task 2 probes the real runtime, Tasks 15-17 build on its notes, and the real-engine checks run on the VM (Verification 6); the key file is deleted after them (Verification 11). The key's use and rules: The VM.
6. The narrow subcommand comes only above 50 ms (p50) added to a hook: Task 33 decides, Task 36 builds it.
7. WezTerm, Warp and Alacritty are raised too: Tasks 1, 27, 30, confirmed at the VM's console by Task 37 (Task 38 if it differs).
8. The pid proof: the cheap check per call, the table's proof on a record change, after a connection error or every 60 s: Tasks 4, 6.

Answered 2026-11-20, after Task 1:

9. The Dell's `COM3`: the run stops the owner's Harness daemon and starts it again as before, in the console session, then checks it runs and holds `COM3`: The Dell; Verification 14, 18.
10. The Dell's session: the owner's console session through `schtasks /it` under the owner's account, with the run's own data folder; no test user there: The Dell; Task 24 (`console.ps1`).
11. Ken presses and speaks into the real dial, from one short list for one sitting; the dial's settings are written only if read first, written back exactly and checked: Task 24; Verification, "Ken's list".
12. Task 30's panel hint stays: only with `VSCODE_PID`, within a timeout, its answer kept per editor; Task 33 measures it: Tasks 30, 33.
13. Cursor: PATH and the per-user folder only: Task 12.
14. Task 37 needs no person: the agent signs the test user in by autologon, restarts the VM, installs the Store apps with winget in that session, reads the window owners itself, and removes the autologon values after: The VM; Task 37.

Answered 2026-11-20, after Task 2's stop:

15. On Windows Claude Code's mod goes through the CLI: `harness device claude inbox` (one long-lived process per session if `$.process.spawn` streams, else one run per poll) and `harness device claude attach`; the CLI does the pipe auth, no token enters the mod, nothing new in the core, macOS and Linux unchanged; the idle CPU and memory with 1 and 3 sessions go in the pull request; a bounded restart. Tasks 15, 16, 39; Verification 6, 8, 9.

## Open questions

None.

## Review Focus

1. **A crashed devices process whose pid was given to another process.** The client dials nothing and `link` says `devicesReady: false`. Inside the minute a proof is held, the reused pid passes the cheap check: the one send fails (nothing listens, or the answer has no proof) and the next call proves by the table and dials nothing. Tests: Task 4 (`devicesPipe`, a row that started after the record; the pid proof), Task 6 (a failed connection proves again), Task 7.
2. **Something else answers on the recorded pipe name** (a 200 with a body and no proof, or a wrong proof). `tellDevices` is false, `askDevices` null, the extension and the plugin drop the answer unread, and the token appears in no log line. Tests: Tasks 6, 8, 9, 15.
3. **A profile path with spaces, Vietnamese letters, `'`, `&` and `%`** (`C:\Users\Nguyễn Văn A' & 100%`). Every argument stays one argument, the launcher is found, the record path is absolute. Tests: Tasks 10, 8, 23.
4. **`claude` on PATH is the Claude desktop app's `Claude.exe`** (it answers `--version` without "Claude Code", and `--help` opens its window). The plugin's runner refuses it after one `--version` and runs nothing more. Test: Task 13.
5. **An app that changed under Harness** (a later VS Code or Cursor whose launcher changed shape, a VS Code update that renamed its commit folder, an Orca whose `orca.exe` moved). A launcher of another shape is refused by name and the setup counts a failure; a renamed commit folder is read anew at the next start; an Orca with no `orca.exe` is not found. Nothing falls back to `cmd.exe`, and `orca.cmd` is never run. Tests: Tasks 10, 12, 20, 21.
6. **Claude Code reloads the mod, quits or crashes while its `harness` process holds a poll** (Windows). Claude Code kills `harness.exe`, and its `node.exe` may run on. The orphan ends before its next poll (its parent is gone) or at its next write, a newer follower's poll ends its hold at once, and no session is left with two followers or none. Tests: Task 15 (parent gone; a failed write; no poll after either), Task 16 (one follower per session; the restart's bound); seen on the VM in Verification 6.

## The VM

- UTM Windows 11 ARM64: `utmctl start Windows`, then `ssh admin@192.168.64.5` (key auth). x64 runs on windows.yml as planned, and on the Dell (below) for the checks that need real x64 hardware or the real dial.
- Copy the tree with `VM_SSH=admin@192.168.64.5 cli/scripts/windows-pty-e2e/vm-sync.sh --cli` (to `C:/work/oh`). Build the host there: `cd /d C:\work\oh\pty && cargo build --release --bins`.
- **Isolation**: an owned test user, made and driven by `desktop/scripts/windows-e2e/desktop-e2e.sh` with `VM_HOST=192.168.64.5` (`preflight`, `user-add`, `session-on`, `run`, `ps`, `shot`, `cleanup`; its README). Everything is that user's: profile, `.harness`, `.claude`, `.codex`, and the apps installed for it alone. The daemon runs from the branch's build with `PORT=18478`, signed out (`BACKEND_WS_URL=ws://127.0.0.1:9`, `WEB_URL=http://127.0.0.1:9`), `ADAPTER_UPDATE_DISABLE=true`, `DISABLE_GRID_INSTALL=true`, `HARNESS_PTY_BIN` the VM's build. Never the `admin` user's engines, apps or sign-ins, never production.
- **The dial** on the VM is the stand-in (Tasks 22-24). The real dial is the Dell's (below).
- **Windows a person would see** are checked in the test user's desktop session, never over SSH (session 0): `desktop-e2e.sh run watch-windows.ps1` records every window shown. The test user (`hxdialwin`) must be signed in at the VM's console. The agent does that itself, as below.
- **Signing the test user in** (the agent, no person; Task 37 first, and any later VM task whose `desktop-e2e.sh session-on` finds no session). Over SSH as `admin`, the agent reads `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`'s `AutoAdminLogon`, `DefaultUserName`, `DefaultDomainName` and `DefaultPassword` (whether each exists, and the first three's values). It sets `AutoAdminLogon=1`, `DefaultUserName=hxdialwin`, `DefaultDomainName` the VM's name, and `DefaultPassword` the user's password from `desktop-e2e.sh`'s `$E2E_WORK/users.txt`. The password goes to a PowerShell on the VM on its stdin (`Set-ItemProperty` from `[Console]::In.ReadLine()`), and is never on a command line, printed, logged, in the notes or committed. Then `shutdown /r /t 0`, and the agent waits for SSH, at most 5 minutes (a stop condition) before `desktop-e2e.sh session-on`. As soon as the session is up, it puts the four values back as they were read (`DefaultPassword` deleted unless it was there) and reads them again to check. The session stays signed in until the next restart. The notes say each time that autologon was set and removed.
- **Console steps** (Task 37; Task 1 could not do them over SSH), all the agent's, in that session: the Claude and ChatGPT apps installed for `hxdialwin` with `winget install --source msstore --accept-package-agreements --accept-source-agreements <id>`. Each runs as a one-shot interactive task under that user (`schtasks /create /it /ru hxdialwin … /run`, which `desktop-e2e.sh run` does through `session-run.ps1` with no stored password). The window owners are read by the agent in that session (`EnumWindows` and `GetWindowThreadProcessId`, then the owner's image name: `app-processes.ps1` and `watch-windows.ps1`), with a screenshot (`desktop-e2e.sh shot`) only when a window's owner is in doubt. The shells of Cursor's extension host, WezTerm, Warp and Alacritty are read there too.
- **The test key** (for Claude Code and Codex, so hooks, the mod and skills fire): an OpenRouter key the main session puts in `%USERPROFILE%\.harness-test\openrouter.key`, owner-only. The engines run as the test user, and an owner-only file in `admin`'s profile is closed to it, so `%USERPROFILE%` here is the test user's profile and the file is that user's alone. The main session places it there after `user-add`. The plan and every brief name only that path. **The key is never printed, echoed, logged, written to another file, put on a command line, in the notes, a commit or the pull request.** A shell that starts an engine reads the file into that process's own environment and starts the engine from it:
  - Claude Code (`<profile>\.local\bin\claude.exe`, which its installer leaves off PATH: started by that path): `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN` read from the file, `ANTHROPIC_API_KEY` empty, a cheap model (`ANTHROPIC_MODEL`, named in the notes by its name alone), and `CLAUDE_CONFIG_DIR` a throwaway folder in the test user's profile.
  - Codex: `CODEX_HOME` a throwaway folder whose `config.toml` names a `model_provider` for OpenRouter with `env_key` (the variable's name, never its value), a cheap model, and that variable read from the file.
  - Harness: the desk's isolated data folder (Task 24, `%USERPROFILE%\.harness-dial-check`), never a person's accounts, homes or data.
  - A transcript, a screenshot or a log that could hold the key is checked before it is copied off the VM; none goes in the notes.
- One test user serves every VM task. The last VM check runs `cleanup`, then the key file is deleted (Verification 11).

## The Dell

- A real Windows 11 x64 PC (a Dell laptop) with a real Harness dial on `COM3`, reached over SSH (key auth) at the address and with the account its owner gives. Both are in the brief and never written in the repo; here the account is "the owner's account". `desktop-e2e.sh` runs with `VM_HOST` and `VM_ADMIN` set to them (its README, "the x64 test PC"). One tester at a time: the main session hands the Dell out as it hands out the VM.
- It is someone's machine. The run uses or changes nothing of the owner's (Claude Code, Codex, apps, homes, sign-ins, Harness data), with one exception: the owner's Harness daemon is stopped and started again, as below. The run touches only what it installs, and removes it after.
- **The session.** Every step that needs the desktop (the desks, the shells in WezTerm and Alacritty, `watch-windows.ps1`, screenshots) runs in the owner's console session, as a one-shot `schtasks /it` task under the owner's account (Task 24's `console.ps1`). SSH is session 0 and runs only what needs no desktop (`serial-check.ps1`, copying files, reading logs). No test user is made on the Dell, so `desktop-e2e.sh user-add`, `session-on`, `run` and `shot` are not used there.
- **Isolation.** The run has its own data folder and homes: Task 24's desks, sealed as Task 23 seals its daemon. That is a throwaway root under the run's folder holding `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, the data folder and the engine homes, with `CLAUDE_PATH`, `CODEX_PATH`, `HARNESS_VSCODE_BIN` and `HARNESS_CURSOR_BIN` naming nothing and `DISABLE_HOOK_INSTALL=true`, so the devices set nothing up in the owner's homes. Ports 18478 and 18479, never 18473. `CABLE_FW_DISABLE=true`: the dial's firmware is never flashed. A real-dial desk is signed in to nothing but a `FakeBackend` on 127.0.0.1 (`cli/e2e/harness/fakeBackend.ts`, as `deviceHerdr.e2e.ts` uses it), which answers each recording with the desk's `--speech` text: no account, no production.
- **The builds**: the x64 payload artifact of the branch's windows.yml run (`gh run download`: `harness-pty.exe`, `harness.exe`, `harness-serial.exe` and the rest), and the CLI tree copied with `VM_SSH=<the Dell> VM_DIR=<a folder of the run's> cli/scripts/windows-pty-e2e/vm-sync.sh --cli`, then `npm ci` there with the Dell's Node. No toolchain is installed on the Dell.
- **What the run installs**, all inside its folders and gone with them: the builds above, herdr's release `herdr.exe` (started with the root's `APPDATA`, so its marker and pipe are the root's), and the portable WezTerm and Alacritty (the zip and the `.exe`, as Task 1 placed them on the VM).
- **The owner's daemon, stopped and restored**, in this order, each through `console.ps1`:
  1. `harness status` as the owner's account: the run keeps "running" or "stopped" and the version, and nothing else (no pid, machine id or path).
  2. If it runs: `harness stop`. Then `desk.mts --dial-read COM3 --out <run folder>\first-read.json` must open the port (exit 0); this is the first read. Exit 3 (busy) means something took `COM3` again, perhaps the owner's Harness Desktop starting its daemon: a stop condition. The run closes nothing of the owner's.
  3. After the run's last check on `COM3` (Verification 18): `harness start`, in the console session, never from SSH. Then `harness status` says running at the version kept in 1, and `desk.mts --dial-read COM3 --out <run folder>\held.json` exits 3 and writes nothing (the owner's daemon holds the port). Either one failing is a stop condition, and is reported as such.
  4. A daemon that was stopped in 1 is not stopped or started. Step 2's look is still taken, and the run checks at the end only that `COM3` is free.
  The evidence says, in these words or close: "the owner's Harness daemon was running at <version>; stopped for the run; started again; running at <version> and holding COM3".
- **The dial, left as found** (Task 24). The first `--dial-read` (step 2 above) is kept in the run's folder (owner-only, deleted at clean up). It holds the dial's settings and how many custom pets it holds, and no serial or mac. A dial that holds a custom pet stops the run before any desk starts. Each desk compares the dial's settings at its `quit` with that first read, and writes them back and checks them when they differ. A last `--dial-read` before the owner's daemon starts again shows the settings equal to the first read.
- **Ken** presses and speaks into the dial, and nothing else: the steps in Verification, "Ken's list", in one sitting. The run does every other step.
- **Evidence**: serials shortened, as `serial-check.ps1` and the desk do; native diagnostics redacted. Nothing with a full serial, the owner's account name or a personal path leaves the Dell. Screenshots are checked before they are copied off.
- **Clean up**, last: stop the desks, run `harness stop` on each root, end what is left of the run's processes by root, delete the roots and the first read, and run `desktop-e2e.sh cleanup` for its admin scratch folder. Nothing then listens on 18478 or 18479, and the owner's daemon is restored (step 3 above).

---

### Task 1: VM probe: launchers, apps, herdr

**Files:**
- Create: `cli/src/lib/windows/fixtures/code.cmd`, `cursor.cmd`, `orca.cmd` (the real launchers, byte for byte; `.gitattributes` keeps `*.cmd` CRLF, as `npm-codex.cmd` beside them)
- Create: `docs/plans/2026-11-19-dial-windows-vm-notes.md`, section `## Task 1`

**Depends on:** none. **Effort:** high. **Red test:** none; one commit.

- [ ] **Step 1:** Start the VM and make the test user (The VM).
- [ ] **Step 2:** Install for that user: VS Code (user installer), Cursor, Orca, herdr 0.9.5, Claude Code, Codex (npm), WezTerm, Warp, Alacritty, and the Claude and ChatGPT desktop apps where an ARM64 or emulated build installs. An app that cannot be installed is written down as that, with what was tried. Claude Code and Codex are installed, and not signed in to any account (Task 2 starts them with the test key).
- [ ] **Step 3: Write the notes**, one heading each:
  1. **Launchers**: the path and whole text of `code.cmd`, `cursor.cmd` and `orca.cmd`, and each app's `.exe` and CLI script as the launcher names them. Copy the three files into the fixtures.
  2. **Install folders** of each app (per-user and machine), and whether its `bin` folder is on the user's PATH.
  3. **`claude` and `codex`**: `where claude`, `where codex`; whether each is an `.exe` or an npm shim, and the shim's text.
  4. **The ChatGPT app**: its program's name; whether its install holds a `codex` of its own, and where; whether a thread started in the app takes `codex queue` from the PATH `codex`. If it takes it only from the app's own copy, say so first in the section (a stop condition).
  5. **Program names** of the running apps, from `harness-pty ps --json`: VS Code, Cursor, Orca, the Claude app, the ChatGPT app, WezTerm, Warp, Alacritty. For each, the program that owns its visible top-level window (WezTerm's may be `wezterm-gui.exe`, not `wezterm.exe`).
  6. **Environment names** set in an integrated terminal of VS Code and of Cursor, and in the process of Claude Code's VS Code extension, that name the editor (`TERM_PROGRAM`, `VSCODE_GIT_ASKPASS_NODE` and the like), with the shape of each value. The same in a shell of WezTerm, Warp and Alacritty: whether WezTerm sets `WEZTERM_PANE`, whether Warp sets `TERM_PROGRAM=WarpTerminal`, and which variable, if any, only Alacritty sets. Names and shapes only.
  7. **herdr**: its version; where its marker file is by default and with `XDG_CONFIG_HOME` set; the pipe it listens on (list `\\.\pipe\`), and the mapping in herdr's `src/ipc.rs` quoted with its commit; `agent.list` answered over that pipe by a line client.
  8. **Link handlers**: whether `HKCU\Software\Classes\{vscode,cursor,claude,codex}` exist (read only).
  9. **Orca's plugin tools**: whether `orca plugin test` and `orca plugin check` exist in Orca for Windows.
- [ ] **Step 4: Commit** `Windows launchers as a real install has them: fixtures and notes`.

**Landed** (`94e4b5317a`). What it could not do over SSH (session 0) moved to Task 37, a console step: the Claude and ChatGPT apps (items 2, 4: an MSIX and a Store app install only in an interactive logon, so the ChatGPT stop condition is undecided), the program that owns each app's visible window (item 5), and the shells of Cursor's extension host, WezTerm, Warp and Alacritty (item 6). Its findings changed Tasks 10, 12, 13, 20, 21, 24, 26, 27, 30 and 36 (each says "Since Task 1").

### Task 2: VM probe: Claude Code's mod runtime and hook runner

**Files:**
- Modify: `docs/plans/2026-11-19-dial-windows-vm-notes.md`, section `## Task 2`

**Depends on:** 1 (the engines installed for the test user; the notes are one file). The test key is on the VM (The VM). **Effort:** high. **Red test:** none; one commit.

- [ ] **Step 1:** In the test user's session, start Claude Code (by `<profile>\.local\bin\claude.exe`: not on PATH, Task 1 §3) (and, for item 5, Codex) with the test key as The VM says, never a person's account, from a throwaway home. Start `cli/scripts/windows-pipe-test-server.ts` on a throwaway data folder (it serves the daemon's own authenticated pipe and a squatter). Load a throwaway mod from a folder outside the repo (never committed).
- [ ] **Step 2: Find out, and write each with the evidence:**
  1. Whether `$.http.fetch(url, { socketPath: '\\\\.\\pipe\\harness-<id>', headers })` reaches the pipe, and whether the answer gives its status, its text and its `x-harness-proof` header.
  2. Which HMAC-SHA256 the runtime has (`crypto.subtle`, `node:crypto`, neither), and where 16 random bytes come from. Check the result against the first vector of `pipe-auth-vectors.json`.
  3. How the mod tells it runs on Windows, and whether `$.env.get('USERPROFILE')`, `$.process.run([<absolute harness.exe>, …])` and `$.fs.read(<%USERPROFILE%\.claude\settings.json>)` work. Whether `$.process.run` flashes a window (`watch-windows.ps1`).
  4. How Claude Code runs a plugin's `command` hook: the exact command line with Git Bash installed and without it (from `harness-pty ps --json`); whether `${CLAUDE_PLUGIN_ROOT}` expands in both; whether a plugin's `hooks.json` takes the exec form (`command` with `args`); whether a window flashes in either.
  5. How Codex runs a hook on Windows (the runner's command line from `harness-pty ps --json`, for Task 31's shells), with the test key and a throwaway `CODEX_HOME`.
  6. The cheap models used, by name, and that the notes do not hold the key: `findstr /L /M /G:<the key file> <the notes>` prints nothing (the search reads the key from its file, so it is on no command line).
- [ ] **Step 3: Stop condition.** If 1 or 2 cannot be done, write that first in the section, report `stop: mod runtime`, and end. Tasks 15 and 16 do not start.
- [ ] **Step 4: Commit** `Claude Code's mod runtime and hook runner on Windows: notes`.

**Landed** (`118ff8f075`), with its stop hit: `$.http.fetch` refuses every pipe path in `socketPath` (inside Claude Code), and `crypto.subtle` has no HMAC. Tasks 15 and 16 were rewritten for the orchestrator's answer (the mod goes through the CLI), and Task 39 added. Its findings on the permission hook (§4) bear on Task 17.

### Task 3: A token file by name

**Files:**
- Modify: `cli/src/lib/windows/pipeAuth.ts:136-243` (`daemonTokenPath`, `readDaemonToken`, `publish`, `ensureDaemonToken`)
- Test: `cli/src/lib/windows/daemonToken.spec.ts`

**Depends on:** none. **Effort:** xhigh (a file the core loads).

**Interfaces (produces):**
- `daemonTokenPath(dataDir: string, name: string = DAEMON_TOKEN_FILE): string`
- `readDaemonToken(dataDir: string, name: string = DAEMON_TOKEN_FILE): Buffer | null`
- `ensureDaemonToken(dataDir: string, name: string = DAEMON_TOKEN_FILE): Buffer`
- The temp file is `.<name>.<pid>.<random>`; the error names the file it could not read. Nothing else changes: one way to make a token.

- [ ] **Step 1: Write the failing tests** in `describe('the daemon token')`:
  - `it('makes a token under another name, beside the daemon\'s')`: `ensureDaemonToken(dir, 'devices-token')` returns 32 bytes; `devices-token` holds 64 hex digits and a newline, mode 0600; `daemon-token` does not exist; `readDaemonToken(dir)` is null and `readDaemonToken(dir, 'devices-token')` equals the token.
  - `it('keeps the two tokens apart')`: after both are made they differ, and a second `ensureDaemonToken(dir, 'devices-token')` returns the same bytes.
  - `it('refuses a named token that is a link')`: `devices-token` as a symlink to a 65-byte file: `readDaemonToken(dir, 'devices-token')` is null and `ensureDaemonToken(dir, 'devices-token')` throws a message holding `devices-token`.
  - `it('leaves no temp file of a named token')`: no entry of `dir` starts with `.devices-token.`.
- [ ] **Step 2:** `cd cli && npx vitest run src/lib/windows/daemonToken.spec.ts` — FAIL (the second argument is ignored). Commit red.
- [ ] **Step 3: Implement** the three signatures. Every existing call passes no name and behaves as before.
- [ ] **Step 4:** the same run passes with every existing case untouched; `npx vitest run src/lib/windows/pipeAuth.spec.ts src/architecture.spec.ts` and `npm run typecheck` pass.
- [ ] **Step 5: Commit** `A pipe token is made under the file name its owner gives`.

### Task 4: The devices' record, target and pid proof

**Files:**
- Create: `cli/src/devices/listenerPipe.ts`, `cli/src/devices/listenerPipe.spec.ts`
- Modify: `cli/src/devices/listenerPath.ts`, `cli/src/devices/listenerPath.spec.ts`

**Depends on:** 3. **Effort:** xhigh.

**Interfaces (produces):**
- `listenerPipe.ts`:
  - `DEVICES_TOKEN_FILE = 'devices-token'`, `DEVICES_RECORD_FILE = 'devices.json'`, `interface DevicesRecord { pipe: string; pid: number }`
  - `devicesRecordPath(dataDir: string): string`
  - `readDevicesRecord(dataDir: string, platform?: NodeJS.Platform): DevicesRecord | null` — null for no file, more than 4096 bytes, no JSON object, a pipe `isPipePath` refuses, or a pid that is not a positive safe integer.
  - `writeDevicesRecord(dataDir: string, record: DevicesRecord): void` — `{"pipe":…,"pid":…}\n` to a temp file beside it (0600), renamed into place; throws when it cannot.
  - `removeDevicesRecord(dataDir: string, pipe: string): void` — removes the file only while it names `pipe`; never throws.
  - `PROOF_MAX_AGE_MS = 60_000`
  - `interface DevicesProof { pipe(dataDir: string): Promise<PipeTarget | null>; forget(dataDir: string): void }`
  - `createDevicesProof(options?: { liveness?: HostLiveness; now?: () => number }): DevicesProof` — the default liveness is the daemon pipe's: `pidAlive`, and the Windows process table loaded when asked. `pipe(dataDir)`:
    1. reads the record and `devices-token`; either missing: null;
    2. `liveness.alive(record.pid)` on every call; false: forget, null;
    3. a proof held for this data folder with the same `pipe`, `pid` and record mtime, younger than `PROOF_MAX_AGE_MS`: the target, with no table read;
    4. else `recordedProcessDead(devicesRecordPath(dataDir), pid, liveness)`: dead, forget and null; alive, hold `{ pipe, pid, mtimeMs, provenAt: now() }` and answer the target.
    `forget(dataDir)` drops what is held for that folder. At most one proof is held per data folder.
  - `devicesProof: DevicesProof` — this process's one, `createDevicesProof()`.
  - `devicesPipe(dataDir: string, proof: DevicesProof = devicesProof): Promise<PipeTarget | null>` — `proof.pipe(dataDir)`.
- `listenerPath.ts`: `type DevicesTarget = { socket: string } | PipeTarget`; `devicesTarget(dataDir: string, options?: { platform?: NodeJS.Platform; home?: string; proof?: DevicesProof }): Promise<DevicesTarget | null>` — on Windows `devicesPipe(dataDir, proof)`, elsewhere `{ socket: devicesListenerPath(…) }` or null. `devicesListenerPath` is unchanged.

- [ ] **Step 1: Write the failing tests** (the pipe is a path `<tmp>/harness-<32 hex>`, which `isPipePath` takes off Windows):
  - `listenerPipe.spec.ts`:
    - write then read gives the record; the file is 0600 and no temp file is left;
    - read is null for: no file; `{}`; a pid of `0`, `1.5` and `"7"`; a 5,000-byte file; with `platform: 'win32'`, `\\\\server\\pipe\\harness-<id>` and a plain file path;
    - read takes `\\\\.\\pipe\\harness-<32 hex>` with `platform: 'win32'`;
    - remove deletes a record naming the pipe, leaves one naming another pipe, and does not throw with no file;
    - `devicesPipe` gives `{ pipe, token }` equal to `readDaemonToken(dir, 'devices-token')` with a proof made of `{ alive: () => true }`;
    - `devicesPipe` is null with: no record; only `daemon-token` in the folder; `{ alive: () => false }`; and a table row for the recorded pid whose start marker is 60 s after the record's mtime (Review Focus 1).
  - `listenerPipe.spec.ts`, `describe('the pid proof')`, with a counted `rows` (a live row for the recorded pid), a counted `alive` and a fake `now`:
    - `it('reads the table once for many calls')`: ten `pipe(dir)` calls inside 60 s give the target each time; `rows` ran once, `alive` ten times;
    - `it('proves again after a minute')`: a call at `PROOF_MAX_AGE_MS` after the proof reads the table again;
    - `it('proves again when the record changes')`: a record rewritten with another pipe, another pid, or the same content and a later mtime reads the table on the next call;
    - `it('proves again after forget')`: `forget(dir)`, then a call reads the table;
    - `it('drops the proof when the pid is gone')`: `alive` false gives null without a table read, and the next call with `alive` true reads the table;
    - `it('holds a proof per data folder')`: two folders each read the table once; forgetting one leaves the other's proof;
    - a table that cannot be read (`rows` rejects) is no proof of death, as `recordedProcessDead` reads it: the target, and the next call reads the table again.
  - `listenerPath.spec.ts`: `devicesTarget(dir, { platform: 'linux' })` is `{ socket: devicesListenerPath(dir, 'linux') }`; with `platform: 'win32'` and a record and token it is the pipe target, and null without them.
- [ ] **Step 2:** `npx vitest run src/devices/listenerPipe.spec.ts src/devices/listenerPath.spec.ts` — FAIL (no module). Commit red.
- [ ] **Step 3: Implement** as in Interfaces. Comment why the liveness is copied (`daemonPipe.ts` is the core's and keeps its own), and why the table's proof is held for a minute (the watch's `front`/`tab` tells, up to 10 a second, would each start the pty host; the HMAC proof still guards every answer).
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `The devices' pipe is found by its record, proven by its own token, and its process checked cheaply between table reads`.

### Task 5: The listener serves the pipe

**Files:**
- Modify: `cli/src/services/devicesListener.ts:87-135,337-358` (options, the open, the close)
- Modify: `cli/src/services/devicesProcess.ts:48-56,221`
- Test: `cli/src/services/devicesListener.spec.ts`, `cli/src/services/devicesProcess.spec.ts`

**Depends on:** 3, 4. **Effort:** xhigh.

**Interfaces:**
- Consumes: `ensureDaemonToken(dataDir, DEVICES_TOKEN_FILE)`, `writeDevicesRecord`, `removeDevicesRecord`, `newPipePath()`.
- Produces: `DevicesListenerOptions.pipe?: { path: string; dataDir: string }`. Given, the listener:
  1. ensures the token, which checks the folder as the daemon's token does (inside the profile, the file no link: `secureStateDirectory`, `requireWindowsStateFile`); a throw logs `[devices] listener not opened · token` and answers null;
  2. serves `listenLocalSocket(onRequest, pipe.path, { token })`, with every limit set as on the socket; errors log `· in use` or `· failed` as today;
  3. writes the record `{ pipe: pipe.path, pid: process.pid }`; a throw closes the server, logs `[devices] listener not opened · record` and answers null;
  4. on close, removes the record after it stops listening.
  The Unix folder check runs only without `pipe`. The `platform` option goes: a null path with no pipe logs `· no path` everywhere.
- `DevicesServiceOptions.platform?: NodeJS.Platform` (tests); `listen` passes `pipe: platform === 'win32' ? { path: newPipePath(), dataDir } : undefined`.

- [ ] **Step 1: Write the failing tests**
  - `devicesListener.spec.ts`, `describe('over a pipe')`:
    - open makes `devices-token` and a `devices.json` naming the path and `process.pid`, and logs `[devices] listener open`;
    - a request with no `x-harness-auth`, with another token's auth, and a replayed nonce each get 401 `{"error":"PIPE_AUTH_REQUIRED"}`, and the handler is not called;
    - a request with `pipeAuthValue(token, newPipeNonce(path))` is handled, and its answer carries `x-harness-proof` equal to `pipeProofValue(token, nonce)`;
    - a `tabs` stream writes its NDJSON lines; a type sent past its rate gets 429, as on the socket;
    - close removes `devices.json` and keeps `devices-token`; a record naming another pipe is left;
    - `devices-token` as a symlink: null, `· token`, no record;
    - `devices.json` as a folder: null, `· record`, and a second open on the same path then succeeds (the server closed).
  - `devicesProcess.spec.ts`: with `platform: 'win32'` the stubbed `openListener` gets `pipe.path` matching `^\\\\\.\\pipe\\harness-[0-9a-f]{32}$` and `pipe.dataDir` the data folder; with `'darwin'` it gets `pipe` undefined.
- [ ] **Step 2:** `npx vitest run src/services/devicesListener.spec.ts src/services/devicesProcess.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.** Update the file's header comment: who may connect on Windows.
- [ ] **Step 4:** the run passes; `npm run test:core` passes with both files at 100%; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `On Windows the devices listen on a pipe of their own, with their own token and record`.

### Task 6: Clients send over the pipe

**Files:**
- Modify: `cli/src/devices/listenerClient.ts` (the three sends), `cli/src/devices/client.ts:214` (`listening`)
- Test: `cli/src/devices/listenerClient.spec.ts`, `cli/src/devices/client.spec.ts`
- Create: `cli/src/devices/listenerPipe.windows.real.spec.ts`
- Modify: the notes, section `## Task 6`

**Depends on:** 4, 5. **Effort:** xhigh.

**Interfaces:**
- Consumes: `devicesTarget`, `DevicesProof` and `devicesProof` (Task 4), `fetchOverPipe(() => target)`, `fetchOverSocket(path)`.
- Produces: `tellDevices`, `askDevices` and `streamDevices` keep their signatures and their "false or null, never a throw". Each takes `options.proof?: DevicesProof` (tests; this process's `devicesProof` by default). A send over a pipe that fails to connect, or whose answer is dropped for a missing or wrong proof, calls `proof.forget(dataDir)`, so the next call proves by the table. In `client.ts`, `listening` is also true on Windows, where a record may appear at any time.

- [ ] **Step 1: Write the failing tests**
  - `listenerClient.spec.ts`, `describe('over a pipe')`, against a real `listenLocalSocket(handler, <tmp>/harness-<id>, { token })` with the record and `devices-token` in a temp data folder, `platform: 'win32'`, `proof: createDevicesProof({ liveness: { alive: () => true, rows: <counted, a live row> } })`:
    - `tellDevices` is true and the server saw the message; `askDevices` gives the object; `streamDevices` hands on each chunk and is true at the end;
    - `it('twenty tells read the table once')`: twenty `tellDevices` in a row are true, and `rows` ran once;
    - `it('a failed connection proves again')`: the server closed, one `tellDevices` is false; the server opened again on the same name, the next `tellDevices` reads the table before it connects;
    - no record: false, null, false, and nothing connects;
    - `alive: () => false`: the same, and the server saw no connection;
    - a plain HTTP server on that name answering 200 with a body and no proof: false, null, false (Review Focus 2), and the next call reads the table again;
    - another token in `devices-token` than the server's: false, null, false.
  - `client.spec.ts`: on Windows the watch opens the `tabs` stream and retries it, as on Unix.
  - `listenerPipe.windows.real.spec.ts`, `describe.runIf(process.platform === 'win32')`: `openDevicesListener({ pipe: { path: newPipePath(), dataDir }, … })` on a real pipe, then `tellDevices`, `askDevices` and `streamDevices` succeed; a raw request with no auth and one with a wrong token get 401; after close `devices.json` is gone and `tellDevices` is false.
- [ ] **Step 2:** `npx vitest run src/devices/listenerClient.spec.ts src/devices/client.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.** Update the file's header comment.
- [ ] **Step 4:** the run passes; `npm run typecheck` passes. On the VM: `npx vitest run src/devices/listenerPipe.windows.real.spec.ts --maxWorkers=1`; write its result in the notes, with the time of one `tellDevices` that reads the table and one that does not (median of 20 each).
- [ ] **Step 5: Commit** `harness device notify and the watch reach the devices over their pipe on Windows`.

### Task 7: `link` for Orca and VS Code

**Files:**
- Modify: `cli/src/deviceClaude/command.ts:438-448` (`devicesLink`), its header comment
- Test: `cli/src/deviceClaude/command.spec.ts`

**Depends on:** 4. **Effort:** xhigh.

**Interfaces:**
- Consumes: `daemonPipe(dataDir, port)`, `askDataFolderServer(pipe, 1_000, token)`, `devicesPipe(dataDir)`, `devicesRecordPath(dataDir)`.
- Produces, on Windows, one JSON line with keys in this order:
  - ready: `{ daemon, devicesPipe, devicesToken, devicesReady: true, devicesRecord }` (`devicesToken` is 64 hex digits);
  - not ready: `{ daemon, devicesReady: false, devicesRecord }`.
  `DeviceDeps.pipes?: { daemon(dataDir, port): Promise<PipeTarget | null>; devices(dataDir): Promise<PipeTarget | null>; answers(target: PipeTarget): Promise<boolean> }` for tests.

- [ ] **Step 1: Write the failing tests** in `command.spec.ts`, for `orca link` and `vscode link` with `platform: 'win32'`:
  - both pipes there and the daemon answering: the exact ready line, exit 0, nothing on stderr;
  - no devices pipe: the not-ready line, with `devicesRecord` equal to `join(dataDir, 'devices.json')`;
  - no daemon pipe, and a daemon pipe that does not answer: `daemon` false;
  - the existing macOS and Linux cases unchanged.
- [ ] **Step 2:** `npx vitest run src/deviceClaude/command.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `link names the devices' pipe, its token and its record on Windows`.

### Task 8: The VS Code extension on Windows

**Files:**
- Create: `plugins/harness-device-vscode/src/pipeAuth.ts`, `pipeAuth.test.ts`
- Modify: `plugins/harness-device-vscode/src/inputs.ts`, `loop.ts`, `wire.ts` and their `*.test.ts`
- Modify: `plugins/harness-device-vscode/README.md`

**Depends on:** none. **Effort:** xhigh.

**Interfaces (produces):**
- `pipeAuth.ts` (Node 16: `createHmac`, `randomBytes`, `timingSafeEqual` only):
  - `PIPE = /^\\\\\.\\pipe\\harness-[0-9a-f]{32}$/`, `TOKEN = /^[0-9a-f]{64}$/`
  - `pipeNonce(pipe: string, random?: (bytes: number) => Buffer): string`
  - `pipeAuth(token: string, nonce: string): string` (the header's value)
  - `pipeProven(proof: unknown, token: string, nonce: string): boolean`
- `inputs.ts`: `type Target = { socket: string } | { pipe: string; token: string }`; `connect(target: Target, body, signal)` and `post(target: Target, body, signal)`. For a pipe they send the auth, and an answer without the right proof is destroyed and settles null before a chunk is handed on. `run` passes `windowsHide: true`.
- `loop.ts`: on Windows the launcher is `<home>\.harness\bin\harness.exe`, then `harness` on PATH (paths by `path.win32` there). `readLink` also takes the Windows line: `devicesPipe` matching `PIPE`, `devicesToken` matching `TOKEN`, an absolute `devicesRecord`, a boolean `devicesReady`; anything else is null. Unplugged, it watches the record's folder for `devices.json`. `startLoop` and `wire` refuse only a remote window.

- [ ] **Step 1: Write the failing tests**
  - `pipeAuth.test.ts`: for each vector of `cli/src/lib/windows/__fixtures__/pipe-auth-vectors.json`: `pipeAuth(token, nonce) === auth`; `pipeProven(proof, token, nonce)`; `pipeNonce(pipe, () => Buffer.from(nonceTail, 'hex')) === nonce`; a proof with one digit changed, `undefined` and `'zz'` are not proven.
  - `inputs.test.ts`, against a server that checks the auth and answers with the proof: `connect` gives 200 and its chunks, `post` its status; a server answering with no proof or a wrong one gives null and no chunk. The servers listen on `\\.\pipe\harness-<32 hex>` on Windows and under `/tmp` elsewhere, so the file runs on windows.yml.
  - `loop.test.ts`, `platform: 'win32'`, home `C:\Users\Nguyễn Văn A' & 100%`:
    - it runs `<home>\.harness\bin\harness.exe` first, then `harness`;
    - a ready Windows line connects with `{ pipe, token }`, and a `show` line shows the terminal;
    - `readLink` is null for: a pipe on another host (`\\\\srv\\pipe\\harness-…`); a token of 63 digits or with an upper-case digit; a relative `devicesRecord`; a ready line with no token;
    - unplugged, the watch is on `dirname(devicesRecord)` and a `devices.json` entry asks again;
    - no logged line holds the token.
  - `wire.test.ts`: on Windows the loop starts; in a remote window it does not.
- [ ] **Step 2:** `cd cli && npx vitest run plugins/harness-device-vscode/src` — FAIL. Commit red.
- [ ] **Step 3: Implement.** README: drop "or on Windows", name the Windows launcher path.
- [ ] **Step 4:** the run passes; `npx vitest run src/devices/vscodeExtensionBundle.spec.ts src/devices/vscodeExtensionTypes.spec.ts` and `npm run typecheck` pass.
- [ ] **Step 5: Commit** `Harness's VS Code extension reaches the devices over their pipe on Windows`.

### Task 9: The Orca plugin on Windows

**Files:**
- Create: `plugins/harness-device-orca/src/pipeAuth.ts`, `pipeAuth.test.ts`
- Modify: `plugins/harness-device-orca/src/inputs.ts`, `dial.ts`, `panel.tsx`, `protocol.ts` and their tests
- Modify: `plugins/harness-device-orca/README.md`

**Depends on:** none. **Effort:** xhigh.

**Interfaces (produces):** the same `pipeAuth.ts` and `Target` as Task 8, a copy of the plugin's own (it imports nothing of the CLI or the extension). `dial.ts` starts on Windows, finds the launcher and reads `link` as Task 8's loop does, and watches the record's folder. `DialState['state']` loses `'windows'`, and `panel.tsx` loses its line.

- [ ] **Step 1: Write the failing tests** (`orca/testing`), mirroring Task 8's: `pipeAuth.test.ts` on the shared vectors; `inputs.test.ts` on proof and no proof; `dial.test.ts` on the Windows launcher order, the Windows link line, the refused lines, the watch on the record's folder, and no log line holding the token; `panel.test.tsx` without the `windows` state.
- [ ] **Step 2:** from the repo root, `( cd plugins/harness-device-orca && env -i HOME="$(mktemp -d)" PATH=/usr/bin:/bin "$(command -v orca)" plugin test . )` — FAIL. Commit red.
- [ ] **Step 3: Implement.** README: Windows in "Install" and "The access Orca asks for"; drop the "Not on Windows yet." sentence.
- [ ] **Step 4:** the same `plugin test .` passes; `plugin check .` exits 0 and `orca plugin validate .` says `orca-plugin.json: ok` (no new access); the plugin's type check (the command in `docs/plans/2026-11-18-dial-orca-tab-scope-plan.md`, "Before starting") prints nothing; `cd cli && npx vitest run src/devices/orcaPluginBundle.spec.ts` passes.
- [ ] **Step 5: Commit** `Orca's Harness Device plugin reaches the devices over their pipe on Windows`.

### Task 10: One Windows program resolver

**Files:**
- Create: `cli/src/lib/windows/program.ts`, `cli/src/lib/windows/program.spec.ts`

**Depends on:** 1 (the fixtures). **Effort:** xhigh.

**Since Task 1:** two batch shapes, not three. `code.cmd` and `cursor.cmd` are the Electron shape; `orca.cmd` is a forwarder to a native `orca.exe` (no `ELECTRON_RUN_AS_NODE`, no script) and is refused here like any other batch file: Orca's finder names `orca.exe` (Task 20, "Decided here"). VS Code's script sits under a commit-named folder, so nothing is cached.

**Interfaces (produces):**
- `interface Program { file: string; args: string[]; env?: NodeJS.ProcessEnv }` — `env`, when set, is the child's whole environment.
- `class WindowsProgramRefused extends Error { readonly program: string }`
- `windowsProgram(file: string, args: readonly string[], options?: { platform?: NodeJS.Platform; environment?: NodeJS.ProcessEnv; read?: (file: string) => string; exists?: (file: string) => boolean }): Program`
  - off Windows: `{ file, args }` as given;
  - an `.exe`: as it is;
  - an npm shim: `node.exe <script>` or the package's `.exe`, through `windowsEngineArgv` as it is;
  - VS Code's or Cursor's own launcher (the Electron shape): its `.exe`, with the CLI script first in `args` and `ELECTRON_RUN_AS_NODE: '1'` in `env`;
  - any other batch file (`orca.cmd` among them), or a launcher whose `.exe` or script is not there: throws `WindowsProgramRefused`.
  - The file is read at every call, and nothing is kept between calls.
- `parseElectronLauncher(text: string, launcherDir: string): { exe: string; script: string } | null`

- [ ] **Step 1: Write the failing tests** (they run on windows.yml too, where `src/lib/windows` is listed):
  - an `.exe` with arguments holding `&`, `|`, `%`, `"`, `^` and a line break: the same file, each argument unchanged, no `env`;
  - `fixtures/npm-codex.cmd`: `node.exe` (beside the shim, else on PATH) and the script, then the arguments;
  - `fixtures/code.cmd` and `cursor.cmd`: the `.exe` and script Task 1's notes name (`..\Code.exe` with `..\8a14f0cc1b\resources\app\out\cli.js`; `..\..\..\Cursor.exe` with `..\out\cli.js`), `['--install-extension', 'x.vsix', '--force']` after the script, `env.ELECTRON_RUN_AS_NODE === '1'`, and the rest of `environment` kept;
  - `it('reads the launcher at every start')`: `code.cmd` resolved once, then rewritten to name `0123456789\resources\app\out\cli.js` (an update), resolves to the new script; with the old folder gone and the launcher not yet rewritten, it is refused;
  - `fixtures/orca.cmd` throws `WindowsProgramRefused`, with plain-word arguments too and with `['orchestration', 'send', …]`;
  - a launcher in a folder named `Nguyễn Văn A' & 100%` resolves the same way (Review Focus 3);
  - `@echo off\r\nstart calc %*\r\n` throws `WindowsProgramRefused` with plain-word arguments too; so does `code.cmd` when its `.exe` is missing, and a launcher with its last line changed (Review Focus 5);
  - `platform: 'darwin'`: the file and arguments as given.
- [ ] **Step 2:** `npx vitest run src/lib/windows/program.spec.ts` — FAIL (no module). Commit red.
- [ ] **Step 3: Implement.** The launcher's form is the fixtures': the line that passes `%*` names the `.exe` and the script relative to `%~dp0`, after `set ELECTRON_RUN_AS_NODE=1`.
- [ ] **Step 4:** the run passes; `npx vitest run src/architecture.spec.ts` passes (`architecture.coreFiles.txt` unchanged); `npm run typecheck` passes.
- [ ] **Step 5: Commit** `One resolver starts a Windows program with no shell: an exe, an npm shim, or VS Code's and Cursor's own launcher`.

### Task 11: This account's own folder, on Windows

**Files:**
- Modify: `cli/src/devices/dialSkill.ts:46-85` (`ownUid`, `ownDirectory`, `skillsFolderOf`)
- Test: `cli/src/devices/dialSkill.spec.ts`

**Depends on:** none. **Effort:** xhigh.

**Interfaces (produces):**
- `ownWindowsPath(path: string, kind: 'file' | 'directory', roots?: readonly string[]): 'ok' | 'missing' | 'owner' | 'unreadable'` — `ok` for a real file or folder (not a link or junction) whose real path is inside a root (`insideWindowsRoots`); `owner` for a link or a path outside. `roots` defaults to the resolved profile.
- `ownDirectory(path: string, uid = ownUid(), windowsRoots: readonly string[] | undefined = <the profile on Windows, undefined elsewhere>)` — with roots it answers `ownWindowsPath(path, 'directory', roots)` and reads no uid; without, the uid check as today. `skillsFolderOf` takes the same optional fourth argument.

- [ ] **Step 1: Write the failing tests**, passing roots by hand: a folder inside the root is `ok` with `uid` -1; one outside is `owner`; a symlink inside the root to a folder inside is `owner`; a missing path and a file are `missing`; `ownWindowsPath(file, 'file', roots)` is `ok` for a real file and `owner` for a link; without roots every existing uid case is unchanged.
- [ ] **Step 2:** `npx vitest run src/devices/dialSkill.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.** No PowerShell, no uid on Windows.
- [ ] **Step 4:** the run passes; `npx vitest run src/devices/orcaHomes.spec.ts src/cable/dialHomeSetup.spec.ts` (its callers) and `npm run typecheck` pass.
- [ ] **Step 5: Commit** `On Windows a skill home is this account's own when it is a real folder in the profile`.

### Task 12: VS Code and Cursor found and run

**Files:**
- Modify: `cli/src/devices/vscodeExtension.ts:27-90,225-283` (deps, `installed`, `vscodeCli`, the real `run`)
- Modify: `cli/src/cable/vscodeExtensionSetup.ts:76-78`
- Test: `cli/src/devices/vscodeExtension.spec.ts`, `cli/src/cable/vscodeExtensionSetup.spec.ts`

**Depends on:** 1, 10. **Effort:** high.

**Interfaces:**
- Consumes: `windowsProgram`; the install folders in Task 1's notes.
- Produces: `VscodeExtensionDeps.folders?: { localAppData?: string; programFiles?: string }`; on Windows `installed()` answers the editor's launcher: `<cli>.cmd` in an absolute PATH folder, then the per-user folder (`<LOCALAPPDATA>\Programs\Microsoft VS Code\bin\code.cmd`, `<LOCALAPPDATA>\Programs\cursor\resources\app\bin\cursor.cmd`), then, for VS Code alone, the machine folder (`<ProgramFiles>\Microsoft VS Code\bin\code.cmd`). Cursor has no machine folder: none was seen for real ("Decided here"), so none is guessed. `export function editorCli(deps: VscodeExtensionDeps): string | null` (today's `vscodeCli`, exported). The real `run` starts `windowsProgram(file, args)` with `windowsHide: true` and ends the child at its time on Windows.
- **Since Task 1:** `installed()` and `editorCli` answer the `.cmd`, never the `.exe` or `cli.js` it names, and nothing resolved is kept: each run resolves the launcher anew, because VS Code's `cli.js` is under a folder named by the build's commit that an update renames.

- [ ] **Step 1: Write the failing tests**
  - `vscodeExtension.spec.ts`, `platform: 'win32'`: found on PATH; else in the per-user folder; else, for VS Code, in the machine folder; `absent` with none; a `cursor.cmd` only under `<ProgramFiles>\cursor\resources\app\bin\` is `absent` (no machine folder for Cursor); a relative PATH folder is not looked in; `bin` absolute wins; `vscodeStatus` reads `<home>\.vscode\extensions\extensions.json` (`.cursor` for Cursor); `vscodeEnable` runs the launcher with `['--install-extension', <vsix>, '--force']`.
  - The real `run` on Windows (spawn mocked): the file is the launcher's `.exe`, `ELECTRON_RUN_AS_NODE` is `'1'`, `windowsHide` is true, and neither `shell` nor `detached` is set; a refused launcher answers `{ code: null, timedOut: false }`.
  - `it('an update between two runs is read anew')`: two `vscodeEnable` runs with `code.cmd` rewritten between them to another commit folder: the second run's first argument is the new `cli.js`.
  - `vscodeExtensionSetup.spec.ts`: on Windows a pass installs, as on a Mac.
- [ ] **Step 2:** `npx vitest run src/devices/vscodeExtension.spec.ts src/cable/vscodeExtensionSetup.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `Harness finds VS Code and Cursor on Windows and sets its extension up there`.

### Task 13: Claude Code's plugin and the dial skill

**Files:**
- Modify: `cli/src/devices/claudePlugin.ts:50-64,127-139` (`claudeRunner`, `versionOf`, `supports`)
- Modify: `cli/src/cable/dialPluginSetup.ts:205-207`, `cli/src/cable/dialHomeSetup.ts:405-428`
- Test: their three specs
- Create: `cli/src/devices/claudePlugin.windows.real.spec.ts`
- Modify: the notes, section `## Task 13`

**Depends on:** 1, 10, 11. **Effort:** high.

**Interfaces:** `supports()` takes `win32`. `claudeRunner(bin, env, platform = process.platform)` starts `windowsProgram(bin, args, { environment: env })` with `windowsHide: true`. On Windows `versionOf` answers a version only when the output says `Claude Code`. The two setups run on Windows.

**Since Task 1:** Claude Code's native installer puts `claude.exe` in `<profile>\.local\bin` and leaves that folder off PATH, as `~/.local/bin` is on macOS. Both lookups find it there: `claudeNearby()` already walks `engineInstallPaths(ENGINE_INSTALL.claude)`, whose Windows list holds `<home>\.local\bin\claude` (and `resolveBinaryOnPath` appends `.exe`), and `claudeFound(home, true)` and `claudeRun()` go through `installedEngineBin`. On Windows no login shell is started for the lookup (there is none). If a case below is green before the change it pins the lookup and the report says so; a fix lives in `claudePlugin.ts`, never in `lib/engineBin.ts` or `lib/engineInstall.ts` (core files, unchanged).

- [ ] **Step 1: Write the failing tests**
  - `claudePlugin.spec.ts`: Windows with 2.1.287 is supported; a `--version` that answers `Claude 1.4.0` on Windows gives `supported: false`, and `claudeEnable` answers the `unsupported` failure after exactly one run (Review Focus 4); the runner on Windows (execFile mocked) starts the resolved program with `windowsHide` and no shell.
  - `src/devices/claudePlugin.windows.real.spec.ts` (new, `describe.runIf(process.platform === 'win32')`; the lookup's `.exe` and its paths are Windows' own, so a Mac run proves nothing): `it('finds claude.exe in the profile\'s .local\\bin, off PATH')`, with `USERPROFILE` a temp profile whose `.local\bin\claude.exe` is a copy of `node.exe` and a PATH without `claude`: `claudeFound(home, false)` and `claudeFound(home, true)` both answer a run of that file, and no shell process is started. Task 34 lists it in windows.yml; on the VM it runs in Task 13's Step 4.
  - `dialPluginSetup.spec.ts`: a pass on Windows installs the plugin.
  - `dialHomeSetup.spec.ts`: `started`, `attached` and `scanned` on Windows write the skill into an owned home.
- [ ] **Step 2:** `npx vitest run src/devices/claudePlugin.spec.ts src/cable/dialPluginSetup.spec.ts src/cable/dialHomeSetup.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.** Remove the three comments that say Windows has no dial to ring.
- [ ] **Step 4:** the run passes; `npm run typecheck` passes. On the VM (the tree synced): `npx vitest run src/devices/claudePlugin.windows.real.spec.ts --maxWorkers=1` passes; write the result in the notes, and whether it was green before Step 3.
- [ ] **Step 5: Commit** `Claude Code's harness-device plugin and the dial skill are set up on Windows`.

### Task 14: `asked` over the daemon's pipe

**Files:**
- Modify: `cli/src/deviceClaude/asked.ts:121-147` (`daemonPost`)
- Test: `cli/src/deviceClaude/asked.spec.ts`

**Depends on:** none. **Effort:** high.

**Interfaces:** `daemonPost(dataDir, port, platform = process.platform, send: typeof fetch = daemonFetch(dataDir, port))`. On Windows it posts the body to `http://127.0.0.1:<port>/api/hook/observed` through `send`, bounded by `WRITE_MS`, cancels the answer, and swallows every error. Elsewhere it is unchanged.

- [ ] **Step 1: Write the failing tests**: on Windows the injected `send` gets `POST /api/hook/observed` with the JSON body; a `send` that rejects (no pipe) resolves with nothing thrown; one that never answers resolves within `WRITE_MS` (fake timers); on macOS `send` is never called.
- [ ] **Step 2:** `npx vitest run src/deviceClaude/asked.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `A waiting permission prompt reaches the daemon over its pipe on Windows`.

### Task 15: `harness device claude inbox`: the session's inbox through the CLI

**Why** (Task 2 §1-§3, and the orchestrator's answer, "Decided here": "Claude Code's mod on Windows goes through the CLI"): Claude Code's mod runtime refuses every pipe path in `socketPath` and has no HMAC, so the mod cannot reach the daemon's pipe. The CLI can: `daemonFetch` already proves the daemon's token over its pipe (Task 14). This task gives the mod a word that holds the session's inbox poll and prints what arrives.

**Files:**
- Create: `cli/src/deviceClaude/inbox.ts`, `cli/src/deviceClaude/inbox.spec.ts`, `cli/src/deviceClaude/inbox.windows.real.spec.ts`
- Modify: `cli/src/deviceClaude/command.ts` (the dispatch of `claude inbox <id>`, `DeviceDeps.write`, the comment above `DEVICE_USAGE`, the header comment), `cli/src/deviceClaude/command.spec.ts`
- Modify: `cli/src/devices/listenerPipe.ts` (`createRecordProof`; `createDevicesProof` built on it), `cli/src/devices/listenerPipe.spec.ts`
- Modify: `cli/src/cli.ts` (the `device` case: `write`)
- Modify: the notes, section `## Task 15` (Step 1)

**Depends on:** 2, 4, 14 (all landed). **Effort:** xhigh (a long-lived client that proves the daemon's token, and a process that must not outlive its session).

**Interfaces:**
- `harness device claude inbox <session id>`, dispatched when `words` is `['claude', 'inbox', <id>]`. It runs on every platform (`daemonFetch` takes the socket or the pipe); only the Windows mod runs it (Task 16). Out of `DEVICE_USAGE`, as `link` is.
- `followInbox(sessionId: string, deps: InboxDeps): Promise<number>` in `inbox.ts`, with `InboxDeps = { dataDir: string; port: number; platform: NodeJS.Platform; acts(): boolean; proof: DaemonProof; fetch?: typeof fetch; write(line: string): Promise<boolean>; wait(ms: number): Promise<void>; parentAlive(): boolean }`. `acts` is command.ts's `pluginActs(dataDir)`; `parentAlive` is `process.kill(process.ppid, 0)` not throwing. It resolves 0 in every case.
- The loop, until it returns:
  1. The id is not a lower-case UUID (the listener's `SESSION_ID`): write `{"off":true}`, return; nothing connects.
  2. Before each poll: `parentAlive()` false, return (nothing written); `acts()` false, write `{"off":true}` and return.
  3. `POST http://127.0.0.1:<port>/api/hook/inbox`, body `{"sessionId":<id>}`, through `daemonFetch(dataDir, port, fetch, platform, (d, p) => proof.pipe(d, p))`, aborted at 30 s (the core holds 27 s, `INBOX_CALL_MS`).
  4. A 200 whose `text` is a string of 1 to 20,000 characters: `acts()` again (the Mac mod's "checked once the poll is back, before its text"); off, write `{"off":true}` and return; on, write `{"text":<text>}`. Any other 200: write `{}`. A 404 (a daemon older than the inbox): write `{"off":true}` and return.
  5. No daemon target, a rejected fetch (no proof, a wrong one, a closed pipe, the 30 s abort), or any other status (503 `NO_DEVICE`): `proof.forget(dataDir, port)`, `wait(60_000)`, write `{}`, and poll again.
  6. Each `write` that resolves false (stdout closed, `EPIPE`): return at once, with no further poll.
  Nothing goes to stderr, ever; the text and the tokens are in no log line or error.
- `DeviceDeps.write(line: string): Promise<boolean>`: `line` and a newline on stdout, false on a write error or an `error` event on stdout (cli.ts wires it with `process.stdout.write(…, callback)`).
- `createRecordProof` (in `devices/listenerPipe.ts`): `createDevicesProof`'s held-proof rule over any `{ pipe, pid }` record, its token and its file's time, held per record file. `createDevicesProof` keeps its name, signature and behavior on it (its existing cases unchanged). `DaemonProof = { pipe(dataDir: string, port: number): Promise<PipeTarget | null>; forget(dataDir: string, port: number): void }` and `createDaemonProof(options?: { liveness?: HostLiveness; now?: () => number }): DaemonProof` in `inbox.ts`, over `daemonRecordPath(dataDir, configuredPortOf(dataDir, port))`, `readDaemonRecord` and `readDaemonToken`, the file's time taken by a stat before the read (a write between the two leaves a newer time, which the next call proves again). `lib/daemonRecord.ts`, `lib/windows/daemonPipe.ts` and `lib/windows/pipeAuth.ts` do not change.
- **If Step 1 says `$.process.spawn` does not stream on Windows**: the same word does one round of steps 1-5 and returns: it writes one line (`{"text"}`, `{}`, `{"off":true}`, or `{"retry":true}` in place of step 5's wait) and exits. The held proof then lives one run, so each poll reads the process table: Verification 9's numbers say what that costs.

- [ ] **Step 1: The VM check: does `$.process.spawn` stream on Windows** (The VM; the test user over SSH, as Task 2 ran; Claude Code by `<profile>\.local\bin\claude.exe` with the test key as The VM says, a throwaway `CLAUDE_CONFIG_DIR`, `claude -p` with a throwaway mod by `--plugin-dir`, outside the repo and never committed). The mod, at `session.start`, writes to a file in a throwaway folder:
  1. the Claude Code version, and whether `$.process.spawn` is a function;
  2. `$.process.spawn({ argv: [<absolute node.exe>, '-e', <one line a second, five times>] })`, with `$.clock.now()` at each piece: streaming means pieces about 1 s apart, all before the child exits;
  3. `$.process.spawn` of `node.exe parent.js`, whose child `node.exe child.js` inherits its stdio, as `harness.exe` starts `node.exe` (`pty/src/command.rs` `run_resolved`). The child writes its pid to that folder, then a line a second; before each line it logs whether `process.kill(process.ppid, 0)` throws, and it logs the first write that fails (its code) and exits. The mod leaves the loop after three pieces. 5 s and 30 s later, from `harness-pty ps --json`: whether the parent is gone, and whether the child still runs; and the child's log.
  Write it in the notes, `## Task 15`, and first the choice: **follow** (spawn is there and streams) or **one-shot** (it is not, or it hands the pieces only at the exit). Whether a write fails once the parent is killed, and whether the parent check sees it gone, go there too. If the child neither sees its parent gone nor fails a write within 30 s, write that first and report it: the follower would then end only when a newer poll replaces its hold. The key stays out of the notes (Task 2 §6's `findstr` check). The notes go in the task's second commit.
- [ ] **Step 2: Write the failing tests** (the form Step 1 chose; the cases below are the follow form's, and the one-shot form keeps each as its one round):
  - `inbox.spec.ts`, `platform: 'win32'`, the pipe stood in by a Unix socket named `harness-<32 hex>` (as `pipeAuth.spec.ts` does) served by `listenLocalSocket(handler, path, { token })`, with `daemon-<port>.json` naming it and `daemon-token` in a temp data folder, `proof: createDaemonProof({ liveness: { alive: () => true, rows: <counted, a live row> } })`, `wait` and `write` recorded:
    - `it('prints what the person said, one line each, and polls again at once')`: answers `{"text":"hi & 100% \"x\"\nnext"}` then `{}` give the lines `{"text":"hi & 100% \"x\"\nnext"}` (that text, whole, as one JSON line) and `{}`; each request is `POST /api/hook/inbox` with `{"sessionId":<id>}` and a valid auth;
    - `it('twenty polls read the process table once')`;
    - `it('an answer with no proof is dropped unread, and the next poll proves again')`: a plain server on that name answering 200 `{"text":"x"}` with no proof: no `text` line; `wait(60_000)`, then `{}`, then the table read again;
    - no daemon record, and a pid not alive: nothing connects, `wait(60_000)`, `{}`;
    - a 503 `NO_DEVICE`: `wait(60_000)`, `{}`, another poll;
    - a 404: `{"off":true}`, resolves 0, no more polls;
    - `acts()` false before a poll: `{"off":true}`, no poll; turned false while a poll is held that then answers a text: `{"off":true}` and no `text` line;
    - an id in upper case, and one that is not a UUID: `{"off":true}`, nothing connects;
    - a text of 20,001 characters, and an empty one: `{}`;
    - `parentAlive()` false: resolves with nothing written and no poll; `write` false after the first line: resolves, with no further poll;
    - `err` is never called, and no written line holds the token;
    - `platform: 'darwin'`, the daemon's Unix socket: the same first case passes through `daemonFetch`'s socket path.
  - `listenerPipe.spec.ts`: every existing `createDevicesProof` case unchanged; `it('a record proof is held per record file')`: two records, two table reads, then none for 59 s.
  - `command.spec.ts`: `device claude inbox <uuid>` runs the follower (the injected `write` gets its lines); `device claude inbox` with no id writes `{"off":true}`; `DEVICE_USAGE` does not name `inbox`.
  - `inbox.windows.real.spec.ts`, `describe.runIf(process.platform === 'win32')`: a real pipe `listenLocalSocket(handler, newPipePath(), { token })`, its record and token in a temp data folder; `followInbox` with `createDaemonProof()` prints a text line, then `{}`; a server with another token gives no text line. Task 34 lists it in windows.yml.
- [ ] **Step 3:** `cd cli && npx vitest run src/deviceClaude/inbox.spec.ts src/devices/listenerPipe.spec.ts src/deviceClaude/command.spec.ts` — FAIL. Commit red.
- [ ] **Step 4: Implement.** Header comments: command.ts names the word and why it exists (the mod's runtime on Windows, Task 2); `inbox.ts` says the follower ends itself and why (`harness.exe` has no job object).
- [ ] **Step 5:** the run passes; `npm run typecheck` passes. On the VM (the tree synced): `npx vitest run src/deviceClaude/inbox.windows.real.spec.ts --maxWorkers=1` passes; its result goes in the notes.
- [ ] **Step 6: Commit** `Claude Code's mod hears the dial through the harness command on Windows, which proves the daemon's token`.

### Task 16: The mod reaches Harness through `harness.exe` on Windows

**Files:**
- Modify: `plugins/harness-device/hooks/device.js`, `plugins/harness-device/test/device.test.ts`, `plugins/harness-device/README.md` (Windows: the mod runs `harness.exe`; no token reaches it)

**Depends on:** 15 (its Step 1 picks the follow or the one-shot form, and its line protocol). Task 39's `attach` line is pinned here and in "Decided here", so this task does not wait for it. **Effort:** xhigh (a child process per session, its restarts and its end).

**Interfaces:**
- Windows is `(await $.session.info()).platform === 'windows'` (Task 2 §3), asked once per `session.start`. On macOS and Linux every path is today's, and `$.process.spawn` is never called.
- On Windows:
  - The profile is `USERPROFILE` (`$.env.get`). `settingsPath` is `<CLAUDE_CONFIG_DIR>\settings.json`, else `<profile>\.claude\settings.json`.
  - The launcher: `<profile>\.harness\bin\harness.exe` when `$.fs.exists` says it is there, else `harness` (PATH). A bare `harness` that cannot start (the stream's first pull rejects: not on PATH) means no Harness here: look again after `RETRY_MS`, as the Mac's `socketOf` does, outside the restart bound. Looked up at each start of a follower.
  - **The follower** (the follow form): `$.process.spawn({ argv: [launcher, 'device', 'claude', 'inbox', <session id>], cwd: <profile> })` (the profile, so a process that outlives its session holds no project folder open), one per session, started from a timer after `session.start`, as `link` is today. Its pieces are joined and cut at `\n`. Each line is parsed: `{"text": <string>}` → `isOn` → `$.prompt.submit({ text, asUser: true })`, not awaited (as today); `{"off":true}` noted; `{}` and any other line ignored. A line over 131,072 characters leaves the loop (which kills the child) and counts as a quick end.
  - **When the loop ends**: after `{"off":true}`, the next follower after `OLD_HARNESS_MS`. Else (it exited or was killed, a line was too long, or a `harness.exe` that is there could not start) it starts again after 1, 2, 4, 8 and 16 s for five quick ends in a row (each ran under 60 s by `$.clock.now()`); the sixth waits `OLD_HARNESS_MS` and the count starts over; a follower that ran 60 s or more resets the count and starts again after 1 s. Every wait is a `$.clock.after`, so a reload cancels it; a reload or unload ends the loop, which kills the child.
  - Without `$.process.spawn`: no follower, nothing retried.
  - **The attach**: at `session.attach` (desktop), `held` is set, and from a timer `$.process.run([launcher, 'device', 'claude', 'attach', <session id>], { timeoutMs: RELINK_TIMEOUT_MS, cwd: <profile> })`, `held` cleared before the run (as today). Sent when the first stdout line is `{"sent":true}`. Otherwise (`{"sent":false}`, another line, a non-zero exit, a reject), the session is held again unless a detach came during the run, and the next attach runs it again, at most once in `RELINK_MS`.
  - `$.http.fetch` is never called, and no file but the settings is read: no token, pipe name or HMAC in the mod.
  - **The one-shot form** (if Task 15's Step 1 chose it): in place of the follower, one `$.process.run([launcher, 'device', 'claude', 'inbox', <session id>], { timeoutMs: 35_000, cwd: <profile> })` per poll, from a timer: `{"text"}` → submit, and poll again at once; `{}` → at once; `{"retry":true}` → after `RETRY_MS`; `{"off":true}` → after `OLD_HARNESS_MS`; anything else (a non-zero exit, a reject, the timeout, no line) → the same restart bound as above.
- The header comment says why Windows differs (Task 2: no pipe in `socketPath`, no HMAC) and that no credential reaches the mod.

- [ ] **Step 1: Write the failing tests** in `device.test.ts` (`claude-code/testing`). A Windows world: `session.info` answers `platform: 'windows'`; `USERPROFILE` is `C:\Users\Nguyễn Văn A' & 100%`; `fs.exists` answers per path; a `process.spawn` hook stands for the CLI (a generator yielding the pieces a test gives, and recording `return()`); `process.run` for `attach`. The follow form's cases (the one-shot form keeps each as its run per poll):
  - the launcher order: there → that path, with argv `[<profile>\.harness\bin\harness.exe, 'device', 'claude', 'inbox', SESSION]` and `cwd` the profile; missing → `harness`; `harness` rejected → no spawn for `RETRY_MS`, then looked for again;
  - `{"text":"hi"}` cut across two pieces → one submit of `hi`; two lines in one piece → two submits, in order;
  - the plugin off in the settings → a text line submits nothing;
  - `{"off":true}`, then the end → the next spawn after exactly 10 minutes, none before;
  - quick ends → spawns at +1, +2, +4, +8 and +16 s, the sixth after 10 minutes; a follower that ran 60 s → the next after 1 s;
  - a line of 131,073 characters → `return()` on the stream, and a restart by the bound;
  - one follower per session: two `session.attach` and a `session.detach` start none;
  - the attach: `{"sent":true}` → one run, argv `[…, 'attach', SESSION]`; `{"sent":false}` → held: an attach within 30 s runs nothing, one after 30 s runs again; a detach during the run → no run after it;
  - no `http.fetch` at all, and `fs.read` reads only the settings file;
  - every existing case (a macOS world) unchanged, and `process.spawn` never called there.
- [ ] **Step 2:** `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin test plugins/harness-device` — FAIL. Commit red.
- [ ] **Step 3: Implement.** README: on Windows the mod runs `harness.exe` (or `harness` on PATH) and is handed no credential.
- [ ] **Step 4:** the test passes; `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin validate plugins/harness-device` passes.
- [ ] **Step 5: Commit** `Claude Code's mod reaches the dial through the harness command on Windows, with no token`.

### Task 39: `harness device claude attach`

**Files:**
- Modify: `cli/src/deviceClaude/command.ts` (the dispatch of `claude attach <id>`, `DeviceDeps.tell`), `cli/src/deviceClaude/command.spec.ts`

**Depends on:** 6 (`tellDevices` over the devices' pipe). **Effort:** high.

**Interfaces:**
- `harness device claude attach <session id>`, dispatched when `words` is `['claude', 'attach', <id>]`; out of `DEVICE_USAGE`. On every platform; only the Windows mod runs it (Task 16).
- It writes one line and exits 0: `{"sent":true}` when the id is a lower-case UUID (the listener's `SESSION_ID`), `pluginActs(dataDir)` holds, and `deps.tell(dataDir, { type: 'attach', sessionId })` is true; else `{"sent":false}`, and nothing is sent when the id or the plugin refuses it. Nothing on stderr.
- `DeviceDeps.tell?: (dataDir: string, message: { type: string } & Record<string, unknown>) => Promise<boolean>`, `tellDevices` by default.

- [ ] **Step 1: Write the failing tests** in `command.spec.ts`, `platform: 'win32'` with `tell` injected: sent → `{"sent":true}` and `tell` saw `{ type: 'attach', sessionId }`; `tell` false → `{"sent":false}`; the plugin off, and removed → `{"sent":false}` and `tell` never called; an upper-case id and a non-UUID → the same; `platform: 'darwin'` → `{"sent":true}` the same way; `err` never called.
- [ ] **Step 2:** `cd cli && npx vitest run src/deviceClaude/command.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.** The comment above `DEVICE_USAGE` names `attach` among the plugins' words.
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `The dial turns to the session the Claude app shows on Windows, through the harness command`.

### Task 17: The permission hook on Windows

**Files:**
- Modify: `plugins/harness-device/hooks/hooks.json`, `plugins/harness-device/hooks/asked`
- Create, only if Task 2's notes say the PowerShell runner needs a script: `plugins/harness-device/hooks/asked.ps1`
- Modify: `plugins/harness-device/README.md`
- Test: `cli/src/harnessDevicePlugin.spec.ts`

**Depends on:** 2. **Effort:** high.

**Interfaces:** one `PermissionRequest` hook for every tool, timeout 5 s, in the form Task 2's notes show Claude Code runs under Git Bash and under PowerShell (`lib/windows/claudeCodeGitBash.ts`: Git Bash, else PowerShell). On Windows it runs `%USERPROFILE%\.harness\bin\harness.exe device claude asked`, else `harness` on PATH, with the hook's stdin. It prints nothing, ever, and exits 0. No text of the prompt is on a command line. No window.

- [ ] **Step 1: Write the failing tests**
  - every existing case of the `sh` script stays as it is, under `skipIf(process.platform === 'win32')`;
  - `hooks.json` still holds one hook, for `*`, with `timeout: 5`;
  - `it('the Windows form names the launcher in the profile, then PATH')`: the text Claude Code runs on Windows (the command in `hooks.json`, or `asked.ps1`) holds `.harness\bin\harness.exe` and `device claude asked`, and writes nothing to its output;
  - `it.runIf(process.platform === 'win32')`, once through `powershell.exe -NoProfile -Command` and once through Git Bash when it is installed, with `USERPROFILE` a temp profile:
    - the launcher stand-in is a copy of `node.exe` named `harness.exe` in `<profile>\.harness\bin`, and a `device.js` in the working folder records its arguments and stdin (Node reads the first word, `device`, as a script there);
    - it runs with `claude asked` and the stdin it was given;
    - the hook's stdout and stderr are empty and its exit is 0, also when the stand-in prints a decision and exits 2, and with no launcher at all.
- [ ] **Step 2:** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts` — the Windows-form case FAILS on the Mac. Commit red.
- [ ] **Step 3: Implement.** README: Windows' launcher path.
- [ ] **Step 4:** the run passes on the Mac; `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin validate plugins/harness-device` passes. The Windows cases run on windows.yml, where Task 34 lists this spec.
- [ ] **Step 5: Commit** `The harness-device hook runs on Windows, under Git Bash and under PowerShell`.

### Task 18: Codex on Windows

**Files:**
- Modify: `cli/src/cable/hosts/codexQueue.ts:95-160` (`codexQueueDeps`, `choose`), its header comment
- Modify: `cli/src/deviceClaude/command.ts:158-178` (`codexCommand`)
- Test: `cli/src/cable/hosts/codexQueue.spec.ts`, `cli/src/deviceClaude/command.spec.ts`

**Depends on:** 1, 10. **Effort:** high.

**Interfaces:** `choose` no longer refuses Windows. There the login shell is never read (PATH is the process's own), the app's own Codex is never asked, and the real `run` starts `windowsProgram(file, args, { environment: env })` with `windowsHide: true`; a refused program ends `'not-started'`. `harness device codex enable` and `status` take Windows.

- [ ] **Step 1: Write the failing tests**
  - `codexQueue.spec.ts`, `platform: 'win32'`: `can(false)` and `can(true)` are true with a `codex` there; `send` runs `['queue', '--thread', id, '--message=<text>']` with a text holding `&`, `|`, `%`, `"` and a line break as one argument; `readLoginShell` and `appBinary` are never called; a `run` that ends `'not-started'` gives `{ outcome: 'failed', reason: 'no binary', ran: 'path' }`.
  - The real `run` on Windows (execFile mocked): the resolved program, `windowsHide`, no shell.
  - `command.spec.ts`: `codex status` on Windows says `supported: true`; `codex enable` there writes the skill.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/codexQueue.spec.ts src/deviceClaude/command.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `The dial's words reach Codex on Windows through codex queue, with no shell`.

### Task 19: herdr over its pipe

**Files:**
- Modify: `cli/src/cable/hosts/herdrClient.ts:36-48,102-107`, `herdrSource.ts:124-127`, `herdr.ts:61-67`, `unixSocket.ts:70-78`
- Test: their four specs

**Depends on:** 1 (the path and the mapping), 11 (`ownWindowsPath`). **Effort:** high.

**Interfaces:**
- `herdrSocketPath(vars, home, platform = process.platform)`: on Windows the marker's path as the notes give it.
- `herdrPipeOf(marker: string): string`: the pipe herdr serves for that marker, by the notes' mapping.
- `HerdrClientDeps.endpoint: string`: what is dialled (the socket's path; on Windows `herdrPipeOf(socketPath)`). `herdrClientDeps()` fills it.
- `unixSocket.ts`: `markerStampOf(path: string, roots?: readonly string[]): string | undefined` — `<inode>:<mtime in ns>` while `ownWindowsPath(path, 'file', roots)` is `ok`.
- The client's `socketStamp()` on Windows is the marker's stamp; the source starts there; the adapter types there.

- [ ] **Step 1: Write the failing tests**
  - `herdrClient.spec.ts`: `herdrSocketPath` and `herdrPipeOf` give the notes' two lines, byte for byte, for the default home and for `XDG_CONFIG_HOME` set; on Windows a request goes to `endpoint`, and `agent.list`, `agent.prompt` and `events.subscribe` work against a line server there; with no marker the answer is `no_socket` and nothing connects.
  - `unixSocket.spec.ts`: `markerStampOf` gives a stamp for a real file inside the root, none for a link, a folder, a file outside the root or a missing one, and another stamp after the file is rewritten.
  - `herdrSource.spec.ts`: `start()` on Windows starts the attempts.
  - `herdr.spec.ts`: on Windows the adapter has `type` and `canType`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/herdrClient.spec.ts src/cable/hosts/herdrSource.spec.ts src/cable/hosts/herdr.spec.ts src/cable/hosts/unixSocket.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.** Fix the three comments that say the client does not speak the pipe.
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `herdr's agents are listed and spoken to over herdr's pipe on Windows`.

### Task 20: Orca found; its homes and plugin

**Files:**
- Modify: `cli/src/devices/orcaHomes.ts:38-70,83-116,180-182` (a Windows branch in `LAUNCHER` and `orcaBinary`, the real `run`, the cache's skip)
- Modify: `cli/src/devices/orcaPlugin.ts:114`
- Test: their two specs

**Depends on:** 1, 10, 11. **Effort:** high. Keep the diff in `orcaHomes.ts` to those lines: dial-linux edits the same file.

**Since Task 1:** Orca's CLI on Windows is `<Orca>\resources\bin\orca.exe`, a native program; `orca.cmd` beside it only forwards to it, and refuses `orchestration send|reply` (Decided here). `resources\bin` is not on PATH after Orca's install. The finder names `orca.exe`, and `orca.cmd` is never answered or run.

**Interfaces:** `OrcaBinaryDeps.localAppData?: string`. On Windows `LAUNCHER` takes `\resources\bin\orca.exe` (any case, `\` separators) and nothing else there. `orcaBinary` answers `orca` on PATH whose real path is such an `orca.exe` (`resolveBinaryOnPath` tries `.exe` first), else `<localAppData>\Programs\orca\resources\bin\orca.exe` when it exists (Task 1 §2); a `LOCALAPPDATA` that is not absolute gives no default. The real `run` starts `windowsProgram(file, args)` with `windowsHide: true`, which runs the `.exe` as it is. The cache reads on Windows; the plugin's `find` no longer answers absent there.

- [ ] **Step 1: Write the failing tests**
  - `orcaHomes.spec.ts`: Windows finds `orca.exe` on PATH and in the default folder (`resources\bin` not on PATH, as installed); an `orca.cmd` found on PATH, even in `resources\bin`, is not taken; another `orca.exe` on PATH (not in `resources\bin`) is not taken; with no `orca.exe` in the default folder it answers null (Review Focus 5); `readOrcaHomes` keeps a home that is an owned folder; `refresh()` on Windows reads; the real `run` on Windows (spawn mocked) starts `orca.exe` itself with the arguments unchanged, no `ELECTRON_RUN_AS_NODE` and no `env`, `windowsHide` and no shell, and a refused program (an `orca.cmd` passed in) answers `{ code: null, stdout: '', timedOut: false }` with nothing spawned.
  - `orcaPlugin.spec.ts`: `orcaStatus` on Windows goes on to ask Orca.
- [ ] **Step 2:** `npx vitest run src/devices/orcaHomes.spec.ts src/devices/orcaPlugin.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `Harness finds Orca's orca.exe on Windows, reads its account homes and connects its plugin`.

### Task 21: Orca's commands and its focus watch

**Files:**
- Modify: `cli/src/cable/hosts/orca.ts:58-104` (`orcaDeps`: `run`, `spawn`, the child's `kill`)
- Test: `cli/src/cable/hosts/orca.spec.ts`

**Depends on:** 10. **Effort:** high.

**Interfaces:** `orcaDeps(platform = process.platform)`. `run` and `spawn` start `windowsProgram(file, args)` with `windowsHide: true`; a refused program answers `{ code: null, stdout: '' }`, or the gone child. On Windows the child's `kill` ends its process tree (`endProcessTree(pid, processTreeKillDeps(null))`, `lib/windows/treeKill.ts`) for either signal. Every adapter that takes `apps.run` (herdr's focus, tmux, WezTerm, the tap paths) gets the same start.

**Since Task 1:** the file the devices pass is Task 20's `orca.exe`, which the resolver runs as it is, so a text with a line break reaches Orca whole (`orca.cmd` would have let `cmd.exe` reparse it).

- [ ] **Step 1: Write the failing tests** (child_process mocked), `platform: 'win32'`: `run('…\\resources\\bin\\orca.exe', ['terminal', 'send', …, '--text=a & b\r\nc %PATH%'])` starts that `.exe` with the text as one argument, unchanged, `windowsHide`, no shell, no `env`; `run('…\\orca.cmd', …)` is refused: it resolves `{ code: null, stdout: '' }` and nothing is spawned, and `spawn` with it gives a child whose `exited` has resolved; stopping `watch-focus` on Windows calls the tree kill with the child's pid and sends no signal; on macOS `run`, `spawn` and `kill` are as today.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/orca.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run passes; `npx vitest run src/lib/windows/noWindow.spec.ts` and `npm run typecheck` pass.
- [ ] **Step 5: Commit** `The devices start Orca's commands on Windows with no shell, and end its focus watch as a tree`.

### Task 22: The serial stand-in bridges

**Files:**
- Modify: `cli/src/cable/__fixtures__/fakeHarnessSerial.mjs` (its header's list, the `open` mode)
- Create: `cli/src/cable/fakeSerialBridge.spec.ts`

**Depends on:** none. **Effort:** medium.

**Interfaces:** `FAKE_SERIAL_OPEN=bridge:<endpoint>`: `open <port>` connects to `<endpoint>` (a Unix socket's path, or `\\.\pipe\…`), says `open`, then carries stdin to the connection and the connection to stdout. It exits 0 when either side ends. An endpoint it cannot reach: `gone` on stderr, exit 4.

- [ ] **Step 1: Write the failing test**: a server on a temp endpoint (a pipe on Windows); the stand-in run as `node fakeHarnessSerial.mjs open COM77` with the bridge; bytes written to its stdin arrive at the server exactly, and the server's bytes at its stdout; the server closing ends it with exit 0; with no server it says `gone` and exits 4.
- [ ] **Step 2:** `npx vitest run src/cable/fakeSerialBridge.spec.ts` — FAIL (it echoes). Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run passes; `npx vitest run src/cable/windowsSerial.spec.ts` still passes.
- [ ] **Step 5: Commit** `The serial stand-in can carry a test's dial`.

### Task 23: The dial end to end on Windows

**Files:**
- Create: `cli/e2e/dialWindows.e2e.ts`, `cli/e2e/harness/windowsDaemon.ts`, `cli/vitest.e2e.windows.config.ts`
- Modify: `cli/e2e/harness/fakeDial.ts` (a second way in for its bytes)
- Modify: the notes, section `## Task 23`

**Depends on:** 5, 6, 7, 22. **Effort:** high. **Red test:** none on the branch: it pins Tasks 5-7. Its run on the base (`harness device notify` prints `no dial`) is the report's evidence. One commit.

**Interfaces (produces):**
- `fakeDial.ts`: `static listen(endpoint: string, options?: FakeDialOptions): Promise<FakeDial>` — serves `endpoint`; the stand-in's connection is the cable. `FakeDial.open` is unchanged.
- `windowsDaemon.ts`: `startWindowsDaemon(options?: { env?: Record<string, string> }): Promise<{ dataDir: string; port: number; env: NodeJS.ProcessEnv; dial: FakeDial; harness(args: string[]): Promise<{ code: number | null; stdout: string }>; close(): Promise<void> }>`.
  - A root under `os.tmpdir()`; `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, `TEMP`, `TMP`, `ADAPTER_DATA_DIR`, `ADAPTER_RUNTIME_DIR`, `ADAPTER_COMPUTER_ID_FILE`, `HARNESS_AUTH_DIR`, `DSH_DIR`, `CLAUDE_PROJECTS_DIR`, `CODEX_HOME` and `HARNESS_HOOK_ROUTES_DIR` inside it; a free `PORT`.
  - Signed out and alone: `BACKEND_WS_URL=ws://127.0.0.1:9`, `WEB_URL=http://127.0.0.1:9`, `ADAPTER_UPDATE_DISABLE=true`, `ANALYTICS_ENABLED=false`, `DISABLE_GRID_INSTALL=true`, `DISABLE_HOOK_INSTALL=true`, `CLAUDE_PATH` and `CODEX_PATH` naming files that are not there, `HARNESS_VSCODE_BIN` and `HARNESS_CURSOR_BIN` the same.
  - The dial: `CABLE_DISABLE=false`, `CABLE_FW_DISABLE=true`, `HARNESSD_TEST_DIAL_PORT=COM77`, `HARNESS_SERIAL_BIN=process.execPath`, `FAKE_SERIAL_LINES=["{\"console\":true,\"ports\":[]}"]`, `FAKE_SERIAL_OPEN=bridge:\\.\pipe\harness-e2e-<random>`, and the daemon's working folder holding `watch.js`, `open.js` and `probe.js` (each puts its own name back in `argv` and imports the stand-in).
  - It starts `node <the run's bundle> start -f`, and fails by name when `HARNESS_PTY_BIN` is unset. `close` runs `harness stop`, then ends what is left.
- `vitest.e2e.windows.config.ts`: `include: ['e2e/dialWindows.e2e.ts']`, `globalSetup: ['./e2e/harness/bundle.ts']`, `setupFiles: ['./vitest.setup.ts', './e2e/harness/artifacts.ts']`, 180 s timeouts, one file at a time.

- [ ] **Step 1: Write the file**, `describe.runIf(process.platform === 'win32')` (the Linux e2e workflow finds it and skips it):
  - `harness device notify "Need you"` prints `no dial` before the dial greets, and `shown` after; the stand-in dial then gets a message holding `Need you`;
  - `askDevices(dataDir, { type: 'notify', mode: 'you' })` answers `{ mode: 'you' }`, and `dial-notify.json` holds it;
  - the real `harness device vscode link` prints `devicesReady: true`, a `devicesPipe`, a 64-digit `devicesToken` and a `devicesRecord` inside this daemon's data folder; a signed `{"type":"vscode","window":"<uuid>"}` on that pipe gets 200 with the proof and stays open 2 s;
  - a request with another token gets 401 `PIPE_AUTH_REQUIRED`; `askDevices` on a second data folder whose record names a pipe served by a plain server (no proof) is null;
  - the data folder is under a root named `Nguyễn Văn A' & 100%` (Review Focus 3).
- [ ] **Step 2:** on the VM (the tree synced, `npm ci`, the host built): `set E2E_BUNDLE=1` and `set HARNESS_PTY_BIN=C:\work\oh\pty\target\release\harness-pty.exe`, then `npx vitest run --config vitest.e2e.windows.config.ts` — every case passes. Write the result in the notes.
- [ ] **Step 3:** on the Mac: `npx vitest run --config vitest.e2e.config.ts e2e/dialStream.e2e.ts` still passes (`FakeDial.open` unchanged), and `npm run typecheck` passes.
- [ ] **Step 4: Commit** `The dial end to end on Windows: notify, the setting, a window's stream and the refusals, on a stand-in dial`.

### Task 24: A desk for hand checks, that leaves the dial as it found it

**Files:**
- Create: `cli/scripts/windows-dial-e2e/desk.mts`, `cli/scripts/windows-dial-e2e/console.ps1`, `cli/scripts/windows-dial-e2e/README.md`
- Modify: `cli/e2e/harness/windowsDaemon.ts` (the options the real-dial and sealed stand-in modes need: the env overrides below, and what a `LocalClient` needs to reach the daemon), `cli/e2e/harness/client.ts` (only if `LocalClient.connect` must take that in place of an `IsolatedDaemon`). What Task 23's run starts and sees does not change.

**Depends on:** 23. **Effort:** xhigh (it reads and writes back someone else's dial, and stops nothing of theirs but through The Dell's steps). **Red test:** none; a test tool, one commit.

**Interfaces:** `node --import tsx scripts/windows-dial-e2e/desk.mts <mode>`, run on the Windows machine. It refuses port 18473. A desk's first line is `{"desk":{"dataDir":…,"port":…,"root":…}}`, so a shell started for herdr or a hand-run hook can name them. Exit codes: 1 not on Windows; 2 bad arguments, before anything starts; 3 the port is busy; 4 the dial must not be greeted (a custom pet, or no `hello` in 10 s); 5 the settings were not restored.
- **The stand-in (`[--port <n>] [--sealed]`, no `--dial`)**: Task 23's daemon and `FakeDial`. Without `--sealed` (the VM's test user only) it uses the engines and apps of the user it runs as: no `CLAUDE_PATH`, `CODEX_PATH`, `HARNESS_VSCODE_BIN` or `HARNESS_CURSOR_BIN` override, `DISABLE_HOOK_INSTALL=false`, `USERPROFILE` left alone, the data folder in `%USERPROFILE%\.harness-dial-check`. With `--sealed` (the Dell) it is sealed exactly as Task 23 seals it. stdin takes one command a line: `list`, `tap <row>`, `rest <row>`, `say <row> <text>`, `pick <app>` (the dial's `{ t: 'app.pick', app }`, as `dialAppFilter.e2e.ts` sends it; `<app>` a host id), `quit`. It prints each dial message as one JSON line.
- **The look (`--dial-read <COMn> --out <file>`)**, read-only. It opens the port with the build's `harness-serial.exe open <COMn>` and decodes frames with `CableDecoder` (`cli/src/cable/cableFrame.ts`) until the dial's first `hello`, at most 10 s (the dial sends one unprompted every few seconds). It writes not one byte to the port, then closes it. It writes `<file>` (0600, whole) as `{"settings":{…the hello's settings…},"pets":<count of petIds>,"at":<ms>}`, with no serial and no mac, and prints `pets: <n>` and the settings' field names (never their values). A busy port: exit 3. No `hello`: exit 4. A port name not matching `^COM[1-9][0-9]{0,2}$`: exit 2.
- **The real dial (`--dial <COMn> --speech <text> --first-read <file> [--port <n>]`, the Dell)**: `startWindowsDaemon` sealed exactly as Task 23 seals it (its root, overrides and `DISABLE_HOOK_INSTALL=true`: nothing of the user it runs as is set up or read), with the daemon's own `harness-serial.exe` (no `HARNESS_SERIAL_BIN`, no `FAKE_SERIAL_*`), `HARNESSD_TEST_DIAL_PORT=<COMn>`, and `CABLE_FW_DISABLE=true`, which no flag turns off. `--first-read` is required and must hold `"pets":0`, else exit 4 before the daemon starts: a new desk's empty pet store would `pet.drop` every pack the dial holds ("Decided here"). It signs the daemon in to a `FakeBackend` on 127.0.0.1 (as `deviceHerdr.e2e.ts` does) whose transcript is `--speech` (at most 200 characters). A `LocalClient` window on the daemon keeps the latest `dial_status`. stdin takes `list` (the rows the daemon sent) and `quit`; the dial's presses are a person's. It prints the daemon's `[device]` and `cable:` log lines as they come, with any serial number cut to its last 4 characters.
  - **On `quit`, before the daemon stops**: if the dial is attached and the fields `settings.set` takes (`brightness`, `character`, `muted`, `quiet`, `straightTitle`, `focusFace`, `scrollReversed`, `voiceLang`, and `uiSkin` and `followCompanion` when the first read has them) differ from the first read, it sends one `dial_settings` with the first read's values for exactly those fields. It then waits up to 10 s for a `dial_status` whose settings equal them. It prints `settings: unchanged`, `settings: restored` (with the names of the fields written) or `settings: not restored` (exit 5). Values are never printed.
- `--quit-on <file>` (any desk mode): the desk acts as on `quit` once `<file>` exists, checked once a second. A desk started in a `console.ps1` task has no stdin to type into, and this is how the tester ends it.
- `quit` stops the daemon (`close`). In the sealed modes it also deletes the root.
- **`console.ps1 -Script <file.ps1> [-ArgsJson <json>] [-TimeoutSec 600] [-NoWait] | -Stop <name>`**, run over SSH as the owner's account on the Dell. It is `session-run.ps1`'s way, for the account it runs as, with no test user's receipt. It registers a one-shot task under that account with an interactive logon (`schtasks /it`; `New-ScheduledTaskPrincipal -LogonType Interactive`, as `session-run.ps1` does), with no password stored and a name `harness-dial-check-<random>`. It runs the task now, waits for it to end within the timeout, prints its exit code and its output (written to a file in the run's folder, then deleted), and deletes the task. It exits 3 when the account has no console session. A task still running at the timeout is ended and deleted. No console window shows: the task starts the script through the same no-window starter `session-run.ps1` compiles (`hxrun.exe`, built with `Add-Type` in the run's folder). `-NoWait` prints the task's name and returns at once, with no timeout of its own; the output file `<run folder>\<name>.log` grows as the script writes and is read over SSH. `-Stop <name>` waits up to 30 s for that task to end, then ends it, and deletes it and its log.

- [ ] **Step 1: Write** the script on `startWindowsDaemon`, `FakeDial`, `FakeBackend`, `LocalClient` and `CableDecoder`, then `console.ps1`, then the README. The README covers what each is for; the four modes; how to run each (the VM's test user's session; the Dell's console session through `console.ps1`); that the unsealed stand-in mode never runs as a person's own user; that the real mode touches nothing outside its root, never flashes the dial, starts only after a look that shows no custom pet, and leaves the settings as the look found them; and the order on the Dell (The Dell).
- [ ] **Step 2:** `npm run typecheck` passes. On the Mac, `node --import tsx scripts/windows-dial-e2e/desk.mts --sealed` exits 1 saying it runs on Windows. Each of these exits 2 before anything starts (checked on the Mac, before the platform check): `--dial COM3` with no `--speech`, `--dial COM3 --speech x` with no `--first-read`, `--dial /dev/tty1`, `--dial-read COM3` with no `--out`, `--quit-on` with no file, and `--port 18473`. `npx vitest run --config vitest.e2e.config.ts e2e/dialStream.e2e.ts` still passes (the harness change is additive).
- [ ] **Step 3: Commit** `A desk script for hand checks of the dial on Windows, on a stand-in or a real dial it leaves as it found it`.

### Task 25: The real-VS Code gate on Windows

**Files:**
- Modify: `plugins/harness-device-vscode/gate/realVscode.gate.ts`, `throwawayApp.ts`, `throwawayApp.test.ts`, `cleanup.ts`, `driver/run.cjs`
- Modify: the notes, section `## Task 25`

**Depends on:** 5, 8. **Effort:** high. **Red test:** none: it is the gate. One commit.

**Interfaces:** on Windows the gate:
- opens the listener with `pipe: { path: newPipePath(), dataDir }` in its root;
- makes the launcher the real `harness.exe` (`HARNESS_EXE_BIN`; unset, the gate fails saying so) at `<home>\.harness\bin\harness.exe`, in an install layout (`lib/windows/installLayout.ts`) whose `cli.js` prints the Windows link line for `device vscode link` and exits 1 for anything else;
- gives VS Code `USERPROFILE`, `LOCALAPPDATA` and `APPDATA` under the root and a PATH of `%SystemRoot%\System32` alone;
- speaks to its driver over a pipe (`\\.\pipe\harness-gate-<random>`);
- finds and ends the throwaway's processes through the Windows process table.
The macOS steps (the bundle id, LaunchServices, the preferences check) stay macOS-only.

- [ ] **Step 1: Implement**, with unit cases in `throwawayApp.test.ts` for what the Windows clean-up selects (only processes under the root).
- [ ] **Step 2:** on the Mac: `cd cli && npm run test:vscode` passes as before.
- [ ] **Step 3:** on the VM, in the test user's session: `set HARNESS_EXE_BIN=C:\work\oh\pty\target\release\harness.exe`, then `npm run test:vscode` — the extension reports the window's shells over the pipe, a `show` shows the terminal, a page key lands. Write the result and the VS Code version in the notes.
- [ ] **Step 4: Commit** `The extension's real-VS Code gate runs on Windows`.

### Task 26: `harness-pty raise` and `open-link`

**Files:**
- Modify: `pty/src/cli.rs` (`Command`, `parse`, `main`), `pty/src/lib.rs` (`pub mod raise;`)
- Create: `pty/src/raise.rs`, `pty/tests/raise.rs`
- Modify: the notes, section `## Task 26`

**Depends on:** none. **Effort:** high. `open-link` is how app links open on Windows (spec, Decided 11): `ShellExecuteW`'s Ex form, never `rundll32`.

**Since Task 1:** a link handler can be missing on a real machine: `vscode` and `cursor` appear in HKCU only after each editor's first start, and `claude` and `codex` only with their apps. `open-link` must then open nothing and show nothing (Decided here).

**Interfaces (produces):**
- `harness-pty raise --pid <n>` or `harness-pty raise --exe <name.exe>`: stdout is one word, `raised`, `refused` or `none`; exit 0.
- `harness-pty open-link <url>`: stdout `opened` or `refused`; exit 0.
- Off Windows both print `{"unsupported":true}` and exit 3, as `ps` does. A bad argument is the existing usage error, exit 2.
- `cli.rs`: `Command::Raise { target: RaiseTarget }`, `enum RaiseTarget { Pid(u32), Exe(String) }`, `Command::OpenLink { url: String }`.
  - `raise` takes exactly one of the two; `--pid` is 1 or more; `--exe` is a file name with no `\`, `/` or `:`, ending `.exe` in any case, at most 255 characters.
  - `open-link` takes one URL of at most 2,048 characters, with no control character or space, whose scheme is `claude`, `codex`, `vscode` or `cursor` followed by `://`.
- `raise.rs`: `pub struct Candidate { pub visible: bool, pub owned: bool, pub tool: bool }`; `pub fn pick(in_z_order: &[Candidate]) -> Option<usize>` (the first visible, unowned, non-tool one). On Windows, `raise(target)`: the target's top-level windows in `EnumWindows` order (a process by pid, or by image file name without case, as `desktop/win.rs` `image_of` reads one), `pick`, `ShowWindow(SW_RESTORE)` when `IsIconic`, `SetForegroundWindow`, then `raised` when `GetForegroundWindow` is that window. `open_link(url)`: `ShellExecuteExW` with `lpVerb` `"open"`, `lpFile` the URL and `fMask` `SEE_MASK_FLAG_NO_UI`; `opened` when it returns TRUE, `refused` otherwise (a scheme with no handler among them: no "pick an app" window).

- [ ] **Step 1: Write the failing tests**
  - `cli.rs`, in `parses_commands` and a new `refuses_bad_raise_and_link_arguments`: the three good forms parse; refused: both `--pid` and `--exe`, neither, `--pid 0`, `--exe C:\x\Code.exe`, `--exe code`, `open-link http://x`, `open-link "vscode://a b"`, a 2,049-character URL.
  - `raise.rs`: `pick` skips hidden, owned and tool windows and takes the first left; none gives `None`; `the_window_code_uses_only_the_documented_calls` reads `include_str!("raise.rs")` and finds none of `AttachThreadInput`, `SendInput`, `keybd_event`, `SystemParametersInfo`, `AllowSetForegroundWindow`; `the_link_code_asks_for_no_ui` finds `SEE_MASK_FLAG_NO_UI` in it.
  - `pty/tests/raise.rs` (`#![cfg(windows)]`): `raise --exe no-such-program.exe` and `raise --pid <a child with no window>` print `none`; a window this test makes and minimizes, raised by its pid, prints `raised` or `refused` and is no longer minimized; `open-link codex://harness-test` prints `refused` within 5 s where `AssocQueryStringW` finds no `codex` handler (the test reads it; skipped, saying so, where one is registered).
- [ ] **Step 2:** `cd pty && cargo test --locked -- cli:: raise::` on the Mac — FAIL (no `raise`). Commit red.
- [ ] **Step 3: Implement.** `USAGE`, `PROTOCOL` and `FEATURES` do not change.
- [ ] **Step 4:** the same run passes on the Mac. On the VM: `cargo test --locked --test raise` and `cargo test --locked -- raise::` pass; write the result in the notes.
- [ ] **Step 5: Commit** `harness-pty raises a window by Windows' own rules, and opens an app link`.

### Task 27: The Windows raise

**Files:**
- Create: `cli/src/cable/hosts/windowsRaise.ts`, `cli/src/cable/hosts/windowsRaise.spec.ts`

**Depends on:** 1 (the program names). **Effort:** high.

**Since Task 1:** the names are what Task 1 saw run or found in each install; which process owns each visible window could not be seen over SSH, and the Claude and ChatGPT apps were not installed. Task 37 reads them at the console; Task 38 corrects an entry that differs. This task does not wait for it.

**Interfaces (produces):**
- `type RaiseOutcome = 'raised' | 'refused' | 'none'`
- `WINDOWS_APPS: Readonly<Record<string, string>>` — from bundle ids (`APP_BUNDLES`' and `org.alacritty`, the set `open.ts` takes) to program names, exactly: VS Code `Code.exe` and Cursor `Cursor.exe` (seen running); Orca `Orca.exe` (the app's window program at the install root, not the CLI `resources\bin\orca.exe`: the helper matches image names without case, so the CLI's processes, the focus watch among them, match too and own no visible window, which `pick` passes over); WezTerm (`com.github.wez.wezterm`) `wezterm-gui.exe`, Warp (`dev.warp.Warp-Stable`) `warp.exe` and Alacritty (`org.alacritty`) `alacritty.exe` (in their installs, not seen running); the Claude app `Claude.exe` and the ChatGPT app `ChatGPT.exe` (not installed). A comment names Task 37 as the check for the last five. No other entry.
- `harnessDesktopLauncher(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): string | null` — `<LOCALAPPDATA>\Programs\Harness\Harness.exe` (by `path.win32`) when `LOCALAPPDATA` is an absolute path and the file is there; else null. The comment names `pty/src/desktop/mod.rs` as where the layout is defined.
- `interface WindowsRaiseDeps { binary(): string | null; run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }>; cursorCli(): string | null; desktopLauncher(): string | null; count(outcome: RaiseOutcome): void }`
- `interface WindowsRaise { app(bundle: string): Promise<boolean>; link(url: string, bundle?: string): Promise<boolean>; cursorFolder(folder: string): Promise<boolean>; desktop(): Promise<boolean> }`
- `createWindowsRaise(deps: WindowsRaiseDeps): WindowsRaise`
  - `app`: a bundle not in the table is `none`. Else `raise --exe <name>` with `RUN_TIMEOUT_MS`; the outcome is stdout's one word when the exit is 0, else `none`. Each call is counted once. True unless `none`: a `refused` raise (the taskbar flash) is a tap done.
  - `link`: the scheme is checked again (the four); `open-link <url>`; true when it says `opened`. Then `app(bundle)` when a bundle is given.
  - `cursorFolder`: `run(cursorCli, [folder])`; true when it exits 0; then `app(Cursor's bundle)`. No CLI: false.
  - `desktop`: `run(desktopLauncher, [], RUN_TIMEOUT_MS)` with no argument; true when it exits 0. No launcher: false, and nothing runs. Not counted (Decided here: a running Desktop raises its own window).

- [ ] **Step 1: Write the failing tests**:
  - `app` runs `[binary, 'raise', '--exe', 'Code.exe']` for VS Code's bundle, and the notes' program names for WezTerm's, Warp's and `org.alacritty`;
  - `raised\n` and `refused\n` are true and counted as themselves;
  - `none`, exit 2, exit 3, a null code, no binary, the word `raisedx`, and a bundle not in the table are false, counted `none`, and the last runs nothing;
  - `link` refuses `http://x` and `file:///c:/x` without a run, runs `open-link` then `raise` for `vscode://anthropic.claude-code/open?session=<id>`, and is false when the helper says `refused`;
  - `cursorFolder` runs the CLI with the folder as one argument, then raises Cursor;
  - `desktop` runs the launcher with no argument and is true on exit 0; false on exit 1 and on a null code; with no launcher it is false and runs nothing; it counts nothing;
  - `harnessDesktopLauncher({ LOCALAPPDATA: 'C:\\Users\\Nguyễn Văn A\' & 100%\\AppData\\Local' }, exists)` is `…\AppData\Local\Programs\Harness\Harness.exe` when `exists` says so, null when not, and null for no `LOCALAPPDATA` and a relative one;
  - nothing logged or counted holds an app's name.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/windowsRaise.spec.ts` — FAIL (no module). Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `A tap's app comes forward on Windows through the pty helper, and Harness Desktop through its launcher`.

### Task 28: One dispatch in each tap path

**Files:**
- Modify: `cli/src/cable/hosts/open.ts:48-74` (`OpenDeps`, the gate, `forward`, `bring`), `appLink.ts:11-44`, `cursorFolder.ts:27-52,74-78`, `vscode.ts:60,102`, `codexApp.ts:32-36`
- Test: their five specs

**Depends on:** 27. **Effort:** high. In `open.ts`, `appLink.ts` and `cursorFolder.ts` change only the deps' type, the platform gate and the one command line: dial-linux edits them too.

**Interfaces:** each of the five deps types gains `windows?: WindowsRaise`. Given, it opens the file's platform gate and replaces the one `open` command:
- `open.ts`: `forward(bundle)` is `deps.windows.app(bundle)`; `can`, `open` and `bring` run on Windows (a pick in the dial's app list brings its app forward, as on macOS); `desktop` is `() => { dropWaiting(); return deps.windows.desktop() }`, as macOS's `forward(HARNESS_BUNDLE)`.
- `appLink.ts`: `opens(session)` is `deps.windows.link(url, link.bundle)`.
- `cursorFolder.ts`: `focus` is `deps.windows.cursorFolder(pane.id)`.
- `vscode.ts:102`: `deps.windows.app(editorBundle)` after the terminal is shown.
- `codexApp.ts`: `forward()` is `deps.windows.app(APP_BUNDLES.codex)`.

- [ ] **Step 1: Write the failing tests**, each with `platform: 'win32'` and a fake `windows`: a tap on an Orca pane switches the terminal, then calls `app` with Orca's bundle; a tap with no pane calls `app` with the agent's bundle and answers what it answers; `bring('vscode')` calls `app` once and a second pick while it runs takes the waiting place; `bring('wezterm')` calls `app` with WezTerm's bundle; a tap whose `app` answers `refused` (true) is a tap done, and one that answers `none` (false) fails as a failed `open -b` does; `desktop()` calls `windows.desktop` once, drops a waiting pick, and answers what it answers; an app link calls `link` with the URL and the bundle, and `run` is never called with `open`; the Cursor folder calls `cursorFolder` with the folder, and refuses a path that is no folder first; a VS Code terminal tap shows the terminal, then calls `app`; Codex's failed link calls `app`. With no `windows`, on Windows, every path answers as today (`desktop` undefined).
- [ ] **Step 2:** `npx vitest run src/cable/hosts/open.spec.ts src/cable/hosts/appLink.spec.ts src/cable/hosts/cursorFolder.spec.ts src/cable/hosts/vscode.spec.ts src/cable/hosts/codexApp.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run passes with every macOS case untouched; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `Each tap path hands Windows its own way to bring the app forward`.

### Task 29: The devices wire the raise and count it

**Files:**
- Modify: `cli/src/services/devices.ts:364-510` (the adapters' wiring), `:270-271` and `:518` (two comments that say Windows has no listener)
- Test: `cli/src/services/devices.spec.ts`

**Depends on:** 12, 21, 27, 28. **Effort:** high.

**Interfaces:** `DevicesDeps.windowsRaise?: WindowsRaise` (tests). On Windows the devices make one `createWindowsRaise({ binary: ptyHostBinary, run: apps.run, cursorCli: () => editorCli(vscodeExtensionDeps('cursor', process.env.HARNESS_CURSOR_BIN)), desktopLauncher: () => harnessDesktopLauncher(), count })` and pass it as `windows` to the opener and to the Claude app, Codex app, VS Code, Cursor and Cursor folder adapters. `launchDesktop: opener.desktop` (`devices.ts:968`) stays as it is: defined on Windows now, it lets the cable host start Desktop for a tap on a Harness agent with no window (`cableHost.ts` `startDesktop`). `count` is `(outcome) => tally('window', outcome)`, on `tally = createEngineTally('[device] raise', ['window'], ['raised', 'refused', 'none'], log)`.

- [ ] **Step 1: Write the failing tests**: on Windows a tap on an outside agent in VS Code calls the injected raise's `app` with VS Code's bundle; a tap on a Harness agent with no window calls its `desktop`; with the real raise and a `run` that answers `refused`, the log has `[device] raise · window · refused` and a day line with `raised 0 refused 1 none 0`, and no line holds `Code` or a bundle id; on macOS no raise is made and no `[device] raise` line is logged.
- [ ] **Step 2:** `npx vitest run src/services/devices.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.** Correct the two comments.
- [ ] **Step 4:** the run passes; `npm run test:core` passes with `devices.ts` at 100%; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `The devices bring a tapped app forward on Windows, and count what Windows answered`.

### Task 30: The hook tells Cursor from VS Code, in a terminal and in the extension's panel, and names Alacritty

**Files:**
- Modify: `cli/hook/notify.mjs:509-605` (`HOST_HINTS`' comment, `hostHints`, `observedBody`), the paneless branch that calls `observedBody` (`:2275-2281`), and the kept answers beside `writeRegistry` (`:1866`)
- Test: `cli/src/hookNotify.spec.ts`

**Depends on:** 1 (the variables), 31 (the same two files, and the run's one table, `windowsListedRows`). **Effort:** xhigh (a table read on a Claude Code hook's path, which had none on Windows, and a state file the hook writes).

**Since Task 1:** `VSCODE_GIT_ASKPASS_NODE` is set in VS Code's integrated terminals only; Claude Code's VS Code extension starts `claude` with the extension host's environment (`VSCODE_PID`, no `VSCODE_GIT_ASKPASS_*`, plus `CLAUDE_CODE_ENTRYPOINT=claude-vscode`), so a session started from its panel needs a second input. Alacritty on Windows sets `ALACRITTY_LOG` and none of its Unix names. Why each input was chosen: "Decided here", "Cursor or VS Code, since Task 1" and "WezTerm, Warp and Alacritty". Cursor's extension host and the three terminals' shells are confirmed at the console by Task 37, and corrected by Task 38 if they differ.

**Interfaces:**
- On Windows only, for a paneless hook (the one path that builds hints), `async function windowsAppBundle(): Promise<string | undefined>`, awaited before `observedBody`, whose result `hostHints(appBundle)` puts in the `__CFBundleIdentifier` hint. The first that answers:
  1. `VSCODE_GIT_ASKPASS_NODE`: its `path.win32.basename`, any case, `Code.exe` gives `com.microsoft.VSCode`, `Cursor.exe` gives `com.todesktop.230313mzl4w4u92`; another name gives no hint and stops here. No process is started.
  2. `VSCODE_PID`, when it is 1 to 10 digits and a positive safe integer (answered 2026-11-20: kept, with its answer kept per editor):
     - its kept answer first: the entry of `hook-editors.json` whose `pid` is `VSCODE_PID` and whose `ipc` is `editorIpcKey()`, mapped no further (it holds the bundle id);
     - else the `executable` of that pid's row in `windowsListedRows()` (the run's one `harness-pty ps --json`, shared with Task 31's climb, within its 3000 ms limit inside the hook's budget), mapped as in 1. A bundle id found this way is kept (below). No row, another name, or no table or a late one gives no hint, keeps nothing, and stops here. The row's image name alone is read.
  3. `ALACRITTY_LOG` set and not empty: `org.alacritty`. Its value is never read.
  4. Else no hint.
- **The kept answers** ("Decided here", "The panel hint's kept answer"), in `notify.mjs`:
  - `const EDITORS_FILE = 'hook-editors.json'`, `EDITORS_MAX = 16`, `EDITORS_MAX_BYTES = 4096`; the file is `join(paths().dataDir, EDITORS_FILE)`, on Windows only.
  - `function editorIpcKey(): string | null`: the first 16 hex digits of SHA-256 of `VSCODE_IPC_HOOK` when it matches `^\\\\\.\\pipe\\[^\\]{1,200}$`, else null. With null nothing is read or kept.
  - `function readEditors(file): Array<{ pid: number; ipc: string; app: string }>`: `readPrivateStateFile(file, EDITORS_MAX_BYTES)` and a strict parse of `{"editors":[…]}` (a positive safe-integer `pid`, 16 lowercase hex `ipc`, `app` one of the two editor ids). A missing file, one too big, not JSON, of another shape, a link, or of another owner reads as `[]`.
  - `function keepEditor(file, entry): void`: the entry first, the others with another `(pid, ipc)` after it, cut to `EDITORS_MAX`, written whole as `writeRegistry` writes (`secureStateDirectory`, `hardenPrivateStateFileIfPresent`, an `O_EXCL | O_NOFOLLOW` temp file at 0600, fsync, rename, `syncStateDirectory`). It never throws: a failed write keeps nothing. Its comment says it is the hook's copy of `atomicWriteJson` and `readState`, because `notify.mjs` imports nothing from `src/`.
- On Windows the environment's own `__CFBundleIdentifier` is never sent. Only the id leaves the process: never a path, a pid or a value. At most `MAX_HINTS`. Elsewhere `hostHints()` and the hints are today's, and none of the three variables is read.
- WezTerm and Warp need nothing here: `WEZTERM_PANE` and `TERM_PROGRAM` are sent today; the report confirms both against Task 37's notes when they exist, else says they are read from source.

- [ ] **Step 1: Write the failing tests** in `describe('hook notify: a session outside a pane')`, with the platform read as Windows (the pipe's preload, `windowsData`), the fake `harness-pty` of `windowsAncestors` (its rows have pid 9000 + n) and `psRunLog`:
  - terminal: `VSCODE_GIT_ASKPASS_NODE` `…\Microsoft VS Code\Code.exe` gives VS Code's id, `…\cursor\Cursor.exe` Cursor's, `CURSOR.EXE` too; `Windsurf.exe` and an empty value give no `__CFBundleIdentifier` hint; in each, `ps-runs` does not exist (no table read), with `VSCODE_PID` set as well;
  - panel: `engine: 'claude'`, `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, no `VSCODE_GIT_ASKPASS_NODE`, `windowsAncestors: [claude.exe, Code.exe]` and `VSCODE_PID=9001`: VS Code's id, and `ps-runs` has exactly one line; with `Cursor.exe` there, Cursor's; `VSCODE_PID=9007` (no row), `VSCODE_PID=abc` and `VSCODE_PID=0` give no hint, the last two with no `ps-runs`; a fake helper that exits 1 gives no hint;
  - `engine: 'codex'` in the panel (`VSCODE_PID=9002`, `windowsAncestors: [powershell -Command, codex.exe, Code.exe]`): VS Code's id, the caller Task 31 names, and `ps-runs` has exactly one line (one table for both readers);
  - a Claude Code hook with none of the three variables: no hint and no `ps-runs`;
  - Alacritty: `ALACRITTY_LOG` alone gives `org.alacritty`, and its value appears nowhere in the body, with no `ps-runs`; `ALACRITTY_LOG` with a `…\Code.exe` askpass gives VS Code's id; `ALACRITTY_LOG` with `VSCODE_PID` naming `Code.exe` gives VS Code's id; `ALACRITTY_LOG` with `VSCODE_PID` naming no row gives no hint;
  - a `__CFBundleIdentifier` set in the environment is not sent; no askpass path, pid or log path is in the body; at most `MAX_HINTS` hints;
  - `describe('the panel hint kept per editor')`, every case with `VSCODE_IPC_HOOK=\\.\pipe\0a1b2c3d-1.106.0-main-sock` unless it says otherwise:
    - `it('a second hook reads no table')`: two panel hooks with `VSCODE_PID=9001` (row `Code.exe`) both give VS Code's id, and `ps-runs` has one line; `hook-editors.json` is mode 0600 and holds neither `VSCODE_IPC_HOOK`'s value nor any path;
    - `it('another editor on the same pid misses')`: then a hook with `VSCODE_PID=9001`, another `VSCODE_IPC_HOOK` and the row now `Cursor.exe` gives Cursor's id, and `ps-runs` has two lines;
    - `it('keeps nothing without the editor\'s pipe')`: no `VSCODE_IPC_HOOK`: two hooks give VS Code's id, `ps-runs` has two lines, and there is no file;
    - `it('keeps no failure')`: `VSCODE_PID=9007` (no row), and a fake helper that exits 1: no hint and no file; the next hook with a row reads the table;
    - `it('holds sixteen')`: twenty hooks with pids 9001-9020 (each row `Code.exe`) leave 16 entries, the last sixteen;
    - `it('replaces a file it cannot read')`: a 5,000-byte file and a file `not json` are each read as empty, and the hook writes the file whole with its one entry; a link at the file's path gives the hint from the table and the link's target is unchanged;
    - `it('serves only the hint')`: a Codex panel hook whose answer is kept still reads the table once for its caller (Task 31);
    - on macOS and Linux no file is read or written.
  - on macOS and Linux none of the three variables is read and the hints are today's.
- [ ] **Step 2:** `npx vitest run src/hookNotify.spec.ts -t "outside a pane"` — FAIL. Commit red.
- [ ] **Step 3: Implement.** Extend `HOST_HINTS`' comment: the three inputs on Windows and why, and that the panel's costs a pty-host start when its kept answer misses, and why the key is the editor's pipe and not the start time.
- [ ] **Step 4:** `npx vitest run src/hookNotify.spec.ts src/architecture.environment.spec.ts src/cable/hosts/hostDetect.spec.ts src/lib/stateWrites.guard.spec.ts` passes; `git diff --stat` names nothing under `cli/src/core/`.
- [ ] **Step 5: Commit** `On Windows the hook says which editor or Alacritty it runs in: the editor's terminal, the extension's panel, Alacritty's shell`.

### Task 31: The hook's caller on Windows

**Files:**
- Modify: `cli/hook/notify.mjs:686-733` (the climb), `:773` and `:915` (its two callers), `:1334` (one read a run)
- Test: `cli/src/hookNotify.spec.ts` (`RunHookOpts`, `describe('hook notify: the caller a hook names')`)

**Depends on:** none. **Effort:** xhigh (every hook's path; the core's check reads the result).

**Interfaces:**
- On Windows, for the engines `codex`, `copilot` and `commandcode`, the caller is found by climbing from `process.ppid` through the rows of `windowsProcessRows()`, at most 8 steps:
  - a row is a command shell when its image is `powershell.exe`, `pwsh.exe` or `cmd.exe` (any case) and its `nativeArgv` has it run a command;
  - PowerShell: before its first word that is no option, a word that is `-c` or a longer prefix of `-Command`; the value of an option that takes one (`-ExecutionPolicy`, `-WindowStyle`, `-InputFormat`, `-OutputFormat`, `-ConfigurationName`, `-WorkingDirectory`, `-CustomPipeName`, `-SettingsFile`, `-Version`, `-PSConsoleFile`, by PowerShell's own prefixes) is no word of its own;
  - cmd: among its leading `/` switches, `/c` or `/r` before any `/k`;
  - the climb stops at the first row that is no command shell, at a pid the table does not hold, and at a parent that is not in the table (the shell itself is then named).
- Every other engine, and no table (no helper, a failed or late read): `process.ppid`, with no helper started for the climb.
- The table is read once a run: the climb and the hook's other readers share the same promise.
- `RunHookOpts.windowsAncestors?: Array<{ executable: string; argv: string[] } | null>`: the hook's ancestors on Windows, nearest first, as `procAncestors` is for Linux (the first is the hook's real parent, row n has pid 9000 + n, the last one's parent is absent, null is a pid the table does not hold). The fake `harness-pty` prints them and appends a line to `<bin>/ps-runs` each time it runs.

- [ ] **Step 1: Write the failing tests**, `it.each` over `[case, ancestors, the index named]` with `engine: 'codex'`, and `const engine = { executable: 'codex.exe', argv: ['codex.exe'] }`:
  - `['powershell.exe', '-NoProfile', '-Command', '& x']`, engine → 1
  - `['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '& x']`, engine → 1
  - `['pwsh.exe', '-NoLogo', '-NoProfile', '-c', '& x']`, engine → 1
  - `['PowerShell.EXE', '-COMMAND', '& x']`, engine → 1
  - `['cmd.exe', '/d', '/s', '/c', 'x']`, engine → 1; `['CMD.EXE', '/C', 'x']`, engine → 1
  - `cmd /c`, then `powershell -Command`, then engine → 2
  - ten `cmd.exe /c` in a row → 8
  - `['powershell.exe']`, engine → 0; `['powershell.exe', '-File', 'run.ps1']`, engine → 0
  - `['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'run.ps1', '-c']`, engine → 0
  - `['pwsh.exe', 'run.ps1', '-Command', 'x']`, engine → 0; `['powershell.exe', '-EncodedCommand', 'AAAA']`, engine → 0
  - `['cmd.exe', '/k', 'x']`, engine → 0; `['cmd.exe']`, engine → 0
  - `['node.exe', '-c', 'x.js']`, engine → 0
  - `cmd /c`, then null → 1; a single `cmd /c` whose parent is absent → 0

  And:
  - `engine: 'commandcode'` and `'copilot'` climb the same way; a paneless hook names by the same rule;
  - `engine: 'claude'` under `powershell -Command` names its parent (index 0), and `ps-runs` does not exist;
  - a fake helper that exits 1 names index 0;
  - a pane hook for Codex leaves `ps-runs` with exactly one line;
  - the Linux and macOS cases are untouched.
- [ ] **Step 2:** `npx vitest run src/hookNotify.spec.ts -t "the caller a hook names"` — the Windows cases FAIL (index 0 named). Commit red.
- [ ] **Step 3: Implement.** Extend the function's comment: the Windows shells, why only three engines, why the table is the pty host's.
- [ ] **Step 4:** `npx vitest run src/hookNotify.spec.ts src/architecture.environment.spec.ts` passes; `git diff --stat` names nothing under `cli/src/core/`.
- [ ] **Step 5: Commit** `On Windows a hook run through PowerShell or cmd names the process above the shell`.

### Task 32: The caller, with real processes

**Files:**
- Create: `cli/src/hookCaller.windows.real.spec.ts`
- Modify: the notes, section `## Task 32`

**Depends on:** 31. **Effort:** medium. **Red test:** none on the branch: it pins Task 31. Its run on the base's `notify.mjs` (the shell's pid named) is the report's evidence. One commit.

- [ ] **Step 1: Write the file**, `describe.runIf(process.platform === 'win32' && !!process.env.HARNESS_PTY_BIN)`. A stand-in daemon as `daemonPipeClients.windows.real.spec.ts` makes one (a data folder with the token and the record of a real pipe, `listenLocalSocket` on it), collecting each body. A paneless `Stop` payload on stdin:
  - through `powershell.exe -NoProfile -Command "& '<node>' '<notify.mjs>' --port <n> --data-dir <dir> --engine codex"`: `callerPid` is `process.pid`;
  - through `cmd.exe /d /s /c "<node> <notify.mjs> … --engine commandcode"`: the same;
  - run with no shell and no `--engine`: `callerPid` is `process.pid`.
  Each child is started with `windowsHide: true`.
- [ ] **Step 2:** on the VM, `set HARNESS_PTY_BIN=C:\work\oh\pty\target\release\harness-pty.exe` and `npx vitest run src/hookCaller.windows.real.spec.ts --maxWorkers=1` — passes; with the base's `notify.mjs` in place the first two cases fail. Write both results in the notes.
- [ ] **Step 3: Commit** `A real PowerShell and a real cmd: the hook names the process above them`.

### Task 33: What the climb costs

**Files:**
- Modify: the notes, section `## Task 33`

**Depends on:** 31. **Effort:** medium. **Red test:** none; one commit. The `over 50 ms` line is the VM's (the plan's rule); the Dell's numbers go beside it.

- [ ] **Step 1:** on the VM, against Task 23's daemon, time a Codex-style hook 20 times each on the base's `notify.mjs` and on the branch's: `powershell.exe -NoProfile -Command "& node notify.mjs --port <n> --data-dir <dir> --engine codex"` with a `Stop` payload on stdin. Time `harness-pty ps --json` alone 20 times as well. Then time Task 30's panel hint: a paneless Claude Code `Stop` hook (`--engine claude`) with `VSCODE_PID` the running `Code.exe`'s pid and `VSCODE_IPC_HOOK` copied from its extension host (Task 1 §6). Run it 20 times with `hook-editors.json` deleted before each (a miss: one table read), and 20 times with it in place (a hit: no table read), against the base's `notify.mjs` with the same environment. On the Dell (The Dell, after the VM), the same timings once, for x64, in the sealed root (no editor there, so the panel hook's two cases use a stand-in `VSCODE_PID` of a process the run started).
- [ ] **Step 2: Write** for each: median, p95, the process count on the VM at the time, the build. One line says how much the climb adds at the median, one how much the panel hint adds on a miss and on a hit, and a last line says `over 50 ms: yes` or `over 50 ms: no` (the climb's, the plan's rule).
- [ ] **Step 3: Commit** `The hook's time on Windows before and after the climb: numbers`. The main session puts them in the pull request. At 50 ms or less added at the median, the whole-table read stays and Task 36 is not run. Over 50 ms, Task 36 runs in this branch, and Task 35 then waits for it too.

### Task 34: windows.yml runs the new checks

**Files:**
- Modify: `.github/workflows/windows.yml:179-193` (the vitest list), and one new step after it

**Depends on:** 6, 8, 13, 15, 17, 23, 32. **Effort:** medium. **Red test:** none; one commit.

- [ ] **Step 1:** add to `$paths` of "Contract suite against the real host, and the Windows CLI specs": `'src/devices/listenerPipe.windows.real.spec.ts'`, `'src/devices/claudePlugin.windows.real.spec.ts'`, `'src/deviceClaude/inbox.windows.real.spec.ts'`, `'src/hookCaller.windows.real.spec.ts'`, `'src/harnessDevicePlugin.spec.ts'`, `'../plugins/harness-device-vscode/src'`.
- [ ] **Step 2:** add the step, with `if: ${{ !inputs.release }}`, `working-directory: cli`, `shell: pwsh`, env `E2E_BUNDLE: "1"` and `HARNESS_PTY_BIN` as the step above sets it:
  ```yaml
      - name: 'The dial, end to end, on a stand-in dial'
        run: npx vitest run --config vitest.e2e.windows.config.ts
  ```
  Its comment says what it starts (a daemon in a temp root, a stand-in dial) and that it reaches nothing outside the runner.
- [ ] **Step 3:** `actionlint .github/workflows/windows.yml` passes; `cd cli && npx vitest run src/scripts/windowsCiChecks.spec.ts` passes. The workflow keeps `permissions: contents: read` and gains no secret.
- [ ] **Step 4: Commit** `windows.yml runs the devices' pipe, the hook's caller, the plugin's tests and the dial end to end`.

### Task 35: The guides say Windows

**Files:**
- Modify: `cli/AGENTS.md` (the devices row of "The processes"), `docs/cli.md:32` (`harness device notify`), `docs/windows-rules.md`

**Depends on:** 13, 16, 17, 18, 19, 20, 24, 25, 29, 30, 33, 37, 39, and 36 and 38 when they run. **Effort:** medium. **Red test:** none; one commit.

- [ ] **Step 1: `cli/AGENTS.md`**, the devices row, in its own words: on Windows the listener is a named pipe with its own token and record (`devices/listenerPipe.ts`); herdr over its pipe; `codex queue` and every other program through `lib/windows/program.ts`; a tap raises the app through `harness-pty raise` (`cable/hosts/windowsRaise.ts`); the dial skill, the plugin and the extension are set up on Windows too.
- [ ] **Step 2: `docs/cli.md`**: `harness device notify` prints `no dial` only where the devices run inside the core; Windows is gone from that sentence.
- [ ] **Step 3: `docs/windows-rules.md`**: each new rule a task's report names (what happened, what was measured, the rule, its test), and Task 1's three that hold for any Windows work: an app's own `.cmd` may be a forwarder, not an Electron launcher (Orca's: run its `.exe`); a launcher's paths change with each update (read it at every start); a link handler may be missing until its app first starts (open with no UI). And Task 2's two: Claude Code's mod runtime refuses a pipe path in `socketPath` and has no HMAC, so a mod reaches Harness through `harness.exe` (Tasks 15, 16, 39); `$.process.run` of a missing absolute path resolves with exit 1 instead of rejecting (check with `$.fs.exists`).
- [ ] **Step 4:** every file and link the changed lines name exists.
- [ ] **Step 5: Commit** `The guides describe the dial on Windows`.

### Task 36 (only if Task 33 says over 50 ms): One pid's chain from `harness-pty`

**Files:**
- Modify: `pty/src/cli.rs` (`Command::Ps`, `parse`), `pty/src/ps.rs`
- Modify: `cli/hook/notify.mjs` (the climb's read, Task 31's, and the panel hint's, Task 30's), `cli/src/hookNotify.spec.ts`
- Modify: the notes, section `## Task 36`

**Depends on:** 30 (its panel hint is the table's other reader, in the same file), 31, 33. **Effort:** xhigh (every Codex, Copilot and Command Code hook's path).

**Interfaces:**
- `harness-pty ps --json --ancestors <pid>`: the rows (`ProcessRowJson`, as today) of `<pid>` and its parents, nearest first, at most 9 rows; it stops at a parent the snapshot does not hold. One Toolhelp snapshot as today, and a process is opened for its marker and command line only when it is on the chain. Off Windows `{"unsupported":true}`, exit 3, as `ps` does. `--ancestors 0`, a missing or non-number value: the usage error, exit 2. `ps --json` alone is unchanged (the core's check reads it).
- `cli.rs`: `Command::Ps { ancestors: Option<u32> }`.
- `notify.mjs`: the climb reads `ps --json --ancestors <process.ppid>` and nothing else changes in its rules; a helper that answers exit 2 (an older host) gives `process.ppid`, as no table does. Task 30's panel hint, on a miss of its kept answer, reads `ps --json --ancestors <VSCODE_PID>` and takes its first row (that pid's own), so a hook reads one chain or two and never the whole table; with both readers in one run, the two reads start together. The other readers of the run's table keep the whole table only if they need rows off the chain; the implementer lists them in the report.

- [ ] **Step 1: Write the failing tests**
  - `cli.rs` `parses_commands`: `["ps", "--json", "--ancestors", "42"]` is `Command::Ps { ancestors: Some(42) }`, `["ps", "--json"]` is `ancestors: None`; refused: `--ancestors 0`, `--ancestors x`, `--ancestors` with no value.
  - `ps.rs`: a pure `chain(rows_by_pid, pid, max) -> Vec<u32>` over a fake table: a chain of 12 gives 9; a parent missing stops it; a loop (a pid that is its own grandparent) stops at the first repeat.
  - `hookNotify.spec.ts`: the fake `harness-pty` records its arguments; a Codex hook runs it with `ps --json --ancestors <ppid>` once; a fake that exits 2 names index 0; every case of Task 31's `it.each` still names the same index; Task 30's panel case runs it with `--ancestors 9001` and still gives VS Code's id.
- [ ] **Step 2:** `cd pty && cargo test --locked -- cli:: ps::` and `cd cli && npx vitest run src/hookNotify.spec.ts -t "the caller a hook names"` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** both runs pass; `npx vitest run src/architecture.environment.spec.ts` passes. On the VM, Task 33's timing again on the branch; write the new median and p95 in the notes.
- [ ] **Step 5: Commit** `A hook reads only its own parent chain from harness-pty on Windows`.

### Task 37: VM console probe: the Store apps, window owners, the shells' environments (no person)

**Files:**
- Modify: `docs/plans/2026-11-19-dial-windows-vm-notes.md`, section `## Task 37`

**Depends on:** 1 (the test user and the apps it installed). **Effort:** xhigh (it sets autologon with a password and restarts the VM). **Red test:** none; findings, one commit. **No person:** the agent does every step (The VM, "Signing the test user in" and "Console steps"). It restarts the VM, so it runs alone there: no other task uses the VM until its commit.

- [ ] **Step 1: Sign the test user in**, as The VM says: read the Winlogon values, set autologon for `hxdialwin` with the password on stdin from `users.txt`, `shutdown /r /t 0`, wait for SSH (at most 5 minutes, else stop and report: the VM is restarted for the task, which does not restart it again), then `desktop-e2e.sh session-on`, whose screenshot shows the user's desktop.
- [ ] **Step 2: Put the Winlogon values back** as they were read (`DefaultPassword` deleted unless it was there), and read them again to check. The session stays signed in.
- [ ] **Step 3: Install the Store apps** for `hxdialwin` alone, signed in to nothing: `winget install --source msstore --accept-package-agreements --accept-source-agreements` with the Claude app's and the ChatGPT app's Store ids (found with `winget search --source msstore`), each as a one-shot interactive task in that user's session (`schtasks /create /it /ru hxdialwin … /run`, through `desktop-e2e.sh run`). Start each once. An app with no build for this VM, or that winget cannot install there, is written down as that, with winget's exit code and its last lines. Cursor's first-run screen (Task 1 §6) is passed by the agent in that session (`uia.ps1`, `input.ps1`, a `desktop-e2e.sh shot` to see it); if it cannot be passed, the note says so and item 4's Cursor half stays open.
- [ ] **Step 4: Write the notes**, one heading each, names and shapes only (as Task 1 §6):
  1. **Window owners**: with VS Code, Cursor, Orca, the Claude app, the ChatGPT app, WezTerm (`wezterm-gui.exe start`), Warp and Alacritty each open, the image name of the process that owns its visible, unowned top-level window. The agent reads this in that session (`EnumWindows`, `GetWindowThreadProcessId`, then the image name: `desktop-e2e.sh run app-processes.ps1` and `watch-windows.ps1`), with a screenshot only when an owner is in doubt. Each against Task 27's `WINDOWS_APPS` entry: same, or "Contradicts Task 27".
  2. **The ChatGPT app**: its program's name; whether its install holds a `codex` of its own, and where; whether a thread started in the app takes `codex queue` from the PATH `codex`. If only from the app's own, say so first in the section (the stop condition).
  3. **Link handlers** now: whether `claude` and `codex` resolve to a handler (`AssocQueryStringW`, read only), and what Task 26's `open-link codex://harness-test` does when none does (prints `refused`, and `watch-windows.ps1` records no window).
  4. **Cursor's shells**: in an integrated terminal of Cursor, whether `VSCODE_GIT_ASKPASS_NODE` names `Cursor.exe`; in Cursor's extension host (Task 1's probe extension), whether `VSCODE_PID` is set and its row's image name is `Cursor.exe`. In VS Code, with Claude Code's extension and its panel open, a throwaway `SessionStart` hook (a throwaway `CLAUDE_CONFIG_DIR`, the test key as The VM says) prints its environment's names: `VSCODE_PID` there and its row `Code.exe`, `VSCODE_IPC_HOOK` there in the shape `\\.\pipe\<hex>-<version>-main-sock` (the kept answer's key), and no `VSCODE_GIT_ASKPASS_NODE`. The same in Cursor if Claude Code's extension installs there, and whether Cursor's `VSCODE_IPC_HOOK` differs from VS Code's (it must, or the two editors would share kept answers on a reused pid). The panel is opened by the agent (`uia.ps1`). Each against Task 30: same, or "Contradicts Task 30".
  5. **The terminals' shells**: in a shell of WezTerm, of Warp and of Alacritty, whether `WEZTERM_PANE` is set, whether `TERM_PROGRAM=WarpTerminal`, and whether `ALACRITTY_LOG` is set in Alacritty's and in neither of the others'. Each against Task 30: same, or "Contradicts Task 30".
  6. That the notes hold no key (Task 2's `findstr` check).
  7. That autologon was set for this task and removed (Steps 1 and 2), with the values read back.
- [ ] **Step 5:** if 1, 4 or 5 says "Contradicts", the section ends with the list of entries Task 38 changes, each with the name seen.
- [ ] **Step 6: Commit** `What the VM's console shows: the Store apps, each app's window, the shells' environments: notes`.

### Task 38 (only if Task 37 contradicts Task 27 or Task 30): The names the console showed

**Files** (only those the contradiction needs):
- Modify: `cli/src/cable/hosts/windowsRaise.ts` (`WINDOWS_APPS`), `cli/src/cable/hosts/windowsRaise.spec.ts`
- Modify: `cli/hook/notify.mjs` (`windowsAppBundle`), `cli/src/hookNotify.spec.ts`

**Depends on:** 27, 30, 37. **Effort:** high.

**Interfaces:** Task 27's and Task 30's, with the names Task 37's list gives. A variable a terminal or Cursor does not set is dropped from `windowsAppBundle`, and the report says which session then reaches no app on Windows (for the pull request's "Where Windows differs"); no new input is added without the main session asking harness-pm.

- [ ] **Step 1: Write the failing tests**: each listed entry's case in `windowsRaise.spec.ts` (`app` runs `raise --exe <the name seen>`) or `hookNotify.spec.ts` (the variable seen gives the id; the one not set is no longer read).
- [ ] **Step 2:** `npx vitest run src/cable/hosts/windowsRaise.spec.ts src/hookNotify.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `The app names and variables Windows showed at the console`.

---

## Verification

**Unit tests** are each task's Step 4, on the Mac, nothing outside the worktree.

**PR CI (Linux, automatic):** `cli-typecheck`, `cli-tests` (the CLI's suite with the extension's tests), `pty-checks` (`cargo test` for `pty`: the `raise` and `open-link` parsing and `pick`), `process-checks`.

**Local gates PR CI does not run** (on the Mac, at the final head, receipts in the pull request):
- `python3 scripts/local-checks.py --run` from a clean tree: it plans `cli-core` (`npm run test:core`, since `cli/src/services/*` changes) and `cli-pty` (`npm run test:terminal-contract`, since `pty/*` changes), and prints the receipts to paste.
- `cd cli && npm run test:vscode`: the extension in a real VS Code, downloaded into a temp root (a window opens for about three minutes). Required because `plugins/harness-device-vscode/` and `devices/vscodeExtension.ts` change.
- The Orca plugin: `plugin test .`, `plugin check .`, `orca plugin validate .` and the type check, as in Task 9 (empty home, bare PATH). No runner has Orca's CLI.
- Claude Code's plugin: `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin validate plugins/harness-device`, then `… claude plugin test plugins/harness-device`.
- The dial e2e files that run only on a Mac: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts e2e/dialTerminalFollow.e2e.ts e2e/dialCodexApp.e2e.ts e2e/deviceCodex.e2e.ts`. Isolation is `IsolatedDaemon`'s own (a private root, port, tmux server, fake engines, a fake `open`, signed out). They guard that macOS did not change.

**On GitHub, by hand, once each, after the final review, never both at once:**
- **Windows** (`gh workflow run windows.yml --ref feat/dial-windows`; the heavy lane is granted by harness-pm). On x64 and arm64 a person sees every job green, and in the logs: the Rust tests with `raise` and `open-link`; the vitest list with `listenerPipe.windows.real.spec.ts`, `claudePlugin.windows.real.spec.ts`, `inbox.windows.real.spec.ts`, `hookCaller.windows.real.spec.ts`, `harnessDevicePlugin.spec.ts`, `program.spec.ts` and the extension's tests; the step "The dial, end to end, on a stand-in dial" with its four cases. Everything runs in the runner's temp folders against daemons it starts itself.
- **CLI end to end** (`gh workflow run cli-e2e.yml --ref feat/dial-windows`): the Linux shards, with `dialStream`, `dialVscode`, `dialAppFilter` and `deviceHerdr`. They guard that Linux did not change. `dialWindows.e2e.ts` shows as skipped there.

**On the VM** (The VM: the owned test user, its desktop session, a daemon of its own on port 18478, signed out, the stand-in dial; the builds are the branch's). Task 37 comes first: the agent alone on the VM, which it restarts, signs the test user in and leaves that session up for the checks below. Each result goes in the pull request:

1. **notify rings the dial.** Start Task 24's desk. In another window of the same user: `harness device notify "Need you"`. It prints `shown`, and the desk prints the notice. `harness device notify` with the desk stopped prints `no dial`.
2. **The e2e on the VM**: Task 23's command; four cases pass.
3. **The extension's gate**: Task 25's command against a downloaded VS Code; it passes.
4. **herdr.** herdr 0.9.5 with an agent in a pane (a shell stands in when no engine is signed in). The desk's `list` shows it; `say <row> hello` types `hello` into that pane; `tap <row>` focuses it.
5. **Orca.** Orca installed for the test user (its `resources\bin` not on PATH, as installed), the plugin installed from the checkout (`orca.exe plugin install`, approved as Orca shows). With the desk up, the panel says "Dial attached."; `say <row>` with a text holding a line break and `&` reaches an agent in an Orca terminal whole (through `orca.exe`, never `orca.cmd`: `harness-pty ps --json` shows no `cmd.exe` under the devices); `rest <row>` switches Orca to it; stopping the desk leaves no `orca.exe` process (the focus watch ended). `orca.exe plugin test .` in the plugin's folder passes.
6. **Claude Code and Codex, real**, on the VM with the test key (The VM: cheap models, throwaway `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, the desk's isolated data folder; never a person's account). With the stand-in dial attached, Harness finds `claude.exe` in `<profile>\.local\bin` (not on PATH) and installs the plugin and the skill into the test user's homes. A Claude Code session started from VS Code's panel (Claude Code's extension, the test key) is listed on the desk with VS Code's id, and `tap <row>` on it opens its `vscode://` link and brings VS Code forward; the same from an integrated terminal. A permission prompt in Claude Code shows on the desk. **The mod's voice, through the CLI** (Tasks 15, 16, 39), in a standalone Claude Code session (`claude.exe` in a PowerShell window of the test user's desktop, the plugin as Harness installed it above, on in the throwaway `CLAUDE_CONFIG_DIR`): `harness-pty ps --json` shows one `harness.exe device claude inbox <id>` with its `node.exe` under `claude.exe`, and no daemon or devices token in any argument; `say <row> hello` on the desk submits `hello` as the person's prompt in that session; opening that session in the Claude app (if Task 37 installed it; else skipped and said so) turns the desk to its row through `attach`. Then `claude plugin disable` in that home: the follower prints its last line and ends, and no `harness.exe … inbox` is left within 60 s. Killing that `harness.exe` by its pid: its `node.exe` ends within 30 s, and a new follower runs within 20 s (the restart's bound). Quitting Claude Code (`/exit`): no `harness.exe` or `node.exe` of the inbox is left within 30 s. A Codex thread takes `say` through `codex queue`; a Codex thread takes `say` through `codex queue`; Claude Code's hook runs under Git Bash, and under PowerShell as Task 2's notes show it, with no window shown; a Codex `Stop` hook names the caller above its shell (Task 31) and the held core does not refuse it. No transcript or log copied off the VM holds the key.
7. **The raise, measured.** VS Code, Cursor, Orca, the Claude app, the ChatGPT app, WezTerm, Warp and Alacritty open with an agent each (those Task 37 could install; each editor started once before, so its link handler exists). A session in Alacritty is raised by `ALACRITTY_LOG` alone; Orca is raised while its focus watch's `orca.exe` runs. Through `desktop-e2e.sh run`, a script sends `tap` to the desk at least 30 times in each of three situations: Harness idle and another app in front; keys being typed into another app (`input.ps1`); the target minimized. Count `raised`, `refused` and `none` from the daemon's `[device] raise` day line. The three rates go in the pull request. Any rate ships (spec, decided 7). A `refused` tap shows no line on the dial; a `none` shows macOS's failure line. `pick <app>` on the desk (the dial's app-list pick) brings that app forward.
   - **Harness Desktop**, installed for the test user alone (the released per-user install, `%LOCALAPPDATA%\Programs\Harness`, signed out). With Desktop closed, `tap <row>` on a Harness agent of the desk's daemon starts it, and `desktop-e2e.sh shot` shows its window; with Desktop hidden in the tray, the same tap brings its window back. The tester looks at the two shots.
8. **Nothing flashes.** `desktop-e2e.sh run watch-windows.ps1` (with its `-Probe` once, as the positive control) through each new flow: the daemon's start, `notify`, a `link` from VS Code and from Orca, the extension's install, `claude plugin` setup, a `codex queue`, an Orca send, a tap of each kind (app, link, Cursor folder), an `open-link` of a scheme with no handler, a Codex-style hook, a Claude Code hook from VS Code's panel, and the mod's follower starting and an `attach` run (Verification 6's session). No `CONSOLE` line from a Harness process, and no "pick an app" window.
9. **The numbers**: the mod's follower on an idle VM (the desk up with the stand-in dial attached, nothing said): with 0, 1 and 3 standalone Claude Code sessions holding it, for 10 minutes each, the VM's CPU (`Get-Counter '\Processor(_Total)\% Processor Time'` every 5 s: mean and p95) and, per session, the CPU seconds and working set of its `harness.exe` and `node.exe` at the end (`Get-Process`); the pty host starts in that time (at most one table read a minute per follower). In the one-shot form, the same, and the starts per minute. Task 33's hook times, and Task 36's if it ran; `harness device notify` timed 20 times (median, p95), a fresh process, so each proves the pid by the table; and Task 6's two `tellDevices` times from one process, with and without the table read (the watch's path).
10. **Clean up**: `desktop-e2e.sh cleanup` (the Store apps go with the test user); nothing listens on 18478; the `admin` user's files are untouched; the Winlogon values read back are those Task 37 read first (no `DefaultPassword` left that was not there).
11. **The key goes**, last, after every check that uses it: delete `%USERPROFILE%\.harness-test\openrouter.key` (and its `.harness-test` folder when empty) in the profile it was put in; `Test-Path` on it then says `False`. The pull request says the test key was removed from the VM after the checks. The key itself is in no command, log, note, commit or pull request text.

**On the Dell** (The Dell: x64, the real dial on `COM3`, the owner's console session through `console.ps1`, the run's own sealed roots, ports 18478 and 18479, a `FakeBackend` on 127.0.0.1; after the VM's checks, one tester at a time). The run does every step but those in "Ken's list". Checks 12 and 13 need no `COM3` and run first, with the owner's daemon untouched. Each result goes in the pull request, serials shortened:

12. **Tap and raise, on x64 (the run).** A sealed stand-in desk (`desk.mts --sealed --port 18479`). WezTerm and Alacritty (portable, in the run's root) each open a PowerShell. In each, the branch's `notify.mjs`, run with a paneless `Stop` payload, `--engine claude` and the desk's `--port` and `--data-dir`, makes a session on the desk (WezTerm's by `WEZTERM_PANE`, Alacritty's by `ALACRITTY_LOG`). A driver script in one `console.ps1` task sends `tap <row>` at least 30 times for each app in each of the VM's three situations (another app in front, keys typed into another app with `input.ps1`, the target minimized). The counts of `raised`, `refused` and `none` come from the `[device] raise` day line and go in the pull request beside the VM's rates. `watch-windows.ps1` meanwhile shows no `CONSOLE` line from a Harness process.
13. **The numbers on x64 (the run)**: Task 33's timings in the sealed root; `harness device notify` timed 20 times (median, p95) against the stand-in desk. The stand-in desk quits.
14. **The owner's daemon stopped; the first look (the run).** The Dell, "The owner's daemon", steps 1 and 2. The look prints `pets: 0`, or the run stops (a stop condition) and goes to 18.
15. **Serial open, and exclusive (the run).** `desktop-e2e.sh put-admin <harness-serial.exe>` and `desktop-e2e.sh admin serial-check.ps1 Port=COM3 Seconds=10`: the port opens, and opening does not reset the dial. Desk A (`--port 18478 --dial COM3 --speech "echo heard" --first-read <file> --quit-on <run folder>\quit-a`) greets the dial: its log shows `cable: dial … on fw …`. Desk B (`--port 18479 --dial COM3 --speech x --first-read <file>`, another root), started beside it, does not take `COM3`: its log names the port busy (`windowsSerial.ts`'s `EBUSY`), and desk A's dial keeps answering. Quit A: B takes `COM3` and greets the dial within its retry. B quits (`settings: unchanged`), and desk A starts again for 16 and 17.
16. **notify on the real dial (the run).** Desk A on `COM3`: `harness device notify "Need you"` with the desk's data folder and port prints `shown`, and desk A's log shows no `cable:` write error. With the desk stopped, `notify` prints `no dial` (checked once, at 18). What the dial draws is the firmware's, the same as on a Mac, so nobody is asked to look at it.
17. **Ken's list.** Before sending it, the run sets up three sessions on desk A: WezTerm and Alacritty as in 12, and herdr's release `herdr.exe` inside WezTerm (started with desk A's `APPDATA` from its first line), with two panes running PowerShell, named `one` and `two`. It then brings Alacritty to the front. With the build installed and desk A up (left running through `console.ps1 -NoWait`), the Dell's tester ends its turn with this list, filled in, as the last part of its report. The main session sends the list to the orchestrator in one message, and resumes the tester with Ken's answer. Desk A waits for that answer, with no time limit of its own. The list, at most these four lines:
    ```
    1. Dial: turn to the WezTerm row and press it. You should see WezTerm come to the front of the Dell's screen (or its taskbar button flash).
    2. Dial: turn to the Alacritty row and press it. You should see Alacritty come to the front (or its taskbar button flash).
    3. Dial: pick herdr's pane "two", hold to talk and say anything. You should see "echo heard" typed in pane two, and nothing in pane one.
    4. Dial: pick pane "one", hold to talk and say anything. You should see "echo heard" typed in pane one.
    Reply "done", or the number of any step that looked different.
    ```
    After the answer, the run takes a screenshot (`console.ps1 -Script screenshot.ps1`, copied with `watch-windows.ps1` and `input.ps1` from `desktop/scripts/windows-e2e/` into the run's folder) and reads desk A's log. Each press shows in the `[device] raise` counts. Each spoken turn shows as a transcript sent to its pane. A pane holds `echo heard` only where it was sent (from herdr's own read of each pane, and the screenshot, which the tester looks at). Then `quit-a` is written and desk A prints its `settings:` line.
18. **The dial and the owner's daemon, back as found (the run).** `desk.mts --dial-read COM3 --out <run folder>\last-read.json`: its settings equal the first read's (the desks' `settings:` lines and this comparison go in the pull request, field names only). Then The Dell, "The owner's daemon", step 3: `harness start` in the console session, `harness status` running at the version kept, and `--dial-read` exits 3, so the owner's daemon holds `COM3`. The pull request carries the line "the owner's Harness daemon was running at <version>; stopped for the run; started again; running at <version> and holding COM3".
19. **Clean up**: as The Dell says. Nothing of the run is left: the roots, the first and last reads, the portable apps, herdr, the desks' processes, the `harness-dial-check-*` tasks; `desktop-e2e.sh cleanup` for its admin scratch folder.

**Not run, and why:**
- The real dial on the VM: it is on the Dell. Serial on arm64 is covered by the stand-in on the VM and by `serialWindows.spec.ts` on windows.yml.
- VS Code, Cursor, Orca and the Store apps on the Dell: installing them there would touch more of someone's machine than the x64 checks need; they are raised on the VM, and x64 is checked through WezTerm and Alacritty, which the run places and removes in its own root.
- Claude Code and Codex on the Dell: its owner's are not used, and the test key is the VM's alone.
- The dial following the app in front, and the Notifications menu: they need the Windows Device app (a separate item). Their transport is checked by Tasks 6 and 23.
- Nothing runs against production, a person's account or a person's apps.

**No temporary workflow.** windows.yml runs the long Windows checks (it is on demand already, and the new step stays in it), and cli-e2e.yml the Linux ones. Proposal for later, not in this pull request: none; windows.yml stays on demand.

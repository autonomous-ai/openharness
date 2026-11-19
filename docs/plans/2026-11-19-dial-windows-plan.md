# The dial on Windows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit. No task pushes or merges, and every task ends green.

**Goal:** On Windows the dial does what it does on a Mac: agents ring it, the devices' listener answers over a named pipe, the VS Code/Cursor extension, the Orca plugin, Claude Code's plugin, Codex, herdr and Orca reach it, a tap raises the session's window, and a hook names a caller that outlives it.

**Architecture:**
- **Part A.** The devices process serves its existing handlers on a pipe of its own (`listenLocalSocket(handler, pipe, { token })`), with its own token (`devices-token`) and record (`devices.json`). Clients find `{pipe, token}` through the record and send with `fetchOverPipe`. `link` hands the pipe, token and record path to the plugins, which sign with their own small copy of the auth.
- **Part B.** One resolver (`lib/windows/program.ts`) turns every program this work starts on Windows into an `.exe` with arguments, never a shell. With it Claude Code's plugin, the dial skill, Codex's queue, herdr (over its pipe) and Orca stop refusing Windows. A dial end-to-end check runs on Windows with a stand-in dial.
- **Part C.** A Rust helper (`harness-pty raise`) raises a window by Windows' documented rules; `cable/hosts/windowsRaise.ts` calls it, starts Harness Desktop through its own launcher, and each tap path dispatches to it once.
- **Part D.** On Windows `hookCallerPid()` climbs past the command shells that die with the hook, read from the pty host's process table. The core does not change.
- The core's process loads `lib/windows/pipeAuth.ts`, `lib/localSocket.ts`, `lib/daemonRecord.ts`, `lib/secureState.ts`, `lib/windows/launch.ts`, `lib/peerAccount.ts`. Only `pipeAuth.ts` changes (a file-name parameter that defaults to today's). Everything else is used as it is, from new files the core does not load.

**Tech Stack:** TypeScript (Node, vitest) in `cli/`; the hook script `cli/hook/notify.mjs`; the VS Code extension and the Orca plugin (TypeScript, `plugins/`); the Claude Code plugin (a JavaScript mod and a hook, `plugins/harness-device`); Rust (`pty/`, `windows-sys`); one GitHub workflow (`.github/workflows/windows.yml`). No Dart change.

**Spec:** `docs/plans/2026-11-19-dial-windows-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core; Rules 4-6), `docs/windows-rules.md` and `docs/validation-and-release.md` ("What PR CI does not run").

## Base

- `feat/dial-windows` at `91f60b6a7b` (`main` with #4482). The spec and this plan are untracked; the main session commits them, no task does.
- Line numbers below are the base's. A task follows the expression it names when a line has moved.
- A new worktree has no `cli/node_modules`: its first task runs `cd cli && npm ci`.
- `feat/dial-linux` edits `devices/orcaHomes.ts`, `cable/hosts/open.ts`, `appLink.ts` and `cursorFolder.ts` too. Tasks 20 and 28 change only the lines they name there. Whoever merges second rebases and keeps both.

## Tasks at a glance

Paths are under `cli/src/` unless they start with another folder. "notes" is `docs/plans/2026-11-19-dial-windows-vm-notes.md`: every task that uses the VM writes its section there, so devcrew runs them one at a time.

| Task | Files (each with its spec or test) | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 VM probe: launchers, apps, herdr | `lib/windows/fixtures/{code,cursor,orca}.cmd` (new), notes | none | high | none: findings, one commit |
| 2 VM probe: Claude Code's mod runtime and hook runner | notes | 1 | high | none: findings, one commit |
| 3 A token file by name | `lib/windows/pipeAuth.ts` | none | xhigh | `lib/windows/daemonToken.spec.ts` |
| 4 The devices' record, target and pid proof | `devices/listenerPipe.ts` (new), `devices/listenerPath.ts` | 3 | xhigh | `listenerPipe.spec.ts` (new), `listenerPath.spec.ts` |
| 5 The listener serves the pipe | `services/devicesListener.ts`, `services/devicesProcess.ts` | 3, 4 | xhigh | their two specs |
| 6 Clients send over the pipe | `devices/listenerClient.ts`, `devices/client.ts`, `devices/listenerPipe.windows.real.spec.ts` (new), notes | 4, 5 | xhigh | `listenerClient.spec.ts`, `client.spec.ts` |
| 7 `link` for Orca and VS Code | `deviceClaude/command.ts` | 4 | xhigh | `command.spec.ts` |
| 8 The VS Code extension on Windows | `plugins/harness-device-vscode/src/{pipeAuth.ts (new),inputs.ts,loop.ts,wire.ts}`, its `README.md` | none | xhigh | its `*.test.ts` |
| 9 The Orca plugin on Windows | `plugins/harness-device-orca/src/{pipeAuth.ts (new),inputs.ts,dial.ts,panel.tsx,protocol.ts}`, its `README.md` | none | xhigh | its `*.test.ts(x)` |
| 10 One Windows program resolver | `lib/windows/program.ts` (new) | 1 | xhigh | `program.spec.ts` (new) |
| 11 This account's own folder, on Windows | `devices/dialSkill.ts` | none | xhigh | `dialSkill.spec.ts` |
| 12 VS Code and Cursor found and run | `devices/vscodeExtension.ts`, `cable/vscodeExtensionSetup.ts` | 1, 10 | high | their two specs |
| 13 Claude Code's plugin and the dial skill | `devices/claudePlugin.ts`, `cable/dialPluginSetup.ts`, `cable/dialHomeSetup.ts` | 1, 10, 11 | high | their three specs |
| 14 `asked` over the daemon's pipe | `deviceClaude/asked.ts` | none | high | `asked.spec.ts` |
| 15 `claude link` on Windows | `deviceClaude/command.ts` | 2, 4 | xhigh | `command.spec.ts` |
| 16 The mod signs its requests | `plugins/harness-device/hooks/device.js`, `plugins/harness-device/test/device.test.ts`, `harnessDeviceMod.spec.ts` (new) | 2 | xhigh | the two tests |
| 17 The permission hook on Windows | `plugins/harness-device/hooks/{hooks.json,asked}`, at most `hooks/asked.ps1` (new), `plugins/harness-device/README.md`, `harnessDevicePlugin.spec.ts` | 2 | high | `harnessDevicePlugin.spec.ts` |
| 18 Codex on Windows | `cable/hosts/codexQueue.ts`, `deviceClaude/command.ts` | 1, 10 | high | `codexQueue.spec.ts`, `command.spec.ts` |
| 19 herdr over its pipe | `cable/hosts/{herdrClient,herdrSource,herdr,unixSocket}.ts` | 1, 11 | high | their four specs |
| 20 Orca found; its homes and plugin | `devices/orcaHomes.ts`, `devices/orcaPlugin.ts` | 1, 10, 11 | high | their two specs |
| 21 Orca's commands and its focus watch | `cable/hosts/orca.ts` | 10 | high | `orca.spec.ts` |
| 22 The serial stand-in bridges | `cable/__fixtures__/fakeHarnessSerial.mjs`, `cable/fakeSerialBridge.spec.ts` (new) | none | medium | `fakeSerialBridge.spec.ts` |
| 23 The dial end to end on Windows | `cli/e2e/dialWindows.e2e.ts` (new), `cli/e2e/harness/windowsDaemon.ts` (new), `cli/e2e/harness/fakeDial.ts`, `cli/vitest.e2e.windows.config.ts` (new), notes | 5, 6, 7, 22 | high | none on the branch: it pins 5-7; one commit |
| 24 A desk for hand checks | `cli/scripts/windows-dial-e2e/desk.mts` (new), `cli/scripts/windows-dial-e2e/README.md` (new) | 23 | medium | none: a test tool, one commit |
| 25 The real-VS Code gate on Windows | `plugins/harness-device-vscode/gate/{realVscode.gate.ts,throwawayApp.ts,throwawayApp.test.ts,cleanup.ts,driver/run.cjs}`, notes | 5, 8 | high | none: the gate itself, one commit |
| 26 `harness-pty raise` and `open-link` | `pty/src/{cli.rs,raise.rs (new),lib.rs}`, `pty/tests/raise.rs` (new), notes | none | high | `cli.rs` and `raise.rs` unit tests |
| 27 The Windows raise | `cable/hosts/windowsRaise.ts` (new) | 1 | high | `windowsRaise.spec.ts` (new) |
| 28 One dispatch in each tap path | `cable/hosts/{open,appLink,cursorFolder,vscode,codexApp}.ts` | 27 | high | their five specs |
| 29 The devices wire the raise and count it | `services/devices.ts` | 12, 21, 27, 28 | high | `services/devices.spec.ts` |
| 30 The hook tells Cursor from VS Code, and names Alacritty | `cli/hook/notify.mjs`, `hookNotify.spec.ts` | 1, 31 | high | `hookNotify.spec.ts` |
| 31 The hook's caller on Windows | `cli/hook/notify.mjs`, `hookNotify.spec.ts` | none | xhigh | `hookNotify.spec.ts` |
| 32 The caller, with real processes | `hookCaller.windows.real.spec.ts` (new), notes | 31 | medium | none on the branch: it pins 31; one commit |
| 33 What the climb costs | notes | 31 | medium | none: numbers, one commit |
| 36 (only if Task 33 measures more than 50 ms) One pid's chain from `harness-pty` | `pty/src/{cli.rs,ps.rs}`, `cli/hook/notify.mjs`, `hookNotify.spec.ts`, notes | 31, 33 | xhigh | `cli.rs` and `ps.rs` unit tests, `hookNotify.spec.ts` |
| 34 windows.yml runs the new checks | `.github/workflows/windows.yml` | 6, 8, 17, 23, 32 | medium | none: a workflow, one commit |
| 35 The guides say Windows | `cli/AGENTS.md`, `docs/cli.md`, `docs/windows-rules.md` | 13, 17, 18, 19, 20, 24, 25, 29, 30, 33, and 36 when it runs | medium | none: docs, one commit |

35 tasks, and Task 36 only if Task 33's number calls for it. Longest chain: 3 → 4 → 5 → 6 → 23 → 24 → 35 (seven tasks). At once: 1, 3, 8, 9, 11, 14, 22, 26, 31. Shared files keep these apart, one at a time: the notes (1, 2, 6, 23, 25, 26, 32, 33, 36: the one VM); `deviceClaude/command.ts` (7, 15, 18); `notify.mjs` (30, 31, 36).

## Global Constraints

- **The pipe's API is stable** (spec, part A), exact values:
  - `devices.json` is `{"pipe":"\\\\.\\pipe\\harness-<32 hex>","pid":<number>}`; the token file is `devices-token`, 64 lowercase hex digits and an optional newline.
  - A pipe is dialled only when it matches `^\\\\\.\\pipe\\harness-[0-9a-f]{32}$` and the recorded pid runs.
  - **The pid proof** (spec, Design "Read cost"): `process.kill(pid, 0)` on every call; the process table's proof (`recordedProcessDead`) when the record changes, after a connection error, and at most every 60 s. Every answer still needs its HMAC proof.
  - Each request is `POST /` with `x-harness-auth: <nonce>.<hex HMAC-SHA256(token, 0x01 ‖ nonce)>`; the nonce is the pipe's 32-hex id, then 128 random bits. Each answer carries `x-harness-proof: <hex HMAC-SHA256(token, 0x00 ‖ nonce)>`. No valid auth: `401` with `{"error":"PIPE_AUTH_REQUIRED"}`.
  - An answer without the right proof is dropped before its body is read.
- **`link` on Windows** prints `{ daemon, devicesPipe, devicesToken, devicesReady, devicesRecord }`. On macOS and Linux every output is byte for byte what it is today.
- **A token is never logged, written or put in an error**: not by the CLI, the extension, the plugin or the mod. It leaves its file only on `link`'s stdout.
- **The test key** (The VM) is never printed, logged, written elsewhere, put on a command line, in the notes, a commit or the pull request, and is deleted from the VM after the checks.
- **The plugins find `harness`** at `%USERPROFILE%\.harness\bin\harness.exe`, then on PATH.
- **No shell, no window.** Every program started on Windows goes through Task 10's resolver with `windowsHide: true`. No `detached: true` (`lib/windows/noWindow.spec.ts`), no `cmd.exe`, no PowerShell. A batch file that is neither an npm shim nor an Electron app's own launcher is refused.
- **The core.** `src/architecture.coreFiles.txt` gains no line. Of the files it lists, only `lib/windows/pipeAuth.ts` changes. `lib/localSocket.ts`, `lib/daemonRecord.ts`, `lib/secureState.ts`, `lib/windows/launch.ts`, `lib/windows/daemonPipe.ts`, `lib/peerAccount.ts`, `lib/binaryOnPath.ts` and `core/` do not change.
- **Coverage.** `services/devicesListener.ts`, `services/devicesProcess.ts` and `services/devices.ts` stay at 100% per file under `npm run test:core` on the Mac: every Windows branch there is reached by an injected platform or dependency, with the pipe stood in by a Unix socket named `harness-<32 hex>` (as `pipeAuth.spec.ts` does).
- **The listener's limits do not change**: 16 connections, the per-type rates, the 2 s deadlines, the streams.
- **Raising a window**: restore if minimized, then `SetForegroundWindow`. No `AttachThreadInput`, no injected input, nothing system-wide. The helper prints one word: `raised`, `refused` or `none`. Exit 2 or 3, a missing helper or no answer in time reads as `none`. Only `none` is a failed tap; `refused` (the taskbar flash) shows no copy on the dial.
- **Apps raised on Windows**: VS Code, Cursor, Orca, the Claude app, the ChatGPT app, WezTerm, Warp and Alacritty, through the one dispatch. A pick in the dial's app list brings its app forward the same way. A tap on a Harness agent starts Harness Desktop through its own launcher, as `open -b` does on macOS.
- **App links** open through `harness-pty open-link` (`ShellExecuteW`), held to `claude`, `codex`, `vscode` and `cursor`. Never `rundll32`.
- **No new host id.** Windows Terminal is not raised. With several windows of one app, the highest in the Z order.
- **Part D**: at most 8 steps; only `powershell.exe`, `pwsh.exe` and `cmd.exe` started to run a command; only for hooks whose runner is a shell (Codex, Copilot, Command Code); only pid, parent pid, image name and command line are read, never an environment. `core/engines/hooks.ts` does not change. The whole-table read stays unless it adds more than 50 ms (p50) to a hook on the VM; then Task 36 replaces it with one pid's chain.
- **Copy and states are macOS's.** No new sentence on the dial. The Orca panel's "Not on Windows yet." goes.
- **Stop conditions** (the task ends, writes what it found in the notes, and the main session asks harness-pm):
  - Task 2: the mod runtime cannot send to a pipe, cannot read the answer's proof, or has no HMAC-SHA256. Tasks 15 and 16 then do not start. No weaker credential is tried.
  - Task 1: sessions of the ChatGPT app answer only to the app's own `codex`. Task 18 still ships the PATH `codex`.
- **Outside text is data**: launcher files, herdr's answers, Orca's answers, `link`'s output and the process table are parsed and bounded, never run.
- **The pull request** names the platforms (Windows 11 x64 and arm64; macOS and Linux unchanged), and carries the raise's measured rate, the hook's time before and after, the `tellDevices` time, and the local gates' receipts.

## Decided here, where the spec was silent

- **The shared vectors exist already**: `cli/src/lib/windows/__fixtures__/pipe-auth-vectors.json` (made by `cli/scripts/gen-pipe-auth-vectors.ts`, read by `pipeAuth.spec.ts` and Desktop's test). The extension's, the plugin's and the mod's tests read the same file. No second fixture.
- **`devicesListenerPath` keeps its name and meaning** (the Unix socket's path, null on Windows): the Unix server and four e2e files use it. Clients ask the new `devicesTarget`, which answers a socket or a pipe with its token.
- **The record**: written after the pipe listens; a write that fails closes the pipe and the listener is not open. Close removes `devices.json` only while it still names this pipe, so a second devices process's record survives the first one's close.
- **`link` when not ready** prints `{ daemon, devicesReady: false, devicesRecord }`: no pipe and no token until the recorded process runs. `harness device claude link` names the daemon's half `daemonPipe` and `daemonToken`.
- **`daemon` in `link`** is true when the recorded daemon pipe answers `GET /api/status` with its proof within 1 s (`askDataFolderServer`).
- **`windowsHide: true`, not `ownProcessGroup()`, on callers that are not detached today**: `ownProcessGroup()` adds `detached` on macOS and Linux, which would change those paths. On Windows both give the same hidden console.
- **"This account's own" on Windows is the profile alone** (`os.homedir()`, resolved), not the configured data folder that `windowsStateRoots()` also allows: a skill home is the person's engine home, never Harness's data.
- **herdr's marker stamp** is `<inode>:<mtime in ns>`: a file's change time moves when its last handle closes (docs/windows-rules.md §3).
- **The app's identity on Windows is the bundle id the devices already key on.** The hook derives it from its own environment and sends it in the existing `__CFBundleIdentifier` hint; `windowsRaise.ts` maps a bundle id to a program name. `hostDetect.ts`, `observed.ts` and the core's route do not change.
- **The window picked**: visible, unowned, not a tool window, first in the Z order.
- **The measure** is one `createEngineTally` (`cable/engineTally.ts`): `[device] raise · window · <outcome>` and its day line. `window` is a fixed word; no app is named.
- **One notes file for the VM** (see the table). It holds no account name, token or personal path: a profile is written `<profile>`.
- **The e2e on Windows has a harness of its own** (`IsolatedDaemon` needs tmux). `HARNESS_SERIAL_BIN` names a program, so the stand-in runs as one: the run's own `node.exe`, with three one-line entry files (`watch.js`, `open.js`, `probe.js`) in the daemon's working folder. Node reads the helper's first word as a script there. No product code changes for it.
- **The gate on Windows uses the real `harness.exe`** (`HARNESS_EXE_BIN`, as `installPs1.spec.ts` takes it) in a throwaway install layout whose `cli.js` prints the link line.
- **Windows real specs** are named `*.windows.real.spec.ts`, live beside their code, and are listed in windows.yml by Task 34 alone.
- **Part D reads the table once per hook run**: the climb and the hook's other readers share one `harness-pty ps --json`.
- **Harness Desktop's launcher** is `%LOCALAPPDATA%\Programs\Harness\Harness.exe` (`pty/src/desktop/mod.rs`: the install root is `FOLDERID_UserProgramFiles`\Harness, the launcher `LAUNCHER_EXE`). A tap on a Harness agent starts it with no argument, and nothing is raised first: a running Desktop, in the tray too, takes a second launch over and restores and raises its own window (`desktop/windows/runner/single_instance.cpp`, `Forward` and the `WM_COPYDATA` handler). No launcher there: the tap fails, as a failed `open -b` does on macOS. The start is not counted in the raise tally, which counts the helper's answers alone.
- **WezTerm, Warp and Alacritty** are found as on macOS: WezTerm by `WEZTERM_PANE`, Warp by `TERM_PROGRAM=WarpTerminal` (both hints the hook already sends), Alacritty by its bundle id alone, which on Windows the hook fills from a variable only Alacritty sets (Task 1's notes name it; Task 30).
- **The pid proof's state** lives in the client's process (`devices/listenerPipe.ts`, one `DevicesProof` per process): a one-shot `harness device notify` proves by the table each time, and the long-lived watch at most once a minute. A pid reused inside that minute passes the cheap check, and gets nothing from it: an answer without the HMAC proof is dropped unread, and the drop makes the next call prove by the table.

## Answered questions (Decided 11 in the spec)

1. A tap on a Harness agent with no window starts Harness Desktop through its launcher: Tasks 27, 28, 29; Verification 7.
2. A pick in the dial's app list brings the app forward on Windows, through the same dispatch: Task 28.
3. A refused raise shows no copy; only `none` fails: Tasks 27, 28.
4. App links open through `harness-pty open-link` (`ShellExecuteW`), four schemes: Tasks 26, 27.
5. A test key (OpenRouter) is on the VM at `%USERPROFILE%\.harness-test\openrouter.key`, owner-only: Task 2 probes the real runtime, Tasks 15-17 build on its notes, and the real-engine checks run on the VM (Verification 6); the key file is deleted after them (Verification 11). The key's use and rules: The VM.
6. The narrow subcommand comes only above 50 ms (p50) added to a hook: Task 33 decides, Task 36 builds it.
7. WezTerm, Warp and Alacritty are raised too: Tasks 1, 27, 30.
8. The pid proof: the cheap check per call, the table's proof on a record change, after a connection error or every 60 s: Tasks 4, 6.

## Review Focus

1. **A crashed devices process whose pid was given to another process.** The client dials nothing and `link` says `devicesReady: false`. Inside the minute a proof is held, the reused pid passes the cheap check: the one send fails (nothing listens, or the answer has no proof) and the next call proves by the table and dials nothing. Tests: Task 4 (`devicesPipe`, a row that started after the record; the pid proof), Task 6 (a failed connection proves again), Task 7.
2. **Something else answers on the recorded pipe name** (a 200 with a body and no proof, or a wrong proof). `tellDevices` is false, `askDevices` null, the extension and the plugin drop the answer unread, and the token appears in no log line. Tests: Tasks 6, 8, 9, 16.
3. **A profile path with spaces, Vietnamese letters, `'`, `&` and `%`** (`C:\Users\Nguyễn Văn A' & 100%`). Every argument stays one argument, the launcher is found, the record path is absolute. Tests: Tasks 10, 8, 23.
4. **`claude` on PATH is the Claude desktop app's `Claude.exe`** (it answers `--version` without "Claude Code", and `--help` opens its window). The plugin's runner refuses it after one `--version` and runs nothing more. Test: Task 13.
5. **An app's launcher that changed shape** (a later VS Code, Cursor or Orca). The resolver refuses it by name and the setup counts a failure; nothing falls back to `cmd.exe`. Tests: Tasks 10, 12, 20.

## The VM

- UTM Windows 11 ARM64: `utmctl start Windows`, then `ssh admin@192.168.64.5` (key auth). The Dell x64 PC is not available: x64 runs on windows.yml only.
- Copy the tree with `VM_SSH=admin@192.168.64.5 cli/scripts/windows-pty-e2e/vm-sync.sh --cli` (to `C:/work/oh`). Build the host there: `cd /d C:\work\oh\pty && cargo build --release --bins`.
- **Isolation**: an owned test user, made and driven by `desktop/scripts/windows-e2e/desktop-e2e.sh` with `VM_HOST=192.168.64.5` (`preflight`, `user-add`, `session-on`, `run`, `ps`, `shot`, `cleanup`; its README). Everything is that user's: profile, `.harness`, `.claude`, `.codex`, and the apps installed for it alone. The daemon runs from the branch's build with `PORT=18478`, signed out (`BACKEND_WS_URL=ws://127.0.0.1:9`, `WEB_URL=http://127.0.0.1:9`), `ADAPTER_UPDATE_DISABLE=true`, `DISABLE_GRID_INSTALL=true`, `HARNESS_PTY_BIN` the VM's build. Never the `admin` user's engines, apps or sign-ins, never production.
- **The dial** is the stand-in (Tasks 22-24). The real dial stays on the Mac.
- **Windows a person would see** are checked in the test user's desktop session, never over SSH (session 0): `desktop-e2e.sh run watch-windows.ps1` records every window shown. The test user must be signed in at the VM's console; if the agent cannot reach the UTM window, that sign-in is the user's one step.
- **The test key** (for Claude Code and Codex, so hooks, the mod and skills fire): an OpenRouter key the main session puts in `%USERPROFILE%\.harness-test\openrouter.key`, owner-only. The engines run as the test user, and an owner-only file in `admin`'s profile is closed to it, so `%USERPROFILE%` here is the test user's profile and the file is that user's alone. The main session places it there after `user-add`. The plan and every brief name only that path. **The key is never printed, echoed, logged, written to another file, put on a command line, in the notes, a commit or the pull request.** A shell that starts an engine reads the file into that process's own environment and starts the engine from it:
  - Claude Code: `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN` read from the file, `ANTHROPIC_API_KEY` empty, a cheap model (`ANTHROPIC_MODEL`, named in the notes by its name alone), and `CLAUDE_CONFIG_DIR` a throwaway folder in the test user's profile.
  - Codex: `CODEX_HOME` a throwaway folder whose `config.toml` names a `model_provider` for OpenRouter with `env_key` (the variable's name, never its value), a cheap model, and that variable read from the file.
  - Harness: the desk's isolated data folder (Task 24, `%USERPROFILE%\.harness-dial-check`), never a person's accounts, homes or data.
  - A transcript, a screenshot or a log that could hold the key is checked before it is copied off the VM; none goes in the notes.
- One test user serves every VM task. The last VM check runs `cleanup`, then the key file is deleted (Verification 11).

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

### Task 2: VM probe: Claude Code's mod runtime and hook runner

**Files:**
- Modify: `docs/plans/2026-11-19-dial-windows-vm-notes.md`, section `## Task 2`

**Depends on:** 1 (the engines installed for the test user; the notes are one file). The test key is on the VM (The VM). **Effort:** high. **Red test:** none; one commit.

- [ ] **Step 1:** In the test user's session, start Claude Code (and, for item 5, Codex) with the test key as The VM says, never a person's account, from a throwaway home. Start `cli/scripts/windows-pipe-test-server.ts` on a throwaway data folder (it serves the daemon's own authenticated pipe and a squatter). Load a throwaway mod from a folder outside the repo (never committed).
- [ ] **Step 2: Find out, and write each with the evidence:**
  1. Whether `$.http.fetch(url, { socketPath: '\\\\.\\pipe\\harness-<id>', headers })` reaches the pipe, and whether the answer gives its status, its text and its `x-harness-proof` header.
  2. Which HMAC-SHA256 the runtime has (`crypto.subtle`, `node:crypto`, neither), and where 16 random bytes come from. Check the result against the first vector of `pipe-auth-vectors.json`.
  3. How the mod tells it runs on Windows, and whether `$.env.get('USERPROFILE')`, `$.process.run([<absolute harness.exe>, …])` and `$.fs.read(<%USERPROFILE%\.claude\settings.json>)` work. Whether `$.process.run` flashes a window (`watch-windows.ps1`).
  4. How Claude Code runs a plugin's `command` hook: the exact command line with Git Bash installed and without it (from `harness-pty ps --json`); whether `${CLAUDE_PLUGIN_ROOT}` expands in both; whether a plugin's `hooks.json` takes the exec form (`command` with `args`); whether a window flashes in either.
  5. How Codex runs a hook on Windows (the runner's command line from `harness-pty ps --json`, for Task 31's shells), with the test key and a throwaway `CODEX_HOME`.
  6. The cheap models used, by name, and that the notes do not hold the key: `findstr /L /M /G:<the key file> <the notes>` prints nothing (the search reads the key from its file, so it is on no command line).
- [ ] **Step 3: Stop condition.** If 1 or 2 cannot be done, write that first in the section, report `stop: mod runtime`, and end. Tasks 15 and 16 do not start.
- [ ] **Step 4: Commit** `Claude Code's mod runtime and hook runner on Windows: notes`.

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

**Interfaces (produces):**
- `interface Program { file: string; args: string[]; env?: NodeJS.ProcessEnv }` — `env`, when set, is the child's whole environment.
- `class WindowsProgramRefused extends Error { readonly program: string }`
- `windowsProgram(file: string, args: readonly string[], options?: { platform?: NodeJS.Platform; environment?: NodeJS.ProcessEnv; read?: (file: string) => string; exists?: (file: string) => boolean }): Program`
  - off Windows: `{ file, args }` as given;
  - an `.exe`: as it is;
  - an npm shim: `node.exe <script>` or the package's `.exe`, through `windowsEngineArgv` as it is;
  - an Electron app's own launcher: its `.exe`, with the CLI script first in `args` and `ELECTRON_RUN_AS_NODE: '1'` in `env`;
  - any other batch file, or a launcher whose `.exe` or script is not there: throws `WindowsProgramRefused`.
- `parseElectronLauncher(text: string, launcherDir: string): { exe: string; script: string } | null`

- [ ] **Step 1: Write the failing tests** (they run on windows.yml too, where `src/lib/windows` is listed):
  - an `.exe` with arguments holding `&`, `|`, `%`, `"`, `^` and a line break: the same file, each argument unchanged, no `env`;
  - `fixtures/npm-codex.cmd`: `node.exe` (beside the shim, else on PATH) and the script, then the arguments;
  - `fixtures/code.cmd`, `cursor.cmd`, `orca.cmd`: the `.exe` and script Task 1's notes name, `['--install-extension', 'x.vsix', '--force']` after the script, `env.ELECTRON_RUN_AS_NODE === '1'`, and the rest of `environment` kept;
  - a launcher in a folder named `Nguyễn Văn A' & 100%` resolves the same way (Review Focus 3);
  - `@echo off\r\nstart calc %*\r\n` throws `WindowsProgramRefused` with plain-word arguments too; so does `code.cmd` when its `.exe` is missing, and a launcher with its last line changed (Review Focus 5);
  - `platform: 'darwin'`: the file and arguments as given.
- [ ] **Step 2:** `npx vitest run src/lib/windows/program.spec.ts` — FAIL (no module). Commit red.
- [ ] **Step 3: Implement.** The launcher's form is the fixtures': the line that passes `%*` names the `.exe` and the script relative to `%~dp0`.
- [ ] **Step 4:** the run passes; `npx vitest run src/architecture.spec.ts` passes (`architecture.coreFiles.txt` unchanged); `npm run typecheck` passes.
- [ ] **Step 5: Commit** `One resolver starts a Windows program with no shell: an exe, an npm shim, or an app's own launcher`.

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
- Produces: `VscodeExtensionDeps.folders?: { localAppData?: string; programFiles?: string }`; on Windows `installed()` answers the editor's launcher: `<cli>.cmd` in an absolute PATH folder, then the per-user folder, then the machine folder (the notes' paths). `export function editorCli(deps: VscodeExtensionDeps): string | null` (today's `vscodeCli`, exported). The real `run` starts `windowsProgram(file, args)` with `windowsHide: true` and ends the child at its time on Windows.

- [ ] **Step 1: Write the failing tests**
  - `vscodeExtension.spec.ts`, `platform: 'win32'`: found on PATH; else in the per-user folder; else in the machine folder; `absent` with none; a relative PATH folder is not looked in; `bin` absolute wins; `vscodeStatus` reads `<home>\.vscode\extensions\extensions.json` (`.cursor` for Cursor); `vscodeEnable` runs the launcher with `['--install-extension', <vsix>, '--force']`.
  - The real `run` on Windows (spawn mocked): the file is the launcher's `.exe`, `ELECTRON_RUN_AS_NODE` is `'1'`, `windowsHide` is true, and neither `shell` nor `detached` is set; a refused launcher answers `{ code: null, timedOut: false }`.
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

**Depends on:** 1, 10, 11. **Effort:** high.

**Interfaces:** `supports()` takes `win32`. `claudeRunner(bin, env, platform = process.platform)` starts `windowsProgram(bin, args, { environment: env })` with `windowsHide: true`. On Windows `versionOf` answers a version only when the output says `Claude Code`. The two setups run on Windows.

- [ ] **Step 1: Write the failing tests**
  - `claudePlugin.spec.ts`: Windows with 2.1.287 is supported; a `--version` that answers `Claude 1.4.0` on Windows gives `supported: false`, and `claudeEnable` answers the `unsupported` failure after exactly one run (Review Focus 4); the runner on Windows (execFile mocked) starts the resolved program with `windowsHide` and no shell.
  - `dialPluginSetup.spec.ts`: a pass on Windows installs the plugin.
  - `dialHomeSetup.spec.ts`: `started`, `attached` and `scanned` on Windows write the skill into an owned home.
- [ ] **Step 2:** `npx vitest run src/devices/claudePlugin.spec.ts src/cable/dialPluginSetup.spec.ts src/cable/dialHomeSetup.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.** Remove the three comments that say Windows has no dial to ring.
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
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

### Task 15: `claude link` on Windows

**Files:**
- Modify: `cli/src/deviceClaude/command.ts:140-152` (the `link` case), its header comment
- Test: `cli/src/deviceClaude/command.spec.ts`

**Depends on:** 2 (it starts only if the runtime can do it: no token is handed to a mod that cannot prove it), 4. **Effort:** xhigh (it hands out the daemon's token).

**Interfaces:** on Windows, with the plugin on and a daemon pipe found: one line `{ daemonPipe, daemonToken, devicesRecord }`, with `devicesPipe` and `devicesToken` added when the devices are ready; exit 0. These are the names Task 16's `Linked` reads (the two tasks agree on them here, and run apart). No daemon pipe, or the plugin off or removed: exit 1 and no output. Elsewhere unchanged.

- [ ] **Step 1: Write the failing tests**: the line with and without the devices' half; `daemonToken` is the 64 hex digits of `daemon-token`; exit 1 with no output when the plugin is off, when `disable` removed it, and with no daemon pipe; the macOS cases unchanged.
- [ ] **Step 2:** `npx vitest run src/deviceClaude/command.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `link hands Claude Code's mod the daemon's pipe and token on Windows, as it hands the socket on a Mac`.

### Task 16: The mod signs its requests

**Files:**
- Modify: `plugins/harness-device/hooks/device.js`, `plugins/harness-device/test/device.test.ts`
- Create: `cli/src/harnessDeviceMod.spec.ts`

**Depends on:** 2. **Effort:** xhigh.

**Interfaces:** on Windows (told as Task 2's notes say) the launchers are `<USERPROFILE>\.harness\bin\harness.exe`, then `harness`. `Linked` holds `{ daemon: { pipe, token }, devices?: { pipe, token } }` there, read from Task 15's line (`daemonPipe`, `daemonToken`, `devicesPipe`, `devicesToken`; a pipe matching the global pattern, a token of 64 lowercase hex digits, else the line is refused). Each request over a pipe carries `x-harness-auth`; an answer without the right `x-harness-proof` counts as no answer (the poll waits `RETRY_MS`, the attach is dropped), and its text is never read. `device.js` exports `pipeAuth(token, nonce)` and `pipeProven(proof, token, nonce)`, with the HMAC-SHA256 Task 2's notes name. On macOS and Linux nothing changes.

- [ ] **Step 1: Write the failing tests**
  - `device.test.ts` (`claude-code/testing`), a Windows world: the launcher order; a poll's `socketPath` is the daemon pipe and its headers hold a well-formed auth for that pipe's id; an answer with the right proof submits its prompt; one with no proof or a wrong one submits nothing and polls again after `RETRY_MS`; the attach goes to the devices pipe with the devices' token; a link line with a malformed pipe or token waits `RETRY_MS`.
  - `harnessDeviceMod.spec.ts` (CLI vitest): `pipeAuth` and `pipeProven` imported from `device.js` agree with every vector of `pipe-auth-vectors.json`.
- [ ] **Step 2:** `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin test plugins/harness-device` and `cd cli && npx vitest run src/harnessDeviceMod.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** both pass; `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin validate plugins/harness-device` passes.
- [ ] **Step 5: Commit** `Claude Code's mod proves the daemon's token on each poll on Windows`.

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

**Interfaces:** `OrcaBinaryDeps.localAppData?: string`. On Windows `orcaBinary` answers `orca.cmd` on PATH whose real path ends `\resources\bin\orca.cmd`, else the default per-user install the notes name when it exists. The real `run` starts `windowsProgram(file, args)` with `windowsHide: true`. The cache reads on Windows; the plugin's `find` no longer answers absent there.

- [ ] **Step 1: Write the failing tests**
  - `orcaHomes.spec.ts`: Windows finds the launcher on PATH and in the default folder; another `orca.cmd` on PATH (not in `resources\bin`) is not taken; `readOrcaHomes` keeps a home that is an owned folder; `refresh()` on Windows reads; the real `run` on Windows (spawn mocked) starts the launcher's `.exe` with `ELECTRON_RUN_AS_NODE`, `windowsHide` and no shell, and a refused launcher answers `{ code: null, stdout: '', timedOut: false }`.
  - `orcaPlugin.spec.ts`: `orcaStatus` on Windows goes on to ask Orca.
- [ ] **Step 2:** `npx vitest run src/devices/orcaHomes.spec.ts src/devices/orcaPlugin.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** the run passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `Harness finds Orca on Windows, reads its account homes and connects its plugin`.

### Task 21: Orca's commands and its focus watch

**Files:**
- Modify: `cli/src/cable/hosts/orca.ts:58-104` (`orcaDeps`: `run`, `spawn`, the child's `kill`)
- Test: `cli/src/cable/hosts/orca.spec.ts`

**Depends on:** 10. **Effort:** high.

**Interfaces:** `orcaDeps(platform = process.platform)`. `run` and `spawn` start `windowsProgram(file, args)` with `windowsHide: true`; a refused program answers `{ code: null, stdout: '' }`, or the gone child. On Windows the child's `kill` ends its process tree (`endProcessTree(pid, processTreeKillDeps(null))`, `lib/windows/treeKill.ts`) for either signal. Every adapter that takes `apps.run` (herdr's focus, tmux, WezTerm, the tap paths) gets the same start.

- [ ] **Step 1: Write the failing tests** (child_process mocked), `platform: 'win32'`: `run('…\\orca.cmd', ['terminal', 'send', …, '--text=a & b'])` starts the resolved `.exe` with the text as one argument, `windowsHide`, no shell; a refused program resolves `{ code: null, stdout: '' }` and `spawn` gives a child whose `exited` has resolved; stopping `watch-focus` on Windows calls the tree kill with the child's pid and sends no signal; on macOS `run`, `spawn` and `kill` are as today.
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

### Task 24: A desk for hand checks

**Files:**
- Create: `cli/scripts/windows-dial-e2e/desk.mts`, `cli/scripts/windows-dial-e2e/README.md`

**Depends on:** 23. **Effort:** medium. **Red test:** none; one commit.

**Interfaces:** `node --import tsx scripts/windows-dial-e2e/desk.mts [--port <n>]`, run on the Windows machine. It starts Task 23's daemon and dial with the engines and apps of the user it runs as (no `CLAUDE_PATH`, `CODEX_PATH`, `HARNESS_VSCODE_BIN` or `HARNESS_CURSOR_BIN` override, `DISABLE_HOOK_INSTALL=false`, `USERPROFILE` left alone, the data folder in `%USERPROFILE%\.harness-dial-check`). It reads one command a line on stdin: `list`, `tap <row>`, `rest <row>`, `say <row> <text>`, `pick <app>` (the dial's `{ t: 'app.pick', app }`, as `dialAppFilter.e2e.ts` sends it; `<app>` a host id), `quit`. It prints each dial message as one JSON line. It refuses port 18473.

- [ ] **Step 1: Write** the script on `startWindowsDaemon` and `FakeDial`, and the README: what it is for, how to run it in the test user's session, that it is never run as a person's own user.
- [ ] **Step 2:** `npm run typecheck` passes; on the Mac `node --import tsx scripts/windows-dial-e2e/desk.mts` exits 1 saying it runs on Windows.
- [ ] **Step 3: Commit** `A desk script for hand checks of the dial on Windows`.

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

**Depends on:** none. **Effort:** high. `open-link` is how app links open on Windows (spec, Decided 11): `ShellExecuteW`, never `rundll32`.

**Interfaces (produces):**
- `harness-pty raise --pid <n>` or `harness-pty raise --exe <name.exe>`: stdout is one word, `raised`, `refused` or `none`; exit 0.
- `harness-pty open-link <url>`: stdout `opened` or `refused`; exit 0.
- Off Windows both print `{"unsupported":true}` and exit 3, as `ps` does. A bad argument is the existing usage error, exit 2.
- `cli.rs`: `Command::Raise { target: RaiseTarget }`, `enum RaiseTarget { Pid(u32), Exe(String) }`, `Command::OpenLink { url: String }`.
  - `raise` takes exactly one of the two; `--pid` is 1 or more; `--exe` is a file name with no `\`, `/` or `:`, ending `.exe` in any case, at most 255 characters.
  - `open-link` takes one URL of at most 2,048 characters, with no control character or space, whose scheme is `claude`, `codex`, `vscode` or `cursor` followed by `://`.
- `raise.rs`: `pub struct Candidate { pub visible: bool, pub owned: bool, pub tool: bool }`; `pub fn pick(in_z_order: &[Candidate]) -> Option<usize>` (the first visible, unowned, non-tool one). On Windows, `raise(target)`: the target's top-level windows in `EnumWindows` order (a process by pid, or by image file name without case, as `desktop/win.rs` `image_of` reads one), `pick`, `ShowWindow(SW_RESTORE)` when `IsIconic`, `SetForegroundWindow`, then `raised` when `GetForegroundWindow` is that window. `open_link(url)`: `ShellExecuteW(…, "open", url, …)`, `opened` when it returns more than 32.

- [ ] **Step 1: Write the failing tests**
  - `cli.rs`, in `parses_commands` and a new `refuses_bad_raise_and_link_arguments`: the three good forms parse; refused: both `--pid` and `--exe`, neither, `--pid 0`, `--exe C:\x\Code.exe`, `--exe code`, `open-link http://x`, `open-link "vscode://a b"`, a 2,049-character URL.
  - `raise.rs`: `pick` skips hidden, owned and tool windows and takes the first left; none gives `None`; `the_window_code_uses_only_the_documented_calls` reads `include_str!("raise.rs")` and finds none of `AttachThreadInput`, `SendInput`, `keybd_event`, `SystemParametersInfo`, `AllowSetForegroundWindow`.
  - `pty/tests/raise.rs` (`#![cfg(windows)]`): `raise --exe no-such-program.exe` and `raise --pid <a child with no window>` print `none`; a window this test makes and minimizes, raised by its pid, prints `raised` or `refused` and is no longer minimized.
- [ ] **Step 2:** `cd pty && cargo test --locked -- cli:: raise::` on the Mac — FAIL (no `raise`). Commit red.
- [ ] **Step 3: Implement.** `USAGE`, `PROTOCOL` and `FEATURES` do not change.
- [ ] **Step 4:** the same run passes on the Mac. On the VM: `cargo test --locked --test raise` and `cargo test --locked -- raise::` pass; write the result in the notes.
- [ ] **Step 5: Commit** `harness-pty raises a window by Windows' own rules, and opens an app link`.

### Task 27: The Windows raise

**Files:**
- Create: `cli/src/cable/hosts/windowsRaise.ts`, `cli/src/cable/hosts/windowsRaise.spec.ts`

**Depends on:** 1 (the program names). **Effort:** high.

**Interfaces (produces):**
- `type RaiseOutcome = 'raised' | 'refused' | 'none'`
- `WINDOWS_APPS: Readonly<Record<string, string>>` — from bundle ids (`APP_BUNDLES`' and `org.alacritty`, the set `open.ts` takes) to program names: VS Code `Code.exe`, Cursor `Cursor.exe`, Orca `Orca.exe`, and the Claude app, the ChatGPT app, WezTerm (`com.github.wez.wezterm`), Warp (`dev.warp.Warp-Stable`) and Alacritty (`org.alacritty`) as Task 1's notes give the program that owns each one's window. Where an app could not be installed: `Claude.exe`, `ChatGPT.exe`, `wezterm-gui.exe`, `warp.exe`, `alacritty.exe`, each flagged in the report. No other entry.
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

### Task 30: The hook tells Cursor from VS Code, and names Alacritty

**Files:**
- Modify: `cli/hook/notify.mjs:509-587` (`HOST_HINTS`' comment, `hostHints`)
- Test: `cli/src/hookNotify.spec.ts`

**Depends on:** 1 (the variable's name), 31 (the same two files). **Effort:** high.

**Interfaces:** on Windows `hostHints()` never reads the `__CFBundleIdentifier` variable. It fills that hint itself from the program the notes' variable names (`VSCODE_GIT_ASKPASS_NODE` unless the notes say another): a file named `Code.exe` gives `com.microsoft.VSCode`, `Cursor.exe` gives `com.todesktop.230313mzl4w4u92`, in any case; anything else gives no hint. With no editor named that way, the variable Task 1's notes name as set by Alacritty alone gives `org.alacritty` when it is set (its value is never read beyond being there). Only the id leaves the process, never the path or a value. Elsewhere nothing changes. If the notes name no such variable, the Alacritty part is left out and the report says so (a tap on an Alacritty agent then reaches no app on Windows, for the pull request's "Where Windows differs"). WezTerm and Warp need nothing here: `WEZTERM_PANE` and `TERM_PROGRAM` are sent today; the report confirms both against the notes.

- [ ] **Step 1: Write the failing tests** in `describe('hook notify: a session outside a pane')`, with the platform read as Windows: a `…\Microsoft VS Code\Code.exe` value gives VS Code's id; `…\cursor\Cursor.exe` gives Cursor's; `CURSOR.EXE` too; `Windsurf.exe`, an empty value and no variable give no `__CFBundleIdentifier` hint; a `__CFBundleIdentifier` set in the environment is not sent; the body holds the path nowhere; Alacritty's variable alone gives `org.alacritty` and its value appears nowhere in the body; Alacritty's variable with `…\Code.exe` gives VS Code's id; at most `MAX_HINTS` hints; on macOS and Linux neither variable is read and the hints are today's.
- [ ] **Step 2:** `npx vitest run src/hookNotify.spec.ts -t "outside a pane"` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx vitest run src/hookNotify.spec.ts src/architecture.environment.spec.ts src/cable/hosts/hostDetect.spec.ts` passes.
- [ ] **Step 5: Commit** `On Windows the hook says which editor or Alacritty it runs in, from its own environment`.

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

**Depends on:** 31. **Effort:** medium. **Red test:** none; one commit.

- [ ] **Step 1:** on the VM, against Task 23's daemon, time a Codex-style hook 20 times each on the base's `notify.mjs` and on the branch's: `powershell.exe -NoProfile -Command "& node notify.mjs --port <n> --data-dir <dir> --engine codex"` with a `Stop` payload on stdin. Time `harness-pty ps --json` alone 20 times as well.
- [ ] **Step 2: Write** for each: median, p95, the process count on the VM at the time, the build. One line says how much the climb adds at the median, and a last line says `over 50 ms: yes` or `over 50 ms: no`.
- [ ] **Step 3: Commit** `The hook's time on Windows before and after the climb: numbers`. The main session puts them in the pull request. At 50 ms or less added at the median, the whole-table read stays and Task 36 is not run. Over 50 ms, Task 36 runs in this branch, and Task 35 then waits for it too.

### Task 34: windows.yml runs the new checks

**Files:**
- Modify: `.github/workflows/windows.yml:179-193` (the vitest list), and one new step after it

**Depends on:** 6, 8, 17, 23, 32. **Effort:** medium. **Red test:** none; one commit.

- [ ] **Step 1:** add to `$paths` of "Contract suite against the real host, and the Windows CLI specs": `'src/devices/listenerPipe.windows.real.spec.ts'`, `'src/hookCaller.windows.real.spec.ts'`, `'src/harnessDevicePlugin.spec.ts'`, `'../plugins/harness-device-vscode/src'`.
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

**Depends on:** 13, 17, 18, 19, 20, 24, 25, 29, 30, 33, and 36 when it runs. **Effort:** medium. **Red test:** none; one commit.

- [ ] **Step 1: `cli/AGENTS.md`**, the devices row, in its own words: on Windows the listener is a named pipe with its own token and record (`devices/listenerPipe.ts`); herdr over its pipe; `codex queue` and every other program through `lib/windows/program.ts`; a tap raises the app through `harness-pty raise` (`cable/hosts/windowsRaise.ts`); the dial skill, the plugin and the extension are set up on Windows too.
- [ ] **Step 2: `docs/cli.md`**: `harness device notify` prints `no dial` only where the devices run inside the core; Windows is gone from that sentence.
- [ ] **Step 3: `docs/windows-rules.md`**: each new rule a task's report names (what happened, what was measured, the rule, its test). None reported: no change to that file.
- [ ] **Step 4:** every file and link the changed lines name exists.
- [ ] **Step 5: Commit** `The guides describe the dial on Windows`.

### Task 36 (only if Task 33 says over 50 ms): One pid's chain from `harness-pty`

**Files:**
- Modify: `pty/src/cli.rs` (`Command::Ps`, `parse`), `pty/src/ps.rs`
- Modify: `cli/hook/notify.mjs` (the climb's read, Task 31's), `cli/src/hookNotify.spec.ts`
- Modify: the notes, section `## Task 36`

**Depends on:** 31, 33. **Effort:** xhigh (every Codex, Copilot and Command Code hook's path).

**Interfaces:**
- `harness-pty ps --json --ancestors <pid>`: the rows (`ProcessRowJson`, as today) of `<pid>` and its parents, nearest first, at most 9 rows; it stops at a parent the snapshot does not hold. One Toolhelp snapshot as today, and a process is opened for its marker and command line only when it is on the chain. Off Windows `{"unsupported":true}`, exit 3, as `ps` does. `--ancestors 0`, a missing or non-number value: the usage error, exit 2. `ps --json` alone is unchanged (the core's check reads it).
- `cli.rs`: `Command::Ps { ancestors: Option<u32> }`.
- `notify.mjs`: the climb reads `ps --json --ancestors <process.ppid>` and nothing else changes in its rules; a helper that answers exit 2 (an older host) gives `process.ppid`, as no table does. The other readers of the run's table (Task 31's shared read) keep the whole table only if they need rows off the chain; the implementer lists them in the report.

- [ ] **Step 1: Write the failing tests**
  - `cli.rs` `parses_commands`: `["ps", "--json", "--ancestors", "42"]` is `Command::Ps { ancestors: Some(42) }`, `["ps", "--json"]` is `ancestors: None`; refused: `--ancestors 0`, `--ancestors x`, `--ancestors` with no value.
  - `ps.rs`: a pure `chain(rows_by_pid, pid, max) -> Vec<u32>` over a fake table: a chain of 12 gives 9; a parent missing stops it; a loop (a pid that is its own grandparent) stops at the first repeat.
  - `hookNotify.spec.ts`: the fake `harness-pty` records its arguments; a Codex hook runs it with `ps --json --ancestors <ppid>` once; a fake that exits 2 names index 0; every case of Task 31's `it.each` still names the same index.
- [ ] **Step 2:** `cd pty && cargo test --locked -- cli:: ps::` and `cd cli && npx vitest run src/hookNotify.spec.ts -t "the caller a hook names"` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** both runs pass; `npx vitest run src/architecture.environment.spec.ts` passes. On the VM, Task 33's timing again on the branch; write the new median and p95 in the notes.
- [ ] **Step 5: Commit** `A hook reads only its own parent chain from harness-pty on Windows`.

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
- **Windows** (`gh workflow run windows.yml --ref feat/dial-windows`; the heavy lane is granted by harness-pm). On x64 and arm64 a person sees every job green, and in the logs: the Rust tests with `raise`; the vitest list with `listenerPipe.windows.real.spec.ts`, `hookCaller.windows.real.spec.ts`, `harnessDevicePlugin.spec.ts`, `program.spec.ts` and the extension's tests; the step "The dial, end to end, on a stand-in dial" with its four cases. Everything runs in the runner's temp folders against daemons it starts itself.
- **CLI end to end** (`gh workflow run cli-e2e.yml --ref feat/dial-windows`): the Linux shards, with `dialStream`, `dialVscode`, `dialAppFilter` and `deviceHerdr`. They guard that Linux did not change. `dialWindows.e2e.ts` shows as skipped there.

**On the VM** (The VM: the owned test user, its desktop session, a daemon of its own on port 18478, signed out, the stand-in dial; the builds are the branch's). Each result goes in the pull request:

1. **notify rings the dial.** Start Task 24's desk. In another window of the same user: `harness device notify "Need you"`. It prints `shown`, and the desk prints the notice. `harness device notify` with the desk stopped prints `no dial`.
2. **The e2e on the VM**: Task 23's command; four cases pass.
3. **The extension's gate**: Task 25's command against a downloaded VS Code; it passes.
4. **herdr.** herdr 0.9.5 with an agent in a pane (a shell stands in when no engine is signed in). The desk's `list` shows it; `say <row> hello` types `hello` into that pane; `tap <row>` focuses it.
5. **Orca.** Orca installed for the test user, the plugin installed from the checkout (`orca plugin install`, approved as Orca shows). With the desk up, the panel says "Dial attached."; `rest <row>` on an agent in an Orca terminal switches Orca to it; stopping the desk leaves no `orca` process (the focus watch ended). Where Orca for Windows has it: `orca plugin test .` in the plugin's folder passes.
6. **Claude Code and Codex, real**, on the VM with the test key (The VM: cheap models, throwaway `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, the desk's isolated data folder; never a person's account). With the stand-in dial attached, Harness installs the plugin and the skill into the test user's homes. A permission prompt in Claude Code shows on the desk; `say` reaches the Claude Code session through the mod (its poll carries the auth and takes only a proven answer); a Codex thread takes `say` through `codex queue`; Claude Code's hook runs under Git Bash, and under PowerShell as Task 2's notes show it, with no window shown; a Codex `Stop` hook names the caller above its shell (Task 31) and the held core does not refuse it. No transcript or log copied off the VM holds the key.
7. **The raise, measured.** VS Code, Cursor, Orca, WezTerm, Warp and Alacritty open with an agent each (those Task 1 could install). Through `desktop-e2e.sh run`, a script sends `tap` to the desk at least 30 times in each of three situations: Harness idle and another app in front; keys being typed into another app (`input.ps1`); the target minimized. Count `raised`, `refused` and `none` from the daemon's `[device] raise` day line. The three rates go in the pull request. Any rate ships (spec, decided 7). A `refused` tap shows no line on the dial; a `none` shows macOS's failure line. `pick <app>` on the desk (the dial's app-list pick) brings that app forward.
   - **Harness Desktop**, installed for the test user alone (the released per-user install, `%LOCALAPPDATA%\Programs\Harness`, signed out). With Desktop closed, `tap <row>` on a Harness agent of the desk's daemon starts it, and `desktop-e2e.sh shot` shows its window; with Desktop hidden in the tray, the same tap brings its window back. A person looks at the two shots.
8. **Nothing flashes.** `desktop-e2e.sh run watch-windows.ps1` (with its `-Probe` once, as the positive control) through each new flow: the daemon's start, `notify`, a `link` from VS Code and from Orca, the extension's install, `claude plugin` setup, a `codex queue`, an Orca send, a tap of each kind (app, link, Cursor folder), and a Codex-style hook. No `CONSOLE` line from a Harness process.
9. **The numbers**: Task 33's hook times, and Task 36's if it ran; `harness device notify` timed 20 times (median, p95), a fresh process, so each proves the pid by the table; and Task 6's two `tellDevices` times from one process, with and without the table read (the watch's path).
10. **Clean up**: `desktop-e2e.sh cleanup`; nothing listens on 18478; the `admin` user's files are untouched.
11. **The key goes**, last, after every check that uses it: delete `%USERPROFILE%\.harness-test\openrouter.key` (and its `.harness-test` folder when empty) in the profile it was put in; `Test-Path` on it then says `False`. The pull request says the test key was removed from the VM after the checks. The key itself is in no command, log, note, commit or pull request text.

**Not run, and why:**
- The real dial on Windows: it stays on the Mac. Serial on Windows is covered by the stand-in here and by `serialWindows.spec.ts` on windows.yml.
- x64 hardware: the Dell PC is not available. x64 runs on windows.yml only.
- The dial following the app in front, and the Notifications menu: they need the Windows Device app (a separate item). Their transport is checked by Tasks 6 and 23.
- Nothing runs against production, a person's account or a person's apps.

**No temporary workflow.** windows.yml runs the long Windows checks (it is on demand already, and the new step stays in it), and cli-e2e.yml the Linux ones. Proposal for later, not in this pull request: none; windows.yml stays on demand.

# Windows native: the CLI on Windows (sub-project B)

Date: 2026-10-16
Status: draft, for review

## Goal

A Windows user, or a Windows machine used as a remote machine, installs the Harness CLI with one
PowerShell command and gets what a Mac gets: a daemon that starts at logon and keeps itself running,
updates itself without ending agents, rolls back a bad build, accepts trusted local commands only from
the signed-in user, reports every engine's state through hooks, and can be uninstalled cleanly.

Sub-project A (`docs/superpowers/specs/2026-10-14-windows-native-pty-host-design.md`) made the terminal
backend, process control and engine launch work on Windows. B makes the CLI installable, supervised,
updatable and fully integrated there. The desktop app on Windows is sub-project C, and it depends on B.

## Decomposition (unchanged from A)

| | Sub-project | Depends on |
|---|---|---|
| A | PTY host + terminal backend + Windows process control (done) | — |
| **B** | CLI on Windows (this spec) | A |
| C | Desktop on Windows | B |
| D | Code signing, and release of the desktop's Windows artifacts | A–C |

B publishes the Windows CLI artifacts itself (the installer cannot work without them). D keeps code
signing and the desktop's release.

## Current state

- **Installer:** `cli/scripts/install.sh` (POSIX `sh`, `curl | bash`) only. It needs tmux. Launchers in
  `~/.local/bin` are shell scripts; PATH is edited in rc files.
- **Runtimes:** `cli/src/lib/runtimeInstall.ts` `platformKey()` knows darwin and linux only, and unpacks
  `.tar.gz` with a hardcoded `/usr/bin/tar`, then makes the folder read-only (`chmod 555`).
- **Release:** `release.yml` (`v*_cli`) publishes `cli.js` and `notify.mjs` only. Nothing publishes a
  Windows Node runtime or `harness-pty`. `windows.yml` builds and tests the host, on demand.
- **harnessd:** `harnessd/platform.ts` knows launchd and systemd; `platformFor('win32')` is null. Stop,
  supervision and the update handoff use POSIX signals; `reexec.ts` replaces the master with exec.
- **Self-update:** `lib/selfUpdate.ts` swaps files inside `~/.harness/cli` by rename, with `.prev` hard
  links for rollback.
- **IPC:** `lib/localSocket.ts` serves the daemon's HTTP API on a Unix socket (0700 folder, 0600
  socket); reaching it is the trust bit (`isTrustedLocal`). On Windows `localSocketPath()` is null, so
  every call goes over loopback TCP, which never counts as trusted.
- **Hooks:** off on Windows (`DISABLE_HOOK_INSTALL=true`). Hook command lines are POSIX-quoted
  (`engines/kit/notifyHooks.ts`), `cli/hook/notify.mjs` exits when `TMUX_PANE` is unset, and the hook
  file writers rely on `O_NOFOLLOW`, `fchmod`, uid and mode bits.
- **Uninstall:** none, on any OS.

## Decisions

1. **Mirror the Mac flow with PowerShell.** A per-user PowerShell installer, the same `~\.harness`
   home, the same Node daemon. No single-file executable, no MSI or winget (they would fork the update
   and runtime code from the Mac's).
2. **Per-user, no administrator rights, no UAC prompt**, for install, run, update and uninstall.
3. **Windows-only layout changes.** Version folders with pointer files, the `.cmd` launcher and Task
   Scheduler are used on Windows only; mac/Linux layouts and behavior do not change, except for the new
   `harness uninstall` and these small changes on every OS:
   - the last line of `harness status` and `harness start` under `○ stopped` reads `start with: harness
     start` (it said `running in background`), and nothing is printed under `◌ out of reach`;
   - the OpenCode, Kilo and Pi plugin texts read `HARNESS_PANE` when `TMUX_PANE` is unset (no change
     under tmux; the plugin is rewritten every release anyway);
   - on Linux a zombie daemon counts as gone, so `harness uninstall` in a container with no init goes on;
   - the updater's start line says `self-update off` for a development build, which never updates.
4. **No symlinks on Windows** (creating one needs Developer Mode or a privilege). Pointers are files.
5. **`hn` is not ported** (it does not compile for Windows: about 200 errors across 10 Unix-only
   modules). On Windows the installer does not install it, and `harness tui` says it is not available.
6. **Phases** (one spec, one plan, each phase testable on its own): B1 distribution, B2 IPC and trust,
   B3 harnessd lifecycle and self-update, B4 hooks and engines, B5 uninstall, Windows CI install job and
   E2E.

## 1. Distribution and install (B1)

### Layout

```
%USERPROFILE%\.harness\
  bin\harness.exe                       ← on the user's PATH
  bin\harness-launch.exe                ← windowless starter (below)
  cli\<version>\cli.js, notify.mjs      ← one folder per CLI version
  cli\current                           ← pointer file: the version in use
  cli\notify.mjs                        ← stable copy the hook command lines name (section 4)
  runtime\node-<version>-win32-<arch>\node.exe
  runtime\current-node                  ← pointer file (as on mac)
  runtime\pty\<version>\harness-pty.exe, conpty.dll, OpenConsole.exe
  runtime\pty\current-pty               ← pointer file (written by A's reader, now by the installer)
```

Pointer files are written by write-to-temp then rename. The pointer readers in Node and in Rust
(`harness.exe`, `harness-launch.exe`) read them with the "single segment, must resolve inside its own
root" check `managedNodePath()` applies today.

**Contract for the desktop (C):** on Windows there is no `~\.harness\cli\cli.js`. The desktop's
`HarnessCliRunner` resolves `cli\current` plus `runtime\current-node` (its first tier), or runs
`bin\harness.exe`. The commands it relies on (`start`, `stop`, `version`, `auth status --json`) are
unchanged.

### Launchers

- **`harness.exe`**: a small Rust console binary in the `pty/` workspace. It reads `cli\current` and
  `runtime\current-node` (the same reader as `harness-launch.exe`), runs `node.exe cli.js <args>` in the
  same console with the caller's arguments passed straight through `CreateProcess`, ignores Ctrl-C itself
  so Node handles it, and exits with Node's exit code. **Not a `.cmd`:** cmd.exe re-parses a batch file's
  arguments in the caller's own command line, so an argument holding `"` followed by `&`, `|`, `<` or `>`
  would run commands or truncate files — and agents call `harness send <name> "<text>"` with text they did
  not write (found while building B1.8).
- **`harness-launch.exe`**: a small Rust binary (GUI subsystem, so no console window) built in the
  `pty/` workspace and shipped beside the host. It resolves the same pointers and starts
  `node.exe cli.js <args>` with `CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP`,
  then exits. Not `DETACHED_PROCESS`: Windows ignores `CREATE_NO_WINDOW` beside it, and every console child
  of the daemon would then open a visible window. When the job forbids breakaway (access denied), it
  starts the process inside the job. Every background start goes through it: the scheduled task, `harness start` from a terminal,
  and a master handing over to its replacement.

### `install.ps1`

Run as `irm https://cdn.autonomous.ai/harness/cli/install.ps1 | iex`. Steps, in the order of
`install.sh`:

1. Host check: Windows 10 1809 or later (ConPTY), x64 or arm64, `tar.exe` present (built in since 1803).
2. Download the Node runtime, the CLI and the pty payload named by their manifests; verify each file's
   SHA-256 and size; unpack into a staging folder and rename it into place.
3. Write the pointer files, `bin\harness.exe` and `bin\harness-launch.exe`.
4. Add `%USERPROFILE%\.harness\bin` to the user's PATH (`HKCU\Environment`), then broadcast
   `WM_SETTINGCHANGE` so new shells see it. Never touch the machine PATH.
5. Register the harnessd task (section 3) and start it; verify with `harness version` and
   `harness status`.

Flags: `-Desktop` (runtime and CLI only, as `--desktop` on mac: the desktop app starts the daemon
itself), `-Manifest <url-or-path>` (test and staging installs), `-NoService`. The tmux check is not run
on Windows. Errors are printed as a sentence a first-time user understands, with the step that failed.

### Runtimes inside the CLI

- `platformKey()` gains `win32-x64` and `win32-arm64`.
- `runtimeInstall.ts` unpacks with `tar.exe` from `%SystemRoot%\System32` on Windows (it reads `.zip`)
  and never makes folders read-only there. `retireSuperseded` retries a folder it cannot remove yet (a
  `node.exe` still running) on its next pass.
- tmux and grid are not installed on Windows.

### Publishing

- **pty payload**: the CLI release builds `harness-pty.exe`, `harness-launch.exe` and the bundled
  ConPTY files for win32-x64 and win32-arm64 (the `windows.yml` jobs, called from the release), and
  publishes them under `harness/pty/<version>/` with a manifest `harness/pty/metadata.json`
  (`{version, url, sha256, size}` per platform). The crate version becomes the CLI's release version.
- **Node for Windows**: a workflow downloads the official `node-v<ver>-win-<arch>.zip`, checks it
  against nodejs.org's signed `SHASUMS256.txt`, and republishes it under the existing Node manifest's
  `win32-x64` and `win32-arm64` keys, at the same version the Mac runtime uses.
- **`install.ps1`** is uploaded beside `install.sh`.
- Every publish goes to a staging prefix first; the E2E installs from it. Publishing to the production
  manifests is a release step the owner starts.

## 2. IPC and trust (B2)

### The daemon's pipe

- On Windows `localSocket.ts` listens on `\\.\pipe\harness-<random>` (128 random bits, new each start).
  The name is written to the owner's `daemon-<port>.json` in the data folder. Node's HTTP server runs on
  a pipe as it does on a Unix socket.
- Node cannot set a pipe's DACL, and the default one lets Everyone open it for reading. So reaching the
  pipe is **not** trust on Windows. Every request proves the token instead, as A's pty host does:
  - The daemon keeps a 32-byte token in a file in the data folder (the user's profile; checked with
    `secureState`'s Windows rules: inside the profile, not a reparse point).
  - The client picks a nonce and sends `X-Harness-Auth: <nonce>.<hex(HMAC-SHA256(token, 0x01‖nonce))>`.
    The token never travels.
  - The daemon answers with `X-Harness-Proof: hex(HMAC-SHA256(token, 0x00‖nonce))`; the client rejects
    a response without a valid proof (a process that took the name after the daemon died).
  - Before dialling, the client checks the daemon's pid from the port file is alive, with A's identity
    proof (pid plus start marker).
  - The daemon checks a nonce is not reused (a bounded recent set).
- `isTrustedLocal()` is true on Windows only for a pipe request with valid auth.
- Loopback TCP keeps exactly the limited trust it has on mac (`x-adapter-local` plus Host/Origin
  checks); nothing that needs trust is served there.
- `daemonEndpoint.ts` (`localDaemonStatus`) and `cli.ts` (`daemonCall`) gain the pipe path; the CLI
  prefers the pipe and falls back to loopback for calls that need no trust.

### Hook credential

On Windows, `hookAuth.ts` drops the uid and mode checks (as today) and adds A's location rules: the
file must resolve inside the profile and must not be a reparse point. It relies on the profile's ACL,
the same protection Claude Code and Codex use for their own credentials.

## 3. harnessd lifecycle and self-update (B3)

harnessd's rules (`cli/src/harnessd/AGENTS.md`) hold on Windows: the master opens no sockets, the spawn
protocol only grows, platform supervision is how the CLI starts and stops a supervised master.

### Start and keep running

- `platformFor('win32')` returns a new `TaskScheduler` platform (`PlatformName` gains `taskscheduler`).
  `harness service install` registers two per-user tasks (Task Scheduler names are machine-wide, so
  the name carries the user; they sit in the root folder, which every user may write):
  `Harness harnessd (<user name>)` **every 5 minutes**, and `Harness harnessd at sign-in (<user name>)` **at
  logon**. Both run `harness-launch.exe start --if-down`, which does nothing when a live master holds the
  spawn lock (the replacement for launchd's KeepAlive and systemd's `Restart=`). The logon task adds
  `--at-logon`, which first forgets a `harness stop`, as launchd loads an agent booted out at the next
  login; the 5-minute task honours the stop. Two tasks, because a task's action runs whatever trigger
  fired, and the boot time alone does not tell a new start: with Fast Startup a Shut down keeps the
  uptime. The tasks have no execution time limit, do not start a second instance, and run at normal
  priority (Priority 4: Task Scheduler's default, 7, is below normal, and the daemon and every agent
  would inherit it). An install from before writes and registers both at its next `harness start` or
  `harness service install`.
- `install.ps1` registers the tasks by default (a remote Windows machine must come back after a reboot
  once its user signs in; see Known limits for a reboot with nobody signed in); `-Desktop` and
  `-NoService` skip it.
- The master runs outside any job object (the launcher's breakaway), so ending the task, closing a
  terminal or signing out of an SSH session never ends it.
- `harness start` with the task registered runs the task (`schtasks /Run`); without it, it starts the
  master through `harness-launch.exe`.

### Stop

- No POSIX signals. `harness stop` asks the core over the pipe (trusted); the core sends a new protocol
  message `harnessd:stop` to the master; the master stops the services and the core, then exits.
- The master stops the core and each service with a new protocol message (`harnessd:shutdown`) on the
  IPC channel it already has, then waits for the existing grace period.
- After the grace period, or when the core does not answer, the CLI or master ends that one process with
  `TerminateProcess`, after checking its identity (pid plus start marker). **Never `taskkill /T`**: the
  pty host's parent is the core, so ending the tree would end every agent.
- `daemonStop.ts` and `supervisor.ts` gain these Windows paths; the deps stay injected (100% coverage).

### Master replacement

Windows has no exec. Where `reexec.ts` would exec in place, the master on Windows starts its
replacement through `harness-launch.exe` while holding the spawn lock, and exits once the replacement has
written the pid file, releasing the lock as it leaves (the replacement does not take it again). It still happens only in the gap before a core starts. The pid changes; the pid
file and every pid check follow it. The lean bundle is off on Windows (it relies on hard links), and
process names stay `node` (`processName.ts` already does that).

### Self-update and rollback

1. The updater downloads the CLI into `cli\<version>\`, verifies it, and canaries it
   (`node cli.js version --json` in a temp folder, which also says the host protocol it needs).
2. It writes `cli\current` and refreshes the stable `cli\notify.mjs` (temp file and rename, retried if
   a running hook holds it), then says `harnessd:staged`.
3. The handoff is the Mac's: the core exits 75, the master starts the new core from the new folder and
   judges it on probation.
4. Rollback rewrites `cli\current` to the previous version. The two newest versions are kept; older
   folders are removed once no live process runs from them, retried later when removal fails.
5. A Node runtime update installs a new `runtime\node-…` folder and pointer; the next master and core
   use it; the old folder is retired when nothing runs it.
6. The terminal host payload (`runtime\pty\<version>`, `current-pty`) now updates with the CLI (sub-project G,
   [the PTY host rollover](2026-10-20-pty-host-rollover-design.md) §5). The updater installs a promoted payload
   beside the CLI's check, under the same lock and handover, and the master's probation judges both;
   `harness update` installs one too. Fixes to `harness-pty.exe`, `harness-launch.exe` or `harness-serial.exe`
   no longer wait for `install.ps1` to run again. A CLI release may raise `PTY_PROTOCOL`: the updater stages
   a build whose `version --json` names a protocol above the installed host's only together with a promoted
   payload of exactly that protocol, the host first, in one handover and one probation.

The Mac's rules stay: a dev build is never replaced, updates only move forward, rejected versions are
remembered. Agents survive because the pty host is independent of the daemon (A).

## 4. Hooks and engines (B4)

- **Hook command lines.** Each engine's hook contract declares, for win32, what runs its hooks:
  `argv` (an argument list, no shell), `bash`, `cmd` or `powershell`. Verified while planning: Claude
  Code takes an exec-form hook (`argv`; its shell form runs Git Bash, or PowerShell without it, which no
  single quoting serves), Codex runs `powershell` (its Windows session shell, with `-NoProfile -Command`;
  `%COMSPEC% /C` only when there is no one local session shell or no PowerShell, and there the line fails closed;
  measured in B4.15), Command Code runs `cmd`, Copilot runs `powershell`. An engine with
  no verified runner gets no hooks on Windows. `notifyHooks.ts` quotes for that runner. The line names only `node.exe`, the stable
  `cli\notify.mjs` and flags Harness writes; no user input.
- **Pane identity.** `notify.mjs` reads `HARNESS_PANE` (`<instance>:%N`, set by the pty host since A)
  when `TMUX_PANE` is unset, and reports over loopback with the hook credential, as today.
- **Hook file writers** (`nativeHookFiles.ts`, `nativeInstall.ts`, `homeAdoption.ts`) gain Windows
  paths: no `O_NOFOLLOW`, `fchmod` or uid; refuse a reparse point at every step; write by temp file and
  rename.
- **Engine homes on Windows**: a per-engine table (Claude `~\.claude`, Codex `~\.codex`, OpenCode and
  Kilo under `~\.config` or `%APPDATA%`, and the rest), each entry verified on the VM.
- **Engines that do not run yet**: find and fix OpenCode on arm64 and Command Code; an engine that
  cannot run natively is reported as unavailable on Windows.
- **Copy**: the desktop and mobile apps word `PTY_HOST_UNAVAILABLE` and `ENGINE_LAUNCH_REFUSED` for a
  first-time user.
- `DISABLE_HOOK_INSTALL` is no longer forced on Windows once the E2E shows Claude Code, Codex, OpenCode
  and Kilo reporting their state.

## 5. Uninstall (B5, every OS)

`harness uninstall` asks for confirmation (it ends every agent), or runs with `--yes`. `--keep-data`
keeps the data folder (sign-in, state, history). Steps:

1. Stop the daemon and every pty host gracefully; agents end.
2. Remove the engine hooks Harness installed (the existing recognizers).
3. Remove the platform service: the scheduled task, the launchd plist or the systemd unit.
4. Remove the PATH entry: `HKCU\Environment` on Windows, the lines Harness added to rc files on mac and
   Linux (matched by their marker comment).
5. Remove the launchers and `~/.harness` (or all but the data folder with `--keep-data`).

On Windows a process cannot delete the `node.exe` it runs from: the last step runs in a detached
`cmd.exe` that waits for the CLI's process to exit, then removes the folder.

## 6. Testing

- **Unit (Vitest, on mac)**: every new Windows branch with injected deps — pointer files, launcher
  resolution, Task Scheduler XML, pipe auth and proof, stop and `TerminateProcess` decisions, master
  replacement, self-update and rollback on version folders, hook quoting per runner, uninstall steps.
  harnessd keeps 100% per-file coverage.
- **Rust**: `harness-launch` unit tests; Windows behavior in `windows.yml`.
- **Windows workflow**: `windows-pty.yml` becomes `windows.yml` and gains an install job on
  windows-latest and windows-11-arm: `install.ps1 -Manifest <local manifest of this build>`, then check
  `harness version`, the task, a running daemon, a PowerShell agent, then `harness uninstall --yes` and
  check nothing is left.
- **E2E on the VM**, as a new local user with a clean profile:
  1. install with `irm` from the staging prefix;
  2. reboot: the daemon is back at logon;
  3. update to N+1 while an agent runs: the agent survives;
  4. a canary-failing build: rolled back;
  5. hooks of Claude Code, Codex, OpenCode and Kilo report state to the Mac desktop (remote use);
  6. another local user cannot make a trusted call;
  7. uninstall: no task, no PATH entry, no files left.
- **mac/Linux**: the existing gates (`test:core`, `test:harnessd`, `test:resume`, contract) match their
  baselines; `harness uninstall` is tested on mac and Linux.

## Out of scope for B

The `hn` TUI on Windows; code signing (D); the desktop app on Windows (C); serial/USB cables (planned
separately); WSL.

## Known limits

- **The daemon starts at logon**, as a LaunchAgent does on a Mac: a Windows machine rebooted with nobody
  signed in has no daemon until someone signs in (or Windows autologon is set). Running without a
  logon (an S4U task or a service) needs a right a standard user lacks, so B does not do it.
- **`hn` is not available on Windows**; `harness tui` says so.
- **On Windows the services run in the core's process** (no separate service processes yet): a service
  process reaches the core over a Unix socket, which Windows does not have here, so the master runs them
  with `HARNESSD_SERVICES=none` and says so at start. Only the updater, the master's own, has a process.
- **Agent commands use loopback TCP on Windows.** `harness new`, `send` and the other agent commands,
  and the daemon's agent list and stop, go over the loopback port without the pipe's credential, so
  another local account on the same PC can reach them. Moving them onto the authenticated pipe is a
  follow-up.
- **The full CLI unit suite is not run on Windows.** CI runs a curated list of specs there; some specs
  still assume POSIX fixtures, or write into the real `%USERPROFILE%\.harness`.
- **Uninstall right after creating a harness** that has not bound its conversation yet: stopping it is
  refused (`IDENTITY_UNAVAILABLE`), the summary says it may still be running and the command exits 1.
  On Windows the terminal host's end closes it; on macOS and Linux nothing does.
- **Over SSH, uninstall reports engine harnesses as possibly still running** (G2): Windows refuses WMI
  to the SSH session, so the stop is refused, though the terminal host's end then closes them.
- **Terminal rows read `offline` after a daemon restart** (update, reinstall) while their shell keeps
  answering (G3). Engine rows come back active.
- **`harness service install` under another `HOME` on macOS** starts a daemon on the real home (G7):
  the plist does not carry `HOME`. Never run that test step on a developer's Mac.
- **`harness-launch --exec` does not exist yet:** the final removal of an uninstall over SSH, as a
  standard user, can stay inside the SSH session's job; the command then says what to run by hand.
- **Copilot and Command Code hooks on Windows have not run end to end** (neither CLI was on the VM).
  Command Code reads `%HOME%\.commandcode` when `HOME` is set, and ignores `COMMANDCODE_HOME`;
  Harness writes and removes in the profile.
- **A `HOME` on a network share refuses every engine launch on Windows**, though most engines read the
  profile there, not `HOME`.
- **Agent Messages' inbox block and Harness's command allowances** (Claude Code's `permissions.allow`,
  Codex's `rules/harness.rules`) are not installed on Windows, so Claude Code in ask mode asks about
  `harness` commands again.
- **State files are checked, then opened by path** (`secureState.ts`): a file swapped in between is
  read. Only the user, SYSTEM and administrators can write there under the profile's ACL.
- **Settings folders set through an engine variable** (`CODEX_HOME` and the like) have no owner check
  on Windows: one pointed into another account's writable folder could be swapped under Harness.
- **A daemon token outside the profile**: a data folder set with `ADAPTER_DATA_DIR` outside the
  profile (for example under `C:\`) can inherit access for every local account, and the token with it.
- **The data folder claim can be skipped.** When its fixed name is held by something that does not
  prove the daemon's token (another program, or a core that answers too slowly), the start goes on
  without it, so two starts at the same moment could both run on one folder. The served-folder check
  and the spawn lock still cover the ordinary paths.
- **A start inside a job that forbids breakaway** (a Harness pane, on an install without the task)
  starts the daemon inside that job; closing the pane ends it, and only `launch.log` says so.
- **Ending `harness.exe`** (a caller's timeout) leaves the `node` it started running.
- **Ending a verified process** looks its pid up again: a pid reissued in that moment would be ended
  in its place (the same user's processes only).
- **A stop during a handover that runs past the 45 s lock wait** can be undone by a slow replacement.
- **Build retirement can remove a build `install.ps1` has just unpacked** if the updater starts
  between the folder and the pointer; the next install puts it back.
- **A staging pty host keeps its folder** (`runtime\pty\<release core>`) when the release of that
  version installs; staging testers run `harness uninstall --keep-data` before installing the release.
- **install.ps1 removes version folders with `Remove-Item -Recurse`**, which in Windows PowerShell 5.1
  may follow a directory link the user placed inside one.
- **Smaller follow-ups from the final review**, none of which a person meets in ordinary use:
  - the pipe's listen side checks names with the looser `pipeIdOf` rule (its names always come from
    `newPipePath`);
  - `/api/status` `localSocket` carries a pipe name on Windows, which a client must not read as a path;
  - a crashed start can leave `.daemon-token.*` temp files in the data folder;
  - `start --if-down`'s judge skips an identified orphan core of a stale master, reads an elevated
    master's `EPERM` as dead, and serves a stop queued while the core was paused once it resumes;
  - the task's start waits up to 45 s for the spawn lock without a line, and its "already running" exit
    under the lock skips the wrong-account check;
  - republishing the live version with other bytes leaves no build to roll back to (releases never
    reuse a version);
  - the production manifest path of the Node workflow is gated only by who may dispatch it (a GitHub
    environment is the owner's call), and "no checksum for an archive" has no test of its own;
  - release.yml's checks of the staging install.ps1 on the CDN and of Windows Node only warn;
  - the pty version folder takes only dotted numbers, so a prerelease host is laid down under its
    release core (`ptyHost/launch.ts` `VERSION_DIR`, install.ps1).

## Risks

- **Antivirus and SmartScreen** may block or slow unsigned `harness-launch.exe` and `harness-pty.exe`
  until D signs them. Mitigation: per-user install outside Program Files, files unpacked by the
  installer (no Mark of the Web on extracted files from `tar.exe`); recorded in the E2E.
- **Task Scheduler differences** across Windows editions and policies (some managed machines block
  user tasks). Mitigation: `harness start` still works without the task; the failure is reported.
- **Engines' Windows hook runners** (Git Bash for Claude Code, others unknown) may differ by version.
  Mitigation: the runner is declared per engine and verified in the E2E.
- **Default pipe DACL** lets other users open the pipe for reading. Mitigation: per-request HMAC with a
  token in the profile; nothing is trusted on reachability alone.

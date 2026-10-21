# Windows native: PTY host and terminal backend (sub-project A)

Date: 2026-10-14
Status: implemented (branch `feat/windows-native-pty`; Windows E2E in `docs/testing/windows-pty-e2e.md`)

## Goal

Run Harness natively on Windows (no WSL), for both uses:

- A Windows user runs the desktop app and CLI on their own machine and drives agents there.
- A Windows machine is a remote machine that a Mac, phone or web client drives.

Every engine is in scope (Claude Code, Codex, plain shell panes, and the rest), and agents must survive
a daemon restart or upgrade, exactly as they do on tmux today.

## Decomposition

Native Windows is several independent projects. Each gets its own spec, plan and implementation:

| | Sub-project | Depends on |
|---|---|---|
| **A** | PTY host + terminal backend + Windows process control (this spec) | — |
| B | CLI on Windows: PowerShell installer, managed runtimes, harnessd under Task Scheduler, IPC trust (named pipe/token), engine launch without POSIX shells, hook commands | A |
| C | Desktop on Windows: runner build, provisioner, replacements for macOS channels (clipboard, notifications, window, fonts, menu), installer | B |
| D | CI and release for Windows artifacts | A–C |

A is first because every other piece needs a terminal backend that is not tmux.

## Current state

- tmux is the only terminal backend (`cli/src/config/terminalConfig.ts`). The `TerminalBackend`
  interface (`cli/src/lib/terminalBackend.ts`) exists, but `core/agents/*` and about 40 other modules
  import tmux helpers directly.
- Process identity, liveness and kill rely on `ps`, `/proc`, process groups and POSIX signals.
- No ConPTY, node-pty or Windows CI exists anywhere in the repo.
- `tui/vendor/alacritty_terminal` already contains a terminal emulator and a `tty` module with Windows
  ConPTY support, and it loads a bundled `conpty.dll` when one is present
  (`src/tty/windows/conpty.rs`).

## Decisions

1. **A Rust PTY host, `harness-pty`**, is a separate long-lived process. It is not node-pty inside the
   daemon (no persistence, no native Node module) and not a third-party tmux clone (control-mode
   compatibility unknown, bugs outside our reach).
2. **Panes outlive the daemon**: the host is not a child of the daemon's lifetime.
3. **Reuse from Orca** (`stablyai/orca`, MIT): selected TypeScript modules and design ideas, not its
   26k-line Electron-bound terminal daemon. Details below.
4. **mac/Linux stay on tmux.** `harness-pty` builds on Unix only so that it can be tested on Linux CI.

## 1. Architecture and components

### `harness-pty` (Rust, new crate `pty/`)

- Shares the vendored `alacritty_terminal` and `vte` from `tui/vendor`.
- One host per user and `HARNESS_HOME` (the home's lock, `run/pty-host-<protocol>.lock`), listening on
  `\\.\pipe\harness-pty-<hash(user SID + HARNESS_HOME)>-<16 random hex>-p<protocol>` with an
  owner-only DACL. The random part is new at each host start, so nobody can guess the name and create
  the pipe first; clients connect only to the endpoint the discovery file (section 4) names. Node's
  pipe client (libuv) cannot ask for `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`, so a process
  that held the name could impersonate the daemon. The name is not secret once the host runs (anyone
  can list `\\.\pipe\`), so after a host dies its name could be taken over: the daemon never dials the
  endpoint of a host proven dead (its pid runs nothing, or another process has it since the discovery
  file was written; `cli/src/lib/ptyHost/launch.ts` `discoveredHostDead`) and starts a new host
  instead. A live host's pid whose hello fails stays an error. (The host's own Rust client connects
  with `SECURITY_IDENTIFICATION`.) On Unix (tests only) it listens on a
  Unix socket in `HARNESS_HOME/run/`.
- Per pane:
  - a ConPTY via `alacritty_terminal::tty`, using the bundled `conpty.dll`/`OpenConsole.exe`;
  - the child process in its own Job Object, kill-on-close. Only the host holds the job's handle
    (it is not inheritable), so when the host dies, every pane's whole tree dies with it, as a tmux
    server's panes do (section 4);
  - an `alacritty_terminal` grid with scrollback bounded like tmux `history-limit`;
  - metadata: id `%<N>` (tmux-shaped, see "Decisions made while planning"), title (OSC 0/2), cwd (spawn cwd, the user's home directory when the create
    gives none, as a new tmux pane; then OSC 7), owner tag, and a held flag
    (the `remain-on-exit` equivalent);
  - the env var `HARNESS_PANE=<instanceId>:<paneId>` in the child, so hooks can name their pane the
    way they read `TMUX_PANE` today.

### Protocol

- Each client opens two connections, as in Orca:
  - `control`: NDJSON request/response with an `id` per request;
  - `stream`: length-prefixed binary frames, one subscription per pane.
- Handshake: `hello{auth, nonce, protocolVersion, clientId}`. The client reads the token from the
  discovery file (section 4) but never sends it: whatever listens on the endpoint reads the hello,
  and that may be a process squatting on the pipe name. `nonce` is 32 random bytes (64 hex digits)
  and `auth = hex(SHA-256(token || 0x01 || nonce))`; the host compares it with its own (in constant
  time) and refuses a mismatch as incompatible. The reply carries
  `proof = hex(SHA-256(token || 0x00 || nonce))`, and the client refuses an endpoint without a valid
  proof, so a squatter cannot pass for the host. The separators differ, so a host's proof sent back
  as an `auth` proves nothing. A host that holds its home's lock but finds the pipe name taken exits with an
  error ("pipe name held by another process") and sets the stale discovery file aside.
- Control requests map one to one onto the backend:
  - pane lifecycle: `create`, `kill`, `respawn` (with `expectedHeldToken`), `holdOpen`, `releaseHold`;
  - reads: `inventory`, `titles`, `paneState`, `paneInfo`, `capture{mode, historyLines, ansi}`,
    `processes`, `jobPids`;
  - writes: `write`, `paste`, `key`, `setTitle`, `notify`;
  - stream control: `resize`, `subscribe`, `pause`, `resume`.
- **Snapshots**: the host serializes the viewport from its grid to ANSI and stamps an output sequence
  number atomically with it. `beginSnapshot`/`endSnapshot` become a sequence cut, with no output gating
  like `tmuxStream.ts`. The `tuiOwnsScrollback`, `conversationHistory` and `repaint` options keep
  their current meaning, implemented over the grid.

### Daemon (TypeScript)

- `TerminalBackendName = 'tmux' | 'ptyhost'`.
- `PtyRuntimeRef { backend: 'ptyhost'; paneId: string; instance: string }` (the host instance, `p<protocol>`), and
  `TerminalRuntimeRef = TmuxRuntimeRef | PtyRuntimeRef`.
- `cli/src/lib/ptyHostBackend.ts` implements the whole `TerminalBackend`, including `holdOpen`,
  `respawn` and `openStream`, so restart, fork and swap work.
- The default backend is `ptyhost` on `win32` and `tmux` elsewhere. `TERMINAL_BACKENDS` still
  overrides it.
- Windows helpers live in `cli/src/lib/windows/`.

## 2. Removing tmux coupling

The modules outside `lib/tmux*` that import tmux code fall into three groups.

**Group 1: process table and engine recognition.** These are not tmux, they only live in `tmux.ts`:
`processRows`, `ProcessRow`, `argvTokens`, `engineProcessMatch(Score)`, `resumeSessionId`,
`processLaunchArgs`/`launchArgs`, `bypassPermissionActive`, `permissionModeFromArgv`.

- Move them unchanged to `cli/src/lib/processTable.ts`. Only the data source becomes per platform:
  `ps` on Unix, `harness-pty` on Windows (section 3).
- Callers include `engines/kit/adoption`, `nativeConversation`, `captureResumeIdentity`,
  `deleteAgentFallback`, `gridAssignments`, `sessionSearch/externals/*` and `core/engines/hooks`.

**Group 2: pane operations that bypass the backend.** These are `clearPaneRemainOnExit`,
`tmuxPaneState`, `resolvePaneEngineProcess`, `lookupPaneEngineProcess`, `tmuxPaneInfo` and
`checkSessionRuntime`, used by `create`, `newPane`, `restart`, `retarget`, `swap`, `fork`,
`externalResume`, `core/terminals/*` and `resumeAgentService`.

- Add `releaseHold`, `paneState`, `paneInfo` and `rootProcess` to `TerminalBackend`.
- Engine resolution ("which process in this pane is the engine") moves above the backend: it takes the
  pane's root pid from `rootProcess` and searches the Group 1 process table.
- Callers reach the backend through `TerminalBackendCoordinator.backendFor(runtime)`.

**Group 3: tmux bootstrap and version gates.** These are `ensureTmuxOnPath`,
`tmuxSupportsSessionEnv`/`TMUX_SESSION_ENV_MIN`, `adoptLegacyHarnessSessions` and `listTmuxPanes`,
used in `main.ts`, `create.ts`, `launchOverrides.ts` and `resumeAgentService.ts`.

- Add `backend.prepare()`, run at daemon start. For tmux it does the PATH check and legacy adoption;
  for ptyhost it makes sure a host is running and connects to it.
- Add `backend.capabilities` (for example `{ sessionEnv: boolean }`) to replace the scattered tmux
  version checks.
- `listTmuxPanes` callers use `backend.inventory()`.

**Types.** `TmuxRuntimeRef` in `core/agents/*` becomes `TerminalRuntimeRef`, narrowed by `backend`
only where code is tmux-specific. `HookTerminalHint` becomes a union over both backends.

**Order.** Groups 1–3 land first as a pure refactor on mac/Linux with `TmuxBackend` as the only
implementation and no behavior change. `PtyHostBackend` comes after, which keeps refactor risk apart
from Windows risk.

**Not changed:** `tmuxStream.ts`, `tmuxAgentDiscovery.ts`, and the rest of `tmux.ts`. They stay
tmux-private.

## 3. Windows process control

### Process table

`harness-pty ps --json` provides it, as does the `processes` request while a host is running. It is
built from:

- `CreateToolhelp32Snapshot` for pid, parent pid and executable;
- `QueryFullProcessImageNameW` for the image path;
- `NtQueryInformationProcess(ProcessCommandLineInformation)` for the command line, split with
  `CommandLineToArgvW` into `nativeArgv`;
- `GetProcessTimes` for the creation time.

The rows map onto `ProcessRow` with `startMarker = "w:<creation FILETIME>"`. The kernel records the
creation time and a later wall-clock change does not move it, so Windows needs no `startTicks`
equivalent.

This follows the existing macOS pattern, where a bundled helper serves `nativeProcessControl`. It
avoids a native Node addon (`@vscode/windows-process-tree`) and PowerShell CIM scans, which take about
a second each. `cli/hook/notify.mjs`, which runs its own `ps`, uses the same helper.

### Identity

`PtyHostBackend.validate()` answers `alive` only when the engine matches its recorded pid and creation
time **and** its pid is in the pane's Job (`jobPids`, from `JobObjectBasicProcessIdList`). A recycled
pid therefore cannot pass, even with a colliding start time. Orca documents this as an open gap in
`windows-pty-root-identity.ts`, #10680.

### Kill and signals

- **Pane kill** has three steps:
  1. `ClosePseudoConsole`, which delivers `CTRL_CLOSE_EVENT`;
  2. wait the same grace period tmux uses;
  3. `TerminateJobObject`, which kills the whole tree.
- **Process signals**: agent-process kills (`process.kill(pid, SIG…)` in `stopAgentService` and
  `swap`, through `terminateDeletedAgent`) go through one seam, `signalAgentProcess(pid, signal)` in
  `cli/src/lib/processSignals.ts`. Callers check the process's identity first, as before. Daemon and
  service kills are sub-project B.
  - Unix keeps `process.kill`.
  - Windows (the ptyhost backend installs the signaller) ends the pid and its descendants with
    TerminateProcess, for both SIGTERM and SIGKILL: a console engine has no window to ask to close.
    The descendants come from one read of the host's process table, by parent pid, a child taken only
    when its start marker is no earlier than its parent's (a reused parent pid names a newer process),
    and they end leaves first, the pid last (`windows/treeKill.ts` `endProcessTree`). It never closes
    a pane, even when the pid is the pane's root: a restart or swap holds the pane open, ends its
    engine through the seam and respawns in the same pane.
  - Ruling 2026-10-16: this replaced `taskkill /PID <pid> /T /F` (adapted from Orca's tree kill).
    Windows refuses `taskkill` to a standard user in an SSH session, even for that user's own
    processes (it goes through WMI, which turns down a non-admin network-logon token), while
    TerminateProcess works.
  - The liveness probe (signal 0) is unchanged.
- **Process groups** (pgid/tpgid, negative-pid kills) have no Windows equivalent. The pane's Job takes
  the "whole group" role.
- **Host death**: each pane's Job is kill-on-close, so the host's death (crash, kill, logoff) ends
  every pane's tree, including a shell that was still starting. Kill, respawn and the drop of a pane
  end the old child's Job explicitly, as before.

### Unavailable on Windows in v1 (reported as unavailable, not emulated)

- `nativeProcessControl`/`processEvidence`, which control engines running outside Harness. They need
  descriptor enumeration (`lsof`), and Windows handle enumeration is not reliable. These modules
  already return `nativeUnavailable` on unsupported platforms.
- External pane adoption (`externalOwnerControl`, `adoptLegacyHarnessSessions`), because there is no
  user tmux to adopt.
- `macosProcessGpu` and `darwin-process-images.c`, which are macOS only.

Agents created inside Harness keep every operation: create, kill, restart, fork, swap, resume, stream
and capture.

## 4. Lifecycle, upgrade and errors

### Start

- **Production**: the host is a harnessd sub-service (harnessd for Windows is sub-project B and runs
  under Task Scheduler at logon, outside any kill-on-close job). It runs beside the daemon and does
  not restart with it.
- **Development/tests**: without harnessd, `PtyHostBackend.prepare()` spawns `harness-pty serve`
  detached. A Windows host that finds itself in a job (the daemon's, a terminal's) starts a copy of
  itself with `CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS` and exits (`pty/src/breakaway.rs`).
- **Single instance**: the home's lock, `run/pty-host-<protocol>.lock` (`flock` on Unix, the file
  open with no sharing on Windows), taken before the endpoint is bound or pane ids are reserved. A
  host that cannot take it exits with success. The Windows pipe name is random per start, so it is
  no lock; its first instance is still created with `FILE_FLAG_FIRST_PIPE_INSTANCE`.
- **Discovery**: `HARNESS_HOME/run/pty-host-<protocol>.json` holds protocol, instance, endpoint (the
  socket path or pipe name), pid, version and token. The host writes it atomically, owner-only (0600;
  on Windows a user-only DACL from its creation). Clients connect only to the endpoint it names.

### Daemon restart or upgrade

The daemon reconnects, calls `inventory()`, and reconciles the registry exactly as with tmux. Agent ids
are kept.

### Host upgrade

- A running `.exe` cannot be overwritten on Windows, so binaries install per version as
  `runtime/pty/<version>/harness-pty.exe` with `conpty.dll` and `OpenConsole.exe`.
- The daemon speaks protocol N and N−1, so it keeps using an older host with no interruption.
- **Drain** on a protocol bump:
  - a new host starts on a pipe suffixed with its protocol;
  - new panes go to the new host;
  - the old host keeps its panes and exits once it has none.

  `TerminalBackendCoordinator` already holds several backend instances (`instanceId`, `byInstance`),
  so each host is one instance. A version directory is removed once no host runs from it.

  As built (Task 21, `cli/src/lib/ptyHost/drain.ts`):
  - `SUPPORTED_PTY_PROTOCOLS = [PTY_PROTOCOL − 1, PTY_PROTOCOL]`. The newest protocol's backend is the
    create backend and starts its host when there is none. An older protocol with a discovery file (or
    registry rows on its instance) gets a drain backend: it only reaches its host, never starts one,
    refuses `create`, and lists, streams and controls its panes. Rows keep their `ptyhost:p<old>`
    runtimes; route keys name the instance, so both hosts are reached at once.
  - **The rule for a bump**: the daemon keeps a client for N−1. The client speaks the host's own
    protocol (the discovery file's, the hello included); an op added at N is gated on the host's
    protocol, and an op N changes keeps its N−1 form.
  - Protocol 2 adds `shutdown`: the host replies and exits only with no pane at all (any owner's),
    else `bad_request` "host still has panes"; once granted it makes no pane, and removes its
    discovery file (and socket) as it exits. A drain host with no pane on two reconcile passes in a
    row is shut down (a protocol 1 host, which has no `shutdown`, is terminated by its pid once a
    fresh inventory lists nothing). A drain host that exits is gone: its inventory is then empty for
    certain, so its rows go gone through the reconciler's misses, and its backend leaves
    (`replaceBackends`) once no row names it. Then `<runtime>/pty/<version>/` directories older than
    `current-pty` and run by no live host of the home are deleted.
  - `<runtime>/pty/current-pty` names the version directory the installed CLI ships (as
    `current-grid` pins grid); `ptyHostBinary()` reads it after `HARNESS_PTY_BIN` and before the
    bundle's `dist/pty/`. The installer writes it (sub-project B).
- **An upgrade never kills an agent.**

### Host crash, logoff or reboot

- Panes die, as when a tmux server dies: every pane's Job is kill-on-close and only the host holds
  it. The daemon sees the pipe close and marks the runtimes `gone`.
- The existing resume path (`resumeStoppedAgent`) relaunches engines with their resume session ids.
- harnessd restarts the host with backoff.

### Error semantics ("we could not look" is not "nothing is there")

| Situation | Result |
|---|---|
| Pipe unreachable | `inventory` → `unavailable`, never an empty list |
| Request never sent | `not_started` |
| Request sent, no reply before timeout | `possibly_executed` |
| Bad token or protocol mismatch | `incompatible`, with the reason |

### Backpressure

- Each stream subscriber has a bounded buffer (4 MB). Past it, the host drops the subscriber with
  reason `overflow`.
- The daemon resubscribes and receives a fresh keyframe. The grid is authoritative, so only
  intermediate output is lost, as with tmux control mode.

### Resources

- Scrollback is bounded per pane.
- The host logs to `HARNESS_HOME/logs/pty-host.log` (`pty/src/logfile.rs`): owner-only (0600 in a
  0700 directory; the user-only DACL on Windows), and each line goes to stderr too, for a host run
  by hand. Past 5 MB it is moved to `pty-host.log.1` (one older file is kept), by the home lock's
  holder only; a rotation that fails is tried again 5 MB later. `HARNESS_PTY_LOG`
  sets the level (default `info`).

## 5. Testing

### Backend contract suite

`cli/src/lib/terminalBackend.contract.ts` runs one suite against `TmuxBackend` and `PtyHostBackend`.
It covers:

- create and kill;
- inventory and titles;
- capture in all three modes;
- typeLiteral, submitText and sendKey;
- holdOpen → respawn, and releaseHold;
- openStream: snapshot cut, resize, paste, pause/resume, overflow and resubscribe;
- validate when a pid is reused and when the process exits.

`harness-pty` builds on Unix, so the ptyhost half runs in the normal Linux PR CI.

### Rust

`cargo test` covers framing, grid capture and snapshot serialization, subscriber backpressure and
drain. Windows-only units (ConPTY, Jobs, process table) are gated by `cfg(windows)`.

### Refactor gate (section 2)

`test:core`, `test:resume`, `test:orchestrator`, the real-tmux specs and the PTY specs must pass
unchanged, with no snapshot or golden changes. They are run locally per AGENTS.md and recorded in the
PR.

### Windows workflow

A new manual workflow, "Windows" (`.github/workflows/windows.yml`, formerly windows-pty.yml), runs `cargo test` and
then the contract suite and the Windows specs against a real host, with the pinned ConPTY payload
beside it. It is not part of PR CI. Each target builds on its own runner: `x86_64-pc-windows-msvc`
on `windows-latest`, `aarch64-pc-windows-msvc` on `windows-11-arm`.

### End to end

E2E runs in a Windows 11 ARM64 VM on the Mac. The Mac desktop app connects to the Windows daemon as a
remote machine, which tests the remote-machine use before sub-project C exists. Scenarios:

1. Create Claude Code, Codex and PowerShell agents. Stream them to the Mac desktop; type, paste large
   text (Vietnamese, CJK) and resize.
2. Restart the daemon: agent ids are kept and streams reattach.
3. Upgrade the host with a protocol bump: the drain moves new panes and old agents survive.
4. Kill the host: resume relaunches the engines.
5. Kill a pane whose engine has child processes: the whole tree is gone and nothing is orphaned.
6. Change the system clock: identities are unchanged.
7. Performance baseline: host idle CPU and memory per pane, compared with tmux on the Mac.

## Reuse from Orca (MIT, attributed in `THIRD_PARTY_NOTICES`)

| Orca source | Use |
|---|---|
| `src/main/windows-process-tree-kill.ts` | Was the `taskkill /T /F` tree kill behind the agent signaller (A, section 3); ruling 2026-10-16 replaced it with a TerminateProcess walk of the host's process table (`windows/treeKill.ts`, not adapted). `src/main/windows-pty-root-identity.ts` was read for its identity gap (section 3, Identity), not reused |
| `src/main/git-bash.ts`, `src/main/pwsh.ts`, `src/main/providers/windows-powershell-executable.ts`, `src/main/providers/windows-shell-args.ts`, `src/main/providers/windows-shell-fallback-chain.ts` | Shell detection; A needs a PowerShell default, B the rest |
| `src/main/pty/windows-environment-path.ts` and the registry PATH reader/merge | Engine environment (B) |
| Two-role connections, versioned hello, batched output with backpressure, Job per shell (Orca's is not kill-on-close; ours is, see section 3), OSC 7 cwd, bundled `conpty.dll`/OpenConsole | Design ideas only, reimplemented |

Not reused: Orca's terminal daemon (Electron-bound), its patched `node-pty` build and its patched
`@xterm/headless`.

## Decisions made while planning

- **Pane ids are `%<n>`, tmux-shaped.** `RegisteredSession.tmuxPane` is sent to clients
  (`lib/agentFrame.ts`), keys the message inbox and is checked by terminal handoff (`/^%\d+$/`).
  Using the same shape keeps all of them working. The registry projects the primary runtime's pane
  into that field for either backend. Route keys carry the backend and host instance, so equal ids on
  two hosts never collide.
- **Capture is byte-compatible with tmux.** `tui/src/capture.rs` already reproduces
  `capture-pane` over an alacritty grid. It moves into a shared crate, `harness-term`, which both
  `hn` and `harness-pty` use.
- **Keyframes reuse `synthesizeTmuxSnapshot`** (`lib/tmuxStream.ts`). The host returns the capture
  and the pane metadata, and the daemon builds the keyframe exactly as it does for tmux.
- **Spawning into the Job is race-free.** The vendored alacritty ConPTY spawn is patched to create
  the child suspended, assign it to the pane's Job, then resume it.
- **Signal scope.** Only agent-process kills (about 22 call sites) move to `processSignals.ts` in A.
  Daemon and service kills belong to B.
- **Host home.** The host's `--home` is `~/.harness/pty` (`HARNESS_PTY_DIR`), which holds `run/`
  and `logs/`.

## Out of scope for A

The installer, harnessd on Windows, named-pipe trust for the daemon socket, engine launch without
POSIX shells and hook command lines (all B); the desktop app (C); release artifacts (D); the `hn` TUI
on Windows; and serial/USB cables.

## Risks

- **ConPTY behavior differences** (resize reflow, DA1 replies, mouse modes) can change what engines
  draw. Mitigation: bundle `conpty.dll`, and test every engine in the E2E matrix.
- **Engine support for Windows** varies, and some engines may not run natively. Each engine's status
  is recorded during E2E; an engine that cannot run is reported as unavailable on Windows, not
  emulated.
- **The Group 2 refactor touches restart, swap and resume**, the most race-sensitive code. Mitigation:
  a separate behavior-preserving PR first, with the full local gates.

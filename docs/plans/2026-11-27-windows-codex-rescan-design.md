# Windows: a running Codex is found again after a restart (2026-11-27)

## The report

Found during #4634 (Ken's VM, 2026-11-26, Windows 11 ARM64): after the daemon restarts, a Claude Code in VS Code's
integrated terminal is now found again by the open scan, but a Codex there is not. Its row comes back only at its next
hook. On macOS and Linux the open scan finds it at once.

## How the open scan finds a Codex today

1. `OpenSessions.owners()` asks each engine's provider which process holds which session. Codex keeps no process record
   (`engines/codex/adoption.ts`, `owners.open`): the kit's `openFileOwners` (`engines/kit/adoption.ts`) asks
   `view.openFilesOf(['codex', 'Codex'])`, keeps the paths that look like `rollout-…-<uuid>.jsonl`, checks the holder in
   the process table (`engineProcessMatch`) and claims the session for that pid; a Codex server (`servesOthers`: an
   `app-server`, `mcp-server`, `codex-acp`) is an app's claim.
2. `processView` (`lib/sessionSearch/externals/support.ts`) answers `openFilesOf` with `lsof -c codex -c Codex`. **On
   Windows it answers an empty map without spawning** (`const lsof = platform !== 'win32'`), so the provider claims no
   session, the scan lists no Codex, and nothing is logged.
3. Codex 0.167+ adds a second gate (#4637). A `codex` typed in a terminal is a client of Codex's own daemon, which holds
   the rollout. The scan then places the session by its client: `observed.ts` `servedOf` → `codexServed.ts`, "the one
   Codex TUI on a terminal working in the session's folder", using the TUIs' folders (`processCwds`: `lsof -a -d cwd` on
   macOS, `/proc/<pid>/cwd` on Linux) and their ttys (`ps -o tty=`). **On Windows `servedLookup` returns undefined**
   ("no process's folder can be read"), so even with an owner the session would land on no page, or worse, on the app
   of the daemon's parents (below).

`processCwds` is the same: on win32 every folder is unknown.

## Does Windows run the Codex daemon? Yes (Codex source, rust-v0.172.0)

Read from `codex-rs/tui/src/startup_orchestration.rs`, `tui/src/daemon_startup.rs`,
`app-server-daemon/src/backend/{pid.rs,pid_start.rs,windows.rs}`:

- The TUI starts the managed daemon on Windows too (`start_with_features_classified`). It is spawned with
  `CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB`, so it outlives the terminal, with its working
  folder set to `<CODEX_HOME>/…/workdir` ("a Windows process pins its working directory"), never the project.
- Its arguments are the same as on Unix: `app-server [--remote-control] --listen unix:// --analytics-default-enabled
  [-c features.<x>=<bool>…]`. #4637's `daemonArgs` (`app-server` with `--listen unix://`) recognizes it unchanged.
  Since Codex 0.172 there is no `--managed-daemon` word; `--listen unix://` alone carries it.
- The TUI stays embedded (holds the rollout itself, as before 0.167) when: it runs as administrator
  (`ELEVATED_LAUNCH_WARNING`), the launcher forbids breakaway (`DetachedLaunchRestricted`, e.g. `cargo run`),
  `--no-daemon`, `--oss`, `--profile`, `-c` overrides, and the other `exclusion` cases.
- Windows never reparents: the daemon's parent pid stays the first TUI's, which may have exited (a reused pid; the
  `w:<FILETIME>` guard in `parentChain` ends the walk) or may be alive in another terminal. Walking the daemon's parents
  would then name the first TUI's app for every session: the same wrong place #4637 fixed on macOS.

So on Windows both cases occur, and the fix must cover both:

| Case | Rollout holder | Placed by |
|---|---|---|
| Embedded TUI (admin, `--no-daemon`, Codex < 0.167, a restricted launcher) | the TUI `codex.exe` | its parents (`scannedApps` win32, #4634) → `term:<pid>` |
| Daemon (the default on Codex 0.167+) | `codex.exe app-server --listen unix://` | its client TUI by folder (`codexServed`) → `client:<pid>` |

The Codex daemon case from #4637 is therefore **confirmed in the source for Windows**; step 2 of the VM steps confirms it
on a real machine.

## Options for "who holds this rollout" on Windows

1. **Codex's own record.** None exists. The state DB (`state_*.sqlite`, `codex-rs/state/migrations`) has no pid
   column per thread; the daemon's pid file names the daemon only, not its threads. Rejected: it cannot say which
   threads are open.
2. **Restart Manager** (`RmRegisterResources` + `RmGetList`, given file paths). Documented and unprivileged, but it is
   asked per candidate path: the scan would have to guess which rollouts to ask about, and an idle thread's rollout
   (old mtime) held by a TUI open for days would fall outside any bound. Rejected.
3. **Open handles of the Codex processes, read by harness-pty** (chosen). The `lsof -c` equivalent: for each `codex.exe`
   pid in the table, `NtQueryInformationProcess(ProcessHandleInformation)` lists that process's handles (Windows 8+,
   one process at a time, no system-wide handle dump), each is duplicated into harness-pty
   (`DuplicateHandle`, needs `PROCESS_DUP_HANDLE`, granted for the same user's non-elevated processes), and only a
   handle whose `GetFileType` is `FILE_TYPE_DISK` and which is not a directory is named
   (`GetFinalPathNameByHandleW`, `\\?\` stripped). Never `NtQueryObject` for names: that is the call that hangs on a
   synchronous pipe; `GetFileType` does not. The same read gives each pid's **working folder** from its PEB
   (`ProcessBasicInformation` → `RTL_USER_PROCESS_PARAMETERS.CurrentDirectory`, `PROCESS_VM_READ`; what psutil's
   `cwd()` does), which `codexServed` needs for the client. A 32-bit (WOW64) process gets no folder (unknown).
4. **Reading Codex's daemon over its socket** (`thread/loaded/list`). Rejected: Harness would become a client of
   another product's private protocol, and it would not name the TUI.

Rust for option 3 follows the architecture rule (Rust on the terminal's side, `windows-sys` already in `pty/Cargo.toml`;
`Wdk_System_Threading` is there for `NtQueryInformationProcess`).

## The fix

### 1. harness-pty: `harness-pty files --json <pid>…` (Windows only)

A one-shot subcommand, like `harness-pty ps --json`, never an op of the running host: the host that holds every
terminal grows no new read of other processes (the core rule "the most trusted process meets the outside least"
applied to the host too), and nothing in the protocol changes.

- Input: at most 32 pids. Output: `{ "rows": [{ "pid", "startMarker", "cwd"?, "files": [path…] }] }`.
- `startMarker` is the same `w:<FILETIME>` as `ps`; the caller drops a row whose marker differs from the table's
  (a reused pid). A process it may not open (another user's, elevated) is left out: unknown, never "holds nothing".
- Only regular disk files, at most 4096 per pid, each path at most 32 Ki UTF-16 units; past a bound the row is left
  out. Nothing is logged; paths go to stdout only.
- Elsewhere it exits with an error (`unsupported`), as Unix has `lsof`.
- Code: `pty/src/ps.rs` beside the table read (it already opens processes and calls `NtQueryInformationProcess`), or a
  new `pty/src/open_files.rs`; `pty/src/cli.rs` for the subcommand.

### 2. cli: `processView` and `processCwds` read it on win32

`lib/sessionSearch/externals/support.ts`, through a reader in `lib/windows/` beside `processTable.ts` (same binary
lookup, `patientExec`, 3 s timeout, 4 MiB output):

- `openFilesOf(commands)` on win32: from the view's table, the pids whose image stem starts with one of `commands`
  (case-insensitive, as `lsof -c` matches a prefix), at most 32 (more: unknown, an empty map and one
  `externalReadFailed`, so admission holds rather than guesses). None: no spawn. Rows whose `startMarker` differs from
  the table's are dropped.
- `processCwds(pids)` on win32: the same reader's `cwd`. One spawn answers both when the view asks for both in one look
  (memoized per view).
- `openFiles(pids)` stays unknown on win32: no caller needs it there.

From here the existing code does the rest on Windows: `openFileOwners` claims the session (the `open.id` regex and
`contains: 'rollout-'` match a `C:\…\sessions\…\rollout-…-<uuid>.jsonl` path), `readAdoptedHead` takes the
`C:\…` folder since #4634, `turnOpen` reads the rollout from the claim's path.

### 3. cable: `codexServed` on Windows

`cable/hosts/codexServed.ts`:

- `servedLookup('win32')` returns the lookup, with `cwds: processCwds` (now readable) and `apps: learnApps` (win32 since
  #4634).
- A Codex TUI on Windows has a console but no tty. On win32 every TUI candidate counts as "on a terminal" with no tty
  name; the client is `{ app, pid }` (`clientTtyForm('win32')` is already undefined). Still exactly one TUI in the
  session's folder, else none; a folder that could not be read is "nothing told".
- The VS Code client adapter (`cable/hosts/vscode.ts`, `client:<pid>` from `place.outer.pid`) then shows that TUI's
  terminal, view-only, as on macOS. Voice keeps going through `codex queue`.

This also turns on #4637's hook-side placement on Windows (`observed.ts` `askServed`), since it is the same
`ObservedDeps.served`: a daemon's hook on Windows is placed by its client instead of the first TUI's hints, where today
it is placed by those hints (the right page only when the first TUI is in the same app). One lookup, one way, as the
code standards ask; the PM decides (question 1).

### Cost

Only on Windows, only when a `codex.exe` runs: one spawn of `harness-pty files` per open scan (every 60 s while a dial
is attached), plus one per Codex hook caller not yet told (as on macOS). Numbers before and after on the VM: the scan's
`ms` in `[observed] scan · … · <ms> ms`, and `harness-pty files` alone for 1 and 32 pids (target: under 50 ms for one
Codex daemon and one TUI; to be measured, not assumed).

### Security

- Same user, non-elevated processes only; harness-pty asks for `PROCESS_QUERY_INFORMATION | PROCESS_DUP_HANDLE |
  PROCESS_VM_READ` and nothing that writes. Duplicated handles are closed at once; none is used for I/O.
- No path, folder or argument is logged or kept: the claim keeps the rollout path in memory as on macOS, and errors log
  their kind only.
- harness-pty's output is parsed as data, with the bounds above.

## Tests (red first)

TypeScript, at the layer where each behavior lives (all run on macOS through the platform parameter):

1. `lib/sessionSearch/externals/support.spec.ts`: on win32, a `processView` over a fake table (`codex.exe` TUI and daemon,
   `node.exe`, `pwsh.exe`, `w:<FILETIME>` markers) and a fake files reader returns the rollout for the daemon's pid from
   `openFilesOf(['codex', 'Codex'])`, drops a row whose marker differs, does not spawn with no `codex.exe`, and answers
   `processCwds` from the same read. **Red today: an empty map.**
2. `cable/hosts/observed.spec.ts`, the scan on win32 with a real `codexProvider` over a temp Codex home (a fake rollout
   `sessions/2026/11/27/rollout-…-<uuid>.jsonl`, `session_meta` with `cwd: "C:\\work\\dial"`, `source: "vscode"`,
   `originator: "codex-tui"`) and a fake Windows tree `Code.exe → pwsh.exe → node.exe → codex.exe (TUI, cwd
   C:\work\dial)`, `codex.exe app-server --listen unix:// --analytics-default-enabled` (parent: the TUI):
   - daemon holds the rollout → one entry on VS Code's page, `outer.pid` the TUI, pane `client:<tuiPid>`;
   - the TUI holds it itself (embedded) → VS Code's page, pane `term:<tuiPid>`;
   - two TUIs in that folder → on no app's page (never a guess);
   - the daemon's parent is a TUI in Windows Terminal, the client is in VS Code → VS Code's page (the daemon's
     parents are never the place).
   **Red today: 0 found.**
3. `cable/hosts/codexServed.spec.ts`: on win32 a TUI with no tty counts as the client; its folder unread → none.
4. `lib/windows/*.spec.ts`: the reader parses `harness-pty files` output, drops malformed rows and a row past a bound,
   and treats a failed run as unknown (null), never as "nothing open".

Rust (`pty/`, run by `windows.yml` in PR CI):

5. `files` lists a file this test process holds open and its working folder; a file closed before the read is not
   listed; a pipe handle the process holds is skipped and the read returns (no hang); a pid that exited is left out.

Local gates: the specs above; `npm run test:core` only if a gated path is touched (none planned); ask the PM for a Mac
slot before any suite.

## VM steps for Ken (through the PM)

Use a test account, never a real one: a Codex CLI signed in to a test account, or Codex with a stub provider
(`OPENAI_BASE_URL` at a local stub) if no test account is at hand. Run no Harness agent meanwhile.

Before the fix (today's release), to confirm the cause:

1. In VS Code, open an integrated terminal (PowerShell, **not** as administrator) and run `codex` in a project folder.
   Send one prompt and let it finish. Report whether the dial shows it, and on which page.
2. Confirm the daemon: in another PowerShell run
   `Get-CimInstance Win32_Process -Filter "name='codex.exe'" | Select-Object ProcessId,ParentProcessId`, then for each
   pid report only **yes/no**: does its command line contain `app-server` and `--listen unix://`
   (`(Get-CimInstance Win32_Process -Filter "ProcessId=<pid>").CommandLine -match 'app-server.*--listen unix://'`).
   Do not paste command lines. Expected: two `codex.exe`, one of them the daemon.
3. Confirm who holds the rollout: open Resource Monitor (`resmon`) → CPU → Associated Handles, search `rollout-`.
   Report which pid holds it (the daemon's or the TUI's), not the path.
4. Restart the daemon (`harness stop`, then `harness start -f` with the stand-in dial). Do not touch the Codex terminal.
   Wait 70 s. Report what the dial shows (VS Code's page, Other's) and the `[observed] scan · N found · M app known · …`
   line (counts only). Expected before the fix: Codex not listed.

With the fix (the PR's head):

5. Time the read: `harness-pty files --json <daemon pid> <TUI pid>` five times
   (`Measure-Command { … }`), report the milliseconds only.
6. Repeat 1 and 4. Expected: `1 found · 1 app known` within 70 s, the Codex on VS Code's page before any hook.
7. Tap it on the dial: VS Code comes forward and shows that terminal.
8. Open a second `codex` in Windows Terminal in **another** folder, restart again. Expected: the VS Code one stays on VS
   Code's page; the Windows Terminal one is on Other's page (Windows Terminal names no app), neither on the other's page.
9. Embedded case: close both, run `codex --no-daemon` in a VS Code terminal, restart. Expected: VS Code's page.
10. Two `codex` in VS Code terminals in the **same** folder, restart. Expected: listed on no app's page (never a
    guess), and back on VS Code's page at the next hook.

## Size

Full: two components (`pty` Rust and `cli`), a new read of other processes' handles and memory (security), and more
than 150 lines (about 200 Rust with tests aside, about 80 TypeScript). Nothing stored, synced or exposed beyond the
process; no new screen; no new end-to-end check (the VM steps are the PM's).

## Decisions (PM, 2026-11-27)

1. Turning on `codexServed` on Windows also places a daemon's **hooks** by their client instead of the first TUI's hints
   (#4637's behavior on macOS/Linux): yes, in this PR, one lookup for scan and hooks.
2. A one-shot `harness-pty files` subcommand, never an op of the running host (the host grows no new read of other
   processes; no protocol change).

## Not covered

- A Codex inside tmux, herdr or Zellij on Windows (WSL), and `codex -C <dir>` (its folder differs), as on macOS.
- An elevated Codex while Harness is not elevated: its handles cannot be read; it comes back at its next hook.
- Voice into a daemon-run session stays `codex queue`; typing into it stays off (view-only), as on macOS.

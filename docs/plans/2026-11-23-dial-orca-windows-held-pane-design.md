# Dial on Windows: a held Orca or herdr pane is told from the agent's own

Date: 2026-11-23. Item: dial eval hill-climb (Orca d), scenario O6 on `a/win32`. Platforms: Windows (behavior),
macOS and Linux (unchanged, tests run there).

## Problem

An agent started in a terminal another program made, from inside an Orca terminal (VS Code from `code .`, Windows
Terminal from `wt`), keeps that Orca terminal's `ORCA_TERMINAL_HANDLE`. On macOS and Linux the devices read which
process made the agent's terminal (`Place.ptyOwner`, `scannedApp.ts readPtyOwner`) and mark any pane not made by Orca's
terminal host *held*: it only switches, never takes words, and the dial follows that agent by its own hooks rather than
by Orca's focus watch.

Windows reads no maker. `services/devices.ts` passes no `ptyOwner` reader on win32 ("Windows has no `ps`"), and
`cable/hosts/orca.ts paneOf` and `cable/hosts/herdr.ts paneOf` take every handle on win32 as the agent's own pane. So on
Windows:

- words for that agent are typed at the Orca (or herdr) terminal's prompt, which holds a shell or another agent: a
  send to the wrong place;
- the dial follows Orca's focus watch for it, which never names it: a prompt typed there does not move the dial
  (eval O6 `a/win32`: `focus.lands` 0, `focus.latency` 0, while darwin and linux pass).

This was hidden until #4562 let the devices find Orca's CLI on Windows.

## Decision (approach A)

Read the maker on Windows from the process table the observed source already reads, `listProcesses`
(`lib/sessionSearch/externals/support.ts`), which on Windows is the Harness PTY host's table (`processRows` →
`windowsProcessRows`, pty/src/ps.rs). No new process, no Rust change, no new dependency.

Rejected:
- B, asking Orca which terminals its host made: `orca terminal list` names no pid, so it cannot tell a held terminal
  from its own.
- C, a new harness-pty op on the Windows console API (which processes share a console): exact, but a Rust change and a
  new op for one fact the table already gives.

## Design

### 1. The Windows maker (`cable/hosts/scannedApp.ts`)

Windows has no terminal names, but the program that creates a pseudo-console starts the shell in it as its own child
(ConPTY: `CreateProcess` with the pseudo-console attribute). So the maker is the caller's nearest parent that is not a
shell, a launcher or a shim of the caller.

`windowsPtyOwner(pid, rows)`, a pure function of one table:
- walks `parentChain(pid, table)` (bounded by `WALK_PARENTS`; a parent that started after its child ends the walk, by
  the `w:<FILETIME>` start markers, since Windows reuses pids and never reparents);
- skips the caller itself, then every parent that is a shell or launcher (`pwsh`, `powershell`, `cmd`, `bash`, `sh`,
  `node`: an npm shim runs Codex as `cmd` → `node` → `codex.exe`) or bears the caller's own name (a Scoop or Volta
  shim `claude.exe` that starts the real `claude.exe`);
- the first other parent is the maker. Its name is read Windows' way: `win32.basename`, a trailing `.exe` dropped, both
  case-insensitively. It names a host only through a Windows-only table, `WINDOWS_PTY_HOSTS`: `orca` → `orca` (the
  app's image name, which its terminal host runs under: Electron run as Node keeps it), `herdr` → `herdr`,
  `wezterm-gui` and `wezterm-mux-server` → `wezterm`. `PTY_HOSTS`, which macOS and Linux read (`ptyHostOf`,
  `readMadeBy`), is unchanged: on macOS Orca's own binary is named `Orca` and is not its terminal host;
- answers `undefined` when the walk names no host: another program made the terminal, the caller is not in the table
  (it has exited), or only shells were found. As on macOS, the read landed and named no host, so the pane is held.

The name is matched and dropped, never kept or logged.

### 2. Start markers kept (`lib/sessionSearch/externals/support.ts`)

`listProcesses` maps each row to a `RunningProcess` and drops the Windows `w:<FILETIME>` start marker (it parses only
`ps` lstart). It keeps it as an optional `startMarker` when it has the `w:` form, so `parentChain` can end a walk at a
reused pid. Other platforms' rows are unchanged. The field is declared in `support.ts` alone (`listProcesses` returns
`RunningProcess & { startMarker?: string }`): `externals/types.ts` is on the core's file list and is not changed.

`listProcesses` is the table read because it is the observed source's own read and the one the dial eval's tier A feeds
from its model (`dialAppEval.spec.ts` mocks `support.js`); `readProcessParents` (`vscodeTerminals.ts`) and
`processRows` are not fed there with names.

### 3. The reader wired (`services/devices.ts`)

On win32 the observed source's `ptyOwner` is `(pid) => readWindowsPtyOwner(pid, listProcesses)`. `readWindowsPtyOwner`
(`scannedApp.ts`, beside `windowsPtyOwner`) reads the table it is given and, on an empty table, throws
(`process table not read`): `listProcesses` answers `[]`, never a throw, for a table it could not read, and an empty
table is a failed read, as `readProcessNames` says. Otherwise it answers `windowsPtyOwner(pid, rows)`. As on macOS and
Linux it runs once per caller process, in the background, only for a caller whose hints name a pane that asks
(`PTY_HINTS`); `processRows` shares a read in flight. A failed read is logged by the existing
`[observed] pty · not read · <kind>` line and read again no sooner than `TTY_RETRY_MS`; until then the pane stays held.

### 4. The adapters (`cable/hosts/orca.ts`, `cable/hosts/herdr.ts`)

Both drop their win32 exception: a handle (pane id) is the agent's own only when `ptyOwner` names that host. Until the
read lands the pane is held and takes no words, as on macOS and Linux (`ObservedSource.holds`). A read that landed and
named no such host logs the existing once-per-caller `[device] orca · held` (or `[device] herdr · held`) line.

WezTerm needs no change in `wezterm.ts`: on Windows its panes were always held (no maker read); now a pane
`wezterm-gui.exe` made takes words, as on macOS and Linux.

### 5. Words that say why

The comments that say Windows reads no maker go: `observed.ts` (the `ptyOwner` dep), `devices.ts` (the win32
argument), `orca.ts` and `herdr.ts` (`paneOf`). The eval's own note in `tierA/steps/sessions.ts` stays (eval files are not edited). `cli/AGENTS.md`'s
devices row says Orca and herdr on Windows are held as elsewhere, the maker read on Windows from the PTY host's table
past shells and launchers.

## Failure and limits

- The table read is the observed source's existing one, bounded by its timeout and output limit; one read per new
  caller process, shared with any read in flight. No polling.
- A wrong guess of Orca's host name on real Windows would hold every Orca pane there (no words, until fixed). So would
  an Orca the daemon cannot open (an elevated Orca under an unelevated daemon: the PTY host drops rows with no start
  marker, which cuts the walk). The `[device] orca · held` line shows either. A check on a real Windows machine runs
  before merge (below).
- Not covered, as before this change: a console window opened from an Orca shell with `start` (a classic console or a
  Windows Terminal handoff) keeps the Orca shell as its parent, so the walk names Orca; and a Node program that makes
  terminals inside an Orca terminal (`code serve-web`) is skipped as a launcher. Both were Orca's own before; this
  change does not make them worse.

## Testing

Red first, at the layer of each behavior:
- `scannedApp.spec.ts`: `windowsPtyOwner` names `orca` for agent → `pwsh.exe` → `Orca.exe`, through `cmd.exe` and
  `node.exe`, and past a shim of the caller's name; `herdr` and `wezterm` for theirs; none for agent → `pwsh.exe` →
  `Code.exe`; none when a parent started after its child (reused pid); none for a caller not in the table;
  case-insensitive names (`ORCA.EXE`); macOS's `PTY_HOSTS` reads unchanged (`Orca` names no host there).
- `scannedApp.spec.ts`: `readWindowsPtyOwner` throws on an empty table and answers `windowsPtyOwner` otherwise.
- `support.spec.ts`: `listProcesses` keeps a `w:` start marker and adds none on other rows.
- `orca.spec.ts`, `herdr.spec.ts`: on win32 a place with another host, or none read yet, is held; one with that host is
  the agent's own pane.
- Dial eval tier A: `a/win32/O6` `focus.lands` and `focus.latency` turn green; tier B reruns; no app drops;
  wrong-session sends stay 0; `baseline.json` updated in the same PR.

Windows check (Ken's side), in the PR body, on the Windows VM: with Harness Device and Orca installed, start Claude Code
in an Orca terminal and, from another Orca terminal, `code .` and Claude Code in VS Code's terminal. Record each agent's
parent chain (`Get-CimInstance Win32_Process` walking `ParentProcessId`, names only) and check: the Orca one reaches
`Orca.exe` past only shells; voice to it lands; the VS Code one reaches `Code.exe` and voice never types into the Orca
terminal. Also check that the daemon and Orca run at the same elevation (neither as administrator). The same for herdr
and for WezTerm if the VM has them, else the PR says each was not checked. The merge waits for this result.

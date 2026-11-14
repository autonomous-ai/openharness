# installPs1.spec.ts: one Windows PowerShell for the library cases

## Why

The Windows workflow's arm64 job runs 44.8 of its 60 minutes (#4297, run 43576955663). Its step "Two real builds:
the pty host rollover and the payload install" takes 21.9-23.6 min on `windows-11-arm` and 1.3-2.1 min on
`windows-latest` (runs 2026-11-02..14); about 1390 s of it is `cli/src/scripts/installPs1.spec.ts`.

## What the time is (measured)

Two probe runs on both runners (43581413308, 43582091190; a throwaway workflow on a branch since deleted):

| One `powershell.exe` (5.1) that ... | windows-11-arm | windows-latest |
|---|---|---|
| runs no module command (`1`) | 0.24-0.38 s | 0.16 s |
| runs one command module autoload must find (`Join-Path`, `Get-FileHash`, `Get-ItemProperty`, or dot-sources install.ps1 and calls `Get-HarnessPlatform`) | 22-29 s | 0.25-0.8 s |
| the same, with PSModulePath removed, clean (user, Program Files, System32), System32 only, or the machine value | 22.1-22.5 s each | 0.2-0.8 s |
| the same, with a fresh module analysis cache, three runs | 23.5, 21.9, 22.0 s | |
| imports Microsoft.PowerShell.Management by its full path, then `Join-Path` | 0.2 s import, 27 ms Join-Path | |
| opens four fresh runspaces in turn, each dot-sourcing install.ps1 and calling `Get-HarnessPlatform`, `Join-Path`, `Get-FileHash` | 21.9 s, then 0.164, 0.163, 0.171 s | 0.28 s, then 0.11 s |

So on the arm64 runner the cost is module autoload's command discovery, about 22 s, paid once per process: not the
process start, not PSModulePath, not the analysis cache. Each case's time in run 43576955663 is a multiple of it
(a call that uses no module command, such as `Add-HarnessUserPath` or `Restart-HarnessDaemon` with nothing to do,
took 0.2-0.45 s).

## Goal

Pay that cost once per spec file instead of once per PowerShell call, so the step drops from about 23 min to about
7 on arm64, and the arm64 job from 44.8 to about 29 min. Measure the step before and after on both runners.

## Ken's decisions

- Cut the number of PowerShell starts: several cases in one PowerShell session, or one prepared session.
- No case is weakened: each still tests the same thing, in a clean state.
- The `as written` case "checks the terminal host's signatures before it moves the host into place" keeps failing
  if `Install-HarnessPty` stops calling `Assert-HarnessPtySigned`.
- Measure the step before and after on both runners; the orchestrator gives the go before every `windows.yml` run.

## Non-goals

- No change to `cli/scripts/install.ps1`. Importing modules by full path would save the 22 s for real users too, but
  it would also stop the PowerShell 7 PSModulePath cases from testing autoload; it is a separate proposal (final
  report), not this branch.
- No change to what any case asserts, and no case removed, merged or skipped.
- No runner image or workflow environment change to hide the cost.

## Approaches

- **A. One PowerShell process per spec file, a fresh runspace per call (chosen).** A long-lived `powershell.exe`
  runs each library call in a new runspace, so no function, variable or imported module of one call reaches the
  next, and each call's environment is set on the process before its runspace opens. The 22 s is paid once; each
  later call costs about 0.17 s. The cases that test a PowerShell process itself stay real processes.
- **B. One shared session per describe, install.ps1 dot-sourced once.** Fewer moving parts, but modules loaded by
  one case stay loaded for the next, so the PowerShell 7 PSModulePath cases would no longer test autoload. Rejected.
- **C. Several cases' scripts in one `powershell.exe` call.** Not a clean state, and one failure hides the rest.
  Rejected.
- Fixing the cost in the environment (PSModulePath) was measured and does not help (table above).

## Design

### The session: `cli/src/testing/windowsPowerShell.ts`

A test helper (the folder of `isolatedTmux.ts`), for Windows only:

- **One process.** `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <host loop>`,
  started on the first call and kept for the file; closed in the spec's `afterAll`. Its cwd is this process's cwd
  (as `spawnSync` children had).
- **A channel no child can take.** Requests and responses go over a named pipe Node serves
  (`\\.\pipe\harness-ps-<uuid>`), one JSON line each way, UTF-8. Not stdin or stdout: a native command a case runs
  inherits the host's standard handles (a `Start-Process -NoNewWindow` child writes straight to them), so either
  would mix case output into the protocol. The host's stdin is `ignore`; its stdout and stderr are kept only to
  name what went wrong when the host itself fails.
- **A fresh runspace per call.** `InitialSessionState.CreateDefault2()` (what `powershell.exe` uses: core only,
  everything else by autoload), execution policy Bypass, the language mode and apartment state `powershell.exe`
  runs with, opened for the call and disposed after it.
- **The call's environment is the process's.** Before the runspace opens, the host replaces its whole environment
  with the one the call sends (`powershellEnv(...)` and `HARNESS_INSTALL_LIBRARY` as now): every variable not in it
  removed, every one in it set. PSModulePath included, so 5.1 builds it at runspace open as a new process does
  (`default` removes it, `powershell7` puts the stand-in modules first), and autoload then reads it.
- **Output as the process gave it.** stdout: output objects formatted as `Out-String -Stream` formats them, with
  Write-Host lines (the information stream) and warnings (`WARNING: ...`) in the order they were written. stderr: the
  error records' text. status: 1 when the script ended on an error it did not catch, else 0, which is what
  `-EncodedCommand` reports for these scripts (each starts with `$ErrorActionPreference = 'Stop'`). The result keeps
  the shape `{ status, stdout, stderr }`, trimmed as `ps()` trims it now.
- **One call at a time, bounded.** Calls queue in order. Each has a timeout (120 s by default, as now); on a
  timeout, or if the host exits, that call fails with a message naming the timeout or the exit and the host's last
  stderr, the host's process tree is ended, and the next call starts a new host. Closing ends the pipe, waits briefly
  for the host to exit, and ends its tree if it has not.

What a fresh runspace does not reset, and why it does not matter here: loaded .NET assemblies and types (process
wide; `Send-HarnessEnvironmentChange` already guards its `Add-Type` with `-as [type]`), and `$PID` (one value for
the file; `Write-HarnessPointer`'s temporary name only needs it unique per process at a time).

### What goes through the session

- `ps()` and `thrown()`, all three module-path modes: every case of `install.ps1 building blocks, in Windows
  PowerShell 5.1` and of `install.ps1, run again over a live install` but the handle-holding one. They become
  `async` and `await` the call; their assertions do not change.
- The helpers of `install.ps1, installing for real from a local manifest`: `platform()` (asked once for the file,
  the native platform does not change during a run), `ticks()` and `userPathValue()`.
- The handle-holding case's clean-up script (ending the `holder-of-handles` processes; the session's own `$PID` is
  excluded as the script already does).

### What stays a real `powershell.exe`, and why

- Every `install()` (`-File install.ps1 -Manifest ...`): the exit code of `-File`, the script run as a file.
- The two `irm | iex` cases: the session they were iex-ed into keeps running; the Restricted execution policy.
- The commands that run the installed `harness` from PowerShell and from a Restricted PowerShell, and the
  argument-quoting lines (`said`): what a person's PowerShell does with the process exit code and arguments. They use
  no module command, so they cost about 0.3 s each.
- `goes on once harness start has started the daemon`: it is about which handles a process inherits.

### Tests of the session (red first): `cli/src/testing/windowsPowerShell.spec.ts`

Windows only (`describe.runIf(win32)`), against the real `powershell.exe`:

- A function and a variable defined in one call, and a module imported in one call, are gone in the next.
- An environment variable sent with one call is absent in the next; PSModulePath sent as a folder holding a stand-in
  module makes autoload load that module, and the next call without it does not see it.
- Write-Host lines and output come back in the order written; an uncaught error gives status 1 and its message on
  stderr; a caught one gives status 0.
- A child started with `Start-Process -NoNewWindow` that writes to its standard output does not break the next call.
- A call over its timeout fails naming the timeout, and the next call succeeds on a new host.
- Every call of one file runs in one process (`$PID` is the same), which is the speed this change is for.

### Workflow

- "Two real builds" adds `src/testing/windowsPowerShell.spec.ts` to its `$paths`, beside installPs1.spec.ts, so the
  session's own tests run on both runners (PR CI runs no Windows). It costs one more 22 s on arm64.
- Its comment on the job's limits ("about 8 s a start") is rewritten with the measured cause and the new numbers.
- The limits stay as they are (arm64 60, x64 40) in this branch (orchestrator's call): a smaller arm64 limit is a
  separate change once several runs show the new time.

## Verification

- Task-level red and green of the Windows-only tests: this Mac has no Windows PowerShell and no Windows machine is
  free (orchestrator, 2026-11-14), so implementers typecheck and run the platform-independent tests locally, and the
  red and green runs of the Windows-only tests come from the temporary workflow below on real runners: the branch is
  pushed at the red commit, then at the green one (each push on the orchestrator's go).
- `as written` (any platform, local): with `Assert-HarnessPtySigned $unpacked` removed from `Install-HarnessPty`,
  the signature case fails; restored, it passes. That case is not touched by this change.
- Mutations on Windows, arm64 and x64, through the session, in a temporary workflow
  (`tmp-installps1-fewer-shells.yml`, push to this branch only, no build, removed before the merge): the session's
  spec and the two library describes, unmutated (pass), then with `Get-HarnessSha256` using `Get-FileHash` (the
  download case fails under `powershell7`), then with the `Import-Module` of Security by full path removed from
  `Get-HarnessPtySignatureProblems` (the signature case fails). The mutations are made in the run's own checkout.
  These show the PowerShell 7 cases still test autoload in a runspace.
- `windows.yml` on the branch, once (on the orchestrator's go): every job green; "Two real builds" time and the
  installPs1.spec.ts per-case times on both runners, against run 43576955663 (arm64 23.6 min, x64 within 1.3-2.1).

## Left to the builder

The host loop's exact PowerShell, the pipe framing, how stray host output is reported, and the order of the work.

# installPs1.spec.ts, one Windows PowerShell for the library cases: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Tasks 2 and 4 are test-first (a red commit, the
> test alone, then the code commit); Tasks 1, 3 and 5 are one commit each. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** `cli/src/scripts/installPs1.spec.ts` pays Windows PowerShell 5.1's first-autoload cost (about 22 s on
`windows-11-arm`) once per spec file instead of once per library call, with every case and every assertion as it is,
and the step is measured before and after on both runners.

**Architecture:** A test helper, `cli/src/testing/windowsPowerShell.ts`, keeps one `powershell.exe` per spec file and
runs each call in a fresh runspace, after replacing the process environment with the call's; requests and results
cross a named pipe Node serves. `installPs1.spec.ts` sends its library calls through it and keeps a real process
where the case is about the process. `windows.yml` runs the helper's own spec in the same step.

**Tech Stack:** TypeScript, Vitest 4.1.10, Node 24.22.2 on the runners, Windows PowerShell 5.1, GitHub Actions,
actionlint 1.7.12. No new dependency.

**Spec:** [docs/plans/2026-11-14-installps1-fewer-shells-design.md](2026-11-14-installps1-fewer-shells-design.md).
Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Decisions on the draft's questions (orchestrator, 2026-11-14)

1. **The limits comment.** Task 4 writes the cause and the numbers measured so far (runs 43565271777, 43576955663,
   43581413308, 43582091190) and states no after-time; the after-times go in the pull request, so the measured head is
   the merged head.
2. **A test for the workflow line.** Kept: Task 4's one assertion in `windowsWorkflows.spec.ts` (the step's `$paths`
   holds the session's spec) is its test that fails first.
3. **`exit N` and a native command's standard error under `$ErrorActionPreference = 'Stop'`.** The helper's header
   names both as not covered, and no test pins them (no call through the session depends on either today: the fake
   `harness` writes to standard error only for `auth`, read with `2>$null`; the clean-up's `taskkill` runs without
   Stop; `exit` is outside library mode). Optional, if cheap: the helper refuses a script with an `exit` statement
   with a clear error instead of running it differently.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 Temporary workflow | `.github/workflows/tmp-installps1-fewer-shells.yml` (new) | none | medium | none: a temporary workflow, one commit |
| 2 The session | `cli/src/testing/windowsPowerShell.ts` (new), `cli/src/testing/windowsPowerShell.spec.ts` (new) | 1 | xhigh | the new spec |
| 3 installPs1.spec.ts through the session | `cli/src/scripts/installPs1.spec.ts` | 2 | high | none: no behavior and no assertion changes, one commit |
| 4 windows.yml runs the session's spec | `.github/workflows/windows.yml`, `cli/src/scripts/windowsWorkflows.spec.ts` | none | medium | one new assertion in `windowsWorkflows.spec.ts` |
| 5 Remove the temporary workflow | `.github/workflows/tmp-installps1-fewer-shells.yml` (deleted) | 1, 2, 3, 4, and Verification 2 and 3 | medium | none: one commit |

Longest chain: 1, 2, 3, 5. Task 4 shares no file with another task and can run beside any of them.

## Global Constraints

- **Unchanged:** `cli/scripts/install.ps1`; every assertion of `installPs1.spec.ts`; no case removed, merged or
  skipped (Task 3, Step 4 checks it by program). The `as written` describe is not touched.
- **Through the session:** `ps()` and `thrown()` in all three module-path modes; `platform()` (asked once for the
  file), `ticks()` and `userPathValue()`; the handle-holding case's clean-up script.
- **Still a real `powershell.exe`:** every `install()`; the two `irm | iex` cases; the commands that run the installed
  `harness` from PowerShell and from a Restricted PowerShell; the `said` lines; the main call of
  ``goes on once `harness start` has started the daemon``. That is 8 `spawnSync('powershell.exe'` in the file, from 12.
- **The session, from the spec:** `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand
  <host loop>`, stdin `ignore`, this process's cwd; the pipe `\\.\pipe\harness-ps-<uuid>`, one JSON line each way,
  UTF-8; per call a runspace from `InitialSessionState.CreateDefault2()`, execution policy Bypass, the process
  environment replaced wholesale before the runspace opens (PSModulePath included); the result
  `{ status, stdout, stderr }`; a timeout of 120 s by default.
- **Each call's environment as now:** `ps()` sends `powershellEnv(modulePath, { HARNESS_INSTALL_LIBRARY: '1', ...env })`.
  `ticks()`, `userPathValue()` and the clean-up name none and get this process's own, as their `spawnSync` had.
- **windows.yml:** the limits stay (arm64 60, x64 40). No runner image or environment change.
- **No Windows here.** Implementers typecheck and run the platform-independent tests; the Windows-only red and green
  come from Task 1's workflow. The main session pushes, each push on the orchestrator's go; an implementer commits
  and reports the SHA. One `windows.yml` run, in Verification, on the orchestrator's go.
- **Platforms:** test code for Windows x64 and arm64. The helper and both specs load on Linux and macOS (PR CI's
  `cli-tests`), where a session never starts a host. No `detached: true` ([Windows rules](../windows-rules.md)).
- A task runs its own specs and `npx tsc --noEmit`, no full local suite. A commit adds its files by name: the two
  documents under `docs/plans/` are untracked here and are no task's. A fresh worktree has no `cli/node_modules`:
  `cd cli && npm ci --no-audit --no-fund`.

## Pushes and runs

Task 1's workflow runs on every push to the branch, and a push while a run is going cancels that run: let a run end
before the next push. A commit goes up by its SHA (`git push origin <sha>:refs/heads/fix/installps1-fewer-shells`), so
a red commit can be pushed alone after the green one exists.

| Push at | Both `library (…)` jobs show |
|---|---|
| Task 2's red commit | red at `The session's own spec`: `Cannot find module './windowsPowerShell.js'` |
| Task 2's green commit | that step green, `Tests  13 passed (13)`. The later steps then run the file as it is before Task 3: the two library describes in real processes (16 min on arm64) and both mutations green. It is the control for Task 3's run; the main session may cancel after the first step if it wants only the green. |
| Task 3's commit | all four steps green; the two library describes against their 977.5 s (arm64) and 38.8 s (x64) of case time in run 43576955663 |
| the final head | Verification 2 |

Task 1's commit pushed alone is red with `No test files found`: there is nothing to learn from it. At Task 2's red
commit `tsc` fails on the missing module, as it must.

## Found while reading the code

Checked at `9cf46e8f93`; rehearsed on this Mac on 2026-11-14 and put back.

- **Baseline.** `cd cli && npx vitest run src/scripts/installPs1.spec.ts src/scripts/windowsWorkflows.spec.ts`:
  `Tests  26 passed | 31 skipped (57)`. `npx tsc --noEmit`: clean, 24 s.
- **`windowsWorkflows.spec.ts` pins neither the `$paths` line nor the limits comment.** It holds
  `src/scripts/installPs1.spec.ts` (line 15) and three other specs (27) by `toContain`, and the limits, the
  `timeout-minutes` line and the job's name (33-40). Its own comment on the limits (30-32) is dated history and
  stays. `windowsCiChecks.spec.ts` reads `windows.yml` too and stays green with Task 4's change.
- **Nothing reads the temporary workflow.** No spec lists the workflows folder, and PR CI's actionlint names its
  files one by one (`ci.yml:98-102`): lint this one by hand. A push to this branch starts no other workflow (the
  other `push` triggers are `main`, `internal/**` and tags).
- **The call sites in `installPs1.spec.ts`:** 45 `ps(` and 12 `thrown(` in the cases, `platform()` 7 times,
  `kept.map(ticks)` twice, `userPathValue` twice; 220 describe, case and assertion lines, every assertion on one line.
- **What Task 1's mutation steps read.** Vitest's JSON reporter gives each case's `title`, `status` and
  `failureMessages`: the stack names the spec's own line (`installPs1.spec.ts:96:12`), and a custom assertion message
  (a call's stderr) leads the message. A name filter with a `|` arrives whole when vitest is started as
  `node node_modules/vitest/vitest.mjs`, and `-t` matches describe names. `install.ps1` has LF on the runners too
  (`*.ps1 text eol=lf`, `.gitattributes`).
- **A tree stop exists:** `stopTree(pid)`, `cli/src/lib/gitProject.ts:506` (`taskkill /pid <pid> /T /F` on Windows).
- **The baseline, run 43576955663**, from the job logs:

  | | arm64 (`windows-11-arm`) | x64 (`windows-latest`) |
  |---|---|---|
  | `windows-pty` job | 44.8 min | 16.8 min |
  | step `Two real builds: …` | 23.6 min | 2.1 min |
  | `install.ps1 building blocks, in Windows PowerShell 5.1` | 543.5 s | 29.1 s |
  | `install.ps1, installing for real from a local manifest` | 414.1 s | 64.2 s |
  | `install.ps1, run again over a live install` | 434.0 s | 9.7 s |

- **Rehearsed:** Task 2's spec against a throwaway helper (`tsc` clean, `1 passed | 12 skipped (13)`; with no helper,
  `Cannot find module`); Task 4's red and green; Task 1's file through actionlint, and its two mutations applied to a
  copy of `install.ps1` (each text found once); Verification 1's mutation. **Not run: any PowerShell.** Every
  PowerShell line in Tasks 1 and 2 was written without a Windows PowerShell to run it.

## Review Focus

Conditions the spec implies and its test list does not name, each pinned by a case of Task 2's spec:

1. **A line longer than a console is wide** (paths under the run's temporary folder are). Expected: whole, not
   wrapped or cut. `returns output, Write-Host lines and warnings in the order written, each line whole`.
2. **Text outside ASCII, and an answer larger than a pipe's buffer.** `ticks()` sends the profile path `Jö 日 & co`
   in its script. Expected: both arrive as sent. `carries text outside ASCII both ways, and an answer larger than a
   pipe holds`.
3. **The host dies under a call**, not only a timeout. Expected: that call fails naming the exit, the next one gets a
   new host. `fails a call whose host exits under it…`.
4. **Nothing left running, and nothing started where no call ran.** `installPs1.spec.ts` closes its session on Linux
   and macOS too. `leaves no powershell.exe behind when it closes`, `closes a session that never ran a call`.
5. **A computer that refuses script files.** A person's Windows has the Restricted policy by default and a runner's
   image may set another, so the library cases alone may not show a host that lost Bypass. `runs a call as
   powershell.exe -ExecutionPolicy Bypass does…`.

Two properties the spec states and lists no test for are pinned as well: calls made together run one at a time, in
order (`runs every call in one powershell.exe…`), and 5.1's own modules are back after a call that had a stand-in
(`has autoload read the PSModulePath its call sent…`). Not pinned: decision 3.

---

### Task 1: The temporary workflow

**Depends on:** nothing. **Effort:** medium (one file, its content below).

**Files:**
- Create: `.github/workflows/tmp-installps1-fewer-shells.yml`

**The test that fails before the change:** none. A temporary workflow changes no behavior: one commit. A fault in
this file that a later push shows is fixed in a commit of its own.

- [ ] **Step 1: Create the workflow** with exactly this content

```yaml
name: tmp installps1-fewer-shells

# TEMPORARY: removed before the merge (docs/plans/2026-11-14-installps1-fewer-shells-plan.md, Task 5).
# The red and the green of this branch's Windows-only tests on both runners, at every push to it: PR CI runs no
# Windows, and windows.yml builds the host first. No build, no secret, nothing published or written outside the run.
on:
  push:
    branches: [fix/installps1-fewer-shells]

permissions:
  contents: read

concurrency:
  group: tmp-installps1-fewer-shells
  cancel-in-progress: true

jobs:
  library:
    name: library (${{ matrix.runner }})
    strategy:
      fail-fast: false
      matrix:
        runner: [windows-11-arm, windows-latest]
    runs-on: ${{ matrix.runner }}
    # With room: before the session, the two library describes took 16 minutes on windows-11-arm (run 43576955663).
    timeout-minutes: 45
    defaults:
      run:
        shell: pwsh
        working-directory: cli
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          # The same pin as windows.yml.
          node-version: 24.22.2
          cache: npm
          cache-dependency-path: cli/package-lock.json
      - name: CLI install
        run: npm ci
      # vitest by its file, not npx: the name filter below has a `|`, which must not pass through cmd.
      - name: The session's own spec
        run: node node_modules/vitest/vitest.mjs run src/testing/windowsPowerShell.spec.ts --maxWorkers=1 --reporter=verbose
      # Not `installing for real`: it runs the real harness.exe, which windows.yml builds.
      - name: installPs1.spec.ts, its two library describes
        run: |
          node node_modules/vitest/vitest.mjs run src/scripts/installPs1.spec.ts -t "building blocks, in Windows PowerShell 5\.1|run again over a live install" --maxWorkers=1 --reporter=verbose
      # Each mutation is made in this run's checkout and put back. Its step is green only when its case, and no other,
      # fails for the mutation's reason: that shows the `powershell7` cases still test autoload.
      - name: 'Mutation 1: Get-HarnessSha256 calls Get-FileHash, and the download case fails under PowerShell 7''s modules'
        env:
          OLD: 'function Get-HarnessSha256([string]$Path) {'
          NEW: "function Get-HarnessSha256([string]$Path) {\n  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()"
          CASE: keeps a download only when its size and SHA-256
          # The line the case fails on: its first check, under 5.1's own modules, still passes.
          EVIDENCE: "'powershell7'"
        run: |
          $ps1 = (Resolve-Path 'scripts/install.ps1').Path
          $text = [IO.File]::ReadAllText($ps1)
          if (-not $text.Contains($env:OLD)) { throw "install.ps1 no longer has the text this mutation replaces: $env:OLD" }
          [IO.File]::WriteAllText($ps1, $text.Replace($env:OLD, $env:NEW))
          $report = Join-Path $env:RUNNER_TEMP 'mutation.json'
          try { node node_modules/vitest/vitest.mjs run src/scripts/installPs1.spec.ts -t $env:CASE --maxWorkers=1 --reporter=verbose --reporter=json "--outputFile.json=$report" }
          finally { git checkout -- scripts/install.ps1 }
          $failed = @((Get-Content -Raw -LiteralPath $report | ConvertFrom-Json).testResults.assertionResults | Where-Object { $_.status -eq 'failed' })
          if ($failed.Count -ne 1 -or -not $failed[0].title.StartsWith($env:CASE)) { throw "Only '$env:CASE' must fail. Failed: $($failed.title -join '; ')" }
          $said = $failed[0].failureMessages -join "`n"
          $at = if ($said -match 'installPs1\.spec\.ts:(\d+):\d+') { (Get-Content -LiteralPath src/scripts/installPs1.spec.ts)[[int]$Matches[1] - 1] } else { '' }
          if (-not "$said`n$at".Contains($env:EVIDENCE)) { throw "The case failed, but not for this mutation's reason: no $env:EVIDENCE in its failure or on the line it failed at." }
          Write-Host "ok: '$($failed[0].title)' failed, at: $($at.Trim())"
          exit 0
      - name: 'Mutation 2: Get-HarnessPtySignatureProblems does not import Security by its path, and the signature case fails'
        env:
          OLD: 'Import-Module -Name (Join-Path $PSHOME ''Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'') -ErrorAction Stop'
          NEW: '# mutation: this PowerShell''s own Security module is not imported'
          CASE: names each terminal host file that is unsigned or signed by someone else
          # In the case's failure message, which carries the call's stderr.
          EVIDENCE: Get-AuthenticodeSignature
        run: |
          $ps1 = (Resolve-Path 'scripts/install.ps1').Path
          $text = [IO.File]::ReadAllText($ps1)
          if (-not $text.Contains($env:OLD)) { throw "install.ps1 no longer has the text this mutation replaces: $env:OLD" }
          [IO.File]::WriteAllText($ps1, $text.Replace($env:OLD, $env:NEW))
          $report = Join-Path $env:RUNNER_TEMP 'mutation.json'
          try { node node_modules/vitest/vitest.mjs run src/scripts/installPs1.spec.ts -t $env:CASE --maxWorkers=1 --reporter=verbose --reporter=json "--outputFile.json=$report" }
          finally { git checkout -- scripts/install.ps1 }
          $failed = @((Get-Content -Raw -LiteralPath $report | ConvertFrom-Json).testResults.assertionResults | Where-Object { $_.status -eq 'failed' })
          if ($failed.Count -ne 1 -or -not $failed[0].title.StartsWith($env:CASE)) { throw "Only '$env:CASE' must fail. Failed: $($failed.title -join '; ')" }
          $said = $failed[0].failureMessages -join "`n"
          $at = if ($said -match 'installPs1\.spec\.ts:(\d+):\d+') { (Get-Content -LiteralPath src/scripts/installPs1.spec.ts)[[int]$Matches[1] - 1] } else { '' }
          if (-not "$said`n$at".Contains($env:EVIDENCE)) { throw "The case failed, but not for this mutation's reason: no $env:EVIDENCE in its failure or on the line it failed at." }
          Write-Host "ok: '$($failed[0].title)' failed, at: $($at.Trim())"
          exit 0
```

- [ ] **Step 2: Lint it**

Run: `actionlint .github/workflows/tmp-installps1-fewer-shells.yml`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/tmp-installps1-fewer-shells.yml
git commit -m "Temporary workflow: the Windows-only tests of installps1-fewer-shells on both runners"
```

---

### Task 2: The session, one `powershell.exe` and a fresh runspace per call

**Depends on:** Task 1 (its red and its green are seen only in that workflow). **Effort:** xhigh (a process, a
pipe, a queue, timeouts; no Windows to run it on).

**Files:**
- Create: `cli/src/testing/windowsPowerShell.ts`
- Test: `cli/src/testing/windowsPowerShell.spec.ts` (new)

**The test that fails before the change:** the whole new spec, 13 cases, 12 of them Windows only.

**Interfaces, produces:**

```ts
/** What one call gave, as `powershell.exe -EncodedCommand` would have. */
export interface PowerShellRun { status: number; stdout: string; stderr: string }
export interface WindowsPowerShell {
  run(script: string, call?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<PowerShellRun>
  close(): Promise<void>
}
export function windowsPowerShell(): WindowsPowerShell
```

- `env` is the call's whole environment; left out, it is `process.env` as it is at the call. `timeoutMs` is
  `120_000` when left out.
- `stdout`: output objects as `Out-String -Stream` formats them, Write-Host lines and warnings (`WARNING: …`), in
  the order written, joined with CRLF, trimmed at both ends. `stderr`: the error records' text, `''` when there is
  none. `status`: 1 when the script ended on an error it did not catch, else 0.
- `run` rejects with an `Error` whose message holds `timed out after <timeoutMs> ms`, or `host exited with code
  <code>`, then the host's last stderr when it wrote any. It rejects only once that host's process has exited, and
  the next call starts a new host.
- `close` ends the pipe, waits up to 5 s for the host, ends its tree if it is still there, and resolves once it
  has exited (inside Vitest's 10 s for a hook). With no host ever started it only resolves, on any platform.

- [ ] **Step 1: Write the failing test**, `cli/src/testing/windowsPowerShell.spec.ts`

```ts
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { windowsPowerShell } from './windowsPowerShell.js'

const session = windowsPowerShell()
const scratch = mkdtempSync(join(tmpdir(), 'harness-ps-session-'))
afterAll(async () => {
  await session.close()
  rmSync(scratch, { recursive: true, force: true })
})

// On any platform: installPs1.spec.ts closes its session in an afterAll that also runs where no case started one.
it('closes a session that never ran a call', async () => {
  await expect(windowsPowerShell().close()).resolves.toBeUndefined()
})

// With room: the first module command a host runs costs about 22 s on windows-11-arm. The three cases that start a host
// of their own come last and run no module command on it, so the file pays that once.
describe.runIf(process.platform === 'win32')('one Windows PowerShell 5.1 for a spec file', { timeout: 120_000 }, () => {
  it('runs every call in one powershell.exe, one at a time, in the order asked', async () => {
    const order = join(scratch, 'order.txt')
    const runs = await Promise.all(['a', 'b', 'c'].map((name) => session.run(`[IO.File]::AppendAllText('${order}', '${name}'); $PID`)))
    expect(Number(runs[0].stdout)).toBeGreaterThan(0)
    expect(new Set(runs.map((run) => run.stdout)).size).toBe(1)
    expect(readFileSync(order, 'utf8')).toBe('abc')
  })

  it('gives each call a runspace of its own: no function, variable or imported module of the call before', async () => {
    const security = String.raw`Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')`
    const seen = '"$([bool](Get-Command Get-HarnessLeft -ErrorAction SilentlyContinue))|$global:HarnessLeft|$(@(Get-Module Microsoft.PowerShell.Security).Count)"'
    expect((await session.run(`function Get-HarnessLeft { 'left' }; $global:HarnessLeft = 'left'; ${security}; ${seen}`)).stdout).toBe('True|left|1')
    expect((await session.run(seen)).stdout).toBe('False||0')
  })

  // A person's Windows refuses script files by default (the Restricted policy): a call must not depend on the computer's.
  it('runs a call as powershell.exe -ExecutionPolicy Bypass does: a script file whatever policy its environment names, the full language, a single-threaded apartment', async () => {
    const file = join(scratch, 'dotted.ps1')
    writeFileSync(file, "function Get-HarnessDotted { 'dotted' }\r\n")
    const run = await session.run(`. '${file}'; "$(Get-HarnessDotted)|$($ExecutionContext.SessionState.LanguageMode)|$([Threading.Thread]::CurrentThread.GetApartmentState())"`, { env: { ...process.env, PSExecutionPolicyPreference: 'Restricted' } })
    expect(run).toEqual({ status: 0, stdout: 'dotted|FullLanguage|STA', stderr: '' })
  })

  it('gives a call the environment it sent, and nothing of the call before', async () => {
    expect((await session.run('"[$env:HARNESS_PS_CALL]"', { env: { ...process.env, HARNESS_PS_CALL: 'sent' } })).stdout).toBe('[sent]')
    expect((await session.run('"[$env:HARNESS_PS_CALL]"')).stdout).toBe('[]')
  })

  // What installPs1.spec.ts's `powershell7` cases stand on. A host that put a module command of its own into the call's
  // runspace ahead of the script (to format the output, say) would load 5.1's Utility there, and those cases would pass
  // whatever install.ps1 called.
  it('has autoload read the PSModulePath its call sent: a stand-in Utility hides Get-FileHash, and the next call has 5.1\'s own again', async () => {
    const modules = join(scratch, 'modules')
    mkdirSync(join(modules, 'HarnessStandIn'), { recursive: true })
    writeFileSync(join(modules, 'HarnessStandIn', 'HarnessStandIn.psm1'), "function Get-HarnessStandIn { 'stand-in' }\r\n")
    // installPs1.spec.ts's stand-in for PowerShell 7's Utility: it lists Get-FileHash and cannot give it to 5.1.
    mkdirSync(join(modules, 'Microsoft.PowerShell.Utility'))
    writeFileSync(join(modules, 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'), "@{ ModuleVersion = '7.0.0.0'; CompatiblePSEditions = @('Core'); PowerShellVersion = '3.0'; NestedModules = @('Microsoft.PowerShell.Commands.Utility.dll'); CmdletsToExport = @('Add-Type', 'ConvertFrom-Json', 'Get-FileHash', 'Invoke-WebRequest', 'New-Object', 'Select-Object', 'Start-Sleep', 'Write-Host') }\r\n")
    const file = join(scratch, 'hashed.txt')
    writeFileSync(file, 'harness')
    const sha = createHash('sha256').update('harness').digest('hex')
    const own: NodeJS.ProcessEnv = { ...process.env }
    for (const name of Object.keys(own)) if (name.toLowerCase() === 'psmodulepath') delete own[name]
    const standIn = { ...own, PSModulePath: `${modules};${join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')}` }
    const probe = `$hash = try { (Get-FileHash -LiteralPath '${file}' -Algorithm SHA256).Hash.ToLower() } catch { 'no Get-FileHash' }; $module = try { Get-HarnessStandIn } catch { 'no stand-in' }; "$hash|$module"`
    expect((await session.run(probe, { env: own })).stdout).toBe(`${sha}|no stand-in`)
    expect((await session.run(probe, { env: standIn })).stdout).toBe('no Get-FileHash|stand-in')
    expect((await session.run(probe, { env: own })).stdout).toBe(`${sha}|no stand-in`)
  })

  it('returns output, Write-Host lines and warnings in the order written, each line whole', async () => {
    const long = 'x'.repeat(300)
    const run = await session.run(`'one'; Write-Host 'two'; Write-Warning 'three'; 4; $true; Write-Host '${long}'; '${long}'`)
    expect(run).toEqual({ status: 0, stdout: ['one', 'two', 'WARNING: three', '4', 'True', long, long].join('\r\n'), stderr: '' })
  })

  it('gives status 1 and the message on stderr for an error the script did not catch, and status 0 for one it caught', async () => {
    const thrown = await session.run("$ErrorActionPreference = 'Stop'; 'before'; throw 'boom'; 'after'")
    expect({ status: thrown.status, stdout: thrown.stdout }).toEqual({ status: 1, stdout: 'before' })
    expect(thrown.stderr).toContain('boom')
    const unknown = await session.run("$ErrorActionPreference = 'Stop'; Get-HarnessNoSuchCommand")
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain("The term 'Get-HarnessNoSuchCommand' is not recognized")
    expect(await session.run("$ErrorActionPreference = 'Stop'; try { throw 'boom' } catch { $_.Exception.Message }")).toEqual({ status: 0, stdout: 'boom', stderr: '' })
  })

  it('keeps answering when a child started with Start-Process -NoNewWindow writes to the host\'s own output', async () => {
    // About 250 KB, more than a pipe holds: a host whose output nobody reads would block the child, and this call with it.
    const echo = `for /L %i in (1,1,4000) do @echo ${'0123456789'.repeat(6)}`
    const loud = await session.run(`$child = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c ${echo}' -NoNewWindow -PassThru; $null = $child.Handle; $child.WaitForExit(); $child.ExitCode`)
    expect(loud).toEqual({ status: 0, stdout: '0', stderr: '' })
    expect((await session.run("'next'")).stdout).toBe('next')
  })

  it('carries text outside ASCII both ways, and an answer larger than a pipe holds', async () => {
    expect((await session.run("'Jö 日 & co'; Write-Host 'Jö 日 & co'")).stdout).toBe('Jö 日 & co\r\nJö 日 & co')
    const lines = (await session.run("1..20000 | ForEach-Object { \"line $_ \" + ('y' * 60) }")).stdout.split('\r\n')
    expect(lines).toHaveLength(20000)
    expect(lines.at(-1)).toBe(`line 20000 ${'y'.repeat(60)}`)
  })

  it('fails a call that passes its timeout, naming it, ends that host, and answers the next call from a new one', async () => {
    const before = Number((await session.run('$PID')).stdout)
    await expect(session.run('[Threading.Thread]::Sleep(60000)', { timeoutMs: 2_000 })).rejects.toThrow('timed out after 2000 ms')
    expect(() => process.kill(before, 0)).toThrow()
    expect(Number((await session.run('$PID')).stdout)).not.toBe(before)
  })

  it('fails a call whose host exits under it, naming the exit, and answers the next call from a new host', async () => {
    await expect(session.run('[Environment]::Exit(7)')).rejects.toThrow('host exited with code 7')
    expect((await session.run("'back'")).stdout).toBe('back')
  })

  it('leaves no powershell.exe behind when it closes', async () => {
    const own = windowsPowerShell()
    const pid = Number((await own.run('$PID')).stdout)
    await own.close()
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd cli && npx vitest run src/testing/windowsPowerShell.spec.ts`
Expected: `Test Files  1 failed (1)`, `Tests  no tests`, with
`Error: Cannot find module './windowsPowerShell.js' imported from …/cli/src/testing/windowsPowerShell.spec.ts`.

- [ ] **Step 3: Commit the red test** and report the SHA: the main session pushes it for the red run.

```bash
git add cli/src/testing/windowsPowerShell.spec.ts
git commit -m "Windows: a spec for one Windows PowerShell per spec file (red)"
```

- [ ] **Step 4: Write `cli/src/testing/windowsPowerShell.ts`**

What is fixed is in Global Constraints and Interfaces. The host loop's PowerShell, the pipe framing and how stray
host output is reported are the builder's. Decided here:

- The host starts on the first call (`spawn`, `stdio: ['ignore', 'pipe', 'pipe']`, no `detached`, no `cwd`). Node
  serves the pipe with `net.createServer` and listens before the host starts. Calls go one at a time, in the order
  made.
- Per call, in the host: remove every environment variable the call did not send and set every one it did; open
  the runspace; run the script; dispose the runspace.
- The host's tree is ended with `stopTree` (`../lib/gitProject.js`), not a second tree stop.
- The file's header says why it exists (the measured 22 s, once per process), what a fresh runspace does not reset
  (loaded .NET assemblies and types; `$PID`) and what it does not cover (decision 3).

Traps, from PowerShell's documented behavior and this repo's notes; none could be run here:

1. Nothing of the host's goes into the call's runspace ahead of the script or into its pipeline. `Out-String` is a
   Utility command: resolved there, it loads 5.1's own Utility into the runspace, and the `powershell7` cases stop
   testing autoload. Format in the host's own runspace.
2. The host's own module commands (`ConvertFrom-Json`, `Out-String`, …) load on first use, under the PSModulePath
   the process has at that moment. Start the host with PSModulePath removed and use each once before the first
   call's environment is applied.
3. `-ExecutionPolicy Bypass` lives in the process environment (`PSExecutionPolicyPreference`): replacing the
   environment removes it, or puts the call's in its place.
4. A new process builds PSModulePath when it starts. After a call that sent a stand-in path, a call that sends none
   must get what a new process has, not an empty or a stale one.
5. Take output, Write-Host lines and warnings from one stream (the information and warning streams merged into the
   output): stream event handlers written as script blocks run on a thread that has no runspace. Do not merge the
   error stream: 5.1 then makes a native command's stderr line a terminating error under Stop (`install.ps1`,
   `Test-HarnessReady`). An error the script does not catch arrives as an exception from the invoke, whose return
   value is then lost: collect the output so that what was written before the error still comes back.
6. The script runs in the runspace's global scope, as `-EncodedCommand` runs it: a wrapper block is dot-sourced,
   not called.
7. Environment names are case-insensitive on Windows: compare them so when removing.
8. `-EncodedCommand` is on the command line, 32 767 characters at most: about 12 000 characters of host loop.
9. In Node: read the host's stdout and stderr always, keeping a bounded tail. Wait for the host's `exit`, not
   `close`, and destroy its output streams after it: a process a case left behind can hold them open.
10. The pipe takes one connection, then stops listening. Decode it as a stream: a character can be split across
    chunks.

- [ ] **Step 5: Typecheck, and run what runs here**

Run: `cd cli && npx tsc --noEmit && npx vitest run src/testing/windowsPowerShell.spec.ts`
Expected: no `tsc` output; `Tests  1 passed | 12 skipped (13)`.

- [ ] **Step 6: Commit** and report the SHA: the main session pushes it for the green run.

```bash
git add cli/src/testing/windowsPowerShell.ts
git commit -m "Windows: one Windows PowerShell per spec file, a fresh runspace per call"
```

- [ ] **Step 7: Read the run, on both jobs**

```bash
gh run list --workflow tmp-installps1-fewer-shells.yml --branch fix/installps1-fewer-shells --commit "$(git rev-parse HEAD)" --json databaseId,status,conclusion,url
gh run view <databaseId> --log-failed
```

Expected in `The session's own spec`: `Tests  13 passed (13)`. A red case is fixed in the helper, in a new commit.
If the log shows a case's own PowerShell is wrong (a syntax or quoting slip), fix that script and keep what the
case asserts; name it in the report. The task is done when that step is green on both jobs.

---

### Task 3: `installPs1.spec.ts` makes its library calls through the session

**Depends on:** Task 2. **Effort:** high (one file, about 70 call sites, proof only on the runners).

**Files:**
- Modify: `cli/src/scripts/installPs1.spec.ts`

**The test that fails before the change:** none. No behavior and no assertion changes; the cases themselves are the
check, green before and after, and Task 1's mutation steps show they still fail when they must. One commit.

**Interfaces, consumes:** `windowsPowerShell()`, `PowerShellRun` (Task 2).

- [ ] **Step 1: The session, and the helpers that use it**

- At module level: `const session = windowsPowerShell()`. The existing `afterAll` becomes `async` and awaits
  `session.close()` first, before the registry keys and the folders.
- `async function ps(script: string, env: NodeJS.ProcessEnv = {}, modulePath: ModulePath = 'default'):
  Promise<PowerShellRun>` returns `session.run` of the same text as now
  (`` `$ErrorActionPreference = 'Stop'; . '${installer}'; ${script}` ``) with
  `{ env: powershellEnv(modulePath, { HARNESS_INSTALL_LIBRARY: '1', ...env }) }`.
- `const thrown = async (call: string): Promise<string>`, the same script, `(await ps(…)).stdout`.
- In `installing for real`: `platform()` returns one promise for the file
  (`native ??= ps('Get-HarnessPlatform').then((run) => run.stdout)`); `userPathValue` and `ticks` become `async`
  and send their script, unchanged, with `session.run(script)` and no `env`.
- In the handle-holding case only the `finally` changes: `await session.run(kill)`. Its main `spawnSync` stays.

- [ ] **Step 2: Await at every call site**

Each `ps(…)`, `thrown(…)`, `platform()`, `ticks(…)` and `userPathValue(…)` is awaited and its case's callback is
`async`; `kept.map(ticks)` becomes `await Promise.all(kept.map(ticks))`, twice. On an `expect` line nothing after
the matcher's `).to…(` changes, and each assertion stays on its one line. `install()`, the two `irm | iex` calls,
the `viaPowerShell`, `said` and Restricted commands stay as they are.

- [ ] **Step 3: Keep the comments true**

Two comments say each case or call starts a `powershell.exe`: above the first library describe (169-170) and above
`closes with the setup steps…` (724). Rewrite each to say what holds now, keeping the incident it names; the
timeouts beside them stay. `ps()`'s own comment gains where the script now runs, and why.

- [ ] **Step 4: Check the cases and assertions kept their shape**

Before committing, from `cli/` (the script lives outside the repo and is never committed):

```bash
check=$(mktemp -d)
cat > "$check/shape.cjs" <<'EOF'
// Every describe and case line (without `async `), and every assertion from its matcher to the end of the line.
const { execFileSync } = require('node:child_process')
const file = 'src/scripts/installPs1.spec.ts'
const matcher = /\)\.(?:not\.)?to(?:Be|Contain|Equal|Match|HaveLength|Throw|BeLessThan)\(.*$/
const shape = (text) => text.split(/\r?\n/).flatMap((line) =>
  /^\s*(describe|it)[.(]/.test(line) ? [line.replace('async ', '').trim()]
    : line.includes('expect(') ? [line.match(matcher)?.[0] ?? line.trim()] : [])
const before = shape(execFileSync('git', ['show', `HEAD:cli/${file}`], { encoding: 'utf8', maxBuffer: 1e8 }))
const after = shape(require('node:fs').readFileSync(file, 'utf8'))
const differ = before.flatMap((line, i) => (line === after[i] ? [] : [`${line}\n   -> ${after[i]}`]))
console.log(`${before.length} before, ${after.length} after, ${differ.length} differ\n${differ.join('\n')}`)
process.exit(before.length === after.length && differ.length === 0 ? 0 : 1)
EOF
node "$check/shape.cjs"; grep -c "spawnSync('powershell.exe'" src/scripts/installPs1.spec.ts; rm -r "$check"
```

Expected: `220 before, 220 after, 0 differ`, then `8`.

- [ ] **Step 5: Typecheck, and run what runs here**

Run: `cd cli && npx tsc --noEmit && npx vitest run src/scripts/installPs1.spec.ts`
Expected: no `tsc` output; `Tests  14 passed | 31 skipped (45)`.

- [ ] **Step 6: Commit** and report the SHA: the main session pushes it.

```bash
git add cli/src/scripts/installPs1.spec.ts
git commit -m "installPs1.spec.ts: the library calls share one Windows PowerShell"
```

- [ ] **Step 7: Read the run, on both jobs** (the commands of Task 2, Step 7)

Expected: all four steps green; in the library step `Tests  23 passed | 22 skipped (45)`; each mutation step ends
with `ok: '<case>' failed, at: …`. Report the library step's time on each runner. A red library case is a fault of
this task or of the helper: find which before changing either.

---

### Task 4: `windows.yml` runs the session's spec, and its comment names the measured cause

**Depends on:** nothing (its two files are no other task's). **Effort:** medium.

**Files:**
- Modify: `.github/workflows/windows.yml:66-68` and `:190-204`
- Test: `cli/src/scripts/windowsWorkflows.spec.ts` (two lines and their comment, in the case that ends on line 28)

**The test that fails before the change:** `runs the rollover and payload-install specs against two real builds of
the host`, with the new assertion.

- [ ] **Step 1: Write the failing assertion**

In `cli/src/scripts/windowsWorkflows.spec.ts`, at the end of that case, after the `for (const spec of […])` line:

```ts
    // The PowerShell that installPs1.spec.ts makes its library calls in has a spec of its own, for Windows only, and PR CI
    // runs no Windows: it runs here, in the same step.
    const paths = pty.match(/^ +\$paths = @\(([^\n]*'src\/scripts\/installPs1\.spec\.ts'[^\n]*)\)$/m)?.[1] ?? ''
    expect(paths.split(', ')).toContain("'src/testing/windowsPowerShell.spec.ts'")
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd cli && npx vitest run src/scripts/windowsWorkflows.spec.ts`
Expected: `Tests  1 failed | 11 passed (12)`, at `src/scripts/windowsWorkflows.spec.ts:31:31`:
`AssertionError: expected [ …(4) ] to include '\'src/testing/windowsPowerShell.spec.…'`.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/scripts/windowsWorkflows.spec.ts
git commit -m "Windows workflow: a spec for the session's spec in the two-builds step (red)"
```

- [ ] **Step 4: Change `.github/workflows/windows.yml`**

The step's `$paths` line (203) gets a fifth entry, last:

```yaml
          $paths = @('src/lib/hostMove/hostMove.real.spec.ts', 'src/lib/ptyHost/drain.spec.ts', 'src/lib/windows/ptyInstall.windows.real.spec.ts', 'src/scripts/installPs1.spec.ts', 'src/testing/windowsPowerShell.spec.ts')
```

The step's comment (190-192) says so: after `install.ps1 in Windows PowerShell 5.1` it adds
`, with the spec of the one PowerShell its library cases share`.

The limits comment (66-68) becomes (the `timeout-minutes` line under it stays):

```yaml
    # A limit per architecture, in minutes. One limit of 40 cancelled the arm64 job in its last test step (run
    # 43565271777); with every step run it then took 44.8 minutes, and x64 16.8 (run 43576955663). The cause,
    # measured (runs 43581413308 and 43582091190): the first command a Windows PowerShell 5.1 process has module
    # autoload find costs 22 to 29 s on windows-11-arm and 0.25 to 0.8 s on windows-latest, once per process,
    # whatever PSModulePath is; a start that runs no such command takes 0.24 to 0.38 s. installPs1.spec.ts paid it
    # at each of its PowerShell starts, about 1390 s of that job. Its library calls now share one PowerShell
    # (cli/src/testing/windowsPowerShell.ts). arm64 keeps 60 until several runs show the new time.
```

- [ ] **Step 5: Run the specs that read the workflow, and lint it**

Run: `cd cli && npx vitest run src/scripts/windowsWorkflows.spec.ts src/scripts/windowsCiChecks.spec.ts && actionlint ../.github/workflows/windows.yml`
Expected: `Tests  24 passed | 5 skipped (29)`; no actionlint output.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/windows.yml
git commit -m "Windows workflow: the two-builds step runs the session's spec; the limits comment names the measured cause"
```

---

### Task 5: Remove the temporary workflow

**Depends on:** Tasks 1, 2, 3 and 4, and Verification 2 and 3 with their evidence recorded. The main session starts
it; it does not start by itself when Task 4 ends. **Effort:** medium.

**Files:**
- Delete: `.github/workflows/tmp-installps1-fewer-shells.yml`

**The test that fails before the change:** none: one commit.

- [ ] **Step 1: Remove it and commit**

```bash
git rm .github/workflows/tmp-installps1-fewer-shells.yml
git commit -m "Remove the temporary workflow of installps1-fewer-shells"
```

- [ ] **Step 2: Check nothing of it is left**

Run: `git grep -n "tmp-installps1" -- . ':!docs/plans'; git diff --stat origin/main...HEAD -- .github`
Expected: no line from the first; from the second, `windows.yml` alone.

---

## Verification

On the final head, after the review, with the temporary workflow still there; Task 5 follows. No sign-in, no
account, no backend, no secret and no production: the runs build and test on GitHub's runners and write nothing
outside themselves. None needs a person's own login or eye.

1. **Local, any platform (this Mac).** The spec's `as written` check and what runs off Windows, from `cli/`:

   ```bash
   npx tsc --noEmit && npx vitest run src/scripts/installPs1.spec.ts src/scripts/windowsWorkflows.spec.ts src/testing/windowsPowerShell.spec.ts
   perl -ni -e 'print unless /^\s+Assert-HarnessPtySigned \$unpacked\s*$/' scripts/install.ps1
   npx vitest run src/scripts/installPs1.spec.ts -t "checks the terminal host's signatures"
   git checkout -- scripts/install.ps1 && npx vitest run src/scripts/installPs1.spec.ts -t "checks the terminal host's signatures"
   ```

   To see: `Tests  27 passed | 43 skipped (70)`; with the call removed, `Tests  1 failed | 44 skipped (45)` and
   `expected 'function Install-HarnessPty {…' to contain 'Assert-HarnessPtySigned $unpacked'`; put back,
   `Tests  1 passed | 44 skipped (45)`, and `git status --short` names no `install.ps1`.

2. **The temporary workflow on the final head** (`tmp-installps1-fewer-shells.yml`; GitHub runners
   `windows-11-arm` and `windows-latest`). The main session pushes on the orchestrator's go. If the head differs from a
   commit whose run is already green by nothing under `cli/src/testing/`, `cli/src/scripts/installPs1.spec.ts`,
   `cli/scripts/install.ps1` and the workflow itself, that run is the evidence and no push is made for this.

   ```bash
   gh run list --workflow tmp-installps1-fewer-shells.yml --branch fix/installps1-fewer-shells --commit "$(git rev-parse HEAD)" --json databaseId,status,conclusion,url
   ```

   To see, in both `library (…)` jobs: `The session's own spec` green with `Tests  13 passed (13)`; the library step
   green with `Tests  23 passed | 22 skipped (45)`; `Mutation 1` green, its last line
   `ok: 'keeps a download only when its size and SHA-256 are the manifest's' failed, at:` followed by the case's
   `'powershell7'` line; `Mutation 2` green, its last line `ok: 'names each terminal host file…' failed, at: …`. A
   red mutation step means the case passed with `install.ps1` mutated, or failed for another reason: the
   `powershell7` cases no longer test autoload, and the branch does not merge.

3. **`windows.yml` on the branch, once** (GitHub runners `windows-11-arm` and `windows-latest`; the baseline run
   took 49 minutes to its last job's end). It starts only by hand, on the orchestrator's go, with no other heavy
   workflow running; a second start on the branch cancels the first.

   ```bash
   gh workflow run windows.yml --ref fix/installps1-fewer-shells
   gh run list --workflow=windows.yml --branch fix/installps1-fewer-shells --limit 1 --json databaseId,headSha,url
   gh run watch <databaseId> --exit-status
   gh run view <databaseId> --json jobs --jq '.jobs[] | [.databaseId, .name, .startedAt, .completedAt] | @tsv'
   gh run view <databaseId> --json jobs --jq '.jobs[] | .name as $job | .steps[] | select(.name | startswith("Two real builds")) | [$job, .startedAt, .completedAt] | @tsv'
   ```

   Per `windows-pty` job, the case times (the script lives outside the repo; `gh` writes the reporter's colours as
   `^[[32m`):

   ```bash
   times=$(mktemp -d)
   cat > "$times/times.cjs" <<'EOF'
   // node times.cjs <job log> [cases]: the verbose reporter's times of the two specs, summed per describe.
   const text = require('node:fs').readFileSync(process.argv[2], 'utf8').replace(/(?:\u001b|\^\[)\[[0-9;]*m/g, '')
   const sums = new Map()
   const cases = []
   for (const line of text.split('\n')) {
     const m = line.match(/src\/(?:scripts\/installPs1|testing\/windowsPowerShell)\.spec\.ts > (.+?) > (.+?)\s+(\d+)\s*ms\s*$/)
     if (!m) continue
     sums.set(m[1], (sums.get(m[1]) ?? 0) + Number(m[3]))
     cases.push(`${m[3].padStart(7)} ms  ${m[2]}`)
   }
   for (const [name, ms] of sums) console.log(`${(ms / 1000).toFixed(1).padStart(7)} s  ${name}`)
   console.log(`${cases.length} cases`)
   if (process.argv[3]) console.log(cases.join('\n'))
   EOF
   gh run view <databaseId> --job <jobId> --log > "$times/job.log" && node "$times/times.cjs" "$times/job.log" cases
   ```

   To see: `headSha` is the branch head; all four jobs green (two `windows-pty`, two `install`); 57 cases listed per
   job (45 of `installPs1.spec.ts`, 12 of the session's spec in its describe), none skipped. To report, beside the
   baseline table above: each `windows-pty` job's time, each `Two real builds` step's time, the three describes'
   sums and the per-case list, on both runners. The goal is about 7 minutes for the step on arm64 and about 29 for
   the job; x64's step stays within 1.3 to 2.1 minutes. An arm64 step that is not well under 23.6 minutes is a
   finding to report, not a pass.

**Temporary workflow:** `tmp-installps1-fewer-shells.yml`, Task 1, removed by Task 5. No permanent one is proposed:
after this branch `windows.yml` runs the session's spec and `installPs1.spec.ts` on both runners, and the session's
spec keeps the autoload proof (its stand-in case).

**Checks PR CI does not run:** none required. `python3 scripts/local-checks.py --list` on the branch's paths prints
`{}`, and nothing under `cli/src/core/`, `cli/src/services/` or `cli/src/harnessd/` changes. PR CI's `cli-tests`
loads both specs on Linux and skips their Windows cases.

**Not in this plan** (the spec's separate proposals, for the final report): importing modules by full path in
`install.ps1`; a smaller arm64 limit once several runs show the new time.

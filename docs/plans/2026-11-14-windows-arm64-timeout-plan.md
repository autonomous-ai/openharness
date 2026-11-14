# Windows workflow, a time limit per architecture: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. One task, test-first: a red commit (the test
> alone), then the workflow commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The arm64 `windows-pty` job has 60 minutes and finishes with every step run (about 43), the x64 job keeps
40, and the `install` job runs again after both.

**Architecture:** Two lines of data and one expression in `.github/workflows/windows.yml`: each entry of
`windows-pty`'s matrix names its limit, and the job reads `timeout-minutes: ${{ matrix.timeout }}`. A text check in
`cli/src/scripts/windowsWorkflows.spec.ts` holds both. No step is skipped, moved or changed.

**Tech Stack:** GitHub Actions, TypeScript, Vitest 4.1.10, actionlint 1.7.12. No new dependency.

**Spec:** [docs/plans/2026-11-14-windows-arm64-timeout-design.md](2026-11-14-windows-arm64-timeout-design.md).
Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Open questions

None.

## Global Constraints

- The values, verbatim: `timeout: 40` on the x64 entry, `timeout: 60` on the arm64 entry, and
  `timeout-minutes: ${{ matrix.timeout }}` on the job. Plain integers, not quoted.
- No step is skipped, moved or changed. The `install` job is untouched: its `timeout-minutes: 30` stays, and its
  matrix gets no `timeout`.
- Not here: making `cli/src/scripts/installPs1.spec.ts` start Windows PowerShell fewer times, or a job of its own for
  it. The final report proposes the first as a separate item; no task touches that spec.
- Files: `.github/workflows/windows.yml` and `cli/src/scripts/windowsWorkflows.spec.ts`. Nothing else. A commit adds
  its file by name: the two documents under `docs/plans/` are untracked here and are no task's.
- The task runs only its own spec. No full local suite: PR CI runs it.
- Platforms: Windows x64 and Windows arm64, on GitHub runners only (`windows-latest`, `windows-11-arm`). No product
  code changes and nothing runs on a person's computer. One pull request; its body names the platforms and carries
  the spec's measured numbers, the red and green output and the Verification run's link.

## Found while reading the code

Checked at `39c675b7af`, with the change rehearsed on this Mac and put back.

- **Baseline.** `cd cli && npx vitest run src/scripts/windowsWorkflows.spec.ts`: `Tests 11 passed (11)`. This
  checkout has `cli/node_modules`; another one installs first: `cd cli && npm ci --no-audit --no-fund`.
- **Rehearsed.** Step 1's test alone: `1 failed | 11 passed (12)`. With Step 4's lines: `12 passed (12)`. With the
  matrix changed and the job still at `40`: red on the second assertion, `expected '40' to be '${{ matrix.timeout }}'`,
  so each half has its own red. `npx tsc --noEmit` is clean with the test in place, and the workflow's other reader
  (`src/scripts/windowsCiChecks.spec.ts`) stays green.
- **actionlint** (1.7.12 here, the version PR CI's `plan` job runs on this file, `ci.yml:98-102`): clean before and
  after; it reads `matrix.timeout` as a number. It refuses a misspelt key (`matrix.timeouts`), but not a quoted
  limit and not an entry with none: the new test pins those two.
- **The release uses the same matrix.** `release.yml`'s `pty-build` calls this job with `release: true`, so the arm64
  payload build gets 60 as well. It runs no test and takes minutes; only a hang waits 20 minutes longer.
- **The job names should gain the limit.** GitHub names a matrix job by its values: today
  `windows-pty (windows-11-arm, aarch64-pc-windows-msvc, arm64, harness-pty-windows-arm64)`, then with `, 60` at the
  end (`, 40` on x64). Nothing in the repo reads these names, and the workflow is no required check.

## Review Focus

- GitHub reads the expression only when a run starts: a limit it cannot read fails the whole workflow, and the
  release's `pty-build` with it. No text check shows that. Task 1, Step 5 (actionlint) and Verification 1.
- An entry with no limit (a line deleted, an architecture added later). Task 1, Step 1: `toStrictEqual` over every
  entry of the matrix, in order.
- A quoted limit (`'60'`), a string where GitHub wants a number. Task 1, Step 1: the match takes digits to the end
  of the line.
- Half the change: the matrix names its limits and the job still says `40`, or the reverse. Task 1, Step 1: one
  assertion for each half.
- The `install` job's matrix and its 30 minutes. The test reads the `windows-pty` job only; Task 1, Step 6 shows
  the diff ends before the steps; Verification 1 sees both `install` jobs run.

---

### Task 1: Each architecture's `windows-pty` job has its own limit

**Depends on:** nothing. **Effort:** medium (mechanical: three lines of a workflow and one text check).

**Files:**
- Modify: `.github/workflows/windows.yml:51-62`
- Test: `cli/src/scripts/windowsWorkflows.spec.ts` (one new case, after the case that ends on line 28)

**The test that fails before the change:** `gives each architecture of the Windows PTY job its own time limit`.

- [ ] **Step 1: Write the failing test**

In `cli/src/scripts/windowsWorkflows.spec.ts`, between
`runs the rollover and payload-install specs against two real builds of the host` and
`publishes the Windows bits to staging, and to production only when a dispatch asks`:

```ts
  // With every step run the arm64 job takes about 43 minutes and the x64 job 16 (2026-11-14). One limit of 40 for both
  // cancelled arm64 in its last test step, and the install job was skipped (run 43565271777).
  it('gives each architecture of the Windows PTY job its own time limit', () => {
    const job = read('windows.yml').match(/\n  windows-pty:\n([\s\S]*?)(?=\n  [\w-]+:\n|$)/)?.[1] ?? ''
    const entries = (job.match(/\n {8}include:\n((?: {10}[^\n]*\n)+)/)?.[1] ?? '').split(/^ {10}- /m).slice(1)
    const limits = entries.map((entry) => [entry.match(/^\s*arch: (\S+)$/m)?.[1], entry.match(/^\s*timeout: (\d+)$/m)?.[1]])
    expect(limits).toStrictEqual([['x64', '40'], ['arm64', '60']])
    expect(job.match(/^ {4}timeout-minutes: (.+)$/m)?.[1]).toBe('${{ matrix.timeout }}')
  })
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd cli && npx vitest run src/scripts/windowsWorkflows.spec.ts`
Expected: `Tests  1 failed | 11 passed (12)`, the failure at `src/scripts/windowsWorkflows.spec.ts:36:20`:

```
AssertionError: expected [ [ 'x64', undefined ], …(1) ] to strictly equal [ [ 'x64', '40' ], [ 'arm64', '60' ] ]
```

Keep the output for the pull request body.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/scripts/windowsWorkflows.spec.ts
git commit -m "Windows: a spec for the PTY job's time limit per architecture (red)"
```

- [ ] **Step 4: Give each matrix entry its limit, and have the job read it**

In `.github/workflows/windows.yml`, the `windows-pty` job, lines 49-62 become (two `timeout:` lines added, one
comment added, `timeout-minutes: 40` replaced):

```yaml
      matrix:
        include:
          - runner: windows-latest
            target: x86_64-pc-windows-msvc
            arch: x64
            artifact: harness-pty-windows-x64
            timeout: 40
          - runner: windows-11-arm
            target: aarch64-pc-windows-msvc
            arch: arm64
            artifact: harness-pty-windows-arm64
            timeout: 60
    # Each runner builds and tests its own native target. Cross-building the other
    # target is dropped: it needs extra MSVC components and adds little signal.
    runs-on: ${{ matrix.runner }}
    # A limit per architecture, in minutes. With every step run arm64 takes about 43 and x64 16 (2026-11-14):
    # installPs1.spec.ts starts Windows PowerShell 5.1 many times, at about 8 s a start on windows-11-arm and 0.4 s on
    # windows-latest. One limit of 40 cancelled the arm64 job in its last test step (run 43565271777).
    timeout-minutes: ${{ matrix.timeout }}
```

- [ ] **Step 5: Run the spec and the lint**

Run: `cd cli && npx vitest run src/scripts/windowsWorkflows.spec.ts`
Expected: `Tests  12 passed (12)`.

Run, from the repo root: `actionlint .github/workflows/windows.yml`
Expected: no output, exit 0. On a machine without `actionlint`, skip it: PR CI's `plan` job lints this file.

- [ ] **Step 6: Check the diff is that and nothing else**

Run: `git diff --stat && git diff -U0 -- .github/workflows/windows.yml`
Expected: one file; three hunks, all above the job's `steps:`: `+            timeout: 40`, `+            timeout: 60`,
and `-    timeout-minutes: 40` replaced by the three comment lines and `+    timeout-minutes: ${{ matrix.timeout }}`.
No line of the `install` job.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/windows.yml
git commit -m "Windows: the arm64 PTY job gets 60 minutes, x64 keeps 40"
```

---

## Verification

On the final head, after the review. No sign-in, no account, no backend, no production, no secret: the workflow has
`permissions: contents: read`, builds the terminal host inside the run, installs and uninstalls on the runner, and
only downloads (Node, the published firmware). It needs nobody's own login or eye.

1. **The Windows workflow on the branch head, once** (`.github/workflows/windows.yml`; GitHub runners
   `windows-latest` for x64 and `windows-11-arm` for arm64; about 50 minutes: arm64 `windows-pty` about 43, then
   `install` about 4). PR CI never runs it (`workflow_dispatch` and `workflow_call` only). It is heavy and starts
   only by hand: ask the orchestrator first, after the branch is pushed, with no other heavy workflow running
   (`docs/validation-and-release.md`). Start it once: a second start on the same branch cancels the first
   (`concurrency`, `cancel-in-progress`).

   ```bash
   gh workflow run windows.yml --ref fix/windows-arm64-timeout
   gh run list --workflow=windows.yml --branch fix/windows-arm64-timeout --limit 1 --json databaseId,headSha,createdAt,url
   gh run watch <databaseId> --exit-status
   gh run view <databaseId> --json jobs --jq '.jobs[] | {name, conclusion, minutes: (((.completedAt | fromdateiso8601) - (.startedAt | fromdateiso8601)) / 60 | floor), notGreen: [.steps[] | select(.conclusion != "success") | "\(.name): \(.conclusion)"]}'
   ```

   No inputs: `release` defaults to `false`, so the tests run. The same from the site: Actions, Windows, Run
   workflow, the branch. Check `headSha` is the branch head.

   To see, four jobs, each `success`:

   - `windows-pty` on `windows-latest` (x64): under 40 minutes (about 16).
   - `windows-pty` on `windows-11-arm` (arm64): under 60 minutes (about 43). The steps a limit of 40 cut are green:
     `Two real builds: the pty host rollover and the payload install`, `Collect the payload`, the artifact upload,
     `Flasher: without a board`.
   - In both `windows-pty` jobs, `notGreen` holds one line, `Check the release payload: skipped` (it runs for a
     release only). Every other step ran.
   - `install`, x64 and arm64: both ran and passed (in run 43565271777 the job was skipped). Skipped by their own
     `if:` and expected: the other architecture's OpenCode step, and the last artifact upload (`if: failure()`). On
     x64 the two OpenCode steps are `continue-on-error` and do not gate.

   That is the pass. Report the run's link, the four durations and the two `windows-pty` job names: each should end
   with its limit (`, 40`, `, 60`); say so if one does not. A job cancelled at its limit, or any other step not
   green, is not a pass, whatever its cause: report the job, the step and the log line with the link, and stop.

**Temporary workflow:** none. The long check has its workflow already, and it starts by hand on any branch.

**Checks PR CI does not run:** none required.
`python3 scripts/local-checks.py --list .github/workflows/windows.yml cli/src/scripts/windowsWorkflows.spec.ts`
prints `{}`, and `npm run test:core` does not apply (nothing under `cli/src/core/` or `cli/src/services/`). PR CI runs
actionlint on `windows.yml` (the `plan` job) and the CLI's typecheck and unit suite, which holds the new case.

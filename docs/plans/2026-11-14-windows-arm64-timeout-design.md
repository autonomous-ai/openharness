# Windows workflow: the arm64 job's time limit

## Problem

`windows.yml`'s `windows-pty` job has one `timeout-minutes: 40` for both architectures. Since #4288 and #4291 the step
"Two real builds: the pty host rollover and the payload install" runs again (it failed early from 2026-11-02 to
2026-11-14, so the steps after it never ran). On arm64 the job now passes 40 minutes: run 43565271777 was cancelled at
40m16s inside "Flasher: without a board", and the `install` job, which needs `windows-pty`, was skipped.

## Measured (GitHub job and step times, and the verbose vitest log)

| Step | x64 | arm64 |
|---|---|---|
| Rust tests | 1.9-2.1m | 2.1-2.4m |
| hn: Rust tests + hn: build release (added since 2026-11-02) | 4.4-6.4m | 5.3-5.5m |
| Contract suite and the Windows CLI specs | 1.9-3.3m | 4.4-6.1m |
| Two real builds | 1.3-2.1m | 21.9-23.6m |
| Flasher: without a board | 0.9-1.5m | 3.7m (41506957961, the last full run) |
| Whole job | 7.6m (11-02), 16.1m (43565271777) | 36.5m (11-02, before hn), 38.9m to the end of Two real builds (43565271777) |

Runs: 43565271777, 43560364769, 43571240058, 43557665371, 43158661612, 42585246551 (2026-11-09 to 11-14),
41506957961 (2026-11-02, the last run where every step ran on both).

- Of Two real builds' 1411 s on arm64 (125 s on x64), `src/scripts/installPs1.spec.ts` takes about 1390 s. Its cases
  start Windows PowerShell 5.1 many times; each start costs about 8 s on the `windows-11-arm` runner and about 0.4 s
  on `windows-latest` (the same cases: 23.6 s vs 1.1 s, 113 s vs 2.0 s, 101 s vs 12.3 s). The other three specs take
  the same time on both.
- Nothing in that step builds: it runs the four specs against binaries built earlier in the job. No binary is built
  twice in the job (the previous host is built once, stamped 0.0.1, and the release build recompiles only the crate).
- The arm64 job, every step run: about 39m to the end of Two real builds, plus the flasher (up to 3.7m) and the payload
  upload (under 0.5m): about 43 minutes. It had 3.5 minutes to spare on 2026-11-02, before hn added 5.3.

## Options

1. **A time limit per architecture** (chosen). x64 keeps 40 minutes (measured 16). arm64 gets 60: the measured 43
   minutes plus the spread already seen between runs (the contract suite 4.4-6.1m, Two real builds 21.9-23.6m, the
   flasher 1.2-3.7m), about 40% headroom, so a slow arm64 runner still finishes while a hang is still cut.
2. Splitting the PowerShell install specs into their own job, after `windows-pty`, from its payload artifact. It does
   not shorten the run: the specs need the built `harness.exe`, so they still start after the build, and the new job
   adds a checkout, Node setup and `npm ci` on a second arm64 runner. Only the step moves; the run's wall time stays
   about the same and its runner minutes grow.
3. One limit of 60 for both: a hang on x64 would hold its runner 20 minutes longer than it needs to.

## Change

In `windows-pty`'s matrix, each entry names its limit (`timeout: 40` for x64, `timeout: 60` for arm64), and the job
reads `timeout-minutes: ${{ matrix.timeout }}`, with a comment that gives the measured numbers. No step is skipped,
moved or changed. The `install` job (30 minutes, measured 3.7) is unchanged.

The jobs keep their names. GitHub names a matrix job by all its values, so the limit would add `, 40` and `, 60` to
them; the job's `name:` lists the other four values as GitHub does today:
`windows-pty (${{ matrix.runner }}, ${{ matrix.target }}, ${{ matrix.arch }}, ${{ matrix.artifact }})`.

`cli/src/scripts/windowsWorkflows.spec.ts` checks it: the arm64 entry's limit is 60, the x64 entry's 40, the job
takes its limit from the matrix, and its name leaves the limit out. It fails before the change.

## Not in this change

Why Windows PowerShell 5.1 starts 20 times slower on the `windows-11-arm` runner. Making `installPs1.spec.ts` start it
fewer times would shorten the arm64 job by most of 20 minutes, but it changes the spec and needs its own measurement;
the final report proposes it.

## Verification

One run of `windows.yml` on this branch (workflow_dispatch, `--ref fix/windows-arm64-timeout`), asked of the
orchestrator first: both `windows-pty` jobs finish inside their limits with every step run, under the names they had,
and both `install` jobs run and pass. Platforms: Windows x64 and Windows arm64 (GitHub runners only; no code runs elsewhere).

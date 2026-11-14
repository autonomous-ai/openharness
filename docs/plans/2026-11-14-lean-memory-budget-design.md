# The lean master's memory budget: why it now fails, and the fix

## Problem

`cli/e2e/lean.e2e.ts` holds the master and each lean service process under 100 MiB resident. It failed twice on
2026-11-14 on branches that touched none of those processes:

- cli-e2e run 43572508176 (Linux, Node 24.22.2): `master resident MiB: expected 100.4296875 to be less than 100`.
  The same head passed on the next run (43575029200).
- A local macOS run on Node 24: `viewers 103 > 100`.

## Measurements

RSS of each lean process, sampled the way the test samples it (every service connected), and again 10 s later.
A spec outside the repository started a fresh isolated daemon from the commit's own bundle, several times per
configuration. Median [min-max], MiB, at "connected".

Commits: `3a11343a02` (2026-10-15, the last green nightly), `4a9f32e1f2` (2026-11-13 nightly, lean passed),
`39c675b7af` (main, 2026-11-14), and main with the fix below as an experiment.

### Linux (ubuntu-latest, as CI; 4 runs each)

| Node | Commit | master | viewers | search | edge | models | core* |
|---|---|---|---|---|---|---|---|
| 24.22.2 | 10-15 | 73.4 [71-76] | 93.8 | 72.1 | 81.1 | 74.3 | 93.6 |
| 24.22.2 | 11-13 | 96.5 [95-100] | 95.5 | 78.4 | 85.6 | 80.9 | 109.7 |
| 24.22.2 | main | 95.6 [88-99] | 95.4 [95-96] | 78.4 | 85.4 | 80.8 | 108.6 |
| 24.22.2 | main + fix | **75.3 [75-75]** | 95.6 | 78.3 | 85.5 | 81.3 | 108.5 |
| 22.23.2 | 10-15 | 75.2 | 89.4 | 68.2 | 78.9 | 69.0 | 89.2 |
| 22.23.2 | main | 83.1 | 93.9 | 74.5 | 84.7 | 77.5 | 103.4 |
| 22.23.2 | main + fix | **70.3** | 93.5 | 74.7 | 84.5 | 77.4 | 103.3 |

\* The core is not under this budget; listed for completeness.

### macOS (arm64, 5 runs each)

| Node | Commit | master | viewers | search | edge | models |
|---|---|---|---|---|---|---|
| 24.22.2 | 10-15 | 81.3 | 102.3 [101-107] | 72.7 | 82.8 | 79.5 |
| 24.22.2 | 11-13 | 107.5 [102-112] | 104.5 | 79.2 | 88.0 | 86.6 |
| 24.22.2 | main | 108.6 [101-111] | 109.2 [105-110] | 79.2 | 87.8 | 86.6 |
| 24.22.2 | main + fix | **76.6 [77-77]** | 106.8 | 79.1 | 87.8 | 86.5 |
| 22.23.2 | 10-15 | 79.5 | 98.9 [95-100] | 67.0 | 77.4 | 72.0 |
| 22.23.2 | main | 90.0 | 101.0 | 72.6 | 83.6 | 79.0 |
| 22.23.2 | main + fix | **70.0** | 100.4 | 72.4 | 83.5 | 79.1 |

A bare Node process idles at 38 MiB on 22.23.2 and 43 MiB on 24.22.2 (macOS): Node 24 adds about 5 MiB to every
process, which is legitimate and not this fix's to recover.

## Cause: the master

Not the code the master loads: its own lean files are about 236 KiB (85 KiB on 10-15). On main its V8 heap is
11 MiB and its external memory 4 MiB, yet it is 115 MiB resident on macOS.

Before every process it starts (the core and each service, about seven at boot), the master checks that its lean
folder is still the one it started with (`harnessd/leanServices.ts` → `leanBundle.ts` `folderFingerprint`), which
hashes every file in it with `harnessd/reexec.ts` `sha256File`. `sha256File` allocates a fresh 64 KiB buffer per
file. The lean folder grew from 236 files (10-15) to 393 (main), so each check allocates about 25 MiB of buffers,
seven times over. They are freed, but the allocator does not hand the pages back, so the master's RSS stays at the
high-water mark, and how high depends on when collections happened to run: hence 88 to 100 on Linux and the
flaky failure.

Reusing one buffer for every hash brings the master to 75 MiB on Linux and 77 on macOS (Node 24), with no spread
between runs.

## Fix

- `sha256File` hashes through one module-level 64 KiB buffer instead of allocating one per call. It reads
  synchronously, so no two calls can share the buffer at once.
- A unit test that fails first: fingerprinting a folder of many files allocates no buffer per file
  (`harnessd/leanBundle.spec.ts` or `reexec.spec.ts`).
- The budget stays at 100 MiB. After the fix the highest lean process on Linux is viewers at 96 MiB (Node 24), and
  the master is at 75.

Outside the daemon core: `cli/src/harnessd/` is the master's.

## Not in this branch: viewers on macOS

Viewers on macOS has been over 100 MiB since at least 10-15 on Node 24 (102), and at it on Node 22 (99). It is not
a regression; `lean.e2e.ts` runs in CI only on Linux, where viewers is 95. Its extra cost over the other services
is the Store putting the release's own harnesses in place: importing the 1.5 MB asset module costs 6.7 MiB and
parsing and decoding its files another 12 MiB, and macOS keeps those pages resident after a collection (about
20 MiB; Linux about 17). It is a separate task (the Store preparing those harnesses in a short-lived process), and
the budget is not loosened for it.

## Verification

- The new unit test, red before the fix and green after; `npm run test:harnessd` at 100%.
- `cli/e2e/lean.e2e.ts` on Linux through the cli-e2e workflow (asked of the orchestrator before it runs).

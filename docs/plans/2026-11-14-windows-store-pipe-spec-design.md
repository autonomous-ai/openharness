# Store pipe spec reads node --test's TAP result

## Problem

`cli/src/lib/windows/storePackagesPipe.windows.spec.ts` runs the Store packages' named-pipe cases
(`store/tools/windows-pipe.test.mjs`) with `node --test` and then requires the TAP summary line `# fail 0` in stdout.
Since Node 23, `node --test` uses the `spec` reporter by default even when stdout is not a terminal, so it prints
`ℹ fail 0` instead. windows.yml runs Node 24.22.2, so the spec is red on both Windows jobs (x64 and arm64) although all
19 cases pass (runs 43158661612 on 2026-11-12 and 43557665371 on 2026-11-14, log: `expected '✔ harness-monitor: …' to
match /^# fail 0$/m`, then `ℹ tests 19`, `ℹ pass 19`, `ℹ fail 0`).

The cause is the spec, not the cases: it parses the human reporter's wording, which Node changed.

## Change

The spec passes `--test-reporter=tap` to `node --test`. TAP is a fixed machine format and Node's TAP reporter keeps the
`# fail <n>` summary line across versions, so the result no longer depends on which reporter is the default.

The check stays as strict:
- exit status 0, which `node --test` gives only when no case failed;
- the summary line `# fail 0`, unchanged.

Nothing else changes: no skip, no loosened match, no other file.

## Same cause elsewhere

A search of the repo for code that spawns `node --test` and reads its output (`'--test'`, `--test-reporter`,
`# fail`/`# pass`/`# tests`, `ℹ `, `node:test/reporters`, `run({ files })`) finds only this spec. The other spawns
(`store/tools/test-folders.test.mjs`, `os/tests/dsh/exercise.mjs`) read the exit status or save the output as a report
without parsing it, and the workflows that call `node --test` read the exit status. So this spec is the only one to fix.

## Test

The spec itself is the test. Red: the Windows jobs above, on the current base. Local proof of the cause on this Mac
(Node 23.11): the same command shape prints no `# fail` line by default and prints `# fail 0` with
`--test-reporter=tap`, and a fixture with one failing case prints `# fail 1` and exits non-zero, so a failing case still
fails the spec. Green: windows.yml on the branch head, the step "Contract suite against the real host, and the Windows CLI specs" on
both jobs, run only on the orchestrator's go. The steps after it and the `install` job have not run since 2026-11-02;
a red there for another cause is reported with its evidence and fixed as a task of its own, not on this branch.

## Platforms

Windows (x64, arm64) only: the spec runs only on `win32`. macOS and Linux are unaffected.

# Pre-merge validation — October 2, 2026

The Desktop 1.2.52 release workflow took 11m30s, but that excludes pre-merge work.
[PR #614](https://github.com/autonomous-ai/openharness/pull/614) and its
[validation record](2026-10-02-native-toolbar-updates.json) provide this clock:

| Phase | UTC | Elapsed |
| --- | --- | --- |
| Current-base validation phase | approximately 13:36–13:59:15 | approximately 23m15s |
| Validation record ready to PR created | 13:59:15–14:01:42 | 2m27s |
| PR open to merged | 14:01:42–14:02:38 | 56s |
| Merge to release trigger | 14:02:38–14:04:32 | 1m54s |
| Release trigger to completed workflow | 14:04:32–14:16:02 | 11m30s |

The PR has no GitHub review submissions or pending check runs. Its 56-second open
period does not measure review performed before opening it. The validation phase
includes result recording and performance measurements; per-command start/end
times were not preserved, so 23m15s is not a measured test execution duration.
The earlier 05:52–13:35 interval is unexplained in the handoff. Local task history
for this toolbar release was unavailable here; do not label that interval as
testing, review or idle time without additional evidence.

## Observed rework

- Of 196 affected unit/widget tests, 192 passed initially. A WebSocket runner-load
  failure prevented one file from loading; its four tests passed separately.
- Six of eight selected native journeys passed initially. Two contained obsolete
  expectations that Cmd-N retained a dismissed draft. #614 corrected those
  expectations and reran only those two journeys, retaining terminal assertions.
- The same day's [PR #604](https://github.com/autonomous-ai/openharness/pull/604)
  reported a validation-wrapper cleanup permission error after 116 Flutter tests
  and analysis had completed successfully. The preserved logs show 23 seconds of
  tests and 4.4 seconds of analysis, but that run has no completed receipt.
  Signaling an already-reaped process group could abort the runner before saving
  the successful results.

The toolbar PR already avoided another full suite after an unrelated rebase.
The remaining improvement is to make that evidence comparison explicit and
repeatable instead of reconstructing file fingerprints and rerunning by default.

## Changes

`scripts/validate-change.py --reuse RECEIPT` accepts prior passing evidence only
for checks with declared input and toolchain scopes. It compares source bytes,
new/deleted files, file modes, tool versions, executable, command, OS, environment
and runner implementation. Unrelated commits do not invalidate a scoped check.
Failed checks still run; independently passing checks can be reused. Original
timestamps and logs are retained and verified by hash, and reuse is labeled.
Missing evidence, unstable source and failed cleanup cannot count as passes.

Cleanup now checks whether an exited parent's group still exists before signaling
it. A live fixture child is still terminated. A real cleanup failure is recorded
with the check's result and log, rather than discarding the run's evidence.
Toolchain probes are also bounded and clean up their own process groups.

Scope remains a review responsibility. Reuse is for deterministic local checks
whose inputs are fully declared and dependencies installed from the matching lock.
Mutable services, real engines, hardware, visual inspection and host-sensitive
performance measurements need fresh evidence. See the
[validation guide](../validation-and-release.md#reuse-evidence-without-hiding-regressions).

## Verification

The process regression suite covers unchanged inputs across an unrelated commit,
source/toolchain/environment/command changes, new and deleted files, mixed
pass/failure results, modified/missing logs, changing source, blocked toolchains,
macOS cleanup errors, and child processes left by an exited parent.

The real Flutter trial runs 13 existing native-toolbar and status-menu unit
tests on Flutter 3.47.2 / Dart 3.13.2. Its first attempt correctly failed and saved
a receipt when this checkout had no dependency configuration. Dependencies were
then prepared from the existing local cache with the lockfile enforced.

| Trial | Result | Total runner time | Test command time |
| --- | --- | ---: | ---: |
| Execute selected Flutter tests | passed | 29.632s | 25.690s |
| Add unrelated documentation, then reuse the receipt | reused | 3.929s | no test execution |

The original log hash and timestamps were preserved. Source and toolchain checks
ran before and after both invocations. This is execution followed by evidence
reuse, not a controlled cold/warm benchmark. The [machine-readable record](2026-10-02-premerge-validation.json)
contains source fingerprints, commands, times and log hashes without environment
values or local absolute paths.

This removes repeat execution of unchanged checks; it does not shorten their
first run, skip required platform checks, or establish a new end-to-end release
duration. The next product release must still be timed from request to completion.

# Restart uses its latest observed process snapshot

Linux native validation of 2d18 reports an identity refusal after a replacement Codex has
already launched. The retained log does not identify the failed field, and one diagnostic
macOS run passes; neither establishes the Linux root cause. Source inspection nevertheless
shows a concrete stale-read bug in the shared pane swap used by restart, retarget and move.
It reads a process, waits for it to settle, reads it again, confirms the same pid/start, then
returns the first snapshot. Publication also checks the executable, which can change while
that same process starts. The resume path already returns the latest process snapshot.

Return the second snapshot when the existing pid/start check succeeds. Preserve the settle
interval, bounded backoff, exact publication check and refusal on a replacement pid/start.
Add no read, subprocess, delay, allocation, state, API or dependency. This is a stale snapshot
correction, not a claim that every Linux restart failure is resolved.

## Design

- Growth/concurrency/read cost: no new storage or work. The existing one swap per agent and
  its 8-second discovery budget remain. The same two reads produce the result.
- Scale/metrics: unchanged bounded discovery and named failure; no new polling or telemetry.
- Compatibility/migration/rollback: unchanged internal return type, wire and disk format.
  No migration. Rollback returns the earlier snapshot again.
- Audience/identity: unchanged owner and pid/start authority; final publication still checks
  the exact current process and executable. A changed pid/start starts a new settle interval.
- Failure: all existing cancellation, timeout and replacement refusals remain in force.
- Platforms: shared TypeScript affects macOS, Linux and Windows. Test the public swap result
  with a controlled clock, retain replacement/death cases, run affected core coverage and
  native restart checks. Native Windows remains deferred by the owner.

The new regression must fail before runtime changes because it receives the earlier
executable. Runtime work is identical (no new call or loop), so the performance argument is
structural; source review must confirm the one-line return-only change.

The new regression fails on the old return (`20261119T235237.990565Z-78855`, 1.3 s).
With the correction, 199 affected restart/retarget/move/swap cases pass, and the changed file
has 100% statements, branches, functions and lines; types pass in 46.2 s
(`20261119T235332.528850Z-79523`). Independent source review approves
(`20261119T235408.779110Z-80093`). Root also checks the pass-through: restartAgent returns the
wait result unchanged; restart and move use commitRelaunchedEngine; retarget compares its
current observation to outcome.processIdentity. Native validation remains separate.

## Design: distinguish a refused publication's evidence

The Linux failure's generic identity code cannot distinguish a failed probe, absent engine,
changed pid/start, or changed executable. Use the existing three-valued process lookup at
publication (the nullable wrapper calls the same function) and log one fixed code for each
refusal. Do not log the lookup's reason, process fields, path, caller input or message. Keep
the same throw, held pane and final authority check; add no retry or second probe. Storage,
compatibility, identity and platform rules above are unchanged. The existing publication
controls gain exact log assertions including secret-shaped fixture values and an unknown
probe case; all four refusal assertions must fail before the diagnostic change.

The four exact log assertions fail on the original runtime, with its original nullable mock
still present (`20261119T235650.863862Z-82525`); the success case passes. After changing the
runtime and removing that unused mock, 200 caller cases pass with 100% per-file coverage in
both restart.ts and swap.ts, and types pass (`20261119T235733.950739Z-83143`). Independent
review approves (`20261119T235813.535236Z-83664`). The final native bundle builds in 21.3 s.
Its 21-case macOS restart/update run passes 20, including the Linux shared-Codex restart case,
but fails restartIdentity before stopping the original engine: AGENT_CHANGED during launch
preparation. Receipt `20261119T235817.990108Z-83745` retains that separate race; the native suite
is failed, not accepted. Linux's earlier publication refusal and this new preparation race
remain to be resolved before release.

## Design: discovery names an unchanged permission mode

The eight-case native diagnostic reproduced four preparation refusals. Probes in the actual
separate core bundle identify only `permissionMode` changing in launch authority in each
failure (`20261120T001535.244108Z-15226`). Discovery fills a missing mode from live argv.
An approving launch without a named mode already uses exactly the engine's `auto` flags,
so filling that name changes the record, but not the launch that the authority protects.

Canonicalize only the missing mode of an approving session to `auto` when capturing and
checking launch authority. Retain the bypass field, lifecycle revision, cancellation and all
other identity fields. Explicit `full`, `ask` or another mode still revokes the authority;
an unnamed non-approving launch remains unnamed, because some engines give explicit Ask
different flags. This also covers older rows and other creation paths without a migration.

- Growth, concurrency and read cost: no stored data, new reads, waits or collections; one
  existing scalar in the bounded identity array gets its effective default.
- Scale and measures: the existing authority checks and named refusal remain. No telemetry
  or content enters logs. Measure the same fixed authority workload before and after.
- Compatibility, migration and rollback: no disk or wire change. Old rows work immediately;
  rollback restores the false refusal. The permission launch contract is unchanged.
- Audience and identity: the same owner, process, permission flags and lifecycle must remain
  current. The fix never grants a different mode or ignores a changed bypass bit.
- Failure and platforms: deterministic regressions cover missing/null backfill for Claude,
  Codex, Cursor and OpenCode against their real flag tables, plus actual mode/bypass changes.
  Shared TypeScript affects macOS, Linux and Windows; native Windows remains deferred.

All four new regressions fail on the old runtime, while the 24 existing controls pass
(`20261120T002110.043871Z-23209`, 1.5 s). Native acceptance uses the unchanged restart flow
and a fixed eight-case cohort with every result retained, without retrying failures.

The correction passes 192 affected cases with 100% per-file authority coverage and types
(`20261120T002304.312919Z-24837`). Independent review approves the source
(`20261120T002305.918650Z-24869`); follow-up contract tests enumerate every engine with
permission modes and compare the supported, unsupported and unknown flag paths. The
native implementation uses the same `permissionFlagToVerify` for both representations;
`DEFAULT_HARNESS_PERMISSION` is `auto`, and restart's swap passes the same effective flags.
The reviewed production bundle passes all 28 native macOS restart/update cases, including
all eight fixed race cases (`20261120T002304.917210Z-24853`, build 22.1 s, native 419.8 s).
The temporary cohort is retained outside the source tree and removed after the run.

A fixed ABBA then BAAB check workload retains all 1.6 million calls
(`20261120T003054.964321Z-48096`, 2.0 s). Explicit-auto CPU changes -1.51% / +0.18%; missing
approving mode +0.15% / +3.52%, at most 16.84 ns added per check. Wall changes are reported
separately (-4.25% / +3.58% missing; -0.68% / +0.21% explicit). This scalar normalization
runs during guarded launch preparation, adds no I/O, and does not run on idle/input paths.
These short isolated results do not establish whole-daemon performance equivalence and do
not clear any existing Resume or checkpoint holds. No repeated cohort or sample exclusion.

The final all-engine contract suite passes 196 affected cases, 100% authority coverage and
types (`20261120T003205.255412Z-49322`, 2.8 s and 7.0 s). Runtime bytes still match the
independently approved source and the 28-case native production bundle.

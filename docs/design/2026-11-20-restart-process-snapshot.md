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

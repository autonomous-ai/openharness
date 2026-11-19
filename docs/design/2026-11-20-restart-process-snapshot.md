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

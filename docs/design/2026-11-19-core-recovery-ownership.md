# Core recovery ownership

Linux run 44541245954 exposed a Codex reopen returning `AGENT_CHANGED` after the
terminal server died. Discovery removed the selected row while Resume was checking
its runtime. Background retirement must yield to Stop, Resume, Restart and Restore.
The independent correction review also found that input arriving after a restored
process is discovered, but before its launch is committed ready, bypasses the wait.

## Design

- Growth: no new stored data, jobs, queues or timers. Existing per-agent lifecycle
  ownership and the bounded input wait are reused.
- Concurrency: the foreground per-agent lifecycle owns retirement. Discovery checks
  ownership before side effects and carries it through archive/Registry publication.
  Input waits for the same launch revision, binding and token to become ready.
- Read cost: existing in-memory ownership lookups; no new file, process or network
  reads. Ready input keeps its existing path.
- Scale: constant work per affected agent. The paired startup/control/resume workload
  and input workload report CPU, memory and caller latency at the frozen final source.
- Compatibility: no wire, archive or Registry format changes; existing clients work.
- Migration and rollback: none; reverting the code restores prior behavior with no
  data conversion. Existing exact identity and archive publication checks remain.
- Audience: the daemon's existing authenticated control and terminal authority apply.
- Identity: no account or process identity is substituted or weakened.
- Failure: changed ownership refuses obsolete publication; restore timeout retains
  the existing visible error and never types into an uncommitted launch.
- Platforms: shared daemon code affects macOS, Linux and Windows. Validate macOS and
  Linux; the user explicitly deferred native Windows validation. No mobile changes.

## Validation

Add deterministic failing tests before implementation for retirement before and
during foreground takeover, and input arriving with an already discovered process.
Run discovery, forget, resume, restart, restore/input and architecture callers plus
types; run the native machine and Hermes cases with private homes and tmux servers.
Final per-file core coverage, exact-head gates and independent review follow once
all newly observed failures have been resolved. Keep failed evidence unchanged.

The six new cases failed against unchanged production code in receipt
`20261119T144146.762074Z-87118`. The affected caller checks and TypeScript then
passed in `20261119T144239.573087Z-88310` (99.2 seconds). Native validation and final
coverage remain pending; this does not resolve the separate Hermes Stop failure.

## Updater handover recovery

The independent review found that the old immutable updater can wait indefinitely
if its staged notification is lost. Keep the canary suppression, but bound that
wait: after 30 seconds, its next normal poll rechecks the pending version and live
digest under the existing stage lock and notifies the master again. It does not
download, run a canary or change the rollback copy. A successful notification ends
the poller as ordinary staging does. A stopped poller, rollback or changed pending
generation revokes that notification. This adds one in-memory timestamp, no stored
state, protocol change, new timer, account access or migration. The existing polling
interval bounds retry frequency, and the retry has a named log line. Validate the
red regression, updater callers and native hostile-update suite on macOS and Linux.

## Hermes native test ordering

Linux shard 1 failed at `agent_delete`, before resume. The test appended a fake
engine instruction to write a message and immediately requested Stop. Native-store
generation changes deliberately hold Stop before signalling (`databaseClose.spec.ts`
covers this). The resume test now waits for that message to appear in the retained
conversation before stopping. This is an observable state barrier, with the existing
30-second request/read deadline, and no command retry or sleep. Production Stop's
native identity, generation and signalling rules are unchanged.

## Review correction evidence

The handover reminder regression failed in `20261119T144744.310985Z-95419`; the
filesystem guidance assertion failed in `20261119T145102.104810Z-6285`.
All 291 updater, supervisor, artifact and database Stop caller tests passed in
`20261119T145147.198791Z-7226`. Its type check found a missing generic return in the
new test double; after correcting it, the three lock countercases and TypeScript
passed in `20261119T145313.212850Z-8788`. The failed receipt remains recorded.

The committed recovery candidate `4f9c9fdfe4` passed 15 private-daemon tests in
`20261119T144650.379377Z-93449`; four Linux sandbox cases were skipped on macOS.
That native receipt precedes the Hermes synchronization and updater corrections.
Native hostile-update and the corrected Hermes test still require validation.

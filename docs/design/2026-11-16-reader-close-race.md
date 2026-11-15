# Reader recovery during Close

Status: implemented; focused caller/stream tests pass, full required validation and native green pending.
Caller regression red on current main `cfd2db421438b6b886d29e376cf7e953c0a36b6c`.
This is separate from database storage extraction, on branch `codex/reader-close-recovery`.

## Failure

The fixed storage comparison inserted 40 MiB of new rows into an already followed Hermes conversation and immediately
asked to Close. Its reader emitted the whole new batch live. The worker correctly enforced its 32 MiB retained-event
limit, gave up the stream, and asked the core to rebuild it. Five of six runs failed Close after a real SIGTERM; the
same failure occurred on the controls parent and storage candidate. All six earlier warmups and idle windows passed.

The relevant source path is unchanged by storage extraction:

1. `otherStreams.gone` sets the reader's lost state through `held`, then schedules its existing one-second retry.
2. `main.ts` implements that callback through `registry.setIdentityHold`, which increments `evidenceRevision`.
3. Close captures that revision in `stopAgentService.bindingIdentity`, saves history and signals the original process.
4. The reader's retry clears its hold before reattachment. That changes `evidenceRevision` again.
5. Stop's unchanged binding guard refuses to complete after the process exits.

The retained timing fits this path: candidate 01-B lost its stream at 03:13:26.996, signalled at 03:13:27.773, and its
reader recovery was due at 03:13:27.996. Baseline 02-A lost it at 03:14:06.473, signalled at 03:14:07.018, and recovery
was due at 03:14:07.473. The logs do not record registry revisions or distinguish the three identical post-effect
refusals. Those details must be proved by the caller regression, not inferred as measured facts.

The deterministic caller regression ran once on Node 24.22.2 with one Vitest worker: one failed, 63 filtered, 1.52 s.
It returned the same `STOP_UNCONFIRMED` after one injected SIGTERM, with `evidenceRevision` changing from 1 to 2,
the reader hold cleared, and the captured native target unchanged. Evidence: `/tmp/reader-close-recovery-red.log`.
This proves the field mechanism at the caller boundary; it does not add revision observations to the earlier native
benchmark logs.

The existing other-stream test named "preserves Stop authority" covers ending a turn, not the agent Close operation.
The new caller test uses the actual Close service, Stop service, registry hold mutation and other-stream retry, with
fake time and injected native termination. It records the revision before and during recovery while proving the
process, executable, start marker, session, bound time, history path and terminal routes are unchanged. It expects
one signal, both checkpoints, the original terminal retired and `{ closed: true }`.

## Proposed runtime change

Keep every Stop authority check, native proof and `evidenceRevision` comparison intact. Optional reader recovery must
yield to the lifecycle operation that already owns this row. Discovery already observes the same reservation through
`binding.whileChanging`, wired to `lifecycle.stopJobs`; other-stream recovery currently bypasses it.

Give `createOtherStreams` access only to the existing Stop promise for an agent. While that promise is pending,
coalesce optional reader-health changes and reattachment into one deferred recovery for the session. Do not change
the registry's hold/revision during that reservation. This covers all writes through the optional-reader `held`
callback, including clearing a hold on a valid page, not only the retry timer that exposed the race. Do not defer
native identity evidence or native-store holds from event frames: those must still revoke an unsafe Close.

The entry captures the session's full pane/binding identity and worker generation. Success forgets the session and
cancels the entry. Failure releases the same existing recovery once, only if its captured binding and generation are
still current; rebuild from history to avoid accepting an obsolete reader result. A different binding, a forgotten
session or a disconnected generation discards it. If a newer Stop owns that same row, it owns the one pending entry.
No new retry attempt, extra timer, native probe, background poll or second lifecycle lock is introduced. Native Stop
never waits for the optional reader.

Merely skipping a timer or checking a deletion tombstone is insufficient: a failed Close would leave no reader
recovery. Merely deleting `evidenceRevision` from Stop would discard a real authority fence. Neither is proposed.

The existing `unopened` recovery map is bounded by `STREAMS_MAX` and each session has at most one continuation. Forget
and disconnect revoke its authority but keep a cancelled marker until the actual Stop promise settles, so repeated
forget/open or reconnect cannot accumulate callbacks on one Stop. A fresh observation of the same exact binding may
authorize that marker again. Shutdown clears the table and admits no more recovery. The continuation belongs to the
already bounded lifecycle operation, adds no wait
to that operation, and cannot commit after the reservation ends or changes without rechecking authority. The final
implementation must demonstrate cleanup on every failure path before it is accepted.

## Design

- Growth: in-memory recovery entry only, at most one per followed/closing session and `STREAMS_MAX` total. Forget and
  disconnect revoke authority; actual Stop settlement or shutdown removes the marker. No durable data is added.
- Concurrency: use the existing per-agent Stop promise and exact binding/generation fences. No native authority is
  suppressed, transferred to a replacement or reacquired from a worker reply.
- Read cost: constant-time map lookups on reader state transitions. No new idle work or inventory scan.
- Scale: preserve the current stream and retry bounds. Pending entries must never exceed admitted sessions; test the
  cap and cleanup. Existing reader failures and Close errors remain observable.
- Compatibility: no public protocol, checkpoint format or stored row changes. Existing client and older-master
  compatibility paths use the same core reservation behavior.
- Migration and rollback: no migration. Roll back the core change; retained histories remain in the same format.
- Audience: N/A because this changes no audience or externally readable data; existing local authorization remains.
- Identity: use the original daemon-owned binding and process; never another account's login.
- Failure: successful Close discards recovery; failed Close resumes it only for the same binding. Native evidence
  changes still return the existing refusal and leave replacement processes and terminals untouched.
- Platforms: core TypeScript runs on macOS, Linux and Windows. No new process-launch behavior. Caller tests on the
  pinned Node version; private macOS daemon acceptance and Linux CI; Windows native execution remains unverified
  unless separately run and must be stated as such.

## Verification, selected before execution

Run the new caller regression red before runtime edits. Then cover loss/recovery before capture, during each
checkpoint and after signalling; failed Close releasing recovery; successful Close forgetting it; replacement
bindings; a second Stop reservation; disconnect, forget and shutdown; native evidence changes still refusing Close.
Use fake clocks and explicit promises, not sleeps or repeated attempts to get a pass.

After implementation: affected caller/stream unit tests, typecheck, required core and resume coverage gates, and
private daemon acceptance with real SIGTERM and a controlled reader-recovery boundary. Reuse unrelated gates only
for unchanged sources. Compare transition cost and idle behavior on the same workload; do not claim a performance
result from the failed storage comparison.

## Separate benchmark correction

The storage workload measures historical data, not a new 40/400 MiB live burst. Before each data-size stage, Close
outside the timed phase, seed the same native session while stopped, then Resume outside the timed phase. Take the
private daemon-log cursor before Resume and await a new successful attach line for that exact agent/session, plus an
active public row with no hold. `agents_list` active and `session_get` alone do not prove live attachment finished.
Record readiness duration separately; no fixed settling sleep. Await the same completion between measured cycles
without changing the measured request-to-result interval.

Native acceptance uses a private Hermes whose exit is held after its real SIGTERM. The test kills only its owned
reader worker, waits for the core's disconnect observation, confirms the original engine is still alive, then releases
the exit. Frozen baseline `a7683cd2ed2fd24756e67d9c1f3bc9856f810f53` fails with the same post-effect
`STOP_UNCONFIRMED` (9.34 s, `/tmp/reader-close-native-red-v3.log`). Two earlier fixture-setup failures were retained:
missing tmux on the test PATH, then an invalid fresh-create attachment-log assumption. The corrected fixture first
uses an ordinary Close/Resume, a new completed attachment and a confirmed live turn before arming the fault.

Keep the same three 40 MiB cycles, one 400 MiB cycle, byte totals, row counts, SHA-256 checks, sampling cadence,
deadlines, process-set assertions and B,A,A,B,B,A order. Prove the corrected fixture against both frozen builds before
the entire fixed comparison. Retain every earlier failed attempt and identify this fixture correction explicitly.
The separate live-reader Close race remains a product defect, even if historical storage now measures cleanly.

`sampled()` currently loses a failed action's raw samples because it throws before returning and the phase is only
appended on success. Preserve each phase's bounded raw samples, requests and failure in `finally`, even if the final
process sample or derived deltas fail. A failed phase stays failed and is excluded from successful timing summaries.
Fix this evidence preservation before any future measurement; do not reconstruct samples the old runs discarded.

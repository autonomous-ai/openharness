# Keep queued input in the pane's write order

Native Browser validation on `15dedd3b` reproduced an existing input race: a
service's queued ready line and a person's message became one prompt. The pane
artifact records both strings joined, and both writes reported completion at
the same timestamp. `SessionInputController.drainNow` calls `inject` directly;
new submissions use `scheduleWrite`, so they cannot see the drained write.

## Design

- Growth/deletion: use the existing per-agent write chain and bounded input
  queue. No new store, timer, queue, limit or persisted data. Settled writes
  release their chain entry; agent cleanup removes its state as before.
- Concurrency: every queued write rejoins the same per-agent chain as a new
  submission. A person's message waits for the earlier paste and Enter to
  finish, without waiting for that message's model turn. Existing cancel,
  native-control and host-move checks remain in that chain.
- Read cost: no additional file, process or network read. The same current
  session lookup immediately precedes a scheduled write.
- Scale: unchanged bounded queues and one active write per agent; overlapping
  writes are a correctness failure, not extra capacity. Measure a matched
  serialized workload and retain the failing overlap control separately.
- Compatibility: public message and delivery contracts are unchanged on all
  clients and backends; no backend rollout order is required.
- Migration/rollback: no data migration; reverting restores the input race.
- Audience/identity: existing session resolution, terminal lease, process
  identity and caller checks are unchanged. No other account is used.
- Failure: the existing delivery/receipt outcomes and named errors remain.
  A failed write must still allow the next queued write to run.
- Platforms: shared TypeScript on macOS, Linux and Windows. Private native
  daemon validation runs locally on macOS; Linux/Windows evidence is separate.

## Validation selected before implementation

First add public-controller barriers covering a queued service delivery
released by turn end or a native-control release, and a queued person message
released by control. A later person's message must not start validation until
the earlier write completes. Record the failures on unchanged runtime, then
run the complete session-input suite and affected core input/cancel/control
tests plus TypeScript. Run the previously failing bundled Browser flow with
the runtime correction and keep the prior 20 passing native cases. Final
required gates, performance comparison, independent review and CI remain
required before merge.

## Local evidence

Independent review of the first correction found that a write waiting on the
promise chain was neither cancellable nor bounded, and could resolve the same
agent ID after `forget` into a replacement conversation. Direct submissions and
host-move/cancel holds share this cause. The corrected design uses the existing
`held` capacity tickets for pending writes, including their receipts and actual
UTF-8 bytes. Cancelled tickets retain capacity until their callbacks are
consumed, so repeated cancellation cannot grow an unbounded promise chain.
Immediate writes retain the existing fast path. `forget` settles and revokes
queued/held work; every delayed callback checks the captured input-state identity.
Legacy writes repeat that check after asynchronous preparation and never arm
confirmation against a replacement after a possible paste. No persisted or
public contract changes are needed. This intentionally removes the old test's
expectation that a forgotten person's message should still be typed.

Additional selected controls cover direct/drained cancellation and replacement,
move/cancel-held replacement, pending item/byte limits including cancelled
capacity, lifecycle changes during validation/paste, and progress after failure.

- The three barrier regressions fail on unchanged `f824010a`: a second write
  begins validation while the drained first write is still blocked. RED:
  `/tmp/core-input-drain-red.log` (3 failed, 122 unselected; 3.68 seconds).
- Routing the drain through `scheduleWrite` passes all 208 cases across
  session input, core input, device input and deliveries (8.01 seconds),
  including existing cancellation and host-move cases. GREEN:
  `/tmp/core-input-drain-green.log`; TypeScript:
  `/tmp/core-input-drain-types.log` (passed).
- The motivating bundled Browser run retains 20 passing native cases and
  the one combined-prompt failure: `/tmp/core-browser-15dedd-native.log`.
  Its failed fixture root was removed and a subsequent read-only command
  and working-directory census found no owned processes there. The native
  regression still needs to run against this correction.

- The first scheduling correction (`ae081733`) passed that previously failing
  bundled Browser flow (12.84 seconds; `/tmp/core-input-ae0817-native.log`).
  Independent review then reproduced the pending cancellation/replacement
  failures and stopped acceptance; its records remain in
  `/tmp/core-input-review-v1/`.
- The lifecycle controls fail in 11 cases on that first correction:
  `/tmp/core-input-lifecycle-red.log` (641 ms). The corrected full input selection
  passes 218 cases across four files in 5.35 seconds:
  `/tmp/core-input-lifecycle-green-final.log`. The intermediate run retained one
  failure because a disappeared agent no longer reported its error; that report
  is restored without notifying a replacement agent. Both logs are retained.

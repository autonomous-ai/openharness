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

## Ready-reader allocation correction

The fixed five-route ABBA comparison at `8848be2012` completed all 1.2 million
messages, but direct input used 17.095 versus 15.696 microseconds of CPU per
message. The other routes varied; this is not a claim that the lifecycle checks
alone explain that difference. The complete samples remain in
`/tmp/core-input-cost-v2/`.

Separate CPU and allocation profiles of the unchanged old/current modules
completed 100,000 direct messages each. They did not isolate the full CPU
difference. Both allocated about 23 MiB in `engineReady`, even though the reader
was ready on every call. A separate public-caller resource count found 23 Promise
resources per message on both sides. These diagnostic results, all child exits,
and the unchanged source hashes are in `/tmp/core-input-profile-v1/`.

Return synchronous `false` when the readiness probe has no startup promise;
await only an actual reader startup. That removes the ready path's Promise and
await continuation. Real startup waits keep their existing reporting, cleanup,
errors and revalidation. Every captured-state and current-row check stays at
its existing boundary. This changes no data, queue, authority, protocol, timer
or platform behavior. It reduces a measured allocation source; only the final
matched comparison can establish the resulting CPU and memory cost.

Before implementation, add a public-controller resource-count regression below
the measured 23-Promise path, with one successful receipt per message. Then run
the full input selection, TypeScript and preserved independent lifecycle
controls. Root coordinates review and a single final five-route ABBA run; no
acceptance timing overlaps other tests or builds.

The resource regression records 2,102 Promise resources for 100 messages on
unchanged `8848be2012`, against a budget of 2,002. Unlike the standalone
diagnostic, the test calls directly in its loop instead of adding an async
helper around each message. Vitest's asynchronous console capture is suppressed
in this allocation check, as in the performance fixture; initial fixture logs
are retained alongside the final RED at
`/tmp/core-input-ready-allocation-red-final.log`. The correction passes all 219
input/core input/device input/delivery cases in 5.38 seconds
(`/tmp/core-input-ready-green.log`), including startup failure and lifecycle
checks, and TypeScript passes (`/tmp/core-input-ready-types.log`).

## Pending-write allocation correction

The next fixed five-route comparison (`/tmp/core-input-cost-v3/`) completed all
1.2 million messages. Direct input was flat, but the two-message burst still
used 11.053 versus 10.369 microseconds of CPU per message. That remains a failed
cost comparison; the following diagnostic is not another acceptance run.

The exact old and `bbf757c2` modules were separately CPU/allocation-profiled on
100,000 successful bursts, with every child and outcome checked. The new pending
ticket path allocates a temporary combined queue in `refusedFull` (9.2 MiB
sampled), and an unused removed-elements array in `splice` (5.3 MiB sampled).
These profiles do not explain the whole CPU difference. Evidence is retained
in `/tmp/core-input-burst-profile-v1/` without overwriting earlier comparisons.

Count both existing bounded arrays directly, and compact held tickets in place
when they are consumed. This adds no state or collection and keeps order,
cancelled-ticket capacity, UTF-8 accounting and every lifecycle check. Apply the
same removal operation to pending writes and move/cancel holds. Public-caller
allocation counting records 500 standard array-result allocations for 100
successful bursts (501 inside Vitest's async scope); first add a regression with a 401-allocation budget, while
requiring all 200 submissions and receipts, then implement the correction.
The complete input selection and TypeScript validate behavior; root separately
reviews and coordinates the final matched cost comparison.

The regression is RED at 501 allocations (`/tmp/core-input-burst-allocation-red-final.log`)
and GREEN with the correction. All 220 input/core input/device input/delivery
tests pass in 5.40 seconds (`/tmp/core-input-burst-allocation-green.log`), and
TypeScript passes (`/tmp/core-input-burst-allocation-types.log`). A changed-source
allocation diagnostic records 1,035.90 MiB sampled versus 1,068.73 MiB at
`bbf757c2`; the discarded `splice` array site disappears and `refusedFull` falls
from 9.20 to 1.96 MiB. These sampled totals are not retained memory and do not
establish CPU acceptance. Its plan, exact artifact/source hashes and successful
200,000-message child are in `/tmp/core-input-burst-profile-v2/`.

The integrated-source V4 ABBA comparison completed all 1.2 million messages,
without retries or forced GC. Burst CPU remains 7.06% higher; the allocation
correction alone did not clear acceptance (`/tmp/core-input-cost-v4/summary.json`).
The burst profile also attributes allocation to Promise continuations, and every
write currently builds separate rejection and completion continuations even
though both outcomes only clear the same write slot. Join those outcomes in one
`then(clear, clear)` continuation, preserving the slot identity check and error
containment. Tighten the existing public ready-input resource regression by one
Promise per successful message before changing runtime code; existing failed
write, cancellation, replacement and bounded burst cases must continue to pass.
This changes no input ordering, authority, persisted state or capacity bound.

The ready-input caller produces 1,902 Promise resources before the correction;
the tightened 1,802 budget fails on that source and passes after joining the
settlement callbacks. The first attempted budget was still permissive and passed;
it is retained separately, not presented as RED. All 220 affected input cases
pass in 5.37 seconds, including progression after a failed write. Evidence:
`/tmp/core-input-settlement-red-final.log` and
`/tmp/core-input-settlement-green.log`. Final timing acceptance remains pending.

## Final integrated validation

On `50a3017d693f`, based on main `266e814cde3d`, independent review found no
remaining correctness issue. Six separate cancel/forget/move-hold controls pass.
The fresh native bundle passes all 13 input-safety cases and the formerly failing
Browser flow: 14 passed, six intentionally unselected, 156.84 seconds.

One frozen five-route ABBA comparison completed 1.2 million messages, with all
outcomes checked and all four children exiting successfully. No retry or forced
GC was used. Whole-workload wall time changed by -0.007%, CPU by +0.21%, and
peak RSS by +0.26 MiB. Individual CPU deltas were direct +3.44%, turn-service
-5.28%, control-service +5.37%, control-person -4.22%, and burst +2.20%
(10.378 to 10.606 microseconds/message). These mixed individual results remain
visible; the complete workload is effectively unchanged, rather than a claim
that every route improved. The coordinator accepts this measured total cost for
the ordering/capacity correction; earlier unsuccessful versions remain recorded.

Exact-source review, native artifact hashes, raw samples and process exits are
indexed by `/tmp/core-input-50a301-validation.json` (SHA-256
`a6823c2eb238a93c32435cd84bd69f1499d84c52dd9fcd9dbd9061ff96795771`).
The following change only records that evidence; runtime and test inputs remain
identical. Linux PR CI and merge remain separate from this local receipt.

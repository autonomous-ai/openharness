# Asynchronous checkpoint owner-journal waits

Review proposal only. No runtime code changed. Keep this separate from native route batching.

## Evidence and scope

The one completed actual Close/Resume CPU diagnostic identifies checkpoint journal durability on the
core's main thread. Across ten Close cycles, V8 fsync sample occupancy rises from 3.1036 to 4.0140 s;
that is occupancy including synchronous kernel wait, not function CPU. The stage has four owner-file
flushes per successful export: initial owner, assigned writer, settled writer and intended destination.
Its initial owner also requires a slot-directory flush. These are required durable transitions.

Move those five waits to Node's asynchronous fsync on the exact already-owned descriptors. Keep
small bounded open/stat/truncate/write and final rename/checks in their current owner. No new process,
worker capability, protocol message, source module, persistent cache or disk format. The engine worker
still receives only the core-selected history file and returns its bounded receipt; it gains no journal,
manifest, rename or deletion authority.

This pass deliberately retains the existing synchronous parent-directory flush after slot mkdir,
final cleanup directory flushes and SessionCheckpointStore's manifest/screen writes. An asynchronous
final rmdir-parent flush would free the physical slot before actual completion and needs additional
admission custody to avoid accumulating timed-out cleanup waits. This bounded owner-journal change
can reduce main-loop blocking without inventing that extra registry. Measure residual stalls before
separately reviewing those remaining waits; this is not a claim that all Close I/O is asynchronous.

## Design

- Storage: unchanged version-1 owner JSON, four fixed directories and the same history inode. Only the
  caller's original 30 s export deadline applies; no deadline extension or skipped durable transition.
- Bounds: one owner update in flight per stage, no queued owner updates. Overlapping writer/settled/
  publish calls fail closed rather than append a queue. At most four physical slots and therefore four
  such asynchronous operations exist; close retains its slot until each actual callback and descriptor
  close has settled. The one owner JSON snapshot is bounded by the existing 1 KiB format.
- State: capture an immutable next-owner snapshot at admission. Hold the actual owner-write promise
  separately from the bounded caller reply. Do not allow a later mutation to change the bytes written
  by an earlier operation. Preserve writer assignment before dispatch; preserve settled attestation
  before verification/publication; preserve destination intent before rename.
- Owner-file authority: retain directory identity, private single-link file/mode/uid checks, no-follow
  exclusive creation, exact opened-file identity, pre-truncate route checks and post-flush route checks.
  Capture descriptor version after the bounded write and recheck it after asynchronous fsync as well:
  the new await must not allow same-inode byte/mode mutation to pass merely because the key survived.
- Initial directory authority: retain owner file fsync followed by creation-only directory fsync.
  Open that directory with no-follow/directory flags, bind the descriptor to the known slot key, keep
  it alive through its actual fsync callback, then recheck the slot and owner before acknowledgement.
  Windows still skips directory fsync under the existing directorySyncSupported contract.
- Descriptor custody: the original owner descriptor closes exactly once, only after fsync callback
  settles. A reply timeout never closes/recycles it. Reuse secureState's existing close custody guard;
  an uncertain close keeps the operation/slot unavailable and is never retried on a recycled integer.
- Ordering: owner updates reject overlap, including while an earlier caller has timed out but its
  actual fsync still runs. A failed completed destination update may be explicitly retried as today,
  performing the whole checked write+flush again; no automatic retry or overlapping retry is added.
- Revocation: public stage methods admit work only while the stage is open and within its original
  deadline. Recheck current after awaited journal completion before writer dispatch, verification,
  descriptor-close continuation or publication. The late operation may complete its own durability
  and identity checks but can neither dispatch a writer nor rename after close/deadline revokes it.
- Cleanup: close marks the stage closed synchronously, then waits for the actual owner journal promise,
  verification and history descriptor close. Its existing bounded reply may end earlier, while its
  continuation retains ownership. A live/unsettled writer still reserves the slot. Cleanup and startup
  recovery remain conservative on any uncertain file, close, attestation or crashed cleanup marker.
- Compatibility: ExportOwnership.settled becomes Promise<void>, a core-only callback that never crosses
  IPC. Await it inside createEngineStorage's existing bounded admitted export operation, and recheck
  its current/deadline afterward. Wire protocol version, worker/old-client compatibility and disk data
  remain unchanged. Existing mock exporters must await settled too.
- Failure: existing CHECKPOINT_STAGE_TIMEOUT, STAGE_OPERATION_TIMEOUT and STAGE_CLEANUP_UNAVAILABLE
  paths remain; no content/path identifiers are added to logs. User's preceding checkpoint remains
  intact on every failure. No migration, retention change, backend deployment or new setting.
- Platforms: portable Node TypeScript; macOS native validation plus Linux final CI. Native Windows is
  deferred by user, with directory-flush skip semantics retained and covered structurally.

## Exact runtime files

1. cli/src/lib/checkpointStages.ts: callback fsync helper/custody, owned bounded asynchronous journal,
   awaited initialization, writer/settled/publish transitions, raw operation drain before close.
2. cli/src/engines/worker/storageProtocol.ts: only settled(): Promise<void> callback typing.
3. cli/src/core/engines/storage.ts: await durable settlement within the existing admitted/deadline
   scope, keep all captured worker lifetime/source and active/current fences.

No new architecture closure entry. No general secureState or registry write rewrite.

## RED and safety controls before runtime

Use controllable fsync callbacks over real private files/descriptors, never sleeps. An explicit
setImmediate/event-loop turn must progress while an owner flush is held; a synchronous flush trap
on an owner file makes the old implementation fail promptly rather than block the test runner.
Actual callback release remains under the fixture's control and is drained before cleanup.

1. Initial, writer, settled and destination journal flushes are asynchronous, preserve ordering and
   leave the event loop available. Owner creation still flushes file before its directory; updates
   flush the owner file only. No writer call or rename occurs until its durability completes.
2. Held owner fsync past the original deadline rejects the reply while descriptor remains open and
   its physical slot remains charged. A second update refuses; close cannot unlink/recycle it.
   Release the original callback exactly once, prove final identity/current checks, then exact close.
3. Close during held writer/settled/destination fsync cannot produce late dispatch, late rename or
   deletion while an actual callback still owns a descriptor. Keep an unsettled writer's slot.
4. Change owner inode, same-inode bytes/mode/link count or slot ancestor while a file/directory flush
   is held: refuse acknowledgement and preserve unrelated files. Existing before-open/after-open/
   after-sync tests remain, adapted to await real settlement rather than removing assertions.
5. Synchronous dispatch throw, callback error and descriptor-close uncertainty retain safe custody;
   an explicit destination retry only after actual failure settled performs its full flush again.
6. Storage export cannot return a receipt while settlement is held. Its original timeout rejects;
   a late settlement result is not returned, no new dispatch occurs, aggregate work stays bounded.
7. Existing crash recovery remains: dead core+live writer, missing/malformed attestation, crashed
   cleanup marker, rename-before-manifest uncommitted/committed/replaced histories, four slots.

Run focused actual RED first. After review/runtime correction: checkpoint stage/durability/store,
SQLite/database Close/OpenClaw and storage transport suites; 100% per-file coverage for changed
core/engines/storage.ts, selected coverage for checkpointStages, architecture/types, and matched
native Close/Resume validation under root's exclusive timing window. Pick exact checks before run.
The existing frozen V5 hold remains until a final combined matched workload passes.

## Prepared source review packet

The actual runtime is still unchanged. The three-file proposed patch is retained at
`/tmp/core-checkpoint-journal-runtime.patch`; the new callback-controlled caller fixtures are in
`checkpointStages.async.spec.ts` and `core/engines/storage.spec.ts`. Existing journal crash/durability
and mock exporters now await the core-only settlement callback, with their assertions retained.

Close cannot await itself: it sets `closed` before its first suspension, captures/drains `ownerWrite`,
and then drains verification/history close. `ownerWrite` owns only its file/directory callbacks and
exact synchronous descriptor closes; it never calls or awaits stage.close. Each public writer,
settled and publish continuation checks current after the bounded write completes. A publication
captured before close therefore fails its current check before rename even when its disk wait succeeds.
The Close-during-writer/settled/destination tests hold the actual callbacks and require close to settle
only after release, with no late publication or deletion of a live writer's stage.

Planned first RED executes only five main-loop/caller durability cases and the two storage settlement
cases. No test, build or benchmark for this checkpoint patch has been run yet. Full source and runtime
review precede the exclusive execution release; no source gate or performance acceptance is claimed.

## Destination overlap fence

Review found that a completed destination journal write alone is not the whole publication: the
history descriptor may still be closing. A second publish must not change the durable destination
while the first operation can still rename. Retain one raw publication promise through owner write,
actual descriptor close and rename; reject overlap without a queue. Writer, settled and verification
admissions also refuse while publication owns that transition. Clear the fence only when the actual
work settles, so an explicit retry after a completed callback failure still performs the entire write.
Close drains that promise too. Its descriptor-close dependency never calls stage.close, so the wait
graph remains acyclic. A new held-history-close RED demands second-publication refusal and the first
intent remaining unchanged; it will fail on the original runtime before correction.

## Actual RED before runtime

At clean `bab40380d4`, all eight selected cases fail as intended. Five journal operations hit the
synchronous-fsync trap; the held history-close case admits a second publication; storage returns
receipts before settlement and accepts the four pending settlements instead of timing them out.
No timeout or unexpected harness failure occurs. Receipt:
`.harness/validation/20261118T210804.400032Z-57354/receipt.json` (1.2 s + 0.7 s, actual exit 1).
The reviewed runtime patch SHA `cca38744d9203531c65478baf8cf9d4854ac62e349dd1c90533af6a4f450ff89`
follows this captured RED; targeted GREEN and all 19 new controls are next.


## First targeted GREEN and fixture identity correction

At clean `3bd27c5a31`, seven of eight targeted cases pass. The initial-directory case's close-count
assertion fails because it counts reused descriptor integers, including a later proof's separate open.
Receipt `.harness/validation/20261118T210853.259025Z-58363/receipt.json` retains this failure (actual
exit 1, no timeout). The fixture now assigns each open a monotonic identity and counts that exact
open's close; the no-close-before-actual-callback guard remains. Runtime is unchanged. The planned
all-19 control pass includes the same eight cases, so it also supplies their corrected GREEN result.

## New controls GREEN

At clean `d19d9a101a`, all 19 new controls pass, including all eight previous RED cases. The stage
file runs 17 controls in 2.5 seconds; storage's two controls run in 0.7 seconds. Receipt:
`.harness/validation/20261118T210953.902607Z-59437/receipt.json` (actual exit 0, no timeout, unchanged
source). Fixtures drain the actual file callbacks and history closes before removing private roots.
The initial failed close-count receipt remains above. Broader validation is prepared but not run:
10 affected journal/store/Close/secure-state/storage files, changed core storage at 100% per-file,
checkpoint helper coverage, architecture and types. Native timing remains pending.

## First broader gate

At clean `66b46815ab`, all 10 selected files pass 199 cases with two platform skips (42.3 seconds).
Architecture passes (6.1 seconds), and types pass (42.2 seconds). The gate still fails its required
core-file coverage: storage has 100% lines/functions but 98.55% statements and 98.11% branches,
with only the final outward receipt refusal unexercised. The retained receipt is
`.harness/validation/20261118T211221.791480Z-61943/receipt.json`. The checkpoint helper reports
99.44% lines, 95.27% statements, 91.97% branches and 97.82% functions; no 100% claim is made for it.

A new controlled-clock case expires the original deadline between settlement's admitted continuation
and outward receipt delivery. It preserves and exercises the final current fence. Runtime and
coverage thresholds stay unchanged. Only affected storage coverage and test typing need follow-up;
the other successful source gates remain evidence for the unchanged runtime.

## Source acceptance

At clean `aad5b70e28`, all 20 storage cases pass (0.9 seconds), covering 69/69 statements, 53/53
branches, 12/12 functions and 46/46 lines in the changed core file. Types pass (6.7 seconds).
Receipt `.harness/validation/20261118T211854.198630Z-68983/receipt.json` records actual exit 0
and unchanged source. Together with the unchanged other nine suites, the selected evidence covers
200 passing cases and two platform skips; architecture also remains passed. All 20 new controls
are exercised. This is source acceptance only: native Close/Resume measurement and the independent
full V5 cost hold are still pending. No remaining synchronous cleanup or manifest flush is removed.


## Fixed native Close/Resume comparison

The macOS A/B/B/A comparison completed with pinned Node24.22.2 and the retained native process-image
helper. A=`bab40380d4`, B=`3bd27c5a31`: exactly three runtime files differ, plus ten Design lines that
record the earlier RED. The first freeze incorrectly asserted three total source files and stopped
before writing inputs; its source and actual outcome (printed assertion, idle owned metadata process,
exact-command SIGTERM and exit143) remain retained. The corrected provenance pins both runtime3 and
full-source4 explicitly. No runtime, workload or completed build changed to fix that metadata.

The original ten syntax checks and fixture typing pass in
`.harness/validation/20261118T215251.644819Z-11088/receipt.json`; the two metadata syntax follow-ups
pass in `.harness/validation/20261118T215709.391045Z-17557/receipt.json`. Both owned builds pass with
actual exit0/EOF/guardian/group/environment cleanup: A bundle `9bd4b885...`, B `f042839b...`.

Final input `/tmp/core-checkpoint-journal-close-resume-v1/inputs.json` SHA:
`9c5233ce96175e425c0f192b2d3504eb147fc46c39ace1c0984767e15f03038a`.
Output `/tmp/core-checkpoint-journal-close-resume-v1-abba` passes all four fixed arms, each with two
preparation and eight measured Close/Resume/native-confirmation cycles and twenty delivered turns.
Preparation cycles stay in whole-workload counters. There is no dropped cycle, extra warm-up or retry.
Root independently verifies all 1,169 frozen inputs, four reports, 80 PIDs and eight groups gone.
Manifest SHA `89b8a5f57aa17db6f6418d08d7c0795e66ce3a091b027ead9059751b2fe6b0cb`.

The added measurement is exactly forty ordered raw points around Close and Resume requests plus one
10 ms whole-workload event-loop histogram. It leaves original confirmation/GC/RSS probes intact and
wraps no product filesystem operation. Raw CPU includes endpoint transport and incidental core work.
The loop histogram covers all cycle work, not Close-only or a particular fsync; GC wall time is not CPU.

| Arm | Whole core CPU ms | Whole main CPU ms | Ten Closes core CPU ms | Whole-loop p99 ms | Whole elapsed s |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1-A-resume | 3843.31 | 2264.81 | 1106.90 | 23.806 | 97.569 |
| 2-B-resume | 3850.93 | 2280.17 | 1110.83 | 12.861 | 98.373 |
| 3-B-resume | 3611.93 | 2117.78 | 1054.74 | 19.808 | 83.120 |
| 4-A-resume | 3772.25 | 2233.52 | 1008.67 | 22.839 | 97.661 |

Two-arm side medians show whole core CPU 3807.78→3731.43 ms (-2.01%) and main CPU
2249.16→2198.97 ms (-2.23%). Close CPU increases: core 1057.78→1082.78 ms (+2.36%) and main
633.01→650.87 ms (+2.82%). Total Close caller time is essentially unchanged, 13.489→13.499 seconds.
Whole-loop p99 improves 23.323→16.335 ms (-29.96%); p95 remains about 12.165 ms, while maximum delay
changes 108.003→102.990 ms. Every raw arm remains included, including the shorter third arm's natural
discovery interval. The whole elapsed median changes -7.04%, without claiming statistical significance
or attributing natural polling variation to the journal correction.

The bounded evidence supports better loop-tail responsiveness with slightly higher Close CPU, not a
guaranteed CPU or caller-latency reduction. Raw review is retained at
`/tmp/core-checkpoint-journal-close-resume-v1-cost-review.json` (SHA
`63b7e54e1ff2316ce6d8dc26d97ba842b93e9c969bde10c17aea50d8f020653a`). Remaining synchronous
parent-slot, cleanup and manifest flushes are unchanged. No broad follow-on async rewrite or extra
measurement follows from these four arms. The independent full V5 and final integrated input/Resume
acceptance remain separate.


## Design: one completed publication per stage

A source review found an inherited internal API edge: after a successful publish(A), another call can
rewrite durable intent to B before failing because history.tmp was consumed. SessionCheckpointStore
is the only product consumer; it acquires a local stage per save, awaits verification, publishes once,
and closes in finally. That call chain cannot reach this edge. It adds no native performance hold.

Complete the existing two-way operation exclusion by refusing publish while verification is pending.
Consume the verified proof synchronously after rename succeeds. Both changes are needed: a second
verification using an earlier completed proof could otherwise finish after publish and restore it.
There is no new state, queue, callback, process, API or disk format. Failed flush/authority/rename
attempts retain explicit retry; successful publication cannot rewrite its destination intent.
The four physical slots and existing deadline/descriptor custody remain unchanged on every platform.
Rollback restores the prior API behavior; no data migration or stored-field change is required.

Three exact API REDs cover same/different repeated destinations and a held actual second verification
while an earlier proof exists. Each must refuse before another journal open or authority callback;
the original intent remains and removes the correct uncommitted orphan. The held verification is
released and drained before cleanup, then ordinary publication must still succeed. Existing actual
failed-flush retry and held-close overlap controls follow in GREEN, then the three stage suites.
No broader filesystem rewrite, timeout change or extra performance measurement is part of this fix.

## Publication proof RED and GREEN

At clean test/Design source `c31f9a8dc6`, all three selected cases fail as intended (1.2 seconds):
the same destination opens six additional descriptors, a different destination replaces the durable
intent, and publication succeeds while the second real verification is held. Receipt:
`.harness/validation/20261118T222326.739561Z-54731/receipt.json`, actual exit 1 without timeout.

Runtime-only commit `813d47434d` adds the pending-verification guard and consumes the successful proof.
All five selected controls then pass (1.4 seconds), including failed-flush retry and held-close overlap:
`.harness/validation/20261118T222355.348990Z-55195/receipt.json`. The three complete stage suites pass
45/45 cases (6.7 seconds): `.harness/validation/20261118T222412.054903Z-55568/receipt.json`.
Both GREEN receipts record actual exit 0, one worker and unchanged source. No additional typing,
coverage, benchmark or broader suite was run for this approved narrow follow-up. Frozen comparison
sources and all measured evidence remain unchanged; root owns final integrated input/Resume validation.


## Design: remove repeated verification after an owner update

The complete ABBA and mirrored BAAB pin/lease comparisons retain a CPU hold. The mirrored
run reports system CPU +5.98% for 64 KiB and +9.42% for 4 MiB. An untimed four-publication
API trace shows two verifier call sites; source inspection confirms that the calls are immediate
after every update flush.
No await, callback or mutation separates those calls once the owner filename is durable.
The trace counts Node filesystem API invocations, not operating-system syscalls or CPU time.
It contains one publication per side at each size; each publication performs four owner writes
(initial, writer, settled, destination). Counts are reported separately for each side and size.

Keep the final owner/directory proof after every file flush. On initial creation, also keep the
proof before the awaited directory flush and the proof after it. On subsequent writer,
settled and destination updates, omit only the duplicate verifier that has no intervening
operation. Keep nonce rereads, history pinning, cleanup locking and all durability operations.

This changes no stored or exposed data, format, audience, identity, compatibility contract,
queue, limit, process or retry. Growth, migration and read amplification outside the fixed
publication are unchanged. Concurrency still fences every asynchronous boundary; failures
retain their existing named refusal and reservation. Rollback restores duplicate reads only.
The shared TypeScript path affects macOS, Linux and Windows; native Windows remains deferred
by the owner. Validation covers each public owner transition, the existing replacement and
flush fault cases, and a scoped cost comparison before performance acceptance.

The three new public-lease cost cases fail before the correction: writer and settled perform
two post-flush directory proofs instead of one, and destination performs three instead of two
(the second is its post-descriptor-close publication proof). Receipt
`20261119T232229.242686Z-47761` retains the failures; no original timing samples are discarded.


The descriptor-count assertions run on POSIX: Windows checks the directory with `statSync`
and its native root proof instead. Initial-owner and destination-owner replacement controls
also protect the retained checks and publication authority. The four stage suites pass 59
cases, the three caller suites pass 110, and types pass (receipts
`20261119T232314.884655Z-48461` and `20261119T232429.228631Z-49623`). The final durability
file passes all 19 cases after the two extra safety controls (`20261119T232602.623506Z-51043`).
Independent review approves the runtime correction and final tests; measured CPU acceptance
remains open. No prior failed or noisy timing result is relabeled or discarded.

## Design: read the owner through its existing descriptor

The next fixed ABBA/BAAB comparison retains a total/system CPU hold at both payload sizes.
Its complete 512 cycles remain evidence; first-cycle JIT differences do not establish a CPU
improvement. The filesystem trace and source identify three owner updates per publication
that each reopen a file already held and checked by the writer, solely to inspect its lease.

On POSIX, open the owner read/write and read its existing contents through that descriptor.
Read at explicit positions so the subsequent write still starts at zero. Allocate no more
than the existing 1 KiB owner limit, complete bounded short reads, refuse premature EOF,
and compare private-file facts and descriptor version before and after reading. Parse the
same owner schema and require the same random lease before writing or truncating. Keep all
filename/directory identity checks, flushes, post-flush proofs and cleanup generation pins.
Windows retains its existing write descriptor and secure path reader: that reader also proves
native root containment, and Windows write opens can change ctime.

There is no new data, cache, API, process, queue, retry or runtime dependency. Four slots and
one in-flight update per slot remain the concurrency/growth bounds. Read work stays bounded
to one 1 KiB owner, with at most 1,024 positive reads. Authority remains this account's private
file and the exact live lease. Failure retains the existing named refusal and reservation;
rollback restores the extra read descriptor, without migration or compatibility changes.
macOS and Linux use the change; Windows keeps its established path (native validation deferred
by the owner). Tests first demonstrate the extra open and exercise short/failed/changed reads,
then run all stage and caller tests, types, independent review and the same cost workload.

All seven new POSIX cases fail on the previous runtime; the three malformed/oversize controls
already pass (`20261119T234522.145034Z-71553`, 1.5 s). After the correction, all eight affected
stage/caller suites pass 181 cases in 25.4 s and TypeScript passes in 47.1 s
(`20261119T234621.989101Z-72458`). Independent review approves the unchanged runtime/tests
(`20261119T234658.525833Z-73101`). Generation tests already cover a preexisting changed lease;
durability cases retain opened-path replacement and post-flush refusal coverage. These are source
and safety results only. The next fixed scoped cost comparison remains required.

## Design: keep the verified owner handle during a reservation

The retained V7 comparison still holds CPU acceptance. A separate fixed 64-publication
Node API interval diagnostic (`20261120T003836.191274Z-55543`, 17.6 s) puts the required
hard link at about 0.58–0.63 ms of main-thread CPU per publication, against about 0.21 ms
for the rename it replaces. Nested and asynchronous intervals are not additive syscall
costs, and this is attribution evidence, not a new acceptance run. The inode pin, random
lease, no-overwrite publication and all durability checks remain mandatory.

On POSIX, keep the owner journal's first verified read/write descriptor until the lease closes, including after publication. This eliminates the three later owner
opens and closes. Keep every directory/path/key/mode/link-count/version and nonce/schema
check before each update, the bounded read, every file/directory flush and every check
after a flush. The retained handle pins only the journal's inode; the existing history
hard link still provides durable crash-recovery authority.

A retained descriptor must never append an owner update. Write the existing serialized
owner from offset zero with positioned writes, handling short writes and refusing a zero
write, then truncate to the exact byte length as before. Owner data is bounded by the
existing schema: fixed fields, safe-integer pids, 32 hex lease characters and the bounded
history basename. Windows retains the existing per-update write-only open, native
contained path reader and writeFileSync path.

- Growth: at most four additional open descriptors, one per existing reservation. No new
  file, index, journal entry, timer, worker or persistent state.
- Concurrency: the existing ownerWrite gate serializes writes. Closing first revokes new
  operations and waits for the actual outstanding fsync callbacks, publication and
  verification before closing. A caller timeout is never proof that the callback finished.
- Cleanup: close the retained owner descriptor in a finally around the stage descriptor's
  actual close during lease cleanup or failed acquisition, including a failed initial owner
  write or failed stage close. Clear the
  saved descriptor before closeStateFileDescriptor so an uncertain close is never retried;
  its existing global custody latch prevents reuse. A close failure leaves the slot reserved
  and latches uncertain custody; a completed publication remains valid, but cleanup does not
  proceed. The existing cached stage close still serves publish and lease close. Owner close
  has one lifetime end, guarded by the cached cleanup promise and closed lease.
- Read cost and scale: the bounded owner read and all proofs remain per update. Only
  repeated open/close calls are removed. Capacity remains four, including unsettled writers.
- Compatibility, migration and rollback: version-two owner bytes and public/internal APIs
  are unchanged; no migration. Rollback returns to per-update descriptor opens.
- Audience and identity: no new authority, login, content, log or telemetry. A path, inode,
  lease, mode, link count or version change must still refuse before publication.
- Failure: existing named cleanup/custody failures remain; zero writes fail explicitly.
  All descriptor closure paths must have deterministic tests, including held callbacks.
- Platforms: this optimization applies on macOS/Linux only. Windows code keeps its native
  containment and per-update lifetime. Native Windows remains deferred by the owner.

Validation is selected before implementation: RED tests show repeated owner opens and
prove the desired lifetime; short/zero writes, failed initial writes and uncertain/held
closes exercise custody. Run all checkpoint stage, publication, Hermes Stop and grid
callers, types and relevant per-file coverage. Review the exact source independently.
Only a changed, accepted implementation may get a new fixed comparison using the frozen
V7 observer method; no further observer change or discarded samples is allowed.

Independent design review (`20261120T004315.893418Z-60202`) found that closing the owner
at publication would make later explicit retries leak a reopened handle through the cached
stage-close promise. Adopt its simpler amendment: retain only until lease close. A refused
link/authority check can retry on the same owner handle, and settled() after publication uses
that same handle. No released/unopened handle state machine or new fallback is introduced.
The behavior change on an uncertain owner close is explicit: it surfaces at lease cleanup,
which logs the named refusal and retains the slot, rather than failing an earlier update.
Fresh fstat, path proofs and nonce rereads remain mandatory on every write.

The first six new lifetime/write tests fail against unchanged runtime
(`20261120T004445.905857Z-61818`, 1.2 s). Amend the tests to the reviewed lease-close lifetime,
add explicit publish-refusal retry and post-publication settled cases, and update the existing
fault injectors before runtime implementation so no protection silently stops being tested.

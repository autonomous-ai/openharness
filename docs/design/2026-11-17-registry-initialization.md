# Registry startup native proof

## Design

Reviewed by the integration coordinator before runtime changes, 2026-11-17.

Source: 261b6da207eea03f07f7a3acbe24c48cf52fe5ab in
/tmp/harness-registry-startup-native-proof.

Evidence and exact scope
The accepted diagnostic is /tmp/registry-residual-b3ac-run3/manifest.json,
source b3ac09ec336918852c0a353bd5992e3a8cb32772, Node 24.22.2, macOS x64.
8-growth-same-1600/result.json: 1,600 rows, 1,816,861 image bytes, one bounded
Codex header per row. load.native-proof-and-row-build = 455.846 ms;
load.proof-recheck = 254.394 ms; 48,047 lstatSync calls; load loop maximum
829.956 ms. This is instrumented attribution, not a performance acceptance
number or a production capacity limit. Cleanup passed. TranscriptBindings,
NativeFiles, NativePaths, NativeHeader and engineHomes are unchanged from that
source to 261b. Registry's load still uses the same proof/build/recheck chain.

Only product callers: core/main.ts runForeground and cli.ts standalone status.
The separate registryDirectoryClose fixture also calls load. There are 39
CLI files with direct registry.load calls, primarily tests. All move to one
awaited load API; no synchronous compatibility implementation is retained.

Existing helpers and the important constraint
NativePaths.resolve already performs asynchronous ancestry lookup using the
same generator as resolveSync. descriptorHeader performs asynchronous first
read and returns a synchronous verification function. readPrivateRegistryFile
already provides asynchronous secure state reading and handle cleanup.
Neither existing native helper removes the final synchronous header, inode,
pathname/alias and deadline fences. NativeFiles also includes parent repair,
complete directory enumeration and negative-candidate evidence. Introducing
another generic worker or duplicate authority implementation is unnecessary.

Proposed boundary, explicitly requiring root acceptance
Make load asynchronous and yield between rows, never within one row's native
proof/verification/private commit. Each row obtains fresh savedTranscriptEvidence
and its exact verify calls in one no-yield operation, then
commits the accepted row to a private initialization map. It is not authority
to type into a terminal. Existing control and revalidate paths still earn fresh
authority when used. Original operation-wide catalog/root evidence is retained
and verified at final installation; a changed home/alias/ancestor restores the
original binding and its identityHold for every dependent row.
The root guard uses NativePaths.retain(), preserving the original route facts
but earning a fresh verification budget. The old NativeFiles work budget must
not span all row yields. Each row's own budget and final fences stay unchanged.
EngineHomeSnapshot.verify already rereads the catalog when invoked; one original
catalog snapshot remains operation-wide, avoiding per-row catalog reconstruction.

This deliberately changes the commitment boundary from one whole-image native
proof to independent row commitments behind an initialization barrier. A leaf
changed after its row commitment is a post-commit native change, not evidence
that will be claimed fresh at final whole-image installation. Merely awaiting
between first proofs while retaining the final all-row verification loop would
leave the measured 254 ms hold. Omitting that loop without defining this row
commit boundary would weaken the existing contract and is not proposed.

Admission, installation and durability
load owns a single initialization Promise; an overlapping load joins it rather
than clearing staged state. Existing public mutation entry points already call
writer.assertOpen; replace these with one Registry assertion that additionally
rejects mutations during initialization before any live row changes. The load
body uses private installation/persistence operations. No partial staged map is
installed, no onEnter notification runs for an incomplete image, and no queue
of public mutations waits for startup. While previously admitted writes drain,
readers retain the previous complete view so those writers can finish their own
guards. Once private initialization begins, public read methods reject until
the complete map passes global row/schema/identity invariants and required
load migration writes settle. Private persistence uses the private map directly,
not public read APIs. This prevents even a direct module caller from observing
an authoritative intermediate image. A sequential explicit reload remains
supported after the prior initialization settles; it first settles previously
admitted writes and closes new admission for the duration of the reload.

core/main awaits load before its existing awaited transaction marking restored
locators dormant; hook/local/backend admission remains later in runForeground.
The private index install therefore precedes the dormant transaction, as today;
the design does not claim otherwise. Readiness follows both awaited barriers.
Standalone status awaits load and its durable flush before printing/exiting.
load-time migration persistence is awaited and errors cannot be converted to a
successful readiness barrier. Boot/own-modes markers must follow the successful
required write, so an interruption cannot mark an incomplete migration done.
No new disk record, version, datastore, queue, service, dependency or switch.
Current and last-30-day readers/writers retain the same top-level array, row
schema, file paths, private modes, mkdir/owner.json exclusion and backup format.
Rollback is the previous binary reading those same bytes. The original image,
including retired fields, remains the pre-v2 backup; asynchronous preparation
must not quarantine or back up a different peer image after the read.

The private map is installed only as a whole. The existing three-way persistence
merge and same mkdir/owner.json lock remain responsible for external hook/peer
writes. Startup native repairs are ordinary changes relative to the original
persisted baseline, never unconditional intended fields; a newer durable owner
wins the existing conflict rules. The merged map is globally validated again.
Tests must prove a peer binding, new row, close-plan cancellation and stolen
process/runtime owner are not overwritten by a startup repair or dormant save.
Duplicate identities in the source or resulting repaired map retain the existing
quarantine/hold behavior; no row is dropped merely to shorten startup.
Quarantine takes that same writer lock, compares the exact original bytes again,
checks its lock ownership and renames without yielding. A different peer image
is left in place and initialization rejects with RegistryPersistenceUnavailable;
it does not report a successful empty view over that valid newer image. The exclusive pre-v2
backup still contains the original image captured before any row yield.

Failures, cancellation and ownership
Native evidence failure retains the original row binding with identityHold,
as today, including expiry, missing/changed catalog, replaced pathname/inode,
alias replacement, changed header, or ambiguous/incomplete parent repair.
Each row gets its own fresh NativeEvidenceBudget after the yield; an expired
proof is never revived. Native file handles/iterators close before the row
commit and before yielding. Secure state reading awaits actual handle cleanup.
flush({exiting:true}) seals public mutation admission immediately, waits for
the initialization settlement, then uses the existing writer finish barrier.
No listener/data-folder ownership is released while required durable work is
unsettled. Abrupt process death owns no async native child/worker to orphan.
An initialization failure does not expose a partially prepared map or enqueue
an empty snapshot that could erase the persisted image. Unknown schemas remain
read-only and corrupt input keeps the existing quarantine behavior.

Explicit residuals and limits of this increment
This removes the all-row native-proof/recheck loop hold. One bounded native
operation still uses synchronous final fences; pathological parent-repair pools
can use the existing 4096-entry / 64-candidate / 3-second limits. This proposal
does not claim a hard sub-millisecond startup bound. It introduces no guessed
new numerical limit. Parent-repair work must be represented in focused checks
and the remaining synchronous per-row cost must be visible in measurement.

The file still has no finite production byte/row bound. The original secure
whole-image read is retained in this task; its measured read+decode was 6.6 ms.
Full JSON.parse,
schema passes, baseline fingerprints, normalization, final invariant validation,
persisted serialization and retained live/staged/baseline images scale with all
existing rows. Reusing async read later would avoid synchronous file I/O but
would not solve JSON parse or memory growth. These remain separate measured work, with no silent
cap, eviction, hidden rows, schema migration or new datastore in this task.

Selected RED tests before runtime edits
1. Pause at the inter-row turn; observe a real scheduled callback, zero partial
   onEnter publication, rejected public reads and mutation before change.
2. Replaced original leaf/alias/ancestor, changed/missing catalog, differing or
   delegated header, incomplete parent candidate and expired evidence: no new
   binding authority; original preserved/held. A row commit has no intervening
   await between proof creation, final verification and private installation.
   A leaf changed after its private row commitment is refused by the unchanged
   later effect/revalidation path; staged data grants no lasting native authority.
3. Malformed/duplicate later row cannot expose an accepted earlier row. All rows
   survive a normal 1,600-row startup, with no production cap inferred.
4. Concurrent durable peer changes during a yield survive startup migration and
   dormant publication, including owner theft and close-plan cancellation.
5. Delayed/rejected migration write keeps load/readiness/status unsettled or
   failed; migration markers cannot precede durability. Exit waits actual init
   and writer cleanup. A second load joins rather than racing the first.
6. Existing migrations, boot handling, names, unknown schema, corruption,
   native binding/parent repair, file security and directory-close tests stay.

Platforms and checks
Runtime affects macOS/Linux/Windows. NativePaths platform rules and current
state-file ownership/ACL rules remain unchanged; no new child-process or window
behavior. Focused Registry/native-binding tests and TypeScript are author-owned.
Root schedules broader affected tests, native standalone-status/no-master
readiness and shutdown checks, and fixed uninstrumented before/after workloads
on the same 16/160/1600-row fixtures/toolchain. Report wall/CPU/main-thread/loop
and RSS, including startup yields, migration writes and cleanup, not only time
inside the awaited call. Native Linux/Windows claims require actual execution.

## Data checklist

1. Growth: existing agent create/update/close/delete, restart restoration,
   migration and rollback behavior stays. No new record, archive, expiry,
   deletion or cap. Full-image growth remains unresolved.
2. Concurrency: local mutation admission, private row commitments and final
   original-root/catalog guards; existing whole-image exclusion and three-way
   merges retain peer changes. Quarantine takes the same lock.
3. Read cost: one whole image plus bounded native evidence per row; the recorded
   1600-row image is 1,816,861 bytes. No new network response or reader.
4. Scale: 1600 is ten times the 160-row diagnostic, not a known production limit.
   Loop delay, CPU and peak RSS are the measurements; image growth remains open.
5. Compatibility: two product callers await initialization; direct test, fixture
   and diagnostic callers use the same API. No stored/wire field changes; current
   and last-30-day binaries read the same bytes and use the same exclusion.
6. Migration/rollback: original exclusive pre-v2 backup stays; required writes
   precede markers and readiness. The previous binary needs no conversion.
   Native status/readiness restore checks are assigned to the coordinator.
7. Audience: same local API predicates, private state directory and files.
   Staged rows cannot be read through Registry admission.
8. Identity: same OS owner and native inode/path/alias checks. No additional
   process, credential, account or impersonation path.
9. Failure: unavailable native evidence retains bindings with identityHold;
   persistence/changed-peer uncertainty rejects initialization. Unknown schemas
   and non-quarantinable corruption retain existing read-only behavior.
10. Platforms: macOS, Linux and Windows, with their existing native path and
    file-security rules. This machine supplies macOS evidence only.

## Author validation, 17 November

The four initial admission/settlement regressions failed on the unchanged
implementation: load returned synchronously rather than an initialization
barrier. `/tmp/registry-startup-native-proof-red.log`, actual exit 1.

The native-access focused run passed 68 tests in four files (initialization,
binding, homes and transcriptBindings), actual exit 0, 12.91 s:
`/tmp/registry-startup-native-proof-focused-2.log`. An earlier sandbox run failed
at the writer lock's process probe with `spawn EPERM`; its 31 failures and one
timeout are retained in `focused-1.log`, not claimed as behavior regressions.

The selected caller run passed 285 tests in seven files (Registry, quarantine,
admission, observation, persistence, fingerprints and startup order), actual
exit 0, 84.63 s: `/tmp/registry-startup-native-proof-callers-1.log`.
TypeScript passed with actual exit 0 in `types-2.log` after correcting the Windows
native fixture's awaited load to run in beforeAll. These are author checks on
macOS with Node 24.22.2; combined gates, independent review, native lifecycle
acceptance and matched performance remain coordinator-owned.

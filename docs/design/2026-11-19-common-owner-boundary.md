# One presentation for session owners

## Design

The session core currently retains raw Cloud provider rows and derives their public frames, activity and turn
readers. Replace that retained view with one admitted common facts record. Native sessions derive the same
facts at their existing read boundaries; Registry rows, transcript/terminal controllers and native lifetimes
remain authoritative and are not copied into an additional cache. This continues the daemon-core extraction,
not a new component capability or public feature.

Data originates in the native Registry/delegates or in the authenticated component that owns a declared
factory. Component provider normalization and rendering rules stay in `lib/cloudAgents.ts`, reachable by
Cloud/CLI only. Core retains identity/name/dates, generic lifecycle/activity/turn facts, and bounded opaque
app/display JSON. It interprets no provider state, repository format, Cloud prefix, completion policy or maker
status. Fixed common serialization supplies ordinary null/default fields for native and service sessions.

The flat service record is its detached app object with private non-enumerable common slots. It has no second
raw/presentation view. Missing app and explicitly empty app remain distinguishable; only the latter needs a
private marker. Existing nonempty app keys establish presence without another slot. Reserved authority keys,
prototype keys, custom descriptors/iterators, proxies, cycles and nonfinite values are refused before retention.
Opaque app names `app`, `work` and `turn` do not collide with private common slots. Native frame parts remain
the final fenced read after ordinary native fields, with their existing Registry/session checks.

Every owner has one existing private incarnation token, preserved only while id/factory/createdAt stay
continuously present. Native admission uses the reviewed existing Registry onEnter seam to revoke both agent
and session alias tokens before fallible question-close effects. Native retirement never revives that token.
No extra identity, revocation, receipt, history or provider map is introduced. A service cannot borrow a native
conversation id or advertise a native terminal route; service sessionId is absent or its own id and its terminal
is absent/default-unavailable. Native facts preserve their actual sessionId and terminal data.

## Staged admission and ordering

The existing service_query/ACK channel carries `session_owner_begin`, `append`, `end`, `cancel`, `checkpoint`,
`ask` and `unask`. Each call is bound by composition to its exact service/physical connection. Inline hosting
uses the existing stopOwner identity/predicate installed before the constructor and revoked before stop or
failure. Components receive only that bound door, never a binder or a way to supply their own authority.

Begin includes the fixed facts format, a transfer id, factory, expected before/after fingerprints and count.
Even an empty catalogue must name a factory belonging to the current authenticated service, through the
existing immutable factory lookup shared with native creation. One provisional stage is allowed globally.
Append accepts at most256 rows and1MiB including its local request envelope headroom. It checks consecutive
ordinals, exact current authority, detached semantic facts, native/owner conflicts, duplicate ids, cards and
logical charges. There is one absolute ten-second deadline in each side of the transfer; append never extends
it. No more than one publication query is unresolved. Expired/failed transfers retain their truthful failure,
never retry automatically, and drop provisional data without changing accepted owners.

End checks the complete count, independently computed canonical after hash, same accepted Map, current link
and current nonrevoked token/native absence for every replacement row. It installs the complete accepted Map
before ordered effects: each changed row then its card, followed by removed-owner question closes/deletions.
Only the calling service's rows can be replaced or removed. Other declared owners keep their records by
reference. A revoked omitted row can be discarded but cannot emit a native deletion, stale question close or
completion; current checkpoint still refuses to expose its revoked authority. Takeover before begin and during
append are both covered, separately for retained versus intentionally omitted rows.

A broadcast failure after Map installation returns SERVICE_UNAVAILABLE. The accepted Map remains complete,
so lost-ACK recovery can prove the exact result rather than replaying a partial catalogue. No client send is an
admission success shortcut. Unknown/malformed/oversized input changes no accepted state or output. The fixed
256-row refusal is tested with257 rows before any stage mutation, followed by valid continuation.

## Durable component state and recovery

Cloud keeps its current provider file format and bounded transition journal. Journal version2 changes its
image fingerprint to the common facts domain; its per-owner transition identity remains component-owned raw
normalization metadata. The component captures detached normalized rows once. In particular it no longer
reattaches the caller's mutable raw.card object. A later provider mutation cannot alter a queued capture or a
chunk still to be sent. Each chunk builds common facts from that same immutable capture; it does not normalize
or clone the provider again, and does not keep a second full encoded catalogue.

The after hash is derived synchronously from the capture, while the before hash is the last acknowledged or
reconciled image. Provider state plus pending intent is written atomically BEFORE begin or any first await.
Only a successful actual intent write counts as the existing synchronous combined-save fast path. Failure
uses the exact pre-attempt journal fallback; queued/disconnected/question/held paths still save provider state
before append. Optimistic provider state remains excluded. No ACK-only write or normal checkpoint read is added.
The frozen connected workload retains the source-derived96-write expectation, subject to actual final counts.

Crash before end leaves accepted-before authoritative; crash/lost ACK after end can match durable pending-after.
Accepted-before match wins when hashes are equal, including empty/same-image ambiguity. Readback happens only
on recovery. Current nonempty core plus unknown/corrupt/unmatched journal remains the named visible Cloud hold.
Ordinary reconnect cannot clear it by deleting core rows. Existing explicit `harness start --restart` establishes
empty core and allows quiet reconstruction from intact provider sessions, discarding only invalid presentation
metadata. Unknown/corrupt provider sessions are never deleted or guessed. Whole-cohort rollback uses the same
explicit restart; a version1 publisher cannot interpret version2 metadata against retained authority.

## Compatibility and bounds

Private worker contract7 coordinates the staged protocol, captured common rename facts and tuple source
`service` replacing `cloud`. Existing header2/tuple element values/order, public presence/null semantics, public
array/event order, meaningful authority hashes, saved native/provider formats, native operation controllers and
public successful results remain. One canonical public object property order is used; public consumers parse
JSON and no durable/signature identity depends on public frame property order. Real checkpoint/question hashes
keep their explicit versioned order. Generic fallback copy is now “Agents are not running here. Try again in a
moment.”; existing SERVICE_UNAVAILABLE/ANSWER_FAILED error codes and shapes are unchanged.

Raw card absent/null/content while said=null has an identical complete public view. The component keeps its
latest raw card for the next actual turn, but core sends no redundant agent_synced for those invisible changes.
This intentional event suppression is recorded in the final matched-cost workload. No core raw hash or component
signal is added solely to recreate that redundant event.

Question ids and prepared question fields now use common session semantics: there is no Cloud request-id prefix
rule in core. Cloud still constructs its own existing ids, clipped text and choices. Captured rename requests
carry fixed common facts rather than raw provider rows. Component callers and exact private-key guards cover
that migration. Detached card captures preserve bytes, not the former alias to the provider's mutable object.
Tests await observable staged completion where the old one-call fixture applied synchronously; this does not
add an ACK-only provider write, a core cache, or a timing acceptance claim.

Original component content admission remains192KiB per normalized row and6MiB−4096 per catalogue, plus its
existing6MiB complete raw publication/cards check. Fixed common logical limits are conservative images of that
old-valid domain:36,554 owners;18,071,668 encoded facts bytes;321,513 objects;1,179,711 properties including all
reserved revocation flags;120,046 array slots. Per-row common facts are at most224KiB by the separately reviewed
R+32KiB proof, keeping existing512KiB rename input and256KiB complete reply guards. Cards are separately charged
at their existing6MiB byte ceiling and at most3objects/12properties per admitted owner, with no array slots.

These are logical admission bounds, NOT heap-byte estimates or a larger provider quota. The frozen38,880-shape
proof uses joint old catalogue bytes and maxima503/175,9/176,32/176 and8/419 respectively. A minimum normalized
row of171 bytes gives floor((6,287,360−1)/172)=36,554; the35,132-row base36 allocation recipe is only a sample of
distinct ids. The exact source proof and frozen receipts are referenced in the checkpoint evidence below.
Current accepted data, one provisional Map/cards and the current bounded input chunk are separately charged;
there is no second permanent presentation. Native retained rows remain zero. Fixed32-level JSON depth covers
all old-valid prepared shapes while bounding arbitrary opaque input traversal.

## Validation and acceptance

Actual caller REDs precede the replacement: Cloud remains in core eager closure; invisible card changes emit
three redundant row syncs; a queued normalized card changes when its provider mutates the raw object. Seven
near192KiB rename cases (eleven requests) preserve escaped fields, longer names, captured values and owner/link
fences. Additional controls cover actual native/service constructors and the old-valid coefficient relationship,
strict JSON/semantic boundaries, missing/empty/nonempty app round trips, private-slot mutation isolation,
257-row refusal, atomic hash/native/link rejection, post-install broadcast failure, staged crash/readback,
held append mutation, physical reconnect versus provider restart, ordered questions/cards,96writes and0writes
for unchanged retained reconnect. Existing native collision/retire/peer-import/recovery/preload evidence remains.

Final acceptance still requires selected source coverage/types and eager closure, independent runtime review,
the combined packaged cohort/restart/rollback controls, and matched CPU/latency/retained/overlap costs. Removing
feature policy is not a claim of speed improvement. The measured flat model is the implementation candidate;
no additional representation-model iteration or112/224MiB product budget is authorized. Mac execution is the
current platform gate; Windows execution is deferred by the user and mobile is excluded.

## Checkpoint evidence

* Clean c14bea913779 baseline: receipt20261118T222224.045582Z-53673, expected2behavior failures,7rename positives
  andtypesPASS, source clean/unchanged, private roots and executable groups settled.
* Card capture RED: receipt20261118T224046.782335Z-76886, one actual caller failure with unchanged runtime:
  original “First” recap became the later raw mutation while queued; private root/groups settled.
* Frozen capacity source: `/tmp/harness-core-owner-flat-allocation-20261119/{capacity.ts,capacity.md,recipes.ts}`;
  actual proof result `/tmp/core-owner-flat-allocation-controls-20261119/controls.json`, independently verified.
  Numeric derivation and transient-card accounting: `/tmp/core-cloud-common-owner-bound-accounting-20261119.md`.
  The ten-arm flat accepted/overlap packet remains immutable and does not itself accept product performance.
* First migration receipt `20261118T230136.376001Z-99754`: architecture 38, actual native formatter 31,
  card hashes 13 and near-limit rename 7 passed. One response fixture still supplied the removed raw shape;
  a missing brace prevented the new stage suite/types from loading. Preserved as fixture failures, never REDs.
* Corrected receipt `20261118T230232.536357Z-1348`: 19 of 22 cases passed; three stage fixture assumptions
  (idempotent foreign cancel, explicitly cancelling a refused append, and an actually exceeded byte budget)
  were corrected. Types identified the identical `OwnerCard` interface-to-type change plus stale test types.
* Migrated receipt `20261118T230650.954887Z-5635`: 409 of 443 cases passed across 23 files; full types passed.
  The 34 remaining failures identified captured-facts/checkpoint/latch/connection-identity fixture migrations.
  The fixture now revokes its physical authority on disconnect and binds a fresh identity on reconnect, as
  actual `serviceLinks` does. No new production semantic correction followed those fixture failures.
* Focused receipt `20261118T231248.253909Z-12681`: 109 queue/recovery/service/inline-host cases and eight
  named affected caller cases passed, followed by full types. This includes held-append provider mutation,
  old-journal hold versus empty-core reconstruction, exact provider-write fault controls, native revocation,
  missing/empty/opaque app round trips and final host-stop fences. Private roots and process groups settled.
* The actual default eager graph is 502 files and 80,638 source lines: +4 files and +115 lines against this
  branch's unchanged baseline. Cloud's 256-line provider module leaves that closure; shared bounded owner
  admission replaces it. This is feature-policy removal, not a net source-size reduction.
* Per-file coverage, combined contract-7 packaged cohort/restart/rollback, and final matched product cost
  acceptance remain open. The parent integration owns later overlapping `api.ts`/`main.ts` changes.
* Initial scoped coverage receipt `20261118T231507.685277Z-15750`: all 411 cases across 22 files passed;
  the command failed only its explicit per-file coverage thresholds. Its immutable report is preserved at
  `/tmp/core-cloud-common-owner-coverage-initial-20261119` with the 15 covered runtime source hashes.
* Narrow supplement receipt `20261118T232417.307598Z-25988`: 208 cases across 11 files, one existing
  named API caller, and full types passed. This covers two declared services preserving each other's
  accepted rows, joint count/authority accounting, expired stages before timer delivery, refused transfer
  recovery, optional facts/app validation, current adapter envelopes and existing native/Create callers.
  No runtime changed after the independently reviewed follow-up delta.
* Hash-pinned Istanbul merge `/tmp/core-cloud-common-owner-merged-coverage-20261119.json` proves 13 of
  15 scoped files at 100% statements/branches/functions/lines. All 15 have 100% lines/functions.
  `sessionOwnerStage.ts` remains 95.53% statements / 96.61% branches and `sessionOwners.ts` remains
  99.19% statements / 99.34% branches; the required per-file gate is therefore still open, not waived.
  Remaining paths are synchronous final authority/accepted-map rechecks after pure validation, an
  undeclared factory in an already admitted retained owner, and an old cancelled stage timer. The current
  immutable lookup, sole accepted-map owner and non-yielding validator cannot cause these states through
  an actual caller. Tests do not synthesize an nth-call authority flip merely to satisfy counters.
  The frozen merge inputs and uncovered statement/branch locations remain available for source review.

## Absolute deadline follow-up (RED, before correction)

Actual bound append/end checks in receipt `20261118T232823.566100Z-30527` both returned success after
real hash work crossed the stage's monotonic expiry. The event loop cannot deliver an expiry timer
while synchronous validation/hash work runs. Each test calls the original `Hash.update`, then advances
only the clock to the deadline; it does not sleep, change hash output, or count authority calls.
This is an actual deadline defect, not an unreachable coverage branch. Proposed correction reuses
`active()` after chunk hashing and immediately before end commits, retaining exact physical-link,
service/transfer, native incarnation and hash admission. Provider/pending journal/write ordering stays
unchanged. The earlier complete source checkpoint's deadline acceptance is superseded by this RED.

Source review proves accepted-map identity cannot change while a stage exists: its sole production
owner installs a replacement only from `commit`, after the stager has called `drop`. Other services
cannot begin while that stage exists, native claims only revoke existing private tokens, and the
synchronous JSON validator rejects callbacks/accessors/proxies without running them. No artificial
replacement `rows()` callback is used to reach this impossible branch. Any simplification remains
subject to runtime review; current physical authority and native token fences are independent.

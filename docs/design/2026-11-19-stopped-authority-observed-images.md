# Bind stopped authority to the images actually read

## Design

This is the next correctness slice of Grid credential custody, based on combined `b8b29dee43`.
The available-only catalog checkpoint is separate and stays frozen for the pending-index comparison.
No observation cache is used by this action-authority path. Performance acceptance remains held.

`queryStopped` currently takes an initial whole-archive metadata witness, reads exact private images
under a directory descriptor for each bounded page, and takes the final whole-archive witness. The
parent supplies a separate synchronous `current()` witness immediately before an action. All those
fences remain required. The initial and final metadata digests contain the stable directory identity
and every `.json` name/full ten-field identity; directory mtime/ctime bracket each individual metadata
scan but are not included in the returned digest, so unrelated temporary files do not self-revoke it.

The confirmed gap is between those scans. If directory A is moved aside before a page opens, B can
provide different row bytes under its own valid page descriptor. Restoring A after that page closes,
before the final metadata scan, may leave both archive witnesses equal even though the returned
matches/selected rows came from B. A negative conflict answer has no selected-row proof to repair that
gap: the actual caller RED sees `matches: false` and `current(): true` despite A containing that
conversation. The selected-owner RED also returns B's metadata with `current(): true`.

## Approved first correctness change

Bind the graph observed by the query to its archive witness. Share the existing commutative metadata
accumulator with the child, keeping bounded scratch state: stable directory identity, `.json` count
and the sum of name/full-identity hashes. Each ordinary archive contributes the exact identity from
the private image proof that supplied its parsed row. This proof already binds its bytes, descriptor,
pathname, owner/mode, size/EOF and raw digest. No second parse, retained raw image, timestamp cache,
new durable file, or unbounded path/stat table is introduced.

`exceptAgentId` still contributes its pathname metadata because it belongs to the authority domain,
although its content remains intentionally excluded. Non-JSON entries remain outside the digest but
inside the existing considered-entry count and deadline. Invalid names, missing images, unreadable or
malformed authority rows, incomplete iteration and uncertain directory close retain named refusal.
Every bounded page retains its present directory admission/close custody and five-second request bound.

Before replying, require the observed-image digest to equal the final full child witness. Retain the
initial witness comparison for the first correctness checkpoint, so this change does not silently alter
the existing refusal when a row changes before its byte read. The parent final `current()` scan remains
unchanged. In particular, no successful reply can mix B's row bytes with A's returned authority witness.
Source/image digests are private equality proofs and never enter logs or public frames.

Concretely, factor the existing filesystem scan behind its unchanged `stoppedArchiveWitness()` wrapper.
The scan can also return the stable directory identity observed inside its successful full-version
bracket, after actual iterator close. A new child-only consumer `observeStoppedArchive()` obtains that
same initial witness and a fresh bounded accumulator derived from that proved directory identity.
Both use one digest implementation; the query adds each real proof's name/identity, or fresh lstat
identity for its excluded record, then compares its accumulator with the original and final witnesses.
The parent continues calling the unchanged string-returning wrapper. No extra authority data crosses IPC.

Removing the duplicate initial metadata pass is a separate possible optimization, not approved runtime
work in this Design. An observed-image digest plus final full witness can prove a coherent current
graph, but it may accept a rewrite completed before that row was read where the old initial snapshot
would refuse. That exact behavioral difference needs review before removing the initial scan. The
correctness fix is required even if it adds hashing or yields no speed gain; no new cost claim is made.

## Failure-first caller and controls

Use a real required storage child, exact private source entry/hash, and private archive roots. Inject
only the filesystem boundary: after the query opens its directory iterator (following the initial
witness), move A aside and put B at the same pathname; restore A after the page/iterator closes and
before the final witness. Check that the original witness and original disk rows are restored. Exercise
the production parent `SessionStorage.stoppedQuery()` and its actual `current()` closure, not a synthetic
replacement for that closure.

The RED selection asks both for a conversation absent only from B, and for selected owner metadata that
differs only in B. Safe behavior is a fixed `changed` refusal; failure output records only booleans and
counts. No credential values are needed. Controls cover excluded-id metadata, non-JSON entries, complete
multi-page enumeration, and normal stable queries. After review, add before/after-read in-place changes,
missing/renamed files, unrecovered directory replacement, deadline/entry limits and close uncertainty.

The exact final child witness and parent final witness are preserved. The main residuals remain O(record
count) fresh action reads and final metadata work; the earlier instrumented repeated-authority profile
attributes 4,800 child file lstats and 4,802 child hashes at 1,600 rows, plus the parent final scan. The
first correctness patch may add an observed-image hash pass. Any later reduction must retain the graph
binding proven here and receive a separately reviewed matched artifact comparison.

macOS source tests use private homes/data and actual child settlement. Windows behavior follows the
same portable metadata contract; native Windows validation remains explicitly deferred.

## Data-design checklist

1. Growth: only per-query counters, a directory identity and a 256-bit sum are added; they leave on
   success, refusal, cancellation or child reap. No records, archive retention, expiry or purge change.
2. Concurrency: keep the parent global storage write lease, existing writer locks, child page descriptors,
   original/final archive witnesses and the caller's final `current()` fence. Late legacy writers remain
   possible; no POSIX whole-folder exclusion is assumed.
3. Read cost: actions still read every relevant archive's exact bytes, with excluded-id metadata only.
   At 1,600 rows the first fix adds one bounded hash per JSON row; it removes no existing read. Removals
   change the final witness or cause `changed`. The display-only catalog remains separate.
4. Scale: preserve 64 considered entries per child page, 16,384 total entries, five-second request
   custody and 50 ms per metadata scan. The prior 16/160/1,600 comparison and syscall counts are retained;
   authority wall/CPU and deadline refusals warn first. No new performance acceptance is claimed.
5. Compatibility: wire/public frames and stored fields are unchanged. `stoppedAgents.query()` serves
   handoffDependencies, handoffDiscovery, keepAbandonedConversation, purgeAgentService and the restore
   composition; `selectConversations()` serves conversationOwners. They retain the same answer shape,
   selected-row proofs and final fences. The new behavior is refusal of inconsistent observed graphs.
6. Migration/rollback: no data migration or production restore is needed because no stored representation
   changes. Complete-cohort rollback remains old-readable for the explicit release-dated compatibility
   window; rolling private workers remain bound to their selected same-build image. Old builds retain
   this known query gap, so this correctness fix is required for release acceptance.
7. Audience: required storage stays under the existing owner/private-directory admission. New values
   are private equality state only; no new API data, notifications, shares, terminal content or logs.
8. Identity: no action changes identity or credentials; same owned session/storage child, never another
   person's login. Missing or changed owner/path authority refuses under existing rules.
9. Failure: fixed `changed`, `invalid`, `unsafe`, `expired` or cleanup/disconnect categories reach current
   callers. A failed graph cannot authorize an action; close uncertainty remains held until actual reap.
   No partial success, automatic effect replay or new silent retry is introduced.
10. Platforms: portable daemon TypeScript on macOS/Linux/Windows; macOS real-child evidence here, native
    Windows validation deferred explicitly. No mobile or web code changes.

## Captured RED

`/tmp/core-grid-storage-authority-red1-20261119.log` and its receipt record actual exit 1 in 1.569 s:
the two graph-mismatch cases fail as expected, and excluded-id/non-JSON and complete-page controls pass.
The original witness is restored in both failures. PID/process group 29326 settled with no timeout or
cleanup signal; each real storage child was closed before its private root was removed. Runtime remained
unchanged at `b8b29dee43`. The coordinator reviewed this Design and approved the correctness-only fix,
retaining the initial scan; performance changes remain separate.

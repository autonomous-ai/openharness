# One observed archive graph plus a fresh final witness

## Design — approved for implementation

Root reviewed the page reader, query and concrete callers and approved the coherent-before-read
behavior on 2026-11-19. Final observed graph plus unchanged parent `current()` is the authority;
earlier selected-row proofs remain separate. Native/performance acceptance is still held.

The correctness checkpoint `654037e7fb` binds every parsed archive's actual proof to the original and
final metadata witnesses. It fixes the reproduced A→B→A wrong-negative/wrong-selection gap, but deliberately
keeps the duplicate initial scan. This proposal removes only that initial metadata scan. It preserves
every exact private image read, the observed-image graph digest, the final whole-archive child witness
and the parent's synchronous `current()` witness. It adds no action cache or byte-proof shortcut.

The measured `839` authority path performed 1,600 raw opens/reads/parses/hashes, 3,200 child metadata
restats for its before/after witnesses, and 1,600 parent final restats. The correctness checkpoint adds
1,600 observed-image metadata hashes. Removing its initial scan would remove 1,600 child restats and
1,600 metadata hashes at that size, bringing child metadata hashing back to the original count while
keeping the new graph binding. This is a causal count prediction, not measured speed acceptance; raw
file reads and final scans remain O(record count), so it cannot be presented as a complete cost solution.

## Directory source and bounded state

The observed digest still needs a proved directory identity. Obtain that from the existing page-owned
private directory reader, not an unguarded pathname lstat or a new filesystem reader. Extend only its
scoped callback with a lazy `directoryStat()` observation. It checks that the scope is active, runs the
same sticky directory security/path fence, and returns the held descriptor's stat on POSIX. On Windows
it retains the existing secure-root policy and bracketed pathname metadata because a POSIX directory
descriptor is unavailable. Any failure stays sticky for the entire page. No raw data or descriptor is
returned, and unused catalog/list callbacks perform no extra observation.

Keep the current initial `stoppedAuthorityHealthy()` and `secureStateDirectory(directory, false)`
admission before opening the asynchronous iterator. This constant-work admission is already part of
the removed scan, so no new open/close pair is added. Only its own ENOENT produces the existing missing
answer; a later iterator-open failure remains a refusal. A shared close failure is checked before any
new handle and cannot be disguised as absence. The lazy page observation uses only stable directory
identity/security fields, not mtime/ctime from unrelated entry writes; the final full metadata scan
continues to bracket its own work with the complete directory version.

During the first query page, use that observation to seed the existing private digest accumulator from
stable directory identity/permissions. Add each actual raw-image proof's `.json` name and full ten-field
identity before query filtering; excluded IDs still contribute fresh pathname metadata. Do not cache
rows, names or proofs across requests. Every non-JSON entry still consumes considered work, and the
existing count/deadline checks and page/iterator close ownership stay in place.

The final child metadata scan remains fully bracketed by the complete directory version and actual close.
Its digest must equal the observed-image digest before any answer can cross IPC. Return that final digest
as the existing witness. The parent `current()` implementation and selected row/credential proof checks
are unchanged. A missing directory is admitted only as the existing missing result; missing-to-present
still fails the parent's final fence. An empty but present directory still gets a proved directory identity
and final witness, rather than being collapsed to missing.

## Exact behavior decision for review

The initial metadata snapshot currently rejects a rewrite that completes before the corresponding raw
image is read, even if every observed image then agrees with the final complete graph. Removing that
snapshot would return the coherent latest answer in that case. This is an intentional difference requiring
review; it must not be hidden as an implementation-only change.

| Interleaving | Correctness checkpoint | Proposed result |
| --- | --- | --- |
| All images unchanged | Complete current answer | Same |
| Rewrite completes before that image's byte proof; observed graph equals final graph | Refuses against initial metadata | Complete latest answer |
| Image changes after its byte proof | Refuses | Refuses against observed/final mismatch |
| New/removal/rename causes iterator to omit or duplicate JSON membership | Refuses | Refuses against observed/final count and name/identity digest |
| A→B→A supplies B's bytes then restores A | Refuses | Refuses against proved directory/image graph versus final witness |
| Unrelated temporary write outside a final metadata scan | Permitted | Same |
| Directory changes during final scan, or descriptor close is uncertain | Refuses | Same |

The authority fact is completeness and exact-current bytes at the final child witness, followed by the
parent's final fence. It is not an immutable snapshot fixed before this asynchronous query started.
Every concrete source/destination row chosen before the query keeps its separate final proof at its
caller. No pre-query row proof may be replaced by the newly observed graph.

The current callers use final ownership, not a start-of-query snapshot:

| Caller | Authority retained separately from the query |
| --- | --- |
| `core/handoffDependencies.ts` | Gets concrete stopped source rows first; publication resolves them only through `stopped.current(saved)`, while the query's `current` and fresh live owner guard conflict absence. |
| `lib/handoffDiscovery.ts:ownedByOther` | Checks query `current()` and the fresh live owner after the await; uncertainty is a conflict. |
| `lib/keepAbandonedConversation.ts` | Clones the source before querying, then gives the answer's final witness to save as its source authority. A newly present conflict must prevent the keep. |
| `lib/purgeAgentService.ts` | Keeps the selected row's identity/current proof and live owner checks; conversation and folder queries supply current conflict absence only. Workspaces separately checks its reviewed path. |
| `core/agents/externalResume.ts` (the `main.ts` stoppedQuery composition) | Keeps the selected live row identity, cancellation and reservation checks; archive current/conflicts guard each commit and are refreshed after external inspection. |
| `core/agents/conversationOwners.ts` via `selectConversations` | Each selected row has its exact image proof; final supersede checks the selected loser, winner, fresh live rows and resume reservations. Global boot listing remains unchanged. |

None consumes an original witness separately from the returned final authority. The proposal changes no
caller and does not substitute a newer source/destination row for one already selected by that caller.

## RED and verification selection

Before implementation, add a real query control where a nonmatching row is rewritten to the requested
conversation before its own byte read, with the final directory stable: the desired latest answer must
fail on the retained-initial-scan checkpoint. Assert the returned answer and actual parent current().
Keep the existing two A→B→A caller regressions and add replacement between pages, incomplete enumeration,
last-row changes, excluded metadata, missing/empty directory, deletion/rename, non-JSON work bounds,
deadline and uncertain-close controls. Before/after image-proof changes must remain refused.

For supported unchanged and changed-last-row fixtures, assert no extra raw file opens/reads or JSON parse
pass and exactly one child whole-archive metadata scan, plus the unchanged parent final scan. These are
count/semantic tests, not timing acceptance. New directory observation ownership must be covered on
POSIX and the existing simulated Windows root-policy branch; native Windows remains deferred.

Only after review and source gates should a new clean artifact receive a separately coordinated fixed
comparison. Preserve all prior `839`, catalog and correctness receipts. No benchmark is authorized by
this proposal.

Actual caller RED: `/tmp/core-grid-storage-authority-single-red1-20261119.{log,receipt.json}`,
two real-child failures both returned `{ accepted: false, code: 'changed' }` for the complete latest
graph. Actual exit1 /1.194s, no timeout or cleanup signal, PID/group53650 absent. Runtime still at the
reviewed correctness checkpoint for this RED; four other tests were deliberately not selected.

## Implemented checkpoint and evidence

The three-file runtime matches the independently reviewed artifact
`/tmp/core-grid-storage-authority-single-runtime-review1-20261119.diff`, SHA256
`634630bb39b3de2ee5ec6c44aa27d100dff8712eda6de3a1bc8986d8617ff81b`.
The initial security/custody admission remains; the observed digest is seeded lazily from the checked
first page directory. Windows uses the existing secure-root policy around its stable pathname identity;
POSIX uses the held directory descriptor. Directory-observation failures are sticky through page close.

Source evidence is `/tmp/core-grid-storage-authority-single-evidence-20261119.json`, SHA256
`6bd6e1bdba88a0bff45389eefde0d2a7f27058ff1209c50f56a071fe02c78a5a`:

- GREEN:60tests/4files, actual0/2.784s. Both before-read callers succeed; original and cross-page
  A→B→A callers refuse. Empty/missing, excluded metadata, incomplete enumeration, work/deadline/close,
  mode/owner, simulated Windows and sticky-custody controls pass.
- Selected coverage:225tests/9files, actual0/9.351s. `stoppedAuthorityMetadata.ts` and `privateImage.ts`
  each100% for statements/branches/functions/lines. Identical-runtime direct-codec follow-up:22tests,
  actual0/1.018s, covers the selected-owner return that the real-child test had exercised outside Vitest
  instrumentation. Combined changed codec coverage is15/15statements and10/10branch arms. Whole existing
  codec coverage remains partial and is not claimed100%.
- Types:actual0/38.344s. All accepted runs have no timeout, no cleanup signal and no remaining owned
  process group. The final follow-up adds only a direct-codec assertion; runtime bytes are unchanged.
- Unchanged and changed-last-row65-record controls each perform65raw image opens/parses and one child
  metadata scan; the separate parent witness adds one scan and no raw reads/parses. No timing claim.

Native Windows remains deferred. All prior cost/native packets stay frozen; performance acceptance and
the eventual combined artifact validation remain outstanding.

## Data-design checklist

1. Growth: one per-query digest and directory identity; discarded on every completion/refusal/reap. No
   new record, cache, archive lifecycle, retention or purge rule.
2. Concurrency: same storage write lease, page security fences, byte proofs, final child witness and
   parent current fence. Late legacy writers remain possible; before-read rewrites are the explicit
   reviewed behavior difference above.
3. Read cost: still fresh bytes for every relevant archive; removes one metadata-only pass. Removals
   and omitted names fail the final graph comparison. No extra whole-archive table or frame payload.
4. Scale: same64 considered names per page,16,384 total entries,5s request custody and50ms final metadata
   budget. Existing16/160/1,600 evidence remains held; syscall/hash counts and authority wall/CPU warn first.
5. Compatibility: no public/wire field change. The listed callers receive the same shape and keep their
   own authority; only the explicitly described coherent before-read rewrite changes from refusal to success.
6. Migration/rollback: no durable migration; old-readable legacy credentials and complete-cohort rollback
   remain. Production restore N/A because disk fields are unchanged. Reverting this optimization keeps
   the required graph-binding correctness fix, and merely restores the initial scan/refusal.
7. Audience: existing owner/private-root checks; no new public copies, notifications, shares or logs.
8. Identity: same owned session and required child; no alternate login or credential fallback.
9. Failure: fixed existing categories, no partial result or automatic action replay; actual descriptor
   and process custody still bounds logical failures.
10. Platforms: daemon TypeScript on macOS/Linux/Windows; macOS source/cost evidence only until further
    validation. No mobile/web changes; Windows native validation remains explicitly deferred.

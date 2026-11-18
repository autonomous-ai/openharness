# Stopped display catalog in the required storage child

## Design

The Grid custody extraction removed the old stopped display cache while moving private image reads out of
core. The fixed `839a6ede62` comparison remains held: at 1,600 rows repeated listing takes 225.709 ms versus
32.134 ms before extraction, and conversation authority takes 187.652 ms versus 30.979 ms. The original
baseline, artifacts and receipts remain unchanged. This correction addresses the existing observational
`StoppedAgentStore.available()` call only. It does not claim to resolve the separate authority-query cost.

The single approved read diagnostic (`/tmp/core-grid-storage-cost-profile-reads1-839a6ede62`) completed all
four operations, with 19,648 unchanged inputs and complete process/descriptor/claim/root cleanup. On its
repeated list, the child performs 1,600 file opens, 3,200 reads including EOF, 1,600 raw-byte hashes, 1,600
archive parses, 1,600 credential binding encodings and 1,600 image-packing encodings. Instrumented inclusive
wall durations are 75.136 ms for file syscalls, 20.945 ms for directory syscalls, 10.167 ms for parsing,
15.879 ms for binding/packing and 13.740 ms for hashing. These are attribution, not CPU or uncontended
performance measurements. The repeated authority query has no binding/packing work and remains fresh.

## Existing caller boundary

| Reader | Actual effect | Contract in this correction |
| --- | --- | --- |
| `agents/list.ts` → `available()` | Stopped public frames and read-only activity/size telemetry | Bounded child observational catalog; no launch credential/reference or current-row grant |
| `transcripts/history.ts` → `list()` | Chooses a private transcript/store, and rechecks after the awaited read | Existing fresh list unchanged |
| `agents/discovery.ts` → `list()` | Chooses archived row for reinstatement | Existing fresh list unchanged |
| Boot `conversationOwners.settle()` → `list()` | Chooses loser/winner and final supersede proofs | Existing fresh list unchanged |
| `cwdRepair.ts` → `list()` | Derives cwd repair and fork source/destination proofs | Existing fresh list unchanged |
| `CoreApi.agents.all()` → `list()` | Search transcript/store sources; Browser legacy migration; usage membership | Existing fresh list unchanged |
| `get`, `selectConversations`, `query`, writes, launch resolution | Selected read or action authority | Existing exact fresh bytes and final owner/witness fences unchanged |

`available()` has one production consumer. It supplies `toStoppedProject`, which uses `grid` and
`gridWebSearch` for public Grid labels, not `gridLaunch`. Frames disable terminal availability/forking and
carry no selected launch credential. Monitor telemetry uses paths only for existing read-only activity and
size summaries. Client Resume/Purge/history requests name ids and enter their existing fresh selected read
or query paths; they do not submit the returned internal row as authority.

## Representation and ownership

The child retains only sanitized display images. Remove the entire `gridLaunch` own property before a
catalog row enters retained state or crosses IPC, including both raw credentials and opaque references.
Do not use null as a replacement: absence here means an observational projection, not a vendor-login
instruction. Keep the actual `grid`/`gridWebSearch` labels and every other existing public display field.
The new fixed catalog page operation marks the read purpose; no user option or generic query is added.

The parent shares existing row decoding/normalization but does not insert catalog results into its
`proofs` WeakMap. Catalog transport rejects a child reply that still carries a `gridLaunch` field;
that is a malformed catalog response, not a silently omitted readable row. Thus `current(catalogRow)` is false, including for a first uncached read. Fresh `list`,
`get` and selected queries retain their existing proof grant. A catalog row contains no reference accepted
by `resolveSelected`; a subsequent actual Resume obtains a fresh row and exact credential proof. Core
retains no catalog table or plaintext. Cached child objects never cross by reference: existing JSON frames
produce caller-owned graphs, and mutating one returned row cannot mutate the next response.
Retaining serialized text deliberately keeps one parse on each hit; this correction removes the repeated
raw file read and credential projection, not all parsing or reply serialization.

The page operation is private to the selected same-build storage cohort. The core launches the exact
immutable admitted entry/hash (or its verified paired lean entry), so it cannot send this operation to an
older independently selected worker. Whole-build rollback selects the older complete cohort and its older
private operation set; the legacy on-disk schema and public client frames do not change.

## Cache admission, freshness and bounds

Restore the existing logical bounds: at most 2,048 entries, at most 4 MiB of serialized sanitized image
bytes, and 30 seconds of reuse from the successful guarded read, measured monotonically. This bounds
logical retained content, not a claim about exact JavaScript heap overhead. No background timer or second
persistent file is introduced. Expired entries are removed on the next catalog access. A full cache or an
individually oversized image takes the fresh path; it never hides a visible row or rejects a supported list.

Every catalog file is still lstat'ed on every enumeration. Reuse requires exact equality of the same ten
fields as the previous catalog: device, inode, size, mtimeNs, ctimeNs, birthtimeNs, mode, uid, gid and nlink.
Only a previously guarded valid image can be cached. Any change, expired age, missing pathname or unsafe
read evicts that entry; misses use the one existing private image reader with owner/mode/root/no-follow,
size/EOF/growth, descriptor/path identity, raw-byte digest and sticky close custody. A successful miss may
cache only its resulting proved image; the earlier metadata probe is not a substitute for that proof.

Page-owned directory custody remains. Extend its existing scoped callback with a metadata-only probe
that checks the same active-directory/path boundary and sticky directory admission before lstat. Hit
paths use this probe; miss paths call the existing guarded reader. No standalone alternate raw reader is
introduced. A directory failure revokes the whole page even if the directory is restored; final page
verification and actual descriptor close remain. Windows keeps its existing directory/root policy and
must not reuse a symlink/junction: its per-path Windows security check remains before a cache lookup.

This restores the old bounded observation contract; it does not represent each hit as a new exact-byte
read. Full stat changes revoke immediately; the historical 30-second reuse bound covers metadata-poor
filesystems for display only. Such a snapshot cannot authorize publication, credential use or deletion.

## Fixed pages and failure behavior

Reuse the current 64-considered-name/64-row cursor and 256-KiB soft packing limit with the existing frame
credits. One child cursor and one parent list admission slot cover both fixed page operations. The cursor
records its purpose; a fresh/catalog mode mismatch refuses rather than continuing the other scan. The
held lookahead advances only on actual delivery. No row-count cap or truncated success is introduced.

Missing catalog files are omitted and their cache entries forgotten. Individual unreadable/malformed
archives preserve the current skip behavior. Directory failure, malformed reply, disconnect, deadline or
uncertain cursor close fails the whole request, holding the slot until actual child reap where required.
A child restart loses its cache naturally. Writes remain able to settle between pages, and changed file
identities invalidate the next observation. No writer lock, final authority fence or release-dated legacy
storage compatibility rule changes.

## Failure-first and acceptance

Before implementation, retain actual public caller REDs showing that a stopped-list display row currently
carries a credential reference and receives `current()` authority. The corrected call must preserve literal
public stopped frames, including Grid labels, while omitting the reference and rejecting `current()`.
Use a private real child/store and fake engines only.

Child and transport controls cover unchanged hits avoiding raw image reads, all ten identity-field misses,
30-second expiry, missing/unsafe/replaced containers and files, mutation between pages, 2,048-entry and
4-MiB fallback with every supported row visible, oversized rows and lookahead, cursor-purpose mismatch,
child loss/replacement, malformed/duplicate replies and close failure. Mutation of returned nested rows
must not poison retained child values. Fresh get/query/list and actual Resume must still see a replacement
and resolve only the current credential; a cached display row cannot resolve a key. All actual descriptors,
children and admission slots settle under the existing rules.

Run selected one-worker caller/storage tests, scoped changed-file coverage and types before a checkpoint.
Send the runtime diff for independent review. Existing fixed timing packets remain frozen; performance
requires a separately reviewed exact-artifact comparison after source correctness. The authority syscall
correction remains a separate, still-unresolved part of this same original extraction task.

## Checkpoint evidence

The actual public-list and Resume caller REDs both failed before this correction: displayed rows carried a
credential reference and received `current()` authority. Both caller GREENs preserve the complete public
stopped frames, including Grid labels; actual Resume resolves the replacement archive credential after a
display read. No generated credential value appears in the evidence.

Source validation on the reviewed runtime completed with 348 tests across 14 files and all six scoped
storage files at 100% statements, branches, functions and lines. The complete `test:resume` selection passed
617 tests across ten files, with all six configured files at 100%. Types passed. Each accepted gate's
owned process group settled without a cleanup signal. The immutable evidence index is
`/tmp/core-grid-storage-catalog-evidence-20261119.json`, SHA-256
`8bda9873e508ec1b846290d8b37acbdad95413b96148f5b8d0c2ae859c14e36d`.

Earlier receipts remain: the initial sandboxed GREEN attempt could not verify process custody and is not
accepted; one fixture type used null instead of a required timestamp; the first full Resume attempt used
the focused 120-second outer limit instead of the existing 300-second full-gate bound; and an old internal
`available() === list()` assertion expected the now-omitted `gridLaunch: null`. That assertion now checks
every remaining display field and no current-row grant, while retaining exact fresh selected reads and
no parent raw reads. Its isolated 79-test run passed but lacked existing cross-caller close coverage;
the complete final Resume gate supplies that coverage. No runtime correction was needed after review.

This checkpoint has no new artifact, native or cost acceptance. macOS source checks ran with private
homes/data and owned children. Windows native validation remains explicitly deferred.

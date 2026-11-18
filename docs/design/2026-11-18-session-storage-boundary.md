# Session storage prerequisite for Grid custody

Approved Design, 18 November 2026. The coordinator selected alternative B from
[the custody alternatives](2026-11-18-grid-credential-custody.md): a required session-storage child handles
private image reads and preparation; core retains session ownership and final publication. This is not an
optional models service and not a universal data converter. The coordinator approved the choices below before
runtime implementation: private stable bindings, parent-owned recovery descriptors and the existing JSON codec.

**Acceptance for this increment:** no legacy Grid plaintext in current core's file-read bytes, parsed session
rows, catalog cache, persistence baseline or unconfirmed recovery snapshots. Old-readable live/stopped files
remain the sole durable authority, with literal keys, during a release-dated compatibility window. This does
not complete the eventual removal of keys from those files. No new permanent plaintext store is introduced.

## Bootstrap and process lifetime

`main.ts` awaits `registry.load()` before creating the service links/local request handlers. Storage therefore
uses a core-owned child with inherited IPC, started from the same admitted immutable execution payload before
the first registry/stopped read. It is a required session subsystem, outside `HARNESSD_SERVICES`; disabling or
crashing models cannot disable persistence. No extra public socket, service token, broker or arbitrary pathname
operation. The child entry loads only Node built-ins, the private image codec and filesystem helpers; it imports
no Registry, session-control code, models implementation or `core/main.ts`.

Only fixed document selectors are accepted: live registry, one stopped agent, one superseded stopped agent,
and the existing names document when used by a registry transaction. Agent ids use the existing 128-character
safe-id rule. Root/data paths are bound at child startup, not accepted from each request. In source and bundled
execution, the child uses the admitted cohort's entry and exact child mode, with its own runtime name; the bundle
inventory and cohort plan must prove it. `HARNESS_NO_MASTER` still gets this same required child. There is no
automatic plaintext inline fallback on spawn failure. Tests inject a transport; they do not silently change
production process ownership.

IPC close or core shutdown immediately revokes new reads/preparation. Core requests child termination and owns
its PID until actual exit. Reply deadlines revoke the caller's permission but do not free its active slot.
Expiration terminates the child; replacement is demand driven and starts only after reap. Parent filesystem
opens and write leases also settle before shutdown acknowledges completion. No unbounded reconnect loop or child herd.

This required composition uses private `WORKER_CONTRACT = 3`. A contract-2 parent cannot admit this core or its
storage child, and a contract-3 parent cannot mix in an older storage implementation. A historical complete
contract-2 cohort still admits its own children and can read the retained legacy files. No public client protocol
or stored schema version changes. Full and lean entries dispatch `__storage` only after their first-import
admission guard. `executedEntry.ts` captures the original immutable file/hash before canonical argv rewriting;
`sessionStorageOwner.ts` retains a standalone artifact claim through actual storage shutdown. The existing named
Node mechanism labels the child `harnessd-storage` where supported, with its existing plain-Node fallback.

## Typed transport and bounds

One active image preparation and one active read per child; at most 64 queued caller operations, matching the
current Registry write queue. Calls carry a monotonically allocated id, child incarnation and bounded remaining
duration. Parent queue time uses its monotonic clock; the child starts a monotonic deadline from the remaining
duration (strictly positive, at most five seconds). Parent timeout and reply admission retain the original deadline,
so transport time never extends final authority. Wall-clock changes in either process cannot expire a fresh request.
Admit at most 1 MiB per IPC frame. Images use an ordered begin/page/end transfer, so a peer cannot allocate an
arbitrary array from a claimed count. Keep one page in each direction and credit it before sending another.
Cancellation and actual settlement are separate states. Parsing, byte hashing and JSON encoding of raw images
happen in the child. Core still parses/validates its bounded metadata pages and owns the complete session table.

Registry has no current whole-image or row byte cap. `title`, `firstTask`, paths, runtime arrays, launch argument
arrays and preserved unknown fields have no finite schema maximum. The raw Grid parser likewise has no key
length limit; the saved-API store's 8-KiB limit does not apply to legacy Grid rows. Existing stopped coverage
requires ten records with 512-KiB titles to remain visible despite the 4-MiB catalog cache; its existing per-file
1-MiB cap remains unchanged. A speculative cap or custom JSON parser would change those contracts. The child
therefore retains the existing JSON parse/stringify codec and projects serialized metadata through bounded IPC
frames. Whole-image child RSS and retained core metadata growth remain explicit residuals to measure, not a
completed bounded-image claim. Preserved unknown fields survive reconstruction unchanged.

The canonical wire types are `SessionDocument`, `SessionImageProof`, `SessionStorageOperation`,
`SessionPreparedImage` and `StoppedArchiveQuery` in `cli/src/lib/sessionStorageWire.ts`. An image proof is
`{ document, identity, bytes, sha256 }`; `identity` preserves the complete BigInt stat tuple as a decimal string.
A request carries `{ remainingMs, operation }`, and its reply is `{ ok: true, value }` or `{ ok: false, code }`.
The exact operations are `read`, `equal`, `prepare`, `discard`, `import`, `release`, `resolve` and
`stopped-query`. `read` optionally names a retained source lease. `prepare` carries the selected document,
source proof, safe candidate metadata, exact empty temporary reservation, and optional raw-source proof for
legacy quarantine. The result carries the temporary leaf, proof and projected metadata. Publication and
settlement are parent operations; there is no child `publish` or `finish` command.

`sessionStorageFrames.ts` transports these logical messages with `begin`, `page`, `end` and `credit` frames.
Every frame carries protocol, random child incarnation, request id and sequence; each sender holds its whole
message slot until the last credited frame settles. Frames are at most 1 MiB and pages at most 64 Ki characters,
with one credited page in flight. There is one active request and at most 64 waiting requests. The legacy
logical image is not capped; its safe projected serialization remains a measured memory residual.

Initialization is the single `session-storage-init-1` message containing the private root, stopped directory
leaf, random incarnation and at most two retained source proofs/leases mapped to inherited descriptors 4 and 5.
The child replies `session-storage-ready-1` for that incarnation. A lease is an opaque random id, not a
credential or permission to launch/rename. IPC errors contain only fixed failure codes, never bytes, rows,
refs, paths, OS messages carrying those values, or rejected payloads.

## Read, merge and publication

1. Core retains its existing Registry write queue and the exact legacy-compatible registry lock. The child
   privately opens the selected source with existing owner/mode/no-link checks, retains its source descriptor,
   parses/validates the image and emits only metadata pages. It returns the exact raw-image digest and descriptor
   identity in `ImageProof`. Missing is a distinct result. Corruption/unknown schema is a fixed failure plus a
   private opaque source lease for quarantine; plaintext diagnostics never return to core.
2. Core performs existing normalization, global identity validation, prior-image comparisons, merge, selected-owner
   decisions and native authority refresh on metadata. `persistedContents` becomes an image proof; the unchanged
   observation path asks the child to compare the exact current bytes with that proof, not just stat times.
   Recovery arrays contain metadata plus references, never raw images or keys.
3. Core reserves the existing exclusive empty transaction temporary and records its exact inode before sending
   the selected metadata and source lease to prepare. The child opens only that reserved inode, reconstructs each
   legacy `gridLaunch` from its lease/reference (or this call's explicit fresh-import input), writes, flushes and
   closes it, and emits its identity/digest and projected result. Parent cleanup therefore owns the exact file even
   if the child dies before acknowledging preparation. A replacement inode is never unlinked. It must reproduce
   the selected metadata exactly; worker output cannot select an owner, remove a row, change a credential binding
   or change unrelated fields. The core validates the returned metadata against its selected candidate.
4. Core holds the existing directory descriptor and legacy registry lock. Immediately before rename, in the
   existing non-yielding fence, it checks deadline, caller/cancellation, child incarnation, lock ownership,
   directory identity, source identity, prepared temporary identity and the current selected session ownership.
   It then performs the rename itself. No `publish` message authorizes a later child rename. The child never
   decides final session publication. A source changed outside the cooperative legacy lock refuses the candidate.
   Exact source-byte proof comes from the read under that lock; a stat result alone is never its substitute.
5. Core keeps today's directory-sync/close and post-sync admission order. A failed or expired sync after rename
   is publication unconfirmed, never successful rollback. Core keeps its writer/reservation through actual OS
   settlement; input/terminal traffic continues independently. A successful preparation reply means the child's
   raw write, flush and close have actually settled. Parent `discard` checks/removes the reserved temporary and
   releases its write slot; after rename, the absent temporary is the expected result. Source leases are released
   separately. On a lost preparation reply, parent waits for the child to exit before cleaning its reservation.
6. Core never repeats a rename merely because a preparation acknowledgement was lost. Cleanup removes only the same proven
   temporary inode in the original directory. A failed cleanup owns that slot and rejects another preparation;
   no accumulating private plaintext temporaries. Historical rollback sees the existing files, not an uncommitted
   metadata derivative. Before orderly handoff, core drains preparation and cleanup before releasing its child.

Current read/prepare helpers are useful implementation seams, but all raw bytes must move together: startup
read, unchanged-image check, locked merge read, quarantine preservation, temporary serialization, unconfirmed
prior/result snapshots and stopped catalog reads. Merely wrapping `prepareRegistryImage` misses most custody.

## Credential reference and models resolution

The storage codec owns the legacy secret field. It emits validated public override metadata plus a versioned
credential binding and an image witness; no literal key. The binding must remain stable when an unrelated row
changes, otherwise every registry write dirties every row and breaks baseline comparisons. A witness belongs to
one image/descriptor and is refreshed independently of the stable binding. The candidate design is a digest of
the canonical full override bound to its selected row identity, held only on the private core/storage/models
boundary; no reference/digest is announced in `AgentView`, logged, or put into public frames.

The approved digest is an equality proof, not an authorization credential. A random reference table would need durable survival/rehydration
across storage restarts and would be a new state owner. A new per-user encryption key or generic secret store is
not proposed. The raw file remains the sole durable authority; on a fresh child, references are derived anew
from exactly the old-readable raw image.

Models resolves only the core-selected reference through a small shared private codec, not by importing Registry.
There need be no storage/models peer channel: the existing authenticated `gridLaunch` request names the bounded
document selector, row identity, immutable credential binding and exact image witness. Models opens only that
fixed document under the same private-file rules, checks source identity/digest and selected credential binding,
and builds the existing engine contribution. It returns one-use environment/argv/config, credential-free override
metadata and the same checked reference; never a reusable key-bearing override. A changed source gives a fixed
stale-reference answer. Core rereads/revalidates the selected session before retrying; no silent latest-provider
substitution. Saved APIs continue to refresh through existing models-owned `ApiConnections` and refuse removal.

The supported inline models path (`HARNESSD_SERVICES=none` / no master) must not import the raw image codec into
core. Its injected selected-reference resolver uses the required storage child; the separate models process uses
its own private codec resolver. Only that explicitly selected override reaches the existing one-use builder
transiently, after exact row/binding/image witness and current-owner checks. It never enters a session, closure
cache, retry payload, baseline or generic IPC snapshot. This transient launch input, like the final environment,
is a precise residual; it is not whole-image parsing or persistent credential custody in core.

A fresh old-client unsaved override already arrives transiently at core and the eventual environment necessarily
passes through its final launcher. It may cross the existing explicit models launch request once; it must not
enter a RegisteredSession, baseline, receipt or stopped cache. For publication, the raw import is passed as this
preparation's transient input to storage and the selected metadata carries its binding. There is no separate
durable import file or commit: the old-readable row's rename is the first durable credential publication.
Cancellation before that point drops the ephemeral import after actual settlement; after it, existing session
and creation receipts decide whether a pane ran. A crash cannot leave a reference pointing at an absent new store.
Once the candidate row publishes, all further preparation/launches recover its key from that old-readable row.

`setGridLaunch` becomes an awaited, owner-checked Registry writer transaction. Its former synchronous mutation
could put raw keys into live rows and combine several uncommitted key deltas in an observation batch. The new
behavior admits projected metadata only after the same durable publication gate as other strict session changes;
concurrent calls serialize, and uncertain publication is reported truthfully. Every production caller must await
it and recheck ownership after the new await.

## Storage failure and recovery

- During initial loading, unavailable storage leaves session initialization explicitly unavailable and never
  returns an empty table that could overwrite saved work. This is a required session subsystem; it is distinct
  from an optional feature crash. Existing terminal engines remain running outside core.
- After initialization, a storage failure leaves loaded metadata, terminal byte delivery, transcript observation
  and authorized control of already-known live sessions running. Mutations that require durable identity/Stop/
  Resume/Purge acknowledgement hold or fail with a named storage-unavailable result. No success before durability.
- Child loss revokes all outstanding image/preparation witnesses immediately. No late reply from an earlier
  incarnation can publish. The child must be reaped before replacement. Retained metadata may be displayed but
  cannot authorize a new saved-session action without a fresh read/proof.
- Core retains the original source descriptor, opened read-only with `O_NOFOLLOW` where supported, before a
  replacement can unlink its inode. Core uses only metadata/fstat on that descriptor, never plaintext reads.
  Its exact identity must match the child's read proof before publication. The descriptor remains owned until
  the associated `unconfirmedBinding.prior` is released, including after a directory-sync error; expiry of a
  caller reply cannot close it. At most the current write/prior image descriptors are retained. Actual close
  determines ownership release; an uncertain close fails closed under the existing queue semantics.
- After child loss, core reaps it and passes retained source descriptors only to its admitted replacement via
  inherited stdio slots. The replacement reads from explicit offset zero, checks the exact prior image digest,
  and restores the prior private image lease. The existing uncertain-publication rollback semantics therefore
  retain their old key without a second durable file. A core crash closes the descriptors just as it previously
  lost its memory snapshot. An inode is not immutable against same-user in-place edits: digest mismatch refuses
  recovery instead of reconstructing a different credential.
- During preparation, a prior credential may be reconstructed from the fresh locked current image when its row
  identity and stable private override binding are equal. This does not weaken models' exact selected-image
  witness check. Unchanged displaced credentials therefore need no historical inode; the changed-key target keeps
  its original source. A different-target commit restores the earlier target before handing custody on, while peer
  changes to affected/displaced rows retain the existing reconciliation/refusal behavior. The two-source bound
  remains an invariant to prove with real Registry uncertainty/concurrent-import tests before acceptance.
- Pinned Node 24.22.2 documents parent descriptors in `spawn` stdio. Its bundled libuv Windows implementation
  duplicates `UV_INHERIT_FD` disk handles; filesystem opens share `FILE_SHARE_DELETE`, permitting replacement
  while an original handle is retained. These source facts justify a portable design, not a Windows native pass.
  A pinned macOS rename/child-loss/inherited-FD test is required first; Windows execution remains user-deferred.
  [Node stdio contract](https://github.com/nodejs/node/blob/v24.22.2/doc/api/child_process.md#optionsstdio),
  [Windows descriptor inheritance](https://github.com/nodejs/node/blob/v24.22.2/deps/uv/src/win/process-stdio.c),
  [Windows file sharing](https://github.com/nodejs/node/blob/v24.22.2/deps/uv/src/win/fs.c).
- The lean core entry rewrites `process.argv[1]` to the canonical mutable CLI. Storage therefore receives the
  exact immutable admitted child entry/hash from the master and renews the parent-PID cohort proof when spawning.
  It must never derive its executable from canonical `SCRIPT_PATH`. Replacement uses the same admitted payload.

## Stopped callers and concurrency

Fresh stopped actions become asynchronous. Do not use synchronous IPC or turn `get()` into a stale cache while
keeping callers unaware. Lists are fresh asynchronous reads; returned metadata alone cannot authorize deletion,
supersession, reservation, launch or provider selection without its fresh selected proof.

| Current callers | Required behavior |
| --- | --- |
| `stopAgentService`, `agents/forget`, `agents/bind`, `retainExitedSession`, `keepAbandonedConversation` | Await selected stopped read/preparation/publication before forgetting/removing the live owner; preserve all existing captured transcript/home/known-conversation merge rules. |
| `resumeAgentService`, `agents/lifecycle`, `agents/close`, `purgeAgentService` | Fresh asynchronous selected-row read with proof, then current owner/guest/reservation checks after every await; never act from the display catalog. |
| `agents/conversationOwners` | Async fresh inventory when settling ownership; before each supersede recheck the exact stopped proof plus current live winner and reservation, not the earlier list. |
| `agents/discovery` | Async startup/revival reads and removal; row/previous-agent/current runtime fences after each new await. |
| `cwdRepair` | Async checked patch preserving exact source and unrelated fields; do not reorder a stopped row or change touchedAt/name. |
| `handoffDiscovery`, `handoffDependencies` | Fresh async read for source/discovery/publication proof. `ownedByOther` must preserve fail-closed enumeration of unreadable records; an omitted catalog entry never proves that a conversation has no owner. Its async caller rechecks the current live source after this await. |
| `transcripts/history` | Fresh async stopped lookup before reading a private transcript, then fresh selected-row revalidation after the history read. Its current `lookup` is a read-authority fence, not merely rendering; a stale catalog cannot replace it. |
| `agents/launches` | Fresh async stopped lookup for resume/preflight selection, with the selected owner checked again after await; never the display catalog. |
| `core/api.agents.all`, `agents/list`, `turns/recaps`, `agents/events` | Explicit metadata snapshot only where used to render/describe. Any consumer that subsequently selects private files or performs an action must take a fresh async read. No field makes a snapshot an authority grant. |
| `main.ts` startup terminal retention and held-move recovery | Await fresh selected stopped records before choosing reconciliation/held conversations. |
| `testing/socketCore`, `testing/observerShapes` | Match production action/read contracts; never fake sanitized inputs that cannot fail before the extraction. |

Stopped `get`, `list`, `available`, `save`, `patch`, `remove` and `supersede` are asynchronous. `CoreApi.agents.all`
now returns a promise; its consumers await the fresh listing. There is no retained core stopped catalog cache or
record-count visibility cap. Listing returns every readable record, skips individually malformed archives, and
fails visibly on a disconnected or stalled storage child. IPC pages and request queues remain bounded; the caller's
requested metadata array and child whole-image codec memory remain explicit residuals.

New stopped writes serialize through one bounded store writer and the shared storage write lease, retaining their
slots through actual settlement. Source read/prepare is fresh, and final publication remains core's non-yielding
current-proof fence. A stopped save and registry removal keep the existing save-before-remove order; there is no
invented atomic multi-file transaction. Copying a credential into a stopped legacy row happens in storage, while
core copies only reference metadata. Resume copies it back the same way. Purge removes the actual old key by
removing the existing record; supersede keeps it in the existing superseded archive. No separate credential
retirement sweep or new reference index is needed in B.

### Stopped action authority

The old handoff publication fence freshly read every stopped row; external adoption's synchronous `current()`
restatted every cached row. Both detected an in-place mutation of a previously nonmatching archive during an
awaited preparation, even if the stopped directory's inode, mtime and ctime stayed unchanged. The original-source
regression confirms this. A directory version alone would weaken authority and is rejected.

The child searches archive content for a bounded selected set of conversations (at most the external request's
258 ids including its 256 aliases), or for overlap with one concrete worktree root that Workspaces resolved read-only.
It returns booleans and a private metadata witness. Matching selected rows keep their own exact image proofs. Core's
final synchronous fence recomputes the witness using a directory iterator, one stat and a commutative digest over
names and full file metadata; it neither reads content nor holds a path/stat table. The directory's full before/after
version fences each scan; the returned witness contains stable directory identity/permissions plus the count and
digest of .json names/full stats. Unrelated .tmp and .resume entries therefore do not invalidate an operation's
own authority. JSON membership and atomic replacements change that digest, while ctime and the other file metadata
catch in-place changes. Scratch
state is bounded. Provisional final-scan work limits are 16,384 directory entries and 50 ms; expiration refuses the
action, never returns a partial absence answer. These limits affect action authority, not list visibility, and require
current/10× measurements before acceptance. The remaining O(record-count) synchronous metadata cost is a residual.

Purge resolves the concrete Git worktree root through Workspaces first, asks storage only about overlap with that
root, and keeps Workspaces' existing root/identity/removal checks. Final core dispatch checks the selected row and
archive witness; native history unlink also checks those synchronously at its existing verification fence. Handoff
selects only its bounded lineage rows and read ids; external adoption retains only its current selected ids and
refreshes them after native observations. No whole-archive authority snapshot is held by core.

Keyed conversation-owner reconciliation uses the same child scan with the fixed `owners` selection. The
request contains only selected conversation keys and the core's explicit default Codex home; the minimal
child environment is not assumed to carry that profile setting. Replies contain only matching projected
rows with their exact image proofs. Final loser/winner, live-owner and resume-reservation fences stay in
core. Requests use at most 258 keys per credited operation, without truncating matching rows. Global boot
reconciliation still groups the full safe metadata listing, and client all-agent listings still return every
readable row. Those all-group and matching-group metadata allocations remain measured residuals.

Legacy registry writers continue to obey the existing lock. Historical stopped writers do not use that lock.
There is no universal data-folder exclusion on POSIX: distinct configured ports use distinct local sockets and
can share the same data directory. No startup scan or daemon ownership gate excludes historical stopped writers.
Current source/stat/proof checks detect unexpected replacement, but cannot promise atomic exclusion against an
uncooperative same-OS-user writer between check and rename. Preserve that existing trust boundary explicitly.
The shared write lease and store writer cover all current stopped writers, including recovery and repair paths.

Source/catalog authority and live/cancellation authority have separate lifetimes. A stopped write checks its
original source witness after retention, before preparation and immediately before its non-yielding publication.
Its own rename necessarily changes that source witness. Live owner/cancellation authority remains checked through
directory sync and final settlement. The final published target must still match its exact prepared metadata after
sync; an external rewrite at that point is publication unconfirmed. Keep prepares a private empty archive directory
at the actual save action before taking its absence witness. Read/list/query operations remain read-only, and a
missing or replaced queried directory still revokes authority.

Cwd repair binds both the source whose transcript proved the folder and the exact live or archived destination
selected before any await. A later row with the same agent id cannot inherit an older row's folder proof. Forget
likewise rechecks its captured live row after archive publication before removing it.

Temporary cleanup records the parent directory's exact stable identity as well as the temporary inode. Missing
temporary paths count as settled only in that original directory. A missing/replaced directory cannot prove a
displaced plaintext temporary was removed: cleanup remains unconfirmed and its preparation capacity stays held.

## Compatibility and verification

No stored schema migration and no rollback-floor change. Current preparation produces the same old-readable
legacy row (including keys); prior complete builds can restart/resume offline using the same provider/credential.
Public client payloads/frames are unchanged. The legacy disk format is a dated compatibility residual: retain it
for at least 30 days after the first published CLI release carrying the storage boundary, record that release's
date before removal, then review the subsequent reference-only migration separately. A date by itself does not
authorize erasing those keys or claiming final disk custody complete.

RED acceptance for B is **core read/parse/cache omission**, not disk omission. Existing RED canary tests prove
current in-memory/reloaded leaks; the disk-omission cases remain the ultimate task's residual and must not be
presented as B's green criteria. Add interception of every raw read/IPC boundary so the test cannot pass merely
because a helper removed `apiKey` after a plaintext read in core. The old-readable legacy files must keep the
synthetic key and support offline Grid restart/resume; no canary values in logs or assertion diffs.

Validation: current-source per-file coverage/types/architecture/lean and child-cohort tests,
all stopped action awaits/freshness cases, exact-source tampering, lost replies, deadlines with real settlement,
child crashes at every publication prefix, service-isolation native scenario, old-reader rollback fixtures, and
coordinated before/after startup/registry-save/stopped-list/selected-launch CPU/RSS/latency at 16/160/1,600 rows.
Private test homes only. Native Windows remains user-deferred; no mobile work.

### Core closure additions

Every session needs the required storage transport, publication fence and stopped authority witness:
`lib/sessionStorage.ts`, `sessionStorageWire.ts`, `sessionStorageFrames.ts`, `sessionPublication.ts` and
`stoppedAuthorityMetadata.ts`. Raw image codecs remain outside the core closure. The new bootstrap owner needs
`harnessd/sessionStorageOwner.ts` and `executedEntry.ts`; its immutable no-master execution path reuses
`bundleFingerprint.ts` and `workerContract.ts`. Only standalone packaged startup dynamically loads
`executionArtifactProcess.ts`, `childCapture.ts`, `executionArtifactChild.ts`, `executionArtifacts.ts` and
`leanBundle.ts` to prepare its initial cohort; admitted supervised and explicit source entries load none of them
through this door. These are session bootstrap dependencies, independent of optional services. Their standalone
first-use cost remains in the measured acceptance.

### Current implementation checks

Real Registry tests cover two-source recovery after child loss, a different-target commit and concurrent imports,
including actual descriptor closure. Raw-read interception covers synchronous and asynchronous fs reads and
FileHandle reads; recursive state inspection includes Maps/Sets so baselines and unconfirmed priors cannot hide
a key from JSON-only assertions. Stopped listings fail visibly on disconnect and recover through a newly admitted
child; listings alongside a prepared write see the old published image until settlement. Worktree tests change a
nonmatching stopped cwd during root resolution and after the final child answer and verify deletion is refused.

The frame sender owns its slot through credit-to-next-page microtasks and refuses sends after close. Required
startup ownership tests cover absent/changed selected entries, an incompatible replacement cohort and retained
artifact claims after failed cleanup. Golden launch fixtures now inspect private fake executables and exercise
the deferred argv factory. Historical script differences from the earlier native-launch migration are retained
for explicit review; no expected output is accepted merely because current code produced it.

The first full core gate preserved 54 failures (5,794 passing, 43 skipped); fixture corrections and the newly
exposed archive/forget authority gaps are tracked separately, not treated as an initial pass. Its next full run
passed all 285 test files (5,851 tests, 43 skipped), but **exited 1** for uncovered branches/functions in twelve
changed files. Focused authority tests now exercise those paths; that coverage failure remains open until the
current full gate passes. The final full core gate then exited 0: 285 files, 5,869 passing tests and 43 skipped,
with 100% statements, branches, functions and lines in every file. The current harnessd gate also exited 0:
21 files, 552 tests (one skipped), with 100% in all four measures per file. The final selected boundary suite
passes 159 tests; source types and the packaged fixture's separate type check pass. Compiled admission and
coordinated measurements remain acceptance work; these results alone do not establish release readiness or a
bounded whole-image design.

Review failure injection found and fixed four custody boundaries. Parent preparation records its exclusive
temporary and descriptor immediately after successful open, before chmod/stat can fail. A failed helper close
has the shared fixed `StateFileCleanupUnconfirmed` identity, retains the original handle, refuses another open,
and remains visible through directory, owner-read, lock-fence and lock-cleanup wrappers. Other already-owned
handles may still close; an uncertain close is never retried. A storage child with uncertain helper cleanup must
actually exit before its caller releases custody. A failed kill marks termination before signaling, never
recurses/retries or releases the slot, and emits one fixed failure line while waiting for actual exit. Finally,
the selected storage entry/hash lives in the process-local transport owner and is passed explicitly by bootstrap;
neither value is placed back in the ordinary process environment after harnessd environment capture.

The four-fix focused run passes 47 tests. The shared helper/lock/storage suite passes 60 tests (two skipped),
including five additional failure-first lock propagation cases. A sandbox-constrained attempt was stopped with
exit 130 after process-generation execution returned EPERM; the selected run outside that constraint exited 0.
Synthetic credential checks use booleans and never emit their random values.

The coordinator reviewed the exact launch matrix categories before recording expected bytes. Grid changes cover
204 of 364 cases (66 creates and 138 relaunches), with 32 to 44 scripts because relaunch now records its actual
final deferred dispatch. DSH changes cover 112 of 130 cases (46 creates, 54 relaunches and 12 forks), with 36 scripts
before and after. These are the admitted native proof/captured-environment/after-exit path; saved-API refresh already
introduced by `9c41a90cd4`; intermediate settings movement from `ff33cd095c`; deliberate template-trust removal from
`38f9eba9e0`, including unchanged fixture modes; and verified credential-reference representation. A separate literal
historical Grid-and-DSH final argv assertion stays independent of rerecording. Fresh matrix verification passes all
five tests. No flags, config, permission or precedence category outside that review was accepted.
# Measured storage cost correction, 18 November

The first exact-source macOS comparison is a failed performance acceptance, despite passing
credential, offline restart and cleanup semantics. At 1,600 records the fixed ABBA samples show
warm stopped-list medians of 32.25 ms before extraction and 784.97 ms afterward; Registry save
257.71 ms and 502.39 ms. Four warm observations per arm are descriptive samples, not p95.
The original twelve-arm receipts remain in `/tmp/core-grid-storage-cost-timing1-2026-11-18`.
The original source at `47403ddfbe` and packaged payload remain frozen. Corrections start on the
combined `c56b2fbb5d` source, including the pending creation index and its admission retry fix.

One fixed, instrumented full/embedded-lean attribution pair found 8,043 requests in each arm:
8,000 came from five 1,600-file archive listings. Both arms preserved all rows, offline launch,
legacy disk readability and actual exit/close/EOF/IPC cleanup. The four inspector profiles and
root's unchanged-input verification are retained in
`/tmp/core-grid-storage-cost-profile-1-2026-11-18`; their sampled CPU/RSS are attribution only.

## Design: bounded stopped-list pages

The required child now owns one listing's initial `.json` names snapshot, preserving the prior
readdir domain/order. Named `stopped-list-page` and `stopped-list-close` operations use the same
credited transport. A page considers at most 64 names and packs at most 256 KiB of projected
images, except one individually supported archive may occupy a page alone. The existing 1 MiB
raw archive contract is unchanged. No truncation, new whole-archive cap or custom JSON parser
is introduced. One projected lookahead may wait for the next page; its name remains unsettled
until delivery, so the final `done` cannot omit it.

The parent verifies cursor identity, contiguous offsets, stable total, positive progress,
the 64-name limit and exact selected image proof shapes. It runs the same strict row decoder
and retains each returned row's exact WeakMap proof. A request-scoped set rejects repeated
agent IDs within or across pages, adding O(returned-row-count) identifier metadata only until
listing settlement; it is not a retained cache or authority table. No success is returned until all pages
complete. Individual damaged records still cannot hide their peers; worker loss, expiration
and uncertain cleanup fail the entire listing. Names and at most one projected page/lookahead
stay in the child. The API's complete returned row array remains in core; child names storage
and core visible metadata still grow with record count and are explicit residuals.

Every page retains the existing five-second monotonic request deadline. There is no new
five-second whole-list deadline. Concurrent listings share one cursor slot with at most 64
waiting callers and five-second admission deadlines, an explicit overload scheduling change
from interleaving per-file requests. Other storage operations and writes run between pages;
listing does not take the global write lease. A listing takes no content cache and grants no
whole-archive absence or conflict authority. Those queries retain their separate child search,
write lease and final metadata witness. Selected mutation after read still revokes `current()`.

The child retains no cursor descriptor: the names operation returns before image processing,
and each image read completes its original close fences. Parent cleanup closes the exact
cursor before admitting another listing. A failed close response triggers child termination;
the slot remains held until actual child exit. Replacement never resumes an old cursor.
Ordinary reads still create no container. A listing snapshots names once, then reads each
selected current pathname, matching the previous listing behavior during same-user writes.

The caller RED receipt is `/tmp/core-grid-storage-batch-red-20261118.log`: all 129 rows, exact
selected proofs, offline credential resolution and unchanged legacy disk bytes passed, then
the bounded-request assertion failed with 129 requests instead of at most four. The corrected
caller and all 62 stopped tests pass. Separate child and transport tests cover byte packing,
large supported rows, malformed peers, name progress, concurrent listings/writes, deadline
admission, child replacement and uncertain close custody. Final coverage, packaged artifact
and cost acceptance must be on the corrected combined source; earlier passing gates do not
establish this correction's performance or final release acceptance.


## Design: exact metadata comparison and prepared lean entry

The fixed child profiles identify repeated `sessionFileIdentity` formatting as another cost:
intermediate read fences formatted the same ten BigInt stat fields four times before the final
proof was formatted. The replacement compares exactly dev, ino, size, mtimeNs, ctimeNs,
birthtimeNs, mode, uid, gid and nlink directly. The final canonical identity string and every
persisted/source proof remain unchanged. Tests mutate every field at the after-read and final
pathname checks, prove actual descriptor close, and compare all operand orderings against the
original string equality. Atime remains outside the identity contract.

A non-admitted no-master entry already prepares and adopts a claimed immutable execution
artifact, proving its original full entry, complete cohort and optional lean core hashes. Storage
now selects the paired leanCoreScript/leanCoreFingerprint from that same artifact when both
exist. With no complete lean pair it selects the existing full pair before any child starts.
After selection, a missing or altered lean entry is refusal; it never falls back to the full or
canonical script. The original admitted supervised entry and explicit source graph are unchanged.
Every replacement child still rehashes its selected entry. The existing artifact claim remains
held until actual storage cleanup, including when cleanup cannot confirm settlement.

The separate RED receipt `/tmp/core-grid-storage-equality-lean-red-20261118.log` records both
expected failures: four intermediate string conversions instead of zero, and full selection
despite an available proved lean pair. The focused current-source follow-up has132 passing
checks across eight files; typechecking passes. The original instrumented RSS difference is
attribution only. No new performance acceptance is asserted until the combined corrected
artifact is built and measured under a reviewed fixed workload.

## Design: synchronous reads only inside storage/models

The fixed profiles also attribute archive cost to separate libuv open/stat/read/EOF/stat/path/
close round trips for every small image. Replace the one private-image reader with synchronous
owned-descriptor I/O, retaining its Promise-returning API. Its sole runtime importer is
`storage/sessionImage`; normal composition calls that codec only in required storage and the
models child. Architecture and raw-read custody regressions must keep it outside core.

Preserve O_NOFOLLOW/O_NONBLOCK, secure directory and Windows-root checks, owner/type/mode
checks and tightening, the original byte limit and growth/EOF probe, and exact ten-field
before/after/path identity comparisons. Open only after shared custody is healthy. Every
successful open is closed through the shared sticky closeStateFileDescriptor owner; any
uncertain close remains cleanup-unconfirmed until actual child exit. No alternate reader,
content cache, extra plaintext file or parent raw read is introduced.

This intentionally spends read work in the owning child's loop instead of libuv scheduling.
A required child's parent still enforces each five-second monotonic request deadline and holds
custody until actual reap; archive pages still consider at most 64 names. Models' selected
credential read can occupy its own loop for an entire Registry image. That whole-image work
and RSS are existing unbounded-image residuals, not a completed bounded-read claim. The final
matched comparison must use one frozen corrected source/artifact after all accepted changes.
Tests cover actual bytes, unsafe/missing/symlink/type/mode cases, short/growing reads, every
metadata-field mutation and actual child death after file/helper close uncertainty, in addition
to the failure-first asynchronous-open counter. Windows native execution remains deferred.

## Design: current Registry returns references only

Current Registry preparation returns a discriminated `registry-credentials` receipt: exact
row-bound credential references plus its existing temporary/proof, with no session metadata
or metadata digest. Names, archives and raw legacy backup retain their actual `value`
projection. Child restore changes only gridLaunch; resolve already requires canonical equality
of requested public override metadata and the resolved override before encoding. No newly
returned metadata can replace the parent's session authority.

The parent owns Registry metadata before awaited preparation: live rows and binding candidates
are deep-cloned; fresh decoded source and private recovery graphs belong to the serialized
writer; intended-field sets supply names only. The merge's first validated rows and persisted
candidates remain private. A real caller regression holds preparation, mutates live nested
launch arguments, and proves the captured image is unchanged while the final fresh-live rebase
preserves the newer observation. This prerequisite passed before replacing the second metadata
validation.

Publication requires the exact reply discriminator/document/proof, complete unique credential
coverage by agentId and registeredAt, no extra fields or rows, and source witnesses matching
the prepared image. An unchanged row identity must preserve its private binding. Intentional
clone/rekey retains the existing resolution rule and receives its new exact row binding.
Only accepted credential objects are substituted around the parent's captured metadata;
the original graph is not mutated. Malformed receipts are refused and the owned temporary
is discarded under existing actual child/descriptor custody before publication.

Registry retains its first validated rows, replaces only their gridLaunch reference objects,
and removes the second whole-image decode/validation and paired canonical metadata passes.
Global identity validation, final fresh-live rebase, preparedRows/preparedImages reuse,
locks/cancellation/directory settlement and unknown-outcome recovery remain. Publication
updates the shared accepted credential witness after rename, so installed rows resolve
against the actual final image. Legacy backup never substitutes its empty placeholder input
for the original raw image. Receipt memory still scales with credential-bearing rows;
whole-image metadata/RSS and authority-scan residuals remain explicit.

The RED receipt `/tmp/core-grid-storage-reference-receipt-red-20261118.log` has the ownership
prerequisite pass and two expected failures: metadata still returned across the private wire,
and four redundant public-row canonical passes for the two-row caller. Acceptance additionally
requires malformed/missing/duplicate/foreign references and wrong binding/proof refusal,
clone/rekey success, actual raw legacy bytes, witness resolution after rename and existing
child-loss/uncertain-publication recovery. Final gates and matched measurement remain pending.

## Design: preserve finite disk failures across required storage

Upstream `c50947ccd7` makes Registry preserve ENOSPC, EDQUOT and EROFS in its fixed
persistence category, so the supervisor does not roll back a good build because its
state volume is full or read-only. Required storage's generic `unsafe` normalization
must preserve that behavior across the child boundary. Its private failure union will
carry those three fixed codes and EACCES/EPERM, which preserve the existing access-refusal
category. It will never serialize arbitrary error messages, paths, causes or errno codes.
The same finite classifier applies at child image read/write and dispatcher boundaries;
unknown errors remain unsafe. Shared descriptor cleanup uncertainty takes precedence and
still requires actual child reap. Parent publication's post-rename directory-sync failure
continues through AtomicWriteUnconfirmed with its original finite disk code.

The regression uses an admitted private child fixture which runs the real codec and wire,
with only its selected temporary write failing, then checks the actual Registry error and
supervisor namesTheDisk decision. It also covers the existing parent directory-sync case
and proves no private path appears. The upstream fixture's old parent fs/promises write
and syncStateDirectory interception is replaced by the actual current child/parent seams;
its exact error-category assertions are retained. No public schema, rollback floor or
storage publication authority changes.

Failure-first receipt `/tmp/core-grid-storage-disk-code-red3-20261118.log` has four expected
child-to-Registry failures (the three disk codes and EACCES became `write failed`) and four
passing controls, including post-rename failures. Two preceding attempts had an incomplete
fixture export interception and are retained as fixture failures, not behavioral RED evidence.
The correction passes 95 selected real-child/reader/Registry cases, then 101 expanded cases
including temporary open/write/chmod/sync failures; reader and wire retain all four coverage
metrics at 100% (`/tmp/core-grid-storage-disk-code-coverage2-20261118.log`). These use combined
main `86558dafad` dependencies, lock SHA256
`a578fb81a3757cfd14de2c687dfe9b7f687d56f8c0112082edf640245995ea61`.

## Compatibility correction: unreadable archive peers remain visible

Preserving finite system codes for Registry must not change stopped-list filtering. Before that
correction, an archive's ENOSPC/EDQUOT/EROFS/EACCES/EPERM read failure became `unsafe`, and the
child skipped that individual unreadable record. The same five fixed codes now join only that
per-record skip set. Container failures, invalid cursor state, expired/busy/disconnected service
and cleanup-unconfirmed remain fatal, with zero partial successful listing. Selected get and
authority queries retain their precise named failure; they never infer absence from it.
No parent cache, alternate reader, publication change or new compatibility exception is added.

Five actual child-to-StoppedAgentStore.list regressions failed first at frozen d038 in
`/tmp/core-grid-storage-unreadable-archive-red1-20261118.log`. Each seeds an unreadable archive
and a readable peer, injects only that exact child's file read, and requires the peer to remain
visible; selected get/query still reject by the same finite code. Removing the fixture fault
must expose both rows with fresh proofs. The previous d038 timing/source/artifact remain frozen.

The correction passes 33 cases across the real caller, child paging and Registry disk categories;
changed stoppedList has 100% statements/branches/functions/lines. TypeScript also passes.
Receipts: `/tmp/core-grid-storage-unreadable-archive-green1-20261118.log` and
`/tmp/core-grid-storage-unreadable-archive-types1-20261118.log`. Tests retain fatal busy, expired,
disconnected and cleanup-unconfirmed replies after a readable record, with no partial catalog.

## Design: reuse a page-owned directory descriptor

The accepted d038 attribution splits native open self samples into 379.5 ms in
secureStateDirectory and 337.5 ms in readPrivateImage. Per-file byte reads, identity
fences and digests remain required. Only repeated directory open/close is replaced.

### Security and compatibility

Each POSIX page owns one O_RDONLY|O_DIRECTORY|O_NOFOLLOW descriptor, acquired after
the shared custody-health guard. Initial admission uses the existing policy:
directory type and current UID, refuse group/world-writable directories, tighten
other safe modes to 0700 and verify. Before **every file**, fstat that descriptor
and lstat its pathname; require directory type, original dev/ino, current UID and
exact private mode on both. A safe mode changed since initial admission may be
tightened by the same existing policy, but a group/world writable mode is refused.
Final page validation repeats those checks, before any rows return. No mtime,
ctime, size or nlink equality is imposed: unrelated cooperative directory writes
retain the current listing behavior. Existing archive authority witnesses remain
unchanged, including nonmatching in-place changes.

Current secureStateDirectory opens the current pathname and checks the opened
descriptor before every file, closing immediately afterward. The page owner keeps
the same descriptor security check at that point and adds a pathname/descriptor
identity check, so directory replacement cannot redirect a later file while this
page is in flight. It also checks at the end, whereas the existing helper has no
post-file directory check. It cannot prove an unobserved permission ABA; neither
can the current open/fstat/close admission. No such guarantee is claimed.

Every file retains its O_NOFOLLOW|O_NONBLOCK open, UID/type/mode and tightening,
size and EOF/growth bounds, all ten before/after/path fields, and digest. Windows
uses the unchanged per-file secureStateDirectory and requireWindowsStateFile path;
this change makes no new claim about Windows native descriptor/ACL semantics.

### Composition and custody

Use a child-private `withPrivateImageDirectory(directory, work)` callback. Its
reader is bound to that exact directory and refuses use after the callback has
settled. No descriptor/token enters IPC or core. It owns and closes its descriptor
in finally with closeStateFileDescriptor; failed close remains sticky, revokes
future work, and surfaces cleanup-unconfirmed for actual child reap. Existing
already-owned file/iterator handles still get their close attempts.

The codec supplies a named stopped-page callback to createStoppedList; each page
continues to consider at most 64 names, preserving byte packing, held lookahead,
offset advancement and zero partial list success. Directory changes between pages
remain permitted. Standalone selected-image/Registry reads retain their reader.

The codec's existing stopped query loops in groups of at most 64 considered names
inside the same directory callback; its total work/deadline bound, exact selected
row proofs and final whole-archive metadata witness remain. Maximum extra custody
is one directory FD beside its existing iterator and one active file FD. No cache,
new serialization, archive copy, retry, or changed authority field is introduced.

### Tests and remaining parent cost

Failure-first actual read fixture counts repeated directory opens while checking
returned row bytes/proofs. Add before-file and final replacement/UID/mode checks,
safe tightening, unrelated temporary and JSON writes during a page, writes between
pages, wrong-directory/expired-reader refusal and shared sticky close uncertainty.
Retain individual unreadable-record filtering and fatal whole-query failures.
Existing size/growth/ten-field/file replacement tests continue through this reader.

The proposed whole-graph Registry clone is withdrawn: strictPersistedRow preserves
grid and unknown compatible nested fields, so shared inputs could become newly
aliased installed rows. Per-row deep capture remains. The adapted real-child
preparation fixture and final-installed shared-Grid regression retain that contract.
The large fingerprint/normalization cost remains open; any invocation-local reuse
must first show duplicated comparisons within a non-yielding ownership interval.

The first bounded page regression fails with 65 actual directory opens for 64
proved images, versus the selected limit of three (initial list admission, page
admission, retained page descriptor). Sixteen existing cursor/filtering controls
pass. Receipt: `/tmp/core-grid-storage-directory-page-red1-20261118.log`.

The correction passes 84 focused reader/list/query cases, with privateImage and
stoppedList at 100% statements, branches, functions and lines. A separate 79-case,
seven-file selection passes real storage transport/codec/query, unreadable-record
compatibility and metadata-authority checks; its owned process group is absent.
The actual page-directory close fault refuses the entire catalog and waits for
child exit, close and IPC disconnect, then proves the PID absent. TypeScript passes.
Receipts: `/tmp/core-grid-storage-directory-page-coverage3-20261118.log`,
`/tmp/core-grid-storage-directory-page-callers1-20261118.log`, and
`/tmp/core-grid-storage-directory-page-types2-20261118.log`.

The initial focused run retained one test mismatch: an arbitrary private callback
error now passes through the directory owner's fixed `unsafe` classification,
matching the existing process dispatcher category. The assertion now requires
that category and still proves fatal/no-partial behavior. No wire failure category
or system-error filtering changed. Earlier failed logs remain. The final raw byte
reader, authority witness, per-row Registry capture and fingerprint semantics are
unchanged. No new timing claim is made; measured parent save cost remains open.

Independent review found that per-record filtering could catch a directory
admission failure, then return a partial page if another writer restored the
original directory before the final check. Both real archive regressions fail
first: unsafe mode restored and replacement restored each incorrectly returned
only the peer row (`/tmp/core-grid-storage-directory-page-sticky-red1-20261118.log`).
The page now retains its first directory-admission failure and refuses all later
admissions and final return, independently of pathname or permission restoration.
Per-file unreadable filtering is unchanged; close uncertainty still requires reap.

The correction passes 137 tests in seven files, including real-child page-close
custody and unreadable-peer compatibility, with both reader and list files at
100% in all four metrics. Types pass. Receipts:
`/tmp/core-grid-storage-directory-page-sticky-coverage2-20261118.log` and
`/tmp/core-grid-storage-directory-page-sticky-types1-20261118.log`. The preceding
coverage attempt exposed a fixture injection placed before directory admission;
its corrected injection now targets that check and preserves the actual failure.

## Design: reuse exact normalized rows from the locked source image

The 160-row count-only diagnostic on 8765 prepares one Registry image. Before
preparation, normalizedRuntimes's exact validTerminalRuntime filter runs 483 times
on 160 unique arrays (323 repeated calls). Both fresh live rebases fingerprint 160
distinct rows exactly once and perform no runtime normalization. This is source
attribution, not latency/CPU acceptance. The diagnostic receipt verifies 9,688
inputs, actual child exit/close/disconnect and PID/group/root cleanup.

### Narrow correction

In the existing locked source-read block, `validatedRows(v2Rows)` already produces
complete normalized source rows and checks global identity invariants. Its result
is currently discarded. Preserve that result in a transaction-local Map keyed by
the exact original raw row object, paired by the validator's unchanged input order.
Only this successful source validation populates the Map, and only for rows with
numeric registeredAt, lastHookAt and lastTranscriptAt plus numeric touchedAt or
legacy updatedAt. Rows requiring Date.now defaults retain their existing calls.
Never key by row id,
runtime array, digest or public identity; different raw objects always validate
independently. Invalid/legacy/non-source rows use strictPersistedRow as today.

Use a local `normalizeSourceRow` function which returns that exact cached result
only for a Map hit and otherwise calls strictPersistedRow. Thread it through the
initial MergeIdentities construction/put and pre-prepare mergedForSave validation,
then final pre-prepare validatedRows. Existing optional helper defaults stay
strictPersistedRow, so both fresh live rebases and all other callers remain fresh.
The global final validation still scans every resulting row and checks all agent,
process, conversation/provisional reservation and runtime identities.

Clear the Map immediately before `await prepareSessionPublication`. No cached
normalization is used across an await after source validation; no cache crosses
transactions, no mutable live row enters it, and no new normalization authority
survives preparation. The normalized rows already chosen for preparation remain
the owned metadata graph, as under the current reference-only receipt contract.

Remove the existing unnecessary await around its synchronous validation IIFE.
Clear the Map on failure before asynchronous source cleanup as well.
The source rows are the required child's private fresh JSON projection. Validation,
reconciliation and initial merge run without yielding after the retained-source
read. Reconciliation replaces Map entries/root objects, while threeWayRow and
withIntended copy roots. They do not mutate nested source fields. The cache cannot
substitute a normalized source row for a changed candidate merely because their
runtime arrays or agent ids agree. Credential receipt replacement and final witness
updates happen after the cache is cleared. Per-row structuredClone, owner captures,
global validation, locks, deadlines, peer conflict handling, source FD/temporary
custody, cancellation and both final fresh-live rebases remain unchanged.

### Tests and scope

Failure-first count at the real Registry caller: its existing three-row admission
fixture performs 15 runtime normalizations; require at most 11 while preserving
literal durable rows, independently owned receipt/live nested fields, and the
existing prepared-row reuse. This targets two repeated passes over the two exact
source rows, not fewer global identity checks. Add a source-row normalization count
alongside a field-changed candidate to prove the candidate is independently parsed.

Run the actual held-child-preparation invalid-live-row and nested mutation cases,
peer-recovered owner/close intent/cancellation/unknown-publication tests, final
installed Grid alias protection, Grid copied-reference rekey/final-witness resolution
and malformed source/global identity rejection. Changes during awaited preparation
must still be seen by the fresh rebase. Prior tests, failures and diagnostic inputs
stay frozen. No private field values, row ids or digests enter diagnostic output.

This adds only a transient pointer Map for already retained live-session metadata;
it removes duplicate normalized graphs and is cleared before preparation. Whole
Registry image/metadata growth remains a residual. Fingerprinting, initial capture
callback delay and every-transaction durable I/O remain measured costs, not solved
by this correction. A later matched comparison must decide actual performance.

Actual RED: `/tmp/core-grid-storage-source-normalization-red1-20261118.log` fails
15 > 11 after the original literal durable and receipt assertions pass.

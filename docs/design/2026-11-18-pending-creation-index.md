# Pending creation discovery outside core

## Problem

`AgentCreationReceipts.pendingIntents()` opens every historical receipt and parses it in the core each minute.
`pendingLaunches` already bounds its retry window, preparation slots and per-pass work, but accumulated completed
receipts still increase core work. Receipt IDs cannot expire: an old client retry must never start another process.
The required session-storage child being introduced for Registry and stopped sessions supplies the process owner
for compatibility discovery. This work does not introduce another process or make durable creation optional.

Implementation is in progress. No runtime or performance acceptance is claimed.

## Design

### Authority and compatibility

The existing primary `id.json`, exclusive claim, exact result and cancellation tombstone remain the only dispatch
authority. Their paths, schemas, checksum rules, durability and final non-yielding claim/effect checks remain.
The derived index never makes an ID available and never grants a retry. Core freshly reads `pendingIntent(id)`
before preparation and still passes its original `CreationAuthority` through the final dispatch.

A new private `agent-creations/.pending-v1/` directory contains one empty private marker per potentially pending
creation ID. A marker becomes durable before a new primary intent is published. Existing unclaimed version-2
intents gain a marker before they are prepared by a new writer. No request, path, credential or user content is
copied into the index. Only the existing bounded creation ID appears in its filename.

A marker is removed only after the authoritative primary/claim/result proves that recovery cannot dispatch the
intent. Missing or corrupt primary evidence is not such proof: a writer may be between marker and primary
publication. Those markers remain harmless discovery hints. A crash before primary publication may leave one;
there is no invented timeout that turns an uncertain live writer into a dead one. A failed marker removal leaves
extra discovery work, never another launch. A failed marker publication prevents the new primary publication.

Supported older cores do not write markers and may run on another configured port against the same data folder.
Therefore index-only discovery, startup-only rebuild, directory mtime and filesystem notifications are insufficient.
A bounded compatibility scan continues in the required storage child. It reconciles legacy pending intents into
the index while all primary files remain readable by old complete builds. Rollback ignores the new directory;
old scans already skip directories. Public client contracts and backend deployment order are unchanged because
this is private daemon storage and the original receipt formats remain authoritative.

### Process boundary and concurrency

Use the existing process-owned `SessionStorage` singleton and admitted child entry. Add fixed operations for this
one existing data family: ensure marker, read the next discovery page, and close that scan. Terminal markers are
retired by the child while it classifies their original receipts; a separate retirement RPC is unnecessary. The root and
`agent-creations` destination are constructor-owned; callers cannot supply arbitrary directories or write contents.
Each operation validates IDs and returns bounded metadata. No callback, shell command or publication destination
crosses the boundary.

Core owns its existing 128-ID retry window, four actual preparation slots and current scan cursor token.
At most 64 marker admissions occupy the existing in-flight receipt map while the storage queue settles. Each retains
one original receipt-directory descriptor and at most one already size-checked request snapshot (262,144 serialized
bytes); this is at most 16 MiB of serialized requests, not a claim about JavaScript object overhead. No second map is
added for admission. An uncertain close retains its ownership and blocks further private-state acquisition.
The child owns the directory handles and private receipt classification. It retains at most one index iterator
and one legacy iterator per scan generation, with bounded scratch state. A page examines at most 64 entries and
obeys the existing 20 ms cooperative work budget; a slow filesystem remains subject to the storage transport's
five-second logical request deadline and actual child-exit custody. Returned IDs and frames have explicit bounds.
No complete directory, receipt history or cache of historical IDs is retained in core or child.

Existing primary hard-link publication handles inter-process races. Index creation is idempotent; observing
another writer's marker requires the same private-directory/file safety checks and durable directory confirmation.
Removing a terminal marker cannot revoke primary authority. The implementation must prove the removal/create
race against an existing claim rather than relying on in-memory locks shared only by one process.

The original retry fairness remains: a crowded 128-ID window yields completed preparation holds to later durable
entries; it does not stop compatibility discovery forever. Index and legacy passes both get bounded progress.
A replacement child invalidates its cursor tokens. Core restarts discovery and deduplicates only its bounded
active window. No old cursor or late response may attach to a new child incarnation.

### Growth and read cost

Historical receipt and tombstone retention is unchanged and indefinite because clients have no expiry contract.
There is at most one index marker per accepted creation ID. Terminal markers are pruned after authoritative
evidence; uncertain pre-primary markers remain until an explicit future writer-retirement mechanism can prove
safe removal. This is an explicit disk-growth residual, not a finite-retention claim.

Normal core discovery receives bounded IDs and reads only candidate pending receipts. The legacy compatibility
pass still performs work proportional to historical receipts, in the child. This design removes that growing JSON
work from core; it does not claim that all storage work is proportional only to new records. Removing the legacy
pass requires positive writer exclusion or a versioned retirement contract, not a date or process-local lock.

The first measurement covers 1,000 and 10,000 completed historical receipts, including old version-1 records and
claimed version-2 records, with pending work at the beginning and end. Record core/child CPU, core event-loop delay,
RSS, discovery latency and actual entries/read bytes. Also measure empty-idle behavior and new-intent publication
latency, including the additional marker durability. No performance acceptance follows from source relocation.

### Failure, audience and identity

Index unavailable or corrupt is a fixed named diagnostic and an unavailable recovery state. Core must not silently
fall back to scanning historical JSON itself. A child crash cannot free an unsettled scan handle before actual exit;
new scan work cannot accumulate abandoned physical owners. Shutdown uses the existing bounded storage close path.
No diagnostic includes an ID, request, source path, raw exception or private content.

The existing private data-directory permissions and admitted storage child enforce access under this daemon's own
account. This work grants no caller another account's identity, no remote filesystem API and no capability to
create a process. Guest and owner dispatch rules stay in the current core authority.

### Migration and rollback

No destructive migration. Existing receipts are discovered by the child compatibility iterator; new writers create
markers before primary publication. Missing index state is reconstructible from primary evidence. Never delete or
rewrite historical primary files merely to shrink the index. Whole-build rollback retains duplicate protection and
uses the original scanner. The combined private worker contract must admit the new child operations together.

### Platforms

The TypeScript storage and filesystem changes affect macOS, Linux and Windows. Native Windows testing is explicitly
deferred by the user; portable path, permission, replacement and close-custody cases remain required. Mobile and
Desktop protocols and publishing are unchanged.

## Checks selected before implementation

- Failure-first discovery cases: completed history never parsed in core; legacy intent created after startup;
  unchanged directory timestamps; work beyond a full retry window; core/child restart during a scan.
- Crash/race cases: durable marker before primary; failed marker fsync; missing/corrupt primary; claim/result/cancel
  before removal; uncertain close; repeated ID and competing writers; marker loss while legacy discovery continues.
- Caller behavior: current creation/receipt/pending-launch suites, unchanged cancellation and duplicate effects,
  no historical request contents in returned pages/logs, private-root confinement and stale cursor rejection.
- Selected storage/core coverage and types; packaged private-daemon recovery with injected child loss; matched
  current/10x historical workload and idle measurements with verified process/descriptor cleanup.

The caller, index and storage transport changes receive independent review together before integration. The required
storage extraction remains its original separate task; this index uses its shared descriptor-custody guard.

### Admission and scan review corrections

`runIntent` first honors its existing in-flight operation, fingerprint and terminal receipt. Returning a completed,
cancelled, failed or unconfirmed outcome never depends on the derived index being writable. Only a new or still
recoverable intent needs marker admission. Its existing in-flight map coalesces duplicates before the first await.
The request and initial hold are captured before that await; an existing pending checksum and original open
directory identity remain its authority. After admission a private continuation reads the primary again: cancellation
or terminal completion may return its current outcome, but a missing/replaced pending image cannot be adopted.
The original directory owner transfers to preparation; cleanup compares the exact in-flight entry so a five-second
reply cannot release an ongoing preparation. Typed asynchronous storage/conflict refusals remain visible to callers.

Every uncached marker is opened without following links, checked and flushed through that exact descriptor. The final
pathname must match the descriptor proof after directory flushes. A maximum-128 cache records only those exact
marker/directory proofs; eviction permits more flush work, never less authority. The child checks original directory
identities again immediately after each asynchronous directory read and before any marker mutation. A mid-page error
closes that original scan; an obsolete cursor cannot close a newer one. Shared private-state helper close uncertainty
is preserved as `cleanup-unconfirmed`, never treated as an ordinary damaged receipt.

Every directory flush also checks its opened descriptor against the original directory proof before and after fsync.
Checking the pathname only afterwards is insufficient: it could temporarily name a replacement during the open.
The configured root may itself be an alias; its resolved directory is pinned by the same proof, while receipt and
index directories beneath that root reject aliases. Terminal retirement checks directory and marker identity again
after reading the receipt evidence, before unlinking the marker.

Independent final review reproduced one recovery gap: a marker admission lasting three seconds let the
two-second retry remove its ID before the primary existed. A later pending result then waited for the minute
scan. The result now restores a missing ID at the normal two-second retry only when the retry window is not
crowded; existing retry times and crowded-window slot release stay unchanged. The independent RED had one
failure and one immediate-admission control (`/tmp/core-pending-index-final-review-red.log`). The exact regression
case and existing fairness controls pass: 17 tests, with all four coverage measures at 100% for
`pendingLaunches.ts`, plus types. Receipt `20261118T050806.406538Z-31358` records actual cleanup. The first
restricted attempt also passed those checks, but its receipt `20261118T050709.911651Z-29807` is failed because the
sandbox denied `ps` inspection; it is not counted as a passing validation receipt.

### Matched history-cost validation plan

The integration owner runs this after review, on the same pinned runtime and build inputs for baseline and candidate.
Use isolated roots with 1,000 and 10,000 completed receipts (the latter is the 10x history case), half legacy version 1
and half claimed version 2, and the same pending intents before and after that history. Include a supported legacy
writer adding a pending intent after the first completed scan; keep its directory timestamp unchanged. Measure cold
recovery and the next recurring pass separately, then empty idle and a fresh modern admission. Record physical child
PID/exit and open-descriptor cleanup, core and storage-child CPU/RSS, core event-loop delay, total receipt opens/read
bytes, time to prepare the first/last pending intent, and median/p95 fresh admission latency. Alternate baseline and
candidate order with the same fixture snapshots and host-load observations. Core may read selected pending receipts;
historical primary JSON must be opened only by the storage child. Do not infer speed or memory improvement from source
size or a passing unit suite. This task prepares the plan; root owns execution and acceptance with the final build.

### Packaged acceptance selection (prepared, not executed)

`e2e/pendingCreationIndex.e2e.ts` has two cases, selecting the full entry and the embedded lean entry from the same
reviewed artifact. Each uses 140 valid completed receipt names and one pending legacy intent, starts a credited
scan, kills its exact child, waits for exit/close/IPC disconnect, refuses the stale cursor and discovers the pending
intent with a replacement. After that scan completes, a legacy writer publishes another pending intent while the
directory timestamp is restored; the next child scan must find it and durably create its marker. Two concurrent
modern retries execute the selected intent once, terminal evidence retires its marker, and terminal replay still
works after the storage owner has permanently closed. Cleanup checks every owned child absent before deleting the
private root.

The existing `serviceProcesses` case named `keeps manual model requests through an outage and core crash` is extended
to kill only the current fixture core's verified `__storage` child while three requests are held on models. Their
statuses stay pending and core stays alive. It then exercises the existing core crash, cancellation, unrelated
agent turn, recovered Claude/Codex creation and duplicate retry checks. The fixture now awaits master exit/close and
both stream EOFs and asserts its owned PID/group/descendant, private socket and root cleanup. Its separate strict
fixture type check also exposed an existing nullable poll-result guard; that guard now checks the row before fields.

The fixed selection is `/tmp/core-pending-index-native-plan.json`: three cases, one worker, 180 seconds per case and
720 seconds for the outer validation check. It disables implicit builds and requires root to supply the exact
`E2E_BUNDLE_PATH` after the combined artifact is frozen. No optional native process-image artifact is assumed. The
fixture type check passes; no packaged execution or timing result is claimed by this preparation.

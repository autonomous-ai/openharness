# Pending creation discovery outside core

## Problem

`AgentCreationReceipts.pendingIntents()` opens every historical receipt and parses it in the core each minute.
`pendingLaunches` already bounds its retry window, preparation slots and per-pass work, but accumulated completed
receipts still increase core work. Receipt IDs cannot expire: an old client retry must never start another process.
The required session-storage child being introduced for Registry and stopped sessions supplies the process owner
for compatibility discovery. This work does not introduce another process or make durable creation optional.

This is a design checkpoint before implementation. No runtime or performance acceptance is claimed.

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
one existing data family: ensure marker, read the next discovery page, and retire a terminal marker. The root and
`agent-creations` destination are constructor-owned; callers cannot supply arbitrary directories or write contents.
Each operation validates IDs and returns bounded metadata. No callback, shell command or publication destination
crosses the boundary.

Core owns only its existing 128-ID retry window, four actual preparation slots and current scan cursor token.
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

Implementation waits for the required storage boundary's stable interface, then this design and the actual caller
changes receive independent review. The existing required storage extraction remains its original separate task.

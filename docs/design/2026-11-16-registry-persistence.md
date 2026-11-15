# Registry persistence without lock sleeps

Status: Design for review; no runtime implementation yet. Based on
`c3f590a247de488cbb61c50f105fe00e95746781`.

This is the first increment of core-plan package 9, step 4. Move registry lock
waiting, lock-owner process probes, the locked read, and temporary-image
preparation off the core event loop. Keep the smallest synchronous final
authority/publication section until a separate design can safely remove it.
**The whole step is not complete while rename and directory fsync still block.**

## Why a save queue alone is unsafe

`registry.ts` has 41 private `save` call sites: 32 non-strict, eight always strict,
and one strict only for external adoption. A save merges local changes with the
latest competing process snapshot under `registry.json.lock`; it does not simply
replace the file with the newest local image. It also reconciles whole ownership
groups after unconfirmed publication and refreshes the live indices from the
merged result.

Awaiting inside that implementation without changing its callers would allow a
later live mutation to be overwritten by an older completed save. Returning a
queued result from a strict method would acknowledge an unsaved close, dispatch,
or first-task removal. Moving final publication behind an await would invalidate
the native-evidence boundary relied on by hook admission and external takeover.

## Design

### Concurrency and commit sequence

Keep one persistence writer per Registry, not a global queue of in-memory
mutations. Observation setters and the body of `transaction(apply)` remain
synchronous. In particular, `hostMove.swap` must see its new route immediately
after calling a synchronous transaction body.

The active writer owns an immutable commit record: the current persisted baseline,
captured local rows, explicit field intents with mutation revisions, the strict
candidate/displaced group if any, and its captured authority identity. Preserve
the existing `mergedForSave`, ownership validation, unknown-schema refusal, and
unconfirmed-group recovery policies. A subsequent observation batch can fold
changes only until the writer captures it; strict barriers are never folded away.
Waiting strict operations retain their candidate and expected authority, not a
full copy of every registry row. The active writer captures the observation image
when it starts that operation, after the preceding committed baseline is known.

The writer proceeds as follows:

1. Acquire the existing mkdir/owner.json lock asynchronously with its existing
   two-second elapsed acquisition budget, including mkdir, owner creation, write,
   fsync and token verification; the strict request's overall deadline can shorten
   it further. Preserve owner generation/token and stale-owner policy,
   private modes and no-symlink checks. Replace `Atomics.wait` with an awaited
   timer, and use an asynchronous, bounded process probe. Retain the owner-file
   fsync. Revalidate the token after asynchronous lock setup so a reclaimed
   ownerless directory never grants permission to publish. Check time again after
   every asynchronous setup result. A mkdir or owner publication completing late
   cannot revive an expired request. Remove only a demonstrably owned token and
   directory incarnation after pending setup settles; an ownerless path whose
   identity was never established is left to the existing stale-debris policy.
2. Read and validate the latest registry through asynchronous descriptor-based
   equivalents of the private-state checks. Compute the same three-way merge
   and exact fingerprints. Timestamp equality is never evidence of equality.
3. Write the immutable merged image to a unique adjacent private temporary file,
   then fsync and close it asynchronously. Do not expose a strict candidate in
   live indices or invoke a success callback yet.
4. Refresh evidence that inherently requires an asynchronous lookup, if this
   authority transition has one. The callback checks the exact prebuilt candidate
   and expected identity; it cannot silently substitute another candidate. A
   changed answer aborts preparation and requires a fresh operation. This lookup
   has a deadline and runs while the existing file lock is held; its lock-hold
   cost must be measured.
5. In one synchronous section, recheck the lock token, the captured live ownership
   group, caller cancellation/current guards, and native proof. Then rename the
   prepared image, fsync the parent directory, and install the committed result.
   There is no await between fresh authority validation and publication. Retain
   the existing post-rename `AtomicWriteUnconfirmed` distinction and whole-group
   recovery. Reject an operation whose target was removed, moved, rebound or
   cancelled during preparation; do not resurrect it from its captured image.
6. Rebase observations that arrived during preparation onto the committed image,
   then queue their persistence. Release only the lock owned by this token. Resolve
   a strict result only after its directory fsync and live-authority check succeed.

Final publication intentionally remains synchronous in this increment. There is
no worker performing an irreversible late rename and no new persistence daemon.
The unrelated exported synchronous `atomicWriteJson` users are not mechanically
converted in this task.

### Rebasing live state

Let `L0` be the local rows captured before preparation, `L1` the rows now in
memory, and `C` the validated rows actually committed. Compute the local changes
from `L0` to `L1`, including deletion and explicit same-value field intent, then
apply those changes to `C` through the existing merge/identity policy. A row
unchanged since `L0` takes its committed peer value; a later local deletion stays
deleted. A later local field edit cannot be overwritten by `C`.

The persisted baseline becomes exactly `C`, never the rebased live result. Clear
only the captured intent revisions, retaining later intentions for the next
commit. Preserve controller object references and ephemeral holds only under the
existing same-binding rules. Strict candidates are staged separately from live
rows; their whole affected ownership group must still match before publication.
If a peer changed an unconfirmed group, reconcile the whole group with native
identity held, as today; do not apply a partial local delta over that recovery.

A transaction can temporarily stage an incomplete route swap. A strict binding
or exit flush must continue refusing an incomplete batch before merge conflict
resolution can disguise it by evicting another owner. A transaction's synchronous
body still runs immediately; its returned Promise and `afterTransaction` callbacks
wait for the corresponding durable batch. The existing `holdSavesMs` deadline
releases batching, not a persistence lock or an unsettled write.

### Strict acknowledgements and callers

Change authority methods to return awaited durable results, with no synchronous
compatibility fallback: `register`, `revalidateBinding`, external
`openPendingAgent`, `setExternalResume`, `finishExternalCancellation`,
`beginExternalDispatch`, `takeFirstTask`, and `setClosePlan`. Ordinary observation
setters continue returning their immediate in-memory result. For pending-agent
creation the implementation must choose one consistently awaited public method,
rather than expose different return types depending on whether adoption is used.

Update and test every authority caller:

- `bind.ts`, Cursor discovery, and `hookServer.ts`: await registration, then
  recheck captured process/binding identity before announcement or attachment.
- `pendingAdmission.ts`: await commit without accepting a stale, cancelled,
  superseded, or closed queue entry afterward. A newer verified conversation
  must still supersede an older pending one; uncertainty retains its place.
- `externalResume.ts` and `externalOwner.ts`: final native inspection must occur
  after asynchronous persistence preparation, immediately before the final
  synchronous publication. Signal callbacks become awaited where needed; the
  signal still requires fresh owner/current checks after any await. No signal,
  admission or launch follows an unconfirmed write.
- `restoreAgents.ts`: await the external dispatch journal before sending launch
  argv, and recheck the owner after waiting. Its journal currently runs through
  synchronous `TerminalDispatchControl.onDispatch`; make this callback awaitable
  in both tmux and PTY create/respawn paths, then recheck `current`, host/client
  incarnation and held-pane ownership before sending the command. Keep the
  host-side exact held-token check. A rejected callback means `not_started`, never
  an ambiguous dispatched outcome. This is an internal API change, not a terminal
  wire-protocol change.
- `closeAgentService.ts` and its update caller: cancellation invalidates queued
  close work immediately in memory, but its result is acknowledged only after
  the cancellation is durable. Deferred/failed plan updates and first-task handoff
  also await their exact commit. A first task is never returned to two waiters.
- `createAgentPane.ts`: await the pending reservation before authorizing its
  dependent launch. A failed reservation cannot be reported as created.

The caller's current/cancellation guard must be part of the prepared operation;
checking only after a durable stale candidate has been installed is insufficient.
No action gains authority from merely entering the write queue.

### Failure, backpressure and shutdown

Every strict request has one five-second deadline from enqueue to reply, covering
queue residence, lock acquisition, preparation and evidence refresh. Queue time
does not reset that clock. Expiry while queued removes and rejects the operation
without performing I/O. Expiry while active rejects its reply and revokes its
permission to enter final publication; cleanup waits for the active OS request
to settle. The synchronous final section cannot interleave a timer callback: its
entry checks the deadline, and once entered its durable result is reported without
pretending that an irreversible publication was cancelled. Its measured blocking
time remains an explicit limitation of this first increment.

Strict queue capacity is 64 waiting operations plus one active writer, matching
the current native-admission capacity. Refuse additional strict work with a named
persistence-unavailable result; do not evict an earlier intent. Observations retain
one folded pending batch, not an unbounded history of full snapshots. Queue depth,
oldest wait, lock duration, preparation duration and final-section duration carry
no content, paths or identifiers. A queue/high-latency warning names the failure
and existing binding/launch holds expose it to the operator.

An I/O timeout cannot prove the OS operation was cancelled. Do not release the
lock or remove a temporary file while an operation using it is unsettled. Fail
dependent authority closed and keep cleanup attached to actual settlement. Never
retry a rename whose completion is uncertain as if it did not happen.

`flush()` becomes an awaited durable barrier. Graceful shutdown and update handoff
stop producers and await it before releasing the core socket or exiting. The
current `process.on('exit', synchronousFlush)` cannot await; remove it only after
all graceful paths use the barrier. Abrupt death preserves previously acknowledged
commits, not unacknowledged observations. An incomplete batch at exit remains a
reported failure with the prior durable snapshot intact.

Startup `load` currently does synchronous native validation, migration, boot/name
file I/O and possible registry writes before serving requests. That startup path
is explicitly outside this first increment and remains an outstanding part of the
full step. Name-file saves on runtime rename/save paths must use the asynchronous
writer/barrier too; the separate file retains its existing format and merge policy.

### Data checklist

- **Growth:** no new durable store or schema. Existing registry row lifecycle
  remains. At most one active image, one folded observation batch and 64 strict
  waiters; temporary images are removed on known failure/success, and existing
  crash debris policy is retained. No content-bearing measurement is added.
- **Concurrency:** one local persistence writer plus the existing cross-process
  mkdir/owner lock. Same old-writer merge and recovery semantics. In-memory
  observation transactions remain synchronous.
- **Read cost:** exact locked snapshot is still required to merge an old writer's
  changes. The unchanged observation optimization remains exact-byte based. No
  new polling or native history scan is introduced.
- **Scale:** measure current and ten-times registry populations. First warning is
  lock/queue latency or queue capacity, then final synchronous-section latency.
  Full-file JSON merge cost remains measured work, not declared eliminated.
- **Compatibility:** no HTTP, socket, registry-row, owner-file or archive contract
  change. Current and last-30-day writers take the same lock and read the same
  bytes. Internal TypeScript Promise returns change atomically with all callers.
- **Migration/rollback:** none. Rolling back reads the existing files and lock.
  The first increment does not introduce a second persistence mode or feature flag.
- **Audience/identity:** N/A for new access; the registry stays under the same OS
  account, private directory/file protections and existing core authorization.
- **Failure:** corrupt/unknown/unsafe files stay refused; strict errors propagate,
  non-strict failures are logged and leave dirty state retryable; unconfirmed
  ownership remains held. No acknowledgement is based on an enqueued operation.
- **Platforms:** daemon macOS, Linux and Windows. Preserve Windows ACL/root and
  directory-fsync behavior; read Windows rules before changing process probes.

## Validation selected before implementation

Profile the baseline first, on a disposable data directory and pinned Node 24.
Record idle/unchanged saves, changed saves and a second real process holding the
legacy lock; retain all failed measurements. Compare identical workloads on the
same host, including event-loop heartbeat latency, write/lock duration, CPU and
memory, at current and ten-times row populations. Heavy/performance runs require
root scheduling; focused tests use one worker while other work is active.
The first increment changes native-admission and terminal-dispatch callback timing;
these caller changes are required scope, even though no transport format changes.

Write failing behavioral tests before runtime edits:

1. A real legacy lock holder blocks a durable request while an unrelated core
   heartbeat/route responds; releasing the holder permits the exact commit.
2. Two real processes concurrently change distinct rows/fields, delete rows, and
   contend for one conversation/route; no peer update is lost and no stale row is
   revived by an unchanged local snapshot. Test both writer versions/directions.
3. Pause preparation at an explicit test barrier. Rename, touch, remove, swap
   routes, change home/process/binding and cancel a close while it waits. Verify
   rebased observations survive and stale strict candidates never publish. Cover
   row deletion, property deletion versus explicit `undefined`, a same-value
   intent repeated at a later revision, and nested/input/live-row aliases mutated
   while the image is preparing. Neither captured snapshots nor cleared intents
   may change through those aliases.
4. Close intent, first-task removal, adoption admission/cancellation and dispatch
   return no success before fsync. Fail each write phase; verify no prompt, signal
   or launch occurred, and retry never duplicates a successful authority action.
5. Replace native evidence or supersede a pending hook while preparation waits.
   Check whole-group refusal/recovery and no stale publication/notification.
6. Kill a real writer before owner publication, after temporary fsync, and after
   rename. Restart and exercise old/new readers. Pin owner-generation handling,
   token cleanup, incomplete route-swap exit, and peer changes to unconfirmed
   displaced ownership groups. Use barriers/IPC, no fixed sleeps.
7. Graceful shutdown/handoff drains the exact accepted batch; forced shutdown does
   not claim an uncommitted acknowledgement. Exercise queue capacity and failure
   settlement without releasing a lock still used by an OS request.
   Expire a queued request behind a blocked active writer; it must answer within
   its original deadline and never execute later. Expire during mkdir, owner
   write/fsync and temporary preparation; late completions never authorize a
   rename or remove another owner's lock.
   While a dispatch journal waits, replace the PTY client, cancel the owner or
   replace the held shell; neither terminal backend may dispatch the stale launch.
8. Preserve private-file, symlink, unknown-schema, legacy migration and Windows
   path behavior with the existing suites plus affected asynchronous cases.

Run typecheck, registry/binding/adoption/close/restore/move/hook affected suites,
required local core/resume/portability gates selected by the checked-in runner,
and a real private-daemon flow. Root owns the full CLI CI, independent review,
integration, PR and merge. This Design requires review before runtime edits.

## Deferred destructive storage dependency

A strict absence barrier can prove that a conversation is absent from a merged,
fsynced registry image at one instant. It cannot fence an old daemon that loaded
the former live row before that instant and later restores it from memory. Nor
does an absent row prevent a changed stale old-writer snapshot from recreating it.
Do not export this barrier as authorization for a database purge worker. That
destructive operation needs its own old-launcher exclusion design; no purge code
or new absence API is included in this increment.

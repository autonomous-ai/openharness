# Registry persistence without lock sleeps

## Pending admission during discovery (17 November Design)

Concurrent native Claude/Codex creation exposed a pending-admission refusal; its
single diagnostic run did not reproduce that failure. A deterministic transaction
test then exposed a defect: pending admission alone did not permit the writer to
validate and commit a complete observation batch, as process admission and binding
already do. Give it the same existing permission;
retain whole-batch validation, durable peer ownership, captured live ownership,
the original write deadline, and publication before returning its detached row.
Do not wait inside the writer for a transaction whose callback may await that
same admission. Incomplete swaps and competing durable route owners still refuse.

This introduces no record, queue, storage shape, migration, identity or audience
change. Work and bounds remain those of the existing strict writer, with no new
polling or retries. Existing content-free refusal diagnostics remain; the private
native diagnostic classifies only fixed reasons and is not part of this change.
Shared TypeScript affects all platforms; native evidence here is macOS x64.

Select deterministic real-transaction RED first, plus incomplete-batch and changed
peer-owner controls, the complete Registry unit file and related admission/merge/
observation files, source types, and the unchanged concurrent native reader case.
Keep the earlier native failure and require actual exit, EOF and owned cleanup.
Broader integration gates follow only after this correction is accepted.

Status: reviewed Design; first increment implementation and focused validation in progress. Based on
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
   ownerless directory never grants permission to publish. Final owner reads are private
   and capped at 4 KiB, including concurrent growth. Lock cleanup performs a no-yield
   inode/token/ownerless-state fence, reads at most two directory entries, and removes
   only owner.json plus the empty lock directory. Unexpected contents hold the lock
   and produce a named warning; cleanup never recursively walks it. Check time again after
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
compatibility fallback: `register`, `revalidateBinding`, `openPendingAgent`,
`resumePendingAgent`, `setExternalResume`, `finishExternalCancellation`,
`beginExternalDispatch`, `takeFirstTask`, and `setClosePlan`. Ordinary observation
setters continue returning their immediate in-memory result. For pending-agent
creation the implementation must choose one consistently awaited public method,
rather than expose different return types depending on whether adoption is used.

Successful strict methods return a snapshot of the committed owner. Controller
references in the live index remain stable under the existing rules, but a later
alias mutation cannot silently change an already-returned authority result. A
receipt is an operation-local identity string, never a retained receipt store.
Pending creation/resume preserve their null-on-refusal contract and log storage
failure; other strict failure paths reject their Promise. Resume source/current
checks run again before publication, and previous-agent links clear in its image.
Close-plan writes retain ordinary peer metadata merging; the durable ownership
identity still fences a stale close, and a missing peer row is never revived.
Observation/flush barriers reject failed storage but retain the unchanged-image
fast path; identical explicit close intent still requires durable publication.

Update and test every authority caller:

- `bind.ts`, Cursor discovery, and `hookServer.ts`: await registration, then
  recheck captured process/binding identity before announcement or attachment.
- `hookServer.ts`: retain the existing prompt/Stop delivery while awaiting storage.
  A queued admission or native-source wait replies pending promptly. A commit
  already preparing its durable image gets at most 250 ms for its initial HTTP
  success reply; after that the reply is pending, below the hook process's five-second
  timeout. Pending never grants prompt/Stop credit. The registry's separate five-second
  deadline revokes late publication while unsettled I/O retains ownership.
- Hermes source admission refreshes its exact indexed source query after image
  preparation. The existing bounded DB/WAL/journal/home evidence verifier is
  captured for this operation and invoked again in the final synchronous fence.
  The source must still classify as the same interactive home; source changes,
  cancellation and the original request deadline refuse publication. Shared-gateway
  admission also refreshes the existing session-pane reader, compares the selected
  hint with the captured hint, and retains that query's verifier until publication.
  Its policy may not move the conversation to another pane during preparation. No
  verifier map or duplicate source classification or pane-selection rule is retained.
- Resume readiness uses a strict `confirmResume` candidate on the existing writer,
  not an observation flush. It captures the selected owner before enqueue and stages
  the verified process, launch grid, ready state and explicitly supplied launch
  arguments together. The selected launch metadata is guarded too: a later local
  launch/argument/grid edit is preserved without acknowledging it as this publication.
  Omitted arguments preserve the old list; an empty list clears
  it. It reuses `persist`'s peer-conflict refusal, captured-image/rebase machinery,
  operation-local committed-owner receipt and whole-group unconfirmed recovery.
  The caller refreshes the exact pane/engine PID+start+executable probe after image
  preparation; the final synchronous fence rechecks the captured owner, operation
  cancellation and route/backend selection. The five-second admission budget is
  never renewed. Until confirmed directory fsync succeeds, the held terminal is
  not released, the resume reservation is not finished, readiness is not announced
  and launch arguments are not acknowledged. Post-rename uncertainty keeps the
  reservation and requires the same exact candidate/native proof to recover.
  Ordinary durable-result versus cleanup-settlement semantics remain unchanged.
  After releasing a terminal hold, the caller rechecks the committed process,
  conversation and route before finishing its reservation or announcing success.
  Shell readiness uses the same staged ready/argument publication and selected
  owner guard, with its allocated terminal still verified as present. No new queue,
  storage format, persistent receipt or generic mutation abstraction is introduced.
  Caller tests hold preparation, cancel/change the process or owner, introduce a
  peer write, fail post-rename fsync, and hold late cleanup; no unconfirmed path may
  release, announce, finish its reservation or return a successful resume.
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

CLI status awaits load-time migration writes before its explicit process exit.
Core shutdown arms its existing stop deadline before awaiting persistence; update
handoff already awaits each teardown action. A synchronous process exit handler
cannot wait and is removed; startup loading and final directory fsync remain
explicit blocking work for a future increment.

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
no content, paths or identifiers. Slow phase warnings are limited to once per
minute per four fixed phases (queue, lock, preparation, publication); ordinary
writes do not log measurements. A queue/high-latency warning names the failure
and existing binding/launch holds expose it to the operator.

A durable operation's result is separate from lock cleanup settlement. The active
queue record owns at most one cleanup Promise. Its caller receives the published
result after synchronous authority formatting; that record retains the writer slot
until cleanup actually settles, and cleanup failure is observed with a fixed warning.
Setup failure still waits for cleanup. This prevents a post-publication deadline
from denying an already-durable result without allowing another writer to race the
still-owned lock. Strict storage failures expose fixed categories, not parser input
snippets or filesystem paths; identity and unconfirmed-publication classes remain.

An I/O timeout cannot prove the OS operation was cancelled. Do not release the
lock or remove a temporary file while an operation using it is unsettled. Fail
dependent authority closed and keep cleanup attached to actual settlement. Never
retry a rename whose completion is uncertain as if it did not happen.

`flush()` becomes an awaited durable barrier. Graceful shutdown and update handoff
stop producers that can need a last write before sealing admission. An exiting
flush seals new authority and mutation calls synchronously: each is explicitly
refused with a fixed closing error. It drains work already accepted, writes the
final observation snapshot, and waits for actual cleanup settlement before its
caller can release the data-folder claim or local socket. Ordinary flush retains
the durable-result behavior; exiting flush is idempotent and retains one lifecycle
Promise, outside the bounded authority queue, without accepting another authority
operation. Its five-second write deadline starts at seal, including the drain;
expiry revokes a not-yet-started final image but does not release ownership while
an earlier OS request remains unsettled. The existing bounded core shutdown/update
deadline exits the process if settlement does not finish. Update teardown stops
advancing after that deadline, so a late drain cannot release the old claim after
handoff. Producers and native operations accepted before sealing may acknowledge
only their actually published result; new operations never acknowledge. The
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


## Design checkpoint: remaining launch publication callers

Review pending; production is frozen at source hash
`07df1930a340a1f32a4c76a566a7406e5d740318d7f284810818a6db4bf01353`, based on
`706a43ad1d9a65014268c1847ccc488f4cf133b2`. The first increment cannot ship with
these callers merely enqueueing the writes they previously completed synchronously.
The earlier growth, locking, privacy, compatibility and platform design still applies:
no new file, writer queue, persistent receipt, feature setting or storage format.

| Caller | What currently follows an observational write | Required boundary |
| --- | --- | --- |
| `core/agents/restart.ts:commitRelaunchedEngine` | process/grid and active setters, terminal hold release, announcement, successful restart reply; explicit launch words are set separately before this | Publish the exact replacement process, ready/active state, launch words and launch grid together before release/announcement/reply. Include the terminal-only restart branch and host-move fallback that calls this helper. |
| `core/agents/retarget.ts` success branch | terminal hold release precedes process/grid, grid launch/web-search pair, remembered subscription model and active setters, announcement and `{ok:true}` | Stage the complete replacement launch record in one strict candidate before the terminal hold is released. A native model change or replacement already started remains described as applied/uncertain on failure. |
| `core/agents/newPane.ts` readiness watcher | process and ready setters, terminal hold release, ready announcement and bind hint; its engine-exit branch releases the hold before archive/shell transition | Strictly publish process readiness, or the distinct engine-exit/shell ownership group, before release/announcement; keep the original launch operation, selected backend/runtime and OpenClaw-local screen requirement. |
| `lib/restoreAgents.ts` readiness watcher | process setter, settle wait, terminal hold/route release, bind hint and “engine up” log | Settle first, then strictly publish the exact process/ready state with a fresh final probe. Shell success/fallback must publish before clearing its hold. The earlier `summary.restored` means allocation/dispatch began; it must not be represented as ready. |
| `core/agents/hostMove.ts:swap` / `lib/hostMove/moveAgent.ts` | a fire-and-forget transaction switches routes/process, announces, then streams move, destination hold releases, old panes close and `{moved:true}` returns | Stage destination route/process, confirm durable publication, then install the row synchronously before stream retarget. Do not infer publication state from whether the Promise threw. |

Restore has a second authority boundary in the same caller: native-token
`onDispatch` and the fresh fallback call observational `setLaunch(starting)` and
label its result committed. That token transition must be a strict journal before
the existing terminal backend's post-callback held-shell/current fence can dispatch.
External dispatch already uses the strict journal and stays on that path.

### Proposed APIs and selection

Replace `confirmResume` with one narrowly typed `confirmLaunch(agentId, input,
authority)` used by these actual readiness callers and Resume. Its closed input
contains the verified `processIdentity` (null only for a terminal), optional grid,
explicit launch words, grid launch/web-search record, remembered subscription model,
and destination runtimes only for HostMove. It stages ready/active automatically;
it accepts neither an arbitrary row patch nor an arbitrary mutation callback.
Omission preserves a field; explicit null/empty values clear it according to the
existing setters. Reuse those setters' normalization rules in the candidate.
Remove the replaced observational setters at these success sites.

The API captures owner and selected launch fields before enqueue; it constructs the
whole candidate from the current row when execution begins, so unrelated queued
observations survive. The existing strict `persist` performs peer exclusion,
preparation, refreshed native proof, final no-yield validation/publication/install,
rebasing and whole-group uncertainty recovery. No general async mutation queue.
The ready fields themselves must still match the durable candidate before an entry
is returned as usable; return a cloned committed entry, never a live mutable alias.

Return a small publication result rather than a nullable entry alone:
`{ state: 'not-published' }` for a refused candidate before publication, or
`{ state: 'confirmed', entry: RegisteredSession | null }` after confirmed directory
fsync. A null entry in the latter means later ownership changed: the durable effect
happened, but no release/announcement may follow. Pre-publication failures keep
their safe typed errors. `AtomicWriteUnconfirmed` remains the distinct safe error
for rename-visible/directory-fsync-unconfirmed; do not erase it into a boolean.
Resume and ordinary readiness callers require a confirmed non-null entry and their
post-await current/owner checks; a published-but-changed result is not success.

Add the narrowly named `beginNativeDispatch(agentId, nativeToken, authority)` beside
`beginExternalDispatch`, using the same writer/strict candidate machinery. It only
stages the actual starting token and active state. The terminal adapter still
rechecks its exact held shell/client/current predicate after the awaited callback;
no native action is authorized by a queued journal or a mere observation flush.

The engine-exit branch is a separate narrow transition, `confirmEngineExit(agentId,
disposition, authority)`, where the actual existing dispositions are an in-place
shell, a separate successor shell, or removal. It reuses `releaseEngine`'s field
clearing and the strict candidate/displaced-group implementation: a successor UUID
is selected once, the original row is removed and the successor is installed in the
same durable group. It is not an arbitrary patch option on `confirmLaunch`.
`retainExitedSession` keeps its synchronous archive save first, awaits this strict
transition, then emits `agent_deleted` before the archive/successor announcement as
before. The new-pane watcher awaits it before releasing the physical pane. Failure
retains the archive and terminal hold and emits no successful deletion/successor
frame. Other observational callers may observe/report the returned completion; they
must not synthesize a successor before it. This removal receipt is not purge-worker
authorization; the old-launcher limitation above still applies.

An initially unbound readiness row is allowed to acquire its first verified process
and native hook binding during the readiness wait. Capture the strict selected
owner after that native observation, accepting only the same agent generation,
engine and selected route and the exact verified process if already populated.
Do not pin a null process from watcher start and then reject its legitimate arrival.
A previously selected non-null process is different: restart/retarget may replace
only the exact old process their operation selected, with the exact replacement
proved by that operation. A third process or unrelated binding is refused. A hook
that changes the owner during image preparation revokes that image; any retry must
reselect/reprepare with fresh proof under the same operation/cancellation budget,
not relax the final owner fence or reuse the stale prepared image. Resume still
pins its saved conversation: an initially null process does not authorize a changed
conversation. A create with no bound conversation may accept its first native hook
only for the exact proved process and same agent generation/engine/route. A bounded
one-time re-selection for that legitimate initial hook is permitted only after a
positive never-published result, with fresh before/after preparation proof and the
same original publication expiry. It is not allowed after uncertain publication.

Keep lifecycle generation/cancellation separately from the pre-commit row snapshot.
`createLaunchAuthority` currently includes process, boundAt and launch, so blindly
reusing its original row predicate would both reject a legitimate initial hook and
reject the method's own successful ready/process installation. Use the original
lifecycle/cancellation fence throughout; after commit, match the cloned committed
owner/launch receipt instead of the superseded pre-commit row fingerprint. Recheck
that pair again after terminal release.

Each caller supplies a post-prepare probe of its exact backend/runtime/engine,
comparing PID, start identity and executable, and a final synchronous operation
fence. Restart retains its lifecycle revision and target; retarget retains its
captured launch authority and native configuration verifier; new-pane retains its
launch generation/route and local-screen prerequisite; restore retains its original
revision/cancellation owner and allocated runtime. Recheck the committed entry after
terminal hold release before success/announcement. Never recapture a cancelled
operation as a new one. Native deadlines and the five-second writer budget do not
restart when proof is refreshed.

### HostMove publication states and recovery

This explicitly amends the earlier timing sentence about `hostMove.swap`: ordinary
`transaction(apply)` still applies synchronously, but this authority change uses a
staged candidate. `MoveAgentDeps.swap` becomes Promise-returning. Its final row
installation remains a single synchronous step and still precedes stream retarget.
A stream opened during preparation attaches to the old route and is included in the
subsequent retarget; no stream can open in a row-switch/retarget gap that is omitted
from that retarget. The old transaction is insufficient: it is an observation merge,
has no final native refresh, and its `finally` would persist provisional live changes
even when a later authority check failed.

The move keeps captured old and destination runtime/process evidence, its existing
input/route holds, and the move marker while swap is pending. Maintain an
operation-local publication latch, initially `never-published`. On the first
`AtomicWriteUnconfirmed`, set it to `uncertain` before any retry or recovery. Only a
positive durable receipt may advance it to `confirmed`; a later not-published,
owner-changed, cancelled, expired or I/O-failed retry cannot move it backwards.
A confirmed receipt with null entry also remains confirmed: it permits no fallback
and no stale cleanup. Do not pass swap through the current `bounded()` helper or
its stringifying catch; preserve the typed publication result/error until this latch
has been updated. The outer catch and `recover()` branch on this latch, never on
whether the last attempt threw or on the old `swapped` boolean alone.
There are three paths:

1. **Never published.** A refusal/revocation/pre-rename failure is known not to have
   published. Existing recovery may close only the exact destination this operation
   allocated; only a confirmed close permits the strictly confirmed fallback launch
   in the original pane. Cancellation still forbids that fallback.
2. **Rename visible, durability unconfirmed.** `AtomicWriteUnconfirmed` is neither a
   failed swap nor a confirmed swap. Do not kill the destination, relaunch the old
   engine, clear terminal holds, close old panes, announce success, or return
   `moved:true`. Retain both exact references and let the existing whole-group
   unconfirmed-binding mechanism reconcile/confirm the same candidate under fresh
   native proof. No guessed rollback from an in-memory row that still names old.
3. **Confirmed.** Once the directory fsync is confirmed, a subsequent ownership
   change or destination-release failure must never trigger old-engine fallback.
   Stream retarget, hold release and old-pane close operate only while the confirmed
   destination still matches this operation. Report a release failure explicitly;
   retain its held pane and do not describe incomplete cleanup as a completed move.

Unconfirmed recovery must remain bounded and use the **same immutable full
candidate**, not rebuild one by calling the public method against the now-current
row. `persist` compares the full candidate intent plus affected-row before
fingerprints; rebuilding after even an unrelated observation can be a different
intent and select rollback/reconciliation instead of confirmation. `confirmLaunch`
owns at most one same-candidate reprepare after `AtomicWriteUnconfirmed`, keeping
that first candidate, affected selection and original guard operation-local. Its
uncertainty latch also stays set across the retry; if the retry cannot positively
confirm, it returns the original safe unconfirmed category with the later fixed
failure reason, never a never-published category. This bounded recovery policy is
shared by the readiness callers, so their success still requires confirmed fsync.
If the same candidate/owner cannot still be proved, leave it held rather than
substituting a newly selected owner.

Each attempt is a **separate existing writer admission** with the same monotonic
expiry captured before the first attempt. Do not call `persist` twice inside one
`writer.run`: each file lock retains one cleanup, and `RegistryWriteQueue.retain`
allows one cleanup per operation. The second admission waits for the first attempt's
actual cleanup settlement. Clamp both admission expiries to the original remaining
five-second budget; refresh/recovery never renews it. A legitimate first-hook
re-selection before publication, if needed, is separately bounded to one and uses
that same expiry. None of these paths creates a second queue or retained receipt
store. Actual pending I/O retains writer ownership as already designed.

If recovery cannot confirm within that budget, return a named held/uncertain failure
and reuse the existing `moveHeld`/conversation hold and route reservations until the
existing startup orphan/registry reconciliation establishes which route survived.
Register that existing refusal **before** freeing any transient input hold. Expose
a small wiring callback for that registration; add no new map or journal. A peer
reconciliation or a late failed retry never authorizes killing either captured pane
or relaunching old merely because the live row still names the old route.

### Refusal covers pending and direct input

The existing `moveHeld` predicate is the durable-in-this-process refusal source;
the presence of a transient `MoveGate.holds` queue is not authority. `holding(id)`
(or an explicit `refused(id)` check at every caller) must still refuse after the
queue is deleted. Do not retain another failed-agent map. Gate enqueue gains a
refusal callback beside deliver at its six producers; drain/refuse releases every
closure without invoking a native write. A failed drain is not a successful release.

Those six callbacks alone are insufficient. The exact consumer contract is:

- `SessionInput.submit` and `submitNow` reject new work with delivery
  `rejected/held`, receipt `held`, and the existing actionable error path.
- `drainNow` checks refusal before taking an item or injecting. A refused drain
  settles **every affected already-queued item**, including items queued before
  the move, exactly once; it does not discard only the gate's drain closure or leave
  `state.queue` stranded. `drainOne` uses the same refusal path.
- A `scheduleWrite` already chained behind `state.writes`, or held behind cancel,
  checks the predicate again when it becomes runnable. Its receipt is rejected if
  still not started. The final injection/current fence checks before the first
  native write and after lease/validation/screen awaits (including lease retries),
  not only at enqueue time. Already-started effects retain the existing unknown/
  ambiguous receipt; they must not be relabelled as never sent.
- `acquireControl` refuses even when no transient gate remains; `acquireAfterHold`
  returns refusal rather than polling a permanent uncertainty hold. Pinned/native
  control and key/paste/Enter paths recheck the same refusal after waits before
  effects, using the existing allowed/current lease fences. Revoking queued input
  must not issue Ctrl-C to an unconfirmed route.
- `terminalStreamManager` checks the predicate for immediate raw input, text/file/
  image paste and scroll as well as the queued callbacks. Its four queue producers
  settle the existing terminal error/receipt on refusal and free buffers. Deleting
  the gate must not expose a direct write path or make an old stream writable.

The hold registration wires the existing queue cancellation/refusal mechanisms to
settle pending work promptly, without deleting the agent or its turn state and
without a second queue. State needed for an already-started write survives until
that result settles. New/queued work stays refused until existing ownership recovery
clears the move hold; handover does not clear it as a convenience.

### Handover while publication is still pending

`settleMovesForHandOver` currently waits twenty seconds and then success-drains
`releaseAll`, although process proof can still be running for thirty seconds. A
refusal set only after `AtomicWriteUnconfirmed` reaches the caller cannot protect
this interval. After the bounded wait, handover explicitly fails/refuses every
remaining transient input hold and revokes the pending move's existing lifecycle
operation; it never force-success-drains an unconfirmed move into whichever route
happens to be in memory. The active move's own later `finally` cannot override this
refusal. Accepted persistence retains its actual-settlement ownership, and the
already-designed terminal exit barrier precedes listener/claim release. Handover
remains bounded by its existing exit deadline, not an infinite move wait.

No production changes to these paths precede review of this failure policy.

### Caller validation before broad gates

Write real-registry caller reds for all five sites, then green: held temporary fsync
must block success and terminal release; cancellation, selected owner/route/backend
replacement, native PID/start/executable changes and peer ownership must revoke the
prepared image. Include initial-null process becoming the legitimate hooked process,
and a startup hook arriving during preparation. Check exact requested launch words,
grid launch/web-search pair and remembered model after a fresh registry load.
For restore, hold native dispatch journaling and prove no backend dispatch; cover
shell/fresh fallback readiness. For HostMove, cover stream-open during preparation,
never-published fallback, lost directory fsync, a peer changing the ownership group,
cancellation before/after publication, unconfirmed then owner/deadline/refusal on
retry, an unrelated observation between the two immutable-candidate attempts,
exhausted recovery, and destination release failure. Exercise `followRow` with a
stream open that is still awaiting its backend when retarget scans existing streams.
Test input queued before the gate, a pending drain callback, a scheduled/leased write,
control acquisition and direct stream input after transient-queue removal, and
handover while swap/proof is still pending. Every refused message/buffer settles its
existing receipt exactly once; no native write occurs. Include engine-exit successor
publication, its durable archive, and post-commit fences that survive the method's
own ready/process update. In every unconfirmed case no old
engine is relaunched beside a possible destination engine and no moved/ready success
is emitted. Existing true-red and failure evidence remains retained.

## Design checkpoint: Stop and forced forgetting

Review pending; no production correction to these callers precedes review. The
caller audit confirms Stop still calls `forgetSession` without awaiting it. Forget
saves the archive synchronously, drops/unbinds the live row observationally, and
emits deletion immediately. With asynchronous observations, successful Stop/Close
can precede durable removal. This is the same authority-publication problem above.

Make `forgetSession` return `Promise<void>`, rejecting with a fixed safe identity/
publication error when it cannot confirm the selected transition. It captures the
resolved owner before enqueue, keeps archive save before removal, and uses existing
`confirmEngineExit(agentId, 'remove', authority)` for an actual live-row removal.
Only a confirmed publication followed by the selected agent remaining absent may
retire the per-session stores or emit `agent_deleted`. An unconfirmed publication
never emits a successful deletion; the archive and existing uncertainty recovery
remain available. There is no second queue, receipt store or arbitrary patch API.
An explicit `agentId` must not resolve a reused session ID into a different agent.

`keepAgent` means binding removal, not engine exit: add the narrow
`confirmSessionUnbound(agentId, sessionId, authority)` using the same strict writer,
owner guard, cloned candidate, `clearBinding` and receipt machinery. It preserves
the selected process/routes/launch and removes only the exact selected binding.
Bindings already removed by strict registration/revalidation need only local
cleanup; they must never unbind another row that later acquired the old session.
Already-absent eviction/cancellation notifications follow their existing strict
group receipt, so they perform no extra disk mutation. No optimistic absence is
invented for a queued removal.

Stop awaits forgetting before resolving, releasing a pending resume reservation,
or letting Close report success. Its existing selected owner/conversation and
Close permission are carried to the final publication fence, with refreshed exact
process-exit evidence and retained transcript verification after preparation.
Terminal-only or initially unbound rows still require the successful owned pane
termination already performed by Stop. After publication, do not reuse a predicate
that requires the removed row; check the confirmed removal/absence and preserve
the original cancellation generation independently where the caller supplies it.
Failure keeps Stop's safe `STOP_UNCONFIRMED` category and releases no success signal.

Forced caller inventory: `bind.handleRegistered` (rebound/evicted/orphaned), binding
revalidation and OpenClaw folder changes, `discovery.onDiscovered` eviction,
`discovery.onRemoved`, and external-adoption cancellation. The asynchronous callers
await forgetting before dependent reset/announcement/browser transfer. Reconciler
already awaits its removal callback; make that callback return the Promise and
report failures through its existing bounded pass. External cancellation already
strictly removed its row; await its cleanup/notification before answering. Preserve
the no-await final publication/install section and recheck selected caller authority
after any newly introduced wait before another native action or announcement.

Purge's worktree and session branches already await Stop, then require no live row;
their dependency inherits this durable boundary. It does **not** authorize the
proposed purge worker: an old daemon can still restore a snapshot loaded before
the new daemon's removal. No old-launcher fencing or global absence proof is claimed.

After the quiet window, add real-registry held-image-fsync reds proving Stop's
Promise, deletion frames, reservation release and a purge deletion dependency stay
pending. Cover cancellation/owner replacement during preparation, late cleanup,
peer ownership and directory-fsync failure; no success or duplicate launch after
uncertain removal. Add binding-only and already-strictly-removed caller cases so
this change neither deletes a replacement owner nor deadlocks a registration
callback behind its own active writer cleanup.

## Design correction: discovery ownership is not yet a durable receipt

Review pending. The preceding inventory was wrong for discovery eviction:
`openProcessAgent` is synchronous and observational, as are `reinstateArchived` and
`adoptEngine`. Their only production caller is `core/agents/discovery.ts`.
`onDiscovered` announces its new owner and forgets an evicted row before queued save;
`onObserved` removes a stopped archive and announces its revived owner before queued
save, or promotes an adopted/starting process to ready observationally. Those
branches remain incomplete and must not use an absent live row as a receipt.

Proposed narrow correction: make these three ownership-changing registry methods
awaited strict transitions at their existing sole production caller, preserving the
observational setters used for ordinary already-ready refreshes. Do not add a
second observation API or convert every setter. Each method selects/captures its
exact original owner(s) before queue residence, stages clones without dropping live
indices, refreshes the observed engine in its exact backend/runtime after image
preparation, and uses the same final owner/lock/native fence and durable receipt.
Discovery already returns Promises to the reconciler, which awaits them. The
methods may publish within the existing transaction via `allowTransaction`;
awaiting `afterTransaction` from inside that transaction would deadlock and is not
the proposed solution. A strict group can include current unrelated observations,
which still use the existing merge and rebase checks.

`reinstateArchived` stages the saved owner and removal of its terminal holder as
the existing candidate/displaced pair. The stopped archive stays until a confirmed
non-null installed owner matches its cloned receipt. Then, synchronously, remove
that archive, notify the terminal successor and continue observation. Refusal or
uncertainty leaves the archive and old live owner intact and reports a fixed held
reason; no guessed rollback and no archive deletion. `adoptEngine` stages the exact
terminal's engine/process/ready transition; only its receipt authorizes browser
transfer, readiness notification and subsequent binding.

`openProcessAgent` stages its selected existing row or a new unbound row, plus the
prior owners whose routes it takes. Selection and displacement must not happen on
live objects before publication. Multiple normalized routes can affect multiple
owners: extend the existing strict `displaced` representation to a list of those
affected rows, bounded by the supplied routes and existing bounded registry image;
do not create a global mutation framework. The existing whole-group peer validation,
uncertain image/prior fingerprints, reconciliation and final atomic install cover
the entire list. Return the bounded removed-owner list to the sole internal caller and preserve final
synchronous install before notifying. No route may be removed from another owner
without its same-group durable update. If a smaller representation can cover the
actual selected routes without weakening this contract, prefer it.

Every fully removed owner receives its captured-id cleanup and deletion notice,
including an existing selected owner taking more routes. Browser transfer retains
the original first predecessor choice and occurs only for a new owner. A retained
owner losing some routes is not deleted. Cleanup must not stop after one removed
row merely because the new owner changes during an awaited cleanup; each old row
is independently fenced by its captured identity, while transfer and new-owner
announcement require the installed receipt.

`onObserved`'s existing starting-to-ready success also goes through `confirmLaunch`
after its observational metadata fills, with the original operation/owner and fresh
exact native proof. A post-commit predicate compares the receipt and selected backend
rather than the pre-commit row. Ordinary already-ready liveness/model/title refresh
remains observational. No success notification or stopped archive deletion follows
a swallowed observation failure or `flush()` alone.

Add caller-level held-fsync tests for new discovery, displacement, shell adoption,
archive revival and starting readiness. Cover cancellation/owner/backend/process
changes, peer writes, directory-fsync uncertainty and archive retention, including
multiple displaced routes and a strict commit inside a reconcile transaction.
Benchmark only after source review in a reserved window; report any change in
discovery latency separately from the original registry write baseline.

Discovery's strict candidate also preserves the native observation's selected
primary runtime and gateway when supplied. Extend the existing closed launch input
with those actual optional fields, and give shell adoption the same closed route/
gateway/grid projection. Undefined preserves the prior value, as the observational
setters did. This avoids losing a selected non-first runtime or overwriting a hook's
gateway merely because discovery's ready transition is now strict.

## Design correction: explicit user choices require durable replies

Review pending. `core/agents/update.ts` is the sole production caller of registry
`rename` and `setLaunchModel`. Both presently acknowledge a person's requested
choice after an observational queued write. This creates an extra crash window
after making persistence asynchronous. `markOpened` is a throttled observation;
its Close cancellation already awaits strict completion. Engine-observed model,
title and timestamp updates remain observational.

Make `rename` an awaited strict names publication through the existing writer.
Capture the selected owner, engine session/name key and trimmed name before queue
residence. Prepare the existing names file with that staged intent, check the
same selected owner/key again before final publication, and expose the name in
the existing in-memory map only after confirmed durability. Return a cloned
matching row; no pane rename, reply or broadcast before that result. The file
format stays compatible with old builds. Old names writers do not participate in
the registry lock, so this increment cannot promise exclusion from a concurrently
running old names writer; preserve the current merge behavior and do not invent a
second persistent authority or silently strengthen that compatibility claim.

Make `setLaunchModel` an awaited strict row publication of its existing closed
model/effort field through `persist`, with the exact original owner selected by
the caller before awaiting the native runtime-profile controller. If the runtime
change succeeded but persistence is refused or uncertain, return an explicit
safe failure rather than success; do not guess a rollback of the engine's model.
Post-publication checks compare the returned receipt, not the pre-mutation row.
Combined name/profile/open requests remain ordered; partial completed choices
stay applied and the failed remaining choice is reported, as with the existing
native runtime-profile error path. Do not introduce a two-file transaction.

Both operations keep existing queue admission/expiry and publication-versus-
cleanup semantics. Caller failures use fixed categories (`AGENT_CHANGED` for
selected-owner revocation; `PERSISTENCE_UNCONFIRMED` for persistence failures)
and fixed log text, without paths, names, model content or raw errors. A flush that
swallowed a prior write failure is not evidence. Preserve unrelated queued name
intent and same-value intent revisions. No new queue, store or retained receipt.

Before runtime changes add real-registry caller reds for held names/model fsync,
owner/session replacement during preparation and runtime-controller wait, queued
expiry, write failure and post-rename uncertainty. Verify no reply/broadcast/pane
rename on refusal, durable success before normal replies, and the existing
combined-update order. Platforms remain macOS/Linux/Windows; there is no new
native process or wire schema. Limits and migration are the existing bounded
registry/names files, queue and backward-compatible atomic-file protocol.

## Local review checkpoint: caller inventory and remaining acceptance

This is a WIP review checkpoint, not acceptance or completion of package 9. The
following boundaries are implemented through the existing single writer; the
new full caller surface needs independent review and final validation at its
integrated source/environment.

| Caller family | Durable boundary and authority |
| --- | --- |
| Create/pending admission | `openPendingAgent` / `resumePendingAgent` publish before callers use the new owner. |
| Hooks and binding evidence | `register` / `revalidateBinding` preserve exact native-home/source proof, selected owner and peer ownership; hook replies await confirmed publication. Hermes refreshes the indexed source after preparation and verifies it in the final fence. |
| External Resume | `setExternalResume`, `beginExternalDispatch`, `finishExternalCancellation` retain the original operation/owner fences and await their durable journal/cancellation. |
| Native dispatch and first task | `beginNativeDispatch` publishes before native effect; `takeFirstTask` durably consumes the selected task before typing. |
| Close | `setClosePlan` persists intent/cancellation and checks plan revision through queued reason/status writes. |
| Resume, restart, retarget, new pane, restore | `confirmLaunch` publishes process/readiness/closed launch fields before terminal release or success. A first legitimate startup hook can supply the initially absent binding; it cannot replace a previously selected conversation/process. |
| HostMove | The same immutable `confirmLaunch` candidate has at most one separately admitted recovery under the original expiry; uncertainty is sticky. Publication is followed synchronously by route/stream installation. Pending/refused holds fence queued and direct input/control, including handover. |
| Stop/forget/exit | `confirmEngineExit` and `confirmSessionUnbound` precede deletion, reservation release and success; archive comes first. Session cleanup rechecks whether another owner acquired the old session. Attach-failure unbind also awaits strict completion. |
| Restore fallbacks | Both shell conversions refresh engine absence after preparation. Every fresh fallback strictly unbinds before respawn. A native dispatch journal then publishes the already-unbound owner before native effect; it does not itself clear a conversation binding. |
| Discovery | `openProcessAgent` atomically stages every affected route owner; every fully removed owner gets captured cleanup/deletion, with only the original first predecessor transferring its browser. `reinstateArchived` keeps the archive until confirmed live install; `adoptEngine` and starting readiness use strict receipts. Dormant retirement captures its selected owner/backend and refreshes native absence after image preparation. |
| Explicit core `agent_update` choices | `rename` stages the exact name key/value until publication, and `setLaunchModel` strictly publishes only the selected relaunch model/effort after live control. Fixed failure replies expose native-change-but-save-unconfirmed without success or guessed rollback. A later queued deletion survives an older prepared rename through existing name revisions. |
| Purge dependency | Existing callers await Stop and durable name deletion. No worker purge authorization or proof against an old daemon's stale pre-bind startup snapshot is introduced. |
| Exit/handover | Producer shutdown precedes terminal writer admission seal; listener/claim ownership lasts through actual settlement or the bounded process-exit deadline. Ordinary flush retains durable-result semantics. |

Ordinary process/liveness observations, terminal availability, title/model reads,
timestamps and throttled `lastOpenedAt` remain synchronous in memory and folded
into asynchronous observation writes. Their mutation APIs do not grant a durable
authority receipt. Synchronous transaction application and the existing peer
three-way merge/rebase semantics remain; last-state-wins is not the algorithm.

The replaced synchronous `remove`, `removeAgent`, `unbindSession`, `releaseEngine`,
`setLaunchArgs` and `setSubscriptionModel` APIs and the private `releaseBinding`
helper are removed. Test seeding uses existing strict transitions through a
test-only helper; historical benchmark adaptation lives only in its fixture.
Production reference search and TypeScript found no remaining callers. Component preferences
`setBrowser` (lifecycle) and `setGridLaunch` (the existing service API) remain
observational; this checkpoint does not assert a new durable component-preference
acknowledgement contract. The core `agent_update` inventory has only name, explicit
model and opened choices; engine-observed models remain ordinary observations.

Evidence is retained under `.harness/validation/registry-persistence/`. True reds
include all launch/HostMove/input families, Stop, discovery adoption/revival and
multi-route cleanup, late session reuse, explicit name/model held fsync, a later
name deletion, attach-failure unbind and dormant/restore native reappearance.
Invalid/unfinished fixtures remain recorded: the first dormant fixture used a
starting row, which correctly took the held-start path and timed out; the corrected
ready-owner fixture failed on the actual premature deletion. Queue-expiry coverage
uses the real bounded writer deadline; interrupted/fake-clock attempts are not
timing evidence. Fixture migration runs with failing old API assertions are not
passing suite receipts. A full integrated test selection, coverage/native gates,
crash/two-process acceptance and quiet after-profile comparison are still pending.

The closure delta remains exactly one added runtime file,
`lib/registryPersistence.ts`, required for every session's durable registry. No new
runtime dependency, service door, process, datastore or unbounded receipt map is
introduced. Startup load/migration/validation and the bounded final synchronous
authority/rename/directory-fsync section still block. Package 9 step 5 receipt
retention/scanning is untouched. None of those residuals is claimed complete.


## Independent review corrections at c6c881f13b

Four caller gaps remain scoped to the same persistence task. Existing authority,
queue, receipts, limits and compatibility rules above apply; no new state store,
wire field or process is introduced. Each correction requires a caller red before
runtime changes and retained focused green evidence.

1. Fresh restore fallback always awaits `confirmSessionUnbound`, including a
   native-token launch. Native absence is refreshed after preparation; only its
   confirmed exact-owner receipt permits the native dispatch journal. Unconfirmed
   unbind/journal never dispatches. The watcher may reset its first-hook baseline
   only to this confirmed unbound receipt and its subsequent dispatch receipt,
   keeping the original lifecycle generation, watcher budget and one fresh retry.
   A hook during the respawn reply or the next readiness probe must still match
   the exact observed process and original route/home; selection remains once.
2. Direct key control rechecks permanent move refusal after leased-terminal
   acquisition and carries the same predicate through coordinator/backend dispatch.
   Tmux `send-keys` and the PTY client write are synchronous effects with no wait
   before dispatch; each checks the predicate immediately before invoking that
   effect. Coordinator paths that await validation propagate the predicate too.
3. Binding revalidation accepts the existing lifecycle/current predicate and
   checks it at queue entry and final publication. A Stop that starts during image
   preparation must not gain a later evidence revision or recovery announcement.
   The caller rechecks the returned receipt and lifecycle after the await, including
   before any late forget/attachment announcement. Failure handling cannot install
   a hold after cancellation/replacement.
4. Resume passes its existing `ownsRoute && confirmedResume(receipt)` callback to
   `releaseHold`, which already checks at the physical backend effect. Cancellation
   during a backend wait retains the hold and cannot complete Resume or announce.

Acceptance includes real-registry held-fsync revalidation versus Stop, fresh native
fallback durable unbind plus legitimate first hook/readiness, deterministic refusal
between lease and key dispatch, and Resume cancellation while backend release waits.
The timestamp normalization fix at 91dbe0bf excludes only generated candidate
`lastTranscriptAt`; genuine local changes still invalidate full affected-row
fingerprints (five focused recovery checks pass). Full acceptance remains pending.


The four review families now have retained true-red caller evidence and eight
passing focused cases (`green-review-four-caller-gaps.log`). Actual native hooks
omit `launch` to mean ready; the watcher accepts that existing form under its
one first-hook selection. Additional unconfirmed-unbind/journal and replacement
cases pass. The initial Resume fixture asserted no announcements including its
legitimate pending announcement; corrected assertions begin at the held release.
The legacy launch-transition log lost during strict discovery conversion is
restored after confirmed publication (the pre-existing log regression test failed
before this correction). The old lock fixtures now expect strict admission to
reject directly rather than acknowledge and fail a later flush.


Checkpoint validation after review corrections: the corrected five-file focused
selector passed 545/545 (`review-fixtures-corrected.log`); the preceding seven-file
run retained 588 passing cases and 14 failures plus one fake-clock rejection, so
that earlier run is not a passing receipt. Its failures were addressed by real
readiness waiting, refreshed peer-owner cleanup, and fixture receipt/guard
expectations. The four untouched passing files in that run cover real launch
callers, restore, coordinator and PTY backend. TypeScript passed at the checkpoint;
subsequent changes are fixture/docs only. No full-suite receipt is implied.

The untimed profile fixture now awaits each 16/160-row admission and exiting-flush
settlement, so it cannot flood the bounded queue or remove a directory while lock
cleanup still owns it. The exact same fixture must run on both sources (`await`
accepts the old synchronous return), with the same 83 timed operations and 90-second
outer cap. Original baseline evidence remains unchanged and source-scoped; no new
profile has run. The remaining golden adapter migration preserves historical
native-command snapshots rather than recording new expected native behavior.


The historical control-transcript fixture now seeds the selected live row after
admission (rather than mutating its cloned receipt), flushes that untimed seed,
passes current backend dependencies while retaining the old fixture adapter, and
forwards Stop authority through strict removal. A `--verify` mode performs one
outcome with no performance collection/output. Stop and retryable Resume hold each
passed once on the current source; own-process identity remains synthetic and every
other host binary is forbidden. The earlier verification failures are retained,
including the missing async synthetic identity before the two actual adapter reds.
These are fixture correctness results, not new historical performance evidence.

The local checkpoint integrates exact main `8fcfa7de5cab3e3beec8f587a37785dca3798585`
without textual conflicts. Its reader/Close regression needed a semantic fixture
conversion: strict removal retains Stop's authority and completes before reader
cleanup. The original fixture produced `STOP_UNCONFIRMED`; its corrected case
passes. Incoming runtime changes remain unchanged, sharing the existing Stop
reservation with the binding revalidation fence.

The single-worker combined selector retained 167 passes and 10 Stop fixture
failures (`green-integrated-reader-close.log`, a failed run despite its filename).
The two unchanged passing files cover reader recovery and real-registry launch
callers. Stop's corrected selector then passed 65/65: it accounts for the final
native proof refresh, injects the existing guest wait instead of advancing a fake
clock through real disk I/O, stops its rebuild resolver from returning deleted
rows, and supplies complete adoption fixture records. TypeScript passed on this
combined source with Node 24.22.2. No broad/native gate or timing comparison was
run for this integration; those acceptance steps remain pending.

### Final Stop publication: native hold versus uncertain storage

The final caller audit reproduced two native-evidence changes after the physical
Stop, while the removal image was prepared or its final process probe awaited.
Both refuse publication, keep the durable/live owner and saved archive, and emit
no deletion, but the new forget catch converts the operation's recorded
`IdentityReadUnavailable` into `STOP_UNCONFIRMED`. That changes queued Close's
established retryable native hold into a failed plan.

The reviewed correction preserves only Stop's own `nativeIdentityError`, recorded
by its existing transcript verifier, at this catch just as its native-control and
termination catches already do. Arbitrary identity/owner errors, storage failures,
deadlines and `AtomicWriteUnconfirmed` retain the fixed unconfirmed Stop outcome.
That verifier runs in refresh/final verification before `prepared.publish`; its
captured error therefore refuses publication. `AtomicWriteUnconfirmed` originates
inside publication and cannot acquire that error classification. No guard, proof,
publication timing, retry, queue, receipt or persisted format
changes. The two deterministic held-image caller reds precede runtime changes;
paired preparation-failure and post-rename directory-sync cases already confirm
that the archive/reservation remains held and no success is announced. All
existing growth, concurrency, audience, identity, platform and rollback rules in
this Design continue unchanged; this correction adds no stored data or API.

Fixture acceptance also now selects actual live rows rather than mutating cloned
admission receipts, forwards Stop authority to strict removal, supplies explicit
final native-process proof, and awaits async purge/name cleanup. A synthetic
own-process lock identity remains the sole permitted process response in the
Hermes store fixture; no host binary is launched. The obsolete fixed-sleep Stop
retry is removed. Core and Resume broad-gate failures at `7211e3364d` remain
recorded failures, not passing receipts; focused corrected-fixture results do not
stand in for their pending final gates.

The reviewed two-line Stop correction passes both retained native-change reds.
`green-final-stop-authority.log` records 241 passing cases across six affected
caller/fixture files, with the one explicitly enabled-only native tmux case skipped
(Node 24.22.2, at most two workers, 106.09 seconds). TypeScript also passed on this
source (`types-final-stop-authority.log`). The paired image-preparation
and post-rename directory-sync faults still return `STOP_UNCONFIRMED` with archive
and reservation retained. The corrected attachment and lifecycle fixtures passed
in `final-authority-fixtures-first.log`; that run also retained six fixture failures,
then corrected in the later focused runs. No failed run is presented as passing.

Root's broad runner on the earlier `7211e3364d` exited 1: core had four failures and
4,567 passes; portability had 1,066 passes and ten platform skips; Resume had one
failure and 496 passes; shell had ten passes. Its PTY selection ran six tmux cases
with two skips because `HARNESS_PTY_BIN` was omitted, so it is not a complete PTY
receipt. Final gates must use the retained explicit PTY binary. No new broad gate,
native acceptance or performance measurement is claimed by this correction.

### Coverage acceptance and retained-owner inventory

The exact `02ebdf5c` broad run passed all 4,571 core, 499 Resume, 1,066 portability
(ten platform skips), fourteen native PTY/tmux, and ten shell tests, but core and
Resume coverage failed. These are failed gates, not passing receipts. Focused
caller tests now invoke the queued authority/refresh callbacks and verify both
retained refusal and successful publication; no coverage exclusions or golden
changes are permitted. Native/crash and timing acceptance remain deferred.

Root reviewed three redundant guards exposed by branch coverage. Restart now
refuses a confirmed-null receipt immediately as `changed after commit`, preserving
its previous observable result, before its ownership predicate and hold release.
Retarget similarly refuses null before constructing its predicate and announces
only after that proof. Their later impossible null checks are removed. The restart
handler maps any string helper outcome to its existing `AGENT_CHANGED`: its own
predicate synchronously proves the selected row exists before the helper's read,
so a separate no-await `vanished` mapping was unreachable. The shared helper keeps
its initial missing-row contract for callers with independent lifecycle guards.

One new caller test also reproduces a real retained-owner race. Resume's `retain`
callback selected the backend and awaited inventory before cloning its mutable
registry entry. Public process, route, or profile observations during that await,
durably flushed and confirmed through the live indexes and disk, became the new
selection. The callback then archived/removed that newer owner and could dispatch
a replacement. `red-resume-retain-inventory-corrected.log` retains all three true
failures; the preceding run used an invalid fixture path constant and is not red
product evidence.

The reviewed correction clones the entry before selecting its terminal or
awaiting inventory, derives the target/runtime from that clone, and retains only
that clone under the existing exact receipt/backend/lifecycle predicate after the
await. An ownership mismatch cannot archive, remove, release or dispatch from the
stale inventory. `checkLive` already has its caller's before/after `liveIdentity`
snapshot in `resumeStoppedAgent`; the new guard covers the second inventory in
retirement. Tests must cover process, route, home and strict native binding changes,
normal unchanged retirement, unavailable inventory and uncertain publication.
No new authority state, retry, deadline, persisted field or public API is added.
The Design's existing bounds, concurrency, identity, compatibility, rollback and
platform contracts remain unchanged.

The corrected caller suite proves the process/route/home inventory reds green,
preserves a strict native Codex binding and a replacement backend, and refuses
dispatch after real post-rename directory-fsync uncertainty. The existing
cancellation fixture now awaits its strict claim and forwards the authority
arguments before cancellation; both unavailable physical cleanup and unconfirmed
retirement preserve their reservation. Its previous immediate cancellation did
not model the named post-claim boundary.

Scoped coverage acceptance (Node 24.22.2, at most two workers) is now complete:
all eleven affected core files have 100% statements, branches, functions and lines
in `coverage-callers-final-first.log`. That run still failed overall (876 passes,
one new backend fixture failure), because changing a dependency property after
service construction did not change the already captured backend resolver. The
fixture now varies that resolver's result. The final three-file Stop/Resume/native
evidence selection passed 280/280 in 97.22 seconds with 100% in all four measures
for both affected Resume/Stop service files (`coverage-resume-callers-final.log`).
TypeScript passed (`types-coverage-checkpoint.log`). Earlier failed and invalid
fixture attempts remain recorded. These focused results do not claim the pending
combined-main broad gates, native/crash/two-writer acceptance or matched timing
comparison; no such execution was performed during this coverage correction.

### Persistence cost correction: repeated local work

The frozen `44995144a50c5e57fa598d5fc0e143e90b34ada2` matched 83-call
A/B/B/A run passed its functional, provenance and cleanup checks, but failed cost
acceptance. At 160 rows, changed-save median CPU for twenty operations increased
from 556.920 to 719.009 ms, p95 elapsed time from 122.269 to 145.506 ms, and sampled
maximum RSS from 122.803 to 198.963 MiB. The event-loop heartbeat improved from
122.812 to 4.777 ms. The original measurements remain source-scoped at
`/tmp/core-registry-cost-v1-summary.json`; neither successful outcomes nor improved
responsiveness make the CPU, memory or elapsed-time regression acceptable.

Root's reviewed four-window counter diagnostic on the unchanged old/449 bundles
passed its private-file outcomes and cleanup. Its manifest is
`/tmp/core-registry-cost-counts-v1-pair/manifest.json`, SHA-256
`953ac7537e78fd24d8d75309dce6429bcddd488ad2718e22199071a5a50d2678`.
At 160 rows an unchanged flush fingerprints 320 rows on both versions; 449 also
deep-clones 160 rows and fingerprints 160 ownership records. The changed
`setCwd`/`flush` pair fingerprints 1,121 rows on old and 1,441 on 449; 449 also
deep-clones 480 rows and fingerprints 320 ownership records. These counts
identify repeated work, not the full cause of the CPU or RSS difference.

The reviewed correction is limited to two changes in `persist`:

1. Reuse `beforeCommit`'s immutable row fingerprints in the unchanged observation
   comparison. Every strict candidate call passes `strict = true`, excluding that
   path before a candidate can replace a captured row. Keep the population check
   and exact private-file byte comparison. This duplicate fingerprinting already
   existed in the old writer; removing it is a measured correction opportunity,
   not evidence that it caused the whole regression.
2. Remove the deep clone only from the final `liveRows` construction after the
   last evidence refresh and ownership checks. `persistedRow` still copies each
   outer row and runtime entry. The merge reads its remaining nested values
   synchronously, copies candidates before changing fields, then normalizes,
   publishes and installs the live result without an await. `index(..., false)`
   invokes no engine callback; those callbacks remain after the writer callback.

The first pre-await immutable capture and strict candidate clones stay. So do
`beforeOwners`, all native/current/cancellation checks, locked peer reads, exact
rebase and intent revisions, final rename and directory fsync, unconfirmed-group
recovery and receipts. No shallow live snapshot survives an await on the successful
publication path. No cache, state mirror, extra revision counter, retained field
list, API or persistence format is introduced. The rebase and its trailing
fingerprint check remain; whole-image serialization reuse is outside this patch.

Data Design: growth decreases by one transient full-table deep clone; existing
image, observation and strict-waiter bounds remain. Concurrency and read cost keep
the same writer, cross-process lock and exact snapshot read; only already-computed
operation-local fingerprints are reused. Scale acceptance still requires the
matched 16/160-row workload with CPU, RSS, successful-save and heartbeat results.
Compatibility, audience and identity are unchanged: files retain their existing
bytes/order and every current guard remains authoritative. No migration is needed;
rollback is a code revert. Failure, deadline, cleanup and crash-recovery semantics
are unchanged. This affects the daemon on macOS, Linux and Windows without changing
an OS call or process-start path; only macOS measurements are currently available.

Before runtime edits, `registry.persistenceCost.spec.ts` will exercise real public
`flush` and `setCwd`/`flush` calls with forwarded built-in counters: one unchanged
fingerprint per row and no third full-table clone beyond the two required
pre-await captures. These are deterministic work budgets, not timing assertions.
Control cases hold an actual temporary-image fsync, edit a nested array through
the live alias and delete a field, then verify both the captured durable image and
the later rebased image. Strict close cancellation, owner replacement, repeated
same-value cancellation and post-rename directory-fsync uncertainty must preserve
their existing authority/durability outcomes. Every wait and teardown is bounded;
tests use private homes/files and no engine. RED and GREEN remain pending root's
quiet-window schedule; no result is claimed by preparing this Design and spec.

The first default-sandbox attempt failed all seven fixture setups with storage
access refused; a direct own-process `/bin/ps` check was denied by that sandbox.
It is retained at `/tmp/core-registry-cost-correction-red.log` as an environment
failure, not RED evidence. The same selected spec, with the authorized private
native permission envelope and no mock/guard changes, produced the intended RED:
four unchanged-row fingerprints against a budget of two, and six row clones
against a budget of four. All five authority, alias/deletion and durability
controls passed. `/tmp/core-registry-cost-correction-red-private.log` records
two failures and five passes in 4.24 seconds on Node 24.22.2, one worker. No runtime
change preceded that RED; the Design and test are committed before the correction.

The two approved runtime edits pass all seven new caller cases in 4.21 seconds
(`core-registry-cost-correction-green.log`). The existing focused persistence,
observation and strict-admission selector then passed 23 cases, with 81 unrelated
cases unselected, in 10.50 seconds (`core-registry-cost-correction-controls.log`).
It covers live alias/deletion and same-value intentions, queued route authority,
peer metadata and exact-file checks, displaced-owner publication, and uncertain
strict recovery. Pinned Node 24.22.2 TypeScript also passed
(`core-registry-cost-correction-types.log`). These logs are retained under `/tmp`.
No native-wait patch was applied. No broad suite, build, crash matrix or new cost
measurement was run for this correction; root's integrated-source acceptance is
still required, and the earlier CPU/RSS/latency regression is not yet cleared.

Root's corrected-source ABBA run on `6f3b89ccc9` completed all 332 operations with
verified cleanup, but cost acceptance still fails. At 160 rows, median CPU per
20 unchanged calls was 106.781 ms before and 171.192 ms after; changed calls were
478.588 ms and 684.773 ms. Changed-call p95 was 120.240 ms and 129.533 ms, with
sampled RSS 120.699 MiB and 174.564 MiB. Event-loop heartbeat p95 improved from
120.448 ms to 4.106 ms. The old legacy-lock refusal remains a different outcome
from the new successful commit. Preserve `core-registry-cost-v2-summary.json` and
manifest SHA `e50bc38d76b04ea698e202dec0bba06027b42839b84b4bd9f5ffdc7593be3c3a`;
the correction does not clear the performance gate.

## Native test cleanup bounds

The lock/crash test helpers must not outlive a failed assertion. This changes
only private test processes and their waits, with no production data, authority,
storage, wire contract or migration change. Keep `ownProcessGroup`, use a
two-second TERM grace followed by KILL and a five-second observed-exit deadline,
bound readiness and teardown flush to ten seconds, and retain private files when
cleanup cannot be confirmed. A twenty-second helper fail-safe bounds a parent
that never releases or kills it. Windows cannot intercept SIGTERM; only the
ignored-TERM native regression is Unix-specific.

Before changing cleanup, the private ignored-TERM fixture acknowledged TERM but
the parent never escalated after two seconds of controlled time. The new case
failed its expected SIGKILL assertion (one failure, 18 unselected, 1.15 seconds),
then its finally block killed and observed the fixture exiting. This is actual
macOS/Node 24.22.2 RED evidence, retained in `core-registry-bounded-waits-red.log`.
No fixed sleep or production process was used. Cleanup GREEN remains pending.

The bounded cleanup passes the new ignored-TERM case plus the existing real lock
and three killed-writer recovery cases: five passes, 14 unselected, 3.02 seconds
on macOS/Node 24.22.2 (`core-registry-bounded-waits-green.log`). TypeScript passes
(`core-registry-bounded-waits-types.log`). Teardown still tolerates setup failure
before the registry exists; losing readiness listeners are aborted. These
test-only changes do not alter or clear the failed production cost evidence.

## Ownership capture only when its final check runs

Prepared on `c022f5a4b68e5c1b4730155fd724231ec4f0d841`, before runtime edits or
test execution. Root's fixed old/c022 attribution pair completed both private
workloads, provenance checks and cleanup. Its manifest is
`/tmp/core-registry-attribution-v1-pair/manifest.json`, SHA-256
`0aa63238d2161a0d06b70449bafa2d84db38f1eaa7d5da0efc2127671412a87c`.
At 160 rows, twenty unchanged flushes captured 3,200 ownership identities; twenty
changed `setCwd`/`flush` pairs captured 6,400. The diagnostic's caller counts and
profiled fingerprint work support removing unused captures. Inspector samples
are stack residency, not CPU; wrapper overhead is included. The earlier matched
ABBA CPU/RSS/latency failure remains, and no improvement is yet measured here.

### Design

`persist` captures `beforeOwners` unconditionally, but only its final
`if (strict) verifyPreparedOwners(...)` consumes it. All binding candidates pass
`true`. Public flush, exit flush and transaction completion pass the truthy
`'observation'` mode. Only the private best-effort `save()` leaves the mode false;
its unused ownership strings and table walk can be omitted. Keep the existing
mode and final guard, constructing an empty ownership map for that false branch.
The proposed runtime edit is limited to that map's initializer. It adds no cache,
option, retained identity or asynchronous boundary.

This saves one 160-row ownership capture per changed `setCwd`/`flush` pair. The
later awaited flush still captures every owner even when its local image is
unchanged, because a different durable file may require publication. Unchanged
flushes therefore retain all 3,200 captures in the measured twenty-call workload.
Do not change the condition to `strict === true`: that would weaken acknowledged
observation and transaction checks. Immutable row/candidate copies, exact-byte
reads, changed-row calculation, owner/current/native/cancellation checks, rebase,
intent revisions, lock token, final rename, directory fsync and uncertain-group
recovery remain as they are. No other fingerprint reuse is part of this change.

- Growth: one transient ownership table contains no entries on a best-effort save;
  existing image, queue and retention bounds remain. No stored data is added.
- Concurrency: the same single writer and cross-process lock run. Ownership is
  still captured before the first await on every path that checks it later.
- Read cost: omit only the unused live-table ownership projection. All exact
  private-file and locked reads remain.
- Scale: deterministic forwarded call counts cover the avoided work. The same
  16/160-row matched workload must still establish CPU/RSS/latency acceptance;
  this local improvement alone cannot clear it.
- Compatibility: persisted bytes, public methods and acknowledged outcomes are
  unchanged for supported old/new writers and clients.
- Migration and rollback: no migration; rollback is a code revert.
- Audience and identity: no data is newly exposed; no login or authority changes.
- Failure: existing named failures, deadlines, cancellation and uncertain durable
  outcomes remain. No failure becomes a best-effort result.
- Platforms: TypeScript daemon on macOS, Linux and Windows; no platform or process
  launch change. Native evidence for this proposal is still pending root's run.

### Caller RED and controls, prepared only

Extend `registry.persistenceCost.spec.ts` with a two-row public
`setCwd`/`flush` case. Forward `JSON.stringify` unchanged and count only the
ownership-record shape used by `ownershipIdentity`, requiring two captures for
the awaited flush instead of the current four. Check the actual durable cwd,
unchanged peer, exact live owner reference and one published image. This is a
work-budget regression, not a timing assertion or a substitute for measurement.

The unchanged-flush control explicitly requires both ownership captures to stay.
Two controls hold actual prepared-image fsync after a public flush or transaction,
replace the live process identity while it waits, and require the acknowledged
write to reject without publishing its old-owner image. The queued replacement
must then persist. Existing strict close cancellation/replacement, immutable
nested-alias/deletion, repeated same-value cancellation and uncertain directory
durability controls remain unchanged. No filesystem result or authority answer
is replaced; the existing fixture forwards I/O and bounds every wait/teardown.

No test, typecheck, build or diagnostic has run for this proposal. Root reviews
the Design and prepared RED before execution and any runtime correction.

Root execution on macOS/Node24.22.2: Design/RED checkpoint `086b0242e5` produced the
intended ownership-count failure (4 instead of2), with9controls passing in7.41s
(`/tmp/core-registry-owner-capture-red.log`). The one-line conditional capture then
passed all10cases in5.95s (`core-registry-owner-capture-green.log`); typecheck passed
(`core-registry-owner-capture-types.log`). Strict and observation checks are unchanged.
No corrected matched-cost run has occurred yet; the previous acceptance remains failed.

## Compare each changed-set key once

Prepared on `33ed50b87b8e9cfe4ab893924e2ce1d05df5a14c`, before runtime edits or
execution. The retained attribution pair counted 25,600 persisted-row fingerprints
across twenty changed calls with 160 rows. Source review found that both the
ordinary changed-set calculation and uncertain-publication affected-set calculation
concatenate the two maps' keys, compare every entry, and only then deduplicate the
result. A key present in both maps therefore repeats the same comparison. This
duplication also exists on the old baseline; it does not explain the regression
or establish performance acceptance.

### Design

Deduplicate each union of keys before its existing fingerprint comparison. A
`Set` keeps first-insertion order, so the same keys are compared in the same order
and the result has the same membership and iteration order. Both calculations
remain synchronous over their existing operation-local snapshots. Every key from
either map remains present, including additions and deletions. The ordinary path
still fingerprints each current row; recovery still compares both prior and
published images. No fingerprint result is cached across operations or awaits.

Growth, concurrency and read cost: this removes duplicate transient comparison
work, without adding stored state, changing existing limits, the single writer,
the cross-process lock, or any file read. Scale: the normal 160-row changed-call
workload is predicted to omit 3,200 fingerprints across twenty calls (25,600 to
22,400); these are source-derived counts, not executed measurements. Root must
still run the matched 16/160-row CPU/RSS/latency comparison. Compatibility,
audience and identity: persisted bytes, supported writer/client contracts and
access remain unchanged. Migration: none; rollback is a code revert. Failure:
immutable capture, owner/current/native/cancellation checks, rebase, intent
revisions, final publication and directory fsync, and uncertain-group recovery
remain authoritative. Platforms: the same TypeScript path on macOS, Linux and
Windows; no OS call or process-start change, and no new platform evidence yet.

### Caller RED and controls, prepared only

Extend the existing two-row public `setCwd` followed by awaited `flush` case in
`registry.persistenceCost.spec.ts`. Forward `JSON.stringify` unchanged and count
persisted-row fingerprints with its existing function replacer, with a budget of
14 against the current source-derived 16. Preserve the exact live owner reference,
process lookup, durable cwd, unchanged peer, one publication, and two required
ownership captures. This is a deterministic work budget, not a timing assertion.

Extend the existing uncertain-directory-durability case with a forwarded counter
after its actual file rename. Require at most four persisted-row fingerprints
for the two prior/image comparisons, against the current source-derived eight.
The strict caller must still reject with `AtomicWriteUnconfirmed`, the written
close plan must remain visible on disk without a durable receipt, and the live
owner must not adopt it. No extra case, authority substitute or filesystem result
is added. Existing alias/deletion, strict owner/cancellation, same-value intent,
peer recovery and cleanup controls remain in place.

Only this Design and those caller-test extensions are prepared. No test, typecheck,
build, diagnostic or benchmark has run, and no runtime code has changed. Root owns
the actual RED, the two-site runtime correction, GREEN and matched cost evidence.

The later root execution on macOS Intel/Node24.22.2 recorded the two intended
failures on test checkpoint `4dbfe7c1eb`: 16 normal-path comparisons against14 and
8 recovery comparisons against4, with8controls passing (5.84s,
`core-registry-fingerprint-red.log`). Deduplicating the two unions before filtering
passed all10cases (5.78s, `core-registry-fingerprint-green.log`); typecheck passed
(`core-registry-fingerprint-types.log`). No authority, durability or scheduling
rule changed. Matched cost remains unaccepted until the corrected source is measured.

## Calculate changed rows only when a consumer needs them

Prepared on `c747778bf6643784f0f36b8b10ea26604c134a99`, before runtime edits or
execution. The v3 matched workload completed all 332 functional checks and cleanup,
but its cost remains unaccepted. At 160 rows, median total CPU for twenty changed
calls was 560.5655 ms before and 617.281 ms after; unchanged calls were 126.304 ms and
158.465 ms. The earlier attribution identified repeated row fingerprint work.
No new timing result is claimed for the proposal below.

### Design

The changed-row set has exactly two consumers: the binding-candidate checks
inside `if (bindingCommit)`, and `verifyPreparedOwners` inside `if (strict)`.
Construct the existing union/filter set when `strict || bindingCommit` is truthy;
otherwise construct an empty set. Only a private best-effort save with neither
consumer omits the unused calculation. The condition directly matches both
consumers, including any binding caller regardless of its strict argument.
Public flush, exit flush and transaction completion pass truthy `'observation'`
and retain their complete fresh changed-row calculation. Do not narrow the guard
to `strict === true` or to `bindingCommit` alone.

Keep every captured row/candidate clone and all existing fingerprint comparisons
that affect a result. Before/after image capture, binding verification, peer and
uncertain-group reconciliation, three-way merging and final rebase still run on
every path where they currently run. The best-effort merge does not consume the
omitted set. No snapshot flag, fingerprint reuse, cache, option, retained identity
or asynchronous boundary is added.

Growth/concurrency/read cost: an empty transient set replaces unused comparisons
on the private path; no new retained data, writer, lock, snapshot or file read.
Scale: the proposed two-row changed save/flush budget is 12 instead of 14, predicting
3,200 fewer fingerprints across twenty 160-row changed calls. This count is derived
from source, not a performance result; unchanged-flush work is unaffected.
Compatibility/migration/rollback: no stored or published contract change or
migration; revert the code to roll back. Audience/identity: no access change or
new data exposure. Failure: owner/current/native/cancellation checks, durable
receipt, rebase, lock token, rename, directory fsync and uncertain-group recovery
remain unchanged. Platforms: shared TypeScript on macOS, Linux and Windows, with
no process-start or OS-call change and no additional platform evidence yet.

### Caller RED and controls, prepared only

Tighten the existing forwarded serialization budget for public `setCwd` followed
by `flush` from 14 to 12. Keep its durable cwd, unchanged peer, exact live reference,
single publication and two required ownership captures.

Keep the existing public-flush and transaction controls that replace an owner
while actual prepared-image fsync waits: each acknowledged observation must
reject its old-owner write, then durably save the queued replacement. These fail
if the proposed condition accidentally excludes truthy `'observation'`. Keep the
existing strict close cancellation/replacement, nested-alias/deletion, repeated
same-value cancellation and uncertain-directory-durability controls. The existing
admission case `rolls back only its unpublished image before a different local
write and then retries the held admission` also exercises best-effort observation
with an unconfirmed group; it must still preserve the unrelated cwd and finish
the later strict admission. No new control duplicates these scenarios.

Only this Design and caller tests are prepared. No runtime edit, syntax check,
test, typecheck, build, diagnostic or benchmark has run. Root owns the actual RED,
minimal correction, GREEN and later matched-cost decision.

Root execution on macOS Intel/Node 24.22.2 recorded the intended failure at
`42095490c9940db78ec3377ce881f8bec6d914ab`: 14 comparisons against the budget of 12,
with nine controls passing (`core-registry-unused-changed-red.log`, 5.90 s).
Matching the calculation guard to its two consumers passed all ten cost/authority
cases (`core-registry-unused-changed-green.log`, 5.79 s). The selected unpublished
image rollback/retry case also passed (`core-registry-unused-changed-recovery.log`,
one passed, 62 unselected, 1.29 s). TypeScript passed with exit zero
(`core-registry-unused-changed-types-confirmed.log`). These are functional/work-count
checks; the v3 matched cost failure remains until fresh source-specific measurement.

## Keep peer recovery independent of the prepared image

Prepared against `95c5ddf368267fbae3b0a3ec55cb2dd295d59942`, before a runtime
correction or execution. Source review found a second way a caller-visible row can
reach the image being prepared: `reconcileUnconfirmed` installs a peer's parsed
row into the live registry, and the recovery branch places a shallow persisted
view of that row into `currentRows`. `strictPersistedRow` preserves the nested
process identity by reference. A later edit through the recovered live row can
therefore change the candidate after its bytes have been written, but before its
baseline and contents cache are installed. This is a suspected caller-visible
data-loss defect, not a measured performance explanation.

### Design

Peer recovery must leave three distinct roles: the locked durable image, the
live recovered owner that callers may change, and the immutable candidate held
across asynchronous preparation. Detach rows when recovery exposes them to the
live registry, and deep-capture any recovered live row added to `currentRows`,
using the same persisted-row snapshot rule as the ordinary pre-await capture.
Do not solve the alias by discarding a later live edit or by making mutable rows
act as the durable baseline. Keep the existing no-await final rebase and current
owner checks. Root will choose the smallest correction after the caller test
actually demonstrates the failure; no runtime code changes are included here.

Growth: no new persisted data, cache or queue; any extra transient copy is limited
to the recovered ownership group already selected by the existing recovery walk.
Concurrency: the existing single writer, lock token, synchronous publication and
rebase remain; this changes only which objects may share mutable nested values.
Read cost: no new file read, process probe or polling. Scale: ordinary saves keep
their current snapshot budget; recovery work remains bounded by its existing
table/group, and matched cost must be checked on any eventual runtime correction.
Compatibility: stored rows, public methods and strict receipts keep their shape;
no backend/client ordering or 30-day contract changes. Migration and rollback:
none; a revert restores the earlier in-memory behavior without rewriting data.
Audience and identity: no new access or authority; native revalidation holds on
recovered bindings and all cancellation checks remain. Failure: the original
unconfirmed publication still rejects; peer recovery keeps the complete peer
group, and later edits must become durable through the ordinary queued writer.
Platforms: shared TypeScript affects macOS, Linux and Windows; the proposed
directory-durability fault case runs on macOS/Linux, matching the existing suite's
Windows exclusion. No native platform result is claimed.

### Caller RED prepared only

Extend `registry.persistenceCost.spec.ts` with one recovery interleaving. Fail the
actual directory fsync of A's close plan, write a peer's changed A row, then start
B's unrelated public `setCwd`. Hold the actual prepared-file fsync after it
finishes, observe A's recovered live row, and mutate its nested process marker.
Release the preparation and await a public flush. Require the first durable
image to retain the peer marker, the final image and live owner to retain the
later marker, and both images to retain A's peer cwd/close plan and B's local cwd.
This uses caller-visible rows and actual disk images; no private registry field,
fixed sleep, timer manipulation or mocked persistence implementation is used.

The existing strict owner-change, ordinary nested-alias/deletion and uncertain
publication controls remain unchanged. No test, typecheck, build, diagnostic or
benchmark has run for this preparation; root owns RED and any runtime correction.

Root reproduced the data loss at `cf1ecb1b7d321e73adbe51511b4869d62bd5dd7d`:
the final durable marker was `peer-recovered-start`, losing `later-live-start`.
The new case failed and ten controls passed (11.27 s,
`core-registry-recovery-alias-red.log`). Detaching the recovered live owner from
the locked peer image, then deep-capturing that owner for preparation, passed all
eleven cases (6.49 s, `core-registry-recovery-alias-green.log`). TypeScript passed
(`core-registry-recovery-alias-types.log`). Independent source review found no
remaining live alias in that recovery path. Ordinary-save capture is unchanged.

The prior `95c5ddf368` native ABBA measurement passed all 332 behavior checks and
cleanup; its cost remains unaccepted. At 160 rows, twenty changed calls consumed
552.4435 ms CPU before and 584.6105 ms after; unchanged calls consumed 114.256 ms
and 171.0755 ms. The manifest is
`64370284a47a87d8aac7f447f1ea943698c0fad07e0fefda85c80423a17897d1`.
The preceding sandbox attempt failed before candidate samples because native
uptime/process checks were denied; that failed receipt remains retained. Neither
result is relabeled as measurement of this subsequent recovery correction.

## Serialize owner snapshots only when their fence is checked

Prepared against `7c55706d13a20d3d195dd4451cb0b62d10865977`, before runtime
edits or execution. The retained native comparison still rejects the save cost:
twenty unchanged 160-row flushes consumed 114.256 ms CPU before and 171.0755 ms
after. Attribution recorded 3,200 owner fingerprints in those candidate calls,
even though the unchanged-image return never consults an owner fingerprint.
This proposal removes that unused serialization, not the captured authority.

### Design

Keep the existing `structuredClone(persistedRow(entry))` capture and its location
before any await. At that same point, `beforeOwners` holds a separate shallow
object made from each original captured row plus the live row's current
`evidenceRevision`. `persistedRow` deliberately removes that transient revision;
the other fields `ownershipIdentity` reads are already in the deep snapshot:
agent/registration/engine, conversation/path, process identity, terminal routes
and primary, engine homes, and the external-resume token. Neither a live row nor
a later lookup into the mutable `currentRows` map is an owner snapshot.

Keep those original shallow objects when binding candidates, displaced rows,
confirmation or peer recovery replace/delete entries in `currentRows`. The
separate top level also cannot inherit the resumed path's changes to
`previousAgentId` and `touchedAt`. Nested owner values belong to the existing deep
capture; the merge and validation helpers do not mutate them. Keep the recovery
snapshot fix and every ordinary pre-await deep copy. Do not reconstruct these
objects by parsing fingerprint text: JSON conversion changes own undefined
properties, non-finite numbers and sparse arrays before validation.

`verifyPreparedOwners` selects exactly the same affected IDs and claims as today.
For each selected ID, compare `ownershipIdentity(live)` with
`ownershipIdentity(capturedOwner)` immediately before publication. Missing owners
still compare as undefined. Preserve the truthy `strict` guard, including public
flush, exit flush and transaction completion's `'observation'`; the unchanged
disk-image return needs no owner serialization but retains its snapshot if it
instead reaches the fence. No capture moves across an await, and no authority,
durability or rebase check is omitted.

Growth: no persisted data, cache, timer or queue is added. One transient shallow
owner object per captured row replaces its eagerly serialized string for this
write. Concurrency: the existing writer, lock and final synchronous fence remain;
snapshots retain their original identities across candidate replacement. Read
cost: no extra file read, scan or process probe, and no new deep copy. Scale:
unchanged public flushes are expected to serialize zero owners instead of N;
an actual write checking K existing owners serializes 2K instead of N + K.
These are source-derived work counts, not accepted timing or a new 10x margin;
root must measure the same frozen 16/160-row workload after the change.
Compatibility: no backend/client, storage, wire or receipt shape change; the
30-day contracts remain. Migration and rollback: none; reverting restores eager
serialization without rewriting data. Audience and identity: access and native
authority are unchanged, including the transient evidence revision. Failure:
an owner mutation or hold/recovery cycle still rejects the stale acknowledged
write before publication, with the existing named error. Platforms: shared
TypeScript on macOS, Linux and Windows; no OS call or process-launch change and
no new platform result claimed.

### Caller RED and authority controls, prepared only

Tighten the two existing forwarded `JSON.stringify` work budgets from two owner
fingerprints to zero: an unchanged public flush, and public `setCwd` followed by
its queued flush. Keep exact durable bytes, row references, process lookup,
unchanged peer, row-fingerprint budget and publication assertions. On the current
runtime those two budgets are expected to fail with two actual serializations.

Keep the existing acknowledged flush/transaction replacement controls. Add two
held-real-fsync cases: change the live nested process marker in place without
changing its revision; or use `setIdentityHold` and clear it again so only the
evidence revision differs when the fence runs. Each must reject the stale public
flush, leave the durable bytes untouched, then let a fresh flush save the local
cwd and current identity without persisting the hold or revision. These controls
protect against retaining live nested references or omitting `evidenceRevision`;
they are expected to pass on the existing implementation.

Only this Design and caller tests are prepared. No runtime code, admission test,
syntax check, test run, typecheck, build, diagnostic or benchmark is part of this
preparation. Root owns the actual RED, runtime correction, GREEN and cost decision.

Root execution at `5994626f4b970fd1fd3894041a3f0dcbc1f02051` recorded the two
intended failures (two owner serializations instead of zero), with eleven
authority/recovery controls passing (`core-registry-owner-snapshot-red.log`,
7.26 s). Capturing the independent owner snapshots and serializing only affected
owners passed all thirteen cases (`core-registry-owner-snapshot-green.log`,
7.66 s). TypeScript passed (`core-registry-owner-snapshot-types.log`). Independent
review found no omitted ownership field or changed authority boundary. The prior
recovery correction also passed all 63 admission controls
(`core-registry-recovery-admission-controls.log`, 62.59 s). Matched cost for these
combined corrections remains pending; the earlier cost failures are retained.

### Current main integration, prepared only

Merged frozen main `ae81a1f077cd0567fb46a35eb21460d5e1a28d11` into the Registry
package after `3cd731efe43dfa1ec5d78b076c9877d89f1aca12`, without textual conflicts.
Main's Close reply now describes the conversation in the saved stopped record;
the Registry branch still awaits close-plan publication and retains its current
owner fences. Three new main Close fixture removals use the existing awaited
`removeRegistryAgent` helper. The registry persistence, owner snapshot, recovery,
stop publication and stopped-store code are unchanged from the preceding head.
Main's isolated E2E Node setup is retained unchanged.

This integration ran no tests, typecheck, build or workload. The combined head
needs Close/stop caller controls, the affected core and resume gates, current-main
test-helper isolation checks, and the pending matched Registry cost measurement.
The earlier passing receipts keep their original source scope; all earlier cost
failures remain retained and acceptance remains pending.

### Current-main Close timer fixture

The integrated Close controls at `b7577c55cb6456289ed3832075131c7baab6b98f`
failed the sustained-idle timer case while 125 cases passed and one was skipped
(`/tmp/core-registry-b757-close-controls.log`). The test observed that its stop
spy had started, then disposed the service and began registry cleanup before the
stop's asynchronous removal finished. Both removals captured the same owner;
the second correctly rejected its stale owner fence. A disposed `tick()` returns
immediately and cannot join the first stop.

The fixture now awaits that stop promise and checks that its row has gone before
disposing. All 118 Close service cases pass (24.16 s,
`/tmp/core-registry-close-timer-green.log`). The unchanged unused-Codex controls
passed in the preceding combined run. Runtime code and authority are unchanged;
this fixture adds no timer, retry or storage behavior. Earlier cost failures and
the remaining whole-package acceptance requirements still apply.

### Matched cost after owner serialization and recovery corrections

The fixed 83-case ABBA comparison at baseline `8fcfa7d` and candidate `546f1a0`
passed all 332 behavior, provenance and cleanup checks. It used the unchanged
reviewed v3 runner and workload with native OS access. Inputs:
`/tmp/harness-registry-cost-v6/inputs.json`, SHA-256
`95a2eba7999e469430c0c57871ba9e3aab7f73d3664b367e163684af66d278c0`.
Result: `/tmp/core-registry-cost-v6-native-abba/manifest.json`, SHA-256
`2dbcd1964dbbe0e7a486d9d83b10e80f3c99da82d8bb8d20bf3dddfdb95d1b15`.

Median CPU totals for 20 operations, baseline to candidate: 16-row unchanged
54.056 to 92.226 ms, 16-row changed 188.256 to 253.284 ms, 160-row unchanged
118.306 to 159.785 ms, and 160-row changed 548.889 to 550.671 ms. For 160-row
changed operations, p95 elapsed time was 122.899 to 123.698 ms, p95 heartbeat
delay 123.200 to 2.989 ms, and maximum sampled RSS 121.367 to 169.523 MiB.
For unchanged 160-row operations, sampled RSS was 87.451 to 170.811 MiB.
These samples do not establish peak memory or attribute the remaining cost.

Cost acceptance still fails: unchanged saves and smaller writes use more CPU,
and memory is higher. Legacy-lock results compare an old refusal with a new
success, so they are excluded from equal-outcome cost comparison. All previous
failed comparisons remain retained. No further runtime optimization or full
package acceptance is claimed by this measurement.

## Avoid publishing an unchanged, already durable names image

### Design

The retained attribution records twenty names-file writes, twenty file fsyncs
and twenty directory fsyncs for twenty unchanged public flushes. `flush()` calls
`persistNames()` even when no rename was requested. These writes do not change
the bytes, but asynchronous preparation still consumes CPU and allocations.
The latest matched comparison remains the failed cost result above; this
correction has no measured acceptance result yet.

Keep the private names-file read, descriptor checks, size bound, parsing and
deadline checks. Omit preparation and publication only without an explicit
rename intent, pending dirty names or deletion tombstones, when the bytes read
exactly match the captured local names image and its revision is still current.
A missing file, different bytes or peer-only names take the existing merge and
durable publication path. An explicit same-value rename still checks its owner
and publishes before it succeeds.

Every `persistNames()` failure must set the existing `namesUnsaved` flag. A
same-value explicit rename can replace the file and then fail directory fsync;
equal bytes alone cannot make the next flush acknowledge that uncertain write.
Its retry must publish durably. An earlier operation cannot clear a dirty name
or deletion admitted while it was reading or preparing its image.

- Growth and scale: no new state, cache, timer or queue. The existing 1 MiB
  names read limit and single bounded writer remain. The retained workload
  measures the omitted publications, CPU and memory; no new margin is claimed.
- Concurrency: keep captured names, revision and tombstones, the writer queue,
  guarded file read and explicit owner predicate. No cross-process lock or
  merge rule changes.
- Read cost: still read the same private names file. Only proven unnecessary
  writes and fsyncs disappear; no stat-based shortcut or polling is added.
- Compatibility: no wire, stored schema, filename or client contract changes.
  Existing clients and backends keep the same success and held outcomes.
- Migration and rollback: no migration; revert the correction to restore
  unconditional names publication.
- Audience and identity: existing private-file and registry-owner checks remain;
  no other account, home or caller gains access.
- Failure: malformed, unsafe and unreadable files still fail with the existing
  content-free persistence error. Failed publication remains dirty until a
  durable retry succeeds; no caller error becomes success.
- Platforms: shared TypeScript affects macOS, Linux and Windows. No process
  start changes. Directory-fsync fault coverage applies where that fsync runs;
  root records the actual validation platforms.

Before runtime changes, dedicated caller controls will require unchanged
flushes to keep the exact bytes without names publication. They also retain
explicit same-value rename durability and revocation, failure retry despite
matching bytes, inherited-name mutation during a read, malformed-file
errors and peer-name merging. Existing inherited-write failure and queued
deletion controls remain required. Root ran the dedicated caller controls
before runtime changes: both unchanged-image cases failed because each flush
republished names, while the other seven cases passed (3.89 s,
`/tmp/core-registry-names-cost-red.log`).

After both names and image-encoding corrections, root ran the dedicated names
and persistence-cost suites together with `registry.spec.ts` and
`registry.launchCallers.spec.ts`: all 222 cases passed across four files
(75.62 s, `/tmp/core-registry-publication-green.log`, macOS/Node 24.22.2).
TypeScript passed (`/tmp/core-registry-publication-types.log`). Independent
source review of both corrections found no actionable findings. The unchanged
matched workload remains pending; no cost improvement is claimed yet.

## Retain the bytes prepared for a successful registry publication

The retained attribution found two full registry serializations for each changed
publication. The first string is the actual temporary-file image; after its
rename and directory fsync succeed, the same immutable rows are serialized again
for `persistedContents`. Retain the first string in that operation and install
it as the acknowledged baseline only after publication succeeds.

The recovery-alias correction above detached live recovered rows from both the
locked image and the prepared candidate. Preparation therefore owns its nested
values; the synchronous live rebase does not mutate that image. No row clone,
owner fingerprint, validation, lock or recovery serialization is removed.
Unconfirmed publication retains its existing owned image and prior snapshot.

Growth, concurrency and scale: one already allocated immutable string lives
until its existing operation completes; no cache, queue, mirror or timer is
added. Read cost is unchanged; one repeated encoding disappears. Storage,
wire contracts, audience and identity do not change. No migration is needed;
rollback is a revert. Failure and publication deadlines remain unchanged. The
shared TypeScript affects macOS, Linux and Windows without starting a process.

Before changing runtime, the existing changed-save caller control additionally
requires one full encoded image for its one durable publication, while keeping
the same durable bytes, live owner and untouched peer. Its forwarded stringify
spy preserves real encoding. Existing held-preparation, nested-alias, recovery
and authority controls remain required. Root will record actual red/green and
matched cost; the earlier cost failures remain retained.

The pre-correction macOS/Node 24.22.2 run failed the intended count (two full
images instead of one), with twelve authority, recovery and alias controls
passing (14.48 s, `/tmp/core-registry-image-encoding-red.log`). Runtime now
retains that first string. The combined macOS/Node 24.22.2 run above passed all
222 cases across four files (75.62 s, `/tmp/core-registry-publication-green.log`),
and TypeScript passed (`/tmp/core-registry-publication-types.log`). Independent
source review found no actionable findings. Matched cost and whole-package
acceptance remain pending; the earlier cost failures still apply.

### Matched cost after removing redundant publications

The unchanged fixed 83-case ABBA workload at old `8fcfa7d` and candidate
`51d7045` passed all 332 behavior, provenance and cleanup checks. Inputs:
`/tmp/harness-registry-cost-v7/inputs.json`, SHA-256
`f40cda16782dae13fcdfabb163aa18a43a059110d4696ac56a27eca309d60518`.
Result: `/tmp/core-registry-cost-v7-native-abba/manifest.json`, SHA-256
`fb33fee7f17b59b29c7808cd45ee88c74daeffc53898c9a82acd227f9085b664`.
Earlier failed runs remain unchanged.

| Twenty successful operations | Median CPU, old → new | Median p95 elapsed, old → new |
| --- | --- | --- |
| Unchanged, 16 rows | 52.997 → 40.756 ms | 41.305 → 2.629 ms |
| Changed, 16 rows | 193.643 → 175.946 ms | 116.288 → 65.636 ms |
| Unchanged, 160 rows | 122.518 → 99.288 ms | 44.983 → 5.571 ms |
| Changed, 160 rows | 565.964 → 522.073 ms | 123.764 → 82.791 ms |

All four selected CPU and latency medians improve. The second 16-row changed
pair used 195.408 → 197.570 ms CPU, so improvement is not uniform across pairs.
For 160-row writes, p95 heartbeat delay falls from 124.024 to 2.855 ms.
Maximum sampled RSS remains higher: 120.695 → 171.451 MiB for changed 160-row
operations, and 86.949 → 172.955 MiB for unchanged operations. These are samples,
not peak memory. Prior analysis found most of that difference present before
the measured flush window; this run does not attribute or resolve it.
Legacy-lock refusal versus success remains excluded from equal-outcome cost.
Full package acceptance, final gates and memory investigation remain open.

## Size bounded reads from the validated descriptor

### Design

The finite `readPrivateRegistryFile()` path currently allocates its entire
limit plus one byte before reading. The names caller permits 1 MiB, so reading
its two-byte `{}` image requests a 1,048,577-byte buffer. This is a concrete
allocation target from source inspection, not attribution of the measured RSS
difference above. A forwarded-allocation regression will record the actual
requests before runtime changes; whole-runtime setup, settled memory and flush
cost still need separate matched measurements.

Reuse the size from the descriptor stat that already checks the file's owner,
type and limit. Initially allocate that size plus one byte, capped at the
caller's limit plus one. If a read fills the buffer before EOF, grow it within
the same cap and continue positional reads. A file can grow after stat: return
every byte observed through EOF up to the limit, and reject the first byte
past it. Never return a truncated prefix that happens to be valid JSON. Decode
UTF-8 once, after reading completes, so characters crossing a read or growth
boundary remain intact. Keep the default unbounded `readFile('utf8')` path.

- Growth and scale: the file limit is unchanged. Buffers belong to one read;
  no cache, global state, queue, setting or dependency is added. Geometric
  growth bounds copying and total allocation by a constant multiple of the
  existing cap. Old and replacement buffers can coexist during growth, so a
  lower small-file allocation does not promise a lower maximum for growing
  files. Measure allocation requests and whole-runtime memory separately.
- Concurrency: use the same opened descriptor throughout. The initial size is
  an allocation hint, never authority to stop reading. Existing writer locks,
  revisions, owner predicates and publication boundaries do not change.
- Read cost: reuse the existing descriptor stat; no extra pathname inspection,
  directory scan, poll or syscall is needed for a stable small file. Preserve
  bounded reads and the caller's existing deadline checks and cleanup.
- Compatibility: no file format, wire contract, filename, error or caller
  success rule changes. Existing clients and backends remain compatible.
- Migration and rollback: no migration; reverting restores the previous
  buffer allocation without changing persisted data.
- Audience and identity: preserve descriptor owner/type/mode checks, POSIX
  no-follow opening and Windows private-root checks. No new account or file
  access is introduced.
- Failure: preserve existing size and unsafe-file errors, propagation of I/O
  failures, and descriptor closure on success and every failure. No malformed
  or truncated contents become a successful durable state.
- Platforms: shared TypeScript affects macOS, Linux and Windows. No process
  launch changes. Native evidence will name the actual platforms run;
  platform-specific permission, link and root controls remain explicit.

Before runtime changes, `registryPersistence.read.spec.ts` calls the exported
reader with real private files and file handles. Its allocation spies forward
the real `Buffer.alloc`, `allocUnsafe` and `allocUnsafeSlow` calls and report
requested bytes, not retained memory or peak RSS. Controls cover small and
empty files, exact and exceeded limits, growth after the real stat below and
above the cap, short reads splitting UTF-8, the default unbounded path, private
file checks, and actual descriptor closure after failures. The small-file
allocation assertion failed against `30e3d6c`: the real `Buffer.alloc` requested
1,048,577 bytes for `{}`. Nineteen controls passed and one Windows-only case
was skipped (403 ms, `/tmp/core-registry-bounded-read-red.log`).

The reader now retains the existing descriptor size and allocates three bytes
for that file, growing geometrically only if the file fills that buffer.
It still reads through EOF or the first byte over the unchanged limit. All
twenty reader cases pass on macOS; the Windows-only case remains unverified.
TypeScript passed (`/tmp/core-registry-bounded-read-types.log`).

The selected six-file caller/control run did **not** pass: 92 tests passed,
three failed and one was skipped (25.63 s,
`/tmp/core-registry-bounded-read-green.log`; the filename does not imply a pass).
The three failures are in `registry.observation.spec.ts`: unchanged
`openProcessAgent` no longer returns the live row object, and unchanged
re-observations after dormant reactivation or learned launch metadata perform
three fsyncs rather than zero. All three reproduce once in a clean disposable
`30e3d6c` checkout with the new reader test absent and the same locked
dependencies (1.93 s, `/tmp/core-registry-observation-30e3-baseline.log`, inputs
`/tmp/core-registry-read-baseline-30e3-inputs.json`). They predate this allocation
correction. The broader authority/publication behavior is unchanged here;
root owns their resolution and full-package acceptance.

After the scheduled RED run, selected checks are the new reader controls,
existing persistence/observation and names caller controls (including explicit
same-value rename, authority loss, uncertain directory fsync and peer merging),
TypeScript, affected required local gates, and the retained matched cost
workload. Root schedules these around isolated performance measurements.
Earlier passing receipts cover their recorded source only. Memory acceptance
and full-package acceptance remain open until the final source is measured.

## Unchanged discovery after asynchronous admission

The reader allocation check exposed three existing observation failures at clean
`30e3d6c`: unchanged `openProcessAgent` calls still prepare and publish a registry
image (three fsyncs), and one old assertion expects the returned row to alias the
live registry. The detached result is intentional: callers must not mutate an
acknowledged ownership snapshot through a later in-place registry change. Keep
that protection and test both value equality and detached nested identity.

The correction targets only an existing process whose candidate, live persisted
fields and durable baseline are identical, with no explicit target-field intent
and no displaced row. Outside a transaction, with no unconfirmed publication
to recover, it may use the ordinary observation path:
that path reads through the existing owner/mode/no-follow checks, notices a
peer's changed image, and commits any unrelated pending changes. Refresh supplied
native authority first, then recheck the target and its baseline before the final
disk read. After that await, check the deadline, captured ownership group and
launch identity without another await before returning a detached current
snapshot. A changed candidate or staged target, displacement, transaction or
uncertain publication keeps strict admission and its fsyncs. If authority refresh
changes a row selected as unchanged, refuse that stale operation.
No new lock, cache, timer, format, dependency or public contract is introduced.

Growth, read bounds and account identity are unchanged. The existing file read
is the freshness witness, never timestamps alone. An authority change during it
must refuse the result. Keep current saved-owner conflict/recovery tests and add
this caller control before runtime edits. Rollback restores redundant writes;
stored data needs no migration. Shared TypeScript affects macOS/Linux/Windows;
local execution below must name its actual platform. The reproduced baseline
failures remain recorded separately from the successful allocation correction.

The corrected observation assertions reproduced three failures and one passing
control before the runtime change (2.25 s,
`/tmp/core-registry-observation-noop-red.log`). Two additional staged-intent and
authority-refresh controls passed against that baseline (1.44 s,
`/tmp/core-registry-observation-noop-controls-before.log`). After the correction,
observation, admission and persistence-cost controls pass: 102 cases across three
files in 69.64 s (`/tmp/core-registry-observation-noop-green.log`). TypeScript
passes (`/tmp/core-registry-observation-noop-types.log`). These are macOS checks
with Node 24.22.2, not native Windows or Linux acceptance or a whole-process
performance measurement.

Independent review found no runtime safety issue and one test portability bug:
the authority-loss hook matched a slash-delimited filename. It now compares the
exact captured native path; all 26 observation cases pass in 15.50 s
(`/tmp/core-registry-observation-path-review-green.log`). Current-main
integration, the required gates, native failure checks and final matched cost
acceptance still follow. Earlier memory results remain open.

### Current-main integration after the observation correction

Merge `cd93bbd181` after `08793f3612`. The binding conflict combines main's
reader-owned hold guard (`followsLive`) with this branch's asynchronous
revalidation and captured lifecycle/row authority checks; neither is removed.
Main's composition passes the real reader's `follows` method. Binding fixtures
now explicitly provide that required method.

The first three-file run had 231 passing cases and three failures: main's new
reader-hold assertions expected the former one-argument revalidation call.
Updating them to require the asynchronous authority callback gives 164/164
binding cases; the other two files' 70 passing cases are retained. The next
five-file fixture run had 299 passing cases and one analogous native-location
assertion failure. Its seven-case file passes after requiring the callback.
These selected results cover 534 cases across eight files; they are not one
uninterrupted full-suite pass. Logs are
`/tmp/core-registry-current-main-{integration-first,bind-green,fixtures-green,native-locations-green}.log`.
The first typecheck identified the missing required fixture method; the corrected
merged source passes (`/tmp/core-registry-current-main-types-final.log`).
Native, full-gate and matched memory/cost acceptance remain pending for this head.

## Canonical comparison allocations after memory attribution

Before changing runtime code, the frozen `52e9aae823` diagnostic pair passed all
83 workload outcomes per side and verified owned cleanup. Inputs are
`/tmp/harness-registry-memory-v1/inputs.json` (SHA-256
`4a52c2f038ff0938feef8d7c17696ac5ca81a2820f5dcf7252ebcab5a10d7340`);
results are `/tmp/core-registry-memory-v1-pair/manifest.json`.
The candidate's RSS after 160 admissions is 168.664 MiB versus 87.723 MiB old,
with heap capacity 82.836 versus 20.742 MiB. After all samples and the final
flush, one diagnostic-only GC leaves 12.643 versus 11.962 MiB used heap and
identical 0.248 MiB array buffers, but capacity remains 79.309 versus 46.242 MiB.
The gap is largely transient allocation and retained heap capacity, not an
equivalently large live row/buffer graph. This does not clear memory acceptance.

The durable per-admission path cannot use the old transaction's deferred
acknowledgement. The candidate performs 104,987 row stringifications through
final flush in this workload. Each canonical object currently creates one
two-element array per key plus a mapped array before copying those properties
into a fresh object. Remove that avoidable intermediate allocation by filling
a fresh null-prototype object in sorted-key order. Keep JSON.stringify's
existing recursive replacer, scalar/array/toJSON semantics and exact canonical
bytes. A null prototype keeps literal `__proto__` and `constructor` keys as data.
This is a local allocation correction, not a cache or new persistence path.

Design: no stored format, audience, account identity, lock, public contract or
migration changes. Snapshot deep copies, row/intent capture, peer merges,
uncertain-publication recovery and immediate durable ownership receipts remain
unchanged. Allocation still scales with the already-bounded row workload; no
new retained collection or lifetime. Rollback restores temporary arrays only.
The code is shared across macOS/Linux/Windows; execution evidence below names
the actual platform and does not substitute for native platform acceptance.

First add a real-admission control that forwards Object.fromEntries and counts
the temporary canonical row/ownership entry pairs without retaining values.
Require zero such pairs while the returned receipt still matches the newly
durable image and prior rows remain equal. Canonical byte controls cover nested
key order, repeated aliases, array order/holes, omitted values, non-finite
numbers, literal prototype keys, inherited toJSON, dates and rejected values.
Then check caller observation, merge, admission and persistence safety suites,
TypeScript, and the required final gates. Root schedules the uninstrumented
matched CPU/RSS workload only after source is stable; neither counts nor the
one-GC diagnostic promise a lower RSS or a passing whole-package cost result.

On macOS x64 / Node 24.22.2, the new admission control first failed with 564
temporary canonical property-pair arrays; its durable image/receipt assertions
and the canonical-byte control passed (one intended failure, one pass, 13
unselected cases; 1.58 s, `/tmp/core-registry-fingerprint-allocation-red.log`).
The local copy correction brings that count to zero and both controls pass.

The selected six-file run recorded 134 passes and three failures in the existing
fingerprint caller tests (138.29 s,
`/tmp/core-registry-fingerprint-allocation-green.log`; the filename is not a
passing receipt). All three reproduce once in clean `52e9aae823`, with the
allocation change absent and the same dependencies: two assertions read disk
before a synchronous setter's asynchronous save settles, and the two-registry
case freezes the lock retry with fake timers (31.53 s,
`/tmp/core-registry-fingerprint-52e9-baseline.log`).

Those callers now await the public flush barrier, fake only row dates, and wait
for every opened registry to finish before fixture removal. Their eight cases
pass (10.61 s, `/tmp/core-registry-fingerprint-async-controls-green.log`). The
other five files retain 129 passing cases covering admission, observation,
merge, immutable snapshots, ownership loss, intents and publication recovery:
137 cases across the selected results, not one uninterrupted six-file pass.
The final TypeScript check and diff check pass
(`/tmp/core-registry-fingerprint-allocation-types.log`). No measured claim about
the final runtime's CPU or whole RSS follows from the eliminated entry pairs;
the required gates and uninstrumented final-source cost comparison remain open.

## Canonical object representation after allocation sampling

Status: rejected after the final matched workload below; the runtime change is
reverted to `7b88dfa202`. The diagnostic and validation evidence is retained.

The uninstrumented `7b88dfa202` comparison still fails RSS acceptance: the
160-row unchanged case is 86.44 MiB old versus 163.90 MiB candidate. Removing
temporary property-pair arrays did not resolve the transient allocation pressure.
The frozen allocation diagnostic at `/tmp/harness-registry-allocation-v2`
samples collected objects as well as retained ones, at 64 KiB intervals, without
operation wrappers or forced GC. Its one current-head child passes all 83
workload outcomes and proves owned process/lock/runtime cleanup. The canonical
replacer subtree accounts for 734.1 MB of 1,886.6 MB sampled cumulative
allocations (38.9%); its own frame accounts for 394.4 MB. This is attribution,
not a CPU/RSS acceptance result. Inputs have SHA-256
`6f72fb8abec5964828d129719542272ed18b597732f22c8b3a685f11555bfd3b`;
summary `/tmp/core-registry-allocation-v2-summary.json` has SHA-256
`e418fb6e48e84b1facd505d6b834cd0a8048db2633cfbe2eece14c318425582c`.

On pinned Node 24.22.2, a bounded V8 shape control confirms the current
null-prototype canonical copies use dictionary properties. The former
`Object.fromEntries` copies and own-property definitions use fast properties,
with identical JSON bytes for a representative 23-key row and literal
`__proto__`, `constructor` and `toJSON` data keys. Replace only canonical object
construction: define sorted own data properties on a fresh object, reusing one
descriptor per object. This avoids both dictionary backing stores and the
former temporary array per property. Keep JSON.stringify's recursive replacer,
normal scalar/array/toJSON semantics and canonical bytes.

Design: no stored format, audience, identity, lock, migration, public contract or
durability change. There is no retained cache. Each call owns its temporary
object and descriptor; copies and peer/uncertainty fences are unchanged. The
code remains shared across macOS/Linux/Windows. V8 representation evidence is a
macOS x64 pinned-Node diagnostic, not native acceptance on other platforms.

Before the runtime edit, run a public three-admission diagnostic against the
frozen bundle. It checks actual V8 representations during the third admission,
immediate durable receipt equality, preserved prior rows and detached nested
receipt objects, then verifies owned cleanup. The expected RED is dictionary
row copies. After the edit, run the same control and the existing canonical
byte, admission, observation, merge and persistence safety tests plus TypeScript.
The root schedules the final uninstrumented CPU/RSS comparison and broader
gates; no shape count or sampled allocation amount claims that RSS passes.

The first caller diagnostic stopped before measurement because its assertion
compared an own `defaultName: undefined` receipt field to JSON, which omits that
field. That fixture failure and its successful cleanup are retained at
`/tmp/core-registry-shape-caller-red.{json,log}`. The corrected diagnostic compares
the receipt's JSON value and then checks its nested alias independently; its
bytes are frozen at `/tmp/harness-registry-shape-caller-v2.mjs`. Against `7b88`,
all three admissions, durable receipts and cleanup pass, and the intended RED
finds 17 dictionary-backed canonical row copies. After the construction change,
the same 17 copies use fast properties and the diagnostic passes. Evidence is
`/tmp/core-registry-shape-caller-v2-{red,green}.json`; no forced GC is used.

On macOS x64 / Node 24.22.2, the six selected safety files pass together:
137/137 cases in 53.34 seconds (`/tmp/core-registry-shape-safety.log`), including
canonical bytes and literal prototype keys, zero property-pair arrays,
immediate durable receipts, nested snapshots, peer merges and uncertainty
fences. TypeScript and diff checks pass (`/tmp/core-registry-shape-types.log`).
The uninstrumented final-source CPU/RSS comparison, native matrix and broader
gates remain pending; the earlier RSS failures are not superseded by these
correctness and representation results.

The final frozen `05b5675705` ABBA completed all 332 expected outcomes and
verified every owned worker, descendant, output stream, lock and private root
was cleaned up. The six old legacy-lock refusals remain recorded separately
from successful-save cost. Median values below compare the two old runs with
the two candidate runs; CPU is total CPU for 20 calls, RSS is the maximum in
each run, and heartbeat is p95 milliseconds.

| Workload | CPU ms, old → candidate | RSS MiB, old → candidate | Heartbeat ms, old → candidate |
| --- | --- | --- | --- |
| 16 unchanged | 55.83 → 27.44 | 79.17 → 80.98 | 42.537 → 0.076 |
| 16 changed | 195.64 → 211.02 | 87.74 → 88.46 | 104.324 → 0.634 |
| 160 unchanged | 126.40 → 84.19 | 89.60 → 162.05 | 45.027 → 0.072 |
| 160 changed | 559.20 → 600.55 | 123.53 → 163.93 | 122.836 → 3.789 |

Removing dictionary-backed canonical copies did not resolve the RSS gap, and
changed-save CPU now exceeds the old baseline. Reject the representation
optimization and restore the prior null-prototype copy implementation. No
unchanged acceptance rerun follows. The summary is
`/tmp/core-registry-05b567-cost-summary.json` (SHA-256
`01cd10792c347020987b417ec8564b30995e71d6d9eb2eada3e1746c22ab7583`);
the explicit NOT_ACCEPTED result is `/tmp/core-registry-05b567-acceptance.json`.

Safety validation at the rejected head nevertheless completed: core 4,773
cases and 100% coverage, portability 1,066 and 100% (10 existing skips), Resume
522 and 100%, real shell 10, tmux 6, native PTY host/lifecycle 8, and the private
registry's 16-case cross-process/crash matrix with verified cleanup. The PTY
host used the source-matched existing binary after checking all 100 tracked
PTY/terminal/vendor inputs; its initially unexercised cases ran separately.
These are named-head safety results, not acceptance of the restored head or a
claim of native engine, Windows or whole-product validation.

The smallest next investigation is repeated canonical comparison of the same
transaction-owned snapshot: `beforeCommit`, changed-row detection and
`mergedForSave` currently fingerprint it independently. Reuse its already
computed fingerprint only within one persist operation. First establish that
every candidate/displacement/recovery replacement gets a new snapshot and
replace the resumed-row in-place edit with a new owned row; then a local
snapshot-keyed comparison can reuse immutable values without caching live
controller rows across awaits. A public admission control must show fewer
actual comparisons while nested live edits, peer recovery, uncertainty fences
and immediate durable receipts still hold. This is a proposed next step,
not an implemented change or a predicted RSS result.

## Reuse comparisons of one operation's immutable admission snapshots

Prepared at `c4e2ff27148018716a98f6090ff4c2b4761df9b2`, before runtime edits.
The entire optimization history above has been checked. Existing reuse covers
the unchanged observation comparison only; admissions still canonicalize each
original captured row for `beforeCommit`, changed-row detection and the initial
merge. The retained allocation sample attributes 38.9% of sampled allocation to
canonicalization. It does not establish an RSS improvement for this proposal.

### Design

Keep a fingerprint lookup local to one `persist` call, keyed by its snapshot
objects. Use it for `beforeCommit`, changed-row detection and the first
`mergedForSave` only. The merge's default remains fresh canonicalization, and
the final post-refresh live rebase uses that default. Fresh live ownership,
native evidence, peer-image comparisons, recovery comparisons and the final
baseline/rebased-image check stay unchanged.

Every initial row is already a deep persisted snapshot. Candidate and displaced
rows replace entries with fresh deep snapshots. Peer recovery likewise installs
a deep snapshot; confirmation uses the privately JSON-owned uncertain image.
None is exposed as a live row. The resumed-lineage path is the sole mutation of
an existing `currentRows` object: replace its top level when removing
`previousAgentId` and updating `touchedAt`. Its unchanged nested values already
belong to the deep snapshot. Normalization, validation and merge helpers only
read these rows or construct replacements. Thus an object-keyed result cannot
mistake a replacement candidate, recovered row or resumed shell for the earlier
captured value. No live object enters the lookup, and no lookup survives its
persist operation.

Growth/read cost: one bounded weak lookup holds references to already computed
strings for the current operation; no retained cache, extra deep copy, file read,
timer, process or queue. Concurrency: the existing writer, lock, immutable
captures and fresh no-await publication fences remain. Scale: a public third
admission is expected to need eleven rather than sixteen whole-row canonical
comparisons, eliminating two repeated comparisons per unchanged prior row and
one for the new row. This is a source-derived work budget, not measured CPU or
RSS; the frozen 16/160-row matched workload remains required. Compatibility,
audience and identity: no bytes, schema, public contract, access or account
change. Migration: none; rollback is a code revert. Failure: exact receipts,
directory fsync, cancellation, private-file checks, peer conflicts, transaction
validation and whole-group uncertainty recovery remain authoritative. Platforms:
shared TypeScript on macOS/Linux/Windows; local checks name their actual platform.

Before runtime edits, add a forwarded whole-row serialization budget to a public
admission with real private files, checking the immediate durable receipt,
unchanged prior rows and detached nested identity. Keep the existing held-fsync
live-alias/deletion, owner/evidence-revision, peer-recovery, cancellation and
uncertainty controls. Add a held resume that clears its successor's lineage
while preserving a later nested live edit; also run the existing resume/archive
lineage control. Selected checks are the cost, admission, observation, merge,
fingerprint and persistence suites and TypeScript, at no more than two workers.
Root reviews this Design before runtime changes and schedules any timed workload
or full gate. The earlier failed RSS results remain open.

The first one-worker macOS x64 / Node 24.22.2 run records the intended RED:
sixteen whole-row comparisons against an initial budget of twelve, with all
sixteen authority, immutable-image, recovery and resume-lineage controls passing
(7.96 s, `/tmp/core-registry-snapshot-cost-v2-red.log`). The earlier diagnostic's
seventeen comparisons used a different fixture; this actual public caller needs
sixteen. The five avoided comparisons imply eleven, and the test budget is
tightened to eleven before runtime edits. No runtime change or timed performance
workload has run.

The corrected eleven-comparison budget also fails as intended with sixteen
actual comparisons (1.25 s, one failed and sixteen unselected,
`/tmp/core-registry-snapshot-cost-v2-red-budget.log`). Runtime is still unchanged.

Root reviewed the capture/replacement paths and both merge calls and approved
the persist-local snapshot lookup before the runtime edit. The correction adds
eighteen runtime lines and removes seven. Only the first merge receives it;
the post-refresh live merge, authority fences and peer comparisons remain fresh.
The public admission now meets the eleven-comparison budget, and all seventeen
cost/authority cases pass (8.13 s, `/tmp/core-registry-snapshot-cost-v2-green.log`).
The five remaining selected safety files pass 122/122 cases together (46.71 s,
`/tmp/core-registry-snapshot-cost-v2-safety.log`). These cover peer conflicts,
displacement, transactions, nested mutation, cancellation and whole-group
uncertain-publication recovery.

The first typecheck failed because the new lineage fixture read `entry` before
narrowing the publication union; its failure remains in
`/tmp/core-registry-snapshot-cost-v2-types.log`. The fixture now requires confirmed
publication before using its entry. Both held nested-edit lineage and existing
resume/archive lineage cases pass (2.97 s, two passed and 161 unselected,
`/tmp/core-registry-snapshot-cost-v2-lineage.log`). The corrected TypeScript and
diff checks pass (`/tmp/core-registry-snapshot-cost-v2-types-final.log`). All
execution above used macOS x64, Node 24.22.2 and at most two test workers. No full
gate, build or timed workload has run on this correction; independent review and
source-specific CPU/RSS acceptance remain open.

### Design — reuse the private preparation identity index (2026-11-16)

The exact `9c4f3ad56e` diagnostic used the frozen native artifact and private
fixture, with collected allocation samples and no forced GC. Its 83 public
outcomes and 168 memory checkpoints passed; the process and all witnessed
children exited, output drained, and the private runtime root was removed.
The manifest is `/tmp/core-registry-allocation-v3-current/manifest.json`, input
SHA-256 `46122254c6da56ab56bc8c5ff4f5249cc1d83c26b44e1f696da93e6867b5664c`.
This diagnostic explicitly permitted concurrent tests and is not timing or RSS
acceptance. Sampled cumulative allocation was 1,643,611,856 bytes; 311,032,488
were direct `strictPersistedRow` allocations, including 75,953,808 from the
preparation conflict indices and 26,958,072 from constructing merge indices.
These roughly 103 MB are six percent of sampled cumulative allocation, not live
memory. The changed-16 Inspector profile includes idle and blocking fsync wall
residency and cannot establish the source of the earlier process-CPU regression.
The frozen RSS and changed-16 CPU failures remain open.

The owned data is the fully reconciled `latest` table read under the private
registry lock. Reconciliation/rollback finishes before conflict checks. Both
binding conflict checks and the first merge then read that same table without
an intervening mutation or await. Keep one lazily constructed `MergeIdentities`
for these synchronous checks, then transfer it to the first merge. A baseline
row absent from the captured current table must leave both the merge map and
the transferred index before any changed row claims identities. Existing
remove/put operations keep their literal insertion order: replacing a row keeps
its place, removal and re-addition go last, and carried binding metadata comes
from the first matching row in that order. Strict parsing's missing date defaults
are still assigned within this one synchronous preparation turn. No live row is
cached. The later post-refresh live merge creates its own fresh index.

Ownership/audience/schema: no public or stored format changes, additional reads,
retained cache, queue, timer, process or identifier. Growth remains bounded by the
already bounded private table. No lookup survives the save. Every native refresh,
peer comparison, live-owner/evidence fence, cancellation check, uncertain-image
recovery and per-caller durable receipt remains fresh and unchanged. No fsync,
publication or transaction acknowledgment is removed. Platforms are shared
TypeScript on macOS/Linux/Windows; this workstation is macOS x64 / Node 24.22.2.
Migration is unnecessary; rollback is a code revert.

Root approved this ownership/order Design before runtime changes. Add a public
third-admission work budget that forwards actual runtime normalization and checks
the complete durable receipt and prior-row order; first measure its RED on the
unchanged runtime. Public successor deletion/order and staged-discovery binding
carry controls exercise the reused-index path. Retain the existing scan-equivalence
and carry-order controls, plus held-preparation live mutation, peer, authority,
uncertainty and cancellation cases. Run focused tests and TypeScript with at most
two workers first. Profile the candidate before freezing it; root reviews the
exact diff and schedules frozen acceptance and broad gates. Do not infer an RSS
fix from reduced sampled allocation.

The first test attempt could not reach fixture setup under the restricted native
identity sandbox: all twenty cases reported storage-access refusal, preserved in
`/tmp/core-registry-index-v3-red.log`. The authorized private-fixture run measured
22 runtime normalizations on the unchanged runtime; all other nineteen controls
passed (9.18 s, `/tmp/core-registry-index-v3-red-private.log`). Sharing three
indices as one avoids four parses for two existing rows, so the final budget is
18. That budget fails at 22 before runtime changes; the additional public control
for removing a bound baseline before staged discovery passes (1.65 s,
`/tmp/core-registry-index-v3-red-budget.log`). The removed-baseline case would
otherwise allow a departed conversation's binding to be carried into the staged
row. Root approved the scoped index transfer before the implementation.

The implementation changes fourteen runtime lines and removes seven. All 21
caller controls and six scan/order merge controls pass together (27/27, 10.28 s,
`/tmp/core-registry-index-v3-green.log`), including the 18-normalization budget.
The four focused admission, observation, persistence and fingerprint suites pass
116/116 (49.07 s, `/tmp/core-registry-index-v3-safety.log`). TypeScript and diff
checks pass (`/tmp/core-registry-index-v3-types.log`). These checks ran on macOS
x64 / pinned Node 24.22.2, with no more than two test workers. No broad gate or
acceptance workload has run on this correction; the next artifact is a diagnostic
allocation profile of the frozen candidate, not permission to clear the RSS gate.

### Design — reuse unchanged prepared normalization (2026-11-16)

The exact `63444a6a` allocation profile attributes 81.99 MB (5.61% of sampled
cumulative allocation) to parsing the post-refresh rebase. Every unchanged
prepared row has already passed `validatedRows`, but that final map parses it
again. Keep an operation-local identity lookup from each serialized prepared
object to its normalized private row. Reuse only when the fresh live merge
returns that exact object. Any live-derived or changed result is parsed afresh;
ids, equal contents or a cached pre-await owner never authorize reuse.

The captured inputs come from deep private snapshots, JSON-read disk data or
the existing private uncertain-publication images. Normalization constructs its
own row and normalized arrays; serialization copies the top level and runtimes.
Neither object is exposed to live callers before the no-yield installation.
The fresh merge never mutates the committed objects: changes produce new rows.
Keep native refresh, ownership/revision checks, peer reconciliation, durable
publication, detached receipts and final live/baseline comparisons unchanged.

Growth: one lookup entry per prepared row, discarded after that operation; no
retained cache, new queue or disk data. The registry's existing full-image reads
have no finite configured production row/byte limit. The 160-row fixture is a
scale sample, not a production bound; that architecture debt remains in the
parent's scale review. Read cost: remove only duplicate normalization, not any
disk read or live comparison. Scale and measures: the existing content-free
persistence phase/queue measures remain; root owns final-source CPU/RSS and
latency headroom review. Sampled allocation is not retained memory or acceptance.

Compatibility, migration, audience and identity: no public or stored shape,
account, credential, access decision or retention changes. No migration is
needed; rollback is a code revert. Failure behavior is unchanged: a changed
invalid live row still rejects before publication. Platforms are shared
TypeScript on macOS, Linux and Windows; focused checks here run on macOS x64,
pinned Node 24.22.2. Root approved this narrow Design before implementation.

Validation selected first: tighten the public third-admission normalization
budget from 18 to 15 (three prepared rows), preserving complete bytes, row order
and receipt checks. Add a held-preparation invalid live-row control so an id-only
lookup would fail. Run the existing caller, merge, admission, observation,
persistence and fingerprint suites (at most two workers) and TypeScript. Their
nested edits, deletion, uncertainty and recovery controls must still pass.
No broad/native gate or final timing rerun belongs to this correction's first
pass; prior cost failures remain recorded.

Before the runtime change, the two selected caller controls produced the intended
RED: 18 normalizations against the 15 budget, while rejecting an invalid live row
after preparation already passed (1.77 seconds). The failure is retained in
`/tmp/core-registry-prepared-row-v1-red.log`.

With the identity lookup, all 144 selected caller, merge, admission, observation,
persistence and fingerprint checks pass (six files, 52.61 seconds), including
the 15-normalization budget and the new invalid-live-row refusal. TypeScript and
diff checks pass. Logs are `/tmp/core-registry-prepared-row-v1-green.log` and
`/tmp/core-registry-prepared-row-v1-types.log`. The runtime delta is nine added
lines and two removed. Independent review and final-source acceptance remain
root's work; no cost or RSS improvement is claimed from these tests.


### Final local acceptance and scale review (2026-11-16)

Root accepted this first increment for merge after source-equivalent current-main
integration and required CI. This is not completion of step 4, package 9 or the
whole daemon-core extraction. The change removes blocking lock waits and image
preparation; final authority checks, synchronous rename/directory fsync, startup
loading/migration, production image growth and receipt expiry remain open.

Functional source `f26ac6b1cb998458699e49b6b972b7ea1db191e7` includes main
`8eaa7614` and the input-ordering fix. The resolved overlap preserves both failed/
uncertain-move refusal and cancellation/forget ownership. Its added caller control
settles an old receipt once without dispatching into a replacement session.
All mapped gates pass: core 4,818, portability 1,066 (ten existing skips), PTY/tmux
14, Resume 522 and shell 10; required coverage is 100%. TypeScript passes.
Native registry compatibility/two-writer/crash cases pass 16/16. Input safety passes
14/14 with the matching macOS native-control helper embedded in the bundle. Its
first run had two Codex-admission failures because that helper was omitted; the
failed log is retained, and no guard or test assertion was weakened. Local
platform evidence is macOS x64, Node 24.22.2. Linux PR units remain pending;
shared TypeScript also affects Windows, whose native execution is unverified here.

The final quiet comparison ran one fixed ABBA with four fresh processes and 83
expected outcomes each: 326 successful saves and six expected old-lock refusals.
All processes, owned probes/holders, output streams, locks and private roots
settled and cleaned up, without retries, timeout killing or forced GC. The table
uses medians of the two runs per side. CPU is the registry process during each
group of 20 saves, excluding child CPU and setup; RSS is the sampled natural-GC
peak. The baseline's exercised registry/persistence/native source inputs match
current main; its one differing transitive source is an unused Codex hook
allow-rule literal. This is not whole-bundle identity or whole-product CPU.

| Workload | CPU ms / 20 saves | Save p95 ms | Heartbeat p95 ms | Sampled peak MiB |
| --- | ---: | ---: | ---: | ---: |
| unchanged, 16 rows | 54.41 -> 29.49 | 41.42 -> 3.73 | 41.53 -> 0.15 | 76.96 -> 85.00 |
| changed, 16 rows | 182.52 -> 199.15 | 103.81 -> 66.80 | 104.17 -> 0.70 | 85.14 -> 88.38 |
| unchanged, 160 rows | 125.17 -> 72.61 | 44.42 -> 3.87 | 44.72 -> 0.04 | 87.18 -> 156.24 |
| changed, 160 rows | 561.28 -> 439.81 | 124.13 -> 80.18 | 124.64 -> 3.01 | 119.55 -> 160.60 |

Across the predeclared regular 80-save workload, CPU is 923.37 -> 741.06 ms
(-19.74%); every regular save p95 improves, and both changed-save latencies improve
about 35%. The small changed-16 CPU increase of 9.11% and changed-160 peak RSS
increase of 41.05 MiB remain costs. The preceding unchanged-160 phase peaks 69.06
MiB higher. These natural-GC samples do not establish retained memory or a leak;
no invented RSS ceiling or allocation-only diagnostic is an acceptance test.
The legacy-lock group has different outcomes: old code refuses after about 2 s,
new code completes after about 105 ms. It is not equal-success throughput.

Scale review: 160 rows is 10x the 16-row reference, not a production capacity bound.
Its 80.18 ms changed-save p95 leaves limited headroom against the 100 ms hot-request
reference. The writer queue is bounded, but full-image reads and the operation's
per-row preparation still have no finite production row/byte bound. The next
registry design must address that growth together with startup and remaining
synchronous publication. Existing content-free persistence phase/queue measures
remain the signals; acceptance does not hide those unfinished limits. No stored
shape, migration, audience or identity changes were added by this review; rollback
remains a code revert. Earlier failed comparisons and native failures above stay
recorded as failures.

Evidence: functional receipt `/tmp/core-registry-f26ac6-validation.json`, SHA256
`6bdcbc43a1a74666f9aa9c70b3fb03025c3f2467d76e5f6d6cc1254e328ae972`;
final cost summary `/tmp/core-registry-f26ac6-cost-summary.json`, SHA256
`a765053f817a70e462954c23f6a741e321f72bd325349300247d5eb095e7a644`;
root disposition `/tmp/core-registry-f26ac6-cost-review.json`, SHA256
`6030d604b0563173c9345b954ae228b8352cf06d6fc9a3f31b0838dcae7218c2`.
The original functional receipt predates cost completion; the separate cost
summary and disposition are its final continuation, not an altered old receipt.

## Browser/frame integration review, 16 November

The accepted Browser/frame/Git source `c1ac4e58` overlaps this increment's
asynchronous registry callers. Preserve the registry writer and its complete
displaced-owner snapshots, captured authority, native refresh and final receipt
checks. Preserve the generic lifecycle from Browser: `attach`, pane takeover,
Stop and purge replace feature-specific callbacks; the old Browser mutator and
core Browser lifecycle stay deleted. Legacy saved flags still load unchanged.
No store schema, lock protocol, persistence preparation or commit algorithm is
changed by this integration.

A discovered agent is told as taking its predecessor's pane only after every
displaced owner's awaited cleanup and a fresh committed-owner check. Purge
awaits saved-name deletion before notifying windows and lifecycle followers,
including every former conversation key. Resume retains durable confirmation
and saved launch arguments, then uses the generic attachment callback. Updated
caller controls retain both parents' assertions, including no takeover event
after replacement during cleanup. These are integration controls, not a claim
that the original Browser/registry regressions were newly discovered.

Selected before execution: conflict-focused discovery/lifecycle/registry/Resume
and transcript tests plus TypeScript; the mapped core, portability, Resume,
harnessd, PTY and shell gates for the combined tree; private native registry and
input safety plus Browser lifecycle/custody and workspaces process ownership
where the shared composition changed. Original accepted cost evidence remains
pinned to its source; reusing the unchanged persistence workload requires an
explicit exercised-input comparison. No prior full-gate receipt is relabeled as
a passing combined run. The Resume quiet benchmark is active, so execution waits
for its completion; source review and conflict resolution proceed meanwhile.

## Detached admission snapshots, 17 November — Design

Registry admission replies deliberately own detached snapshots. Two notifications still assumed
that later live mutations changed those replies: Resume announced the old web-search status after
refreshing its launch metadata, and a recovered hook announced an admission hold that core had
just cleared. Capture the current row after the synchronous metadata change and notify only while
the committed owner still matches. Keep every durable launch/readiness receipt and hook admission
check; a newer owner must never inherit the earlier notification.

- Growth: no new stored or retained records; one transient snapshot replaces the existing reply.
- Concurrency: the existing per-agent admission/resume coordination remains. Reacquire by agent,
  verify the committed owner, apply only the existing synchronous metadata update, and capture
  without an intervening await. Recheck ownership after a notification callback can mutate it.
- Read cost and scale: one indexed in-memory agent lookup and one row copy per notification;
  no collection scan, disk read, polling, new fan-out, or new background work. Existing admission
  and Resume failure states remain the signals at 10x; no new capacity claim is made.
- Compatibility: the existing frame shape and durable Registry format are unchanged. All clients,
  including the last 30 days, receive the corrected current values through the same contract.
- Migration and rollback: no migration; revert these caller changes to restore the old behavior.
- Audience and identity: existing local hook authentication, committed owner checks, and the
  owner's Registry remain authoritative. No credential or other account's state is added.
- Failure: a replaced or removed owner suppresses stale notification through the existing changed
  owner refusal or a content-free hook diagnostic; no successful readiness is invented.
- Platforms: shared TypeScript behavior affects macOS, Linux, and Windows. Focused caller tests
  use private state; guest process parity remains a separately opt-in native check.

Before changing runtime code, add failing first-frame and recovered-hook assertions plus controls
for ownership changing during metadata callbacks. Correct three tests that still seed detached
return values: pass fork metadata at admission, register the shared native-history owner, and
capture the real guest process identity before Stop. Preserve every existing behavioral assertion.
Select the complete Resume, Hermes hook, cwd repair, and native-history deletion files after the
focused RED, plus TypeScript. Root's already-passing purge fixture is not changed here. Broader
gates and native/cost reuse remain the coordinator's final-source validation, not this evidence.

Scoped validation: all six selected caller/fixture regressions failed before correction (4.61 s).
The first four-file run then passed 214 cases but failed six existing Hermes fault cases. Their
hoisted store-pool wrapper retained an old error class across module resets; an ordered two-case
reproduction passed the first case and failed the second. A per-fixture spy now wraps the fresh
real module, preserving source failures and every assertion. The complete Hermes file passes
28 cases (30.62 s); the other three complete files passed in the earlier run. Five focused Resume
controls pass (2.95 s), including replacement before/after metadata refresh, cancellation, and a
missing current row. The new cancellation assertion was corrected to the existing coordinator's
`AGENT_CHANGED` contract; its first mismatched-detail failure is retained. TypeScript passes.
These are scoped results across successive source fixes, not a single passing four-file run.
The real guest parity test and final Resume coverage/native acceptance remain unrun here.

## Process reconciliation before hook admission (2026-11-17 Design)

The combined native engine run exposed six Cursor admission failures: a create can confirm its
process while the hook-triggered reconciliation prepares an observation, so the Registry owner
guard correctly refuses that stale observation. The rejection escaped process resolution before
the bounded admission queue owned the request and became HTTP 500. A separate single diagnostic
did not reproduce the race; it does not supersede those failures.

Treat only `RegistryOwnershipChanged` from the hinted reconciliation as an overdue observation.
Continue the existing current-process matcher and bounded record/pane-commit wait, using the
arrival-time ancestry already captured. Unknown errors still propagate. Do not weaken the owner
guard, adopt the rejected observation, or grant the hook a binding from its old snapshot. The
existing `onWait` reply remains a live hold while daemon resolution continues; returning 202 and
dropping resolution would lose Cursor deliveries because that client does not retry the same hook.
No new queue, retry policy, state, disk format, migration, account authority or capacity is added.
The shared TypeScript change affects all platforms; native acceptance here is macOS only.

Tests first inject the actual typed guard refusal into the resolver and assert fresh matching,
waiting for pane publication, and refusal after removal; an unrelated error still rejects. Then
run the complete resolver file with its per-file coverage and the affected native Cursor cases
on the corrected combined source. Earlier native failures remain recorded until that proof.

# Registry persistence without lock sleeps

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

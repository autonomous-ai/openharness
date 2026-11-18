# Paste preparation outside the core

Status: image and file preparation, storage, retention and native clipboard work are extracted in
frozen candidate `05bf43f451`. Its integration onto `68f03b4374` is under review; matched historical
V4 still holds on combined CPU (+21.29%) despite lower core CPU (-10.25%) and sampled RSS (-28.03%).
The file-only Design below is historical and superseded by the completed-image sections later in this
record. Current integration preserves the native descriptor proof, private clipboard acceptance and
128-operation physical-settlement admission. It is not yet accepted or shipped.

This is the first slice of package 7 in [the core plan](2026-11-15-core-plan.md), limited to paste uploads.
Harness indexes, manifests, registry, setup and attachment storage are outside it.

## Design

### Approved scope after the native proof

The candidate below originally covered images and other files. Native macOS evidence now rules out its
image part: AppleScript's PNG read refuses inherited `/dev/fd/3` with `-1700`. Reopening a prepared pathname
would weaken the file-identity boundary. Move **file-drop uploads only**, keeping the image byte preparation
and clipboard implementation in core. Do not add another image mechanism in this slice.

This narrower scope means the existing stream slot becomes a discriminated union: file uploads keep
generation UUID, kind and whether final input already belongs to MoveGate; images keep their existing
metadata/buffers plus that generation and its bounded allocation release. The same
generation fence applies after every await and at final dispatch for BOTH kinds, including cross-kind Cancel
and new begin. Standard 3 requires fixing every case of this cancellation cause. Keep both caller RED tests.
No new image helper, buffer copy or global clipboard mutex. Release image chunk references after the existing
assembly step; retain only the control token through preparation and final dispatch.

Previously the slot cleared at assembly, allowing a second begin before the old paste finished. Keep it
occupied until dispatch settles: a second begin gets the existing busy refusal; Cancel invalidates it
synchronously and frees the logical slot for a new begin of either kind, subject to outstanding-work
admission capacity that Cancel cannot release early. Desktop already waits for completion and
supports busy-to-Cancel retry. This changes no wire frame or pacing. Old operations cannot clear a new token,
emit late progress/completion, or type. Cancelled worker I/O still holds its reservations until actual settlement.

Use a fixed private `paste-drops/file-uploads` child for new worker-owned artifacts, so the unchanged image
helper's legacy flat-directory pruning cannot delete worker staging files or invalidate its accounting.
Existing files stay where they are and remain under their existing retention behavior; do not migrate,
delete or silently count them as newly bounded. The new service's 2 GiB/1,024-file ceilings cover its own
child directory only. Legacy image/paste storage growth and pruning remain explicit core debt. On rollback,
new paths still resolve, but their automatic expiry waits until this service runs again; an older flat-folder
pruner cannot reclaim the child directory. Review accepted this bounded rollback-retention limitation.

### Ownership and the remaining core work

At the baseline, `lib/terminalStreamManager.ts` stores incoming image/file chunks in `ActiveStream.pendingUpload`,
copies every chunk, concatenates the complete upload, then calls `lib/pasteDropFiles.ts` to write it.
An image also calls `lib/osClipboard.ts`; core then sends Ctrl+V or pastes the saved path. These helpers are
in `architecture.coreFiles.txt`. The stream manager is their only production caller.

Move file-drop metadata, chunk validation/assembly, filesystem admission, writing and retention to a `paste` service
in the existing edge process. Use the established `CorePorts`, service host and service-link composition.
`services/paste.ts` owns the component, `services/pasteProcess.ts` its private process protocol; registration
belongs in `harnessd/services.ts`, `serviceProcess.ts` and `services/inline.ts`. No new process, datastore,
runtime dependency or public client route is needed. Do not give this service agent input authority.

Core retains its existing `pendingUpload` slot, reduced to generation UUID, kind and final held-dispatch
ownership for file drops only.
This is existing final-input control state, not a new map. Core also retains stream authorization, MoveGate,
final path delivery and the unchanged image/clipboard path. It validates the bounded prepared-file result
without reading file bodies. File-drop whole-file buffers, concatenation and file writing leave core; bounded binary
views still wait in the existing input lane, and image buffers
remain. Neither `pasteDropFiles.ts` nor `osClipboard.ts` can leave the default import closure while the
unchanged image path still calls them. Do not claim a file-count reduction that this narrowed slice cannot make.

### Transport and published contracts

Keep terminal protocol version 3, all existing begin/progress/result frame names, the literal
`an upload is already in progress on this pane` refusal, image/file limits and fallback outcomes.
Desktop sends 256 KiB chunks with a 1 MiB acknowledgement window: four chunks may be in flight.
No client changes or backend rollout are required; the last 30 days' clients retain their wire contract.

The service has a dedicated existing authenticated service link. Per chunk, synchronously and without
an intervening await, the core checks the paste link's `buffered()` value, sends a `service_event` header,
sends the original `TerminalBinaryClear.bytes` view with `notifyBinary`, then starts a private `call`
for that operation's result. Header fields are generation, fresh operation UUID, trusted connection/stream,
kind, sequence, byte length and deadline. The core does not encode, concatenate, base64 or copy the body.
JSON metadata plus the result request is bounded to 2 KiB per chunk, excluding the unchanged binary body.

`services/process.ts` invokes `onEvent` synchronously before the next binary message. The worker associates
the next binary message with that header, and the result RPC with its operation UUID. A new header fails an
unpaired predecessor. Binary without a header is refused. Failure to send a header sends no body; failure
to send a body fails that operation. Ordered WebSocket messages and the synchronous send sequence prevent
cross-operation pairing. This needs fault tests, including handler rejection before the body and reconnect.
Header/body pairing, filesystem write queues, completion and expiry records live in the worker; bounded
input admission and the existing ordered terminal lane remain in core. Begin registers its generation
synchronously before any asynchronous file work so a subsequent Cancel cannot overtake registration.

The 36 MiB outbound ceiling is **paste-link-only**, using existing `serviceLinks.buffered('paste')`.
There is no generic transport limit to widen: `localWsServer` sends directly. Do not change that transport,
other services' send limits. The reviewed dispatch correction below bounds/reuses the existing backend
stream lanes; it adds no second core queue.
Added overhead is one event header, one existing RPC round trip and one UUID per chunk; measure it.

### Approved dispatch correction

The shipping caller REDs supersede the original assumption that current transport dispatch was already
appropriate. `localWsServer` awaits a complete binary operation on one socket chain; the remote backend
has an existing per-stream lane. A held file write or image preparation blocks local Cancel and every
other pane. Detached preparation alone is unsafe: Enter could overtake the uploaded path, and a drained
service socket leaves its connected RPC map unbounded. This correction reuses the existing stream lane.

**Routing and authority.** Local binary dispatch hands work to `BackendSocket.enqueueTerminalBinary`
without awaiting terminal preparation on the socket chain. The backend reuses `inStreamLane` for local
and remote binary input. The manager synchronously checks read-only/watch status, current connection,
live stream and allowed kind before any reservation. It supplies a closure over the admitted stream and,
for an upload chunk, the exact existing generation object. The queued closure repeats liveness/generation
checks before calling the worker. It cannot look up a successor and reinterpret old bytes as its upload.
No worker gets a terminal target or a terminal-writing callback.

Begin and Cancel keep the existing terminal authorization and request-ready checks but bypass upload
preparation in the backend lane/down-chain. Begin validates and assigns its generation synchronously,
then starts its existing bounded worker admission. Cancel invalidates the selected generation immediately
and sends the existing cancellation event. Begin remains charged while its admission promise is pending.
If Cancel frees the logical slot while old work still occupies admission capacity, a new begin can receive
a capacity refusal immediately; cancellation does not pretend the old memory/RPC work has settled.

**Admission state and ceilings.** Extend the existing `streamLanes` map entry, rather than add a map or
queue: its existing tail plus counts of admitted frames, payload bytes and upload operations. Keep the
corresponding three scalar totals on `BackendSocket`. Reserve synchronously before adding a promise to
the lane or starting a detached begin. A begin uses one upload operation and one frame, with bounded
control metadata; a chunk uses one upload operation, one frame and its original body-view byte length.
Limits are four queued/running upload operations per stream and 128 across this backend, counting begin
and work from cancelled/closed generations until settlement. An accepted begin has settled before the
client sends its four-chunk window. Ten simultaneous 4 x 256 KiB file windows therefore use 40 of 128
slots and 10 MiB of the 32 MiB upload-body ceiling. A fifth unacknowledged chunk cannot create a worker
RPC, another queued promise, or another retained body view.

The existing lane also needs an overall bound now that local socket dispatch no longer waits for it:
64 admitted frames / 8 MiB per lane; 512 frames / 64 MiB across this backend. These include begin control
metadata and ordinary input/paste, not just uploads. Eight MiB admits the existing 6 MiB plain paste plus
one 1 MiB upload window and keys. Refused work is never enqueued. This is an explicit expansion of the
existing all-terminal admission bookkeeping, not a generic transport/service queue. The paste-link-only
36 MiB socket ceiling remains unchanged; generic serviceLinks/localWs socket send behavior is unchanged.

Images additionally reserve their declared assembly allocation, rounded up to 256 KiB, against a single
32 MiB manager-wide counter at begin. Partial-image cancellation discards its existing chunks and releases
that reservation; once assembly transfers ownership to preparation/held delivery it stays charged until
that actual work settles. This limits old cancelled image preparations without another copy or helper.
The existing assembly can transiently allocate another two 8 MiB arrays for one maximum-size image;
this is not an RSS guarantee or removal of the image-storage/clipboard residual.

**Ordering versus settlement.** Keep these lifetimes separate on the admission token; do not create
another queue. The existing lane advances only when a dispatch has established its ordering. For an
ordinary file/image preparation that means its current final-paste decision has finished, so a later
same-pane Enter cannot overtake it. Another pane has a separate existing lane and proceeds immediately.
Normal plain paste retains its current ordering. File chunk work initially starts inside its existing
lane, preserving the shipping caller's serial writes while admitting the full four-frame client window.

For work handed to the existing MoveGate, establishing order means enqueuing its callback there. The lane
may then advance so later input joins that same gate in order and retains existing after-close delivery.
Its count/byte/upload admission token is released only when that callback completes or is discarded by
its generation fence. Making the lane await the callback would break this parity. The same ownership
handoff applies to existing non-awaited raw writes: preserve their pipelining, release their admission
when the existing result promise settles. An input held for sequence reordering retains its release
callback on the existing bounded held-input entry until it is written/refused/dropped; no new held-input
map is introduced. Tokens have one idempotent release path; cancellation, close and timeouts do not
release memory that an existing callback or asynchronous operation still owns.

**Failure, closure and cleanup.** Overflow uses existing client frame shapes: begin gets
`terminal_chunked_upload_begin_result {accepted:false, reason:PASTE_WINDOW_EXCEEDED}`; a file/image chunk
gets its existing terminal failure code and a static `PASTE_WINDOW_EXCEEDED` message, and only its captured
current generation is revoked. Ordinary lane overflow reports `TERMINAL_INPUT_OVERFLOW` and closes only
that stream through its existing close path, with a visible reason; reopening is required, and later flood
frames no longer own a live stream. It never silently consumes an Enter or floods unbounded error replies. Counters/bytes
are updated only on admission and settlement, never by scanning lanes. A closing connection synchronously
revokes unfinished uploads through existing manager closure, prevents any new admissions, and leaves
already-owned lane entries charged until their tasks skip/finish. Remove a lane entry only when its tail
and all retained settlement tokens are complete; identity-check deletion so old completion cannot remove
a successor. Already-enqueued MoveGate input keeps the established row fallback authority.

No-service/fallback admission returns the existing named failure and releases its token immediately.
Inline/Harness OS uses the identical manager/lane admission before the same PastePort, so it cannot bypass
these bounds. Worker filesystem reservations remain charged after its timed reply until real I/O cleanup
settles. Unknown/expired current uploads produce `PASTE_UPLOAD_UNAVAILABLE`, while published duplicate
generations may remain ignored; stale replies still fail the manager's generation check and cannot clear
a successor. Existing worker/call deadlines remain; this does not claim to repair every pre-existing
image filesystem/clipboard wait or the cross-paste clipboard race.

**Final authority and evidence.** The held/closed fallback currently has no tmux implementation:
`TmuxBackend` implements neither `pasteInput` nor `writeInput` at this base. Its existing not-started result
is a limitation, not proven delivery. The implemented PTY `pasteInput` selects its client and calls the
client's synchronous socket write before its first await; it has no load-buffer gap. Live tmux streams
already check `allowed` before and after load-buffer; live PTY streams synchronously emit their frame.
The actual PTY-boundary test confirms this synchronous dispatch; preserve the existing lack of tmux fallback, and do not
invent a worker-selected terminal authority path.

Required RED/green cases: the real private-WebSocket file/image cancellation and same-pane Enter cases;
four accepted chunks and an over-window flood while worker bufferedAmount is zero; begin/Cancel/new-begin
and connection-close churn retaining old charges; unknown-stream/watch/read-only calls consuming no
capacity; mixed plain paste/input ordering and independent panes; queued old generation after a new begin;
MoveGate callback charges, later held keys and after-close delivery; lane overflow/resumption/cleanup;
no-service and inline behavior. Run only focused checks after review; broad gates/native/performance remain
root-scheduled. Root reviewed and approved this explicit core admission state and input-test scope after
the real wire REDs, before runtime edits.

### Audience, identity and revocation

Core keeps current owner, connection, watch/read-only and live-stream checks before delegation. The worker
never chooses a terminal or requests raw input. Core selects delivery from its captured stream/MoveGate.
No service operation accepts client-supplied authority, provider credentials or another account's login.
Files use the daemon's existing filesystem identity; this does not introduce an agent login operation.

The captured generation must still equal the existing stream slot after every asynchronous reply, including
begin and progress, and at final dispatch. Cancel invalidates that slot synchronously and sends an unheld
cancellation event. An old preparation may finish cleanup but cannot emit progress, a completion or input
for the next upload. Stream closure/takeover and link replacement also revoke unfinished preparation.
MoveGate's deliberate delivery of already-held input after stream closure needs parity tests: preserve the
existing authority decision; the worker must not reinterpret it or choose the row. No new shared cancellation API.

`serviceLinks.call` times out the caller but does not abort worker filesystem work. The worker therefore has
its own deadline and cancellation event. It retains the operation's reservations until actual I/O settlement,
even after the caller stops waiting. Disconnect aborts every generation belonging to that service connection.
No upload or final terminal action is automatically retried or replayed. Duplicate chunk sequences use the
first accepted body and never increase progress twice; completed generations cannot dispatch twice.

Existing wire limitation: old clients send no upload generation with binary chunks. An old client's chunk
arriving after a new begin can be indistinguishable from the new upload. Internal generations fence stale
worker replies; this slice does not claim to fix that pre-existing client ambiguity.

### File identity at final delivery

The worker returns bounded artifact facts, never an arbitrary absolute path. Files use
`<generation>-<sanitized basename>` under the fixed configured `paste-drops/file-uploads` directory.
Core constructs the path. It refuses separators, controls, ADS syntax, invalid
generation prefixes and excessive encoded basename length. Filename sanitization remains in the worker;
core only validates the resulting single component. No filename/path/content goes into diagnostics.

Reuse already-loaded `NativePaths`, `NativeEvidenceBudget` and `nativeFileKey` for independently established
core evidence, not worker assertions: owned private paste directory; tracked ancestry and physical containment;
no link in the private subtree; regular single-link file; matching current UID/private mode on POSIX; and
size within the selected kind's ceiling. Open read-only with `O_NOFOLLOW | O_NONBLOCK` where supported and
compare the descriptor's identity/version with the inspected pathname and publication result. Hold its
identity through final dispatch and check the route/version at the existing final paste guard.
Windows uses configured/profile roots, refuses junctions/reparse points and ADS paths, and follows the
existing version comparison exception for `ctime` changing at last handle close.

The worker closes its writer before atomic publication and never rewrites a published artifact. Core reads
no payload or payload hash. These checks constrain the selected artifact and detect replacement; they are
not an OS sandbox against a malicious same-UID process, nor a guarantee that a path cannot change after
the application receives it. Native evidence budgets bound work/check elapsed time, but cannot interrupt a
kernel-stalled filesystem syscall. Do not describe them as hard filesystem timeouts.

### Rejected image variant and explicit clipboard residual

The following was the prerequisite for moving image preparation too. It is not implementation authority:
the macOS part failed natively, so all of this helper work is excluded from the proposed file-only slice.

Linux supplies the verified read-only descriptor as `wl-copy`/`xclip` stdin; no image bytes return to core.
The parent descriptor closes once, synchronously in the post-spawn finally, before exit callbacks can run.
Close failure is named `PASTE_CLIPBOARD_FD_CLOSE_FAILED`, not silently swallowed or retried against a
potentially recycled descriptor. Clipboard execution has a 5-second deadline, bounded termination and
64 KiB stderr ceiling. Keep completion on child exit rather than inherited-pipe closure. Return only static,
bounded failure reasons; no raw helper stderr or paths. Windows and WSL keep their current path fallback.

macOS must read the verified inherited descriptor through fd 3 and `/dev/fd/3`; simply passing a prepared
pathname to AppleScript reopens a replaceable file. Before runtime work, prove the exact AppleScript
`read ... as «class PNGf»` operation with a private PNG, a replaced original pathname and inherited fd 3.
The proof must never read or write a clipboard, use the real home, or run a terminal. If it fails, propose a
file-drop-only first slice; do not substitute a replaceable pathname or silently change image behavior.

After clipboard success, generation check and Ctrl+V dispatch must execute before any added await, RPC,
descriptor cleanup or file deletion. Cleanup is requested after dispatch. No global clipboard mutex/state is
added. **The existing cross-paste global clipboard race remains outside this slice's correctness claims.**

### Growth, admission, concurrency and cleanup

Filesystem quota counters, reservations, write queues and expiry records are worker-owned. Core retains
the explicitly approved input admission counters/holds above. Reserve filesystem quota atomically at begin;
serialize file operations per upload, with up to four queued/active chunk slots, not one.

| Resource | Ceiling and behavior |
| --- | --- |
| Upload body | Existing 20 MiB file limit; exact chunk geometry required; 8 MiB image path unchanged in core |
| Active uploads | 32 globally, 4 per trusted client connection; cancelling unsettled work still counts |
| Chunk reservations | 4 per accepted upload, 128 globally; the 32-upload worker ceiling leaves room for every full window |
| Chunk body memory | 256 KiB per slot, at most 32 MiB total; no assembled full-body buffer |
| Paste-link outbound queue | 36 MiB for this link alone, checked before the complete header/body/RPC send sequence |
| Chunk control framing | At most 2 KiB per chunk for metadata and result request |
| Retained storage | 2 GiB completed bytes plus reserved announced upload bytes; failed cleanup stays charged |
| Published files | 1,024; active uploads reserve their eventual published slot |
| Deadlines | 30 seconds per operation/inactivity; one-hour absolute unfinished-upload lifetime |
| Completed retention | Existing 24 hours; do not evict an unexpired file for a new upload |
| Inventory | `opendir` buffering 128 entries, one inspection at a time, at most 4,096 entries |
| Expiry | One owned pass of at most 128 entries, four concurrent inspections/deletions; stop awaits that pass |

Ten concurrent uploads reserve 40 slots: 10 MiB bodies plus at most 80 KiB chunk control framing. All 32
full windows require 32 MiB plus 256 KiB framing; the paste-only 36 MiB ceiling leaves bounded control
and WebSocket overhead. A stalled worker receives no acknowledgements, so well-behaved clients stop at
their existing window. The tests must confirm the complete send sequence's actual buffered accounting.
Do not acknowledge until the chunk write settles and its body is released. A fifth unacknowledged chunk
cannot borrow another upload's reservation. Cancellation does not release occupied I/O slots early.

Write positionally into an exclusive private `.part` file. Exact sequence/length geometry prevents holes
or overshoot; duplicate sequence numbers do not double-count. Publish only a complete closed artifact by
atomic rename. No incomplete path reaches a terminal. A failed/cancelled write is removed after I/O settles;
a deletion failure keeps its byte/file charge and a named failure. After uncertain final delivery, retain the
published file normally because its path may already have reached the application.

Startup performs bounded inventory once and seeds one bounded expiry schedule; request paths update only
changed entries. No `readdir`/unbounded `Promise.all` per upload. If inventory exceeds 4,096 entries, preserve
unexamined files and refuse new uploads with a named inventory-capacity failure. Do not silently delete them.
Existing completed worker-owned files stay in place and count against its storage. Legacy flat-folder files
are preserved outside these new ceilings. Only recognized unchanged worker-owned paste artifacts
qualify for expiry; foreign files, links and directories are not followed/deleted. Preserve changed/unsafe
entries and report the cleanup problem. Orphan parts become eligible after the unfinished-upload deadline.

The ceilings are enforced safety bounds, not measured capacity claims. The root-scheduled performance fixture
must record content-free counts/bytes, admission utilization, pending cleanup and oldest-operation age; this
slice adds no telemetry carrying paths or identifiers. Named capacity/cleanup failures are the first runtime
warning. Ten concurrent uploads are the initial tenfold workload;
prove latency/memory headroom rather than infer it from source lines. Re-review when measured capacity is
less than tenfold below a relevant limit or the same failure needs another patch.

### Failures, compatibility and rollback

Worker off, down, held off, hung, full or failed refuses the upload through the existing terminal responses;
ordinary terminal input remains usable. Map failure details to bounded existing `terminal_error`/begin refusal
contracts, with a stable paste failure code and content-free diagnostic. Begin still resolves before the
client's 10-second wait: do not wait 30 seconds to report an unavailable service or an incomplete inventory.
Cleanup faults are logged by name and appear in upload refusal reasons when they prevent admission.

Completed files remain ordinary files in the fixed child directory. No schema migration or destructive
relocation. A rollback can still read their paths; automatic expiry resumes when the new service next runs.
The explicit inline debug/Harness OS/older-master route uses the same service logic
and is tested; a worker failure never activates an inline fallback. Any temporary older-master exception
must have a removal date. The default supervised core never imports the moved component implementation.

Execution platforms: macOS, Linux and Windows. Desktop/mobile/web wire contracts stay unchanged. Report
which native platforms were actually tested; a mocked platform result is not native Windows evidence.

### Rules and evidence before implementation/ship

This Design addresses repository standards 1/2/9 by shrinking the existing boundary with no new generic core
mechanism or dependency; 3/12 by caller RED evidence and one reviewed task; 4/8 by bounded operations and
matched runtime measurements; 5 by the lifecycle/rollback/admission rules above; 6 by named failures,
deadlines and no replay; 7 by stream authority/private artifact proof; 10 by platform evidence. Component
rules require the default import closure, 100% affected core/service coverage and native failure isolation.
Windows process rules apply: no Windows clipboard subprocess/window is introduced.

First approval checkpoint: this document, actual `TerminalStreamManager.handleFrame/handleBinary` caller
RED cases for cancellation across asynchronous preparation/final dispatch, a four-chunk compatibility case,
and the private macOS descriptor proof. The proof failed; review approved file-only extraction with the
shared cancellation fix. Reproduce both REDs once on pinned Node 24, then commit Design/RED before runtime.
Broad/native/performance checks and push still require the root's frozen-checkpoint review.

Later implementation evidence: service protocol/body-view tests; four-slot/global actual-settlement accounting;
late begin/progress/final replies; watcher/owner/takeover checks; pairing faults; chunk geometry/duplicates;
quota/inventory/cleanup failures; malicious paths, symlink/hardlink/owner/version replacement; descriptor
close failures; Windows junction/ADS cases; MoveGate parity and exactly-once dispatch. Clipboard child timeout
changes belong to the rejected image variant and are outside this slice.
Run a private real worker killed, SIGSTOPed, restarted and held off while an unrelated terminal echoes.
Use no owner homes, accounts, daemon, tmux server or clipboard. Pick affected core/harnessd/PTY/portability
checks before running; run full required gates only after the implementation checkpoint.

Measure identical baseline/new workloads (256 KiB, 4 MiB and 20 MiB files; images through 8 MiB; ten concurrent
four-chunk bursts; all 32 reserved windows against a stopped worker; simultaneous typing; idle/off state).
Report paste latency, core CPU/RSS, worker memory and terminal echo p95, including the UUID/header/RPC cost.
Do not claim a speedup or complete core extraction before those results exist.

## Evidence record

2026-11-16, Node v26.7.0, native macOS, base `8fcfa7de5c`:

- Design recorded before test/proof execution. Only this document, caller tests and the standalone proof
  script are changed; runtime remains unchanged. No full gate, build, performance run or push.
- Caller command: `node node_modules/vitest/vitest.mjs run src/lib/terminalStreamManager.spec.ts --maxWorkers=1 -t 'paste preparation boundary' --reporter=dot`.
  Result: **2 failed, 1 passed**, 115 outside the selection. Cancel/new-begin still allows the old file path
  into `pasteRaw`; late cancelled image completion still sends byte `0x16`. Both fail on observed terminal
  input, not missing imports. Ten independent uploads each accepting four 256 KiB chunks pass. This is
  baseline compatibility, not evidence that the future service's admission/backpressure implementation works.
- Initial test run also exposed a fixture mistake: ten fake handles all reported `%1`, correctly triggering
  the control lease. Give each handle its session's distinct runtime; rerun only these selected cases.
  The corrected run above retains the two intended RED failures.
- Private proof command: `node scripts/paste-fd-proof.mjs`. It creates a fixed 68-byte PNG in a private
  temporary directory, opens a read-only descriptor, replaces the original pathname, and asks `/usr/bin/osascript`
  only to return `read (POSIX file "/dev/fd/3") as «class PNGf»`. Child HOME/CFFIXED_USER_HOME/TMPDIR point to
  private fixture directories. No clipboard read/write, real-home access or terminal process is involved.
- Sandbox execution: unavailable, XPC `Connection invalid` and AppleScript `-1708`. This is not descriptor
  compatibility evidence. One permitted native execution then failed **`-1700`: cannot make the fd path
  into type file**. Do not retry the assertion green or substitute pathname reopening. The proof script
  remains reproducible evidence of why the image candidate was rejected, not a normal passing test gate.
- The targeted caller run took 673 ms; native proof command 80 ms. These are validation durations, not
  product performance measurements. Implementation/merge/publication durations: not started.
- Before runtime edits, reproduced the same two RED failures and passing ten-window compatibility case
  with `/Users/d/.harness/runtime/node-v24.22.2-darwin-x64/bin/node` and PATH pinned to that directory plus
  `/usr/bin:/bin`: 685 ms. All subsequent product validation uses this pinned Node 24 toolchain; Node 26
  results above are retained as historical evidence only. The slot-lifetime correction enforces the existing
  single-upload contract through final dispatch. Additional focused cases will cover cross-kind cancellation,
  the final busy interval, failure followed by begin, duplicate completion and held MoveGate input.
- Pre-runtime Design/RED commit: `a8c6498126`. Runtime work remains on this isolated branch; root owns
  review, PR and merge. No architecture golden, coverage exclusion, broad gate, native process test,
  performance run or push has been added during implementation.
- Focused implementation runs reached 164 passing caller/link/worker/private-file tests before independent
  review identified more worker ownership cases. A replay of a completed generation first failed by being
  accepted again; the worker now retains a bounded generation index with the retained artifacts.
- Native filesystem fixture REDs also found that `/tmp` aliases made a lexical private-prefix comparison
  miss a symlink under the resolved data root, and that rejecting a parent symlink after mkdir could already
  have created a child outside the selected directory. Resolve the configured root, inspect its private
  ancestry before creating anything, and verify again after creation. These are worker/file-proof corrections,
  not a new path mechanism.
- Review's three additional caller REDs failed on pinned Node 24: initial inventory discovered an existing
  generation after begin's first check and its published bytes were overwritten; cancellation deleted a foreign
  replacement of the staging name; inspection failure after successful rename allowed that generation to reopen.
  Recheck retained generations after inventory; match the owned staging inode/version before cleanup/publication;
  retain generation, bytes and file count immediately when rename settles, before inspection can fail.
- Chronology of the created guard: it was already added during source review before the new unowned-create
  tests. For RED evidence only, remove that one guard, run the two new cancellation/inventory-failure cases,
  observe both foreign `.part` files deleted (two failures), then restore it. Do not describe their subsequent
  greens as red-first implementation. The final guard also requires the exact staged identity, and never
  unlinks a pathname whose exclusive create failed.
- After those ownership fixes, all 33 worker cases passed on pinned Node 24 (1.12 seconds). At that checkpoint,
  a complete focused rerun, final TSC and coverage receipt were still pending. A published
  file whose identity could not be inspected stays charged and its generation cannot reopen; expiry reports
  `PASTE_CLEANUP_UNVERIFIED` and preserves it until a subsequent service inventory can establish evidence.
- Shipping-caller review found a further blocker: `localWsServer` awaits `handleLocalBinary` on its socket
  chain, which awaits the manager's complete chunk preparation. Thus Cancel and another pane's input cannot
  reach the manager while a worker write or image helper is held. Direct-manager cancellation tests do not
  prove wire cancellation. Four real private-WebSocket caller regressions reproduced this failure after
  the root's quiet performance window, as recorded below. The dispatch correction is approved for implementation.
- The earlier assumption that the existing service call path bounds connected pending requests was wrong:
  `serviceLinks` has notification and restart-wait bounds, but its connected `waiting` map has no admission
  bound. The paste socket's 36 MiB buffered-byte limit alone cannot bound requests after the worker drains
  bytes. The approved correction bounds existing input admission; generic service transport stays unchanged.
- Approved Design: reuse the existing per-stream backend lane for local binary input, retain final paste
  before later same-pane keys, process cancellation outside blocked upload preparation, and charge bounded
  work before lane insertion. A queued chunk must retain its selected generation across Cancel/new begin.
  Any new reservation remains charged until actual queued/running work settles, including stream closure and
  held MoveGate delivery. Root completed explicit core-state review; no new queue/map is added, and no claim
  that the retained image/clipboard/final-input residual has left core is made.
- Real wire RED receipt (pinned Node 24): the sandbox first refused private Unix `listen` with EPERM, which
  is not behavior evidence. One authorized permission run then reached the intended assertions: all four
  file/image x Cancel/no-Cancel cases timed out waiting for unrelated input while preparation remained held
  (5.14 seconds). Finally blocks released preparation and closed clients, local servers, backend managers
  and sockets; no `hpaste-wire-*` fixture directories remained. This receipt predates dispatch runtime edits.
- Dispatch Design/RED checkpoint: `deceec4292`. The initial integrated focused run passed 202 tests across
  seven files, including all four real wire cases and admission/Cancel/close/MoveGate caller checks.
  Subsequent focused worker/link coverage reached 100% statements/functions/lines with one remaining
  cleanup race branch before the expiry review below; that receipt is historical, not final acceptance.
- Publication during a held expiry pass reproduced a worker cleanup bound violation: with 130 due files,
  the original scheduled pass held four inspections and a new publication scheduled two more concurrently
  (peak six, expected four; pinned Node 24 RED, 997 ms). The initial stop test passed for the wrong reason:
  its setup upload still needed cleanup. The corrected fixture publishes that upload before expiry and
  reproduced early stop. One service-owned in-flight expiry Promise now prevents overlapping passes and
  is awaited by stop. The first green attempt passed stop ownership and descriptor-close reporting, but the
  overlap fixture timed out. Source review identified a regression in that refactor: initial inventory calls
  expiry directly, and its initial timer was no longer armed after scheduling moved to the timed-pass finally.
  Scheduling is restored after the initial pass (which stop already owns through initialization). The overlap
  fixture also uses the public stop barrier to assert that only the owned 128-entry pass completes and the
  two unstarted expiries remain. No timeout was increased. After the quiet window, all three narrow expiry/
  stop/descriptor-close regressions passed in 1.51 seconds. The earlier suspicion about fake-clock ordering
  was not the diagnosed cause.
- Final focused caller/worker run: **217 tests passed in seven files, 7.66 seconds**, pinned Node 24 with one
  worker. This includes six private-WebSocket cases (file/image mocks plus real inline file preparation),
  public admission bounds and lifecycle cases, worker ownership/cleanup, private-file proof and service
  protocol failures. `core/pasteLink.ts`, `services/paste.ts` and `services/pasteProcess.ts` each have **100%
  statements, branches, functions and lines** (aggregate 420/292/63/285). A separate focused run passed the
  actual `PtyHostBackend.pasteInput` synchronous-dispatch case. No clipboard or owner terminal was touched.
- One new global-frame recovery fixture initially awaited only native write acknowledgement, before the
  manager's reporting Promise settled. It now observes the existing public admission callback's retained
  Promise, proving recovery at actual settlement. The runtime was unchanged. TSC also found an implicit-array
  type in the new global-byte fixture; an explicit test element type fixes it without changing runtime.
- Final pinned Node 24 `tsc --noEmit --incremental false --pretty false` passed. Since the focused test run,
  only that test type annotation, comments, whitespace and this evidence record changed. Broader gates,
  architecture-closure approval, native failure isolation and matched performance evidence remain pending
  root scheduling; no PR or push has occurred.

## Expiry timer ceiling addendum

Independent review of frozen `6df5076dec` found that a recognized artifact's future mtime, or a backward
wall-clock jump before rearming, can make its next expiry delay exceed Node's maximum supported positive
timer delay (`2^31 - 1` milliseconds). Node reduces an excessive delay to one millisecond, so the unchanged
future expiration repeatedly rearms a one-millisecond timer. That violates the daemon's idle-work bound.

Clamp only the scheduled wait to `2^31 - 1`, retaining the existing minimum of one millisecond. The stored
expiration date, private-file identity, quota reservations, single expiry-pass ownership and stop barrier
remain unchanged. A maximum-length wait wakes the existing scheduler to recompute the remaining time;
this introduces no periodic poll, new timer, setting or early deletion. It applies equally on macOS, Linux
and Windows and changes no wire or storage format, migration, audience or filesystem identity.

The public `createPasteFiles` regression uses recognized real files in private temporary directories and
fake time, with separate future-mtime and backward-clock cases. It observes repeated timer scheduling,
asserts retained bytes before the original expiration, then verifies eventual deletion through the existing
filesystem callback. No fixed sleeps or private service state are used. Test and Design preparation precede
runtime changes. After quiet release, pinned Node 24 RED execution failed both cases in 1.28 seconds:
each scheduled ten excessive timers during ten milliseconds of fake time (delay about 2,233,883,645 ms,
above the supported 2,147,483,647 ms). The original runtime remained unchanged for this receipt. Broader
gates remain root-owned.

Design/RED checkpoint: `39d60f8e8c`. The single scheduled-delay clamp then passed both regressions in
877 ms on pinned Node 24; the original expiration and all quota/identity/ownership state are unchanged.
Independent architecture review approved adding only `core/pasteLink.ts` to the sorted core-file list:
it is the bounded service bridge and all of its dependencies already belong to that closure. No moved
service implementation is approved for the default core closure; existing image helpers remain there.

Final timer checkpoint validation: **243 tests passed across eight focused files**, including all architecture
checks, in 28.45 seconds. The three new bridge/service files retain **100% coverage in every dimension**;
pinned Node 24 TSC passed. All paste wire/storage/expiry fixture directories were removed, and no validation
process remains. No broad suite, native process, build, performance run or push was started. Root will
integrate current main before broad acceptance; this task branch's base remains unchanged.

## Native acceptance plan

Prepared on integrated `19bfeb663d` (main `1ee076c588`), before native test edits or execution. This
adds tests and private measurement fixtures only. Runtime behavior, storage, wire contracts, migration,
audience and identity remain the reviewed design above. Root reviews this plan, supplies frozen shipping
bundles and schedules every execution; a prepared test is not passing evidence.

### Checked-in native cases

Add `cli/e2e/paste.e2e.ts`, using the current `IsolatedDaemon`, copied standalone Node, fake Claude Code,
private tmux and `LocalClient`. The fixture owns at most two agents and one daemon per case. Terminal
input uses actual binary frames and the fake engine's real turn events, with no backend, worker, filesystem
or core-port substitution. Files contain deterministic synthetic bytes. No image frame or clipboard call
is made. Windows is explicitly unverified: these process-signal cases run where the private tmux harness
and signals exist, not through a platform override.

The unrelated pane shares the upload's client socket, so a blocked per-connection input chain cannot
pass as failure isolation. Both panes send the normal five-second lease heartbeat and acknowledge drawn
output; a terminal lease expiring must not mask the separate upload timeout. A Stop reply has a
ten-second deadline, a submitted turn's start five seconds and its end fifteen seconds. Fake-agent
creation is bounded at sixty seconds and binding at thirty, within the whole-case limit.

1. Send a complete four-chunk file window, immediately followed by same-pane Enter. Check the final
   artifact's bytes, exactly one file result and exactly one turn containing its path. Replay a completed
   chunk, then submit a distinct ordinary turn as a real ordering barrier; no second path may be typed.
2. Freeze the already connected edge process after begin, send a final file chunk and Cancel on the same
   client, and prove unrelated terminal input still completes while edge is frozen. Begin a fresh upload,
   resume edge and finish it. The cancelled result/progress/path must not reach the new generation; a
   subsequent ordinary turn supplies the final delivery barrier.
3. Kill edge after an accepted upload's first settled chunk. The next chunk fails visibly, another pane
   still completes input and Stop, and the same core remains alive. Await the supervisor's new edge PID
   and paste connection, then prove a fresh upload completes without reviving the incomplete one.
4. Freeze edge after an accepted upload's first settled chunk and leave its next chunk waiting through
   the existing 30-second result deadline. Other-pane input and Stop must complete while that exact edge
   process remains frozen. The upload reports a named failure. Resume that process and prove a fresh
   upload works, with no late completion from the expired operation. The fixture extends only the
   supervisor heartbeat deadline so it can witness the existing paste deadline; no paste timeout changes.
5. Hold paste's connection with the existing `HARNESSD_TEST_HOLD_CONNECT` gate. Begin refuses promptly
   with its named unavailable result; ordinary input and Stop remain usable. Remove the private gate,
   await connection and complete a fresh upload under the same core.
6. Fail paste's start with the existing `HARNESSD_TEST_FAULTS=paste` fault. Begin refuses visibly and
   ordinary input/Stop still work; no inline fallback or published artifact is allowed.

Each wait has a named deadline and follows an observed event, process state, reply or actual file result;
there are no settling sleeps. Begin keeps its client-side ten-second bound, chunk failure waits at most
35 seconds, process state/echo barriers five seconds, worker connection/recovery 30 seconds, and each
case has a 150-second whole-test limit. A captured process start identity is checked before signalling;
only fixture PIDs are inspected, never process environments or unrelated command lines. Teardown resumes
any still-owned stopped process, closes clients, awaits the existing daemon/reaper cleanup with a
45-second bound, verifies captured PIDs and the private root are gone, and retains failure evidence if
cleanup is uncertain. The outer root runner also owns a bounded TERM/KILL/reap deadline.

### Matched cost proposal

An ignored fixture uses the same current helpers with frozen main/candidate shipping artifacts, fixed
A/B/B/A order, pinned native Node and one worker. Source/tree/toolchain/bundle/helper hashes, standalone
copied Node bytes at start/end, process identities, private roots and cleanup are checked on every run.
No source patch, inspector, forced collection, hidden warmup or unchanged retry is allowed. Root may
separately admit one functional preflight per artifact before reserving the timed interval.

One workload consists of 256 KiB, 4 MiB and 20 MiB files, followed by ten simultaneous four-chunk uploads.
The latter use ten independent trusted client connections, because each connection intentionally admits
only four active uploads. They each own a separate controlled agent and pane. Each client preserves the
existing four-chunk acknowledgement window. A separate pane receives one ordinary input at each
acknowledged chunk boundary, recording real terminal output rather than awaiting a fake-engine turn.
The same bounded count, schedule and outstanding echo window apply to both artifacts. There are exactly
137 echoes: one, sixteen, eighty and forty across the four transfer phases. One echo is in flight and at
most ten wait, one per uploading pane; consuming an acknowledgement waits for its echo before refilling
that pane's four-chunk window. File-result latency is captured on arrival, independently of that echo
wait. All ten begins are accepted before their forty frames are sent. All expected file lengths/hashes, path
deliveries and final ordinary turns must match. A defined 30-second idle interval records both processes
after preparation has settled; it is a workload interval, not a readiness sleep.

Report core and edge CPU separately and together, sampled RSS for each, total/file latency, terminal-echo
latency samples and p95, chunk and acknowledgement counts, declared/observed outstanding bytes and
operations, refusal counts, unfinished `.part` counts and oldest outstanding age at observed boundaries.
Do not call client-visible outstanding work an internal queue measurement or sampled RSS a peak. The
actual end-to-end costs include the new event/header/body/RPC sequence; source/protocol tests establish
one event plus one result RPC per chunk. No per-RPC CPU or actual socket-header byte attribution is
claimed without a separately reviewed probe. Failed isolation/admission work is reported separately from
successful-paste latency; a timed artifact passing assertions does not accept its performance numbers.

The earlier design's image and 32-window stress cases remain distinct required evidence. Images cannot
be exercised natively here without a real clipboard side effect; existing caller tests cover their shared
generation/admission behavior. A bounded stopped-worker stress extension can use 32 independent clients
and four chunks each, with a 33rd begin refused and ordinary input still usable, but its instrumentation
and schedule need root review before execution. Neither this proposal nor file-only results close the
image-storage residual or prove a tenfold memory/latency margin by themselves.

Preparation checkpoint: the six checked-in native cases and ignored `.scratch/paste-cost` fixture are
written but unexecuted. The cost fixture submits file-path Enter and checks artifact hashes outside each
transfer/echo CPU window, then uses ordinary turns as delivery barriers before the defined idle interval.
The runner does not build, retry, profile, warm up or patch either artifact. It refuses changed/dirty source,
hashes both bundle directories plus the current helpers, toolchain and fixture at start/end, and requires
the copied Node bytes to match before/after and its folder to disappear at global teardown. A cost case
has a 240-second limit; the fixed ABBA runner stops at 1,050 seconds with TERM then KILL after ten seconds.
Root must review the source and choose a quiet interval before any execution; passing preparation is not
native, performance or Windows evidence.

### First integrated gates

The first clean-head full gates on `77bea31ba6`, against main `1ee076c588`, exposed four stale service
inventory assertions: the core's empty ports, the inline service exports, the edge service list, and the
master's published service names omitted paste. Core passed 4,628 tests with two failures; harnessd
passed 368 with two failures and one skipped. These failed runs do not establish coverage acceptance.
The 14 native terminal-contract tests, typecheck and shipping build passed on macOS Intel/Node 24.22.2.

The correction changes only those expected inventories and imports `startPaste` from the actual inline
module's source. An intermediate focused check caught a wrong test import; after correcting it, all
88 tests in the three affected specs passed (3.71 seconds). Runtime code and contracts are unchanged.
The original failed logs remain; full coverage gates still need to pass on this corrected checkpoint.

The corrected `2a7accfd1c` run passed all 4,630 core tests, 370 harnessd tests (one skipped), and
14 terminal-contract tests. Core coverage still failed: only `PASTE_OFF`'s four unavailable/no-op
functions were untested. Caller tests now check begin/chunk refusal and safe cancellation/stop, plus
the matching service fallbacks. All 43 API tests passed; that isolated API run's overall coverage is
incomplete because other core suites exercise its unrelated functions. The next full gate must prove
100% combined per-file coverage. No runtime code changed in either test correction.

## Completion Design: images and clipboard (2026-11-16)

This follow-up supersedes the file-only scope above only after its native prerequisite and caller REDs
pass review. The failed AppleScript `/dev/fd/3` proof and the earlier file-only CPU increase (about 37%)
remain evidence; neither is acceptance for this completion. Runtime at this checkpoint is unchanged.

Extend the existing paste worker, PastePort and paired header/binary protocol to both upload kinds.
Images keep their 8 MiB ceiling and files 20 MiB. Image chunk copies, whole-file assembly, writes,
retention and native clipboard tools leave the default core. There is no PNG decoder or conversion in
the current core: its existing raw PNG bytes must remain byte-identical. The only retained core work
is current stream/generation authorization, existing input admission/MoveGate ordering, independent
artifact identity proof and final terminal dispatch. Extract that small artifact proof from
`pasteDropFiles.ts`; remove that module and `osClipboard.ts` from the default import closure rather
than hiding their feature work behind another loaded helper. No new process, dependency, client frame,
setting or terminal-writing capability is added.

All published artifacts use the existing private `paste-drops/file-uploads` directory and its sole
worker writer. The existing 2 GiB/1,024-file quota includes new images. Legacy UUID PNG files remain in
place: a bounded worker inventory adopts recognized regular/private files for their existing 24-hour
expiry, within the same explicit quota; links, directories and unrecognized files are preserved.
Inventory across both locations stays within the existing 4,096-entry limit, uses sequential inspection,
and refuses admission visibly when it cannot establish a complete safe inventory. No migration or
path rewrite occurs. Older builds can still read published paths; automatic child-directory expiry
waits until this worker returns after rollback, as already recorded above.

Keep four 256 KiB chunks per upload, 128 global operations, 32 MiB chunk bodies, the 36 MiB paste-link
queue, 32 active preparations/four per trusted connection, the 30-second operation/inactivity deadline,
one-hour unfinished lifetime, 24-hour retention and the existing bounded expiry schedule. Publication
and clipboard lifecycle facts belong to worker records bounded by its 1,024-file ceiling. A cancelled
or timed-out operation retains native process/descriptor and storage reservations until actual settlement.
No old generation can publish progress, dispatch input, release a successor's clipboard ownership or
clear the successor's stream slot. Link loss refuses outstanding work; it never starts inline fallback.

Core proves the selected image artifact before asking for clipboard preparation inside the existing
final/held delivery callback. It repeats current generation and artifact checks on the reply and sends
Ctrl+V without an intervening await. A failed or unavailable clipboard uses the independently proven
path fallback. Same-pane Enter stays ordered after this operation, and unrelated panes remain usable.
Windows and WSL retain path fallback and start no clipboard subprocess.

Clipboard mutation needs a **worker-owned global reservation**, not merely separate pane lanes. Its
bounded waiters are admitted within the preparation limits above. A successful preparation holds that
reservation until core reports the existing terminal input promise's settlement; cancellation cannot
release it while its native operation still owns a child or descriptor. Release is generation-bound and
idempotent. Two-agent interleaving must prove that B cannot replace A's image between A's clipboard
reply and A's actual transport submission/settlement, and that cancelled A cannot unlock B. This proves
transport ordering, not that an external CLI has consumed the OS clipboard. Unknown/possibly-executed
terminal outcomes stay visible and are never retried. Lost replies, service replacement, actual helper
settlement and owner cleanup require explicit tests before implementation is accepted.

The macOS prerequisite uses built-in JXA `NSFileHandle` to read a verified inherited descriptor under a
private home after the original pathname has been replaced. It never opens the general clipboard. Only
after that succeeds, the same fixed PNG is written/read on a unique private named pasteboard as
`public.png` and compared byte for byte. No pathname reopen, PNG conversion or arbitrary script/command
from a component is accepted. `scripts/paste-native-image-proof.mjs` records these two separate proofs;
the earlier failed `paste-fd-proof.mjs` stays unchanged.

Linux must keep the real clipboard owner bounded and owned after wl-copy/xclip's launcher exits. Both
tools fork after claiming selection ownership; their serving child can retain inherited pipes. Treat
launcher exit as readiness, not complete process settlement. Reuse existing tied-process primitives
where possible; any generic lifetime change needs closure review and affected-user tests. The clipboard
helper has a five-second preparation deadline and 64 KiB diagnostic ceiling, emits static failure names,
and must survive tests for cancellation, replacement and worker death without orphaning an owner.
See the primary implementations of [wl-copy](https://github.com/bugaevc/wl-clipboard/blob/master/src/wl-copy.c)
and [xclip](https://github.com/astrand/xclip/blob/master/xclip.c). Native Linux proof is separate from mocks.

Before runtime edits, run the private descriptor prerequisite, then private pasteboard roundtrip, and
caller REDs for unavailable image begin, forwarding image chunks through PastePort, cancellation during
worker clipboard preparation, same-pane Enter/independent-pane responsiveness, held MoveGate timing,
and two-agent clipboard interleaving. Follow with worker geometry/duplicate/capacity/cleanup/native-owner
faults and actual private-wire transport checks. Root schedules full core/harnessd/architecture, native
failure-isolation and matched file/image performance checks. No owner home, account, daemon, terminal
server or general clipboard participates in these fixtures. This section records the proposed completion
and its selected proof gates; it does not claim implementation, native cross-platform or cost acceptance.

### Completion prerequisite and caller RED evidence

At runtime checkpoint `02779237b49f60a954ad33efe024dcc5064f5852`, pinned Node 24.22.2 on native macOS Intel:

- `node scripts/paste-native-image-proof.mjs` passed: the inherited descriptor returned the original
  fixed 68-byte PNG after its pathname was replaced. No clipboard access occurred.
- `node scripts/paste-native-image-proof.mjs --private-pasteboard` initially could not obtain a board
  in the sandbox (`[id nil]`). The first error reported the absent setter; a diagnostic clarified the
  unavailable native object. This is sandbox unavailability, not a PNG compatibility failure. The
  authorized native execution then passed: the unique private board's `public.png` value matched all
  original bytes. The fixture never accesses the general board and releases its private board.
- `node node_modules/vitest/vitest.mjs run src/lib/terminalStreamManager.spec.ts --maxWorkers=1
  -t 'image worker completion boundary' --reporter=dot` produced **three expected RED failures**
  (137 outside selection), 1.36 seconds. Image begin is accepted while the paste service is absent;
  the original image chunk never reaches PastePort; and agent B overwrites the mocked clipboard
  while A's terminal dispatch remains unsettled. These assertions exercise caller behavior and
  observed clipboard/input ordering, not an import-list or absent-method assertion.

Only this Design, the separate native proof fixture and caller tests changed. No runtime edits,
build, full gate, performance run, real clipboard access, merge or publication occurred in this window.

### Durable clipboard reservation review

The in-memory reservation alone is insufficient: after A's clipboard reply, its Ctrl+V may be queued
in the terminal transport while a replacement worker prepares B. Refusing to retry an unknown input
does not prevent B from replacing A's clipboard. Root approved a fail-closed external reservation;
the following lifecycle supersedes the earlier in-memory-only assumption.

The first proposed per-core namespace layout was rejected during independent review. Two workers
could both scan an empty root and create different namespaces, while a delayed release of fixed
`held` could unlink a successor. Both caller-visible ownership failures were reproduced in two
barrier-controlled REDs before the replacement design below (2 failures, 11 outside selection,
0.695 seconds, Node 24.22.2 on macOS).

Use one atomic `mkdir paste-drops/clipboard-reservations/held`, shared by every core incarnation
using this data directory. Its only child is an immutable filename containing the trusted core PID,
hashed native birth marker (or `unknown`) and existing generation UUID. The file contains no bytes.
Directories are private 0700 and the regular, single-link marker is 0600. Physical ancestry, owner,
mode and descriptor identity are verified. Native process probes stay entirely in the worker;
core injects its own PID through the existing port and gains no feature map, native probe or token
store. Only explicit ESRCH proves absence; unreadable identity or other probe errors stay live.

Before any native mutation, sync the marker, its held directory and containing directories, then
verify the captured directory identity and exactly one matching token with a bounded synchronous
fence. Inspect at most two children and make at most one recovery retry. A crashed empty directory
can be removed nonrecursively: a suspended creator must fail its captured-directory/sole-token
fence before it can touch the clipboard. A present token, including one not yet synced, blocks its
live or unknown core. Malformed, multiple, unsafe or unreadable state fails closed. There is no
expiry release; the existing proven-path fallback remains available.

Release unlinks only its immutable token name, then uses nonrecursive rmdir. ENOTEMPTY preserves
any successor. No read/check/await/unlink of a reusable filename is permitted. The terminal owner
creates a fresh randomUUID for every Begin, including repeated client upload IDs, and the worker
consumes each published image once; a successor therefore never reuses a live operation's token.
A stale release cannot name the successor even across worker replacement. Proven dead/replaced
core cleanup follows the same token-only removal. Unknown birth identity stays held until absence
is proven; it cannot be cleared merely because an identity probe later becomes readable.

Release validates an existing private reservation root; it never creates that root or repeats
its parent-directory publication flush. That flush belongs to claim, before native clipboard
mutation. Removing an existing exact token still verifies its ancestry and identity, preserves
any successor, flushes the reservation root after removal and waits for that flush to settle.
A missing root or marker has nothing to publish or remove. This removes one redundant full
disk flush per release without changing any pre-clipboard durability fence.

Cancellation during create/sync/removal remains charged until the OS operations settle, and the
current generation is checked again before native start. A cancelled native owner remains charged
until real process/descriptor settlement. An orderly worker stop or crash does not acknowledge
queued core input: a written image retains its durable marker until the current PastePort delivers
that generation's actual input settlement. Lost release remains unavailable until core restart.
This guarantees dispatch ordering, not consumption by an external CLI; unknown/possibly_executed
terminal outcomes remain visible and are never retried.

The implementation removes image payload assembly, filesystem writes and native clipboard helpers
from the default core closure. Core retains only its existing input lane and final artifact identity
proof; the existing paste worker owns image chunks, retention, native clipboard lifetime and this
bounded reservation. `lib/osClipboard.ts` and `lib/pasteDropFiles.ts` are removed; the smaller
`lib/pasteArtifact.ts` holds only the authority proof shared by worker and core. No generic spawn
helper, new dependency or core feature record was added.

Validation is still in progress. The three clipboard suites passed 65 cases before the final
additional directory-replacement guard test. They cover two-core claim admission, duplicate stale
release versus successor, suspended mkdir/open creators, in-flight fsync, live/unknown/PID-reused
owners, marker faults, real-settlement cancellation and lost-worker reservation. The actual macOS
helper then passed `e2e/pasteClipboardNative.e2e.ts` under authorized native execution: fd0 retained
the original private PNG after pathname replacement, a uniquely named pasteboard returned identical
bytes, and the helper exited/closed. The initial sandbox run could not access the native board and
failed; no general clipboard was accessed. Linux's test is present in the existing CLI E2E suite
and requires that suite's private Xvfb server and real xclip; native Linux execution is pending CI.
No new cost acceptance is claimed, and the original file-only CPU regression remains rejected evidence.

### Descriptor cleanup and native-proof correction (2026-11-17 Design)

Final review found that reporting a failed descriptor close did not retain its resource charge.
The terminal caller cleared the upload and released backend admission; validation failure inside
`openPreparedPaste` could also throw before returning the descriptor to either caller.

Keep uncertain cleanup within the existing admission, without adding another table or retrying a
possibly reused descriptor. The artifact helper reports a distinct, content-free close-uncertain
error when validation cleanup fails, and each proof's close is attempted at most once. Core marks
that existing pending upload as cleanup-unconfirmed and retains the admitted binary operation with
an unresolved settlement. Clear/Cancel/view teardown cannot release that charge; the shipping
backend's existing 128-upload/global byte limits continue to bound it across reconnects. Ordinary
terminal input remains independent. Further Begin on that view is visibly refused; restart is the
recovery for an uncertain OS close. The existing worker clipboard job applies the same rule when
artifact validation fails: a failed owner retains its existing job/lease until process termination.
No new persistent format, queue, timer, process, protocol, capacity or permission is added. The
change applies to shared macOS/Linux/Windows proof handling; Windows still launches no clipboard
child. Rollback changes no files or client contracts.

For the native fixture, a failed clipboard read is not process-exit evidence. Capture only exact
fixture-owned child/descendant PIDs with their native start identities; after Cancel or worker death,
verify those identities have actually disappeared. A timeout or unreadable identity fails the proof.
Use the private X server and named Mac pasteboard only. Teardown attempts owner cancellation,
worker/server termination, awaited exit/EOF, private board removal and root removal independently,
then reports every failure. It never skips later cleanup after an earlier rejection and never targets
an unverified PID. No process environment or owner's clipboard is read.

Selected checks: caller REDs for image/file close failure, validation cleanup failure, reconnect/global
admission and continued ordinary input; helper close-once coverage; worker failed-open settlement;
fixture teardown failure aggregation and process-identity semantics; affected focused tests and types;
then the private macOS native fixture. Linux execution stays pending the existing final CLI E2E run.
The 4,705-test full core gate and 294-case focused receipt preceding this correction remain scoped to
the earlier source. Full gates, combined performance and publication remain coordinator-owned.

Correction evidence: the original image/file caller and artifact tests failed five cases before the
fix, and the worker failed-open test failed separately. The expanded caller proof fills all 128
existing upload admissions with uncertain closes across view disconnect/reconnect, for image/file
and returned-proof/failed-validation cleanup; the next upload is refused while ordinary input still
works. The affected five-file suite passed 197 tests; TypeScript passed. Selected clipboard/native
service coverage passed 36 tests at 100% statements, branches, functions and lines in both files.
The corrected private macOS native fixture passed (1 passed, Linux 1 explicitly skipped), including
independently attempted pasteboard and root cleanup. Linux now checks captured native PID/start
identities, not clipboard-read failure, but native Linux execution remains pending the existing CI
suite. No full-gate or performance acceptance is inferred from these focused checks.

## Current integration Design (2026-11-19)

Integrate the reviewed delta `3bde211303..05bf43f451` onto current `68f03b4374` in a new isolated
worktree. Preserve current client-stream routing, input-source reporting, MoveGate sticky refusal,
worker admission and the lazy inline service host. The existing typed fake-engine fixture supersedes
the candidate's fixture change. Paste joins the existing edge process; regenerate the complete worker
plan literal and prove old/new host plans cannot mix. Keep current contract 6 until root combines the
concurrent contract 7 change. No dependency, public frame, storage format or general clipboard change.

Two source-reviewed integration gaps require actual failing tests before correction. First, a prepared
artifact must retain immutable native route facts with a fresh bounded verification at each final fence:
clipboard waiting may outlast the original three-second lookup budget. Current NativePaths.retain()
already offers that boundary. An unchanged real private file must remain valid after a fake-clock delay;
changed inode/content/ancestry and a verification exceeding its own budget must still fail. Capture the
retained route before opening a descriptor; keep current fd/path versions and close-once uncertainty.
Second, MoveGate refusal must settle the candidate's new retained input admission and report the
existing static refusal; a refused completed upload must also clear its current generation without
executing input. Neither Cancel nor disconnect releases uncertain or still-running physical work.

The exact preselected focused checks, conflict resolutions and historical receipt hashes are retained at
`/tmp/paste-completion-integration-review-20261119/plan.md` for this local integration. Root coordinates
full core/harnessd, terminal contract, architecture/lean and private native checks on the final combined
source. No native, build or timed run is approved at this checkpoint. Historical V4 remains descriptive
(two samples per side, 16 artifacts/186 chunks); it does not identify the remaining CPU cause or prove
performance of this integration. Native Windows and mobile are explicitly deferred by the user.

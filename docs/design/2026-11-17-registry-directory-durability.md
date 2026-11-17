# Registry directory durability

The session Registry remains the authority in the core. Its asynchronous writer still performed the final directory
`fsync` synchronously after rename. The fixed 17 November attribution workload measured about 18.56 ms in that call
per changed 160-row save. This change moves only that directory flush off the event loop. It does not change the
Registry format, startup migration, observation policy or the lock protocol.

## Design

1. **Growth.** One active writer and at most 64 waiting requests remain. A publication owns at most one extra pinned
   directory descriptor. The existing unconfirmed ownership-group record is prepared before rename and installed
   immediately after it; successful admission or existing recovery replaces/removes it. It is an immutable copy of
   existing rows, not a second store. Registry rows and image bytes remain uncapped, as before; this
   change does not truncate customer data or claim to solve the measured 1,600-row startup cost.
2. **Concurrency.** The one writer holds the same `registry.json.lock` directory and owner token through actual OS
   settlement. Rename, recovery installation and the published phase run without yielding. A post-rename timeout
   rejects the caller as non-retryable uncertainty while the writer and lock remain occupied. After asynchronous
   directory flush, fresh native evidence, owner/token checks and a fresh live rebase precede admission. A request
   that expired or was observed revoked cannot become successful later.
3. **Read cost.** The existing complete image merge remains; no polling or second background writer is added. Only
   the active publication gains a pinned descriptor identity check and a second admission check/rebase. Deep-copy
   preparation and that second check count in before/after CPU, memory and whole-operation loop-hold measurements.
4. **Scale.** Queue capacity and original five-second request budget stay fixed; lock acquisition stays within two
   seconds. At 10x rows the existing whole-image costs still grow and remain a separate residual. Existing fixed,
   content-free slow-persistence phase warnings and the before/after workload expose those costs.
5. **Compatibility.** `registry.json`, `agent-names.json`, lock directory and owner fields are unchanged. Current and
   older standalone hook/status writers use the same lock and read the same rows. `AtomicWriteUnconfirmed` keeps
   its existing public error handling; its internal retryability prevents this call's recovery from reviving expired
   authority. No public client, backend or service contract changes.
6. **Migration and rollback.** No data migration or deployment order is required. An old build reads every image
   this build writes. A crash after rename can leave the old or new durable image, as before; neither a timed-out
   callback nor a crash proves rollback. Recovery keeps the complete displaced ownership group and preserves peer
   changes. Existing startup/native validation remains authoritative.
7. **Audience.** No additional reader or external copy exists. The directory and descriptor must remain private,
   owned by the current OS user, and the same inode before publication and after the asynchronous wait. Errors and
   measurements use fixed categories without row content, paths or tokens.
8. **Identity.** Native process, transcript, route and operation authority remain in the core's existing admission
   guards. No service gains a credential or permission to publish session state. Ordinary observations may advance
   during the wait, and successful admission rebases them without changing existing live-reference semantics.
9. **Failure.** Before rename, failure is unavailable persistence. After rename, failure is uncertain publication;
   live admission, terminal release, ready frames, first-task delivery and final retirement wait for its receipt.
   Existing transient I/O recovery gets at most its original second attempt and never a new deadline. An uncertain
   pending Create/Resume propagates the error rather than converting it into a refusal that destroys/retries a pane.
   The directory closes synchronously in the final fence. If close throws, the writer is terminally sealed, reports a
   fixed restart-required failure, retains its lock/settlement until process exit and never closes that numeric fd
   again. Waiting callers expire on their own existing deadlines. Exiting flush cannot claim a clean handoff.
10. **Platforms.** macOS and Linux use the asynchronous directory flush and final synchronous close. Windows keeps
    its existing file-sync/rename path because directory flush is unsupported there; there is no new await between
    rename and admission on Windows. Native evidence from one platform is not evidence for another.

## Validation

Tests pause the real post-rename directory callback, then check disk publication, old live ownership, event-loop
progress, cancellation and deadline classification, stale native evidence, later observations/deletions, names,
Create/Resume callers and exiting flush. Existing crash and legacy-writer cases remain. A separate process injects
an uncertain directory close so OS termination, rather than a test's reused fd, proves its lifetime ended.

The focused Registry/caller suite and typecheck precede the required local coverage and platform gates. The fixed
before/after workload includes the synchronous tail, caller latency, CPU, RSS and owned-process cleanup. Neither
instrumented phase timing nor successful unit tests alone clear the performance or platform gate.

# Reserve checkpoints with their confirmed writer

Status: source approved; helper and production performance validation pending. Design was approved with three binding amendments before implementation. Review receipt `20261120T102300.608265Z-63407`; its initial HOLD is retained separately. Existing production Close/Resume and helper holds remain.

Close creates two durable database exports. Each currently persists an owner without a writer, then persists its attested writer, then persists settlement and destination. Observe and attest the same worker lifetime first, and create the first durable owner with that writer. The export request still waits for complete owner and slot flushes. This removes one owner write and full flush per export; both exports, history verification/sync, destination pin and manifest publication remain. V9 counts nominate these owner transitions; no main-thread CPU attribution is claimed.

## Design

- Growth: the same four slots, byte limits, one deadline, bounded buffers and lease generations. No new persistent record, process, timer, package or core-loaded file.
- Concurrency: the storage export admission owns lifetime attestation and one allocation callback. The store consumes its one-shot gate synchronously; inactive and duplicate calls cannot alter first-call state. Slot mkdir, cleanup lock and generation checks remain.
- Read cost: the same lifetime/read/attestation requests. Initial owner creation includes its confirmed pid; the separate writer update is removed. All source, record, slot and publication fences remain.
- Scale: the same four-operation cap and bounded private files; no list or fan-out grows. A busy slot is discovered after the bounded lifetime request, so a repeated held Close pays that request cost.
- Compatibility: no worker IPC, stored-owner version, client or backend change. Recovery still accepts old null-writer owners. Old readers understand the new initial record as the previous post-writer state.
- Migration and rollback: none; old and new owners use version two. A crash or failed initial flush can conservatively retain an unexposed record while its writer lives. Full Harness stop cycles the services and core (`harnessd/master.ts` stopAll), so the existing restart remedy still applies.
- Audience and identity: unchanged private account-owned checkpoint state; the same master-attested service pid and lifetime. The core exposes no path until a successful, one-shot handoff.
- Failure: preserve first allocation failures and named holds. Consume the one-shot before preflight; only that first active call records started/finished/failure. Inactive/duplicate calls do not overwrite it. A rejected export while the first allocation is started and unfinished, without a recorded failure, is a stage timeout regardless of a fractional clock comparison. Otherwise preserve the existing export-failure mapping.
- Platforms: shared TypeScript on macOS/Linux/Windows; Windows owner containment/descriptor-close rules remain. Native Windows validation is user-deferred.

## Custody and ordering

The store owns an absolute deadline from the original stage-creation point. Its gate checks activity, deadline and current source/session proof before disk work. CheckpointStages independently checks pid and deadline before create. Acquire returns a core-only stage with verify/publish/close and handoff; it exposes no worker path or settlement method directly. Handoff checks current, marks the lease exposed synchronously and returns the path/key, deadline and settlement method. No await separates store ownership assignment, current check and handoff.

If create completes while the store is active, the gate assigns the stage and current() handles an expired deadline; store finally closes it unexposed. If the store already finished, the gate closes the unexposed candidate itself. The stage manager drains its own timed-out create. These ownership choices are synchronous and mutually exclusive. Unexposed close removes the lease through existing generation-checked cleanup even though its stored writer is non-null. Exposed, unsettled work retains its slot. Once handed off, a refused export may conservatively retain the lease just as the old writer-update/current-check sequence did.

## Validation selected before implementation

Write caller controls first: first owner contains the attested pid; no lease/export before actual owner and slot flushes; one-shot allocation/handoff; exposed unsettled work retained; late unexposed work actually removed; no disk work for inactive/expired/invalid-pid/duplicate admission; original exact busy/timeout/session-changed/source-error mapping; an outer timer winning while the clock is just below deadline; duplicate gate calls cannot contaminate a later generic export error. Recover old null-writer records and retain failed initial records with a live pid. Port every existing writer fault to initial creation or settlement, preserving owner/slot/link/flush/close and four-slot controls.

Run affected storage, checkpoint, Close/Stop, recovery and type checks. Run the mandatory core coverage and packaged private-daemon Close/Resume checks on the final integrated source before release. Independently review resulting code. Then compare the same full stage workload (acquire through actual cleanup): owner flushes must fall from three to two, elapsed must improve at least 5% in each order, and CPU/main must not show repeatable regression. Production Close wall must move lower against the immediate parent; the same original baseline remains required for overall acceptance. If the actual production workload does not improve, do not retain this as a performance optimization. No successful history export, flush or safety test may be omitted.

## Source and fault evidence

The new stage/storage controls failed 13 of 15 cases against the previous implementation, and the store controls failed seven of nine; all 24 passed after implementation (`20261120T103327.996343Z-72584`, `20261120T104037.391392Z-79103`, `20261120T104126.721261Z-79881`). Earlier fixture-only hangs are retained in their separate receipts.

Existing writer-update faults now exercise initial owner creation or the remaining settlement update; duplicate writer/settlement cases collapse to the surviving update. Initial owner and slot flush tests assert the attested pid while acquisition is unresolved. Four timed-out initial allocations retain their actual descriptors until the callbacks finish, then free every unexposed slot. Both legacy owner versions with null writer still recover. A live exposed writer remains reserved on failed export; the old SQLite fixture omitted writer assignment, so its deletion expectation was corrected to assert the retained owner and no published history.

The full affected matrix passed 341 tests across 18 files (`20261120T105243.508736Z-89747`). The same receipt has storage coverage at 100% statements, branches, functions and lines. TypeScript passed in `20261120T105044.493031Z-87924`; that receipt also retains the earlier fixture expectation failure. Independent source review approved the implementation (`20261120T105243.261359Z-89736`). Production wiring directly passes `engineStorage.exportDatabase` to the store in `core/main.ts`; there is no old-argument adapter.

Initial allocation failures use the existing disk/source/session refusal mapping; later export failures remain read failures. Initial owner failures formerly inside the separate writer update can therefore use the disk-failure wording. A handoff followed by a storage timeout may retain an undispatched lease, as the previous writer-then-check path did. A dependency that swallows a failed allocation is outside the production storage contract; no successful publication can bypass settlement. Source review added a direct empty-slot assertion after the existing real-disk held-acquisition and held-close tests drain.

Full core coverage, packaged private-daemon Close/Resume and production cost still need validation on the final integrated source. Native Windows testing remains deferred by the user. No earlier performance hold is cleared by this source approval.

# Checkpoint allocation flushes

## Design

A checkpoint lease is handed to a worker only after its initial owner record and both containing directory names are durable. Creating an allocation currently flushes the pool synchronously, then flushes the owner and slot serially. The current-source V14 observer records two allocations per Close. A separate fixed ABBA primitive probe found initial-allocation wall time 7.63% and 7.00% lower with three concurrent flushes; same-side spread 6.01%. CPU and main-thread CPU were inconclusive. This is a nomination, not production acceptance.

After creating the slot, history file and complete initial owner, start the owner flush and asynchronous flushes of the slot and pool together. Await every actual completion with allSettled even when one fails. Retain all handles until their operations finish. Verify owner bytes/version and original slot and pool identities after that barrier. Expose no lease on any failure or timeout. Existing late-create custody closes any eventual unexposed allocation after a bounded caller response. Later owner updates, data verification, settlement, publication and cleanup remain sequential as before.

- Growth: the same four fixed slots and 1 GiB per stage. No new files or retained generations. At most two additional directory descriptors per initial allocation; all are closed after actual I/O, including errors.
- Concurrency: the existing exclusive slot mkdir and lease remain the authority. Exactly three flushes per initial allocation, never an unbounded queue. No worker sees the path before all three complete.
- Read cost: only the selected allocation; fresh parent/slot identities and owner version after the final await. No successful-proof cache.
- Scale: four allocations permit at most twelve initial flushes; existing busy and cleanup failures remain the first signals. Compare complete allocation/publication/cleanup CPU and latency at the existing bound.
- Compatibility: no protocol, owner version, names, manifests or history format change. Existing v1/v2 recovery readers see the same records. Both clients and backend are unaffected.
- Migration and rollback: no data migration. Either source can recover the other's completed or interrupted initial allocations using the existing rules. A crash before handoff can leave a reserved unexposed slot, as it can today; no writer or publication depends on an unfinished barrier.
- Audience: private same-account state only; existing owner/type/link/permission and directory checks remain required.
- Identity: core selects the slot and destination; the same exact writer PID and lease are saved. No account substitution.
- Failure: all callbacks settle before descriptor cleanup or final error. The caller deadline still returns a named CHECKPOINT_STAGE_TIMEOUT while raw work retains custody. No publication on failed or partial flushes. The original owner, slot and pool are rechecked after concurrent work.
- Platforms: shared TypeScript on macOS/Linux/Windows. Directory flushes remain disabled where unsupported; native Windows validation is deferred by the user. No process launch changes.

## Validation selected before implementation

Caller tests first: all three flushes start before any callback completes; no early lease/handoff; the main loop stays available; every callback is retained after a failure or deadline; owner/slot/pool replacement at pending and final callbacks refuses admission; late completion closes all descriptors and releases only a proven unexposed slot. Run existing checkpoint stage, generation, recovery, ownership, reservation, durability, storage and session-checkpoint tests plus typecheck. Review the implementation independently, then run a fixed complete-lifecycle ABBA comparison and the original-baseline Close/Resume workload. No numerical acceptance is inferred from primitive counts or source size.

## Implementation evidence

Independent design review approved the experiment with conditions; it did not approve release. The implementation opens and proves both directories before starting any flush, keeps the existing state-file custody gate, awaits all actual callbacks in owner/slot/pool order for failure selection, closes both directory descriptors even if one close fails, and performs fresh pool, slot, owner and history-name checks before admission. Windows retains a single owner-file flush without directory operations.

Eight new caller tests failed on the serial source. The selected 11-file run subsequently passed all 204 assertions and typecheck but was correctly marked failed for two unobserved rejection promises in the added test helper. After fixing that helper and targeting the pool-open injection after owner creation, the affected 15 cases passed with no unhandled errors. The unchanged 189 other assertions and typecheck remain applicable. The existing initial-owner-replacement test now requires all allocation flushes to complete while still refusing the lease and preserving the replacement bytes.

Performance remains open: a fixed complete-lifecycle comparison must show a clear wall or event-loop improvement without a regression under four simultaneous allocations. Otherwise this experiment is withdrawn. The original-baseline daemon Close/Resume holds also remain open.

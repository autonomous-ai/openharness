# Fresh SQLite checkpoint reads

A cached immutable SQLite handle can return old conversation rows after an engine updates its store at the same size within the filesystem timestamp granule. Close must read the current store for both existing checkpoint phases.

The isolated storage worker drops only its selected store's native handle before export. In the older inline composition, each checkpoint statement requests a fresh read: it bypasses any earlier coalesced query and opens/closes its selected handle. Schema, page and singleton reads all carry that requirement. Ordinary polling keeps its cache and coalescing.

## Design

- Growth: no new persistent data, process, dependency, cache or admission map. Existing two read threads, 64 queued statements, page limits, one-GiB export cap and four checkpoint operations remain.
- Concurrency: native reads are synchronous on their owning thread. Fresh statements never join an earlier read; each uses the existing bounded queue. Source, stage, cancellation and publication proofs are unchanged.
- Read cost: isolated export reopens one selected connection. Inline compatibility reopens per statement. No whole-store scan or history-sized buffer is added. A timed-out fresh inline statement may remain active until SQLite finishes; retries can occupy both threads but remain bounded.
- Scale: existing statement and 30-second export deadlines remain. Measure Close CPU/wall cost and inline slow-statement contention. No increased timeout or relaxed acceptance threshold.
- Compatibility: checkpoint bytes and manifests, private export wire messages, clients and backend are unchanged. Already-published old worker binaries need an update to receive this fix.
- Migration and rollback: no data migration. Reverting restores the stale-read defect.
- Audience and identity: same local account and core-selected database path. No SQL comes from callers. Other stores' cached handles are untouched; another session in the same store may pay a reopen.
- Failure: existing unavailable/timeout and native-authority errors remain. A failed fresh statement supplies no rows. Existing stage ownership and cleanup remain.
- Platforms: shared TypeScript for macOS/Linux/Windows; no process-launch change. Real macOS SQLite and thread tests run locally; Linux CI remains required and native Windows is user-deferred.

## Evidence and scope

Real-SQLite regressions reproduced old exported rows (`144118.655465Z-91881`) and stale fresh-statement/coalescing behavior (`144212.293139Z-92635`). The correction passed 204 affected tests and types (`144352.155712Z-93985`) and independent source review (`144548.365723Z-96005`). The reduced final change is validated separately.

An exact-content comparison optimization was tested and removed. The production Close fixture, like Hermes, records `ended_at` and `end_reason` on exit, so its final export must differ. Adding comparison requests, capability checks and reuse proofs did not address that measured path. The V33 original-baseline diagnostic remains held: core CPU is 15–16% higher and Close wall time about 30% higher. This correctness fix does not claim those performance or extraction holds are resolved.

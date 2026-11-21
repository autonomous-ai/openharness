# Clipboard claim contention

## Design

The combined core gate exposed a race between two claims through the same clipboard worker.
The second claim can recover the first claim's still-empty directory while the first is publishing
its token. The durable cross-process fence refuses the collision, but an ordinary competing request
should return busy without disturbing the worker's own in-flight publication.

Keep one boolean per reservation owner while claim preparation is pending. A competing claim returns
the existing null/busy result. Clear the boolean only when preparation and any failed-claim cleanup
actually settle. There is no queue, retry, timer or core state. Independent worker instances still use
the existing exclusive directory, process-birth identity, durable token and final sole-token fence.

Growth and scale are constant: one boolean per existing worker owner. Concurrency is per reservation
owner; cross-process authority stays on disk. Read cost adds no filesystem operation and avoids the
competing preparation. Storage, migration, rollback, audience and identity are unchanged; no new data
is stored, exposed or synchronized. Public compatibility retains the existing busy result. Filesystem
failures keep their named error and do not strand the local slot. macOS runs the actual filesystem
tests; shared Linux code uses the same protocol. Native Windows remains deferred by the owner.

## Validation

Before changing runtime code, suspend the actual root/held directory creation and attempt another
claim through the same owner. Both cases must return busy while the first remains valid, then permit
a successor after release. Existing cross-worker crash-prefix, PID-reuse, stale-release, fsync and
unsafe-path tests remain. Check recovery after a failed root or held-directory mkdir. Run the whole
reservation suite with per-file coverage, its Paste callers and types; then the combined core gate.

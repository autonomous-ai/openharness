# Checkpoint cleanup flush

Close currently blocks its core thread while flushing the staging pool directory
after removing each completed slot. The repeated V15 diagnostic found about 19 ms
per invocation in both runs. These perturbed durations nominate the path only;
they do not establish baseline cost or savings.

## Design

Run the final pool-directory flush asynchronously, but keep close/save awaiting
its actual callback and descriptor close. Open and prove that directory descriptor
before removing any name. The manager holds the slot index until actual settlement,
including after the directory name disappears. Admission waits for any locally
pending cleanup within the caller's original deadline, rechecks custody/deadline,
and retries. It reports BUSY only when all occupied slots belong to other work.

- Growth: four slot indices and at most four pending cleanup flushes per manager;
  production has one manager. The existing 1 GiB per slot remains unchanged.
- Concurrency: exclusive mkdir remains the cross-process lock. The pending map
  covers only the local interval after rmdir and before callback/FD close. A
  failed close retains the slot and the existing global custody refusal.
- Read cost: constant directory/FD proof per completed slot; no scans or polling.
- Scale: four slots are the admission bound; named busy, timeout and cleanup
  failures identify capacity or disk faults. Measure unrelated reads under load.
- Compatibility: owner v1/v2, names, data, manifest and recovery remain unchanged.
  Recovery and failed-allocation cleanup retain their existing synchronous flush.
- Migration and rollback: no migration; revert the flush implementation.
- Audience: private core state only, with unchanged local/account enforcement.
- Identity: the preopened directory must match the allocation's pool key; existing
  slot/owner/file generation checks still precede every destructive step.
- Failure: await actual callback; close the FD before releasing accounting. A
  failed flush logs cleanup refusal, an uncertain close keeps custody poisoned.
  A timed-out caller never releases a raw operation or slot early.
- Platforms: shared TypeScript affects macOS/Linux/Windows; Windows has no directory
  flush and retains synchronous cleanup. Native Windows is explicitly deferred.

No response is returned early and shutdown is unchanged in this first stage.
Post-commit background cleanup needs separate caller evidence and lifecycle work.
The independent design review is APPROVE_DESIGN_WITH_CONDITIONS, receipt
20261120T203715.753126Z-9294. Keep every actual disk flush and all pre/post checkpoint
saves. The original performance and final release holds remain open.

Validation: red caller tests hold actual cleanup callbacks, prove close remains
pending and the loop remains available, and exercise four slots/two waiters, late
callbacks, callback errors and uncertain close. Run existing checkpoint callers
and types. A fixed before/after caller workload must show improved loop/read
latency without a complete-cycle cost regression before keeping this change.

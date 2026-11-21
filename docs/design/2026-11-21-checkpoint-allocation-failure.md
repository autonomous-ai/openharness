# Failed checkpoint allocation

A failure after creating a fixed staging slot but before handing it to a worker
currently leaves an empty or partial slot. Recovery deliberately retains missing
or incomplete owner records, so four transient disk failures can permanently
prevent saving history.

## Design

The creating call removes only its own unexposed allocation after all actual disk
operations and descriptor closes settle. It proves the slot and each created file
again before deleting anything, never recursively deletes a directory, preserves
foreign replacements, and retains the original allocation error. Failed cleanup
keeps the existing STAGE_CLEANUP_UNAVAILABLE diagnostic. Exposed leases and crash
recovery do not change. A failed descriptor close prevents deletion.

- Growth: the existing four slots and 1 GiB per slot remain; failed unexposed
  allocations are reclaimed immediately where identity can still be proved.
- Concurrency: exclusive slot mkdir and exclusive file creation remain the locks.
  Cleanup proves the entire set before mutation and rechecks each name at unlink.
- Read cost: extra checks run only on failed allocation, not successful saves.
- Scale: no scan or fan-out beyond the two fixed files in one slot. Busy allocation
  and retained-cleanup errors remain the first capacity warnings.
- Compatibility: owner version 2, names, worker protocol and manifests are unchanged.
  Old readers and rollback see exactly the same successful allocations.
- Migration and rollback: none; revert the failure cleanup without a data migration.
- Audience: private local state only; no new network or client surface.
- Identity: the core's exclusively created files, never a worker or another account.
- Failure: await actual work, preserve original error, log refused cleanup; do not
  delete a replacement, an unproved file, or a slot handed to a worker.
- Platforms: portable filesystem path affects macOS, Linux and Windows. Run the
  fault suite on macOS; native Windows remains explicitly deferred by the user.

Validation: first demonstrate repeated open/stat/owner-write/flush failures exhaust
slots, then prove they leave capacity available. Preserve replacement and delayed
callback cases and run all checkpoint/resume callers plus typecheck. This corrects
a failure path; it claims no improvement to successful Close/Resume latency.

# Integrating the atomic state writer with core extraction

Main `8d5b451c3d` adds the atomic state reader/writer and Change agent while the
extraction is at `b93fceea72`. Integrate both: optional launch rendering and
database history remain in components; Registry and stopped-record preparation
remain in the owned storage process. Main's atomic writer replaces the remaining
ordinary state writes, preserving the extraction's physical descriptor custody.

## Design

- Growth: no new product state. Existing file limits, journals, queues and cleanup
  limits remain. A temporary lock is built once per acquisition and removed only
  after its actual handle has closed.
- Concurrency: retain Registry's lock, fresh authority checks and pre/post-durability
  rebases. Publish its complete lock owner atomically, as main now does. Failed
  descriptor cleanup continues to refuse later storage work; it cannot release
  an operation's ownership early.
- Read cost: no history or optional feature implementation returns to core. State
  reading and writing use main's common helper at the process that owns the file.
- Scale: preserve bounded storage work and deadlines. Compare the integrated
  build against this exact new main; earlier measurements retain their old source
  scope and cannot establish the cost of this merge.
- Compatibility: existing file names, schemas, modes and old-reader contracts stay
  readable. Use one `AtomicWriteUnconfirmed` identity with the existing retryable
  classification needed by the extraction's publication recovery.
- Migration and rollback: no new migration. Preserve exclusive legacy backup,
  boot-marker ordering and the complete worker cohort. Rollback reads the same
  Registry, stopped records and Cloud journal.
- Audience: no new endpoint or data exposure. Failures retain content-free names.
- Identity: existing OS owner, native process, file and service-link checks remain.
- Failure: Cloud's file now also contains the publication journal. An unreadable
  journal must retain its original bytes and refuse publication, rather than
  starting an empty catalogue. Its writer uses the common durable atomic helper.
  Disposable caches retain main's quarantine behavior.
- Platforms: shared TypeScript affects macOS, Linux and Windows. Run Mac caller,
  coverage and packaged checks and Linux CI; native Windows remains deferred by
  the user's instruction. Mobile changes arriving from main are outside this task.

Validation: resolve the contracts first; run types and conflict-affected callers,
including atomic state, physical cleanup, Registry crash/lock ownership, Cloud
recovery, installed-index locking, deferred launch and component boundaries. Then
run the required exact-commit local gates and newly affected native checks. The
earlier `b93` native workflow and incomplete performance packet remain evidence
for that source only. Neither is described as validation of this integration.

## Integration evidence

Seven custody cases failed before the shared writer and complete-owner lock used the retained-close helpers (`20261119T113054.592328Z-2105`). The 14 custody checks then passed; the first green receipt retained its sandbox process-inspection refusal. The final authorized caller run confirms cleanup as well. Two further REDs reproduce an unlocked installed-index setup read and an unflushed installer dispatch (`20261119T113351.049309Z-5293`).

The corrected combined caller run passes 339 tests, with three platform skips, across 16 files and passes TypeScript (`20261119T113624.522647Z-7986`). Native-file test observations now use resolved paths and distinguish the mocked separate installer's effects from the parent's writes. Main's old hook writers remain extracted; their atomic publication checks exercise the guarded native-file publisher.

Registry crash/disk-failure callers, launch and Resume authority, checkpoint and archive writes, native-hook goldens, master supervision, lean entry and architecture pass 1,158 tests, with one existing skip, across 21 files (`20261119T114354.324845Z-19963`). The earlier 360-second batch timeout remains recorded (`20261119T113711.272655Z-8965`); the completed run used per-test reporting and four workers and took 396 seconds.

This completes source integration of main, not release acceptance. Native workflow 44513089598 on the previous b93 source found both stale fixtures and runtime failures, including disk exhaustion being mistaken for an invalid worker build. Its failed logs are retained and the affected cases require correction and validation. Performance holds and final required gates remain open.

Shutdown review follow-up: a shared state helper can throw after losing proof that a descriptor closed. The process-wide custody guard already prevents future opens, but the registry writer must also retain its drain and shutdown promise. Check the same custody guard when a write escapes with an error, preserving the original publication/admission result while preventing queued work or final flush from running. This adds no state format, reader, network, or new process; the existing finite daemon stop deadline remains the only exit. Cover actual failed closes before publication, after publication, and after admission, including callers that wrap the failure.

Follow-up evidence: `20261119T120116.181481Z-42273` reproduces three queued-write violations after actual failed closes. `20261119T120159.895376Z-42933` passes 191 registry/custody tests, both native registry shutdown callers and TypeScript, with actual exit and cleanup verified. The native wrappers now record their actual source entry before calling the core directly; this corrects the missing-entry failures in workflow 44513089598 without weakening production admission.

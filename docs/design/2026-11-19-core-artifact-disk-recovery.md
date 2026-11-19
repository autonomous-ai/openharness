# Worker preparation when the disk is full

Design before code. Native run 44513089598 on b93fceea72 found that a full disk while publishing an immutable worker image was reported as an unsupported build. The supervisor then rejected an otherwise valid update.

Keep the immutable payload and positive cohort admission. Preserve a fixed, content-free storage-unavailable result for ENOSPC, EDQUOT and EROFS only after candidate cleanup is confirmed. Carry that result through the owned preparer and re-execution decision. No child starts, and no update is rejected or confirmed; retry with the supervisor's bounded backoff. Uncertain cleanup still retains ownership and refuses another preparation. A real invalid build retains its rollback behavior.

- Growth: no new files or state; existing bounded artifact and claim retention remains.
- Concurrency: the existing one-preparation owner and physical child-close fence remain.
- Read cost: only the existing selected payload and its candidate are examined.
- Scale: retry delay is bounded by the existing supervisor maximum; no extra polling or workers.
- Compatibility: public client and stored-data contracts are unchanged. The new fixed result is private to the same admitted release's embedded preparer and master.
- Migration and rollback: none; previous builds still read the same files and claims.
- Audience and identity: existing owner-only directories, parent PID and selected-code checks remain authoritative.
- Failure: fixed storage-unavailable log and supervisor status; preserve pending probation while no child exists.
- Platforms: shared macOS/Linux/Windows TypeScript; Mac caller tests and native full-disk validation, Linux CI. Native Windows remains deferred by the user.

Validation: fail first at artifact publication, preparer serialization, re-execution and supervisor recovery. Verify real invalid/uncertain cases remain refused, retry stops on shutdown, and no child is admitted before storage recovers. Retain the original full-disk failures; do not increase timeout or weaken cohort admission to pass them.

Evidence (2026-11-19, isolated macOS worktree based on b93fceea72):

- RED: `20261119T114929.858326Z-29748`, seven failures across publication, serialization, re-execution and pending-update recovery.
- Target GREEN: `20261119T115031.956789Z-30859`, seven passed.
- Caller GREEN: `20261119T115716.709537Z-37767`, 240 passed across five files and TypeScript passed; real admitted children recovered after storage became available.
- Required supervisor gate: `20261119T115804.906879Z-38685`, 621 passed, one platform skip, all four coverage measures 100% per file. Every successful receipt includes actual exit and verified cleanup.
- Native workflow 44513089598 remains a recorded failing baseline; the packaged full-disk acceptance must run on the integrated final build. This change does not provide final native or performance acceptance for the whole extraction.

Native fixture correction and measured recovery:

- The diagnostic `20261119T122057.963737Z-79594` retained allocated-file and free-block measurements outside the disposable volume. Before the last candidate it had 22.84 MiB free for a 27.35 MiB worker image: the budget omitted a separate 13.75 MiB master image for each fixture release. The volume now budgets both measured images per release and current/backup/canary files. Deliberate exhaustion still uses real write refusal.
- `20261119T122559.236442Z-1034`: all four hostile full-disk scenarios and TypeScript passed in 134.4 seconds, with verified cleanup. Both ordinary disk-full cases had already passed in `20261119T121008.281204Z-60367` (that overall receipt failed on the last update case).
- The crashing candidate now proves it is running before the fixture fills the volume and releases its external crash gate. This distinguishes an invalid running build from a valid build whose immutable payload cannot yet be prepared.

Final integrated handover correction (Design before code): `20261119T131053.374053Z-95355` passed the two ordinary disk-full cases, all eight Wi-Fi cases and both selected device cases. Four update cases failed on the same leftover canary. Its PID identifies an updater restarted from the old immutable cohort after staging, before the master re-executed. It downloaded the already-staged build and was stopped during its canary.

The old updater must wait while a different version's pending marker matches the actual installed bytes. The replacement updater, whose version matches that marker, can still supersede a build on probation. A rollback changes the installed bytes and releases the wait. Recheck under the existing stage lock before writing, in case another updater staged during the download.

- Growth/migration/rollback: no new persisted state, cleanup scan, or wire field. Existing pending marker and original backup stay unchanged.
- Concurrency: the existing install lock still protects staging; a pending marker alone is insufficient without its matching installed digest.
- Read cost/scale: one small marker read at an update check; hash the installed bundle only when that marker names a different version. No added work in the core, no new timer, no additional process.
- Audience/identity: the updater reads its configured owner-only install as before.
- Failure/platforms: one waiting log per staged version; shared code with Mac native update coverage and Linux CI. Native Windows remains deferred.
- Validation: original native failure retained. Regression tests first prove the old updater downloads nothing and preserves the original backup, rollback resumes checks, and the current staged updater can accept a newer version.

Handover evidence: `20261119T132348.105506Z-23017` fails both old-cohort cases; its third failure was a test setup missing the prior notify file, corrected before the green run. `20261119T132656.633442Z-33307` independently fails the under-lock race without its final check. `20261119T132500.029494Z-26134` passes 119 caller tests and TypeScript. With the added lock case, `20261119T132748.076321Z-34206` passes all 120 caller tests and all 16 packaged native update scenarios, including the four disk-full cases, in 369.2 seconds with verified cleanup. No assertion, disk-fill condition, probation or process-custody requirement was removed.

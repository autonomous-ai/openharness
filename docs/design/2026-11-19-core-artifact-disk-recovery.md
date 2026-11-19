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

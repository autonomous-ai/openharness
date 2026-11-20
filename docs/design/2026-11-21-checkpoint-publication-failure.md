# Keep a checkpoint after unconfirmed manifest publication

A manifest rename can succeed before its parent directory flush fails. The atomic
writer reports `AtomicWriteUnconfirmed` in that case. Checkpoint cleanup currently
leaves its success flag false and deletes a terminal or transcript's new history,
although the visible manifest already names that file. The database stage's
existing manifest-aware cleanup does not make this deletion.

## Design

Only the manifest write's `AtomicWriteUnconfirmed` marks the new history as
published for cleanup. The save still fails, preserving the original error and
stopping Close. Both the previous history and the newly referenced history remain;
cleanup never makes a visible manifest point to a file it just deleted. Failures
before manifest publication, including an unconfirmed screen write, keep their
existing cleanup. The store latches unconfirmed directory publication. Before any later save creates
files or reuses a visible transcript checkpoint, it confirms that directory flush;
a failed retry leaves the latch set and creates nothing. The latch carries no
paths or session records. No additional I/O is added to an ordinary successful
save. A fresh process retains the existing filesystem recovery contract; no
persistent marker or startup flush is introduced by this narrow correction.

- Growth: no new storage format or cache. Retain the new referenced file and old
  history after this exceptional partial publication. Do not delete either when
  durability is unknown; existing successful-save and conversation deletion rules
  remain. Any retained prior generation is existing failure-recovery residue. Repeated retries in the live store create no
  further generation until the directory is confirmed.
- Concurrency: keep the current Close/session authority and atomic writer. No new
  lock, retry or operation begins after failure.
- Read cost: unchanged; the atomic writer's typed outcome supplies publication
  evidence without another filesystem read.
- Scale: no new normal-path work or fan-out. Fault tests cover first and replacement
  saves, terminal and transcript histories, and parent-open/flush failures.
- Compatibility: same public manifest and history bytes; published clients and the
  backend are unaffected. No migration. Reverting this fix restores the deletion
  bug and is not a safe data-recovery action.
- Audience and identity: unchanged private checkpoint directory and current session.
- Failure: the existing `HISTORY_NOT_SAVED` result remains visible; a post-publication
  error does not become success. No content or path is added to logs.
- Platforms: shared TypeScript. Native fault checks run on macOS; directory sync is
  skipped on Windows, whose native validation remains deferred by the user.

Pick checks before implementation: real filesystem red tests at the store API,
then existing checkpoint/secure-state callers, types and independent review. This
fix changes failure cleanup only; the successful I/O sequence remains identical.

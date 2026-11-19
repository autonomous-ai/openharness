# OpenClaw integration authority corrections

Independent review of the combined daemon-core source found waits introduced by
main's first-task handling that need the same binding and caller fences as the
extracted input path. Reproduce each confirmed case before changing runtime code.

## Design

- Growth: reuse the existing bounded input states and 256-entry retry maps. A
  first task retains only its fingerprint, cleared by its matching turn or stop.
- Concurrency: capture session binding before asynchronous pane/transaction work;
  recheck before reading into a session, taking its task, or submitting it.
  Durable removal is the consumption point. Its receipt survives subsequent
  source-release waits; a revoked handoff is reported, and a still-current launch
  fails visibly instead of waiting for a task no longer on disk. Replacement
  launches remain untouched.
  Only the engine's recovery command may bypass queued messages that are waiting
  for their pane. Other controls preserve their existing ordering.
- Read cost: no new polling. Preserve retry budgets across unreadable/transient
  screens; a genuine ready reading resets the history-recovery episode.
- Scale: keep existing map, byte and time limits. A pane-readiness wait must not
  spend the separate terminal-lease wait before that lease is requested.
  Each wait spends only its own cumulative budget, even when the reasons alternate.
  History retry episodes reset on a new TUI process or a confirmed Gateway outage,
  not a transient banner or unreadable frame.
- Compatibility: no public protocol or stored format change. First-task identity
  is in-memory only. Native history stays in its worker. Empty OpenClaw history
  must have no selected node or window, and cannot erase an earlier checkpoint.
- Migration/rollback: none; existing rows and checkpoints remain readable. A
  refused close preserves the last complete checkpoint and the live session.
- Audience/identity: the same local session and launch own every terminal effect.
  No worker gains publication authority and no account identity changes.
- Failure: stale work refuses; transient reads retain bounded retry state;
  unavailable or inconsistent history never becomes successful empty history.
- Platforms: TypeScript paths affect macOS/Linux/Windows. Validate macOS native
  callers and Linux CI; native Windows is deferred by the owner. Mobile excluded.

Review hypotheses already ruled out by the complete caller source: an unread
screen is refused by `messageWriter` before `commandHold` can allow a write; the
updater's staged callback exits with the service-restart code even when IPC fails,
so each restarted old-cohort updater re-arms the bounded reminder. The pending
negative path proof detects a newly created database in both verify and fresh.
Keep those protections; do not add redundant fallbacks or weaker source proofs.

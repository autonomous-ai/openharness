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

## Supervisor preparation deadline

The native 9d2a7 boot failed about 16 seconds after entering its lean master with
`worker_artifact_cleanup_unsettled`; that log does not establish its cause. Artifact preparation borrowed the
15-second lightweight probe deadline while it decodes and durably publishes the
complete worker cohort. Its deadline must be separate and bounded; a slow but
complete preparation keeps its ownership until actual child close. Timeout still
refuses admission, preserves uncertain claims and requires supervisor restart.
The timeout gets a fixed diagnostic name without child stderr, paths or content.

Storage format, growth, identity and audience are unchanged: one owned preparation,
one claimed cohort, no new data or concurrency. No migration is needed; rollback
restores the prior deadline. The same TypeScript path runs on macOS/Linux/Windows;
native Windows remains deferred. Verify delayed success past the probe deadline,
termination at the preparation deadline and admission only after actual close.

## Final handoff and startup corrections, 19 November

The exact `9d2a7e93c5` candidate passes all eleven required local CLI gates
(`20261119T155713.220102Z-51861`). Its native run passes 26 cases, including all
twelve ordinary updater cases, but fails the first OpenClaw daemon startup
(`20261119T155823.175558Z-54719`): artifact cleanup became unsettled approximately
sixteen seconds after boot. That run remains failed.

Cohort preparation was borrowing the lightweight fifteen-second probe deadline.
A deterministic regression demonstrates that a valid sixteen-second preparation
was killed and permanently refused subsequent child admission. Preparation now
has its own sixty-second bound; termination still requires actual child close,
and uncertain cleanup still holds admission closed. Fixed diagnostics identify
slow completion and timeout without exposing child output. The original native
log did not distinguish the cause of unsettled cleanup, so the historical
failure is not claimed to prove a timeout.

Independent review also found live user-message confirmation acting before app
publication, and asynchronous first-task failure acting after a foreground
lifecycle took ownership. Caller regressions fail before the correction;
confirmation now follows publication, and lifecycle/deletion checks withdraw
both attached handoff and its late completion. A source-release failure after
admitted task removal now reports the same launch failed immediately. An
unconsumed task remains for retry. A competing successful take returning null
is not confused with a failure.

The real Registry tests distinguish unconfirmed publication from admission:
authority revoked during settlement keeps the in-memory task and restores its
prior disk row on the next flush; release failure after admission keeps removal
and reports the existing restart-required persistence error. This does not add
a guarantee against a crash between unconfirmed publication and recovery.

Evidence: deadline RED `20261119T160422.556684Z-76603`, GREEN
`20261119T160711.458163Z-84230`; four caller RED assertions
`20261119T160927.136807Z-89016`; 313 caller tests, both changed core files at
100 percent coverage, and types pass in `20261119T161600.305641Z-2297`. That
receipt also retains a wrong diagnostic expectation in one new Registry test;
correcting only that expectation yields 39 passing Registry/durability tests in
`20261119T161716.288337Z-5415`. Final exact-head gates, corrected packaged startup
and matched cost measurements remain required before release.

The final review confirms the publication/admission distinction. Inspection of
`swap.ts` shows restart does not forget the input controller, so its withdrawn
handoff now releases only the expectation it created. The existing expectation
API returns that scoped release; record identity protects later identical tasks
and a replacement controller without a new registry, timer or public protocol.
A latched Registry can also refuse `setLaunch`; the async handoff reports that
exception through a fixed diagnostic instead of an unhandled rejection. The
new caller RED receipt is `20261119T162347.502400Z-11922`. Non-timeout preparation
failures retain the existing fixed `worker_artifact_cleanup_unsettled` diagnostic;
raw child output is never logged.

The supplemental review found that a retried or overlapping handoff must own
withdrawal too. Two real-controller caller tests reproduce the leak and stale
withdrawal (`20261119T162859.671695Z-17887`). Each matching `expectFirstTask` call
now replaces only the in-memory expectation record while keeping its fingerprint
and waiting state. Its release owns that record; an earlier handoff cannot clear
a newer one, and a retry can withdraw after restart. No second handoff map or
queue is introduced, and repeated expectations emit no extra frame.

Final caller validation passes 560 tests with types and both changed core files
at 100 percent (`20261119T162929.044376Z-18292`). Independent supplemental review
confirms retry and overlap withdrawal are corrected (`20261119T163000.790679Z-19427`).
Its remaining ordering hypothesis requires a second `takeFirstTask` to finish
while the first still releases its storage source. The actual registry does not
permit that ordering: `takeFirstTask` runs inside `RegistryWriteQueue`, `persist`
awaits source release in its `finally`, and `drain` awaits that complete operation
before admitting the next. Existing queue tests cover retained ownership through
settlement and escaping cleanup failure. No speculative concurrent-take path or
weaker source ownership is added. The full exact-head gates and packaged/cost
acceptance remain separate from this source review.

# Keep a completed reader on native confirmation

The attachment fix at `53d42bf277` passed the caller tests, required core gate and native Close/Resume test, but
failed its matched healthy-path cost comparison. For twelve completed-reader confirmations, the two baseline
runs used 316.500/413.561 ms core CPU; the candidate used 662.932/662.671 ms. Both matched pairs regressed.
The native waits dominate latency, and sampled RSS is not a transient peak. These measurements cover the core,
including its polling and test probe, and exclude helper/engine/worker CPU. They do not quantify each call's cost.

The same-ID confirmation now repeats `handleRegistered`: two stopped-record reads, an atomic saved-record write
and fsyncs, reservation completion, recap synchronization, attachment scheduling and terminal validation, before
reusing the parser that is already running. Resume already finished its reservation. The baseline skipped this
work. A completed reader can be retained while a missing or obsolete attachment still needs its successor.

## Design

Record this Design and a real composed-caller RED before the runtime correction. The initial attachment Design
remains the explanation for the liveness fix; this measured follow-up narrows its redundant healthy-reader work.

- Growth: no new persistent fields, maps, caches, timers, queues or worker requests. A transient capture of the
  existing reader and pane identity lives only across the synchronous native commit.
- Concurrency: the attachment owner supplies `captureReader(session)`, a guard for the confirmed row. It captures
  the exact pane identity, prior `boundAt` and ready worker handle. After commit, the same reader must still be
  installed for the current row, with the same identity after restoring only the prior `boundAt` for comparison.
  Home, process, route, cwd, path, evidence and hold changes cannot qualify. Pending attachment counts include
  queued and joined attempts; all require the fresh successor even if a handle has partly installed.
- Read cost: bounded lookups over existing attachment/stream state and a fixed-size identity comparison. The
  healthy confirmation does no additional archive, native or worker read. The matched native workload must show
  the new frozen candidate's cost; all failed comparison results remain part of the evidence.
- Scale: O(1), no idle work or fan-out. Measured core CPU already blocked the broader follow; affected native
  CPU, latency and sampled RSS are required acceptance evidence after this correction.
- Compatibility: no backend/client, wire or persistence changes. The skip applies only to a pure same-ID native
  confirmation. Switch, recovered metadata, ordinary SessionStart and owner settlement retain their normal path.
  Existing history/turn state is kept; there is no reset, replay or duplicate stream.
- Migration and rollback: none. Reverting this guard restores the functionally correct but cost-regressing
  `53d42bf277` behavior without changing saved conversations or the independent worker lookup memo.
- Audience: an internal read-only readiness observation. No new client access, logging or telemetry.
- Identity: native evidence remains authoritative. A ready worker cannot establish or refresh a binding. Every
  existing stale-read, cancellation, final-current and successor-serialization check remains unchanged.
- Failure: incomplete or uncertain readiness keeps the existing follow and error path. Readiness rejects identity
  or interpretation holds, relaunch marks, retained turn controls, pending/recovery/superseded work and forgotten
  attachment lifetimes. Worker readiness reads its existing connected/stopped, handle/token, orphan, closing,
  pending-open and recovery state. A retained normalizer alone never qualifies. Later loss uses existing recovery.
- Platforms: shared TypeScript; native Hermes record discovery runs on macOS/Linux. Windows keeps its existing
  `none` path. No process-launch changes. Local native evidence is macOS/private tmux with pinned Node 24.

`neverFoldedHistory` describes file-tail behavior: it is set even after a successful fileless Hermes DB attach.
A transcript-backed never-folded row cannot qualify. For fileless Hermes, the actual ready worker handle proves
the reader exists; that file-tail flag cannot override it. The readiness query remains owned by attachment;
binding only captures before commit and consults the guard for pure same-ID metadata.

## Caller evidence and acceptance

The existing real registry/main-store/attachment/native-follower/core-port/worker-reader caller adds a real private
`StoppedAgentStore`. After the reader finishes, native confirmation must cause zero extra saves, reservation
finishes, terminal probes or attachments, retain its reader and deliver one live turn without replay/reset/sync.
Before the correction this failed on actual delegated calls, not a timing threshold: one extra save, reservation
finish and terminal probe, and two attachment requests instead of one. The other six caller tests passed, including
all three stale-attachment overlaps. This max-one-worker RED ran before any runtime edit on 2026-11-16.

The tests keep all three overlap controls and late forget/rebind controls, and add missing/disconnected reader
and unfinished attachment cases, including a queued attach and a handle installed before its attach settles.
Native same-ID identity changes and retained/relaunch/held obligations still follow. Worker readiness covers actual
pending/open/disconnect/reconnect/lost/closing/forget states. A later native pass still waits without attachment.
Root reviews the frozen checkpoint before broad/native/cost validation.

The corrected affected selection passed 443 tests in seven files, with 100% statements, branches, functions and
lines for `bind.ts`, `attach.ts` and `otherStreams.ts`. The other-engine identity golden caller and TypeScript also passed.
The first expansion exposed two fixture assumptions: same-session registration preserves cwd, and polling a
20 ms backoff with a 50 ms assertion interval misses it. The controls now use the actual cwd mutation and the
actual held-log promise barrier. Their original failed outputs are retained. A later discovered transcript is
also tested: its never-folded flag prevents reuse and the ordinary attachment tails it from the start.

Native and matched cost acceptance for this corrected checkpoint remain pending. Main's later test-isolation
change requires the same private copied Node and current helpers on both benchmark sides; no earlier candidate
result is relabeled as evidence for this correction.

The earlier native timeout's exact interleaving remains unobserved; the independent source/caller defect is proven.

## Integration with reader recovery on current main

Main's #4371 distinguishes a ready reader from one that owns recovery while its worker is unavailable. The
composed caller now uses main's registry hold callback and destroys worker streams on disconnect. Before any
runtime correction, 21 cases passed and two failed: a native confirmation during recovery invalidated its pending
open with a new `boundAt`, leaving an orphan forever; a connected reader that gave up retained its hold, so the
fileless Hermes confirmation could not attach a successor. The failing log is
`/tmp/resume-main-integration-v2-red.log`; earlier native/cost results do not cover this combined source.

The correction keeps recovery's authority distinct from completed-reader reuse. A same-conversation native
confirmation waits while a reader hold still belongs to recovery; a later discovery pass commits that metadata
after recovery clears its hold. Different-conversation native evidence remains authoritative immediately. Once
the reader gives up, a successful native confirmation can release only the reader's own hold and follows with a
reset, so a retained orphan cannot qualify as an installed reader. Unrelated identity holds remain in force.
This adds no state, timer, queue, wire change or persisted data. Healthy confirmation retains its existing guard;
only a held recovery or a given-up reader takes these branches. Tests require one worker stream and exactly one
live turn, with no history replay, duplicate attachment or reset notification during recovery. Shared TypeScript
is affected; final native, platform and cost acceptance belongs to the integrated checkpoint.

The final focused evidence covers 526 passing cases in ten files, selected across the affected runs. The first
seven-file run's unchanged six files passed; its expanded caller controls included two incomplete forget fixtures
and two outage-start assertions that failed. Forget now uses both normalizer cleanup and attachment cleanup,
as main does. The corrected caller suite passed 27 cases, including stale recovery ownership and an unrelated
identity hold; the five-file final selection passed 260 cases. Logs retain the failed expansion alongside the
corrections (`/tmp/resume-main-integration-v2-focused.log`, `-controls.log`, and `-final-focused.log`).

The outage-start assertions exposed a separate limitation: Hermes `hydrate()` deliberately discards historical
events, whereas the store worker's resume branch looks for a hydrated `turn_started` to announce a turn begun
while it was down. Thus no start was emitted for a user row inserted during the outage. This integration does
not change Hermes hydration or claim that behavior passes. Recovery controls require the existing stream to
remain its sole owner and a subsequent live turn to arrive exactly once. No native benchmark was rerun.

## Confirmed Hermes recovery and an outage's current turn

Independent review found two remaining caller gaps. A confirmed Hermes terminal record settles to `wait`, so
discovery cannot rescue its fileless reader after connected recovery gives up. A new Hermes reader also seeds
silently, so the worker's existing resume reconciliation has no start event for a turn begun during its outage.

Before runtime changes, extend the real registry/attachment/terminal-follower/worker/private-SQLite caller.
Confirm and settle the native record before losing its reader, then require fresh record evidence to restore
exactly one reader. An unrelated hold, changed owner or stale native reply must not authorize this recovery.
Exercise an idle-to-working outage, an already acknowledged working turn, turns completed while offline,
ordinary startup, repeated reconnect and owner loss; only a newly open current turn may be announced.

The binding pass asks the existing terminal follower to refresh only a reader-owned hold with no recovery owner.
That refresh reads the record even when its stamp is unchanged, and the captured row/process authority still
fences its answer. Healthy passes retain their cached `wait`; unrelated holds are never released. The worker
passes its existing resume turn state to the Hermes reader. Hydration keeps only the last start event while
folding, emits it only if the acknowledged turn was closed and the current turn is open, and emits no historical
text, tools or completed turns. Ordinary hydration remains silent. The worker's existing resume filtering and
serial acknowledgements still own immediate delivery and duplicate suppression; delayed initial seeding uses
the same one-time reconciliation when the store next answers.

- Growth/read cost: no persisted records, timers, queues or extra store query. At most one already-bounded start
  event is held during the existing fold; one fresh terminal-record read occurs only for abandoned recovery.
- Concurrency/identity: existing captured process, row and stream generation checks remain authoritative; recovery
  readiness and ownership remain separate. A changed owner cannot receive the former owner's events or hold release.
- Scale: existing session, reader, query-page and outbox bounds remain. Matched healthy-path cost and failure
  acceptance are required for the final integrated source; source size alone establishes no performance result.
- Compatibility/migration/rollback: no backend/client/wire/schema change and no migration. Reverting restores the
  two liveness gaps without changing saved sessions. The current resume turn state already exists in worker IPC.
- Audience/failure: no new access, logging content or telemetry. Existing visible reader holds, bounded retry
  failures and stale-identity refusal remain; no new discovery timer or automatic retry loop is introduced.
- Platforms: shared TypeScript worker; Hermes native terminal-record discovery on macOS/Linux, existing hooks on
  Windows. No process-launch changes. Local evidence below names macOS; native/platform/performance gates remain.

The real-caller RED on `d20bb1ed` recorded three failures and three passing controls (40.98 s,
`/tmp/hermes-recovery-gaps-red.log`): already-confirmed recovery never became ready, a newly open outage turn
emitted no start, and the stale-record rescue control never entered a fresh record read. After the correction,
all 32 then-selected caller cases passed (21.59 s, `/tmp/hermes-recovery-gaps-green1.log`).

An additional history control caught a first-draft mistake: retaining the most recent start without forgetting
its subsequent end could resurrect a completed prompt before an empty user row. The delayed-seed control passed
and that history control failed before the correction (496 ms,
`/tmp/hermes-recovery-history-control-red.log`). Retention now follows the last start/end boundary; only an
unclosed current start is eligible. The expanded reader controls pass, including a transient initial read and
exactly-once delivery when the seed later succeeds.

The five-file expansion recorded 269 passes and two fixture failures (60.40 s,
`/tmp/hermes-recovery-gaps-focused.log`): an exact binding-dependency assertion omitted `refresh: false`, and the
owner-loss barrier tried to obtain a forwarding spy's original handler through `getMockImplementation()`, which
was undefined. The fixture now captures the actual handler before spying. The unchanged reader and worker
selections contribute 58 passes. The final three core test files pass 213 cases in 24.60 s with 100% statements,
branches, functions and lines for each changed core module (`bind.ts`, `hermesTerminal.ts`), including the actual
five-retry exhaustion and owner loss after SQLite hydration but before the worker reply. These selected runs
cover 271 passing cases in five files; the earlier failed expansion is not relabeled as an uninterrupted pass.

Final logs are `/tmp/hermes-recovery-gaps-core-coverage.log` and
`/tmp/hermes-recovery-gaps-types-final.log` (TypeScript passes). Execution is macOS with Node 24.22.2 and isolated
private SQLite stores. No broad gate, native daemon matrix, performance comparison, Linux or signed Windows run
was performed for this correction. Those acceptances remain required on the final integrated source.

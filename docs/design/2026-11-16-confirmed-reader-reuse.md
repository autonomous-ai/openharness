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

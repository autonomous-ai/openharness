# Follow the identity confirmed after Resume

`resumePendingAgent` restores a conversation with `boundAt: null` and `lastHookAt: 0`. Once its new process is
ready, Resume starts an optional attachment. Hermes's terminal record can then confirm that same conversation:
`registry.register` fills `boundAt`, changing the identity against which the attachment is checked. The stale
attachment correctly returns false. But the terminal binding path skips `followRegistered` when `isNew` is false,
so it never schedules the attachment for the confirmed identity. Later terminal passes settle to `wait`.

This source defect is independently reproduced with deterministic caller tests. A native Close/Resume run on
`6e06272d1a` also timed out after Resume confirmation without another completed attachment, but its log does not
establish which guard rejected that particular attempt. Do not attribute that run's exact interleaving to this proof.

The initial correction called the existing `followRegistered` for every successful Hermes terminal commit and
logged a switch only for a new conversation. `AttachTracker` already compares the captured identity: the successor
waits for an obsolete attachment, then runs, while an identical one joins. Its completed-reader reattach passed
functional acceptance but failed the matched core-CPU comparison. The [measured follow-up](2026-11-16-confirmed-reader-reuse.md)
keeps an already completed, current reader through pure same-ID confirmation and preserves this successor for
unfinished or unavailable readers. Every identity and cancellation guard remains; no new retry mechanism is needed.

## Design

Root reviewed this Design and the real-caller RED before runtime implementation on 2026-11-16.

- Growth: no new records, fields, maps, queues, timers or persisted data. Existing per-session attach tracking owns
  this work and releases it when the attempt completes.
- Concurrency: the native commit establishes new authority synchronously. Existing identity-aware attach tracking
  serializes old and new attempts. A stale native read, Close, process replacement or different conversation still
  revokes its operation. The successor receives the committed row, never authority copied from the stale attempt.
- Read cost: one attachment for an actual native confirmation. There is no additional discovery query or ordinary
  per-pass attachment; the terminal follower's next pass settles to `wait`. The follow-up avoids repeated archive
  and terminal-probe work for a completed reader. Native and affected cost acceptance remain required; earlier
  stopped-history numbers cover that unchanged workload only.
- Scale: one confirmation per resumed process, with the existing terminal-follower and attach-pool bounds. No idle
  work is added. Required core gates, native completion and affected healthy-path CPU/latency check the limit.
- Compatibility: no backend, client, wire or saved-row schema change. The resumed conversation gains the stream
  it should already have. With `isNew: false`, the existing settlement skips owner handoff, name inheritance,
  `session_synced` and conversation-reset frames. `resumeOnly` prevents first-turn history replay.
- Migration and rollback: no migration. Reverting this scheduling correction restores the liveness gap without
  changing saved conversations or the separate worker lookup memo.
- Audience: existing internal binding and reader checks; no new client access, logs containing data or telemetry.
- Identity: native evidence remains the binding authority. Reader hints never claim it; no login or owner changes.
- Failure: the existing `followRegistered` error path reports thrown failures. A stale attachment remains false;
  the fresh confirmation supplies a separate obligation. Repeated passes schedule no retry loop.
- Platforms: shared TypeScript core on macOS and Linux for Hermes terminal-record discovery. Windows keeps its
  existing hook path (`HermesTerminal` returns `none`). No process-launch code changes.

## Caller evidence

The regression uses real isolated registry resume methods, the actual `main.ts` store initializer, `createAttach`,
`createBinding`, `createHermesTerminal`, the core worker port and worker stream requests. A real Hermes reader reads
a private SQLite store; process/terminal evidence and asynchronous boundaries are controlled. The installed core
handle and worker reader must belong to the current identity, then deliver a fresh turn once without replaying
retained history, resetting the conversation or sending `session_synced`.

Before the runtime edit, three overlaps failed: native confirmation during terminal validation, store lookup or
worker open changed `boundAt`, correctly cancelled the obsolete attach, and requested no successor. Four controls
passed: confirmation before or after attachment, and late native replies after forget or a different conversation.
Both the initial ignored diagnostic and the tracked real-reader version recorded this RED. The earlier native
timeout remains evidence of a symptom, not proof of its precise schedule.

Focused validation passed 365 tests across binding, attachment, Hermes terminal discovery and the attach tracker,
with one worker. TypeScript found a missing required field in the test's observed-process fixture; after making
that fixture explicit, its seven caller tests and TypeScript both passed. Root reviews the frozen checkpoint
before another native run or broad gates.

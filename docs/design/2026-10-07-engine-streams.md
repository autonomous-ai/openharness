# Live transcript workers

Tracking: [#1016](https://github.com/autonomous-ai/openharness/issues/1016).
Follows the [live interface](2026-10-07-engine-live.md) and
[reader workers](2026-10-07-engine-readers.md). This change is being validated;
it does not complete the full Claude Code/Codex isolation effort.

## Ownership

The existing supervised `engine-claude` and `engine-codex` processes now host
live parsers alongside history readers. They locate transcript windows, fold
records, retain parser state, and propose normalized events. Core owns session
bindings, accepted transcript checkpoints, explicit cancellation/closure, and
the event funnel. Generic file notifications stay in core; it neither tails nor
normalizes Claude Code/Codex JSONL through the legacy watcher in this mode.

`LiveState` is a core observation and closure handle. `LiveParser` adds the
engine's ingestion methods and exists inside its worker. Other engines keep
their current tailers and parsers.

## Checkpoints and delivery

- **ES-001 — Pull and acknowledgement.** One live operation runs per engine
  worker. Core serializes requests fairly across that engine's sessions. A
  request carries the last accepted cursor; retrying the same request returns
  the same cached page. Every successful page advances a serial, including empty
  polls, so acknowledging an empty response permits observing later appends.
- **ES-002 — Bounded delivery.** Pages target 1 MiB including raw records and
  normalized events. A single larger record can exceed that target. Results over
  the socket envelope travel in 256 KiB fragments with a digest, up to a 64 MiB
  serialized result limit. A worker's response cache is bounded to 128 MiB and
  256 sessions. Oversized results fail explicitly without accepting their bytes.
  Remaining transcript data stays on disk. Capability negotiation and all reply
  fragments share one 15-second core deadline. Parser cleanup uses the same
  per-engine queue as reads, so retiring a parser cannot displace its replacement's
  first read.
- **ES-003 — Recovery equivalence.** Core retains the original attach end as
  well as the accepted offset. A replacement worker reconstructs the same
  original parser window through the accepted offset, silently, then reads new
  records. Reconstructing only the latest turn changed thinking ids and forgot
  a Codex goal across ordinary turns; regression tests compare recovery with a
  continuously running parser. Recovery streams records rather than retaining
  the whole file, but its elapsed work grows with bytes accepted since attach.
  The 15-second operation deadline and supervisor budgets still apply; long
  recovery is measured separately from paired steady-state CPU, memory and latency.
- **ES-004 — Binding and cancellation.** Replies are fenced by service connection
  generation, copied binding identity, parser handle, and core decision epoch.
  Closing an observed turn updates its checkpoint and invalidates an in-flight
  page. The worker applies its own closure behavior when reconstructing that
  checkpoint; an unseen newer turn can still open normally. Stop's identity
  check remains synchronous in core. Linux process start ticks preserve a binding
  across wall-clock corrections; a changed pid or start tick still invalidates it.
- **ES-005 — Attach handover.** A hold stops new pulls and waits for the current
  page. Replacement hydration is staged to that acknowledged byte. Installation
  is synchronous, and an expired hold, changed binding, explicit tail move or
  intervening cancellation rejects the candidate. Initial live content activates
  an empty parser first and streams afterward; core does not collect the whole
  first turn in an `initialEvents` array. Core retains first-turn delivery intent
  across a failed initial prepare until activation succeeds for that binding.
- **ES-006 — File changes.** A checkpoint fingerprints file identity and bytes at
  the accepted boundary. Replacement, truncation or a changed boundary rejects
  the page and schedules a held re-attach. Files up to 32 MiB activate a fresh
  parser and replay existing records as history in bounded pages; subsequent
  appends are live. The history boundary survives worker restart. Larger files
  hydrate from their new end. A trusted explicit tail move hydrates at the new
  offset without replay. This is not a checksum of every byte in the transcript.

## Availability and compatibility

Worker failure pauses its engine's transcript delivery. Core and the engine CLI
remain alive; the CLI keeps writing its transcript. Recovery delivers the
unaccepted records once. An engine worker that remains parked cannot deliver
live events until it runs again. History requests report explicit unavailability.
Other engines and core operations remain independent.

Private live methods are not public routes and accept only core's authenticated
owner connection. Workers retain no core query capabilities. Capability replies
are checked before use. A master's explicit live-host version selects the new
path only when its report names the core's actual parent pid, so a stale inherited
flag does not select an older master's reader-only worker. An older master or explicit inline configuration uses the
compatibility module. Runtime errors never select an inline parser.

## Remaining work and evidence

Validation covers the core and supervisor per-file gates, protocol and compatibility
contracts, private-daemon crash/freeze/memory/parking recovery, rewrite replay,
turns, compaction and history. Results and source-specific receipts are recorded in
the PR and the working branch's ignored `.harness`. Paired performance measurements,
a separate code review and ready-PR CI still precede merge.

Raw records still reach the runtime-profile and device-evidence consumers, and
the worker currently reuses the runtime-profile field probe for attach. These
are explicit migration bridges. Hook policy/admission/installers, launch and
session discovery/resume, pane/input interpretation, runtime models/profiles,
and the remaining shared helpers still need process boundaries. The complete
normal core import closure has not yet been cleared of Claude Code/Codex code.

# Live engine interpretation outside core

Tracking: [#1016](https://github.com/autonomous-ai/openharness/issues/1016).
Follows the [reader pilot](2026-10-07-engine-readers.md) and the
[engine interface inventory](2026-10-05-engine-interface.md).

## Current increment

Claude Code's normalizer now belongs to `engines/claude/normalize.ts`. Claude Code
and Codex own their attach rules and live-parser factories. The `Engine.live`
facet exposes ingestion, a read-only turn snapshot, explicit closure, and the
start offset used to name thinking blocks. Event types and transcript folding
are engine-neutral kit modules; the backward file reader takes injected rules.

Core's attach and ingest modules receive a `LiveFor` dependency. The normalizer
table keeps a `LiveParser` handle per migrated session, without Claude's tool
maps or Codex's concrete normalizer type. A parser reports a failure separately
from its events so core can announce the reason before the corresponding turn
end. Other file engines and database readers retain their existing adapters.
A file line for a database engine cannot create a Claude parser for that engine.
The old plain-terminal fallback remains explicit in the temporary live lookup;
it does not acquire end-first attach rules.

**The interface-only increment ran live parsers in core's process.** The following
[live worker increment](2026-10-07-engine-streams.md) moves supervised parsing
across the process boundary and records its remaining validation. `engines/live.ts`
is temporary composition while the live transport is built. `lib/normalize.ts`
is a compatibility export used by consumers still being migrated. The existing
supervised workers initially isolated history and last-turn reads only.

## Preserved requirements

- **EL-001 — Arrival identity.** A turn snapshot is a value. Its identity includes
  both a parser instance and its turn counter. A normal Stop cannot close a turn
  opened after its arrival or a turn in a replacement parser. StopFailure keeps
  its existing exception; a hook older than the latest prompt hook closes nothing.
  Core also checks the engine binding and expected turn identity at closure, and
  a rejected proposal emits no end event. Reusing a session id under another
  engine replaces its parser before ingestion.
- **EL-002 — Tail handover.** Attach holds delivery, rebuilds up to the held byte,
  and installs the replacement before releasing the hold. A failed read or expired
  hold preserves the old parser. No await is introduced into that final swap.
- **EL-003 — Event order.** The record's failure is announced before its events.
  First-turn replay, history replay and a resumed open turn remain distinct.
- **EL-004 — Closure semantics.** Cancellation preserves Claude's pending-call
  behavior. Relaunch and forced Stop clear pending calls. Tool-name links survive
  for late results. Core asks for closure; only the engine edits parser state.
- **EL-005 — Scope evidence.** Recorded transcript oracles, attach/hook race tests,
  the local core coverage gate and private-daemon tests validate this extraction.
  They do not establish live-process isolation.

## Remaining isolation audit

| Area | Current evidence / remaining work |
| --- | --- |
| History and last turn | Worker isolation merged in #1015; keep its reply, deadline and stale-binding guards. |
| Live transcripts | Typed parser and attach rules extracted here. Move state, file following and ordered delivery to workers, with bounded backpressure and restart reconstruction. |
| Hooks | Engine admission, path resolution and installers have engine homes but still execute in core. Stop still coordinates through an in-process facet. |
| Launch and sessions | Launch facets exist; preparation, homes, discovery/process recognition, resume/fork and binding repair still need a runtime boundary. |
| Screen and input | Pane interpretation, questions, acceptance and input preparation still contain engine behavior. Core must retain terminal/input authority. |
| Runtime profiles and models | Transcript/config interpretation and switching remain in shared core-reachable helpers. Core should read reported state and validate proposed actions. |
| Other helpers | Audit title, usage, search, one-shot, transcript-reader and compatible-format consumers, including transitive imports through `lib/normalize.ts`. |
| Completion proof | Require the complete C&C runtime closure to be outside normal core, plus fault, reconnect, stale-generation and cleanup evidence. File moves alone are insufficient. |

The live transport must carry binding and connection generations and preserve
the acknowledged transcript position across a worker restart. It must neither
queue unbounded per-line RPC calls nor silently fall back to inline parsing when
an isolated worker fails. Core remains authoritative for agents, session binding,
terminals, turns, input and questions. The existing master supervises one worker
per engine type; no per-agent worker process or new supervisor is planned.

# Engine runtime profiles

Status: implementation in progress. This continues [engine isolation](2026-10-05-engine-interface.md)
after [live transcript isolation](2026-10-07-engine-streams.md). The supervised Claude Code/Codex profile
path now executes in workers. Its profile implementations are also excluded from normal core's
import closure. Final validation, runtime measurements and review remain before this increment ships.

## Ownership

Claude Code and Codex own transcript and pane interpretation, native model and effort policy,
configuration reads, and model catalogs. Core's runtime coordinator keeps accepted profile state,
notification timing, and control transactions. Its routing facade uses the inline manager only for
other engines or explicit compatibility. Supervised Claude Code/Codex observations, catalogs and
native-control eligibility go through their workers, with no inline fallback after failure.

The runtime facet takes plain session, state, and optional control values. Its reducers mutate those
supplied values, not a registry or terminal. The private worker handler copies only declared fields
before evaluation. A restarted worker can evaluate the next operation entirely from core's last
accepted snapshot.

Live transcript pages carry compact, opaque runtime evidence beside normalized events. The engine
extracts that evidence from the vendor record. Core transports it without interpreting its keys.
For example, a large assistant record contributes its model/version facts without carrying its entire
answer into another profile request. An unrecognized model acknowledgement still retains its existing
control meaning. The metadata-field probe uses the same engine reducer on an isolated scratch state;
it no longer loads the monolithic runtime manager inside a worker.

## Private protocol

`engine_runtime_capabilities` and `engine_runtime_read` require core's authenticated owner link.
They are not public request routes. Each worker loads its own runtime facet on demand.

- Version 1 supports compact record batches, pane observations, configuration, model lists,
  native catalogs, effort eligibility, and a current profile description.
- Requests and replies are bounded at 1 MiB. Batches contain at most 512 compact records; pane text
  is bounded at 256 KiB. There are at most two runtime requests executing per engine worker.
- One five-second core deadline covers negotiation and execution. A worker also recycles when an
  asynchronous operation exceeds its execution deadline, containing abandoned file reads.
- The core transport rejects stale connection generations, malformed results, and profile ids for
  another agent. A control result must describe the same supplied transaction. Both the current
  agent-id encoding and the previously supported bound conversation-id encoding remain accepted.
- Calls do not fall back to core after worker failure. Caller wiring must preserve the last accepted
  profile and retry pending evidence under the same binding checks used by live transcripts.

## Core authority and handover

Core serializes runtime requests per engine, with a 256-entry queue and a five-second queue wait
budget in addition to the transport deadline. Each operation carries copied state and control facts.
Replies are rejected if the conversation/process binding, control revision, or observed CLI version
changed. A stale caller cannot replace a newer binding's accepted profile. Empty conversation ids
never become shared cached state; unbound agents can still request their own catalogs.

Live pages reduce compact evidence in bounded batches before acknowledging their cursor or delivering
events. Failed reductions retain the previous cursor and retry even without another file change.
Cancellation is checked again after awaiting the profile worker. Attach hydration has its own staged
state, including configuration; it installs that state and the live parser in one synchronous commit
under the existing binding, turn, tail-movement and hold guards. A failed stage cannot commit a
partially reduced page.

Synchronous display reads use accepted state. Control waiters, cancellation, nested notification
suppression and debounce remain in core. Gateway sessions remain display-only. The parent-bound
`HARNESSD_ENGINE_RUNTIME=<master-pid>:1` report selects runtime isolation separately from live parsing;
an older master selects explicit compatibility instead of discovering the missing protocol on a
user's first request. The wire profile parser no longer imports the runtime manager.

## Remaining before this increment ships

The legacy manager takes injected runtime facets. Normal supervised core supplies no Claude/Codex
facet; explicit inline mode or an older master's capability report loads them through
`services/inline.ts`. Architecture checks reject either profile implementation in normal core's import
closure. Worker failure never changes this composition.

The old catch-all interpreted other engines' records and panes as Claude. Auditing recorded Amp,
Muse, Copilot, agy and Pi transcripts found no native profile metadata supplied by that fallback.
Their registry seeds and native config/footer readers remain. Claude commands quoted in their answers
or panes no longer change their profiles. Tests replay the recordings and cover these native sources;
this does not add new engines to the worker migration.

1. Finish validation of the import split and the other-engine regression checks.
2. Measure paired CPU, RSS and latency for the final implementation, including engine workers.
3. Validate any further changes, then complete a separate review and automatic ready-PR CI.

Current development evidence: 1,446 core/services tests with 100% coverage in every file; the supervisor
gate with 100% coverage in every file; 204 focused profile/controller/home/protocol tests; typechecking
and architecture checks. Six selected private daemon/tmux cases passed with fake vendor CLIs: Codex
model/effort switching, both engines' moved-home catalogs, private-route denial, and both engines'
accepted-profile preservation and pending-evidence recovery while their worker was frozen. These are
development receipts, not a claim that the remaining boundary or full engine goal is complete.

Hooks, launch/discovery/resume, input interpretation, and the other boundaries tracked by the engine
isolation work remain in scope after runtime profiles. This increment does not close the full goal.

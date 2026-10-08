# Engine runtime profiles

Status: implementation in progress. This continues [engine isolation](2026-10-05-engine-interface.md)
after [live transcript isolation](2026-10-07-engine-streams.md). It is not complete runtime-profile
process isolation yet.

## Ownership

Claude Code and Codex own transcript and pane interpretation, native model and effort policy,
configuration reads, and model catalogs. The shared runtime manager retains profile state,
notification timing, and control transactions during migration. Core must ultimately keep only
reported state and transaction authority; it must not interpret either vendor's records or panes.

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

## Remaining before this increment ships

The transport and worker methods exist, but the normal core profile consumers still use the inline
manager. This branch must not be marked ready on the strength of the extraction tests alone.

1. Wire a core coordinator that serializes profile mutations, stages hydration, and fences binding
   and control revisions. A late pane/config result must not overwrite newer transcript evidence.
2. Apply a live page's profile evidence before acknowledging its cursor. Retry failures from that
   checkpoint; split large evidence batches within protocol limits without dropping records.
3. Serve synchronous display reads from accepted reported state. Preserve model-control waiters,
   cancellation, notification suppression/debounce, and existing gateway display-only policy.
4. Remove the normal core path's runtime imports of Claude/Codex profile implementations. Explicit
   older-master/inline compatibility must be selected from a parent-bound capability report.
5. Preserve the existing metadata behavior of other engines during this two-engine migration;
   the legacy manager currently routes some of them through Claude-shaped fallback readers.
6. Run affected coverage gates, profile/model daemon integration and recovery tests, inspect runtime
   cost, then complete separate review and automatic ready-PR CI before merge.

Hooks, launch/discovery/resume, input interpretation, and the other boundaries tracked by the engine
isolation work remain in scope after runtime profiles. This increment does not close the full goal.

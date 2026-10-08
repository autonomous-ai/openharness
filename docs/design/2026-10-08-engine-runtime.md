# Engine runtime profiles

Status: implemented for Claude Code and Codex. This continues [engine isolation](2026-10-05-engine-interface.md)
after [live transcript isolation](2026-10-07-engine-streams.md). The supervised Claude Code/Codex profile
path now executes in workers. Its profile implementations are also excluded from normal core's
import closure. This boundary covers runtime profiles; the wider engine migration remains in progress.

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

## Compatibility and validation

The legacy manager takes injected runtime facets. Normal supervised core supplies no Claude/Codex
facet; explicit inline mode or an older master's capability report loads them through
`services/inline.ts`. Architecture checks reject either profile implementation in normal core's import
closure. Worker failure never changes this composition.

The old catch-all interpreted other engines' records and panes as Claude. Auditing recorded Amp,
Muse, Copilot, agy and Pi transcripts found no native profile metadata supplied by that fallback.
Their registry seeds and native config/footer readers remain. Claude commands quoted in their answers
or panes no longer change their profiles. Tests replay the recordings and cover these native sources;
this does not add new engines to the worker migration.

Development evidence: 1,447 core/services tests with 100% coverage in every file; the supervisor
gate with 100% coverage in every file; 583 focused profile/controller/home/protocol/attach and boundary
tests; typechecking and architecture checks. Eight selected private daemon/tmux cases passed with fake
vendor CLIs: Codex model/effort switching, both engines' moved-home catalogs, private-route denial,
both engines' accepted-profile preservation and pending-evidence recovery while their worker was
frozen, and both engines' explicit inline profiles/catalogs. The name filter excluded 25 other cases.
The queue regression also verifies that an expired caller returns while the preceding request remains
pending, without letting its successor bypass that active request.

A paired macOS run compared main `023ae4117` with runtime code `b1000873d`, using Node 22.23.2,
four agents (two active), two windows, four terminal streams, 1 MiB histories and history requests
every two seconds. Each phase measured 30 seconds after warmup. CPU is a percentage of one logical
CPU; RSS below includes core and both engine workers. Master, other services, vendor CLIs and tmux
are excluded. The engines and backend are disposable local fakes.

| Active workload | Main | Runtime isolation |
|---|---:|---:|
| Core + worker CPU | 8.73% | 8.80% |
| Core + worker mean RSS | 319.30 MiB | 314.61 MiB |
| Core mean RSS | 140.44 MiB | 141.78 MiB |
| Core event-loop p99 | 14.01 ms | 14.25 ms |
| History read p95 | 42.70 ms | 36.12 ms |
| Fake turn p95 | 6000 ms | 6142 ms |
| Completed turns | 10 | 10 |

Empty CPU/RSS was 1.07%/90.75 MiB versus 1.16%/89.99 MiB; populated-idle was
4.17%/306.33 MiB versus 4.02%/306.82 MiB. This is one paired measurement, not a new numerical gate
or evidence about real model latency. The PR records CI/review evidence separately from these local
checks and measurements.

Hooks, launch/discovery/resume, input interpretation, and the other boundaries tracked by the engine
isolation work remain in scope after runtime profiles. This increment does not close the full goal.

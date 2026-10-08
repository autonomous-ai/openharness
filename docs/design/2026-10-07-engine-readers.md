# Engine reader process pilot

[Issue #1014](https://github.com/autonomous-ai/openharness/issues/1014) records the private protocol
before implementation. This is the first process boundary in the
[engine interface migration](2026-10-05-engine-interface.md).

Only Claude Code and Codex `historyPage` and `lastTurnText` run in these workers. Their recorded
history, cursor and last-turn fixtures are the compatibility oracle. Launches, hooks, discovery,
resume, live ingestion, screen/input and models have not moved to a worker. Core remains the sole
owner of sessions, bindings, turns and terminal access.

## Contract

| ID | Guarantee |
|---|---|
| ER-001 | The master starts `engine-claude` or `engine-codex` on its first read. Each uses the existing service supervisor, authenticated local link, heartbeat watch, restart backoff and crash parking. An empty daemon starts neither worker. |
| ER-002 | Private version 1 messages contain only session id, transcript path, touched time, optional Codex home, and pagination arguments. They carry no registry, turn, terminal, credentials or callable core capability. Core denies every query from these readers; clients cannot route these private request types. |
| ER-003 | Core and worker each admit at most four concurrent reads per engine, rejecting excess with `ENGINE_BUSY`. There is no unbounded queue. A link waits at most five seconds for startup and five for execution. A worker recycles itself when an asynchronous read lasts five seconds; a blocked event loop is contained by the master's heartbeat watch. |
| ER-004 | Each worker has a 512 MiB V8 heap limit and 1 GiB RSS budget. It owns a 128-entry pager. Existing bounded file readers remain bounded. Serialized replies over 4 MiB are rejected before transport, beneath the local service transport's 6 MiB ceiling. These are containment limits, not expected steady-state usage. |
| ER-005 | Replies use the existing unique request id and private protocol version. Core validates their replay-event shape, rejects a reply from an earlier connection generation, and rejects a read when the requested session's binding changed while it was pending. Registry identity is copied before yielding because rows can mutate in place. |
| ER-006 | Disconnects, timeouts and failed reads are not replayed or retried inline. History returns an explicit error and retryability. A missing last-turn read yields no recap text. After recovery, a new request may read again; no turn or input is replayed. |
| ER-007 | Explicit inline mode and an older master that does not report hosting these readers retain the existing inline implementation. Capability is determined from the master's reported process list. These are new optional workers, so `askedSince: 0` prevents an old core from starting workers it cannot use; the existing protocol 4 `want` message needs no change. |

`core/engines/readers.ts` is the injected port; `engines/worker/protocol.ts` is its small value-only
contract; `engines/worker/process.ts` owns reader execution. The master imports none of them.
`services/inline.ts` is the existing explicit compatibility import. Architecture and lean-bundle tests
keep the worker and reader implementations outside supervised core's import closure.

There is one intentional limit on formerly successful replies: a legacy full-history request whose
normalized answer exceeds 4 MiB returns `ENGINE_REPLY_TOO_LARGE`, with `retryable: false`. Request a
smaller page; retrying the same oversized read will not help. A single enormous event can exceed that
limit even with a one-record page. This pilot does not silently truncate such an event or introduce a
second streaming protocol.

The process boundary contains crashes, allocation pressure and hangs. It is not an OS security
sandbox: workers run as the same user and can read that user's files. Capability denial is an API
ownership rule, not protection from arbitrary native code in the worker.

## Proof and next boundary

Unit tests cover malformed requests/replies, overload, worker deadlines, lost/replaced connections,
changed bindings, private capability denial and the original recorded replies. The daemon test covers
demand startup, normal pages and recap text, kill, freeze, memory restart and crash parking while
core and engine processes survive. Soak/chaos includes both workers in every process/fault pair.
The optional `PERF_READERS=1` workload adds history reads every two seconds and measures core plus
reader CPU and RSS, together with request and turn latency. Reports identify the exact bundle; short
runs do not establish long-term leak freedom. Validation results and durations belong in the PR.

Moving live ingestion and hooks next requires a distinct transition contract: core-issued binding
and turn generations, ordered events, bounded buffering, and replay/resynchronization rules. This
read-only pilot does not establish those guarantees and is not complete engine isolation.

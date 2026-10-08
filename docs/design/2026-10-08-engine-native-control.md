# Engine native control connections

Codex's connection to its shared app-server now runs in the Codex worker, through
`Engine.nativeControl`. That covers the `codex app-server proxy` client, the JSON-RPC protocol, and
the activity and stop sequences. Before this batch the core spawned that child and kept its socket
open. Now the core spawns no engine child and keeps no engine socket.

Core keeps the authority:

- the process table, and which process is the session's, by its identity;
- the session's store (`CODEX_HOME`);
- the early answers that need no server;
- whether a stop is still wanted;
- whether an unbound chat was never used;
- the SIGTERM that follows.

## What moved

| Was in core | Now in the Codex worker (`engines/codex/nativeControl.ts`) |
| --- | --- |
| `lib/codexSessionLifecycle.ts`: `connectCodexControl`, the daemon pid file, `stopSharedCodexSession` | `connectCodexControl`, the daemon pid file, the stop sequence: pause the goal, interrupt the turn, archive and unarchive, confirm `notLoaded` |
| `lib/runtimeActivity.ts`: `CodexActivityReader` (a connection pool per home, 60 s backoff) | the same pool and backoff; `thread/read` mapped to working, idle or unknown |
| argv rules (`--no-daemon`, `--remote`, the npm wrapper) | the same, applied to the argv core passes |

`core/engines/nativeControls.ts` is core's side:

- It reads the process table, at most once every two seconds for activity.
- It finds the owner by identity and executable, and resolves the store.
- It passes the worker plain data `{ home, sessionId, owner argv }`.
- It keeps the stop's early return for an exited client that never bound a conversation.

A stop runs under a single-use grant (token). The worker asks core three questions through
`engine.nativeControl`, and core answers each from what it holds:

- **`current`:** is the stop still wanted? A no revokes the grant.
- **`running(pid, startedAt)`:** checked against the table core read as the stop began.
- **`unused`:** the Close's fresh screen proof.

A grant allows at most 32 questions, one at a time. It ends when a question goes unanswered or is
refused, when its connection is replaced, at its deadline, or when the stop completes.

## Bounds and failure

| Bound | Value |
| --- | --- |
| Activity read | 15 s deadline, 8 in flight, 64 queued; past the deadline the worker is recycled |
| Stop | 60 s deadline, 4 in flight, none queued; past the deadline the worker is recycled |
| One question to core | 10 s |
| Reply | 4 KiB; a refusal is one line of at most 600 characters, with no control characters |

- **Activity.** No reading is `unknown`.
- **Failed stop.** A stop the worker could not confirm throws. The close keeps the pane and the stop
  is not signalled. The worker's refusal text reaches the person (for example "Stop this conversation
  on its remote Codex server…"). A lost worker gives a fixed text.
- **Killed worker.** Its proxy client exits with it, because the client reads the worker's pipe, and no
  further request of the stopped attempt reaches the server.
- **Kill between archive and unarchive.** A worker killed there can leave the thread archived. The
  pre-move code had the same risk if the core died there; a worker is now the likelier process to be
  killed. The history stays on disk, but nothing yet unarchives it automatically.

**A Codex stop now needs the Codex worker.** Before this batch, a client launched with `--no-daemon` (every
Harness launch on a Codex that has it) was stopped with no connection at all. Its argv is now read by
the worker, so while that worker is parked a Codex stop fails closed and keeps the pane, as a message
is withheld while its screen cannot be read. A live Codex agent's worker is normally running already:
its live parser runs there. If stops must survive a parked worker, the ownership flag can become
declared launch data that core evaluates itself. This batch does not do that.

The parent-bound `HARNESSD_ENGINE_NATIVE_CONTROL=<master-pid>:1` capability selects the worker.
Explicit inline mode and older masters compose the same control in process
(`services/inline.ts` `nativeControlFor`), and the core closes its connections at shutdown.
`NATIVE_CONTROL_ENGINES` (Codex) is declared data, so a stop of any other engine never waits on a
worker.

## Validation

- **Recorded cases.** The former `codexSessionLifecycle.spec.ts` and the `CodexActivityReader` cases
  run unchanged against the composed pieces: `core/engines/nativeControls.stop.spec.ts`,
  `lib/runtimeActivity.spec.ts`, `lib/engineHomeReaders.spec.ts`. So does the real close chain in
  `lib/unusedCodexClose.spec.ts`.
- **New unit tests.** They cover the broker through the real worker requests: the grant's answers,
  revocation, overlap and count limits, a replaced connection, a throwing check, refusal text and
  inline bounds. They also cover the worker requests themselves: bounds, abort, deadline, recycle,
  late answers and load retry.
- **`e2e/engineNativeControl.e2e.ts`** runs against the fake shared server:
  - Activity runs over the worker's own proxy child. With the worker killed while that connection is
    open, exactly one new connection follows, the old client is gone, and the next close stops the
    conversation once.
  - With the worker killed while a stop waits on the server, the close fails with the pane kept and
    nothing more reaches the server. A second close then interrupts, archives and unarchives once.
  - Explicit inline mode closes through the core's own control.
  - In every case the core stays up.
- **Unchanged suites.** `e2e/enginehomes.e2e.ts` (the moved shared server: activity, resources, close)
  runs unchanged.

# Engine native control connections

Codex's connection to its shared app-server now runs in the Codex worker, through
`Engine.nativeControl`. That covers the `codex app-server proxy` client, the JSON-RPC protocol, the
activity pool and the stop's sequence of requests. Before this batch the core spawned that child and
kept its socket open. Now the core spawns no engine child and keeps no engine socket.

Stopping an agent is session control, so every decision that needs no server stays in core. Core reads
those decisions from the process table, the session's identity and store, and Codex's declared
contract. A stop needs the Codex worker only for a conversation that is on a running shared server.
The former code needed a server connection in exactly that case, too.

## What moved, and what core reads itself

| Was in `lib/codexSessionLifecycle.ts` / `CodexActivityReader` | Now |
| --- | --- |
| The `--no-daemon`, `--remote` and npm-wrapper argv rules | Core, from Codex's declared launch data (`EngineLaunch.sharedServer`: owned flag, remote flag, script names) |
| The server's pid file (`app-server-daemon/daemon.pid`) and whether that process runs | Core: the file path is declared data; the process table is core's |
| The unbound-chat proof, the early return for an exited client, cancellation | Core, unchanged |
| The person's messages for these outcomes | Declared with the contract (`messages`), unchanged text |
| `connectCodexControl`; `thread/read`; pause goal, interrupt turn, archive and unarchive, confirm `notLoaded` | The Codex worker (`engines/codex/nativeControl.ts`) |
| The activity pool per home, with its 60 s backoff | The Codex worker |

Core's side is `core/engines/nativeControls.ts`. It passes the worker only `{ home, sessionId }`, and
only for a conversation it has established is on a running server.

## The stop grant

A stop runs under a single-use grant. Before each effect the worker asks core one of three things:

- **`current`:** is the stop still wanted? A no revokes the grant.
- **`pending`:** the worker is about to archive; is the stop still wanted? Core notes the archive, so
  that it can be undone if this worker is lost before its unarchive.
- **`settled`:** the unarchive was sent, so nothing is left to undo.

A grant allows at most 32 questions. It is revoked on a refusal, a replaced connection, the deadline
or completion.

**Repair.** A stop that got no reply from its worker may have left a thread archived. Core keeps a note
of any archive the stop marked `pending` and never marked `settled`. On the next connection of that
worker, core asks it once to `recover` the thread (unarchive it), bounded at 15 s. Core logs the
outcome and forgets the note either way. A stop that did get a reply needs no repair: that worker
already made its own unarchive attempt. In inline mode nothing is kept, because there is no worker to
lose.

## When the worker does not answer

**Stops that need no server** go ahead with no worker:

- a client launched with `--no-daemon`;
- a store with no server record;
- a server process that is not running;
- an unbound chat proved unused;
- an exited client that never bound a conversation.

**A conversation on a running shared server** with a worker that does not answer (parked, crashed, past
its deadline) behaves as the former in-process code did when its connection to the server failed:

- The stop is not confirmed, and it throws.
- The client is not signalled, and its pane stays.
- Core logs `the codex worker did not answer the stop`.

**Activity** with no worker is `unknown`.

**A close sent just after the Codex worker restarted** used to fail with `ENGINE_STALE_REPLY`: its
first read went to the transcript tail through the worker being replaced. A read is idempotent, so the
close now waits up to 10 s for the worker's new link (`core/engines/engineLinks.ts`) and reads once
more. Writes are never retried this way.

## Bounds

| Bound | Value |
| --- | --- |
| Activity read | 15 s deadline, 8 in flight, 64 queued; past the deadline the worker is recycled |
| Stop | 60 s deadline, 4 in flight, none queued; past the deadline the worker is recycled |
| Recover | 15 s deadline |
| One question to core | 10 s |
| Reply | 4 KiB; a refusal is one line of at most 600 characters, with no control characters |

The parent-bound `HARNESSD_ENGINE_NATIVE_CONTROL=<master-pid>:1` capability selects the worker.
Explicit inline mode and older masters compose the same control in process
(`services/inline.ts` `nativeControlFor`), and the core closes its connections at shutdown.

## Validation

- **Recorded cases.** The former `codexSessionLifecycle.spec.ts` and the `CodexActivityReader` cases
  run unchanged against the composed pieces: `core/engines/nativeControls.stop.spec.ts`,
  `lib/runtimeActivity.spec.ts`, `lib/engineHomeReaders.spec.ts`. So does the real close chain in
  `lib/unusedCodexClose.spec.ts`.
- **New unit tests.** They cover:
  - the broker: decisions with no worker, the grant's answers, revocation, the count limit, the repair
    on reconnect (done, refused, unreachable), refusal text, a worker that does not answer, inline
    bounds;
  - the worker requests: bounds, abort, deadline, recycle, late answers, load retry, recover;
  - the close's single retried read and the engine links.
- **`e2e/engineNativeControl.e2e.ts`** runs against the fake shared server:
  - Activity runs over the worker's own proxy child. A close sent the moment that worker is killed
    still stops the conversation, once.
  - A worker killed while a stop waits on the server leaves the pane, and nothing more reaches the
    server. A second close then stops the conversation once.
  - A worker killed between archive and unarchive: the next worker unarchives the thread once, and a
    later restart repairs nothing more.
  - With the Codex worker parked, Stop ends a `--no-daemon` agent.
  - With the Codex worker parked, Stop of a shared-server conversation fails closed: the pane stays,
    the agent stays, and the failure is logged.
  - Explicit inline mode closes through the core's own control.
- **Unchanged suites.** `e2e/enginehomes.e2e.ts` (the moved shared server: activity, resources, close)
  runs unchanged.

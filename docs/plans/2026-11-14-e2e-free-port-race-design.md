# E2E harness: learn the port a process bound, never pick one ahead

## Why

`cli/e2e/harness/daemon.ts` `freePort()` opens a listener on port 0, reads the port, closes it and hands the number to
the daemon as `PORT`. Between the close and the daemon's bind, any process can take that port. On cli-e2e run
43568618113 (shard 2), `turns.e2e.ts` "claude: a /goal that pauses after its hook refuses to stop…" timed out: the
daemon logged `control port 34881 unavailable; assigning a separate port`, listened on 42457, and the harness kept
polling 34881. A flaky test is a bug: the fix removes the race at the layer where it lives, with no retry and no longer
timeout, and covers every e2e helper that picks a port the same way.

## What picks a port ahead today

| Helper | Port | What it is used for |
|---|---|---|
| `e2e/harness/daemon.ts` `freePort()` | the daemon's `PORT` (hook/control HTTP server) | the socket name `daemon-<PORT>.sock`, `/api/health` polling, `LocalClient`'s TCP url, every test's `d.port` fetches |
| `e2e/harness/realBackend.ts` `freePort()` | the backend's `PORT` and `PORT_APP_PROXY` | `backend.url` / `wsUrl`; the app proxy is not used by any test |
| `e2e/cloudAgents.e2e.ts` `freePort()` | `HARNESS_CONNECTIONS_PORT` (the connections bridge) | nothing in the test; a leftover from before the harness defaulted it to `'0'` (#4027). Cloud agents reach the bridge over its socket on macOS and Linux (`cloud/bridge.ts`) |

Every other `listen(0)` in `e2e/` keeps its listener open and reads its address, which has no race.

## Approaches

1. **Learn the bound port (chosen).** The process binds what it can and the harness reads the port it reports.
   The daemon already does the right thing on `EADDRINUSE` (falls back to an ephemeral port, keeps its socket name
   from the configured port) and logs `[hooks] listening on 127.0.0.1:<actual>`; the backend accepts `PORT=0`.
2. Hold the probe listener open and hand it over as a file descriptor. Neither the daemon nor the backend can listen on
   an inherited descriptor; adding that is product code for a test's sake.
3. Pick ports from a per-worker range. Still races with anything else on the machine (ephemeral ports of other
   processes); it only makes the collision rarer.

## Design

**Daemon (`e2e/harness/daemon.ts`).**
- `freePort()` stays only as the pick of a *configured* port (the `PORT` env, the socket name `daemon-<PORT>.sock`,
  artifact file names): a port that is taken by the time the daemon binds is now harmless, because the daemon falls
  back and the harness follows it.
- `IsolatedDaemon` gets `readonly configuredPort` (what `PORT` was set to; what the `port` option sets) and a `port`
  getter: the port in the last `[hooks] listening on 127.0.0.1:<n>` line of this daemon's output, so a core the master
  restarts on another port is followed too (as `corePid()` follows the last `core started`). Before any such line it
  throws `the daemon has not said which port it listens on yet`, so no caller silently uses a guess.
- `start()` waits for that line in this start's output, then polls `/api/health` on that port (same deadlines as
  today); `socketPath` and artifact names use `configuredPort`.
- The three tests that start a second daemon on the first one's port to collide with it (`lean.e2e.ts:188`,
  `twodaemons.e2e.ts:246` and `:309`) pass `configuredPort`, which is what they mean (same `PORT`, same socket).
  Everything else keeps `d.port`, which is now the port the daemon answers on.

**Real backend (`e2e/harness/realBackend.ts`, `backend/src/server.ts`).**
- The harness starts the backend with `PORT=0` and `PORT_APP_PROXY=0` and drops its `freePort()`.
- `backend/src/server.ts` logs the port it bound (`app.server.address()`), not `env.PORT`: `backend listening on
  <actual>`. The harness reads that line from `backend.log`, ending the wait at once if the backend exits first, then
  polls `/api/ready` as today. In production `PORT` is fixed, so the line reads the same.

**Cloud agents (`e2e/cloudAgents.e2e.ts`).** Drop its `freePort()` and the three `HARNESS_CONNECTIONS_PORT` overrides;
the harness's `'0'` applies.

## Tests

- Red then green, `e2e/portHolder.e2e.ts`: the existing case already holds the daemon's port with a stranger before it
  starts. It gains: `d.port` is not the held port, and a request to `d.port` reaches the daemon (its `/api/status`
  answers with the daemon's body, not the holder's `{}`). Today `d.port` is the held port: red.
- Red then green, a harness spec for the real backend (in cli-e2e's real-backend group, skipped without
  `HARNESS_E2E_SERVICES_DIR` as the other real-backend specs are): `startRealBackend` must not hand the backend a
  port someone else holds. The spec reproduces the race deterministically: the port the harness's pick would return is
  held by a stranger listener before the backend binds (for example by stubbing the `node:net` probe the pick uses so
  it reports a port the test holds; the planner picks the mechanism). It then asserts that `backend.url`'s port is the
  one the backend logged as bound (`backend listening on <n>`), that `/api/health` answers there, and that the
  stranger heard nothing. Today the backend fails with `EADDRINUSE` or the url points at the stranger: red. With the
  fix the harness picks nothing and follows the log: green. (Orchestrator's call, 2026-11-14.)
- cloudAgents: the removal is checked by `cloudAgents.e2e.ts` itself passing.

## Non-goals

- No change to the daemon's own fallback or socket naming.
- No retry, no longer timeout, no new option.

## Platforms

Test harness only (macOS and Linux run cli-e2e); the backend log line runs everywhere the backend runs.

## Decisions on the plan's questions (orchestrator, 2026-11-14)

1. `cli.e2e.ts` starts its daemon with `harness start`, so the harness sees no output: it reads the daemon's own record
   of the port it bound (follows a fallback), not `configuredPort`.
2. A daemon with no socket cannot fall back (`cli/src/hookServer.ts`, by design), so `noSocket.e2e.ts`'s first case can
   still meet a stolen port. Left as it is; the pull request names it.
3. `twodaemons.e2e.ts:309` starts `release` first and passes `release.port`, which removes its double race.
4. The scripts outside `cli/e2e/` that pick a port the same way (`cli/scripts/share-harness-e2e.ts`,
   `box-claim-e2e.ts`, `remote-viewers-stack.ts`, `local-stack-peer.ts`, `daemons/e2e/sandbox.mjs`) are fixed too, each
   with a way this branch already has (`PORT=0` and the bound port read back, or the daemon's own port record). A
   script that would need a product change or a large rewrite is left out and named in the final report.

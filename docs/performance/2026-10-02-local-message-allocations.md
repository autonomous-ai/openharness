# Local terminal message allocations — October 2, 2026

Established local WebSocket connections receive frequent synchronous JSON control
messages, including terminal acknowledgements and liveness notices. The entire
message handler was `async` even when it did no asynchronous work. This allocated
extra promises and suspension state for every such message.

The handler now returns synchronously for those paths. Handshake and task routing
retain their asynchronous handlers; binary operations and remote forwarding return
their existing promises. The same per-connection promise chain still serializes
all messages and catches failures. Routing callbacks retain their original receiver.
No wire format, authorization, heartbeat, buffering, or terminal scheduling changes.

## Measured result

[Raw measurements](2026-10-02-local-message-allocations.json) compare
`aad71fc576a0a9b0d9b52a2b206d02d08b481967` with the changed handler, on macOS ARM64,
Node 22.23.2. Both variants are minified with esbuild, use the same dependency graph,
and run in fresh processes. Six paired timing trials alternate baseline/candidate
order; three separate paired trials sample allocations. Each trial warms up first.

| Workload | Metric, median | Before | After | Change |
| --- | --- | ---: | ---: | ---: |
| 6,000 messages, one at a time | Estimated allocated bytes | 54,923,744 | 50,293,944 | 8.4% less |
| Same | Process CPU | 223.16 ms | 225.69 ms | 1.1% more |
| Same | Elapsed | 183.29 ms | 188.87 ms | 3.0% more |
| 60,000 messages, batches of 100 | Estimated allocated bytes | 223,778,336 | 179,608,824 | 19.7% less |
| Same | Process CPU | 257.61 ms | 250.08 ms | 2.9% less |
| Same | Elapsed | 245.79 ms | 243.56 ms | 0.9% less |

This is a component allocation improvement. CPU savings are small and were not
consistent across traffic shapes. The one-at-a-time elapsed increase is about
0.93 microseconds per round trip. An earlier prototype comparison also reduced
allocations (6.7% / 20.3%) and had mixed timing (1.6% slower / 3.6% faster).

The benchmark uses real loopback WebSockets with synthetic acknowledgement/alive
frames and a fake backend. It asserts message sequence and type. CPU includes the
client and server; allocated bytes are sampled estimates including collected
objects, **not retained memory**. It does not measure actual terminal rendering,
agent work, whole-app battery consumption, or macOS's significant-energy label.
No live app, daemon, shared server, tmux session, or agent was changed.

Reproduce from the repository root, with dependencies already installed:

```sh
node cli/scripts/benchmark-local-ws.mjs aad71fc576a0a9b0d9b52a2b206d02d08b481967 /tmp/local-ws-comparison-new
```

The output directory must be new. Workers use private fixture directories and
loopback ports, close their sockets, and remove their fixture state. The allocation
sampler attaches in-process and never opens a debug TCP port. Each worker has a
30-second deadline, with a 35-second parent limit.

## Validation

- TypeScript typecheck passed.
- 189 tests across seven affected files passed locally, including real local and
  Unix sockets, remote/shared relays, terminal streams, and liveness behavior.
- 47 local WebSocket cases include 13 new regression cases: ordering behind slow
  local binary / remote JSON / remote binary / task routing operations; dispatch
  failures; queued frames during owned, isolated, and shared handshakes; and
  releasing late-acquired relays after disconnect.
- Two new disconnect fixtures initially resumed before server close; they now wait
  for the server-side close. The failed and passing receipts are retained in the
  machine-readable record.
- Required full CLI suite and OS/Node matrix run in CI before merge; its result is
  recorded on the PR. No desktop rendering code or engine lifecycle changed.

Local validation completed at 17:28:09 UTC. The exact original user request time is
unavailable in this task context. Merge time and CI evidence belong to the PR;
publication is intentionally excluded because the user requested a weekend hold.

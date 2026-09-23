# Remote terminal latency by verified transport

**Measurement checkpoint: the 18-trial series is still running.** Raw observations
are saved incrementally. The [manifest](2026-09-23-transport-data/manifest.json)
states whether the series is complete and lists missing trials. Final pooled
results will replace this checkpoint before the PR is marked ready.

The question is how the same remote terminal behaves over direct P2P,
Cloudflare TURN, and the Harness WebSocket relay. Comparing Office on one route
with Home on another cannot isolate that difference.

## Workload and boundaries

Each of the two linked iMacs gets three trials per requested route. Route order
rotates between repetitions and target order alternates. A trial creates one
disposable terminal, runs a raw-mode Python echo probe, and deletes only that
terminal. Existing sessions and installed daemon settings remain unchanged.

There are ten warmups and 200 measured one-byte echoes per workload, first idle
and then during a requested 20 Hz ANSI redraw. Matching nonce/sequence/byte
responses verify delivery. Achieved decoded bytes and duration are recorded;
the repetitive compressible workload is not a saturation benchmark. Thirty
machine capability RPCs run separately, with three excluded warmups.

The timing boundary is client binary input send to matching PTY response
received. It includes encryption, transport, remote daemon/PTY work, and the
return path. It excludes physical keyboard input, desktop rendering, display
presentation, and agent/model work. Percentiles from those separate stages
cannot be added into an end-to-end p95.

This uses production `RemoteRelayPool` and wire code from `0ee69791`, hosted in
the benchmark process behind an ephemeral loopback WebSocket. It shares one
Node event loop between client and transport. The installed local daemon
(0.2.99 at the start) supplies existing login/trust context but is not on the
measured data path. Compare these route trials to each other; they are not a
before/after speedup relative to the earlier installed-daemon results.

## How a route is proven

- **Direct P2P:** TURN credentials are removed from this isolated offer policy.
  Both nominated ICE candidate types must be non-relay. Production negotiation
  and data handling are otherwise used. This deliberately restricted trial
  measures an available direct path, not automatic route-selection success.
- **Cloudflare TURN:** the existing relay-only ICE diagnostic flag applies only
  to this benchmark process. The nominated pair must contain a relay candidate;
  configured TURN service hosts must belong to Cloudflare.
- **Harness relay:** this isolated pool has P2P disabled, including its retry
  path. Terminal input and output must use the backend WebSocket.

Every echo records the selected pair's candidate types/protocols, stream route
membership, migration state, and actual binary send/delivery counters for both
paths. An accepted observation needs one input send and a matching response on
the requested path, with no opposite-path binary traffic. Missing candidate
evidence, a transition, or fallback cannot be counted as a requested-route
latency. Candidate IP addresses, ports, authentication, and terminal output are
excluded from published evidence.

The adapter inspects the pinned werift/transport implementation and adds counters
only to its own pool. It reads existing identity/authentication and keeps a trust
snapshot in memory. It cannot refresh or clear login, change saved trust, or
replace the desktop's connections. Revalidate the instrumentation after changes
to the underlying transport implementation.

## Availability and limitations

Calibration established both relay paths on Office. A normal automatic offer
selected a pair with a **remote relay candidate**, so the requested direct-P2P
calibration was rejected rather than relabeled. Direct-only offers to both
iMacs then timed out; the repeated series retains these attempts as availability
results instead of assigning zero latency or substituting a fallback's timing.

Production's ICE negotiation budget is 25 seconds. This probe waits up to 35
seconds after its PTY starts for the requested route. These are different
boundaries; neither timeout is a measured application recovery percentile.
Network conditions may differ on a later run. Failures here do not establish
which firewall, NAT, interface, or implementation caused the missing direct path.

The earlier Office row was **reported P2P** by the daemon, without recorded ICE
pair evidence. It remains a historical observation in the
[core-experience report](2026-09-23-core-experiences.md), not a verified direct-P2P
baseline for this comparison.

Calibration runs and their sanitized negotiation traces are retained in the
[diagnostic ledger](2026-09-23-transport-data/diagnostics/ledger.json). They use
five measured echoes per workload when a route is available; they are excluded
from the repeated-series latency distributions.

## Reproduction and artifacts

See the [probe and serial runner instructions](../../cli/scripts/benchmark-terminal-latency.md).
The [trial plan](2026-09-23-transport-data/plan.json) fixes order, sample counts,
and source revision. Warmups, outliers, and failed trials are retained. Artifacts
with failed setup may omit a shell-output diagnostic tail; the manifest records
each removed field and SHA-256 before/after publication. Private console logs
are not copied to the repository.

```sh
python3 cli/scripts/summarize-route-benchmarks.py \
  docs/performance/2026-09-23-transport-data
```

The reducer pools individual verified observations, never averages percentiles,
counts failed trials/echoes separately, and refuses an incomplete matrix unless
`--allow-partial` is explicitly used to inspect a checkpoint.

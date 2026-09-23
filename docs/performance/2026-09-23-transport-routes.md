# Remote terminal latency by verified transport

Verified Office terminal echo medians were **14.6 ms over direct P2P**, **109.8 ms
through Cloudflare TURN**, and **401.4 ms through the Harness WebSocket relay**.
Direct-only negotiation succeeded in one of three Office trials and none of three
Home trials. Both relay paths completed all three trials on both targets.

All **5,200 measured echoes** and **390 measured control requests** completed.
All 18 series terminals and all five calibration terminals were deleted. Five
unavailable direct-path trials are retained alongside the successful timings.
This is a transport baseline for prioritizing improvements, with explicit path
availability and timing boundaries.

The question is how the same remote terminal behaves over direct P2P,
Cloudflare TURN, and the Harness WebSocket relay. Comparing Office on one route
with Home on another cannot isolate that difference.

## Requested-route availability

| Target | Requested route | Completed trials | Measured echoes |
|---|---|---:|---:|
| Office iMac | Direct P2P | 1/3 | 400 |
| Office iMac | Cloudflare TURN | 3/3 | 1,200 |
| Office iMac | Harness relay | 3/3 | 1,200 |
| Home iMac | Direct P2P | 0/3 | 0 |
| Home iMac | Cloudflare TURN | 3/3 | 1,200 |
| Home iMac | Harness relay | 3/3 | 1,200 |

Availability describes the requested path. All five failed direct-only attempts
reached their PTYs through the fallback WebSocket relay while negotiation ran.

## Verified terminal echo latency

Times are milliseconds. Each workload has 200 measured echoes per successful trial. Warmups are excluded; every accepted outlier is retained. P2P has one successful trial, so its tail estimates have less support than the three-trial relay results.

| Target / route | Workload | n | Median | p95 | p99 | Maximum | >250 ms |
|---|---|---:|---:|---:|---:|---:|---:|
| Office iMac / Direct P2P | Idle | 200 | 14.60 | 135.02 | 146.81 | 153.10 | 0/200 |
| Office iMac / Direct P2P | 20 Hz redraw | 200 | 17.03 | 37.70 | 68.28 | 70.79 | 0/200 |
| Office iMac / Cloudflare TURN | Idle | 600 | 109.81 | 163.81 | 315.72 | 1087.25 | 12/600 |
| Office iMac / Cloudflare TURN | 20 Hz redraw | 600 | 110.41 | 175.91 | 313.68 | 318.88 | 18/600 |
| Office iMac / Harness relay | Idle | 600 | 401.39 | 504.67 | 593.23 | 667.41 | 600/600 |
| Office iMac / Harness relay | 20 Hz redraw | 600 | 403.39 | 511.98 | 592.43 | 669.52 | 600/600 |
| Home iMac / Cloudflare TURN | Idle | 600 | 108.53 | 167.83 | 296.72 | 317.37 | 12/600 |
| Home iMac / Cloudflare TURN | 20 Hz redraw | 600 | 109.80 | 180.17 | 318.27 | 322.86 | 21/600 |
| Home iMac / Harness relay | Idle | 600 | 384.65 | 503.28 | 586.33 | 616.92 | 600/600 |
| Home iMac / Harness relay | 20 Hz redraw | 600 | 387.44 | 501.09 | 591.95 | 670.81 | 600/600 |

## Machine control requests

These streamless capability RPCs are application request/response timings, not network pings. They are measured separately from typing. The outgoing control request stays on the backend WebSocket even when terminal data uses a faster channel; these are not route-pinned control-RPC comparisons.

| Target / terminal route | n | Median | p95 | p99 | Maximum |
|---|---:|---:|---:|---:|---:|
| Office iMac / Direct P2P | 30 | 401.04 | 453.75 | 458.99 | 458.99 |
| Office iMac / Cloudflare TURN | 90 | 402.11 | 476.68 | 534.71 | 534.71 |
| Office iMac / Harness relay | 90 | 403.12 | 445.41 | 531.65 | 531.65 |
| Home iMac / Cloudflare TURN | 90 | 387.41 | 459.37 | 823.38 | 823.38 |
| Home iMac / Harness relay | 90 | 387.77 | 506.97 | 537.26 | 537.26 |

## Setup and warm reattachment

Each cell is the observed minimum–maximum in milliseconds. There are only three successful observations per relay route and one for direct P2P; these are not reliable setup/recovery percentiles. Setup can use the initial WebSocket path and involve migration. Warm reattachment opens a new local client socket on the same pool/route and verifies the next byte in the same running probe; it does not simulate a network outage or a GUI session-picker action.

| Target / requested route | n | Cold control-ready | Create terminal | Attach terminal | Warm reattach + echo |
|---|---:|---:|---:|---:|---:|
| Office iMac / Direct P2P | 1 | 1669 | 575 | 80 | 65 |
| Office iMac / Cloudflare TURN | 3 | 1690–1939 | 573–796 | 934–1584 | 221–248 |
| Office iMac / Harness relay | 3 | 1675–2241 | 582–594 | 417–478 | 812–836 |
| Home iMac / Cloudflare TURN | 3 | 1645–2264 | 555–590 | 2894–2910 | 225–279 |
| Home iMac / Harness relay | 3 | 1638–1748 | 423–646 | 387–403 | 784–846 |

Cold control-ready includes machine selection and the first remote capability
response. Attach ends at `terminal_ready`, which can arrive over the fallback
path. In all three Home TURN trials, reaching the requested path took another
**4,284–4,364 ms after the probe was ready**. That settling wait is excluded from
the typing distributions and retained as `stagesMs.waitForRequestedRoute` in
each artifact. A short steady-state echo does not imply a short cold connection.

## Achieved output

Decoded byte rates during the redraw phase, in decimal kB/s. The compressible 20 Hz payload is a typing-under-output workload, not a throughput ceiling.

| Target / route | Observed decoded kB/s range |
|---|---:|
| Office iMac / Direct P2P | 79.6 |
| Office iMac / Cloudflare TURN | 77.6–78.5 |
| Office iMac / Harness relay | 77.5–78.0 |
| Home iMac / Cloudflare TURN | 77.7–77.9 |
| Home iMac / Harness relay | 76.6–77.6 |

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

The client is an Apple M2 Max with 12 CPU cores and 64 GiB RAM, running macOS
26.6.2 and Node 22.23.1. The measured werift dependency is 0.24.4. Both remote
probes report Darwin/x86_64 and terminal protocol 3; their daemon build revisions
are not inferred from the client's checkout. The workstation has other
applications and sessions running. Remote host load and network conditions were
not controlled or replayed. See the [environment record](2026-09-23-transport-data/diagnostics/environment.json).

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
iMacs then timed out during calibration. The repeated series subsequently
established Office P2P once; its other five direct-only attempts timed out.
Every attempt is retained, with no zero-latency or fallback substitution.

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

## What matters next

1. **Make the fast path dependable.** The successful Office P2P run was quick,
   while five direct-only attempts could not establish that path. These are six
   trials on two targets, not a population-wide availability estimate. Preserve
   fallback usability while investigating negotiation and candidate reachability.
2. **Reduce relay and control-path delay.** Every measured Harness-relay echo
   exceeded 250 ms. Control RPC medians remained around 387–403 ms even when
   terminal traffic used a faster path. Session opening/creation needs its own
   measurements; a fast steady-state typing result does not cover those steps.
3. **Keep tails and setup visible.** Office TURN had a **1,087 ms** idle echo,
   retained in the results. P2P's 135 ms idle p95 also matters alongside its
   14.6 ms median. Different sampling periods and one successful P2P trial do not
   establish that redraw improves latency. The several-second attach/setup
   observations deserve follow-up independently of the typing median.

The resource boundary is unchanged: the earlier **213 MiB** result measured the
**desktop process**, including terminal rendering and scrollback. Claude Code,
Codex, shells, tmux, and the Harness daemon were outside that process counter.
Their usage must be reported separately, as specified in the
[resource-accounting plan](2026-09-23-core-experiences.md#desktop-process-resources).
Startup remains a priority; install time is outside the performance scorecard.

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

Validation: four route-proof tests and a strict TypeScript check pass. The reducer
independently validates every accepted observation, workload count, and source
revision. Published trial objects match their originals after only the recorded
diagnostic removals; all manifest hashes verify. A final read-only inventory
audit found no disposable probe sessions on either remote machine:
[cleanup audit](2026-09-23-transport-data/diagnostics/cleanup-audit.json).

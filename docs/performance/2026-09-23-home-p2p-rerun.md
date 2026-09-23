# Home iMac direct P2P: follow-up measurements

**Direct P2P did not establish in any of six follow-up trials.** Combined with the
[original comparison](2026-09-23-transport-routes.md), this is **0/9 attempts** on
the Home iMac across three series. The README now includes all three series in its
availability count. There are no verified Home P2P echoes from which to calculate
a median or tail latency.

Two series of three trials ran serially on September 23, 2026, from **22:40:36 to
22:42:41 UTC** and **22:56:28 to 22:58:33 UTC**. Each created a disposable
terminal, started the Python probe,
and reached it through the Harness WebSocket relay while attempting direct
negotiation. Every terminal was deleted afterward.

| Series / trial | Direct negotiation timeout | Wait after probe readiness | Route at end of wait | Terminal deleted |
|---|---:|---:|---|---|
| First retry / 1 | 25,000 ms | 35,061 ms | Harness relay | Yes |
| First retry / 2 | 25,000 ms | 35,052 ms | Harness relay | Yes |
| First retry / 3 | 25,001 ms | 35,033 ms | Harness relay | Yes |
| Second retry / 1 | 25,001 ms | 35,076 ms | Harness relay | Yes |
| Second retry / 2 | 25,002 ms | 35,092 ms | Harness relay | Yes |
| Second retry / 3 | 25,001 ms | 35,035 ms | Harness relay | Yes |

These are setup timings. Negotiation starts before probe readiness, so the
two timing columns have different start points. Neither is a terminal echo
latency or an application outage duration.

## What the observations establish

All six negotiations received an answer and reported host and server-reflexive
candidate types on both sides, then timed out while reporting `ice=connecting`.
At the end of the probe's 35-second route wait, each trial recorded no nominated
candidate pair, no ready data channel, and zero binary sends or deliveries over
P2P. Probe startup traffic used the relay in both directions. The
[first](2026-09-23-home-p2p-rerun-data/negotiation.json) and
[second](2026-09-23-home-p2p-retry2-data/negotiation.json) negotiation records preserve
those facts from the private logs without machine identifiers or candidate addresses.

The results establish that a direct path was unavailable under these test
conditions. They do not isolate a firewall, NAT, network interface, or
implementation as the cause. Terminal creation and probe startup succeeded;
the failure was specific to establishing the requested direct route.

The planned workload was 200 measured echoes at idle and 200 during a 20 Hz
redraw, plus 30 control requests per successful trial. The route check stopped
all six trials before those measurement phases, leaving **zero measured echoes
and zero measured control requests** in these follow-ups. Relay startup responses are
not included as P2P observations. The earlier 5,200 echoes and 390 control
measurements remain the latency data in the README.

## Method and environment

The [first plan](2026-09-23-home-p2p-rerun-data/plan.json) and
[second plan](2026-09-23-home-p2p-retry2-data/plan.json) each fixed three attempts
before their first connection. No attempt was discarded or replaced. The source
revisions were `d98b3531748a8a927b7b39711822fc5c472bf8ee` and
`853239bb737599d71a659889e8315a9e3beb6d31`, respectively. Product and benchmark
source were unchanged between the two reruns; the route-proof checks passed
before the first. The same isolated production transport method as
the original comparison removed TURN credentials for each direct-only offer
and required a nominated pair with no relay candidate before measuring echoes.

The client was an Apple M2 Max with 64 GiB RAM, macOS 26.6.2, Node 22.23.1, and
werift 0.24.4. The remote probe reported Darwin/x86_64 and terminal protocol 3.
The installed local daemon reported 0.2.99 and was outside the measured
transport path. The environment records for the
[first](2026-09-23-home-p2p-rerun-data/environment.json) and
[second](2026-09-23-home-p2p-retry2-data/environment.json) reruns note that other
applications and sessions remained running; network conditions
and remote load were not controlled. These attempts do not establish a general
P2P success rate across users or networks.

All six deletion replies confirmed cleanup. Separate read-only inventory audits
at [22:44 UTC](2026-09-23-home-p2p-rerun-data/cleanup-audit.json) and
[22:59 UTC](2026-09-23-home-p2p-retry2-data/cleanup-audit.json) found zero disposable
probes remaining on Home.

## Artifacts and reproduction

The [first manifest](2026-09-23-home-p2p-rerun-data/manifest.json) and
[second manifest](2026-09-23-home-p2p-retry2-data/manifest.json) record SHA-256 hashes
and explicit redactions. Only shell-output diagnostic tails were removed from
the six trial results; their timing, route evidence, errors, and cleanup
records are preserved. Console logs remain private, with selected negotiation
facts published separately.

Use the [real terminal probe](../../cli/scripts/benchmark-terminal-latency.md)
with `--route p2p`, a linked Home machine ID, 200 samples and 30 control samples.
Keep each of three serial attempts in a fresh file and retain failed attempts.
Validate the published series with:

```sh
python3 cli/scripts/summarize-route-benchmarks.py \
  docs/performance/2026-09-23-home-p2p-rerun-data

python3 cli/scripts/summarize-route-benchmarks.py \
  docs/performance/2026-09-23-home-p2p-retry2-data
```

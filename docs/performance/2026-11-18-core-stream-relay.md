# Shared stream relay attribution — 2026-11-18

One corrected fixed ABBA run completed with outer exit 0 and all four child exits 0. Each child and guardian was reaped, both pipes reached EOF, the owned process group was gone, and its private root was removed. All 146 frozen runtime/source/helper hashes were unchanged before and after each arm. No retry was run.

Baseline `0c190a62ae26d614d975d7c20f31762d07b2e4aa`; candidate runtime `dc19f69f6a144dafbcbe62312e21e326fbfc9e38`. Pinned Node v24.22.2 darwin-x64. Both bundles use production node20/minify/keepNames transforms. Corrected common fixture: `cli/scripts/client-stream-benchmark.ts`. Frozen packet `/tmp/core-stream-attribution-packet-20261118f`; reports `/tmp/core-stream-attribution-results-20261118f`.

Each steady case uses 128 warmup and 8192 measured cycles with 32 KiB payloads. Browser performs one binary screen output and one ACK. Viewer performs client data, service data and ACK. All exact-counter, public-ID, payload and binary-buffer-identity assertions passed. Every latency sample is retained in the four arm JSON files.

## Scope and fixture correction

This measures factory relay work with synchronous accepting transport stubs. It excludes serialization, actual sockets, service processes, daemon RSS and terminal echo. Both sides construct the same synthetic incoming Viewer payload inside the measured loop; that matched cost is not work performed by the production service grant adapter, which wraps its existing payload.

The first d comparison and e diagnostic remain recorded, not accepted. Their candidate fixture rebuilt endpoint functions on each data/ACK; the old Browser stub also rebuilt its port. Production constructs both once (`core/main.ts:1283`, old `core/main.ts:1294` / `agentBrowserLink.ts:50`). The e CPU profile attributed 788.658 ms of sampled cycle stack time to endpoint function naming in the keepNames build. The f fixture caches these objects and matches incoming payload construction; no product runtime was optimized in response to the artifact.

## All paired results

Values in each cell are A0, B1, B2, A3. Pair changes are B1/A0 and B2/A3. CPU/elapsed cover the whole measured loop; p50/p95 are per cycle, including identical timing instrumentation.

| Agents / streams / consumer | CPU ms | CPU changes | Elapsed ms | p50 µs | p95 µs | p95 changes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 / 1 / browser | 29.885, 29.696, 30.893, 29.4 | -0.6, 5.1% | 21.463, 22.232, 22.617, 21.28 | 2.076, 2.124, 2.141, 2.054 | 4.007, 4.262, 4.272, 3.906 | 6.4, 9.4% |
| 1 / 1 / viewer | 6.259, 11.945, 11.967, 6.264 | 90.8, 91% | 2.56, 6.228, 6.13, 2.516 | 0.169, 0.531, 0.522, 0.171 | 0.469, 1.185, 1.25, 0.472 | 152.7, 164.8% |
| 1 / 4 / browser | 25.693, 27.226, 27.18, 25.261 | 6, 7.6% | 19.277, 21.184, 21.183, 18.961 | 1.986, 2.21, 2.151, 1.985 | 2.805, 3.191, 3.278, 2.773 | 13.8, 18.2% |
| 1 / 4 / viewer | 6.648, 11.408, 9.868, 6.524 | 71.6, 51.3% | 3.14, 6.511, 6.405, 3.079 | 0.303, 0.562, 0.564, 0.3 | 0.514, 1.283, 1.246, 0.509 | 149.6, 144.8% |
| 16 / 1 / browser | 21.4, 23.231, 23.465, 20.922 | 8.6, 12.2% | 19.291, 21.159, 21.438, 18.864 | 2.037, 2.179, 2.235, 2.019 | 3.799, 4.111, 4.231, 3.673 | 8.2, 15.2% |
| 16 / 1 / viewer | 7.847, 13.425, 12.542, 7.617 | 71.1, 64.7% | 3.199, 6.486, 6.395, 3.201 | 0.302, 0.613, 0.618, 0.299 | 0.551, 1.074, 1.056, 0.547 | 94.9, 93.1% |
| 16 / 4 / browser | 21.511, 22.123, 22.263, 21.2 | 2.8, 5% | 18.671, 20.077, 20.351, 18.435 | 2.145, 2.294, 2.334, 2.108 | 2.298, 2.614, 2.64, 2.273 | 13.8, 16.1% |
| 16 / 4 / viewer | 6.729, 9.599, 8.251, 6.472 | 42.7, 27.5% | 3.643, 6.063, 5.754, 3.587 | 0.382, 0.514, 0.491, 0.384 | 0.559, 1.13, 1.085, 0.557 | 102.1, 94.8% |
| 160 / 1 / browser | 20.801, 23.092, 22.851, 20.084 | 11, 13.8% | 18.565, 19.917, 20.026, 18.053 | 2.108, 2.225, 2.288, 2.079 | 2.278, 2.61, 2.609, 2.216 | 14.6, 17.7% |
| 160 / 1 / viewer | 5.995, 9.557, 9.392, 6.057 | 59.4, 55.1% | 3.443, 6.321, 6.22, 3.46 | 0.295, 0.6, 0.604, 0.299 | 0.54, 1.006, 1.006, 0.539 | 86.3, 86.6% |
| 160 / 4 / browser | 20.809, 22.633, 22.588, 20.125 | 8.8, 12.2% | 19.229, 21.121, 21.237, 18.661 | 2.19, 2.387, 2.44, 2.149 | 2.347, 2.709, 2.676, 2.285 | 15.4, 17.1% |
| 160 / 4 / viewer | 5.988, 8.161, 8.424, 5.815 | 36.3, 44.9% | 3.168, 5.555, 5.458, 3.109 | 0.271, 0.461, 0.468, 0.271 | 0.555, 1.137, 1.116, 0.556 | 104.9, 100.7% |

The corrected shared relay costs more CPU in most cases. Viewer p95 grows by roughly 0.45–0.78 µs per three-operation cycle; Browser p95 grows by roughly 0.26–0.51 µs per output/ACK cycle. Grant ownership, service incarnation and private/public ID translation remain enforced. These absolute and relative costs are both reported; neither is a native latency acceptance claim.

## Cap and queue probes

| Probe | Candidate high-water / attempts | Retained heap bytes B1 / B2 | Process RSS delta bytes B1 / B2 | Scope |
| --- | --- | --- | --- | --- |
| live | 2048 / 4097 | 1632688 / 1632688 | 3297280 / 3342336 | 64 × 64 panel attempts plus overflow; 2048 accepted, 2049 refused. |
| viewer-live | 256 / 257 | -1422656 / -1426400 | -466944 / -466944 | 256 admitted, one refused; synthetic baseline lacks real service256/64 cap. |
| pending | 512 / 513 | 371272 / 371048 | 20480 / 0 | 512 admitted, one refused; 8/connection retained. |
| ids | 16 / 24 | -216168 / -216168 | 0 / 98304 | 16 × 524000-byte IDs admitted, eight refused; strings prebuilt and excluded; direct core ingress. |
| first-start-frames | 4096 / 4098 | 673696 / 673696 | 49152 / 49152 | 4096 held frames before overflow; overflow revokes and releases stream. |
| first-start-bytes | 128 / 258 | 2045728 / 2045728 | 3530752 / 3932160 | 128 held frames before UTF-8 byte overflow; includes127 ×32KiB payloads. |
| transport-count | 4096 / 4097 | 537384 / 537384 | 12288 / 16384 | 4096 release closures /147456 queued bytes; no socket/payload allocation. |
| transport-bytes | 127 / 129 | 12392 / 12392 | 0 / 0 | 127 release closures /4166108 queued bytes; no socket/payload allocation. |

All cap refusal/recovery and late-callback assertions passed. Sequential V8 memory deltas can be negative because prior fixtures become collectable between readings. In particular, the Viewer and prebuilt-ID samples do not establish absolute retained-memory bounds; small steady-state RSS deltas are allocator noise. Repeatable positive high-water samples support attribution, not final capacity acceptance. The Browser caps remain explicit new safety budgets, not a derived maximum supported workload. The native gate must separately validate process isolation, cleanup, actual stream traffic and the core memory/terminal targets.

Raw receipts, all samples and comparison tables remain in the f report directory. Prior d/e results and CPU profiles remain in their separate directories. The final combined core/services gate and packaged native validation are owned by the integration run.

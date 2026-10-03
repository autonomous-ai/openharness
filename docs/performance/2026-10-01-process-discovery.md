# Process discovery: read only the necessary argument prefix

An allocation trace of the development daemon on October 1 attributed an estimated
89.1 MiB of 669.8 MiB sampled allocations (13.3%) to process-entrypoint parsing over
30 seconds. The trace includes objects collected during the interval. The daemon's
large heap decreased during profiling; this did not establish a persistent leak,
and that decrease is not an optimization result.

The process matcher checked each candidate engine by tokenizing the entire command
line again. Shell wrappers and tool arguments therefore generated many temporary
matches even though discovery only needed the executable prefix. It now reads tokens
on demand, retaining the exact existing quoting rules. Cursor still examines at most
eight tokens; Hermes still validates its actual launcher source. Full argv parsing
remains available to resume and permission handling. No cross-scan cache is added,
and process identities, file ownership, aliases, polling cadence and launch behavior
are unchanged.

## Measurements against CLI 0.3.46

The [raw samples](2026-10-01-process-discovery-data/native-macos.json) compare the
released matcher and discovery module at `c1ab7ff1c9a26dba7fb6a27c45e6abd76b90b92d`
with the changed code. Both use identical dependencies and tooling, bundled into
private temporary files. Each fixture contains 1,022 synthetic process rows and
1, 16 or 105 terminal roots. Each root has a shell, an agent and two tool children;
wrapper/tool arguments are either short or about 4 KB. The latter size reflects
argument lengths observed on the development machine; the contents are synthetic.

Measurements used the managed Node 22.23.2 runtime on macOS ARM64, 30 warmups and
30 alternating rounds of five full discovery scans per version. No other tests or
builds owned by this task ran during the final timing loop. Other workstation apps
were still running. These are Node CPU totals divided by 150 scans:

| Arguments | Panes | Previous CPU/scan | Changed CPU/scan | Reduction |
| --- | ---: | ---: | ---: | ---: |
| short-arguments | 1 | 0.120 ms | 0.112 ms | 6.8% |
| short-arguments | 16 | 0.690 ms | 0.605 ms | 12.3% |
| short-arguments | 105 | 3.716 ms | 2.834 ms | 23.7% |
| wrapper-4k | 1 | 0.742 ms | 0.073 ms | 90.2% |
| wrapper-4k | 16 | 11.305 ms | 0.475 ms | 95.8% |
| wrapper-4k | 105 | 81.558 ms | 2.882 ms | 96.5% |

This measures process matching and full in-memory discovery, including allocation
and garbage collection. It excludes collecting the OS process table, tmux calls,
networking, rendering and battery. It does not establish a whole-app CPU, RAM or
100-fold improvement. The initial generator-based experiment was rejected because
it slowed short argument lists; the final direct token reader improved both cases.

## Correctness and reproduction

From `cli/`:

```sh
node --import tsx scripts/process-discovery-bench.ts /tmp/discovery.json
npx vitest run src/lib/processArgv.spec.ts src/lib/tmux.spec.ts src/lib/tmuxAgentDiscovery.spec.ts src/lib/terminalAgentDiscovery.spec.ts src/lib/terminalAgentReconciler.spec.ts
node --import tsx scripts/resume-native-e2e.ts
node --import tsx scripts/check-native-fixture-git.mjs
```

The benchmark compares 2,000 deterministic argument cases against the exact
released matcher for every supported process engine, including incomplete quotes,
empty tokens, wrappers, interpreter options and ambiguous aliases. It also compares
the complete discovered agents and placements before measuring each fixture.
All 224 expanded matcher/discovery tests and TypeScript checks passed (one
platform-specific case was skipped on macOS). The expanded checks require normal
process access: the sandboxed attempt rejected six `ps` probes; the same tests
passed outside that restriction. On macOS, the private native
fixture passed with Claude Code 2.1.286 and Codex 0.159.3: the live coordinator
identified the exact resumed process, history and hooks were retained, and three
close/checkpoint/resume cycles passed for each engine. It also verified receipt
replay, attach-to-existing-process behavior, missing-ID recovery, deferred-close
persistence/cancellation, and preservation of a neighboring pane and surviving
shell. This uses disposable profiles and a loopback-only unavailable model provider;
it does not measure inference, browser rendering, or every installed engine.

The native fixture also checks for optional plugin Git fetches left behind by its
Codex processes. Cleanup is restricted to Git processes whose working directory
is inside that invocation's temporary root, with PID/start-marker/executable
revalidation before signaling. An attempted Git proxy environment override did
not prevent those fetches and was removed. This fixture cleanup is separate from
production session shutdown; further investigation of orphaned helpers remains.

The controlled cleanup check starts two Git requests against its own stalled
loopback HTTP server. It verified that three processes inside the fixture exited
and the neighboring Git request stayed alive until the check closed its server.
This check also runs on both Linux CI architectures. The final macOS lifecycle
run left no fixture Git processes or temporary profile in an independent audit.

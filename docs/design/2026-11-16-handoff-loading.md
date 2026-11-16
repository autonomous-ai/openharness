# Load Change agent's publication code when it is used

Package 11 remains open. This first slice removes the handoff transaction from the default core's
loaded code; it does not move its final authority or filesystem transaction into another process.

## Design

The reason for #1145 still holds. A service can be suspended after an approval, while the selected
conversation or originating owner request changes. Its later filesystem write cannot rely on that
old approval. Current core authority and the final synchronous check/link/rename therefore remain
together. History interpretation, redaction, rendering and Git commands already run in edge.

The existing asynchronous `conversationReads` facade becomes the loading door. It receives the same
`HandoffWiring` and data directory that `main.ts` currently passes to `createHandoffDependencies`.
The first query imports that composition and constructs it once. Concurrent first queries await the
same initialization; every later query uses the same discovery and publisher witnesses. Loading only
at publish, or constructing a publisher per query, would lose the observations that authorize commit.
There is no top-level await in the daemon's startup wiring.

An initialization failure logs only `HANDOFF_UNAVAILABLE` and rejects the requesting query with that
named hold. It never becomes empty history. The failed initialization is discarded so a later caller
may try again, with no automatic retry loop. An ESM evaluation failure may remain unavailable until
restart. Normal turns, input, Stop and readiness never call or wait for this door.

The import walker excludes only `core/conversationQueries.ts`'s dynamic import of
`core/handoffDependencies.ts`. A static import, a different importer or another target is still
walked. Its warmed closure remains checked and reported. The cold reduction is eight files:
`core/handoffDependencies.ts`, `core/handoffPublication.ts`, `lib/handoffDiscovery.ts`,
`lib/handoffPublication.ts`, `lib/handoffFiles.ts`, `lib/handoffValidation.ts`, `lib/handoffGit.ts` and
`lib/subagentTranscript.ts`. Against the pre-runtime checkpoint, cold load changes from 541 files /
92,752 lines to 533 / 91,993; the handoff-warmed load is 541 / 92,764. Physical source counts are
informational, not runtime performance evidence. The test requires the exact warmed-minus-cold file
set and rejects another target hidden behind the same door.

| Question | Decision |
| --- | --- |
| Growth | No new persisted data, cache, timer, queue, witness map or registry mirror. One dependency instance and its initialization promise replace one eager instance. Existing discovery/selection maps stay capped at 128 each. Existing receipt/stage lifetime growth remains an open package 11 limitation. |
| Concurrency | Concurrent initialization shares one promise. Existing project/receipt/exclusion locks and final publication guards are unchanged. A failed attempt settles before a later caller can create another. |
| Read cost | No additional data read, scan or polling. All existing query and publication reads retain their scope; stopped-owner discovery still scans its existing stopped IDs. |
| Scale | Loading occurs once per daemon facade. No claim of a new 10x margin. Startup/first-query CPU, RSS and latency are measured separately from warmed publication and event-loop delay. |
| Compatibility | No backend, client, wire, CoreApi, receipt v1 or output change. Existing 5 s handoff budget and held outcomes remain. Edge, explicit inline and no-master modes use the same facade. Clients from the last 30 days keep the same contract. |
| Migration and rollback | No migration or stored-data rewrite. Reverting restores eager construction without changing receipts or output. |
| Audience | Existing owner/request/link checks remain server-side. Lazy loading grants no new access. |
| Identity | The same core-owned selected conversation, process, native file and project witnesses authorize commit. No user-home or other account fallback is added. |
| Failure | A failed door returns a named unavailable hold and a content-free log line. Existing final publication refusals and recovery remain unchanged. Ordinary agent operations do not depend on the door. |
| Platforms | Shared TypeScript affects macOS, Linux and Windows. No process start or window behavior changes. Native validation is separately reported for the platforms actually run. |

## Selected evidence

Before runtime edits, record failing caller and architecture tests. Exercise cold construction,
concurrent first queries, the same discovered/selected witness at publish, unavailable initialization,
caller-triggered retry, and request revocation while initialization is pending. Preserve existing
inline/process native output goldens and the handoff authority/recovery matrix. No output golden is
regenerated for this change.

After focused checks, run TypeScript, architecture/lean entry and the required core coverage gate at
the final source. The private daemon handoff/service-outage flow must show normal input, turn and
Stop while handoff is unavailable. Root schedules builds, full gates and native checks.

Profile current loading before changing runtime. Freeze source, bundle, fixture, Node and environment
identities; compare the same quiet workload before/after. Separate daemon startup, first handoff
query and warmed successful/same-intent publication. Retain every failed outcome and cleanup receipt;
never use profiler-overhead results as unprofiled acceptance timing.

Before runtime edits, the private composition diagnostic v2 passed on Node 24.22.2/macOS. Its four
profiled phases were import 15.460 ms / 17.842 ms CPU, construction 0.519 / 0.578, first resolve
0.159 / 0.184, and 10,000 warm resolves 3.573 / 4.944. Samples locate module compilation and the
existing dependency factory; inspector start/stop also dominates sampled totals. These numbers are
attribution only, not unprofiled acceptance or full-daemon startup. Manifest SHA256:
`755e4a9c5d7d42e9569ba8a88eea5d28251e5afceaf9d1e1ee6b662e58641028`.
The v1 fixture's missing ESM `createRequire` banner caused an import failure; its failed artifacts
remain retained, with child reap and private-root cleanup verified. Matched candidate timing,
full-daemon startup and publication acceptance are still pending.

Focused validation on macOS/Node 24.22.2: TypeScript passed; 262 tests across ten handoff
caller/authority/files/service files passed, retaining the existing native output goldens. The eight
conversation-facade tests cover its changed file at 100% statements, branches, functions and lines.
Architecture and query checks passed 33 cases. The separately included lean-entry suite failed its
sandbox `os.uptime` call with EPERM and skipped 20 cases; it is not accepted and needs a root-scheduled
run with the required OS access. The full core gate and actual private-daemon checks remain pending.

## Warm query dispatch correction

The retained matched composition run at main `1119380` and candidate `276a211` measured 10,000
warmed resolves at 4.362 and 4.910 ms CPU respectively; both pairs increased. The source awaits the
settled initialization promise on every query. This adds scheduling work after initialization and
defers the underlying read until after the caller's current turn, unlike the eager facade. These
measurements describe those builds only and do not attribute the entire CPU difference to that await.

Keep the successfully constructed dependency object beside the shared initialization promise. Each
operation uses that object immediately once ready, otherwise it awaits the same initialization as
other first callers. The methods stay asynchronous: synchronous dependency errors still reject the
returned promise. Set the ready reference only after successful construction, so a failed attempt
cannot leave a usable partial object. No authority, witness, data, lock, timer, deadline or final
publication guard changes. The design decisions above, including rollback, identity and platforms,
still apply.

Before this correction, table-driven caller tests initialize each operation, issue a warm request,
and then replace its backing conversation before yielding. The request must start against the
conversation present when called; the next request must see its replacement. They also cover every
cold entry and a synchronous dependency error through the asynchronous facade. Existing concurrent
initialization, held failure, later retry and pending-request revocation controls remain mandatory.
Root runs the red/green checks, coverage and matched cost measurement; none is claimed by this design.

The pre-correction focused run on macOS/Node 24.22.2 failed all eight warm dispatch cases as expected;
the other four controls passed (1.05 s, `/tmp/core-handoff-warm-dispatch-red.log`). After correction,
both facade suites passed all 17 tests in 1.49 s with `conversationQueries.ts` at 100% statements,
branches, functions and lines (56 statements, 85 branches, 16 functions, 47 lines;
`/tmp/core-handoff-warm-dispatch-green.log`). TypeScript passed
(`/tmp/core-handoff-warm-dispatch-types.log`). Independent source review found no actionable findings;
root also reviewed the change. Final gates, build and new matched cost evidence remain pending.

## Limits retained

After its first use, ESM retains this code in core. Receipt parsing/serialization, stage writes,
fsyncs and bounded bulk buffers still run there. Splitting that I/O needs a reviewed phase contract
and recovery proof; this slice introduces neither. `lib/terminalHandoff.ts` is unrelated remote-pane
routing and is not part of this transaction. Package 11 cannot be marked complete by this lazy door.

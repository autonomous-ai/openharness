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
walked. Its warmed closure remains checked and reported. The expected cold reduction is seven files:
`core/handoffDependencies.ts`, `core/handoffPublication.ts`, `lib/handoffDiscovery.ts`,
`lib/handoffPublication.ts`, `lib/handoffFiles.ts`, `lib/handoffValidation.ts` and `lib/handoffGit.ts`.
The exact inventory must be proved before changing the checked-in list. Physical source counts are
informational, not runtime performance evidence.

| Question | Decision |
| --- | --- |
| Growth | No new persisted data, cache, timer, queue, witness map or registry mirror. One lazy dependency reference replaces one eager reference. Existing discovery/selection maps stay capped at 128 each. Existing receipt/stage lifetime growth remains an open package 11 limitation. |
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
never use profiler-overhead results as unprofiled acceptance timing. No cost result has run yet.

## Limits retained

After its first use, ESM retains this code in core. Receipt parsing/serialization, stage writes,
fsyncs and bounded bulk buffers still run there. Splitting that I/O needs a reviewed phase contract
and recovery proof; this slice introduces neither. `lib/terminalHandoff.ts` is unrelated remote-pane
routing and is not part of this transaction. Package 11 cannot be marked complete by this lazy door.

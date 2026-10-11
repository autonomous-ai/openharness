# Recover manual model requests after an outage

Previously a model service outage completed an identified create as
`failed/GRID_UNAVAILABLE`. The same creation ID could never recover. Core now
persists the semantic model request before lookup, returns a visible hold,
recovers it after restart, and lets cancellation win a durable exclusive slot
against dispatch. A claimed but uncertain effect is not replayed.

The [design](../design/2026-10-10-durable-launch-intents.md) records the exact
boundary and remaining lifecycle work. This covers identified manual model
selection, not every create/fork/restart/retarget dependency. Later Store and
grid-launch preparation still need the same boundary.

## Evidence

The healthy Linux/Darwin request golden was recorded from main `10c9e7420` in
commit `ac32477c7`, before implementation. It passes unchanged. It pins platform,
UTC and placeholder paths and forbids host subprocesses. The mutation script is
`cli/scripts/handoff-2026-10-08/mutate-launch-intents.py`; it checks healthy
wiring, original authorization, receipt/directory identity, cancellation,
conflicting disk evidence and bounded scheduling through assertion failures.

The new private `serviceProcesses.e2e.ts` case kills models, saves three requests,
kills core, verifies readiness and held reasons, cancels one, exercises an
unrelated session, then recovers the two remaining IDs exactly once. It passes
for both fake Claude Code and Codex. All daemons, homes, ports and tmux servers
belong to the fixture. The five-second reply deadline does not abandon a slow
lookup; a six-second successful lookup has its own regression.

Independent review found and prompted fixes for a discarded slow lookup,
unbounded historical/retry work, incomplete receipt evidence, ancestor sync,
changed legacy validation, missing early hold reasons, stale preflight authority,
canonical DSH aliases, contradictory memory/disk results, and retained tab
ownership after cancellation. Each has an executable regression. Final review
attestation and exact-head CI/local receipts belong in the PR body; this record
does not substitute for those gates.

The full Linux e2e run also exposed a pre-existing initial-launch race in
`stall.e2e.ts`: two process scans marked a new Codex row dormant 163 ms before its
ready marker, clearing its control and input state. This happened before the
fixture's first injected stall. Discovery now leaves initial engine absence to
the startup watcher while the row is starting without a process identity. It
still detects a missing pane, and two later absences of an observed engine still
count. A scan begun before readiness cannot count after readiness changes.

Commit `4cb11bec4` recorded the healthy discovery golden from the unchanged main
implementation before this correction. Linux/Darwin are pinned and host binaries
are forbidden. Three fault regressions failed before the correction and pass
afterward; the healthy golden and original e2e assertion remain unchanged.

Three paired runs of 10,000 in-memory initial-launch reconciliation passes on
Node 22.23.2 measured 77.4–81.3 ms before and 74.3–78.2 ms after; parent CPU was
140.7–147.8 ms and 135.2–141.2 ms, with noisy RSS deltas of 14.2–17.8 MiB and
12.2–16.0 MiB. This narrow workload supplies private synthetic process/pane
snapshots and no-op lifecycle callbacks; it measures the recurring decision,
not tmux/process probing or a user-visible speedup. The
[six results](2026-10-10-initial-launch-cost.json) and
[`initial-launch-cost.mjs`](../../cli/scripts/handoff-2026-10-08/initial-launch-cost.mjs)
retain the measurement. Bundle main `71f42b852` and the candidate reconciler with
the same CLI esbuild, using `cli/src/lib` as the baseline's import directory and
Node ESM with a `createRequire` banner; pass each bundle path to that script,
alternating before/after three times under `TZ=UTC TMPDIR=/tmp` on a quiet host.

## Matched cost

On the same macOS host and Node 22.23.2, three alternating runs measured 60 healthy
receipt creations plus reconstructed status readers each. The former source is
main `71f42b852`; fixtures use private temporary directories. These are journal
microbenchmarks, not total agent startup or end-to-end responsiveness measurements.

| Metric per run | Former v1 receipt | Recoverable v2 intent |
| --- | --- | --- |
| Median operation latency | 76.9–78.9 ms | 182.3–189.8 ms |
| p95 operation latency | 96.9–113.6 ms | 244.9–333.9 ms |
| Process CPU for 60 operations | 111.7–121.7 ms | 397.1–431.7 ms |
| RSS change during run | 0.3–0.6 MiB | −0.4–2.0 MiB |

The extra immutable intent/claim/result and directory syncs add measurable local
I/O latency. RSS changes are noisy deltas, not peak-memory bounds. This change
makes no speedup claim. Recovery keeps four preparations, 128 retry IDs and a
shared 20 ms per-pass work budget, checked between operations; a single synchronous
filesystem operation can exceed it. The private crash test separately checks
readiness within 15 seconds and working unrelated sessions during the outage.

The [anonymous results](2026-10-10-durable-model-requests-cost.json) retain all six
runs. For 60 sorted samples, the reported median is the upper middle sample at
index 30 and p95 is the sample at index 57. The measurement script is
[`receipt-cost.mjs`](../../cli/scripts/handoff-2026-10-08/receipt-cost.mjs).
From the repository root, prepare both implementations with the same installed
CLI dependencies, then alternate these commands three times on an otherwise
quiet host (Node 22.23.2 for the recorded measurement):

```sh
mkdir -p .harness/receipt-cost-before
git show 71f42b852:cli/src/lib/agentCreationReceipt.ts > .harness/receipt-cost-before/agentCreationReceipt.ts
git show 71f42b852:cli/src/lib/secureState.ts > .harness/receipt-cost-before/secureState.ts
cli/node_modules/.bin/esbuild .harness/receipt-cost-before/agentCreationReceipt.ts --bundle --platform=node --format=esm --outfile=.harness/receipt-before.mjs
cli/node_modules/.bin/esbuild cli/src/lib/agentCreationReceipt.ts --bundle --platform=node --format=esm --outfile=.harness/receipt-after.mjs
TZ=UTC TMPDIR=/tmp node cli/scripts/handoff-2026-10-08/receipt-cost.mjs .harness/receipt-before.mjs legacy
TZ=UTC TMPDIR=/tmp node cli/scripts/handoff-2026-10-08/receipt-cost.mjs .harness/receipt-after.mjs intent
```

The recorded v2 source was `3f960b4db`; the subsequent receipt-evidence correction
does not change the healthy benchmark path. Each invocation owns and removes only
its newly created temporary fixture directory.

## Accounting

This slice began October 10 around 17:24 UTC; the first golden commit preceded
implementation. Implementation, test development, validation, review/CI waiting
and merge are recorded separately in the PR's validation receipts. At this
write-up the change is under validation and not yet landed. No publication or
release occurred. The full daemon refactor remains governed by the
[completion checklist](2026-10-09-daemon-core-completion.md).

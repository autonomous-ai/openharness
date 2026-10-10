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
shared 20 ms per-pass work budget; the private crash test separately checks
readiness within 15 seconds and working unrelated sessions during the outage.

## Accounting

This slice began October 10 around 17:24 UTC; the first golden commit preceded
implementation. Implementation, test development, validation, review/CI waiting
and merge are recorded separately in the PR's validation receipts. At this
write-up the change is under validation and not yet landed. No publication or
release occurred. The full daemon refactor remains governed by the
[completion checklist](2026-10-09-daemon-core-completion.md).

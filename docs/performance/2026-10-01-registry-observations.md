# Unchanged registry observations

The daemon's discovery pass called `updateRuntimes` and `updateProcessIdentity` for
each live agent. Both advanced `touchedAt` even when the observation contained no
new information. At the end of the transaction, this rewrote the whole registry:
one process-birth probe, one lock-owner sync, one registry-file sync, and one
directory sync on every pass.

Discovery now advances the bookkeeping clock only when the persisted row changes.
A non-strict save with unchanged rows reads the file through the existing private
file checks and compares its exact contents with the last durable save. Matching
bytes avoid the lock, process probe, and writes. This still reads the registry;
it does not assume a matching mtime means matching contents.

An external change falls through to the existing locked three-way merge. Actual
changes retain the atomic write and all durability checks. Close-intent requests
always take that durable path, including identical retries. The cache is reset on
load and updated only after a successful durable save.

Refreshing an existing row also removes fields deleted by an external writer.
Previously, assigning the new fields over the old object retained a removed
`closePlan`, allowing a later pass to save a cancelled close request again.

## Measurements

Measured on Apple M2 Max, macOS arm64, managed Node 22.23.2. Five alternating
before/after trials per population, twenty measured discovery transactions per
trial after warm-up. Each variant uses the same dependency graph and synthetic
state in its own private directory. Real filesystem calls and process probes are
counted without replacing their behavior.

| Agents | Median wall time before → after | Node CPU time before → after | Node CPU reduction |
| --- | --- | --- | --- |
| 1 | 17.213 → 0.067 ms | 2.087 → 0.069 ms | 96.7% |
| 32 | 19.418 → 0.421 ms | 4.535 → 0.430 ms | 90.5% |
| 128 | 38.252 → 1.337 ms | 24.633 → 1.423 ms | 94.2% |

For every unchanged transaction, registry replacements fell from **1 to 0**, syncs
from **3 to 0**, and macOS `ps` probes from **1 to 0**. At 32 agents, registry bytes
written fell from **29,296 to 0** per pass. Node CPU excludes the child `ps` process.
These are registry-operation measurements, not whole-app energy, battery-life,
GPU, or engine-process improvements. Other live workloads were not controlled.

All 600 measured transactions preserved every field except the intentionally
changed bookkeeping clock, and retained each process index. Raw observations and
source hashes are in [the result file](2026-10-01-registry-observations.json).

## Reproduce

From the repository root, save the baseline source:

```sh
git show 920237b64:cli/src/lib/registry.ts > /tmp/registry-before.ts
cd cli
node scripts/benchmark-registry-observations.mjs \
  /tmp/registry-before.ts src/lib/registry.ts /tmp/registry-benchmark-new
node scripts/registry-observation-e2e.mjs /tmp/registry-e2e-new
```

Use new output directories; the scripts refuse to overwrite earlier evidence.
Both tools replace the production environment module at bundle time, so importing
the registry cannot adopt or migrate user state. They do not start a real daemon,
engine, or tmux session. The concurrency fixture stops only the children it owns.

## Correctness boundaries

Regression tests cover unchanged observations, real route/process changes,
reactivation, launch readiness, learned metadata, external in-place and atomic
session updates, unchanged mtimes, unsafe files/directories, symlinks, corrupt and
unknown-schema files, storage-failure retries, and strict close-intent durability.

The two-process fixture runs 123 discovery passes alongside 20 added agents and
40 title changes. It verifies that the externally bound conversation, all 21 agent
rows, and a concurrently saved close intent survive, then verifies that an external
cancellation remains cancelled. Both children are reaped and
the registry lock is released. The on-demand CI workflow runs this fixture on
Linux alongside the full CLI suite.

# CLI CI in four file shards

The previous two full CLI CI runs spent 4m50s and 5m57s in one default-suite
Vitest invocation. The remaining checks waited behind it even though they could
run independently. The default suite now runs as four file shards on separate
Linux runners; typecheck and contract checks run alongside them.

The existing worker cap, process isolation, assertions, timeouts and opt-in skips
remain. Guard fuzz keeps its separate invocation and wall-clock assertion. The
native serial/login-shell OS/Node matrix, lockfile checks, registry integration,
release bundle checks, and full updater coverage remain required. Linux login
shell cases retain their existing platform gate.

Vitest's [pinned sharding implementation](https://github.com/vitest-dev/vitest/blob/v4.1.10/docs/guide/improving-performance.md#sharding)
partitions files. A separate aggregate gate verifies that all four complete
discovery inventories agree and every discovered file appears exactly once in
passing reports. It checks case totals and actual upstream job verdicts, so a
JSON report cannot conceal a failed process or missing shard. The original
`typecheck-test` job/output remains the aggregate interface for callers.

## Observed timing

Candidate: `b2aa5c24d366c13a8981b282d2d8b1e766a87ae6`, Node 22.23.2,
Vitest 4.1.10. [Full CLI CI](https://github.com/autonomous-ai/openharness/actions/runs/37044314333)
passed from October 2 17:58:29 to 18:01:48 UTC. The
[machine-readable record](2026-10-03-cli-ci-shards.json) retains every verified
file, counts, report hashes and job/step timings.

| Measurement | Time |
| --- | ---: |
| Complete candidate workflow | **3m19s** |
| Four test steps | 1m19s / 2m24s / 38s / 59s |
| Slowest shard job, including setup and artifact upload | 2m51s |
| Typecheck and contracts job | 2m50s, including an 87s checkout |
| Aggregate file-coverage gate job | 20s |
| Previous workflow [37041350155](https://github.com/autonomous-ai/openharness/actions/runs/37041350155) | 6m19s |
| Previous workflow [37040969426](https://github.com/autonomous-ai/openharness/actions/runs/37040969426) | 7m41s |

This workflow was **3m00s–4m22s shorter**, or about **47–57%**, than those adjacent
runs. They used different source/runner conditions, so this is an observed
comparison, not a controlled benchmark or guaranteed time. Four Linux runners
trade extra setup/runner minutes for shorter waits. The uneven shard times and
checkout variation remain visible opportunities; no timeout was weakened to
obtain the result.

## Verification

- All **508 default-suite files** appeared exactly once: **8,818 passing cases,
  63 existing skips**, no todo cases. Reports and inventories are retained as
  workflow artifacts for seven days, with their hashes in the committed record.
- All 40 guard fuzz cases passed separately, along with typecheck, registry integration,
  existing-install launcher repair, release-bundle contracts and the updater's
  complete-coverage gate.
- All four macOS/Linux × Node 20.19.0/22.23.2 native jobs passed.
- All 82 process CI cases passed in 17.634s; all 11 new verifier regression cases also passed locally.
  They cover missing/duplicate files, inconsistent inventories/counts, unfinished
  or failed assertions, hidden file errors, paths outside the component, and
  failed/skipped/cancelled upstream jobs. Workflow lint and diff checks passed.

No application code, dependencies or existing tests changed. This affects
on-demand `cli`/`full` CI, not Desktop test duration or signing/publication.
No product release is needed. Performance evidence added afterward does not
change the tested workflow or verifier.

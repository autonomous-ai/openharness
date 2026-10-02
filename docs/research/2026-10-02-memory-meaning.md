# Preserve meaning in bounded coding-memory excerpts

Two prompt candidates were rejected after actual offline model checks. Production
remains on `coding-memory-v6`. This change adds diagnostic coverage and records
failures; it does not claim to fix interpretation or activate new live memories.

The diagnostic runner now accepts an explicit `bounded` capture boundary. Its
real queue applies the same restriction used for incomplete conversation excerpts,
and reports carry that boundary into semantic review. A missing or different
boundary cannot silently satisfy a bounded fixture. Older complete-episode reports
remain reviewable under their original complete-context assumption.

## Frozen cases and observations

The [eight-case corpus](2026-10-02-memory-meaning-cases.json) was frozen before the
first run. Its SHA-256 is
`657aae9de4f301b660cc2c57dce0f80ae801f49e71921a2365b862ba15d0023e`.
These are synthetic development cases inspired by observed failures, not held-out
user histories. They distinguish defaults from permitted overrides, requests from
exploratory questions, accepted numbers from tentative numbers, and user corrections
from quoted assistant plans. A limited list of UI edits is not an exhaustive list
of all allowed controls. Every probe supplies an empty conditions object; no
generated applicability key is copied into a recall query to make it pass.

The same cached Qwen3.8-27B-Q4_0 model and llama.cpp 9870 runtime ran each variant
once: eight calls, 90 seconds per call, 4,096 output tokens, 16,384 context tokens,
temperature zero, seed 42, thinking disabled, no retries. External networking was
denied by the worker's OS sandbox. Reports record model/source hashes and normal
worker exit. This reference model is not the selected companion model.

| Variant | Completed cases | Supported/useful records | Faithful positive recall | Correct abstention | Decision |
| --- | --- | --- | --- | --- | --- |
| [Production v6](2026-10-02-memory-meaning/baseline.json) | 7/8 | 5/5 reviewed | 4/5 reviewed | 16/16 reviewed | Baseline; incomplete case remains unmeasured |
| [Clause guidance v7](2026-10-02-memory-meaning/clauses.json) | 8/8 | 5/7 | 4/6 | 18/18 | Reject |
| [Logical-strength guidance v8](2026-10-02-memory-meaning/logical-strength.json) | 8/8 | 5/7 | 4/6 | 18/18 | Reject |

These judgments belong to the implementing agent, not an independent reviewer.
The baseline's incomplete case failed evidence coverage, so its three probes did
not run and aggregate quality rates stay null. Another baseline record correctly
retained the default but omitted the explicit manual override: the record itself
was supported, while the recall packet was incomplete.

Both candidates retained that override and completed the previously rejected case.
They nevertheless overstated other sources: unresolved approval of a retry delay
became wording that could imply an observed unset value or a prohibition, and named
retained controls became the only allowed controls. The review rejects these
conservatively; the full proposed claims, actions, evidence and attributed labels
are available for disagreement and rescoring. More completed extractions alone
do not establish better memories.

An approved offline check of five private bounded excerpts also failed to justify
v7: four of seven records were judged supported, compared with four of six under
v6. The candidate lost a permitted override, promoted tentative design options,
and added an unsupported blanket restriction. No private v8 run followed the
synthetic failures. Transcripts, outputs, source identities, hashes and review
labels for these private checks remain outside the repository. None of the checks
wrote live memory or changed the user's model, account or preferences.

## Evidence and reproduction

Each public report has matching `*-review.json` attributed labels and
`*-scores.json` output in [the evidence directory](2026-10-02-memory-meaning/).
The two `*-prompt.ts` files there are exact rejected learner snapshots, retained
as evidence only. They are not runtime modules and their relative imports assume
the original learner location. Their SHA-256 values match their reports.

With the pinned Node runtime and existing CLI dependencies, reproduce any score
without inference from `cli/`, using a new output path:

```sh
node --import tsx scripts/memory-quality-review.ts \
  --suite ../docs/research/2026-10-02-memory-meaning-cases.json \
  --report ../docs/research/2026-10-02-memory-meaning/clauses.json \
  --review ../docs/research/2026-10-02-memory-meaning/clauses-review.json \
  --output /tmp/memory-meaning-clauses-scores.json
```

TypeScript and all 27 diagnostic runner/reviewer tests passed on Node 22.23.2.
The receipt is `.harness/validation/20261002T175441.257916Z-61611/receipt.json`:
base `5a0951b1c996b47ce1e819aa40429862d3581756`, dirty-source fingerprint
`a29630bab89f6d6a1982b698597deff63bf5b46ad86d392202660eb5de9af57f`.
Those diagnostic changes were committed as
`4e8dc82c03ebdcccc29d222f5e4a54f178d26b26`. Later evidence files do not change the
tested CLI source. No broader production-prompt suite was required because neither
candidate was retained.

## Remaining work

Exact provenance does not prove faithful interpretation. A separate check of each
proposal against its source is a possible next experiment, not an implemented
guarantee. It must measure both mistaken acceptance and mistaken rejection, fit
existing model-call budgets and lease deadlines, and preserve source authorization.
A model judging its own output is not independent evidence of correctness.

Live selected-model learning, automatic contextual recall and useful coding-task
outcomes still need verification. Applying the published correctness and contract
principles in the [design council](../plans/2026-09-30-coding-memory-council.md)
means keeping these claims separate; its authors did not participate in or endorse
these reviews. Neither passing unit tests nor these small synthetic samples closes
the larger memory-quality gates.

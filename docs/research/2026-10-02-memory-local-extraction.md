# Memory extraction: local model comparison

The extraction prompt now names the required fields and their meaning explicitly.
The previous prompt asked for evidence JSON pointers without saying whether they
pointed into a source or a proposed memory, and prohibited “identity” while
requiring scope IDs and a conflict key. Actual model responses used `/text`, null
conflict keys, invented verification, and capture timestamps as validity dates.

`coding-memory-v5` replaces the overlapping prose with a field contract. It
distinguishes required scope/topic identifiers from host-owned record identifiers,
explains evidence coverage, requires a nonempty future action, and preserves
unknown reasons and dates. It also explains that a coding topic does not establish
an applicability condition. Admission, storage, recall, model selection, quotas,
timeouts and experimental controls are unchanged.

## Measured comparison

These are synthetic development diagnostics with an explicit offline reference
model, not Tim's selected model or real-user learning. Both arms used the cached
GGUF file named `Qwen3.8-27B-Q4_0.gguf`, llama.cpp `9870 (2d973636e)`, an Apple M2 Max
with 64 GiB RAM, temperature 0, seed 42, thinking disabled, a 16,384-token context,
4,096 output tokens and the production learner's 90-second limit. The model's full
SHA-256 and all source hashes are in the reports. Each call used the actual learner,
admission, disposable store and recall implementation. Expectations and probes
were never supplied to the model.

The model ran with a temporary home, offline mode and an OS sandbox denying
external networking. An attempted non-loopback connection returned `EPERM` before
each run. No private conversation, account credential, live memory or app setting
was used. No model was downloaded. Only runtime stderr containing local paths was
removed from the committed reports; model answers and recall packets are intact.

| Frozen six-case suite | v4 baseline | v5 candidate |
| --- | --- | --- |
| Calls made | 6 | 6 |
| Completed extraction jobs | 3 | 6 |
| Stored memories | 0 | 3 |
| Positive cases learned and correctly recalled | 0 of 3 | 2 of 3 |
| Negative recall probes | 3 completed; 4 unmeasured | 7 of 7 passed |

The [baseline](2026-10-02-memory-local-extraction/baseline.json) rejected two useful
answers for invalid evidence pointers and one for malformed JSON. Its three
completed cases contained no useful memory. These failures are not abstention
successes.

The [candidate](2026-10-02-memory-local-extraction/candidate.json) retained the
debugging preference with its production-incident exception and the project-only
SQLite decision with its actual deployment rationale. It also retained the
PostgreSQL default, but invented `taskType: implementation`. That unsupported
condition caused a missed recall. The [attributed review](2026-10-02-memory-local-extraction/candidate-review.json)
therefore fails that memory; [scores](2026-10-02-memory-local-extraction/candidate-scores.json)
are **2/3 supported and useful memories, 2/3 correct positive recalls, and 7/7
correct abstentions**. This is the implementing agent's source review, not an
independent human assessment.

The unchanged [multi-episode suite](2026-09-30-memory-batch-extraction-cases.json)
was checked after fixing the candidate. In its first case, both personal
preferences were faithfully retained, the database default was unconditional,
and all five recall probes passed. The second case proposed only the supported
SQLite decision, but omitted evidence coverage for its empty applicability map;
the existing guard rejected the batch. Its three probes were not run. The
[report](2026-10-02-memory-local-extraction/candidate-batch.json),
[review](2026-10-02-memory-local-extraction/candidate-batch-review.json) and
[scores](2026-10-02-memory-local-extraction/candidate-batch-scores.json) preserve
that failure. Overall batch-quality rates remain null because only one of two
cases completed.

## Limits and next work

Earlier local experiments also tried Qwen2.5 7B and Qwen3.5 9B. They produced
schema/coverage failures or exceeded the production deadline. A longer field
appendix and schema-description variant were rejected; neither is shipped.
Local model availability alone does not establish extraction readiness.

The measured improvement justifies clearer instructions in the experimental
implementation. It does **not** meet the held-out quality gates. In particular,
unconditional defaults and reliable field coverage still need work. No validator
was relaxed, no output was repaired, and rejected model answers were not silently
promoted. More than one prompt/model comparison and task-level evidence are needed
before claiming reliable personalization across frameworks.

The selected Muse/OpenCode route's provider refusal remains a separate blocker.
No private sessions were sent to it or to these local reference models. Actual
selected-model extraction, real-session usefulness, native task benefit and the
held-out-history evaluation remain unverified.

The saved semantic scores can be reproduced without model calls. From `cli`, use
the existing reviewer with a new output path:

```sh
node --import tsx scripts/memory-quality-review.ts \
  --suite ../docs/research/2026-09-30-memory-extraction-cases.json \
  --report ../docs/research/2026-10-02-memory-local-extraction/candidate.json \
  --review ../docs/research/2026-10-02-memory-local-extraction/candidate-review.json \
  --output /tmp/memory-candidate-scores.json
```

For the batch result, use the batch suite and `candidate-batch` report/review.
The producer hashes bind this review to the exact saved evidence. They do not
authenticate the reviewer or turn a development diagnostic into a rollout gate.

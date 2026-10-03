# Compact extraction response: rejected candidate

Making empty extraction fields optional did not establish a useful efficiency gain.
The candidate omitted unknown rationale, empty exceptions and empty validity from
the model response, then expanded those values before full record validation.
Applicability, evidence coverage, scope and material fields remained required.
The tested [patch](2026-10-03-memory-compact/candidate.patch) is archived only;
production remains `coding-memory-v6` with its existing response contract.

The [plan](2026-10-03-memory-compact/plan.json) reused the eight frozen synthetic
cases, cached Qwen3.8-27B-Q4_0 model, 512-token reasoning budget, temperature zero,
seed 42 and 90-second per-call deadline from the
[earlier comparison](2026-10-03-memory-reasoning.md). Each arm ran once. These
already-inspected examples are adaptive development evidence, not held-out data.

| Measurement | Existing response | Compact candidate |
| --- | ---: | ---: |
| Completed cases | 8/8 | 8/8 |
| Mean attempt time | 55.069 s | 55.346 s |
| Median attempt time | 57.835 s | 56.564 s |
| Maximum attempt time | 66.082 s | 67.135 s |
| Input tokens | 24,926 | 25,374 |
| Completion tokens, including reasoning | 5,312 | 5,270 |
| Total tokens | 30,238 | 30,644 |

The candidate saved 42 completion tokens but added 448 input tokens. Its longer
field guidance and changed generated wording outweighed the omitted defaults.
One run per arm cannot establish a reliable latency improvement from the small
median difference, and the mean was slightly higher. The candidate was rejected;
no additional private-session run followed. This result does not prove that every
compact format is ineffective or that another model would behave the same way.

The implementing agent judged six of six stored records supported, specific and
useful; six positive recalls preserved the source context, and eighteen negative
probes abstained. The defaults/override distinction and the narrow export change
were retained. The export record's phrase “as the prompt actions” is less precise
than the original keep/remove wording; the judgement covers the whole record,
including its exception and exact recalled source. The attributed
[review](2026-10-03-memory-compact/review.json) and
[scores](2026-10-03-memory-compact/scores.json) are not independent review, private
history quality, native delivery or evidence of better coding outcomes.

Before model evaluation, TypeScript validation and 115 tests across six affected
files passed against the candidate. They covered expansion into the complete
stored format, legacy rejection, material fields, scope, evidence and queue
behavior. The final change contains only this evidence and the archived patch;
it does not ship the candidate or modify the installed app, daemon, model, account,
settings or memory. External networking was denied and inference writes were
confined to a disposable folder. The worker exited normally.

The [report](2026-10-03-memory-compact/report.json) contains the original synthetic
answers, records, source contexts and measurements. The
[manifest](2026-10-03-memory-compact/comparison.json) binds the base commit, patch,
candidate source hashes, corpus, unchanged runner and earlier control. No private
transcripts or private test artifacts are included. Live automatic learning and
the broader quality, lifecycle and coding-benefit gates remain open.

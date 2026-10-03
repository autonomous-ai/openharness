# Reasoning preserved synthetic qualifications but missed the private deadline

A 512-token reasoning budget improved the unchanged v6 extractor on eight known
synthetic cases. It then timed out on the first of five previously consented private
excerpts. This is evidence about one local reference configuration, not a completed
real-user quality check or a reason to change the user's companion model.

## Controlled comparison and adaptive follow-up

All arms used the frozen [meaning corpus](2026-10-02-memory-meaning-cases.json),
production `coding-memory-v6`, Qwen3.8-27B-Q4_0, llama.cpp 9870 (`2d973636e`),
16,384 context tokens, at most 4,096 output tokens, temperature zero and seed 42.
Each request had the existing 90-second learner deadline. There were no tools,
retries, prompt changes, relaxed admission rules or production writes. The model
worker inherited an OS sandbox that rejected external networking and confined all
writes to a disposable directory. Its authenticated HTTP listener used loopback.

The initial plan compared thinking disabled with a 1,024-token thinking budget.
After that budget timed out on its second case, one adaptive follow-up tested
512 tokens. The unchanged control was reused. The smaller arm is therefore not
a separately preregistered or held-out result. Each configuration ran once; this
does not estimate run-to-run variability or performance on other hardware.

The implementing agent reviewed the stored claims, future actions, scope,
qualifications and recalled source context against the frozen criteria. These
are attributed judgments, not independent human ratings. Expected answers and
review labels were not passed to the extractor.

| Configuration | Completed cases | Supported/useful records reviewed | Correct positive recalls reviewed | Correct abstentions reviewed | Result |
| --- | --- | --- | --- | --- | --- |
| Thinking disabled | 7/8 | 5/5 | 5/5 | 16/16 | One evidence-coverage failure; aggregate quality remains inconclusive |
| 1,024 thinking tokens | 1/8 | 1/1 | 1/1 | 2/2 | Second case timed out; six were not run |
| 512 thinking tokens | 8/8 | 6/6 | 6/6 | 18/18 | Completed synthetic diagnostic only |

Unfinished cases receive no abstention or quality credit. The two incomplete
arms retain null aggregate rates even though their completed records passed
review. The counts, exact outputs and labels are in the
[comparison](2026-10-03-memory-reasoning/comparison.json).

The control again left manual expansion out of its generated default-navigation
summary. Its recalled original excerpt preserved that qualification, explaining
why the completed control's recall score differs from the earlier summary-only
experiment. That gain is not attributed to reasoning. The smaller reasoning arm
also put the manual override in the stored claim. It kept the unapproved retry
delay unresolved and preserved other export actions while naming the requested
conflict-prompt edits, without inventing an exhaustive action inventory.

The median attempt duration was 29.1 seconds for the control and 57.8 seconds
for the 512-token arm; the latter's maximum was 66.1 seconds. The 1,024-token arm
took 89.1 seconds on its completed case and hit the deadline on the next. These
are measurements on this machine, including the failed control attempt, not
native-provider latency or cost estimates.

## The private follow-up did not complete

The same smaller budget was then applied only to the five excerpts already
approved for offline processing. Their text, role, project and bounded-context
designation were unchanged. The evaluator used disposable owner/session/source
identifiers and capture timestamps; this was not a new native capture or live
companion session. Original input files remained read-only and their hashes
matched afterward. The driver and worker could not reach external networks.

The first extraction hit 90 seconds and was recorded as `inference_timeout`.
No memory was committed in that disposable case, and the remaining four examples
were not run. Semantic quality is unmeasured; the earlier private result of four
supported memories out of six is not replaced by the synthetic score. All private
sources, model-run metadata, identities, hashes and review artifacts remain local.
Only these aggregate observations are published.

## Evidence and implications

The [evidence directory](2026-10-03-memory-reasoning/) includes the three synthetic
reports, their attributed reviews, scores, plans and the exact runner snapshot.
Public reports omit process stderr and local paths to the prior plan/control;
model answers, source snapshots, records, counters and outcomes are unchanged.
The manifest identifies original and published report hashes. Review bindings and
scores were regenerated for the published bytes. The snapshot retains the tested
machine's paths; adapting those paths is necessary to rerun it elsewhere.

For example, recompute the smaller arm's score without inference from `cli/`:

```sh
node --import tsx scripts/memory-quality-review.ts \
  --suite ../docs/research/2026-10-02-memory-meaning-cases.json \
  --report ../docs/research/2026-10-03-memory-reasoning/reasoning512.json \
  --review ../docs/research/2026-10-03-memory-reasoning/reasoning512-review.json \
  --output /tmp/memory-reasoning512-scores.json
```

The execution receipts report normal runner completion. They do not turn the
recorded coverage failure, timeout or unrun cases into passing quality checks.
All workers exited, and no app, daemon, firmware, live memory or provider setting
was replaced. The production extractor remains v6. Local thinking-token budgets
are not certified equivalents of any native agent's effort settings.

The next implementation investigation is avoidable extraction overhead within
the current evidence and deadline contracts. Increasing reasoning alone has not
demonstrated reliable private learning. Real selected-model behavior, independent
held-out assessment, and coding-task benefit remain required. This follows the
[design council's](../plans/2026-09-30-coding-memory-council.md) distinction between
checks and broader claims; no named practitioner participated in this review.

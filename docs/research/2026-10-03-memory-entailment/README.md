# Dedicated entailment checks for coding-memory fields

The dedicated entailment classifier is rejected as a memory admission candidate.
It completes quickly but accepts both difficult unsupported proposals and withholds
one supported proposal under the predeclared primary input format. Confidence
scores do not repair that result.

This offline diagnostic evaluates the classifier on the same sixteen known synthetic proposals as the
[whole-proposal review](../2026-10-02-memory-source-audit.md) and
[source-first review](../2026-10-03-memory-source-first/README.md). It changes no
production learning, recall, model selection or dependencies.

## Result

All 69 source–hypothesis pairs completed: three elementary relation checks and
33 memory fields under each input format. The command finished in 19.1 seconds,
including imports, file verification and model loading. There were no retries,
timeouts, truncated inputs, private excerpts or selected-provider calls.

| Input | Supported proposals accepted | Supported proposals withheld | Unsupported proposals accepted | Unsupported proposals withheld |
| --- | ---: | ---: | ---: | ---: |
| Scoped source, primary | 9 | 1 | 2 | 4 |
| Raw source, ablation | 8 | 2 | 2 | 4 |

The [report](report.json) contains every input and field score; the
[comparison](scores.json) binds them to the frozen fixture labels. The primary
arm fails the diagnostic rule. Neither another input format nor a threshold was
selected after seeing these results.

Both formats accept the same previously missed distinctions: missing approval
does not establish an implementation state, and a limited edit to named controls
does not establish an exhaustive inventory. In the primary arm, the minimum
entailment score across the two fields was 0.9917 for the first unsupported
proposal and 0.9951 for the second. These high scores are observations, not
evidence that the interpretations are correct.

The primary arm withholds the agreed fourteen-day retention policy because it
labels the proposed deletion action neutral. The frozen fixture treats that
action as supported by the stated policy. This is an implementing-agent judgment;
independent human review may disagree and remains required. The ablation also
withholds a supported project-scoped build-log preservation request.

Completed proposals' two or three field checks took a median 90.9 milliseconds
across both formats, with a maximum of 119.6 milliseconds. This excludes model
loading, imports and file verification. The 184,424,451-parameter model loaded in
706.5 milliseconds on this run. These are single-run CPU observations, not a
native application latency or production packaging claim.

A [post-hoc ranking check](ranking.json) shows why a single confidence cutoff is
insufficient even on these known cases: the highest-scoring unsupported proposal
ranks above the lowest-scoring supported one. This arithmetic observation does
not tune a threshold, add model calls or change the frozen primary decision.

The [manifest](manifest.json) records the completed inference receipt and exact
published report hash. The command's successful execution establishes that the
experiment ran; the measured admission quality fails. This evidence does not
justify adding another model to the learner. Tests with the selected companion
model, independent held-out review and actual coding outcomes are still needed.

## Frozen method

The author's [model card](https://huggingface.co/MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli)
describes training on MultiNLI, Fever-NLI and Adversarial-NLI, with entailment,
neutral and contradiction outputs. This experiment tests its applicability to
coding-memory assertions; those training datasets do not establish performance
on our domain. The [WiCE research](https://arxiv.org/abs/2303.01432) also documents
the difficulty of applying entailment models to naturally occurring claims.

The [plan](plan.json), runner, scorer, complete Python dependency versions and
[model file hashes](model-files.json) are frozen before inference. Only public
model/tokenizer data and binary package wheels are downloaded, into a disposable
environment. Model data is pinned to a specific upstream revision; safetensors
loads without pickle or remote custom code. The model never downloads content
during inference. An OS sandbox denies networking and writes outside the test's
output directory; its network denial is checked before loading the model.

For each proposal, the classifier sees the original source passage paired
separately with the verbatim `claim`, `futureAction` and any nonempty `rationale`.
There is no generated decomposition or case-specific rewriting. The primary
input includes the captured project, speaker role and bounded-episode marker.
A predeclared ablation omits that metadata. It cannot replace the primary arm
as the winning criterion after results are known. Expected answers, review notes
and prior model outputs are withheld from inference.

A proposal is accepted in this diagnostic only when every tested field has
entailment as its highest-scoring class. Neutral means the evidence is insufficient;
contradiction means it conflicts. Both withhold acceptance. Their probabilities
and distinct labels remain in the report. These scores are not calibrated truth
probabilities. The test counts both unsupported acceptances and supported proposals
withheld, so withholding everything cannot succeed.

All sixteen cases must complete in the primary arm, all ten supported proposals
must be accepted, and all six unsupported proposals must be withheld to justify
further investigation. There are no retries or threshold tuning. CPU inference
uses two threads, float32, evaluation mode, deterministic algorithms and a
120-second evaluation deadline. No pair may exceed 512 tokens; there is no
truncation. Three elementary relation checks verify the label mapping before the
memory cases run. These checks and their inference cost are reported separately.

This is a necessary textual-support check, not complete memory admission. Scope,
authority, provenance, usefulness, structured conditions and temporal validity
still need their own checks. The implementing agent supplied the frozen labels;
these are development cases, not independent human judgments or held-out user
histories. No private conversation or selected-provider call is involved.

## Reproduction

Install [requirements.txt](requirements.txt) into a disposable Python 3.12
environment and fetch only the pinned files identified in `model-files.json`.
Under the sandbox described above, run:

```sh
python -B run.py /path/to/pinned-model /path/to/disposable-output/new-report.json
```

To recompute the comparison without loading the model:

```sh
python -B score.py report.json /tmp/memory-entailment-new-scores.json
```

Both report destinations must be new. The scorer binds every premise and
hypothesis back to its fixture, verifies file hashes and probability/label
consistency, and counts missing or unfinished work explicitly. Inspect the saved
per-field answers as well as the aggregate; a fast classifier can still be wrong.

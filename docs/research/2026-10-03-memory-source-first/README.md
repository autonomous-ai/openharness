# Source-first review of coding-memory proposals

The source-first reviewer is rejected. It still accepted the first difficult
interpretation error, returned an invalid fifth review, and timed out on the
sixth. Ten further proposals were not attempted. Adding the source interpretation
did not establish a reliable publication gate, and this incomplete run provides
no overall accuracy rate. The production extractor remains `coding-memory-v6`;
none of these research files is imported by the app, learner or framework adapters.

The diagnostic tested whether interpreting sources before seeing a candidate
would improve on the earlier [whole-proposal review](../2026-10-02-memory-source-audit.md).

## Observed result

All ten distinct source interpretations completed. Of sixteen planned proposal
reviews, four returned structurally valid reviews: two accepted supported
proposals, one rejected an unsupported proposal, and one accepted an unsupported
proposal. The fifth response used a Markdown code fence and failed the frozen
strict JSON contract. It receives no success credit. The sixth request hit the
90-second deadline; no answer was saved, and the run stopped. The model worker
then exited with code zero. The [report](report.json) and [scores](scores.json)
retain these outcomes separately from an aggregate quality claim.

For `audit-01f634831f20`, the first stage explicitly said it was unknown whether
the assistant's proposed change had been implemented. The second stage still
accepted a claim that the retry delay had not been set to the proposed value,
citing the user's lack of approval. It left the compound claim intact despite
the request to split materially different assertions. This repeats the earlier
conservative rejection case; exact quotations and field coverage did not prove
the proposed interpretation. The other previously missed case, an exhaustive
list inferred from limited UI edits, was not reached.

The ten source calls took a median 23.6 seconds. Five answered proposal reviews
took a median 75.9 seconds, with a maximum of 80.0 seconds. Among the four valid
reviews, adding the corresponding source call gave a median 102.3 seconds before
any original extraction work. Sixteen calls were attempted, fifteen returned an
answer, and those answers reported 17,073 total input/output tokens. The timed-out
request's usage is unknown. This does not justify extra calls or a longer lease
in production, and timing on this single run is not a controlled comparison of
machine load or inference implementations.

An earlier startup attempt made zero model calls because the version probe read
stdout while the runtime wrote to stderr. Correcting that probe did not change
the prompts, cases or acceptance rule. The final run's outer validation receipt
also reported `source_changed`: the scorer and this explanation were added while
inference ran. The runner, plan, two prompts and input corpus remained unchanged;
their exact hashes were checked afterward. Both failed receipts remain failed.
The [manifest](manifest.json) records those distinctions and the published report
transformation; no inference retry or passing full-run result is implied.

## Method and boundary

[WiCE](https://arxiv.org/abs/2303.01432) studies sub-sentence entailment and minimal
supporting evidence, while documenting difficult real-world verification cases.
[FENICE](https://aclanthology.org/2024.findings-acl.841/) aligns extracted atomic
claims with source information using natural-language inference. These motivate
checking smaller assertions. This experiment is our separate language-model
review procedure; it does not implement or replicate either paper's metric.

The frozen [plan](plan.json) uses the same sixteen synthetic proposals and
implementing-agent judgments as the earlier review. Ten distinct source inputs
are interpreted once each. All ten interpretations finish before any candidate
is submitted to the model. Both stages start fresh conversations with no tools.
Expected verdicts and provenance labels are withheld from both stages.

The [first prompt](source-prompt.txt) asks for sourced statements, qualifications,
and unknowns. The [second prompt](review-prompt.txt) supplies the original sources,
that fallible interpretation, and one candidate. It requests separate checks for
material clauses, covering every material field. Exact quotes, permitted paths,
field coverage and response shape are checked in code. These structural checks
cannot establish that the clauses are correctly decomposed or interpreted.

The cached Qwen3.8-27B-Q4_0 model runs with llama.cpp 9870 (`2d973636e`), thinking
disabled, temperature zero, seed 42 and a 16,384-token context. Source calls have
1,536 output tokens and proposal reviews 2,048. Each call has a 90-second deadline;
the whole inference run has fifteen minutes. There are no model retries. This is
one configuration on one machine, with no estimate of repeatability or other
models' quality.

The driver and model inherit an OS sandbox that denies external networking and
permits writes only in a fresh private temporary directory. A network probe must
receive `EPERM` before the model starts. The HTTP listener is authenticated and
bound to loopback. There are no private excerpts, selected-provider requests,
production writes, app launches, account changes or firmware changes.

## Reproduction

[run.mjs](run.mjs) requires a model path, a `llama-server` path and a new output
directory. The supplied model and runtime must match the plan. On macOS, run it
under `sandbox-exec` with a profile that denies external networking, allows
loopback, denies writes by default, and permits writes only under the disposable
output parent. The script refuses to overwrite an earlier run or to run when its
external-network probe succeeds. Review the script before running an experiment;
it is deliberately separate from the production inference service.

To recompute the recorded comparison without inference, from this directory:

```sh
python3 score.py report.json /tmp/memory-source-first-new-scores.json
```

The output path must be new. The scorer verifies suite, plan, prompts and runner
hashes; rebinds each submitted prompt to the original input; checks field and
quote coverage; and counts unsupported, unclear, invalid and missing reviews
separately. A missing answer receives no success credit. Recorded token usage
covers answered calls only; attempts without an answer are reported separately.

The source-only interpretation is shared only between candidates with byte-equal
source inputs. Reported per-candidate source-plus-review times count that source
call in full. They do not include the original extraction, and they do not imply
that the extra work fits the production two-minute lease or six-call hourly
allowance shared with notebook generation.

These are known development cases, not held-out user histories. Their labels
belong to the implementing agent, not an independent human reviewer. Passing this
diagnostic would only justify another test, not automatic publication. The
[design council](../../plans/2026-09-30-coding-memory-council.md) applies published
engineering principles; its authors did not participate in this experiment.

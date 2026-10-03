# A second model review still missed the difficult interpretation errors

A separate source review caught clear distortions but accepted both subtle errors
that survived the extraction prompt experiments. It is not being added as an
automatic publication gate. This records an experiment, not a shipped safeguard.

The [frozen corpus](2026-10-02-memory-source-audit/cases.json) contains 16 synthetic
source/proposal pairs: eight saved outputs from the preceding extraction diagnostic
and eight authored minimal-pair cases. The implementing agent labeled ten supported
and six unsupported before inference. Those judgments are not authenticated human
ground truth. The authored cases distinguish an explicit project preference from a
personal default, a request from an implemented outcome, an unknown rationale from
an invented accessibility explanation, and a correct claim from a contradictory
future action.

Each call received only the [review instructions](2026-10-02-memory-source-audit/prompt.txt)
and one candidate with its source, role, project scope and episode boundary. Expected
answers, origin labels and previous review comments were withheld. The cached
Qwen3.8-27B-Q4_0 model was the same reference model used for extraction, with a fresh
request for each case. No conversation state, tools, private user history or live
memory were used. The worker's OS sandbox rejected external networking. The run
used temperature zero, seed 42, a 16,384-token context, 1,024 output tokens and a
90-second call deadline, with no retries. All sixteen JSON responses were valid;
the worker exited normally.

| Expected judgment | Reviewer accepted | Reviewer rejected | Unclear or invalid |
| --- | --- | --- | --- |
| Supported, 10 cases | 10 | 0 | 0 |
| Unsupported, 6 cases | 2 | 4 | 0 |

The [raw report](2026-10-02-memory-source-audit/report.json) and
[attributed comparison](2026-10-02-memory-source-audit/scores.json) retain every
answer and both mismatches. Median call time was 6.73 seconds; maximum was 12.73
seconds on this machine. The two mistaken acceptances came from actual extraction
outputs, not the authored corruptions:

- An unapproved retry value, pending measurement, was interpreted as a rejected
  value and accepted despite wording that could imply an observed implementation
  state or prohibition.
- A request to retain named controls and remove two others was accepted as an
  exhaustive inventory, even though the source limited the scope of the edit.

The reviewer repeated the extractor's interpretation in its summaries. This is
evidence of correlated errors in this particular small test, not a claim that all
model review is ineffective. The measured result does not justify doubling live
model calls or weakening the existing admission rules. An eventual second call
would also need an explicit reservation under the shared six-call hourly budget,
durable state and authorization checks; it cannot be slipped into the current
120-second lease without addressing those contracts.

The [following experiment](2026-10-02-memory-source-recall/comparison.json) supplies
exact source excerpts during recall and measures the resulting coding behavior.
Generated claims and actions with source metadata alone do not let the receiving
agent inspect the original wording. The new context format keeps selected excerpts
within the same byte, scope and privacy limits. It does not retroactively prove a
stored paraphrase is correct, and one coding task still fails with the original
qualification present.

All artifacts here are synthetic. The suite, prompt, model weights and runner are
identified by hashes in the report. Scores compare exact case IDs and the frozen
expected verdicts; no native-framework or held-out-user quality claim follows.

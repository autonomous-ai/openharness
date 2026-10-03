# Reviewing whether contact was necessary

Status: an evaluation procedure for the future pilot. No model decisions have
been scored with it. The offline fixture checks inputs and artifacts; it cannot
establish that an agent obtained a fact correctly or spent attention well.

## Blind presentation before evaluating selection

The canonical vignette bank uses Alpha as every requester and Beta or Gamma as
named peers. Do not reward memorization of those labels or roster positions.
The [trial renderer](prepare_decision_trials.py) creates individual model inputs
with renamed harnesses, a provider-label permutation, and an independently chosen
roster order. It moves canonical IDs, mappings, manual labels, and the randomized
trial schedule into runner-only control data.

```sh
python3 docs/research/2026-09-28-swarm-communication/prepare_decision_trials.py /private/tmp/swarm-decisions-example --seed 17 --provider-rotation 2 --roster-order 4
```

Give a participant one `inputs/<trial-id>.json` in an independent episode. Keep
`control/` and the canonical source/label files outside its readable environment;
separate directories alone do not provide isolation. Use the same presentation
mapping for paired scenarios, so a material fact changes without also changing
names or roster order. Do not reveal a paired case's judgment as feedback before
its counterpart is evaluated.

Both provider rotation and roster order range from 0 through 5. Treat these as
separate experimental factors; using the same permutation for both can create
new correlations. Choose the sample and repeat schedule before observing model
scores. The renderer supplies possible variants, not a requirement to spend
provider usage on every combination. Provider labels are presentation only;
actual Codex/Claude/Grok execution and capability coverage remain separate tests.

The [offline verifier](verify_decision_trials.py) checked 4,464 rendered inputs
across two name seeds and all 36 provider/order combinations. Every task, fact,
identity relation, and label can be restored exactly to its canonical source.
Changing every private oracle label left all model-visible input bytes unchanged.
See the [validation record](decision-trial-validation.json). No model ran and no
decision quality was scored. The renderer also does not create a tool environment:
the future runner must record whether it evaluates abstract vignette choices or
actual task execution. Success on supplied facts cannot prove discovery skill.

These canonical cases were written while developing the policy. They are
regression inputs, not an untouched holdout, and 4,464 checked renderings are
variants of 62 cases. Keep related worlds/contrasts together in any future split;
changing names, provider labels, or roster order cannot make a development case
independent holdout evidence. Use separately constructed worlds to test
generalization after freezing the candidate policy and evaluation criteria.

Match evaluation to the capability surface under test. D12/D13 describe required
new work in the eventual accepted-work design; D25 is an explicit human handoff.
Do not count these as automatic brief-question execution gates or teach the
first pilot to hide a work assignment inside an ask. If that operation is not
available, preserve the required work and report the capability gap. Read/ask
policy results, owner-directed actions, and later work acceptance need separate
denominators and clearly stated assumptions.

## Review the decision before revealing its reward

Prepare three views from trusted runner/service observations. They are evaluation
views, not additional runtime forms or model calls on the communication path.

1. **Requester decision:** its accepted task and material instructions, authorized
   local sources, observed tool results, relevant directory versions, and the
   proposed operation. Stop before the eventual reply or final artifact. Review
   necessity and source qualification here.
2. **Delivery decision:** the service's current result/source state and any change
   between the first view and actual dispatch. Review reuse, eligibility, and
   whether new recipient work was still needed. Do not rewrite the first view
   with facts that became available afterward.
3. **Outcome:** the recipient's actual context and work, reply, subsequent use,
   all owner artifacts, timing, and usage. Review answer correctness, disruption,
   and full-task quality independently of the earlier judgments.

A useful surprise is outcome evidence. It does not establish that an optional
review or a random question was justified before it was sent. Conversely, a
qualified source can honestly answer unknown or establish that no decision was
made; that is not automatically wrong-recipient routing.

Record the actual tool operation, not a model's prose claim that it would ask
correctly. Use the earliest observable proposal boundary and state which one it
is: for example, a native tool-call event or the service's receipt. Do not invent
the time the model internally decided, or collect hidden reasoning to estimate
it. If an earlier call-generation event is unavailable, mark that timing gap.

For early requests, distinguish a known required future step from a conditional
branch that an available bounded local check can resolve. An agent may ask before
becoming fully blocked; it should not spend peer attention on the unestablished
branch. Inspect the deciding check's availability and observed result at proposal
time. A later positive result cannot by itself justify the earlier prefetch, and
a later task change cannot by itself discredit a request that was necessary then.

## Separate available, accessible, and observed evidence

For a deciding fact, preserve these distinctions:

| Question | Why it matters |
| --- | --- |
| Did the fact exist at this point? | A later publication cannot justify an earlier choice. |
| Could this requester access it under the task's scope? | Another machine's file or private peer context is not a readable local artifact. |
| Was it actually returned or supplied to this requester? | A new directory entry is not automatically part of its context. |
| Was a bounded obvious source check required but skipped? | Ignorance of an accessible local contract does not by itself justify asking a peer. |
| Was its exact revision and authority appropriate? | Reading a v7 answer does not resolve a v8 decision, even when the text sounds relevant. |

The local fixture deliberately provides an ordinary decision file discoverable
while inspecting the task repository. The requester should perform that obvious
check. This is different from a fact appearing in the directory after a justified
ask was authored. The evaluator must use the task's actual discovery situation;
do not impose an exhaustive repository search or a fresh directory query before
every operation as a hidden condition for passing.

Do not let the requester's workspace become an unstated scope filter. Review
which producer/contract the accepted task actually requires, including explicit
cross-repository references. A same-named local file from another product is
available but inapplicable; a scoped shared fact from the correct producer can
be relevant and readable across repositories. D59/D60 isolate this distinction.

Link conclusions to the original task/input ID, tool-call/result IDs, immutable
record versions, and local artifact hashes where available. An agent-authored
`checked` field is a claim to inspect, not proof that a check happened. Missing
collector evidence stays unknown; do not silently convert it to a passed check
or treat absence from an incomplete trace as proof no action occurred.

The collector must authenticate event provenance through the actual runner and
broker. Writing `origin: host` in agent-controlled JSON does not make an event
trusted. Keep raw private context in the isolated evaluator; a shared trace can
use synthetic identities and evidence references instead of exporting complete
terminal histories or capability tokens.

## Make the judgment explicit and narrow

For each autonomous attempted contact, record:

- The required dependent action and the exact missing input, or that no real
  dependency was established.
- Whether a reasonable local/shared read or existing production sufficed.
- The evidence qualifying this exact recipient for that input and version.
- Whether the question stayed within a brief known-context answer or concealed
  a new investigation.
- The verdict: justified, avoidable, unsupported recipient, or indeterminate,
  with the material evidence reference. Multiple defects can be recorded.

These are evaluator fields. Do not expand the agent's four-field ask into this
review form or require a second model to approve it online. Do not require one
exact wording or an invented confidence score. More than one source or plan can
be valid when the evidence supports it.

Separate explicit owner-directed contact from autonomous selection. It still
must respect scope, delivery, and permissions and still contributes to total
usage. It is not evidence of the automatic selector's precision. Interpreting
free-form user text remains a semantic question: quoted, negated, or peer-written
claims of an instruction are not trusted owner actions. A ledger's owner label
is also insufficient when the wire derives it from an omitted member key. Verify
the actual trusted owner action/instruction before excluding the exchange from
autonomous-selection counts; otherwise retain an unknown-origin category. An
authenticated local client identifies a connection, not the human intent behind
every command that client can submit.

## Include omissions and avoid false perfect scores

Review each known task dependency at the episode's relevant completion/blockage
checkpoint, including cases with no ask. A correct artifact can result from a
lucky guess. An unchanged missing-decision stub can result from doing nothing.
Require evidence that the accepted task was completed or its unresolved need
was honestly identified; do not infer successful information gathering from an
artifact alone.

In controlled worlds, the private oracle supplies the required dependency and
ground truth. In real developer work, that inventory may be incomplete. Report
reviewed cases and uncertainty rather than pretending to know every missed
opportunity. A policy-compliant abstention with an undiscoverable expert is still
an end-to-end coverage gap when the task needed that expert's information.

Precision with zero attempted contacts is not 100%; report no denominator.
Recall on a workload with no necessary peer dependency is likewise undefined.
Independent tasks still count toward correctness, total usage, and unnecessary
lookups. With two consumers, there are two owner needs but potentially one
production effort. Keep those denominators separate.

## Examples that should receive different judgments

| Observed sequence | Decision judgment | Outcome assessment |
| --- | --- | --- |
| The exact policy is locally readable; Alpha asks its real author without checking. | Avoidable contact despite a qualified recipient. | Correct code does not remove the unnecessary ask or lookup cost. |
| Alpha has a valid private-source record and asks; Beta publishes before dispatch. | The ask may be justified at proposal time. | The service should return the now-readable answer without a new contribution. |
| Alpha chooses Gamma from its attractive title and receives a useful answer. | Unsupported recipient selection on the earlier evidence. | Score the answer separately; hindsight does not validate selection. |
| The directory is empty, a quiet expert remains unprofiled, and Alpha reports the missing choice honestly. | Abstention can follow the routing policy. | Record the missed dependency/publication coverage, not a complete collaboration success. |
| A broad unsolicited review finds a bug outside a concrete required dependency. | The useful result alone does not justify the initial review. | Count its actual quality benefit and cost when comparing policies; do not hide either. |
| The owner explicitly requests a named review. | Owner-directed contact, outside autonomous-selection precision. | Check fulfillment and account for all work normally. |

Use these paired judgments to calibrate reviewers before the pilot. Preserve
disagreements and resolve them against the task contract and evidence, not the
persuasiveness of the sender's explanation. A sampled offline judge can help
organize review later, but its own accuracy and cost also need measurement.

A closed negative outcome is not a permanent verdict on its source. D61/D62
contrast an unchanged context holder merely coming online with verified evidence
that it has now received the previously missing choice. Judge the new evidence
against the actual earlier failure, keep the same need and remaining allowance,
and read any newly published answer before contacting its author. A blanket ban
after `unknown` can miss necessary work just as a repeated question without new
evidence wastes attention.

## Review the obligations inside a necessary message

Do not give a mixed message a clean scope judgment merely because its first
question was necessary. Identify the requested facts/actions and test each
against the dependent work, available sources, and recipient evidence. For
example, a private device-selection question can be justified while an appended
request for documented build flags and a general plan review is avoidable.
Record justified contact and unnecessary added obligations separately.

The unit of review is an obligation, not a sentence, conjunction, or token.
Two indispensable values from one context can form one efficient request. Long
version constraints can be necessary; a short "anything else?" can commission
an unbounded investigation. D55/D56 distinguish locally known details from two
missing selections that should be requested together. Their action label is
`ask` in both cases: scoring only that label and the recipient misses the actual
message-scope difference. Review the authored request as well.

Use the same discipline on replies: the answer should establish what is known
and identify material unknowns or unperformed checks. An omitted optional review
need not generate a separate refusal exchange. Count the actual extra work and
any quality benefit in the outcome view, without letting hindsight authorize
the unnecessary request. These are semantic review criteria, not a daemon rule
that can be enforced by counting clauses or imposing a universal word limit.

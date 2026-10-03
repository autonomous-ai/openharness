# Alternatives, evaluation, and rollout

Status: proposed evaluation, with three bounded abstract lifecycle checks completed.
No live model benchmark or paid provider experiment was run for this design.

## Alternatives considered

| Approach | Benefit | Main failure | Decision |
| --- | --- | --- | --- |
| Tighten the current prompt only | Small change; may suppress greetings and reassurance asks. | Weak ownership metadata and unconditional late continuation remain. Models can rationalize optional contact. | Useful first mitigation, insufficient final design. |
| Let an agent pick the most similar available peer | Easy discovery; high apparent activity. | Similar titles do not establish current responsibility, private context, or the correct revision. | Use similarity only to retrieve evidence, never to force a recipient. |
| Elect a coordinator for every swarm | Centralized assignments and decisions. | Adds a bottleneck, token cost, and an authority structure the user did not create for independently owned tasks. | Optional future workflow for explicit projects, not the default swarm behavior. |
| Broadcast needs to the swarm | Can discover an otherwise hidden expert. | Charges every peer for uncertainty; creates duplicate replies and diffuse ownership. | Reject as the default fallback. Missing evidence should remain visible. |
| Shared directory and published results only | Very quiet, reusable context. | Cannot resolve genuinely private context or negotiate incompatible decisions. Stale records remain a problem. | Necessary foundation, not the entire product. |
| A second model approves every message | Can critique necessity. | Adds per-message inference; often sees only the sender's persuasive account and can make the same mistake. | Consider for offline evaluation or limited shadow sampling, not initially on the critical path. |
| Dependency evidence plus separate read, ask, work, and resume operations | Combines independent ownership with necessary exchanges and mechanical controls. | Requires accurate small records and provider capability verification; semantic necessity is still fallible. | Recommended, delivered in stages. |

## Research used to challenge the proposal

Anthropic's compiler experiment coordinated through a shared repository and task
claims, without a separate agent chat mechanism in that prototype. Its hardest
shared bottleneck also caused agents to duplicate the same fix. This supports
testing artifact/ownership coordination before adding more conversation; it does
not prove chat is never useful or that task files alone solve a mixed-provider
swarm. [Compiler experiment](https://www.anthropic.com/engineering/building-c-compiler).

Anthropic's later study distinguishes independent parallel discovery from work
with interdependent artifacts. It reports both coordination failures and cases
where unique information was not successfully shared. In its vulnerability
comparison, differing search scope explains part of the apparent advantage;
restricting scope changed the token-efficiency comparison. The relevant design
lesson is to measure useful outcomes and missed information, not message volume
or raw discoveries alone. [Multiagent study](https://www.anthropic.com/research/multiagent-systems).

Those are different systems and workloads. Their costs, agent counts, and
success rates are not estimates for Harness. The native product comparison and
the eight local exchanges are closer evidence for this product's specific UX.

Two additional primary-source checks sharpen the evaluation:

- [MAST, revision 3](https://arxiv.org/html/2503.13657v3) distinguishes missing
  clarification, unshared important information, ignored peer input, repeated
  steps, and weak outcome checking across its examined agent systems. We use
  that as a diagnostic reminder to inspect actual tool behavior and information
  flow, not as a failure-rate estimate for Harness or proof that an automated
  judge would work here. A well-written rationale and a correct final artifact
  can still hide a bad communication decision.
- The [matched-budget reasoning study](https://arxiv.org/html/2604.02460v2)
  compares selected multi-hop tasks and controls intermediate reasoning tokens,
  explicitly excluding prompts and final answers from that budget. Its full-
  context theoretical setup is different from a harness lacking a peer's private
  decision or physical environment. The relevant lesson is to use a competent
  independent baseline and measure actual resources. It does not establish a
  universal winner or estimate Harness's substantial native input-context costs.

## How the proposal handles observed cases

These are conditional design judgments using the limited evidence in
[observed-exchanges.md](observed-exchanges.md), not a measured replay.

| Case | Proposed behavior |
| --- | --- |
| A: broad product/UX status question | Read published state; do not start an open-ended prioritization discussion without a concrete dependency. |
| B: unsolicited broad review that found bugs | Apply own required validation. Admit independent review when the task/project actually requires it. Finding real bugs afterward does not establish necessity beforehand. Measure any quality loss from suppressing discretionary reviews. |
| C: suspected live-environment interference | Inspect causal process/resource evidence; ask the identified actor only if that information cannot resolve the actual interference. |
| D: progress announcement plus overlapping question | Publish the work claim; reuse the existing unresolved dependency rather than creating another broad request. |
| E: old ownership assumption | Read current claim state; completed unrelated work should not be treated as a current editing conflict. Absence of a claim is not a guarantee of no conflict. |
| F: recorded owner-origin handoff | Verify the originating owner action. Preserve genuine explicit transfers and acceptance; the API role alone cannot exclude the case from autonomous-selection review. |
| G: device context bundled with build instructions | Read build instructions locally; ask the evidenced device/context owner for the remaining necessary fact. |
| H: real prior-context question with a long progress report | Ask only for the missing prior decision. Preserve the valid answer that the user had not made the decision. |

## What to measure

Score task completion and correctness first. A silent failure must not win an
efficiency comparison against a necessary successful exchange.

| Metric | Definition / interpretation |
| --- | --- |
| Request-decision precision | Autonomous attempts to authorize peer work that were justified by evidence available to the sender at that decision, divided by such attempts. A cache hit or rejected send must not hide avoidable agent attempts. An interesting answer does not retroactively justify a broad ask. |
| Delivered-contact precision | Actual peer contributions that were justified at dispatch, divided by delivered contributions. Record admission, reuse, rejection, and delivery separately; a reused answer creates no new peer contact. |
| Wrong-recipient rate | Contacts whose selected peer lacks the evidenced responsibility/context/access. Separate avoidable stale routing from a legitimate claim changing after admission. |
| Request scope | Whether each requested fact/action is needed and belongs with this source. Record mixed requests that bundle unnecessary obligations into an otherwise justified contact; contact precision alone cannot reveal this waste. |
| Dependency recall | Necessary peer dependencies correctly resolved by a read, subscription, or right-peer contact. Failure to contact must not encourage guessing. |
| Task outcome | Required tests/artifacts/decisions correct for the requested version and environment; blocked/unknown reported honestly. |
| Total usage | Input, cached input, output/reasoning where available, and cost across requester, recipients, and any router/judge. Report providers separately; character counts are not tokens. |
| Extra peer work | Peer turns and tool work caused by the feature, including introductions, repeated waits, clarifications, and unsolicited reviews. |
| Time | End-to-end task duration and time on the critical dependency path, plus recipient owner's delay. A faster requester can still make the swarm slower. |
| Result use | Whether an answer changed a relevant action, satisfied a criterion, prevented duplicate work, or correctly established an unresolved fact. Transport receipt alone does not show this. |
| Stability | Stale resumes, duplicate work, cross-swarm routing, native-path escapes, draft/approval interference, and unacknowledged delivery uncertainty. |
| Maintenance overhead | Publishing and refreshing work records, directory reads, and extra context tokens. Include this overhead in every comparison. |
| Concentration at a source | Distinct necessary requests, duplicate requests avoided, producer queue delay, and the source owner's task delay. Count shared production once in total usage, regardless of consumer count. |

Necessary dependencies can be known before the task is fully blocked. Permit a
precise request early enough for a peer to answer at a natural boundary, provided
the accepted work actually requires it. Do independent work while waiting. Do
not turn hypothetical future improvements into dependencies to justify prefetch.

## Three evaluation layers

### 1. Protocol mechanics: partially checked

Run `python3 docs/research/2026-09-28-swarm-communication/check_continuation_model.py`.

The abstract model explores 8,250 event orderings in 14 families plus four
explicit success/inline-result paths. Under its serialized destination
assumption, it found no invariant violations in the proposed resume gate.
Deliberately weakened variants produced concrete counterexamples for:

- Checking authority at queue admission but not at actual dispatch.
- Re-enabling a feature and resurrecting a revoked continuation.
- Replaying uncertain delivery after a restart.

This is neither exhaustive verification of a distributed implementation nor a
test of existing provider adapters. The model assumes a matching answer and an
already-admitted dependency; it says nothing about necessity, peer selection,
content correctness, or real token savings. Real implementation tests must also
cover remote cancellation races, version checks, capability authentication,
input routes outside Harness, and destination serialization.

The separate [two-sided model](check_exchange_model.py) checks 6,807 bounded
orderings and nine positive paths for initial questions, one clarification,
step-aware waits, changed owner input, and passive human inspection. Its
[results](exchange-model-results.json) expose seven weakened-rule failures and
one lost-delivery contrast. Like the first model, it assumes that the ask was
necessary and admitted. It does not verify real step handles, actual tool-result
delivery, distributed propagation, accepted work, or native provider behavior.

The [wait-set model](check_wait_set_model.py) checks 35,364 additional orderings
and thirteen positive paths for one owner waiting on several necessary outcomes.
One grant per dependency can produce redundant owner resumes. Waiting for every
answer without surfacing a clarification/failure can instead prevent progress.
The model exposes both mistakes under stated abstract lifecycle assumptions;
it does not measure their frequency, native support, or real cost.

### 2. Decision vignettes: specification and future model test

The draft suite contains 62 [synthetic inputs](decision-cases.json) and separate
[manual oracle labels](decision-oracle.json). IDs and label alignment were
checked; no model has been scored on them. Provider assignments rotate across
case groups. Inputs contain no oracle fields. These are decision scenarios,
not executable coding environments or proof of a measured improvement.

Use paired scenarios where one material fact changes: local availability,
current ownership, revision, actual authority, or whether a decision exists.
The expected result is a read, subscribe, ask, request work, defer, or continue
independently. Include attractive decoys and legitimate unknowns.

Pass only scenario inputs to the model, keep oracle labels separate, and record
the tool action actually chosen. A prose claim that it would act correctly is
insufficient. Rotate names, engines, and positions so the model cannot learn
that “Claude” or the first directory row is always the right recipient.

The [blinded trial renderer](prepare_decision_trials.py) now prepares individual
inputs with independent name/provider/roster changes and keeps labels/mappings
in runner-only control data. Its [offline validation](decision-trial-validation.json)
checks 4,464 reversible renderings, not 4,464 model decisions. The
[review procedure](decision-review.md#blind-presentation-before-evaluating-selection)
defines isolation, paired-case presentation, and capability-specific limits.

Vignettes check boundary judgments. They do not establish end-to-end coding
quality or billable savings. Human/manual policy labels are a proposed rubric,
not measured model results. The 62 canonical scenarios were developed alongside
this policy and are a development/regression set, not an untouched holdout.
Renaming or rotating them does not create independent new task worlds.

For a future holdout, freeze the candidate policy and evaluator first, then use
separately constructed task worlds whose outcomes have not informed tuning. Keep
paired material contrasts and presentation variants together when splitting
worlds; do not tune on one variant and label its renamed twin held out. Report
results by task world and actual provider execution, with presentation sensitivity
separate from generalization. Repeated variants cannot be counted as thousands
of independent examples when estimating uncertainty.

Many of these inputs deliberately make the deciding fact explicit. Passing them
would show that an agent can apply the written rule, not that it can discover
that fact in a real task. The task pilot must add incomplete evidence, misleading
titles, stale publications, genuine ambiguity, and natural requests that do not
announce their own classification. Judge the observed decision and its timing;
do not demand one exact prose justification or punish a different valid plan.

### 3. Task-backed mixed-provider pilot: not run

Construct tasks with executable outcome checks and realistic opportunities to
avoid or require contact. The initial task prompt must not tell the model whom
to ask or force a communication round trip. Examples include implementing an
interface against a published schema, honoring a peer-held user decision, using
a device test produced elsewhere, and resolving a real shared-resource conflict.

Provide each harness only its own task context and the scoped directory. Private
peer facts must not also be trivially readable through the test fixture's shared
filesystem. Keep results and timing scripts isolated from production sessions.
Do not use real customer credentials or contact working peers as fixtures.

Compare at least these conditions with the same tasks, models, reasoning
settings, budgets, and artifact checks:

1. Current autonomous prompt and existing delivery policy.
2. Stricter instructions using the current sparse directory.
3. Stricter instructions plus fresh work records and selective resume.
4. Independent execution where the task is solvable locally, as a cost baseline.

This separates prompt effects from metadata and lifecycle effects. Include all
six directed cross-provider pairings among Claude, Codex, and Grok, and same-
provider controls. Repeat nondeterministic cases and keep a holdout set unseen
while tuning. Report raw counts and uncertainty; small samples cannot establish
near-perfect autonomous routing.

Measure every participating session, including directory maintenance. Use
observed usage fields, not guessed token/character ratios. If precise attribution
is unavailable, mark that metric unknown and use controlled isolated sessions
for cost comparisons. Do not extrapolate total savings from fewer messages.

### Separate routing quality from a perfect directory

Evaluate the same dependency under four metadata conditions:

- A correctly seeded directory, used only to test routing with good evidence.
- Records actually published by the working agents, charging their upkeep.
- A cold directory with idle unprofiled peers.
- Stale, conflicting, or incomplete records with provenance intact.

Only the second condition can support end-to-end cost claims for automatic
publication. A manually seeded perfect directory is an upper-bound control; it
must not make the proposal appear cheaper by hiding the publisher's work.
Include record maintenance for tasks whose records are never used.

Keep substantial independent tasks in the workload. A suite made entirely of
forced dependencies unfairly favors collaboration. Treat a deliberately balanced
stress suite as a stress suite, not as an estimate of normal developer usage.

The executable fixture now includes a `local` control: the exact required fact
is in each consumer's repository, while the directory still identifies a real
qualified peer. It changes only those decision files relative to the private-
source world. This tests the necessity gate separately from finding the right
peer. A `published` condition tests shared-record reuse instead. Neither one
requires an author turn; the local condition also needs no swarm discovery for
that fact. Count unnecessary lookups and failed/cached ask attempts even when
the final artifact is correct. The offline judge does not yet score those events.

### Publication coverage is a first-class outcome

A correctly abstaining requester can still reveal a weak system. If a peer holds
the required answer but the directory never makes that source discoverable,
abstaining may follow the policy while the end-to-end dependency remains missed.
Do not count every cold-directory abstention as a successful collaboration just
because it avoided a wrong message.

Record the stages separately:

| Stage | Failure it can reveal |
| --- | --- |
| The accepted task actually requires an unavailable fact/result. | The agent invents a dependency, or misses a real one. |
| A qualified source or readable result exists in the permitted swarm. | The input is truly unavailable, outside scope, or still undecided. Those cases are not all routing failures. |
| Accurate relevant evidence is published before it is needed. | A quiet expert is invisible, a claim is stale, or publication gives a wrong account of the decision. |
| Discovery retrieves that evidence for the real task's query. | Indexing/query mismatch hides a record that exists, or similarity promotes a decoy. |
| The requester chooses read, ask, wait, or independent work correctly. | Unnecessary contact, wrong recipient, missed available result, or premature blockage. |
| The recipient's outcome is correct and used appropriately. | Bad information, excessive investigation, rejected valid evidence, or an unresolved choice reported as success. |

Report routing quality conditional on usable evidence and end-to-end dependency
handling together. The former diagnoses the policy; the latter prevents a perfect
directory or a high abstention rate from hiding a broken product experience.
An answer that correctly establishes "no earlier decision" can resolve the
information question while the implementation still needs an authorized choice.
Keep those outcomes separate in task completion counts.

### Compare the cost of keeping peers discoverable

Use three publication policies with the same task workloads: sparse existing
metadata, selective shared-work/result publication, and one record for every
substantial task. Do not assume the broadest directory or the fewest records wins.
Charge unused publications as well as the records that later save work.

The accounting question is whether avoided peer turns and avoided reconstruction
outweigh record creation/refresh, discovery, extra prompt context, stale-record
mistakes, and the contacts that remain. This is a comparison of measured complete
episodes, not a numeric estimate the model must invent before sending a question.
Preserve per-provider input/cache/output counters; pricing or subscription costs
can be applied later using the actual applicable terms.

A title or plan already generated by the provider can be a low-cost search hint.
It cannot be relabeled as a current ownership claim merely to make maintenance
appear free. Similarly, batching publication with a necessary tool call may avoid
an extra model iteration while still adding context and tool-result tokens.

Within the selective-publication condition, compare a plain update receipt with
a response that also returns bounded, applicable same-subject evidence. Keep
underlying records and tasks identical. Measure required conflicts discovered,
redundant lookups avoided, compatible-peer claims that incorrectly trigger asks,
omitted/late matches, and added context. A returned record is not necessarily a
reason to contact its author. This is an opportunity during qualifying work,
not a directory scan required for every turn or evidence that all unknown
dependencies have become discoverable.

The current recommendation is selective publication because it fits the desired
ownership model and avoids a compulsory update for unrelated work. It remains a
hypothesis to compare against broader publication, especially for future-needed
user decisions whose importance the publisher cannot predict. The directory must
preserve unknowns rather than manufacture evidence to compensate for poor recall.

### Alternatives for the quiet expert who has no record

Missing publication cannot be repaired by pretending a title proves knowledge.
Compare the actual information gained with the work and access it requires:

| Mechanism | What it can establish | Limitation and decision |
| --- | --- | --- |
| Reuse provider titles and observed workspace/activity | A cheap hint about a likely subject. Current `sessionTitle.ts` reads existing provider names; it does not run a new Harness summarizer. | Keep as a search hint. A name does not establish the exact decision, revision, or current responsibility. |
| Selective work/context/result publication | An identified source or a directly readable answer, including records from authors with no outgoing questions. | Primary proposal. Charge publication and reaffirmation costs; measure omitted future-needed facts. |
| One publication for every substantial task | Broader opportunities to find historical context holders. | Comparison condition, not assumed winner. It adds upkeep and can still omit the particular fact that will matter later. |
| Targeted retrieval from a peer's underlying conversation | May recover an existing fact without starting its author. | Requires a different shared-data contract and reliable origin, role, scope, and completeness handling. A matching quoted snippet is not necessarily a decision. Do not silently add transcript access to the publication/read contract. Reconsider only with evidence that the narrower directory misses important needs. |
| A board of unanswered needs or notices for new candidate sources | Could connect a later publication to an already known missing input. | A broad board moves search/context cost into other owners' work. Similarity matches must not create automatic turns. Prefer exact-result subscriptions where the required result is already identifiable; keep arbitrary source-discovery wakeups out of the first design. |

No option establishes private, unrecorded knowledge in an indefinitely idle
session for free. Keep this information limit explicit rather than describing
correct abstention as complete dependency recall. Improving coverage must earn
its maintenance cost and preserve the user's choice of what the swarm shares.

Mutable records add another measurable cost: reaffirming that a policy is still
current after accepted human input. This is different from refreshing a name or
heartbeat. Historical pinned results remain readable without an author turn;
the extra assurance is needed only when the consumer actually requires current
state. Include that distinction in publication and avoided-confirmation counts.

### Concrete task worlds

The [offline upload-recovery fixture](pilot-fixture.md) makes the prior-decision
world executable with three owner tasks and private oracle checks. Its generator
does not start providers, and its artifact judge deliberately does not call a
correct answer a successful communication policy. Live event capture, publication
timing, recipient disruption, and usage accounting remain to be measured.

Its two-consumer variant makes both Alpha and Gamma depend on Beta's same policy
fact. Vary whether they arrive concurrently, see an already pending request, or
read the published answer later. Correct artifacts after two duplicate questions
are not an efficiency success. Keep Beta's own task in the episode and charge
its usage once. Active consumer withdrawal versus passive observation belongs
in the protocol gates; the artifact judge does not simulate it.

| World | Outcome check | Communication distinction |
| --- | --- | --- |
| Versioned interface change | Produced client accepts the required schema and rejects the wrong version. | A readable schema needs no author turn; an absent private contract needs its evidenced source. |
| Prior user decision | Implementation matches a seeded user choice, or correctly reports that none was made. | A tempting related title must not replace the actual discussion holder. |
| Required test result | Packaging uses only a passing result for the exact revision/environment. | A running producer needs a subscription; an idle/failed producer is not a passed test. |
| Shared live resource | Both owner tasks complete without conflicting operations in a synthetic resource log. | Causal overlap needs specific coordination; sharing a repository alone does not. |
| Changed human work | Only the new requested artifact changes after a steering/task-switch event. | A delayed old reply remains a record and cannot start an old task again. |
| Independent work with attractive peers | All ordinary task outputs pass their checks. | Membership, expertise advertisements, and available idle peers create no reason to ask. |

Use separate private provider contexts for hidden facts, rather than putting the
answer in a shared fixture directory and merely telling agents not to read it.
Begin each independent episode with fresh task state and an empty result cache.
An author may publish a previously private fact during its normal work: the
consumer should then read it. The evaluator must follow the actual timeline;
it must not insist on an ask after the answer became available.

For active peers, give each one its own meaningful task and include brief-known-
fact questions as well as requests that conceal substantial investigation. A
requester's faster finish is insufficient if it stalls the recipient's owner.
Exercise reciprocal waits and ready-result/incoming-question races separately
from semantic routing so the cause of a failure is visible.

### Adjudication and accounting

Use the [decision review procedure](decision-review.md) to keep the requester's
earlier evidence, the service's dispatch state, and the eventual outcome separate.
It distinguishes an accessible but skipped local source from an unseen later
publication, audits no-contact omissions, and leaves missing evidence unknown.
Zero attempted contacts do not produce a meaningful precision percentage.

Assess necessity using the sender's available evidence at send time, before
showing the reviewer a surprisingly useful answer. Assess recipient correctness
against the actual context/responsibility/access records. A context holder
correctly answering “no decision was made” is a valid source, not a wrong-peer
failure. Report failures caused by stale publication separately from poor
selection despite good evidence.

Keep the sender's observed snapshot and causal event order as well as the service's
admission/delivery state. A result can become available after a justified decision
to ask but before dispatch; a good service then returns it without contacting the
author. That differs from an agent asking despite already seeing the answer.
Conversely, an unnecessary ask intercepted by the service still costs requester
work and reveals a policy failure. Report both layers instead of calling all
intercepted asks good or blaming the sender for information not yet available.
Wall-clock ordering across machines alone does not establish what an agent knew.

Count publication/discovery tool round trips, hook latency, prompt context,
cached input, outputs, provider-side auxiliary work where measurable, and every
affected harness's usage. Publishing inside an existing turn can still add a
model/tool round trip. If provider usage already aggregates native children,
avoid counting both the aggregate and those same child totals again.
Test cache behavior when enabling the feature, changing membership, refreshing
work records, and receiving a result. A passive-context integration that repeatedly
changes an early prompt prefix could move cost into ordinary work instead of
reducing it. The native [usage follow-up](observed-exchanges.md#native-usage-follow-up)
provides observed counter windows, not a causal estimate of that effect.

Randomize trial order and rotate provider/name/position assignments. Pair task
worlds and seeds across policies, report every failed or unresolved trial, and
keep the holdout set untouched during tuning. Specify the run count, usage cap,
quality thresholds, and acceptable recipient delay before the paid pilot. Those
values need a concrete test harness and spending envelope; they are not measured
results from the current design investigation.

The older approved three-provider transport test established delivery and reply
correlation under explicit instructions. It is not this autonomous pilot, and its
limited spending authorization is not reused for this investigation.

## Rollout and stopping criteria

First ship the mechanically understandable reductions: quiet membership setup,
short instructions, explicit request outcomes, and task-bound continuation.
Use the existing account-level experimental toggle and keep the default off.
Do not turn on automatic bounded work in the first pilot.

Then add work/context records and evaluate brief asks. Before enabling the new
policy more widely, require:

- No known cross-swarm, stale-task, duplicate-dispatch, permission-provenance, or
  human-input interference failures in conformance testing.
- Correct behavior for every specified must-ask and must-not-ask fixture.
- Task outcome at least maintained against the baseline on the held-out tasks.
- Fewer avoidable peer turns and lower measured total usage after record upkeep,
  with acceptable dependency latency and recipient disruption.
- Honest unresolved states and a practical route to inspect/fix missing or stale
  responsibility records.

Those are release criteria, not current achieved results. Numerical targets for
statistical precision and cost reduction should be set before the paid pilot
once its task mix and spending envelope are fixed; do not invent measured gains.

Stop or narrow the experiment if agents route by titles alone, publish misleading
claims, repeatedly reframe optional contact as required, starve owner tasks, or
guess missing facts to keep message counts low. Preserve the ledger for diagnosis
and revert policy/adapter changes independently. Disabled collaboration must not
clear users' sessions or delete historical results.

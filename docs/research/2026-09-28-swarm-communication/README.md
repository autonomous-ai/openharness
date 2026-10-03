# Swarm communication design investigation

Status: design complete and ready for implementation review. The investigation
started September 28, 2026 at 17:19 UTC. The [completion review](design-review.md)
maps the original questions to decisions, evidence, and remaining implementation
gates. This folder is design and evaluation work, not a change to the running
collaboration policy.

## The product requirement

Harness provides one A2A layer across supported agent providers: a Codex harness
can consult a Claude Code or Grok harness in the same swarm. A pane is its view;
the harness session is the participant. Provider-native communication is design
research and an adapter consideration, not the product's collaboration boundary.
Each participant retains its own context, tools, and permissions.

Agents should work like capable colleagues with ownership of their own tasks.
They should contact one particular peer briefly when that peer has something
necessary to finish the work. Availability, a vaguely relevant title, a desire
for reassurance, or the possibility of a useful second opinion is insufficient.
If the requesting agent can reasonably obtain the result itself, it should.

The goal is successful independent work with occasional necessary exchanges.
Low message count alone is not success: a silent agent that guesses an interface
instead of obtaining a necessary decision also fails.

## Current design recommendation

Let a concrete dependency trigger communication. The sender must know what
action needs the missing input and why an evidenced peer is the right source.
Being in the same swarm makes a peer eligible; it does not make asking useful.

| Situation | Behavior |
| --- | --- |
| The agent can reasonably finish the work itself. | Continue independently. No directory check or review ceremony is required. |
| The needed fact/result is available. | Read it without starting its author. |
| A particular peer holds required unpublished context. | Ask one bounded question, with the dependent action and necessary version/context. |
| The exact required result is already being produced. | Wait on that result; do not ask for progress or commission it again. |
| Necessary new work belongs with a peer's evidenced capability or responsibility. | Offer the bounded operation. The recipient accepts within its own authority and priorities. |
| No qualified source is established. | Preserve the missing need, continue useful work, and use the owner's authorized judgment where appropriate. Do not query random peers. |

Small shared work/decision/result records make peers discoverable during their
normal work. Publish the useful short fact itself when possible. No idle setup
conversation, profile-filling turn, default coordinator, or broad transcript index
is required. Record upkeep still has a cost and can miss unanticipated future
needs; the evaluation must measure that tradeoff.

A shared answer is a fact already made available inside the swarm, including a
prior peer reply. A pending request is a tracked question awaiting its result.
For the same need and material version, read the existing answer or follow the
existing request instead of sending a duplicate. The user has no publishing
step to perform.

Both owners keep control of their work. A brief question does not commission an
investigation. A new human input suspends obsolete outgoing work and revokes old
automatic answer wakes. Reuse a still-needed dependency explicitly; never wake
whatever task happens to occupy the pane later. Replies need no thank-you turn.

This is the recommendation to implement and evaluate. Measured precision, token
savings, and complete native-adapter compatibility are not established by the
design documents or offline checks.

## Questions this investigation must resolve

1. What exactly causes communication today, and which real exchanges could have
   been avoided? Distinguish model decisions from daemon delivery triggers.
2. What constitutes a dependency strong enough to justify contact?
3. How does an agent identify the particular peer who has the needed answer,
   artifact, ownership, or access? What counts as evidence, and when is it stale?
4. How can that evidence stay current without human role forms, constant model
   summarization, or publishing entire conversations?
5. When should an agent read a shared artifact, ask a question, coordinate an
   overlapping change, request bounded work, or continue independently?
6. How do requests respect both agents' current tasks, human instructions,
   permission boundaries, swarm origin, availability, and attention?
7. How do cancellation, changed tasks, delayed answers, retries, mutual waits,
   wrong recipients, and unavailable owners avoid generating extra work?
8. What is the smallest useful request and response? How are answer provenance,
   freshness, acceptance, and subsequent use established?
9. Which rules belong in instructions, which can the daemon enforce, and which
   require evaluation because they are semantic judgments?
10. How do we measure saved work, recipient disruption, wrong-peer contact,
    unnecessary contact, missed dependencies, time, and total token cost?
11. What can the current Claude, Codex, and Grok integration actually support?
12. What should be built first, how should it be piloted, and what evidence would
    justify enabling the new behavior more broadly?

## Evidence and deliverables

- [Design completion review](design-review.md): requirement-by-requirement audit,
  verified evidence, and explicit limits on what is ready versus still untested.
- [First implementation brief](implementation-brief.md): concrete release slices,
  record upkeep, cold start, recipient priority, and a reproduced continuation gap.
- [Small agent contract](agent-contract.md): candidate stable instructions,
  minimal agent arguments, explicit tool effects, and avoided round trips.
- [Decision review procedure](decision-review.md): separate the evidence available
  before contact, the service's delivery decision, and the eventual outcome;
  inspect omissions as well as successful exchanges.
- [Minimum conformance plan](conformance-plan.md): concrete release gates for
  scope, quiet setup, task lifetimes, all provider directions, and honest status.
- [Current behavior audit](baseline.md): code paths, runtime observations, and
  explicit limits on what those observations prove.
- [Observed exchanges](observed-exchanges.md): eight paraphrased local cases,
  conditional assessments, notice sizes, and the limits of this small sample.
  A later [native usage audit](usage-window-observations.json) records ten matched
  Codex notice windows with explicit limits on attribution and completeness.
- [Investigation log](worklog.md): completed work, decisions, evidence, remaining
  questions, and the next concrete action.
- [Provider-native comparison](native-session-comparison.md): Claude Code, Codex,
  and Grok; independent sessions versus delegated agents, passive reads versus
  work, and native scope gaps. [Local evidence metadata](native-evidence.json) records versions and
  reproducible read-only checks.
- [Proposed communication policy](policy-proposal.md): necessary dependencies,
  recipient evidence, work records, timing, and developer experience.
- [Protocol and adapters](protocol-and-adapters.md): cross-provider operations,
  task/continuation lifetimes, capability gaps, and staged integration.
- [Alternatives and evaluation](alternatives-and-evaluation.md): tradeoffs,
  research caveats, observed-case decisions, metrics, and rollout criteria.
- [Decision inputs](decision-cases.json) and [separate manual labels](decision-oracle.json):
  62 synthetic scenarios ready for review and a future model evaluation.
- [Blinded trial renderer](prepare_decision_trials.py) and [offline validation](decision-trial-validation.json):
  independent name/provider/roster variants with private labels kept separate;
  4,464 reversible renderings checked, no model decisions scored.
- [Offline task fixture](pilot-fixture.md) and [generator/judge](pilot_fixture.py):
  three owner tasks, one or two consumers, private/published/local fact controls,
  and output checks. Its [verifier](verify_pilot_fixture.py) runs hand-written
  reference code; no agents are launched and communication remains unscored.
- [Abstract continuation check](check_continuation_model.py) and
  [results](continuation-model-results.json): 8,250 bounded event orderings;
  no production or autonomous model-quality claims.
- [Two-sided exchange check](check_exchange_model.py) and
  [results](exchange-model-results.json): 6,807 bounded orderings, including
  clarification stages, input changes at either side, and human inspection
  that cannot consume a waiting agent's continuation. No provider execution.
- [Owner wait-set check](check_wait_set_model.py) and
  [results](wait-set-model-results.json): 35,364 bounded orderings for several
  required outcomes, one owner continuation, and necessary intervention during
  an all-results wait. These are abstract protocol checks, not native tests.
- [Current goal-scope reproduction](reproduce_goal_scope.mts): synthetic events
  through current source confirm that an automatic Codex goal continuation loses
  its originating swarm. No live provider work is started.
- [Delayed-invocation reproduction](reproduce_invocation_scope.mts) and
  [observations](invocation-scope-observations.json): current service admissions
  cannot distinguish an older delayed context lookup or an obsolete input within
  the same swarm. Synthetic inputs only; no provider or terminal delivery.

Next: implement the reviewed release slices, then verify the actual adapters
and run a separately authorized behavioral pilot. Native conformance, autonomous
decision quality, and net token savings remain unverified.

Repository changes for this investigation stayed in this folder. No production settings, ongoing peer
tasks, account data, or provider logins were changed during the investigation.
Private exchanges were analyzed locally; exported examples are paraphrased or
synthetic. The preexisting naming and prompt-scope work was preserved.

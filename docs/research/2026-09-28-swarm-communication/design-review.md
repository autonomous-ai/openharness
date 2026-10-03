# Design completion review

This reviews the requested design, not a production implementation. The objective
was selective, autonomous communication between capable agents: independent
ownership, a necessary input or operation, an evidenced recipient, appropriate
timing, and a brief exchange. The original scope includes Codex, Claude Code,
Grok, and other supported providers inside the originating swarm.

The recommendation is ready for implementation review. It does not establish
perfect routing, measured savings, or verified native support for every proposed
adapter primitive. Those claims require the separate implementation and pilot
gates specified below.

## The twelve investigation questions

| Question | Design resolution and inspected evidence | Limit retained |
| --- | --- | --- |
| 1. What causes communication today? | [Current audit](baseline.md) traces membership introductions, broad model instructions, sparse directory metadata, ask admission, reply notices, and bounded CLI waits. [Eight observed cases](observed-exchanges.md) distinguish specific needs from broad status/review requests. Current `prompts.ts` and `command.ts` were re-read during closeout. | Source is the current worktree, not proof of the installed daemon. The small local sample cannot establish a waste rate; an API owner label alone cannot prove human intent. |
| 2. What is necessary enough to ask? | [Policy](policy-proposal.md#what-qualifies) requires a concrete dependent action plus missing context, a result, responsibility, or access. Check the obvious authoritative source, while avoiding expensive reconstruction of work the exact peer already did. | A plausible four-field request does not prove necessity. Semantic judgments require evaluation. |
| 3. Who is the right peer? | [Source selection](policy-proposal.md#finding-the-right-peer) separates exact responsibility, known context, and mere hints. [Record validity](protocol-and-adapters.md#historical-evidence-versus-a-current-assertion) separates immutable results from current commitments. | Names, models, availability, timestamps, and cwd are insufficient. Unrecorded private knowledge remains undiscoverable. |
| 4. How is discovery maintained? | [Implementation brief](implementation-brief.md#make-discovery-useful-without-a-second-workforce) specifies selective updates during authorized work, direct publication of short facts, and no idle profiling. Relevant evidence can return with an already-required update. | Publication has upkeep/context cost and can miss future needs. A claim is not a filesystem lock or a complete inventory of concurrent work. |
| 5. Which action should follow? | [Small interface](agent-contract.md#small-tool-surface-explicit-effects) distinguishes read, publish, ask, reply, wait, and dependency updates. [Bounded work](protocol-and-adapters.md#bounded-work-beyond-the-brief-question-pilot) specifies acceptance for necessary new operations. | New work is not hidden inside a question. The first implementation covers brief questions; the full design retains later accepted work. |
| 6. How are both tasks respected? | [Task origin](protocol-and-adapters.md#task-origin-and-new-input) binds accepted input and swarm independently of pane focus. [Recipient attention](protocol-and-adapters.md#recipient-attention-between-contributions) prioritizes human input and ready owner work. Peer text does not grant authority. | Current source reproductions reveal origin/continuation gaps. Native turn identity, hooks, and a terminal's idle state do not independently prove the proposed guarantees. |
| 7. How do retries and changing work stay quiet? | [Closed outcomes](protocol-and-adapters.md#after-an-answer-or-a-closed-question), stable needs, explicit adoption, one owner wait cycle, and [cancellation rules](protocol-and-adapters.md#cancellation-and-distributed-races) prevent new IDs or late replies from granting fresh work. | Abstract checks assume trusted serialized boundaries. Uncertain remote effects cannot be treated as undone or safely replayable. |
| 8. What is the smallest useful exchange? | [Agent arguments](agent-contract.md#agent-arguments-versus-service-metadata) use source, question, dependent action, and the bounded source check. The host supplies identity/authority. Replies retain material context and become reusable without a second publication. | Small means sufficient for the dependency, not an arbitrary word limit. Delivery/read/answer does not prove use or owner-task completion. |
| 9. What can the system enforce? | [Admission contract](protocol-and-adapters.md#admission-and-delivery-are-separate) handles scope, identity, generations, existing handles/contracts, expiry, and delivery effects. The policy handles necessity, relevance, and required message contents. | Exact declared contract reuse is not arbitrary semantic deduplication. Model-written owner claims do not acquire trusted human provenance. No per-message judge model is assumed. |
| 10. How will improvement be measured? | [Decision review](decision-review.md) separates proposal, delivery, and outcome using actual evidence available at each point. [Evaluation plan](alternatives-and-evaluation.md) measures all owners' quality, delay, complete usage, publication, missed dependencies, and unnecessary obligations. | Native usage windows are observations, not causal savings. Manual cases and correct artifacts cannot prove selective communication. |
| 11. What do the providers support? | [Native comparison](native-session-comparison.md), [evidence metadata](native-evidence.json), and the [adapter matrix](protocol-and-adapters.md#adapter-evidence-and-capability-matrix) distinguish inspected interfaces, pinned source, and future runtime gates. | A public Grok source revision differs from the installed build. MCP/session headers and managed protocols do not establish accepted-input provenance or attachment to arbitrary running terminals. |
| 12. What should be built first? | [Release slices](implementation-brief.md#small-release-slices) begin with quiet setup, task/input identity, concise policy, and brief evidenced exchanges. Subscriptions/sharing and accepted new work have separate [conformance gates](conformance-plan.md). Preserve the account-level default-off experiment and existing inspection view. | No production changes or new live pilot were performed in this design investigation. Release gates are requirements, not passing results. |

## Evidence checked at closeout

- Reproduced all three abstract models and compared their complete JSON outputs
  with the saved reports: 8,250, 6,807, and 35,364 bounded orderings respectively.
  All matched. Their positive paths and weakened-rule counterexamples remain
  explicit; none executes a provider or tests semantic necessity.
- Verified the delayed-invocation reproduction's hashes against the current
  five service/scope sources, and the native input-integration hashes against
  the current three integration sources. The saved invocation observations
  record zero transport calls. Re-ran the separate goal reproduction with
  synthetic normalization events: initial origin survives, automatic continuation
  loses it, and a typed lookalike remains unknown. No installed runtime was used.
- Verified the 52-check artifact-fixture record against its generator/verifier
  hashes. It checks hand-written reference implementations, including hidden
  policy separation and frozen artifacts; communication and usage stay unscored.
- Verified the 62-case, 4,464-rendering decision record against its source hashes.
  These are reversible presentations of development scenarios, not model runs,
  independent task worlds, or an untouched holdout.
- Checked local document targets/anchors and JSON/Python syntax. The closeout
  [validation record](design-review-validation.json) captures checked hashes and
  separates completed offline checks from unrun native/behavioral gates.

## What follows the design

Implementation should use the small agent contract and release slices; the
detailed protocol exists to make their effects precise, not to paste every edge
case into every prompt. Read/reuse and quiet setup come first. Preserve the full
accepted-work design without enabling it before its own gates pass.

The future conformance suite must establish actual supported input/delivery
routes, all six directed provider pairings, same-provider controls, and any
advertised remote participation. A separately authorized pilot must then compare
equivalent task worlds with frozen criteria, isolated private facts, measured
owner outcomes, and complete usage. Choose its spending envelope and numerical
quality/latency criteria before running it; the old transport-test approval does
not authorize that new experiment.

These are implementation and empirical validation steps after the design. They
remain unachieved and must not be described as evidence that the proposed agents
already behave precisely or efficiently. The completed deliverable is a concrete,
source-informed design and a reproducible way to test its claims.

# A design council for the coding companion

The subsequent [modern practitioner study](../research/2026-09-30-modern-coding-memory.md) extends these foundations with agent workspace design, task-dependent collaboration, working examples, experimental evidence, and maintained coding knowledge.

Status: design proposal, 2026-09-30. The council below is a synthesis of published work, not a meeting, simulated testimony, or endorsement by its authors. These are complementary engineering perspectives, not an objective ranking of the best programmers. Their documented ideas inform the design; the proposed memory system and the decisions below are ours.

Build a pair programmer that remembers how this developer makes decisions, why this project works as it does, and what happened when an idea met reality. The LLM supplies current reasoning and tool use. Memory supplies relevant prior evidence, context, and preferences. Neither replaces checking the present code or listening to the developer.

This extends the [coding product model](2026-09-30-coding-memory-product.md) and [service architecture](2026-09-30-tim-memory.md). The scope remains coding on one machine across Claude Code and Codex, with the selected companion DSH supplying learning intelligence. Cross-machine synchronization comes later.

## The council and its design influence

Each source column describes the published work. Each design column is our application of that work, not a claim about what its author would build today.

| Perspective | Documented idea and primary source | Our design consequence |
| --- | --- | --- |
| Peter Naur: understanding the program | Programming involves understanding the relation between a program and its world, explaining design choices, and knowing how to change it. He also argues that this understanding exceeds documentation. [Programming as Theory Building, 1985, reproduced paper](https://gwern.net/doc/cs/algorithm/1985-naur.pdf). | Retain rationale, domain connections, assumptions, and unanswered questions. A project model helps reconstruct understanding; it cannot claim to encode all of someone's tacit knowledge. |
| Edsger Dijkstra: reasoning about correctness | His constructive approach connects program structure to tractable correctness arguments and distinguishes testing from proof. [Structured programming, EWD268, 1969](https://www.cs.utexas.edu/~EWD/transcriptions/EWD02xx/EWD268.html). | Separate required invariants, reasoned arguments, test observations, and open hypotheses. A green suite does not establish every claimed property. |
| Barbara Liskov and Jeannette Wing: behavioral contracts | Compatible method signatures alone are insufficient; subtype behavior must preserve the relevant properties of its supertype. [A Behavioral Notion of Subtyping, 1994](https://www.cs.cmu.edu/~wing/publications/LiskovWing94.pdf). | By analogy, adapters must preserve memory meaning, scope, and uncertainty, not merely accept the same JSON. Certify observable behavior per host and expose unsupported capabilities. |
| David Parnas: boundaries around change | Module decomposition should hide difficult decisions or decisions likely to change. [On the Criteria To Be Used in Decomposing Systems into Modules, 1972](https://ckrybus.com/static/papers/decomposing_systems_into_modules_1972.pdf). | Separate transcript decoding, knowledge storage, learning, selection, and host delivery. A changed CLI transcript or model must not redefine memory identity or scope. |
| Donald Knuth: explanation for people | Literate programming treats programs as human-readable explanations linked with their implementation. [Author's account of Literate Programming](https://cs.stanford.edu/~knuth/lp.html). | Every useful memory must make sense as a short statement with its reason and evidence. Keep accepted code/design examples with revision pointers; show explanations in context. |
| Dennis Ritchie and Ken Thompson: composition | Their Unix paper describes common I/O interfaces, pipes, and a compact system intended to be understandable and easy to use. [The UNIX Time-Sharing System, 1978 revision of the 1974 paper](https://www.nokia.com/bell-labs/about/dennis-m-ritchie/cacm.html). | Use a small memory service with composable operations and thin adapters. Keep SQLite and bounded local retrieval initially; richer infrastructure must earn its cost. |
| Kent Beck: short feedback cycles | His account of TDD develops one concrete runnable test at a time, makes it pass, and optionally refactors. He explicitly leaves responsibility for quality with the practitioner. [Canon TDD, 2023](https://newsletter.kentbeck.com/p/canon-tdd). | Remember the developer's preferred feedback sequence and the actual result. Evaluate the companion on completed work, not its ability to repeat principles. TDD is available, not imposed on everyone. |
| Rich Hickey's Clojure: identity over time | Clojure distinguishes a stable identity from the different immutable values associated with it over time. [Official account of values, identity, and state](https://clojure.org/about/state). | Preserve a memory ID while creating explicit revisions. Distinguish what was believed then, what applies now, and what changed; do not silently rewrite the past. |
| Margaret Hamilton: recovery and priorities | In her first-person Apollo recollection, Hamilton describes error detection, recovery, and preserving essential work under overload, as part of a team effort. [MIT recollection, 2009](https://news.mit.edu/2009/apollo-vign-0717). | Learning is durable background work. Recall has a deadline, inference can wait, and a memory failure must leave the coding session usable. Report incomplete recovery honestly. |
| Bret Victor: visible understanding | His programming-environment design makes behavior and state visible, supports exploration, and explains concepts where they are used. [Learnable Programming, 2012](https://worrydream.com/LearnableProgramming/). | Let the developer inspect why a memory affected a choice, compare an accepted example with the current work, and correct it directly. Keep feedback close to the task. |

Historical techniques are not universal prescriptions. This council provides design tests and vocabulary. It does not populate a user's memory with celebrity preferences, assign the user a famous-programmer personality, or ask an LLM to impersonate anyone.

## Decisions after comparing the perspectives

### Remember judgment with its conditions

The basic unit is a sourced claim that can improve a future decision. A useful style memory says **when this situation occurs, prefer this approach, because of this tradeoff, except under these conditions**. It may also link to an example the developer explicitly accepted.

This represents styles such as deriving an invariant before implementation, exploring concrete examples first, composing small functions, protecting interface contracts, or measuring a hot path before changing it. Multiple styles can coexist by task and component. No numerical personality vector or single label needs to reconcile them.

Keep three kinds of authority separate: product-level engineering safeguards, sourced external references, and what this developer actually chose. An article can be a reference without becoming a user preference. A recalled preference is context, never a new grant of permission or a reason to violate current requirements.

### Preserve understanding while admitting its limits

Naur's concern exposes a limit of any archive; Knuth's approach gives us a way to make the explainable part useful. Our resolution is a **working project model** assembled from independent, scoped records: domain concepts, accepted decisions, required invariants, observed findings, and unresolved hypotheses. It is an inspectable aid to understanding, not a complete digital copy of a programmer's mind.

Store reasons actually expressed by the user or in reviewable work artifacts. A plausible reason invented after the fact stays an unverified hypothesis. Do not ask for or store private model reasoning traces. Ordinary code facts should be refreshed from the repository; retain the expensive explanation of why they matter.

### Keep different kinds of evidence distinct

Correctness arguments and empirical feedback answer different questions. Our design uses both without making one stand in for the other. Verification metadata records the method, artifact, revision/environment, result, coverage, assumptions, and limits where available. Missing information stays unknown.

A passing test establishes an observation for that run. A benchmark requires its workload and conditions. A proof or static check establishes a property only within its stated assumptions. A visual approval applies to the reviewed attributes and version. A claim that retries are safe needs more than one successful request. These distinctions travel with the memory across frameworks.

### Keep the core small and the understanding rich

The project model and developer profile are views over records, not separate biographies or mandatory graph databases. Optional structured detail captures a decision or experiment only when the episode supports it. Common operations stay `recall`, `search`, `read`, `propose`, `feedback`, `correct`, `forget`, and `status`.

Decoding a framework, choosing an extraction model, indexing content, and delivering a packet can change independently. Contract tests must verify scope, uncertainty, budget, and delivery status at each adapter. If one host cannot confirm receipt, report that limitation rather than marking the memory used.

### Adapt without agreeing blindly

The companion should fit a developer's workflow while remaining a competent reviewer. Within current authorization and applicable instructions, use project requirements to determine viable choices; personal defaults help choose among those choices. If a remembered preference conflicts with evidence, explain the concrete conflict and propose an alternative. Ask only when an unresolved choice materially affects the work.

For example: a preference for an in-process cache can fit one deployment. A new requirement for multiple independent writers changes the problem. Recall the original rationale, inspect the current architecture, and reconsider coordination. Do not silently change the user's general preference because this task needs an exception.

### Preserve history and allow real forgetting

Normal changes create revisions with lineage. Forgetting is a separate purge operation that removes owned content and derived copies under Harness control, subject to the architecture's explicit retention policy. Immutability is not an excuse to keep deleted text forever. A minimal content-free suppression record can prevent immediate reimport. Already delivered native conversation text remains a separately disclosed limit.

## What the memory stores

The existing record envelope supplies identity, revision, evidence, scope, state, and validity. Add optional details to these existing kinds; do not require a new table or complete questionnaire for every facet.

| Shape | Existing kind | Additional information when supported |
| --- | --- | --- |
| Conditional working style | `working_preference` | Approach, task conditions, reason, exception, accepted/rejected example references. Reasoning and feedback sequence belong here too. |
| Engineering decision | `project_decision` | Problem, considered alternatives, chosen option, rationale, expected result, observed outcome, reason to revisit. Never invent missing alternatives. |
| Domain model and invariants | A view of project decisions, constraints, references, and findings | Source of each requirement; relevant component; assumptions and evidence. “Must never lose a committed write” is distinct from “this implementation never loses one.” |
| Experiment and counterexample | `verified_pitfall`, or `working_continuity` while unresolved | Hypothesis, change, measurement/check, result, limits, failed approach and conditions for retrying it. A failed memory candidate is not the same thing as a useful rejected engineering option. |
| Preferred explanation or learning support | `working_preference` or `reference`, with the appropriate assertion type | Topic, requested depth, helpful examples, explicit learning goal; no global competence score. |
| Current investigation | `working_continuity` | Goal, revision, verified facts, explicitly unresolved hypotheses, remaining checks, next step, completion/expiry. |

These shapes add structure only where it improves recall. Evidence can support one field without supporting the entire record. Preserve field-level evidence links for decisions containing both user choices and tool observations; split a record when its scope or validity differs. A style example accepted for naming does not also certify its algorithm or performance.

The [example records and pairing cases](2026-09-30-coding-memory-examples.json) show the envelope, optional details, evidence mapping, and expected behavior. All identities, projects, utterances, and outcomes there are synthetic.

## The pair-programming contract

Memory delivery is not a second planner that issues commands. The receiving LLM uses the current task, current repository evidence, relevant memory, and its own capabilities to decide what to do. The learning model remains the selected companion DSH model; the working coding agent need not use that same engine.

| Moment | What the buddy does | What memory contributes |
| --- | --- | --- |
| Orient | Understand the requested outcome and inspect the affected code. | Relevant prior decisions, domain language, current handoff. |
| Choose | Compare viable approaches; surface a material conflict when one exists. | Conditional preferences, rationale, previously rejected options, unknowns. |
| Work | Use a suitable feedback loop and stay within current authorization. | The developer's applicable work sequence and accepted examples. |
| Verify | Check the changed behavior and report the limits of the evidence. | Required properties, known regression risks, reusable measurement context. |
| Learn | Capture a new correction, changed decision, or supported outcome if it has future value. | Original provenance, prior revisions, and a useful no-change result when nothing new was learned. |

This loop scales to the task. A typo fix does not need a design interview. Learning happens in the background from the first eligible interaction; it does not depend on having a conversation with the companion or running a 24-hour scan.

### Same task, different working styles

Synthetic task: fix a duplicate event delivery bug in the same queue implementation, with identical requirements and code.

| Prior user statement | Expected adaptation | Shared requirement |
| --- | --- | --- |
| “For concurrency bugs, first spell out the state transitions and what must remain true.” | Begin with the relevant state model and ownership invariant, then reproduce the race and verify the fix. | Prevent duplicate delivery under the specified contract; run meaningful regression checks and state uncertainty. |
| “For reproducible bugs, show me the smallest failing test, then make a small fix.” | Begin with a focused reproducer, make the bounded change, then explain why it preserves the same ownership invariant. | The same correctness and compatibility requirements apply. |

The adaptation changes the useful first move and presentation, not the truth standard. A developer can prefer the first approach for a new concurrent algorithm and the second for a familiar UI regression. If there is no evidence of a preferred sequence, follow the current task and project conventions without inventing a style.

For interface work, a similarly useful memory could link a reviewed screen and the exact reasons it was approved: information density, keyboard flow, and visible error recovery. It must not reduce that evidence to “likes beautiful UI.” For performance work, preserve the benchmark definition and accepted tradeoff instead of an unsupported “cares about speed” label.

## How we know the design works

Extend the [evaluation cases](2026-09-30-tim-memory-cases.json) with paired style tests, invariant-versus-observation tests, experiment confounds, expired alternatives, reference-versus-preference separation, and challenges to an unsuitable default. Run style comparisons on matched tasks with the same engine/model, code, requirements, and budget; change only the learned preference. Then repeat across frameworks. Grade the action sequence from observable work and artifacts, not private model reasoning or whether the assistant announces a persona.

Require both task correctness and the expected adaptation. More stylistically familiar output cannot compensate for a broken patch. A well-judged exception should not be scored as failure to obey the profile. Blind review should also inspect repeated corrections, unnecessary interruption, unsupported assertions, and restoration of task context. The existing native-only and combined-memory baselines still apply.

The first implementation remains small: conditional style plus accepted project decision plus a debugging handoff, learned in one framework and used in the other. Include one conflict that requires challenging a remembered default, one changed condition that invalidates an old conclusion, and one task that needs no memory. This demonstrates a useful pair-programming relationship before adding more profile facets or retrieval infrastructure.

The aspiration is a trusted long-term coding partner. This design makes that aspiration testable; it does not establish that a perfect partner has already been built.

# Coding memory for developers

Build memory that helps any supported coding agent work like a colleague who understands the developer, the codebase, and the task. It should improve engineering choices, produce changes that fit the project, and reduce repeated explanation. Tim is the interface to that knowledge. General DSH domains and cross-machine synchronization are outside this product scope.

This document defines the coding-specific product model. The [architecture](2026-09-30-tim-memory.md) defines storage, learning, recall, adapters, and controls. The examples below are illustrative, not a profile inferred about the current user. A development-gated runtime prototype now exists; the [review log](2026-09-30-coding-memory-review-log.md) tracks what has been implemented and tested. An initial owner library is integrated into the companion viewer; native production integration, richer project/receipt views and behavioral evaluation remain incomplete.

The owner library now connects a memory to its recent recall history and accepts helpful/unhelpful feedback for a specific version and receiving context. That feedback is reversible and separate from the remembered fact. In the development implementation it makes a bounded adjustment to recall ordering for the same project and matching task/branch scope and conditions, across Claude and Codex. It cannot override eligibility or project requirements, and repeated recall earns no reward. Real-model usefulness and direct navigation back to the receiving task remain unverified or unfinished.

The [historical design council](2026-09-30-coding-memory-council.md) applies ten complementary engineering perspectives to this model. Its central addition is memory of engineering judgment: how someone approaches a problem, why a decision made sense, what evidence supports it, and what would warrant changing it. These perspectives inform our design; they are not preset personalities assigned to developers.

The [modern practitioner study](../research/2026-09-30-modern-coding-memory.md) examines Peter Steinberger, Andrej Karpathy, Jeff Dean, Mitchell Hashimoto, Simon Willison, Addy Osmani, and Charity Majors through public 2025–2026 material. It adds memory of workspace resources, task contracts, working examples, experiments, and maintained project explanations. These are complementary examples, not a survey of all programmers.

## How programmers work

For memory design, use a recurring loop: understand the problem, recover context, choose an approach, change the code, validate it, review it, ship it, and learn from its behavior. A developer may move back and forth, skip a stage for a small change, or hand work to another person or agent. The important unit is the engineering decision and its outcome.

Research supports paying attention to this context. A Microsoft study of developer workdays found that interruptions have different effects during development versus planning or release, and highlighted developers' control over their work. Its sample was Microsoft developers, not every kind of programmer. [Meyer et al., 2019](https://www.microsoft.com/en-us/research/publication/today-was-a-good-day-the-daily-life-of-software-developers/).

| Work stage | Knowledge that can help the next agent |
| --- | --- |
| Understand | The user need, acceptance criteria, domain language, and prior decisions that constrain this task. |
| Recover context | Relevant components, ownership, authoritative documents, previous attempts, and why an apparently obvious approach failed. |
| Choose | Tradeoffs already considered, conditions under which an option was preferred, and which alternatives remain open. |
| Implement | Applicable code and architecture conventions, accepted examples, dependencies, and local constraints. |
| Validate | Relevant regression risks, meaningful tests, performance measurements, visual review expectations, and known environment pitfalls. |
| Review | The developer's preferred change size, explanation level, evidence, and review checkpoints. |
| Ship | Project release practices and pending prerequisites. Remembered practice never grants permission to merge or deploy. |
| Operate and return | Observed results, unresolved incidents, temporary blockers, and the exact state needed to resume. |

Tim should reduce the cost of recovering context and getting useful feedback. The DevEx research framework identifies feedback loops, cognitive load, and flow as useful dimensions; this motivates measuring fewer repeated explanations and interruptions alongside technical correctness. It does not prove that this memory design improves productivity. [Noda et al., 2023, author-hosted paper](https://www.michaelagreiler.com/wp-content/uploads/2024/06/DevEx-WhatDrivesProductivity.pdf).

## Kinds of programming work

There is no useful fixed number of programmer personalities for this product. Job labels, technical domains, responsibilities, expertise, and current work mode describe different things. Stack Overflow's survey asks about developer roles separately from experience and technologies; we should preserve those distinctions rather than treating a role as a complete profile. [Developer survey](https://survey.stackoverflow.co/2025/developers).

Use the following twelve overlapping work contexts as an initial vocabulary. These are our design categories, not an exhaustive or statistically validated taxonomy. Concerns are examples to learn about, not preferences assigned from a job title.

| Work context | Examples of relevant concerns |
| --- | --- |
| Product and full stack | End-to-end behavior, scope, delivery speed, maintainability, customer outcomes. |
| Frontend and interface engineering | Interaction, accessibility, rendering performance, visual consistency, component behavior. |
| Backend and APIs | Domain rules, data integrity, latency, authorization, integration contracts. |
| Mobile and desktop clients | Platform conventions, offline behavior, startup, battery and memory use, distribution. |
| Systems and embedded software | Resource budgets, timing, hardware behavior, reliability, observability. |
| Data engineering and analytics | Data quality, lineage, reproducibility, batch cost, schema evolution. |
| Machine learning and scientific software | Evaluation, experiment reproducibility, numerical assumptions, inference or compute cost. |
| Infrastructure, platform, and SRE | Reliability, deployment, incident recovery, operational effort, infrastructure cost. |
| Security engineering | Threat models, trust boundaries, auditable behavior, sensitive data handling. |
| Games, graphics, and real-time software | Frame budgets, assets, input response, simulation behavior, iteration speed. |
| Libraries, SDKs, and developer tools | API ergonomics, compatibility, documentation, adoption friction, packaging. |
| Testing and quality engineering | Reproducible failures, coverage of behavior, test isolation, useful automation. |

A person can occupy several contexts. Separately track work modes such as exploring, prototyping, maintaining, reviewing, teaching, or responding to an incident. Solo versus team work, new versus existing systems, and prototype versus production also change the decision. None of these implies a permanent personality or a preferred database.

## What the coding memory should know

Use independent, editable facets. Leave a facet unknown until evidence exists. Avoid a questionnaire that requires the user to fill out a complete developer profile before memory can help.

| Facet | Useful things to learn | How it changes agent behavior |
| --- | --- | --- |
| Work context | Current domains, responsibilities, project maturity, ownership, and task stage. | Select the right context and verification for this particular change. |
| Engineering priorities | Correctness, reliability, latency, throughput, memory, battery, shipping speed, simplicity, maintainability, security, cost. | Explain and choose tradeoffs that fit the task, with measurable requirements where available. |
| Reasoning and feedback | A stated preference for starting with invariants, examples, a reproducer, a prototype, or measurements; relevant work conditions and accepted evidence. | Choose a useful first move and feedback sequence without lowering correctness standards or imposing that sequence on unrelated work. |
| Code style | Functional, object-oriented, imperative, or declarative approaches; explicitness; type use; error handling; mutation; naming and comments. | Produce code that fits accepted examples and repository conventions. Read formatter settings rather than relearning whitespace. |
| Architecture | Boundaries, composition, abstraction tolerance, dependency policy, public API stability, monolith/service preferences. | Avoid proposing a pattern the developer rejected for the same reasons and conditions. |
| Stack and storage | Languages, frameworks, database preferences, operational constraints, migration policy, query/ORM choices. | Compare viable options using the user's reasons, without replacing an existing project choice just to match personal taste. |
| Visual design | Typography, spacing, density, color, icon/illustration treatment, motion, surfaces, approved references and rejected examples. | Match the relevant product's visual direction with concrete criteria. |
| Interaction design | Navigation, discoverability, keyboard behavior, progressive disclosure, loading/error/empty states, undo, onboarding. | Preserve the interaction choices the user values, including required accessibility behavior. |
| Verification and completion | Test strategy, regression risks, benchmark conditions, visual review, acceptance evidence, when a change is ready. | Run appropriate checks and present the evidence the developer needs. |
| Collaboration with agents | Planning detail, implementation checkpoints, review style, explanation length, autonomy within current authorization. | Communicate and hand off work effectively without treating old permission as a permanent grant. |
| Knowledge and learning | Familiarity by topic, project/domain knowledge, requested explanation level, learning goals, trusted references. | Explain unfamiliar concepts without re-teaching known material; revisit this when the user asks to learn. |
| Project decisions and domain rules | Why an approach was chosen, business invariants, compatibility commitments, external obligations, ownership. | Preserve intent that source code alone cannot explain. |
| Working continuity | Current hypothesis, rejected attempts, relevant diff/tests, incomplete work, blockers, next step. | Resume useful work across frameworks without turning temporary state into a durable preference. |

Engineering priorities need conditions and tradeoffs. “Cares about performance” is weak. “For the editor's typing path, investigate latency regressions before adding visual effects; preserve the agreed measurement conditions” can change an implementation. Store any numeric target only when it was actually specified or adopted; do not invent a budget from the word fast.

Code style also has several layers. Syntax and formatting usually belong to the repository's tools. Programming paradigms describe how code is organized. Architecture choices describe system boundaries. Testing and change discipline describe how work gets validated. A developer can combine functional transformations with object-oriented platform APIs and prefer small fixes in a legacy codebase. A single label such as functional programmer loses these distinctions.

A working style should affect observable work. For the same concurrency bug, one developer may want the state transitions explained first; another may prefer a minimal failing test first. Both still need a sound fix and meaningful verification. Store the conditional preference and evidence, not a claim that one person is a Dijkstra-type or Beck-type programmer. With no applicable preference, the agent uses current task requirements and project conventions.

## Preferences need conditions and reasons

Technology usage, preference, and constraints are distinct. Stack Overflow also distinguishes technologies people used from those they want to use. That distinction is essential at the individual level: maintaining a Java service does not prove the developer would choose Java for a new product. [Technology survey definitions](https://survey.stackoverflow.co/2025/technology).

For every substantive memory, preserve: what was stated or observed, who it applies to, the project/task conditions, the reason, supporting evidence, exceptions, and what would change the conclusion. These examples show why:

| Weak memory | Useful conditional memory |
| --- | --- |
| Likes PostgreSQL. | For new transactional web services, explicitly prefers PostgreSQL because the team understands SQL and wants few additional systems. Existing deployments and offline clients require separate decisions. |
| Likes minimalist UI. | For the operations console, approved compact information density and restrained color; rejected large decorative cards because they hid important state. |
| Cares about UX. | In settings flows, wants changes to be previewable and reversible; rejected immediate destructive actions. |
| Likes fast code. | During an incident, asked to preserve the measured latency improvement and avoid unrelated refactoring. The urgency belongs to that incident. |
| Is a senior developer. | Explicitly comfortable with SQL and database migrations; currently learning Rust ownership and requested worked examples. |
| Hates tests. | Rejected tests that only restated CSS constants; still expects meaningful interaction and regression coverage. |
| Likes MongoDB. | Maintains MongoDB because a client requires it. No personal preference has been stated. |

Database knowledge should include the workload, consistency and transaction needs, deployment environment, operating burden, cost, team familiarity, existing data, migration constraints, and reversibility of the choice. A remembered preference informs that decision; it does not establish which database is technically suitable today.

Approved visual references are particularly valuable. Keep the artifact or accessible pointer, its revision, the relevant area, the user's accepted or rejected attributes, and the product scope. An image alone does not establish what the user liked. Acceptance of an illustration does not approve its typography, and a playful companion screen does not establish the style for an administration console. Historical references are memory; current product files remain authoritative for today's design.

## Knowledge is specific to a topic

Store useful evidence of familiarity and requested support rather than a global junior/senior score. Someone can know distributed systems deeply, be new to a particular frontend framework, and want a refresher on a familiar API. A question, a typo, or agent-written code does not establish lack of skill or expertise.

Useful knowledge records include a user's own description of experience, topics they have explicitly asked to learn, domain concepts discussed in the project, and the explanation format they found helpful. Observable work may support a tentative familiarity signal, but keep its basis visible and never use it to gate features, rank employees, or withhold an explanation. The current request for detail always matters more than an old preference for brevity.

Three sources need separate treatment: the developer's understanding, the project's domain knowledge, and the agent's current understanding. They do not automatically transfer to each other. Preserve expensive discoveries and decision rationale; refresh ordinary API details and code structure from authoritative sources when needed.

## A coding specific data model

Keep the architecture's versioned memories and evidence. Add coding facets and decision conditions rather than a single generated biography. Views such as “How you work” are projections of sourced records, not independently maintained profiles that drift apart.

Each record needs an `assertionType`: `stated_preference`, `observed_usage`, `project_constraint`, `accepted_decision`, `verified_finding`, `learning_goal`, or `temporary_state`. This is separate from its evidence class and memory kind. An observed tool choice cannot become a stated preference during consolidation.

Relevant conditions include work area, task stage, artifact type, project/component, platform, product maturity, environment, and technical preconditions. Unknown conditions stay unknown. The list of facets is extensible; admission still requires a concrete future benefit.

For example, this fragment assumes an explicit user statement supporting both the default and the exception:

```json
{
  "facet": "stack_and_storage",
  "assertionType": "stated_preference",
  "subject": "database_selection",
  "scope": { "profileId": "example_profile" },
  "when": { "workload": "new_transactional_web_service" },
  "prefer": "PostgreSQL",
  "because": "The user wants familiar SQL tooling and few additional systems.",
  "exceptions": [
    { "when": { "deployment": "offline_single_user_client" }, "prefer": "SQLite" }
  ],
  "evidenceClass": "user_stated",
  "evidence": ["example_user_statement"],
  "lastConfirmedAt": null
}
```

Do not resolve choices by voting across memories. Honor the active agent's instruction hierarchy, current user intent, and applicable project requirements. Personal defaults operate within that permitted space. A new task-specific choice is not automatically a permanent preference change; an explicit enduring correction revises the old record. If requirements conflict materially, surface the conflict at the actual decision point.

Optional decision details preserve the actual problem, considered alternatives, chosen option, expected result, observed outcome, and conditions for revisiting it. Optional experiment details preserve a hypothesis, intervention, check, result, and limits. Each material field needs evidence; do not invent a reason because it sounds plausible. A useful rejected engineering approach can be active negative knowledge, while an unsupported memory candidate remains rejected. See the [synthetic record examples](2026-09-30-coding-memory-examples.json).

The project's working model is a view assembled from scoped decisions, constraints, findings, references, and unresolved task state. Distinguish a required invariant from evidence that an implementation satisfies it. Keep hypotheses labeled as hypotheses and retain the observations that could disprove them. This model supports understanding; it does not claim to capture all of a developer's tacit knowledge.

## Learning and recall during coding

Corrections, explanations of choices, accepted alternatives, verified failures/fixes, and explicit learning goals are the strongest opportunities. Repeated actions can help locate useful episodes, but are weak evidence of preference. An agent suggestion followed by silence is not a user endorsement. Routine code generation, copied boilerplate, and repeated dependency files should not fill the store.

The selected companion model performs background consolidation. On each task, the receiving agent gets only the relevant combination of developer defaults, project knowledge, and active work state. Illustrative packets:

| Task | Recall should emphasize |
| --- | --- |
| Design a new API | Existing contract, domain constraints, relevant architecture decisions, error-handling preference. |
| Build a product screen | Accepted design references, interaction conventions, accessibility requirements, verification expectations. |
| Investigate a slow request | Relevant prior investigation, actual performance target if known, benchmark method, current hypothesis. |
| Choose storage | Applicable preference and its reasons, deployment/workload constraints, earlier alternatives. |
| Review a patch | Known risks, relevant coding conventions, developer's review format, evidence still missing. |
| Resume a bug fix in another framework | Reproduction, attempts and outcomes, current revision, unresolved hypothesis, next verification step. |

Recall should improve a choice or save rediscovery. It should not announce “you care about quality” before every task. Keep a bounded context packet, make evidence available on demand, and retain a visible unknown when there is no relevant evidence.

The receiving agent pairs through a simple loop: orient, choose, work, verify, learn. Memory contributes relevant prior context; the LLM reasons about today's task and checks today's code. If a remembered preference is unsuitable under a new requirement, explain the specific tradeoff and propose a better fit. Agreement with the profile is not a substitute for engineering judgment. Keep user statements, published references, reasoned arguments, test results, benchmarks, and visual approvals distinguishable.

## Memory in a modern agent workspace

The same developer can want a quick visual experiment, a carefully specified migration, an independent repair, or a guided learning session. Preserve work mode and completion criteria with the task; learn enduring interaction preferences only with supporting evidence. This lets the companion vary the feedback loop while keeping the user's current request in charge. Parallelism and notification preferences are conditional, not a universal goal to maximize agents.

Project knowledge should include pointers to canonical guides, reusable skills, helper tools, and proven examples. Record when a resource is useful, its revision, and what was verified. Read today's project authority instead of creating competing copies of its rules. A discoverable skill, a loaded skill, and a successful use are different observations. Repeated mistakes may justify a better reproducer, tool, or existing guide within authorized work; more reminders are not always the best repair.

Experiments preserve the question, evaluator, baseline, candidate, conditions, status, and limits. An unsuccessful approach may save the next agent time, but its failure must remain conditional. A crashed run cannot win a benchmark because its export used a numeric placeholder. A result from another workload, resource budget, environment, or revision needs an applicability check.

Add a maintained coding notebook to Project knowledge. It synthesizes supported records into short explanations of how the project works and why, with evidence and open questions available on demand. Pages are derived from versioned records, not an independent biography or editable policy file. Corrections, forgetting, and exclusions invalidate affected pages before recall; stale synthesis must not survive a corrected source. Saving an agent's answer never creates independent confirmation of that answer.

The current notebook prototype groups each topic within its exact project/task/branch scope. The owner
can open a page, read its source memories and their conditions, and use the existing correction or
forget controls. **Individual memories** remains available while explanations are queued, learning is
paused, an older service is connected, or an older store has not yet been indexed. Pages show their
coverage and unresolved-record count; a generated explanation is not a complete account of a project.
The companion's selected model prepares explanations inside the existing six-call hourly allowance,
with at most 24 records and 48 KB of input per page. Browsing does not invoke a model. Mechanical
provenance and lifecycle checks pass; faithful synthesis and improved coding outcomes still require
real-model evaluation.

## Experience in the coding companion

In the review build, enable **Settings → Experimental → Coding memory**, then open **Companions → Memories**.
The setting is off by default, belongs to the current account on this computer, and needs no environment
variable or restart. It uses the model selected in Companions and retains the existing watching consent.
The viewer separates **How you work**, **Project knowledge**, and **Learning**. Turning the experiment
off stops its background work and keeps saved memories; Learn and Recall have their own controls inside
Memories. Companions must be enabled for learning or recall to run, but the local opt-in can still be
cleared while companions are off. This is an opt-in preview, not evidence that the real-model rollout
gates have passed.

The memory viewer should answer four practical questions: “How do you understand my way of working?”, “What do you know about this project?”, “Why did you choose that?”, and “Where were we?” Keep the existing terminal as the place where coding work happens.

Show natural statements with scope and evidence. Allow the user to correct a reason, mark an observed tool as a preference, limit a preference to one project, attach an approved reference, or forget it. Do not show personality scores or demand that the user approve an endless stream of obvious lessons. Ask for clarification only when uncertainty materially changes a current decision.

Implemented control: “Limit to a project…” searches known, included coding projects by name or folder. Selecting a project opens a concrete preview; only applying it changes the memory. The claim, evidence and existing corroboration remain intact. Limiting applicability does not count as confirming truth. Conflicting project claims are shown and held for review. Account changes clear the picker; stale revisions require another review, and unavailable destinations are never silently replaced. Moving an already scoped memory or expanding its scope is not offered.

## First coding workflows and evaluation

Begin with feature implementation, bug fixing, review, and task handoff across Claude Code and Codex. Exercise frontend, backend, and tooling examples so the design is not implicitly frontend-only. Preserve the extensible contexts for other programming domains without claiming untested support for every specialist workflow.

The first useful release should demonstrate all three:

1. A stated engineering preference learned in one framework changes a relevant decision in another, within its conditions.
2. An accepted project decision survives framework changes and overrides an incompatible personal default where project requirements govern.
3. A partially completed investigation resumes with its evidence and uncertainty intact, without repeating discarded attempts.

Extend the existing evaluation set with usage-versus-preference, team-versus-personal style, conditional database choice, topic-specific expertise, scoped visual taste, changing work mode, measurable performance requirements, and explanation requests that override old defaults. Compare usefulness and correctness against native-only memory and include irrelevant-context cases. These are proposed evaluations, not completed runtime results.

Use matched tasks to test different reasoning and feedback preferences with the same requirements, repository, engine/model, and budget. Require the expected change in approach and a correct result. Include a preference that should be challenged, a failed approach whose conditions have changed, and a user who has not stated a style. Grade observable actions and artifacts; do not infer success from an agent saying that it remembered.

Within those first workflows, include current workspace guidance and evidence attached to the actual revision. Maintained notebook pages now have a development implementation with source correction/forget controls; task/session navigation and comparative usefulness remain unfinished. Richer experiment automation remains optional follow-up; the research does not require expanding the initial product beyond coding on one machine in Claude and Codex.

The quality question is whether the agent makes a better engineering decision and the developer has to repeat less context. A richer-looking profile is not sufficient evidence.

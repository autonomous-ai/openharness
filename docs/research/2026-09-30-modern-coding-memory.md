# Coding memory through modern programmers' workflows

Research date: 2026-09-30. This extends the [coding product model](../plans/2026-09-30-coding-memory-product.md) and [earlier engineering perspectives](../plans/2026-09-30-coding-memory-council.md). It is a design study, not an implemented memory system.

The main addition is **memory of how to get useful work done and establish that it worked**: find the right instructions, recover a working example, choose the right feedback loop, preserve experiments, and maintain an explanation of the project. Preferences about code, databases, and design still matter; they need this operational context to help the next agent.

These seven practitioners provide complementary public perspectives, not a representative survey or a ranking of programmers. Most sources are from 2026, with two relevant 2025 accounts. We inspected published repositories and first-person material, not their private workspaces. Source observations and our proposed product behavior are distinguished below. The [source manifest](2026-09-30-memory-sources.json) records dates and inspected revisions.

## Peter Steinberger: make the workspace usable by agents

**Observed setup.** His `agent-scripts` repository separates shared rules in `AGENTS.MD`, reusable workflows in skills, small helpers in scripts, and validation hooks. The README describes canonical guidance with local pointers and managed skill links instead of independent copies. The synchronization script accommodates different discovery layouts. This describes his published setup, not a compatibility test of every current host. [README at the inspected revision](https://github.com/steipete/agent-scripts/blob/d15557c94fa1b92870d6901dbf07615eadf6dd34/README.md), [skill synchronization](https://github.com/steipete/agent-scripts/blob/d15557c94fa1b92870d6901dbf07615eadf6dd34/scripts/sync-skills).

His documentation helper reads summaries and `read_when` metadata, giving agents a route into relevant project knowledge. The structure-mapping skill treats maps as discovery aids requiring source verification. The frontend skill asks for a deliberate visual direction suited to the product; its presence does not establish one permanent personal aesthetic. [Documentation helper](https://github.com/steipete/agent-scripts/blob/d15557c94fa1b92870d6901dbf07615eadf6dd34/scripts/docs-list.ts), [structure skill](https://github.com/steipete/agent-scripts/blob/d15557c94fa1b92870d6901dbf07615eadf6dd34/skills/project-structure/SKILL.md), [frontend skill](https://github.com/steipete/agent-scripts/blob/d15557c94fa1b92870d6901dbf07615eadf6dd34/skills/frontend-design/SKILL.md).

His December 2025 account describes starting with executable CLI surfaces, using screenshots and working software to refine the product, and investing in architecture and project documentation. It is an iterative product workflow; detailed implementation instructions are not always the starting point. [Shipping at Inference-Speed](https://steipete.me/posts/2025/shipping-at-inference-speed).

**Our design consequence.** Tim needs a small map of authoritative workspace resources: where guidance lives, its scope, when to read it, its revision, and whether the current host can actually discover it. Remember the reason for a convention or an expensive discovery; read today's commands and configuration from their canonical source. If a guide already solves the problem, retrieve its pointer instead of manufacturing a competing lesson. A file existing on disk is not evidence that an agent loaded it.

This map belongs to the project context, not the developer's personality. An imported public rule file must remain external reference material until deliberately adopted within the user's own workspace.

## Andrej Karpathy: three different loops, three kinds of memory

**Product exploration.** In the April 2025 MenuGen account, a quick agent-built prototype leads into harder deployment and integration work, including authentication and payment identity problems. A working local experience did not establish that the deployed user flow was correct. [Vibe coding MenuGen](https://karpathy.bearblog.dev/vibe-coding-menugen/).

**Our design consequence.** Preserve the task's purpose and completion criteria. “Accepted as an exploratory demo,” “integration test passed,” and “observed working after deployment” answer different questions. Tim should carry unresolved gaps forward when work changes framework or moves from exploration to release. Configuration requirements may be useful memory; secret values are not.

**Controlled experimentation.** The inspected `autoresearch` setup lets an agent change training code against a fixed evaluation implementation. It establishes a baseline and records results with keep, discard, or crash status. The prescribed training budget is five minutes, excluding startup and compilation. The README explicitly limits comparisons across different computing platforms; the program also weighs simplicity alongside the metric. [README](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/README.md), [experiment instructions](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md).

**Our design consequence.** A reusable experimental result needs the objective, evaluator and data revisions, baseline and candidate revisions, resource conditions, outcome, and limitations. Retain failed approaches when they save rediscovery, without treating every run as a durable lesson. Import failure status before interpreting a score: this program uses zero as a crash placeholder, which must never become a winning low score in our memory. A changed evaluator or budget calls for a new comparison, not a rewritten success story.

**Maintained knowledge.** Karpathy's April 2026 LLM Wiki proposal separates source material, a maintained interlinked wiki, and instructions for its organization. Ingest updates existing topics; queries can produce reusable synthesis; maintenance checks contradictions and stale pages. He describes reading the result beside the agent. This is a proposed pattern and personal account, not a measured guarantee of correctness or scale. [LLM Wiki, author document](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

**Our design consequence.** Add a maintained coding notebook to Tim's project view. It should explain topics such as “How previews stay consistent” using validated decisions, findings, and open questions. Each paragraph must retain its supporting record revisions. SQLite remains authoritative; the notebook is a derived view. Corrections and forgetting invalidate dependent pages before they can be recalled again. A generated answer saved into a page does not create new independent evidence. We adopt the useful synthesis pattern within coding scope, without expanding capture into a general personal archive.

## Jeff Dean: specify the important behavior, vary the interaction

**Documented perspective.** In his February 2026 interview, Dean distinguishes collaborative brainstorming from delegating a sufficiently specified task. He argues that specifications need important corner cases and performance requirements, and discusses supplying reusable guidance about techniques that do not work. He also emphasizes latency's effect on interaction. His discussion of many future agents is a possibility, not evidence that he personally operates a particular multi-agent workspace. [Original interview and transcript, especially 01:10–01:17 and 01:19](https://www.latent.space/p/jeffdean).

**Our design consequence.** Remember a task contract: intended behavior, important edge cases, relevant workload, explicit performance target if one exists, and what evidence would establish completion. Remember interaction preferences with conditions: frequent feedback while discovering the problem can coexist with independent execution of a well-defined repair. Do not impose a new questionnaire or a universal plan-first process. Infer what is already clear from the current request and project; ask only where uncertainty changes a consequential decision.

For performance work, our records should distinguish the metric, workload, environment, and measurement window. “Fast” is not a benchmark, and yesterday's result is not a guarantee about today's code. Model capability observations also need versions and task conditions; they must not become permanent model rankings or silently change the selected DSH model.

## Four complementary perspectives

| Practitioner and primary source | Documented practice | Our design inference for Tim |
| --- | --- | --- |
| Mitchell Hashimoto — [My AI Adoption Journey, February 2026](https://mitchellh.com/writing/my-ai-adoption-journey) | Describes learning agents' limits, bounded delegation, verification, and improving instructions or tools when mistakes recur. His account also treats attention and interruption as constraints. | A repeated failure should lead toward a better existing guide, reproducer, helper, or regression check. Remember the repair and its evidence; avoid an ever-growing stack of reminders. |
| Simon Willison — [Hoard things you know how to do](https://simonwillison.net/guides/agentic-engineering-patterns/hoard-things-you-know-how-to-do/) and [Agentic manual testing](https://simonwillison.net/guides/agentic-engineering-patterns/agentic-manual-testing/) | Keeps working examples that can be recombined. Exercises generated software directly and uses artifacts recording commands, outputs, and screenshots to demonstrate work. | Keep a library of proven capabilities with dependencies, revisions, and limits. A screenshot supports an appearance claim; an executed flow supports a behavior claim. Neither establishes every aspect of correctness. |
| Addy Osmani — [My LLM coding workflow going into 2026, January 2026](https://addyosmani.com/blog/ai-coding-workflow/) | Describes specifying and planning first, building in small steps, supplying relevant context, and reviewing and testing the result. | Preserve acceptance criteria and project constraints across steps. Support deliberate planning where useful without forcing the same ceremony on small fixes or exploratory visual work. |
| Charity Majors — [AI demands MORE engineering discipline, June 2026](https://charity.wtf/p/ai-demands-more-engineering-discipline) | Emphasizes observed system behavior, characterization tests, and production feedback as part of engineering discipline. | Link operational observations to the relevant build, environment, and time window. Do not certify a release from unrelated green tests or an old healthy trace. |

These sources do not establish a universal favorite database, visual style, programming language, agent, or degree of parallelism. Authorship of a technology, use in one project, and an explicitly stated preference remain different evidence.

## What changes in the product design

The historical round emphasized engineering judgment and its reasons. This round adds the resources and feedback that make that judgment usable in an agent workspace. Keep the three existing layers—developer defaults, project knowledge, active work—and enrich them rather than adding seven celebrity profiles.

| Addition | Information to preserve | Concrete next-task behavior |
| --- | --- | --- |
| Workspace guidance map | Canonical resource, scope, revision, task triggers, discovery status. | Read the current relevant guide; avoid duplicate policy and detect stale pointers. |
| Task contract | Work mode, acceptance criteria, remaining gaps, permitted work from the current request. | Resume the right stage; do not treat a prototype acceptance as release completion or standing authorization. |
| Working examples | Capability demonstrated, code/artifact revision, dependencies, actual verification. | Reuse the relevant pattern after checking today's constraints and access. |
| Experiment history | Hypothesis, baseline, candidate, evaluator, conditions, typed outcome. | Avoid repeating an applicable failure; recheck a result when its conditions change. |
| Maintained coding notebook | Short topic synthesis, supporting record revisions, unresolved questions. | Explain the project without rebuilding its entire history or inventing corroboration. |
| Outcome and capability history | What worked, with which model/tools, on which revision/environment, and when. | Retrieve useful leads while checking present capabilities and current system state. |

Reuse `reference`, `working_continuity`, `project_decision`, and `verified_pitfall` records with optional details. Do not turn live branch ownership into historical memory: the runtime determines who is currently working. Separate a parallel experiment from an accepted project decision until there is evidence of adoption. A memory suggesting a better helper can inform an already authorized code change; automatic learning does not itself publish new repository instructions or grant deployment permission.

The coding notebook fits the existing DSH: an approachable project explanation on the left, the real companion agent on the right. From a topic, the user can open its rationale, working examples, verification, and unresolved questions. Corrections use the same memory service as other views. The viewer does not become a second independent source of truth.

## A concrete cross-framework example

In a synthetic project, the developer explores a new checkout with one agent. They approve its layout, but the payment callback has only been tested locally. An existing guide identifies the staging test flow, and an older experiment records why matching accounts by mutable email failed.

When the developer resumes in the other framework, Tim supplies a small packet: the accepted visual attributes, the unresolved integration check, the current guide pointer, and the applicable identity pitfall. The agent checks the current implementation and exercises the appropriate flow within the task's authorization. It does not redesign an accepted layout, claim the checkout is already production-ready, or copy an old unverified fix. The notebook updates only from the resulting supported records.

## What to build first

Keep the first release demonstration focused on a conditional preference, an accepted project decision, and an unfinished investigation transferring between Claude and Codex. Add authoritative resource pointers and evidence tied to revisions to those same demonstrations. This tests the modern findings without requiring a new knowledge-graph backend, autonomous experimentation system, or additional agent frameworks.

The continuous-learning slice adds the maintained coding notebook, including dependency invalidation, source inspection, and correction/forget controls before tester rollout. Rich experiment comparisons and automated suggestions for improving project helpers can follow when real task failures justify them.

The [architecture](../plans/2026-09-30-tim-memory.md), [synthetic examples](../plans/2026-09-30-coding-memory-examples.json), and [evaluation cases](../plans/2026-09-30-tim-memory-cases.json) incorporate these consequences. The fixtures test proposed behavior; they are not completed runtime evaluations or evidence of a productivity gain.

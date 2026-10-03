# Cross-framework coding memory: research

Date: 2026-09-30. Status: research, not an implementation or a performance benchmark.

Recommendation: keep the memory ownership, scope, evidence, and delivery contract in Harness. Start with selective learning and task-specific recall across Claude Code and Codex. Evaluate Claude-mem and Hindsight as serious alternatives before expanding the core. Shared storage is already available elsewhere; the product must help the next agent avoid corrections the user has already made.

The proposed system is in [the design](../plans/2026-09-30-tim-memory.md). The [coding product model](../plans/2026-09-30-coding-memory-product.md) narrows the product to developer preferences, engineering decisions, and coding continuity across frameworks; general DSH domains are outside scope. The [source snapshot](2026-09-30-memory-sources.json) records repository revisions and observed adoption signals. No personal conversation archive was ingested for this research.

The [modern practitioner round](2026-09-30-modern-coding-memory.md) adds a source-grounded study of seven programmers' public workflows, with consequences for workspace guidance, verified examples, experimentation, and maintained project knowledge.

## What native agents actually do

### Claude Code

Claude separates authored instructions from automatically learned notes. Its documented auto-memory categories are user, feedback, project, and reference. Auto memory is enabled by default. It excludes information easily reconstructed from code and information already in project instructions; it need not save something every session.

Memory is Markdown under a repository-specific directory, shared by that repository's worktrees. An index is loaded at conversation start, bounded to 200 lines or 25 KB; topic files are read as needed. Users can inspect, edit, and remove notes. Native memory is local to the machine. Current versions also support AGENTS.md, with version and precedence qualifications; integration should detect capabilities instead of assuming that only CLAUDE.md is recognized. These are documented behaviors, not conclusions from an inspection of Claude's private runtime. [Official memory documentation](https://code.claude.com/docs/en/memory).

**Takeaway:** preserve user feedback and decisions, keep the index small, and allow ordinary work to produce no durable note.

### Codex

OpenAI Docs describes local memory as an optional background system, disabled by default. Generation and recall can be controlled separately, including per chat. Eligible prior conversations are processed after they become idle; quota thresholds can defer generation. Its generated memory directory is separate from ChatGPT memory, and manual edits are not the primary control surface. [Official local memory documentation](https://learn.chatgpt.com/docs/customization/memories).

The public pipeline separates extraction of individual conversations from consolidation of accumulated evidence. It uses job claims, retry handling, and serialized consolidation. Successful extraction can yield no memory. Consolidation selects inputs, maintains evidence artifacts, and updates a navigable memory workspace. The source README has some stale directory references; the pinned implementation paths, not those old path names, identify the code reviewed here. [Pipeline at inspected revision](https://github.com/openai/codex/blob/92bc601ad60542c92bf0bb1e7a2eb70b84ac49d2/codex-rs/memories/README.md), [extraction implementation](https://github.com/openai/codex/blob/92bc601ad60542c92bf0bb1e7a2eb70b84ac49d2/codex-rs/memories/write/src/phase1.rs), [consolidation implementation](https://github.com/openai/codex/blob/92bc601ad60542c92bf0bb1e7a2eb70b84ac49d2/codex-rs/memories/write/src/phase2.rs).

The released V1 extraction prompt explicitly prioritizes preventing repeated user corrections, distinguishes verified outcomes from assistant claims, and rejects generic advice or unadopted brainstorming. It permits empty output. This is much closer to the desired Tim behavior than summarizing everything that happened. [Released extraction prompt, v0.159.2](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/memories/write/templates/memories/stage_one_system.md).

The released V1 read prompt supplies a compact summary, then directs task-specific searches into a handbook and supporting evidence. It asks for citations and revalidation of facts likely to drift. The consolidation prompt includes removal of stale guidance and preservation of still-supported evidence when an input disappears. [Released read prompt](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/ext/memories/templates/memories/read_path.md), [consolidation prompt at inspected revision](https://github.com/openai/codex/blob/92bc601ad60542c92bf0bb1e7a2eb70b84ac49d2/codex-rs/memories/write/templates/memories/consolidation.md).

There are versioned prompt paths. The inspected V2 extraction template emphasizes faithful task history, user wording, ownership, uncertainty, and avoiding overgeneralized preferences. Its read template permits direct use of the injected summary and requests deeper evidence only when it could change the answer. Do not assume the V1 handbook layout or retrieval sequence is universal across Codex configurations. This is another reason to integrate through a service contract rather than sharing native generated files. [V2 extraction](https://github.com/openai/codex/blob/92bc601ad60542c92bf0bb1e7a2eb70b84ac49d2/codex-rs/memories/write/templates/memories/stage_one_system_v2.md), [V2 read path](https://github.com/openai/codex/blob/92bc601ad60542c92bf0bb1e7a2eb70b84ac49d2/codex-rs/ext/memories/templates/memories/read_path_v2.md), [released version selection](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/memories/write/src/prompts.rs).

**Takeaway:** distinguish observation, durable learning, and recall. Preserve why a belief exists and allow later evidence to change it. Source prompts demonstrate intended behavior, not a measured guarantee of model quality.

### The integration opportunity

Both current products expose session and prompt lifecycle hooks that can deliver additional context. Claude documents SessionStart and UserPromptSubmit context injection. Codex documents these hooks too; released v0.159.2 source confirms the prompt hook's context-output handling. Codex also requires trust review of non-managed hook definitions. Transcript formats are not a stable API. We inspected the installed Codex version, 0.159.0, but did not run a live integration test against it. [Claude hook contract](https://code.claude.com/docs/en/hooks), [Codex hook contract](https://learn.chatgpt.com/docs/hooks), [released Codex prompt-hook implementation](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/hooks/src/events/user_prompt_submit.rs).

MCP supplies a common tool interface; it does not by itself ensure an agent recalls anything before starting work. Automatic delivery, lifecycle recovery, and truthful delivery status need explicit adapters.

## Open-source landscape

Selection favors substantial public interest, relevant coding integrations, and distinct design approaches. Stars and forks below are GitHub API observations at 2026-09-30 12:32 UTC, **not active-user counts, quality scores, or evidence of memory-feature adoption**. Claims in project READMEs are implementation descriptions, not independently reproduced benchmarks.

| Project | Stars / forks | Mechanism and lesson for Harness | Fit and tradeoff |
| --- | ---: | --- | --- |
| [Claude-mem](https://github.com/thedotmack/claude-mem/tree/a077975ebd41643902f53e538e9bdf36c8367a0a) | 94,987 / 8,405 | Coding-session observations, lifecycle capture, SQLite, hybrid search, compact results followed by timeline and detail reads. Already supports multiple frameworks. | Closest product alternative. Cross-source startup context is configurable and defaults off. Its observer/provider and worker lifecycle would need integration with Harness's DSH model ownership. |
| [Hindsight](https://github.com/vectorize-io/hindsight/tree/13f72ebe01e0ece6a1aaf1c4b5bf9ffff4ec08ea) | 43,506 / 5,817 | Separate retain, recall, and reflect operations; evidence-backed consolidated observations; semantic, lexical, graph, and temporal retrieval. | Strong backend alternative with coding-agent integrations. More infrastructure and inference machinery than a small local store; embedded deployment exists, so Docker is not inherently required. |
| [Mem0](https://github.com/mem0ai/mem0/tree/94c3fe9f238f3dbf29c9ce98643bd71eb13077cd) | 66,364 / 7,813 | Scoped extraction and search, configurable inference/embedding backends, SDKs and coding integrations. | Useful general memory infrastructure. Harness still needs coding-specific evidence, project identity, delivery, and utility evaluation. |
| [Graphiti](https://github.com/getzep/graphiti/tree/3c427640abf909f12f71f963fce15eb514a3c493) | 31,323 / 3,213 | Facts with temporal validity, source episodes, contradiction handling, and hybrid graph retrieval. | Borrow temporal validity and provenance. A graph database and graph extraction are not justified for the first two-agent release without retrieval evidence. |
| [Letta](https://github.com/letta-ai/letta/tree/5bcdd177d70fa2b31a754cfcd801e77b2e1ab16a) | 24,982 / 2,637 | Persistent agent state and background memory maintenance. Current docs describe a Git-backed memory filesystem with small always-visible areas and deeper files. | Strong model for a continuing companion. Adopting its agent runtime would be a broader change than adding memory to Harness's existing agent runtimes. |
| [Beads](https://github.com/gastownhall/beads/tree/2d395d35afadf0a3aeb9bb0a737a0ac02cd97e60) | 27,535 / 1,872 | Dependency-aware task state plus durable project facts, exposed by CLI and agent integrations. | Especially relevant to coding continuity. Keep unfinished tasks separate from durable preferences. Beads explicitly places operator preferences in the harness's own memory. |
| [Serena](https://github.com/oraios/serena/tree/8a3ce35cae29a93748842ba463231d6c78d181e7) | 29,914 / 2,036 | Project/global Markdown, named references, and deliberate agent reads. | Excellent portability and human inspection. Its choice to avoid automatic content injection is a different product tradeoff from reliable per-task recall. |
| [MCP reference memory server](https://github.com/modelcontextprotocol/servers/blob/f46d9578190b476b3501923ea8977d899e8db2cb/src/memory/README.md) | 90,709 / 11,716* | Entity, relation, and observation CRUD with node search. | A useful interoperability baseline, not a complete learning or coding-recall pipeline. *Counts cover the whole reference-server repository.* |

### Details that change the build decision

**Claude-mem is already cross-framework.** Its progressive search avoids loading full observations unnecessarily. It also has its own provider onboarding, including hosted offerings and explicit alternatives. An integration must preserve the user's existing engine/account choice; do not install it with defaults and call that Harness's shared brain. [Pinned README](https://github.com/thedotmack/claude-mem/blob/a077975ebd41643902f53e538e9bdf36c8367a0a/README.md).

**Hindsight is more than a vector database.** Its observations retain supporting sources, are revised as evidence changes, and have deletion handling for derived beliefs. Its Codex integration documents recall on prompt submission and retention after work. This makes it a credible benchmark for both memory quality and integration effort. [Observation lifecycle](https://github.com/vectorize-io/hindsight/blob/13f72ebe01e0ece6a1aaf1c4b5bf9ffff4ec08ea/hindsight-docs/docs/developer/observations.mdx), [Codex integration](https://github.com/vectorize-io/hindsight/blob/13f72ebe01e0ece6a1aaf1c4b5bf9ffff4ec08ea/hindsight-integrations/codex/README.md).

**Do not describe today's Mem0 using an old architecture diagram.** The inspected Python OSS add path gathers recent messages, retrieves existing scoped memories, performs additive extraction, embeds candidates, and deduplicates. Explicit update/delete operations exist separately. Generic descriptions of an automatic four-way ADD/UPDATE/DELETE/NONE cycle would misdescribe this revision's inspected path. [Pinned implementation](https://github.com/mem0ai/mem0/blob/94c3fe9f238f3dbf29c9ce98643bd71eb13077cd/mem0/memory/main.py).

**Temporal facts do not require a graph in our first version.** Graphiti distinguishes when something was true from when it was recorded and retains superseded history. Harness can initially represent that contract with relational records and explicit links. This is a design inference, not a claim of equivalent graph retrieval. [Graphiti architecture and requirements](https://github.com/getzep/graphiti/blob/3c427640abf909f12f71f963fce15eb514a3c493/README.md).

**Letta has evolved.** Its older SDK memory-block docs remain available, but current product docs describe MemFS and background dreaming. MemFS uses ordinary files, a small always-visible portion, optional search additions, and version history. Learn from the maintenance loop without assuming the older core/archival API describes every current Letta deployment. [MemFS](https://docs.letta.com/concepts/memfs), [memory maintenance](https://docs.letta.com/configuration/memory).

**A task database is complementary.** Beads's dependency graph and `remember`/`prime` workflow provide continuity. They do not eliminate the need for personal knowledge and selective cross-project recall. [Pinned Beads README](https://github.com/gastownhall/beads/blob/2d395d35afadf0a3aeb9bb0a737a0ac02cd97e60/README.md).

**Files remain a useful interface.** Serena's named memory references, read-only controls, and inspectable files are valuable even with a database underneath Harness. Its application licensing at the inspected main revision is GPL-3.0-or-later; SolidLSP remains MIT. Older releases differ. This proposal borrows ideas and does not copy its implementation. [Memory design](https://github.com/oraios/serena/blob/8a3ce35cae29a93748842ba463231d6c78d181e7/docs/02-usage/045_memories.md), [component license documentation](https://github.com/oraios/serena/blob/8a3ce35cae29a93748842ba463231d6c78d181e7/docs/01-about/060_license.md).

## Why the current Harness approach falls short

Audit baseline: `5e2d026a935c4908d86ec2db7ab6479639a6737e`. These findings concern the implementation, not a statistical evaluation of the user's saved notes.

| Current behavior | Consequence |
| --- | --- |
| Live detection emphasizes corrections, repeated failures, and repeated command sequences. | Much useful intent and rationale has no route into learning. Repetition alone does not establish a successful procedure. |
| History review batches short user/assistant excerpts; decisive tool evidence is absent from that input. | It can paraphrase a request without knowing what worked or why. |
| A lesson becomes a short project note or a skill. | Preferences, decisions, applicability, uncertainty, and changing facts are squeezed into publication formats. |
| The prompt already permits no output and discourages obvious advice. | Another prompt sentence is unlikely to fix the whole pipeline. |
| Approved skills reach engines via launch-time runtime copies and an index; notes have publication paths. | Cross-engine distribution exists, but there is no corresponding task-specific recall contract. |
| A skill-file read counts as use; any turn in a note's project counts as note use. | Exposure and activity are mistaken for usefulness. |
| Project identity hashes the absolute working directory, with some realpath aliases. | Different worktrees still fragment knowledge about the same repository. |
| Native-agent imports and publication approval already exist. | Preserve those boundaries, but distinguish private learning from publishing shared instructions. |

Source anchors: [signals](../../cli/src/pair/learn/signals.ts), [history review](../../cli/src/pair/learn/conversationReview.ts), [distillation](../../cli/src/pair/learn/distill.ts), [types and identity](../../cli/src/pair/learn/types.ts), [publication](../../cli/src/pair/learn/publish.ts), [runtime delivery](../../cli/src/dsh/runtime.ts), [usage tracking](../../cli/src/pair/learn/usage.ts), [DSH model selection](../../cli/src/pair/intelligence.ts).

## Build versus adopt

Recommend a small Harness-owned core first: project identity, evidence, selective consolidation, retrieval, and delivery receipts. Reuse existing transcript normalization, DSH model execution, and runtime plumbing. SQLite fits the CLI's existing infrastructure. Keep records exportable as JSON and readable Markdown; do not make a vendor's prompts or native memory directory the source of truth.

Before committing to a larger backend, compare this thin implementation with Claude-mem and Hindsight on the same held-out coding tasks. Include native-only memory as a baseline. If an alternative wins on quality and operating cost while preserving scope, the selected DSH model, deletion, and deployment constraints, adopt it behind the memory-service contract. Existing research does not establish a winner on those measures.

Do not begin with a graph database, automatic skill generation, or machine synchronization. The first proof is simpler: a correction learned in Claude changes the next relevant Codex action, and vice versa, without contaminating unrelated work.

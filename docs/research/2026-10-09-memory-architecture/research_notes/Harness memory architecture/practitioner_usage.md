# Practitioner usage of coding-agent memory (as of 2026-10-09)

Scope: how developers actually use memory with coding agents in 2025-2026: tools adopted, failure modes, recommended patterns, cross-agent and cross-machine sharing, team governance, and security research.

Method notes:
- Star counts were read from the public GitHub REST API on 2026-10-09. Stars measure attention, not usage.
- Hacker News (HN) points and comment counts were read from the HN Algolia API on 2026-10-09. Quoted HN comments are anecdotes from named accounts, not measurements.
- "Measured" marks a benchmark or study with stated method. Everything else is a vendor claim or a practitioner anecdote.
- Reddit could not be searched with the available tools: no Reddit threads came back. Reddit sentiment is therefore absent, not negative.

## Q1. Which coding memory tools are most adopted, how are they used day to day, and what adoption signals exist?

### Takeaway
The most common "memory" in daily use is still plain instruction files (CLAUDE.md / AGENTS.md), repo docs, progress/todo files and git history, many of them now loaded natively by the harness (Claude Code auto memory, Copilot Memory). Among add-ons, claude-mem (hook-based automatic capture) has by far the most GitHub attention (~99k stars, ~2.2k issues). Beads leads the "task tracker as memory" camp. General memory backends (Mem0, Hindsight, Graphiti, Supermemory) have large star counts that mix in non-coding use. No public install or usage telemetry exists for any of them.

### Cited Findings
**Adoption signals: GitHub stars on 2026-10-09 (GitHub API; stars are not usage)**
- claude-mem: 98,980 stars, 8,670 forks, created 2025-08-31. Its description now says "Persistent Context Across Sessions for Every Agent" — [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- Mem0, a general memory layer: 66,902 stars. OpenMemory MCP ships from this project — [mem0ai/mem0](https://github.com/mem0ai/mem0)
- Hindsight: 47,696 stars, created 2025-10-30. The growth is unusually fast for its age, so treat it cautiously — [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)
- Graphiti: 31,596 stars — [getzep/graphiti](https://github.com/getzep/graphiti)
- Supermemory: 31,175 stars — [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory)
- Serena: 30,132 stars. It is mainly a semantic code toolkit, and memories are a sub-feature — [oraios/serena](https://github.com/oraios/serena)
- Beads: 27,774 stars. steveyegge/beads now redirects to gastownhall/beads (created 2025-10-12) — [gastownhall/beads](https://github.com/gastownhall/beads)
- Letta: 25,091 stars — [letta-ai/letta](https://github.com/letta-ai/letta)
- AGENTS.md spec repo: 24,844 stars — [agentsmd/agents.md](https://github.com/agentsmd/agents.md)
- Steinberger's agent-scripts: 7,321 stars, created 2025-11-08 — [steipete/agent-scripts](https://github.com/steipete/agent-scripts)
- ByteRover CLI (formerly Cipher): 4,956 stars, last push 2026-06-25 — [campfirein/byterover-cli](https://github.com/campfirein/byterover-cli)
- Basic Memory: 4,124 stars — [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory)
- mcp-memory-service: 2,006 stars — [doobidoo/mcp-memory-service](https://github.com/doobidoo/mcp-memory-service)
- Cline Memory Bank docs repo: 589 stars, last push 2025-06-10. The Memory Bank is a prompt pattern rather than a tool, so stars understate its use — [nickbaumann98/cline_docs](https://github.com/nickbaumann98/cline_docs)
- claude-mem issue volume: 2,187 issues in total, 363 of them matching "token" (GitHub search API, 2026-10-09) — [claude-mem issues](https://github.com/thedotmack/claude-mem/issues)

**HN attention: instruction files far outdraw memory tools**
- AGENTS.md threads:
  - "AGENTS.md – Open format for guiding coding agents": 2025-08-20, 837 points / 382 comments — [HN 44957443](https://news.ycombinator.com/item?id=44957443)
  - "Claude Code now reads AGENTS.md if there is no Claude.md": 2026-09-18, 741/285 — [HN 49760187](https://news.ycombinator.com/item?id=49760187)
  - "AGENTS.md outperforms skills in our agent evals" (Vercel): 2026-01-29, 524/196 — [HN 46809708](https://news.ycombinator.com/item?id=46809708)
  - "Claude Code reads AGENTS.md only when telemetry is on [fixed]": 2026-09-23, 486/284 — [HN 49814947](https://news.ycombinator.com/item?id=49814947)
- Consumer-memory threads also drew large threads: "Claude Memory", 2025-10-23, 559/312 — [HN 45684134](https://news.ycombinator.com/item?id=45684134); "Claude's memory architecture is the opposite of ChatGPT's", 2025-09-11, 448/236 — [HN 45214908](https://news.ycombinator.com/item?id=45214908)
- Memory-tool Show HNs drew far less:
  - "Show HN: Stop Claude Code from forgetting everything": 2025-12-29, 202/225 — [HN 46426624](https://news.ycombinator.com/item?id=46426624)
  - "Recall – Local project memory for Claude Code": 2026-06-21, 138/85 — [HN 48622590](https://news.ycombinator.com/item?id=48622590)
  - "Open-source memory for coding agents, synced over SSH" (deja-vu): 2026-07-15, 131/35 — [HN 48923111](https://news.ycombinator.com/item?id=48923111)
  - "Beads – A memory upgrade for your coding agent": 2025-11-28, 111/68 — [HN 46075616](https://news.ycombinator.com/item?id=46075616)
  - "OKF Agent Memory – Git-native persistent memory": 2026-09-05, 81/32 — [HN 49581240](https://news.ycombinator.com/item?id=49581240)
  - "Total Recall – write-gated memory for Claude Code": 2026-02-05, 67/32 — [HN 46907183](https://news.ycombinator.com/item?id=46907183)
  - "ctx – Search the coding agent history already on your machine": 2026-07-02, 65/43 — [HN 48763462](https://news.ycombinator.com/item?id=48763462)

**Built-in memory in the harnesses**
- Claude Code (docs fetched 2026-10-09) has two mechanisms:
  - CLAUDE.md, which you write, at project, user or org scope.
  - Auto memory, which Claude writes. It is on by default in local sessions and saves four note types (`user`, `feedback`, `project`, `reference`). It skips anything derivable from the code or git history.
  - Auto memory lives in `~/.claude/projects/<project>/memory/`: a `MEMORY.md` index (first 200 lines or 25KB loaded every session) plus one topic file per memory. Docs: "Auto memory is machine-local ... Files are not shared across machines or cloud environments."
  - Settings: disable with `autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; relocate with `autoMemoryDirectory`.
  - Source: [Claude Code docs: How Claude remembers your project](https://code.claude.com/docs/en/memory)
- Claude Code v2.1.277 (2026-09-18) reads AGENTS.md when no CLAUDE.md/CLAUDE.local.md exists. Reading both requires the non-default `claude-md-and-agents-md` setting — [Claude Code docs](https://code.claude.com/docs/en/memory); [HN 49760187](https://news.ycombinator.com/item?id=49760187)
- GitHub Copilot Memory timeline:
  - 2025-12-19: early access for Pro/Pro+.
  - 2026-01-15: public preview for all paid plans, with 28-day expiry.
  - 2026-03-04: on by default for Pro/Pro+.
  - 2026-05-26: repo-level off switch and CLI controls.
  - 2026-09-25: used by agentic autofix.
  - Sources: [changelog 2025-12-19](https://github.blog/changelog/2025-12-19-copilot-memory-early-access-for-pro-and-pro); [2026-01-15](https://github.blog/changelog/2026-01-15-agentic-memory-for-github-copilot-is-in-public-preview/); [2026-03-04](https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/); [2026-05-26](https://github.blog/changelog/2026-05-26-copilot-memory-has-more-controls-for-deletion-scope-and-the-copilot-cli/); [2026-09-25](https://github.blog/changelog/2026-09-25-agentic-autofix-now-uses-copilot-memory)

**claude-mem**
- How it works:
  - Lifecycle hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) capture activity automatically. Observations are compressed by the Claude Agent SDK and stored in local SQLite. A local web viewer runs on port 37777. Content wrapped in `<private>` tags is excluded — [Better Stack](https://betterstack.com/community/guides/ai/claude-mem/); [DataCamp](https://www.datacamp.com/tutorial/claude-mem-guide)
  - One review argues hooks matter because MCP-only retrieval happens only "when Claude decides to ask for it" — [Augment Code](https://www.augmentcode.com/learn/claude-mem-persistent-memory-claude-code)
- README as of 2026-10-09:
  - Install targets include OpenCode and T3 Code (Codex and Claude Code providers).
  - Observations from Claude Code and Codex can be combined at session start with `CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES` (default false).
  - The installer asks users to sign in and offers a 30-day trial of a hosted observer. Sign-in can be skipped with `CLAUDE_MEM_ONLINE_OPTIN=false`.
  - Cloud sync goes to cmem.ai.
  - The README also says a third-party "CMEM" crypto token is "officially embraced by the creator."
  - Source: [claude-mem README](https://github.com/thedotmack/claude-mem)

**Beads and task-tracker alternatives**
- Origin and design:
  - Yegge built Beads after a failed ~350k-line TypeScript project and concluded that agents need a structured issue tracker rather than markdown plans.
  - Issues are JSONL in git with a SQLite cache and hash IDs to avoid merge conflicts.
  - Sources: [Yegge, Introducing Beads (2025-11-12 mirror)](https://steveyegge.spicytakes.org/post/2025-11-12-introducing-beads-a-coding-agent-memory-system); [paddo.dev](https://paddo.dev/blog/beads-memory-for-coding-agents/)
  - Yegge claimed 1,000 stars and 50 forks in six days — [Yegge on X](https://x.com/Steve_Yegge/status/1978335514039337380)
- Beads in daily use (HN, 2025-11-28):
  - "It doesn't compete with gh issues as much as it competes with markdown specs. It's helpful for getting Claude code to work with tasks that will span multiple context windows" (adamgordonbell).
  - A spec-kit user re-templated spec-kit to use Beads instead of markdown files (iand675).
  - Source: [HN 46075616](https://news.ycombinator.com/item?id=46075616)
- Backlash and alternatives (HN, 2026-01-04):
  - "Show HN: I replaced Beads with a faster, simpler Markdown-based task tracker" (ticket/`tk`). Its author has ~1,900 markdown tickets in one project.
  - `git notes` for solo work ("Claude Code just needs to be told that they exist"; no merge logic, so not for teams) (arjie).
  - The `gh` CLI with GitHub issues (jannniii and others).
  - Source: [HN 46487580](https://news.ycombinator.com/item?id=46487580)

**Minimal practices from known practitioners**
- Simon Willison (HN, 2025-11-28): "I often tell my coding agents 'append things you figure out to notes.md as you are working' - then in future sessions I can tell them to read or search that file." He also lets Claude Code grep a `~/dev/` folder of several hundred checked-out repos instead of using a vector memory — [HN 46075616](https://news.ycombinator.com/item?id=46075616)
- Mitchell Hashimoto (2026-02-05): when an agent repeatedly does something wrong, "update the `AGENTS.md` (or equivalent)". "Each line in that file is based on a bad agent behavior, and it almost completely resolved them all." He calls this "harness engineering." The post mentions no separate memory or notes system — [Hashimoto, My AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey)
- Geoffrey Huntley's Ralph loop (2025-07-14):
  - Each loop gets a fresh context and re-reads `@fix_plan.md` and the `specs/` folder (one spec per file).
  - `AGENT.md` is "the heart of the loop". The loop should "update @AGENT.md using a subagent but keep it brief."
  - Notes are needed because "future loops will not have the reasoning in their context window."
  - On the plan file: "The TODO list is what I'm watching like a hawk. And I throw it out often."
  - Source: [Huntley, Ralph](https://ghuntley.com/ralph/)
- Harper Reed (2025-02-16): `spec.md`, `prompt_plan.md` and a checked-off `todo.md` in the repo, "good for keeping state across sessions" — [Harper Reed, My LLM codegen workflow atm](https://harper.blog/2025/02/16/my-llm-codegen-workflow-atm/)
- Peter Steinberger's agent-scripts:
  - One canonical `AGENTS.MD` of shared hard rules. Downstream repos carry a pointer line ("READ ~/Projects/agent-scripts/AGENTS.MD BEFORE ANYTHING (skip if missing)") with repo-specific rules below it: "Do not copy the shared blocks into downstream repos."
  - `~/.claude/CLAUDE.md` is symlinked to the shared file. A `sync-skills` script links skills for Codex and Claude Code.
  - Source: [steipete/agent-scripts](https://github.com/steipete/agent-scripts)
- Karpathy's "LLM Wiki" (2026-04-04, 296 HN points):
  - An "idea file" to paste into an agent: raw sources, plus an LLM-maintained interlinked markdown wiki, plus a schema file (CLAUDE.md/AGENTS.md) — [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f); [HN 47640875](https://news.ycombinator.com/item?id=47640875)
  - Follow-on: "A Karpathy-style LLM wiki your agents maintain (Markdown and Git)", 2026-04-25, 260 points — [HN 47899844](https://news.ycombinator.com/item?id=47899844)
- Heavy users who stay vanilla (HN, 2025-12-29):
  - A user "in Claude Code 30+ hr/wk" runs "pretty much ... vanilla everything" (dimitri-vs).
  - "I stick general preferences in what it calls 'user memory' and stick project specific preferences in the working directory" (eterm).
  - "If something consistently goes wrong I add more to CLAUDE.md or even better, have Claude Code just update CLAUDE.md itself" (levocardia).
  - Source: [HN 46426624](https://news.ycombinator.com/item?id=46426624)
- Skepticism toward memory plugins:
  - On the Recall thread (2026-06-21): "I never had to explain my project" (serial_dev). "the majority here have stated the same... That CLAUDE.md or AGENTS.md effectively do this" (intothemild). Source: [HN 48622590](https://news.ycombinator.com/item?id=48622590)
  - "I think this is mostly being overengineered. At this stage, a curated MEMORY.md is enough" (ubermon). "I think everyone's ended up building one of these for themselves" (arjie). One commenter catalogued "over 140 such systems" (zby). Sources: [HN 48923111](https://news.ycombinator.com/item?id=48923111); [zby's agent-memory-systems review](https://zby.github.io/commonplace/agent-memory-systems/)

**Other tools in coding use**
- Serena memories:
  - Markdown files in `.serena/memories/` that "can be committed, reviewed in PRs, and reverted," plus global memories in `~/.serena/memories/global/`.
  - An onboarding pass writes the first memories. The agent gets only memory names and "decides what to read and when."
  - Source: [Serena docs: Memories](https://oraios.github.io/serena/02-usage/045_memories.html)
- Hindsight:
  - Official Claude Code plugin with four hooks: SessionStart, UserPromptSubmit recall, Stop retain, SessionEnd.
  - Codex hook scripts, scoped per project by working directory.
  - Version 0.9.0 claims one plugin for ten coding agents.
  - Needs an LLM provider for extraction. Local (Docker) or cloud.
  - Sources: [Hindsight Claude Code integration](https://hindsight.vectorize.io/sdks/integrations/claude-code); [Hindsight Codex integration](https://hindsight.vectorize.io/sdks/integrations/codex); [starryhope guide](https://www.starryhope.com/ai/hindsight-memory-for-coding-agents/)

### Inferences
- No public usage telemetry exists for any of these tools. claude-mem's ~99k stars and ~2.2k issues do indicate a large real install base. The star counts for Mem0, Hindsight, Graphiti and Supermemory mix coding and non-coding use.
- Two lines of evidence point to file-based, harness-loaded memory as the default practice:
  - The attention gap: AGENTS.md threads reach 500-840 HN points, while memory-tool Show HNs reach 60-200.
  - The repeated "vanilla CLAUDE.md is enough" comments.
- Add-on memory tools tend to win where those files fall short: long research sessions, multi-day multi-window tasks, and searching old sessions across agents.
- claude-mem is moving toward a hosted, account-based product: a sign-in prompt at install, a hosted observer trial, and cloud sync. This is a material change for privacy-sensitive users.

### Gaps
- No install telemetry was collected (npm downloads, plugin marketplace counts) for claude-mem, Basic Memory, Serena, Hindsight or Beads.
- Reddit (r/ClaudeAI, r/ChatGPTCoding, r/cursor) sentiment could not be retrieved: searches returned no Reddit threads.
- Day-to-day usage reports for ByteRover/Cipher, Basic Memory and the Graphiti MCP in coding contexts were not found.
- The Cline Memory Bank has issue reports (see Q2) but no adoption numbers.

## Q2. What failure modes do practitioners report?

### Takeaway
Reported failures fall into seven groups:
- Instructions or memories that agents ignore, or that the harness loads inconsistently.
- Agents not saving or recalling at the right time.
- Cost and accuracy penalties from always-loaded context. This one has measured evidence.
- Stale, conflicting or bloated memories.
- Unverified efficiency claims and tool reliability bugs.
- Privacy exposure from hosted memory.
- Persistence of injected instructions (see Q6).

Two IDE vendors, Cursor and Windsurf/Devin, retreated from opaque auto-generated memories toward versioned rules and skills.

### Cited Findings
**Measured evidence on always-loaded context**
- ETH Zurich, "Evaluating AGENTS.md" (arXiv 2602.11988, Feb 2026):
  - Repository context files "tend to reduce task success rates compared to providing no repository context, while also increasing inference cost by over 20%."
  - Traces show agents do follow the files but explore more: more tests, more file reads.
  - The authors recommend that human-written files describe "only minimal requirements."
  - Source: [arXiv 2602.11988](https://arxiv.org/abs/2602.11988)
  - Secondary reports put developer-written files at +4% and LLM-generated files at −3%. These figures were not verified against the paper — [Medium summary](https://medium.com/activated-thinker/every-serious-developer-had-one-agents-md-file-now-theres-a-study-1f2513be062e)
- Conflicting measured evidence:
  - 124 PRs across 10 repos found AGENTS.md associated with 28.64% lower median runtime and 16.58% fewer output tokens, at comparable completion — [arXiv 2601.20404](https://arxiv.org/abs/2601.20404)
  - A two-agent, 17-task ablation found that context strategy did not measurably change correctness — [arXiv 2607.27250](https://arxiv.org/pdf/2607.27250)
- DreamBench-SWE (2026-08-21), a multi-session memory benchmark:
  - No external memory: 21/180.
  - Deterministic verbatim event memory: 82/180.
  - Pinned hosted Mem0 (literal storage): 97/180.
  - The author explicitly does not claim superiority among the conditions that have memory.
  - Source: [arXiv 2608.20664](https://arxiv.org/abs/2608.20664)
  - Reading: some memory helps a lot on tasks that need earlier-session evidence, and simple verbatim logs capture most of the gain.
- Chroma "Context Rot" (July 2025): performance degrades as input tokens increase. 260 HN points — [Chroma research](https://research.trychroma.com/context-rot); [HN 44564248](https://news.ycombinator.com/item?id=44564248)
- Vercel evals (2026-01-29): an AGENTS.md docs index beat skills (on-demand loading).
  - HN readers summarise it as AGENTS.md working "100% of the time as opposed to 79%" (velcrovan).
  - A commenter reads baseline/skills/skills+prompt/AGENTS.md as 29/33, 31/33, 32/33 and 33/33, and questions the margins and the number of runs (NitpickLawyer, jryan49).
  - Sources: [Vercel blog](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals); [HN 46809708](https://news.ycombinator.com/item?id=46809708)

**Ignored or inconsistently loaded instructions (anecdote, plus documented harness behaviour)**
- HN, 2026-09-18 ([HN 49760187](https://news.ycombinator.com/item?id=49760187)):
  - The system-reminder wrapper tells the model the injected context "may or may not be relevant." Codex reportedly follows AGENTS.md more reliably than Claude Code (boorang).
  - The harness, not the model, decides when to inject (Merad, adastra22).
  - Imported files "are more likely to fall out of context or to be ignored" (tstrimple).
- "Any tricks to get Claude to actually use the CLAUDE.md consistently? Many times now its completely ignored it, despite being short" (petee, 2026-06-21) — [HN 48622590](https://news.ycombinator.com/item?id=48622590)
- Documented edge cases ([Claude Code docs](https://code.claude.com/docs/en/memory); [HN 49814947](https://news.ycombinator.com/item?id=49814947)):
  - Before v2.1.281, sessions on Bedrock or with telemetry disabled read CLAUDE.md only.
  - Adding a CLAUDE.local.md silently stops AGENTS.md from loading by default.
  - A CLAUDE.md that tells Claude "in words" to read AGENTS.md works only "if it decides to open the file."
  - Docs: memory is "context, not enforced configuration"; longer files "reduce adherence."

**Agents not saving or recalling at the right time**
- "How does one make the agent actually save and recall memories and at relatively sensible times? ... nothing that actually looked useful in real use" (dizhn). The deja-vu author fell back to a SessionStart hook that injects context "completely bypassing the agent", plus pasted rules in CLAUDE.md/AGENTS.md — [HN 48923111](https://news.ycombinator.com/item?id=48923111)
- "The information being available is not the problem; the agent not realizing that it doesn't have all the info is". Putting memory behind MCP makes it "a matter of ensuring the agent will invoke the MCP at the right moment" (stingraycharles) — [HN 46075616](https://news.ycombinator.com/item?id=46075616)
- A well-described skill is still skipped "about 5-10% of the time" (joebates) — [HN 46809708](https://news.ycombinator.com/item?id=46809708)
- Serena: "An LLM may fail to save memories during onboarding." Onboarding "will read a lot of content ... filling up the context window" — [Serena docs](https://oraios.github.io/serena/02-usage/045_memories.html)
- Cline Memory Bank: a Feb 2025 issue reports Cline claiming it had updated the memory bank files when none changed — [cline#1911](https://github.com/cline/cline/issues/1911)

**Context bloat and token cost**
- Cline (Apr 2025): prompts reached ~300,000 tokens after ~5 iterations even with the Memory Bank on — [cline discussion #2979](https://github.com/cline/cline/discussions/2979)
- A guide warns that agents rewrite activeContext.md/progress.md after small changes. Its fix is to update the memory bank only at task end — [fast.io guide](https://fast.io/resources/cline-memory-bank-guide/)
- "Filling context with what you think the model needs adds nothing and possibly just inflates context which is harmful" (suprjami). "keeping a local copy of everything you ever told Claude in your context window is bad for the same reasons keeping a local copy of your code called My_Code_v3_final.zip is bad" (gste) — [HN 48622590](https://news.ycombinator.com/item?id=48622590)
- LLM Wiki critiques ([HN 47640875](https://news.ycombinator.com/item?id=47640875)):
  - "Too much context pollution" (cyanydeez).
  - "This is just RAG" (kenforthewin).
  - LLM rewrites gradually degrade the content ("rewriting valid information with less terse information") (devnullbrain).
  - Separately, a blog review says temporal tracking, decay, abstention and verification remain unaddressed — [akitaonrails](https://akitaonrails.com/en/2026/05/18/ai-agent-memory-karpathy-llm-wiki-agentmemory/)
- Compaction loses detail: "post-compaction, the memory of even the current session feels so much dumber" (austinbaggio, a memory-tool author) — [HN 46426624](https://news.ycombinator.com/item?id=46426624)
- Over-saving trivia and markdown sprawl: "recent LLMs seem to have an intense penchant to try to write one or more markdown files per large task" (iand675) — [HN 46075616](https://news.ycombinator.com/item?id=46075616)
- Tool overload: "Is anyone else just completely overwhelmed with the number of things you _need_ for claude code? Agents, sub agents, skills, claud.md, agents.md, rules, hooks" (JoshGlazebrook) — [HN 46426624](https://news.ycombinator.com/item?id=46426624)

**Staleness**
- An agent kept applying a rate limit that had since changed — [HackerNoon, Your Agent's Memory Is a Liability](https://hackernoon.com/your-agents-memory-is-a-liability-not-a-feature)
- Copilot builds in 28-day expiry "to prevent stale information" — [GitHub changelog 2026-01-15](https://github.blog/changelog/2026-01-15-agentic-memory-for-github-copilot-is-in-public-preview/)
- Serena ships `serena memories check` for stale references, but does not track staleness of memory content — [Serena docs](https://oraios.github.io/serena/02-usage/045_memories.html)

**Unverified claims and reliability (claude-mem)**
- Issue #4138 (2026-09-20) disputes the "~10x token savings" claim:
  - Search wrapped multi-word queries as exact FTS5 phrases. On 91k observations, a query returned 3 results instead of 76.
  - Natural-language queries returned 0.
  - Recall was never measured, so session injection "may be systematically incomplete."
  - A linked PR proposes to "remove unverified recall-efficiency claims."
  - Source: [claude-mem #4138](https://github.com/thedotmack/claude-mem/issues/4138)
- Other recent issues:
  - Cloud sync "permanently stuck" (#4191) — [#4191](https://github.com/thedotmack/claude-mem/issues/4191)
  - Observations lost if the worker restarts during a provider quota cooldown (#4580) — [#4580](https://github.com/thedotmack/claude-mem/issues/4580)
  - A request to disable the injected work-state section (#4625) — [#4625](https://github.com/thedotmack/claude-mem/issues/4625)

**Privacy**
- A Claude Code memory skill connected at session start to a third-party hosted MCP server. Users asked for self-hosting, and the vendor asked "what gets you comfortable sending proprietary code to other external services?" — [HN 46426624](https://news.ycombinator.com/item?id=46426624)
- Total Recall changed its installer to gitignore `memory/` by default because it "can contain personal notes, people context, and daily logs" — [HN 46907183](https://news.ycombinator.com/item?id=46907183)
- Supermemory proxies requests, which raises token consumption — [LogRocket](https://blog.logrocket.com/building-ai-apps-mem0-supermemory/)

**Concurrency**
- Parallel sessions writing the same markdown log can interleave or lose entries (Total Recall author: "at worst") — [HN 46907183](https://news.ycombinator.com/item?id=46907183)

**Duplicated and conflicting rules across tools**
- With CLAUDE.md symlinked to AGENTS.md, "When prompted to write to it, it will always try to write into the Claude.md and error out" (ffsm8).
- Codex reading a CLAUDE.md symlink will "generously re-interpret them as directions to itself" (ryandrake).
- "blindly applying agents.md is probably an antipattern" because prompts need per-model tuning (swyx).
- Source: [HN 49760187](https://news.ycombinator.com/item?id=49760187)

**Vendors retreating from auto-memories**
- Cursor: staff say Memories were intentionally removed starting in 2.1.x (one reply says 2.1.17), with an "Export memories" command that writes .mdc rules. One user said the command was missing in 2.1.34 — [Cursor forum](https://forum.cursor.com/t/are-my-memories-gone/144057)
- Devin (formerly Windsurf): auto-generated memories "apply to the legacy Cascade agent only." The default Devin Local agent "does not persist memories." Users are told to migrate memories to skills — [Devin docs](https://docs.devin.ai/desktop/cascade/memories)

### Inferences
- The best-measured finding is that always-on context has a cost. It raises tokens and can lower success.
- A second, partly conflicting finding (Vercel's evals, plus reports of skipped skills) is that on-demand retrieval is unreliable because agents do not reliably fetch.
- Together these favour small, high-value always-loaded files (indexes, pointers, hard rules) plus deterministic injection by hooks, rather than large always-loaded dumps or tools that depend on the agent to fetch.
- Cursor and Windsurf/Devin stepping back from auto-generated memories toward versioned rules and skills suggests auto-memory was hard to make trustworthy in a product.
- Efficiency claims for memory plugins are mostly unmeasured. The #4138 dispute shows recall is rarely benchmarked.

### Gaps
- No measured data on how often memory poisoning happens in the wild, how much trivia gets saved, or the token cost of claude-mem-style injection in typical use.
- The ETH figures for developer-written vs LLM-generated files were not verified against the paper.

## Q3. What patterns do experienced practitioners recommend?

### Takeaway
- Keep always-loaded instructions short, and grow them only from observed failures (Hashimoto's "harness engineering").
- Use pointers and @imports to one canonical file rather than copies.
- Put durable knowledge in versioned docs and rules.
- For long-running work, use progress/todo files, structured feature or task lists, and git history.
- Prefer a task tracker over ad-hoc markdown plans for multi-session work.
- Gate memory writes behind human review instead of trusting fully automatic capture.

### Cited Findings
- Anthropic (2025-11-26) ([Anthropic, Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)):
  - An initializer agent writes `claude-progress.txt`, an `init.sh`, and a JSON feature list in which every feature starts as failing.
  - Each session reads the progress file and the git log, works on one feature, commits "with descriptive commit messages", and updates progress.
  - JSON was chosen because the model is "less likely to inappropriately change or overwrite JSON files compared to Markdown files."
  - Failures it addresses: premature victory, undocumented half-finished work, features marked done without tests.
- Grow instructions from failures:
  - "Each line in that file is based on a bad agent behavior" — [Hashimoto](https://mitchellh.com/writing/my-ai-adoption-journey)
  - "only make a skill or memory when the LLM gets something wrong" (suprjami) — [HN 48622590](https://news.ycombinator.com/item?id=48622590)
- Keep it minimal:
  - "human-written context files should describe only minimal requirements" — [arXiv 2602.11988](https://arxiv.org/abs/2602.11988)
  - Claude Code docs: target "under 200 lines per CLAUDE.md file". Move area-specific rules into path-scoped `.claude/rules/`. Use hooks for anything that must be enforced — [Claude Code docs](https://code.claude.com/docs/en/memory)
  - Huntley: "keep it brief" — [Huntley](https://ghuntley.com/ralph/)
  - AGENTS.md as "a nested sparknotes for the project" (verdverm) — [HN 49760187](https://news.ycombinator.com/item?id=49760187)
- Pointers, not copies:
  - Steinberger's single-line pointer plus local rules — [steipete/agent-scripts](https://github.com/steipete/agent-scripts)
  - CLAUDE.md containing only "@AGENTS.md" "worked well" (bryanhogan) — [HN 49760187](https://news.ycombinator.com/item?id=49760187)
  - "Just a simple PROJECT.md is enough - and referenced from AGENTS.md" (theshrike79) — [HN 48622590](https://news.ycombinator.com/item?id=48622590)
- Put an index in the always-loaded file: Vercel found a docs index in AGENTS.md more reliable than skills. "You need the model to interpret documentation as policy you care about ... rather than as something it can look up if it doesn't know something (which it will never admit)" (thom) — [HN 46809708](https://news.ycombinator.com/item?id=46809708)
- Docs as memory, with periodic consolidation:
  - "record things chronologically and then have Claude do periodic reviews of the docs and update key design documents" (pigpop) — [HN 46426624](https://news.ycombinator.com/item?id=46426624)
  - A commit agent that removes "documentation of completed work except where it should be rolled into lasting documentation" (vidarh) — [HN 46075616](https://news.ycombinator.com/item?id=46075616)
  - "using CLAUDE.md / agent instructions as de facto architecture docs ... those docs actually get maintained" (amadeuswoo) — [HN 46693985](https://news.ycombinator.com/item?id=46693985)
  - "Agents don't need memory, they need documentation" — [DEV Community](https://dev.to/max_quimby/agents-dont-need-memory-they-need-docs-48a6)
- Plan and todo files for long-running loops:
  - Huntley re-reads `fix_plan.md` and specs every loop and throws the plan out often — [Huntley](https://ghuntley.com/ralph/)
  - Harper Reed's `todo.md` is "good for keeping state across sessions" — [Harper Reed](https://harper.blog/2025/02/16/my-llm-codegen-workflow-atm/)
- A task tracker instead of markdown plans for work that spans several context windows:
  - [Yegge](https://steveyegge.spicytakes.org/post/2025-11-12-introducing-beads-a-coding-agent-memory-system); [HN 46075616](https://news.ycombinator.com/item?id=46075616)
  - Lighter alternatives: `tk`, `git notes`, GitHub issues — [HN 46487580](https://news.ycombinator.com/item?id=46487580)
- Gated writes and human pruning (Total Recall thread, [HN 46907183](https://news.ycombinator.com/item?id=46907183)):
  - Design principle: "the model shouldn't necessarily be trusted to decide what's permanently important."
  - Tiers: a small always-loaded `CLAUDE.local.md` ("around a page of text"); categorized registers read on demand; append-only daily logs that "decouple capture from commitment."
  - "I'm a fan [of] human pruning ... I'd argue any 'automated memory' is a failure over time" (4b11b4).
  - "no fully automatic writes ... ongoing review process, deduplication" (andershaig).
- Vendors also gate and validate:
  - Devin suggests Knowledge from chat feedback, and the user edits, saves or dismisses each suggestion — [Devin docs: Knowledge](https://docs.devin.ai/onboard-devin/knowledge)
  - Copilot uses only facts validated against cited code — [GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- Deterministic search over semantic search for old sessions: recall usually needs "the exact error string, the unique function name, a specific cli flag." Embeddings bring large models and "non-deterministic results" (vshulcz) — [HN 48923111](https://news.ycombinator.com/item?id=48923111)
- Fresh context after each task, reloading memory files rather than chat history — [fast.io Cline guide](https://fast.io/resources/cline-memory-bank-guide/); [Huntley](https://ghuntley.com/ralph/)

### Inferences
- Experienced practitioners converge on a layered design:
  - Hot: a small always-loaded constitution and index.
  - Cold: versioned docs and specs read on demand.
  - Working: progress/todo files or a tracker for the current task.
  - History: git log and searchable session transcripts.
- Automatic capture is tolerated as raw history to search, but promotion to always-loaded memory is expected to pass a human or a validation gate.
- "Remember this" (explicit, user-triggered) is the trusted path. Automatic capture is treated as a log, not as instructions.

### Gaps
- No primary statements were found from Armin Ronacher on agent memory specifically. His 2026 posts found were about agent-friendly languages — [Ronacher, A Language For Agents](https://lucumr.pocoo.org/2026/2/9/a-language-for-agents/)
- No controlled comparison of explicit "remember this" vs automatic capture was found.

## Q4. How do people share memory across agents and machines, and what pain remains?

### Takeaway
- Across agents, people mostly keep one canonical AGENTS.md and reach it through symlinks or @imports. Since 2026-09-18, Claude Code also reads AGENTS.md natively.
- Across machines, people use a git dotfiles repo, sometimes a Syncthing/iCloud folder, and now some small sync tools.
- Built-in auto-memories are machine-local and harness-specific: Claude Code, Windsurf/Devin and Cursor (now removed) all work this way.
- Cross-agent memory aggregators exist but have thin independent validation: claude-mem multi-harness, Hindsight's ten-agent plugin, OpenMemory MCP, Pieces MCP, Supermemory MCP, deja-vu and ctx.
- Remaining pain points:
  - Different file names and rule formats per tool.
  - Symlink edge cases (Windows, write-back).
  - Per-model tuning.
  - Default settings that silently skip files.
  - The safety of injecting memory from another machine without vetting it.

### Cited Findings
**Symlinks and imports**
- `ln -s AGENTS.md CLAUDE.md`; git post-checkout hooks that recreate symlinks (nomel); a CLAUDE.md with "@AGENTS.md" plus Claude-specific steering below it (bengt).
- git tracks symlinks but not hardlinks (wgd).
- Counter-view: one shared file for every model is "probably an antipattern" (swyx).
- Source: [HN 49760187](https://news.ycombinator.com/item?id=49760187)
- Claude Code skips an AGENTS.md it already loaded through an import or symlink, so the file is not read twice — [Claude Code docs](https://code.claude.com/docs/en/memory)

**Dotfiles and sync tools**
- A dotfiles repo maps one personal instructions file to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` with a setup script — [Pablo Stafforini](https://stafforini.com/notes/how-i-keep-claude-code-and-codex-in-sync/)
- Options compared: a git repo, a Syncthing/Dropbox/iCloud folder, or a notes vault — [coding-with-ai.dev](https://coding-with-ai.dev/posts/sync-claude-code-codex-cursor-memory/)
- Windows symlinks need admin rights or Developer Mode, so imports are safer on mixed-OS teams — [aq.dev](https://aq.dev/guides/keep-agents-md-and-claude-md-in-sync/)
- Sync tools:
  - agentsync ("Dotfiles for AI agents": skills, rules, commands and MCP servers for Claude Code, Cursor and Codex from one git manifest) — [JustinBeaudry/agentsync](https://github.com/JustinBeaudry/agentsync)
  - claude-code-dotfiles — [Povaz/claude-code-dotfiles](https://github.com/Povaz/claude-code-dotfiles)
- Steinberger's `sync-skills` builds per-machine skill links for Codex and Claude Code. `~/.claude/CLAUDE.md` is symlinked to the shared AGENTS.MD — [steipete/agent-scripts](https://github.com/steipete/agent-scripts)

**Machine-local memory stores**
- Claude Code auto memory is per repository and shared across worktrees, but machine-local. A gitignored `CLAUDE.local.md` exists only in the worktree where it was created, so the docs suggest importing a home-directory file instead — [Claude Code docs](https://code.claude.com/docs/en/memory)
- Windsurf/Devin memories live in `~/.codeium/windsurf/memories/`, are scoped to a workspace and are "not committed to your repository" — [Devin docs](https://docs.devin.ai/desktop/cascade/memories)

**Cross-agent aggregators**
- claude-mem combines Claude Code and Codex observations at session start when `CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES=true` (default false). It installs into OpenCode and T3 Code, and offers cloud sync to cmem.ai — [claude-mem README](https://github.com/thedotmack/claude-mem)
- Hindsight offers plugins for Claude Code and Codex and a unified plugin covering ten coding agents (v0.9.0), with a self-hosted or cloud server — [Hindsight Claude Code](https://hindsight.vectorize.io/sdks/integrations/claude-code); [Hindsight Codex](https://hindsight.vectorize.io/sdks/integrations/codex)
- Mem0 OpenMemory MCP:
  - Shared memory for MCP clients (Cursor, Claude Desktop and Windsurf are listed), local or hosted, backed by Qdrant — [mem0.ai/openmemory](https://mem0.ai/openmemory); [Hugging Face guide](https://huggingface.co/blog/lynn-mikami/open-memory-mcp-server)
  - Independent reviews are thin (one Product Hunt review) — [Product Hunt](https://www.producthunt.com/products/openmemory-mcp-2)
- Pieces MCP exposes activity-based long-term memory, queryable by time and app, to Copilot, Cursor and other clients. The vendor notes the token overhead of each call — [Pieces](https://pieces.app/blog/introducing-the-pieces-mcp-server)
- Small protocol and SQLite projects:
  - "Open Memory Protocol – One Memory Store for Claude, ChatGPT, Cursor", 2026-06-30, 33 points — [HN 48726966](https://news.ycombinator.com/item?id=48726966)
  - CaviraOSS OpenMemory (SQLite), 2025-12-14, 48 points — [HN 46262294](https://news.ycombinator.com/item?id=46262294)
- deja-vu (2026-07-15) ([HN 48923111](https://news.ycombinator.com/item?id=48923111)):
  - Built "after watching Claude Code and Codex debug the same problems more than once." The author had ~3.3 GB of old session records.
  - Setup: a laptop plus a headless Mac mini where "the agent can work on the mini all night, and in the morning I extract its memory."
  - It strips known secrets and uses exact-token search.
  - A commenter flagged that blindly injecting another machine's memory without vetting is an injection risk (koolba).
- ctx searches the existing local history of several agents — [HN 48763462](https://news.ycombinator.com/item?id=48763462)
- Codex offered to import Claude and Cursor conversations (cjonas) — [HN 49760187](https://news.ycombinator.com/item?id=49760187)

**Why people want cross-agent memory, and why some avoid it**
- A vendor's motivation: "context living beyond a single agent or tool ... that context is still owned by that agent instance". MCP works in Cursor, "but you lose a lot of the auto-magic stuff you get with the Claude Code plugin" — [HN 46426624](https://news.ycombinator.com/item?id=46426624)
- Deliberately not syncing: "I've settled on writing these bespoke per project/client, typically as a harness plugin in its own repo ... simplifies the full mental model not to have to handle moving from machine to [machine]" (Arubis) — [HN 48923111](https://news.ycombinator.com/item?id=48923111)

**Rules formats remain per tool**
- Cursor `.cursor/rules/*.mdc` uses globs; Claude Code `.claude/rules/` uses `paths` frontmatter; skills (SKILL.md folders) can be symlinked across Claude Code and Codex — [Unblocked blog](https://getunblocked.com/blog/keeping-claude-md-agents-md-cursorrules-in-sync/); [Claude Code docs](https://code.claude.com/docs/en/memory)

### Inferences
- The portable layer in practice is git-versioned markdown: AGENTS.md, docs, skills and plans. Opaque auto-memory stores stay tied to one harness and one machine, which is why people either avoid them or add an aggregator.
- Cross-machine sync of learned memory, as opposed to instructions, is still mostly DIY: SSH sync, cloud sync from one vendor, or a git repo.
- Injecting memory written by another agent or machine without vetting is a recognised but unsolved risk.

### Gaps
- No chezmoi-specific walkthrough for agent instruction files was found.
- No independent evaluation of OpenMemory, Supermemory MCP or Pieces in coding workflows was found.
- No data on how many users run more than one agent against a shared memory store.

## Q5. Team/shared memory: how teams share conventions, and who approves

### Takeaway
- Teams share learned conventions mainly through checked-in instruction files and rules, reviewed in PRs like code.
- Hosted products add governed memory:
  - GitHub Copilot Memory: scoped to repo or user, citation-validated, expires after 28 days, with owner and admin controls.
  - Devin: suggests Knowledge, and a human edits and approves it.
- Vendors themselves point durable team knowledge to version-controlled files rather than auto-memories.

### Cited Findings
- GitHub Copilot Memory (public preview) ([GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/copilot-memory); [changelog 2026-05-26](https://github.blog/changelog/2026-05-26-copilot-memory-has-more-controls-for-deletion-scope-and-the-copilot-cli/)):
  - Repository facts come only from actions by users with write access. They are stored "with citations to supporting code" and validated against the current branch ("Only validated facts are used").
  - Unused entries are deleted after 28 days.
  - Repository owners can review and delete facts. Org and enterprise admins must enable the policy, and since 2026-05-26 repo admins can turn memory off per repository.
  - Facts are shared across the cloud agent, code review, the CLI and autofix. Code review uses repository facts only.
- Devin Knowledge: "Devin will automatically suggest Knowledge to remember based on your feedback in chat". Users edit before saving or dismiss each suggestion — [Devin docs: Knowledge](https://docs.devin.ai/onboard-devin/knowledge); [Cognition Dec 2024 update](https://cognition.ai/blog/dec-24-product-update)
- Devin/Windsurf docs:
  - To remember something durably and share it with your team, ask Cascade to write it to a Rule in `.devin/rules/` or to the repo's AGENTS.md. Rules are "version-controlled and shareable."
  - Size caps: global rules 6,000 characters; workspace rule files 12,000 characters each.
  - Source: [Devin docs](https://docs.devin.ai/desktop/cascade/memories)
- Cursor: memories once required user approval before saving (1.2). They were later removed (2.1.x), with an export path into Rules — [past.dev](https://www.past.dev/blog/cursor-memory); [Cursor forum](https://forum.cursor.com/t/are-my-memories-gone/144057)
- Claude Code scopes:
  - Project CLAUDE.md is "Team-shared instructions for the project ... via source control."
  - User and local files are personal. Auto memory is personal and machine-local.
  - Org-wide policy goes through a managed CLAUDE.md.
  - A `managed-only` setting loads only the org's managed CLAUDE.md and auto memory.
  - Source: [Claude Code docs](https://code.claude.com/docs/en/memory)
- Serena project memories are committed and "reviewed in PRs, and reverted like any other repository artifact" — [Serena docs](https://oraios.github.io/serena/02-usage/045_memories.html)
- Total Recall offers a documented "team mode" gitignore pattern for teams that want to share memory, while ignoring `memory/` by default — [HN 46907183](https://news.ycombinator.com/item?id=46907183)
- Shared instruction files can also be abused. Hashimoto says he plants prompt injections in his AGENTS.md and code comments to catch contributors who submit unreviewed agent output (June 2026, X post; reported, not verified here) — [Hashimoto on X](https://x.com/mitchellh/status/2067970516951150721)

### Inferences
- The dominant governance model is the ordinary code review flow over versioned files. Hosted memories add machine validation (citations, expiry) and admin switches, not human approval of each fact. Devin is the exception, with per-item approval of suggestions.
- Approval rights follow write access: Copilot repo facts come from writers, and committed files go through PR review.

### Gaps
- No primary data on how teams resolve conflicting memories between members.
- No documentation of team-shared Claude Code auto memory (none appears to exist: auto memory is personal and machine-local).

## Q6. Security research on memory persistence and mitigations

### Takeaway
- Memory turns a one-off prompt injection into a persistent one.
- Public demonstrations from 2024 to 2026 cover ChatGPT, Gemini, Windsurf, Claude's consumer memory tool and Claude Code's MEMORY.md and hooks.
- Vendor fixes have mostly closed specific vectors (exfiltration channels, system-prompt placement) rather than the root cause: untrusted content can trigger memory writes, and memory is read back as trusted context.
- Recommended mitigations:
  - Review and prune memories.
  - Require confirmation for memory writes triggered by content.
  - Keep secrets out of memory.
  - Vet untrusted repositories.
  - Treat memory as data, not instructions.

### Cited Findings
- ChatGPT "SpAIware" (Rehberger, 2024-09-20) ([Embrace The Red](https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/)):
  - Prompt injection from a website or document wrote instructions into ChatGPT's long-term memory. They persisted across sessions and continuously exfiltrated chats through image URLs.
  - OpenAI fixed the exfiltration vector in macOS app 1.2024.247, but "A website or untrusted document can still invoke the memory tool to store arbitrary memories."
  - Advice: update, "regularly review" memories, use temporary chats.
- Gemini (Rehberger, Feb 2025): "delayed tool invocation" bypassed Gemini's refusal to call memory tools on untrusted data, planting long-term memories present in all future sessions. Google rated it low probability and low impact — [GIGAZINE coverage](https://gigazine.net/gsc_news/en/20250214-prompt-injection-gemini-long-term-memory/); [Slashdot/Ars coverage](https://it.slashdot.org/story/25/02/12/0011205/new-hack-uses-prompt-injection-to-corrupt-geminis-long-term-memory)
- Windsurf SpAIware (Rehberger, 2025-08-22) ([Embrace The Red](https://embracethered.com/blog/posts/2025/windsurf-spaiware-exploit-persistent-prompt-injection/)):
  - Windsurf's memory tool was invoked automatically, so injected content could persist false information or instructions into future conversations and exfiltrate data.
  - Windsurf had been unresponsive since the end-of-May report.
- Claude Code MEMORY.md compromise (Cisco, 2026-04-01) ([Cisco Blogs](https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code)):
  - Attack: a malicious repo's npm postinstall hook overwrote `~/.claude/projects/*/memory/MEMORY.md`, the hooks in `~/.claude/settings.json`, and a shell alias that re-enabled auto-memory.
  - "Memory files are treated as high-authority additions to this rulebook." The poisoned agent advised hardcoding API keys, and the effect persisted across projects, sessions and reboots.
  - Fix: Claude Code v2.1.50 removed user memories from the system prompt. Anthropic said the attack requires interacting with an untrusted repository and that the user principal is fully trusted.
  - Implied mitigations: update, vet install scripts, and audit MEMORY.md, hooks and shell rc files.
- Claude Opus 4.7 memory tool (Rehberger, 2026-04-17) ([Embrace The Red](https://embracethered.com/blog/posts/2026/breaking-opus-4.7-with-chatgpt/)):
  - An image with hidden text made Opus write four fake memories in 5 of 10 trials, even though it flagged possible injection every time.
  - Plausible payloads succeeded more often, and an empty memory store was easier to poison.
  - The specific example dropped to 0% about 24 hours later, for unknown reasons.
  - The HackerOne report was closed as a safety issue.
  - The memory tool's guidance includes "critical_reminders" such as not storing verbatim commands.
- Cross-machine memory as a vector: injecting another machine's extracted memory "fully automated ... without any vetting" was flagged as an injection path (koolba) — [HN 48923111](https://news.ycombinator.com/item?id=48923111)
- Secrets: deja-vu strips known secrets before storing. ctx stores text as-is and warns users to review it before publishing — [HN 48923111](https://news.ycombinator.com/item?id=48923111). claude-mem excludes content in `<private>` tags — [claude-mem README](https://github.com/thedotmack/claude-mem)
- Supply-chain and process risk in a memory tool's own repo: claude-mem issue #4430 (2026-10-05) flags a version-bump skill that tells an agent to read npm credentials and publish on its own — [claude-mem #4430](https://github.com/thedotmack/claude-mem/issues/4430)
- Built-in enforcement: Claude Code docs say memory is context, and actions that must be blocked need a PreToolUse hook — [Claude Code docs](https://code.claude.com/docs/en/memory)

### Inferences
- The attack pattern repeats across vendors: (1) an automatic memory write triggered by untrusted content, (2) the memory is re-read later as trusted user context, (3) it is used for exfiltration or unsafe advice.
- Any harness that auto-captures memory, or syncs memory between agents or machines, inherits this pattern. Each additional writer (hooks, other agents, other machines) widens the entry points.
- Mitigations found in practice:
  - Write gates and human review (Total Recall, Devin suggestions).
  - Validation against code (Copilot citations).
  - Expiry (Copilot 28 days).
  - Placement outside the system prompt (Claude Code v2.1.50).
  - Secret stripping (deja-vu).
  - Treating memory as data rather than instructions.
- The current Claude Code docs still load the first 200 lines or 25KB of MEMORY.md into every session. The Cisco-reported fix appears to change where memory is placed and how authoritative it is, not whether it loads. This is inferred, not confirmed.

### Gaps
- The OWASP agentic guidance on memory poisoning (e.g. ASI06) was not retrieved.
- No research found specifically on poisoning memory MCP servers (OpenMemory, Hindsight, claude-mem) or on poisoning Beads issue data.
- Rehberger's original Gemini post URL was not fetched; only secondary coverage is cited.

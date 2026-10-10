# Memory in coding agents other than Claude Code and Codex (as of 2026-10-09)

Labels used below: "documented" means vendor docs, changelog or engineering blog. "Secondary" means a third-party summary or search snippet; these are flagged inline. "Inference" means my own reasoning, and appears only in the Inferences subsections. Every finding carries a URL. Dates are given where the claim depends on a version.

## Q1. Per-agent mechanics, and which agents keep memory locally vs in the vendor cloud (sync across machines and teammates)

### Takeaway
Two families have formed.

**Vendor-cloud memory, scoped to an account, repo or org.** It follows the user across machines and is often shared with a team:
- GitHub Copilot Memory: repo facts and per-user preferences on GitHub's servers, shared across Copilot surfaces and with everyone who has read access to the repo.
- Devin Knowledge: org and enterprise scope; being migrated into Skills since 2026-09-18.
- Cursor Projects shared-context files: synced "across every cloud and local machine", beta since 2026-09-10.
- Augment Cosmos Expert memory: a shared virtual filesystem, either org-shared or personal.
- Amp threads: stored server-side, searchable by workspace members.
- Factory Organization Memory: older docs only, unverified today.
- Kiro Memory (launched 2026-10-09): repo-scoped records, but the docs do not say where they are stored.

**Local, file-based memory.** It is per machine and shared only if the user commits or syncs files themselves:
- Windsurf / Devin Desktop Cascade memories: `~/.codeium/windsurf/memories/`, per workspace, never synced.
- Gemini CLI: Markdown tiers (global `~/.gemini/GEMINI.md`, repo `GEMINI.md`, a private per-project memory folder) plus an experimental Auto Memory inbox.
- VS Code agent memory tool: local files under `/memories/`.
- Hermes Agent: `~/.hermes/memories/MEMORY.md` + `USER.md`, a SQLite session store and self-written skills.
- OpenClaw: workspace `MEMORY.md`, `USER.md` and daily `memory/YYYY-MM-DD.md` notes.

**No automatic memory.** Aider, OpenCode, Cline, Roo Code (shut down 2026-05-15), JetBrains Junie and Factory Droid today rely only on instruction files. Teams share those through git.

### Comparison table (documented facts unless marked; blank = not documented)

| Agent | Store and format | Scope | Writes | Recall | Local vs cloud; sharing | User controls |
|---|---|---|---|---|---|---|
| GitHub Copilot Memory | Server-side records: subject, fact, citations, reason | Repo facts; per-user preferences | Automatic `store_memory` tool calls by cloud agent, code review, CLI, autofix | Most recent repo memories added to the prompt at session start; each checked against its cited code before use | GitHub cloud; shared across Copilot surfaces and all users with repo read access | 28-day expiry (reset on use); repo owners delete facts; per-repo off switch; admin policy; CLI `/memory` |
| VS Code agent memory tool (Copilot Chat) | Local Markdown under `/memories/`, `/memories/repo/`, `/memories/session/` | User / workspace / session | Agent writes when asked | First 200 lines of user memory auto-loaded; rest on request | Local only; repo memory "isn't a shared project file" | Show / Clear All Memory Files commands |
| Cursor Memories (removed) | Per-project memories in Settings | Project, per user | Auto-generated, beta | Injected | Not shared | Gone in 2.1 (Nov 2025) |
| Cursor Projects (beta) | Shared context files | Per Project | Agents write what they learn | Coordinator and subagents read | Synced across cloud and local machines | Not documented |
| Cursor rules | `.cursor/rules/*.mdc`, `~/.cursor/rules`, `AGENTS.md`, User Rules, Team Rules | Project / user / team | Human-authored | Always / intelligent / glob / manual | Git; Team Rules from the dashboard | Admins can enforce Team Rules |
| Windsurf → Devin Desktop (Cascade) | `~/.codeium/windsurf/memories/` | Workspace | Automatic, or "create a memory of ..." | Used by Cascade | Local only; not committed, not shared | Edit in Customizations; legacy Cascade agent only |
| Gemini CLI | Markdown: `~/.gemini/GEMINI.md`, repo `GEMINI.md`, private per-project folder | Global / project-shared / project-private | Agent edits files with `write_file`/`replace`; Auto Memory drafts patches and skills into an inbox | All tiers concatenated into every prompt; JIT loading for subdirectories | Local; repo file shared via git | `/memory show`, `reload`, `list`, `inbox` |
| OpenCode | `AGENTS.md`, `~/.config/opencode/AGENTS.md`, `instructions` (globs, URLs) | Project / user | Human; `/init` drafts | Always loaded | Git; remote URLs | Env vars disable Claude Code fallbacks |
| Amp | `AGENTS.md` hierarchy; threads | Project / user / workspace | Human (AGENTS.md); threads are a by-product | AGENTS.md always loaded; past threads read via `@T-…`/URL or search | Threads on Amp servers, visible to the workspace | Thread visibility levels; archive / delete |
| Cline | "Memory Bank" prompt method: `memory-bank/*.md` | Project | Agent writes when told | Instructions make it read every file each task | Git | All user-driven |
| Roo Code (shut down) | `.roo/rules*`, `~/.roo/rules*`, `AGENTS.md` | Project / user / mode | Human | Always loaded | Git | Extension shut down 2026-05-15 |
| Kiro | Steering `.kiro/steering/*.md` and `~/.kiro/steering`; Memory records (title, description, content, type, scope) | Workspace / global / repo | Steering: human. Memory: automatic, including after a session ends | Steering by inclusion mode; Memory retrieved on match | Steering via git, MDM or Configuration Sync; Memory storage not documented | `/memories` read&write, read only or off; no writes in untrusted workspaces |
| Aider | `CONVENTIONS.md` via `/read`, `--read` or `.aider.conf.yml` | Project | Human | Always loaded (read-only, cached) | Git | None |
| Factory Droid | `AGENTS.md`, `~/.factory/` instructions, skills | Project / user | Human | At startup and on dynamic discovery | Git. Older docs (secondary) describe User and Organization Memory | Not documented |
| Devin Knowledge → Skills | Cloud items: trigger + content (+ `!macro`) | Org / enterprise / repo-pinned / personal | Devin suggests; human approves | Retrieved by relevance; repo-pinned items always applied | Devin cloud, org-shared | Deprecated, migrating to Skills since 2026-09-18 |
| JetBrains Junie | `.junie/AGENTS.md`, `AGENTS.md` (+ `.junie/playbook.md`, `.junie/rules/*.md`), legacy `.junie/guidelines.md`; `~/.junie/AGENTS.md` | Project / user | Human; offers to import other agents' files | Always loaded | Git | None documented |
| Augment Code | Rules and guidelines files; IDE "Agent memories"; Cosmos Expert memory in a shared VFS | Workspace / user / org | Memories automatic | Memories in default context; Cosmos loads memory by scope | Cosmos memory org-shared or personal; Context Engine is a cloud index | Cosmos: correct or veto; simple vs noisy memory |
| Hermes Agent | `MEMORY.md` (2,200 chars) + `USER.md` (1,375 chars); `~/.hermes/skills/`; SQLite FTS5 sessions | User (per profile) | `memory` tool + background review; `skill_manage` | Frozen snapshot in the system prompt; `session_search` on demand; skills by progressive disclosure | Local; optional external providers | Write approval for memory and skills; `/journey`; curator |
| OpenClaw | `~/.openclaw/workspace`: `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md`, `DREAMS.md` | Per agent workspace | Agent writes files; pre-compaction flush; "dreaming" | Bootstrap files at session start; daily notes via hybrid search | Local; user is advised to back up to a private git repo | Flush, dreaming and embedding-provider settings |

### Cited Findings

#### GitHub Copilot: Copilot Memory, the VS Code memory tool, and instruction files
- **What Copilot Memory is.** It stores repository facts and per-user preferences. It is used by Copilot cloud agent, Copilot code review, Copilot CLI and agentic autofix. Memories captured by one feature can be used by another. Repo facts are used only in the same repo, and code review uses repo facts only. The IDE is not listed. — [GitHub Docs: Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- **How entries are created and expire.** Creating a repo fact requires write access. Facts can come from PRs closed without merging; those are used only if the current code still supports them. Unused entries are auto-deleted after 28 days, and successful validation and use resets the timer. — [GitHub Docs: Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- **Who controls it.**
  - Repo owners review and delete repo facts.
  - Users view and delete their own preferences.
  - Business and Enterprise admins can export or delete preferences in bulk; on those plans, preferences are owned by the billing org.
  - It is enabled per user: on by default for individual plans, behind an admin policy for org plans.
  - Status is still "public preview".
  - [GitHub Docs: Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- **Design** (blog by Tiferet Gazit, January 2026).
  - Each memory has a subject, a fact, citations and a reason.
  - Memories are created through a tool call (`store_memory`).
  - At session start, the most recent memories for the repo are put into the prompt. A search tool and weighted prioritization are "planned".
  - Memories are created only from actions in that repo by contributors with write permission, and used only by users with read permission.
  - [GitHub Blog: Building an agentic memory system for GitHub Copilot](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)
- **Timeline.**
  - 2025-12-19: early access / public preview for Pro and Pro+ (coding agent and code review). — [GitHub Changelog](https://github.blog/changelog/2025-12-19-copilot-memory-early-access-for-pro-and-pro)
  - 2026-01-15: all paid plans; 28-day expiry. — [GitHub Changelog](https://github.blog/changelog/2026-01-15-agentic-memory-for-github-copilot-is-in-public-preview/)
  - 2026-03-04: on by default for Pro and Pro+. — [GitHub Changelog](https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/)
  - 2026-05-26: per-repo off switch, deletion-scope controls, and `/memory` commands in Copilot CLI. — [GitHub Changelog](https://github.blog/changelog/2026-05-26-copilot-memory-has-more-controls-for-deletion-scope-and-the-copilot-cli/)
- **Secondary, not verified on GitHub.** JetBrains Copilot gained memory across chat sessions (2026-08-11) — [vpsranking summary](https://vpsranking.com/news/ai/ai-2026-08-11-github-copilot-jetbrains-memory-ollama/). Agentic autofix stores fix patterns as memories (2026-09-25) — [SessionWatcher](https://sessionwatcher.com/news/github-copilot-agentic-autofix-copilot-memory).
- **VS Code agent memory tool** (separate from Copilot Memory).
  - Scopes: User `/memories/` (across workspaces), Repository `/memories/repo/` (this workspace only), Session `/memories/session/`.
  - "User, repository, and session memory are stored locally on your machine."
  - "The first 200 lines are automatically loaded into the agent's context at the start of every session" (user memory).
  - Repository memory "isn't a shared project file".
  - Commands: "Chat: Show Memory Files" and "Chat: Clear All Memory Files".
  - The Plan agent keeps `plan.md` in session memory.
  - Docs advise moving verified repo knowledge into source-controlled instructions.
  - [VS Code docs source: memory.md](https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/agents/run/memory.md). Search snippets of the same official page give the toggle `chat.tools.memory.enabled` and a separate setting to integrate GitHub-hosted Copilot Memory — [VS Code: Memory in VS Code agents](https://code.visualstudio.com/docs/agents/run/memory)
- **Instruction files.**
  - Types: personal instructions (GitHub.com chat only), `.github/copilot-instructions.md`, path-specific `.github/instructions/NAME.instructions.md`, agent instructions (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`; "not supported by all Copilot features"), and organization instructions (Business and Enterprise).
  - Precedence: personal > repository (path-specific, repo-wide, agent) > organization. All relevant sets are sent.
  - PR review reads instructions and skills from the head branch.
  - JetBrains and Xcode support only `.github/copilot-instructions.md`.
  - [GitHub Docs: response customization](https://docs.github.com/en/copilot/concepts/prompting/response-customization)

#### Cursor
- **Memories launched** as a beta in Cursor 1.0 (June 2025): facts remembered from conversations, per project, managed under Settings → Rules. — [Cursor changelog 1.0](https://cursor.com/changelog/1-0)
- **The 2.1 changelog** (2025-11-21) says "Custom modes have been removed, with the ability to export as custom commands" and "Rules in home folder (`~/.cursor/rules`) will be included in context". It does not mention memories. — [Cursor changelog 2.1](https://cursor.com/changelog/2-1)
- **Users report memories disappearing in 2.1.** A forum thread dated 2025-11-23 asks for custom modes and memories back. A reply (poster not identified as staff) says Custom Modes were "intentionally removed in Cursor 2.1". No official reason for removing memories was found. — [Cursor forum: Custom modes and memories gone in 2.1](https://forum.cursor.com/t/custom-modes-and-memories-gone-in-2-1/143744); also [Are my memories gone?](https://forum.cursor.com/t/are-my-memories-gone/144057), [Memories not showing](https://forum.cursor.com/t/memories-not-showing/143820), [Can't clear memories](https://forum.cursor.com/t/cant-clear-memories/148254), [Memories get deleted when reloading window](https://forum.cursor.com/t/memories-get-deleted-when-reloading-window/137462) (pre-removal bug)
- **Workarounds** (secondary, from forum search snippets): an "Export memories" command writes an `.mdc` rule; downgrading to 2.0.77 shows memories so they can be deleted; or ask the agent to "Delete all memories". — [Cursor forum](https://forum.cursor.com/t/cant-clear-memories/148254)
- **Rules today.**
  - Project Rules live in `.cursor/rules/*.mdc` with frontmatter `description`, `globs`, `alwaysApply`; a plain `.md` file there is ignored.
  - User Rules (Customize → Rules) apply to Agent only.
  - Team Rules are set in the dashboard on Team and Enterprise plans and can be enforced; they support globs and apply across all team repos.
  - `AGENTS.md` is read in the root and in subdirectories; nested files combine, and the more specific one wins.
  - Order: Team → Project → User. Docs suggest keeping rules under 500 lines.
  - [Cursor Docs: Rules](https://cursor.com/docs/context/rules)
- **Cursor Projects** (beta, 2026-09-10).
  - "Each Project maintains a set of files that sync across every cloud and local machine its agents use."
  - Agents add "what they learn about the codebase and how you prefer work to be done".
  - "If one agent figures out how to test a service ... every future agent can use those instructions."
  - "This context grows with the Project".
  - [Cursor blog: Introducing Projects](https://cursor.com/blog/projects), [Cursor changelog: Projects](https://cursor.com/changelog/projects)
- **Automations memory files** (secondary): aggregators say Cursor Automations gained deletable memory files in June 2026 (3.8 or 3.9). Not verified on cursor.com. — [developertoolkit.ai changelog mirror](https://developertoolkit.ai/pl/cursor-ide/version-management/changelog/)

#### Windsurf → Devin Desktop (Cascade)
- **Where the docs are now.** Windsurf docs redirect to docs.devin.ai. "Memories apply to the legacy Cascade agent only"; the new default Devin Local agent "does not persist memories". — [Devin Docs: Cascade memories](https://docs.devin.ai/desktop/cascade/memories)
- **How memories work.**
  - Created automatically, or on request ("create a memory of ...").
  - Tied to the workspace and stored in `~/.codeium/windsurf/memories/`.
  - "Auto-generated memories live only on your machine." Not committed, not shared.
  - No credit cost.
  - Docs recommend Rules or AGENTS.md for durable knowledge.
  - [Devin Docs: Cascade memories](https://docs.devin.ai/desktop/cascade/memories)
- **Rules.**
  - Global: `~/.codeium/windsurf/memories/global_rules.md` (6,000 chars, always on).
  - Workspace: `.devin/rules/*.md` (preferred) or `.windsurf/rules/*.md`, 12,000 chars per file.
  - `AGENTS.md`: the root file is always on; subdirectory files act as an automatic glob for that directory.
  - Enterprise system rules: `/etc/devin/rules/`, `/Library/Application Support/Devin/rules/`, `C:\ProgramData\Devin\rules\`; read-only for users.
  - The legacy `.windsurfrules` is still read.
  - Triggers: always_on / model_decision / glob / manual.
  - [Devin Docs: Cascade memories](https://docs.devin.ai/desktop/cascade/memories)
- **Release notes.** 2026-07-31: the enterprise Cascade setting became a scope choice. 2026-08-07: "Legacy Cascade now defaults to disabled for enterprise tiers." 2026-08-14: Devin Local enabled by default for enterprise. — [Devin release notes](https://docs.devin.ai/release-notes/overview)
- **Secondary.** Windsurf was renamed Devin Desktop on 2026-06-02, with a "complete sunset of Cascade on July 1, 2026". That date is contradicted by docs that still describe legacy Cascade memories, and by the August release note that only *defaults* legacy Cascade to disabled for enterprise. — [businesstechnavigator](https://businesstechnavigator.com/news/windsurf-devin-desktop-cascade-eol-2026), [noqta](https://noqta.tn/en/blog/devin-desktop-windsurf-ai-agent-fleet-management-2026)
- **Known problem** (secondary): researchers found that Cascade's `create_memory` tool could be triggered by indirect prompt injection, making attacker instructions persistent ("SpAIware"-style). It was reported 2025-05-30 and disclosed about three months later. — [SecurityLab.ru](https://www.securitylab.ru/news/562793.php); background on SpAIware: [The Hacker News](https://thehackernews.com/2024/09/chatgpt-macos-flaw-couldve-enabled-long.html)

#### Gemini CLI
- **Memory is Markdown files** that the agent edits with `write_file`/`replace`.
  - Shared project instructions go to the repo `GEMINI.md`.
  - Private project notes go to a "per-project private memory folder".
  - Cross-project preferences go to `~/.gemini/GEMINI.md`.
  - Page last updated 2026-05-13.
  - [geminicli.com: Memory files](https://geminicli.com/docs/tools/memory/), [GitHub: docs/tools/memory.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/memory.md)
- **Release notes.**
  - v0.9.0 (2025-10-06): `/memory list`.
  - v0.23.0–v0.26.0 (Jan 2026): Agent Skills arrive in preview, are enabled by default, and ship with a `skill-creator` skill.
  - v0.40.0 (2026-04-28): "transitioned to a prompt-driven, four-tier memory management system".
  - v0.42.0 (2026-05-12): Auto Memory inbox "with a canonical-patch contract".
  - [Gemini CLI release notes](https://geminicli.com/docs/changelogs/)
- **The old `save_memory` tool**, which appended to `~/.gemini/GEMINI.md`, is no longer named in current docs, and no release note announces its removal. — current: [Gemini CLI memory docs](https://geminicli.com/docs/tools/memory/); old docs mirror: [save_memory](https://s1m0n38.github.io/gemini-cli/tools/memory/)
- **Loading.**
  - Three levels: global, workspace directories and their parents, and just-in-time (JIT) scanning when a tool touches a directory, "up to a trusted root".
  - "concatenates the contents of all found files, and sends them to the model with every prompt".
  - `@file.md` imports.
  - `context.fileName` can list `AGENTS.md`; it is not the default.
  - `/memory show` and `/memory reload`.
  - [geminicli.com: GEMINI.md](https://geminicli.com/docs/cli/gemini-md/), [memory-management tutorial](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/tutorials/memory-management.md)
- **Auto Memory** (experimental, off by default; enable with `"experimental": {"autoMemory": true}`).
  - A background task at startup reviews sessions in `~/.gemini/tmp/<project>/chats/` that have been idle for at least 3h and have at least 10 user messages.
  - It emits memory `.patch` files and `SKILL.md` drafts into a project-local inbox.
  - It "cannot directly edit active memory files, settings, credentials, or project GEMINI.md files".
  - `/memory inbox` applies or rejects patches and promotes skills to `~/.gemini/skills/` or `.gemini/skills/`.
  - It "defaults to creating no artifacts unless the evidence is strong".
  - It runs on a preview Flash model, and transcript excerpts may be sent to the model.
  - [geminicli.com: Auto Memory](https://geminicli.com/docs/cli/auto-memory/)
- **Known problems.** "Project-specific context is incorrectly saved to global user memory" — [issue #6371](https://github.com/google-gemini/gemini-cli/issues/6371). A user asks how to disable memory — [discussion #24698](https://github.com/google-gemini/gemini-cli/discussions/24698).
- **Product banner** (not independently confirmed): "Unpaid tier and Google One users: Gemini CLI was replaced by Antigravity CLI on June 18th, 2026". — [geminicli.com](https://geminicli.com/docs/tools/memory/)

#### OpenCode
- **Files read.** Project `AGENTS.md` (walking up from the current directory) and global `~/.config/opencode/AGENTS.md`.
- **Claude Code fallbacks.** It falls back to `CLAUDE.md` and `~/.claude/CLAUDE.md`, and reads `~/.claude/skills/`. `OPENCODE_DISABLE_CLAUDE_CODE=1` and finer flags turn these off. "The first matching file wins in each category."
- **`instructions` setting.** Accepts paths, globs (e.g. `.cursor/rules/*.md`) and remote URLs (5 s timeout).
- **`/init`.** Creates `AGENTS.md`, or improves an existing one.
- **Memory.** No built-in memory is documented.
- Source for all of the above: [OpenCode Docs: Rules](https://opencode.ai/docs/rules/)

#### Amp
- **Threads are cross-client and shareable.** One thread URL opens in the web app, CLI and iOS/macOS apps.
  - Visibility levels: Private (workspace admins can also see it), Workspace, Group (Enterprise only), Unlisted ("Anyone on the internet who has the link").
  - In a workspace, threads in workspace-owned projects are shared with the workspace by default.
  - `@T-…` or a pasted thread URL makes the agent read that thread. The agent's search covers "your workspace members' shared threads".
  - "Handoff" starts a fresh thread with the context that matters.
  - Archived threads remain referenceable.
  - No memory feature is mentioned.
  - [Amp Docs: Threads](https://ampcode.com/docs/threads)
- **Thread tools** (search snippets of Amp news): `find_thread` is the sibling of `read_thread`. The `read_thread` subagent "checks whether later work revised or reverted what it found". — [Amp news: Find Threads](https://ampcode.com/news/find-threads), [Amp news: Read Bigger Threads](https://ampcode.com/news/read-bigger-threads)
- **AGENTS.md lookup** (secondary, a Verdent guide verified against the manual on 2026-08-25): the working directory, parents up to $HOME, subtrees the agent reads, and `/etc/ampcode/AGENTS.md`; frontmatter globs. — [Verdent: Amp guide](https://www.verdent.ai/guides/agents/amp-coding-agent)
- Amp supports Agent Skills — [agentskills.io](https://agentskills.io/)

#### Cline
- **Memory Bank is a prompting method, not a feature.** Cline docs call it "a documentation methodology".
  - Custom instructions (in `.clinerules/memory-bank.md` or global custom instructions) force Cline to read `memory-bank/projectbrief.md`, `productContext.md`, `activeContext.md`, `systemPatterns.md`, `techContext.md` and `progress.md`: "I MUST read ALL memory bank files at the start of EVERY task".
  - Trigger phrases: "initialize memory bank", "update memory bank", "follow your custom instructions".
  - [Cline Docs: Memory Bank](https://docs.cline.bot/prompting/cline-memory-bank)
- **Rule files** (secondary): Cline reads `.clinerules/`, `AGENTS.md`, `.cursorrules` and `.windsurfrules`, with per-file toggles in a Rules panel; it reportedly does not read `CLAUDE.md`. — [thepromptshelf guide](https://thepromptshelf.dev/blog/cline-agents-md-clinerules-integration-guide-2026/), [MemoryLake](https://www.memorylake.ai/es/blogs/migrate-claude-code-to-cline)

#### Roo Code
- **Rules.** `.roo/rules/`, `.roo/rules-{modeSlug}/`, global `~/.roo/rules/`, fallback `.roorules`, legacy `.clinerules`. It loads `AGENTS.md` (or `AGENT.md`) by default; `roo-cline.useAgentRules: false` disables that. No memory feature. — [Roo Code Docs](https://roocodeinc.github.io/Roo-Code/features/custom-instructions)
- **Shut down.** "The Roo Code Extension was shut down on May 15th." The repo was archived 2026-05-15 and points users to ZooCode (a community fork) and Cline. — [GitHub: RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code)

#### Kiro (AWS)
- **Steering files.**
  - Locations: `.kiro/steering/` (workspace) and `~/.kiro/steering/` (global; IDE and CLI only). Workspace wins on conflict.
  - Foundation files: `product.md`, `tech.md`, `structure.md`.
  - Inclusion modes: `always` (default), `fileMatch`, `manual`, `auto`.
  - `AGENTS.md` is always included.
  - Teams can push global steering files through MDM or Group Policy. Kiro Web uses Configuration Sync for personal steering.
  - On Web, PR comments from the task creator teach patterns that apply "across your repositories".
  - [Kiro Docs: Steering](https://kiro.dev/docs/steering/)
- **Memory**, launched in Kiro CLI 2.29.0 ("Memory Across Chat Sessions", 2026-10-09) for local V3 sessions — [Kiro changelog CLI 2.29](https://kiro.dev/changelog/cli/2-29/).
  - Each memory is a record with title, description, content, type and scope (e.g. `repo:github/<owner>/<repository>`).
  - It stores "repository commands and conventions, corrections, debugging insights, approaches already ruled out, and how you prefer to work".
  - With "Automatic memory updates", Kiro creates and refines memories, including after a session ends.
  - In a later session it retrieves a matching memory, and the chat shows a Memory entry.
  - `/memories` lists memories read-only; edits and deletions are requested in chat.
  - Access levels: read & write / read only / off.
  - No writes in an untrusted workspace.
  - The page does not say where memories are stored or whether they sync.
  - [Kiro Docs: Memory](https://kiro.dev/docs/memory/)

#### Aider
- **Conventions file.** Conventions go in a Markdown file loaded with `/read` or `--read` ("marked as read-only, and cached if prompt caching is enabled"), or always via `read:` in `.aider.conf.yml`. No automatic memory is documented. — [Aider Docs: conventions](https://aider.chat/docs/usage/conventions.html)
- **AGENTS.md.** Aider is listed as an AGENTS.md supporter. — [agents.md](https://agents.md/)

#### Factory (Droid)
- **Current docs** (domain now docs.factory.com).
  - `AGENTS.md` holds "durable project instructions, commands, and guardrails", loaded "at startup and during dynamic discovery".
  - Personal instructions live in `~/.factory/`, `~/.agents/` and `~/.agent/`.
  - Skills load in full only when invoked.
  - No built-in memory is described.
  - [Factory Docs: memory management](https://docs.factory.com/guides/power-user/memory-management)
- **Older pages, now redirected or 404** (secondary, from search snippets; conflicting).
  - One guide said "Droid doesn't have built-in memory between sessions" and suggested `.factory/memories.md` / `~/.factory/memories.md` referenced from AGENTS.md plus hooks.
  - Another page described automatic User Memory (private) and Organization Memory (visible to the whole org, editable only by Org Admins), loaded into each chat with secrets filtered out.
  - [old memory-management URL](https://docs.factory.ai/guides/power-user/memory-management), [old user-guides/memory URL, now 404](https://docs.factory.ai/user-guides/memory)

#### Devin (Cognition)
- **Knowledge is deprecated.** "Knowledge is deprecated and will be removed." Existing items migrate automatically to Skills in Plugins, one `knowledge` plugin per scope (organization, enterprise, personal), with content unchanged and folders preserved. — [Devin Docs: Knowledge](https://docs.devin.ai/product-guides/knowledge)
- **Migration dates.** 2026-09-18: "Knowledge is being migrated to Skills"; migrated orgs see Knowledge read-only. 2026-07-17: Skills applied "consistently across Devin Cloud, Devin CLI, and Devin Desktop". 2026-09-30: in the Context tab, "memory opens from a single row". — [Devin release notes](https://docs.devin.ai/release-notes/overview)
- **How Knowledge worked.**
  - Each item has a Trigger Description and Content, plus an optional `!macro`.
  - Scopes: organization (default) and enterprise. Repo pinning: none, a specific repo, or all repos.
  - Devin suggests items from chat feedback, and can suggest updates.
  - "Devin retrieves Knowledge when relevant, not all at once or all at the beginning."
  - Users can enable or disable items for themselves.
  - [Devin Docs: Knowledge](https://docs.devin.ai/product-guides/knowledge)

#### JetBrains Junie
- **Lookup order** (Junie CLI): `.junie/AGENTS.md`; else root `AGENTS.md` combined with `.junie/playbook.md` and `.junie/rules/*.md`; else the legacy `.junie/guidelines.md` or `.junie/guidelines/`.
- **Global file.** `~/.junie/AGENTS.md`. Project wins on conflict, and identical content is deduplicated.
- **Imports.** On first open, Junie offers to import other agents' guideline or memory files into `.junie/AGENTS.md`.
- **Memory.** No automatic memory is documented.
- Source: [Junie Docs: Guidelines and memory](https://junie.jetbrains.com/docs/guidelines-and-memory.html)
- **Older IDE docs disagree:** they default to `.junie/guidelines.md` with a configurable path, which looks version-dependent. — [JetBrains help mirror](https://www.jetbrains.com.cn/help/junie/customize-guidelines.html)

#### Augment Code
- **Agent memories.** Agent's default context includes "current workspace, current file, and Agent memories" (search snippet of the official page). — [Augment Docs: Using Agent](https://docs.augmentcode.com/using-augment/agent)
- **History** (secondary, search snippet): Memories launched with Augment Agent in April 2025, "update automatically" and persist across conversations. — [Augment blog: Meet Augment Agent](https://www.augmentcode.com/blog/meet-augment-agent)
- **IDE rules and guidelines.**
  - `~/.augment/user-guidelines.md` is IDE-local: "Guidelines defined in VSCode will not propagate to JetBrains IDEs".
  - Rules live in `~/.augment/rules/` and `<workspace>/.augment/rules/` (Always / Manual / Auto), plus a `.augment-guidelines` file.
  - `AGENTS.md` and `CLAUDE.md` are discovered hierarchically.
  - Limits: 24,576 chars for user guidelines; 49,512 chars for workspace guidelines plus rules.
  - [Augment Docs: Rules & Guidelines](https://docs.augmentcode.com/setup-augment/guidelines.md)
- **Auggie CLI rule order** (search snippet): a flag-passed file, then `CLAUDE.md`, `AGENTS.md`, `.augment/guidelines.md` (legacy), then `.augment/rules/`. — [Augment Docs: CLI rules](https://docs.augmentcode.com/cli/rules)
- **Cosmos Experts memory.**
  - "Memory lets an Expert retain useful context across sessions."
  - Stored as readable Markdown "in the shared virtual filesystem (VFS)".
  - "Memory can be shared with an organization or kept within a user's VFS, depending on the Expert's visibility."
  - Scopes: global, channel, project, user, repo.
  - "Simple" memory records explicit human feedback. "Noisy" memory keeps an evidence log and promotes a learning only after enough evidence accumulates.
  - The Expert flags conflicts with current evidence.
  - [Augment Docs: Cosmos Expert memory](https://docs.augmentcode.com/cosmos/experts-memory.md)

#### Hermes Agent (Nous Research)
- See Q4 for the full loop. **Launch date is disputed:** 2026-02-25 per one blog — [heyuan110](https://www.heyuan110.com/posts/ai/2026-04-14-hermes-agent-guide) — versus first public tag v0.2.0 on 2026-03-12 per a timeline built from GitHub releases — [hermesagents.net](https://hermesagents.net/evolution).

#### OpenClaw (formerly Clawdbot / Moltbot)
- See Q4 for the full loop.

### Inferences
- Only GitHub Copilot, Devin, Cursor Projects, Augment Cosmos, Amp (threads) and possibly Kiro make learned context follow the account or repo across machines and teammates. Every IDE- or CLI-local memory (Windsurf/Cascade, Gemini CLI, VS Code tool, Hermes, OpenClaw) is per machine.
- Vendors with local auto-memory consistently tell users to promote durable knowledge into git-tracked rules or AGENTS.md (Windsurf docs and VS Code docs say so explicitly). That has become the de facto way to share with a team.
- Two vendors have dropped a first-generation auto-memory: Cursor in 2.1, and Windsurf → Devin Desktop, whose new default agent does not persist memories. Both replaced it with explicit or file-based mechanisms (rules, Projects context, Skills).

### Gaps
- Kiro Memory: storage location (local vs AWS account) and sync are undocumented.
- Augment IDE "Agent memories": storage location, editing and sync are not in current docs.
- Factory: could not confirm whether User and Organization Memory still exists; the page now returns 404.
- Cursor: no official reason for removing Memories was found; the Automations memory-files claim is unverified.
- Copilot Memory in the IDE: only secondary sources cover the JetBrains integration.

## Q2. Converged conventions: AGENTS.md, rules files, skills (SKILL.md) — who reads what

### Takeaway
AGENTS.md is now the cross-vendor instruction file. It is stewarded by the Agentic AI Foundation under the Linux Foundation and used in 60k+ repos. Agent Skills (`SKILL.md`, originally from Anthropic, now an open standard) is the cross-vendor format for procedures. Almost every agent in scope reads both, while keeping its own rules directory for legacy and glob-scoped rules. Learned memory is increasingly written into these shared formats: Devin Knowledge → Skills, Gemini Auto Memory → `SKILL.md`, Hermes self-written skills.

### Cited Findings
- **AGENTS.md.**
  - "A simple, open format for guiding coding agents".
  - "stewarded by the Agentic AI Foundation under the Linux Foundation".
  - "used by over 60k open-source projects".
  - "The closest AGENTS.md to the edited file wins".
  - Listed supporters: Codex, Jules, Factory, Aider, goose, opencode, Zed, Warp, VS Code, Devin, Junie, Amp, Cursor, RooCode, Gemini CLI, Kilo Code, GitHub Copilot coding agent, Ona, Windsurf, Augment Code.
  - [agents.md](https://agents.md/)
- **Agent Skills.**
  - "originally developed by Anthropic, released as an open standard".
  - A skill is a folder with `SKILL.md` (at minimum a name and description) plus optional scripts, references and assets.
  - Loaded by progressive disclosure: discovery, then activation, then execution.
  - Listed clients include Junie, Gemini CLI, OpenCode, Cursor, Amp, GitHub Copilot, VS Code, Claude Code, Codex, Factory, Roo Code, Kiro, Hermes Agent, OpenClaw, Goose, Letta, OpenHands, Tabnine and others.
  - [agentskills.io](https://agentskills.io/)
- **Which files each agent reads.**

  | Agent | Files read | Source |
  |---|---|---|
  | GitHub Copilot | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, skills | [GitHub Docs](https://docs.github.com/en/copilot/concepts/prompting/response-customization) |
  | Cursor | `.cursor/rules/*.mdc`, `~/.cursor/rules`, nested `AGENTS.md` | [Cursor Docs](https://cursor.com/docs/context/rules), [Cursor 2.1](https://cursor.com/changelog/2-1) |
  | Windsurf / Devin Desktop | `.devin/rules`, `.windsurf/rules`, `.windsurfrules`, nested `AGENTS.md` | [Devin Docs](https://docs.devin.ai/desktop/cascade/memories) |
  | Gemini CLI | `GEMINI.md` by default; `AGENTS.md` only via `context.fileName` | [Gemini CLI docs](https://geminicli.com/docs/cli/gemini-md/) |
  | OpenCode | `AGENTS.md`, falling back to `CLAUDE.md`; `~/.claude/skills` | [OpenCode Docs](https://opencode.ai/docs/rules/) |
  | Roo Code | `.roo/rules`, `.roorules`, `.clinerules`, `AGENTS.md` | [Roo Docs](https://roocodeinc.github.io/Roo-Code/features/custom-instructions) |
  | Kiro | `.kiro/steering`, `AGENTS.md` | [Kiro Docs](https://kiro.dev/docs/steering/) |
  | Junie | `.junie/AGENTS.md`, `AGENTS.md`, `.junie/guidelines.md` | [Junie Docs](https://junie.jetbrains.com/docs/guidelines-and-memory.html) |
  | Augment | `.augment/rules`, `.augment-guidelines`, `AGENTS.md`, `CLAUDE.md` | [Augment Docs](https://docs.augmentcode.com/setup-augment/guidelines.md) |
  | Factory | `AGENTS.md`, `~/.factory/`, `~/.agents/` | [Factory Docs](https://docs.factory.com/guides/power-user/memory-management) |
  | Cline (secondary) | `.clinerules/`, `AGENTS.md`, `.cursorrules`, `.windsurfrules` | [thepromptshelf](https://thepromptshelf.dev/blog/cline-agents-md-clinerules-integration-guide-2026/) |
  | Aider | Explicit `--read` files only | [Aider Docs](https://aider.chat/docs/usage/conventions.html) |
  | OpenClaw | Workspace `AGENTS.md` + `SOUL.md` + `USER.md` + `MEMORY.md` | [OpenClaw workspace docs](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-workspace.md) |
- **Learned knowledge moving into skills.**
  - Devin Knowledge → Skills in plugins. — [Devin Docs](https://docs.devin.ai/product-guides/knowledge)
  - Gemini CLI Auto Memory drafts `SKILL.md` files. — [Gemini CLI Auto Memory](https://geminicli.com/docs/cli/auto-memory/)
  - Hermes treats skills as "procedural memory". — [Hermes Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- **Agents that import other agents' files.** OpenCode reads Claude Code's `CLAUDE.md` and skills — [OpenCode Docs](https://opencode.ai/docs/rules/). Junie offers to import other agents' memory files — [Junie Docs](https://junie.jetbrains.com/docs/guidelines-and-memory.html). Augment auto-imports Markdown rule files — [Augment Docs](https://docs.augmentcode.com/setup-augment/guidelines.md).

### Inferences
- A stable split has formed across vendors: short facts that are always loaded (AGENTS.md, MEMORY.md, rules) versus procedures loaded on demand (SKILL.md). Auto-learning systems are converging on emitting one of these two portable formats rather than keeping a private store. Devin and Gemini CLI do this explicitly.
- Gemini CLI remains the notable holdout that does not read AGENTS.md by default.

### Gaps
- Whether Amp and Aider read `CLAUDE.md` as a fallback was not checked.
- Cline's rule list rests on secondary sources.

## Q3. How agents validate memories (citations, expiry, review)

### Takeaway
GitHub Copilot is the only vendor with documented just-in-time validation: citations are re-checked against the current branch before use, a contradicted memory is rewritten, and unused entries expire after 28 days. Everyone else relies on one or more of:
- human review gates (Gemini inbox, Hermes and Kiro approval or access levels, Devin suggestion approval);
- hard capacity limits that force consolidation (Hermes);
- evidence thresholds (Augment "noisy" memory);
- lifecycle curation (Hermes curator);
- nothing at all (most file-based systems).

Memory poisoning through prompt injection is a demonstrated risk for auto-writing memories (Windsurf, OpenClaw).

### Cited Findings
- **Copilot.**
  - Repo facts are "checked against their code citations on the current branch" before use.
  - Facts from unmerged PRs are used only if the current code supports them.
  - The 28-day expiry resets on use.
  - Preferences are only "judged for whether they still apply".
  - [GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- **Copilot design rationale and results** — [GitHub Blog](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/):
  - "Information retrieval is an asymmetrical problem: It's hard to solve, but easy to verify."
  - Contradicted memories are re-stored corrected; validated ones are re-stored to refresh their timestamp.
  - An offline curation service was rejected as too complex and costly.
  - Adversarial tests seeded false memories, and the pool "self-healed".
  - A/B tests: coding-agent PR merge rate rose from 83% to 90%; positive feedback on code review rose from 75% to 77% (p < 0.00001). Code review offline evaluation: precision +3%, recall +4%.
- **Gemini CLI Auto Memory.** Patches are never applied without approval. Extraction "defaults to creating no artifacts unless the evidence is strong". It cannot touch project `GEMINI.md`. — [Gemini CLI Auto Memory](https://geminicli.com/docs/cli/auto-memory/)
- **Hermes memory.** Hard character limits force consolidation; duplicates are rejected; a security scan blocks invisible Unicode and injection or exfiltration patterns; write approval is optional. — [Hermes Docs: Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- **Hermes curator.** Skills move from stale (14 days unused) to archived (30 days). LLM consolidation is off by default. It never auto-deletes. Snapshot and rollback, pinning and dry run are available. — [Hermes Docs: Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator)
- **Augment Cosmos.** Noisy memory promotes a learning "only after enough evidence accumulates"; the Expert flags conflicts with current evidence. — [Augment Cosmos memory](https://docs.augmentcode.com/cosmos/experts-memory.md)
- **Kiro.** No memory writes in untrusted workspaces; read-only and off modes; memory use is shown in the chat. — [Kiro Memory](https://kiro.dev/docs/memory/)
- **Devin.** Knowledge suggestions are edited or dismissed by humans before saving. — [Devin Knowledge](https://docs.devin.ai/product-guides/knowledge)
- **Amp.** The `read_thread` subagent checks "whether later work revised or reverted what it found" (search snippet). — [Amp news: Find Threads](https://ampcode.com/news/find-threads)
- **Memory poisoning, OpenClaw.**
  - An injected `MEMORY.md` rule kept changing behavior in later sessions. — [arXiv 2603.11619: Taming OpenClaw](https://arxiv.org/pdf/2603.11619)
  - A CSA note says attacks persist across restarts and "resist simple file-revert remediation" because vector indexes keep residue. — [CSA research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-openclaw-indirect-prompt-injection/)
  - A lab test showed durable memories shifting the agent's trust hierarchy until it ran a reverse shell. — [Lakera](https://www.lakera.ai/blog/memory-poisoning-instruction-drift-from-discord-chat-to-reverse-shell)
- **Memory poisoning, Windsurf Cascade** (secondary): the `create_memory` tool could be driven by indirect prompt injection. — [SecurityLab.ru](https://www.securitylab.ru/news/562793.php)

### Inferences
- Citation checking works because Copilot's memories are about code. Preference-type memories ("how I like work done"), which Cursor Projects, Kiro, Hermes and OpenClaw all store, cannot be verified against code. Those systems fall back on human review or nothing.
- Write approval and "untrusted workspace = read-only" (Hermes, Kiro, Gemini inbox) are the main defenses against poisoning. Systems that write memory automatically with no review (Cascade, OpenClaw by default) are the ones with published poisoning demos.

### Gaps
- No vendor except GitHub publishes measurements of stale or incorrect memory.
- No confirmed in-the-wild memory-poisoning incidents were found.

## Q4. Hermes Agent and OpenClaw memory loops

### Takeaway
**Hermes** keeps a tiny, capped, always-injected profile: `MEMORY.md` plus `USER.md`, frozen for the whole session to protect the prompt cache. Everything else is retrieved on demand: FTS5 search over raw past sessions, and self-written agentskills.io skills as "procedural memory". A background review after turns writes memory and skills, and a weekly curator ages and consolidates skills.

**OpenClaw** treats a Markdown workspace as the agent's whole memory ("no hidden state"). Bootstrap files (`AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`) are injected at session start. Daily `memory/YYYY-MM-DD.md` logs are retrieved by hybrid vector + keyword `memory_search`. A silent pre-compaction flush and an optional "dreaming" pass consolidate, and `MEMORY.md` is kept out of group chats.

### Cited Findings

**Hermes Agent**
- **Storage.**
  - Memory lives in `~/.hermes/memories/`, or per profile in `~/.hermes/profiles/<name>/memories/`.
  - `MEMORY.md` holds agent notes, capped at 2,200 chars (~800 tokens). `USER.md` holds the user profile, capped at 1,375 chars (~500 tokens).
  - No auto-compaction: a write over the limit errors, and the agent must consolidate.
  - [Hermes Docs: Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- **Recall.**
  - Memory is "injected into the system prompt as a frozen snapshot at session start".
  - Mid-session writes are saved to disk but appear only in the next session (to preserve the prefix cache).
  - The `memory` tool supports add, replace and remove via unique substring match, and has no read action.
  - [Hermes Docs: Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- **Session search.** SQLite FTS5 in `~/.hermes/state.db` over CLI and messaging sessions. Results are raw messages with "no LLM summarization, no truncation", and the agent can scroll within a session. — [Hermes Docs: Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- **Background review and controls.**
  - After a turn, a background "self-improvement review" can save memories or update skills. It can run on a cheaper model, be deferred to idle time, or be disabled.
  - `memory.write_approval` stages writes, handled with `/memory pending|approve|reject`.
  - `/journey` lists, edits and deletes learned skills and memories.
  - Docs recommend `/new` at task boundaries.
  - Security scanning runs on every write.
  - External providers run alongside built-in memory: bundled Holographic, RetainDB and ByteRover; plugins for Honcho, Hindsight, Supermemory, Mem0 and OpenViking.
  - [Hermes Docs: Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- **Skills as procedural memory.**
  - Stored in `~/.hermes/skills/` as agentskills.io `SKILL.md`, loaded by progressive disclosure (`skills_list` → `skill_view`).
  - The `skill_manage` tool supports create, patch, rewrite, delete, write_file and remove_file.
  - The system prompt asks the agent to save "a non-trivial workflow". Triggers include errors that were resolved and user corrections.
  - Skills should hold "lessons, not logs".
  - `skills.write_approval` stages writes in `~/.hermes/pending/skills/`.
  - A Skills Hub (skills.sh, ClawHub, etc.) runs a security scanner.
  - [Hermes Docs: Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- **Curator.**
  - Runs at most every 7 days, after at least 2 idle hours.
  - Skills unused for 14 days become stale; after 30 days they are archived.
  - Optional LLM consolidation into "umbrella" skills (off by default), with tar.gz snapshot and rollback.
  - Never auto-deletes. Skips pinned, cron-referenced, hub-installed and hand-written skills.
  - Memory is maintained by the background review, not the curator.
  - [Hermes Docs: Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator)

**OpenClaw**
- **Workspace files.**
  - The default workspace is `~/.openclaw/workspace`: "Keep it private and treat it as memory."
  - Loaded every session: `AGENTS.md` (operating instructions and memory usage), `SOUL.md` (persona) and `USER.md` (4,000-char cap).
  - Also present: `IDENTITY.md`, `TOOLS.md`, an optional `BOOT.md`, a one-time `BOOTSTRAP.md`, `memory/YYYY-MM-DD.md` and `MEMORY.md`.
  - Caps: 20,000 chars per file and 60,000 chars total for bootstrap injection.
  - `MEMORY.md` loads only in "the main, private session, not shared/group contexts".
  - Docs recommend backing the workspace up to a private git repo, with no secrets in it.
  - Transcripts live in `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`.
  - [OpenClaw docs: agent workspace (GitHub)](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-workspace.md)
- **Memory files and tools.**
  - "The model only remembers what gets saved to disk; there is no hidden state."
  - `MEMORY.md` holds curated long-term facts and decisions; it is truncated in the prompt if over budget.
  - Daily notes are "not injected into the bootstrap prompt on every turn"; today's and yesterday's load on a bare `/new` or `/reset`.
  - `memory_search` is hybrid, "vector similarity ... combined with keyword matching", on a builtin SQLite engine. The default embedding provider is OpenAI; alternatives include Gemini, Voyage, Mistral, Bedrock, local GGUF, Ollama and LM Studio.
  - Other tools: `memory_get`, `intent`, and transcript tools `sessions_search` / `sessions_history`.
  - [OpenClaw Docs: Memory](https://docs.openclaw.ai/concepts/memory)
- **Consolidation.**
  - Before compaction, a silent "memory flush" turn asks the agent to save important context. It is on by default and uses a private copy of the conversation; disable with `agents.defaults.compaction.memoryFlush.enabled: false`.
  - "Dreaming" is on by default and writes `DREAMS.md` summaries for human review.
  - [OpenClaw Docs: Memory](https://docs.openclaw.ai/concepts/memory)
- **Known problem: MEMORY.md poisoning** via prompt injection was demonstrated; see Q3. — [arXiv 2603.11619](https://arxiv.org/pdf/2603.11619), [CSA](https://labs.cloudsecurityalliance.org/research/csa-research-note-openclaw-indirect-prompt-injection/)

### Inferences
- Both designs keep the always-loaded part tiny and human-readable, and make files the source of truth. Retrieval (FTS5 or hybrid vector search) covers the long tail.
- Hermes favors prefix-cache stability (frozen snapshot) and keyword search without LLM calls. OpenClaw favors richer semantic retrieval at the cost of an embedding dependency and a vector index that can retain poisoned content.
- Hermes is the clearest public example of a "self-improving skills" loop with lifecycle management (stale → archive) and rollback.

### Gaps
- No published effectiveness data was found for either loop.
- Hermes's launch date is disputed (February vs March 2026).
- The OpenClaw rename history (Clawdbot → Moltbot → OpenClaw) was not re-verified in this pass.

## Q5. Memory features launched, changed or removed in 2025–2026

### Takeaway
2025–2026 brought a shake-out. First-generation auto-memories were removed or demoted (Cursor Memories removed in 2.1; Windsurf Cascade memories now legacy-only after the Devin Desktop rebrand; Devin Knowledge folded into Skills; Roo Code shut down). Cloud and team memory with validation or review grew (Copilot Memory with citations and expiry; Cursor Projects shared context; Kiro Memory; Augment Cosmos). CLI agents moved to file-based tiers plus review inboxes (Gemini CLI four-tier memory and Auto Memory). AGENTS.md and Agent Skills became the shared substrate.

### Cited Findings (chronological)
- **2025-04**: Augment Agent launches with automatically updated Memories (secondary snippet). — [Augment blog](https://www.augmentcode.com/blog/meet-augment-agent)
- **2025-05-30**: Windsurf Cascade memory-persistence prompt-injection issue reported (secondary). — [SecurityLab.ru](https://www.securitylab.ru/news/562793.php)
- **2025-06**: Cursor 1.0 ships Memories (beta). — [Cursor 1.0](https://cursor.com/changelog/1-0)
- **2025-07-14**: Cognition agrees to acquire Windsurf (secondary). — [businesstechnavigator](https://businesstechnavigator.com/news/windsurf-devin-desktop-cascade-eol-2026)
- **2025-10-06**: Gemini CLI v0.9.0 adds `/memory list`. — [Gemini CLI release notes](https://geminicli.com/docs/changelogs/)
- **2025-11-21**: Cursor 2.1 removes Custom Modes and adds `~/.cursor/rules`; users report Memories gone. No official reason found. — [Cursor 2.1](https://cursor.com/changelog/2-1), [forum](https://forum.cursor.com/t/custom-modes-and-memories-gone-in-2-1/143744)
- **2025-12-19**: Copilot Memory public preview for Pro and Pro+. — [GitHub Changelog](https://github.blog/changelog/2025-12-19-copilot-memory-early-access-for-pro-and-pro)
- **2026-01**: Gemini CLI enables Agent Skills by default (v0.25/0.26). — [Gemini CLI release notes](https://geminicli.com/docs/changelogs/)
- **2026-01-15**: Copilot Memory reaches all paid plans, with 28-day expiry; the engineering blog post on design and validation is published. — [GitHub Changelog](https://github.blog/changelog/2026-01-15-agentic-memory-for-github-copilot-is-in-public-preview/), [GitHub Blog](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)
- **2026-02/03**: Hermes Agent public launch (disputed date). — [hermesagents.net](https://hermesagents.net/evolution)
- **2026-03-04**: Copilot Memory on by default for Pro and Pro+. — [GitHub Changelog](https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/)
- **2026-04-28**: Gemini CLI v0.40.0 moves to "prompt-driven, four-tier memory"; `save_memory` disappears from the docs. — [Gemini CLI release notes](https://geminicli.com/docs/changelogs/)
- **2026-05-12**: Gemini CLI v0.42.0 adds the Auto Memory inbox. — [Gemini CLI release notes](https://geminicli.com/docs/changelogs/)
- **2026-05-15**: Roo Code extension shut down and its repo archived. — [GitHub: Roo-Code](https://github.com/RooCodeInc/Roo-Code)
- **2026-05-26**: Copilot Memory adds per-repo off switch, deletion scope and CLI `/memory`. — [GitHub Changelog](https://github.blog/changelog/2026-05-26-copilot-memory-has-more-controls-for-deletion-scope-and-the-copilot-cli/)
- **2026-06-02**: Windsurf renamed Devin Desktop (secondary). The claimed Cascade sunset on 2026-07-01 conflicts with the official 2026-08-07 note that legacy Cascade merely "defaults to disabled for enterprise tiers". — [noqta](https://noqta.tn/en/blog/devin-desktop-windsurf-ai-agent-fleet-management-2026); [Devin release notes](https://docs.devin.ai/release-notes/overview)
- **2026-06-18**: Gemini CLI is replaced by Antigravity CLI for unpaid and Google One users (docs banner). — [geminicli.com](https://geminicli.com/docs/tools/memory/)
- **2026-09-10**: Cursor Projects (beta) with synced shared-context files. — [Cursor blog](https://cursor.com/blog/projects)
- **2026-09-18**: Devin Knowledge begins migrating to Skills; Knowledge deprecated. — [Devin release notes](https://docs.devin.ai/release-notes/overview), [Devin Knowledge](https://docs.devin.ai/product-guides/knowledge)
- **2026-10-09**: Kiro CLI 2.29.0 adds "Memory Across Chat Sessions". — [Kiro changelog](https://kiro.dev/changelog/cli/2-29/)

### Inferences
- **Why removals happened** (speculative; no vendor stated reasons):
  - Opaque, locally stored auto-memories were hard to inspect, share or keep correct. Cursor forum threads show users unable to see or clear memories.
  - Vendors are steering durable knowledge toward reviewable, shareable artifacts: rules, AGENTS.md, skills, and project files synced through the vendor cloud.
- **Pattern in the new launches.** Every 2026 launch adds an explicit control surface (expiry and citations, an inbox, access levels, approval queues). Unreviewed automatic memory is no longer shipped as a default without controls.

### Gaps
- Cursor's rationale for removing Memories and Cognition's rationale for not persisting memories in Devin Local are undocumented.
- Exact launch dates for VS Code's local memory tool and for Augment Cosmos memory were not found.

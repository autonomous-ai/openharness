# Sync distilled records, validate them before recall

> **Decision after this report (2026-10-09).** Every agent already learns; none of them shares. So Harness
> memory starts by aggregating, not by extracting: a raw layer that reads each agent's own memory folder
> and the session index Harness already keeps, then harnesses that run over it. The first is
> [Memories](../../../../store/agents/memories/) — a Store harness that browses every agent's memories
> beside your activity, with an About You the agent builds from your own words on request. Delivery into
> every agent, more harnesses over the same data, and sync of the About You profile come next.

Date: 2026-10-09. Status: research and design. Nothing here is built or scheduled.

The earlier proposal points the right way, but it is not yet the best design. Keep its core: agents' own memories are read-only sources, one evidence-backed record model sits above all agents, machines sync records (not transcripts) end to end encrypted, forgetting is a tombstone every machine applies, and memory is an experimental service that costs nothing when off. Change four things. **Project identity**: keep opaque project IDs and link projects across computers through the normalized remote plus the repository's root commit, with confirmation, instead of making the remote the identity. **Delivery**: use a memory-owned hook command installed only while memory is on, and narrow "never write native memory files" to "never edit what an agent generated", so Harness can still use input channels the agents provide for this, such as Codex's memory extensions folder. **Validation**: check each record's code citations against the current checkout before recall, and let unused project facts expire. GitHub Copilot is the only coding agent that does this, and it reports a measured gain (pull-request merge rate up from 83% to 90%). **Sync format**: define it precisely: Atuin-style logs per device, hash chains, a key per record under an account key, and key rotation when a device is removed. Harness has no encrypted store for data at rest today, so this part is new work. Replace the git-repository fallback with local-only use plus export, because git history keeps forgotten text and the git host sees plaintext. The biggest risk is not sync. Harness has **zero completed real-model extractions** and no recall delivery in the current build. The smallest useful proof is a "remember this" said in Claude Code reaching the next Codex harness on the same computer. This is a design only: coding memory is out of scope until the engine refactor ships, and current work is focused on onboarding.

## Five parts stay; four details change

| # | Earlier proposal | Verdict | What changes | Why |
|---|---|---|---|---|
| 1 | Agents' own memories are sources, never the source of truth. Read Claude Code's memory folder, Codex memories, AGENTS.md and transcripts. Deliver through SessionStart/UserPromptSubmit hooks plus MCP. Never write native memory files. | **Keep, narrow one rule** | Never edit memory an agent generated: Claude Code's `MEMORY.md` and topic files, or Codex's `memory_summary.md` and `MEMORY.md`. Do write to channels designed for outside input: the Codex extensions folder (optional, late), and a Harness-owned instructions file for agents without prompt hooks. Imported native memories enter as tentative. Offer a `harness memory search` command next to MCP. | Hooks inject without depending on the agent deciding to fetch. MCP memory loses to Claude Code's built-in memory instructions ([#48465](https://github.com/anthropics/claude-code/issues/48465)). OpenAI's own features feed Codex memory through `extensions/` ([memory_import.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/external-agent-migration/src/memory_import.rs)). Native memory is model-written, and a malicious repository poisoned it in the Cisco case ([Cisco](https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code)). |
| 2 | One record model: preference, decision, pitfall, continuity, reference, each with evidence pointers. | **Keep, add fields** | Add code anchors (path, line range, blob hash, commit), the last validation result and the origin device. Every revision becomes one immutable log entry. Procedures become reviewed skills later, not a sixth kind now. | Copilot's citation check is the validated pattern ([GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)). Claude Code's four types and Codex's handbook sections map onto these five kinds. |
| 3 | Project identity from the normalized git remote, not the path. | **Change** | The opaque project ID stays canonical. A matching normalized remote plus a shared root commit proposes a link between projects on two computers. Ambiguous cases ask the person. The remote travels only inside encrypted records. | Forks, mirrors, repositories without a remote and rewritten history all break remote-as-identity. The [Naming System](../../../naming-system.md) says a Project belongs to one computer. `companions/src/memory/project.ts` states "remotes never establish memory ownership". |
| 4 | Sync records, not transcripts: an append-only E2EE log of distilled records and tombstones, immutable records with supersede links, transcripts fetched on demand. | **Keep, specify** | One series per device with a single writer, sequential index, hash chain and frozen authenticated header. Each record gets its own key, wrapped by an epoch key. The backend gets a new store for ciphertext at rest. Derived pages never sync. | Atuin ships this shape ([record/mod.rs](https://github.com/atuinsh/atuin/blob/main/crates/atuin-domain/src/record/mod.rs)). Desk sync is plaintext by design (`backend/prisma/schema.prisma`). |
| 5 | Forget or exclude becomes a tombstone every machine applies before recall, including derived pages. | **Keep, strengthen** | Shred the record key on the server. Tombstones carry a fingerprint so no machine relearns the fact from its own transcripts. Apply pending forgets before the first recall after reconnecting. Set a horizon after which a long-offline device wipes and re-pulls. Exclusions sync as policy records. | Atuin's delete record leaves the ciphertext on the server ([Atuin store](https://docs.atuin.sh/main/reference/store/)). Evolu calls enforced cross-device deletion "not trivial" ([Evolu](https://github.com/evoluhq/evolu/blob/main/apps/web/src/app/%28docs%29/docs/time-travel/page.mdx)). |
| 6 | Runs as an experimental service in harnessd; off = free. | **Keep** | Runs as its own on-demand process in the experimental host. When off: no process, no hook entries, no model calls. | `docs/design/2026-10-03-harnessd.md`, `cli/src/services/AGENTS.md` |
| F | Fallback: a private git repo of Markdown memory (Letta MemFS-style). | **Replace** | Fall back to local-only memory with JSON/Markdown export. Git can be an export target the person chooses, never the sync substrate. | Forgetting needs a history rewrite on every clone, the git host reads plaintext, and Letta documents no encryption, deletion or conflict handling for MemFS ([Letta MemFS](https://docs.letta.com/letta-code/memfs)). |

## The recommended design

### Where each piece lives

| Piece | Lives in | Status today |
|---|---|---|
| Record store, admission, recall, receipts, notebook | Memory service process (experimental host, on demand), reusing `companions/src/memory/` | Built with unit tests: about 5,500 lines plus 6,000 lines of tests. Warm recall p95 is 19.5 ms on 10,000 records (`docs/research/2026-09-30-memory-performance.json`). |
| Capture | The memory service subscribes to core turn events and reads transcripts from paths in core's session registry, the way `cli/src/services/search.ts` does | `companions/src/memory/capture.ts` exists. The scoped `transcript_read` request is designed but not built. |
| Extraction and consolidation | The memory service, using one-shot runs of the person's own Claude Code or Codex. Never an API key or a fallback provider. | Adapters exist but are certified only for Claude Code 2.1.285–2.1.287 and Codex 0.159.0. The current releases are 2.1.296 and 0.162.1, so they need recertification. |
| Recall delivery | A memory-owned hook command. Core's installer writes its declared block while memory is on and removes it when memory is off. | Removed in #684. `cli/src/coreIsolation.spec.ts` forbids context in core's `cli/hook/notify.mjs`. |
| Sync engine and keys | Memory service. Epoch key in its data directory (0600) or the OS keychain. Sealed frames travel through the gateway. | New |
| Server log | Backend: a ciphertext log, key envelopes and a `memory_changed` push, following the Desk pattern (`backend/src/routes/desk.ts`). Offered as an optional relay capability, so self-hosted relays can omit it. | New |
| Viewer and settings | Desktop Memories viewer and **Settings → Experimental → Coding memory**. A read-only phone view comes later. | About 3,000 lines of Dart exist but are disconnected: core refuses `{'verb': 'memory'}`. |
| Core | No memory code. Two small additive contracts: the declared hook block, and one sealed frame type in `cli/src/lib/e2ee/applicationFrames.ts`. | Each needs a contract review (`docs/plans/2026-10-03-memory-companion-isolation.md`). |

The hook choice is a judgment call. Option A: core's existing hook relays a packet from the memory service through a recall port with a deadline and an empty fallback. That is one process per prompt, but it reverses #684 and puts core on the prompt path. Option B: a separate `harness memory hook` command, installed and removed with the service. It exits silently when the service is off or late. Core never waits, and the cost is a second hook process per prompt plus one more Codex trust record, which Harness already pre-records for its own hooks (#1127, `cli/src/engines/codex/hookContract.ts`). **Recommend B.**

### Records

The five kinds from `companions/src/memory/types.ts` stay. They already carry scope, evidence class, conflict key, validity and revisions. Each kind gets its own validation and expiry rule:

| Kind | Example | Check before recall | Expiry |
|---|---|---|---|
| `working_preference` | "Show me the plan before editing migrations" | Applicability conditions only; a preference cannot be checked against code | Never by age; changed only by correction or forget |
| `project_decision` | "One Postgres database; the team is small" | Cited file or AGENTS.md line still present | Becomes tentative when its anchor changes |
| `verified_pitfall` | "Parallel tests clash on port 5432; isolation fixed it" | Cited blob hash still matches | 28 days unused; validation resets the clock |
| `reference` | "Release decisions live in issue tracker X" | Locator still resolves | On change |
| `working_continuity` | "Waiting on the USB device; firmware not written" | Branch or task still open | Closes on completion, or after 14 days |

New fields: `codeAnchors[] {path, startLine, endLine, blobHash, commit}`, `origin {deviceId, series, idx}` and `lastValidated {at, result}`. Admission stays as built (`companions/src/memory/admission.ts`). Preferences and decisions need user-role evidence. Technical findings need tool evidence. Anything inferred or imported stays tentative and is never delivered as guidance.

### Capture and consolidation

| Path | Trust | How |
|---|---|---|
| Explicit "remember this" | Highest; no model call | The agent runs `harness memory remember "<text>"`. The service checks the text against the latest user turn in the transcript, then stores it as `user_stated`. Codex uses the same rule: it writes memory "only when explicitly asked" ([read_path.md](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/ext/memories/templates/memories/read_path.md)). |
| Automatic extraction | Medium | Runs on completed, idle episodes, once, on the computer where the conversation happened. Uses the existing `coding-memory-v6` prompt with excerpt references. Budget: six calls per hour. Records are extracted once and synced, never re-extracted on each machine. |
| Native imports | Low | Reads `~/.claude/projects/<repo>/memory/` and `~/.codex/memories/` (and `memories_v2/`) as `imported` and tentative. Shown in the viewer, never injected until confirmed. |
| Consolidation | Medium | A periodic job merges duplicates and supersedes contradicted records by writing ordinary supersede entries. As with Anthropic's dreams, the output is new and the input is untouched ([Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)). Notebook pages are rebuilt locally and never synced. |

### Recall and delivery for each agent

| Agent | Session start | Each prompt | On demand | Rules |
|---|---|---|---|---|
| Claude Code | SessionStart hook for every source, including `compact`: a short orientation | UserPromptSubmit `additionalContext`: up to 6 items and about 1,000 tokens (the host cap is 10,000 characters) | `harness memory search`; MCP optional | Skip anything already loaded from CLAUDE.md, AGENTS.md or the native `MEMORY.md` index. Never write the auto memory folder or repoint `autoMemoryDirectory`. |
| Codex | SessionStart (`startup\|resume\|clear\|compact`) | UserPromptSubmit `additionalContext`, added as developer context (default limit about 2,500 tokens) | Same | Pre-record the memory hook's trust hash. MCP calls can mark a thread "polluted" for Codex's own memory if the person set `disable_on_external_context`. |
| OpenCode | Existing plugin (`companions/src/memory/adapters/opencodeRecallPlugin.ts`) | Plugin synthetic part | Same | Pinned to the certified version |
| Other engines | The DSH runtime bootstrap context (`cli/src/dsh/runtime.ts`) or a Harness-owned instructions file | None until a prompt hook is proven | Same | Certified one engine at a time |
| Repository AGENTS.md | Never written automatically | — | — | When a record has earned team status, Harness proposes a one-line diff for the person to accept |

Delivered packets are wrapped as fallible historical data that grants no permissions. A missed recall injects nothing. Codex adds hook output at developer priority, so its packet must stay small and clearly labeled.

### Validation before use

This follows Copilot's method. Copilot checks repository facts "against their code citations on the current branch" before use, and unused entries expire after 28 days, with each validation resetting the clock ([GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)). In Harness, each candidate with code anchors gets one of three outcomes:

1. **Anchor unchanged**: deliver it.
2. **Anchor changed**: deliver it only as a "lead to verify", and queue a background re-validation.
3. **File gone**: withhold it.

Hashing a handful of files takes milliseconds, which fits inside the hook deadline. Each computer validates against its own checkout, so a record that applies on one computer can be withheld on another computer that is on a different branch. That is the intended behavior.

GitHub explains the reasoning: retrieval is "hard to solve, but easy to verify". It reports that seeded false memories "self-healed", and that its A/B tests raised the coding agent's merge rate from 83% to 90% ([GitHub Blog](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)). These are vendor numbers, not independent results.

### Cross-machine sync

**Log entry.** The authenticated header is frozen from the start: `{id, deviceId, series, idx, prevHash, epoch, schemaVersion, hlc}`. The body is one of:

- `Create`
- `Supersede{old}`
- `Forget{ids, fingerprints}`
- `Policy{exclude/include}`
- `LinkProject{normalizedRemote, rootCommit}`
- `EvidenceAvailable{pointer, size}`

Each body is encrypted (XChaCha20-Poly1305) with a random per-record key. That key is wrapped by the current epoch key and stored separately, so it can be shredded.

Atuin uses this layout. Each host writes only its own series, sync compares a map of `(host, tag) → last idx` to find what is missing, and every record gets its own content key wrapped by the master key ([Atuin](https://github.com/atuinsh/atuin/blob/main/crates/atuin-domain/src/record/mod.rs), [encryption](https://github.com/atuinsh/atuin/blob/main/crates/atuin-common/src/encryption/paseto_v4.rs)). The hash chain adds what index counters alone miss: a cloned VM reusing a device ID, or a server hiding entries, shows up as mismatched heads ([Kleppmann](https://martin.kleppmann.com/papers/bft-crdt-papoc22.pdf)).

**Server.** The server only stores data. It answers:

- `status → {device → {series → (idx, head)}}`
- `upload`: the device's own series only, with contiguous idx and a device signature
- `download(after idx)`
- `deleteKeys(ids)`
- `compact(epoch snapshot)`

It also pushes `memory_changed`, like `desk_changed`. It sees sizes, timestamps and device IDs. Padding hides exact sizes.

**Keys and devices.** The device key log is already append-only and hash-chained, and the backend "cannot forge an entry" (`cli/src/lib/e2ee/deviceLog.ts`). Memory keys build on it:

| Event | What happens |
|---|---|
| First device turns sync on | It creates a random 32-byte epoch key |
| Device added | Once the device appears in the device key log and the person approves memory sync on it, an existing device wraps the epoch key to the new device's key and uploads the envelope. Bitwarden and Signal add devices the same way ([Bitwarden](https://bitwarden.com/help/bitwarden-security-white-paper/), [Signal](https://signal.org/blog/a-synchronized-start-for-linked-devices/)). |
| Device removed | A `remove` in the device log starts a new epoch. Remaining devices get the new key, live records move into a compacted snapshot, and the server deletes the old epoch's blobs. Without rotation, removal is policy only: 1Password states that removal "isn't cryptographically enforced" ([1Password](https://agilebits.github.io/security-design/revoke-access.html)). |
| Phone | Read-only key path; never fetches evidence |
| All devices lost | Memory is gone unless the person saved a recovery key. Say so plainly. |

**Conflicts.** There is no last-writer-wins. When two machines supersede the same record, both versions stay as forks marked `needs_verification`. The store already does this for conflicting claims (`companions/src/memory/store.ts`). Consolidation or the person resolves the fork.

**Forget.** A forget runs in five steps:

1. Add a `Forget` entry to the log.
2. The server deletes the record's key.
3. Every device purges the record's rows, FTS entries, notebook pages and receipts.
4. Tombstones keep the record ID and a keyed fingerprint of its conflict key and claim, so no device relearns it from its own transcripts.
5. Tombstones are kept longer than a stated offline horizon (for example 180 days). A device that has been offline longer wipes its copy and pulls again, and a returning device applies forgets before it serves any recall.

A secret found after sync gets two actions: forget the record, and tell the person to rotate the credential.

**Evidence on demand.** Records point back to their source: origin computer, session and turn. On another computer, opening the evidence sends a sealed request over the existing fleet lane when the origin is online. Otherwise the viewer says "Evidence is on <computer>". Transcripts are never uploaded by default.

**Project links.** `LinkProject` puts the normalized remote and the root commit inside the encrypted body, so the server never learns repository names. Another computer links its project automatically when both values match a local checkout. It asks when only one matches, for example a fork (different remote, same root commit) or rewritten history (same remote, different root).

### Security against memory poisoning

The pattern repeats across vendors: untrusted content triggers a memory write, and later sessions read it back as trusted context. It has been demonstrated against ChatGPT, Gemini, Windsurf and Claude Code ([Windsurf](https://embracethered.com/blog/posts/2025/windsurf-spaiware-exploit-persistent-prompt-injection/), [Cisco](https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code)).

| Threat | Control | Precedent |
|---|---|---|
| Injected tool output or web page writes a "preference" | Only user-role evidence creates preferences or decisions. Turns that used web search or MCP can't create active records. | Codex's `polluted` thread mode ([types.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/config/src/types.rs)) |
| Recalled text read as an instruction | Fenced, labeled packet. Invisible characters and markup-imitating tags are stripped. No system-prompt placement. | Claude Code v2.1.284 neutralization ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)) |
| Malicious repository edits native memory files | Native imports stay tentative, show their origin and are never promoted automatically | Cisco MEMORY.md compromise |
| Compromised or cloned device injects records | Signed per-device series, hash-chain heads gossiped over `group_sync`, revoke plus epoch rotation | Device key log; Tailscale Tailnet Lock ([Tailscale](https://tailscale.com/kb/1226/tailnet-lock)) |
| Server rollback or withholding | Authenticated headers; head mismatch across devices raises an alert | Kleppmann hash graph |
| Secrets captured | Secret filter before every write (Atuin's default patterns) plus the existing admission guard | [Atuin config](https://github.com/atuinsh/atuin/blob/main/crates/atuin-client/config.toml) |
| Stale facts cause harm | Anchor validation at recall; expiry of unused project facts | Copilot |

One known weakness: in the trust group, "compromising ANY member lets it add keys the whole group trusts" (`cli/src/lib/e2ee/trustGroup.ts`). The memory key is only as strong as that rule.

### User controls

Separate Learn and Recall switches (already built), plus:

- A per-project exclude and a private-conversation control.
- **Remember this** and **Forget** from any agent.
- The Memories viewer, with *How you work*, *Project knowledge*, *Helping now* and *Learning*.
- Correct, narrow scope or forget, with a preview of affected pages.
- A per-computer "Sync memory on this computer" switch.
- A device list with Remove.
- Export to JSON or Markdown.
- A label showing where each record's evidence lives.

The viewer is also honest about limits. Forgetting a record does not erase what Claude Code or Codex saved in their own memory, or text already in a running conversation. The viewer says so, and links to the native file when the same fact is there.

### What to measure

| Measure | Gate | Source of the bar |
|---|---|---|
| Repeated corrections per task | Fewer than with native memory alone, with no correctness loss | Earlier plan |
| Relevant memory delivered within budget | ≥ 90% across Claude Code → Codex and the reverse | Earlier plan |
| Tasks needing no memory get none | ≥ 95% | Earlier plan |
| Delivery verified, not just emitted | Packet marker found in the next native transcript entry | Earlier plan feedback taxonomy |
| Records withheld or demoted by validation | Tracked. A high rate means extraction is stale. | Copilot |
| Recall latency | p95 < 100 ms with a 200 ms hook deadline | Earlier plan |
| Extraction cost | Calls and tokens per day per account. Never above the six-per-hour budget. | Codex team: memory "consumes significant additional tokens" ([#19105](https://github.com/openai/codex/issues/19105)) |
| Forget propagation | Every online device purged within one minute. A device past the horizon re-pulls. | Design target |
| Poisoning, scope leak and resurrection fixtures | Zero failures | Earlier plan |
| Task benefit | A/B against memory off, native only, Harness only, and claude-mem or Hindsight | VibeMemBench shows most setups fail this test |

## Build the smallest proof first

| Phase | Proves | Includes | Exit gate | Excludes |
|---|---|---|---|---|
| 0. Now | Nothing to build | This design | Engine refactor shipped, onboarding has plateaued, owner approval | All code |
| 1. One computer, explicit memory | A "remember this" in Claude Code changes the next Codex harness, and the reverse | Memory service process, memory hook, `remember`/`forget`/`search` commands, viewer reconnected | Received context verified in pinned versions across resume and compaction. Off leaves zero hooks and zero processes. Forget works. | Model extraction, sync |
| 2. One computer, automatic learning | Learned records are correct and help | Extraction from episodes, anchor validation, native imports as tentative records, held-out set of 60 or more tasks | The earlier plan's release gates; beats native-only on repeated corrections | Sync |
| 3. Two computers | Records follow the person, and forgetting follows them too | Sync log, epoch key, project links, forget propagation, device removal | Forget, horizon, equivocation and revoke tests pass. The server holds only ciphertext and metadata. | Phone writes |
| 4. Breadth | More agents and surfaces | More engines, Codex extensions channel, AGENTS.md diff proposals, skills projection, phone read-only view | Certification for each engine | — |

Phase 1 skips model extraction on purpose. Extraction is where the earlier work stalled: zero completed real-model runs because of the weekly quota (`docs/research/2026-10-01-memory-native-quality-blocked.json`). Explicit memory is also the path practitioners trust most.

## How the agents remember today

### Claude Code 2.1.296: two local stores, hooks as the way in

Claude Code has two stores ([memory docs](https://code.claude.com/docs/en/memory)):

- **CLAUDE.md**, which the person writes.
- **Auto memory**, which Claude writes. It has been on by default since v2.1.32 (2026-02-05). It lives in `~/.claude/projects/<repo>/memory/` and holds a `MEMORY.md` index (the first 200 lines or 25KB load every session) plus typed topic files: user, feedback, project and reference.

Auto memory is "machine-local", keyed by the local git repository, and shared across worktrees. Since v2.1.277 (2026-09-18), Claude Code reads AGENTS.md natively, but only where no CLAUDE.md exists.

Hooks are the integration point ([hooks](https://code.claude.com/docs/en/hooks)). SessionStart (startup, resume, clear, compact, fork) and UserPromptSubmit accept `additionalContext` up to 10,000 characters. Larger output becomes a file path that Claude is not told to open.

Open issues show where the native design hurts:

- Index overflow silently drops the newest entries, so corrections get lost ([#92998](https://github.com/anthropics/claude-code/issues/92998)).
- MCP memory servers cannot win priority over the built-in memory prompt ([#48465](https://github.com/anthropics/claude-code/issues/48465)).
- "Nothing follows the login" across machines ([#87027](https://github.com/anthropics/claude-code/issues/87027)).

Anthropic is building more:

- A consolidation pass ("Auto Dream") appeared for some users in March 2026 and then vanished ([#38461](https://github.com/anthropics/claude-code/issues/38461), [#50694](https://github.com/anthropics/claude-code/issues/50694)).
- The changelog mentions mounted team memory stores (`CLAUDE_MEMORY_STORES`) in remote sessions ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).
- In this research, the shipped binary also contained flag-gated code for personal and team memory sync. That code is undocumented and is not a contract.

Expect Anthropic to ship its own sync for Claude-only users. Harness's lasting value is the layer across agents.

### Codex 0.162.1: optional, slow, global, with a designed input folder

Codex memories are off by default ([memories docs](https://learn.chatgpt.com/docs/customization/memories?surface=cli)). The pipeline has two phases:

1. A background extraction turns idle conversations into per-conversation summaries. Defaults: at least 6 hours idle, at most 10 days old, 2 conversations per run.
2. A sandboxed consolidation agent, which runs at most once every 6 hours, rewrites `~/.codex/memories/` ([README](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/memories/README.md), [config](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/config/src/types.rs)).

Recall injects `memory_summary.md`, truncated to 2,500 tokens, regardless of the working directory. OpenAI calls that "by design for the current models" ([#17496](https://github.com/openai/codex/issues/17496)).

Two facts matter for Harness:

- **`memories/extensions/<name>/` is the designed input folder.** OpenAI's Computer History and its own feature for importing another agent's memory, which copies Claude Code's memory files and is still behind a flag, both use it ([Computer History](https://learn.chatgpt.com/docs/customization/computer-history), [memory_import.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/external-agent-migration/src/memory_import.rs)). Resources with timestamps are pruned after 7 days, and `codex debug clear-memories` wipes the folder, so anything Harness writes there must be re-deliverable.
- **Hooks are GA, on by default, and gated by trust review.** `additionalContext` is added as developer context, capped at about 2,500 tokens by default. New or changed hooks are skipped until trusted ([hooks](https://learn.chatgpt.com/docs/hooks)).

Memory v2 (opt-in since 2026-09-08) writes a separate `memories_v2/` with one summary of at most 10KB. That is another reason not to depend on Codex's file layout.

### Other agents: vendor clouds or local files, and the first generation is being withdrawn

| Agent | Where memory lives | Follows the person across computers? | Validation |
|---|---|---|---|
| GitHub Copilot Memory | GitHub servers; repository facts and personal preferences | Yes | Citations checked on the current branch; 28-day expiry |
| Cursor | Memories removed in 2.1; Projects shared-context files (beta, 2026-09-10) | Projects: yes ([Cursor](https://cursor.com/blog/projects)) | Not documented |
| Devin | Knowledge deprecated and migrating to Skills since 2026-09-18 | Cloud, organization-wide ([Devin](https://docs.devin.ai/product-guides/knowledge)) | Human approval |
| Windsurf / Devin Desktop | `~/.codeium/windsurf/memories/`, legacy Cascade agent only | No ([Devin Desktop](https://docs.devin.ai/desktop/cascade/memories)) | None |
| Kiro (launched 2026-10-09) | Records scoped like `repo:github/<owner>/<repo>` | Undocumented ([Kiro](https://kiro.dev/docs/memory/)) | No writes in untrusted workspaces |
| Gemini CLI | Markdown tiers plus an Auto Memory inbox of patches | No | Every patch needs approval ([Gemini](https://geminicli.com/docs/cli/auto-memory/)) |
| Hermes Agent | `MEMORY.md` (2,200 characters) plus `USER.md`, FTS5 session search, self-written skills | No | Caps, injection scan, optional approval ([Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)) |
| OpenClaw | Workspace Markdown plus daily notes with hybrid search | No | None; poisoning demonstrated ([arXiv 2603.11619](https://arxiv.org/pdf/2603.11619)) |
| OpenCode, Aider, Cline, Junie, Factory | Instruction files only | Through git | — |

Two conventions now span vendors. AGENTS.md is the shared instruction file, listed as supported by 20 agents and used in over 60,000 repositories ([agents.md](https://agents.md/)). `SKILL.md` is the shared format for procedures ([agentskills.io](https://agentskills.io/)). Every memory launched in 2026 ships with a control surface: expiry, an inbox, access levels or approval.

## What the evidence says about memory systems and practice

Benchmarks favor simple retrieval and careful writing over packaged memory services:

- On the independent MemoryAgentBench, plain BM25 scored 41.5, ahead of Mem0 (21.1), Zep (24.0) and Cognee (20.6). Long-context models led at 46.9–49.6. Every system scored at most 7% on multi-hop selective forgetting ([MemoryAgentBench](https://arxiv.org/html/2507.05257v3)).
- A GPT-4o-mini agent using grep over files scored 74.0% on LoCoMo, against Mem0's reported 68.5% ([Letta](https://www.letta.com/blog/benchmarking-ai-agent-memory)).
- LoCoMo's answer key is about 6.4% wrong, and its judge accepted 62.81% of deliberately wrong answers. Vendor claims above about 93% are not credible ([audit](https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg)).

For coding, memory helps only when later work truly depends on earlier facts:

- On DreamBench-SWE, 180 tasks went from 21 passes without memory to 82 with a plain verbatim event log and 97 with Mem0 storing text literally. The author claims no ranking among the memory conditions ([arXiv 2608.20664](https://arxiv.org/abs/2608.20664)).
- On VibeMemBench, 11 of 12 pairings of a solver with an existing memory system did not beat memory off. Direct injection of verified experience did help 4 of 5 solvers ([arXiv 2609.23570](https://arxiv.org/abs/2609.23570)).

The lesson for Harness: quality on the write side and validation matter more than retrieval sophistication. A vector database or graph is not justified yet.

| System | Shape | Fit for Harness |
|---|---|---|
| claude-mem (98,980 stars) | Hooks, SQLite, works across agents | Now asks users to sign in, offers cloud sync to cmem.ai, and its README promotes a crypto token. Disputed recall claims ([#4138](https://github.com/thedotmack/claude-mem/issues/4138)). Benchmark against it; don't adopt it. |
| Hindsight (47,696) | Retain, recall and reflect; plugin for ten agents | Strong benchmark target. Needs its own LLM and Postgres ([repo](https://github.com/vectorize-io/hindsight)). |
| Mem0 (66,902) | Add-only facts plus hybrid search | The published scores come from the paid Platform's "proprietary optimizations" ([repo](https://github.com/mem0ai/mem0)) |
| Graphiti / Zep | Facts that track when they were true, linked to source episodes | Worth borrowing the validity and provenance ideas; no graph database ([repo](https://github.com/getzep/graphiti)) |
| Letta MemFS | Git-backed Markdown edited by the agent | Good for inspection; weak on forgetting and encryption |
| Anthropic Managed Agents memory stores | Versioned, path-addressed documents with "dreaming" | Hosted by Anthropic, readable by the host, Claude only ([docs](https://platform.claude.com/docs/en/managed-agents/memory)) |

None of these products documents end-to-end encryption that the vendor cannot read. Customer-held keys for data at rest is the strongest option found ([Zep](https://help.getzep.com/security-compliance)). That gap is why Harness needs its own sync.

Practitioners mostly stay with short instruction files that grow only from observed failures. Mitchell Hashimoto says of his AGENTS.md: "Each line in that file is based on a bad agent behavior" ([Hashimoto](https://mitchellh.com/writing/my-ai-adoption-journey)). Evidence on always-loaded context points both ways. An ETH study found that repository context files tend to lower task success and raise cost by over 20% ([arXiv 2602.11988](https://arxiv.org/abs/2602.11988)). In Vercel's evals, an AGENTS.md index beat skills that load on demand ([Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)).

The combined reading favors a small always-loaded part plus injection by hooks, rather than tools the agent must remember to call. Practitioners say the same: memory behind MCP depends on "the agent [invoking] the MCP at the right moment" ([HN](https://news.ycombinator.com/item?id=46075616)). When memory is synced across machines, injecting another machine's memory "without any vetting" was flagged as an injection risk ([HN](https://news.ycombinator.com/item?id=48923111)).

## What changed since the September 30 research

| Topic | 2026-09-30 docs said | Now |
|---|---|---|
| Claude Code and AGENTS.md | "Supports AGENTS.md, with version and precedence qualifications" | Native since v2.1.277, only where no CLAUDE.md exists. `claude-md-and-agents-md` mode reads both. |
| Codex version and memory | 0.159 inspected; extraction followed by consolidation | 0.162.1. Extraction now triggers on user turns with a cooldown; the crate README is stale. Memory v2 is opt-in. The extensions folder is the designed input. |
| Codex hook trust | Trust required | Harness pre-records its own hooks' trust hashes (#1127) |
| Harness delivery | UserPromptSubmit recall certified for Claude 2.1.286–2.1.287 and Codex 0.159–0.160 | Removed in #684 (2026-10-03). Core now forbids it. Certifications are stale. |
| claude-mem | "Closest product alternative" | Hosted sign-in, cloud sync and token promotion make it a benchmark only |
| Cross-machine sync | Out of scope; "do not begin with machine synchronization" | Still not first. Designed here as phase 3. |
| Vendor memory | Claude and Codex compared | Copilot measured validation at use. Cursor and Devin withdrew first-generation memory. Kiro launched Memory. Anthropic has unreleased sync and consolidation. |
| Module location | `cli/src/memory/` | `companions/src/memory/`, outside core |

## Decided by evidence, by judgment, and still open

| Status | Item |
|---|---|
| **Evidence** | Agents' own memories are local to one machine and one agent. Their formats change between releases. |
| **Evidence** | Hooks deliver more reliably than tools the agent must choose to call (Claude issue #48465, practitioner reports, Vercel). This is moderate evidence, not a controlled study. |
| **Evidence** | Host caps: Claude Code 10,000 characters per hook output; Codex about 2,500 tokens by default. |
| **Evidence** | Validating against code at use pays off (Copilot, vendor-measured). Generic experience extraction often does not (VibeMemBench). |
| **Evidence** | Per-device logs with per-record keys ship in production (Atuin). Removal without key rotation is only server policy (1Password). |
| **Evidence** | Memory poisoning is demonstrated across vendors. |
| **Evidence** | Harness's extraction quality is unmeasured: zero completed real-model runs. |
| **Judgment** | A separate memory hook rather than relaying through core |
| **Judgment** | Linking projects through remote plus root commit, with confirmation |
| **Judgment** | Epoch keys wrapped to devices in the device key log, and rotation on removal |
| **Judgment** | Evidence fetched live from the origin computer; no transcript upload |
| **Judgment** | Expiry values (28 days, 14 days, 180-day horizon) and a budget of about 1,000 tokens and 6 items |
| **Judgment** | Local-only use plus export as the fallback |
| **Open** | Whether Anthropic ships personal memory sync, and how Harness should coexist with it |
| **Open** | Whether Codex makes memory v2 the default, which changes what the extensions folder receives |
| **Open** | Whether trust-group membership is strong enough for a memory key, or whether adding a device needs a co-signature, as in Tailnet Lock |
| **Open** | Recovery when every device is lost: an optional recovery key, or accepted loss |
| **Open** | Whether deleting a key (crypto-shredding) counts as erasure under privacy law; needs counsel |
| **Open** | Which of the other twelve engines support injection at prompt time |
| **Open** | Which account and model pay for extraction, and the quota impact on subscription plans |
| **Open** | Whether conversations started outside Harness (already indexed by session search) may feed memory, and how the person opts in |

## Conclusion

The question has shifted from storage to trust. Every vendor can store memories. What separates the ones that last is whether a stored memory can be checked before it reaches the agent, corrected by the person, and removed everywhere. Copilot checks citations, Gemini and Devin use inboxes, Kiro and Hermes use access levels. Cursor and Windsurf, which shipped opaque automatic memory, withdrew it. Harness already has the hard part that most products lack: evidence-bound records with admission rules, tombstones and delivery receipts. The best design builds on that, adds validation at recall, and makes forgetting work across machines through key destruction, not just deletion requests.

The earlier proposal treated sync as the centerpiece. Sync is the easiest part to specify, because Atuin and the password managers have shipped the pattern. The uncertain parts are upstream: whether extraction on the person's own model produces records worth keeping, and whether the hook packet changes what the next agent does. Phases 1 and 2 answer those questions on one computer for little cost. If they fail, there is nothing worth syncing. If they pass, the sync design above is ready.

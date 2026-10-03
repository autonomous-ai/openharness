# Coding memory: sequential review and implementation

Status: in progress, 2026-09-30. The objective remains a thoroughly reviewed, useful coding memory system across agent frameworks. Passing an isolated core suite does not establish completion or perfection.

These reviews are performed by Codex using the published principles collected in the [historical council](2026-09-30-coding-memory-council.md) and [modern practitioner study](../research/2026-09-30-modern-coding-memory.md). They are not personal participation, simulated quotations, or endorsements by the named programmers. Each perspective produces a concrete question, a change or open requirement, and evidence needed to close it. Review again after integration, not just after the design document.

## Authoritative starting state

The preceding examples-only answer made no implementation progress. This turn rechecked the worktree and fast-forwarded the design branch from `5e2d026a9` to the already-fetched `origin/main` at `21793ef8d`. Existing research files were preserved. The current runtime has `LessonStore`, narrow signal learning, explicit conversation lookback, and `CompanionIntelligence`; it did not contain the proposed memory service.

The new code is in `cli/src/memory/`. It is an isolated library and is not yet wired into the installed daemon, agent hooks, or desktop viewer. No personal conversations have been ingested into it during development.

## Review sequence: round one

| Order / perspective | Our review question and finding | Change and remaining evidence |
| --- | --- | --- |
| 1. Peter Naur | Can another agent recover why a choice made sense, including its limits? A bare lesson string loses this. | The record carries rationale, conditions, exceptions, source spans, and revision. Live handoff and faithful extraction remain unverified. |
| 2. Edsger Dijkstra | Which properties are established, and which merely asserted? A model could otherwise manufacture evidence metadata. | Admission requires actual source IDs/spans and checks verification against the captured source. Tests reject invented verification and assistant success claims. This proves structural checks, not semantic faithfulness of every paraphrase. |
| 3. Barbara Liskov | Do both host adapters preserve the same contract? | The core has a framework-neutral record and recall packet. Real Claude/Codex context delivery and resumed-session behavior remain required. |
| 4. Jeannette Wing | Does information retain its scope and meaning through composition? | Access and topic dependency checks prevent profile/project widening; tool-quoted user text cannot become user evidence. Adapter and extraction adversarial tests remain required. |
| 5. David Parnas | Can storage, extraction, and delivery change independently? | Types, admission, and storage are separate modules. Durable learning and engine adapters are the next boundaries to implement. |
| 6. Donald Knuth | Can the user understand a memory without reading a database row? | Claims, rationale, conditions, and evidence are explicit. The actual readable viewer and evidence navigation remain pending. |
| 7. Dennis Ritchie | Is the service small enough to compose with existing agents? | Local SQLite and narrow operations form the core. CLI/MCP integration remains pending; no new external database service was added. |
| 8. Ken Thompson | Can behavior be inspected and reproduced with small tools? | Disk persistence and reopen tests exercise the actual SQLite store. A runnable cross-framework demonstration and export/diagnostic commands remain pending. |
| 9. Kent Beck | Does feedback expose an actual failure before it is declared fixed? | The second pass produced four failing behavior tests, then repaired conflict resolution, topic revision continuity, stale-generation commits, and dependent-note deletion. |
| 10. Rich Hickey | Are identity, revision, and current applicability separate? | Memory IDs persist across CAS revisions. Topic invalidation now keeps content-free revision metadata, so regeneration cannot reuse a revision number. |
| 11. Margaret Hamilton | Can learning or storage failure disrupt coding? | Missing SQLite returns a typed unavailable result; lock waits are bounded. Worker isolation, durable leases/recovery, and foreground recall deadlines remain pending. |
| 12. Bret Victor | Can the user see why behavior changed and correct it? | The core exposes records, history, evidence, correction, and forgetting. The DSH interaction and visual review remain pending. |
| 13. Peter Steinberger | Does memory point to current workspace authority instead of duplicating it? | Reference details retain evidence and conditions. Resource discovery, revision checks, and host-loaded status still need executable integration tests. |
| 14. Andrej Karpathy | Can a failed experiment win because a placeholder looks like a good score? Can generated synthesis reinforce itself? | Failed runs normalize to null scores; comparisons require recorded conditions. Derived source lineage and topic dependencies prevent treating their records as independent user evidence. Actual evaluator comparison and notebook generation remain pending. |
| 15. Jeff Dean | Does collaboration change with the task while acceptance stays explicit? | Conditional recall and temporary-state labels preserve that distinction. Real matched tasks, performance measurement, and interaction evaluation remain pending. |
| 16. Mitchell Hashimoto | Does a repeated mistake improve the workspace, or merely produce more reminders? | Canonical references and negative knowledge are in the model. The feedback path that proposes a meaningful helper/test change remains pending. |
| 17. Simon Willison | Is a remembered capability tied to something that actually ran? | Verification carries an artifact, revision, environment, coverage, and limits. Native execution receipts and reusable-example applicability remain pending. |
| 18. Addy Osmani | Do requirements survive task steps and agent switches? | The design carries task contracts and scoped decisions. Complete episode capture and end-to-end acceptance tests remain pending. |
| 19. Charity Majors | Does production evidence refer to this change, environment, and observation window? | Operational verification has distinct fields. Real operational adapters and tests against wrong-build attribution remain pending. |

## Round two: executable findings

The first 19 store tests passed. Additional tests then demonstrated four failures before fixes:

1. A correction could not safely resolve a conflicting peer. Resolution now checks every supplied peer revision and updates the group transactionally.
2. Invalidating a topic deleted its revision history marker. Invalid pages now retain scope and revision metadata with their content cleared; regeneration compares the expected revision.
3. A topic generation started before learning was toggled could commit afterward. Topic publication now checks the control generation as well as parent revisions.
4. Forgetting a parent left a generated dependent memory. Sources now record explicit memory dependencies; deletion follows that graph, purges owned derivatives, and retains only evidence spans used by unrelated surviving records.

Subsequent checks added field-level evidence coverage, failed-run normalization, validity-window checks for current topics, and preservation of exceptions/verification limits in recall packets.

Validation at the end of round two: 30 tests in `src/memory` and the existing SQLite/guard regression subset (46 tests) passed. CLI TypeScript checking passed. These were isolated core checks, not a native agent benchmark or a completed rollout.

## Round three: correction, continuous intake, and responsiveness

Two new tests failed before fixes: a generated dependent record remained current after its parent was corrected, and a broad surviving evidence quote could retain forgotten content. Corrections now invalidate current descendants and reject stale derived evidence. Forgetting follows overlapping source spans conservatively as well as explicit derivation links; unrelated records with disjoint evidence spans survive. Explicit user corrections work with automatic learning off, while ordinary ingestion remains gated.

Source access preserves task/branch boundaries, and derived topic statements carry their parents' conditions, exceptions, and validity. Project identity resolves Git worktrees through their common directory, generates opaque persistent IDs, and permits explicit unused aliases. Matching remotes do not merge unrelated projects.

The durable queue commits source events, episode state, and capture cursors atomically. Tests cover first-message capture before an assistant reply, replay, process restart, incomplete inputs, excluded/private source rollback, selected-model outages, per-project leases, expired-worker recovery, model/account/control changes, atomic proposal batches, and forgetting during inference. Inference reservations persist a six-call rolling hourly budget. A successful empty extraction has a different state from model unavailability or missing sources.

SQLite now runs through a bundled worker with a typed internal operation contract. Real worker tests exercise capture, recall, restart, scope checks, and forgetting. A blocked-worker test verifies that recall times out while the parent remains responsive. This establishes the deadline mechanism, not the 10,000-record latency gate.

Round-three checkpoint: 53 memory tests passed. TypeScript passed at the 50-test checkpoint. Subsequent validation and implementation status are recorded below.

## Round four: evidence-based self-improvement

The user's overnight direction makes continuous learning and improvement explicit. The architecture now separates evolving knowledge, contextual usefulness, and versioned system-quality experiments. New corroboration tests add independent evidence from another framework to an existing meaning without duplicating or rewriting it. Repeated input and generated echoes add no independent confirmation. Old confirmations do not transfer to a corrected meaning, and forgetting also purges corroborating sources.

The primary-source research refresh inspected the author abstracts/version histories for [ACE v3](https://arxiv.org/abs/2510.04618v3), [LongMemEval v2](https://arxiv.org/abs/2410.10813v2), [RoMeRL v3](https://arxiv.org/abs/2608.02508v3), and [EDV v1](https://arxiv.org/abs/2606.24428v1). Their findings motivate granular updates, temporal/abstention evaluation, careful credit assignment, and separate verification. Their benchmark results are not claimed for Harness. Full methodological comparison and reproduction are still open.

## Open implementation and review work

The full [architecture](2026-09-30-tim-memory.md) and its [64 synthetic scenarios](2026-09-30-tim-memory-cases.json) remain the requirement set. The synthetic scenarios are not equivalent to the executable core tests or to the separate held-out evaluation.

- Exercise the development-gated daemon integration with authenticated live sessions, account changes and native invocation. Unit tests establish the lifecycle contract, not a running-app end-to-end result.
- Expose private-session/project controls, learning/recall preferences, queue gaps and model availability through authenticated user-facing transports and the viewer before removing the development flag.
- Validate profile-scoped companion capture with real-model negative-domain and scope tests. The host now binds only the current collection conversation to personal scope; native project evidence cannot become a global preference.
- Add quiet-period episode batching; bounded retention is implemented, while incomplete or oversized episodes remain explicit gaps rather than being silently summarized.
- Validate the extraction process and faithful field-level support with real models. Structural source checks alone cannot establish this.
- Validate the development-gated hook path against the real authenticated host, including resume/compaction and native hook latency. One Claude print-mode transport path is verified against a local mock; Codex verification remains incomplete.
- Complete general project-agent CLI/MCP operations, private-session/project forms and per-revision feedback. Owner-library reads and token-bound collection recall are implemented in round ten. Content-free prepared/emitted receipts exist, with production model-context delivery explicitly unverified.
- Build the three Memories views inside the existing DSH viewer while retaining the real agent terminal on the right.
- Integrate notebook synthesis, correction/forget invalidation of owned exports/caches, and diagnostics for previously delivered native context.
- Preserve approved lessons and native memory, with versioned migration, rollback, and experimental controls.
- Exercise the three real coding workflows in both framework directions, matched preferences, no-recall/conflict cases, baselines, and the architecture's held-out and performance gates.

## Integration discovery requiring follow-up

The existing Claude one-shot process disables built-in tools and MCP loading. The Codex process currently uses a read-only sandbox and ignores user config/rules, which does not by itself establish zero tool availability. Before using it for the new learner, certify a supported restricted inference configuration against the installed release and preserve the selected account/model. Do not infer tool removal from a sandbox label or silently switch providers. [Official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [approval and sandbox behavior](https://learn.chatgpt.com/docs/agent-approvals-security).

A local mock-server probe of installed Codex 0.159.0, using synthetic input, a fake key, and the `gpt-5.4` model identifier, disabled execution/app/browser/plugin/agent features. The outgoing catalog contained only `request_user_input`. A synthetic call to that tool returned an error item without interactive input; a synthetic `exec_command` request was refused and created no marker file. This is evidence for that tested configuration, not a universal no-tools claim or a live-model test. The restricted adapter and its failure tests are now implemented; host integration remains pending. Probe source: `.scratch/memory-implementation-20260930/tool-catalog-probe.mjs` (development-only, not a shipped artifact).

The store uses ordinary-page secure deletion plus FTS5 secure deletion, and avoids a persistent WAL. This protects the owned current database/index; it does not erase OS snapshots, independent exports, or already-delivered native transcripts. [SQLite FTS5 deletion behavior](https://www.sqlite.org/fts5.html#the_secure_delete_configuration_option).

## Round five: native capture, bounded inference, and measured retrieval

The selected-model extraction loop now claims a durable lease, supplies bounded evidence and existing drafts, validates JSON, and rechecks the current target before publication. Tests distinguish no useful memory from an outage, reject fabricated quotes and publication fields, coalesce ticks, stop hung providers, and cancel even when a provider ignores its abort signal. Unknown rationales can remain null. Proposed future actions, exceptions, and validity conditions now require evidence coverage as well as the main claim; structural coverage still does not prove semantic entailment.

Native capture reads registered Claude/Codex JSONL files independently of UI previews. Sources and byte cursors commit together. Tests cover the first user message before a reply, restart, partial UTF-8 writes, consent/pause boundaries, in-place rewrites, bounded oversized-record handling, quiet closure, project reassignment refusal, and a host-provided fork boundary. Pasted code and block quotes are reference data, and tool output never acquires user authorship. No native tool output is promoted to verified test evidence merely because it was captured: typed execution verification still needs its own adapter. General-domain filtering, complete fork/import lineage, and private-session controls must be bound by the host before rollout.

`CompanionIntelligence.extract` uses fresh, bounded native processes and checks observed login identity before and after inference. The original `run` path remains available for existing lessons. Codex 0.159.0 and Claude Code 2.1.285 are the initially tested releases; unknown releases wait rather than select another model. A separate local mock probe of Claude with an isolated config, fake token, and `claude-opus-4-6` reported an empty outgoing tool catalog. A forced unlisted Bash call created no marker. Process tests reject tool availability/attempts, error results, unexpected protocols, and oversized output, and preserve Unicode across pipe chunks. These are protocol/configuration checks, not real-model quality tests. The restriction flags are documented in the [official Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

The 10,000-record benchmark initially missed the warm p95 target: 196.6 ms. SQLite selected the scope index first and repeated the FTS scan for each scoped row. Driving the join from FTS once reduced it to 12.7 ms. A second review found that inapplicable or expired rows could consume all 120 candidate slots. Conditions, exceptions, validity, and exclusions now filter before that cap; a regression with 125 newer unusable matches still finds the older applicable memory. Typed scalar/array condition tests pass. With those filters, warm p95 is 15.9 ms, new-worker p95 is 42.3 ms, and no request timed out among 310. This is one synthetic local dataset, not a relevance evaluation; “cold” does not mean a cleared OS disk cache. [Reproducible measurements](../research/2026-09-30-memory-performance.json); runner: `cli/scripts/memory-benchmark.ts`.

Latest checkpoint: **112 memory/companion tests plus 46 existing SQLite/guard regression tests passed** (158 total). CLI TypeScript checking, release bundling, and the bundled version smoke check passed. No installed app or daemon was replaced, no personal conversations were ingested, and no real provider model was called by these probes. The code remains an unshipped integration foundation; live delivery, the viewer, retention, native execution receipts, faithful extraction, and held-out behavioral evaluation remain open.

## Round six: ownership, privacy, and recovery

An authenticated Harness owner can now be bound to the current sign-in without storing the raw user ID in the memory store. The binding survives a verified token refresh but is discarded on a different sign-in or environment. A late identity response cannot bind a replacement session. This is a host integration primitive; the live host has not called it yet. Model accounts and companion avatars remain separate from knowledge ownership.

Session and project exclusion now withhold original evidence and generated descendants from read, history, support, listing, recall, and topics. Exclusion cancels pending extraction and late publication. The host-only forget operation remains available for a known hidden record. Restoring a session or project restores existing retained knowledge, rechecks contradictory active records, and starts a new capture boundary so the excluded interval is not backfilled. Supplementary private confirmations do not inflate public support counts. A fresh public statement of the same meaning replaces the private representative evidence without exposing its earlier revision.

Privacy filters run before candidate limits: 125 private matches cannot crowd out an older public match. The synthetic 10,000-record benchmark now measures warm p95 **20.4 ms**, new-worker p95 **36.9 ms**, and zero timeouts among 310 requests. The benchmark's relevance and environment limitations still apply.

A recovery test exposed and fixed a cancelled-episode cursor trap: forgetting an open episode's evidence no longer prevents later native turns from being captured. Capture checks exclusions before opening a transcript, retains acknowledged byte positions, and resumes from fresh eligible events. The current pause boundary uses host policy time and native record timestamps; complete native fork/import lineage and host-owned privacy UI integration remain open.

Checkpoint: **124 memory/companion tests and 10 auth-session tests passed**. TypeScript passed. These changes remain isolated from the installed app. Next: bounded backlog/evidence retention, the live host lifecycle, and user-facing controls.

## Round seven: bounded retention and host lifecycle

Completed episodes now immediately retain only their exact supporting excerpts, including historical revisions and independent confirmations. Unused captured text is deleted with content-free identity receipts to prevent native replay from recreating it. Evidence still needed by another pending episode stays intact until that episode settles. The pending queue is capped at 256 episodes of at most 96,000 serialized bytes each; a full backlog refuses new input before cursor advancement. Unreviewed input expires after seven days with an explicit `expired` state, a cumulative content-free gap count, and rejection of late inference. Maintenance limits each compaction pass to 512 sources and removes old terminal job/call metadata. This bounds captured backlog, not the total size of useful retained knowledge or native conversations owned by the engines.

The runtime now owns profile-specific workers, capture, idle scheduling, requested Learn/Recall preferences, privacy operations and bounded recall. Tests cover account changes, consent changing during startup, private-mode changes during recall, native session rotation, late model output, foreground cancellation, off/on preferences and first-turn capture while intelligence is unavailable. A recently exited process receives a two-minute capture grace period; no archive scan is introduced. Ordinary Claude/Codex workspace sessions and the bundled Web/Firmware DSHs are the first host classifications. Home/root sessions, subagents and unrelated DSHs are excluded. Classification of a coding session does not prove that every utterance is about coding; faithful extraction and negative-domain evaluations remain necessary.

`cli.ts` now binds this lifecycle to the existing daemon switch, watching consent, authenticated owner and selected collection intelligence. The exact authenticated zoo response carries its local owner provenance through a WeakMap, so an old account's cached consent cannot enable a new account's capture. Guest memory uses a separate local owner. **This integration is gated by `HARNESS_CODING_MEMORY=1` in addition to the existing experimental and watching controls.** The flag is not enabled in the installed app. In this development mode the previous automatic signal learner/timer is disabled to avoid running two background learning systems; approved old lessons and their files are preserved. Migration, manual history-review behavior and the user-facing controls need validation before removing that flag.

Review also found unnecessary native CLI probing on idle ticks. The learner now checks for eligible queued work before resolving a model and backs off unavailable targets for a minute. Native account inspection and invocation share the same absolute Codex-home rule and cached login-shell context; extraction receives only the required native environment, with ambient API credentials and Node injection settings removed. Custom-provider environments wait instead of falling back to a native subscription. Native version probes are bounded to five seconds and support cancellation. Two original two-second fixture probes timed out intermittently during the broad run; isolated rerun passed, and the updated cancellation/idle behavior addresses the relevant runtime weaknesses without relaxing protocol or release checks.

Checkpoint before the final version-probe cancellation case: **231 tests passed across 21 files**, including memory, companion intelligence, authentication, daemon-switch, SQLite and input-guard regressions. TypeScript passed and CLI release bundling passed. No personal conversations were ingested and no real provider model was called. The remaining native hook/CLI/MCP delivery, receipts, companion viewer, profile-preference entry point and behavioral evaluation are still required.

The added slow-version cancellation case also passed with the full eight-test native Codex process file. The final CLI bundle and bundled `version` smoke check passed. These are 232 distinct validated tests, with the additional case run after the broad suite.

## Round eight: personal preferences and project requirements

The host now classifies the current collection's verified companion conversation as a personal coding-memory source. It does not scan archived companion conversations or treat another `autonomous/pair` session as the active collection. Personal capture and project capture have separate cache identities even if their working directories match. A synthetic runtime test learns a stated coding preference from the companion and recalls it in two separate projects. Project decisions, verified findings and temporary task state require project scope; companion extraction is instructed to abstain on repository-specific statements without a bound project.

Project review may read relevant personal defaults to reuse their topic keys, but captured project evidence still cannot confirm or revise a global record. Recall suppresses a broader memory when an applicable, visible, more specific record has the same conflict key. This also withholds the broader fallback when the specific records need clarification, or when the specific record does not match the search terms. Private, expired, tentative, excepted or inapplicable records do not influence this precedence. Task/branch rules apply only in their current scope. The global default remains available in other projects. This is explicit-key precedence, not a semantic contradiction detector; extraction quality and missed topic matching still need evaluation.

The 10,000-record benchmark with these filters measured warm p95 **19.5 ms**, new-worker p95 **39.4 ms**, and zero timeouts among 310 requests. It uses unique conflict keys and does not establish behavior under a pathological high-collision topic distribution. Unit tests exercise actual override/conflict cases. The broader benchmark limitations remain in the [measurement artifact](../research/2026-09-30-memory-performance.json).

Checkpoint: **156 memory tests and 92 companion/authentication/daemon-switch/SQLite/guard regression tests passed** (248 total across two runs). TypeScript, the CLI release bundle and its version smoke check passed. Native delivery, authenticated user controls, real extraction quality and behavioral evaluation remain open; this still requires the development flag and has not changed the installed app.

## Round nine: delivery receipts, withdrawals and a native transport check

Recall preparation now records opaque memory IDs/revisions, query/context/packet hashes, route, byte count and timestamps. Neither raw prompts nor remembered text is copied into the receipt tables. Prepared packets and successful hook stdout writes are different facts; both remain `delivery: unverified`. There is no model-facing operation that can declare verified delivery, and these receipts never reinforce a belief. Receipt metadata is bounded to 5,000 rows and thirty days. Tests cover scope/account/session/route binding, exact byte budgets, idempotent emission timestamps, privacy and forgetting without retaining deleted claim text.

The native prompt callback is asynchronous and bounded to 225 ms; the memory runtime retains its 200 ms deadline and policy checks. Errors, unavailable stores, oversized context and hung callbacks do not block the coding prompt. `notify.mjs` acknowledges its stdout write through a credential-checked endpoint that verifies the same live native session. Source-level protocol tests exercise Claude and Codex payloads; they are not proof that either native CLI consumed the context.

Delivery review exposed two real races: a selected memory could be forgotten or corrected before the callback returned without changing the consent generation. New regression tests failed for both. A separate knowledge epoch now changes transactionally with record writes/deletion; final recall validation rejects packets spanning that change. It remains separate from the learning generation so a proposal batch can publish atomically. Later prompts in the same included native session receive bounded, content-free withdrawal references for changed, private, expired or forgotten revisions. The notice explicitly says that earlier native conversation content was not erased. These notices do not reach a runtime that has been fully disabled; user-facing fresh-session guidance is still required. Repeated notices are not suppressed on an unverified assumption that a model consumed them.

The reproducible [native transport probe](../../cli/scripts/memory-native-hook-probe.mjs) uses temporary isolated native configuration, synthetic prompts, fake credentials and localhost model/adapter fixtures. Claude **2.1.286** emitted the real hook packet and included its marker alongside the original prompt in the outgoing `/v1/messages` request, with an empty model tool catalog. This establishes one print-mode UserPromptSubmit path, not extraction quality, the real Harness ownership path, TUI/resume/compaction behavior, or usefulness. [Metadata and limitations](../research/2026-09-30-memory-native-delivery.json). The observed CLI release had advanced since the earlier 2.1.285 extraction probe; a separate restricted-inference probe again showed an empty catalog and refused a forced unlisted Bash call without creating its marker. 2.1.286 was added to the extraction release allowlist.

Codex **0.159.0** returned the synthetic prompt response in a fresh exec probe but emitted no hook context. An interactive probe then stopped at native folder trust. Automatic approval review rejected accepting “Trust and continue” because it persists code-execution trust; the test was cancelled and its temporary files removed. Explicit approval was subsequently granted; see round eleven. No trust bypass or alteration of the user's existing native configuration was used. At this checkpoint, automatic memory hook output was allowed only for the tested Claude 2.1.286 release; round eleven records the later approved Codex check.

With 10,000 synthetic memories and the full 5,000-receipt history, prepared recall measured warm p95 **39.5 ms**, new-worker p95 **50.9 ms**, and zero timeouts among 310 requests. This includes withdrawal checks and durable receipt writes; it excludes hook process startup, HTTP, runtime ownership checks and inference. The benchmark also verifies eviction at the receipt cap.

The initial hook regression run failed because the sandbox denied localhost listeners; one test helper now reports that listen failure instead of hanging until its timeout. With loopback permission, one existing offline-registry fallback case failed and then passed in isolation. The final combined run passed **374 tests across 24 files**. TypeScript, release bundling and the bundled version smoke check passed. The installed app and daemon remain unchanged, the development flag remains required, and no personal conversations were ingested or real provider model invoked.

## Round ten: owner control and collection recall

The library has an owner-only path separate from an agent's scope. Paginated owner reads include personal, project, task and branch records while preserving privacy filters before page limits. Detail views return retained evidence quotations and source metadata, not the surrounding native conversation. Cursors are invalidated by knowledge, policy or preference changes so a viewer does not combine two different snapshots. Ordinary scoped agent reads retain their existing boundaries.

Correction, forgetting and Learn/Recall settings now produce concrete previews by executing their effects in a transaction that is rolled back. Applying the preview checks the same library version in an atomic transaction. This protects against unseen new dependents before a forget operation, as well as stale record revisions or settings. Corrections cannot silently change scope, conflict identity or a verification claim; measured findings remain on the evidence path. Only submitted detail objects become fresh user assertions. Inspection and explicit owner settings work with watching off and do not start capture or inference. Concurrent inspection requests share a worker and have bounded admission.

The local owner API verifies process ancestry and OS ownership before even reading. Agent tokens and payload-supplied owner authority are refused. A successful preview issues a random, two-minute, one-use capability bound to the owner, process, connection and server-held command. Another connection, process, owner, expired capability, injected command or `confirmed: true` cannot apply it. This inherits the existing person-versus-Harness-process trust boundary, not protection against arbitrary same-user malware. The CLI currently exposes `harness pair memory list|status|show <id> --json`; the verified desktop transport and editing forms are not built. Unix-socket callers without verifiable PID are deliberately refused by this API.

The collection's existing MCP/CLI interface now has `recall_memory`, requiring its current launch token even at read-only autonomy. The host binds it to personal coding scope. It accepts a bounded query and known applicability conditions, with no owner/project/session selection or write operation. Results have prepared receipts with delivery still unverified. Synthetic tests exercise collection recall with both Claude and Codex identities; this is not a certification of Codex's automatic prompt hook, which was still blocked at this checkpoint as recorded in round nine. The companion instructions describe the new read path and require abstention when it is empty, off or unavailable.

The first combined checkpoint passed **379 tests across 29 files**, including memory, pair control/client/MCP/frame routing, companion intelligence, owner authentication, switch and SQLite/guard regressions. TypeScript and CLI bundling passed before the final instruction/documentation edits; the final run is recorded below. The installed Flutter is 3.44.9 with Dart 3.12.2, below this repository's Flutter 3.47/Dart 3.13 requirement. No desktop source was changed, no app launched or replaced, and no SDK upgraded. User-facing integration, live process/transport verification and real-model extraction quality remain required before rollout.

Final review found two deletion-preview races and reproduced both before fixing them. A new notebook topic or new corroborating evidence could expand the dependency graph without changing a memory revision. Topic writes and genuinely new support roots now advance the knowledge snapshot; replaying an existing root does not. A stale preview is rejected before any deletion. This is dependency accounting, not reinforcement of an inferred belief.

The broad 33-file run passed 526 checks and failed one expected read-tool catalogue assertion, which needed to include the newly scoped `recall_memory` tool. After updating that assertion, all 63 checks in its package/client/worker follow-up passed. The final memory-and-companion follow-up, including the two new race regressions, passed **275 checks across 23 files**. These runs cover **529 distinct checks** in total. Final TypeScript, CLI bundling, bundled version smoke check, and diff whitespace validation passed. The worker test exercises owner inspection, a rolled-back forget preview, foreign-owner rejection and committed forgetting through the actual bundled worker. Pagination flags expose subsequent library pages in the read-only CLI. No real native-model extraction or production-owner control call was performed.

## Round eleven: trusted native Codex delivery and the memory viewer

After explicit user approval, the disposable Codex 0.159.0 test accepted native folder trust and reviewed and trusted only its synthetic UserPromptSubmit hook. The hook ran, acknowledged its stdout write, and its marker appeared as developer-role context alongside the original prompt in the outgoing model request. A second request contained the prompt without the marker; its purpose is not established by this metadata-only probe. This certifies the observed interactive hook path, not every native request, extraction fidelity, resume/compaction, or task quality. The earlier untrusted exec result remains recorded. Existing user configuration was untouched and all temporary native files were removed. The development-only prompt adapter now permits this tested Codex release alongside Claude 2.1.286; receipts still say delivery-unverified in real sessions. [Recorded probe](../research/2026-09-30-memory-native-delivery.json).

The desktop package configuration identified a separate matching SDK at `/Users/ab/development/flutter-3.47.2`. It reports Flutter 3.47.2 and Dart 3.13.2; the earlier 3.44.9 discovery was a different installation. No SDK was upgraded.

The companion viewer now has a development-gated coding library: personal preferences, project records and learning status. It displays retained evidence, applicability, exceptions, validity and verification limits. Corrections show the exact submitted fields and preserve drafts across stale revisions; refreshing shows the current saved statement beside the draft. Verified findings and measured experiments remain on their evidence path rather than receiving an ordinary form edit. Forgetting previews dependent memory/notebook counts and explains that original conversations and delivered native context remain. Learn and Recall are independent, previewed settings; neither switch deletes existing knowledge.

The owner UI uses a persistent, auxiliary loopback TCP `WsConn`, because the host needs a verifiable process ID. Its handshake does not count as desktop presence; opening the view never provisions a daemon or launches an agent. Account changes invalidate the connection and purge displayed evidence. Preview capabilities stay in memory, expire, bind to the existing connection, and are consumed once even after an uncertain reply. The pair request/response type is excluded from transport logs, including late uncorrelated replies. The main socket, terminal transport and DSH layout are unchanged. A library snapshot change also rechecks open details, removing forgotten evidence while preserving an owner's correction draft.

The 24-hour lookback action is hidden only when the new service is available; existing approved and pending legacy lessons remain inspectable. This is not a legacy-data migration. The initial project cards still use opaque project identifiers in their detail view; persisted project names, scope-editing controls, per-session privacy controls and receipt/helpfulness views remain outstanding.

Validation covers **94 distinct desktop checks** across the broad run and targeted follow-ups. The broad run passed 89 and exposed one overly broad test finder matching the same statement behind and inside a modal; the finder now targets the dialog. Added owner-lifecycle checks passed. The new full-DSH integration fixture initially left its legacy lesson request unanswered; supplying that synthetic response made its timer-cleanup check pass. All affected viewer and integration cases then passed. Scoped Flutter analysis, the icon audit (495 first-party Dart files), TypeScript, CLI release bundling and the bundled version smoke check passed. Native prompt runtime tests passed **24 checks**, including the new Codex release gate. The isolated Codex UI probe used only the approved disposable folder and a localhost mock; no personal transcripts or real provider-model requests were used.

Real-font synthetic detail renders were inspected in both appearances at normal and 200% text. Representative captures: [dark detail](../research/2026-09-30-memory-viewer/memory-dark-1.0x.png), [narrow light detail at 200%](../research/2026-09-30-memory-viewer/memory-light-2.0x.png). The normal macOS debug review app builds and passes signature verification. It was not launched or installed. No physical IME/VoiceOver review, native viewer interaction, live daemon owner-control mutation, production migration or real-model faithfulness/usefulness evaluation is claimed.

## Round twelve: executable extraction diagnostics and conditional recall

Exact quotes and matching scope prove structural provenance, not that a paraphrase faithfully represents its evidence. A real learner diagnostic now keeps its rubric and later recall probes outside the inference prompt. It captures synthetic episodes into a disposable database, calls `MemoryLearner`, uses actual admission and recall, and records the resulting knowledge rather than scoring a separately mocked summarizer. The [frozen six-case corpus](../research/2026-09-30-memory-extraction-cases.json) covers conditional preferences, project-specific decisions, unsupported taste from routine tool use, third-party quotations, invented rationale and unbound repository facts. These are development cases, not independent held-out evidence or a substitute for the larger release study.

The native runner binds to the live companion's selected model and native account identity, verifies the companion session and rejects custom-provider routes. It rechecks this identity around every call, uses the existing restricted adapters, stops on unavailable intelligence, and has no fallback or retry. Native diagnostic observers retain only bounded model labels, token counters and reported costs; absent readings stay unknown, and observer errors cannot affect extraction. An init model label is a CLI report, not proof of provider execution. Reports include fixture/prompt/source hashes; existing report paths cannot be overwritten.

The [first attempt](../research/2026-09-30-memory-extraction-baseline.json) used the selected Claude `opus`/`high` configuration on Claude Code 2.1.286. Its first case ended `waiting_for_model / inference_unavailable` after approximately 1.2 seconds including setup. A separate read-only native auth-status query in the same environment reported `loggedIn: false`. The run stopped after one invocation, with **zero completed extractions** and no observed token/cost readings. No model was substituted, personal transcript supplied to inference, production memory database changed, or native account configuration edited by the diagnostic script. The saved init label is not a completed model result.

This exposed an evaluation defect: the original runner still counted empty-database recall checks after failed extraction. The recorded attempt preserves that original output with an explicit interpretation. The current runner marks those checks inconclusive, skips the recall probes and labels semantic review `not_reviewable` until extraction completes. Process exit status distinguishes a stopped run from a completed mechanically passing run. Even a mechanically passing run leaves semantic review pending.

An independent code review found that MCP recall accepted conditions while the CLI could only submit a query. The CLI now accepts bounded, typed `--conditions` JSON; the authenticated route passes it unchanged. Prompt v2 and MCP share guidance for `taskType`, `productionIncident` and explicit technology/environment constraints. Project identity is not an invented condition, and unknown context is not false. Exact matching and existing records are preserved; this is not fuzzy normalization, automatic task classification or evidence of improved extraction quality. The fixture's independently written probes still expose a mismatch if a generated record uses a different key. No native prompt-v2 extraction has been run while the selected login is unavailable.

Checkpoint validation covers **122 distinct tests across eight files**. The broad run passed 121; the 28-check control/evaluation follow-up passed after the condition-routing assertion, and the 20-check native adapter follow-up passed with an added asynchronous observer-failure case. These cover the real diagnostic pipeline with synthetic provider output, native adapter filtering/observers, learner behavior, CLI parsing and pair control/MCP regressions. CLI TypeScript and separate strict checking of the diagnostic runner passed. Development compilation, release bundling, the bundled version smoke check and diff whitespace validation passed. The dry run confirms the original fixture hash without invoking a model. The installed app and daemon remain unchanged; the development flag and all release gates remain in place.

## Round thirteen: make learning possible during sustained coding work

A runtime regression reproduced starvation: a completed coding turn remained unreviewed while its project agent continued working. Three independent gates caused this: every streamed event reset the quiet timer, any busy captured session prevented review, and the inference bridge treated any working harness in the fleet as foreground pressure. A long autonomous task or unrelated remote job could therefore prevent local learning indefinitely.

The host now recognizes fresh local turn/user-message events, excluding replay, resume and subagents. Streamed replies, tools, compaction and completion do not reset the quiet window. The runtime and native inference bridge preserve priority for the selected collection companion rather than every agent in the fleet. Other project work can continue during a background review, which still uses one restricted native process and the selected account/model. The companion's busy state and new local requests cancel active extraction; source capture remains separate.

Foreground interruption now requeues the episode immediately for eligibility after the runtime's quiet window. It is reported as `waiting_for_quiet`, not model unavailability. A late response from the interrupted call cannot publish. Interrupted reservations remain in the rolling budget: repeatedly cancelling the same episode does not produce unlimited retries. Account/privacy/state cancellation and provider quota backoff keep their previous behavior. The viewer distinguishes companion work, a recent request and a budget wait, and describes the revised background-learning policy.

Validation covers **65 distinct core tests across six files**. The broad follow-up passed 64 and exposed a new Claude fixture missing the native `message.role` field; after correcting that fixture, its six-test file passed using both native normalizers. The original starvation regression failed before the fix and now learns the completed turn while leaving the next unfinished turn open. Interruption, late-output rejection, immediate requeue and durable budget checks passed. All **11 existing memory-view widget checks** and scoped Flutter analysis passed. Final CLI type checking, release bundling, bundled version smoke check and diff whitespace validation passed. The normal macOS debug review app rebuilt and passed signature verification; it was not launched or installed. No physical/native interaction or real-provider scheduling-latency measurement is claimed.

This is a scheduling correction, not a real-provider concurrency benchmark. The selected Claude login remains unavailable for model-quality evaluation; no further native inference was attempted. The development flag is unchanged. One episode per call and six calls per hour can still create a backlog; compatible batching, real-model usefulness, full native lifecycles and production integration remain unfinished.

## Round fourteen: verify authorization before sending the extraction prompt

Synthetic regressions reproduced two startup gaps. `cancel()` did not cover a call still awaiting native account metadata. A second test held the native version probe, changed the account, and observed that both Claude and Codex adapters still launched extraction; rejecting the eventual result did not prevent the old prompt from being sent. A separate test showed that extraction could silently select a new context after the queue had acquired its original lease.

The learner now passes its original selected context into extraction. The companion registers cancellation before its first account lookup and refuses a mismatched lease context. After the version probe, the shared native transport runs an asynchronous account/selection check followed by a synchronous host owner, consent, Learn preference and runtime check immediately before spawn. The host supplies authorization bound to the original active profile, so a change does not depend on the next two-second timer tick. Context changes retain the episode as waiting work with its reservation still counted. The diagnostic runner also rechecks selection after native startup probing.

Validation covers **84 distinct tests across eight files**. The broad run passed 82 and exposed one new assertion using the wrong fixture context label; the corrected learner file passed all 12 checks, including an added source-retention case. Executable fixtures exercise account, model and owner changes during the version probe for both engines, plus unchanged successful extraction. Their filesystem handshake allows normal macOS process startup time; an initial one-second wait was too short. Host tests revoke owner identity, watching and the experiment without another tick. Existing adapter filtering, cancellation, queue publication and diagnostic cases passed. CLI type checking, strict checking of the diagnostic runner, release bundling, the bundled version smoke check and diff whitespace validation passed. A dry run preserved the frozen suite hash with zero model calls. These are synthetic fixtures, not real-provider execution or credential-switch tests. The installed app and daemon were not changed.

An external login can still change after the host's final account observation while the native CLI obtains its credentials. No cross-process credential lock or atomic provider-account guarantee is claimed. Post-result identity checks and transactional publication guards remain necessary. Real extraction quality, useful throughput and the release evidence remain unfinished; the development flag is unchanged.

## Round fifteen: review compatible episodes within the existing call budget

The one-episode-per-call scheduler could inspect only six completed turns per hour. The queue now leases up to four complete episodes sharing the exact project/task/branch scope, within the existing source-byte and event-count limits. Selection starts with the highest-priority eligible job and scans at most sixteen candidates. A group reserves one call; the rolling six-call budget and foreground priority remain unchanged. Synthetic small episodes can now finish twenty-four episode reviews before the seventh reservation is deferred.

A durable membership table binds each job to its call independently of caller-supplied lease fields. The store verifies every member's token, generation, selected context, source digest and inclusion before publication. It commits all proposals and per-episode outcomes together, or none. A privacy change to either the first or another member rejects all output; only remaining jobs still held by that token return to the queue. Late output cannot release a replacement lease. Invalid proposals preserve all source work, and failed episodes retry individually. The additive table can be created on an older database; an old unfinished lease recovers after expiry with its previous reservation still counted.

Prompt v3 presents explicit episode boundaries as indices into a deduplicated source array. Original source IDs, roles, sessions and ordering remain intact. It instructs the model not to interpret an unrelated reply as acceptance across episodes. Shared roots remain one source of support. A successful batch marks only episodes whose evidence was used as learned; the remaining reviewed episodes receive their own no-useful-memory outcome. This classification reflects the accepted output, not an independent semantic quality grade.

Validation passed **239 tests across all 21 memory/intelligence test files**. Coverage includes batch limits, scope separation, atomic rollback, forged supplied membership, privacy revocation, interruption, restart and old-schema recovery, durable budget, evidence deduplication, prompt boundaries, native startup authorization, capture, recall, forgetting and owner controls. Three initial failures were tests assuming one episode per call: capture now checks the complete recovered batch excludes paused/private text; retention keeps a shared episode explicitly open to verify source preservation; backpressure refills the freed batch slots and verifies rejection again. The full suite passed after those changes. A new legacy-schema fixture needed an explicit writable SQLite constructor option for strict type checking; this affects only its disposable database. CLI and diagnostic-runner type checks, release bundling, the bundled version check and diff whitespace checks passed. The diagnostic dry run preserved the frozen suite hash without model calls. The installed app and daemon remain unchanged.

No real-model batch extraction, comparative usefulness score, provider latency or cost improvement is claimed. The development flag and release gates remain in place. The native quality diagnostic still needs a usable selected login, and production rollout, fuller lifecycle verification, migration of legacy lessons and user-facing provenance remain unfinished.

## Round sixteen: prepare batch-quality diagnostics and prevent partial scoring

A fresh read-only check found the selected companion still configured as Claude `opus`/`high`, with the native auth status reporting `loggedIn: false`. No model was invoked and no account or authentication setting was changed. The initial automatic approval check timed out; the permitted single retry succeeded. Native extraction quality remains unmeasured, rather than being replaced by a different model or inferred from unit tests.

The diagnostic runner now accepts `--batch` for a separate frozen two-case corpus. One case combines two explicit personal preferences with a quoted third-party opinion and an unbound repository fact. The other places an assistant experiment, an unrelated acknowledgement and an explicit project decision in three distinct conversations. Their rubrics ask whether boundaries, scope, exceptions and evidence attribution survive consolidation. Expected answers and recall probes are withheld from inference. The original six-case corpus and its hash remain unchanged. The new corpus hash is `4ef4d98a8a628390b729f9a0b5a4c7ff2a9ff83995e398a48144a4c94a617059`.

The evaluator captures separate episodes into the real queue and invokes the learner once. It reports expected/reviewed episode counts and per-state job totals. A partial batch can return a valid empty response while leaving source episodes queued; the grader now marks completion false and all quality/recall checks inconclusive in that case. It does not award a successful abstention or expose such a case for semantic grading. Oversized diagnostic groups are rejected before inference.

All **13 evaluation tests** passed, including new mixed-session, partial-batch and oversize cases; the previous 239-test full memory run plus this follow-up cover 242 distinct checks. CLI and standalone runner type checks passed. Both suites' dry runs reported zero native calls and their expected hashes. The frozen batch corpus itself has no real-model outputs or semantic grades. The installed app and daemon remain unchanged; the release gates remain unmet.

## Round seventeen: let the owner correct an overbroad scope

An owner can now narrow a personal memory to one known, included project through the existing rolled-back preview and one-use apply capability. It creates a scope audit and revision while preserving claim text, conditions, evidence and uncertainty. A regression with two independent source sessions exposed a lost-support bug: copying only the record's first evidence dropped later corroboration. Narrowing now carries all existing support roots to the restricted meaning without adding a new user confirmation. Conflicts with the destination's project knowledge appear in the preview and hold both claims for review. Owner controls remain available when Learn and Recall are off.

The store invalidates dependent notebooks and queued/in-flight reviews of the old evidence. A late broader proposal is refused, and a later recall in a different project contains a withdrawal for the previously supplied revision. Earlier native context remains in its conversation. Scope audit survives restart and is attached to the memory's deletion lifecycle. Unknown/excluded destinations, stale previews, a foreign owner, project-to-project moves and scope expansion are refused. Agent tokens cannot browse project labels or invoke the owner narrowing action.

The owner picker searches bounded pages of known project names and redacted folder paths. Labels are stored separately from project IDs and omitted from agent records and recall packets. Worktrees share a common repository label; an explicit clone alias keeps the first label. The UI preserves its search when backing out of a preview. Late search replies cannot restore older choices. A privacy refresh now reloads an already open picker, and an unavailable selection refreshes the choices without selecting a replacement. A changed revision must be reviewed again. Return in search and paging only browse; Escape backs out one level; pending application disables duplicate submission and dismissal. The real DSH terminal is unchanged.

Validation covered **252 backend tests across 21 files** (242 memory checks plus 10 companion-intelligence checks) and **35 distinct desktop tests across four files** over the targeted runs. CLI type checking, scoped Flutter analysis, CLI release bundling and the bundled version smoke check passed. Synthetic light/dark renders cover 100%, 160% and 200% text at short/narrow window sizes with long names and paths; [picker](../research/2026-10-01-memory-scope/project-picker-dark-2.0x.png) and [preview](../research/2026-10-01-memory-scope/scope-preview-light-1.0x.png) examples were visually inspected. The normal macOS debug review build passed with the Apple Silicon renderer and strict deep signature verification. These widget renders do not verify physical native IME or VoiceOver behavior. The installed app and daemon were not changed or launched.

This is still a development-gated prototype. No real provider inference was run during this round; the selected native login was signed out at the last check. Semantic quality, cross-framework task benefit, explicit usefulness feedback, fuller native lifecycle coverage, legacy lesson migration and production rollout remain unfinished. The published-programmer council remains a synthesis of sources, not actual participation or endorsement.

## Round eighteen: collect usefulness feedback without reinforcing a false memory

The owner library now shows up to ten recent recall contexts for a memory revision and supports Helpful, Not helpful and Clear feedback. A context binds the receiving engine/session/project, explicit task/branch scope and known conditions. Repeated prompt-hook, MCP and manual recalls in that context share one rating. Feedback does not change the claim, add independent evidence, prove native delivery or automatically change retrieval ranking. This applies the council's measurement and feedback-loop checks as our own design review; no practitioner participated in or endorsed this review.

The owner capability path previews and applies each explicit rating. Per-context versions reject concurrent changes, including after a cleared rating. The detail stays mounted, preserves keyboard focus and offers a refresh after an uncertain response without retrying the write automatically. Owner/connection changes and a changed knowledge snapshot reject stale work. Long names and paths wrap at 100% and 200% text in both appearances; [dark](../research/2026-10-01-memory-feedback/feedback-dark-2.0x.png) and [light](../research/2026-10-01-memory-feedback/feedback-light-2.0x.png) renders use synthetic data.

Receiver privacy is checked before history deduplication and limits, in addition to source visibility. A private receiving session removes its owner history and feedback without reviving them on reinclusion. The original privacy policy is also checked when an older daemon wrote it without the new cleanup hook. No native receiver ID or prompt is copied into receipt metadata. Feedback expires with its referenced receipt, even when a newer receipt in the same context survives; corrected revisions do not inherit ratings. Deletion uses foreign-key dependencies. Older receipts without recorded receiver authority do not acquire guessed context during migration.

A real extraction attempt exposed a separate native-login defect. Claude's auth check succeeded in the shell but reported signed out with the memory adapter's restricted environment. Read-only A/B checks identified missing OS login names. The adapter now supplies USER and LOGNAME from `os.userInfo()`, ignoring inherited claimed values and continuing to exclude ambient provider credentials. A regression failed before this change and passes afterward. This corrects the interpretation of earlier signed-out checks: the restricted environment could hide an existing native login.

The frozen six-case diagnostic was retried with the unchanged corpus and selected Claude `opus`/`high` on native 2.1.286. It [stopped on its first case](../research/2026-10-01-memory-native-quality-blocked.json) with no completed extraction or semantic credit. A separate synthetic READY probe [identified a rejected seven-day usage limit](../research/2026-10-01-memory-native-quota-diagnostic.json). Native frames included a rejected rate-limit event, an assistant `rate_limit` error, and an error result whose subtype was nevertheless `success`. The adapter now maps these to the existing budget-deferred backoff and refuses any later purported answer; allowed/warning telemetry still permits extraction. No account/model fallback, personal transcript, production memory write, or credential change was used. No more provider attempts were made after identifying the weekly limit. Real-model quality and batch usefulness remain unmeasured.

Final targeted validation passed **272 tests across 22 memory and companion-intelligence files**, **40 guard fuzz checks** run separately, and **43 desktop tests across four files**. Type checking, scoped Flutter analysis, the icon audit, release bundling and the bundled version check passed. The normal macOS debug review build passed with its local signature; it was not opened or installed. Four synthetic feedback renders were visually inspected. A [synthetic benchmark](../research/2026-10-01-memory-feedback-performance.json) at 10,000 memories and 5,000 retained receipts measured warm p95 30.223 ms, fresh-worker p95 67.335 ms and zero timeouts over 310 requests; it is neither model latency nor comparative retrieval-quality evidence.

Local full-suite runs did not produce one clean run on this host. The first used an incomplete PATH; its two failing files passed all 100 checks with the normal PATH restored. The next run had timing failures in twelve files; all 412 checks in those files passed alone with one worker. A final one-worker full run passed 7,748 tests with two failures (a hook registry missing at the assertion and an installer timeout), plus 38 skips; those two files then passed all 48 tests unchanged. These rechecks do not relabel the failed full runs as passing. The final native quota cases were verified in the 272-test focused run. The follow-up PR must also record the result of its manually dispatched CI at the exact commit.

PR #521 merged the previous checkpoint into main as `3988b8bbf`. This follow-up preserves the development flag, experimental-companion toggle and watching-consent gates. Task/session navigation, a collection-wide Helping now view, learned retrieval improvements, maintained notebooks, legacy-lesson migration, full native lifecycle verification and the held-out release evidence remain unfinished. The installed app, daemon and firmware remain unchanged.

## Round nineteen: make the coding-memory preview an explicit app setting

The owner can now choose **Settings → Experimental → Coding memory** instead of setting an environment variable. The choice defaults off and persists separately for each account on this computer. An explicit saved off overrides the old environment default. Changing it stops the current learner before applying the new choice, keeps saved memories, and retains the companion/watching and selected-model requirements. Opening settings reads the choice without creating a memory database or launching inference.

The local preference API uses the existing verified owner-process connection, rejects agent tokens and body-supplied owner authority, checks the expected revision, and rechecks identity after asynchronous work. The UI waits for acknowledgement, clears the old account's choice, ignores late replies, and offers a read after an uncertain save without automatically repeating the write. A saved opt-in remains manageable with companions off; only its two preference actions pass that gate, while memory browsing, recall and agent tools remain off. The setting explains that learning is paused in that state.

Two regressions failed before their fixes: companion-off routing prevented clearing the saved choice, and an already open Memories viewer stopped checking after an unsupported response. The viewer now discovers an enabled local service during its ordinary read refresh. This neither sends terminal input nor replays conversation history. The new regression's first post-fix run exposed an unanswered legacy-lesson fixture request; answering that request removed its pending test timer. Strict type checking also required the new route fixture's caller verdict to retain its literal error type.

Validation passed **108 desktop tests across eight files**, **27 local routing/settings tests across three files**, CLI type checking, scoped Flutter analysis, release bundling and the bundled version smoke check. The normal Apple Silicon macOS debug build passed with its local signature. Synthetic [light](../research/2026-10-01-memory-setting/setting-light-1.0x.png) and [enlarged dark](../research/2026-10-01-memory-setting/setting-dark-2.0x.png) renders cover the setting at 100% and 200% text, including a narrow window. These are widget renders, not physical VoiceOver/IME validation. The full CLI run initially hit installer timeouts; a separate loopback probe proved the sandbox denied listening with `EPERM`. That run was stopped and the suite restarted with the required local-server access; the PR records its final result and exact-commit CI.

At the user's request, the earlier review build and matching local CLI were installed for review. The separate review app was opened at **Companions → Memories**, and the new setting's saved on state was observed through the native UI. The personal library was empty. The later regression fixes rebuilt successfully but did not replace or restart that open app. No public release or firmware was published, no synthetic personal memories were seeded, and no additional native model calls were made. The selected Claude account's last observed weekly limit still blocks semantic evaluation. The full product gates, maintained notebook, usefulness-based ranking and other outstanding evidence remain unfinished. The programmer council continues to mean our source-grounded review, not actual participation or endorsement.

The first PR #539 CI run passed 8,001 CLI tests but failed the existing `cli.ts` source-wiring check: its timer regex only recognized a callback beginning directly with `void pairLearner`, and its startup assertion predated the dynamic preview guard. The check now locates the two owned timer registrations independently of callback formatting, still requires both inside the master-switch handler, and checks the new preview gates alongside the existing shutdown assertions. No runtime behavior or test was disabled for that correction. The PR records the subsequent checks on the updated commit.

The permitted local full run completed with **8,043 passed, 6 failed and 38 skipped**. One failure was that timer assertion; all **61 checks across the switch, runtime, settings and local settings-route files** passed after its correction. The remaining five failures were the installed OpenCode TUI's missing `--auto`/`--agent` flags; the OpenCode implementation and flag tests are unchanged in this PR. The full local run is recorded as failed, not relabeled by focused rechecks. Native OpenCode compatibility and the memory model-quality gates are separate from the opt-in setting's validation.

Later investigation for [PR #544](https://github.com/autonomous-ai/openharness/pull/544) corrected the
missing-flag interpretation above: both flags appear in the installed binary's stderr help output.
The unchanged test reads only stdout, which is empty. The recorded failures remain failures of that
test; they are not evidence that the installed binary lacks those flags.

PR #539 merged as `7be7ae16afca5ee44da03a8bc14c1effead6eebd` after all four jobs in
[its final CI run](https://github.com/autonomous-ai/openharness/actions/runs/36857274078) passed on
head `a20f41d86aa3d09a3c7f26f9f64f6cf2683b3b4e`. No release was published.

## Round twenty: maintain inspectable project notebooks

Applying the published-programmer council's workspace, evidence and feedback-loop criteria, this
round adds a project notebook as a derived reading aid. This is our source-informed review; none of
the practitioners participated in or endorsed it. Each topic stays inside its exact project, task
and branch scope. Only current active records enter a generated explanation; possible or conflicted
memories remain visible as unresolved records. Statements cite exact source revisions and material
fields. Source conditions, exceptions and validity are inherited independently of the generated prose.
These structural checks cannot establish whether an LLM paraphrase is faithful.

The durable background job shares the existing six-call hourly allowance with extraction. Completed
episodes normally go first; one existing slot can serve a waiting notebook so continuous intake cannot
starve every explanation. Input is bounded to 24 records and 48 KB, while coverage counts include
omitted records. Owner browsing paginates the originals independently. No new inference budget or model
selection was added. Leases bind source snapshot, privacy generation and selected companion context;
interruption, account/model changes and stale results cannot publish. Correction, forgetting,
exclusion and validity boundaries clear or hide stale pages. Forgetting the last record removes its
derived index entry. An older writer's invalidated page can be rebuilt before its next validity deadline.

Older stores are indexed in batches of 50 records while learning is enabled. Migration does not copy
source prose or make a model call. Individual memories remain available before indexing and while
learning is off. Owner-only notebook routes retain verified caller and identity rechecks; agent tokens
cannot browse them. Tests exercise a bundled worker from capture through extraction, notebook
publication, owner reading and forgetting, plus owner changes during pending reads.

**Project knowledge** now opens a [notebook index](../research/2026-10-01-memory-notebooks/notebooks-dark-1.0x.png).
A [page](../research/2026-10-01-memory-notebooks/notebook-light-1.0x.png) names its project and scope,
shows partial coverage, and links every statement to its source memory. Conditions and exceptions stay
visible alongside the explanation. Source links reuse the existing evidence, correction and forget
dialog. Read-only navigation cannot send terminal input or start inference. Late page/paging replies
cannot reopen a dismissed page or restore another account's content. After an invalidated index is
refetched, Back restores the list position and initiating control's keyboard focus.

Validation so far passed **335 backend checks across 26 files**, then **22 notebook checks** including
three new record/byte-limit and old-store migration cases. **67 desktop checks across six files** pass.
The first viewer run failed two synthetic fixture assumptions (a missing query map and an overly narrow
inferred map type); both fixtures were corrected. Navigation review found an early scroll restoration;
the delayed-index regression now covers awaiting the read before restoring focus and position. Type
checking passed. Scoped Flutter analysis found only missing braces on the new multiline guards; those
were corrected. The final navigation change rebuilt successfully as a normal macOS debug app with the
Apple Silicon renderer and local signature. The full local CLI run completed with **8,086 passed,
5 failed and 38 skipped** in 642 seconds. All five failures were the unchanged installed OpenCode
flag checks for `--auto` and `--agent`. The run remains failed; this does not establish native OpenCode
compatibility. After rebasing onto `606cdf15a`, **338 backend checks across 26 files** and all **67 desktop checks**
passed, along with CLI and benchmark-runner type checks. The PR records the normal rebased build and
exact-commit CI before merge.

Synthetic renders cover normal and 200% text in both appearances, including narrow windows and long
project paths. The [enlarged page](../research/2026-10-01-memory-notebooks/notebook-light-2.0x.png) and
[source conditions](../research/2026-10-01-memory-notebooks/notebook-sources-dark-2.0x.png) were visually
inspected. These do not verify physical native IME or VoiceOver. The open review app was left alone;
no synthetic memories were written into the user's store and no native model was called. At the last
UI observation, the selected Claude account still had no weekly allowance. Real extraction and
notebook quality, cross-framework task benefit, usefulness-based ranking, task/session navigation,
legacy lesson migration and the held-out rollout gates remain unfinished. The feature stays opt-in.

A [synthetic scale check](../research/2026-10-01-memory-notebooks/performance.json) used 10,000 records
across 100 queued notebooks and 10 projects. Over 220 owner reads, warm p95 was 21.882 ms for the index
and 10.910 ms for a page; fresh-worker index p95 was 66.106 ms, with zero request timeouts. The original
`tsx` command could not open its local IPC socket in the sandbox; `node --import tsx` ran the same
local-only diagnostic without that socket or elevated access. No actual user data or inference was
used. This measures queued-page browsing, not generated-prose cost, model latency or semantic benefit.
Reproduce with `cd cli && node --import tsx scripts/memory-benchmark.ts --notebooks`.

## Round 21 — explicit usefulness without automatic self-reinforcement

The published-practitioner review asks whether feedback changes a future decision without becoming
evidence that a fact is true. The development implementation now uses the owner's Helpful / Not
helpful rating to adjust ordering among already eligible lexical candidates. It shares that signal
across Claude and Codex only for the exact receiving project, explicit task/branch scope and known
conditions. A changed memory revision, different context, ambiguous multi-project request or legacy
receipt without captured relevance stays neutral. Repeated recall and transport retries earn no
additional vote. No actual practitioner participated in this review.

The adjustment is `0.125 * (helpful - unhelpful) / (ratings + 4)`, applied to the lexical score.
This shrinks sparse feedback toward neutral and bounds its influence below 12.5%; it is a provisional
policy to evaluate, not a calibrated probability or evidence of improved coding outcomes. Existing
scope, source visibility, applicability, exceptions, validity and more-specific project requirements
are checked before ranking. The same byte/item limits remain. Clearing feedback removes its effect;
correcting or forgetting the claim also removes the old revision's influence. A rated receipt still
does not prove that a native model received or used its content.

The new relevance metadata uses an additive table so an older writer's receipt inserts continue to
work. One-way keys do not retain prompt text or native receiver session IDs. Existing ratings remain
inspectable; the UI explicitly identifies earlier ratings that cannot guide future recall. The
[normal light view](../research/2026-10-01-memory-usefulness/feedback-light-1.0x.png) and
[200% dark view](../research/2026-10-01-memory-usefulness/feedback-dark-2.0x.png) were inspected.
These synthetic renders establish layout behavior, not native VoiceOver or physical IME behavior.

Regression review found two privacy bugs before the fix: a repeated session exclusion after an
older writer's policy change skipped cleanup, and receiving-project reinclusion could revive its
old ratings. Both regressions failed first. Exclusion, repeated exclusion and reinclusion now discard
that receiver activity before an equality early return, preserving only the opaque withdrawal
receipt. Later activity can begin afresh. Source visibility is checked independently.

Validation passed 317 memory/intelligence checks, then all nine focused usefulness cases including
the additional rated-personal-default versus project-requirement case. All 40 memory viewer checks,
scoped Flutter analysis, CLI type checking and a separate strict benchmark-runner type check passed.
Initial fixture errors (missing required legacy policy columns and an inferred optional condition)
were corrected separately from the two actual privacy failures. The follow-up is restacked on
`3d55daff9`; the final whole CLI run and exact-commit manual CI results are recorded in its PR.

The [scale diagnostic](../research/2026-10-01-memory-usefulness/performance.json) used 10,000 synthetic
memories and 5,000 explicitly rated receiving contexts. Across 310 requests, warm recall p95 was
22.127 ms and fresh-worker p95 was 64.780 ms, with zero timeouts. Reproduce with
`cd cli && node --import tsx scripts/memory-benchmark.ts --feedback`. This measures local performance,
not retrieval quality or real hook latency. No personal store was seeded, native model called,
running app replaced or release published. The held-out real-history and task-benefit requirements,
real notebook faithfulness, native lifecycle coverage and fuller task/session navigation remain open.

## Round 22 — distinguish recall presence from reviewed quality

The next evidence question was whether the evaluation can distinguish an appropriate memory from
any nonempty result. Its original recall probe could not: an unrelated returned record still passed
the presence check. That mechanical result is now explicitly labelled as presence only. The learner
diagnostic also records the exact bounded recall context so a review can examine the text an adapter
would receive, including conditions and exceptions, rather than relying only on record IDs.

An offline review tool binds source fixtures, native output and labels by exact file hashes. It
provides source excerpts, frozen criteria, returned records and query context with blank judgements.
It omits model/arm labels without claiming perfect blinding. Reviewers declare their identity, kind
and independence; the tool does not authenticate those declarations. Unsupported or irrelevant
content, missing required knowledge and unfaithful context cannot receive reviewed-recall credit.
Incomplete annotations remain pending, and an empty or incomplete denominator never becomes 100%.
Semantic judgements do not establish received native context, coding-task benefit or notebook quality.

The latest primary-source research also argues for measuring outcomes and appropriate controls.
The [developer-history study](https://arxiv.org/abs/2608.10319) compares personalization with generic
and mismatched guidance, with limited personalization benefit in its setting. The
[VibeMemBench paper](https://arxiv.org/abs/2609.23570) separates usable prior knowledge from what
memory systems actually supply on executable coding tasks. Their findings inform our comparison
design; neither evaluates Harness. No external dataset has been imported or counted toward our
held-out requirement, and no actual programmer participated in this review.

All **24 extraction/review tests** pass. They cover the old false-positive nonempty recall, irrelevant
extras, missing needs, unsupported memories, unfaithful or missing context, modified files/probes,
changed record versions, duplicate/invented IDs and incomplete extraction. A regression exposed a
validator that rejected a partially filled annotation depending on field order; that case failed
before the fix and now remains pending as intended. An initial missing brace in the test fixture was
also corrected. CLI and standalone runner type checks are recorded with the final PR checks.

The CLI was run against the actual saved quota-blocked diagnostic, using only its frozen synthetic
sources. Its [review result](../research/2026-10-01-memory-quality-review-blocked.json) correctly has
zero completed cases out of six and null memory, recall and abstention rates. A second write to the
same path was refused and the original report hash remained unchanged. The scorer hash was checked
against the source file. No native inference, private history scan, production memory write, app
replacement, firmware change or release occurred. Real model quality and the full release evidence
remain unproven; a reviewed synthetic diagnostic will not substitute for them.

## Round 23 — inspect what was prepared for the current coding session

Bret Victor's [Learnable Programming](https://worrydream.com/LearnableProgramming/) argues for
making program state and behavior visible in context. Our application of that principle is to
show the owner which memory versions Harness prepared for an open coding session, when that
happened, and the conditions attached to them. This is our engineering interpretation of a
published source; Victor did not participate in or endorse this review.

Companions → Memories now includes Helping now. Its session picker uses the live host roster,
including framework, project and known session name. Each selected memory offers Read memory
for the existing evidence/correction/forget editor, plus exact-version Helpful / Not helpful
feedback and clearing. A transport emission remains explicitly unverified delivery. The timestamp
describes the last recorded store preparation, which may precede the current turn; failed host
requests and actual model use are not inferred.

Review found that positive-only receipt history could leave an earlier selection looking current
after a newer empty recall. An additive, content-free latest-attempt row now records empty/off
results too, without creating a full history receipt. The row keeps a one-way receiver key and
bounded metadata, never prompt text, claims or native session IDs. Retention is 30 days and at
most 5,000 receivers. Earlier histories are not backfilled. Reads recheck source and receiver
privacy, current revisions and validity; closed capture-grace sessions are excluded. Receiver
exclusion removes activity, and reinclusion does not resurrect it.

The owner endpoint accepts an optional host agent ID, derives native identities itself and rejects
an identity change during the worker request. A regression test exposed an in-place mutation of
the supplied session object: the check incorrectly accepted the old result before the fix.
The runtime now copies the session snapshot before awaiting. Desktop reads reject late replies,
preserve an explicit session choice, clear invalidated content and never retry a feedback write
after an uncertain response. A library change while previewing feedback prevents application.

All **92 focused CLI tests** passed, as did CLI type checking, strict benchmark-runner checking,
scoped Flutter analysis and the icon audit. The full local CLI run had **8,238 passed, 5 failed
and 39 skipped** in 677 seconds. The five failures are the unchanged OpenCode help checks: the
installed binary emits its help to stderr while those tests inspect stdout. The full desktop run
had **5,232 passed, 4 failed and 15 skipped**. All four failures were reproduced in a disposable
copy of the unchanged base `cf69f796d`: a pending activity timer in `bios_navigation_test`, two
stale Search harnesses/Open Harness tooltip expectations in `search_workspace_test`, and the
watchdog expectation in `workspace_event_isolation_test`. Neither full local run is recorded as
passing. The PR records final rebased checks and the exact-commit manual CI result.

Both native macOS fixture cases passed on Apple Silicon. They exercise keyboard feedback once,
focus return and removal of a previous memory after an empty recall. The actual renderer's
[dark](../research/2026-10-01-memory-activity/activity-native-dark.png) and
[light](../research/2026-10-01-memory-activity/activity-native-light.png) captures were inspected.
Headless widget fixtures also cover narrow windows and 200% text, loading, emptiness, errors and
identity changes. Flutter logged a failure to foreground the native fixture, although both tests
and captures completed; physical AppKit input, IME and VoiceOver remain unverified.

The [synthetic performance diagnostic](../research/2026-10-01-memory-activity-performance.json)
used 10,000 memories, 5,000 retained receivers and 128 open-session identities. Across 310 recalls
and activity reads, warm recall p95 was **23.061 ms**, fresh-worker recall p95 **49.793 ms**, and
the activity read p95 **3.682 ms**, with no recall timeouts. Reproduce with
`cd cli && node --import tsx scripts/memory-benchmark.ts --activity`. These are local lexical
performance measurements, not semantic quality, native delivery or coding-task benefit.

No private history was scanned, native model called, production memory seeded, installed review
app replaced or release published. Real extraction and notebook faithfulness, cross-framework
task benefit, native lifecycle coverage, task/session navigation and the held-out rollout gates
remain open. This change makes existing recall inspectable; it does not establish those outcomes.

## Native compatibility and first consented capture check — October 1

The next check stayed on native transport and real-data intake. Claude Code 2.1.286 print-mode
and Codex 0.159.3 trusted interactive probes both carried fresh synthetic memory on the next
user prompt after resume, manual compaction and a model change. The
[native results](../research/2026-10-01-memory-native-lifecycle.json) preserve the outgoing-request
observations and their limits. Codex also sent unidentified requests without the marker; this
does not certify every request, automatic mid-turn compaction, account/profile changes or
usefulness. No actual practitioner participated in this validation.

The prompt-recall gate now includes Codex 0.159.3. Its background extraction gate remains
unchanged: a separate restricted-command probe received startup error items for missing old-model
metadata and for the disabled code-mode host on a current model. Explicitly disabling the two
code-mode feature flags did not remove that error. The adapter still rejects error items and does
not choose a different model or enable execution. The probe's initial classifier was too permissive
about startup errors; it was corrected before any extraction compatibility change. The saved
diagnostics report failure, including normal text output that followed an error.

All **156 focused memory and hook checks** passed, and CLI type checking passed. The new
0.159.3 prompt-recall case failed before the gate change. An initial sandboxed hook test run
could not bind its loopback servers and was stopped; the socket-enabled rerun passed. Both
checked-in lifecycle probes were run with disposable native configuration, fake credentials
and local mock endpoints. Native Codex folder/hook trust was reviewed under the user's existing
explicit authorization. No installed app or production configuration was replaced.

The user then explicitly requested testing on their real sessions. A private, read-only audit of
the live memory store found no learned memories and deferred/unavailable inference. The selected
companion was Codex / gpt-6-astra / max; the corresponding native account reported exhausted usage.
The original transcripts and selected excerpts were kept outside the repository.

A private replay of two recent coding sessions through the actual capture implementation preserved
all **26 user messages**, but **20 belonged to source_incomplete episodes** and only six to queued
episodes. Twelve incomplete transitions were caused by the bounded-chunk limit; fourteen first
record-incomplete transitions were also observed. These are capture-availability counts, not
memory-quality percentages. An independently authored six-item expectation list and abstention
checks are saved privately for later native extraction. No Tim response or extraction-quality
score was fabricated, and no source text or expected personal memory was seeded into production.
The next data-intake work must preserve useful instructions in long sessions while retaining
explicit uncertainty about genuinely missing context.

### Long-session capture repair

Four structural regressions reproduced the loss before the fix: a byte limit, a source-count
limit, oversized user input followed by intact instructions, and a missing tool result between
two intact instructions. Capture now closes intact segments as bounded context, isolates
unreadable records, and carries that distinction through restart until a native turn boundary.
The v4 extraction prompt describes the gaps. The durable publication check permits only explicit
user-stated preferences, constraints, decisions or learning goals from bounded context; editing
lease metadata cannot authorize assistant evidence, inferred preferences or execution outcomes.

A [fixed-window before/after replay](../research/2026-10-01-memory-consented-capture.json) used the
same two consented sessions and the original cutoff. Before: 26 user events captured, six queued,
20 source-incomplete. After: all 26 captured and queued, with 20 explicitly marked bounded and
six in complete context. All six manually authored expected-memory source spans are now available
for learning. This proves availability only: no native model response, paraphrase-quality score,
task benefit or production backfill was produced. Raw transcripts, quotations and expected personal
memories remain private and outside git. The first comparison script used the wrong sample ID field;
that harness error was corrected before recording the fixed-window results.

Store schema 2 prevents old readers from treating these queued segments as complete conversations.
The additive upgrade preserves existing records, sources, controls and exclusions; the previous
main revision was also run against a disposable upgraded store and returned `schema_unsupported`.
An older app cannot use the upgraded coding-memory store; it is not an automatic downgrade path.
The installed review app and production store were left untouched. Historical source-incomplete
jobs are not silently reclassified or replayed.

Validation: the final memory suite passed **346 checks** across 26 files, including upgrade
preservation, unsupported-version refusal and restart across a gap. Type checking passed.
A fresh host check at 16:21 UTC showed the user had switched the companion from Codex to
**OpenCode**, which the current memory intelligence does not support. Both existing Claude and
Codex accounts still reported exhausted weekly limits; neither was substituted for the selected
companion. OpenCode integration is now the immediate requirement for the requested end-to-end
test. Actual Tim extraction and the held-out quality/rollout gates remain open.

### OpenCode extraction transport, isolated and not enabled

The capture repair merged in [PR 557](https://github.com/autonomous-ai/openharness/pull/557)
as `a6f2bd0ebcfebfdfa594460609942a99c62ee204` after all four CI jobs passed for the
exact submitted head. A fresh read of the running app still returned `DAEMONS_OFF`.
No setting, selected model, installed app or production memory was changed to bypass that state.

The new OpenCode adapter requires an explicit snapshot of the selected API account, provider,
model definition and variant. It checks the binding before launch and after output, isolates
native session storage, denies tools, and removes disposable state. Unknown versions, OAuth,
unresolved configuration placeholders, non-bundled provider modules and system managed policy
are unsupported. System policy is refused rather than overridden; native 1.18.34 loads it after
inline configuration. This is a version-specific native transport, not a process sandbox.

The [installed 1.18.34 probe](../research/2026-10-01-memory-opencode-inference.json) invoked the
actual adapter with fake credentials and localhost responses. Normal text passed; forced shell
and question tools were denied and rejected by the adapter, even though the native CLI retried
the model after the denied attempt. Every request exposed zero tools and the selected synthetic
credential/model. No forbidden file was created, and temporary session storage was removed.
Twenty-two focused tests, the full 378-check memory/companion suite and TypeScript checking passed.

This module is intentionally not connected to the companion yet. An authoritative observer for
the foreground OpenCode account/configuration and the host runtime binding still need to be
implemented. OpenCode capture and recall are separate remaining work. No real model evaluated
the user's private sample, and no model-quality, useful-memory or task-benefit claim follows
from the transport checks.

### OpenCode foreground binding and companion integration

The 1.x Harness plugin now observes the selected companion's native request. It asks the host
before inspecting credentials; the host grants a five-second, one-use challenge only for the
process-owned companion session while Coding memory, watching consent and Learn are enabled.
The observed provider, model alias, API credential and native variant stay in volatile memory.
No credential enters the session registry, saved profile, browser/device frames or research logs.
The binding expires after fifteen minutes and is withdrawn on an owner, process, session, selected
model or authorization change. Identical model credentials cannot carry a result across Harness
owners. Only the latest submitted `chat.message` and its selected agent may observe request settings.
Internal title, summary and compaction requests do not replace the user's selection.

`CompanionIntelligence` now uses this binding for OpenCode extraction and companion reasoning,
with checks before launch and after completion. It never guesses a provider from the machine's
default configuration or falls back to Claude/Codex. This requires a fresh foreground request
from the updated plugin; already-running OpenCode processes must restart to load it. The native
version remains pinned to 1.18.34. OAuth/function-based credential wrappers, managed system
configuration, other SDKs and OpenCode 2.x remain unsupported.

The [native binding probe](../research/2026-10-01-memory-opencode-binding.json) kept a disposable
OpenCode process alive, observed a real foreground request through the generated hook, and then
ran the actual companion extraction against a localhost model. Both a native API login and an
explicit provider-key override used the expected account, provider model ID and `high` variant.
Off sent no credential snapshot and launched no extraction; scratch storage was removed. The
first probe exposed the 1.x SDK's missing health wrapper, so the hook now uses that pinned SDK's
in-process HTTP client for `/global/health`; the corrected path was exercised natively.

A further native manual-compaction check caught an internal request replacing the user's `high`
variant with the compaction default. Matching the request to its submitted message and agent fixed
that regression. Both native account cases now compact and then extract with the original selected
variant, while compaction itself requests no observation grant. Synthetic continuations are also
excluded by the message binding; automatic compaction remains uncertified. The hook boundaries are
defined in the [pinned plugin interface](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/plugin/src/index.ts).

Validation: **516 tests across 34 affected suites**, TypeScript checking and the CLI bundle passed.
The first unprivileged hook-server run could not bind localhost (`EPERM`); the permitted run passed.
The required real multiplexer suite ran in a separate temporary tmux 3.7c server: nine checks
passed, including discovery for Claude 2.1.287, Codex 0.159.3, OpenCode 1.18.34, Pi 0.85.1,
Hermes 0.18.0 (2026.7.1), Grok 1.0.44 and its `agent` alias. Nine unavailable engine rows were
skipped. This verifies discovery/lifecycle behavior, not those engines' memory-inference support.
These are synthetic integration results. The host's ownership/consent inputs are supplied by the
fixture and tested separately through the real hook server. The installed review app, its settings,
and personal memories remain unchanged. OpenCode source capture and prompt recall, real-user
extraction quality and the broader task-benefit/rollout requirements are still open.

### OpenCode native capture and collection recall

OpenCode 1.18.34 conversations now enter the same consent-controlled capture queue as Claude
and Codex. The host supplies the database and current session/workspace identity; the reader
checks native ownership, parent-session exclusion, version and directory before reading that
session. SQL bounds both returned JSON bytes and part counts. The persisted cursor survives
host restarts, detects database replacement and changed/deleted messages, and keeps a monotonic
position after native undo cleanup. Learn-off, session exclusion and project exclusion intervals
are not backfilled when re-enabled.

Forked messages retain their original native timestamps despite receiving new row IDs and SQL
insertion times. Comparing those timestamps with the new session's creation time excludes copied
history. Generated summaries, compaction markers, synthetic prompts, ignored parts and reasoning
are not fresh user evidence. Quoted user material remains a reference; tool calls and results
have separate roles and do not manufacture verification. Streaming replies wait for native
completion. Interrupted or incomplete context admits only the queue's existing bounded-context
rules, preserving readable instructions around oversized results.

The verified OpenCode collection session can now retrieve shared personal memories through its
existing scoped MCP tool. Receipt/activity schemas and desktop labels recognize OpenCode.
Automatic prompt delivery remains disabled for OpenCode pending an outgoing native-model-request
test; capture and extraction transport do not establish prompt delivery or useful recall.

The reproducible `cli/scripts/memory-native-opencode-source-probe.mjs` uses the real 1.18.34
binary, an isolated HOME/database, fixture-only file permission and synthetic localhost responses.
It recorded a native completed `read` call, fork, manual compaction and undo, then exercised the
actual capture implementation against the running database: six original role-separated sources,
zero duplicates on a repeated poll, zero copied-fork sources, two fresh fork sources, zero summary
sources, and capture suspended while undo was active. The sanitized source recording is committed
under `cli/src/memory/__fixtures__`; no personal conversations or credentials are included.

Validation: 401 memory checks, TypeScript checking, CLI bundling, 56 desktop memory widget checks
and targeted Flutter analysis passed. The full CLI suite ran 8,480 tests: 8,433 passed, 45 skipped,
and two unrelated tmux probes failed near their timeouts while another suite was active on this Mac.
Both complete tmux suites then passed all 36 checks with one worker. The required isolated native
tmux suite passed nine checks and skipped nine unavailable engine rows. No app, firmware or release
was installed by this increment. Real-user extraction quality remains unmeasured: the prepared
private sample is waiting for explicit approval of its selected external model destination.

### Shared recall through a native OpenCode adapter

The memory library remains owned by the Harness profile and project. The new authenticated
`/api/hook/memory-context` endpoint accepts a query and an observed framework version; it resolves
the live process and session before invoking the existing shared memory runtime. It does not accept
caller-selected profile or project authority, and it never falls back to ownership inferred from a
pane alone. Recall does not require a provider credential, an extraction-model binding or Learn
being enabled. Existing experimental, Recall, source-privacy and project controls still apply.

OpenCode 1.18.34's adapter inserts historical context into the outgoing user-message conversion,
without writing it to native conversation storage. It revalidates recall for every request, removes
its prior transient parts, bounds responses and abandons an optional lookup after 700 ms including
native-version discovery and host transport. The core retains its 200 ms deadline. Neither deadline
is a measurement of live-host latency. Receipt acknowledgement means the adapter handed over context;
the product continues to label model delivery unverified.

The native probe exposed a lifecycle distinction: `experimental.chat.messages.transform` also runs
inside compaction. A preceding compaction hook now suppresses recall for that summary input. The
recorded automatic-continuation hook and native synthetic-part marker allow the ordinary agent's
next request to obtain freshly retrieved context for the last actual user request. A newly submitted
request replaces that query, including when it contains only files. Unknown releases, missing host
ownership, unavailable memory and late responses continue without added context.

`cli/scripts/memory-native-opencode-recall-probe.mjs` exercised the production plugin and shared
runtime/store with the real 1.18.34 binary and a localhost mock model. The seeded memory cites a
synthetic Claude user source. The outgoing OpenCode request received it with Learn off and Recall
on; turning Recall off, hiding the Claude source, using another session or returning an unavailable
service withheld it. An explicit correction replaced the old revision on the next request, and
forgetting removed it. Both manual and automatic compaction requests contained no injected memory;
the automatic continuation received fresh context. SQLite contained zero saved injected parts after
all phases. The complete sanitized hook shapes and results are in
[`opencode-1.18.34-recall.json`](../../cli/src/memory/__fixtures__/opencode-1.18.34-recall.json).

These are transport and state-transition checks with a seeded proposal, not semantic extraction or
task-benefit results. The native probe uses a fixture HTTP/process binding; production endpoint
authorization is tested separately. Interactive TUI delivery, overflow replay and the provider
matrix are not certified by this recording. Cross-framework runtime tests additionally verify that
Codex and OpenCode see the same corrected record ID/revision and the same deletion. No installed app,
global plugin, live memory, provider setting, firmware or release was changed by this increment.

### One user submission stays one source after native overflow recovery

The real OpenCode 1.18.34 binary exposed a capture bug when a localhost mock provider returned a
context-length error. Native recovery compacted the history and copied the pending user request with
new IDs and timestamps, without marking it synthetic. Capture counted that single submission twice.
That would let a framework retry look like independent support for a lesson.

The existing plugin now stamps submitted parts with Harness-owned origin metadata containing only
the native session/message IDs and a schema version. Native recovery preserves that stamp. Capture
excludes the copy; a genuine later submission remains eligible, even when its text repeats an earlier
request. Only a valid origin in the bound session can establish a fresh submission. The native model
request contained no origin metadata. Stamping does not turn on learning, recall or model binding.

For existing sessions without stamps, the read-only reader recognizes the first user record after a
successful automatic overflow compaction from native causal metadata. The previous-user lookup uses
the recorded `(session_id,time_created,id)` index. In a 10,000-message synthetic query comparison,
median reads at the beginning, middle and end stayed approximately 1.3 ms, similar to the pre-change
reader. This is an in-memory SQLite query measurement, not live capture latency. Manual compaction,
non-overflow compaction and failed summaries do not trigger this fallback. An unmarked new request
after a process crash between compaction and replay is ambiguous and is conservatively withheld;
newly stamped submissions resolve that ambiguity.

The native source probe now exercises overflow, forks, new fork instructions, manual compaction and
undo. Both stamped and unmarked recordings yielded one source for the replayed user statement;
restarting capture yielded no duplicate. Regression cases also cover enabling learning between the
original and copied request, genuine repetitions, foreign origins and missing compaction records.
The raw synthetic records and exact source hashes are in
[`opencode-1.18.34-overflow.json`](../../cli/src/memory/__fixtures__/opencode-1.18.34-overflow.json).

Recall follows the verified original submission through overflow recovery and retrieves fresh
context. The updated native recall recording shows the same shared Claude-sourced memory in the
original and retried OpenCode requests, none in the compaction request, and zero injected parts in
native storage. Its correction, deletion, source-privacy and Recall-off checks still pass. These
recordings demonstrate transport and source handling; they do not measure semantic extraction or
task benefit. They do not certify interactive TUI delivery or all provider configurations.

The first full CLI run passed every test assertion but failed on an unrelated fixture exception:
the devices-command test server sent HTTP 200 headers before attempting a 404. Its default content
type is now set without prematurely sending headers. No product device behavior changed.

This change prevents new duplicate capture; it does not rewrite previously saved evidence or
memories. No live memory, installed app, global plugin, provider setting or release was changed.
The real-session quality sample still requires explicit approval for its external model destination.

### Keep the companion available for continuous learning

A read-only completion audit found a live memory service with Learn and Recall enabled, learning
waiting for a model, and capture at its bounded backlog limit. The selected collection conversation
was saved as stopped. This does not establish whether that specific stop was manual or automatic.
It exposed a reproducible lifecycle gap: the collection's ten-minute idle timer stops its native
runtime even when background coding-memory learning remains enabled. OpenCode requires that live
runtime for its observed account/model binding; cached names cannot replace that authority.

The collection now remains open while its current owner has authorized background learning. This
applies equally to Claude, Codex and OpenCode, including time between reviews or while work is
deferred. It does not send a keepalive prompt, launch a model request, reopen a stopped conversation,
switch engines, retain provider credentials on disk or enlarge the queue. Normal idle shutdown
resumes when learning is disabled. Explicit stop and experiment-off still take precedence, and
account or watching changes immediately revoke the memory runtime's keep-open requirement.

The regression first failed for all three engines: a synthetic idle collection was stopped despite
its background-use requirement. After the fix it stayed live for three idle intervals, with no
prompt or resume calls, and stopped on the next check after learning was disabled. Runtime checks
cover an empty queue, Recall-only mode, identity changes, watching/experimental-off and pause.
This is lifecycle validation with synthetic state. The live stopped conversation and its backlog
were left untouched; a fresh model connection and real-user extraction-quality validation remain
necessary before claiming end-to-end completion.

### Claude 2.1.287 compatibility — October 2

The installed Claude release had advanced to 2.1.287 while the extraction and prompt-recall
allowlists still stopped at earlier native observations. The actual production extraction adapter
initially refused it as `claude_version_uncertified`, with zero provider requests. This prevented
learning through that selected companion runtime; it was not evidence of a model-quality failure.

The [native recording](../research/2026-10-02-memory-claude-2.1.287.json) now covers this exact release.
A disposable launcher redirects only native home/config/provider environment, forwards the actual
version and unchanged production arguments, and uses fake credentials against localhost. The real
adapter accepted the synthetic completed response with an empty tool catalogue, omitted the
workspace-instruction canary, and rejected a provider-sent Bash attempt before any fixture hook,
MCP command, or shell sentinel was written. The selected mock model and effort remain explicit.
The separate native lifecycle probe observed fresh context on the next prompt after resume,
manual compaction, and a model change.

Only 2.1.287 is added to the existing tested versions. Unknown releases still decline automatic
extraction and prompt delivery; explicit scoped recall remains available. Host-bound receipt tests
and shared correction/forgetting checks cover the new Claude version alongside Codex and OpenCode.
No real account, model selection, conversation, installed application, or release was changed.
Print-mode transport is the measured boundary: production account/profile changes, interactive TUI
paths, semantic quality, and coding-task usefulness are not established by these mock observations.

### Stop repeating a provider's non-retryable refusal — October 2

A synthetic READY request through the saved OpenCode Muse free model received HTTP 403 with the
provider's `FreeTierError`: this route was restricted to use within OpenCode. No extraction case
completed. This is a provider refusal, not a memory-quality score. A similar custom-agent restriction
is [reported upstream](https://github.com/anomalyco/opencode/issues/50627); that report does not prove
the cause of this particular request. No private conversations or personal credentials were supplied.

The production adapter previously turned this error into a generic model outage. Its selected
connection remained ready, allowing another background call after the queue's one-minute defer.
The adapter now recognizes the exact recorded, non-retryable refusal. Companion intelligence retains
only an opaque connection fingerprint in memory, stops further background calls on that connection,
and clears the refusal when the observed model, account, owner or native process changes. A routine
refresh of the same snapshot does not reset it; a late error cannot block a replacement connection.
Ordinary outages and quota failures retain their existing handling. No credential or refusal is added
to the saved companion profile, and no alternative model is selected automatically.

Learning keeps its sources queued under the existing retention and capacity limits, preserves the
refusal during the deferred interval, and keeps notebook work pending as well. Memories explains
that the selected provider declined background learning and points to the companion's existing model
control. Reviewing that explanation does not change Learn or Recall. The foreground terminal remains
available; saved memories remain subject to the existing Recall setting.

The [recording](../research/2026-10-02-memory-provider-refusal.json) includes the real OpenCode 1.18.34
binary receiving the same refusal from a localhost mock: exactly one request, no tools, no forbidden
action, and disposable native storage removed. Synthetic integration checks exercise the production
intelligence, learner and queue over more than an hour, then resume on a new connection without
dropping source evidence. These checks establish refusal handling, not semantic extraction quality,
live user learning, or improved coding outcomes. The selected external route was not retried or
bypassed, and real-session quality evaluation remains incomplete.

### Clarify extraction fields after actual local model failures — October 2

Offline reference models exposed ambiguity that the mocked transport checks could
not: evidence paths pointed into source text instead of the proposed memory,
required topic identifiers were null, and verification and validity dates were
invented. The extraction prompt now gives one explicit field contract, including
the difference between required scope/topic IDs and host-owned record identity.
It preserves episode boundaries, source roles, bounded-context restrictions,
scope, exact quotations, contradiction handling and unknowns. Storage, admission,
recall and inference selection are unchanged.

The [local comparison](../research/2026-10-02-memory-local-extraction.md) records
both gains and failures. On the six frozen cases, the same cached 27B model went
from three completed negative cases and no stored memories to six completed
cases, with two of three memories judged supported/useful and correctly recalled.
All seven negative recall probes passed. The third memory still invented an
implementation-only condition for an unconditional preference. A separate frozen
batch check retained both personal preferences correctly, but another batch failed
the unchanged field-coverage guard. Its unrun probes remain unmeasured.

These are attributed agent judgments over synthetic model outputs, not independent
human review, selected-companion certification, real-user learning or coding-task
benefit. The programmer perspectives continue to mean source-grounded design
reviews. No private transcript, live memory, account setting, app or firmware was
changed. The experimental implementation has clearer instructions; the full
memory-quality gates remain unmet.

### Resolve exact evidence in the host, then review meaning — October 2

An actual offline extraction rejected a useful proposal after the model normalized
whitespace in its quotation. The host now supplies bounded source-excerpt references
and resolves selected references into exact original text, source identity and
captured verification. Existing storage, scope, authorship, coverage, size and
durable queue checks remain in force. Unknown references and metadata overrides
fail; legacy quotations still need exact matching. Original source text and episode
boundaries remain available in full. The prompt is versioned `coding-memory-v6`.

The [measured comparison](../research/2026-10-02-memory-source-references.md) covers
unchanged single and multi-episode diagnostic suites with the same local model.
All eight cases completed, retaining six memories judged supported and useful by
the implementing agent; six positive and twelve negative recall probes passed
semantic review. This is development evidence, not an independent or held-out score.

Five consented private excerpts were also processed entirely offline with external
networking blocked on both the driver and model worker. The whitespace failure was
resolved, but semantic review rejected two of six memories for overgeneralization
and treating tentative options as settled. Their private evidence remains local.
All structural presence checks passed, demonstrating why presence alone is an
insufficient quality measure. Faithful real-user extraction, selected-companion
learning, automatic contextual recall and coding-task benefit remain open.

Review against Parnas's module boundaries, Liskov/Wing's behavioral contracts,
Dijkstra's distinction between checks and broader claims, and Knuth's readable
explanations is recorded with the evidence. These remain our applications of
published principles, not reviews or endorsements by those authors.

### Reject prompt-only fixes that still change the user's meaning — October 2

The offline diagnostic runner now records complete versus bounded source context
and rejects review/report boundary mismatches. A frozen eight-case corpus exercises
defaults and overrides, polite requests and exploratory questions, tentative and
accepted numbers, quoted assistant plans, and limited control changes.

The [measured comparison](../research/2026-10-02-memory-meaning.md) keeps failures
visible. Production v6 completed seven cases; one positive recall omitted a permitted
override and another case failed admission. Two candidate prompts completed all
eight cases but each retained two records rejected for overstating the source.
The implementing agent judged five of seven memories and four of six positive
recall packets supported; all eighteen abstention probes passed. An approved offline
private check also failed to show improvement. Neither candidate was promoted.

Production extraction remains v6. Diagnostic typechecking and 27 tests passed;
the retained changes are evaluation coverage and attributed evidence. Semantic
checking of proposals is a future experiment, not a shipped safeguard. Selected
companion learning, automatic contextual recall, independent quality assessment
and improved coding outcomes remain unproven. No app or firmware was released.

### Give receiving agents the supporting words — October 2

A [separate model review](../research/2026-10-02-memory-source-audit.md) accepted
both subtle interpretation errors from the earlier extraction experiments. It is
not promoted to an automatic admission gate. Instead, native prompt and collection
MCP recall now use `coding_memory_sources`: exact selected evidence excerpts with
captured author, engine, time, verification limits and memory revision/scope. The
generated claim and action still support search and the owner library, but are not
included in this context format. Existing direct summary callers retain their
contract. Extraction remains v6; no schema migration or extra model call is added.

Selection keeps the existing account, project, task, branch, applicability, privacy,
revision and deletion rules. Excerpts shared by several records appear once. The
same byte cap applies to the complete packet: an oversized candidate is omitted
whole, with no qualification trimming or fallback to a generated instruction.
Explicit viewer corrections retain their field labels and replace old evidence.
Missing or altered source evidence cannot be invented by serialization. The wrapper
identifies historical excerpts as fallible context, not current instructions or
permission. Surrounding source context may still be absent.

The [synthetic coding comparison](../research/2026-10-02-memory-source-recall/comparison.json)
records two of five assessable tasks passing with generated summaries, three with
summaries plus excerpts, and four with excerpts alone. The actual store format also
passed four of five. The last two arms were added after inspecting the earlier
results; this is adaptive development evidence, not a held-out improvement claim.
An underspecified sixth task and strict-JSON failures remain visible. The model
still removes unrelated export actions despite the original qualification.

Native localhost probes observed exact context in [Claude 2.1.287](../research/2026-10-02-memory-source-recall/native/claude.json)
and [Codex 0.160.0](../research/2026-10-02-memory-source-recall/native/codex.json).
Codex also made an unidentified request without context; its runtime allowlist is
unchanged. The [OpenCode 1.18.34 probe](../research/2026-10-02-memory-source-recall/native/opencode.json)
exercised the shared store/runtime and real plugin through correction, forgetting,
privacy, Recall off, manual/automatic compaction and overflow replay. Its isolated
startup originally waited for npm registry retries before loading the local plugin;
the SDK-free fixture now explicitly uses npm offline mode under the same OS network
block. No installed engine configuration changes.

This applies the council's evidence and behavioral-contract principles without
treating a fluent paraphrase or a passing transport test as proof of intent. Private
real-user quality, independent review, native lifecycle coverage, paired framework
workflows and the broader rollout gates remain open. No app or firmware release.

### Codex 0.160 prompt recall lifecycle — October 2

The [native lifecycle report](../research/2026-10-02-codex-memory-0160/lifecycle.json)
observed the complete source-excerpt packet on each of five user prompts across
manual compaction, restart, model change and native configuration-profile selection.
Each prompt receives a fresh marker; old context in history cannot satisfy that check.
The first [incomplete run](../research/2026-10-02-codex-memory-0160/lifecycle-incomplete.json)
exhausted its initial deadline during individual hook review. It remains failed.
The probe now allows that setup time, stops on a timeout even when the native CLI
exits zero, and checks ordered PreCompact/PostCompact events instead of assuming
every provider uses the remote compaction endpoint. Native checks use synthetic
localhost responses, fake credentials and disposable homes with execution disabled.

Codex 0.160.0 is added only to prompt recall. A lesson captured through Claude can
be recalled through the verified Codex adapter while learning is off, with the same
ownership, correction, deletion and recall controls. Real-session delivery receipts
still say unverified. Five additional native requests omitted context; their purpose
is not established by the metadata probe. Configuration-profile selection does not
certify a real login/account or Harness-owner change.

Restricted background extraction remains uncertified. Both the
[original command](../research/2026-10-02-codex-memory-0160/extraction-failed.json)
and [explicit Code Mode disable flags](../research/2026-10-02-codex-memory-0160/extraction-flags-failed.json)
produced a startup error with the current model. The installed catalog specifies
Code Mode for that model independently of those feature switches. Neither the
execution host nor a different model is enabled to make this test pass, and the
adapter's error rejection remains intact. [Conditions and source identities](../research/2026-10-02-codex-memory-0160/conditions.json)
separate this transport evidence from the still-open quality and usefulness gates.

### Score the source context actually recalled — October 2

Extraction diagnostics now request the source-excerpt format used by native recall.
`--recall-format summary` retains the earlier format as an explicit comparison arm.
Reports include sanitized source snapshots captured before maintenance. Review checks
each packet's exact excerpts, author role, engine, timestamp, verification metadata,
record revision, scope, source links and evidence-field coverage. The validator does
not call the production serializer. It binds captured text and role to the frozen
fixture and rejects missing, duplicated, altered or extra supporting material.

Older summary reports remain reviewable and keep their format label; they do not
acquire source-validation evidence retroactively. Review scores name the context
formats inspected, and the offline runner records the validator's source hash.
Neither exact text nor a matching hash proves semantic support or authentic authorship.
The attributed reviewer still assesses meaning, qualifications, relevance and missing
knowledge. Unsupported stored records continue to fail correct-memory recall even
when their source packet preserves the original words.

A private offline replay used only five previously consented excerpts and their six
already-generated proposals. It made no new model calls. The original record-quality
judgements were retained and the new packets inspected against their frozen sources.
All three positive source contexts preserved the original full excerpt, including
qualifications, compared with one faithful positive summary context. **Both formats
still scored four of six supported/useful records and one of three fully correct
recalls.** All twelve negative probes abstained. The two overbroad records remain
failures; these results do not establish improved extraction or coding-task outcomes.

The replay preserved project scope, text, source role/engine, bounded context and
probes. Only disposable profile/source identifiers and generated replay metadata
changed, with mappings retained privately. Original files and production memory were
read-only. The OS sandbox denied networking and limited writes to the private test
folder. An initial SQLite temporary-file failure was preserved; directing temporary
files into that folder allowed the replay to finish under the same restrictions.
All excerpts, records, labels, hashes and detailed reports remain local. This is a
small, attributed development review, not independent or held-out release evidence.

The storage failure also exposed a separate diagnosis problem: an unexpected store
error can surface as `waiting_for_model / inference_unavailable`. That classification
needs a focused follow-up; it does not explain the live provider blockage without
additional evidence. Live automatic learning, wider native lifecycles and the
planned quality/benefit gates remain unfinished.

### Explain why continuous learning is waiting — October 3

The collection now carries bounded availability reasons from its observed runtime
through the memory adapter, queue and Memories viewer. A stopped or unopened
companion, incomplete startup, unavailable model/account connection, unsupported
configuration and unverified native version have distinct recovery explanations.
An unavailable account observation does not claim the user is signed out. Native
version refusal remains separate from model quality and provider refusal.

Extraction jobs retain their last recognized reason in existing queue metadata.
During the retry delay, an idle check no longer describes that deferred work as an
empty queue. This survives store/learner restart without another account lookup,
version probe or inference call. Learning-off, excluded/private sources and expired
work suppress the notice; a successful later review clears it. Only fixed reason
codes are retained or shown, never native/provider error text. Notebook claim
failures forward the current reason, but notebook-only delay metadata still lacks
the durable per-job reason used by extraction jobs.

The Desktop points to the existing companion terminal and model controls. Reading
or reviewing the explanation does not reopen an agent or change Learn/Recall.
This improves recovery diagnosis; it does not unblock the installed stopped
conversation, change the selected provider, or establish successful real-user
learning. The separate in-process diagnostic storage-error classification and the
two unsupported private-example memories remain open.

### Separate reasoning quality from completion time — October 3

A [local comparison](../research/2026-10-03-memory-reasoning.md) kept production
extraction v6 unchanged and varied only the reference model's reasoning budget.
The control completed seven of eight frozen synthetic cases. A 1,024-token budget
preserved the first case's manual override but timed out on the second. One
adaptive 512-token follow-up completed all eight, with six of six stored memories
judged supported/useful, six correct positive recalls and eighteen abstentions.
The reviewer was the implementing agent, and these already-inspected examples
remain development evidence. Source-excerpt recall, already shipped separately,
preserved qualifications that the control's generated summary omitted.

The approved offline private follow-up timed out on its first excerpt, committed
no memory there, and did not run the other four. Its quality remains unmeasured;
it does not replace the earlier four-of-six private finding. Original inputs were
unchanged, external networking was blocked, and all private artifacts stay local.
No production prompt, model/effort selection, deadline, admission rule or live
memory changed. Lower extraction overhead is the next investigation; stronger
reasoning by itself is not a verified live-learning fix.

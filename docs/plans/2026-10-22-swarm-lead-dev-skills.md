# Swarm Lead and DEV Skills Implementation Plan

**Goal:** Ship built-in Lead and DEV skills for Claude Code and Codex without requiring a plugin. Attach only the appropriate skill to each newly launched Swarm session.

**Architecture:** Carry an explicit optional Swarm role through native creation, prepare a role-specific skill beneath a session-keyed workspace runtime, and point the engine's session instructions to it. Preserve the role and runtime key for restarts. Sessions created before this change keep their current behavior and adopt the skill only on their next fresh Swarm launch (Lead confirmed this boundary on 2026-10-22). Ordinary coding sessions keep their current behavior. Use the existing engine instruction contracts, preserving the person's instructions.

**Tech stack:** TypeScript, Node 24, Vitest, Dart/Flutter.

## Approved brief

Owner-approved scope is skills and launch prompts only; no backend enforcement, progress board, stuck detection or Reviewer skill.

Lead skill, in short plain English:
- Restate the request and mark guesses. Ask one question at a time in project chat, prioritizing goal, scope, constraints and done criteria. State small/medium/large; large work needs a written description.
- Split only after the task giver or owner clearly approves that description. Others' opinions and vague acknowledgements do not replace approval. Small clear requests can be done immediately; “just do it” skips questions but records important choices.
- Ask with numbered options, a default and deadline. At the deadline record and use the default for choices already authorized; elapsed time does not grant required approval.
- Route multi-part or roughly 15+ minute work into groups with goal, changes, constraints, owned code and acceptance checks. Coordinate Swarm agents; private subagents only read/look up.
- Decide reuse/keep/stop after completion; check silent workers and reassign stalled work. Report on-screen trust, sign-in or permission blocks immediately, naming the machine owner.
- Summarize long threads and record important decisions once.

DEV skill:
- Acknowledge the group and the work in chat.
- Test first, debug systematically, follow the plan in order, verify before done, and check review findings before changing code.
- Report a blocker with a “Needs:” line, then continue independent parts. Interpret ambiguous answers narrowly and record that interpretation.
- Finish all testable work and package a needed person/device action into one clear step.
- Every handoff says “Ready: yes/no”, with evidence and unverified items; distinguish local checks from real-environment runs.
- Ask the Lead to route instead of splitting into private subagents; do not touch other groups' code; merge/push/open a PR only when told. Print little.

## Constraints and ownership

- CLI skill files and role attachment launch path; Desktop launch prompt; CLI delivery header text only.
- Both the owner's and contributed machines use the executing machine's session workspace. Never write skills into the owner's native engine directories.
- No dependency added; existing sessions adopt the skill only on a fresh Swarm launch, not a restore of their old native session. No change to ordinary coding sessions.
- Lead bootstrap stays within 2,000 UTF-16 units with 160-character identifiers.
- Tests use throwaway directories, mocked engines/core and private test state, never the live daemon, real tmux or native user homes.
- Rebase onto current main before delivery; other groups edit prompts too. Push a feature branch and open a draft PR only; do not mark ready, merge or release.

## Review focus

Role isolation in a shared workspace; skill preservation on retry/restart; symlinked managed directories; preserving existing engine instructions and selected Store harnesses; attachment even when the first prompt is delivered as a file.

## Task 1: Session skill launch

Files: new `cli/src/lib/swarmSkills.ts` and tests; `cli/src/lib/productUsageSignals.ts` classifies the two new launch refusals using its existing invalid/setup kinds; creation wire/core, pane registry and relaunch metadata; Desktop launch integration and creation payload; `cli/src/superTabs/start.ts`.

- [x] Write and run failing filesystem and launch tests for both engines and both roles, ordinary sessions, retries, restarts and symlink refusal.
- [x] Implement `prepareSwarmSkill(workspace, {role, key})` returning a session instruction pointing at the saved skill. Snapshot skills once per session; refuse unsafe filesystem paths. Bundle the small Markdown strings in the CLI module so single-file releases carry them.
- [x] Pass explicit `swarmRole` on Desktop and contributed worker launches. Validate it, record `{role,key}` with the pane and restore it on relaunch.
- [x] Combine the skill pointer with the existing engine instruction mechanism; preserve custom instructions and Store runtime.
- [x] Verify focused CLI tests before broad gates.

## Task 2: Prompts and delivery

Files: `desktop/lib/super_tabs/launch_prompt.dart`, its launch/startup tests, CLI host header and tests.

- [x] Add failing assertions for role skill pointers and long-ID prompt limits.
- [x] Replace duplicated coordination rules with skill pointers. Keep route syntax and reply guidance.
- [x] Run affected Flutter startup/launch tests and analysis on changed files.

## Validation and delivery

- [ ] CLI Node 24: `npm run typecheck`; `npm run test:super-tabs`; affected host/start/skill/attribution/registry/relaunch specs; `npm run test:core` because native creation changes. No dsh/runtime change is planned.
- [ ] Desktop: `flutter analyze` on changed files; `flutter test test/super_tab_launch_test.dart test/super_tab_startup_recovery_test.dart`.
- [ ] Inspect the diff, fetch/rebase current main, rerun only newly affected checks, commit/push, and open a draft PR with exact validation results and limitations.
- [ ] Report PR, head and “Ready: yes/no” to the group. Real-engine behavioral compliance remains unverified by deterministic launch tests.

## Validation record

Platform: macOS arm64, Node 24.3.0, Flutter 3.47.5 / Dart 3.13.4. CLI tests redirect all homes and data to throwaway directories. Native integration uses fake Claude Code/Codex engines and a private tmux socket, never the live daemon. Skill content is bundled as Markdown strings; the launch creates the session's SKILL.md. Current Store runtime uses a session-keyed skill directory rather than project-wide native discovery links, so this implementation also keeps skill pointers local to the session.

- Regression RED: CLI role propagation, attachment and missing skill checks failed before implementation; Flutter role metadata and skill-pointer checks failed before implementation.
- CLI typecheck passed. `npm run test:super-tabs` passed with 100% coverage.
- Affected CLI specs (skill files, registry/pane persistence, attribution, relaunch, host/start, existing dsh/runtime and architecture): 341 tests passed. Added coverage tests also exercise role persistence after hooks, reload and detached-shell release; filesystem tests cover shared-workspace isolation and redirected managed paths.
- `npm run test:core -- --maxWorkers=3`: 199 files / 2,946 tests passed; the gate fails solely on unchanged `src/services/osDevice.ts:181` (119/120 lines, 35/36 functions). An isolated run of its existing 20 tests reproduces that coverage gap. The Lead instructed this group to leave it alone; #1525 carries the missing test. All modified core files reached 100%.
- `E2E_BUNDLE=1 node_modules/.bin/vitest run --config vitest.e2e.config.ts e2e/swarmSkills.e2e.ts`: passed. Both roles and engines receive only their own skill, metadata survives native binding, restart retains the skill and no skills are written into native engine homes. Also passed against the source runner.
- Flutter launch/startup suites: 50 tests passed, including Desktop worker roles, attached first prompts and the 2,000-unit limit with maximum IDs.
- Flutter analysis: no errors or warnings; 12 existing informational curly-brace lints in unchanged statements of `app_state.dart`. Plain analyze reports these; `--no-fatal-infos` accepts that existing baseline.
- Existing legacy sessions require a fresh Swarm launch to adopt a role skill. No roster bridge is included, as confirmed by the Lead.
- Real-engine reasoning/compliance and contributed physical-machine runs are unverified. The native integration verifies transport, filesystem and argv behavior with isolated fake engines.

Input scopes for evidence reuse: CLI source/lockfile/Node toolchain for CLI checks; Desktop source/pubspec/toolchain for Flutter checks. Backend-only and OS Python-only rebases do not change these scopes. A new change in those scopes or a conflict resolution requires affected checks.

### Broad validation and final review

`npm test -- --maxWorkers=3` was stopped at its approximately ten-minute limit (04:49:38–04:59:45 UTC); this run is incomplete, not a passing full suite. Its launch-refusal enumeration guard found missing classification for the new role/skill errors; those now use the existing invalid/setup kinds. The guard and native creation tests then passed together (134 tests).

Thirteen failures from four unchanged files reproduce on a temporary archive of current main with the same Node/toolchain: `engines/nativeDescriptors.golden.spec.ts` (5), `messages/rpc.spec.ts` (1), `engines/kit/storePool.spec.ts` (1), `engines/kit/exactTranscript.spec.ts` (6). A Cursor fixture hit its five-second deadline under the broad run; its isolated rerun passed all 28 tests. The two native `sessionRepair.spec.ts` failures required the private Darwin helper; after building it with `scripts/build-process-images.py` and setting `HARNESS_PROCESS_IMAGES_ARTIFACT`, all 78 tests in that file passed. None of those baseline files were changed.

Review: author inspected the complete diff and exercised the native bundle; independent review is requested from the Lead's review workgroup. No private subagents were started. Approval deadlines in the Lead skill apply to authorized choices, not the explicit approval needed to split work.

Timing (UTC, overlapping implementation and validation): assignment go 04:35:54; implementation/first focused green checks by 04:43; validation 04:40–05:01; final rebase/publication recorded in the PR handoff. Merge and release are not authorized. Ready for merge: no, pending independent review and the documented baseline gates.

Final integration: rebased on #1517 after it merged. The shared host header and Desktop prompt had text conflicts; the resolution preserves its five-part task template alongside the role skill pointers, removing only the duplicated coordination prose. Revalidated the host/service tests, routing coverage gate, CLI typecheck, Flutter launch/startup suites and bundle integration on the combined source. Other deterministic evidence covers unchanged inputs; the broad suite is not repeated.

## Review fixes (2026-10-22)

- Aligned the Lead task template with #1517: goal, changes, constraints, owned code and acceptance checks. DEV wording now explicitly requires a “Needs:” line and forbids touching other groups' code.
- Extracted `lib/harnessRuntimeIgnore.ts` from the Store ignore handling and reused it in both launch paths. It preserves custom rules, adds runtime/legacy rules once, atomically publishes the ignore file, and refuses a redirected file. A fresh-repository test actually runs `git add -A` and checks that SKILL.md is never staged.
- Restored a compact inline coordination clause in both Lead-facing prompts for older sessions/CLIs. Desktop and delivery-header skill guidance is explicitly conditional on Claude Code or Codex; worker starts omit the skill instruction for other engines.
- RED: five CLI regressions and the Flutter bootstrap regression failed on the pre-fix source. GREEN: 174 affected CLI tests, 50 Flutter launch/startup tests, typecheck, the 111-test routing coverage gate (100%), and the bundled private-engine integration passed. No core launch code changed in this review fix; prior core evidence is retained. The Lead accepted the previously documented OS-device and reproduced broad-suite failures as baseline.

Final compatibility review: restored the unconditional “Discuss first; build when authorized.” sentence for Leads, alongside skill-qualified guidance and the inline coordination fallback. The startup recovery assertion failed without it, then passed with it. Claude/Codex worker starts on an older contributed CLI may still be told to use swarm-dev even though that CLI cannot attach it; this accepted limitation is documented in the PR. Native role attachment requires an updated execution CLI.

Final prompt-only verification: both Flutter launch/startup suites pass (50 tests), analysis of the changed prompt/test reports no issues, and maximum-ID Lead prompt length is 1,977/2,000 UTF-16 units. CLI inputs are unchanged from the prior reviewed receipt; no CLI or broad-suite checks were repeated.

## Full-permission integration (2026-10-22)

Rebased the reviewed branch onto `9142773b0` (#1532, after #1528). The two textual conflicts were in CLI worker dispatch and Desktop launch integration. Both resolutions retain full permission mode and role metadata; the core launch changes applied without textual conflicts. Added combined assertions for direct/contributed CLI worker starts, Desktop Lead/member launches, and both roles on both engines in the bundled private-daemon integration. The latter checks the actual full-mode argv and saved permission mode alongside the role skill.

Fresh validation on the integrated tree uses Node 24.3.0 and Flutter 3.47.5/Dart 3.13.4 on macOS arm64, with isolated fixture homes and engines:

- CLI typecheck passed.
- Ten affected CLI specs passed all 427 tests (skill runtime, Store runtime, registry/pane, relaunch, attribution, usage classification, host/start and architecture).
- Routing coverage passed all 111 tests with 100% in every gated file.
- Bundled native integration passed for both engines and roles, including restart and native-home isolation.
- Flutter launch/startup recovery passed all 57 tests. Maximum-ID Lead prompt remains 1,977/2,000 UTF-16 units.
- Analysis of seven changed Dart files passed with no errors/warnings; the same 12 existing informational style notices remain in app_state.dart.

The initial concurrent core/routing coverage runs collided because routing cleaned the parent coverage directory. That core attempt was interrupted, not passing evidence; core was rerun with its own reports directory.

Core rerun: `npm run test:core -- --maxWorkers=3 --coverage.reportsDirectory=/private/tmp/swarm-rebase-core-coverage` passed 199 files / 2,947 tests. All four changed core agent files have 100% statements, branches, functions and lines. The command exits nonzero only for the unchanged, Lead-accepted `services/osDevice.ts:181` coverage gap (same missing line/function/branch); that file has no diff from main. The broad CLI suite was not repeated; its previously accepted baseline evidence remains above.

Range review confirmed the rebase changes only the two shared launch boundaries, retaining #1532's permission retry/recovery behavior and this branch's role isolation, fallback guidance and discuss-first sentence. No merge or release was performed. Rebase, integration assertions and validation took about five minutes; push and CI waiting are tracked separately in the handoff.

## Desktop CI fixture correction (2026-10-22)

The automatic ready-PR run exposed 18 Desktop test subclasses overriding AppNotifier.createAgent without its new optional swarmRole argument. This is a branch regression, not an accepted baseline. Reproduced the compile failure locally in new_agent_permission_mode_test.dart before adding the optional parameter to every override. Production inputs are unchanged. All 18 affected files then passed together: 236 tests passed, one skipped; analysis of those 18 files found no issues. CLI/core/native and the 57 launch/startup receipts cover unchanged production inputs and are retained. The corrected push will run automatic CI once; no manual workflow or rerun was started.

## Worker-release integration (2026-10-22)

Started from the Lead's pushed clean rebase `40adc5099` on #1525, then rebased onto `591b056a3` (#1527). CLI host/start sources and tests applied cleanly, retaining full-mode starts, role metadata, original-native-launch protection, agent.release and host close/retry behavior. Resolved the Desktop prompt and startup recovery conflicts by retaining every rule from both sides: discuss first, supported-engine role skills, routing, group coordination, small self-work/read-only subagents, five-part tasks, worker reuse/keep/stop with stop preferred, reply-once, scheduled report reading and project scope.

The combined prompt is 1,990/2,000 UTF-16 units with both IDs at 160 characters. Compact wording preserves the rules, and startup recovery pins the coordination and worker-release clauses. The extra fallback assertions failed before the wording fix; the length test also caught the first oversized combined draft.

Fresh checks on Node 24.3.0 and Flutter 3.47.5/Dart 3.13.4, macOS arm64:

- `cd cli && node_modules/.bin/vitest run src/superTabs --maxWorkers=3`: 20 files / 386 tests passed, including worker release, host close, dispatch and skill instructions.
- `cd cli && npm run test:super-tabs -- --coverage.reportsDirectory=/private/tmp/swarm-release-routing-coverage`: 111 tests passed, 100% statements/branches/functions/lines.
- `cd cli && npm run typecheck`: passed.
- `cd desktop && flutter test --no-pub test/super_tab_launch_test.dart test/super_tab_startup_recovery_test.dart`: 58 tests passed.
- `cd desktop && flutter analyze --no-pub lib/super_tabs/launch_prompt.dart test/super_tab_launch_test.dart test/super_tab_startup_recovery_test.dart`: no issues.
- `git diff --check`: clean.

The branch's native/core role attachment and 18 Desktop fixture signatures are unchanged; earlier scoped evidence remains recorded above. The merge and release remain the Lead's; the separate old-session bridge is still waiting for this PR to merge. Integration and requested validation took about five minutes; publication and CI waiting are separate.

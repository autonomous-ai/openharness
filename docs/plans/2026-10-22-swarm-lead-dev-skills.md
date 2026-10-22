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
- Route multi-part or roughly 15+ minute work into groups with goal, scope, constraints and acceptance checks. Coordinate Swarm agents; private subagents only read/look up.
- Decide reuse/keep/stop after completion; check silent workers and reassign stalled work. Report on-screen trust, sign-in or permission blocks immediately, naming the machine owner.
- Summarize long threads and record important decisions once.

DEV skill:
- Acknowledge the group and the work in chat.
- Test first, debug systematically, follow the plan in order, verify before done, and check review findings before changing code.
- Report a blocker in one line, then continue independent parts. Interpret ambiguous answers narrowly and record that interpretation.
- Finish all testable work and package a needed person/device action into one clear step.
- Every handoff says “Ready: yes/no”, with evidence and unverified items; distinguish local checks from real-environment runs.
- Ask the Lead to route instead of splitting into private subagents; respect ownership; merge/push/open a PR only when told. Print little.

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

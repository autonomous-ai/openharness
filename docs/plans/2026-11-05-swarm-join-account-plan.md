# Swarm join account choice implementation plan

> Implement task by task in this Engineer session, test first, followed by independent security reviews and user-flow testing.

**Goal:** Let new Desktop collaborators explicitly choose Team or their own account when joining a Swarm.
**Architecture:** Reuse the existing Join Swarm surface and per-Swarm `machine.ownAccountWork` command. Keep machine contribution restricted to Team until the explicit own-account command succeeds. Reuse the same choice control for invitation/discovery joins before their Team setup offer.
**Tech Stack:** Flutter/Dart, existing SuperTabController and AppNotifier.
**Spec:** Swarm task #3317, conversation 120f084ba2034258eb3a1862; ASCII mockup approved by Scholes through River on November 5, 18:16 Vietnam time.

## Global Constraints

- Team account preselected. Own-account warning names files, tools, keychain and signed-in apps; consent applies only to this Swarm on this computer.
- Existing viewers, existing memberships, removed machines, account switches and unsupported platforms retain their safeguards.
- No backend protocol change, dependencies or real sign-out in tests. Keep existing machine settings reversible.
- Two independent security reviews, Desktop affected tests, light/dark screenshots and check-ui-style before Ready.
- PR starts: Requested by scholes through Harness.

## Design

- Growth: reuse one existing ownAccountChoice record per machine per Swarm; machine/Swarm removal deletes it. Transient UI choice ends on dismissal/sign-out/completion.
- Concurrency: existing server command serializes each Swarm write and verifies the machine owner's session. UI checks account identity after awaits and serializes join attempts. Separate contribution and consent never grant access before consent succeeds.
- Read cost: existing controller snapshots/deltas only; no polling added.
- Scale: at 10x joins, constant additional choice/command per join; existing command latency/error logs warn first.
- Compatibility: existing command, settings and default Team contribution; older server refusal leaves Team restriction and a visible error.
- Migration/rollback: none; old clients honor the existing setting. Revert UI without altering stored consent.
- Audience: server enforces owner/session/machine checks; UI never grants access itself.
- Identity: explicit owner consent is required before enabling own-account work, scoped to this Swarm. Team stays default.
- Failure: refusal or uncertain response never reports own-account success or skips into unrestricted work. Retry uses controller operation receipts.
- Platforms: desktop macOS/Linux/Windows with existing platform permission copy; web/mobile never configure a local account.

## Review Focus

1. Account changes during join must not save consent for the next account.
2. Preview/new-member race must not change an existing membership's machine setting.
3. Failed or uncertain consent must leave Team restriction and actionable recovery.
4. Invitation and discovery joins must offer a choice without overlapping dialogs or setup prompts.
5. Joined-machine note must describe actual account access, and switching back stays available in Machines.

### Task 1: Persist explicit choice safely

**Files:** desktop/lib/super_tabs/join_machine.dart, desktop/lib/super_tabs/join_machine_note.dart; desktop/test/swarm_join_machine_test.dart.
**Interfaces:** Extend SwarmJoinMachine.add with optional ownAccount=false; return the actual choice and a visible configuration failure in SwarmJoinedMachine. Consume existing machine.ownAccountWork command.

- [x] Add and commit failing tests: own-account consent follows contribution; default sends no consent; refusal/account change never reports consent; note describes actual access.
- [x] Run affected test file and record expected failures.
- [x] Implement minimal choice handling, retaining teamAccountOnly and existing eligibility checks; use controller retry for uncertain commands.
- [x] Run affected tests, then commit and push implementation.

### Task 2: Offer the choice throughout first join

**Files:** desktop/lib/super_tabs/join_dialog.dart; new desktop/lib/super_tabs/join_account_choice.dart; desktop/lib/state/app_state.dart; desktop/test/swarm_sharing_test.dart and relevant app join tests.
**Interfaces:** Shared SwarmJoinAccountChoice control; selected own-account value reaches addMachineOnJoin and SwarmJoinMachine.add. A pending request on AppNotifier lets SwarmJoinHost present the same choice for joins without the link dialog.

- [x] Add and commit failing widget/app tests for Team default, own-account selection and warning, setup skipped only after successful own-account setting, Team setup preserved, viewer/existing member suppression, cancellation, sign-out and invitation/discovery joins.
- [x] Run targeted tests and record expected failures.
- [x] Implement shared choice in the existing join surface, fallback dialog in the join host, and app orchestration without changing existing machine settings.
- [x] Run affected tests on macOS; analyze changed files and run check-ui-style. Capture light/dark UI screenshots using fake account/memory store.
- [x] Commit/push, add red/green evidence to PR, mark Ready and hand off to Integrator for two security reviews and independent Tester.

## Validation scope

Flutter 3.47.2 / Dart 3.13.2 on macOS. Run swarm_join_machine_test, swarm_sharing_test, team_account_offer_test, team_account_lock_test, swarm_join_any_test, super_tab_sharing_auto_join_test, and new choice tests; additional importers only if behavior changes affect them. Deterministic checks cover changed Dart files plus pubspec.lock and this SDK. PR CI supplies component Linux suite; no full local suite. Record implementation/validation/waiting separately; merge/publication belong to Integrator.


## Execution evidence

- Plan first: cff2edc7. Task 1 tests: e3e1d8b8; implementation: 72c351d1. Task 2 failing tests: 724f72b8, e86621d0 and 1328dfd5 before implementation.
- Task 1 behavioral red: 15 passed, 5 expected failures with API declarations present; green: 20 passed.
- Task 2 behavioral red: 12 passed, 9 expected failures; initial green: 21 passed. Queued-account regression red: 1 expected failure; final affected checks: 155 passed, 15 existing skips.
- `make validate ARGS=".harness/juniper12-validation-plan.json"`: affected checks plus analysis and UI style, Flutter 3.47.2/Dart 3.13.2 on macOS. Analyzer has 16 existing informational brace lints in unrelated AppNotifier methods; no errors or warnings in changed code.
- Light/dark widget screenshots for Team, own-account and invitation/discovery surfaces are captured with fake sign-in and memory state. The tester still verifies the current head independently; two security reviews precede merge.
- No migration or new backend/CLI command. Rollback is reverting the UI; the existing per-Swarm setting remains switchable from Machines.
- Timing (Vietnam time, November 5): approval waiting 18:12–18:16; implementation and targeted red/green checks from 18:16; final validation started 18:29. Review, merge, publication and release waiting are separate and pending with the Integrator.

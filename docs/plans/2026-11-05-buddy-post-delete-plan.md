# Buddy post deletion implementation plan

> Implement task by task in this Engineer session, test first, followed by independent review and testing.

**Goal:** Let the attributed owner delete their Buddy proposal on Desktop and phone without offering Edit.

**Architecture:** Keep plain-message edit eligibility intact. Add a delete-only predicate matching the server's person attribution and buddy-proposal personId checks, and use it in both apps' existing menus, including phone threads.

**Tech Stack:** Dart, Flutter, flutter_test.

**Spec:** Swarm task #3330; backend contract in PR #3180 (`messageEdits.ts`).

## Global Constraints

- Separate branch based on `super-tab/8439eda0e00391dac310b817`; no backend changes.
- Only the attributed person with write access sees Delete. Edit remains hidden for proposals.
- Keep existing confirmation, request and failure handling; no real CLI sign-in or persistent state in tests.
- Desktop, web, iOS and Android share their existing menu paths; no process changes.
- Two security reviews shared with #3322, plus independent UI testing before merge.

## Review Focus

- A mismatched or missing source personId must not expose Delete.
- Agent attribution must never qualify, even with a matching source personId.
- Archived/read-only/deleted messages must retain their existing restrictions.
- Phone thread menus must use the same deletion eligibility as the main chat.
- Plain messages retain both actions; system sources retain neither.

## Design

No new storage, synchronization, identity, query or migration. Growth, concurrency, read cost, scale, compatibility, migration and rollback: N/A because this only offers an existing command. Audience: server independently authorizes deletion. Identity: current signed-in account only. Failure: existing refusal UI. Platforms: Desktop/web and phone use their existing menus.

## Task 1: Desktop owner deletion

**Files:** `desktop/lib/super_tabs/profile_actions.dart`, `desktop/lib/super_tabs/view.dart`, `desktop/test/super_tab_message_edit_test.dart`, `desktop/test/super_tab_profile_actions_test.dart`.

**Interfaces:** Consume SuperTabMessage author/source and current controller access. Produce `bool canDelete(SuperTabMessage message)`; preserve `canChange` for Edit.

- [ ] Commit widget tests asserting owner proposal offers Delete but no Edit; another person's and agent-authored proposals offer neither. Add eligibility coverage for mismatched source ownership and restricted messages.
- [ ] Run affected tests and record the expected missing Delete failure.
- [ ] Add delete-only eligibility and wire the existing menu; run affected tests green and commit.

## Task 2: Phone owner deletion

**Files:** `mobile/lib/swarm/swarm_conversation.dart`, `mobile/lib/swarm/swarm_conversation_page.dart`, `mobile/test/swarm/swarm_message_edit_test.dart`.

**Interfaces:** Consume SuperTabMessage and SwarmConversation access. Produce `bool mayDelete(SuperTabMessage message)`; preserve `mayChange` for Edit; use in chat and thread menus.

- [ ] Commit widget tests for owner Delete/no Edit and denial for other-person, agent and mismatched source proposals, including thread menu.
- [ ] Run affected tests and record expected missing Delete failure.
- [ ] Implement and wire delete-only eligibility, run affected tests green and commit.

## Validation and handoff

- [ ] Run affected Desktop profile/message tests and phone message edit tests with Flutter 3.47.2/Dart 3.13.2; run `desktop/scripts/check-ui-style.sh`.
- [ ] Capture light/dark menus in both apps with in-memory/fake sign-in fixtures.
- [ ] Add red/green evidence to PR comment, mark Ready and hand off to Integrator for shared security reviews and independent UI testing. CI supplies touched component suites.

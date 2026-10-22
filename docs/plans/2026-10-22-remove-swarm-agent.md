# Remove agents from a Swarm implementation plan

> **For agentic workers:** Use superpowers:executing-plans and the built-in swarm-dev workflow. Run each behavior test red, implement, then verify green.

**Goal:** Let a Swarm owner or contributor remove an agent with confirmation, and notify affected Leads immediately.

**Architecture:** Extend the existing roster context menu and shared dialog/controller plumbing. Add person-only notices inside the backend agent.remove case, using distinct operation-derived message IDs per conversation; existing transactional receipts prevent duplicate notices on retry. Preserve existing session ownership and stop-confirmation behavior.

**Stack:** Flutter/Dart, TypeScript, Vitest; no dependencies.

**Spec:** Owner-approved workgroup “Remove agent from the Swarm in Desktop”, expanded assignment of 2026-10-22: owner/contributor-only action, plain confirmation naming agent and machine, backend refusal displayed, one notice per affected group identifying remover, agent and open task, delivered to that group's remaining Lead; no notices for host-agent removal or agents without groups.

## Constraints and review focus

- Own roster.dart, controller.dart only if necessary, roster tests; backend agent.remove case and command tests. Add one isolated store integration test to prove receipt replay; no store implementation changes.
- Existing permission, native stop and reservation behavior stays authoritative. No native session operations from Desktop.
- Cancel, permission loss or access revocation sends no removal. Guard duplicate confirmation and retain pending operation receipts for uncertain replies.
- Multiple affected groups need distinct message IDs. A removed Lead cannot receive its own notice; other recipients must remain members.
- Removal without active work must not claim a task stopped. Replays return the original receipt without another message or delivery.
- Tests use in-memory Desktop state and disposable MongoDB, never production homes, port 18473 or real tmux.
- Branch from current main; deliver a draft PR only. No merge/release.

## Task 1: Desktop removal action

Files: desktop/lib/super_tabs/roster.dart, desktop/test/super_tab_roster_test.dart; controller.dart only if existing plumbing cannot suffice.

- [x] Add widget tests for owner confirm/cancel, contributor vs unrelated person, refused removal, lost acknowledgement retry, permission revocation and existing details action.
- [x] Run the new tests and observe the missing action.
- [x] Add Remove from Swarm to the existing menu when canWrite and owner/contributor. Use showAppDialog and SuperTabDialogScope, recompute permission from the current snapshot, and call controller.command / retry.
- [x] Verify roster and related controller/dialog tests; analyze changed Dart files.

## Task 2: Lead notices

Files: backend/src/superTabs/commands.ts (agent.remove only), commands.test.ts; backend/integration/superTabs.test.ts (receipt regression only).

- [x] Add failing tests for active work, memberships across groups, named person/agent/task, unique message IDs, no groups/no active task, and person-only notices.
- [x] Add a database integration test removing once and retrying the same operation; assert one notice and delivery per group.
- [x] Capture affected groups before removal, retain the existing removal helper, then append person-authored notices with stableId(operationId, removal notice, group.id) and remaining Lead recipients.
- [x] Run backend typecheck, Super Tab unit tests and isolated integration suite.

## Task 3: Review and draft handoff

- [x] Inspect a rendered confirmation and permission-specific menus, then get a fresh read-only code review.
- [ ] Resolve material findings, fetch/rebase main, and run only checks affected by new source changes.
- [ ] Push the branch and create a draft PR with exact tests and screenshot. Report Ready: yes/no, head, links and any unverified behavior to the workgroup.

## Validation scope

Flutter: changed-file analyze; super_tab_roster_test.dart, super_tab_controller_test.dart and super_tab_project_delete_test.dart (shared pending-dialog conventions). Backend: npx tsc --noEmit; NODE_ENV=test with the existing fixture encryption key, vitest run src/superTabs; npm run test:super-tabs. Use two workers and bounded runs. Full unrelated suites are outside this isolated menu/notice change; CI component suites start after owner marks the draft ready.

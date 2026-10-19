# Super Tab implementation review — 19 October 2026

The existing app tab contains a flat workgroup list, a chat/native-terminal/PR centre, and a right sidebar with Leads, Humans, Agents and contributed machines. The hidden Cmd-Option-Shift-T shortcut reuses the Cmd-N lead form without Recent harnesses. Clicking an agent opens its exact native terminal; hiding a pane preserves the running harness.

## Machine contribution

A collaborator explicitly contributes an owned machine, project folder, permitted engines/default accounts and concurrency limit. The machine owner executes queued starts through the existing durable native creation receipts. Contributions do not create whole-machine shares. Removing the contributor revokes the contribution. Pausing stops new dispatch while preserving running agents. Model settlement completes before work assignment is permitted.

Fresh host readings expose CPU/GPU, RAM and project-volume disk, available subscription windows and resets. Unknown readings remain unknown. Routing rejects stale/full/paused machines and candidates missing required resources/tools. The backend independently admits each launch and the host reserves native capacity.

## Review path

1. Use Cmd-Option-Shift-T and create a lead using the familiar form.
2. Click a member to focus its terminal; use the group terminal icon to show the group's panes. Hide a pane and reopen it.
3. A native pending question adds a local “needs you” notice. Clicking it goes to that terminal; the native question-close event clears it.
4. Humans + invites collaborators. Machines + contributes capacity; machine details configure or pause it and attach an existing harness.
5. Inspect PR references in chat and the PR view. References are actual observed links; unknown GitHub state is not presented as verified.

## Validation plan and evidence

Source scope: Desktop Super Tab UI/state and native macOS integration; CLI machine readings, routing and host launch protocol; backend Super Tab authorization, durable operations and Mongo transactions. Toolchain: pinned Flutter 3.47.2 and repository Node lockfiles. Use private test homes/daemons and synthetic engines only.

- Routing coverage: 100% statements, branches, functions and lines after the contributed-capacity cases.
- Desktop affected widget tests: creation, multi-pane hide/reopen, roster, narrow/large-text layouts and native question handoff. Final checks are recorded below when complete.
- macOS native fixture: actual Flutter terminal surface, both sidebars retained; synthetic accounts and harnesses.
- Backend: disposable Mongo replica-set integration tests, including owner-only queue execution, project scope, concurrency, pause and revocation.
- CLI: two disposable daemons demonstrate a teammate contributing capacity without a MachineShare; a repeated start uses the original native receipt.
- Existing `superTabsCollaboration.e2e.ts` currently fails at `GUEST_NOT_ALLOWED`: main's guest policy does not permit the old `super_tabs` capacity RPC. This change does not widen guest permissions. The new explicit contribution flow has its own end-to-end test.

## Delivery constraints

Use the official signed internal Desktop workflow, not a public feature-test release. New machine contribution requires the matching CLI and backend as well as Desktop. A Desktop-only artifact does not by itself deploy those changes. Existing remote terminal control permissions still apply: a collaborator allowed only to observe a terminal cannot type into it.

Implementation, validation, merge, build/publication and waiting are distinct phases. No merge or production publication is claimed by this document.

## Completed local checks

- 86 affected Desktop widget tests passed, including native-question notice → exact terminal → cleared question, multi-agent panes, hiding and reopening, dark/light and narrow/large-text layouts.
- Native macOS fixture passed with real terminal rendering and realistic CPU/GPU/RAM/disk/quota cards; screenshots saved locally under `/private/tmp/super-tab-review-final`.
- 265 CLI tests across 16 files passed; both TypeScript typechecks passed.
- Backend replica-set suite: 33 tests passed, including the final guard against changing a contribution during model settlement.
- Two-daemon contribution E2E passed again after integrating main's creator-scoped creation receipts (`1fb7c4fc08`). No real user harnesses were used for testing.
- Shared icon catalogue audit passed. Whole-tree Flutter analysis reported pre-existing third-party/deprecated and unrelated device-test warnings; it is not recorded as a clean whole-tree check.

Review PR: https://github.com/autonomous-ai/openharness/pull/1436

Official internal Desktop build: https://github.com/autonomous-ai/openharness/actions/runs/39294760131 (Desktop source `da0a3f9dacbd70e31cc78905f2208f77affa84b8`; the follow-up settlement fix changes backend files only).

Validation/build timing for this final review phase: required CI and internal build started around 17:30 UTC; native macOS and final local integration checks completed by 17:35 UTC. Earlier implementation time is not represented as build time. Publication and merge remain separate, and their final status is reported with the review handoff.

## Installed review build

The official internal build succeeded and was locally accepted by Gatekeeper as a notarized Developer ID app. It is installed at `/Users/ab/Applications/Harness SuperTab Oct19.app` and opened for review. Press Cmd-Option-Shift-T to create a Super Tab. Local CLI `0.4.23-dev.f2e4605215` is installed using the repository installer, with a binary-only rollback copy in `.harness/review/cli-rollback-before-f2e4605`. No user harnesses were used for tests.

[Apple Silicon DMG](https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop-internal/9207d418957f7828742b619a9d848fac/Harness-macos-arm64-1.2.94-da0a3f9.dmg)

SHA-256: `9e3a2d3f5e60add9380c1acde01e57744accd71c99bfa462bb76395730cf4682`.

The final broad CI run exposed one obsolete welcome-page assertion that expected Recent harnesses on Super Tab creation. The test now verifies the approved lead-only form and preservation of existing harnesses; all 15 tests in that file pass locally. This correction changes tests only, so the installed application's source remains current. Required CI must pass before merge. The matching backend has not been published by the internal app build; machine contribution needs that server rollout before it can be used against production.

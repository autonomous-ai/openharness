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

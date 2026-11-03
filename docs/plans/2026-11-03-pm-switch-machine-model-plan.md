# Move a PM between machines and choose its model: Implementation Plan

> **For agentic workers:** Follow the Harness Engineer workflow in the project's instructions. This plan is implemented by the assigned Engineer; it does not use subagent-driven development.

**Goal:** Let an authorized person choose a destination machine, engine/account and model for a PM switch, while keeping the source PM alive until the new PM is running and has atomically taken over the project chat.

**Architecture:** The backend validates the source and destination and records one switch request plus a guarded target Lead start. The destination host starts a candidate PM from the source's handoff and settings; only a successful start can promote the candidate and reassign the lead conversation. The source host closes only its old process after that promotion. Desktop selects the destination and compatible engine/account/model from current machine observations.

**Tech Stack:** TypeScript, Zod, Vitest, Super Tab backend and CLI host protocols, Dart/Flutter widgets.

**Spec:** `docs/superpowers/specs/2026-11-02-pm-switch-engine-account-design.md`, sections 6–9.

## Global Constraints

- Preserve the source PM and project chat until a destination candidate is running and backend promotion succeeds.
- The backend enforces project-manager rights, destination contribution and `requireTeamWork` placement; the target host rechecks its current contribution, generation, engine, profile and Team-account limits.
- A failed target start leaves the old PM running and emits exactly one fixed-reason line. Never stop a process except the process created for this switch or the old PM after promotion.
- Keep the request and candidate bounded to one per PM; stale requests and late candidates cannot take over.
- Preserve task assignments, project chat, role, saved Swarm skill and GitHub setting. Recompute destination project folder and machine account rules.
- Phone UI is out of scope. Desktop tests use a memory store and fake sign-in. Never run a test that signs the Mac out of the real CLI.
- Swarm code stays out of `cli/src/core`; temp files live only in `mktemp -d` directories.
- Before Ready, record red/green evidence for each named risk, run the full Super Tab backend integration suite, and pass two independent security reviews.
- PR body begins exactly: `Requested by dee@autonomous.ai through Harness.`

## Review Focus

- **Destination authorization race:** the source owner is allowed to move a PM but the destination is not allowed for this project, has been withdrawn, or changed contribution generation. Tests must prove request and launch admission refuse it without disturbing the source.
- **Team-account boundary:** an owner or borrower attempts a destination on another person's Team machine or a Team account already serving another project. Tests must prove the same placement policy as a new Lead start is enforced.
- **Promotion ordering:** destination process creation, reporting or promotion fails, or source cleanup races the rebind. Tests must prove the source remains alive until atomic promotion and closes only afterward.
- **Late/duplicate target:** a lease expires, the request is replaced, or the target host restarts and retries. Tests must prove stale candidates cannot become lead and cannot post a second result line.
- **Stale UI selection:** machine capabilities or profile/model availability changes while the dialog is open. Widget tests must prove submission uses a still-valid destination and the no-choice state gives one clear reason.

---

### Task 1: Validate and record a cross-machine switch request

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (`lead.switch`, switch claim/result and candidate promotion commands)
- Modify: `backend/src/superTabs/model.ts` (`switchRequest` and candidate/start state)
- Modify: `backend/src/superTabs/tidy.ts` (expiration of unclaimed/expired target switches)
- Test: `backend/src/superTabs/commands.test.ts`, `backend/src/superTabs/tidy.test.ts`
- Integration test: `backend/integration/superTabLiveness.test.ts`

**Interfaces:**
- Consumes: existing `leadHost`, `admitMachineStart`, `requireTeamWork`, machine observations, source PM ownership, and `switchRequest`.
- Produces: `lead.switch` accepting optional `machineId` and `model`; one target candidate start tied to the current request; a backend-only atomic promotion that transfers `leadConversationId` to the candidate after its successful start.

- [ ] **Step 1: Write failing backend tests** for same-machine compatibility; valid cross-machine placement; project owner and source-machine owner permissions; unauthorized member; stale/offline/outdated/uncontributed destination; wrong engine/profile; contribution-generation change; Team-account restriction; promotion retaining conversation/chat and changing the lead exactly once; failed target preserving source and writing one line; expired and duplicate promotion refusal.
- [ ] **Step 2: Run targeted tests and confirm expected failures**: `cd backend && npx vitest run src/superTabs/commands.test.ts src/superTabs/tidy.test.ts`.
- [ ] **Step 3: Implement request validation, persisted request fields, atomic candidate promotion and stale cleanup**. Keep all authorization decisions on the backend and make any expiry/claim checks use the existing transaction time.
- [ ] **Step 4: Run targeted tests and confirm they pass**, then run `cd backend && npx vitest run --config vitest.super-tabs.config.ts integration/superTabLiveness.test.ts`.
- [ ] **Step 5: Commit the passing backend change** as `feat(swarm): authorize and promote cross-machine PM switches`.

### Task 2: Start the candidate on the destination and retire the source after promotion

**Files:**
- Create or modify: `cli/src/superTabs/leadSwitchRequest.ts`
- Modify: `cli/src/superTabs/host.ts`, `cli/src/superTabs/start.ts` as needed to serve destination candidate starts and post-promotion source cleanup
- Test: `cli/src/superTabs/leadSwitchRequest.spec.ts`, `cli/src/superTabs/host.spec.ts`, `cli/src/superTabs/start.spec.ts`

**Interfaces:**
- Consumes: Task 1's guarded target start and switch id; existing host start flow, local daemon handoff calls, profile lookup, signed-in check and PM prompt.
- Produces: an idempotent target-host operation that claims the candidate start, runs it with source handoff and chosen model/account, reports successful start for backend promotion, and closes the old PM only after observing promotion.

- [ ] **Step 1: Write failing host tests** for handoff and candidate start on another machine; preservation of role, saved Swarm skill, permission mode and GitHub setting; target folder/profile/model; failed create preserving source; duplicate/restarted target idempotency; source process closure only after promotion; exact process id fencing.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/leadSwitchRequest.spec.ts src/superTabs/host.spec.ts src/superTabs/start.spec.ts`; confirm failures correspond to missing cross-machine behavior.
- [ ] **Step 3: Implement the destination start and source cleanup flow** using the existing start/claim machinery and switch id. Never infer ownership from the project owner's login or stop a process by name.
- [ ] **Step 4: Run the targeted CLI tests and the affected CLI component checks**, including any coverage gate required by touched files.
- [ ] **Step 5: Commit** as `feat(cli): start a switched PM on its destination machine`.

### Task 3: Choose the machine, account and model in Desktop

**Files:**
- Modify: `desktop/lib/super_tabs/switch_pm.dart`
- Modify as needed: `desktop/lib/super_tabs/model.dart`, `desktop/lib/super_tabs/controller.dart`
- Test: `desktop/test/super_tab_switch_pm_test.dart`

**Interfaces:**
- Consumes: current machine observations, profiles, capabilities, project/source-machine access and Task 1's `lead.switch` fields.
- Produces: the agreed Switch PM dialog with machine picker, destination engine/account rows, model picker (Default first), one-line no-choice reason, and a submission containing the chosen destination, profile and model.

- [ ] **Step 1: Write failing widget tests** for machine options (enabled and disabled with reasons), destination profile refresh, model choices, current destination marking, stale choice refusal, one-line no-choice message, agreed explanatory copy, and command payload.
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_switch_pm_test.dart`; confirm expected UI and payload failures.
- [ ] **Step 3: Implement the dialog** in Harness design language, with the agreed ASCII layout as its interaction source and no phone UI changes.
- [ ] **Step 4: Run** the widget tests and `cd desktop && flutter analyze lib/super_tabs`.
- [ ] **Step 5: Commit** as `feat(desktop): choose a machine and model when switching PMs`.

### Task 4: Validate the integrated change and hand it to independent review

**Files:**
- Update: this plan's evidence in the pull request description/comment; no additional product code unless a failing check requires a fix.

- [ ] Run the full Super Tab integration suite once, after the backend/host behavior is integrated.
- [ ] Run affected backend and CLI unit coverage gates and Desktop widget/analyze checks; select exact commands from the validation guide before starting them.
- [ ] Record test-first red/green output for each task-risk case in the pull request.
- [ ] Mark the pull request ready only after local checks pass; add two independent security review steps focused on source/destination authority and Team-account boundaries, and a Desktop test step for the visible dialog.
- [ ] Address findings test-first, ask the same reviewers/tester for a second pass, and report the exact revision and evidence in the task status.

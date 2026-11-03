# Machine Removal Privacy Implementation Plan

> **For agentic workers:** The Engineer implements this plan task by task in this Harness session. Each task writes and commits a failing test before its code.

**Goal:** The machine removal preview names only agents and projects the machine owner may read, counts hidden entries, and keeps removal blocked when an unreadable project's PM runs on the machine.

**Architecture:** Filter preview details with the existing project access rules in the backend. Return aggregate counts for hidden agents and sole source projects, and a generic blocking reason when the Product Manager's project is unreadable. Current Desktop and Mobile clients request `/removal/v2` and require its response marker; older backends return not found, so current clients fail closed without fetching legacy data. Released clients keep the old `/removal` response shape when every detail is readable; when hidden details apply, the server refuses with a generic update-required message. Filter unreadable agent IDs from the removal command result too.

**Tech Stack:** TypeScript, Vitest, Fastify integration tests, Dart, Flutter widget tests.

**Spec:** Harness task #2297, conversation `abb59dc19a6eb0ce1ccf7c94`.

## Global Constraints

- The server enforces visibility; hidden names, IDs, project names and task titles never reach the viewer.
- Removal remains blocked by a PM on the machine, even if the viewer cannot read that PM's project.
- Two independent security reviews are required before merge.
- Before Ready, provide red/green evidence for every named risk and run the full Super Tab integration suite.
- PR body starts with: `Requested by diego@autonomous.ai through Harness.`

## Review Focus

- Hidden agents must contribute to one aggregate count without leaking identity, project, task or ID.
- A hidden PM still blocks removal while exposing only a generic reason.
- A direct removal command refused for a hidden PM must not expose its name or project.
- Hidden sole source projects contribute to an aggregate count without exposing IDs or names.
- Released clients never silently confirm removal when hidden details apply; current clients fail closed if the backend lacks the versioned preview.
- The removal command result never includes IDs of agents the actor cannot read.
- Visible agents, projects and PMs retain their existing details.
- Desktop and Mobile show aggregate counts while preserving the current visible-entry presentation.

---

### Task 1: Filter the backend removal preview

**Files:**
- Modify: `backend/src/superTabs/machines.ts`
- Modify: `backend/src/superTabs/commands.ts`
- Test: `backend/src/superTabs/machines.test.ts`

**Interfaces:**
- Consumes: `canReadAgent(state, actor, agent)` and `canReadProject(state, actor, project)` from `projects.ts`.
- Produces: version 2 previews with a response marker, readable `agents`, `hiddenAgentCount`, `blockedBy` with visible project details or `{ reason: "A Product Manager of a project you can't see runs on this machine." }`, readable `soleSourceProjects`, and `hiddenSoleSourceProjectCount`. Unversioned requests receive the legacy shape only when no hidden details exist; otherwise they receive a generic update-required refusal.

- [x] **Step 1: Write a failing unit test** named `the removal preview names only the agents and projects its owner reads`. Build a peer-contributed machine containing a worker and PM in an unreadable private project, plus an unreadable sole source project; assert that readable entries remain detailed, hidden entries are counted, and the result contains none of the hidden IDs, names, project names or task titles.
- [x] **Step 2: Run the named unit test** with `cd backend && npm test -- src/superTabs/machines.test.ts -t 'the removal preview names only the agents and projects its owner reads'`; confirm it fails because private details are currently returned.
- [x] **Step 3: Implement filtering in `removalPreview`**. Keep all agents in `hiddenAgentCount` accounting; include an agent's ID, name, project name and task only when `canReadAgent` is true. For `blockedBy`, return a project ID and name only when `canReadProject` is true, otherwise return only the generic Product Manager reason. Preserve the block in both cases. Count unreadable sole source projects in `hiddenSoleSourceProjectCount`.
- [x] **Step 4: Make `protectLead(state, agentId, actor)` generic when `canReadProject` is false**, so direct attempts to remove a machine with an unreadable PM stay blocked without returning hidden names.
- [x] **Step 5: Rerun the named unit test and the direct removal refusal integration test**; confirm both pass.
- [x] **Step 6: Commit** failing tests before the passing backend implementation.

### Task 2: Verify the route and blocked removal behavior

**Files:**
- Modify: `backend/integration/superTabs.test.ts`

**Interfaces:**
- Consumes: Task 1's removal preview response and the existing `machine.remove` command.

- [x] **Step 1: Write a failing route integration test** using a machine owner who cannot read the private project of a worker and PM on their machine. Assert the GET response contains aggregate counts and no private identifier, name, project or task; assert `machine.remove` remains refused with no private name in its error.
- [x] **Step 2: Run the new integration test** with `cd backend && npm run test:super-tabs -- integration/superTabs.test.ts -t 'removal preview'`; confirm the refusal assertion fails before the generic error fix. The unit test records the preview disclosure's red result.
- [x] **Step 3: Confirm the existing route uses the filtered `removalPreview` output** without changing its authorization boundary.
- [x] **Step 4: Rerun the new integration test** and confirm it passes.
- [x] **Step 5: Commit** the failing integration test separately.

### Task 3: Show aggregate counts in Desktop

**Files:**
- Modify: `desktop/lib/super_tabs/machines.dart`
- Test: `desktop/test/super_tab_machines_test.dart`

**Interfaces:**
- Consumes: Task 1's `hiddenAgentCount` and `hiddenSoleSourceProjectCount` response fields.
- Produces: confirmation dialog lines `N agents of projects you can't see` and `N projects have code only on this machine that you can't see` when counts are nonzero, plus a generic blocking reason for an unreadable PM.

- [x] **Step 1: Write a failing widget test** that opens the removal dialog with aggregate counts and checks that each count line is shown without any hidden name.
- [x] **Step 2: Run the named widget test** with `cd desktop && flutter test test/super_tab_machines_test.dart --plain-name 'removal preview counts projects the viewer cannot see'`; confirm the count lines are absent.
- [x] **Step 3: Parse the two aggregate count fields and either form of `blockedBy`; show its generic reason when supplied. Render aggregate count lines when positive and retain current readable-agent and readable-project details.**
- [x] **Step 4: Rerun the named widget test** and confirm it passes.
- [x] **Step 5: Commit** the failing widget test, then commit the passing UI implementation separately.

### Task 4: Keep the Mobile removal prompt in sync

Added after the independent security review found that the phone rejected a reason-only block and omitted hidden counts; the coordinator approved this client update on 2026-11-03.

**Files:**
- Modify: `mobile/lib/swarm/swarm_machine_menu.dart`
- Test: `mobile/test/swarm/swarm_machines_test.dart`

**Interfaces:**
- Consumes the same two hidden counts and either readable-project or generic-reason form of `blockedBy` as Desktop.
- Displays aggregate count lines with no private identifiers and shows a generic block without offering confirmation.

- [x] **Step 1: Write failing Mobile tests** for hidden counts in the removal warning and the generic reason for an unreadable PM.
- [x] **Step 2: Run each new test before implementation** and confirm it fails because the counts are absent and the reason-only block is rejected.
- [x] **Step 3: Parse non-negative counts and both `blockedBy` forms; render the aggregate lines and the generic block.**
- [x] **Step 4: Rerun the affected Mobile test file** and confirm it passes after the fix.
- [x] **Step 5: Commit** the failing tests separately from the implementation.

### Task 5: Preserve privacy across client versions and removal results

**Files:**
- Modify: `backend/src/routes/superTabs.ts`
- Modify: `backend/src/superTabs/store.ts`
- Modify: `backend/src/superTabs/commands.ts`
- Test: `backend/integration/superTabs.test.ts`
- Test: `backend/src/superTabs/commands.test.ts`
- Modify: `desktop/lib/super_tabs/machines.dart`
- Test: `desktop/test/super_tab_machines_test.dart`
- Modify: `mobile/lib/swarm/swarm_machine_menu.dart`
- Test: `mobile/test/swarm/swarm_machines_test.dart`

**Interfaces:**
- Current clients request the `/removal/v2` endpoint and require `previewVersion: 2`; older backends therefore fail closed without returning the legacy preview.
- Older clients receive an update-required refusal whenever hidden counts or an unreadable Product Manager apply, and the old shape when all details are readable.
- Generic Product Manager copy follows the Naming System and remains accurate across refusal paths.
- `machine.remove` returns only agent IDs readable by its actor.

- [ ] **Step 1: Add failing tests** for versioned client success, legacy client refusal with hidden data and compatibility with fully readable data, current clients rejecting an unversioned backend response, and filtering unreadable agent IDs from removal results.
- [ ] **Step 2: Implement the compatibility handshake, neutral generic copy and readable-ID filter.**
- [ ] **Step 3: Run the focused tests for each changed component.**

### Task 6: Run required verification

**Files:**
- No additional files.

**Interfaces:**
- Consumes: Tasks 1–5.

- [ ] **Step 1: Run affected backend unit tests and the full Super Tab integration suite.**
- [ ] **Step 2: Run the affected Desktop and Mobile tests and analyze changed Dart code.**
- [ ] **Step 3: Record red/green evidence in a PR comment, attach the changed Desktop screenshot, and request two independent security reviews.**

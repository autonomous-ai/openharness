# Machine Removal Privacy Implementation Plan

> **For agentic workers:** The Engineer implements this plan task by task in this Harness session. Each task writes and commits a failing test before its code.

**Goal:** The machine removal preview names only agents and projects the machine owner may read, counts hidden entries, and keeps removal blocked when an unreadable project's PM runs on the machine.

**Architecture:** Filter preview details with the existing project access rules in the backend. Return aggregate counts for hidden agents and sole source projects, and a generic blocking reason when the PM's project is unreadable. Update the Desktop confirmation to display those aggregate counts without exposing hidden names.

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
- Visible agents, projects and PMs retain their existing details.
- Desktop shows aggregate counts while preserving the current visible-entry presentation.

---

### Task 1: Filter the backend removal preview

**Files:**
- Modify: `backend/src/superTabs/machines.ts`
- Modify: `backend/src/superTabs/commands.ts`
- Test: `backend/src/superTabs/machines.test.ts`

**Interfaces:**
- Consumes: `canReadAgent(state, actor, agent)` and `canReadProject(state, actor, project)` from `projects.ts`.
- Produces: `agents` for readable agents, `hiddenAgentCount`, `blockedBy` with visible project details or `{ reason: "A PM of a project you can't see runs here." }`, `soleSourceProjects` for readable projects, and `hiddenSoleSourceProjectCount`.

- [ ] **Step 1: Write a failing unit test** named `the removal preview names only the agents and projects its owner reads`. Build a peer-contributed machine containing a worker and PM in an unreadable private project, plus an unreadable sole source project; assert that readable entries remain detailed, hidden entries are counted, and the result contains none of the hidden IDs, names, project names or task titles.
- [ ] **Step 2: Run the named unit test** with `cd backend && npm test -- src/superTabs/machines.test.ts -t 'the removal preview names only the agents and projects its owner reads'`; confirm it fails because private details are currently returned.
- [ ] **Step 3: Implement filtering in `removalPreview`**. Keep all agents in `hiddenAgentCount` accounting; include an agent's ID, name, project name and task only when `canReadAgent` is true. For `blockedBy`, return a project ID and name only when `canReadProject` is true, otherwise return only `{ reason: "A PM of a project you can't see runs here." }`. Preserve the block in both cases. Count unreadable sole source projects in `hiddenSoleSourceProjectCount`.
- [ ] **Step 4: Make `protectLead(state, agentId, actor)` generic when `canReadProject` is false**, so direct attempts to remove a machine with an unreadable PM stay blocked without returning hidden names.
- [ ] **Step 5: Rerun the named unit test and the direct removal refusal integration test**; confirm both pass.
- [ ] **Step 6: Commit** failing tests before the passing backend implementation.

### Task 2: Verify the route and blocked removal behavior

**Files:**
- Modify: `backend/integration/superTabs.test.ts`

**Interfaces:**
- Consumes: Task 1's removal preview response and the existing `machine.remove` command.

- [ ] **Step 1: Write a failing route integration test** using a machine owner who cannot read the private project of a worker and PM on their machine. Assert the GET response contains aggregate counts and no private identifier, name, project or task; assert `machine.remove` remains refused with no private name in its error.
- [ ] **Step 2: Run the new integration test** with `cd backend && npm run test:super-tabs -- integration/superTabs.test.ts -t 'removal preview'`; confirm it fails on the current unfiltered response.
- [ ] **Step 3: Confirm the existing route uses the filtered `removalPreview` output** without changing its authorization boundary.
- [ ] **Step 4: Rerun the new integration test** and confirm it passes.
- [ ] **Step 5: Commit** the failing integration test separately.

### Task 3: Show aggregate counts in Desktop

**Files:**
- Modify: `desktop/lib/super_tabs/machines.dart`
- Test: `desktop/test/super_tab_machines_test.dart`

**Interfaces:**
- Consumes: Task 1's `hiddenAgentCount` and `hiddenSoleSourceProjectCount` response fields.
- Produces: confirmation dialog lines `N agents of projects you can't see` and `N projects have code only on this machine that you can't see` when counts are nonzero, plus a generic blocking reason for an unreadable PM.

- [ ] **Step 1: Write a failing widget test** that opens the removal dialog with aggregate counts and checks that each count line is shown without any hidden name.
- [ ] **Step 2: Run the named widget test** with `cd desktop && flutter test test/super_tab_machines_test.dart --plain-name 'removal preview counts projects the viewer cannot see'`; confirm the count lines are absent.
- [ ] **Step 3: Parse the two aggregate count fields and either form of `blockedBy`; show its generic reason when supplied. Render aggregate count lines when positive and retain current readable-agent and readable-project details.**
- [ ] **Step 4: Rerun the named widget test** and confirm it passes.
- [ ] **Step 5: Commit** the failing widget test, then commit the passing UI implementation separately.

### Task 4: Run required verification

**Files:**
- No additional files.

**Interfaces:**
- Consumes: Tasks 1–3.

- [ ] **Step 1: Run affected backend unit tests and the full Super Tab integration suite.**
- [ ] **Step 2: Run the affected Desktop test and analyze changed Dart code.**
- [ ] **Step 3: Record red/green evidence in a PR comment and request two independent security reviews.**

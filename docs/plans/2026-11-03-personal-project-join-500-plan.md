# Personal Project Join 500 Implementation Plan

> Way of working: this project's Engineer role (test first, each failing test committed before its code, one pull
> request, one independent review step). No execution handoff.

**Goal:** A harness started with a first message from a project chat joins the project instead of failing with an
internal server error; in a project with no coordinator it becomes the project's Product Manager; and a join that is
still refused tells the person why and what to do.

**Architecture:** `agent.add` (backend/src/superTabs/commands.ts) records two rows in the project chat in one command:
the system row naming who added the harness (or a Product Manager's launch-refused note) and the person's first
message. Both took the command's operation id, so the command's duplicate-id guard threw a plain `Error` and the route
answered 500. The system rows get ids derived from the operation id; the first message keeps it. Desktop's join failure
(desktop/lib/super_tabs/launch.dart `_joinFailed`) names a server error or a refusal separately, each with its next step.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB, Vitest (Super Tab integration suite); Flutter/Dart (Desktop).

**Spec:** Task #2458 (Tony, 2026-11-03). Root cause, confirmed by replaying Desktop's join command against Tony's
production Swarm state, read-only: his Personal project (`lead`) had no coordinator, so New Harness joined it as a
worker (`lead` absent) with "Hi New PM Personal"; "tony added … to the project" and the message shared one id.
Without the first message the same join succeeds. Pike's #2700 (task #2296) fixes the same collision; the id lines
here match its lines so the two merge cleanly.

## Global Constraints

- PR body first line: "Requested by tony@autonomous.ai through Harness."
- Backend change: the full Super Tab integration suite (`npx vitest run -c vitest.super-tabs.config.ts`) passes before
  Ready; take the team suite lock when others run suites on this Mac.
- Desktop copy follows docs/naming-system.md; design-system roles only (`python3 scripts/check-ui-style.py`).
- Desktop tests use a memory store and a fake sign-in; nothing signs the Mac out of the real CLI.
- Swarm code stays out of cli/src/core.

## Review Focus

- A first message from the project chat (worker join): both rows stored, distinct ids, the message keeps the
  operation id (its receipt), HTTP 200.
- A Product Manager's join with a first message and a launch-refused note: both rows stored, HTTP 200.
- Replaying the same operation id returns the same result and writes nothing twice.
- Desktop, server error (HTTP 5xx): says the Harness server failed, the harness keeps running, Check status retries.
- Desktop, refusal (HTTP 4xx with a reason): shows the reason, the harness keeps running, Discard request or Check status.
- Desktop, a project chat with no coordinator: New Harness starts the PM (lead, PM prompt) and leaves the project's and
  the Swarm's names and visibility alone; a project chat with a coordinator still joins a worker.

## Tasks

### Task 1: The join with a first message answers 200 (backend)

**Files:**
- Test: `backend/integration/superTabs.test.ts`
- Modify: `backend/src/superTabs/commands.ts`

**Interfaces:**
- Consumes: `POST /api/super-tabs/:id/commands` with `agent.add` (`initialMessage`, `lead`, `launchRefused`).
- Produces: `message()` takes an optional id; the shared-to-project row uses `stableId(operationId, 'shared-to-project')`
  and the launch-refused row `stableId(operationId, 'launch-refused')`.

- [ ] Integration test through the route: a Swarm whose project chat has a coordinator; a second harness joins the
  project chat with a first message (no `lead`). Expect 200, the first message under the operation id, the system row
  under another id, and a replay of the operation id answering the same.
- [ ] Same file: a Product Manager join with `initialMessage` and `launchRefused` into a project chat with no
  coordinator. Expect 200 and both rows.
- [ ] Run both: they fail with 500 on main. Commit the failing tests.
- [ ] Give `message()` an optional id and the two system rows their derived ids. Run both: 200. Commit.

### Task 2: Desktop says why a join failed and what to do

**Files:**
- Test: `desktop/test/swarm_launch_recovery_test.dart`
- Modify: `desktop/lib/super_tabs/launch.dart`

**Interfaces:**
- Consumes: `SuperTabFailure.statusCode` and `message` from the join's command post.
- Produces: `_joinFailed` copy:
  - 5xx: "The {who} started on {machine} and keeps running there, but the Harness server had an error adding it to the
    project. Check status to try again."
  - 4xx with a reason: "The {who} started on {machine} and keeps running there, but the project did not take it:
    {reason}. Discard request, or Check status once that changes."
  - Anything else (no answer): today's copy.

- [ ] Tests: a 500 join shows the server-error copy; a 403 with a reason shows the refusal copy; Discard and Check status
  still work as before. Run: they fail on today's copy. Commit the failing tests.
- [ ] Change `_joinFailed`. Run the recovery tests and the style check. Commit.
- [ ] Screenshot of both messages in the New Harness box (in-memory render), light and dark, for the PR.

### Task 3: New Harness in a project with no coordinator starts its Product Manager (Desktop)

River, 2026-11-03: "a project with no coordinator gets its PM from New Harness in its chat, and that person's first
message goes to the PM."

**Files:**
- Test: `desktop/test/super_tab_launch_test.dart`
- Modify: `desktop/lib/super_tabs/launch.dart`

**Interfaces:**
- Consumes: `SuperTabSnapshot.projectFor`, `leadOf` (no coordinator: null).
- Produces: a launch journal with `lead: true` and `coordinator: true` for an existing project chat with no coordinator;
  `agent.add` with `lead: true`; no `project.rename`, `tab.rename` or rebinding of the Swarm's name; no visibility field.

- [ ] Tests: New Harness in a project chat with no coordinator sends `swarmRole: lead` and joins with `lead: true`, the
  first message in that join, and posts no rename; with a coordinator it stays a worker (existing tests get a
  coordinator in their fixture). Run: they fail. Commit the failing tests.
- [ ] `SuperTabLaunch.open` reads the snapshot for a new journal in an existing Swarm and marks the coordinator start;
  `complete` skips the renames and rebinding for it; the visibility field is for new Swarms and projects only.
  Run the launch and recovery tests. Commit.

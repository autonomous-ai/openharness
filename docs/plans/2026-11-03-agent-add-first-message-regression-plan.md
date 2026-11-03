# Agent Add First Message Regression Plan

**Goal:** Ensure `agent.add` can persist its join row and a person's first message together, including when a launch is refused, and report duplicate message IDs as a client error.

**Architecture:** Keep the operation ID on the user's initial message so receipts remain stable. Give ancillary system rows deterministic IDs derived from the operation ID, and raise the Super Tab's typed error when a command tries to persist duplicate message IDs.

**Tech Stack:** TypeScript, Vitest, Super Tab command reducer and integration suite.

**Spec:** Task #2296 in the Super Tab conversation; regression from #2207, with acceptance criteria for shared-agent first messages, launch-refused first messages, and duplicate-ID handling.

## Global Constraints

- Keep changes within `backend/src/superTabs/commands.ts` and `backend/src/superTabs/commands.test.ts`, plus this required plan.
- Preserve the initial message's `operationId`, receipt, and result `messageId`.
- Before Ready, record red/green evidence in a PR comment and run the full Super Tab integration suite.
- Never run a test that signs the Mac out of the real CLI.
- Start the pull request body with `Requested by diego@autonomous.ai through Harness.`

## Review Focus

- Shared-to-project `agent.add` with `initialMessage`: agent is listed, both rows have distinct IDs, and the person's message retains the operation ID.
- Lead `agent.add` with `initialMessage` and `launchRefused`: both rows persist with distinct IDs and the lead joins.
- A future collision with an existing message ID is surfaced as `SuperTabError` (client error), not a generic server error.

## Tasks

### Task 1: Cover the three command outcomes

**Files:**
- Test: `backend/src/superTabs/commands.test.ts`

**Interfaces:**
- Consumes: existing `agent.add` command schema and test fixtures.
- Produces: regression tests beside the existing #2207 tests for shared first-message join, launch-refused first-message join, and duplicate-ID error typing.

- [ ] Add a shared-agent case asserting agent membership, distinct join/message IDs, and the initial message ID equals the operation ID.
- [ ] Run the focused test and record the expected duplicate-ID failure.
- [ ] Add a lead plus `launchRefused` case asserting the lead joins and both rows have distinct IDs.
- [ ] Run the focused test and record the expected duplicate-ID failure.
- [ ] Add a duplicate existing message ID case asserting a `SuperTabError` with client status.
- [ ] Run the focused test and record that the generic error currently fails the assertion.
- [ ] Commit the failing tests before production changes.

### Task 2: Preserve stable distinct message IDs and typed errors

**Files:**
- Modify: `backend/src/superTabs/commands.ts`
- Test: `backend/src/superTabs/commands.test.ts`

**Interfaces:**
- Consumes: Task 1's command regression cases; existing `stableId` and `SuperTabError` utilities.
- Produces: deterministic ancillary message IDs (`shared-to-project` and `launch-refused`) and a typed duplicate-ID error.

- [ ] Give the shared-to-project system row `stableId(operationId, 'shared-to-project')`.
- [ ] Give the launch-refused system row `stableId(operationId, 'launch-refused')`.
- [ ] Keep the initial message on the original operation ID.
- [ ] Throw `SuperTabError` from the duplicate-ID guard with a clear client-facing error.
- [ ] Run the focused command tests and confirm all three regression cases pass.
- [ ] Commit the minimal production fix after the failing-test commit.

### Task 3: Validate backend behavior

**Files:**
- No further source files.

**Interfaces:**
- Consumes: Task 2 implementation.
- Produces: recorded evidence for backend unit tests and the full Super Tab integration suite.

- [ ] Run `npm test -- src/superTabs/commands.test.ts` from `backend/`.
- [ ] Run `npm run test:super-tabs` from `backend/`.
- [ ] Record exact commands, commit revisions, and results in the PR comment.

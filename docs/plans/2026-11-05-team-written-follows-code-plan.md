# A task is Team-written only when a Team agent's code is on it: implementation plan

Task #3304, audit finding H2 (`docs/security/2026-11-02-team-account-boundary.md`). Requested by Ken. Written by the
Engineer's way of working in the project's instructions: this plan, then each task test first, one pull request.

**Goal:** the Team-written mark follows the code. A Team agent joining a task, being named into it, posting there or
opening it no longer marks it; a Team agent assigned to build it, or GitHub showing the app's bot pushed to its pull
request, still does. A mark from a join, set before this change, clears once GitHub reads every pull request the task
records as clean.

**Architecture:** `backend/src/superTabs/teamWritten.ts` keeps the rule. The mark gets a cause (`teamWrittenBy`): a Team
assignment, or the pull requests a bot's push was read on. The joins in `commands.ts` stop calling the marker. The store
passes the pull requests it read to the command (`context.pushOriginPulls`), so a clean read can clear only a mark whose
pull requests it covered.

**Tech Stack:** TypeScript, vitest, the Super Tab store (MongoDB through Prisma, no schema change: the state is JSON).

**Spec:** the task's brief (#3304); the rule it changes is in `docs/plans/2026-11-02-team-written-branch-plan.md`, "The rule".

## Global Constraints

- Security-sensitive (the Team-written rule, audit H2): two security reviews before merge.
- Keep the rule for real Team-pushed code: GitHub's record of a bot's push, and a Team agent assigned to the task, still mark it.
- A clean read never clears a mark it did not cover: an assignment's mark and a mark from a branch read (no pull request) stay.
- `unknown` still refuses the main account; a step still reads its task's mark.
- Swarm code stays out of `cli/src/core`. Backend only.

## Design

- Growth: two optional fields on a task and its steps (`teamWrittenBy`, at most the 5 pull requests a read covers). Deleted with the conversation.
- Concurrency: the command's own transaction on the Swarm row, as today. The read happens before it; the command checks the read
  covered every pull request the task records at commit time, so a pull request added between the two keeps the mark.
- Read cost: no new GitHub read. The existing read at an assignment, an added agent, a Ready and `work.teamWritten` decides.
- Scale: unchanged; no new query.
- Compatibility: a mark without a cause is one from before this change. It is kept until a clean read covers every recorded pull
  request, so an old mark from a push or an assignment is cleared only when GitHub shows no bot's push there now. Old clients read
  `teamWritten` only.
- Migration + rollback: none needed. A rollback reads `teamWritten` as before and ignores the cause; a mark cleared meanwhile stays
  cleared, which GitHub's read justified.
- Audience: the server sets and clears it; no client's word does (`work.teamWritten` still needs the server's own read).
- Identity: GitHub's activity log, never a commit's author, as today.
- Failure: a failed read is `unknown` and clears nothing.
- Platforms: N/A because it is server code.

## Review Focus

- A Team agent named into a task by another agent's post: no mark, and no stop message to the main-account members.
- A Ready whose result names a clean pull request while the task records a bot-pushed one: the read is the worst of both, so the mark stays.
- A pull request recorded on the task after the read and before the command: the read did not cover it, so a clean read clears nothing.
- A task a Team agent was assigned, its pull request later reading clean (a person rebased the commits): the mark stays.
- A step created while its task was marked keeps a copy; clearing the task clears the step's copy of the same cause too.

---

### Task 1: joins, posts and openings no longer mark

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (`teamJoin`, `joinable`, `conversation.agent`, `conversation.create`)
- Modify: `backend/src/superTabs/teamWritten.ts` (`markTeamWritten` comment; `hasStep` removed once unused)
- Test: `backend/src/superTabs/teamWritten.test.ts`

**Interfaces:**
- Produces: `markTeamWritten(state, group, worker)` is called from `work.assign` only.

- [ ] **Step 1: Write the failing tests** in `teamWritten.test.ts`:
  - `does not mark a task when a Team agent opens it, is added to it, is named into it or posts there`: each path leaves
    `teamWritten` undefined, sends no `TEAM_WRITTEN_STOP`, and a main-account agent is then assigned the task's step.
  - Replace `is marked when a Team agent opens it or is added to it` and `marks a clean task when another agent names a Team agent into it`.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/teamWritten.test.ts`. Expected: the new test fails (marked on join).
- [ ] **Step 3: Implement**: drop the `marking(... markTeamWritten ...)` call in `teamJoin`, `joinable` and `conversation.agent`,
  and the creator clause of `conversation.create` (a step still copies its task's mark). `requireTeamWrittenAccount` stays on each.
- [ ] **Step 4: Run** the same file and `ownAccountWork.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** the test, then the code.

### Task 2: the mark has a cause, and a covering clean read clears a mark without a lasting one

**Files:**
- Modify: `backend/src/superTabs/model.ts` (`Conversation.teamWrittenBy`)
- Modify: `backend/src/superTabs/teamWritten.ts` (`markTeamWritten`, `applyPushOrigin`)
- Modify: `backend/src/superTabs/commands.ts` (`CommandContext.pushOriginPulls`; the call sites of `applyPushOrigin`; step copy)
- Modify: `backend/src/superTabs/store.ts` (`pushOriginFor` returns the pull requests it read)
- Test: `backend/src/superTabs/teamWritten.test.ts`, `backend/integration/superTabTeam.test.ts`

**Interfaces:**
- Produces: `Conversation.teamWrittenBy?: { assigned: true } | { pulls: string[] }`;
  `CommandContext.pushOriginPulls?: string[]`;
  `applyPushOrigin(state, group, origin, pulls?: readonly string[]): void`.

- [ ] **Step 1: Write the failing tests**:
  - `clears a mark from before this change once GitHub reads every pull request the task records as clean`: a task with
    `teamWritten: true`, no cause, `pullRequestUrls: [P]`, and its step's copy; a step `work.assign` of a main agent with
    `{ pushOrigin: 'clean', pushOriginPulls: [P] }` is taken and both marks are gone.
  - `keeps a mark a clean read did not cover`: same with `pushOriginPulls: []` or a different pull request: refused.
  - `keeps a Team assignment's mark through a clean read`: `f.written()`, then a clean covering read: refused.
  - `keeps a bot push's mark until a clean read covers the pull requests it was read on`: a `team` read on `[P, Q]` marks it;
    a clean read of `[P]` keeps it; a clean read of `[P, Q]` clears it.
  - `keeps a branch read's mark`: a `team` read from an `agent.start` with a branch (no pull requests) is never cleared.
  - Integration (`superTabTeam.test.ts`): the store passes the pull requests it read, and a stored legacy mark clears through it.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/teamWritten.test.ts`. Expected: the clearing tests fail.
- [ ] **Step 3: Implement**:
  - `markTeamWritten` sets `teamWrittenBy = { assigned: true }`. `applyPushOrigin('team', pulls)` sets `{ pulls }` (merged with an
    earlier push's pulls; never over an assignment).
  - `applyPushOrigin('clean', pulls)`: for the task and each of its steps, a mark is cleared when it is not an assignment's,
    the task records at least one pull request, every one of them is in `pulls`, and a push mark's own pulls are all in `pulls`.
  - `pushOriginFor` returns `{ origin, pulls }`; `executeOnce` sets `context.pushOriginPulls` from it (empty for a branch read).
  - A step opened on a marked task copies the task's cause.
- [ ] **Step 4: Run** the file, `ownAccountWork.test.ts`, `src/github/pushOrigin.test.ts`, and the integration file. Expected: PASS.
- [ ] **Step 5: Commit** the tests, then the code, and update the rule in `docs/plans/2026-11-02-team-written-branch-plan.md`
  and the H2 status in `docs/security/2026-11-02-team-account-boundary.md`.

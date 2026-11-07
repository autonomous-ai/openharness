# GitHub Reads After Access Implementation Plan

> Written by the project's writing-plans way of working: the Engineer implements it task by task, test first.

**Goal:** A command's pre-command GitHub reads (push origin, branch origin, repository reach, pull request files, merges and
heads) run only once the server knows the caller may run that command, so a refused caller makes the server call GitHub
zero times (task #4388).

**Architecture:** `SuperTabStore.executeOnce` reads GitHub before the command's transaction, and each read loads the Swarm
with no check of who asks. The actor resolution `executeOnce` does (person, agent, the crew dispatch's PM, a pool host)
moves into one method, `commandActor`, which both the command and a new gate, `callerMay`, use. `callerMay` resolves the
actor on the read's own loaded state and runs `authorizeCommandAccess` (membership, viewer write, and the audience of the
conversation, project, agent or start the command names). Every read calls it right after its load, before any GitHub
call; a refusal throws a `SuperTabError`, which every read already turns into "nothing read", so the command then refuses
in its own transaction exactly as today.

**Tech Stack:** TypeScript backend, Prisma on MongoDB, vitest with a loopback replica set.

**Spec:** task #4388's brief (conversation 160568e5b75f6183be3c4491).

## Global Constraints

- Backend only; next backend release. No change to what a member sees or can do.
- A refused command's error says no more than it does today.
- Never log a token or the app's credentials.
- Owns `backend/src/superTabs/`.

## Review Focus

- A stranger's command on a real task and on a made-up one refuses alike, so the refusal tells nothing of the task (tested).
- A viewer (read-only member) who can read the task still triggers no read: the gate checks write access, not only reads (tested).
- The crew dispatch's work.assign as the project's PM still reads push origin and reach (covered by `crewDispatch.test.ts`).
- The gate adds no Swarm load: it runs on the state each read already loaded (`superTabCommandLoads.test.ts` stays green).
- A Ready's head read after the command keeps reading for the member who sent it (tested through work.status review).

---

### Task 1: Refused callers make no GitHub call

**Files:**
- Create: `backend/integration/superTabGithubCallers.test.ts`
- Modify: `backend/vitest.super-tabs.config.ts` (include the new file)
- Modify: `backend/src/superTabs/store.ts` (`executeOnce`, `pushOriginFor`, `repositoryReachFor`, `pullRequestFilesFor`,
  `pullRequestMergesFor`, `verdictHeadRead`, `readyHeadRead`, `headsReadNow`)

**Interfaces:**
- Produces: `private async commandActor(tx: Transaction, user: AuthUser, state: SuperTabState, command: Command, caller: Caller): Promise<Actor>`
  and `private async callerMay(tx: Transaction, user: AuthUser, state: SuperTabState, command: Command, caller: Caller): Promise<void>`,
  with `interface Caller { asAgentId?: string; hostMachineId?: string; workspaceLeave: boolean; asProjectPm?: string }`.
- Each read takes a `may: (tx: Transaction, state: SuperTabState) => Promise<void>` and awaits it after its load.

- [ ] **Step 1: Write the failing test**

A Swarm whose project is on `https://github.com/acme/app`, with a task linking pull request 7, a step of it, the owner's
instructions holding a rule the task carries, a viewer member and a signed-in stranger. Every GitHub hook is a `vi.fn`
counter. For each of work.assign, work.status review, work.check with a head, conversation.agent present,
work.teamWritten, agent.start and lead.start naming a branch, and instructions.save:
- `it('a stranger\'s and a viewer\'s <command> is refused with zero GitHub calls')`: both reject; every counter is 0.
- `it('a member\'s <command> still reads GitHub')`: the owner's same command calls its hook.
- `it('a stranger is refused alike on a real task and a made-up one')`: same code, status and message.

- [ ] **Step 2: Run it to see it fail**

Run: `cd backend && npx vitest run --config vitest.super-tabs.config.ts integration/superTabGithubCallers.test.ts`
Expected: the refused-caller cases FAIL with the hook called (the member cases pass).

- [ ] **Step 3: Implement `commandActor` and `callerMay` in `store.ts`, and gate every read**

`executeOnce` builds its actor through `commandActor` (no behavior change) and hands each read
`may = (tx, state) => this.callerMay(tx, user, state, command, caller)`.

- [ ] **Step 4: Run it to see it pass, with the store's GitHub tests**

Run: `cd backend && npx vitest run --config vitest.super-tabs.config.ts integration/superTabGithubCallers.test.ts integration/superTabReviewSteps.test.ts integration/superTabTeam.test.ts integration/superTabInstructions.test.ts integration/superTabPullRequestEvents.test.ts integration/crewDispatch.test.ts integration/superTabCommandLoads.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** the test first (red), then the code (green).

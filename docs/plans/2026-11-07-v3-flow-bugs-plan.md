# v3 flow bugs (#1, #7, #8 of the #4212 audit) Implementation Plan

> Written by the writing-plans skill; the Engineer implements it task by task, test first, as the project's instructions say.

**Goal:** A Regular agent's own chat is read and delivered; a member's own agents reach the PM's route for projects they read; a PM still in a Harness Team account gets one clear refusal that says how to move it, and the move works.

**Architecture:** Three backend-only fixes under `backend/src/superTabs/`. The read rule for private chats stops counting agent chats as closed Chat with PM. The machine read stops turning the join's `teamAccountOnly` mark into a Team-account refusal. A team session's refused coordination commands get a named refusal for a PM, and the crew dispatch says why it skips that PM's project. CLI 0.5.63 needs no change: it reads `teamWork` from the backend.

**Tech Stack:** TypeScript, vitest, MongoDB memory replica set (integration tests through `SuperTabStore`).

**Spec:** Task #4248 brief; findings 1, 7 and 8 in task #4212.

## Global Constraints

- Verify each finding first. Test first. Never read or print a secret or login.
- Owns: `backend/src/superTabs/`, `cli/src/superTabs/` (tests in `backend/integration/`).
- A real-store test per finding.
- A team session still reaches nothing in a main account (task #4120, `integration/superTabTeam.test.ts` "still reaches nothing in a main account").
- Clients from the last 30 days keep working: `machine.contribute` still takes `teamAccountOnly`, and the stored mark stays (Desktop `launch.dart` reads it).

## Review Focus

- A Regular agent's chat after its person leaves and rejoins: still nobody's (the audience generation check stays).
- A closed Chat with PM from before Buddies: still nobody's.
- A computer listed on join whose person cannot read the project: still refused at the pick (`teamWorkCheck`), only the per-machine read changes.
- A Team account's own pool (`hostMachineId`) still reads as refused.
- A Team-account agent that is not a PM keeps the plain team-session refusal.

---

### Task 1: A Regular agent's own chat is read and delivered (#1)

**Files:**
- Modify: `backend/src/superTabs/projects.ts` (`isClosedPmChat`)
- Test: `backend/integration/superTabV3Flows.test.ts` (new)

- [ ] **Step 1: Write the failing test** `a Regular agent's own chat is in its person's read, opens, takes read marks, and reaches the agent`: member joins, lists a computer, `agent.new` kind regular, agent started; `store.read(member)` lists the chat; `readConversation` through the store answers; a member message there is delivered to the agent (delivery row exists and the agent claims it); the agent's reply is in the member's read.
- [ ] **Step 2: Run it** `npx vitest run integration/superTabV3Flows.test.ts` — FAIL (chat missing from the read).
- [ ] **Step 3: Implement** `isClosedPmChat(group)`: false for an agent chat (`isAgentChat`).
- [ ] **Step 4: Run it** — PASS. Run `src/superTabs/agentNew.test.ts`, `projects.test.ts`, `decisions.test.ts`.
- [ ] **Step 5: Commit** test, then fix.

### Task 2: A member's computer listed on join reads as taking projects' work (#8)

**Files:**
- Modify: `backend/src/superTabs/machines.ts` (`teamWorkRefusal`, `teamAccountOnly` comment)
- Test: `backend/integration/superTabV3Flows.test.ts`; unit tests that pinned the old rule (`ownAccountWork.test.ts`, `teamRouting.test.ts` and others the run names)

- [ ] **Step 1: Write the failing test** `a member's computer listed as they joined reads as taking the owner's projects' work`: member contributes with `teamAccountOnly: true` and reports a reading; `store.read(owner).state.machines` row for it has `teamWork: { allowed: true }`; the same through `SwarmReads.firstLoad` derived machines.
- [ ] **Step 2: Run it** — FAIL (`TEAM_ACCOUNT_REQUIRED`).
- [ ] **Step 3: Implement**: drop `pool.teamAccountOnly` from `teamWorkRefusal`'s early return; the mark is kept for older Desktop clients only.
- [ ] **Step 4: Run it** — PASS; update the unit tests that asserted the old refusal.
- [ ] **Step 5: Commit** test, then fix.

### Task 3: A PM in a Team account is told how to move, and the move works (#7)

**Files:**
- Modify: `backend/src/superTabs/store.ts` (`teamCommand` takes the acting agent; `dispatchCrew` skip)
- Test: `backend/integration/superTabTeam.test.ts`

**Interfaces:**
- Produces: refusal code `PM_IN_TEAM_ACCOUNT` (403): "This {PM name} runs in a Harness Team account, which starts and assigns no agents now. {owner} moves it to their own computer with Switch PM; it keeps its chat and tasks, and starts agents there in their own account. Until then it keeps coordinating."

- [ ] **Step 1: Write the failing test** `a PM in a Team account is refused assigning or starting with how to move it, and its owner's Switch PM moves it to their own computer`: a PM of the person's project on their Team machine; as the team session, `work.assign` of the person's own agent and `agent.start` on the person's own computer and on the Team machine are refused with `PM_IN_TEAM_ACCOUNT` and the text naming the person and Switch PM; `lead.switch` by the person to their own computer queues a start there; the dispatch pass skips the project with `PM_IN_TEAM_ACCOUNT`.
- [ ] **Step 2: Run it** — FAIL (`TEAM_SESSION_LIMITED` / `TEAM_ACCOUNTS_REMOVED`, no skip code).
- [ ] **Step 3: Implement** in `teamCommand(state, team, user, command, asAgentId?)`: when the actor leads a project, `work.assign`, `conversation.agent` and `agent.start` are refused with `PM_IN_TEAM_ACCOUNT`; other agents keep `TEAM_SESSION_LIMITED`. `dispatchCrew` counts `PM_IN_TEAM_ACCOUNT` for a project whose PM is on a Team account.
- [ ] **Step 4: Run it** — PASS; run the rest of `superTabTeam.test.ts`.
- [ ] **Step 5: Commit** test, then fix.

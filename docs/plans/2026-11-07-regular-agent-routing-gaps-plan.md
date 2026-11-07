# Routing gaps for Regular agents after Swarm v3: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** fix the six gaps anh Dee's Buddy found in its code review of main 0413586e (task #4218, 2026-11-07), each verified
against main d1f33f5ca first. All six are real; none was dropped.

**Architecture:** six small fixes in backend/src/superTabs, one per finding:

1. **Read says Team-account rules on an own computer** (machines.ts teamWorkRefusal, the finding's routeCommand.ts:385). The Swarm
   read still gives `teamWork.allowed: false, TEAM_ACCOUNT_REQUIRED` for any machine without a Team session when the machine was
   added at join (`teamAccountOnly`) or `SWARM_TEAM_ACCOUNT_REQUIRED=1`. The CLI route turns that into `teammatesRefused` and
   leaves out every teammate's own agent there. The server's own check (teamWorkCheck, task #4120) allows that agent. Fix: a
   machine that is not a Team account reads no Team-account refusal. A Mac reads as itself, no longer as its Team account,
   whose privacy check left its person's own agents out the same way. The `required` parameter goes, and so does the
   "Team account joining" reading (#3122), which can no longer happen, with the database read behind it. Team account entries
   keep their reading until #4120's follow-up removes them.
2. **An assigned Regular agent gets no project code** (commands.ts assignTo, the finding's start.ts:428). A Regular agent starts
   in its own empty folder. Assigning it a task changes only its project membership, and the brief does not say where the code
   is. Fix: its task message names the project's code: the GitHub address to clone into its own folder with its person's own
   git, or the checkout on this computer to make a worktree of. When there is neither, it says so.
3. **Automatic picks skip idle Regular agents** (dispatch.ts freeCrew). freeCrew keeps only agents whose project is this one, and
   an idle Regular agent has none. A task the PM routed (pinned) to it is never handed over. The write-time check
   (store.ts) calls candidatesFor without the project's open tasks, so it also reads the Regular agent's empty project. Fix: an
   idle Regular agent is free crew of every project it may work in (projects.ts regularMayWorkIn, exported). candidatesFor takes
   the open tasks as a required argument, and the write-time check passes its project's. A second project's pick of an agent
   placed in the same pass is refused at write time (DISPATCH_STALE), bounded by DISPATCH_TRIES as any stale pick is.
4. **A closed Regular agent never returns** (closedAgents.ts). A closed session removes the agent. Its record is dropped
   because its own chat has an audience, so it counts as confidential. A restore would be refused anyway (`project-ended`) and
   would skip its chat. Fix: a Regular agent is not removed when its session closes, the same as a Buddy. It stays listed as
   closed, in its chat, and is back when its session runs again. Only its person's stop removes it.
5. **A rejection doesn't settle the proposal** (commands.ts task.reject, proposalCards.ts:206). task.reject writes only
   `taskApproval`. The proposal keeps no decision, so the PM is told it is overdue and can still accept it into a task that can
   never run. Fix: a rejection also records the proposal's decision as `no` with the reason, and clears its overdue mark.
6. **A pending approval strands after rejoin** (taskApproval.ts:40, commands.ts member.remove). Approval belongs to the
   requester's membership. When they leave, nobody can approve or reject it again and the task stays open forever. Fix: when a
   person leaves, every approval of theirs still in `proposal` is rejected ("Its requester left the Swarm."), settled as in 5,
   and its PM is told. A rejoined person gets no authority back (plan 2026-11-07-swarm-v3-approval-plan.md).

**Tech Stack:** TypeScript backend, vitest.

**Spec:** task #4218's brief; docs/specs/2026-11-07-swarm-v3.md; docs/plans/2026-11-07-regular-or-pm-agents-plan.md.

## Global Constraints

- Only backend/src/superTabs. No CLI or Desktop change.
- No code path reads a login or a secret. A Regular agent still works only where its person can read.
- One rejection path: task.reject and a leave share one helper.

## Design

- growth: no new records. A proposal's decision and a rejected approval are fields that exist already. A closed Regular agent stays
  listed until its person stops it, as a Buddy does (bounded by the Swarm's agent limit).
- concurrency: the Swarm's usual single write per command.
- read cost: unchanged. freeCrew reads the loaded state; regularMayWorkIn is one people lookup and one project read per agent.
- scale: 10x agents are 10x freeCrew rows per project pass, inside the existing per-agent cost. The dispatch pass time warns first.
- compatibility: backend only. Older clients read the same fields. An older CLI route reads the corrected `teamWork`.
- migration and rollback: none. Rolled back, the gaps return; no data needs undoing.
- audience: unchanged. The server enforces it (teamWorkCheck, regularMayWorkIn, authorizeTaskApproval).
- identity: a Regular agent clones with its own person's git on their own computer, never the machine owner's.
- failure: a Regular agent with no reachable code is told so in its task message.
- platforms: backend (Linux in CI).

## Review Focus

- That 1 only drops Team-account refusals of machines that are not Team accounts, and that teamWorkCheck still enforces access.
- That 3 never hands a Regular agent work in a project its person cannot read, or outside its private project.
- That 4 leaves the stop path (agent.release stop, agent.remove) removing a Regular agent as before.

## Tasks

### Task 1: own computers read no Team-account refusal

**Files:** backend/src/superTabs/machines.ts, store.ts, read/views.ts, read/service.ts, and the tests teamRouting, ownAccountWork,
computerMoves.

**Interfaces:** `teamWorkRefusal(pool, now, teamRow, otherWorkspace)` (no `required`); `machineTeamWork(pool, now, teamMachines,
otherWorkspaceMachines)` (no state, no joining list); `joiningTeamMacs` and `store.joiningTeams` removed.

- [ ] Change the tests that pinned the pre-v3 rule to the v3 one: a machine with no Team session (added at join, or under
      `SWARM_TEAM_ACCOUNT_REQUIRED=1`) reads `teamWork` allowed. Watch them fail.
- [ ] Drop the `required` and `teamAccountOnly` refusal in teamWorkRefusal; watch them pass.

### Task 2: a Regular agent's task names its project's code

**Files:** backend/src/superTabs/commands.ts, backend/src/superTabs/regularAssign.test.ts

- [ ] Test: Ada assigned a task in a project with a GitHub address; the task message names it. A project checked out on Ada's
      computer names that folder. One with neither says the code is not reachable. Watch it fail.
- [ ] Add the line in assignTo for `worker.regular`; watch it pass.

### Task 3: dispatch hands work to idle Regular agents

**Files:** backend/src/superTabs/dispatch.ts, backend/src/superTabs/projects.ts, backend/src/superTabs/store.ts,
backend/src/superTabs/regularAssign.test.ts

**Interfaces:** `regularMayWorkIn` exported from projects.ts.

- [ ] Test: a task pinned to idle Ada is in dispatchPlan for its project; not for a project Ada's person cannot read. Watch it fail.
- [ ] freeCrew takes idle Regular agents that may work in the project; the write-time check passes the project's open tasks.
      Watch it pass.

### Task 4: a closed Regular agent stays and returns

**Files:** backend/src/superTabs/closedAgents.ts, backend/src/superTabs/regularAssign.test.ts

- [ ] Test: Ada's session proved stopped past STOPPED_REMOVE_MS is not in closedAgents, so she stays in her chat. Watch it fail.
- [ ] `removable` leaves out Regular agents; watch it pass.

### Task 5: a rejection settles its proposal

**Files:** backend/src/superTabs/taskApproval.ts, backend/src/superTabs/commands.ts, backend/src/superTabs/taskApproval.test.ts

**Interfaces:** `rejectTaskApproval(group, reason, by, now)` in taskApproval.ts.

- [ ] Test: a Review-mode proposal rejected by its person; `proposal.decide accept` is refused PROPOSAL_DECIDED and the proposal
      has decision `no`. Watch it fail.
- [ ] task.reject goes through rejectTaskApproval; watch it pass.

### Task 6: a leave settles the person's pending approvals

**Files:** backend/src/superTabs/commands.ts, backend/src/superTabs/taskApproval.test.ts

- [ ] Test: the requester leaves with a task awaiting their approval; it is rejected with the reason and its PM is told. Watch it
      fail.
- [ ] member.remove rejects them through rejectTaskApproval; watch it pass.

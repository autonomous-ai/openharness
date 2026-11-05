# The Swarm hands the next task to a free crew member: implementation plan

> Implemented by the task's Engineer the project's way (project instructions, Engineer): task by task, test first, each
> failing test committed before the code that passes it. No per-task review; the pull request's review step is the one
> independent review. No Execution Handoff.

**Goal:** The server, not the PM, gives work to the crew: every 30 seconds and right after the events that free a member
or open a task, each free crew member gets its pinned work, then its lane's top task (P0 first, then queue order). Two
hours without progress sends the member a line; three hours puts the task back in its lane with the reason. The board
can group tasks by member.

**Architecture:** A pure module `backend/src/superTabs/dispatch.ts` decides (lanes, who is free, pins, the next task,
the clocks, the capacity line) from the state alone. `SuperTabStore.dispatchCrew(tabId)` reads a Swarm once, asks
`dispatchPlan` for its picks and sends each through the existing `work.assign` command, as the project's PM, in that
command's own transaction: `WORK_ACTIVE` and `AGENT_BUSY` already refuse a second assignment inside the write, and the
pick's operation id is stable (`dispatch:<task>:<attempt>`), so two racing passes replay or collide instead of assigning
twice. The backend worker runs the pass every 30 s over Swarms with crew; API processes run it after a commit that can
free a member or open a task. The two clocks run in the liveness sweep that already loses tasks (liveness.ts), through
its `loseTask`. Desktop adds Group by Member to the board.

**Tech Stack:** TypeScript backend (vitest unit tests; the Mongo integration suite runs in PR CI), Flutter Desktop
(flutter_test, memory store and fake sign-in).

**Spec:** Task #3400 brief and its two acceptance checks (anh Dee's Swarm redesign, approved 2026-11-05).

## Global Constraints

- PR body first line: "Requested by Dee through Harness."
- Owns `backend/src/superTabs/`, `backend/src/worker.ts`, `desktop/lib/super_tabs/` (and their tests).
- Numbers live in one place, `DISPATCH_RULES` in `dispatch.ts`, until the project rules record (#3393) lands; then
  `lanes` is read from its `lanes` section (`{ name, owns[] }`, the same shape) and the rest from the fields it adds.
- No new refusal code: removedRefusals.test.ts stays green. A dispatch refused by `work.assign` is skipped and logged by
  code, never retried in a loop.
- Swarm code stays out of cli/src/core. Tests never sign the Mac out of the real CLI. Temp files only in mktemp -d.

## Sibling interfaces (agreed in their tasks)

- Crew (#3397, Keeper): `Agent.crew?: { role: string; at: number; by: string; lane?: string }` and `isCrew(agent)`.
  `lane` is the one field this task asks Keeper to add (`crew.add` takes an optional `lane`). Until #3397 merges this
  branch declares the same field in model.ts; whichever lands second keeps one copy.
- Sleep and move (#3398, Heron): `Agent.asleep?: { since: number }` and `Agent.movedTo` on the agent record. An asleep
  crew member counts as free, and its assignment wakes it in the same write (asked of Heron: `work.assign` wakes an
  asleep crew member instead of refusing its closed session); a member with `movedTo` is skipped.
- Handed (#3399, Handoff): `occupiesAgent(group)` (active work that is not handed) and `handed(group)` from handed.ts.
  Until #3399 merges, dispatch.ts has the same two rules locally (handed = a task's own `review` status); then it imports
  them. Before #3399, `work.assign` still refuses an agent with a handed task (`AGENT_BUSY`): the pass skips it.
- Rules record (#3393, Ledger): `lanes` as above; `DISPATCH_RULES` moves there.

## Design

- **Growth:** two small fields per task (`lane` set by the PM, `pin` cleared at its assignment) and one per assignment
  (`nudgedAt`); nothing else stored. The pass stores nothing of its own.
- **Concurrency:** every assignment is one `work.assign` transaction (group and agent parts written, so a concurrent
  write retries). Stable operation ids make racing passes (worker and API, two API processes) replay one receipt or
  collide (`OPERATION_REUSED`, `WORK_ACTIVE`, `AGENT_BUSY`), never assign twice.
- **Read cost:** the 30 s pass lists only Swarms with a crew agent (one query on agent parts, `data.crew` set), then
  loads each such Swarm's active state once; an event pass loads only the Swarm that changed.
- **Scale:** 10x crew is 10x picks per pass, each a small transaction; the pass's log line (`[swarm-dispatch]` assigned,
  skipped by code, ms) warns first.
- **Compatibility:** older clients ignore `lane`, `pin`, `nudgedAt` and `derived.lanes`; an older CLI reads the
  assignment as any other. A project with no crew is untouched: the PM assigns as today.
- **Migration + rollback:** none. Rolling back stops the dispatch; assignments it made are ordinary assignments.
- **Audience:** the server picks and assigns as the project's PM; only the PM or a person of the project sets a lane
  (`work.lane`), as `work.queue` is guarded.
- **Identity:** assignments are made as the project's PM agent (the actor the PM itself would be), never as a person or
  the machine owner. A project with no PM is not dispatched (logged).
- **Failure:** a refused pick is logged by code and left for the next pass; the 2 h line and the 3 h return each post in
  the task (the return also to the PM, as any loss does); nothing changes silently.
- **Platforms:** backend only, and the shared Desktop board (macOS, Windows, Linux, web alike).

## Review Focus

- Two passes at once (worker and an API process) over one free member and two tasks: one assignment each, never two
  tasks to one member, never one task to two members (Task 3 integration test).
- A member that lost a task to the 3 h clock is not handed the same task again at once (Task 2 test).
- A P0 task deep in the queue beats the queue's first P2 (Task 2 test); a `notBefore` in the future, a step, an archived
  task or a chat is never picked (Task 2 test).
- A pinned task whose member left the crew or the Swarm goes to its lane, not nowhere (Task 2 test).
- Waiting on a person or on review stops the clocks (Task 4 test).

---

### Task 1: Lanes and the task's lane

**Files:**
- Create: `backend/src/superTabs/dispatch.ts`, `backend/src/superTabs/dispatch.test.ts`
- Modify: `backend/src/superTabs/model.ts` (Conversation `lane?`, `pin?`; Assignment `nudgedAt?`; Agent `crew?`),
  `backend/src/superTabs/commands.ts` (`work.lane`)

**Interfaces:**
- Produces: `interface Lane { name: string; owns: string[] }`; `DISPATCH_RULES = { everyMs: 30_000, maxHanded: 3,
  nudgeAfterMs: 2 * HOUR, returnAfterMs: 3 * HOUR, lanes: [backend: backend/, CLI: cli/, Desktop: desktop/,
  mobile: mobile/, docs: docs/] }`; `laneOf(group, lanes): string | null`: the PM's `group.lane` if set, else the lane
  owning most of the task's `owns` paths (prefix match; a tie goes to the table's first), else null.
- Command `{ type: 'work.lane', conversationId, lane: string | null }`: the PM or a person of the project (the
  `work.queue` guard); the lane name is matched to the table case-insensitively and stored as the table writes it.

- [ ] Failing tests: owns `backend/src/x.ts` -> backend; `desktop/lib/a.dart` + `backend/src/b.ts` + `desktop/test/c`
  -> Desktop; no match -> null; the PM's lane wins over paths; `work.lane` by the PM and by a person sets it, by another
  agent is refused as `work.queue` is, null clears it.
- [ ] Implement; run `npm test -- src/superTabs/dispatch.test.ts src/superTabs/commands.test.ts`; commit test, then code.

### Task 2: Who is free, and what each free member gets

**Files:** `dispatch.ts`, `dispatch.test.ts`

**Interfaces:**
- Produces: `freeCrew(state, projectId, rules): Agent[]`: crew agents of the project (not the PM, not a Buddy, not
  stopping, not moving (`movedTo`), session not closed unless asleep, no pending start) with no occupying task and fewer than `maxHanded` handed tasks, longest
  free first. `dispatchPlan(state, projectId, rules, now): Pick[]` with
  `Pick = { conversationId: string; agentId: string; why: 'pin' | 'lane'; lane: string | null }`: each member takes
  first a task pinned to it (oldest pin first), then its lane's top open task (a member with no lane, whose role is
  Engineer, takes the project's top task). Open = a task with a brief, no active work, not a step, not archived, not
  cancelled or done, `notBefore` not after today. Order: P0 first, then `queueOrder`. Each task goes to one member.
  A task lost by this member to the 3 h clock is skipped for it.

- [ ] Failing tests: pins before the lane's top; P0 beats queue order; one task, two free members -> one pick; a member
  with an occupying task or 3 handed tasks is not free; a member with 2 handed tasks is; the PM, a Buddy, a stopping agent, a moving one
  and a non-crew agent get nothing; an asleep member is free; a pin whose member left the crew goes to the lane; the 3 h loser is skipped; future
  `notBefore`, steps, archived and chats are never picked.
- [ ] Implement; run the file; commit test, then code.

### Task 3: The pass, as the PM, through work.assign

**Files:**
- Modify: `backend/src/superTabs/store.ts` (`dispatchCrew`, the after-commit trigger), `backend/src/worker.ts`
- Create: `backend/src/superTabs/dispatchPass.ts` (`startCrewDispatch`, the Swarm listing),
  `backend/integration/crewDispatch.test.ts`

**Interfaces:**
- Produces: `SuperTabStore.dispatchCrew(tabId): Promise<{ assigned: number; skipped: Record<string, number> }>`;
  `startCrewDispatch(db, store, everyMs = DISPATCH_RULES.everyMs): () => void`. Each pick is
  `executeOnce(PM's host user, tabId, { operationId: stableId('dispatch', task, String(attempts)), command: work.assign },
  leadId)`. Triggers after commit: `work.status` (done, review, stopped), `work.cancel`, `conversation.create`,
  `work.define`, `work.priority`, `work.queue`, `work.lane`, and losses.

- [ ] Failing integration tests (fresh replica set, never DATABASE_URL): a free crew member is assigned its pin, then its
  lane's top task; two `dispatchCrew` passes run together over one member and two tasks leave exactly one assignment
  (one task, that member); a project with no crew is untouched; a refused pick (Team-written task, main-account member)
  is skipped and the next task is tried.
- [ ] Implement; run `npm test -- integration/crewDispatch.test.ts` once locally; commit test, then code.

### Task 4: The 2 h line and the 3 h return

**Files:** `backend/src/superTabs/liveness.ts` (in `lostReason` / `sweepLiveness`), `dispatch.ts`, `dispatch.test.ts`

**Interfaces:**
- Produces: `crewClock(state, group, worker, assignment, now, rules): 'nudge' | 'return' | null` from the assignment's
  own progress (`progressAt`, else when it was assigned), only for crew members' tasks in `working`. `nudge` posts one
  line to the member in the task (`assignment.nudgedAt`, once per assignment): "No progress on this task for 2 hours.
  Post where it stands, or set it blocked with why; at 3 hours it goes back to the <lane> lane." `return` loses the task
  with the reason "no progress for 3 hours: back in the <lane> lane".

- [ ] Failing tests: at 2 h one line, not twice; at 3 h the task is lost with that reason and appears in `dispatchPlan`
  for another member, not the same one; `needs_human`, `blocked` and handed tasks never tick; a non-crew worker is
  unchanged; progress at 1 h 59 restarts both clocks.
- [ ] Implement; run the file and liveness.test.ts; commit test, then code.

### Task 5: Pins for findings, red CI and conflicts

**Files:** `commands.ts` (`work.check`, `work.assign` clears), `store.ts` (`pullRequestSeen`), `dispatch.ts`, tests

**Interfaces:**
- Produces: `Conversation.pin?: { agentId: string; why: 'findings' | 'ci' | 'conflict'; at: number }`, set on a task with
  no active work for its last builder (its assignment's or `lostAttempt`'s agent) when another agent's check fails
  (findings), or the PR watch reads a failed check run at the head (ci) or `mergeable === false` (conflict); cleared by
  any `work.assign`.

- [ ] Failing tests: a Reviewer's failed check on a lost task pins it to its builder; the builder's own failed check does
  not; red CI and a conflict pin; a green run does not; an assignment clears the pin.
- [ ] Implement; commit test, then code.

### Task 6: The capacity line per lane

**Files:** `dispatch.ts`, `read/views.ts` (`derived.lanes`), `read/contract.ts`, tests

**Interfaces:**
- Produces: `laneCapacity(state, projectId, rules, now): Array<{ lane: string; waiting: number; busy: number;
  oldestAt: number | null }>` and `capacityLine(c, now)`: `Desktop: 6 waiting, 2 busy, oldest 2 h`. Read:
  `derived.lanes: Record<projectId, LaneCapacity[]>` for projects with crew.

- [ ] Failing tests: counts and oldest for one lane; `capacityLine` reads exactly `Desktop: 6 waiting, 2 busy, oldest 2 h`;
  no crew -> no entry.
- [ ] Implement; commit test, then code.

### Task 7: Desktop: Group by Member

**Files:** `desktop/lib/super_tabs/tasks_view.dart`, `desktop/lib/super_tabs/model.dart`, a new
`desktop/lib/super_tabs/member_groups.dart`; `desktop/test/super_tab_member_groups_test.dart`

- [ ] ASCII mockup posted in the task first (the PM brings it to anh Dee; work goes on, his look comes after merge).
- [ ] Failing widget test (memory store, fake sign-in): Group by Member lists each member with its lane and its tasks,
  then Unassigned; the lane capacity lines show at the top; the default board is unchanged.
- [ ] Implement by the Harness design language; run the test file and the board's existing tests; commit test, then code.

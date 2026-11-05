# An engineer is free once its PR is ready for review: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** A task whose pull request is ready for review is handed over: its Engineer is free for new work, keeps its
GitHub push access to fix findings, and the task comes back to it on a No verdict, red CI or a merge conflict. If that
Engineer is down, or has not picked it back up within 60 minutes, the task is released so anyone free in the lane takes
it (task #3399, requested by Dee through Harness).

**Architecture:** "Handed" is the `review` status of a task (not a step), the status its Engineer sets when it marks the
pull request ready. A new module `backend/src/superTabs/handed.ts` holds the rule and its one constant:
`handed(group)`, `occupiesAgent(group)` (active work that is not handed), `reopenHanded(...)` and `REOPEN_OWNER_MS`.
`activeWork` keeps meaning "the task is open" (archive, steps, deletion and token holds all need that); every check
that asks "is this agent busy" reads `occupiesAgent` instead. A reopen puts the same assignment back to `working`, so the
assignment id, the GitHub token hold and "built by" (the run ledger) do not change.

**Tech Stack:** TypeScript backend (vitest unit tests; the Mongo integration suite runs in PR CI).

**Spec:** task #3399 brief and its two acceptance checks.

## Design note

**States.**

| From | Event | To |
| --- | --- | --- |
| working | Engineer's own Ready (`work.status review`) | review = handed: Engineer free, hold kept |
| review (handed) | a failed check by someone other than the Engineer (a Reviewer's or Tester's No; sibling #3394 makes that the verdict signal), or a step's own agent failing its step check | working, `reopened {at, why}`, Engineer told |
| review (handed) | PR watch: CI failed on the current head, or a merge conflict | working, `reopened`, Engineer told in the same CI/conflict message |
| working + reopened | Engineer's own status, check or post in the task | working (pick-up; `reopened` cleared) |
| working + reopened | 60 minutes (`REOPEN_OWNER_MS`) with no pick-up, or the Engineer is down (session stopped, machine offline, usage limit) | lost, so the PM (or #3400's dispatcher) hands it to anyone free in the lane |
| review (handed) | Engineer sets done after merge | done; hold and run released as today |

A handed task is never lost for its Engineer's machine or session: nothing waits on that agent. One exception to the
reopen: a grid attempt whose review failed is not pinned to its grid agent, since its next attempt steps up to a stronger
model (decision 8); it stays in review for the coordinator to route, as before. A step's own Ready
(a Reviewer's or Tester's) is not a handover; steps keep today's rules.

**Why not a new `handed` WorkStatus.** Older CLIs and Desktop read the status and show "Ready for review"; a new value
would show as unknown on every client released before this change. The `review` status already means exactly "the PR is
ready", so it is the state; `Assignment.reopened` is the only new field.

**Token holds.** `github/holds.ts` HOLDING keeps `review`, so a handed task keeps its hold and the Engineer can push fixes.
A reopen keeps the assignment id, so no hold starts or ends. While the Engineer holds two tasks (one handed, one new),
`githubAssignment` gives the token for the task in its hands first (working/needs_human/blocked), then the handed one, so
a handed task's merge (which revokes its tokens) never revokes the token the new task is pushing with.

**Assignment ids and run records.** The new task gets its own assignment id as today. The cross-Swarm run record
(`superTabRun`, one per agent) moves to the new assignment: a handed assignment's record is replaced without cancelling
its queued deliveries (a Reviewer's findings to the Engineer must still arrive). Known limit: once the new task ends, the
agent has no run record while the handed one is open, so the cross-Swarm fence does not cover the handed task; nothing
in it is in the agent's hands then.

**Busy checks moved to `occupiesAgent`:** `work.assign` and `work.resume` AGENT_BUSY, `workerIndex.working`
(awaitingWorkers), the coordinator's idle notice (tidy.ts: its own handed task leaves it idle; a Reviewer or Tester in
someone else's open task is still not idle), `finishWorker` (no "awaiting" mark while another task is in its hands). Light
reads now keep `reviewOf` (parts/light.ts), since `handed` tells a task from a step. Unchanged (they mean "task open"): archive, deletion, steps' `reviewedBuild`, agent stop/release/remove
(stopping an Engineer whose task is in review still waits, as today).

### Design checklist

- growth: one `reopened` object per assignment, cleared at pick-up or the next status; nothing else stored.
- concurrency: every change is in the group's own write (commands, and store.ts pullRequestSeen's transaction).
- read cost: no new reads; the PR watch already reads each open task's PR every minute.
- scale: 10x tasks is 10x reopen checks in the same loops; the watch's pass log line warns first.
- compatibility: old clients see `working`/`review` as today and ignore `reopened`. An older server reading a reopened row
  sees an ordinary working task.
- migration + rollback: none. Rolling back makes `review` busy again; a reopened row is plain `working`.
- audience: reopen is triggered only by server-read GitHub state or a recorded check verdict; no client field sets it.
- identity: N/A because nothing here acts as a person.
- failure: a reopen and a release each post a line in the task to its Engineer (and the release to the coordinator, as
  any loss does); nothing changes silently.
- platforms: backend only.

## Global Constraints

- Owns backend/src/superTabs/ and backend/src/github/ only. Swarm code stays out of cli/src/core.
- No new refusal code. `removedRefusals.test.ts` stays green.
- The 60-minute number lives in one constant (`REOPEN_OWNER_MS`) until the project rules record (#3393) lands.
- Tests never sign the Mac out of the real CLI. Temp files only in mktemp -d folders.

## Review Focus

- Security (token holds): a handed task keeps its hold; a reopen neither ends nor starts one; `githubAssignment` picks the
  in-hand task first; an agent with no task in progress still gets no token.
- A handed Engineer is free in every busy check, and still busy in stop/release.
- A reopen keeps assignment id and run ledger ("built by"); the 60-minute release reaches the lane through the normal loss.

## Task 1: a handed Engineer is free for new work and keeps its push access

**Files:** backend/src/superTabs/handed.ts (new), handed.test.ts (new), model.ts, commands.ts, tidy.ts, store.ts,
github/holds.test.ts (new)

**Interfaces:** `handed(group): boolean`, `occupiesAgent(group): boolean`, `REOPEN_OWNER_MS`.

- [ ] Test: Engineer sets review; assigning it a second task succeeds (AGENT_BUSY before); `awaitingWorkers` lists it; the
  idle notice can name it; work.resume is not refused by a handed task.
- [ ] Test: holds: the handed task still holds, the new task adds one, neither ends; githubAssignment prefers the in-hand task.
- [ ] Code.

## Task 2: a handed task is never lost for its Engineer

**Files:** liveness.ts, handed.test.ts

- [ ] Test: a handed task stays `review` when its Engineer's session stops, its machine goes offline or it hits a limit.
- [ ] Code.

## Task 3: No, red CI or a conflict reopens the task pinned to its owner

**Files:** handed.ts, commands.ts, liveness.ts, store.ts (pullRequestSeen), pullRequestEvents.ts, handed.test.ts

- [ ] Test: a Reviewer's failed check on a handed task reopens it to the same assignment and agent, tells the Engineer, keeps
  the run ledger; the Engineer's own failed check does not.
- [ ] Test: the PR watch reopens on CI red at the head and on a conflict; a green run does not.
- [ ] Test: the Engineer's post or status picks it up; with no pick-up in 60 minutes it is lost (released); a down Engineer
  loses it at once; the next Ready clears `reopened`.
- [ ] Code.

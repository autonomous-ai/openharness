# A person's moved rule leaves only for work merged after the move: implementation plan

> Implemented by the task's Engineer the project's way (project instructions, Engineer): task by task, test first, each
> failing test committed before the code that passes it. No Execution Handoff.

**Goal:** A person-tagged rule moved into a code task may leave the instructions only once that task's pull request merged
after the rule went into the task, by the server's own read of GitHub, and that works with the daily tidy turned off.

**Architecture:** Today a moved rule's task counts as merged when the archive pass recorded any linked pull request merged
(`Conversation.mergeSeen`, written by `store.ts archiveFinished`). That record holds when the Swarm read it, not when it
merged, so an old merged pull request counts; and the archive pass runs only while tidying is on, so with it off a moved
rule can never leave. Instead, a task records when its brief was last set (`briefAt`, by `conversation.create` and
`work.define`), and an `instructions.save` that drops a line kept only in code tasks has the store read those tasks' linked
pull requests on GitHub before the write (`hooks.pullRequestMerges`, GitHub's `merged_at`), as it reads push origins. The
guard (`ruleGuard.ts rulePlaces`) counts a task merged only when one of its links merged after its `briefAt`.
`mergeSeen` is no longer read; its writer and field go.

**Tech Stack:** TypeScript backend (vitest; the Mongo integration suite runs in PR CI).

**Spec:** Task #3463 brief and its two acceptance checks (follow-ups from the review of #3392's #3220).

## Global Constraints

- PR body first line: "Requested by Dee through Harness."
- Owns `backend/src/superTabs/`. Outside it, only wiring: `backend/src/routes/superTabs.ts` (the hook on the API store).
- No new refusal code; a GitHub read that cannot say counts as not merged (the line stays, the refusal says why).
- At most 20 pull requests read per save; a token per repository, revoked after the read.

## Design

- Growth: one number per task (`briefAt`); `mergeSeen` is no longer written.
- Concurrency: the read happens before the write; the write still checks the instructions' base revision.
- Read cost: GitHub reads only on a save that drops a tagged line kept in a code task, capped at 20.
- Compatibility: a task from before (no `briefAt`) counts any merge GitHub reports, as today's rule does; older clients
  never see the fields.
- Migration + rollback: none.
- Audience: GitHub's answer, read by the server; no command writes `briefAt` or a merge time.
- Identity: the read uses the Harness GitHub App's read-only token, never a person's.
- Failure: GitHub unreachable → the line stays and the refusal names the task, as for an unmerged one; each read it
  could not make is logged by repository, number and status.
- A later `work.define` resets `briefAt`: the rule then waits for a merge after the new brief, which fails safe (the line
  stays) (review 1 of #3273).
- The tasks read are those the guard's own matcher finds a dropped rule in (`ruleGuard.ts tasksHoldingMoves`), across
  wrapped lines and as one rule of a line of several (review 1 of #3273).
- Platforms: backend only.

## Review Focus

- A pull request merged before the brief got the rule never frees it (Task 1 test).
- With tidying off, a person's save drops the moved line once its task's pull request merged (Task 2 test).
- A forged merge record (any agent's `conversation.merged`) still frees nothing by itself: only GitHub's `merged_at` counts.

---

### Task 1: count only a merge after the move

**Files:** `ruleGuard.ts`, `model.ts` (`briefAt`, `CommandContext.pullRequestMerges`), `commands.ts`, `instructions.test.ts`

- [ ] Failing tests: a task whose linked pull request GitHub says merged before the brief was set keeps the line (`waiting`);
  one merged after frees it; `briefAt` is set by create and define, by no other command.
- [ ] Implement; commit test, then code.

### Task 2: the store reads GitHub at the save, tidying on or off

**Files:** `store.ts` (pre-read, hook `pullRequestMerges`), new `ruleMoves.ts` (the app reader), `archive.ts`/`store.ts`
(`mergeSeen` writer removed), `routes/superTabs.ts`, `integration/superTabInstructions.test.ts`

- [ ] Failing integration test: tidying off, a person's save dropping a moved line succeeds once the hook says its task's
  pull request merged after the move; refused before, and refused for an older merge.
- [ ] Implement; commit test, then code.

# A departed checker's failure can be cleared Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its passing code; one independent review step on the pull request.

**Goal:** A check failed by a checker who has since left the Swarm can pass again in the same attempt: a later pass by the task's PM, or by a person who owns the project or the Swarm, clears every earlier failure from checkers no longer in the Swarm. Fix to what ships ("reviewed and tested before merge": a task whose Reviewer was stopped could never pass its check).

**Architecture:** `recordCheckVerdict` (checkVerdicts.ts) takes the set of checkers whose failures this verdict clears. `work.check` (commands.ts) passes it only for a pass by someone accountable for the task: its PM (the project's current coordinator, `ledProject`; a replaced PM's removal clears the lead of the tasks it led), the project's owner or the Swarm's owner. The cleared checkers are those whose verdict names an agent or a person the Swarm no longer lists. `passedBy` and `evidence` are recomputed from the verdicts that remain, as today.

**Tech Stack:** TypeScript, Vitest (backend); the CLI's task text (Vitest spec).

**Spec:** Task #2656 (Diego, 2026-11-04; option (b) decided by the PM, River).

## Global Constraints

- A live checker's failure still stands: a later pass by anyone else, the PM and owners included, doesn't erase it.
- A departed checker's failure is never dropped by itself: only an accountable checker's pass clears it. Anyone else's pass leaves the check failed.
- A failure from before verdicts were kept names no checker, so nothing here changes it.
- A cleared failure stays on the record: a line in the task's chat names the departed checker (each verdict keeps its checker's name), its evidence's first line and who cleared it (security reviews 1 and 2).
- Someone accountable can stop a live Reviewer and then clear its failure. That gives nobody new power, since owners and the coordinator can already merge past a check, and the line in the task records it.
- The CLI names a departed checker by its last known name, not a bare id.
- Swarm code stays out of cli/src/core. The backend unit suite and the Super Tab integration suite run in PR CI.
- PR body begins `Requested by diego@autonomous.ai through Harness.`

## Design

- Growth: one short name on each verdict, and one chat line per cleared failure; a cleared verdict leaves the check's list.
- Concurrency: N/A because it runs inside the existing command transaction, as every verdict does.
- Read cost: N/A because no new read; the departed test reads the state the command already holds.
- Scale: one pass looks up each of the check's verdicts in the Swarm's agents and people, a handful per check.
- Compatibility: one optional field on a verdict (`name`), which older readers ignore. Older clients read `passedBy` and `evidence` as before.
- Migration + rollback: none. A rollback leaves cleared checks passed, which is what they then were.
- Audience: the server decides who may clear: the task's PM or an owner, by the actor the command runs as.
- Identity: the actor's own key, never the machine owner's.
- Failure: a pass by someone else leaves the check failed with the departed checker's evidence, as today.
- Platforms: backend; the CLI's task text.

## Review Focus

- Who counts as accountable: the project's current coordinator, `project.ownerId`, `state.ownerId`.
- Who counts as departed: an agent no longer in `state.agents`, a person no longer in `state.people`.
- A live checker's failure is never cleared.

## Task 1: Accountable passes clear departed checkers' failures

**Files:** `backend/src/superTabs/checkVerdicts.ts`, `backend/src/superTabs/commands.ts` (`work.check`), `backend/src/superTabs/steps.test.ts`

**Interfaces:** `recordCheckVerdict(check, verdict, clears?: (by: string) => boolean)`.

- [x] Write failing tests in the steps fixture: R fails, R is removed, R2 passes: still failed. The owner passes: passed, `passedBy` and evidence from that pass. The task's PM passes: the same. A live checker's failure isn't cleared by the owner. Commit; watch them fail.
- [x] Implement; commit; watch them pass.

## Task 2: The CLI names a departed checker

**Files:** `cli/src/superTabs/agentContext.spec.ts`

- [x] Test that a departed checker's failure reads with its last known name. It already passed: the task read names stopped agents from the backend's known names.

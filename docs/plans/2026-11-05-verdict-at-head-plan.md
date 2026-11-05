# A verdict counts only at the head it read: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** Review and test verdicts record the pull request head they read. A newer head stops them counting unless the
pull request's own patch is the same (a plain rebase, or a main merge that leaves the PR's diff unchanged). This
replaces reading "Ready to merge: No / With fixes" out of post text (task #3394, requested by Dee through Harness).

**Architecture:** A check verdict (`CheckVerdict`, model.ts) gains the pull request, head and patch id it was given at.
The task keeps, per linked pull request, the head and patch id its PR watch last read (`Conversation.pullRequestHeads`).
`checkVerdicts.ts` derives a check's `passedBy`/`evidence` from the verdicts that still count; a verdict that does not
count is marked `stale` with the head that made it so. The PR watch (pullRequestEvents.ts, every minute) reads the PR's
per-file patches only when the head changed, hashes them into a patch id (hunk positions ignored), stores the new head
and re-derives the checks of the task and its steps. liveness.ts drops its text parse: a failed check (already
`changesRequested`) is what keeps a step waiting. Desktop's check line says "Yes at <head>" or "Stale: read X, PR is at Y".

**Tech Stack:** TypeScript backend (vitest, Mongo integration suite), Flutter Desktop (one widget line).

**Spec:** task #3394 brief; PM answers in the task (one Desktop line; delete the text parse; optional `head` on
`work.check`; one GitHub App method).

## Global Constraints

- No new refusal: `removedRefusals.test.ts` stays green. A bad `head` is a schema error like any malformed field.
- Old clients: `head` is optional; a verdict without a head, or on a task with no watched pull request, counts as before.
- Fail safe: a head whose patch cannot be read (GitHub error, over 3,000 files) has patch `null`, so only an exact head
  match counts there.
- Reads: per-file patches are read only when the watch sees a new head; steps are found with one read on that change.
- Swarm code stays out of cli/src/core.

## Design

- growth: `pullRequestHeads` holds one entry per linked pull request (links are already bounded); verdicts as before.
- concurrency: written in the same group transaction as the watch's keys (store.ts pullRequestSeen) and `work.check`.
- read cost: the files read happens once per new head, not per pass; the steps read only then too.
- scale: 10x pushes means 10x file reads; the pass's log line (`pulls`, `unreadable`) warns first.
- compatibility: old clients ignore the new fields; Desktop without this change still reads `passedBy`.
- migration + rollback: none; absent fields read as "counts". Rolling back leaves extra fields nobody reads.
- audience: the head and patch id come from the server's GitHub App read, never from a client; a checker only states
  the head it read.
- identity: N/A because nothing here acts as a person.
- failure: an unreadable patch is stored as `null` and only an exact head counts; the pass logs unreadable pulls.
- platforms: backend only, plus one Desktop text line that looks the same on every platform.

## Review Focus

- A pass at an old head must never count unless the patch ids match (security: it gates merges).
- A failure at an old head stops counting too (the check reads pending, not failed).
- The step refresh: steps' checks re-derive against their task's heads.

## Task 1: verdicts carry a head, and a check counts only its live verdicts

**Files:** backend/src/superTabs/model.ts, checkVerdicts.ts, checkVerdicts.test.ts (new)

**Interfaces:** `CheckVerdict { pullRequest?, head?, patch?, stale? }`; `PullRequestHead { head, patch, at }`;
`verdictCounts(verdict, heads)`, `deriveCheck(check, heads)`, `refreshChecks(checks, url, previous, next)`.

- [ ] Test: a pass at the current head counts; after a new head with another patch it is stale and `passedBy` is null.
- [ ] Test: the same patch at a new head keeps it; a verdict with no head counts as before.
- [ ] Test: a stale failure no longer fails the check.
- [ ] Code.

## Task 2: `work.check` stamps the verdict

**Files:** backend/src/superTabs/commands.ts, steps.test.ts

- [ ] Test: a check recorded on a task (and on its step) records the task PR's watched head and patch; an optional
  `head` the checker gives is recorded instead; a malformed one is refused by the schema.
- [ ] Code.

## Task 3: the PR watch records new heads and their patch id

**Files:** backend/src/superTabs/pullRequestPatch.ts (new), pullRequestEvents.ts, store.ts, parts/light.ts,
backend/src/github/app.ts, integration/superTabPullRequestEvents.test.ts

- [ ] Test (unit): the patch id ignores hunk positions and file order, and changes with any changed line.
- [ ] Test (integration): a pass at a verdict's head keeps it; a new commit makes it stale on the task and its step; a
  rebase with the same patch keeps it.
- [ ] Code.

## Task 4: no text parse in liveness

**Files:** backend/src/superTabs/liveness.ts, commands.ts, steps.test.ts, instructionsTemplate.ts, instructions.test.ts

- [ ] Test: a "Ready to merge: With fixes" post to a working Engineer keeps nothing; a failed check does.
- [ ] Code; the template's Workflow 3 says a failed check, recorded at the head read, keeps the step.

## Task 5: the Desktop check line

**Files:** desktop/lib/super_tabs/work_details.dart, its test

- [ ] Test: "Yes at 1a2b3c4" for a counting pass with a head; "Stale: read 1a2b3c4, PR is at 9f8e7d6" for a stale one.
- [ ] Code.
